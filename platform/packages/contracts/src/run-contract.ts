// The Run Contract (design/D-03 section 8, D-08 C02, design/ADR-M22): the signed permission for
// one agent run. The worker issues it after G4; the runner verifies it before it creates the
// sandbox. The signed bytes are the RFC 8785 canonical JSON of the contract (core
// `runContractBytes`); the signature is an Ed25519 signature made by OpenBao Transit.
//
// Values are strings, integers and arrays only (no floating point, D-05 D6), so the canonical
// bytes are the same after a round trip through PostgreSQL jsonb. Lists that act as sets
// (`allowed_tools`, `allowed_models`, `egress_allowlist`) must be sorted and unique, so the same
// set always gives the same bytes.
import { isAgentAdapterCode, type AgentAdapterCode } from './agent.js';
import {
  BACKING_SERVICE_PATTERN,
  IMAGE_DIGEST_PATTERN,
  isToolPermission,
  registerToolCode,
  TOOL_KEY_PATTERN,
  type ToolGrant,
} from './tools.js';
import type { AutonomyLevel } from './codes.js';
import { isRepoPath } from './repo-path.js';
import {
  budget,
  GIT_SHA,
  HOST,
  MODEL,
  positiveInt,
  REPO,
  SHA256,
  SIGNATURE,
  sortedSet,
  text,
  timestamp,
  UUID,
  VERSION_LABEL,
  type Check,
} from './contract-checks.js';

/**
 * 3 (X04, ADR-M69 §2.6): `tool_grants`. The worker issues schema 3; the runner also accepts
 * schema 2 (X03, `agent_adapter`), which has no `tool_grants` and so no register tools. A contract
 * of schema 1 is refused (`malformed`).
 *
 * 4 (O06, ADR-M106 §2.4, D-03 1.53): schema 3 plus `repo_path` and `root_instructions_sha256`. The
 * worker issues it only for a project with a folder or an agent with a second pinned file
 * (`RUN_CONTRACT_SCHEMA_FOLDER`), so every other contract stays schema 3, byte for byte.
 */
export const RUN_CONTRACT_SCHEMA_VERSION = 3;
/** O06: the schema of a contract with `repo_path` and `root_instructions_sha256`. */
export const RUN_CONTRACT_SCHEMA_FOLDER = 4;
/** Schema versions the runner accepts. */
export const RUN_CONTRACT_SCHEMA_VERSIONS = [2, 3, 4] as const;

/** Autonomy levels a contract may grant: L0 never runs an agent (D-02 FR-03), L3+ not in the MVP. */
export const RUN_CONTRACT_AUTONOMY_LEVELS = [
  'L1',
  'L2',
] as const satisfies readonly AutonomyLevel[];
export type RunContractAutonomy = (typeof RUN_CONTRACT_AUTONOMY_LEVELS)[number];

export interface RunContract {
  readonly schema_version: (typeof RUN_CONTRACT_SCHEMA_VERSIONS)[number];
  readonly run_id: string;
  readonly intent_id: string;
  readonly tenant_id: string;
  readonly project_id: string;
  /** `owner/name` on the Git host. */
  readonly repo: string;
  readonly base_sha: string;
  /** `agent/INT-YYYY-NNNN`: the only branch the agent may push (D-02 FR-30). */
  readonly branch: string;
  /** The plan approved at G3 and its hash. */
  readonly plan_id: string;
  readonly plan_sha256: string;
  /** Files or path patterns from the G3 plan (G5 compares the real changes with them). */
  readonly planned_files: readonly string[];
  /** From the agent register (C10). */
  readonly agent_id: string;
  readonly agent_version: string;
  /** The agent's adapter in the register (X03): the runner drives the run with it. */
  readonly agent_adapter: AgentAdapterCode;
  readonly instructions_sha256: string;
  /**
   * Tools the agent may use in this run: the agent's registered tools that the plan task also
   * lists (handbook Ch.13 G4, template T13; QUESTIONS.md #34). Sorted, unique; may be empty.
   */
  readonly allowed_tools: readonly string[];
  /**
   * Schema 3 (X04, ADR-M69 §2.6): one grant per register tool (`tool:<key>`) in `allowed_tools`,
   * sorted by key; may be empty. Absent in schema 2.
   */
  readonly tool_grants?: readonly ToolGrant[];
  /**
   * Schema 4 (O06): the project's folder in the repository (`projects.repo_path`; '' = the whole
   * repository). The agent works in it; G5 fails a change outside it. Absent before schema 4.
   */
  readonly repo_path?: string;
  /** Schema 4 (O06): the SHA-256 of the agent's second pinned file, or null. */
  readonly root_instructions_sha256?: string | null;
  readonly autonomy_level: RunContractAutonomy;
  /** Cost cap in USD as a decimal string (`"2"`, `"0.5"`, at most 6 decimals). */
  readonly max_budget_usd: string;
  readonly max_iterations: number;
  readonly max_duration_min: number;
  /** More identical consecutive tool calls than this stops the run (D-02 FR-35). */
  readonly loop_threshold: number;
  /** Model names allowed by policy for the intent's data class. Sorted, unique, at least one. */
  readonly allowed_models: readonly string[];
  /** Host names the sandbox may reach (GitHub, LiteLLM; D-03 section 9). Sorted, unique. */
  readonly egress_allowlist: readonly string[];
  /** ISO 8601 UTC with milliseconds, for example `2026-09-26T08:00:00.000Z`. */
  readonly issued_at: string;
  readonly expires_at: string;
}

/** What the worker hands to the runner. */
export interface RunContractEnvelope {
  readonly contract: RunContract;
  /** Transit signature, `vault:v<N>:<base64>`; `N` is the signing key version. */
  readonly signature: string;
}

/** Why the runner refused a contract (ADR-M22 section 2.4). Codes only; texts in the catalog. */
export const RUN_CONTRACT_REJECT_REASONS = [
  'malformed',
  'bad_signature',
  'unknown_contract',
  'mismatch',
  'not_yet_valid',
  'expired',
  'revoked',
  'run_not_startable',
  // X04 (ADR-M69 §2.6): a tool grant the runner cannot enforce or turn into the gateway's
  // configuration, or whose call rules differ from the runner's own catalogue.
  'tool_not_enforceable',
  // O06 (ADR-M106 §2.4): a project folder that the contract's agent adapter cannot work in (only
  // OpenHands sets its working folder per run).
  'folder_not_enforceable',
] as const;
export type RunContractRejectReason = (typeof RUN_CONTRACT_REJECT_REASONS)[number];

export type RunContractValidation =
  | { readonly ok: true; readonly contract: RunContract }
  | { readonly ok: false; readonly field: string };

const BRANCH = /^agent\/INT-[0-9]{4}-[0-9]{4,9}$/;
const TOOL = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

const MAX_PLANNED_FILES = 1000;

const plannedFiles: Check = (value) =>
  Array.isArray(value) &&
  value.length >= 1 &&
  value.length <= MAX_PLANNED_FILES &&
  value.every(
    (f) => typeof f === 'string' && f.length >= 1 && f.length <= 1024 && !f.includes('\0'),
  );

const MAX_TOOL_GRANTS = 20;
const SHA256_HEX = SHA256;

/** One grant: exactly its fields, each in its format (ADR-M69 §2.6). */
function isToolGrant(value: unknown): value is ToolGrant {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const g = value as Record<string, unknown>;
  const keys = Object.keys(g).sort();
  const expected = [
    'backing_services',
    'call_rules_sha256',
    'image_digest',
    'max_calls',
    'permissions',
    'tool_key',
    'tool_version',
    'transport',
  ];
  return (
    keys.length === expected.length &&
    keys.every((k, i) => k === expected[i]) &&
    text(TOOL_KEY_PATTERN)(g.tool_key) &&
    text(VERSION_LABEL)(g.tool_version) &&
    // Only `http` tools reach a run (ADR-M69 §2.4); `stdio` tools are not planned (§2.5).
    g.transport === 'http' &&
    text(IMAGE_DIGEST_PATTERN)(g.image_digest) &&
    sortedSet(/^[a-z][a-z_]{0,62}$/, 1)(g.permissions) &&
    (g.permissions as string[]).every(isToolPermission) &&
    text(SHA256_HEX)(g.call_rules_sha256) &&
    sortedSet(BACKING_SERVICE_PATTERN, 0)(g.backing_services) &&
    positiveInt(g.max_calls)
  );
}

/** Sorted by key, unique, each a valid grant. */
const toolGrants: Check = (value) =>
  Array.isArray(value) &&
  value.length <= MAX_TOOL_GRANTS &&
  value.every(
    (grant, i) =>
      isToolGrant(grant) && (i === 0 || (value[i - 1] as ToolGrant).tool_key < grant.tool_key),
  );

const FIELDS: Readonly<Record<keyof RunContract, Check>> = {
  schema_version: (value) => (RUN_CONTRACT_SCHEMA_VERSIONS as readonly unknown[]).includes(value),
  run_id: text(UUID),
  intent_id: text(UUID),
  tenant_id: text(UUID),
  project_id: text(UUID),
  repo: text(REPO),
  base_sha: text(GIT_SHA),
  branch: text(BRANCH),
  plan_id: text(UUID),
  plan_sha256: text(SHA256),
  planned_files: plannedFiles,
  agent_id: text(UUID),
  agent_version: text(VERSION_LABEL),
  agent_adapter: isAgentAdapterCode,
  instructions_sha256: text(SHA256),
  allowed_tools: sortedSet(TOOL, 0),
  tool_grants: toolGrants,
  repo_path: (value) => typeof value === 'string' && isRepoPath(value),
  root_instructions_sha256: (value) => value === null || text(SHA256)(value),
  autonomy_level: (value) =>
    typeof value === 'string' &&
    (RUN_CONTRACT_AUTONOMY_LEVELS as readonly string[]).includes(value),
  max_budget_usd: budget,
  max_iterations: positiveInt,
  max_duration_min: positiveInt,
  loop_threshold: positiveInt,
  allowed_models: sortedSet(MODEL, 1),
  egress_allowlist: sortedSet(HOST, 1),
  issued_at: timestamp,
  expires_at: timestamp,
};

/** The contract fields, in schema order. */
export const RUN_CONTRACT_FIELDS = Object.keys(FIELDS) as readonly (keyof RunContract)[];

/**
 * Checks a value against the Run Contract schema: every field of its schema version present with
 * the right format (`tool_grants` from schema 3, `repo_path` and `root_instructions_sha256` in
 * schema 4 only), no other field, every register tool of
 * `allowed_tools` with exactly one grant and every grant in `allowed_tools`, and `expires_at` after
 * `issued_at`. Returns the first field that fails.
 */
export function validateRunContract(value: unknown): RunContractValidation {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, field: '(contract)' };
  }
  const record = value as Record<string, unknown>;
  const extra = Object.keys(record).find((key) => !Object.hasOwn(FIELDS, key));
  if (extra !== undefined) return { ok: false, field: extra };
  const schema = record.schema_version;
  for (const field of RUN_CONTRACT_FIELDS) {
    const absent =
      (field === 'tool_grants' && schema === 2) ||
      ((field === 'repo_path' || field === 'root_instructions_sha256') && schema !== 4);
    if (absent) {
      if (Object.hasOwn(record, field)) return { ok: false, field };
      continue;
    }
    if (!FIELDS[field](record[field])) return { ok: false, field };
  }
  const tools = record.allowed_tools as string[];
  const registerTools = tools.filter((tool) => tool.startsWith('tool:'));
  const granted = ((record.tool_grants ?? []) as ToolGrant[]).map((g) =>
    registerToolCode(g.tool_key),
  );
  if (registerTools.length !== granted.length || granted.some((code) => !tools.includes(code))) {
    return { ok: false, field: 'tool_grants' };
  }
  if (Date.parse(record.expires_at as string) <= Date.parse(record.issued_at as string)) {
    return { ok: false, field: 'expires_at' };
  }
  return { ok: true, contract: value as RunContract };
}

/** The signing key version in a Transit signature (`vault:v<N>:…`), or undefined when malformed. */
export function signatureKeyVersion(signature: unknown): number | undefined {
  if (typeof signature !== 'string' || signature.length > 512) return undefined;
  const match = SIGNATURE.exec(signature);
  return match ? Number(match[1]) : undefined;
}

/** A well-formed envelope: a valid contract and a well-formed signature with its key version. */
export interface ParsedRunContractEnvelope {
  readonly contract: RunContract;
  readonly signature: string;
  readonly keyVersion: number;
}

/**
 * Checks the shape of an envelope received by the runner: exactly `contract` and `signature`, a
 * valid contract and a `vault:v<N>:…` signature. Undefined when anything is malformed. The
 * signature itself is not verified here.
 */
export function parseRunContractEnvelope(value: unknown): ParsedRunContractEnvelope | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 2 || keys[0] !== 'contract' || keys[1] !== 'signature') return undefined;
  const validation = validateRunContract(record.contract);
  const keyVersion = signatureKeyVersion(record.signature);
  if (!validation.ok || keyVersion === undefined) return undefined;
  return { contract: validation.contract, signature: record.signature as string, keyVersion };
}
