// Entry point of the data access layer (task A06; tenant per transaction: task H09, ADR-M110).
import { sql, type Kysely, type PostgresDriver } from 'kysely';

import { encodeGitHint, GIT_HINT_CHANNEL, type GitHint } from '../git-events/hints.js';

import { createPlatformDriver, kyselyOver, type DatabaseConfig } from './connection.js';
import { listenGitHints, type GitHintSubscription } from './git-hints.js';
import type { Database } from './schema.js';
import { SystemScope } from './system-scope.js';
import { TenantBoundDriver } from './tenant-driver.js';
import { TenantScope } from './tenant-scope.js';
import { parseTenantId, type TenantId } from './tenant-id.js';

/**
 * The platform database, connected as the application role `platform_app`.
 * Tenant data: `forTenant(tenantId)`. The few cross-tenant operations: `system`.
 * Every statement of a tenant runs in a transaction that sets `app.tenant_id` first (H09).
 * The underlying query builder is not exposed.
 */
export class PlatformDatabase {
  readonly system: SystemScope;
  readonly #tenantDbs = new Map<TenantId, Kysely<Database>>();

  private constructor(
    private readonly db: Kysely<Database>,
    private readonly driver: PostgresDriver,
    private readonly config: DatabaseConfig,
  ) {
    this.system = new SystemScope(db, (tenantId) => this.tenantDb(tenantId));
  }

  static connect(config: DatabaseConfig): PlatformDatabase {
    const driver = createPlatformDriver(config);
    return new PlatformDatabase(kyselyOver(driver), driver, config);
  }

  forTenant(tenantId: TenantId): TenantScope {
    return new TenantScope(this.tenantDb(tenantId), tenantId);
  }

  /**
   * O08 (ADR-M112 §2.5): wakes the worker's poll of one repository with `NOTIFY`. Reads and
   * writes no table, so it needs no tenant.
   */
  async notifyGitHint(hint: GitHint): Promise<void> {
    await sql`SELECT pg_notify(${GIT_HINT_CHANNEL}, ${encodeGitHint(hint)})`.execute(this.db);
  }

  /** O08 (ADR-M112 §2.6): the worker's `LISTEN`, on one connection outside the pool. */
  listenGitHints(onHint: (hint: GitHint) => void): Promise<GitHintSubscription> {
    return listenGitHints(this.config, onHint);
  }

  close(): Promise<void> {
    return this.db.destroy();
  }

  /** One tenant-bound instance per tenant, over the shared pool. */
  private tenantDb(tenantId: TenantId): Kysely<Database> {
    const id = parseTenantId(tenantId);
    let db = this.#tenantDbs.get(id);
    if (db === undefined) {
      db = kyselyOver(new TenantBoundDriver(this.driver, id));
      this.#tenantDbs.set(id, db);
    }
    return db;
  }
}
