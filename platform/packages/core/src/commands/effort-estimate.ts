// The human-effort baseline of an intent (task V14, D-08 V14 AC1, ADR-M79 §2.6, QUESTIONS
// #691–#693). A person records how many hours the work would take without an agent; the agent
// report compares the merged intents' lead time with it (`metrics/agents.ts`).
//
// - Who (QUESTIONS #693): a role on the project in `access.intent_create_roles` (never `viewer`,
//   rule M16), or a tenant admin. No role on the project and not a tenant admin → `intent_not_found`;
//   a read role only → `forbidden`. No new config key.
// - When (QUESTIONS #692): while the intent is open. A finished intent (`done`, `rejected`,
//   `cancelled`, `blocked`) → `intent_finished`; the database trigger (SDA29) refuses it too.
// - What: hours from 0.25 to 10000 with at most two decimals, a number only, never a text. The
//   estimate can change while the intent is open; it never goes back to empty.
import { isTenantAdmin } from '../admin/actor.js';
import { DbError } from '../db/errors.js';
import { isEffortHours } from '../db/repositories/intents.js';
import type { Intent } from '../db/schema.js';
import type { TenantScope } from '../db/tenant-scope.js';
import { FINISHED_INTENT_STATUSES } from '../workflow/step.js';
import { projectAccess } from './access.js';
import { CommandError } from './errors.js';

export interface EffortEstimateRequest {
  readonly intent: Intent;
  /** Decimal string of hours, 0.25 to 10000, at most two decimals. */
  readonly hours: string;
  /** The person who records the estimate. */
  readonly actorId: string;
}

const isFinished = (status: string): boolean =>
  (FINISHED_INTENT_STATUSES as readonly string[]).includes(status);

/** Refuses a person who may not write the estimate (QUESTIONS #693). */
async function assertMayEstimate(
  scope: TenantScope,
  intent: Intent,
  actorId: string,
): Promise<void> {
  if (await isTenantAdmin(scope, actorId)) return;
  const access = await projectAccess(scope, intent.project_id, actorId);
  if (!access.canRead)
    throw new CommandError('intent_not_found', `intent ${intent.code} not found`);
  if (!access.canCreateIntent) {
    throw new CommandError('forbidden', 'the caller may not record an effort estimate');
  }
}

/** Records the estimate under the intent lock; returns the intent as stored. */
export async function recordEffortEstimate(
  scope: TenantScope,
  request: EffortEstimateRequest,
): Promise<Intent> {
  const { intent, actorId } = request;
  await assertMayEstimate(scope, intent, actorId);
  if (!isEffortHours(request.hours)) {
    throw new DbError('invalid_value', 'hours must be 0.25 to 10000 with at most 2 decimals');
  }
  return scope.transaction(async (tx) => {
    const locked = await tx.intents.lockAndGet(intent.id);
    if (!locked) throw new CommandError('intent_not_found', `intent ${intent.code} not found`);
    if (isFinished(locked.status)) {
      throw new CommandError('intent_finished', `${intent.code} is finished`);
    }
    // The role may have been withdrawn since the first check.
    await assertMayEstimate(tx, locked, actorId);
    return tx.intents.recordEffortEstimate(locked.id, { hours: request.hours, actorId });
  });
}
