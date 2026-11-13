// Agent adapter interface (design/D-03 section 7.2, D-08 C05, design/ADR-M29). The MVP
// implementation is `@sdlc/adapter-agent-openhands` (OpenHands Agent Server over REST, ADR-M04,
// ADR-M10). The runner depends on this interface; the agent runs inside the run's sandbox.
//
// Rules the interface carries:
// - The agent talks to models only through LiteLLM with the run's virtual key (FR-50). The key is
//   passed through the Agent Server API, never as a sandbox environment variable (ADR-M25 §2.4).
// - The model is chosen by the platform, never by the agent: it must be one of the contract's
//   `allowed_models` (D-07 §4, QUESTIONS #79).
// - Caps come from the Run Contract (FR-32): `max_iterations` is enforced by the agent itself,
//   `max_duration_min` by the caller (interrupt, then remove the sandbox).
// - Commits: the platform commits what the agent left, with a fixed author that names the agent,
//   so G7 counts the agent as a producer (FR-11, QUESTIONS #80).
import type { ProjectConfig } from './project-config.js';
import type { RunContract } from './run-contract.js';
import type { RedactedSecret } from './secrets.js';

/**
 * Tools an agent may get at L1/L2 (ADR-M10 §4.1 item 4). The contract's `allowed_tools` must be a
 * subset; browser, delegation and workflow tools are never granted in the MVP.
 */
export const AGENT_TOOLS = ['file_editor', 'task_tracker', 'terminal'] as const;
export type AgentTool = (typeof AGENT_TOOLS)[number];

/**
 * Adapters that drive an agent (X03, ADR-M68 §7, ADR-M88). Every agent of the register names one
 * (`agents.adapter`); the Run Contract carries it (`agent_adapter`), and the run's sandbox image
 * names it in its label `sdlc.agent.adapter`.
 */
export const AGENT_ADAPTERS = ['openhands', 'opencode'] as const;
export type AgentAdapterCode = (typeof AGENT_ADAPTERS)[number];

/** Image label that names the adapter of a sandbox image (ADR-M68 §7). */
export const AGENT_ADAPTER_LABEL = 'sdlc.agent.adapter';
/** Image label that names the version of the agent in a sandbox image (ADR-M68 §7). */
export const AGENT_VERSION_LABEL = 'sdlc.agent.version';

export function isAgentAdapterCode(value: unknown): value is AgentAdapterCode {
  return typeof value === 'string' && (AGENT_ADAPTERS as readonly string[]).includes(value);
}

/**
 * The sandbox image of a project for an adapter (X03, QUESTIONS #522, #528): `images.<adapter>`,
 * and for OpenHands `image` when `images.openhands` is not set. Undefined when the project has no
 * image for the adapter: a run of such an agent cannot start.
 */
export function sandboxImageFor(
  sandbox: ProjectConfig['sandbox'],
  adapter: AgentAdapterCode,
): string | undefined {
  if (adapter === 'openhands') return sandbox.images?.openhands ?? sandbox.image;
  return sandbox.images?.[adapter];
}

/**
 * X11 (ADR-M29 §2.10): context condensing of one run, chosen by the runner from the project's
 * `run.context_condensing`. Only the OpenHands adapter condenses; summaries are written by the
 * run's own model with the run's key, and stay client data (never in events, logs or tables).
 */
export interface AgentCondensing {
  /** Events in the model's view before a condensation. */
  readonly maxEvents: number;
  /** Events kept at the start of the view (the task message). */
  readonly keepFirst: number;
  /** Context size of the run's model, in tokens. */
  readonly contextTokens: number;
}

/**
 * How a run condenses its context (run event `agent_started`, field `condensing`):
 * - `off`: the project does not condense;
 * - `summarize`: the agent gets a condenser;
 * - `context_unknown`: the project condenses, but the run's model has no context size (rule M35);
 * - `unsupported`: the run's adapter does not take the platform's condenser (OpenCode).
 */
export const CONDENSING_STATES = ['off', 'summarize', 'context_unknown', 'unsupported'] as const;
export type CondensingState = (typeof CONDENSING_STATES)[number];

/** The condensing of a run of `adapter` with `model` under the project's configuration. */
export function condensingFor(
  config: ProjectConfig['run']['context_condensing'],
  adapter: AgentAdapterCode,
  model: string,
): { readonly state: CondensingState; readonly condensing?: AgentCondensing } {
  if (config.mode === 'off') return { state: 'off' };
  if (adapter !== 'openhands') return { state: 'unsupported' };
  const contextTokens = Object.hasOwn(config.model_context_tokens, model)
    ? config.model_context_tokens[model]
    : undefined;
  if (contextTokens === undefined) return { state: 'context_unknown' };
  return {
    state: 'summarize',
    condensing: { maxEvents: config.max_events, keepFirst: config.keep_first, contextTokens },
  };
}

/** Where the runner reaches the agent, and the per-run key that authenticates the runner. */
export interface AgentEndpoint {
  /** Base URL of the Agent Server as the runner sees it, for example `http://sdlc-sandbox-<id>:8000`. */
  readonly baseUrl: string;
  /** Random per run; only the runner holds it (ADR-M25 §2.4). */
  readonly sessionKey: RedactedSecret;
}

/** The model the agent calls, through LiteLLM (FR-50). */
export interface AgentModelAccess {
  /** Model name at the gateway; must be in the contract's `allowed_models`. */
  readonly model: string;
  /** LiteLLM as the sandbox sees it: an egress service of the run (`http://litellm:4000`). */
  readonly baseUrl: string;
  /** The run's virtual key. Call `reveal()` only where it is handed to the Agent Server. */
  readonly virtualKey: RedactedSecret;
}

/**
 * What the agent works on (D-08 C05 AC2). Texts go to the model only; they are never written to
 * `run_events` or the audit log.
 */
export interface AgentTask {
  /** The spec linked at G2 (`spec_refs`), a file in the workspace. */
  readonly spec: {
    readonly path: string;
    readonly commitSha: string;
    readonly contentSha256: string;
  };
  /** The plan approved at G3. `plannedFiles` equals the contract's `planned_files`. */
  readonly plan: {
    /** `plans.summary`: empty for a plan read from a file (B09). */
    readonly summary: string;
    readonly plannedFiles: readonly string[];
    /**
     * B09 PR 2 (ADR-M40 §2.7, QUESTIONS #169): the task text of a plan read from a file, read by
     * the runner from the file at the plan's commit in its own clone, hash checked against the
     * contract's `plan_sha256`, cleaned and capped. Written by people in the repository and
     * approved at G3, but untrusted in the prompt: the adapter delimits it. In memory only.
     */
    readonly taskText?: PlanTaskTextBlock;
  };
  /**
   * C08 PR 2 (QUESTIONS #158): this run follows a CI failure at G6 (a retry). The agent gets a
   * fixed instruction to run the project's checks and fix them; never CI logs or check names.
   */
  readonly ciFailed?: boolean;
  /**
   * E01 PR 2 (ADR-M41 §2.7, QUESTIONS #179): the feedback of the request for changes at G7 this run
   * answers, read by the runner from the Git host at run start. Untrusted text written by a person:
   * the adapter puts it in a delimited block and tells the agent it cannot change the task, the
   * rules, the files or the tools. In memory only: never in Temporal, logs, run events or tables.
   */
  readonly reviewFeedback?: ReviewFeedbackText;
  /**
   * X13 PR 2 (ADR-M74 §2.6): the project's approved memory notes, read by the runner from its own
   * clone at `base_sha`, hash checked against the contract's `memory.set_sha256`, cleaned and
   * capped. Approved by a person, but untrusted in the prompt: the adapter delimits it as data. In
   * memory only: never in Temporal, logs, run events or tables.
   */
  readonly memory?: MemoryTextBlock;
}

/** The memory notes of a run, rendered and capped by the runner. */
export interface MemoryTextBlock {
  /** `Memory file: <name>` lines, each followed by the file's cleaned text. */
  readonly text: string;
  /** Number of memory files in the text. */
  readonly files: number;
  /** True when the runner left files out or cut a file or the whole text at its cap. */
  readonly truncated: boolean;
}

/** The task text of a plan file, rendered and capped by the runner (`PLAN_TASK_TEXT_MAX_CHARS`). */
export interface PlanTaskTextBlock {
  readonly text: string;
  /** Number of tasks in the plan. */
  readonly tasks: number;
  /** True when the runner cut a field or the whole text at its cap. */
  readonly truncated: boolean;
}

/** The text of a request for changes, capped by the runner (`REVIEW_FEEDBACK_MAX_CHARS`). */
export interface ReviewFeedbackText {
  /** `review`: a pull request review and its line comments; `comment`: a `/request-changes G7`. */
  readonly source: 'review' | 'comment';
  readonly text: string;
  /** True when the runner cut the text at the cap. */
  readonly truncated: boolean;
}

export interface StartAgentRun {
  readonly contract: RunContract;
  readonly endpoint: AgentEndpoint;
  readonly model: AgentModelAccess;
  readonly task: AgentTask;
  /** The repository inside the sandbox (`/workspace`). */
  readonly workingDir: string;
  /**
   * X04 (ADR-M69 §2.4): the run's MCP gateway, when the contract grants register tools. The agent
   * reaches every register tool there with the per-run key; absent: no register tool.
   */
  readonly tools?: AgentToolAccess;
  /** X11 (ADR-M29 §2.10): context condensing; absent: none (the agent's view is never cut). */
  readonly condensing?: AgentCondensing;
}

/** The run's MCP gateway for the agent (X04, ADR-M87 §5). */
export interface AgentToolAccess {
  /** `TOOL_GATEWAY_URL`: the gateway's alias on the run network. */
  readonly url: string;
  /** Random per run; the gateway holds only its SHA-256. Revealed only into the agent's request. */
  readonly key: RedactedSecret;
}

/** A started run. Holds no secret except the endpoint's session key (redacted). */
export interface AgentRunHandle {
  readonly runId: string;
  readonly conversationId: string;
  readonly endpoint: AgentEndpoint;
  readonly workingDir: string;
}

/**
 * State of the agent (not the platform's `run_status`):
 * - `running`: working, or not started yet;
 * - `finished`: the agent said it is done;
 * - `max_iterations`: the agent stopped itself at its iteration cap (FR-32);
 * - `stopped`: the agent stopped without finishing (for example after the platform interrupted it);
 * - `error`: the agent reported an error;
 * - `stuck`: the agent's own stuck detector stopped it.
 */
export type AgentRunState =
  'running' | 'finished' | 'max_iterations' | 'stopped' | 'error' | 'stuck';

export interface AgentRunStatus {
  readonly state: AgentRunState;
  /** Agent steps so far (one model reply each). */
  readonly iterations: number;
  /**
   * Loop detection (C11, D-02 FR-35, ADR-M42 §2.7): the number of events of any kind in the
   * agent's log, except the events of a context condensing (X11), which are not progress. The
   * runner sees no progress when it stops growing for the configured window.
   */
  readonly events: number;
  /**
   * Identical tool calls in a row at the end of the log: the same tool and the same SHA-256 of
   * the canonical arguments. Counts only; the arguments are client data.
   */
  readonly identicalCalls: number;
  /** X11: condensations so far (counts only; the summaries are client data). */
  readonly condensations?: number;
  /** X11: events removed from the model's view by those condensations (they stay in the log). */
  readonly eventsForgotten?: number;
}

/** What `commitWork` found and did (QUESTIONS #80). */
export interface AgentCommit {
  /** Final `HEAD` of the run's branch after the commit (or unchanged when nothing was left). */
  readonly headSha: string;
  /** True when the platform made a commit of what the agent left uncommitted. */
  readonly committed: boolean;
}

/** The fixed author of the platform's commit: it names the agent (G7 producer, FR-11). */
export interface AgentCommitAuthor {
  readonly name: string;
  readonly email: string;
}

export type ChangeStatus = 'added' | 'modified' | 'deleted';

export interface ChangedFile {
  /** Path relative to the repository root. Client data: never in `run_events` or the audit log. */
  readonly path: string;
  readonly status: ChangeStatus;
}

/** One entry of the agent's log, as the agent reports it. Client data: evidence only (E02). */
export type AgentLogEvent = Readonly<Record<string, unknown>>;

/**
 * What the agent opened, for the run's context snapshot (X07, ADR-M90 §2.1). Client data: the
 * runner hashes the paths and never writes them to a run event, a log or a table.
 */
export interface AgentFileReads {
  /** Files opened with the agent's file-reading tool, relative to the working dir, sorted, distinct. */
  readonly paths: readonly string[];
  /** Calls of that tool on a path outside the working dir. */
  readonly outside: number;
  /** Tool calls that can read files the adapter cannot name (a shell command, a search). */
  readonly unattributed: number;
}

export interface AgentOutputs {
  /** Files changed between the contract's `base_sha` and `headSha` (renames as delete + add). */
  readonly changedFiles: readonly ChangedFile[];
  readonly headSha: string;
  readonly iterations: number;
  /** The whole log, oldest first. */
  readonly events: readonly AgentLogEvent[];
  /** X07: the files the log shows the agent opened. */
  readonly reads: AgentFileReads;
}

export interface AgentAdapter {
  /** Starts the agent on the task. Refuses a model outside `allowed_models` or an unknown tool. */
  startRun(input: StartAgentRun): Promise<AgentRunHandle>;
  getStatus(handle: AgentRunHandle): Promise<AgentRunStatus>;
  /** Asks the agent to stop at once (cancels the model call in flight). */
  stop(handle: AgentRunHandle): Promise<void>;
  /**
   * Commits what the agent left uncommitted on the run's branch, with `author` (QUESTIONS #80).
   * Refuses when `HEAD` is not on `branch` any more (`branch_changed`).
   */
  commitWork(
    handle: AgentRunHandle,
    input: {
      readonly branch: string;
      readonly author: AgentCommitAuthor;
      readonly message: string;
    },
  ): Promise<AgentCommit>;
  /** Changed files since `baseSha`, the last commit, the step count and the log. */
  collectOutputs(handle: AgentRunHandle, baseSha: string): Promise<AgentOutputs>;
}

/** Why an agent call failed. Codes only; the texts are in the message catalog (NFR-08). */
export const AGENT_ERROR_CODES = [
  'invalid_input',
  'model_not_allowed',
  'tool_not_allowed',
  'unauthorized',
  'not_found',
  'server_error',
  'network_error',
  'timeout',
  'invalid_response',
  'branch_changed',
  'git_failed',
  // X03 (ADR-M68 §6 gap 1): the agent changed its own configuration, tools or MCP servers.
  'config_changed',
] as const;
export type AgentErrorCode = (typeof AGENT_ERROR_CODES)[number];

/** Safe values only: HTTP status codes, field names, counts. Never text from the agent. */
export type AgentErrorParams = Readonly<Record<string, string | number>>;

export class AgentError extends Error {
  override readonly name = 'AgentError';

  constructor(
    readonly code: AgentErrorCode,
    readonly params: AgentErrorParams = {},
  ) {
    super(`agent.${code}`);
  }
}
