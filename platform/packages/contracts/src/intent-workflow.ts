// The intent workflow on Temporal (task B07, design/ADR-M30). Names shared by the worker, which
// runs the workflow, and by the processes that wake it (api, poller). Pure constants: the
// workflow code imports this module too, and it must stay deterministic.

/** Temporal task queue of the intent workflow. The runner has its own queue (`sdlc-runner`, C06). */
export const INTENT_TASK_QUEUE = 'sdlc-intents';

/** Workflow type name (the exported workflow function). */
export const INTENT_WORKFLOW_TYPE = 'intentWorkflow';

/**
 * Signal that asks the workflow to read the intent's state again. It carries no data: the
 * database is the source of truth, so a duplicate or replayed signal is harmless.
 */
export const INTENT_WAKE_SIGNAL = 'wake';

/**
 * Signal that tells the workflow a run of the intent is being killed (task C11, ADR-M42 §2.2). No
 * data: the database says which run (`stopping` or `stopped_killed`). The workflow cancels the
 * run's activity when the signal arrives while that activity is pending, so a run waiting for a
 * runner slot never starts and a running one stops on its next heartbeat. A signal at any other
 * time changes nothing.
 */
export const INTENT_KILL_SIGNAL = 'kill';

/** Input of the workflow and of its activities: IDs only, never client data (ADR-M30). */
export interface IntentWorkflowRef {
  readonly tenantId: string;
  readonly intentId: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Workflow ID of an intent: `intent/<tenant_id>/<intent_id>`. Throws for IDs that are not UUIDs. */
export function intentWorkflowId(ref: IntentWorkflowRef): string {
  if (!UUID.test(ref.tenantId) || !UUID.test(ref.intentId)) {
    throw new Error('intentWorkflowId: tenant and intent IDs must be lowercase UUIDs');
  }
  return `intent/${ref.tenantId}/${ref.intentId}`;
}

/**
 * Wakes the workflow of an intent, starting it when it does not run yet (Temporal
 * signal-with-start). Implemented by `@sdlc/workflow-client`; tests pass a fake.
 */
export interface IntentWorkflowSignals {
  wake(ref: IntentWorkflowRef): Promise<void>;
  /** C11: the kill signal, to a workflow that runs (never starts one). */
  kill(ref: IntentWorkflowRef): Promise<void>;
}

/** What one step of the workflow did (the `stepIntent` activity). Codes only. */
export type IntentStepResult =
  /** The intent moved: status or gate changed. The workflow steps again at once. */
  | { readonly outcome: 'moved' }
  /**
   * Nothing to do until something changes; the workflow waits for a wake signal. With `wakeInMs`
   * it also steps again after that delay without a signal (session 2: the gate deadline, the end
   * of a HOTL block window). The delay is relative, so the workflow never compares its own clock
   * with the database's.
   */
  | {
      readonly outcome: 'waiting';
      readonly reason: IntentWaitReason;
      readonly wakeInMs?: number;
      /**
       * U02 (ADR-M54 §2.4b): a code that says more about the reason; the step records it with
       * the reason. Today the failed G4 check (`gate.g4_check_failed`'s `check`); open to later
       * gates. Never free text.
       */
      readonly cause?: string;
    }
  /** The intent is finished (`done`, `rejected`, `cancelled`, `blocked`); the workflow ends. */
  | { readonly outcome: 'finished'; readonly status: string }
  /**
   * C06 session 2 (ADR-M33 §2.6): the intent is `running` and needs a new run. The workflow calls
   * `prepareRun`, then hands the run to the runner (task queue `sdlc-runner`).
   */
  | { readonly outcome: 'run_prepare' }
  /** C06 session 2: the intent's run ended (a final status); the workflow calls `finishRun`. */
  | { readonly outcome: 'run_ended'; readonly runId: string }
  /**
   * C08 (ADR-M38 §2.1): the run passed G5 and its block window closed. `push`: the workflow asks
   * for a push token (`preparePublish`), the runner pushes (`publishRun`), then the worker opens
   * or finds the pull request (`finishPublish`). `open_pr`: the branch is pushed; only
   * `finishPublish` is left.
   */
  | { readonly outcome: 'publish'; readonly runId: string; readonly step: 'push' | 'open_pr' }
  /**
   * E03 (ADR-M49 §2.1): the intent waits at G8 and its Evidence Pack is missing or out of date.
   * The workflow calls the worker activity `buildReleasePack` (minutes: every stored evidence file
   * is read back and checked), then steps again.
   */
  | { readonly outcome: 'build_pack' };

export type IntentWaitReason =
  /** The gate needs a person's decision. */
  | 'decision'
  /** The gate's input (spec at G2, plan at G3) does not exist yet. */
  | 'input_missing'
  /**
   * The project AI record is missing or does not allow the intent's data class: the submit waits
   * until the record is fixed (D-02 FR-19, ADR-M32 §2.5).
   */
  | 'ai_record'
  /** An escalation freezes the intent (ADR-M28 §2.4). */
  | 'frozen'
  /**
   * The intent waits at a gate this worker does not handle (a dependency is off, for example the
   * Cost Controller AppRole for G4 or the publish dependencies for G6).
   */
  | 'later_gate'
  /**
   * U02 (ADR-M54 §2.4b): a HOTL block window of a gate the platform passed is still open (ADR-M30
   * §2.4b): a person with the gate's role may still send the passed gate back. The step wakes when
   * the window closes (`wakeInMs`), and records that time.
   */
  | 'hotl_block_window'
  /**
   * A G4 check failed (task C06, ADR-M33): the agent, its instructions, the AI record, the
   * approved inputs or the budget. A system `fail` records the cause; the next wake checks again.
   */
  | 'g4_check'
  /** G4 passed or was approved; the run starts (C06 session 2 hands it to the runner). */
  | 'run_pending'
  /**
   * The Git host could not be read for the G4 facts (base commit, instructions file) or for the
   * spec check at G2–G4 (B08).
   */
  | 'git_host_unavailable'
  /**
   * B08 (ADR-M39 §2.4): the linked spec cannot be read at the head of the default branch; the
   * intent waits at G2 until a person links a spec that can be read.
   */
  | 'spec_unavailable'
  /**
   * S01 (ADR-M61, D-02 §6.2): the linked spec has no acceptance criteria (or was linked before
   * S01, QUESTIONS #290); G2 waits until a person links a spec with at least one.
   */
  | 'spec_unclear'
  /**
   * B09 (ADR-M40 §2.4, QUESTIONS #167): the plan file at the head of the default branch is not
   * the submitted plan (changed, removed or not readable); G3 or G4 waits until a person with a
   * submit role submits the plan again.
   */
  | 'plan_resubmit_needed'
  /** C06 session 2: the intent's run is under way (the workflow that drives it waits for it). */
  | 'run_in_progress'
  /**
   * C06 session 2: the run failed or was lost and the intent is paused: it waits until the run's
   * escalation lets a new run start (a person decided; ADR-M33 §2.7).
   */
  | 'run_review'
  /**
   * C06 session 2b: the L1 (High risk) run stored its proposal as evidence (QUESTIONS #111); the
   * intent is paused at G4 while Person A takes the proposal forward (no new run starts).
   */
  | 'proposal_review'
  /**
   * C07 (ADR-M34 §2.8): G5 found a breach (instruction files, cost cap, iteration or time cap, a
   * stalled run); the intent is paused at G5 until a person decides on the escalation.
   */
  | 'g5_review'
  /**
   * C07: G5 is HITL for this intent (the matrix) and waits for a person's approval of the run's
   * changes (`/approve G5`).
   */
  | 'g5_decision'
  /**
   * C07 (QUESTIONS #131): the intent went back to G3 because a run changed files outside its
   * plan; G3 waits for a new plan (a plan hash G5 has not refused).
   */
  | 'new_plan_needed'
  /**
   * C08 (ADR-M38 §2.5): the push or the pull request could not be done (an empty diff, a branch
   * someone else changed, repeated failures); the intent is paused at G6 until a person decides on
   * the `technical` escalation (QUESTIONS #156). C08 PR 2: also a CI timeout, a pull request closed
   * or changed by someone else (`technical`), or a critical security finding (`security`).
   */
  | 'publish_review'
  /**
   * C08: the push failed for a reason that may pass (the Git host, the runner); the workflow tries
   * again after a delay, a few times.
   */
  | 'publish_retry'
  /** C08: the pull request is open; G6 waits for CI (the checks are not all finished). */
  | 'ci_pending'
  /**
   * O06 (ADR-M106): the pushed commit has no check at all, so the repository may have no CI. G6
   * waits `verification.ci_missing_minutes`, then pauses with a `technical` escalation.
   */
  | 'ci_missing'
  /**
   * C08 PR 2 (ADR-M38 §2.7): CI passed and G6 is HITL (the matrix, a security finding at the
   * threshold, or findings unknown): Person B approves (`/approve G6`).
   */
  | 'g6_decision'
  /**
   * E01 (ADR-M41): G7 waits for valid reviews of the pull request's head (Person B, and a second
   * approver for dual approval), given as GitHub reviews (QUESTIONS #175).
   */
  | 'g7_decision'
  /** E01: the approvals are complete; a person merges the pull request (never the platform). */
  | 'g7_merge'
  /**
   * E01: a reviewer requested changes. PR 1 holds G7 here; PR 2 starts a new run after G4
   * (QUESTIONS #179).
   */
  | 'g7_changes_requested'
  /**
   * E01: G7 stopped (the pull request was closed, changed by someone else, or merged before G7
   * passed); the intent is paused at G7 until a person decides on the escalation.
   */
  | 'g7_review'
  /**
   * E03 (ADR-M49): G8 waits for the release approval of Person B (and the second approver at
   * Critical risk), bound to the pack's release hash (`/approve G8`).
   */
  | 'g8_decision'
  /**
   * E03: G8 stopped (a stored evidence file failed its re-check); the intent is paused at G8 until
   * a person decides on the `security` escalation.
   */
  | 'g8_review'
  /** E03: the worker cannot build Evidence Packs (no evidence store, or it cannot be reached). */
  | 'evidence_unavailable'
  /** A status that the workflow does not move (`paused`, `blocked`, `running`). */
  | 'not_in_gate';

/**
 * Every `IntentWaitReason`, at runtime (U02): the catalog test checks that each has a label, and
 * the migration's CHECK accepts each.
 */
export const INTENT_WAIT_REASONS = [
  'decision',
  'input_missing',
  'ai_record',
  'frozen',
  'later_gate',
  'hotl_block_window',
  'g4_check',
  'run_pending',
  'git_host_unavailable',
  'spec_unavailable',
  'spec_unclear',
  'plan_resubmit_needed',
  'run_in_progress',
  'run_review',
  'proposal_review',
  'g5_review',
  'g5_decision',
  'new_plan_needed',
  'publish_review',
  'publish_retry',
  'ci_pending',
  'ci_missing',
  'g6_decision',
  'g7_decision',
  'g7_merge',
  'g7_changes_requested',
  'g7_review',
  'g8_decision',
  'g8_review',
  'evidence_unavailable',
  'not_in_gate',
] as const satisfies readonly IntentWaitReason[];

/** Compile-time check: the list holds every reason. */
type MissingWaitReason = Exclude<IntentWaitReason, (typeof INTENT_WAIT_REASONS)[number]>;
export const INTENT_WAIT_REASONS_COMPLETE: MissingWaitReason extends never ? true : never = true;
