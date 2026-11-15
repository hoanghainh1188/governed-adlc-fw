// Throw-away databases for the DB integration tests (task A06, design/ADR-M09 section 2.6).
// SDLC_TEST_DATABASE_URL: superuser URL of a server whose roles come from
// platform/deploy/postgres/init (`pnpm test:db` starts one). Each test file gets its own database.
// The superuser connects with `-c role=…`, so every check runs with the privileges of
// `platform` (owner, migrations) or `platform_app` (application), never as superuser.
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Kysely } from 'kysely';
import pg from 'pg';
import { describe } from 'vitest';

import {
  createKysely,
  createPlatformDriver,
  kyselyOver,
} from '../../../packages/core/src/db/connection.js';
import { migrateToLatest } from '../../../packages/core/src/db/migrator.js';
import { PlatformDatabase } from '../../../packages/core/src/db/platform-database.js';
import type { Database } from '../../../packages/core/src/db/schema.js';
import { TenantBoundDriver } from '../../../packages/core/src/db/tenant-driver.js';
import type { TenantId } from '../../../packages/core/src/db/tenant-id.js';

const baseUrl = process.env.SDLC_TEST_DATABASE_URL;
if (!baseUrl && process.env.SDLC_REQUIRE_DB === '1') {
  throw new Error('SDLC_REQUIRE_DB=1 but SDLC_TEST_DATABASE_URL is not set (run: pnpm test:db)');
}

/** `describe` that runs only when a test database server is available. */
export const describeDb = describe.skipIf(!baseUrl);

const TEST_DB_NAME = /^sdlc_test_[0-9a-f]{16}$/;

export function urlFor(database: string, role?: string): string {
  const url = new URL(baseUrl!);
  url.pathname = `/${database}`;
  url.search = role ? `?options=${encodeURIComponent(`-c role=${role}`)}` : '';
  return url.toString();
}

async function admin<T>(work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: urlFor('postgres') });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

export interface TestDatabase {
  readonly name: string;
  /** Connected as the owner role `platform`, like the migration command. */
  readonly owner: Kysely<Database>;
  /**
   * Raw query builder connected as `platform_app`, for privilege checks. No tenant is set, so
   * row-level security (H09, migration 0060) shows no tenant row: use `appAs` for tenant data.
   */
  readonly appRaw: Kysely<Database>;
  /**
   * Raw query builder connected as `platform_app` with the tenant set in every transaction, as
   * `forTenant()` does, but without the tenant guard: for checks of database triggers,
   * constraints and grants on tenant rows (H09).
   */
  appAs(tenantId: TenantId | string): Kysely<Database>;
  /** The data access layer, connected as `platform_app`. */
  readonly app: PlatformDatabase;
  drop(): Promise<void>;
}

/** Creates an empty database owned by `platform` and migrates it to the latest version. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const name = `sdlc_test_${randomBytes(8).toString('hex')}`;
  // The name is interpolated into DDL (identifiers cannot be parameters): check it first.
  if (!TEST_DB_NAME.test(name)) throw new Error(`unexpected test database name ${name}`);
  await admin(async (client) => {
    await client.query(`CREATE DATABASE ${name} OWNER platform`);
    await client.query(`REVOKE ALL ON DATABASE ${name} FROM PUBLIC`);
    await client.query(`GRANT CONNECT ON DATABASE ${name} TO platform_app`);
  });
  const owner = createKysely({ connectionString: urlFor(name, 'platform'), maxConnections: 2 });
  const { error } = await migrateToLatest(owner);
  if (error) throw new Error('migration of the test database failed', { cause: error });
  const appRaw = createKysely({
    connectionString: urlFor(name, 'platform_app'),
    maxConnections: 2,
  });
  const appAsDriver = createPlatformDriver({
    connectionString: urlFor(name, 'platform_app'),
    maxConnections: 2,
  });
  const appAsDbs = new Map<string, Kysely<Database>>();
  const appAs = (tenantId: TenantId | string): Kysely<Database> => {
    let db = appAsDbs.get(tenantId);
    if (db === undefined) {
      db = kyselyOver(new TenantBoundDriver(appAsDriver, tenantId as TenantId));
      appAsDbs.set(tenantId, db);
    }
    return db;
  };
  const app = PlatformDatabase.connect({
    connectionString: urlFor(name, 'platform_app'),
    maxConnections: 4,
  });
  return {
    name,
    owner,
    appRaw,
    appAs,
    app,
    async drop() {
      await Promise.all([owner.destroy(), appRaw.destroy(), appAsDriver.destroy(), app.close()]);
      if (!TEST_DB_NAME.test(name)) throw new Error(`refusing to drop ${name}`);
      await admin(async (client) => {
        await waitForDisconnect(client, name);
        await client.query(`DROP DATABASE ${name} WITH (FORCE)`);
      });
    },
  };
}

const DISCONNECT_WAIT_MS = 5_000;
const DISCONNECT_POLL_MS = 20;

/**
 * Waits until the database has no connections left. `pool.end()` resolves before its clients'
 * sockets are closed; if `DROP … WITH (FORCE)` terminates such a closing connection, PostgreSQL
 * sends it 57P01. `createPool` listens for that error now, but the wait keeps the teardown quiet
 * and `pg.Client`s made directly in tests have no listener. FORCE stays as the fallback.
 */
async function waitForDisconnect(client: pg.Client, name: string): Promise<void> {
  const deadline = Date.now() + DISCONNECT_WAIT_MS;
  for (;;) {
    const { rows } = await client.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1',
      [name],
    );
    if (rows[0]!.n === 0 || Date.now() >= deadline) return;
    await sleep(DISCONNECT_POLL_MS);
  }
}

/**
 * Runs SQL as superuser with triggers disabled (`session_replication_role = replica`): an admin
 * editing the database directly, bypassing grants and triggers (D-08 A07 AC4).
 */
export async function tamper(
  database: string,
  statement: string,
  values: unknown[] = [],
): Promise<void> {
  if (!TEST_DB_NAME.test(database)) throw new Error(`refusing to tamper with ${database}`);
  const client = new pg.Client({ connectionString: urlFor(database) });
  await client.connect();
  try {
    await client.query('SET session_replication_role = replica');
    await client.query(statement, values);
  } finally {
    await client.end();
  }
}
