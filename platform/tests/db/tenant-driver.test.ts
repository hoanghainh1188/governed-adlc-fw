// D-08 H09 AC2 (ADR-M110 §2.2): every statement of a tenant runs in a transaction whose first
// statement sets `app.tenant_id` with `set_config(…, true)`; the setting is never per session.
import {
  CompiledQuery,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  sql,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
} from 'kysely';
import { describe, expect, it } from 'vitest';

import type { Database } from '../../packages/core/src/db/schema.js';
import {
  beginForTenantQuery,
  setTenantQuery,
  TENANT_SETTING,
  TenantBoundDriver,
} from '../../packages/core/src/db/tenant-driver.js';
import { TenantScope } from '../../packages/core/src/db/tenant-scope.js';
import { parseTenantId } from '../../packages/core/src/db/tenant-id.js';
import { TENANT_A, TENANT_B } from './dummy.js';

interface Sent {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

/** A driver that records every statement and fails the ones `failOn` matches. */
class RecordingDriver implements Driver {
  readonly sent: Sent[] = [];
  released = 0;
  constructor(private readonly failOn?: RegExp) {}
  init(): Promise<void> {
    return Promise.resolve();
  }
  acquireConnection(): Promise<DatabaseConnection> {
    return Promise.resolve({
      executeQuery: <R>(query: CompiledQuery): Promise<QueryResult<R>> => {
        this.sent.push({ sql: query.sql, parameters: query.parameters });
        if (this.failOn?.test(query.sql)) return Promise.reject(new Error('failed on purpose'));
        return Promise.resolve({ rows: [] });
      },
      streamQuery: () => {
        throw new Error('not used');
      },
    });
  }
  async beginTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('begin'));
  }
  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('commit'));
  }
  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('rollback'));
  }
  releaseConnection(): Promise<void> {
    this.released += 1;
    return Promise.resolve();
  }
  destroy(): Promise<void> {
    return Promise.resolve();
  }
}

function tenantDb(inner: Driver, tenant = TENANT_A): Kysely<Database> {
  return new Kysely<Database>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new TenantBoundDriver(inner, parseTenantId(tenant)),
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
}

const SET_TENANT = 'SELECT set_config($1, $2, true)';
const BEGIN_A = `BEGIN; SELECT set_config('app.tenant_id', '${TENANT_A}', true)`;

describe('H09 AC2: the tenant is set per transaction', () => {
  it('sets the tenant transaction-locally, with the tenant as a parameter', () => {
    const query = setTenantQuery(parseTenantId(TENANT_A));
    expect(query.sql).toBe(SET_TENANT);
    expect(query.parameters).toEqual([TENANT_SETTING, TENANT_A]);
    expect(TENANT_SETTING).toBe('app.tenant_id');
  });

  it('begins and sets the tenant in one message, with a checked tenant ID', () => {
    expect(beginForTenantQuery(parseTenantId(TENANT_A))).toMatchObject({
      sql: BEGIN_A,
      parameters: [],
    });
    expect(
      beginForTenantQuery(parseTenantId(TENANT_B), {
        isolationLevel: 'serializable',
        accessMode: 'read only',
      }).sql,
    ).toBe(
      `START TRANSACTION ISOLATION LEVEL SERIALIZABLE READ ONLY; SELECT set_config('app.tenant_id', '${TENANT_B}', true)`,
    );
    expect(() => beginForTenantQuery(`${TENANT_A}'; --` as never)).toThrow();
    expect(() =>
      beginForTenantQuery(parseTenantId(TENANT_A), { isolationLevel: 'x; DROP' as never }),
    ).toThrow(/isolation/);
  });

  it('wraps a statement sent outside a transaction in its own transaction', async () => {
    const inner = new RecordingDriver();
    const scope = new TenantScope(tenantDb(inner), parseTenantId(TENANT_A));
    await scope.projects.list();
    expect(inner.sent.map((s) => s.sql)).toEqual([
      BEGIN_A,
      expect.stringMatching(/^select .* from "projects"/),
      'COMMIT',
    ]);
    expect(inner.released).toBe(1);
  });

  it('sets the tenant once, at BEGIN, in a transaction', async () => {
    const inner = new RecordingDriver();
    const scope = new TenantScope(tenantDb(inner), parseTenantId(TENANT_A));
    await scope.transaction(async (trx) => {
      await trx.projects.list();
      await trx.users.list();
    });
    const statements = inner.sent.map((s) => s.sql);
    expect(statements[0]).toBe(BEGIN_A);
    expect(statements.filter((s) => s.includes('set_config'))).toHaveLength(1);
    expect(statements).toHaveLength(4);
    expect(statements.at(-1)).toBe('commit');
  });

  it('rolls back the short transaction when the statement fails', async () => {
    const inner = new RecordingDriver(/^select/);
    const scope = new TenantScope(tenantDb(inner), parseTenantId(TENANT_A));
    await expect(scope.projects.list()).rejects.toThrow();
    expect(inner.sent.map((s) => s.sql).slice(-1)).toEqual(['ROLLBACK']);
    expect(inner.sent.map((s) => s.sql)).not.toContain('COMMIT');
    expect(inner.released).toBe(1);
  });

  it('rolls back when setting the tenant fails at the start of a transaction', async () => {
    const inner = new RecordingDriver(/set_config/);
    const db = tenantDb(inner);
    await expect(db.transaction().execute(() => Promise.resolve())).rejects.toThrow();
    expect(inner.sent.map((s) => s.sql)).toEqual([BEGIN_A, 'ROLLBACK']);
  });

  it('binds each tenant-bound driver to its own tenant', async () => {
    const inner = new RecordingDriver();
    await sql`SELECT 1`.execute(tenantDb(inner, TENANT_A));
    await sql`SELECT 1`.execute(tenantDb(inner, TENANT_B));
    const begins = inner.sent.filter((s) => s.sql.startsWith('BEGIN')).map((s) => s.sql);
    expect(begins).toEqual([BEGIN_A, BEGIN_A.replace(TENANT_A, TENANT_B)]);
  });

  it('never sets the tenant for the session', async () => {
    const inner = new RecordingDriver();
    const scope = new TenantScope(tenantDb(inner), parseTenantId(TENANT_A));
    await scope.projects.list();
    await scope.transaction((trx) => trx.projects.list());
    for (const sent of inner.sent) {
      expect(sent.sql).not.toMatch(/set_config\([^)]*false\)|^\s*SET\s+(SESSION\s+)?app\./i);
    }
  });

  it('refuses streaming, which would hold a transaction open between reads', async () => {
    const inner = new RecordingDriver();
    const db = tenantDb(inner);
    const stream = db.selectFrom('projects').selectAll().stream();
    await expect(stream.next()).rejects.toThrow(/streaming/);
  });

  it('rejects a forged tenant ID', () => {
    expect(() => new TenantBoundDriver(new RecordingDriver(), 'x' as never)).toThrow();
  });
});
