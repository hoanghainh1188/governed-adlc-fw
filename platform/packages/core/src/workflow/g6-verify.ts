// Gate G6, part 2: independent verification from CI (task C08 PR 2, D-08 C08 AC2, D-02 FR-13,
// D-09 N2, design/D-03 sections 6 and 6.1, ADR-M38 §2.7, QUESTIONS #157–#159, handbook Ch.14
// §14.5 Step 3 and §14.10.2).
//
// Runs when the pull request of the intent's last run is linked. The reading of CI (`readCi`,
// before the lock) is recorded as `ci_checked`; the step decides from the database, in order:
//   1. a person's rejection at G6 ends the intent; a request for changes (HITL, or within the
//      block window of a G6 the platform passed) takes it back to G4 for a new run;
//   2. the pull request is closed or merged, or shows another commit than the platform pushed
//      → `paused` at G6 and a `technical` escalation (QUESTIONS #156);
//   3. CI failed → a system `fail ci_failed`: retries left (`run.g6_ci_retries`, counted since the
//      last G3 approval) → back to G4, a new run from the pushed commit (notice `ci_retry`); none
//      left → back to G3, HITL from then on (N2, FR-13, notice `ci_returned`);
//   4. CI pending → wait (`ci_pending`) until `verification.ci_timeout_minutes` after the clock
//      start (entry into G6, the end of G5's block window, or the close of the last G6
//      escalation), then `paused` and a `technical` escalation; no retry used (QUESTIONS #159);
//   4b. no check at all on the commit (O06, ADR-M106: the repository may have no CI) → wait
//      (`ci_missing`) until the shorter of `verification.ci_missing_minutes` and the CI timeout,
//      then `paused` and a `technical` escalation (`ci_missing`); no retry used;
//   5. CI passed: a critical security finding → `paused` and a `security` escalation, once per
//      input (a `resume` brings the intent back for Person B's approval); otherwise oversight from
//      the matrix with the findings (`securityFindings`, `securityFindingsUnknown`: fail closed,
//      QUESTIONS #157): AUDIT and HOTL → a system `pass` and G7 (the block window applies, E01
//      waits for it); HITL → Person B approves (`/approve G6`), never the run's producer (FR-11);
//      the gate deadline applies (FR-12).
// Escalation level: `run.failed_run_escalation` (`pause` or higher, rule M20). Every decision and
// escalation is bound to the G6 input hash (FR-17).
import type {
  EscalationRoute,
  EscalationTrigger,
  GateReasonCode,
  IntentStepResult,
  IntentStatus,
  OversightResolution,
  ProjectRole,
} from '@sdlc/contracts';

import type { IntentNoticeKind } from '../db/repositories/intent-notices.js';
import type { Intent, Run } from '../db/schema.js';
import type { TenantScope } from '../db/tenant-scope.js';
import { EscalationError } from '../escalation/errors.js';
import { assertActionAllowed } from '../escalation/freeze.js';
import { raiseEscalation } from '../escalation/raise.js';
import type { Registry } from '../registry/registry.js';
import { G4_OPERATOR_ROLES } from './g4.js';
import { g3Approvers, type G5Policy } from './g5.js';
import { gatherG6Facts, recordCiReading, type CiReading, type G6Facts } from './g6-ci.js';
import { gateHistory } from './gate-history.js';
import { blockWindowEnd, sentBackForInput } from './hotl.js';
import { checkGateOverdue, closeGateOverdue, gateClockStart } from './overdue.js';
import { waitedSeconds } from './waited.js';
import { g6Context, resolveGateOversight } from './oversight.js';

/** Why G6 stopped at CI (audit `gate.g6_check_failed`, escalation packet). */
export type G6Check =
  | 'ci_failed'
  | 'ci_no_retries'
  | 'ci_timeout'
  | 'ci_missing'
  | 'pr_closed'
  | 'pr_merged'
  | 'branch_moved'
  | 'critical_finding';

/** The escalation of a G6 stop: route, trigger, packet reason code. */
const STOPS: Readonly<
  Record<
    Exclude<G6Check, 'ci_failed' | 'ci_no_retries'>,
    { route: EscalationRoute; trigger: EscalationTrigger; reason: GateReasonCode }
  >
> = {
  // Not `time`: that trigger is the gate deadline's (closed when the gate is decided).
  ci_timeout: { route: 'technical', trigger: 'unusual_behaviour', reason: 'ci_failed' },
  // O06 (ADR-M106): `resume` stays at G6 and reads CI again, as after a timeout.
  ci_missing: { route: 'technical', trigger: 'unusual_behaviour', reason: 'ci_failed' },
  pr_closed: { route: 'technical', trigger: 'unusual_behaviour', reason: 'input_mismatch' },
  pr_merged: { route: 'technical', trigger: 'unusual_behaviour', reason: 'input_mismatch' },
  branch_moved: { route: 'technical', trigger: 'unusual_behaviour', reason: 'input_mismatch' },
  critical_finding: { route: 'security', trigger: 'risky_action', reason: 'security_finding' },
};

const MINUTE = 60_000;

/** Delay before the step reads the Git host again after an outage (as at G4). */
const GIT_HOST_RETRY_MS = 60_000;

type Waiting = Extract<IntentStepResult, { outcome: 'waiting' }>;
const moved: IntentStepResult = { outcome: 'moved' };
const wait = (reason: Waiting['reason'], wakeInMs?: number): IntentStepResult =>
  wakeInMs === undefined
    ? { outcome: 'waiting', reason }
    : { outcome: 'waiting', reason, wakeInMs };

/** The step at G6 once the pull request is linked (see the header). Under the intent lock. */
export async function stepCi(
  tx: TenantScope,
  registry: Registry,
  policy: G5Policy,
  intent: Intent,
  /** `unavailable`: the Git host could not be read (people's decisions are still handled). */
  reading: CiReading | 'unavailable' | null,
): Promise<IntentStepResult> {
  const changed =
    reading !== null && reading !== 'unavailable' ? await recordCiReading(tx, reading) : false;
  const facts = await gatherG6Facts(tx, intent.id);
  if (!facts?.ci) return wait('ci_pending');
  const { ci, run } = facts;

  const history = await gateHistory(tx, intent.id, 'G6');
  if (history.rejection !== null) {
    return move(tx, registry, intent, { status: 'rejected', gate: 'G6' }, 'rejected', {
      decisionId: history.rejection,
      audience: [],
    });
  }
  if (history.latestChangesRequest !== null) {
    return move(tx, registry, intent, { status: 'in_gate', gate: 'G4' }, 'returned', {
      decisionId: history.latestChangesRequest,
      audience: G4_OPERATOR_ROLES,
    });
  }

  // Without a fresh reading the step never decides on CI (no timeout, no pass): it waits.
  if (reading === 'unavailable') {
    return wait('git_host_unavailable', GIT_HOST_RETRY_MS);
  }
  if (ci.prState !== 'open') {
    return stop(
      tx,
      registry,
      policy,
      intent,
      facts,
      ci.prState === 'merged' ? 'pr_merged' : 'pr_closed',
    );
  }
  if (ci.headSha !== facts.pushedHead)
    return stop(tx, registry, policy, intent, facts, 'branch_moved');
  if (ci.state === 'failed') return failCi(tx, registry, policy, intent, facts);
  if (ci.state === 'pending' || ci.state === 'missing') {
    const { ci_timeout_minutes, ci_missing_minutes } = policy.config.verification;
    const missing = ci.state === 'missing';
    const minutes = missing ? Math.min(ci_missing_minutes, ci_timeout_minutes) : ci_timeout_minutes;
    const deadline =
      (await ciClockStart(tx, registry, policy, intent, run)).getTime() + minutes * MINUTE;
    const now = registry.now().getTime();
    if (now >= deadline) {
      return stop(tx, registry, policy, intent, facts, missing ? 'ci_missing' : 'ci_timeout');
    }
    return wait(missing ? 'ci_missing' : 'ci_pending', deadline - now);
  }

  // CI passed.
  const hasCritical =
    ci.counts.critical > 0 ||
    (facts.dependencies !== null && facts.dependencies.advisoryFindings > 0);
  if (hasCritical && !(await resumedFor(tx, intent.id, facts.inputSha256))) {
    return stop(tx, registry, policy, intent, facts, 'critical_finding');
  }
  const oversight = oversightAt(policy, intent, facts);
  if (oversight.mode === 'HITL') {
    const { valid } = await registry.revalidateApprovals(tx, {
      intentId: intent.id,
      gate: 'G6',
      inputSha256: facts.inputSha256,
    });
    const approvals = valid.filter((a) => history.countedApprovals.has(a.id));
    if (approvals.length < Math.max(1, oversight.approvalsNeeded)) {
      // Person B is told once per new reading that needs a decision.
      if (changed) await notice(tx, intent, 'g6_decision', oversight.roles);
      const wakeInMs = await checkGateOverdue(tx, registry, {
        intent,
        gate: 'G6',
        config: policy.config,
        oversight,
        // Person B's time starts when CI passed, not at the entry into G6 (code review).
        clockStart: laterOf(
          gateClockStart(intent, history.latestChangesRequestAt),
          facts.ciReadAt,
          registry.now(),
        ),
        subject: { kind: 'g6_input', sha256: facts.inputSha256 },
        producers: run.triggered_by === null ? [] : [run.triggered_by],
      });
      return wakeInMs === undefined
        ? wait('g6_decision')
        : { outcome: 'waiting', reason: 'g6_decision', wakeInMs };
    }
    await closeGateOverdue(tx, registry, intent.id, 'G6');
    if (!(await advanceAllowed(tx, intent, registry))) return wait('frozen');
    return move(tx, registry, intent, { status: 'in_gate', gate: 'G7' }, 'advanced', {
      decisionId: approvals.at(-1)!.id,
      audience: [],
    });
  }
  // AUDIT and HOTL: the platform passes; never again on an input a person sent back.
  if (await sentBackForInput(tx, intent.id, 'G6', facts.inputSha256)) return wait('g6_decision');
  if (!(await advanceAllowed(tx, intent, registry))) return wait('frozen');
  const pass = await registry.decide(tx, {
    intentId: intent.id,
    gate: 'G6',
    decision: 'pass',
    actor: { type: 'system' },
    inputSha256: facts.inputSha256,
    waitedSeconds: waitedSeconds(intent, registry.now()),
    source: 'workflow',
    context: contextOf(facts),
  });
  return move(tx, registry, intent, { status: 'in_gate', gate: 'G7' }, 'hotl_passed', {
    decisionId: pass.id,
    audience: oversight.roles.filter((role) => role !== 'viewer'),
  });
}

/** The later of two times, never after `now` (`b` may come from the database clock). */
function laterOf(a: Date, b: Date | null, now: Date): Date {
  if (b === null) return a;
  return new Date(Math.max(a.getTime(), Math.min(b.getTime(), now.getTime())));
}

/** The policy context of G6: the findings counts, and whether they are known (QUESTIONS #157). */
export function contextOf(facts: G6Facts) {
  return g6Context(facts);
}

function oversightAt(policy: G5Policy, intent: Intent, facts: G6Facts): OversightResolution {
  return resolveGateOversight(policy.policy, intent, 'G6', { changeFlags: [], g6: facts });
}

/** CI failed: a retry from G4, or back to G3 when none is left (N2, FR-13). */
async function failCi(
  tx: TenantScope,
  registry: Registry,
  policy: G5Policy,
  intent: Intent,
  facts: G6Facts,
): Promise<IntentStepResult> {
  const used = await retriesUsed(tx, intent.id);
  const decision = await registry.decide(tx, {
    intentId: intent.id,
    gate: 'G6',
    decision: 'fail',
    actor: { type: 'system' },
    reasonCode: 'ci_failed',
    inputSha256: facts.inputSha256,
    waitedSeconds: waitedSeconds(intent, registry.now()),
    source: 'workflow',
    context: contextOf(facts),
  });
  const retry = used < policy.config.run.g6_ci_retries;
  await audit(tx, registry, intent, facts.run, retry ? 'ci_failed' : 'ci_no_retries', decision.id);
  if (retry) {
    return move(tx, registry, intent, { status: 'in_gate', gate: 'G4' }, 'ci_retry', {
      decisionId: decision.id,
      audience: G4_OPERATOR_ROLES,
    });
  }
  // QUESTIONS #131 rule, extended to G6 (`returnedFromG5`): G3 is HITL from now on and the G3
  // approvals in force no longer count; the same plan may be approved again by a person.
  await registry.voidApprovals(tx, { intentId: intent.id, gate: 'G3', reasonCode: 'ci_failed' });
  return move(tx, registry, intent, { status: 'in_gate', gate: 'G3' }, 'ci_returned', {
    decisionId: decision.id,
    audience: await g3Approvers(tx, policy, intent),
  });
}

/** G6 `fail ci_failed` decisions since the last G3 approval: the retries used. */
async function retriesUsed(tx: TenantScope, intentId: string): Promise<number> {
  const g3 = await tx.gateDecisions.listForIntent(intentId, 'G3');
  const lastG3 = g3
    .filter((d) => d.decision === 'approve' || d.decision === 'pass')
    .map((d) => new Date(d.created_at).getTime())
    .reduce((a, b) => Math.max(a, b), 0);
  return (await tx.gateDecisions.listForIntent(intentId, 'G6')).filter(
    (d) =>
      d.decision === 'fail' &&
      d.reason_code === 'ci_failed' &&
      new Date(d.created_at).getTime() >= lastG3,
  ).length;
}

/**
 * When the CI clock started: entry into G6, the end of G5's block window (the push waits for it),
 * the recorded push, or the close of the run's last G6 escalation, whichever is latest; never
 * later than now.
 */
async function ciClockStart(
  tx: TenantScope,
  registry: Registry,
  policy: G5Policy,
  intent: Intent,
  run: Run,
): Promise<Date> {
  let start = new Date(intent.gate_entered_at ?? intent.updated_at).getTime();
  const g5 = await gateHistory(tx, intent.id, 'G5');
  if (g5.passAt) start = Math.max(start, blockWindowEnd(g5.passAt, policy.config).getTime());
  // The push (recorded by the runner, database clock): CI starts only then.
  const pushed = (await tx.runEvents.list(run.id))
    .filter((e) => e.event_type === 'branch_pushed')
    .at(-1);
  if (pushed) start = Math.max(start, new Date(pushed.created_at).getTime());
  for (const e of await tx.escalations.listForIntent(intent.id)) {
    if (e.run_id === run.id && e.packet.gate === 'G6' && e.closed_at) {
      start = Math.max(start, new Date(e.closed_at).getTime());
    }
  }
  return new Date(Math.min(start, registry.now().getTime()));
}

/** A `resume` on a security escalation for exactly this input: Person B approves next. */
async function resumedFor(
  tx: TenantScope,
  intentId: string,
  inputSha256: string,
): Promise<boolean> {
  return (await tx.escalations.listForIntent(intentId)).some(
    (e) =>
      e.packet.gate === 'G6' &&
      e.packet.reason_code === 'security_finding' &&
      e.packet.subject_sha256 === inputSha256 &&
      String(e.decision?.decision) === 'resume',
  );
}

/** Pauses the intent at G6 with an escalation bound to the G6 input. */
async function stop(
  tx: TenantScope,
  registry: Registry,
  policy: G5Policy,
  intent: Intent,
  facts: G6Facts,
  check: keyof typeof STOPS,
): Promise<IntentStepResult> {
  const kind = STOPS[check];
  const level = policy.config.run.failed_run_escalation;
  await raiseEscalation(
    tx,
    {
      intentId: intent.id,
      runId: facts.run.id,
      trigger: kind.trigger,
      route: kind.route,
      severity: level.severity,
      responseLevel: level.response_level,
      packet: {
        subject_kind: 'g6_input',
        subject_sha256: facts.inputSha256,
        gate: 'G6',
        run_id: facts.run.id,
        agent_id: facts.run.agent_id,
        reason_code: kind.reason,
      },
      producers: facts.run.triggered_by === null ? [] : [facts.run.triggered_by],
      raisedBy: { type: 'system' },
    },
    { now: () => registry.now() },
  );
  await audit(tx, registry, intent, facts.run, check);
  return move(tx, registry, intent, { status: 'paused', gate: 'G6' }, 'g6_escalated', {
    decisionId: null,
    audience: kind.route === 'security' ? ['person_b'] : G4_OPERATOR_ROLES,
  });
}

async function audit(
  tx: TenantScope,
  registry: Registry,
  intent: Intent,
  run: Run,
  check: G6Check,
  decisionId?: string,
): Promise<void> {
  await tx.audit.append({
    action: 'gate.g6_check_failed',
    actorType: 'system',
    actorId: null,
    entityId: intent.id,
    occurredAt: registry.now(),
    payload: { ...(decisionId ? { decision_id: decisionId } : {}), check, run_id: run.id },
  });
}

/** The freeze check before an advance (ADR-M28 §2.4). */
async function advanceAllowed(
  tx: TenantScope,
  intent: Intent,
  registry: Registry,
): Promise<boolean> {
  try {
    await assertActionAllowed(tx, intent.id, 'gate_advance', registry.now());
    return true;
  } catch (error) {
    if (error instanceof EscalationError && error.code === 'frozen') return false;
    throw error;
  }
}

async function notice(
  tx: TenantScope,
  intent: Intent,
  kind: IntentNoticeKind,
  audience: readonly ProjectRole[],
): Promise<void> {
  await tx.intentNotices.record({
    intentId: intent.id,
    kind,
    status: intent.status,
    gate: intent.current_gate,
    previousGate: intent.current_gate,
    decisionId: null,
    audienceRoles: [...new Set(audience.filter((role) => role !== 'viewer'))],
  });
}

async function move(
  tx: TenantScope,
  registry: Registry,
  intent: Intent,
  to: { readonly status: IntentStatus; readonly gate: 'G3' | 'G4' | 'G6' | 'G7' },
  kind: IntentNoticeKind,
  notice_: { readonly decisionId: string | null; readonly audience: readonly ProjectRole[] },
): Promise<IntentStepResult> {
  if (intent.status === 'in_gate' && intent.current_gate === 'G6') {
    await closeGateOverdue(tx, registry, intent.id, 'G6');
  }
  const updated = await tx.intents.moveState(intent.id, {
    from: { status: intent.status, currentGate: intent.current_gate },
    to: { status: to.status, currentGate: to.gate },
    at: registry.now(),
  });
  // Under the intent lock the compare-and-set cannot miss; if it does, roll back this step.
  if (!updated) throw new Error(`G6: intent ${intent.id} moved under its lock`);
  await tx.intentNotices.record({
    intentId: intent.id,
    kind,
    status: updated.status,
    gate: updated.current_gate,
    previousGate: intent.current_gate,
    decisionId: notice_.decisionId,
    audienceRoles: [...new Set(notice_.audience.filter((role) => role !== 'viewer'))],
  });
  return moved;
}
