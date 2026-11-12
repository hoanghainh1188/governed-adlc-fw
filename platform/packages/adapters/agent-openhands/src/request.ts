// Pure builders for the OpenHands Agent Server 1.48.0 requests (design/ADR-M10 §2.2, ADR-M29).
// Pure, so tests can check exactly what reaches the sandbox.
//
// What the conversation gets:
// - LLM: `litellm_proxy/<model>` on LiteLLM with the run's virtual key (FR-50); the key travels in
//   the request body only, never as a sandbox environment variable.
// - Tools: the contract's `allowed_tools`, which must be in AGENT_TOOLS (ADR-M10 §4.1 item 4).
//   X04 (ADR-M69 §2.4, QUESTIONS #519): register tools (`tool:<key>`) reach the agent only through
//   the run's MCP gateway: one `mcp_config` entry, the gateway's URL with the per-run key in a
//   header, only when the contract grants them (confirmed on Agent Server 1.48.0).
// - Project instructions: `agent_context.load_project_skills` loads AGENTS.md (and
//   `.openhands/skills/`) from the workspace. User, public and memory skills stay off: public skills
//   would be fetched from GitHub, which the sandbox cannot and must not reach.
// - `max_iterations` from the contract (FR-32); `autotitle: false` (one model call fewer,
//   ADR-M10 §4.1 item 1); OpenHands' own stuck detector on (fixed thresholds; the platform's
//   loop check with the configured limit comes in C11).
// - X11 (ADR-M29 §2.10): with `condensing`, an `LLMSummarizingCondenser` on the run's own model,
//   URL and key, and the agent's `max_input_tokens`. Without it the body has no condenser at all.
// - The first user message: `buildTaskMessage` of `@sdlc/agent-kit` (the spec, the plan, the
//   rules of the run and the delimited blocks) with the OpenHands last rule (`FINISH_RULE`).
import { agentWorkingDir, buildTaskMessage, checkTask, toolsOf } from '@sdlc/agent-kit';
import {
  AgentError,
  TOOL_GATEWAY_KEY_HEADER,
  TOOL_GATEWAY_URL,
  type AgentCondensing,
  type AgentTask,
  type RunContract,
} from '@sdlc/contracts';

import { condenserOf } from './condensing.js';

export interface ConversationRequestInput {
  readonly contract: RunContract;
  readonly model: string;
  readonly llmBaseUrl: string;
  /** The virtual key, revealed only here. */
  readonly virtualKey: string;
  readonly workingDir: string;
  readonly task: AgentTask;
  /** X04: the run's MCP gateway and the per-run key, revealed only here; absent without grants. */
  readonly tools?: { readonly url: string; readonly key: string };
  /** X11: context condensing of the run; absent: no condenser. */
  readonly condensing?: AgentCondensing;
}

/** The name of the run's MCP server in the agent's `mcp_config`. */
export const MCP_SERVER_NAME = 'sdlc-tools';

/**
 * The agent's MCP servers: the run's gateway when the contract grants register tools. A contract
 * with grants and no gateway, a gateway without grants, or another URL is refused: the agent gets
 * exactly what the signed contract grants.
 */
function mcpConfigOf(input: ConversationRequestInput): Record<string, unknown> | undefined {
  const grants = input.contract.tool_grants ?? [];
  if (grants.length === 0 && input.tools === undefined) return undefined;
  if (grants.length === 0 || input.tools?.url !== TOOL_GATEWAY_URL || input.tools.key === '') {
    throw new AgentError('tool_not_allowed', { tool: 'mcp' });
  }
  return {
    [MCP_SERVER_NAME]: {
      url: input.tools.url,
      transport: 'http',
      headers: { [TOOL_GATEWAY_KEY_HEADER]: `Bearer ${input.tools.key}` },
    },
  };
}

/** The last rule of the OpenHands task message: the agent ends with its `finish` tool. */
export const FINISH_RULE = '- When the task is done, call the finish tool with a short summary.';

/** The OpenHands task message (`buildTaskMessage` of `@sdlc/agent-kit` with its last rule). */
export function taskMessage(
  contract: RunContract,
  task: AgentTask,
  workingDir: string,
  nonce?: string,
  planNonce?: string,
): string {
  return buildTaskMessage(contract, task, workingDir, {
    finishRule: FINISH_RULE,
    nonce,
    planNonce,
  });
}

/** Body of `POST /api/conversations` (Agent Server 1.48.0, `StartConversationRequest`). */
export function buildConversationRequest(input: ConversationRequestInput): Record<string, unknown> {
  const { contract } = input;
  if (!contract.allowed_models.includes(input.model)) {
    throw new AgentError('model_not_allowed');
  }
  checkTask(contract, input.task);
  const tools = toolsOf(contract, { registerTools: true });
  const mcp = mcpConfigOf(input);
  const llm = {
    model: `litellm_proxy/${input.model}`,
    baseUrl: input.llmBaseUrl,
    virtualKey: input.virtualKey,
  };
  const { condensing } = input;
  return {
    agent: {
      kind: 'Agent',
      ...(mcp === undefined ? {} : { mcp_config: mcp }),
      llm: {
        model: llm.model,
        base_url: llm.baseUrl,
        api_key: llm.virtualKey,
        usage_id: 'agent',
        ...(condensing === undefined ? {} : { max_input_tokens: condensing.contextTokens }),
      },
      ...(condensing === undefined ? {} : { condenser: condenserOf(condensing, llm) }),
      tools: tools.map((name) => ({ name, params: {} })),
      agent_context: {
        load_project_skills: true,
        load_user_skills: false,
        load_public_skills: false,
        load_memory: false,
      },
    },
    // O06 (ADR-M106 §2.4): OpenHands loads its skills from here and from the Git root.
    workspace: { kind: 'LocalWorkspace', working_dir: agentWorkingDir(contract, input.workingDir) },
    initial_message: {
      role: 'user',
      content: [{ type: 'text', text: taskMessage(contract, input.task, input.workingDir) }],
      run: true,
    },
    max_iterations: contract.max_iterations,
    stuck_detection: true,
    autotitle: false,
    // Trace labels (scalars only): codes and IDs, no client data.
    observability_metadata: {
      run_id: contract.run_id,
      intent_id: contract.intent_id,
      tenant_id: contract.tenant_id,
      agent_id: contract.agent_id,
    },
  };
}
