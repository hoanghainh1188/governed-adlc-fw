// The worker's break-glass pass for one tenant (task H08, ADR-M111 §2.5, §2.8). A plain loop calls
// it (R044: never a Temporal timer or schedule); PR 3 wires it into the worker. Each move is its own
// transaction with its audit event, written once: the row lock and trigger SDA32 keep a second
// worker from writing it again.
import type { BreakGlassGrant } from '../db/schema.js';
import type { TenantScope } from '../db/tenant-scope.js';
import { loadEffectiveConfig } from '../registry/effective-config.js';

const HOUR_MS = 3_600_000;
/** The shortest review window (`break_glass.review_due_hours` is 1 to 48). */
const MIN_REVIEW_HOURS = 1;

export interface BreakGlassPassResult {
  readonly expired: number;
  readonly lapsed: number;
  readonly reviewOverdue: number;
}

/** Ends the grants whose time is over at `now`, then marks the reviews that are overdue. */
export async function runBreakGlassPass(
  scope: TenantScope,
  now: Date,
): Promise<BreakGlassPassResult> {
  let expired = 0;
  let lapsed = 0;
  for (const due of await scope.breakGlass.listDue(now)) {
    const ended = await endGrant(scope, due.id, now);
    if (ended === 'expired') expired += 1;
    if (ended === 'lapsed') lapsed += 1;
  }
  let reviewOverdue = 0;
  const candidates = await scope.breakGlass.listUnreviewed(
    new Date(now.getTime() - MIN_REVIEW_HOURS * HOUR_MS),
  );
  const dueHours = new Map<string, number>();
  for (const grant of candidates) {
    let hours = dueHours.get(grant.project_id);
    if (hours === undefined) {
      hours = (await loadEffectiveConfig(scope.projectConfigs, grant.project_id)).config.break_glass
        .review_due_hours;
      dueHours.set(grant.project_id, hours);
    }
    if (grant.ended_at!.getTime() + hours * HOUR_MS > now.getTime()) continue;
    if (await markReviewOverdue(scope, grant.id, now)) reviewOverdue += 1;
  }
  return { expired, lapsed, reviewOverdue };
}

async function endGrant(
  scope: TenantScope,
  id: string,
  now: Date,
): Promise<'expired' | 'lapsed' | null> {
  return scope.transaction(async (tx) => {
    const grant = await tx.breakGlass.lockForUpdate(id);
    const status = grant ? dueStatus(grant, now) : null;
    if (!grant || status === null) return null;
    await tx.breakGlass.update(grant.id, { status, ended_at: now });
    await tx.audit.append({
      action: status === 'expired' ? 'break_glass.expired' : 'break_glass.lapsed',
      actorType: 'system',
      actorId: null,
      entityId: grant.id,
      payload: { intent_id: grant.intent_id },
    });
    return status;
  });
}

/** The end state of an open grant whose time is over at `now`, or null. */
export function dueStatus(grant: BreakGlassGrant, now: Date): 'expired' | 'lapsed' | null {
  if (grant.status === 'requested' && grant.lapses_at.getTime() <= now.getTime()) return 'lapsed';
  if (
    grant.status === 'active' &&
    grant.expires_at !== null &&
    grant.expires_at.getTime() <= now.getTime()
  ) {
    return 'expired';
  }
  return null;
}

async function markReviewOverdue(scope: TenantScope, id: string, now: Date): Promise<boolean> {
  return scope.transaction(async (tx) => {
    const grant = await tx.breakGlass.lockForUpdate(id);
    if (!grant || grant.review_url !== null || grant.review_overdue_at !== null) return false;
    if (grant.escalation_id === null) return false;
    const escalation = await tx.escalations.getById(grant.escalation_id);
    await tx.breakGlass.update(grant.id, { review_overdue_at: now });
    await tx.audit.append({
      action: 'break_glass.review_overdue',
      actorType: 'system',
      actorId: null,
      entityId: grant.id,
      payload: { intent_id: grant.intent_id, incident: escalation?.code ?? 'unknown' },
    });
    return true;
  });
}
