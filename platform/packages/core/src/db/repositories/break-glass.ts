import { isUuid } from '../tenant-id.js';
import type { BreakGlassGrant, BreakGlassGrantsTable, TenantInsert } from '../schema.js';
import type { Updateable } from 'kysely';
import { TenantRepository } from './base.js';

/** The most grants one list returns (newest first). */
export const BREAK_GLASS_LIST_LIMIT = 500;

/** The columns a move may write (migration 0061 grants UPDATE on these only). */
export type BreakGlassUpdate = Pick<
  Updateable<BreakGlassGrantsTable>,
  | 'status'
  | 'approver_id'
  | 'decided_at'
  | 'expires_at'
  | 'escalation_id'
  | 'ended_at'
  | 'revoked_by'
  | 'review_url'
  | 'reviewed_by'
  | 'reviewed_at'
  | 'review_overdue_at'
>;

/**
 * Break-glass grants (task H08, migration 0061, ADR-M111 §2.1, §2.5). Insert, read and the moves
 * that trigger SDA32 allows; never a delete. Every query names the tenant.
 */
export class BreakGlassRepository extends TenantRepository {
  /** Records a request; a second open grant for the intent fails with `conflict`. */
  request(input: TenantInsert<'break_glass_grants'>): Promise<BreakGlassGrant> {
    return this.run(
      this.db
        .insertInto('break_glass_grants')
        .values({ ...input, tenant_id: this.tenantId })
        .returningAll()
        .executeTakeFirstOrThrow(),
    );
  }

  /** One grant of this tenant, or undefined. */
  get(id: string): Promise<BreakGlassGrant | undefined> {
    if (!isUuid(id)) return Promise.resolve(undefined);
    return this.run(
      this.db
        .selectFrom('break_glass_grants')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', id)
        .executeTakeFirst(),
    );
  }

  /** The grant, locked for the rest of the transaction. */
  lockForUpdate(id: string): Promise<BreakGlassGrant | undefined> {
    if (!isUuid(id)) return Promise.resolve(undefined);
    return this.run(
      this.db
        .selectFrom('break_glass_grants')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst(),
    );
  }

  /** The `requested` or `active` grant of the intent, or undefined (at most one). */
  openForIntent(intentId: string): Promise<BreakGlassGrant | undefined> {
    return this.run(
      this.db
        .selectFrom('break_glass_grants')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('intent_id', '=', intentId)
        .where('status', 'in', ['requested', 'active'])
        .executeTakeFirst(),
    );
  }

  /** Every grant of the intent, oldest first. */
  listForIntent(intentId: string): Promise<BreakGlassGrant[]> {
    return this.run(
      this.db
        .selectFrom('break_glass_grants')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('intent_id', '=', intentId)
        .orderBy('created_at')
        .orderBy('id')
        .execute(),
    );
  }

  /** The grants of these projects, newest first; only `requested` and `active` with `open`. */
  listForProjects(projectIds: readonly string[], open = false): Promise<BreakGlassGrant[]> {
    if (projectIds.length === 0) return Promise.resolve([]);
    let query = this.db
      .selectFrom('break_glass_grants')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('project_id', 'in', [...projectIds]);
    if (open) query = query.where('status', 'in', ['requested', 'active']);
    return this.run(
      query
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(BREAK_GLASS_LIST_LIMIT)
        .execute(),
    );
  }

  /** Open grants whose time is over at `now`: requests past `lapses_at`, grants past `expires_at`. */
  listDue(now: Date): Promise<BreakGlassGrant[]> {
    return this.run(
      this.db
        .selectFrom('break_glass_grants')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where((eb) =>
          eb.or([
            eb.and([eb('status', '=', 'requested'), eb('lapses_at', '<=', now)]),
            eb.and([eb('status', '=', 'active'), eb('expires_at', '<=', now)]),
          ]),
        )
        .orderBy('created_at')
        .limit(BREAK_GLASS_LIST_LIMIT)
        .execute(),
    );
  }

  /** Grants that were active, ended at or before `endedBefore`, with no review and no overdue mark. */
  listUnreviewed(endedBefore: Date): Promise<BreakGlassGrant[]> {
    return this.run(
      this.db
        .selectFrom('break_glass_grants')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('status', 'in', ['revoked', 'expired'])
        .where('review_url', 'is', null)
        .where('review_overdue_at', 'is', null)
        .where('ended_at', '<=', endedBefore)
        .orderBy('ended_at')
        .limit(BREAK_GLASS_LIST_LIMIT)
        .execute(),
    );
  }

  /** Writes a move (trigger SDA32 refuses one not allowed). */
  update(id: string, set: BreakGlassUpdate): Promise<BreakGlassGrant> {
    return this.run(
      this.db
        .updateTable('break_glass_grants')
        .set(set)
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow(),
    );
  }
}
