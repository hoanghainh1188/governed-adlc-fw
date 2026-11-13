// Tools for agents (task X04, design/ADR-M69, ADR-M87). Two kinds of tool share the `allowed_tools`
// lists of the agent register, the plan and the Run Contract:
// - the built-in tools of the agent (`AGENT_TOOLS`: `file_editor`, `task_tracker`, `terminal`);
// - register tools, `tool:<tool_key>`: MCP servers in a container of their own per run, reached by
//   the sandbox only through the run's MCP gateway (ADR-M69 §2.4).
//
// The permission catalogue and the call rules of each permission live here (QUESTIONS #530): the
// gateway's rules are generated from them by the runner, never written by a tenant. A new
// permission or a new rule needs an ADR.
import type { AgentAdapterCode } from './agent.js';

/** `tool:<tool_key>`: the prefix of a register tool's code (ADR-M69 §2.1, QUESTIONS #517). */
export const REGISTER_TOOL_PREFIX = 'tool:';

/** A register tool's key: unique per tenant, never reused (like `agent_key`). */
export const TOOL_KEY_PATTERN = /^[a-z][a-z0-9-]{1,62}$/;

/** True for `tool:<tool_key>` with a valid key. */
export function isRegisterToolCode(value: string): boolean {
  return (
    value.startsWith(REGISTER_TOOL_PREFIX) &&
    TOOL_KEY_PATTERN.test(value.slice(REGISTER_TOOL_PREFIX.length))
  );
}

/** The key of a register tool's code (`tool:project-docs` → `project-docs`). */
export function toolKeyOf(code: string): string {
  return code.slice(REGISTER_TOOL_PREFIX.length);
}

/** The code of a register tool (`project-docs` → `tool:project-docs`). */
export function registerToolCode(toolKey: string): string {
  return `${REGISTER_TOOL_PREFIX}${toolKey}`;
}

/** Status of a register tool (design/D-05 §5 `tool_status`): the same moves as an agent's. */
export const TOOL_STATUSES = ['proposed', 'active', 'suspended', 'quarantined', 'retired'] as const;
export type ToolStatus = (typeof TOOL_STATUSES)[number];

/**
 * How a tool runs (ADR-M69 §2.4–§2.5): `http` is MCP over Streamable HTTP in a container of its
 * own per run; `stdio` is a program inside the sandbox image, with no credential.
 */
export const TOOL_TRANSPORTS = ['http', 'stdio'] as const;
export type ToolTransport = (typeof TOOL_TRANSPORTS)[number];

/**
 * The transports each agent adapter can give a run (ADR-M69 §2.3 check 4, QUESTIONS #519). X04 PR 2:
 * the OpenHands Agent Server takes the run's MCP gateway over HTTP with a header key (`mcp_config`,
 * confirmed on 1.48.0). OpenCode: none yet, so G4 refuses its register tools
 * (`tool_transport_not_supported`).
 */
export const ADAPTER_TOOL_TRANSPORTS: Readonly<Record<AgentAdapterCode, readonly ToolTransport[]>> =
  {
    openhands: ['http'],
    opencode: [],
  };

/**
 * The run's MCP gateway as the sandbox sees it (ADR-M69 §2.4, ADR-M87 §5): the alias on the run
 * network, the port and the path. The sandbox reaches register tools only there.
 */
export const TOOL_GATEWAY_ALIAS = 'tools';
export const TOOL_GATEWAY_PORT = 3000;
export const TOOL_GATEWAY_URL = `http://${TOOL_GATEWAY_ALIAS}:${String(TOOL_GATEWAY_PORT)}/mcp`;
/** The header that carries the per-run key: `Authorization: Bearer <key>`. */
export const TOOL_GATEWAY_KEY_HEADER = 'Authorization';
/** The port and path every `http` tool image serves MCP on (Streamable HTTP). */
export const TOOL_MCP_PORT = 8080;
export const TOOL_MCP_PATH = '/mcp';

/**
 * X04 PR 3b (ADR-M69 §2.4): where a tool with backing services finds its run's settings and its
 * credential, written by the runner before the container starts (never an environment value).
 */
export const TOOL_RUNTIME_DIR = '/run/sdlc-tool';
/** Settings of the run: IDs, codes and host names only (`ToolRuntimeConfig`). */
export const TOOL_CONFIG_FILE = 'config.json';
/** The run's credential of the tool (`ToolRuntimeCredentials`). */
export const TOOL_CREDENTIALS_FILE = 'credentials.json';

/** `config.json` of a `read_documents` tool (X04 PR 3b, ADR-M89). */
export interface ToolRuntimeConfig {
  readonly schema_version: 1;
  /** The index version of the run's base commit. */
  readonly index_id: string;
  /** The project's schema in `knowledge-db` (`kdocs_p<…>`). */
  readonly schema: string;
  /** The embedding model (the tool's `model_ref`). */
  readonly model: string;
  /** `knowledge-db:5432` on the tool's service network, database `knowledge`. */
  readonly database: { readonly host: string; readonly port: number; readonly name: string };
  /** `http://litellm:4000` on the tool's service network. */
  readonly model_gateway_url: string;
}

/** `credentials.json` of a `read_documents` tool: the run's login and the tool's own model key. */
export interface ToolRuntimeCredentials {
  readonly db_username: string;
  readonly db_password: string;
  readonly llm_key: string;
}

/**
 * `config.json` of a `read_code` tool (X06 PR 2, ADR-M108 §2.8): the code index version of the
 * run's base commit, the project's code schema and the database. No model: the code tool calls none.
 */
export interface CodeToolRuntimeConfig {
  readonly schema_version: 1;
  readonly index_id: string;
  /** The project's code schema in `knowledge-db` (`kcode_p<…>`). */
  readonly schema: string;
  readonly database: { readonly host: string; readonly port: number; readonly name: string };
}

/** `credentials.json` of a `read_code` tool: the run's login only. */
export interface CodeToolRuntimeCredentials {
  readonly db_username: string;
  readonly db_password: string;
}

/**
 * The permission catalogue (ADR-M69 §2.2). The first one is `read_documents` (X04); `read_code`
 * (X06, ADR-M108 §2.8) reads the project's code index. A tool has at most one of the two: each
 * reads its own index with its own login.
 */
export const TOOL_PERMISSIONS = ['read_code', 'read_documents'] as const;
export type ToolPermission = (typeof TOOL_PERMISSIONS)[number];

export function isToolPermission(value: string): value is ToolPermission {
  return (TOOL_PERMISSIONS as readonly string[]).includes(value);
}

/** The rule of one argument of a tool call. Strings and integers only. */
export type ToolArgumentRule =
  | { readonly type: 'string'; readonly max_length: number }
  | { readonly type: 'integer'; readonly min: number; readonly max: number };

/** One tool name a permission allows, with the rules of its arguments (QUESTIONS #530). */
export interface ToolCallRule {
  readonly tool: string;
  /** Every argument the call may have; any other argument is refused. */
  readonly arguments: Readonly<Record<string, ToolArgumentRule>>;
  /** Arguments the call must have. Sorted. */
  readonly required: readonly string[];
}

/**
 * The call rules of each permission: the only tool names and arguments the run's gateway lets
 * through (ADR-M87 §5). Fixed here; never configuration, never from a tenant.
 */
export const TOOL_CALL_RULES: Readonly<Record<ToolPermission, readonly ToolCallRule[]>> = {
  // X06 (ADR-M108 §2.8). The tool checks again that a path is relative and has no `..`.
  read_code: [
    {
      tool: 'find_symbol',
      arguments: {
        kind: { type: 'string', max_length: 20 },
        limit: { type: 'integer', min: 1, max: 50 },
        name: { type: 'string', max_length: 200 },
      },
      required: ['name'],
    },
    {
      tool: 'find_references',
      arguments: {
        limit: { type: 'integer', min: 1, max: 100 },
        name: { type: 'string', max_length: 200 },
      },
      required: ['name'],
    },
    {
      tool: 'related_files',
      arguments: {
        limit: { type: 'integer', min: 1, max: 100 },
        path: { type: 'string', max_length: 1000 },
      },
      required: ['path'],
    },
  ],
  read_documents: [
    {
      tool: 'search_project_docs',
      arguments: {
        limit: { type: 'integer', min: 1, max: 20 },
        query: { type: 'string', max_length: 1000 },
      },
      required: ['query'],
    },
  ],
};

/** A backing service a tool container may reach on its service network: `alias:port`. */
export const BACKING_SERVICE_PATTERN =
  /^[a-z][a-z0-9-]{0,62}:([1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])$/;

/** An image digest: `sha256:` and 64 hex digits. */
export const IMAGE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

/**
 * RFC 8785 canonical JSON of the call rules of `permissions` (sorted, unique), as an object keyed
 * by permission. The rules hold strings, non-negative integers, arrays and objects only, so
 * sorting the keys and `JSON.stringify` give the canonical bytes. `call_rules_sha256` in a tool
 * grant is the SHA-256 of these bytes (ADR-M69 §2.6): the worker and the runner compute it each
 * from their own catalogue.
 */
export function toolCallRulesJson(permissions: readonly ToolPermission[]): string {
  const sorted = [...new Set(permissions)].sort();
  return canonical(Object.fromEntries(sorted.map((p) => [p, TOOL_CALL_RULES[p]])));
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * One register tool a run may use (the Run Contract's `tool_grants`, ADR-M69 §2.6). Strings,
 * integers and sorted lists only, like the rest of the contract.
 */
export interface ToolGrant {
  readonly tool_key: string;
  readonly tool_version: string;
  readonly transport: ToolTransport;
  /** `sha256:…` of the tool's image. */
  readonly image_digest: string;
  /** Sorted, unique, at least one. */
  readonly permissions: readonly ToolPermission[];
  /** SHA-256 (hex) of `toolCallRulesJson(permissions)`. */
  readonly call_rules_sha256: string;
  /** `alias:port` entries, sorted and unique; may be empty. */
  readonly backing_services: readonly string[];
  /** The run gateway's cap of calls for this tool. */
  readonly max_calls: number;
}
