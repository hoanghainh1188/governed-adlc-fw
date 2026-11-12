// G3 after G5 sent the intent back (task C07, QUESTIONS #131, design/ADR-M34 §2.8):
// - G3 is HITL at every tier from then on (`GateContext.returnedFromG5`, like a forced-HITL flag),
//   after a run went outside its plan, and after a person decided `modify` or `roll_back` on a G5
//   escalation (Harry, C07 PR 2 decision A);
// - the plan a run went outside of can never be approved again: G3 needs a new plan hash. A
//   `modify` or `roll_back` allows the same plan: a person decides at G3.
// Both read stored facts: the audit events `gate.g5_check_failed` with the check `out_of_scope`,
// and the closed G5 escalations with their decision. C08 PR 2: G6 sends the intent back to G3 the
// same way (`gate.g6_check_failed` with `ci_no_retries`, or `modify` / `roll_back` on a G6
// escalation); the new-plan rule stays for `out_of_scope` only. E01: G7 too (a rejection, or
// `modify` / `roll_back` on a G7 escalation; QUESTIONS #178). H05: a request for changes at G5 of
// a run too large to review (`gate.g5_split_requested`).
import type { TenantScope } from '../db/tenant-scope.js';

/** Decisions on a G5 escalation that send the intent back to G3. */
export const G5_RETURN_DECISIONS: readonly string[] = ['modify', 'roll_back'];

async function scopeFailures(scope: TenantScope, intentId: string): Promise<string[]> {
  const events = await scope.audit.listForEntity(intentId, ['gate.g5_check_failed']);
  return events
    .map((e) => e.payload as { check?: unknown; run_id?: unknown })
    .filter(
      (p) =>
        (p.check === 'out_of_scope' || p.check === 'outside_project_path') &&
        typeof p.run_id === 'string',
    )
    .map((p) => p.run_id as string);
}

/**
 * True when G5 ever sent the intent back to G3: a run went outside its plan, or a person decided
 * `modify` or `roll_back` on a G5 escalation.
 */
export async function returnedFromG5(scope: TenantScope, intentId: string): Promise<boolean> {
  if ((await scopeFailures(scope, intentId)).length > 0) return true;
  // H05 (ADR-M95 §2.5): a request for changes of a run too large to review split the plan at G3.
  if ((await scope.audit.listForEntity(intentId, ['gate.g5_split_requested'])).length > 0) {
    return true;
  }
  // C08 PR 2 (ADR-M38 §2.7): G6 sent the intent back to G3 when CI failed with no retries left
  // (N2, FR-13). The same rule holds: G3 is HITL from then on.
  const g6 = await scope.audit.listForEntity(intentId, ['gate.g6_check_failed']);
  if (g6.some((e) => (e.payload as { check?: unknown }).check === 'ci_no_retries')) return true;
  // E01 (QUESTIONS #178): a rejection at G7 sends the intent back to G3 the same way.
  if (
    (await scope.gateDecisions.listForIntent(intentId, 'G7')).some((d) => d.decision === 'reject')
  ) {
    return true;
  }
  const escalations = await scope.escalations.listForIntent(intentId);
  if (
    escalations.some(
      (e) =>
        e.status === 'closed' &&
        e.trigger !== 'time' &&
        (e.packet.gate === 'G5' || e.packet.gate === 'G6' || e.packet.gate === 'G7') &&
        G5_RETURN_DECISIONS.includes(String(e.decision?.decision)),
    )
  ) {
    return true;
  }
  // QUESTIONS #211 (first E01 PR 2, #191): `modify` or `roll_back` on the escalation of a failed
  // run took the intent back to G3 the same way.
  return escalations.some(
    (e) =>
      e.status === 'closed' &&
      e.packet.gate === 'G4' &&
      e.run_id !== null &&
      G5_RETURN_DECISIONS.includes(String(e.decision?.decision)),
  );
}

/** The hashes of the plans that a run of the intent went outside of. */
export async function refusedPlanHashes(
  scope: TenantScope,
  intentId: string,
): Promise<ReadonlySet<string>> {
  const runIds = await scopeFailures(scope, intentId);
  if (runIds.length === 0) return new Set();
  const plans = await scope.plans.list(intentId);
  const hashes = new Set<string>();
  for (const runId of runIds) {
    const run = await scope.runs.getById(runId);
    const plan = plans.find((p) => p.id === run?.plan_id);
    if (plan) hashes.add(plan.plan_sha256);
  }
  return hashes;
}
