// D-08 H09 AC1 + AC3 + AC4 on a live PostgreSQL (ADR-M110 §2.1, §2.4): every table with a
// `tenant_id` column has row-level security enabled and forced with both policies (a later table
// that misses them fails here); `platform_app` sees no tenant row without a tenant, and a query of
// tenant A never sees, changes or creates a row of tenant B, even with raw SQL and no filter.
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Database } from '../../../packages/core/src/db/schema.js';
import { seedRun, type SeededRun } from '../cost-seed.js';
import { createTestDatabase, describeDb, type TestDatabase } from './helpers.js';

/** Tables without row-level security in the public schema (ADR-M110 §2.4). */
const WITHOUT_RLS = ['tenants', 'kysely_migration', 'kysely_migration_lock'];

describeDb('H09: row-level security on PostgreSQL', () => {
  let t: TestDatabase;
  let a: SeededRun;
  let b: SeededRun;
  let tables: string[];

  beforeAll(async () => {
    t = await createTestDatabase();
    const now = new Date();
    a = await seedRun(t.app, { slug: 'acme', models: ['model-a'], now });
    b = await seedRun(t.app, { slug: 'globex', models: ['model-a'], now });
    const rows = await sql<{ table_name: string }>`
      SELECT c.table_name FROM information_schema.columns c
        JOIN information_schema.tables tb
          ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name
       WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id'
         AND tb.table_type = 'BASE TABLE'
       ORDER BY c.table_name`.execute(t.owner);
    tables = rows.rows.map((row) => row.table_name);
  }, 60_000);

  afterAll(async () => {
    await t?.drop();
  });

  /** Row counts of every tenant table, as `db` sees them. */
  async function counts(db: Kysely<Database>) {
    const result: Record<string, { all: number; a: number; b: number }> = {};
    for (const table of tables) {
      const row = await sql<{ all: number; a: number; b: number }>`
        SELECT count(*)::int AS all,
               count(*) FILTER (WHERE tenant_id = ${a.scope.tenantId})::int AS a,
               count(*) FILTER (WHERE tenant_id = ${b.scope.tenantId})::int AS b
          FROM ${sql.table(table)}`.execute(db);
      result[table] = row.rows[0]!;
    }
    return result;
  }

  describe('AC1: every table with tenant_id', () => {
    it('finds the tenant tables of the database', () => {
      expect(tables.length).toBeGreaterThanOrEqual(51);
      for (const table of WITHOUT_RLS) expect(tables).not.toContain(table);
    });

    it('has row-level security enabled and forced, with both policies', async () => {
      const state = await sql<{
        table: string;
        enabled: boolean;
        forced: boolean;
        policies: string[] | null;
      }>`
        SELECT c.relname AS table, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
               (SELECT array_agg(p.policyname || ':' || array_to_string(p.roles, ',') || ':' || p.cmd
                                 ORDER BY p.policyname)
                  FROM pg_policies p
                 WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS policies
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = ANY(${tables})
         ORDER BY c.relname`.execute(t.owner);
      expect(state.rows.map((row) => row.table)).toEqual(tables);
      for (const row of state.rows) {
        expect(row, row.table).toEqual({
          table: row.table,
          enabled: true,
          forced: true,
          policies: ['owner_all:platform:ALL', 'tenant_isolation:platform_app:ALL'],
        });
      }
    });

    it('gives no role BYPASSRLS, and the tenants table has no row-level security', async () => {
      const roles = await sql<{ rolname: string }>`
        SELECT rolname FROM pg_roles
         WHERE rolbypassrls AND rolname IN ('platform', 'platform_app')`.execute(t.owner);
      expect(roles.rows).toEqual([]);
      const tenants = await sql<{ enabled: boolean }>`
        SELECT relrowsecurity AS enabled FROM pg_class WHERE relname = 'tenants'`.execute(t.owner);
      expect(tenants.rows).toEqual([{ enabled: false }]);
    });
  });

  describe('AC3: no tenant, or another tenant, sees nothing', () => {
    it('the seed has rows of both tenants in the main tables', async () => {
      const seen = await counts(t.owner);
      for (const table of ['projects', 'users', 'intents', 'plans', 'runs', 'audit_log']) {
        expect(seen[table]!.a, table).toBeGreaterThan(0);
        expect(seen[table]!.b, table).toBeGreaterThan(0);
      }
    });

    it('platform_app without a tenant sees no row of any tenant table', async () => {
      const seen = await counts(t.appRaw);
      for (const table of tables) expect(seen[table], table).toEqual({ all: 0, a: 0, b: 0 });
    });

    it('tenant A sees only its own rows, even when a query forgets the tenant filter', async () => {
      const owner = await counts(t.owner);
      const seen = await counts(t.appAs(a.scope.tenantId));
      for (const table of tables) {
        expect(seen[table], table).toEqual({ all: owner[table]!.a, a: owner[table]!.a, b: 0 });
      }
      const intents = await sql<{ tenant_id: string }>`
        SELECT tenant_id FROM intents`.execute(t.appAs(a.scope.tenantId));
      expect(new Set(intents.rows.map((row) => row.tenant_id))).toEqual(
        new Set([a.scope.tenantId]),
      );
    });

    it("tenant A cannot change tenant B's rows or write a row for tenant B", async () => {
      const asA = t.appAs(a.scope.tenantId);
      const updated = await sql`UPDATE intents SET title = 'x' WHERE id = ${b.intentId}`.execute(
        asA,
      );
      expect(updated.numAffectedRows).toBe(0n);
      await expect(
        sql`INSERT INTO users (tenant_id, display_name, email)
            VALUES (${b.scope.tenantId}, 'Mallory', 'mallory@example.test')`.execute(asA),
      ).rejects.toMatchObject({ code: '42501' });
      const still = await sql<{ title: string }>`
        SELECT title FROM intents WHERE id = ${b.intentId}`.execute(t.owner);
      expect(still.rows[0]!.title).not.toBe('x');
    });

    it('a malformed or empty tenant setting matches no row', async () => {
      const empty = await t.appRaw.transaction().execute(async (trx) => {
        await sql`SELECT set_config('app.tenant_id', '', true)`.execute(trx);
        return sql<{ n: number }>`SELECT count(*)::int AS n FROM intents`.execute(trx);
      });
      expect(empty.rows[0]!.n).toBe(0);
    });
  });

  describe('AC4: the platform still works across tenants', () => {
    it('the system scope and the tenant scopes still find their rows', async () => {
      const projects = await t.app.system.listPollableProjects();
      expect(new Set(projects.map((p) => p.tenantId))).toEqual(
        new Set([a.scope.tenantId, b.scope.tenantId]),
      );
      expect((await a.scope.intents.getById(a.intentId))?.id).toBe(a.intentId);
      expect(await a.scope.intents.getById(b.intentId)).toBeUndefined();
    });

    it('the owner role still sees every row (migrations, definer functions)', async () => {
      const seen = await counts(t.owner);
      expect(seen.intents!.all).toBe(seen.intents!.a + seen.intents!.b);
    });
  });
});
