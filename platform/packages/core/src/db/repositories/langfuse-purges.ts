// The Langfuse purge of each intent (task E08, design/ADR-M53; D-05 §6.6 and §10.1, version 1.35;
// migration 0024). Always for one tenant, with `tenant_id = <tenant>` on every table occurrence.
//
// - The selection is the first filter: finished intents of a project, ended at or before the
//   cut-off, without an active hold, whose Langfuse purge is not confirmed. The retention rules
//   decide again for each intent, and the purge decides a third time under the intent lock.
// - A request is recorded when the worker asked Langfuse to delete; it is confirmed once, on a
//   later pass, when the intent's traces are no longer found (Langfuse deletes asynchronously).
import { sql } from 'kysely';

import { DbError } from '../errors.js';
import type { LangfusePurgesTable } from '../schema.js';
import { isUuid } from '../tenant-id.js';
import { TenantRepository } from './base.js';
import { FINISHED_FOR_RETENTION } from './retention.js';

export type LangfusePurgeCause = 'retention' | 'archive' | 'client_deletion';

/** A finished intent whose Langfuse purge is not confirmed. */
export interface LangfuseCandidate {
  readonly intentId: string;
  readonly intentCode: string;
  readonly intentStatus: string;
  /** The intent's `updated_at`: its end. */
  readonly intentUpdatedAt: Date;
  /** Attempts of an earlier, unconfirmed request; 0 when none. */
  readonly attempts: number;
}

export interface LangfusePurgeRow {
  readonly intentId: string;
  readonly cause: LangfusePurgeCause;
  readonly traces: number;
  readonly attempts: number;
  readonly requestedAt: Date;
  readonly lastRequestedAt: Date;
  readonly confirmedAt: Date | null;
}

function toDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') return new Date(value);
  throw new TypeError('langfuse purges: unexpected time value');
}

type Selected = Pick<
  LangfusePurgesTable,
  'intent_id' | 'cause' | 'traces' | 'attempts' | 'requested_at' | 'last_requested_at'
> & { confirmed_at: Date | null };

function toRow(row: {
  [K in keyof Selected]: unknown;
}): LangfusePurgeRow {
  return {
    intentId: row.intent_id as string,
    cause: row.cause as LangfusePurgeCause,
    traces: Number(row.traces),
    attempts: Number(row.attempts),
    requestedAt: toDate(row.requested_at),
    lastRequestedAt: toDate(row.last_requested_at),
    confirmedAt: row.confirmed_at === null ? null : toDate(row.confirmed_at),
  };
}

export class LangfusePurgeRepository extends TenantRepository {
  /**
   * Finished intents of the project, ended at or before `cutoff`, without an active hold and
   * without a confirmed Langfuse purge, except `excludeIds` (intents the loop set aside for a
   * while). Never requested first, then the oldest request, then the oldest end: a few intents
   * that never confirm cannot starve the others (review of E08).
   */
  async candidates(selection: {
    readonly projectId: string;
    readonly cutoff: Date;
    readonly limit: number;
    readonly excludeIds?: readonly string[];
  }): Promise<LangfuseCandidate[]> {
    if (!isUuid(selection.projectId)) return [];
    const exclude = (selection.excludeIds ?? []).filter(isUuid);
    const rows = await this.run(
      this.unconfirmed(selection.projectId)
        .select(['i.id', 'i.code', 'i.status', 'i.updated_at', 'p.attempts'])
        .where('i.updated_at', '<=', selection.cutoff)
        .$if(exclude.length > 0, (qb) => qb.where('i.id', 'not in', exclude))
        .orderBy(sql`p.last_requested_at ASC NULLS FIRST`)
        .orderBy('i.updated_at')
        .orderBy('i.id')
        .limit(selection.limit)
        .execute(),
    );
    return rows.map((row) => ({
      intentId: row.id,
      intentCode: row.code,
      intentStatus: row.status,
      intentUpdatedAt: toDate(row.updated_at),
      attempts: row.attempts === null ? 0 : Number(row.attempts),
    }));
  }

  /** How many intents `candidates` would select without its limit: the base of the guard. */
  async countCandidates(selection: {
    readonly projectId: string;
    readonly cutoff: Date;
  }): Promise<number> {
    if (!isUuid(selection.projectId)) return 0;
    const row = await this.run(
      this.unconfirmed(selection.projectId)
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('i.updated_at', '<=', selection.cutoff)
        .executeTakeFirstOrThrow(),
    );
    return Number(row.n);
  }

  /** Finished intents of the tenant: the other base of the guard. */
  async finishedCount(): Promise<number> {
    const row = await this.run(
      this.db
        .selectFrom('intents')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('tenant_id', '=', this.tenantId)
        .where('status', 'in', [...FINISHED_FOR_RETENTION])
        .executeTakeFirstOrThrow(),
    );
    return Number(row.n);
  }

  /**
   * Finished, not held intents of the project whose Langfuse purge is not confirmed: an archived
   * project's `project.purged` waits until this is 0.
   */
  async unconfirmedCount(projectId: string): Promise<number> {
    if (!isUuid(projectId)) return 0;
    const row = await this.run(
      this.unconfirmed(projectId)
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .executeTakeFirstOrThrow(),
    );
    return Number(row.n);
  }

  /** Finished, not held intents of the project without a confirmed Langfuse purge. */
  private unconfirmed(projectId: string) {
    return this.db
      .selectFrom('intents as i')
      .leftJoin('langfuse_purges as p', (join) =>
        join.onRef('p.intent_id', '=', 'i.id').on('p.tenant_id', '=', this.tenantId),
      )
      .where('i.tenant_id', '=', this.tenantId)
      .where('i.project_id', '=', projectId)
      .where('i.status', 'in', [...FINISHED_FOR_RETENTION])
      .where('p.confirmed_at', 'is', null)
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('evidence_holds as h')
              .select('h.id')
              .where('h.tenant_id', '=', this.tenantId)
              .whereRef('h.intent_id', '=', 'i.id')
              .where('h.released_at', 'is', null),
          ),
        ),
      );
  }

  /** The intent's purge row, or undefined. */
  async get(intentId: string): Promise<LangfusePurgeRow | undefined> {
    if (!isUuid(intentId)) return undefined;
    const row = await this.run(
      this.db
        .selectFrom('langfuse_purges')
        .select([
          'intent_id',
          'cause',
          'traces',
          'attempts',
          'requested_at',
          'last_requested_at',
          'confirmed_at',
        ])
        .where('tenant_id', '=', this.tenantId)
        .where('intent_id', '=', intentId)
        .executeTakeFirst(),
    );
    return row ? toRow(row) : undefined;
  }

  /**
   * Records a delete request: a new row, or one more attempt of an unconfirmed row. Returns the
   * attempt number. Fails on a confirmed row (it never changes again).
   */
  async recordRequest(input: {
    readonly intentId: string;
    readonly cause: LangfusePurgeCause;
    readonly traces: number;
    readonly at: Date;
  }): Promise<number> {
    const current = await this.get(input.intentId);
    if (current?.confirmedAt) {
      throw new DbError('immutable', 'the Langfuse purge of this intent is confirmed');
    }
    if (!current) {
      await this.run(
        this.db
          .insertInto('langfuse_purges')
          .values({
            tenant_id: this.tenantId,
            intent_id: input.intentId,
            cause: input.cause,
            traces: input.traces,
            requested_at: input.at,
            last_requested_at: input.at,
          })
          .execute(),
      );
      return 1;
    }
    const attempts = current.attempts + 1;
    await this.run(
      this.db
        .updateTable('langfuse_purges')
        .set({
          traces: input.traces,
          attempts,
          last_requested_at:
            input.at > current.lastRequestedAt ? input.at : current.lastRequestedAt,
        })
        .where('tenant_id', '=', this.tenantId)
        .where('intent_id', '=', input.intentId)
        .where('confirmed_at', 'is', null)
        .execute(),
    );
    return attempts;
  }

  /**
   * Confirms the purge: the intent's traces are no longer found. Without a request (an intent
   * without traces) the row is written confirmed at once. Returns false when it was confirmed
   * already.
   */
  async confirm(input: {
    readonly intentId: string;
    readonly cause: LangfusePurgeCause;
    readonly at: Date;
  }): Promise<boolean> {
    const current = await this.get(input.intentId);
    if (current?.confirmedAt) return false;
    if (!current) {
      await this.run(
        this.db
          .insertInto('langfuse_purges')
          .values({
            tenant_id: this.tenantId,
            intent_id: input.intentId,
            cause: input.cause,
            traces: 0,
            requested_at: input.at,
            last_requested_at: input.at,
            confirmed_at: input.at,
          })
          .execute(),
      );
      return true;
    }
    const result = await this.run(
      this.db
        .updateTable('langfuse_purges')
        .set({
          confirmed_at: sql<Date>`greatest(${input.at}::timestamptz, requested_at)`,
        })
        .where('tenant_id', '=', this.tenantId)
        .where('intent_id', '=', input.intentId)
        .where('confirmed_at', 'is', null)
        .executeTakeFirst(),
    );
    return Number(result.numUpdatedRows) === 1;
  }
}
