// Entry point of the data access layer (task A06; tenant per transaction: task H09, ADR-M110).
import type { Kysely, PostgresDriver } from 'kysely';

import { createPlatformDriver, kyselyOver, type DatabaseConfig } from './connection.js';
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
  ) {
    this.system = new SystemScope(db, (tenantId) => this.tenantDb(tenantId));
  }

  static connect(config: DatabaseConfig): PlatformDatabase {
    const driver = createPlatformDriver(config);
    return new PlatformDatabase(kyselyOver(driver), driver);
  }

  forTenant(tenantId: TenantId): TenantScope {
    return new TenantScope(this.tenantDb(tenantId), tenantId);
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
