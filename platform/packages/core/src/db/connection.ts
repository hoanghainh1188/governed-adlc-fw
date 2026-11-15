// PostgreSQL connections for the platform database (task A06, design/ADR-M09).
import {
  Kysely,
  PostgresAdapter,
  PostgresDialect,
  PostgresDriver,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type Driver,
} from 'kysely';
import pg from 'pg';

import type { PlatformLogger } from '../observability/logger.js';
import type { Database } from './schema.js';

export interface DatabaseConfig {
  /**
   * `postgres://…` URL. The platform connects as `platform_app`; migrations as `platform`
   * (the owner). Until A04 the URL comes from the environment; later from OpenBao (D-03 §8.2).
   */
  readonly connectionString: string;
  /** Pool size. Default 10. */
  readonly maxConnections?: number;
  readonly applicationName?: string;
  /**
   * Called when a pooled connection fails outside a query: an idle client (PostgreSQL restart,
   * `pg_terminate_backend`, a network reset) or a checked-out client between two queries. The
   * pool has already dropped the client and stays usable. Receives a code only (`connectionErrorCode`),
   * never the error's message or the client: they can hold the connection URL and password.
   */
  readonly onIdleError?: (code: string) => void;
}

/** SQL `date` stays a `YYYY-MM-DD` string; a JS Date would shift it by the local time zone. */
const typeParsers: pg.CustomTypesConfig = {
  getTypeParser: (oid, format) =>
    oid === pg.types.builtins.DATE && format !== 'binary'
      ? (value: string) => value
      : (pg.types.getTypeParser(oid, format) as (value: string) => unknown),
};

const ERROR_CODE = /^[A-Z0-9_]{1,32}$/;

/**
 * The SQLSTATE (`57P01`) or the Node error code (`ECONNRESET`) of a connection error, or
 * `unknown`. Exported for tests.
 */
export function connectionErrorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && ERROR_CODE.test(code) ? code : 'unknown';
}

/**
 * Without a listener, an `'error'` event of the pool (an idle client failed) or of a checked-out
 * client (failed between two queries) is thrown by Node and ends the process. The pool removes a
 * failed idle client itself; a checked-out one fails its next query, so the caller still sees it.
 */
export function createPool(config: DatabaseConfig): pg.Pool {
  const pool = new pg.Pool({
    connectionString: config.connectionString,
    max: config.maxConnections ?? 10,
    application_name: config.applicationName ?? 'sdlc-platform',
    types: typeParsers,
  });
  const report = (error: unknown): void => {
    try {
      config.onIdleError?.(connectionErrorCode(error));
    } catch {
      // A failing hook must never turn a handled error into a crash.
    }
  };
  // Every client, idle or checked out, reports its own errors once. The pool's `'error'` event
  // repeats an idle client's error (pg-pool's idle listener): listen, so Node does not throw it,
  // but do not report it twice.
  pool.on('connect', (client) => {
    client.on('error', report);
  });
  pool.on('error', () => undefined);
  return pool;
}

/** The `onIdleError` hook of the platform processes: one warning line with the code only. */
export function logIdleDbErrors(logger: PlatformLogger): (code: string) => void {
  return (code) => logger.log('warn', 'db.idle_client_error', { code });
}

/** Internal: a Kysely instance without the tenant guard. Never exported from `@sdlc/core`. */
export function createKysely(config: DatabaseConfig): Kysely<Database> {
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool: createPool(config) }) });
}

/**
 * Internal: a Kysely instance over a given driver (task H09). The platform database shares one
 * `PostgresDriver` (one pool) between its own instance and one tenant-bound instance per tenant.
 */
export function kyselyOver(driver: Driver): Kysely<Database> {
  return new Kysely<Database>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
}

/** Internal: the shared driver of the platform database, over a new pool. */
export function createPlatformDriver(config: DatabaseConfig): PostgresDriver {
  return new PostgresDriver({ pool: createPool(config) });
}
