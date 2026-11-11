// The configuration of a run's MCP gateway (task X04, design/ADR-M69 §2.4, ADR-M87 §5). It is
// generated from the signed Run Contract, never written by hand, and no expression in it comes
// from a tenant: tool names and argument rules come from the permission catalogue of
// `@sdlc/contracts` (QUESTIONS #530).
//
// agentgateway 1.6, still so in 1.7 (ADR-M87 §3):
// - one target per tool grant, named by the tool key; with more than one target the agent sees each
//   tool as `<tool_key>_<tool name>`, with one target by its own name; the gateway lists only the
//   allowed ones;
// - the per-run key is checked by its SHA-256 only (`apiKey`, `Authorization: Bearer <key>`);
// - the argument rules are an HTTP `authorization` rule on the JSON-RPC body: a batch, a body that
//   does not parse or a body over the buffer limit fails the rule and is refused;
// - one call cap per tool (`localRateLimit` on the tool's target, a bucket that never refills); a
//   call refused by tool name uses one call of the cap too;
// - the stats and admin ports are off; one JSON log line per request with codes only.
import {
  TOOL_CALL_RULES,
  TOOL_GATEWAY_PORT,
  TOOL_MCP_PATH,
  TOOL_MCP_PORT,
  type ToolArgumentRule,
  type ToolCallRule,
  type ToolGrant,
} from '@sdlc/contracts';

/** The readiness port: the runner never calls it; the gateway's log tells it is ready. */
export const GATEWAY_READINESS_PORT = 15021;
/** The log line agentgateway writes once it serves (`agent_core::readiness`). */
export const GATEWAY_READY_MESSAGE = 'marking server ready';

/**
 * The name the agent sees for a tool of a grant: agentgateway prefixes a tool with its target's
 * name (`<tool_key>_<tool>`) only when it serves more than one target (tested against 1.6.0 and 1.7.0).
 */
export function exposedToolName(toolKey: string, tool: string, targets: number): string {
  return targets > 1 ? `${toolKey}_${tool}` : tool;
}

const json = (value: string): string => JSON.stringify(value);

/** CEL for one argument: its type and its limits. `a` is the arguments map. */
function argumentCel(name: string, rule: ToolArgumentRule): string {
  const value = `a[${json(name)}]`;
  if (rule.type === 'string') {
    return `(type(${value}) == string && size(${value}) <= ${String(rule.max_length)})`;
  }
  // agentgateway reads a whole JSON number as `uint` (or `int` when negative) and any other number
  // as `double`: only a whole number within the limits passes (tested against 1.6.0 and 1.7.0).
  return (
    `((type(${value}) == uint || type(${value}) == int) && ` +
    `double(${value}) >= ${rule.min.toFixed(1)} && double(${value}) <= ${rule.max.toFixed(1)})`
  );
}

/** CEL for one allowed tool: its exposed name, only known arguments, required ones, each rule. */
function callCel(toolKey: string, rule: ToolCallRule, targets: number): string {
  const names = Object.keys(rule.arguments).sort();
  const known = `a.all(k, k in [${names.map(json).join(', ')}])`;
  const required = rule.required.map((name) => `has(a.${name})`);
  const each = names.map(
    (name) => `(!(${json(name)} in a) || ${argumentCel(name, rule.arguments[name]!)})`,
  );
  const args = [known, ...required, ...each].join(' && ');
  return (
    `(b.params.name == ${json(exposedToolName(toolKey, rule.tool, targets))} && ` +
    `b.params.arguments.with(a, ${args}))`
  );
}

/** The rules of a grant's permissions, from the runner's own catalogue. */
export function grantRules(grant: ToolGrant): readonly ToolCallRule[] {
  return grant.permissions.flatMap((permission) => TOOL_CALL_RULES[permission]);
}

/**
 * The HTTP authorization rule: every `tools/call` must name an allowed tool and fit its rules. Any
 * other request method passes (GET opens the event stream; the key check still applies).
 */
export function argumentRuleCel(grants: readonly ToolGrant[]): string {
  const calls = grants.flatMap((grant) =>
    grantRules(grant).map((r) => callCel(grant.tool_key, r, grants.length)),
  );
  const allowed = calls.length === 0 ? 'false' : calls.join(' || ');
  return (
    `request.method != "POST" || json(request.body).with(b, ` +
    `b.method != "tools/call" || (has(b.params.name) && has(b.params.arguments) && (${allowed})))`
  );
}

export interface GatewayConfigInput {
  readonly grants: readonly ToolGrant[];
  /** Hex SHA-256 of the per-run key: the key itself is never in the file. */
  readonly keySha256: string;
  /** The host of a tool on the tool network: its short alias (`toolHost`). */
  readonly toolHost: (toolKey: string) => string;
}

/**
 * The gateway's configuration file as JSON (agentgateway reads YAML, and JSON is YAML). Grants
 * sorted by key give the same file for the same contract.
 */
export function buildGatewayConfig(input: GatewayConfigInput): string {
  if (!/^[0-9a-f]{64}$/.test(input.keySha256)) throw new Error('key hash');
  const grants = [...input.grants].sort((a, b) => (a.tool_key < b.tool_key ? -1 : 1));
  const config = {
    config: {
      adminAddr: 'off',
      statsAddr: 'off',
      readinessAddr: `0.0.0.0:${String(GATEWAY_READINESS_PORT)}`,
      logging: { format: 'json' },
      // agentgateway 1.7 encrypts MCP session IDs by default and, without a key, writes one it
      // makes into this file (the run's config volume is writable). A key is never written there:
      // sessions stay unencrypted, as in 1.6. They live only on the run's internal tool network.
      session: { key: 'disabled' },
    },
    binds: [
      {
        port: TOOL_GATEWAY_PORT,
        listeners: [
          {
            routes: [
              {
                policies: {
                  apiKey: { mode: 'strict', keys: [{ keyHash: `sha256:${input.keySha256}` }] },
                  authorization: { rules: [{ require: argumentRuleCel(grants) }] },
                  mcpAuthorization: {
                    rules: grants.flatMap((grant) =>
                      grantRules(grant).map((rule) => ({
                        allow:
                          `mcp.tool.target == ${json(grant.tool_key)} && ` +
                          `mcp.tool.name == ${json(rule.tool)}`,
                      })),
                    ),
                  },
                  localRateLimit: {
                    conditional: grants.map((grant) => ({
                      condition:
                        `mcp.methodName == "tools/call" && ` +
                        `mcp.tool.target == ${json(grant.tool_key)}`,
                      maxTokens: grant.max_calls,
                      tokensPerFill: 1,
                      // Never refills within a run: the cap is per run (ADR-M69 §2.7).
                      fillInterval: '87600h',
                      type: 'requests',
                    })),
                  },
                },
                backends: [
                  {
                    mcp: {
                      statefulMode: 'stateful',
                      targets: grants.map((grant) => ({
                        name: grant.tool_key,
                        mcp: {
                          host: `http://${input.toolHost(grant.tool_key)}:${String(TOOL_MCP_PORT)}${TOOL_MCP_PATH}`,
                        },
                      })),
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}
