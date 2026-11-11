// What a run did with its register tools (task X04, design/ADR-M69 §2.7, ADR-M87 §5, QUESTIONS
// #518, #532): counted from the MCP gateway's JSON log lines, read through the Docker logs endpoint
// at the end of the run, before the gateway is removed. The gateway sits outside the sandbox, so
// these counts are better evidence than the agent's own events. Only codes and counts leave this
// module: never a query, an argument, an answer or a key (the gateway logs none of them).
//
// agentgateway 1.7 (as 1.6) writes one line per request (scope `request`):
// - an allowed call: `mcp.method.name` `tools/call`, `mcp.target` (the tool key), a status < 400;
// - a call refused by tool name: the same with status 400 and an `error`;
// - a refused argument (`reason` `Authorization`), a call over the cap (`RateLimit`) and a missing
//   or wrong key (`APIKeyAuth`): no target, because the gateway refuses before it reads the tool.
//   With one tool in the run they belong to it; with more they are counted for the run only.
import type { ToolGrant } from '@sdlc/contracts';

export type ToolRefusal = 'max_calls' | 'tool_not_allowed' | 'argument_refused' | 'key_refused';

export interface ToolCounts {
  readonly calls: number;
  readonly failedCalls: number;
  readonly refusedCalls: number;
}

export interface ToolUsage {
  /** One entry per grant, in key order, also when a tool was never called. */
  readonly tools: readonly { readonly toolKey: string; readonly counts: ToolCounts }[];
  /** The first refusal of each reason, with its tool when the gateway names it (or one tool). */
  readonly refusals: readonly { readonly reason: ToolRefusal; readonly toolKey?: string }[];
}

interface Line {
  readonly scope?: unknown;
  readonly 'http.status'?: unknown;
  readonly 'mcp.method.name'?: unknown;
  readonly 'mcp.target'?: unknown;
  readonly error?: unknown;
  readonly reason?: unknown;
}

const REASONS: Readonly<Record<string, ToolRefusal>> = {
  Authorization: 'argument_refused',
  RateLimit: 'max_calls',
  APIKeyAuth: 'key_refused',
};

function parse(line: string): Line | undefined {
  if (!line.startsWith('{')) return undefined;
  try {
    const value: unknown = JSON.parse(line);
    return value !== null && typeof value === 'object' ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Counts the gateway's log lines for the run's grants. */
export function toolUsage(logs: string, grants: readonly ToolGrant[]): ToolUsage {
  const keys = grants.map((g) => g.tool_key).sort();
  const only = keys.length === 1 ? keys[0] : undefined;
  const counts = new Map(keys.map((k) => [k, { calls: 0, failedCalls: 0, refusedCalls: 0 }]));
  const refusals = new Map<ToolRefusal, string | undefined>();
  const refuse = (reason: ToolRefusal, toolKey: string | undefined) => {
    if (toolKey !== undefined) counts.get(toolKey)!.refusedCalls += 1;
    if (!refusals.has(reason)) refusals.set(reason, toolKey);
  };
  for (const raw of logs.split('\n')) {
    const line = parse(raw.trim());
    if (line?.scope !== 'request') continue;
    const status = typeof line['http.status'] === 'number' ? line['http.status'] : 0;
    const target = typeof line['mcp.target'] === 'string' ? line['mcp.target'] : undefined;
    const known = target !== undefined && counts.has(target) ? target : undefined;
    const policy = typeof line.reason === 'string' ? REASONS[line.reason] : undefined;
    if (policy !== undefined) {
      refuse(policy, policy === 'key_refused' ? undefined : (known ?? only));
      continue;
    }
    if (line['mcp.method.name'] !== 'tools/call') continue;
    if (known === undefined) {
      // A call for a tool that is not the run's: refused by name, for no tool of the run.
      refuse('tool_not_allowed', only);
      continue;
    }
    // The gateway's argument rule refuses an unknown tool name before the call reaches a target,
    // so an error here is the tool's own answer: a failed call, not a refusal.
    if (status >= 400 || line.error !== undefined) counts.get(known)!.failedCalls += 1;
    else counts.get(known)!.calls += 1;
  }
  return {
    tools: keys.map((toolKey) => ({ toolKey, counts: counts.get(toolKey)! })),
    refusals: [...refusals].map(([reason, toolKey]) =>
      toolKey === undefined ? { reason } : { reason, toolKey },
    ),
  };
}
