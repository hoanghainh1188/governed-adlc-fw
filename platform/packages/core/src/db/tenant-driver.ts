// The tenant of a database transaction (task H09, design/ADR-M110 §2.2).
//
// Row-level security (H09 PR 2) compares every row's `tenant_id` with the setting `app.tenant_id`.
// The setting is always transaction-local (`set_config(…, true)`): PostgreSQL resets it at COMMIT
// or ROLLBACK, so a pooled connection never keeps another tenant (R026). A statement sent outside a
// transaction runs in its own short transaction that sets the tenant first.
import {
  CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type QueryCompiler,
  type QueryResult,
  type TransactionSettings,
} from 'kysely';

import { parseTenantId, type TenantId } from './tenant-id.js';

/** The name of the setting the row-level security policies read. */
export const TENANT_SETTING = 'app.tenant_id';

/** `SELECT set_config('app.tenant_id', <tenant>, true)`: local to the current transaction. */
export function setTenantQuery(tenantId: TenantId): CompiledQuery {
  return CompiledQuery.raw('SELECT set_config($1, $2, true)', [
    TENANT_SETTING,
    parseTenantId(tenantId),
  ]);
}

const ISOLATION_LEVELS: readonly string[] = [
  'read uncommitted',
  'read committed',
  'repeatable read',
  'serializable',
];
const ACCESS_MODES: readonly string[] = ['read only', 'read write'];

/**
 * `BEGIN` (or `START TRANSACTION …`) and `set_config(…, true)` in one message, so a transaction of a
 * tenant costs no extra round trip. The simple query protocol takes no parameters: the tenant ID
 * is inlined after `parseTenantId` checked it (36 characters of `[0-9a-f-]` only), and the
 * settings are checked against fixed lists.
 */
export function beginForTenantQuery(
  tenantId: TenantId,
  settings: TransactionSettings = {},
): CompiledQuery {
  const id = parseTenantId(tenantId);
  const { isolationLevel, accessMode } = settings;
  if (isolationLevel !== undefined && !ISOLATION_LEVELS.includes(isolationLevel)) {
    throw new Error('unsupported isolation level');
  }
  if (accessMode !== undefined && !ACCESS_MODES.includes(accessMode)) {
    throw new Error('unsupported access mode');
  }
  let begin = 'BEGIN';
  if (isolationLevel !== undefined || accessMode !== undefined) {
    begin = 'START TRANSACTION';
    if (isolationLevel !== undefined) begin += ` ISOLATION LEVEL ${isolationLevel.toUpperCase()}`;
    if (accessMode !== undefined) begin += ` ${accessMode.toUpperCase()}`;
  }
  return CompiledQuery.raw(`${begin}; SELECT set_config('${TENANT_SETTING}', '${id}', true)`);
}

/**
 * A driver bound to one tenant, over the shared driver (and pool) of the platform database.
 * `destroy` does nothing: the platform database owns the pool and closes it.
 */
export class TenantBoundDriver implements Driver {
  readonly #inner: Driver;
  readonly #tenantId: TenantId;

  constructor(inner: Driver, tenantId: TenantId) {
    this.#inner = inner;
    this.#tenantId = parseTenantId(tenantId);
  }

  init(): Promise<void> {
    return this.#inner.init();
  }

  async acquireConnection(): Promise<DatabaseConnection> {
    return new TenantBoundConnection(await this.#inner.acquireConnection(), this.#tenantId);
  }

  async beginTransaction(
    connection: DatabaseConnection,
    settings: TransactionSettings,
  ): Promise<void> {
    const conn = bound(connection);
    try {
      await conn.inner.executeQuery(beginForTenantQuery(this.#tenantId, settings));
    } catch (error) {
      // Kysely does not roll back when BEGIN itself fails, so the transaction ends here.
      await rollbackQuietly(conn.inner);
      throw error;
    }
    conn.inTransaction = true;
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    const conn = bound(connection);
    try {
      await this.#inner.commitTransaction(conn.inner);
    } finally {
      conn.inTransaction = false;
    }
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    const conn = bound(connection);
    try {
      await this.#inner.rollbackTransaction(conn.inner);
    } finally {
      conn.inTransaction = false;
    }
  }

  async savepoint(
    connection: DatabaseConnection,
    name: string,
    compileQuery: QueryCompiler['compileQuery'],
  ): Promise<void> {
    await this.#inner.savepoint?.(bound(connection).inner, name, compileQuery);
  }

  async rollbackToSavepoint(
    connection: DatabaseConnection,
    name: string,
    compileQuery: QueryCompiler['compileQuery'],
  ): Promise<void> {
    await this.#inner.rollbackToSavepoint?.(bound(connection).inner, name, compileQuery);
  }

  async releaseSavepoint(
    connection: DatabaseConnection,
    name: string,
    compileQuery: QueryCompiler['compileQuery'],
  ): Promise<void> {
    await this.#inner.releaseSavepoint?.(bound(connection).inner, name, compileQuery);
  }

  releaseConnection(connection: DatabaseConnection): Promise<void> {
    return this.#inner.releaseConnection(bound(connection).inner);
  }

  async destroy(): Promise<void> {
    // The shared pool is closed by `PlatformDatabase.close`.
  }
}

class TenantBoundConnection implements DatabaseConnection {
  inTransaction = false;

  constructor(
    readonly inner: DatabaseConnection,
    private readonly tenantId: TenantId,
  ) {}

  async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    if (this.inTransaction) return this.inner.executeQuery<R>(compiledQuery);
    try {
      await this.inner.executeQuery(beginForTenantQuery(this.tenantId));
      const result = await this.inner.executeQuery<R>(compiledQuery);
      await this.inner.executeQuery(CompiledQuery.raw('COMMIT'));
      return result;
    } catch (error) {
      await rollbackQuietly(this.inner);
      throw error;
    }
  }

  // A stream would hold the transaction open between reads; the platform does not stream.
  streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    const refused: AsyncIterableIterator<QueryResult<R>> = {
      next: () => Promise.reject(new Error('streaming queries are not supported for tenant data')),
      [Symbol.asyncIterator]: () => refused,
    };
    return refused;
  }
}

function bound(connection: DatabaseConnection): TenantBoundConnection {
  if (connection instanceof TenantBoundConnection) return connection;
  throw new Error('connection does not belong to a tenant-bound driver');
}

async function rollbackQuietly(connection: DatabaseConnection): Promise<void> {
  try {
    await connection.executeQuery(CompiledQuery.raw('ROLLBACK'));
  } catch {
    // The original error is the one to report; a broken connection fails its next use.
  }
}
