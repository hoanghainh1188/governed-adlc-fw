// Drives the agent of one run in its sandbox (D-08 C05 AC1–AC4, ADR-M29). Order:
//
// 1. the run must be `running` (provisioned by `provisionRun`);
// 2. LiteLLM must be on the contract's egress list (the agent reaches models only there, FR-50);
// 3. load the task: the contract's plan and the intent's spec (AC2); a plan read from a file
//    gives its tasks' text, read from the run's clone at the plan's commit (B09 PR 2);
// 4. join the run's network and start the agent with the contract's caps  → `agent_started`;
// 5. poll the agent. The iteration cap is the agent's own (`max_iterations`); the time cap is the
//    runner's: at `max_duration_min` it interrupts the agent, waits the grace period, and otherwise
//    leaves the sandbox to be removed (interrupt, then kill; AC3)          → `agent_stopped`;
//    the budget cap too (C07, `spend.ts`): the spend of the run's key is read every
//    `spendCheckMs`; a warning once at `budget.warn_percent`               → `budget_warning`;
//    a stop at `budget.stop_percent`, like at the time cap                 → `agent_stopped`;
//    an agent that ends with an error is checked once more against the budget (LiteLLM records
//    spend late): a budget stop is `stopped_budget`, never `failed`;
//    loop detection (C11 PR 2, `loop-watch.ts`, ADR-M42 §2.7): more identical tool calls in a
//    row than the contract's `loop_threshold`, or no new agent event for the configured window
//    → `loop_detected`, then `agent_stopped`; the run ends `stopped_stalled`. Order when several
//    stops are due in one poll: kill (a cancel of a run being killed is the kill), cancel, the
//    agent's own end, time cap, budget, loop;
// 6. when the agent finished: commit what it left, with the fixed agent author (QUESTIONS #80);
// 7. collect the changed files since `base_sha`, the last commit and the log (AC4);
// 7b. (C07, ADR-M34 §2.2) a run that goes to G5 (succeeded or stopped at a cap): the runner computes
//    its changes from the workspace in its own clone, stores the diff and checks it against the
//    plan and the agent instruction paths      → `diff_stored`, `changes_checked`; when that
//    fails the run fails (`agent_changes_unavailable`): no run reaches G5 unchecked;
// 8. end the run with its status, `stop_reason` and `iterations` → `agent_finished` (the HEAD the
//    sandbox reported goes to the event only: `runs.head_sha` is the commit the runner pushes after
//    G5, C08, ADR-M38 §2.2).
//
// The kill switch (C11, ADR-M42): while it polls the agent the driver also reads the run's status;
// `stopping` (or the activity's cancel while the run is `stopping`) stops the agent like at the
// time cap, ends the run `stopped_killed` / `killed` (`agent_stopped`, `agent_finished` with
// outcome `killed`), and then, best-effort and bounded (`killEvidenceMs`, QUESTIONS #183), kills
// the sandbox's processes, waits until the gateway refuses the run's key and stores the run's diff
// as evidence. A failure there
// is recorded (`kill_evidence_failed`) and never delays the kill.
//
// The run leaves `running` only with one conditional update: if the kill switch (C11) or the
// sweep moved it first, this driver changes nothing. The caller removes the sandbox (`Runner`).
// Paths, the log and texts are returned to the caller only; run events hold codes and counts.
import {
  AgentError,
  condensingFor,
  type AgentAdapter,
  type AgentFileReads,
  type AgentOutputs,
  type AgentRunHandle,
  type AgentRunState,
  type AgentRunStatus,
  type CondensingState,
  type ProjectConfig,
  type RedactedSecret,
  type RunContract,
  type RunKeySpendReader,
  type RunStatus,
  type SecretUnwrapper,
  TOOL_GATEWAY_URL,
} from '@sdlc/contracts';
import {
  KILLED,
  loadEffectiveConfig,
  parseTenantId,
  recordBudgetWarning,
  type PlatformDatabase,
  type TenantScope,
} from '@sdlc/core';

import { Redacted } from '@sdlc/secrets';

import type { DockerClient } from '../docker/client.js';
import type { Sandbox } from '../sandbox/lifecycle.js';
import type { RunnerSettings } from '../settings.js';
import type { MemoryFilesReader } from '../workspace/memory-files.js';
import type { PlanFileReader } from '../workspace/plan-file.js';
import { attachRunner } from './access.js';
import { AgentRunError } from './errors.js';
import { discardFeedbackToken, type FeedbackReader } from './feedback.js';
import { LoopWatch, type LoopStop } from './loop-watch.js';
import { SpendWatch } from './spend.js';
import { loadMemory } from './memory.js';
import { loadAgentTask } from './task.js';

/** The repository inside the sandbox (ADR-M25 §2.3). */
export const AGENT_WORKING_DIR = '/workspace';

/** Consecutive failed status calls before the runner gives up on the agent. */
const MAX_STATUS_ERRORS = 5;

export interface AgentDriveDeps {
  readonly db: PlatformDatabase;
  readonly docker: DockerClient;
  readonly settings: RunnerSettings;
  readonly adapter: AgentAdapter;
  /** Default: `new Date()`. Stored times. */
  readonly now?: () => Date;
  /** Default: `Date.now`. Deadlines. */
  readonly clock?: () => number;
  /** Default: `setTimeout`. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Default: the sandbox name on the run's network. Tests reach the Agent Server another way. */
  readonly agentUrl?: (runId: string) => string;
  /**
   * L1 runs (C06 session 2b, ADR-M33 §2.9): computes the proposal from the sandbox's workspace in
   * the runner's own clone and stores it as evidence; returns the number of changed paths. Without
   * it an L1 run that finished fails (`proposal_unavailable`).
   */
  readonly proposal?: (
    contract: RunContract,
    sandbox: Sandbox,
  ) => Promise<{ changedFiles: number }>;
  /**
   * Runs that go to G5 (C07, ADR-M34 §2.2): computes the run's changes in the runner's clone,
   * stores the diff as evidence and records `changes_checked`; returns the number of changed
   * paths. Without it such a run fails (`changes_unavailable`).
   */
  readonly changes?: (contract: RunContract, sandbox: Sandbox) => Promise<{ changedFiles: number }>;
  /**
   * Reads the spend of the run's key with the key itself (C07, ADR-M34 §2.6). Without it the
   * runner does not watch the budget; the gateway's cap still blocks calls.
   */
  readonly spendReader?: RunKeySpendReader;
  /**
   * True once the gateway refuses the run's key (C11): the worker revoked it. A killed run's diff
   * is stored only after that. Without it no diff is stored for a killed run.
   */
  readonly keyRevoked?: (key: RedactedSecret) => Promise<boolean>;
  /**
   * E01 PR 2: reads the feedback of a request for changes with the run's feedback token, and
   * opens its wrapping token. Without them a run that answers a request fails
   * (`feedback_unavailable`).
   */
  readonly feedbackReader?: FeedbackReader;
  readonly unwrapper?: SecretUnwrapper;
  /**
   * B09 PR 2 (ADR-M40 §2.7): reads the plan file at the plan's commit from the run's kept clone.
   * Without it a run whose plan was read from a file fails (`task_unavailable`, `no_clone`).
   */
  readonly planFile?: PlanFileReader;
  /** X13 PR 2: the memory notes of the run's kept clone (ADR-M74 §2.6). */
  readonly memoryFiles?: MemoryFilesReader;
}

export interface AgentRunRequest {
  readonly contract: RunContract;
  readonly sandbox: Sandbox;
  /** Model chosen by the caller (the agent's pinned model, QUESTIONS #79). */
  readonly model: string;
  /** The run's LiteLLM virtual key (Cost Controller `issueRunKey`). */
  readonly virtualKey: RedactedSecret;
  /**
   * Aborted when the run is cancelled (C06 session 2: the Temporal activity's cancel; C11: the kill
   * switch). The driver stops the agent like at the time cap (interrupt, then kill) and ends the
   * run `failed` (`agent_cancelled`); the caller then removes the sandbox. Never a concurrent
   * teardown while the agent is being driven.
   */
  readonly signal?: AbortSignal;
  /** E01 PR 2: the single-use wrapping token of the run's feedback token, when it has one. */
  readonly wrappedFeedbackToken?: RedactedSecret;
}

/** How the agent run ended (run event `agent_finished`). */
export type AgentOutcome =
  | 'finished'
  | 'max_iterations'
  | 'max_duration'
  | 'max_budget'
  | 'stuck'
  | 'loop_detected'
  | 'no_progress'
  | 'agent_error'
  | 'killed'
  | 'failed';

export interface AgentRunResult {
  readonly outcome: AgentOutcome;
  /** The run status this driver set, or undefined when the run had already left `running`. */
  readonly status: RunStatus | undefined;
  readonly stopReason: string | undefined;
  /** Undefined when the agent could not be reached any more (killed at the time cap, failures). */
  readonly outputs: AgentOutputs | undefined;
  /**
   * X07 (ADR-M90 §2.1): the files the agent's log shows it opened, also for an L1 run; undefined
   * when the log was not read. For the context snapshot only.
   */
  readonly reads?: AgentFileReads;
}

/** The fixed author of the platform's commit: it names the agent (G7 producer, FR-11, #80). */
export function agentCommitAuthor(contract: RunContract): { name: string; email: string } {
  return { name: 'sdlc-agent', email: `agent-${contract.agent_id}@agents.sdlc.invalid` };
}

export type EndOutcome = Exclude<AgentOutcome, 'failed' | 'killed'>;

/**
 * X11 (ADR-M29 §2.10, QUESTIONS #552): the fields of `agent_finished` for a run with condensing on.
 * Counts only, from the agent's last status; nothing when condensing is not on.
 */
export function condensingFields(
  state: CondensingState,
  status: Pick<AgentRunStatus, 'condensations' | 'eventsForgotten'> | undefined,
): { condensations?: number; events_forgotten?: number } {
  if (state !== 'summarize') return {};
  return {
    condensations: status?.condensations ?? 0,
    events_forgotten: status?.eventsForgotten ?? 0,
  };
}

export const STATUS_OF: Readonly<Record<EndOutcome, RunStatus>> = {
  finished: 'succeeded',
  // An iteration cap is a budget of agent steps (D-07 §6: "token cap and a maximum number of
  // iterations"); the stop reason tells which cap (ADR-M29).
  max_iterations: 'stopped_budget',
  max_duration: 'stopped_timeout',
  // The run's key reached `budget.stop_percent` of its cap (C07, FR-52).
  max_budget: 'stopped_budget',
  stuck: 'stopped_stalled',
  // Loop detection (C11 PR 2, FR-35): G5 treats both as `run_cap_reached` (ADR-M34 §2.8).
  loop_detected: 'stopped_stalled',
  no_progress: 'stopped_stalled',
  agent_error: 'failed',
};

export const STOP_REASON_OF: Readonly<Record<EndOutcome, string | undefined>> = {
  finished: undefined,
  max_iterations: 'max_iterations',
  max_duration: 'max_duration',
  max_budget: 'max_budget',
  stuck: 'agent_stuck',
  loop_detected: 'loop_detected',
  no_progress: 'no_progress',
  agent_error: 'agent_error',
};

export function clockOf(deps: Pick<AgentDriveDeps, 'clock'>): () => number {
  return deps.clock ?? Date.now;
}

export function sleepOf(deps: Pick<AgentDriveDeps, 'sleep'>): (ms: number) => Promise<void> {
  return deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
}

function nowOf(deps: AgentDriveDeps): Date {
  return deps.now ? deps.now() : new Date();
}

/** LiteLLM's `alias:port` must be in the contract's egress list, or the agent cannot reach it. */
export function llmReachable(contract: RunContract, llmBaseUrl: string): boolean {
  const url = new URL(llmBaseUrl);
  return contract.egress_allowlist.includes(`${url.hostname}:${url.port}`);
}

/** Outcome of an agent that stopped by itself. */
export function outcomeOf(
  state: AgentRunState,
  iterations: number,
  maxIterations: number,
): AgentOutcome {
  if (state === 'finished') return 'finished';
  if (state === 'stuck') return 'stuck';
  if (state === 'max_iterations') return 'max_iterations';
  // Backstop when the agent does not say why it stopped: the step count reached the cap.
  if (iterations >= maxIterations) return 'max_iterations';
  return 'agent_error';
}

/** What the poll loop and the stop step need: shared with the evaluation driver (task L04). */
export type PollDeps = Pick<AgentDriveDeps, 'adapter' | 'settings' | 'clock' | 'sleep'>;

export interface Polled {
  readonly state: AgentRunState;
  readonly iterations: number;
  readonly timedOut: boolean;
  readonly cancelled?: boolean;
  /** The run's key reached the stop share of its cap (C07). */
  readonly overBudget?: boolean;
  /** The run was moved to `stopping` by the kill switch (C11). */
  readonly killed?: boolean;
  /** Loop detection stopped the run (C11 PR 2). */
  readonly loop?: LoopStop;
  /** X11: condensing counts of the agent's last status. */
  readonly condensations?: number;
  readonly eventsForgotten?: number;
}

export async function pollUntilDone(
  deps: PollDeps,
  handle: AgentRunHandle,
  deadline: number,
  signal?: AbortSignal,
  watch?: SpendWatch,
  killRequested: () => Promise<boolean> = () => Promise.resolve(false),
  loops?: LoopWatch,
): Promise<Polled> {
  const clock = clockOf(deps);
  const sleep = sleepOf(deps);
  let errors = 0;
  let last: AgentRunStatus = { state: 'running', iterations: 0, events: 0, identicalCalls: 0 };
  let nextSpendCheck = clock() + deps.settings.agent.spendCheckMs;
  for (;;) {
    if (signal?.aborted) return { ...last, timedOut: false, cancelled: true };
    if (await killRequested()) return { ...last, timedOut: false, killed: true };
    let read = false;
    try {
      last = await deps.adapter.getStatus(handle);
      errors = 0;
      read = true;
    } catch (error) {
      errors += 1;
      if (errors >= MAX_STATUS_ERRORS) throw error;
    }
    if (last.state !== 'running') return { ...last, timedOut: false };
    if (clock() >= deadline) return { ...last, timedOut: true };
    // The budget before the loop checks: `stopped_budget` tells the reviewer more (ADR-M42 §2.7).
    if (watch && clock() >= nextSpendCheck) {
      if ((await watch.check()) === 'stop') return { ...last, timedOut: false, overBudget: true };
      nextSpendCheck = clock() + deps.settings.agent.spendCheckMs;
    }
    // Only a status that was read is observed. The idle clock is wall time, so failed reads count
    // as silence; the fifth failed read in a row fails the run anyway (`MAX_STATUS_ERRORS`).
    const loop = read ? loops?.observe(last) : undefined;
    if (loop) return { ...last, timedOut: false, loop };
    await sleep(Math.min(deps.settings.agent.pollMs, Math.max(0, deadline - clock())));
  }
}

/** Interrupt, then wait up to the grace period. `kill`: the agent did not stop in time. */
export async function stopAtTimeCap(
  deps: PollDeps,
  handle: AgentRunHandle,
): Promise<{ method: 'interrupt' | 'kill'; iterations: number | undefined }> {
  const clock = clockOf(deps);
  const sleep = sleepOf(deps);
  const graceEnd = clock() + deps.settings.agent.stopGraceMs;
  try {
    await deps.adapter.stop(handle);
  } catch {
    return { method: 'kill', iterations: undefined };
  }
  for (;;) {
    try {
      const status = await deps.adapter.getStatus(handle);
      if (status.state !== 'running') return { method: 'interrupt', iterations: status.iterations };
    } catch {
      // keep trying until the grace period ends
    }
    if (clock() >= graceEnd) return { method: 'kill', iterations: undefined };
    await sleep(Math.min(deps.settings.agent.pollMs, Math.max(0, graceEnd - clock())));
  }
}

async function endRun(
  deps: AgentDriveDeps,
  scope: TenantScope,
  contract: RunContract,
  change: {
    readonly outcome: AgentOutcome;
    readonly status: RunStatus;
    readonly stopReason: string | undefined;
    readonly iterations: number | undefined;
    readonly outputs: AgentOutputs | undefined;
    readonly commit: 'committed' | 'nothing' | undefined;
    /** L1: the changed paths of the proposal, computed by the runner. */
    readonly changedFiles?: number;
    /** X11: the condensing counts (`condensingFields`). */
    readonly condensed?: ReturnType<typeof condensingFields>;
  },
): Promise<RunStatus | undefined> {
  const now = nowOf(deps);
  // A kill that landed after the last poll still wins: the run then ends `stopped_killed` (C11).
  const ended = await scope.runs.end(contract.run_id, {
    from: ['running'],
    to: change.status,
    now,
    finishedAt: now,
    ...(change.stopReason ? { stopReason: change.stopReason } : {}),
    ...(change.iterations === undefined ? {} : { iterations: change.iterations }),
  });
  await scope.runEvents.append(contract.run_id, 'agent_finished', {
    outcome: change.outcome,
    iterations: change.iterations ?? 0,
    ...(change.outputs
      ? { changed_files: change.outputs.changedFiles.length, head_sha: change.outputs.headSha }
      : change.changedFiles === undefined
        ? {}
        : { changed_files: change.changedFiles }),
    ...(change.commit ? { commit: change.commit } : {}),
    ...change.condensed,
  });
  return ended;
}

async function failRun(
  deps: AgentDriveDeps,
  scope: TenantScope,
  contract: RunContract,
  reason: string,
): Promise<AgentRunResult> {
  await scope.runEvents.append(contract.run_id, 'agent_failed', { reason });
  const stopReason = reason.startsWith('agent_') ? reason : `agent_${reason}`;
  const now = nowOf(deps);
  const ended = await scope.runs.end(contract.run_id, {
    from: ['running'],
    to: 'failed',
    now,
    finishedAt: now,
    stopReason,
  });
  if (ended === 'stopped_killed') {
    return { outcome: 'killed', status: ended, stopReason: KILLED, outputs: undefined };
  }
  return { outcome: 'failed', status: ended, stopReason, outputs: undefined };
}

/** Runs the agent of a provisioned run to its end. Never throws for agent or task failures. */
export async function driveAgent(
  deps: AgentDriveDeps,
  request: AgentRunRequest,
): Promise<AgentRunResult> {
  const { contract, sandbox } = request;
  const scope = deps.db.forTenant(parseTenantId(contract.tenant_id));
  const run = await scope.runs.getById(contract.run_id);
  // E01 PR 2: the run's feedback token, revoked on every exit that does not read with it.
  const feedback = {
    reader: deps.feedbackReader,
    unwrapper: deps.unwrapper,
    wrappedToken: request.wrappedFeedbackToken,
  };
  // Killed between provisioning and the start (C11): no agent to stop.
  if (run?.status === 'stopping') {
    await discardFeedbackToken(scope, contract.run_id, feedback);
    return endKilled(deps, scope, contract, undefined);
  }
  if (run?.status !== 'running') {
    await discardFeedbackToken(scope, contract.run_id, feedback);
    throw new AgentRunError('run_not_running');
  }
  const killRequested = () => isStopping(scope, contract.run_id);

  let handle: AgentRunHandle;
  let watch: SpendWatch | undefined;
  let config: ProjectConfig;
  let condensing: CondensingState;
  let taskLoading = false;
  try {
    if (!llmReachable(contract, deps.settings.agent.llmBaseUrl)) {
      throw new AgentRunError('model_unreachable');
    }
    // The effective configuration when the run starts: budget shares and the loop window.
    ({ config } = await loadEffectiveConfig(scope.projectConfigs, contract.project_id));
    watch = spendWatchFor(deps, scope, contract, request.virtualKey, config);
    // X11 (ADR-M29 §2.10): the project's condensing, for this run's adapter and model.
    const condenser = condensingFor(
      config.run.context_condensing,
      contract.agent_adapter,
      request.model,
    );
    condensing = condenser.state;
    taskLoading = true; // from here `readRunFeedback` uses or revokes the token
    const loaded = await loadAgentTask(scope, contract, feedback, deps.planFile);
    // X13 PR 2 (ADR-M74 §2.6): approved memory notes, or none; never fails the run.
    const memory = await loadMemory(scope, contract, config.memory, deps.memoryFiles);
    const task = {
      ...loaded,
      ...(memory === undefined ? {} : { memory }),
      // X13 PR 3a (ADR-M74 §2.5): L1 runs never propose; evaluation runs never get here.
      ...(config.memory.mode === 'read_propose' && contract.autonomy_level !== 'L1'
        ? {
            memoryProposal: {
              maxFiles: config.memory.max_files,
              maxFileChars: config.memory.max_file_chars,
            },
          }
        : {}),
    };
    const endpoint = await attachRunner(
      deps.docker,
      deps.settings,
      sandbox,
      deps.agentUrl?.(contract.run_id),
    );
    handle = await deps.adapter.startRun({
      contract,
      endpoint,
      model: {
        model: request.model,
        baseUrl: deps.settings.agent.llmBaseUrl,
        virtualKey: request.virtualKey,
      },
      task,
      workingDir: AGENT_WORKING_DIR,
      // X04 (ADR-M69 §2.4): the run's MCP gateway, when the contract grants register tools.
      ...(sandbox.toolKey === undefined
        ? {}
        : { tools: { url: TOOL_GATEWAY_URL, key: new Redacted(sandbox.toolKey) } }),
      ...(condenser.condensing === undefined ? {} : { condensing: condenser.condensing }),
    });
  } catch (error) {
    if (!taskLoading) await discardFeedbackToken(scope, contract.run_id, feedback);
    return failRun(deps, scope, contract, failureCode(error));
  }
  await scope.runEvents.append(contract.run_id, 'agent_started', {
    max_iterations: contract.max_iterations,
    max_duration_min: contract.max_duration_min,
    // Left out when off, so a run without condensing has the same event as before X11.
    ...(condensing === 'off' ? {} : { condensing }),
  });

  const deadline = clockOf(deps)() + contract.max_duration_min * 60_000;
  const loops = new LoopWatch(
    {
      identicalCallsMax: contract.loop_threshold,
      noProgressWindowMs: config.run.loop_detection.no_progress_window_minutes * 60_000,
    },
    clockOf(deps),
  );
  let polled: Polled;
  try {
    polled = await pollUntilDone(
      deps,
      handle,
      deadline,
      request.signal,
      watch,
      killRequested,
      loops,
    );
  } catch (error) {
    return failRun(deps, scope, contract, failureCode(error));
  }
  // The activity's cancel of a run that is being killed is the kill (C11).
  if (polled.killed || (polled.cancelled && (await killRequested()))) {
    const stopped = await stopAtTimeCap(deps, handle);
    await scope.runEvents.append(contract.run_id, 'agent_stopped', {
      reason: 'killed',
      method: stopped.method,
    });
    const result = await endKilled(
      deps,
      scope,
      contract,
      stopped.iterations ?? polled.iterations,
      condensingFields(condensing, polled),
    );
    if (result.status === 'stopped_killed') await storeKilledEvidence(deps, scope, request);
    return result;
  }
  if (polled.cancelled) {
    const stopped = await stopAtTimeCap(deps, handle);
    await scope.runEvents.append(contract.run_id, 'agent_stopped', {
      reason: 'cancelled',
      method: stopped.method,
    });
    return failRun(deps, scope, contract, 'cancelled');
  }

  let outcome: AgentOutcome;
  let iterations: number | undefined = polled.iterations;
  let reachable = true;
  if (polled.timedOut || polled.overBudget || polled.loop) {
    const reason = polled.overBudget ? 'max_budget' : (polled.loop?.reason ?? 'max_duration');
    if (polled.loop) {
      await scope.runEvents.append(contract.run_id, 'loop_detected', {
        identical_calls: polled.loop.identical_calls,
        threshold: polled.loop.threshold,
        idle_minutes: polled.loop.idle_minutes,
      });
    }
    const stopped = await stopAtTimeCap(deps, handle);
    await scope.runEvents.append(contract.run_id, 'agent_stopped', {
      reason,
      method: stopped.method,
    });
    outcome = reason;
    iterations = stopped.iterations ?? iterations;
    reachable = stopped.method === 'interrupt';
  } else {
    outcome = outcomeOf(polled.state, polled.iterations, contract.max_iterations);
    // The gateway refuses calls past the key's cap and records spend late (ADR-M34 §2.6).
    if (
      outcome === 'agent_error' &&
      watch &&
      (await watch.settleAfterError(sleepOf(deps), deps.settings.agent.spendRecheckMs))
    ) {
      outcome = 'max_budget';
    }
  }

  let commit: 'committed' | 'nothing' | undefined;
  let outputs: AgentOutputs | undefined;
  // L1: the result is a proposal, never a commit or a push (FR-03, T09, ADR-M33 §2.9).
  const proposalOnly = contract.autonomy_level === 'L1';
  let proposed: { changedFiles: number } | undefined;
  if (reachable && outcome === 'finished' && proposalOnly) {
    if (!deps.proposal) return failRun(deps, scope, contract, 'proposal_unavailable');
    try {
      proposed = await deps.proposal(contract, sandbox);
    } catch {
      return failRun(deps, scope, contract, 'proposal_failed');
    }
  }
  if (reachable) {
    try {
      if (outcome === 'finished' && !proposalOnly) {
        const done = await deps.adapter.commitWork(handle, {
          branch: contract.branch,
          author: agentCommitAuthor(contract),
          message: `sdlc: agent run ${contract.run_id}`,
        });
        commit = done.committed ? 'committed' : 'nothing';
      }
      outputs = await deps.adapter.collectOutputs(handle, contract.base_sha);
      iterations = outputs.iterations;
    } catch (error) {
      return failRun(deps, scope, contract, failureCode(error));
    }
  }

  const status: RunStatus = proposed ? 'succeeded_proposal_only' : STATUS_OF[outcome as EndOutcome];
  const stopReason = STOP_REASON_OF[outcome as EndOutcome];
  // C07: every run that goes to G5 has its changes checked outside the sandbox first.
  if (TO_G5.includes(status)) {
    if (!deps.changes) return failRun(deps, scope, contract, 'changes_unavailable');
    try {
      await deps.changes(contract, sandbox);
    } catch {
      return failRun(deps, scope, contract, 'changes_unavailable');
    }
  }
  const set = await endRun(deps, scope, contract, {
    outcome,
    status,
    stopReason,
    iterations,
    // What the sandbox reports is not the result of an L1 run: no head commit is recorded.
    outputs: proposalOnly ? undefined : outputs,
    commit,
    ...(proposed ? { changedFiles: proposed.changedFiles } : {}),
    condensed: condensingFields(condensing, polled),
  });
  const reads = outputs ? { reads: outputs.reads } : {};
  if (set === 'stopped_killed') {
    return { outcome: 'killed', status: set, stopReason: KILLED, outputs: undefined, ...reads };
  }
  return {
    outcome,
    status: set,
    stopReason,
    outputs: proposalOnly ? undefined : outputs,
    ...reads,
  };
}

/** The run was moved to `stopping` (C11). A read error is not a kill: the next poll reads again. */
async function isStopping(scope: TenantScope, runId: string): Promise<boolean> {
  try {
    return (await scope.runs.getById(runId))?.status === 'stopping';
  } catch {
    return false;
  }
}

/** Ends a killed run: `stopping → stopped_killed` (C11, migration 0020). */
async function endKilled(
  deps: AgentDriveDeps,
  scope: TenantScope,
  contract: RunContract,
  iterations: number | undefined,
  condensed: ReturnType<typeof condensingFields> = {},
): Promise<AgentRunResult> {
  const now = nowOf(deps);
  const moved = await scope.runs.transition(contract.run_id, {
    from: ['stopping'],
    to: 'stopped_killed',
    now,
    finishedAt: now,
    stopReason: KILLED,
    ...(iterations === undefined ? {} : { iterations }),
  });
  await scope.runEvents.append(contract.run_id, 'agent_finished', {
    outcome: 'killed',
    iterations: iterations ?? 0,
    ...condensed,
  });
  return {
    outcome: 'killed',
    status: moved ? 'stopped_killed' : undefined,
    stopReason: KILLED,
    outputs: undefined,
  };
}

/**
 * The diff of a killed run, as evidence for the review (QUESTIONS #183): only after the run is
 * `stopped_killed` and the gateway refuses its key, within `killEvidenceMs`. Best-effort: every
 * failure is recorded (`kill_evidence_failed`) and the caller removes the sandbox anyway.
 */
async function storeKilledEvidence(
  deps: AgentDriveDeps,
  scope: TenantScope,
  request: AgentRunRequest,
): Promise<void> {
  const { contract } = request;
  const fail = async (reason: string): Promise<void> => {
    await scope.runEvents
      .append(contract.run_id, 'kill_evidence_failed', { reason })
      .catch(() => undefined);
  };
  if (!deps.changes || !deps.keyRevoked) return fail('unavailable');
  // Nothing in the sandbox may change the workspace while it is read, not even a process the
  // agent left running: kill every process first (the volume stays). Security review of C11.
  try {
    await deps.docker.containerKill(request.sandbox.names.container);
  } catch {
    return fail('sandbox_not_stopped');
  }
  const clock = clockOf(deps);
  const deadline = clock() + deps.settings.agent.killEvidenceMs;
  for (;;) {
    if (await deps.keyRevoked(request.virtualKey).catch(() => false)) break;
    if (clock() >= deadline) return fail('key_not_revoked');
    await sleepOf(deps)(Math.min(deps.settings.agent.pollMs, Math.max(0, deadline - clock())));
  }
  const changes = deps.changes;
  const left = Math.max(0, deadline - clock());
  let timer: NodeJS.Timeout | undefined;
  try {
    const outcome = await Promise.race([
      changes(contract, request.sandbox).then(() => 'stored' as const),
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), left);
      }),
    ]);
    if (outcome === 'timeout') await fail('timeout');
  } catch {
    await fail('failed');
  } finally {
    clearTimeout(timer);
  }
}

/** Run statuses that go to G5 (core `finishRun`): their changes are checked first (C07). */
const TO_G5: readonly RunStatus[] = [
  'succeeded',
  'stopped_budget',
  'stopped_scope',
  'stopped_timeout',
  'stopped_stalled',
];

/** The run's spend watch, with the project's warning and stop shares; none without a reader. */
function spendWatchFor(
  deps: AgentDriveDeps,
  scope: TenantScope,
  contract: RunContract,
  key: RedactedSecret,
  config: ProjectConfig,
): SpendWatch | undefined {
  if (!deps.spendReader) return undefined;
  return new SpendWatch({
    reader: deps.spendReader,
    key,
    contractCapUsd: contract.max_budget_usd,
    limits: { warnPercent: config.budget.warn_percent, stopPercent: config.budget.stop_percent },
    // C07 decision C: the run event and the intent's notice in one transaction (FR-52).
    onWarning: async (warning) => {
      await recordBudgetWarning(
        scope,
        { runId: contract.run_id, intentId: contract.intent_id },
        warning,
      );
    },
  });
}

export function failureCode(error: unknown): string {
  if (error instanceof AgentRunError) return error.reason;
  if (error instanceof AgentError) return error.code;
  return 'runner_error';
}
