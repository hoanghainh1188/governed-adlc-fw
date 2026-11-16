// The handoff from the intent workflow to the runner (task C06 session 2, design/ADR-M33 §2.6,
// QUESTIONS #53, #55, #112). The runner process is a Temporal worker on its own task queue; one
// long-running activity per run, with heartbeats. Its slots are the runner's sandbox limit, so
// extra runs wait in Temporal (D-03 §10.1).
//
// Activity inputs and results stay in the Temporal history, so they hold IDs, codes and single-use
// OpenBao wrapping tokens only (their time to live is the contract's validity): the run's GitHub
// token, its virtual key, after a request for changes at G7 the feedback token (E01 PR 2) and the
// secrets of its `read_documents` tools (X04 PR 3b).
// Never a raw token, a virtual key, a key ID, feedback text or other client data.

/** Temporal task queue of the runner (ADR-M25 §2.7). */
export const RUNNER_TASK_QUEUE = 'sdlc-runner';

/**
 * H08 (ADR-M111 §2.2): the Temporal task priority key of a run that a break-glass grant puts first
 * (`runner_priority`). Lower goes first; Temporal's default key is 3.
 */
export const BREAK_GLASS_PRIORITY_KEY = 1;

export interface ExecuteRunInput {
  readonly tenantId: string;
  readonly runId: string;
  /** The agent's pinned gateway model (QUESTIONS #79). */
  readonly modelRef: string;
  /** Single-use wrapping token around `{ token }`: the run's GitHub token (QUESTIONS #44). */
  readonly wrappedGitToken: string;
  /** Single-use wrapping token around `{ key }`: the run's LiteLLM virtual key (QUESTIONS #112). */
  readonly wrappedVirtualKey: string;
  /**
   * E01 PR 2 (ADR-M41 §2.7, QUESTIONS #179): single-use wrapping token around `{ token }`, a
   * single-repository GitHub token that may only read pull requests (or issues, for a command on
   * the intent's issue). Present when the run answers a request for changes at G7; the runner reads
   * the recorded review or comment with it, in memory only, then revokes it.
   */
  readonly wrappedFeedbackToken?: string;
  /**
   * X04 PR 3b (ADR-M69 §2.4, QUESTIONS #535, #541): by tool key, the single-use wrapping token
   * around a `read_documents` tool's `{ db_username, db_password, llm_key }` and the ID of the
   * index version it reads. The runner unwraps it and writes it into the tool's container as a
   * file; the sandbox never sees it.
   */
  readonly toolSecrets?: Readonly<Record<string, ToolSecretsHandoff>>;
}

/** One tool's handoff (X04 PR 3b): a wrapping token and an ID, nothing else. */
export interface ToolSecretsHandoff {
  readonly wrapped: string;
  readonly indexId: string;
}

export type ExecuteRunResult =
  /** The runner provisioned the sandbox and drove the agent; the run has a final status. */
  | { readonly outcome: 'ended'; readonly status: string; readonly stopReason: string | null }
  /**
   * The runner did not start the run: the contract was refused (for example `expired`), or
   * provisioning failed. `reason` is a code (ADR-M22 §2.4, ADR-M25 §2.8).
   */
  | { readonly outcome: 'refused'; readonly reason: string };

/**
 * The push of a run's changes (task C08, D-08 C08 AC1, design/ADR-M38 §2.2): the runner applies
 * the run's stored diff (the diff G5 checked) to a fresh clone of the run's base commit, makes one
 * commit and pushes `agent/INT-…`. Only after G5 passed (QUESTIONS #52).
 */
export interface PublishRunInput {
  readonly tenantId: string;
  readonly runId: string;
  /**
   * Single-use wrapping token around `{ token }`: a single-repository GitHub token with
   * `contents: write`, issued for this push only (ADR-M38 §2.3).
   */
  readonly wrappedPushToken: string;
}

export type PublishRunResult =
  /** The branch points at the run's commit (pushed now, or already by an earlier attempt). */
  | { readonly outcome: 'pushed' }
  /**
   * The runner did not push. `reason` is a code; the runner recorded it as the run event
   * `publish_refused` (final: a person decides, QUESTIONS #156) or `publish_failed` (may work on a
   * new attempt).
   */
  | { readonly outcome: 'refused' | 'failed'; readonly reason: string };

/** Activities of the runner's Temporal worker. */
export interface RunnerActivities {
  executeRun(input: ExecuteRunInput): Promise<ExecuteRunResult>;
  /** C08: push the run's checked changes (see `PublishRunInput`). */
  publishRun(input: PublishRunInput): Promise<PublishRunResult>;
}
