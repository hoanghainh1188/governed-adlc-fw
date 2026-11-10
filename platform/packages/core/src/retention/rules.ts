// Retention rules (task E05, design/ADR-M51; D-05 §10.1; D-02 FR-44). Pure functions: the
// selection in the database is the first filter, these rules decide again for every row, and the
// purge decides a third time under the intent lock, with the time of that moment.
//
// - One clock per intent: its evidence is kept `retention days` after the later of the intent's
//   end and the row's creation. Open intents are never purged.
// - A code minimum that no configuration changes: nothing younger than 180 days, from its creation
//   and from its intent's end, is purged for retention (`MIN_EVIDENCE_AGE_DAYS`). It equals the
//   floor of rule M31 and the bucket's default lock.
// - Held intents are never purged.
// - An archived project: after the archive grace period (from `project.archived`), every finished
//   intent's evidence is purged, also before the 180 days: the purge identity then bypasses the
//   GOVERNANCE lock (FR-44).
// - A tenant in client-data deletion after its grace period: the same bypass for finished,
//   not-held evidence (H03b, ADR-M97 §2.1).
const DAY_MS = 86_400_000;

/** No row is purged for retention before this age (ADR-M51 §2.4); independent of configuration. */
export const MIN_EVIDENCE_AGE_DAYS = 180;
/** Default lock of the bucket `evidence` (GOVERNANCE, `create-buckets.sh`). */
export const BUCKET_LOCK_DAYS = 180;
/** A lock that ends within this many days is moved forward (projects with longer retention). */
export const LOCK_EXTENSION_MARGIN_DAYS = 14;
/** Intent statuses that never change again. */
export const FINISHED_INTENT_STATUSES_FOR_RETENTION: readonly string[] = [
  'done',
  'rejected',
  'cancelled',
  'blocked',
];

export type PurgeCause = 'retention' | 'archive' | 'client_deletion';

export type KeepReason =
  /** The intent is still open. */
  | 'open'
  /** The intent's evidence is on hold. */
  | 'held'
  /** Within the project's retention. */
  | 'retention'
  /** Younger than the code minimum (a configuration below 180 days, which rule M31 refuses). */
  | 'min_age';

export type PurgeDecision =
  | { readonly purge: true; readonly cause: PurgeCause }
  | { readonly purge: false; readonly reason: KeepReason };

export interface RowFacts {
  readonly now: Date;
  readonly intentStatus: string;
  /** The intent's `updated_at`: its end when it is finished. */
  readonly intentUpdatedAt: Date;
  readonly createdAt: Date;
  readonly held: boolean;
  /** The project's `retention.evidence_retention_days`; null when its configuration is unusable. */
  readonly retentionDays: number | null;
  /** Set when the project is archived and its grace period is over. */
  readonly archivePurgeDue: boolean;
  /** Set when the tenant's client-data purge may delete finished, not-held evidence (H03b). */
  readonly clientDeletionDue?: boolean;
}

export const addDays = (from: Date, count: number): Date =>
  new Date(from.getTime() + count * DAY_MS);

export function isFinished(status: string): boolean {
  return FINISHED_INTENT_STATUSES_FOR_RETENTION.includes(status);
}

/** When the row's retention ends: the later of the intent's end and the row's creation, plus days. */
export function retentionEnds(facts: {
  readonly intentUpdatedAt: Date;
  readonly createdAt: Date;
  readonly retentionDays: number;
}): Date {
  const start = Math.max(facts.intentUpdatedAt.getTime(), facts.createdAt.getTime());
  return addDays(new Date(start), facts.retentionDays);
}

/** Whether a row's files may be purged now, and why not. */
export function purgeDecision(facts: RowFacts): PurgeDecision {
  if (!isFinished(facts.intentStatus)) return { purge: false, reason: 'open' };
  if (facts.held) return { purge: false, reason: 'held' };
  if (facts.clientDeletionDue) return { purge: true, cause: 'client_deletion' };
  if (facts.archivePurgeDue) return { purge: true, cause: 'archive' };
  if (facts.retentionDays === null) return { purge: false, reason: 'retention' };
  const now = facts.now.getTime();
  if (now < retentionEnds({ ...facts, retentionDays: facts.retentionDays }).getTime()) {
    return { purge: false, reason: 'retention' };
  }
  const minimum = retentionEnds({ ...facts, retentionDays: MIN_EVIDENCE_AGE_DAYS }).getTime();
  if (now < minimum) return { purge: false, reason: 'min_age' };
  return { purge: true, cause: 'retention' };
}

/**
 * The cut-off of the database selection for retention: rows created, and intents ended, at or
 * before it. Never later than the code minimum allows.
 */
export function retentionCutoff(now: Date, retentionDays: number): Date {
  return addDays(now, -Math.max(retentionDays, MIN_EVIDENCE_AGE_DAYS));
}

/** Whether an archived project's evidence may be purged: the grace period after the archive is over. */
export function archivePurgeDue(now: Date, archivedAt: Date | null, graceDays: number): boolean {
  return archivedAt !== null && now.getTime() >= addDays(archivedAt, graceDays).getTime();
}

/**
 * How far to move a row's lock, or null. Only for projects that keep evidence longer than the
 * bucket's lock; only when the current lock ends within the margin; never backwards.
 * - A finished intent: to the end of its retention.
 * - An open intent: `retention days` from now (moved again when that nears).
 */
export function lockTarget(facts: {
  readonly now: Date;
  readonly intentStatus: string;
  readonly intentUpdatedAt: Date;
  readonly createdAt: Date;
  readonly lockExtendedUntil: Date | null;
  readonly retentionDays: number;
}): Date | null {
  if (facts.retentionDays <= BUCKET_LOCK_DAYS) return null;
  const bucketLock = addDays(facts.createdAt, BUCKET_LOCK_DAYS).getTime();
  const current = Math.max(bucketLock, facts.lockExtendedUntil?.getTime() ?? 0);
  const now = facts.now.getTime();
  if (now < current - LOCK_EXTENSION_MARGIN_DAYS * DAY_MS) return null;
  const target = isFinished(facts.intentStatus)
    ? retentionEnds(facts)
    : addDays(facts.now, facts.retentionDays);
  return target.getTime() > current && target.getTime() > now ? target : null;
}

/**
 * The purge guard (ADR-M51 §2.4): a pass refuses to purge more than `percent` % of a tenant's
 * stored rows for retention, and never more than `floor` rows when that is larger. A bug or a
 * wrong configuration then stops at the guard instead of emptying the store. Archive purges are
 * not counted: an archived project may be most of a tenant, and its grace period protects it.
 */
export function guardTrips(
  candidates: number,
  liveRows: number,
  guard: { readonly percent: number; readonly floor: number },
): boolean {
  const allowed = Math.max(guard.floor, Math.floor((liveRows * guard.percent) / 100));
  return candidates > allowed;
}
