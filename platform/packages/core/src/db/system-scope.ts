// Operations that cannot be bound to one tenant (design/ADR-M09 section 2.4).
// Keep this list short and explicit. Each method must say why it needs to cross tenants.
import { sql, type Kysely } from 'kysely';

import { translatePgError } from './errors.js';
import { assertTokenHash } from './repositories/api-tokens.js';
import type { WebSessionEndReason } from './schema.js';
import type { Database, Tenant } from './schema.js';
import type { TenantStatus } from './vocabulary.js';
import { isUuid, parseTenantId, type TenantId } from './tenant-id.js';
import { setTenantQuery } from './tenant-driver.js';
import { TenantScope } from './tenant-scope.js';

export interface NewTenant {
  readonly slug: string;
  readonly name: string;
  readonly monthlyBudgetUsd?: string | null;
}

/** Tenant statuses that may still authenticate (H03c: cancel during the grace period). */
export type AuthTenantStatus = Extract<TenantStatus, 'active' | 'pending_deletion'>;

export interface ResolvedApiToken {
  readonly tenantId: TenantId;
  readonly userId: string;
  readonly tokenId: string;
  /** `pending_deletion`: the API allows only the client data-deletion routes (H03c). */
  readonly tenantStatus: AuthTenantStatus;
}

/** A dashboard session found by its secret's hash (U05, ADR-M73 §2.2): IDs and times only. */
export interface ResolvedWebSession {
  readonly tenantId: TenantId;
  readonly userId: string;
  readonly sessionId: string;
  readonly lastSeenAt: Date;
  /** When the person signed in with GitHub (U06: a passkey is registered within 5 minutes). */
  readonly createdAt: Date;
  /** SHA-256 of the session's CSRF token (U06); null for a session made before U06. */
  readonly csrfSha256: string | null;
  /** `pending_deletion`: the API allows only the client data-deletion routes (H03c). */
  readonly tenantStatus: AuthTenantStatus;
}

/** An escalation whose clock is due (task B11): IDs only. */
export interface DueEscalation {
  readonly tenantId: TenantId;
  readonly escalationId: string;
}

/**
 * Work of the memory loop (task X13 PR 3b, ADR-M74 §2.5): a run whose pushed memory branch has no
 * proposal row yet, or a proposal still `pushed` or `opened`. IDs only.
 */
export type MemoryWork =
  | { readonly tenantId: TenantId; readonly kind: 'run'; readonly runId: string }
  | { readonly tenantId: TenantId; readonly kind: 'proposal'; readonly proposalId: string };

/** An open intent whose workflow the worker wakes (task B07): IDs only. */
export interface OpenIntent {
  readonly tenantId: TenantId;
  readonly intentId: string;
}

/** A project the GitHub poller reads (task B06): IDs and the repository name only. */
export interface PollableProject {
  readonly tenantId: TenantId;
  readonly projectId: string;
  /** `owner/name` on the Git host. */
  readonly repoFullName: string;
}

/** The result of `withSpendSyncLock`: `ran: false` when another process holds the lock. */
export type SpendSyncLockResult<T> =
  { readonly ran: true; readonly value: T } | { readonly ran: false };

/** Two-key session advisory lock of the retention loop (task E05, ADR-M51). */
const RETENTION_LOCK_CLASS = 0x45_56_52_01;
const RETENTION_LOCK_KEY = 1;

/** Two-key session advisory lock of the scheduled spend sync (task C12, ADR-M24 §2.5). */
const SPEND_SYNC_LOCK_CLASS = 0x43_4f_53_01;
const SPEND_SYNC_LOCK_KEY = 1;

/** The query builder bound to one tenant's transactions (task H09, ADR-M110 §2.2). */
export type TenantDbFactory = (tenantId: TenantId) => Kysely<Database>;

/**
 * Cross-tenant work (QUESTIONS #733, ADR-M110 §2.3): every read of tenant data loops over the
 * tenants and runs in the tenant's own transaction (`tenantDb`), as `forTenant()` does. Only the
 * `tenants` table and the two authentication lookups (migration 0059) are read without a tenant.
 */
export class SystemScope {
  /** @internal Use `PlatformDatabase.system`. */
  constructor(
    private readonly db: Kysely<Database>,
    private readonly tenantDb: TenantDbFactory,
  ) {}

  /** Tenant IDs ordered by ID: the active tenants, or every tenant. */
  private async tenantIds(which: 'active' | 'all'): Promise<TenantId[]> {
    const rows = await run(
      this.db
        .selectFrom('tenants')
        .select('id')
        .$if(which === 'active', (qb) => qb.where('status', '=', 'active'))
        .orderBy('id')
        .execute(),
    );
    return rows.map((row) => parseTenantId(row.id));
  }

  /** At most `limit` active tenants, ordered by ID, for which `probe` finds a row. */
  private async tenantsWhere(
    limit: number,
    probe: (tenantId: TenantId) => Promise<unknown>,
  ): Promise<TenantId[]> {
    const found: TenantId[] = [];
    for (const tenantId of await this.tenantIds('active')) {
      if (found.length >= limit) break;
      if ((await run(probe(tenantId))) !== undefined) found.push(tenantId);
    }
    return found;
  }

  /** Platform admin: creates a tenant. Tenants are the root of isolation, so no tenant scope applies. */
  createTenant(input: NewTenant): Promise<Tenant> {
    return run(
      this.db
        .insertInto('tenants')
        .values({
          slug: input.slug,
          name: input.name,
          monthly_budget_usd: input.monthlyBudgetUsd ?? null,
        })
        .returningAll()
        .executeTakeFirstOrThrow(),
    );
  }

  /**
   * One-time bootstrap (task B03, ADR-M26): creates a tenant and runs `work` with a scope bound to
   * it, in the same transaction. The tenant row, its first user, token and audit events commit or
   * roll back together. Fails with `DbError('conflict')` when the slug is taken.
   */
  createTenantWith<T>(
    input: NewTenant,
    work: (scope: TenantScope, tenant: Tenant) => Promise<T>,
  ): Promise<T> {
    return run(
      this.db.transaction().execute(async (trx) => {
        const tenant = await trx
          .insertInto('tenants')
          .values({
            slug: input.slug,
            name: input.name,
            monthly_budget_usd: input.monthlyBudgetUsd ?? null,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        const tenantId = parseTenantId(tenant.id);
        // The rest of the transaction belongs to the new tenant (H09, ADR-M110 §2.2).
        await trx.executeQuery(setTenantQuery(tenantId));
        return work(new TenantScope(trx, tenantId), tenant);
      }),
    );
  }

  /** Platform admin and CLI: finds a tenant by its slug before a tenant scope exists. */
  getTenantBySlug(slug: string): Promise<Tenant | undefined> {
    return run(
      this.db.selectFrom('tenants').selectAll().where('slug', '=', slug).executeTakeFirst(),
    );
  }

  /** Operator commands (`adlc audit verify`): every tenant, ordered by slug. */
  listTenants(): Promise<Tenant[]> {
    return run(this.db.selectFrom('tenants').selectAll().orderBy('slug').execute());
  }

  /**
   * Client data deletion (H03b/H03c, ADR-M97): moves a tenant to `pending_deletion` or `purged`,
   * or restores `active` when a deletion is cancelled during the grace period. Tenant scopes
   * cannot UPDATE `tenants` (tenant guard); only the system scope may.
   */
  setTenantStatus(
    tenantId: TenantId,
    status: Extract<TenantStatus, 'active' | 'pending_deletion' | 'purged'>,
  ): Promise<Tenant | undefined> {
    return run(
      this.db
        .updateTable('tenants')
        .set({ status })
        .where('id', '=', parseTenantId(tenantId))
        .returningAll()
        .executeTakeFirst(),
    );
  }

  getTenant(tenantId: TenantId): Promise<Tenant | undefined> {
    return run(
      this.db
        .selectFrom('tenants')
        .selectAll()
        .where('id', '=', parseTenantId(tenantId))
        .executeTakeFirst(),
    );
  }

  /**
   * GitHub poller (task B06, ADR-M27): the poller runs for every tenant, and it only learns a
   * project's tenant from this list. Returns the IDs and the repository name of the active GitHub
   * projects of active tenants, nothing else. All further work runs in `forTenant(tenantId)`.
   */
  async listPollableProjects(): Promise<PollableProject[]> {
    const found: PollableProject[] = [];
    for (const tenantId of await this.tenantIds('active')) {
      const rows = await run(
        this.tenantDb(tenantId)
          .selectFrom('projects as p')
          .select(['p.id', 'p.repo_full_name'])
          .where('p.tenant_id', '=', tenantId)
          .where('p.git_provider', '=', 'github')
          .where('p.status', '=', 'active')
          .orderBy('p.id')
          .execute(),
      );
      for (const row of rows) {
        found.push({ tenantId, projectId: row.id, repoFullName: row.repo_full_name });
      }
    }
    return found;
  }

  /**
   * Escalation clock (task B11, ADR-M28 §2.2): the worker loop advances the clocks of every
   * tenant and only learns an escalation's tenant from this list. Returns the IDs of escalations
   * with a clock due at `now`, earliest first, of active tenants. All further work runs in
   * `forTenant(tenantId)`, which locks the row.
   */
  async listDueEscalations(now: Date, limit: number): Promise<DueEscalation[]> {
    const due: { readonly item: DueEscalation; readonly at: number }[] = [];
    for (const tenantId of await this.tenantIds('active')) {
      const rows = await run(
        this.tenantDb(tenantId)
          .selectFrom('escalations as e')
          .select(['e.id', 'e.next_check_at'])
          .where('e.tenant_id', '=', tenantId)
          .where('e.next_check_at', 'is not', null)
          .where('e.next_check_at', '<=', now)
          .orderBy('e.next_check_at')
          .orderBy('e.id')
          .limit(limit)
          .execute(),
      );
      for (const row of rows) {
        due.push({
          item: { tenantId, escalationId: row.id },
          at: new Date(row.next_check_at!).getTime(),
        });
      }
    }
    return due
      .sort((a, b) => a.at - b.at || compareText(a.item.escalationId, b.item.escalationId))
      .slice(0, limit)
      .map((entry) => entry.item);
  }

  /**
   * The memory loop's work (X13 PR 3b, ADR-M74 §2.5), of active tenants: first runs that pushed a
   * memory branch (`memory_branch_pushed`) and have no proposal row, then proposals still
   * `pushed` or `opened`, least recently looked at first. Crosses tenants, so IDs only.
   */
  async listMemoryWork(limit: number): Promise<MemoryWork[]> {
    const runs: { readonly item: MemoryWork; readonly at: number }[] = [];
    const proposals: { readonly item: MemoryWork; readonly at: number; readonly id: string }[] = [];
    for (const tenantId of await this.tenantIds('active')) {
      const db = this.tenantDb(tenantId);
      const runRows = await run(
        db
          .selectFrom('run_events as re')
          .select(['re.run_id', 're.created_at'])
          .where('re.tenant_id', '=', tenantId)
          .where('re.event_type', '=', 'memory_branch_pushed')
          .where((eb) =>
            eb.not(
              eb.exists(
                eb
                  .selectFrom('memory_proposals as mp')
                  .select('mp.id')
                  .where('mp.tenant_id', '=', tenantId)
                  .whereRef('mp.run_id', '=', 're.run_id'),
              ),
            ),
          )
          .orderBy('re.created_at')
          .limit(limit)
          .execute(),
      );
      for (const row of runRows) {
        runs.push({
          item: { tenantId, kind: 'run', runId: row.run_id },
          at: new Date(row.created_at).getTime(),
        });
      }
      const proposalRows = await run(
        db
          .selectFrom('memory_proposals as mp')
          .select(['mp.id', 'mp.updated_at'])
          .where('mp.tenant_id', '=', tenantId)
          .where('mp.state', 'in', ['pushed', 'opened'])
          .orderBy('mp.updated_at')
          .orderBy('mp.id')
          .limit(limit)
          .execute(),
      );
      for (const row of proposalRows) {
        proposals.push({
          item: { tenantId, kind: 'proposal', proposalId: row.id },
          at: new Date(row.updated_at).getTime(),
          id: row.id,
        });
      }
    }
    return [
      ...runs
        .sort((a, b) => a.at - b.at)
        .slice(0, limit)
        .map((entry) => entry.item),
      ...proposals
        .sort((a, b) => a.at - b.at || compareText(a.id, b.id))
        .slice(0, limit)
        .map((entry) => entry.item),
    ];
  }

  /**
   * Intent workflow reconcile (task B07, ADR-M30 §2.3): the worker wakes the workflow of every
   * open intent, so a wake signal lost between a commit and the signal is caught up. Crosses
   * tenants, so it returns IDs only: open intents (not `done`, `rejected`, `cancelled`) of active
   * tenants, ordered by (`tenant_id`, `id`), after the keyset position `after`.
   */
  async listOpenIntents(
    limit: number,
    after?: { readonly tenantId: string; readonly intentId: string },
  ): Promise<OpenIntent[]> {
    const found: OpenIntent[] = [];
    for (const tenantId of await this.tenantIds('active')) {
      if (found.length >= limit) break;
      if (after !== undefined && compareText(tenantId, after.tenantId) < 0) continue;
      const afterId = after !== undefined && tenantId === after.tenantId ? after.intentId : null;
      const rows = await run(
        this.tenantDb(tenantId)
          .selectFrom('intents as i')
          .select('i.id')
          .where('i.tenant_id', '=', tenantId)
          .where('i.status', 'not in', ['done', 'rejected', 'cancelled', 'blocked'])
          .$if(afterId !== null, (qb) => qb.where('i.id', '>', afterId!))
          .orderBy('i.id')
          .limit(limit - found.length)
          .execute(),
      );
      for (const row of rows) found.push({ tenantId, intentId: row.id });
    }
    return found;
  }

  /**
   * The tenants that have an evaluation that is not final, or a run still working (task L04, ADR-M81 §2.8): what the
   * worker's evaluation loop visits. IDs only, ordered, active tenants only.
   */
  async listTenantsWithOpenEvaluations(limit: number): Promise<TenantId[]> {
    return this.tenantsWhere(limit, (tenantId) =>
      this.tenantDb(tenantId)
        .selectFrom('evaluations as e')
        .select('e.id')
        .where('e.tenant_id', '=', tenantId)
        .where((eb) =>
          eb.or([
            eb('e.status', 'in', ['queued', 'running']),
            // An ended evaluation whose run is still on a runner: the loop stops that run.
            eb.exists(
              eb
                .selectFrom('evaluation_runs as er')
                .select('er.id')
                .where('er.tenant_id', '=', tenantId)
                .whereRef('er.evaluation_id', '=', 'e.id')
                .where('er.status', '=', 'running'),
            ),
          ]),
        )
        .limit(1)
        .executeTakeFirst(),
    );
  }

  /**
   * The tenants with an evaluation task to check, or being checked (task L07, ADR-M85 §2.5): the
   * worker's check loop hands a registered task to a runner and looks for checks that ended
   * without an answer. IDs only.
   */
  async listTenantsWithTasksToCheck(limit: number): Promise<TenantId[]> {
    return this.tenantsWhere(limit, (tenantId) =>
      this.tenantDb(tenantId)
        .selectFrom('evaluation_tasks as et')
        .select('et.id')
        .where('et.tenant_id', '=', tenantId)
        .where('et.status', 'in', ['registered', 'checking'])
        .limit(1)
        .executeTakeFirst(),
    );
  }

  /**
   * The tenants with an evaluation plan the worker's plan loop must look at (task L05, ADR-M82
   * §2.4): a Run now request, a schedule that is due, an `on_change` plan, or a pause that ended.
   * IDs only, active tenants, ordered.
   */
  async listTenantsWithPlanWork(now: Date, limit: number): Promise<TenantId[]> {
    return this.tenantsWhere(limit, (tenantId) =>
      this.tenantDb(tenantId)
        .selectFrom('evaluation_plans as p')
        .innerJoin('evaluation_plan_versions as v', (join) =>
          join
            .on('v.tenant_id', '=', tenantId)
            .onRef('v.plan_id', '=', 'p.id')
            .onRef('v.version', '=', 'p.current_version'),
        )
        .select('p.id')
        .where('p.tenant_id', '=', tenantId)
        .where((eb) =>
          eb.or([
            eb.and([eb('p.status', '=', 'active'), eb('p.run_requested_at', 'is not', null)]),
            eb.and([eb('p.status', '=', 'active'), eb('p.next_run_at', '<=', now)]),
            eb.and([eb('p.status', '=', 'active'), eb('v.trigger', '=', 'on_change')]),
            eb.and([eb('p.status', '=', 'paused'), eb('p.paused_until', '<=', now)]),
          ]),
        )
        .limit(1)
        .executeTakeFirst(),
    );
  }

  /**
   * Kill signals to send again (task C11, ADR-M42 §2.2): `running` intents of active tenants whose
   * latest run of the current round (created since the intent became `running`) is being killed
   * or was killed. A kill recorded without a signal (the operator command, a lost signal) still
   * cancels a run activity that waits in Temporal. IDs only; at most `limit`.
   */
  async listKillingIntents(limit: number): Promise<OpenIntent[]> {
    const found: OpenIntent[] = [];
    for (const tenantId of await this.tenantIds('active')) {
      if (found.length >= limit) break;
      const rows = await run(
        this.tenantDb(tenantId)
          .selectFrom('intents as i')
          .innerJoin('runs as r', (join) =>
            join.on('r.tenant_id', '=', tenantId).onRef('r.intent_id', '=', 'i.id'),
          )
          .select('i.id')
          .where('i.tenant_id', '=', tenantId)
          .where('i.status', '=', 'running')
          .where('r.status', 'in', ['stopping', 'stopped_killed'])
          .whereRef('r.created_at', '>=', 'i.updated_at')
          .where((eb) =>
            eb.not(
              eb.exists(
                eb
                  .selectFrom('runs as later')
                  .select('later.id')
                  .where('later.tenant_id', '=', tenantId)
                  .whereRef('later.intent_id', '=', 'r.intent_id')
                  .whereRef('later.attempt', '>', 'r.attempt'),
              ),
            ),
          )
          .orderBy('i.id')
          .limit(limit - found.length)
          .execute(),
      );
      for (const row of rows) found.push({ tenantId, intentId: row.id });
    }
    return found;
  }

  /**
   * The scheduled spend sync (task C12, ADR-M24 §2.5): one gateway read covers every tenant, so
   * only one process may sync at a time. Takes a session advisory lock on one reserved connection
   * without waiting, runs `fn`, and releases the lock; a process that dies releases it with its
   * session. Another holder → `{ ran: false }`, `fn` is not called.
   */
  async withSpendSyncLock<T>(fn: () => Promise<T>): Promise<SpendSyncLockResult<T>> {
    return this.db.connection().execute(async (conn) => {
      const got = await run(
        sql<{
          locked: boolean;
        }>`SELECT pg_try_advisory_lock(${SPEND_SYNC_LOCK_CLASS}::int4, ${SPEND_SYNC_LOCK_KEY}::int4) AS locked`.execute(
          conn,
        ),
      );
      if (got.rows[0]?.locked !== true) return { ran: false };
      try {
        return { ran: true, value: await fn() };
      } finally {
        await run(
          sql`SELECT pg_advisory_unlock(${SPEND_SYNC_LOCK_CLASS}::int4, ${SPEND_SYNC_LOCK_KEY}::int4)`.execute(
            conn,
          ),
        );
      }
    });
  }

  /**
   * The scheduled spend sync (task C12): the earliest start of the runs, of any tenant, that ended
   * at or after `since`, so the sync covers the whole of a run that just ended, also one longer than
   * the look-back window. A time only; null when no run ended since then.
   */
  async earliestStartOfRunsEndedSince(since: Date): Promise<Date | null> {
    let earliest: Date | null = null;
    for (const tenantId of await this.tenantIds('all')) {
      const row = await run(
        this.tenantDb(tenantId)
          .selectFrom('runs')
          .select((eb) => eb.fn.min('created_at').as('earliest'))
          .where('tenant_id', '=', tenantId)
          .where('finished_at', '>=', since)
          .executeTakeFirst(),
      );
      const value = row?.earliest as Date | string | null | undefined;
      if (value == null) continue;
      const start = new Date(value);
      if (earliest === null || start < earliest) earliest = start;
    }
    return earliest;
  }

  /**
   * The retention loop (task E05, ADR-M51): one process at a time deletes evidence files. Same
   * pattern as `withSpendSyncLock`: a session advisory lock without waiting.
   */
  async withRetentionLock<T>(fn: () => Promise<T>): Promise<SpendSyncLockResult<T>> {
    return this.db.connection().execute(async (conn) => {
      const got = await run(
        sql<{
          locked: boolean;
        }>`SELECT pg_try_advisory_lock(${RETENTION_LOCK_CLASS}::int4, ${RETENTION_LOCK_KEY}::int4) AS locked`.execute(
          conn,
        ),
      );
      if (got.rows[0]?.locked !== true) return { ran: false };
      try {
        return { ran: true, value: await fn() };
      } finally {
        await run(
          sql`SELECT pg_advisory_unlock(${RETENTION_LOCK_CLASS}::int4, ${RETENTION_LOCK_KEY}::int4)`.execute(
            conn,
          ),
        );
      }
    });
  }

  /**
   * The orphan sweep of the retention loop (task E05, ADR-M48 §2.7): which of these pack IDs, read
   * from file paths in the evidence store, have a row in any tenant. IDs in, IDs out.
   */
  async existingPackIds(ids: readonly string[]): Promise<Set<string>> {
    const valid = ids.filter((id) => isUuid(id));
    const found = new Set<string>();
    if (valid.length === 0) return found;
    for (const tenantId of await this.tenantIds('all')) {
      const rows = await run(
        this.tenantDb(tenantId)
          .selectFrom('evidence_packs')
          .select('id')
          .where('tenant_id', '=', tenantId)
          .where('id', 'in', valid)
          .execute(),
      );
      for (const row of rows) found.add(row.id);
    }
    return found;
  }

  /** Health check (task B03): true when the database answers. Reads no table. */
  async ping(): Promise<true> {
    await run(sql`SELECT 1`.execute(this.db));
    return true;
  }

  /**
   * Authentication (task B03): the tenant is only known after the token is found, so this lookup
   * crosses tenants. Takes the SHA-256 hash, never the token. Returns undefined unless the token
   * is not revoked, not expired, its user is active, and the tenant is `active` or
   * `pending_deletion` (H03c: cancel during the grace period; the API then allows only the
   * data-deletion routes).
   */
  async resolveApiToken(
    tokenHash: string,
    now: Date = new Date(),
  ): Promise<ResolvedApiToken | undefined> {
    assertTokenHash(tokenHash);
    const tenantId = await this.lookupTenant('auth_api_token_tenant', tokenHash);
    if (tenantId === undefined) return undefined;
    const row = await run(
      this.tenantDb(tenantId)
        .selectFrom('api_tokens as t')
        .innerJoin('users as u', (join) =>
          join.on('u.tenant_id', '=', tenantId).onRef('u.id', '=', 't.user_id'),
        )
        .innerJoin('tenants as tn', 'tn.id', 't.tenant_id')
        .select(['t.id as token_id', 't.tenant_id', 't.user_id', 'tn.status as tenant_status'])
        .where('t.tenant_id', '=', tenantId)
        .where('t.token_hash', '=', tokenHash)
        .where('t.revoked_at', 'is', null)
        .where('t.expires_at', '>', now)
        .where('u.status', '=', 'active')
        .where('tn.status', 'in', ['active', 'pending_deletion'])
        .executeTakeFirst(),
    );
    return row
      ? {
          tenantId: parseTenantId(row.tenant_id),
          userId: row.user_id,
          tokenId: row.token_id,
          tenantStatus: row.tenant_status as AuthTenantStatus,
        }
      : undefined;
  }

  /**
   * The API's guard (U05, ADR-M73 §2.2): a session cookie names no tenant, so the lookup crosses
   * tenants, as for API tokens. Takes the SHA-256 of the session secret, never the secret.
   * Returns undefined unless the session is not ended, not past its absolute end, seen after
   * `idleSince`, its user is active, the tenant is `active` or `pending_deletion` (H03c), and the
   * identity it was opened with is still linked.
   */
  async resolveWebSession(
    secretHash: string,
    now: Date,
    idleSince: Date,
  ): Promise<ResolvedWebSession | undefined> {
    assertTokenHash(secretHash);
    const tenantId = await this.lookupTenant('auth_web_session_tenant', secretHash);
    if (tenantId === undefined) return undefined;
    const row = await run(
      this.tenantDb(tenantId)
        .selectFrom('web_sessions as s')
        .innerJoin('users as u', (join) =>
          join.on('u.tenant_id', '=', tenantId).onRef('u.id', '=', 's.user_id'),
        )
        .innerJoin('user_identities as i', (join) =>
          join
            .on('i.tenant_id', '=', tenantId)
            .onRef('i.id', '=', 's.identity_id')
            .onRef('i.user_id', '=', 's.user_id'),
        )
        .innerJoin('tenants as tn', 'tn.id', 's.tenant_id')
        .select([
          's.id as session_id',
          's.tenant_id',
          's.user_id',
          's.last_seen_at',
          's.created_at',
          's.csrf_sha256',
          'tn.status as tenant_status',
        ])
        .where('s.tenant_id', '=', tenantId)
        .where('s.secret_sha256', '=', secretHash)
        .where('s.revoked_at', 'is', null)
        .where('s.expires_at', '>', now)
        .where('s.last_seen_at', '>', idleSince)
        .where('i.unlinked_at', 'is', null)
        .where('u.status', '=', 'active')
        .where('tn.status', 'in', ['active', 'pending_deletion'])
        .executeTakeFirst(),
    );
    return row
      ? {
          tenantId: parseTenantId(row.tenant_id),
          userId: row.user_id,
          sessionId: row.session_id,
          lastSeenAt: row.last_seen_at,
          tenantStatus: row.tenant_status as AuthTenantStatus,
          createdAt: row.created_at,
          csrfSha256: row.csrf_sha256,
        }
      : undefined;
  }

  /**
   * Ends the session of a secret's hash, whatever its state (sign-in replaces any session cookie
   * the browser sent, ADR-M73 §2.2: no session fixation). Crosses tenants for the same reason as
   * `resolveWebSession`. Returns the tenant and user when this call ended an open session.
   */
  async endWebSessionBySecret(
    secretHash: string,
    reason: WebSessionEndReason,
    at: Date,
  ): Promise<{ tenantId: TenantId; userId: string } | undefined> {
    assertTokenHash(secretHash);
    const tenantId = await this.lookupTenant('auth_web_session_tenant', secretHash);
    if (tenantId === undefined) return undefined;
    const row = await run(
      this.tenantDb(tenantId)
        .updateTable('web_sessions')
        .set({ revoked_at: at, end_reason: reason })
        .where('tenant_id', '=', tenantId)
        .where('secret_sha256', '=', secretHash)
        .where('revoked_at', 'is', null)
        .returning(['tenant_id', 'user_id'])
        .executeTakeFirst(),
    );
    return row ? { tenantId: parseTenantId(row.tenant_id), userId: row.user_id } : undefined;
  }
  /**
   * The tenant of an API token or a web session, by its SHA-256 hash only (migration 0059,
   * ADR-M110 §2.4): the one read of tenant data that cannot name its tenant first.
   */
  private async lookupTenant(
    fn: 'auth_api_token_tenant' | 'auth_web_session_tenant',
    sha256: string,
  ): Promise<TenantId | undefined> {
    const result = await run(
      sql<{ tenant_id: string | null }>`SELECT ${sql.id(fn)}(${sha256}) AS tenant_id`.execute(
        this.db,
      ),
    );
    const tenantId = result.rows[0]?.tenant_id;
    return tenantId == null ? undefined : parseTenantId(tenantId);
  }
}

/** Byte order of lowercase IDs, as PostgreSQL orders `uuid` and `text` in the C collation. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

async function run<T>(statement: Promise<T>): Promise<T> {
  try {
    return await statement;
  } catch (error) {
    return translatePgError(error);
  }
}
