// Activities of the intent workflow (task B07, design/ADR-M30; C06 session 2, ADR-M33 §2.6). They
// run in the worker process with the database and the registry; the workflow only sees their
// coded results. The run activities return IDs, codes and two single-use OpenBao wrapping tokens:
// never a raw token, a virtual key, its ID or client data (ADR-M30 §2.1, QUESTIONS #112).
import type {
  CheckEvaluationTaskResult,
  EvidenceStore,
  IntentStepResult,
  IntentWorkflowRef,
  ToolSecretsHandoff,
} from '@sdlc/contracts';
import {
  breakGlassRunPriority,
  abandonPublish,
  abandonRun,
  buildReleasePack,
  finishPublish,
  finishEvaluationRun,
  finishRun,
  finishTaskCheck,
  parseTenantId,
  preparePublish,
  revokeKilledRunKey,
  startRun,
  stepIntent,
  type EvaluationRunEnd,
  type FinishEvaluationDeps,
  type G4Deps,
  type G6Deps,
  type G7Deps,
  type SpecGitHost,
  type PlatformDatabase,
  type PlatformLogger,
  type PublishDeps,
  type Registry,
  type ReleasePackOutcome,
  type RunDeps,
} from '@sdlc/core';

export type PrepareRunActivityResult =
  | {
      readonly ok: true;
      readonly runId: string;
      readonly modelRef: string;
      readonly wrappedGitToken: string;
      readonly wrappedVirtualKey: string;
      /** E01 PR 2: the single-use wrapping token of the feedback token (never the token). */
      readonly wrappedFeedbackToken?: string;
      /** X04 PR 3b: by tool key, a wrapping token and an index ID (never the secrets). */
      readonly toolSecrets?: Readonly<Record<string, ToolSecretsHandoff>>;
      /** H08 (ADR-M111 §2.2): `break_glass` when the run goes first in the runner queue. */
      readonly priority?: 'break_glass';
    }
  | { readonly ok: false; readonly reason: string };

/** C08: the wrapped push token, or the step's conditions no longer hold. */
export type PreparePublishActivityResult =
  | { readonly ok: true; readonly wrappedPushToken: string }
  | { readonly ok: false; readonly reason: string };

/** C08: the pull request is linked, or why not (codes only). */
export type FinishPublishActivityResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: string };

export interface IntentActivities {
  /** One step of the intent (core `stepIntent`): at most one move, in one transaction. */
  stepIntent(ref: IntentWorkflowRef): Promise<IntentStepResult>;
  /** C06: the round's next run (core `startRun`). */
  prepareRun(ref: IntentWorkflowRef): Promise<PrepareRunActivityResult>;
  /** C06: the run ended; revoke its key, sync spend, move the intent (core `finishRun`). */
  finishRun(ref: IntentWorkflowRef, runId: string): Promise<void>;
  /** C06: the runner's activity was lost; revoke the key at once, fail the run (core `abandonRun`). */
  abandonRun(ref: IntentWorkflowRef, runId: string): Promise<void>;
  /** C11: the workflow got the kill signal; revoke the killed run's key at once. */
  revokeKilledRunKey(ref: IntentWorkflowRef, runId: string): Promise<void>;
  /** C08: a push token for the run's push, wrapped (core `preparePublish`). */
  preparePublish(ref: IntentWorkflowRef, runId: string): Promise<PreparePublishActivityResult>;
  /** C08: find or open the pull request and link it (core `finishPublish`). */
  finishPublish(ref: IntentWorkflowRef, runId: string): Promise<FinishPublishActivityResult>;
  /** C08: the runner's push activity or a worker activity failed; count a failed attempt. */
  abandonPublish(
    ref: IntentWorkflowRef,
    runId: string,
    reason: 'runner_lost' | 'worker_failed',
  ): Promise<void>;
  /**
   * E03 (ADR-M49 §2.1): build the release pack of an intent at G8 (core `buildReleasePack`): every
   * stored evidence file is read back and checked. Returns a code only.
   */
  buildReleasePack(ref: IntentWorkflowRef): Promise<ReleasePackOutcome>;
  /**
   * L04 (ADR-M81 §2.8): an evaluation run ended on the runner (or was lost). Revoke its key, write
   * the result with the cost, check the budget, end the evaluation when no run is left (core
   * `finishEvaluationRun`). Idempotent.
   */
  finishEvaluationRun(input: FinishEvaluationRunInput): Promise<void>;
  /**
   * L07 (ADR-M85 §2.5): the check of a project's evaluation task ended on the runner (or was
   * lost). Writes `checked` or `check_failed`, or hands the check back (core `finishTaskCheck`).
   * Idempotent.
   */
  finishEvaluationTaskCheck(input: FinishEvaluationTaskCheckInput): Promise<void>;
}

/** What the check workflow tells the finishing activity: IDs, a hash and the coded answer. */
export interface FinishEvaluationTaskCheckInput {
  readonly tenantId: string;
  readonly evaluationTaskId: string;
  readonly cardSha256: string;
  readonly attempt: number;
  readonly end: CheckEvaluationTaskResult | { readonly outcome: 'lost' };
}

/** What the workflow tells the finishing activity: IDs, a time and the runner's coded result. */
export interface FinishEvaluationRunInput {
  readonly tenantId: string;
  readonly evaluationRunId: string;
  readonly attempt: number;
  /** ISO time the run's key was issued. */
  readonly keyIssuedAt: string;
  readonly end: EvaluationRunEnd;
}

/** E03: the worker's evidence store (its identity `worker-evidence`, ADR-M49 §2.2). */
export interface ReleaseDeps {
  readonly store: EvidenceStore;
  /** Largest evidence file read back (`SDLC_WORKER_EVIDENCE_MAX_ITEM_MB`). */
  readonly maxItemBytes: number;
}

export interface IntentActivityDeps {
  readonly db: Pick<PlatformDatabase, 'forTenant'>;
  readonly registry: Registry;
  /** G4 facts from outside the database (C06). Without it G4 is not evaluated. */
  readonly g4?: G4Deps;
  /**
   * The Git host for the spec re-check at G2–G4 (B08, ADR-M39 §2.4). `main.ts` always wires it;
   * without it the step does not re-check the spec.
   */
  readonly specs?: SpecGitHost;
  /** Everything a run needs (C06 session 2). Without it a decided G4 waits (`run_pending`). */
  readonly runs?: RunDeps;
  /** The push and the pull request at G6 (C08). Wired with `runs`. */
  readonly publish?: PublishDeps;
  /** What G6 reads from CI (C08 PR 2). Without it a linked pull request waits (`ci_pending`). */
  readonly g6?: G6Deps;
  /** What G7 reads from the Git host (E01). Without it the intent waits at G7. */
  readonly g7?: G7Deps;
  /** E03: the evidence store for G8's release pack. Without it the intent waits at G8. */
  readonly releases?: ReleaseDeps;
  /** E03: why a release pack could not be built (codes only). */
  readonly logger?: PlatformLogger;
  /** L04: the Cost Controller for the end of an evaluation run. Without it the activity throws. */
  readonly evaluations?: FinishEvaluationDeps;
}

/** Thrown by a run activity when the worker was started without run support. */
export class RunsNotConfiguredError extends Error {
  override readonly name = 'RunsNotConfiguredError';
}

export function createIntentActivities(deps: IntentActivityDeps): IntentActivities {
  const scope = (ref: IntentWorkflowRef) => deps.db.forTenant(parseTenantId(ref.tenantId));
  const runs = (): RunDeps => {
    if (!deps.runs) throw new RunsNotConfiguredError('runs are not configured in this worker');
    return deps.runs;
  };
  const publish = (): PublishDeps => {
    if (!deps.publish) throw new RunsNotConfiguredError('runs are not configured in this worker');
    return deps.publish;
  };
  return {
    stepIntent: (ref) =>
      stepIntent(
        scope(ref),
        {
          registry: deps.registry,
          ...(deps.g4 ? { g4: deps.g4 } : {}),
          ...(deps.specs ? { specs: deps.specs } : {}),
          ...(deps.g4 && deps.runs ? { startRuns: true } : {}),
          ...(deps.publish ? { publish: true } : {}),
          ...(deps.g6 ? { g6: deps.g6 } : {}),
          ...(deps.g7 ? { g7: deps.g7 } : {}),
          ...(deps.releases ? { releases: true } : {}),
        },
        ref.intentId,
      ),
    async prepareRun(ref) {
      const result = await startRun(scope(ref), runs(), ref.intentId);
      if (!result.ok) return { ok: false, reason: result.reason };
      const first = await breakGlassRunPriority(scope(ref), result.run.runId, new Date());
      return {
        ...(first ? { priority: 'break_glass' as const } : {}),
        ok: true,
        runId: result.run.runId,
        modelRef: result.run.modelRef,
        wrappedGitToken: result.run.wrappedGitToken.reveal(),
        wrappedVirtualKey: result.run.wrappedVirtualKey.reveal(),
        ...(result.run.wrappedFeedbackToken
          ? { wrappedFeedbackToken: result.run.wrappedFeedbackToken.reveal() }
          : {}),
        ...(result.run.toolSecrets.size > 0
          ? {
              toolSecrets: Object.fromEntries(
                [...result.run.toolSecrets].map(([toolKey, secrets]) => [
                  toolKey,
                  { wrapped: secrets.wrapped.reveal(), indexId: secrets.indexId },
                ]),
              ),
            }
          : {}),
      };
    },
    finishRun: (ref, runId) => finishRun(scope(ref), runs(), ref.intentId, runId),
    abandonRun: (ref, runId) => abandonRun(scope(ref), runs(), runId),
    async revokeKilledRunKey(ref, runId) {
      await revokeKilledRunKey(scope(ref), runs(), runId);
    },
    async preparePublish(ref, runId) {
      const result = await preparePublish(scope(ref), publish(), ref.intentId, runId);
      return result.ok
        ? { ok: true, wrappedPushToken: result.wrappedPushToken.reveal() }
        : { ok: false, reason: result.reason };
    },
    async finishPublish(ref, runId) {
      const result = await finishPublish(scope(ref), publish(), ref.intentId, runId);
      return result.ok ? { ok: true } : { ok: false, reason: result.reason };
    },
    abandonPublish: (ref, runId, reason) => abandonPublish(scope(ref), ref.intentId, runId, reason),
    async finishEvaluationRun(input) {
      if (!deps.evaluations) {
        throw new RunsNotConfiguredError('evaluations are not configured in this worker');
      }
      await finishEvaluationRun(
        deps.db.forTenant(parseTenantId(input.tenantId)),
        deps.evaluations,
        {
          evaluationRunId: input.evaluationRunId,
          attempt: input.attempt,
          keyIssuedAt: new Date(input.keyIssuedAt),
          end: input.end,
        },
      );
    },
    async finishEvaluationTaskCheck(input) {
      await finishTaskCheck(deps.db.forTenant(parseTenantId(input.tenantId)), {
        evaluationTaskId: input.evaluationTaskId,
        cardSha256: input.cardSha256,
        attempt: input.attempt,
        end: input.end,
      });
    },
    async buildReleasePack(ref) {
      if (!deps.releases) return 'unavailable';
      return buildReleasePack(
        scope(ref),
        {
          registry: deps.registry,
          store: deps.releases.store,
          maxItemBytes: deps.releases.maxItemBytes,
          now: () => deps.registry.now(),
          ...(deps.logger ? { log: deps.logger } : {}),
        },
        ref.intentId,
      );
    },
  };
}
