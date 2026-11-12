// Gate G5, scope drift and budget (task C07 PR 2, D-08 C07 AC1–AC3, D-02 FR-13, FR-32, FR-52,
// D-09 N1, N3, design/D-03 section 6, design/ADR-M34 §2.8–§2.9, QUESTIONS #21, #82, #130–#134).
//
// `stepG5` runs when the intent waits `in_gate G5` after a run (`finishRun`). It reads the run's
// result (`gatherG5Facts`: the runner's checked changes, the key's cap, the synced spend) and
// checks, in this order:
//   1. instruction files: the run added, changed or removed a file the agent reads as
//      instructions (QUESTIONS #126, #132)       → `fail instructions_unpinned`, paused at G5,
//      `security` escalation;
//   1b. secrets (H04, ADR-M93 §2.4): the runner's scan found a secret in the run's added lines
//      → `fail secret_in_diff`, paused at G5, `security` escalation; the scan failed or was not
//      recorded (QUESTIONS #587, #590) → `fail secret_scan_failed`, paused, `technical` escalation.
//      Nothing is pushed before G5 passes, so no pull request carries the secret;
//   2. scope: a changed path outside the plan, or a run stopped for its scope (N1, QUESTIONS #131)
//      → `fail out_of_scope`, back to `in_gate G3`: G3 is HITL from then on and needs a new plan;
//      no escalation (the G3 approver decides);
//   3. caps: the cost cap (`max_budget`, or a synced spend at the stop share, N3)
//      → `fail budget_exceeded`; the iteration cap, the time cap or a stalled run
//      → `fail run_cap_reached` (the exact cause in `gate.g5_check_failed`); each: paused at G5,
//      `intent` escalation (QUESTIONS #21, #82);
//   no record of the changes (the runner never lets this happen) → `fail input_mismatch`, paused,
//      `technical` escalation.
// Then the review size (H05, ADR-M95, QUESTIONS #456, #601–#604): a change over
// `run.review_limits`, or with no measurement, makes G5 HITL at every tier (never a breach, never
// an escalation). The intent waits with the cause `review_too_large` or `review_size_unknown`;
// only an approval with a reason code of `REVIEW_ALLOW_REASON_CODES` counts, and a request for
// changes takes the intent back to G3 (HITL) to split the plan, not to G4.
// Otherwise, by the matrix: HOTL (and AUDIT) → a system `pass`, `in_gate G6` (the block window
// applies: `/reject G5` or `/request-changes G5` within it; C08 waits for it before G6 acts);
// HITL → Person A approves (`/approve G5`). A request for changes at G5 takes the intent back to
// G4 (a new run on the approved plan); a rejection ends it.
// The budget warning (FR-52) is not G5's: the runner records its notice with the run event
// `budget_warning`, so the comment appears while the agent works (Harry, C07 PR 2 decision C).
//
// `stepPausedG5`: the intent waits until a person decides on the escalation (handbook Ch.6 §6.6),
// re-checked just before acting (FR-17):
//   `resume` → back to `in_gate G4`: a new run from `base_sha` after G4 (QUESTIONS #134); with
//     `budget_increase_usd` X (API only) the intent budget grows by X and the next runs' cap is
//     the stopped run's cap + X (QUESTIONS #133, only up);
//   `modify` or `roll_back` → back to `in_gate G3` (a new plan; the run's diff stays as evidence);
//   `terminate` → the intent ends as `cancelled`.
// Every step writes in the step's transaction, under the intent lock. Paths never enter the
// database: G5 reads counts and hashes.
import {
  GATE_REASON_CODES,
  REVIEW_ALLOW_REASON_CODES,
  type EscalationRoute,
  type EscalationTrigger,
  type GateReasonCode,
  type IntentStepResult,
  type IntentStatus,
  type OversightResolution,
  type PolicyEngine,
  type ProjectRole,
  type ValidatedProjectConfig,
} from '@sdlc/contracts';

import { fromMicros, isUsd, toMicros } from '../cost/money.js';
import type { IntentNoticeKind } from '../db/repositories/intent-notices.js';
import type { Escalation, Intent } from '../db/schema.js';
import type { TenantScope } from '../db/tenant-scope.js';
import {
  closeEscalation,
  decisionAllows,
  revalidateEscalationDecision,
} from '../escalation/decide.js';
import { EscalationError } from '../escalation/errors.js';
import { assertActionAllowed } from '../escalation/freeze.js';
import { raiseEscalation } from '../escalation/raise.js';
import type { Registry } from '../registry/registry.js';
import { G4_OPERATOR_ROLES } from './g4.js';
import { gatherG5Facts, spentPercent, type G5Facts } from './g5-facts.js';
import { gateHistory } from './gate-history.js';
import { checkGateOverdue, closeGateOverdue, gateClockStart } from './overdue.js';
import { sentBackForInput } from './hotl.js';
import { resolveGateOversight } from './oversight.js';
import { waitedSeconds } from './waited.js';

export interface G5Policy {
  readonly config: ValidatedProjectConfig;
  readonly policy: PolicyEngine;
}

/** A G5 breach: the gate reason code, the exact cause (audit) and where the intent goes. */
export interface G5Breach {
  readonly reason: GateReasonCode;
  readonly check:
    | 'instructions_changed'
    | 'secret_found'
    | 'secret_scan_failed'
    | 'out_of_scope'
    | 'outside_project_path'
    | 'max_budget'
    | 'spend_at_stop'
    | 'max_iterations'
    | 'max_duration'
    | 'stalled'
    | 'changes_missing';
  /** Null: back to G3, no escalation (scope). Otherwise the escalation's route and trigger. */
  readonly escalation: {
    readonly route: EscalationRoute;
    readonly trigger: EscalationTrigger;
  } | null;
}

/** The first breach of the run, in the order of the header; null when none. */
export function g5Breach(facts: G5Facts, config: ValidatedProjectConfig): G5Breach | null {
  const { run, changes } = facts;
  if (changes === null) {
    return {
      reason: 'input_mismatch',
      check: 'changes_missing',
      escalation: { route: 'technical', trigger: 'unusual_behaviour' },
    };
  }
  if (changes.instructionFiles > 0) {
    return {
      reason: 'instructions_unpinned',
      check: 'instructions_changed',
      escalation: { route: 'security', trigger: 'risky_action' },
    };
  }
  if (facts.secrets?.result === 'found') {
    return {
      reason: 'secret_in_diff',
      check: 'secret_found',
      escalation: { route: 'security', trigger: 'risky_action' },
    };
  }
  if (facts.secrets === null || facts.secrets.result !== 'clean') {
    return {
      reason: 'secret_scan_failed',
      check: 'secret_scan_failed',
      escalation: { route: 'technical', trigger: 'unusual_behaviour' },
    };
  }
  // O06 (ADR-M106 §2.4): a change outside the project's folder, like a change outside the plan.
  if (changes.outsideFolder > 0) {
    return { reason: 'out_of_scope', check: 'outside_project_path', escalation: null };
  }
  if (changes.outOfScope > 0 || run.status === 'stopped_scope') {
    return { reason: 'out_of_scope', check: 'out_of_scope', escalation: null };
  }
  const caps = { route: 'intent', trigger: 'accumulated_risk' } as const;
  if (run.status === 'stopped_budget' && run.stop_reason === 'max_budget') {
    return { reason: 'budget_exceeded', check: 'max_budget', escalation: caps };
  }
  // The runner checks the spend only while the agent works (ADR-M34 §2.6): G5 reads it again.
  const percent = spentPercent(facts);
  if (percent !== null && percent >= config.budget.stop_percent) {
    return { reason: 'budget_exceeded', check: 'spend_at_stop', escalation: caps };
  }
  if (run.status === 'stopped_budget') {
    return { reason: 'run_cap_reached', check: 'max_iterations', escalation: caps };
  }
  if (run.status === 'stopped_timeout') {
    return { reason: 'run_cap_reached', check: 'max_duration', escalation: caps };
  }
  if (run.status === 'stopped_stalled') {
    return { reason: 'run_cap_reached', check: 'stalled', escalation: caps };
  }
  return null;
}

type Waiting = Extract<IntentStepResult, { outcome: 'waiting' }>;
const moved: IntentStepResult = { outcome: 'moved' };
const wait = (reason: Waiting['reason']): IntentStepResult => ({ outcome: 'waiting', reason });

/** The step at `in_gate G5` (see the header). Under the intent lock. */
export async function stepG5(
  tx: TenantScope,
  registry: Registry,
  policy: G5Policy,
  intent: Intent,
): Promise<IntentStepResult> {
  const facts = await gatherG5Facts(tx, intent.id);
  // No run to check (for example an intent moved to G5 by hand): nothing to decide.
  if (!facts) return wait('not_in_gate');

  const history = await gateHistory(tx, intent.id, 'G5');
  if (history.rejection !== null) {
    return move(tx, registry, intent, { status: 'rejected', gate: 'G5' }, 'rejected', {
      decisionId: history.rejection,
      audience: [],
    });
  }
  // H05: the oversight is resolved before the decisions are read; it says whether the run is held
  // for its size (pure: the size is one of the facts).
  const oversight = resolveGateOversight(policy.policy, intent, 'G5', {
    changeFlags: [],
    reviewSize: facts.review,
  });
  const held = reviewHold(oversight, facts);
  // H05: a request for changes of a change too large to review splits the plan at G3.
  if (history.latestChangesRequest !== null && held !== null) {
    return splitAtG3(tx, registry, policy, intent, facts, held, history.latestChangesRequest);
  }
  // A person sent the run's changes back (HITL, or within the block window): a new run after G4.
  if (history.latestChangesRequest !== null) {
    return move(tx, registry, intent, { status: 'in_gate', gate: 'G4' }, 'returned', {
      decisionId: history.latestChangesRequest,
      audience: G4_OPERATOR_ROLES,
    });
  }

  const breach = g5Breach(facts, policy.config);
  if (breach) return failG5(tx, registry, policy, intent, facts, breach);

  if (oversight.mode === 'HITL') {
    const { valid } = await registry.revalidateApprovals(tx, {
      intentId: intent.id,
      gate: 'G5',
      inputSha256: facts.inputSha256,
    });
    const approvals = valid.filter(
      (a) =>
        history.countedApprovals.has(a.id) && (held === null || allowsReviewSize(a.reason_code)),
    );
    if (approvals.length < Math.max(1, oversight.approvalsNeeded)) {
      // FR-12 (ADR-M30 §2.9): the gate deadline and its overdue escalation, as at G1–G4.
      const wakeInMs = await checkGateOverdue(tx, registry, {
        intent,
        gate: 'G5',
        config: policy.config,
        oversight,
        clockStart: gateClockStart(intent, history.latestChangesRequestAt),
        subject: { kind: 'g5_input', sha256: facts.inputSha256 },
        producers: facts.run.triggered_by === null ? [] : [facts.run.triggered_by],
      });
      return {
        outcome: 'waiting',
        reason: 'g5_decision',
        ...(wakeInMs === undefined ? {} : { wakeInMs }),
        ...(held === null ? {} : { cause: held }),
      };
    }
    // A person decided: the overdue escalation closes before the freeze check (as at G1–G4).
    await closeGateOverdue(tx, registry, intent.id, 'G5');
    if (!(await advanceAllowed(tx, intent, registry))) return wait('frozen');
    return move(tx, registry, intent, { status: 'in_gate', gate: 'G6' }, 'advanced', {
      decisionId: approvals.at(-1)!.id,
      audience: [],
    });
  }
  // HOTL and AUDIT: the platform passes; never again on an input a person sent back.
  if (await sentBackForInput(tx, intent.id, 'G5', facts.inputSha256)) return wait('g5_decision');
  if (!(await advanceAllowed(tx, intent, registry))) return wait('frozen');
  const pass = await registry.decide(tx, {
    intentId: intent.id,
    gate: 'G5',
    decision: 'pass',
    actor: { type: 'system' },
    inputSha256: facts.inputSha256,
    waitedSeconds: waitedSeconds(intent, registry.now()),
    source: 'workflow',
  });
  return move(tx, registry, intent, { status: 'in_gate', gate: 'G6' }, 'hotl_passed', {
    decisionId: pass.id,
    audience: oversight.roles.filter((role) => role !== 'viewer'),
  });
}

/** Why the run is held for its size (H05), or null: the policy's `review_too_large` override. */
export function reviewHold(
  oversight: Pick<OversightResolution, 'overrides'>,
  facts: Pick<G5Facts, 'review'>,
): 'review_too_large' | 'review_size_unknown' | null {
  if (!oversight.overrides.includes('review_too_large')) return null;
  return facts.review === null ? 'review_size_unknown' : 'review_too_large';
}

/** An approval of a held run counts only with a reason code of `REVIEW_ALLOW_REASON_CODES`. */
export function allowsReviewSize(reasonCode: string | null): boolean {
  return (
    reasonCode !== null && (REVIEW_ALLOW_REASON_CODES as readonly string[]).includes(reasonCode)
  );
}

/**
 * H05 (ADR-M95 §2.5): a person requested changes of a run held for its size. The intent goes back
 * to G3 to split the plan; G3 is HITL from then on (`returnedFromG5` reads the audit event) and
 * the earlier G3 approval no longer counts. The same plan may be approved again: a person decides.
 */
async function splitAtG3(
  tx: TenantScope,
  registry: Registry,
  policy: G5Policy,
  intent: Intent,
  facts: G5Facts,
  held: 'review_too_large' | 'review_size_unknown',
  decisionId: string,
): Promise<IntentStepResult> {
  await tx.audit.append({
    action: 'gate.g5_split_requested',
    actorType: 'system',
    actorId: null,
    entityId: intent.id,
    occurredAt: registry.now(),
    payload: { decision_id: decisionId, check: held, run_id: facts.run.id },
  });
  await registry.voidApprovals(tx, { intentId: intent.id, gate: 'G3', reasonCode: held });
  return move(tx, registry, intent, { status: 'in_gate', gate: 'G3' }, 'g5_returned', {
    decisionId,
    audience: await g3Approvers(tx, policy, intent),
  });
}

/** Records the G5 `fail`, the exact cause, and moves the intent (G3, or paused + escalation). */
async function failG5(
  tx: TenantScope,
  registry: Registry,
  policy: G5Policy,
  intent: Intent,
  facts: G5Facts,
  breach: G5Breach,
): Promise<IntentStepResult> {
  const decision = await registry.decide(tx, {
    intentId: intent.id,
    gate: 'G5',
    decision: 'fail',
    actor: { type: 'system' },
    reasonCode: breach.reason,
    inputSha256: facts.inputSha256,
    waitedSeconds: waitedSeconds(intent, registry.now()),
    source: 'workflow',
    context: { breached: true },
  });
  await tx.audit.append({
    action: 'gate.g5_check_failed',
    actorType: 'system',
    actorId: null,
    entityId: intent.id,
    occurredAt: registry.now(),
    payload: { decision_id: decision.id, check: breach.check, run_id: facts.run.id },
  });
  if (breach.escalation === null) {
    // N1, QUESTIONS #131: back to G3; the G3 approvers (HITL from now on) act next. The earlier
    // round's G3 approval no longer counts.
    await registry.voidApprovals(tx, {
      intentId: intent.id,
      gate: 'G3',
      reasonCode: 'out_of_scope',
    });
    return move(tx, registry, intent, { status: 'in_gate', gate: 'G3' }, 'scope_returned', {
      decisionId: decision.id,
      audience: await g3Approvers(tx, policy, intent),
    });
  }
  const level = policy.config.run.g5_breach_escalation;
  await raiseEscalation(
    tx,
    {
      intentId: intent.id,
      runId: facts.run.id,
      trigger: breach.escalation.trigger,
      route: breach.escalation.route,
      severity: level.severity,
      responseLevel: level.response_level,
      packet: {
        subject_kind: 'g5_input',
        subject_sha256: facts.inputSha256,
        gate: 'G5',
        run_id: facts.run.id,
        agent_id: facts.run.agent_id,
        reason_code: breach.reason,
      },
      // The person who allowed the run produced it with the agent (FR-11, FR-18).
      producers: facts.run.triggered_by === null ? [] : [facts.run.triggered_by],
      raisedBy: { type: 'system' },
    },
    { now: () => registry.now() },
  );
  return move(tx, registry, intent, { status: 'paused', gate: 'G5' }, 'g5_breach', {
    decisionId: decision.id,
    audience: G4_OPERATOR_ROLES,
  });
}

/** The step at `paused G5`: acts on the escalation's decision (see the header). Under the lock. */
export async function stepPausedG5(
  tx: TenantScope,
  registry: Registry,
  policy: G5Policy,
  intent: Intent,
): Promise<IntentStepResult> {
  const run = (await tx.runs.listForIntent(intent.id)).at(-1);
  const escalation = run
    ? (await tx.escalations.listForIntent(intent.id))
        .filter((e) => e.run_id === run.id && e.packet.gate === 'G5')
        .at(-1)
    : undefined;
  if (!run || !escalation) return wait('g5_review');
  // FR-17: the escalation is bound to the G5 input it was raised for. A changed input (a late
  // spend sync) voids its decision and closes it; G5 is evaluated again on the new result, which
  // raises a new escalation bound to the new input.
  // An escalation closed outside this step (no decision acted on) is re-evaluated the same way:
  // G5 raises a new escalation, so the intent never stays paused without one.
  const current = (await gatherG5Facts(tx, intent.id))?.inputSha256 ?? null;
  if (
    escalation.status === 'closed' ||
    (current !== null && current !== escalation.packet.subject_sha256)
  ) {
    if (escalation.status !== 'closed' && escalation.decision !== null && current !== null) {
      await revalidateEscalationDecision(
        tx,
        { escalationId: escalation.id, subjectSha256: current, action: 'run_start' },
        { now: () => registry.now() },
      );
    }
    await close(tx, registry, escalation);
    await tx.intents.moveState(intent.id, {
      from: { status: 'paused', currentGate: 'G5' },
      to: { status: 'in_gate', currentGate: 'G5' },
      at: registry.now(),
    });
    return moved;
  }
  if (escalation.decision === null) return wait('g5_review');
  const now = registry.now();
  const decision = String(escalation.decision.decision);
  const subjectSha256 = String(escalation.packet.subject_sha256);

  switch (decision) {
    case 'resume': {
      // Re-checked every time: an expired or mismatched decision is voided (FR-17).
      if (!(await stillValid(tx, registry, escalation, subjectSha256, 'run_start'))) {
        return wait('g5_review');
      }
      await raiseBudgetIfDecided(tx, escalation, run.id, now);
      await close(tx, registry, escalation);
      return move(tx, registry, intent, { status: 'in_gate', gate: 'G4' }, 'run_resumed', {
        decisionId: null,
        audience: G4_OPERATOR_ROLES,
      });
    }
    case 'modify':
    case 'roll_back': {
      if (!(await stillValid(tx, registry, escalation, subjectSha256, 'gate_advance', true))) {
        return wait('g5_review');
      }
      await close(tx, registry, escalation);
      // Decision A: G3 is HITL from now on (`returnedFromG5`); the same plan may be approved, by a
      // new decision: the earlier round's G3 approval is voided with the breach's reason code.
      await registry.voidApprovals(tx, {
        intentId: intent.id,
        gate: 'G3',
        reasonCode: breachReason(escalation),
      });
      return move(tx, registry, intent, { status: 'in_gate', gate: 'G3' }, 'g5_returned', {
        decisionId: null,
        audience: await g3Approvers(tx, policy, intent),
      });
    }
    case 'terminate': {
      if (!(await stillValid(tx, registry, escalation, subjectSha256, 'gate_advance', true))) {
        return wait('g5_review');
      }
      await close(tx, registry, escalation);
      return move(tx, registry, intent, { status: 'cancelled', gate: 'G5' }, 'terminated', {
        decisionId: null,
        audience: [],
      });
    }
    default:
      return wait('g5_review');
  }
}

/**
 * The decision still binds this run's result and has not expired (FR-17); an expired or mismatched
 * one is voided and the escalation waits for a new decision. `anyScope`: the decision acts by
 * ending or sending back, which no protected action covers (`roll_back`, `terminate`).
 */
export async function stillValid(
  tx: TenantScope,
  registry: Registry,
  escalation: Escalation,
  subjectSha256: string,
  action: 'run_start' | 'gate_advance',
  anyScope = false,
): Promise<boolean> {
  if (escalation.status === 'closed') return false;
  const check = await revalidateEscalationDecision(
    tx,
    { escalationId: escalation.id, subjectSha256, action },
    { now: () => registry.now() },
  );
  return check.valid || (anyScope && check.reason === 'scope_mismatch');
}

/**
 * QUESTIONS #133: a `resume` that names `budget_increase` with an amount X raises the intent
 * budget by X, and the next runs' cap to the stopped run's cap + X. Only through the API: a
 * comment never names it (ADR-M28 §2.7).
 */
async function raiseBudgetIfDecided(
  tx: TenantScope,
  escalation: Escalation,
  runId: string,
  now: Date,
): Promise<void> {
  const amount = escalation.decision?.budget_increase_usd;
  // The decision API checks the amount; the step checks again so that a bad value can never
  // block it: no valid amount, no increase.
  if (!isUsd(amount) || toMicros(amount) <= 0n) return;
  if (!decisionAllows(escalation, 'budget_increase', now)) return;
  const contract = await tx.runContracts.getByRunId(runId);
  const cap = contract?.contract_json.max_budget_usd;
  const previousCap = isUsd(cap) ? cap : '0';
  await tx.intents.raiseBudget(escalation.intent_id, {
    addUsd: amount,
    runBudgetUsd: fromMicros(toMicros(previousCap) + toMicros(amount)),
    escalationId: escalation.id,
  });
}

/** The reason code of the G5 breach an escalation is about (its packet); `other` when missing. */
export function breachReason(escalation: Escalation): GateReasonCode {
  const code = escalation.packet.reason_code;
  return typeof code === 'string' && (GATE_REASON_CODES as readonly string[]).includes(code)
    ? (code as GateReasonCode)
    : 'other';
}

/** The roles that approve G3 after a return from G5 (HITL, `returnedFromG5`). */
export async function g3Approvers(
  tx: TenantScope,
  policy: G5Policy,
  intent: Intent,
): Promise<ProjectRole[]> {
  const g3 = resolveGateOversight(policy.policy, intent, 'G3', {
    changeFlags: (await tx.plans.latest(intent.id))?.change_flags ?? [],
    returnedFromG5: true,
  });
  return g3.roles.filter((role) => role !== 'viewer');
}

export async function close(
  tx: TenantScope,
  registry: Registry,
  escalation: Escalation,
): Promise<void> {
  await closeEscalation(
    tx,
    { escalationId: escalation.id, closedBy: { type: 'system' } },
    { now: () => registry.now() },
  );
}

/** The freeze check before an advance (ADR-M28 §2.4). Failing or pausing is never frozen. */
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

async function move(
  tx: TenantScope,
  registry: Registry,
  intent: Intent,
  to: { readonly status: IntentStatus; readonly gate: 'G3' | 'G4' | 'G5' | 'G6' },
  kind: IntentNoticeKind,
  notice: { readonly decisionId: string | null; readonly audience: readonly ProjectRole[] },
): Promise<IntentStepResult> {
  // The gate was decided: its overdue escalation (HITL only) closes before the move.
  if (intent.status === 'in_gate' && intent.current_gate === 'G5') {
    await closeGateOverdue(tx, registry, intent.id, 'G5');
  }
  const updated = await tx.intents.moveState(intent.id, {
    from: { status: intent.status, currentGate: intent.current_gate },
    to: { status: to.status, currentGate: to.gate },
    at: registry.now(),
  });
  // Under the intent lock the compare-and-set cannot miss. If it does, roll back the decisions
  // and escalations this step wrote, so that a retry does not write them twice.
  if (!updated) throw new Error(`G5: intent ${intent.id} moved under its lock`);
  await tx.intentNotices.record({
    intentId: intent.id,
    kind,
    status: updated.status,
    gate: updated.current_gate,
    previousGate: intent.current_gate,
    decisionId: notice.decisionId,
    audienceRoles: [...new Set(notice.audience)],
  });
  return moved;
}
