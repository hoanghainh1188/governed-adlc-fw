// Evidence retention (task E05, design/ADR-M51; D-05 §6.6 and §10.1, version 1.33; D-02 FR-44).
// The rows the worker's retention loop works on: evidence items (proposals, diffs) and Evidence
// Pack versions whose files are still in the evidence store. Always for one tenant, with
// `tenant_id = <tenant>` on every table occurrence (D-05 D2, the tenant guard).
//
// - An intent's evidence is kept from the intent's end: `intents.updated_at` of a finished intent
//   (`done`, `rejected`, `cancelled`, `blocked`), the time of its final move. A finished intent
//   never moves again; if its `updated_at` ever moved, the purge would only come later.
// - Open intents and intents with an active hold are never selected for the purge.
// - The selection here is the first filter; `retention/rules.ts` decides again for every row, and
//   the purge decides a third time under the intent lock before it deletes anything.
import type { EvidenceKind } from '@sdlc/contracts';
import { sql, type ExpressionBuilder } from 'kysely';

import { DbError } from '../errors.js';
import type { Database, EvidencePack } from '../schema.js';
import { isUuid } from '../tenant-id.js';
import { TenantRepository } from './base.js';

/** Intent statuses that never change again: the retention clock starts there. */
export const FINISHED_FOR_RETENTION = ['done', 'rejected', 'cancelled', 'blocked'] as const;

export type RetentionRowKind = 'item' | 'pack';

/** One evidence item or one pack version, with the facts the retention rules need. */
export interface RetentionRow {
  readonly kind: RetentionRowKind;
  readonly id: string;
  readonly intentId: string;
  readonly intentStatus: string;
  /** The intent's `updated_at`: its end when it is finished. */
  readonly intentUpdatedAt: Date;
  readonly createdAt: Date;
  readonly lockExtendedUntil: Date | null;
  /** The files: one for an item, the manifest and the Markdown for a pack. */
  readonly uris: readonly string[];
  /** The item's kind, or `pack`. */
  readonly evidenceKind: EvidenceKind | 'pack';
  /** The item's SHA-256, or the pack's manifest SHA-256. */
  readonly sha256: string;
  /** The pack's Markdown SHA-256. */
  readonly markdownSha256: string | null;
  readonly packVersion: number | null;
}

export interface PurgeSelection {
  readonly projectId: string;
  /** Rows created at or before this time, of intents that ended at or before it. */
  readonly cutoff: Date;
  readonly limit: number;
}

export interface LockSelection {
  readonly projectId: string;
  readonly now: Date;
  /** The bucket's default lock (days). */
  readonly bucketLockDays: number;
  /** Rows whose lock ends within this many days are selected. */
  readonly marginDays: number;
  /** The project's retention: rows already past it (finished intents) are left out. */
  readonly retentionDays: number;
  readonly limit: number;
}

const DAY_MS = 86_400_000;
const days = (from: Date, count: number) => new Date(from.getTime() + count * DAY_MS);

type ItemDb = Database & { e: Database['evidence_items']; i: Database['intents'] };
type PackDb = Database & { e: Database['evidence_packs']; i: Database['intents'] };

function toDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') return new Date(value);
  throw new TypeError('retention: unexpected time value');
}

export class RetentionRepository extends TenantRepository {
  /** Projects of the tenant, any status: archived projects are purged too (FR-44). */
  listProjects(): Promise<{ id: string; slug: string; status: string }[]> {
    return this.run(
      this.db
        .selectFrom('projects')
        .select(['id', 'slug', 'status'])
        .where('tenant_id', '=', this.tenantId)
        .orderBy('id')
        .execute(),
    );
  }

  /**
   * Rows of finished, not held intents of the project, not purged, created at or before
   * `cutoff`, of intents that ended at or before it. Oldest first.
   */
  async purgeCandidates(selection: PurgeSelection): Promise<RetentionRow[]> {
    if (!isUuid(selection.projectId)) return [];
    const items = await this.run(
      this.itemBase()
        .where('i.project_id', '=', selection.projectId)
        .where('i.status', 'in', [...FINISHED_FOR_RETENTION])
        .where('e.created_at', '<=', selection.cutoff)
        .where('i.updated_at', '<=', selection.cutoff)
        .where((eb) => eb.not(this.held(eb as never, 'e')))
        .orderBy('e.created_at')
        .orderBy('e.id')
        .limit(selection.limit)
        .execute(),
    );
    const packs = await this.run(
      this.packBase()
        .where('i.project_id', '=', selection.projectId)
        .where('i.status', 'in', [...FINISHED_FOR_RETENTION])
        .where('e.created_at', '<=', selection.cutoff)
        .where('i.updated_at', '<=', selection.cutoff)
        .where((eb) => eb.not(this.held(eb as never, 'e')))
        .orderBy('e.created_at')
        .orderBy('e.id')
        .limit(selection.limit)
        .execute(),
    );
    return merge(items.map(itemRow), packs.map(packRow), selection.limit);
  }

  /** How many rows `purgeCandidates` would select without its limit: the base of the guard. */
  async countPurgeCandidates(selection: Omit<PurgeSelection, 'limit'>): Promise<number> {
    if (!isUuid(selection.projectId)) return 0;
    const count = async (table: 'items' | 'packs') => {
      const base = table === 'items' ? this.itemBase() : this.packBase();
      const row = await this.run(
        base
          .clearSelect()
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .where('i.project_id', '=', selection.projectId)
          .where('i.status', 'in', [...FINISHED_FOR_RETENTION])
          .where('e.created_at', '<=', selection.cutoff)
          .where('i.updated_at', '<=', selection.cutoff)
          .where((eb) => eb.not(this.held(eb as never, 'e')))
          .executeTakeFirstOrThrow(),
      );
      return Number(row.n);
    };
    return (await count('items')) + (await count('packs'));
  }

  /**
   * Rows of the project whose object lock ends within the margin (the bucket's default lock from
   * their creation, or how far the loop moved it), not purged. Rows of finished intents already
   * past the project's retention are left out: their lock is not moved again.
   */
  async lockCandidates(selection: LockSelection): Promise<RetentionRow[]> {
    if (!isUuid(selection.projectId)) return [];
    const horizon = days(selection.now, selection.marginDays);
    const createdBefore = days(horizon, -selection.bucketLockDays);
    const pastRetention = days(selection.now, -selection.retentionDays);
    const due = (eb: ExpressionBuilder<ItemDb | PackDb, 'e' | 'i'>) =>
      eb.and([
        eb.or([
          eb.and([
            eb('e.lock_extended_until', 'is', null),
            eb('e.created_at', '<=', createdBefore),
          ]),
          eb('e.lock_extended_until', '<=', horizon),
        ]),
        eb.not(
          eb.and([
            eb('i.status', 'in', [...FINISHED_FOR_RETENTION]),
            eb('i.updated_at', '<=', pastRetention),
            eb('e.created_at', '<=', pastRetention),
          ]),
        ),
      ]);
    const items = await this.run(
      this.itemBase()
        .where('i.project_id', '=', selection.projectId)
        .where((eb) => due(eb as never))
        .orderBy('e.created_at')
        .orderBy('e.id')
        .limit(selection.limit)
        .execute(),
    );
    const packs = await this.run(
      this.packBase()
        .where('i.project_id', '=', selection.projectId)
        .where((eb) => due(eb as never))
        .orderBy('e.created_at')
        .orderBy('e.id')
        .limit(selection.limit)
        .execute(),
    );
    return merge(items.map(itemRow), packs.map(packRow), selection.limit);
  }

  /** Rows of one intent, not purged, created after `since` (all when null). For the legal hold. */
  async filesOfIntent(intentId: string, since: Date | null): Promise<RetentionRow[]> {
    if (!isUuid(intentId)) return [];
    const items = await this.run(
      this.itemBase()
        .where('e.intent_id', '=', intentId)
        .$if(since !== null, (qb) => qb.where('e.created_at', '>', since!))
        .orderBy('e.created_at')
        .orderBy('e.id')
        .execute(),
    );
    const packs = await this.run(
      this.packBase()
        .where('e.intent_id', '=', intentId)
        .$if(since !== null, (qb) => qb.where('e.created_at', '>', since!))
        .orderBy('e.created_at')
        .orderBy('e.id')
        .execute(),
    );
    return merge(items.map(itemRow), packs.map(packRow), Number.MAX_SAFE_INTEGER);
  }

  /** Rows of the tenant whose files are still stored: the base of the purge guard. */
  async liveCount(): Promise<number> {
    const [items, packs] = await Promise.all([
      this.run(
        this.db
          .selectFrom('evidence_items')
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .where('tenant_id', '=', this.tenantId)
          .where('purged_at', 'is', null)
          .executeTakeFirstOrThrow(),
      ),
      this.run(
        this.db
          .selectFrom('evidence_packs')
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .where('tenant_id', '=', this.tenantId)
          .where('purged_at', 'is', null)
          .executeTakeFirstOrThrow(),
      ),
    ]);
    return Number(items.n) + Number(packs.n);
  }

  /**
   * Counts of a project's rows (for `project.purged` and the operator report): `purged`,
   * `held` (not purged, intent held), `open` (not purged, intent open), `remaining` (not purged,
   * intent finished and not held).
   */
  async projectCounts(
    projectId: string,
  ): Promise<{ purged: number; held: number; open: number; remaining: number; intents: number }> {
    if (!isUuid(projectId)) return { purged: 0, held: 0, open: 0, remaining: 0, intents: 0 };
    const finished = [...FINISHED_FOR_RETENTION] as string[];
    const items = await this.run(
      this.db
        .selectFrom('evidence_items as e')
        .innerJoin('intents as i', (join) =>
          join.onRef('i.id', '=', 'e.intent_id').on('i.tenant_id', '=', this.tenantId),
        )
        .select((eb) => ['e.purged_at', 'i.status', this.held(eb as never, 'e').as('held')])
        .where('e.tenant_id', '=', this.tenantId)
        .where('i.project_id', '=', projectId)
        .execute(),
    );
    const packs = await this.run(
      this.db
        .selectFrom('evidence_packs as e')
        .innerJoin('intents as i', (join) =>
          join.onRef('i.id', '=', 'e.intent_id').on('i.tenant_id', '=', this.tenantId),
        )
        .select((eb) => ['e.purged_at', 'i.status', this.held(eb as never, 'e').as('held')])
        .where('e.tenant_id', '=', this.tenantId)
        .where('i.project_id', '=', projectId)
        .execute(),
    );
    const rows = [...items, ...packs] as {
      purged_at: Date | null;
      status: string;
      held: boolean;
    }[];
    const counts = { purged: 0, held: 0, open: 0, remaining: 0 };
    for (const row of rows) {
      if (row.purged_at !== null) counts.purged += 1;
      else if (row.held) counts.held += 1;
      else if (!finished.includes(row.status)) counts.open += 1;
      else counts.remaining += 1;
    }
    const intents = await this.run(
      this.db
        .selectFrom('intents')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('tenant_id', '=', this.tenantId)
        .where('project_id', '=', projectId)
        .executeTakeFirstOrThrow(),
    );
    return { ...counts, intents: Number(intents.n) };
  }

  /**
   * Finished, not-held, not-purged evidence of the project (any age): the client-data purge
   * (H03b) deletes these with the GOVERNANCE bypass. Open and held intents stay out.
   */
  async clientPurgeCandidates(projectId: string, limit: number): Promise<RetentionRow[]> {
    if (!isUuid(projectId) || limit <= 0) return [];
    const items = await this.run(
      this.itemBase()
        .where('i.project_id', '=', projectId)
        .where('i.status', 'in', [...FINISHED_FOR_RETENTION])
        .where((eb) => eb.not(this.held(eb as never, 'e')))
        .orderBy('e.created_at')
        .orderBy('e.id')
        .limit(limit)
        .execute(),
    );
    const packs = await this.run(
      this.packBase()
        .where('i.project_id', '=', projectId)
        .where('i.status', 'in', [...FINISHED_FOR_RETENTION])
        .where((eb) => eb.not(this.held(eb as never, 'e')))
        .orderBy('e.created_at')
        .orderBy('e.id')
        .limit(limit)
        .execute(),
    );
    return merge(items.map(itemRow), packs.map(packRow), limit);
  }

  /**
   * How many finished, not-held evidence rows of the tenant are still stored: the client purge
   * may finish only when this is 0 (held and open rows may remain and block completion).
   */
  async clientPurgeableRemaining(): Promise<number> {
    const count = async (table: 'items' | 'packs') => {
      const base = table === 'items' ? this.itemBase() : this.packBase();
      const row = await this.run(
        base
          .clearSelect()
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .where('i.status', 'in', [...FINISHED_FOR_RETENTION])
          .where((eb) => eb.not(this.held(eb as never, 'e')))
          .executeTakeFirstOrThrow(),
      );
      return Number(row.n);
    };
    return (await count('items')) + (await count('packs'));
  }

  /** Open intents and active holds that block completing a client purge (H03b AC2). */
  async clientPurgeBlockers(): Promise<{ openIntents: number; activeHolds: number }> {
    const open = await this.run(
      this.db
        .selectFrom('intents')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('tenant_id', '=', this.tenantId)
        .where('status', 'not in', [...FINISHED_FOR_RETENTION])
        .executeTakeFirstOrThrow(),
    );
    const holds = await this.run(
      this.db
        .selectFrom('evidence_holds')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('tenant_id', '=', this.tenantId)
        .where('released_at', 'is', null)
        .executeTakeFirstOrThrow(),
    );
    return { openIntents: Number(open.n), activeHolds: Number(holds.n) };
  }

  /** How many audit_log rows this tenant holds (retained after a client purge). */
  async auditRowCount(): Promise<number> {
    const row = await this.run(
      this.db
        .selectFrom('audit_log')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('tenant_id', '=', this.tenantId)
        .executeTakeFirstOrThrow(),
    );
    return Number(row.n);
  }

  /**
   * Inside a transaction, after the intent lock: the row again, locked, when its files are still
   * stored. The purge decides on this, never on the selection.
   */
  async lockRow(kind: RetentionRowKind, id: string): Promise<RetentionRow | undefined> {
    if (!isUuid(id)) return undefined;
    if (!this.db.isTransaction) {
      throw new DbError('invalid_value', 'lockRow must run inside a transaction');
    }
    if (kind === 'item') {
      const row = await this.run(
        this.itemBase().where('e.id', '=', id).forUpdate('e').executeTakeFirst(),
      );
      return row ? itemRow(row) : undefined;
    }
    const row = await this.run(
      this.packBase().where('e.id', '=', id).forUpdate('e').executeTakeFirst(),
    );
    return row ? packRow(row) : undefined;
  }

  /** Whether the intent has an active hold. */
  async isHeld(intentId: string): Promise<boolean> {
    if (!isUuid(intentId)) return false;
    const row = await this.run(
      this.db
        .selectFrom('evidence_holds')
        .select('id')
        .where('tenant_id', '=', this.tenantId)
        .where('intent_id', '=', intentId)
        .where('released_at', 'is', null)
        .executeTakeFirst(),
    );
    return row !== undefined;
  }

  /** Marks the row purged (once). Returns false when it was purged already. */
  async markPurged(kind: RetentionRowKind, id: string): Promise<boolean> {
    const table = kind === 'item' ? 'evidence_items' : 'evidence_packs';
    const result = await this.run(
      this.db
        .updateTable(table)
        .set({ purged_at: sql<Date>`now()` })
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', id)
        .where('purged_at', 'is', null)
        .executeTakeFirst(),
    );
    return Number(result.numUpdatedRows) === 1;
  }

  /** Records how far the files' lock was moved (only forward). */
  async markLockExtended(kind: RetentionRowKind, id: string, until: Date): Promise<void> {
    const table = kind === 'item' ? 'evidence_items' : 'evidence_packs';
    await this.run(
      this.db
        .updateTable(table)
        .set({ lock_extended_until: until })
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', id)
        .where((eb) =>
          eb.or([eb('lock_extended_until', 'is', null), eb('lock_extended_until', '<', until)]),
        )
        .execute(),
    );
  }

  private itemBase() {
    return this.db
      .selectFrom('evidence_items as e')
      .innerJoin('intents as i', (join) =>
        join.onRef('i.id', '=', 'e.intent_id').on('i.tenant_id', '=', this.tenantId),
      )
      .select([
        'e.id',
        'e.intent_id',
        'e.kind',
        'e.storage_uri',
        'e.sha256',
        'e.created_at',
        'e.lock_extended_until',
        'i.status as intent_status',
        'i.updated_at as intent_updated_at',
      ])
      .where('e.tenant_id', '=', this.tenantId)
      .where('e.purged_at', 'is', null);
  }

  private packBase() {
    return this.db
      .selectFrom('evidence_packs as e')
      .innerJoin('intents as i', (join) =>
        join.onRef('i.id', '=', 'e.intent_id').on('i.tenant_id', '=', this.tenantId),
      )
      .select([
        'e.id',
        'e.intent_id',
        'e.version',
        'e.manifest_uri',
        'e.manifest_sha256',
        'e.markdown_uri',
        'e.markdown_sha256',
        'e.created_at',
        'e.lock_extended_until',
        'i.status as intent_status',
        'i.updated_at as intent_updated_at',
      ])
      .where('e.tenant_id', '=', this.tenantId)
      .where('e.purged_at', 'is', null);
  }

  /** `EXISTS` an active hold on the row's intent. */
  private held(eb: ExpressionBuilder<ItemDb, 'e'>, alias: 'e') {
    return eb.exists(
      eb
        .selectFrom('evidence_holds as h')
        .select('h.id')
        .where('h.tenant_id', '=', this.tenantId)
        .whereRef('h.intent_id', '=', `${alias}.intent_id`)
        .where('h.released_at', 'is', null),
    );
  }
}

type ItemSelect = Awaited<
  ReturnType<ReturnType<RetentionRepository['itemBase']>['executeTakeFirstOrThrow']>
>;
type PackSelect = Awaited<
  ReturnType<ReturnType<RetentionRepository['packBase']>['executeTakeFirstOrThrow']>
>;

function itemRow(row: ItemSelect): RetentionRow {
  return {
    kind: 'item',
    id: row.id,
    intentId: row.intent_id,
    intentStatus: row.intent_status,
    intentUpdatedAt: toDate(row.intent_updated_at),
    createdAt: toDate(row.created_at),
    lockExtendedUntil: row.lock_extended_until ? toDate(row.lock_extended_until) : null,
    uris: [row.storage_uri],
    evidenceKind: row.kind,
    sha256: row.sha256,
    markdownSha256: null,
    packVersion: null,
  };
}

function packRow(row: PackSelect): RetentionRow {
  return {
    kind: 'pack',
    id: row.id,
    intentId: row.intent_id,
    intentStatus: row.intent_status,
    intentUpdatedAt: toDate(row.intent_updated_at),
    createdAt: toDate(row.created_at),
    lockExtendedUntil: row.lock_extended_until ? toDate(row.lock_extended_until) : null,
    uris: [row.manifest_uri, row.markdown_uri],
    evidenceKind: 'pack',
    sha256: row.manifest_sha256,
    markdownSha256: row.markdown_sha256,
    packVersion: (row as Pick<EvidencePack, 'version'>).version,
  };
}

/** Both lists, oldest first, at most `limit`. */
function merge(a: RetentionRow[], b: RetentionRow[], limit: number): RetentionRow[] {
  return [...a, ...b]
    .sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime() || x.id.localeCompare(y.id))
    .slice(0, limit);
}
