// Issuing a Run Contract (worker side, design/D-03 section 8, D-08 C02 AC1, ADR-M22 section 2.3).
// The contract is built from the intent, its latest plan and the project configuration, signed
// through the `RunContractSigner` interface (the worker wires in OpenBao Transit; the key never
// leaves OpenBao), then stored with its run in one transaction.
//
// This function checks the contract itself. The G4 decision around it (agent registered and
// active, autonomy within the stricter of the stored and the current maximum, AI record, key
// capped) belongs to C06 (QUESTIONS.md #22, #32).
import { randomUUID } from 'node:crypto';

import {
  AUTONOMY_LEVELS,
  RUN_CONTRACT_SCHEMA_FOLDER,
  RUN_CONTRACT_SCHEMA_MEMORY,
  RUN_CONTRACT_SCHEMA_VERSION,
  signatureKeyVersion,
  type AgentAdapterCode,
  validateRunContract,
  type IntentStatus,
  type RunContract,
  type RunContractAutonomy,
  type RunContractEnvelope,
  type RunContractMemory,
  type RunContractSigner,
  type ToolGrant,
} from '@sdlc/contracts';

import type { Run } from '../db/schema.js';
import type { TenantScope } from '../db/tenant-scope.js';
import { loadEffectiveConfig } from '../registry/effective-config.js';
import { runContractBytes, runContractSha256 } from './canonical.js';
import { RunContractError } from './errors.js';

export interface RunContractAgent {
  readonly id: string;
  readonly version: string;
  readonly instructionsSha256: string;
  /** The agent's allowed tools in the register (C10). */
  readonly tools: readonly string[];
  /** The adapter that drives the agent (X03, QUESTIONS #526). */
  readonly adapter: AgentAdapterCode;
  /** O06 (ADR-M31 §2.5 0.6): the SHA-256 of the agent's second pinned file; null or absent: none. */
  readonly rootInstructionsSha256?: string | null;
}

export interface IssueRunContract {
  readonly intentId: string;
  /** The plan approved at G3; must be the intent's latest plan. */
  readonly planId: string;
  readonly baseSha: string;
  readonly agent: RunContractAgent;
  /** Tools listed for the task in the plan (template T13). The contract gets the intersection. */
  readonly planTools: readonly string[];
  /**
   * X04 (ADR-M69 §2.6): one grant per register tool (`tool:<key>`) of the intersection, from G4's
   * `checkToolsForRun`. Default: none. The schema check refuses a register tool without its grant.
   */
  readonly toolGrants?: readonly ToolGrant[];
  readonly autonomyLevel: RunContractAutonomy;
  /** Caps (D-02 FR-32): from the intent budget and the configuration, chosen by the caller (C06). */
  readonly maxBudgetUsd: string;
  readonly maxIterations: number;
  readonly maxDurationMin: number;
  /** From `PolicyEngine.allowedModels` for the intent's data class. */
  readonly allowedModels: readonly string[];
  /** Hosts the sandbox may reach (deployment settings: GitHub, LiteLLM). */
  readonly egressAllowlist: readonly string[];
  /** The G3/G4 approver who allowed the run; null when the system did (G4 POLICY). */
  readonly triggeredBy: string | null;
  /**
   * X13 (ADR-M74 §2.6, QUESTIONS #712): the memory G4 found at `base_sha`, for a project whose
   * `memory.mode` is not `off`. Present: the contract is schema 5. Absent: schema 3 or 4 as before.
   */
  readonly memory?: RunContractMemory;
}

export interface IssueDeps {
  readonly signer: RunContractSigner;
  /** Default: `new Date()`. */
  readonly now?: () => Date;
}

export interface IssuedRunContract {
  readonly run: Run;
  readonly envelope: RunContractEnvelope;
  readonly contractSha256: string;
  readonly keyVersion: number;
}

/** Intent statuses that never get a new run. */
const CLOSED_INTENT_STATUSES: readonly IntentStatus[] = [
  'done',
  'rejected',
  'cancelled',
  'blocked',
];

/** Sorted, unique copy: set-like lists always give the same canonical bytes. */
export function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

/**
 * The tools a run may use: the agent's registered tools that the plan task also lists
 * (handbook Ch.13 G4, QUESTIONS.md #34). Sorted and unique.
 */
export function allowedTools(
  agentTools: readonly string[],
  planTools: readonly string[],
): string[] {
  const planned = new Set(planTools);
  return sortedUnique(agentTools.filter((tool) => planned.has(tool)));
}

export async function issueRunContract(
  scope: TenantScope,
  input: IssueRunContract,
  deps: IssueDeps,
): Promise<IssuedRunContract> {
  const intent = await scope.intents.getById(input.intentId);
  if (!intent) {
    throw new RunContractError('intent_not_found', `intent ${input.intentId} not found`);
  }
  if (CLOSED_INTENT_STATUSES.includes(intent.status)) {
    throw new RunContractError('intent_closed', `intent ${intent.code} is ${intent.status}`);
  }
  if (AUTONOMY_LEVELS.indexOf(input.autonomyLevel) > AUTONOMY_LEVELS.indexOf(intent.max_autonomy)) {
    throw new RunContractError(
      'autonomy_above_intent',
      `autonomy ${input.autonomyLevel} is above the intent maximum ${intent.max_autonomy}`,
    );
  }
  const plan = await scope.plans.latest(intent.id);
  if (plan?.id !== input.planId) {
    throw new RunContractError('plan_not_latest', `plan ${input.planId} is not the latest plan`);
  }
  const project = await scope.projects.getById(intent.project_id);
  if (!project) {
    throw new RunContractError('intent_not_found', `project of intent ${intent.code} not found`);
  }
  const { config } = await loadEffectiveConfig(scope.projectConfigs, intent.project_id);

  const issuedAt = deps.now ? deps.now() : new Date();
  const expiresAt = new Date(issuedAt.getTime() + config.run.contract_validity_minutes * 60_000);
  // O06 (ADR-M106 §2.4): schema 4 only for a project with a folder or an agent with a second
  // pinned file; every other contract stays schema 3.
  const rootSha256 = input.agent.rootInstructionsSha256 ?? null;
  const folder = project.repo_path !== '' || rootSha256 !== null;
  // X13 (QUESTIONS #712): schema 5 = schema 4's fields plus `memory`, only with memory on.
  const memory = input.memory;
  const schema =
    memory !== undefined
      ? RUN_CONTRACT_SCHEMA_MEMORY
      : folder
        ? RUN_CONTRACT_SCHEMA_FOLDER
        : RUN_CONTRACT_SCHEMA_VERSION;
  const draft: RunContract = {
    schema_version: schema,
    run_id: randomUUID(),
    intent_id: intent.id,
    tenant_id: scope.tenantId,
    project_id: intent.project_id,
    repo: project.repo_full_name,
    base_sha: input.baseSha,
    branch: `agent/${intent.code}`,
    plan_id: plan.id,
    plan_sha256: plan.plan_sha256,
    planned_files: [...plan.planned_files],
    agent_id: input.agent.id,
    agent_version: input.agent.version,
    agent_adapter: input.agent.adapter,
    instructions_sha256: input.agent.instructionsSha256,
    allowed_tools: allowedTools(input.agent.tools, input.planTools),
    tool_grants: [...(input.toolGrants ?? [])].sort((a, b) =>
      a.tool_key < b.tool_key ? -1 : a.tool_key > b.tool_key ? 1 : 0,
    ),
    ...(folder || memory !== undefined
      ? { repo_path: project.repo_path, root_instructions_sha256: rootSha256 }
      : {}),
    ...(memory !== undefined ? { memory: { ...memory } } : {}),
    autonomy_level: input.autonomyLevel,
    max_budget_usd: input.maxBudgetUsd,
    max_iterations: input.maxIterations,
    max_duration_min: input.maxDurationMin,
    loop_threshold: config.run.loop_detection.identical_tool_calls_max,
    allowed_models: sortedUnique(input.allowedModels),
    egress_allowlist: sortedUnique(input.egressAllowlist),
    issued_at: issuedAt.toISOString(),
    expires_at: expiresAt.toISOString(),
  };
  const validation = validateRunContract(draft);
  if (!validation.ok) {
    throw new RunContractError(
      'invalid_input',
      `field ${validation.field} does not fit the Run Contract schema`,
      validation.field,
    );
  }
  const contract = validation.contract;

  const signed = await deps.signer.sign(runContractBytes(contract));
  if (signatureKeyVersion(signed.signature) !== signed.keyVersion) {
    throw new RunContractError(
      'signature_invalid',
      'the signer returned an inconsistent signature',
    );
  }
  const contractSha256 = runContractSha256(contract);
  const { run } = await scope.runContracts.store({
    contract,
    contractSha256,
    signature: signed.signature,
    keyVersion: signed.keyVersion,
    triggeredBy: input.triggeredBy,
  });
  return {
    run,
    envelope: { contract, signature: signed.signature },
    contractSha256,
    keyVersion: signed.keyVersion,
  };
}
