// Gate G8: release approval, sealing the Evidence Pack, closing the intent (task E03, D-08 E03
// AC1–AC3, D-02 FR-10, FR-11, FR-12, FR-17, FR-40, FR-43, design/D-03 sections 6 and 6.1,
// design/ADR-M49, QUESTIONS #220–#222, handbook Ch.15 §15.5 Step 4 and §15.10.3).
//
// `stepG8` runs when the intent waits `in_gate G8` (G7 recorded the merge). Under the intent lock,
// in this order:
//   1. a person's rejection → `rejected` (D-03: G8 → Rejected); a request for changes keeps the
//      intent at G8 (the change is merged: a fix needs a new intent), and approvals recorded before
//      it no longer count;
//   2. the Evidence Pack: the step recomputes its hashes from the database (`currentPackHashes`, no
//      file is read). No AI record → no disclosure note → a system `fail ai_record_missing`, once
//      per input (AC2, FR-43). The latest version is not current (new evidence, a new decision or
//      escalation) → `build_pack`: the workflow's activity `buildReleasePack` builds it (every
//      stored file is read back and checked), then the step runs again;
//   3. the approvals bound to the G8 input (`g8-facts.ts`: the merge and the pack's release hash)
//      are re-checked (FR-17), and counted since the entry and the last request for changes. Every
//      G8 is production in the MVP (QUESTIONS #220): HITL, Person B, and the second approver at
//      Critical risk (rule M3). Producers never decide G8 (FR-11, `decideGate`);
//   4. approvals complete: the G8 overdue escalation is closed first (the pack then changes and is
//      built again); then every HOTL block window must be closed and `release` must not be frozen;
//      the latest version is sealed, `evidence.pack_sealed` and `intent.closed` (coded metrics,
//      AC3) are recorded, and the intent ends `done` (notice `released`);
//   5. otherwise: the gate deadline (FR-12) and the notice `g8_review_needed` (once per stay). For a
//      project with the client's own disclosure format, Person B's approval confirms that the
//      client's note is ready (QUESTIONS #222; the release hash binds the disclosure facts).
//
// `buildReleasePack` (the workflow's activity, before the lock): a stored evidence file that fails
// its re-check (hash, size, missing) stops G8: `paused` and a `security` escalation (QUESTIONS
// #221). `stepPausedG8` acts on its decision, re-checked just before acting (FR-17): `resume` →
// back to `in_gate G8` (the pack is built again), `terminate` → `cancelled`.
import type { IntentStatus, IntentStepResult, ProjectRole } from '@sdlc/contracts';

import { toCostAmounts, WASTED_RUN_STATUSES } from '../cost/report.js';
import type { IntentNoticeKind } from '../db/repositories/intent-notices.js';
import type { Escalation, Intent } from '../db/schema.js';
import type { TenantScope } from '../db/tenant-scope.js';
import { EscalationError } from '../escalation/errors.js';
import { assertActionAllowed } from '../escalation/freeze.js';
import { raiseEscalation } from '../escalation/raise.js';
import {
  buildEvidencePack,
  currentPackHashes,
  isCurrent,
  type EvidenceBuildDeps,
  type PackHashes,
} from '../evidence/build.js';
import { EvidencePackError } from '../evidence/errors.js';
import type { PlatformLogger } from '../observability/logger.js';
import type { Registry } from '../registry/registry.js';
import { close, stillValid, type G5Policy } from './g5.js';
import {
  g8InputSha256,
  g8Producers,
  gatherG8Facts,
  gatherG8Merge,
  type G8Merge,
} from './g8-facts.js';
import { gateHistory, type GateHistory } from './gate-history.js';
import { hotlBlockWindowOpenUntil } from './hotl.js';
import { checkGateOverdue, closeGateOverdue, gateClockStart } from './overdue.js';
import { resolveGateOversight } from './oversight.js';
import { breakGlassReviewPending } from '../break-glass/service.js';

/** Why G8 stopped (audit `gate.g8_check_failed`): a stored evidence file failed its re-check. */
export type G8Check = 'evidence_hash_mismatch' | 'evidence_missing';

const ALL_TIME = { from: new Date(0), to: new Date('9999-12-31T00:00:00.000Z') };

type Waiting = Extract<IntentStepResult, { outcome: 'waiting' }>;
const moved: IntentStepResult = { outcome: 'moved' };
const buildPack: IntentStepResult = { outcome: 'build_pack' };
const wait = (reason: Waiting['reason'], wakeInMs?: number): IntentStepResult =>
  wakeInMs === undefined
    ? { outcome: 'waiting', reason }
    : { outcome: 'waiting', reason, wakeInMs };

/** The step at `in_gate G8` (see the header). Under the intent lock. */
export async function stepG8(
  tx: TenantScope,
  registry: Registry,
  policy: G5Policy,
  intent: Intent,
  /** The worker can build packs (an evidence store); without it the intent waits. */
  canBuild: boolean,
): Promise<IntentStepResult> {
  const merge = await gatherG8Merge(tx, intent);
  if (!merge) return wait('not_in_gate');
  const history = await gateHistory(tx, intent.id, 'G8');
  if (history.rejection !== null) {
    return move(tx, registry, intent, { status: 'rejected' }, 'rejected', history.rejection, []);
  }
  await announceChangesRequest(tx, registry, intent, history);

  let hashes: PackHashes;
  try {
    hashes = await currentPackHashes(tx, intent);
  } catch (error) {
    if (error instanceof EvidencePackError && error.code === 'ai_record_missing') {
      return refuse(tx, registry, policy, intent, merge, history);
    }
    throw error;
  }
  const oversight = oversightAt(policy, intent, await flagsOf(tx, intent));
  const overdueFor = async (sha256: string) =>
    checkGateOverdue(tx, registry, {
      intent,
      gate: 'G8',
      config: policy.config,
      oversight,
      clockStart: gateClockStart(intent, history.latestChangesRequestAt),
      subject: { kind: 'g8_input', sha256 },
      producers: await g8Producers(tx, intent),
    });
  const latest = await tx.evidencePacks.latest(intent.id);
  const facts = isCurrent(latest, hashes) ? await gatherG8Facts(tx, intent) : null;
  if (!facts) {
    // The deadline runs while the pack cannot be built (no store, a store that fails).
    const overdue = await overdueFor(g8InputSha256(merge, null));
    return canBuild ? buildPack : wait('evidence_unavailable', overdue);
  }

  // FR-17: an approval that expired or no longer matches the input is voided before it counts.
  const { valid, voided } = await registry.revalidateApprovals(tx, {
    intentId: intent.id,
    gate: 'G8',
    inputSha256: facts.inputSha256,
  });
  // A `void` is a new G8 decision: the pack lists it, so it is built again first.
  if (voided.length > 0) return moved;
  const approvals = valid.filter((a) => history.countedApprovals.has(a.id));
  if (approvals.length >= Math.max(1, oversight.approvalsNeeded)) {
    // The pack must list the overdue escalation closed: close it, and let the pack be rebuilt.
    if ((await closeGateOverdue(tx, registry, intent.id, 'G8')) > 0) return moved;
    const now = registry.now();
    const until = await hotlBlockWindowOpenUntil(tx, registry, intent.id, now);
    if (until !== null)
      return wait('hotl_block_window', Math.max(0, until.getTime() - now.getTime()));
    if (!(await releaseAllowed(tx, intent, registry))) return wait('frozen');
    // H08 (ADR-M111 §2.8): no release while a break-glass grant is active or ended without its
    // post-incident review; recording the review wakes the intent.
    if (await breakGlassReviewPending(tx, intent.id)) return wait('break_glass_review');
    return release(tx, registry, intent, facts, approvals.at(-1)!.id);
  }

  const overdue = await overdueFor(facts.inputSha256);
  if (!(await noticedSinceEntry(tx, intent.id, 'g8_review_needed'))) {
    await notice(tx, intent, 'g8_review_needed', approvers(oversight.roles), null);
  }
  return wait('g8_decision', overdue);
}

/** QUESTIONS #220: every G8 is a production release in the MVP. */
function oversightAt(
  policy: G5Policy,
  intent: Intent,
  changeFlags: Awaited<ReturnType<typeof flagsOf>>,
) {
  return resolveGateOversight(policy.policy, intent, 'G8', { changeFlags });
}

async function flagsOf(tx: TenantScope, intent: Intent) {
  return (await tx.plans.latest(intent.id))?.change_flags ?? [];
}

function approvers(roles: readonly ProjectRole[]): ProjectRole[] {
  return roles.filter((role) => role !== 'viewer');
}

/** A request for changes at G8: notice once; the gate clock starts again (`gateClockStart`). */
async function announceChangesRequest(
  tx: TenantScope,
  registry: Registry,
  intent: Intent,
  history: GateHistory,
): Promise<void> {
  const request = history.latestChangesRequest;
  if (request === null || (await tx.intentNotices.existsForDecision(request))) return;
  await closeGateOverdue(tx, registry, intent.id, 'G8');
  await notice(tx, intent, 'g8_changes_requested', ['person_a', 'person_b'], request);
}

/**
 * AC2, FR-43: no project AI record, so no disclosure note: a system `fail ai_record_missing` once
 * for this merge, the notice `g8_refused`, and the intent waits. The gate deadline still runs.
 */
async function refuse(
  tx: TenantScope,
  registry: Registry,
  policy: G5Policy,
  intent: Intent,
  merge: G8Merge,
  history: GateHistory,
): Promise<IntentStepResult> {
  const inputSha256 = g8InputSha256(merge, null);
  const recorded = (await tx.gateDecisions.listForIntent(intent.id, 'G8')).some(
    (d) =>
      d.decision === 'fail' &&
      d.reason_code === 'ai_record_missing' &&
      d.input_sha256 === inputSha256,
  );
  if (!recorded) {
    const fail = await registry.decide(tx, {
      intentId: intent.id,
      gate: 'G8',
      decision: 'fail',
      actor: { type: 'system' },
      reasonCode: 'ai_record_missing',
      inputSha256,
      source: 'workflow',
      context: { environment: 'production' },
    });
    await notice(tx, intent, 'g8_refused', ['pm_brse', 'person_a'], fail.id);
  }
  const oversight = oversightAt(policy, intent, await flagsOf(tx, intent));
  const overdue = await checkGateOverdue(tx, registry, {
    intent,
    gate: 'G8',
    config: policy.config,
    oversight,
    clockStart: gateClockStart(intent, history.latestChangesRequestAt),
    subject: { kind: 'g8_input', sha256: inputSha256 },
    producers: await g8Producers(tx, intent),
  });
  return wait('ai_record', overdue);
}

/** G8 passed (AC3): seal the pack, record the metrics, close the intent. */
async function release(
  tx: TenantScope,
  registry: Registry,
  intent: Intent,
  facts: NonNullable<Awaited<ReturnType<typeof gatherG8Facts>>>,
  decisionId: string,
): Promise<IntentStepResult> {
  const now = registry.now();
  const sealed = await tx.evidencePacks.seal(facts.pack.id, now);
  // Under the intent lock nothing else seals; a refusal means the data is not what we read.
  if (!sealed) throw new Error(`G8: pack ${facts.pack.id} could not be sealed`);
  await tx.audit.append({
    action: 'evidence.pack_sealed',
    actorType: 'system',
    actorId: null,
    entityId: sealed.id,
    occurredAt: now,
    payload: {
      intent_id: intent.id,
      version: sealed.version,
      content_sha256: sealed.content_sha256,
      release_sha256: facts.pack.release_sha256,
    },
  });
  const runs = await tx.runs.listForIntent(intent.id);
  const changeRequests = (await tx.gateDecisions.listForIntent(intent.id, 'G7')).filter(
    (d) => d.decision === 'request_changes',
  ).length;
  const cost = toCostAmounts(
    await tx.costRecords.reportTotals({
      ...ALL_TIME,
      intentId: intent.id,
      wastedStatuses: WASTED_RUN_STATUSES,
    }),
  );
  await tx.audit.append({
    action: 'intent.closed',
    actorType: 'system',
    actorId: null,
    entityId: intent.id,
    occurredAt: now,
    payload: {
      pack_id: sealed.id,
      pack_version: sealed.version,
      release_sha256: facts.pack.release_sha256,
      lead_time_seconds: Math.max(
        0,
        Math.floor((now.getTime() - new Date(intent.created_at).getTime()) / 1000),
      ),
      runs: runs.length,
      g7_change_requests: changeRequests,
      cost_usd: cost.costUsd,
      input_tokens: cost.inputTokens,
      output_tokens: cost.outputTokens,
    },
  });
  return move(tx, registry, intent, { status: 'done' }, 'released', decisionId, []);
}

/** The freeze check before the release (`release` is a protected action, ADR-M28 §2.4). */
async function releaseAllowed(
  tx: TenantScope,
  intent: Intent,
  registry: Registry,
): Promise<boolean> {
  try {
    await assertActionAllowed(tx, intent.id, 'release', registry.now());
    return true;
  } catch (error) {
    if (error instanceof EscalationError && error.code === 'frozen') return false;
    throw error;
  }
}

export interface ReleasePackDeps extends EvidenceBuildDeps {
  readonly registry: Registry;
  /** Why a build was unavailable (codes and IDs only); the workflow tries again a minute later. */
  readonly log?: PlatformLogger;
}

/** What the activity `buildReleasePack` did; the workflow then steps again (or waits a minute). */
export type ReleasePackOutcome = 'built' | 'stopped' | 'unavailable' | 'skipped';

/**
 * Builds the intent's release pack (the workflow's activity, before the intent lock; ADR-M49
 * §2.1). Idempotent: a build whose content did not change returns the existing version. A stored
 * file that fails its re-check stops G8 (see the header).
 */
export async function buildReleasePack(
  scope: TenantScope,
  deps: ReleasePackDeps,
  intentId: string,
): Promise<ReleasePackOutcome> {
  const intent = await scope.intents.getById(intentId);
  if (intent?.status !== 'in_gate' || intent.current_gate !== 'G8') return 'skipped';
  try {
    await buildEvidencePack(scope, { type: 'system' }, intent.id, deps);
    return 'built';
  } catch (error) {
    if (!(error instanceof EvidencePackError)) throw error;
    switch (error.code) {
      case 'evidence_hash_mismatch':
      case 'evidence_missing':
        return (await stopForEvidence(scope, deps.registry, intentId, error.code))
          ? 'stopped'
          : 'skipped';
      // The step refuses (no AI record) or seals (sealed) itself.
      case 'ai_record_missing':
      case 'pack_sealed':
        return 'skipped';
      // A store that fails, a file above the size cap, concurrent builds: try again later.
      default:
        deps.log?.log('warn', 'worker.release_pack_unavailable', {
          tenant_id: scope.tenantId,
          intent_id: intentId,
          code: error.code,
        });
        return 'unavailable';
    }
  }
}

/** Pauses G8 with a `security` escalation bound to the G8 input (QUESTIONS #221). */
async function stopForEvidence(
  scope: TenantScope,
  registry: Registry,
  intentId: string,
  check: G8Check,
): Promise<boolean> {
  return scope.transaction(async (tx) => {
    const intent = await tx.intents.lockAndGet(intentId);
    if (intent?.status !== 'in_gate' || intent.current_gate !== 'G8') return false;
    const merge = await gatherG8Merge(tx, intent);
    if (!merge) return false;
    const policy = await registry.policyFor(tx, intent.project_id);
    const level = policy.config.run.failed_run_escalation;
    const { releaseSha256 } = await currentPackHashes(tx, intent);
    const escalation = await raiseEscalation(
      tx,
      {
        intentId: intent.id,
        runId: merge.run.id,
        trigger: 'unusual_behaviour',
        route: 'security',
        severity: level.severity,
        responseLevel: level.response_level,
        packet: {
          subject_kind: 'g8_input',
          subject_sha256: g8InputSha256(merge, releaseSha256),
          gate: 'G8',
          run_id: merge.run.id,
          reason_code: 'input_mismatch',
        },
        producers: await g8Producers(tx, intent),
        raisedBy: { type: 'system' },
      },
      { now: () => registry.now() },
    );
    await tx.audit.append({
      action: 'gate.g8_check_failed',
      actorType: 'system',
      actorId: null,
      entityId: intent.id,
      occurredAt: registry.now(),
      payload: { check, escalation_id: escalation.id },
    });
    await move(tx, registry, intent, { status: 'paused' }, 'g8_escalated', null, [
      'person_b',
      'governance',
    ]);
    return true;
  });
}

/** The step at `paused G8`: acts on the escalation's decision (see the header). Under the lock. */
export async function stepPausedG8(
  tx: TenantScope,
  registry: Registry,
  intent: Intent,
): Promise<IntentStepResult> {
  const escalation = (await tx.escalations.listForIntent(intent.id))
    .filter((e) => e.packet.gate === 'G8' && e.trigger !== 'time')
    .at(-1);
  if (!escalation) return wait('g8_review');
  const subject = String(escalation.packet.subject_sha256);
  // Closed without a decision acted on: back to G8, which builds the pack again (and stops again
  // when a file still fails its check).
  if (escalation.status === 'closed') return resume(tx, registry, intent);
  if (escalation.decision === null) return wait('g8_review');
  return actOn(tx, registry, intent, escalation, subject);
}

async function actOn(
  tx: TenantScope,
  registry: Registry,
  intent: Intent,
  escalation: Escalation,
  subjectSha256: string,
): Promise<IntentStepResult> {
  const decision = String(escalation.decision?.decision);
  if (decision !== 'resume' && decision !== 'terminate') return wait('g8_review');
  if (!(await stillValid(tx, registry, escalation, subjectSha256, 'gate_advance', true))) {
    return wait('g8_review');
  }
  await close(tx, registry, escalation);
  if (decision === 'resume') return resume(tx, registry, intent);
  return move(tx, registry, intent, { status: 'cancelled' }, 'terminated', null, []);
}

function resume(tx: TenantScope, registry: Registry, intent: Intent): Promise<IntentStepResult> {
  return move(tx, registry, intent, { status: 'in_gate' }, 'g8_resumed', null, ['person_b']);
}

/**
 * Whether people were already told `kind` during this stay at G8: a notice of `kind` after the
 * last notice that moved the intent into G8 (from G7, or back from `paused G8`).
 */
async function noticedSinceEntry(
  tx: TenantScope,
  intentId: string,
  kind: IntentNoticeKind,
): Promise<boolean> {
  const notices = await tx.intentNotices.listForIntent(intentId);
  let entry = -1;
  notices.forEach((n, i) => {
    if (n.gate === 'G8' && (n.previous_gate !== 'G8' || n.kind === 'g8_resumed')) entry = i;
  });
  return notices.slice(entry + 1).some((n) => n.kind === kind && n.gate === 'G8');
}

async function notice(
  tx: TenantScope,
  intent: Intent,
  kind: IntentNoticeKind,
  audience: readonly ProjectRole[],
  decisionId: string | null,
): Promise<void> {
  await tx.intentNotices.record({
    intentId: intent.id,
    kind,
    status: intent.status,
    gate: intent.current_gate,
    previousGate: intent.current_gate,
    decisionId,
    audienceRoles: [...new Set(approvers(audience))],
  });
}

async function move(
  tx: TenantScope,
  registry: Registry,
  intent: Intent,
  to: { readonly status: IntentStatus },
  kind: IntentNoticeKind,
  decisionId: string | null,
  audience: readonly ProjectRole[],
): Promise<IntentStepResult> {
  if (intent.status === 'in_gate' && intent.current_gate === 'G8') {
    await closeGateOverdue(tx, registry, intent.id, 'G8');
  }
  const updated = await tx.intents.moveState(intent.id, {
    from: { status: intent.status, currentGate: intent.current_gate },
    to: { status: to.status, currentGate: 'G8' },
    at: registry.now(),
  });
  // Under the intent lock the compare-and-set cannot miss; if it does, roll back this step.
  if (!updated) throw new Error(`G8: intent ${intent.id} moved under its lock`);
  await tx.intentNotices.record({
    intentId: intent.id,
    kind,
    status: updated.status,
    gate: updated.current_gate,
    previousGate: intent.current_gate,
    decisionId,
    audienceRoles: [...new Set(approvers(audience))],
  });
  return moved;
}
