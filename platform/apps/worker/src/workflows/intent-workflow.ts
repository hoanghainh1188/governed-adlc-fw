// The intent workflow on Temporal (D-08 B07 AC1 and AC5, design/D-03 section 6, ADR-M30; the run
// after G4: D-08 C06 AC4, ADR-M33 §2.6).
//
// A thin durable loop. The database is the source of truth: the `stepIntent` activity reads the
// intent under its lock and makes at most one move (core `stepIntent`). The workflow steps again
// after a move, waits for a wake signal when there is nothing to do, and ends when the intent is
// finished. It holds no client data: its input, signal and activity results are IDs and codes.
//
// C06 session 2: when G4 is decided the step asks for a run (`run_prepare`). The workflow prepares
// it (`prepareRun`, worker), hands it to the runner (`executeRun` on the task queue `sdlc-runner`:
// one long-running activity with heartbeats, one attempt), and asks the step again. When the run
// ended the step says `run_ended` and the workflow calls `finishRun`. A lost runner (heartbeat
// timeout, activity failure) → `abandonRun`: the run's key is revoked at once and the run fails.
// Old histories never saw the run outcomes, so the new branches replay them unchanged (no patch).
//
// C08 (ADR-M38 §2.1): when G5 passed a run and its block window closed, the step says `publish`.
// `push`: `preparePublish` (worker: a single-repository `contents: write` token, wrapped), then
// `publishRun` on the runner's queue (one attempt, heartbeats), then `finishPublish` (worker: the
// pull request). `open_pr`: `finishPublish` only. A lost runner counts as a failed attempt
// (`abandonPublish`); a failed push waits `RUN_ACTIVITY_RETRY_MS` before the step is asked again.
//
// C11 (ADR-M42 §2.2): the kill switch records the kill in the database first, then sends the
// `kill` signal. While `executeRun` is pending (waiting for a runner slot, or running), the signal
// cancels it: an activity that has not started never starts, and a running one gets the cancel on
// its next heartbeat (the runner also sees `stopping` in the database within a poll). The workflow
// first asks the worker to revoke the run's key (`revokeKilledRunKey`), then waits until the
// runner has stopped the agent and cleaned up (`WAIT_CANCELLATION_COMPLETED`). A kill signal at
// any other time changes nothing. Old histories never saw the signal and replay unchanged.
//
// Deterministic code only: this file is bundled for the Temporal workflow sandbox and may import
// `@temporalio/workflow`, `@sdlc/contracts` and types (lint rule in eslint.config.mjs).
// The escalation clocks are not timers here (ADR-M28): the workflow asks the database. The only
// timers are the one a step asks for (`wakeInMs`) and the pause after a failed activity.
import {
  INTENT_KILL_SIGNAL,
  INTENT_WAKE_SIGNAL,
  BREAK_GLASS_PRIORITY_KEY,
  RUNNER_TASK_QUEUE,
  type IntentStepResult,
  type IntentWorkflowRef,
  type RunnerActivities,
} from '@sdlc/contracts';
import {
  ActivityCancellationType,
  CancellationScope,
  condition,
  continueAsNew,
  defineSignal,
  proxyActivities,
  setHandler,
  sleep,
  workflowInfo,
} from '@temporalio/workflow';

import type { IntentActivities } from '../activities/intent-activities.js';

export const wakeSignal = defineSignal(INTENT_WAKE_SIGNAL);
export const killSignal = defineSignal(INTENT_KILL_SIGNAL);

/**
 * Moves in a row before the workflow waits for a signal anyway. G1–G3 need at most 4 moves on one
 * wake-up; the cap stops a loop if a move keeps being reported without progress.
 */
export const MAX_MOVES_PER_WAKE = 16;

/** Shortest timer the workflow sets for a `wakeInMs`. */
export const MIN_TIMER_MS = 1000;

/** Pause before the workflow asks again after a run activity failed (the worker, not the run). */
export const RUN_ACTIVITY_RETRY_MS = 60_000;

const { stepIntent } = proxyActivities<IntentActivities>({
  startToCloseTimeout: '1 minute',
  retry: {
    initialInterval: '1 second',
    maximumInterval: '1 minute',
    // A missing intent never appears later: fail the workflow instead of retrying for ever.
    nonRetryableErrorTypes: ['WorkflowError'],
  },
});

// The run activities are not retried by Temporal: a retry could issue a second contract or finish
// twice. The database says what to do next, so the workflow simply asks the step again.
const {
  prepareRun,
  finishRun,
  abandonRun,
  revokeKilledRunKey,
  preparePublish,
  finishPublish,
  abandonPublish,
} = proxyActivities<IntentActivities>({
  startToCloseTimeout: '5 minutes',
  retry: { maximumAttempts: 1 },
});

// One run = one attempt. The runner sends a heartbeat at least every 30 seconds; a lost heartbeat
// means the runner is gone (ADR-M33 §2.7). The run itself is capped by its contract
// (`max_duration_min`, at most a few hours in the MVP).
const { executeRun } = proxyActivities<RunnerActivities>({
  taskQueue: RUNNER_TASK_QUEUE,
  startToCloseTimeout: '12 hours',
  heartbeatTimeout: '2 minutes',
  retry: { maximumAttempts: 1 },
  // C11: a kill cancels the activity and waits until the runner stopped the agent and cleaned up.
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
});

// H08 (ADR-M111 §2.2): the same activity, first in the runner queue (Temporal task priority: a
// lower key goes first; the default key is 3). Used only when `prepareRun` says `break_glass`.
const { executeRun: executeRunFirst } = proxyActivities<RunnerActivities>({
  taskQueue: RUNNER_TASK_QUEUE,
  startToCloseTimeout: '12 hours',
  heartbeatTimeout: '2 minutes',
  retry: { maximumAttempts: 1 },
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  priority: { priorityKey: BREAK_GLASS_PRIORITY_KEY },
});

// E03 (ADR-M49 §2.1): the release pack reads every stored evidence file back (minutes). One
// attempt: the step asks again when it is still needed (the build is idempotent).
const { buildReleasePack } = proxyActivities<IntentActivities>({
  startToCloseTimeout: '15 minutes',
  retry: { maximumAttempts: 1 },
});

// C08: one push = one attempt (clone, apply, push; minutes, not hours).
const { publishRun } = proxyActivities<RunnerActivities>({
  taskQueue: RUNNER_TASK_QUEUE,
  startToCloseTimeout: '15 minutes',
  heartbeatTimeout: '2 minutes',
  retry: { maximumAttempts: 1 },
});

export async function intentWorkflow(ref: IntentWorkflowRef): Promise<string> {
  let wakes = 0;
  setHandler(wakeSignal, () => {
    wakes += 1;
  });
  let kills = 0;
  setHandler(killSignal, () => {
    kills += 1;
  });
  const killCount = () => kills;
  let moves = 0;
  for (;;) {
    const seen = wakes;
    const result: IntentStepResult = await stepIntent(ref);
    if (result.outcome === 'finished') return result.status;
    if (moves < MAX_MOVES_PER_WAKE) {
      if (result.outcome === 'moved') {
        moves += 1;
        continue;
      }
      if (result.outcome === 'run_prepare' || result.outcome === 'run_ended') {
        moves += 1;
        if (!(await driveRun(ref, result, killCount))) await sleep(RUN_ACTIVITY_RETRY_MS);
        continue;
      }
      if (result.outcome === 'publish') {
        moves += 1;
        if (!(await drivePublish(ref, result))) await sleep(RUN_ACTIVITY_RETRY_MS);
        continue;
      }
      if (result.outcome === 'build_pack') {
        moves += 1;
        if (!(await driveReleasePack(ref))) await sleep(RUN_ACTIVITY_RETRY_MS);
        continue;
      }
    }
    moves = 0;
    const wakeInMs = result.outcome === 'waiting' ? result.wakeInMs : undefined;
    if (wakeInMs === undefined) {
      await condition(() => wakes !== seen);
    } else {
      // At least one second: a deadline that just passed is handled by the next step anyway.
      await condition(() => wakes !== seen, Math.max(MIN_TIMER_MS, wakeInMs));
    }
    // Long waits with many wake-ups: start a fresh history (the state lives in the database).
    if (workflowInfo().continueAsNewSuggested) {
      await continueAsNew<typeof intentWorkflow>(ref);
    }
  }
}

/**
 * E03: builds the release pack at G8. False when the store could not be used or the activity
 * failed: the workflow waits a little and asks the step again.
 */
async function driveReleasePack(ref: IntentWorkflowRef): Promise<boolean> {
  try {
    return (await buildReleasePack(ref)) !== 'unavailable';
  } catch {
    return false;
  }
}

/**
 * One piece of a run's round. Returns false when a worker activity failed (the workflow waits a
 * little and asks the step again); the runner's failure is not one: the run is abandoned.
 */
async function driveRun(
  ref: IntentWorkflowRef,
  result: Extract<IntentStepResult, { outcome: 'run_prepare' | 'run_ended' }>,
  killCount: () => number,
): Promise<boolean> {
  try {
    if (result.outcome === 'run_ended') {
      await finishRun(ref, result.runId);
      return true;
    }
    // A kill signal from now on is about the run prepared here (C11).
    const seenKills = killCount();
    const prepared = await prepareRun(ref);
    if (!prepared.ok) return true;
    try {
      await executeKillable(ref, prepared, () => killCount() !== seenKills);
    } catch {
      // Heartbeat timeout, the runner stopped, the activity failed, or the kill cancelled it: the
      // run is lost or killed (core `abandonRun` ends it accordingly and revokes the key).
      await abandonRun(ref, prepared.runId);
    }
    return true;
  } catch {
    return false;
  }
}

/** `executeRun`, cancelled when a kill signal arrives while it is pending (C11, see the header). */
async function executeKillable(
  ref: IntentWorkflowRef,
  prepared: Extract<Awaited<ReturnType<typeof prepareRun>>, { ok: true }>,
  killed: () => boolean,
): Promise<void> {
  const scope = new CancellationScope();
  let settled = false;
  const run = prepared.priority === 'break_glass' ? executeRunFirst : executeRun;
  const execution = scope.run(() =>
    run({
      tenantId: ref.tenantId,
      runId: prepared.runId,
      modelRef: prepared.modelRef,
      wrappedGitToken: prepared.wrappedGitToken,
      wrappedVirtualKey: prepared.wrappedVirtualKey,
      // E01 PR 2: a wrapping token only; the feedback text never enters the history.
      ...(prepared.wrappedFeedbackToken === undefined
        ? {}
        : { wrappedFeedbackToken: prepared.wrappedFeedbackToken }),
      // X04 PR 3b: wrapping tokens and index IDs only.
      ...(prepared.toolSecrets === undefined ? {} : { toolSecrets: prepared.toolSecrets }),
    }),
  );
  const markSettled = () => {
    settled = true;
  };
  execution.then(markSettled, markSettled);
  await condition(() => settled || killed());
  if (!settled) {
    scope.cancel();
    try {
      await revokeKilledRunKey(ref, prepared.runId);
    } catch {
      // `finishRun` or `abandonRun` revokes it when the run ends.
    }
  }
  await execution;
}

/**
 * The push and the pull request at G6 (C08). Returns false when an activity failed or the push
 * failed for a cause that may pass: the workflow waits a little and asks the step again, which
 * stops after `MAX_PUBLISH_ATTEMPTS` (core).
 */
async function drivePublish(
  ref: IntentWorkflowRef,
  result: Extract<IntentStepResult, { outcome: 'publish' }>,
): Promise<boolean> {
  try {
    if (result.step === 'push') {
      const prepared = await preparePublish(ref, result.runId);
      if (!prepared.ok) return prepared.reason !== 'token_failed';
      let pushed;
      try {
        pushed = await publishRun({
          tenantId: ref.tenantId,
          runId: result.runId,
          wrappedPushToken: prepared.wrappedPushToken,
        });
      } catch {
        await abandonPublish(ref, result.runId, 'runner_lost');
        return false;
      }
      if (pushed.outcome === 'failed') return false;
      if (pushed.outcome === 'refused') return true;
    }
    const finished = await finishPublish(ref, result.runId);
    return finished.ok || finished.reason !== 'pr_failed';
  } catch {
    // A worker activity failed unexpectedly: count it, so the round never retries for ever.
    try {
      await abandonPublish(ref, result.runId, 'worker_failed');
    } catch {
      // The database is down too: the pause below and the next step try again.
    }
    return false;
  }
}
