// D-08 H09 AC5 (ADR-M110 §2.6): the cost of row-level security, measured. Skipped unless
// SDLC_RLS_BENCH=1 (`SDLC_RLS_BENCH=1 SDLC_TEST_DB_DIR=platform/tests/integration/db/rls-cost.test.ts
// pnpm test:db`; `SDLC_RLS_REPORT=<file>` writes the report there). It seeds many tenants in one throw-away database, then times the same
// repository calls with row-level security on (migration 0060) and off (turned off by the owner
// in this test database only). The numbers are printed as JSON for the ADR; the test fails only
// when a query no longer uses the tenant index or the slowdown passes a wide bound.
import { sql } from 'kysely';
import fs from 'node:fs';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseTenantId, type TenantId } from '../../../packages/core/src/db/tenant-id.js';
import { createTestDatabase, describeDb, type TestDatabase } from './helpers.js';

const enabled = process.env.SDLC_RLS_BENCH === '1';
const TENANTS = 10;
const USERS_PER_TENANT = 2000;
const ROUNDS = 300;
/** Wide on purpose: a developer machine is noisy. The ADR records the real numbers. */
const MAX_SLOWDOWN = 3;

function median(values: number[]): number {
  const sorted = [...values].sort((x, y) => x - y);
  return sorted[Math.floor(sorted.length / 2)]!;
}

async function timed(rounds: number, work: (i: number) => Promise<unknown>): Promise<number> {
  const times: number[] = [];
  for (let i = 0; i < rounds; i += 1) {
    const start = process.hrtime.bigint();
    await work(i);
    times.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  return median(times);
}

(enabled ? describeDb : describe.skip)('H09 AC5: the query cost of row-level security', () => {
  let t: TestDatabase;
  const tenants: TenantId[] = [];
  const userIds = new Map<TenantId, string[]>();
  let tables: string[];

  beforeAll(async () => {
    t = await createTestDatabase();
    for (let i = 0; i < TENANTS; i += 1) {
      const tenant = await t.app.system.createTenant({ slug: `bench-${i}`, name: `bench ${i}` });
      tenants.push(parseTenantId(tenant.id));
    }
    await sql`
      INSERT INTO users (tenant_id, display_name, email)
      SELECT tn.id, 'user ' || g, 'user' || g || '@example.test'
        FROM tenants tn CROSS JOIN generate_series(1, ${USERS_PER_TENANT}) g`.execute(t.owner);
    await sql`ANALYZE users`.execute(t.owner);
    for (const tenantId of tenants) {
      const rows = await sql<{ id: string }>`
        SELECT id FROM users WHERE tenant_id = ${tenantId} ORDER BY id LIMIT ${ROUNDS}`.execute(
        t.owner,
      );
      userIds.set(
        tenantId,
        rows.rows.map((row) => row.id),
      );
    }
    const found = await sql<{ relname: string }>`
      SELECT relname FROM pg_class WHERE relrowsecurity AND relkind = 'r'`.execute(t.owner);
    tables = found.rows.map((row) => row.relname);
  }, 120_000);

  afterAll(async () => {
    await t?.drop();
  });

  async function measure() {
    const tenantOf = (i: number) => tenants[i % TENANTS]!;
    const idOf = (i: number) => userIds.get(tenantOf(i))![Math.floor(i / TENANTS) % ROUNDS]!;
    return {
      getByIdMs: await timed(ROUNDS, (i) => t.app.forTenant(tenantOf(i)).users.getById(idOf(i))),
      listMs: await timed(ROUNDS / 10, (i) => t.app.forTenant(tenantOf(i)).users.list()),
      transactionMs: await timed(ROUNDS, (i) =>
        t.app.forTenant(tenantOf(i)).transaction(async (scope) => {
          await scope.users.getById(idOf(i));
          await scope.users.getById(idOf(i + 1));
        }),
      ),
      insertMs: await timed(ROUNDS, (i) =>
        t.app.forTenant(tenantOf(i)).users.create({
          display_name: `new ${i}`,
          email: `new-${i}-${Date.now()}@example.test`,
        }),
      ),
    };
  }

  async function setRls(on: boolean) {
    for (const table of tables) {
      await sql`ALTER TABLE ${sql.table(table)} ${sql.raw(
        on ? 'ENABLE ROW LEVEL SECURITY' : 'DISABLE ROW LEVEL SECURITY',
      )}`.execute(t.owner);
    }
  }

  it('measures the same calls with row-level security off and on', async () => {
    await measure(); // warm up the pool and the caches
    await setRls(false);
    const off = await measure();
    await setRls(true);
    const on = await measure();
    const plan = await t
      .appAs(tenants[0]!)
      .transaction()
      .execute(async (trx) => {
        const result = await sql<{ 'QUERY PLAN': string }>`
        EXPLAIN SELECT * FROM users WHERE tenant_id = ${tenants[0]!}`.execute(trx);
        return result.rows.map((row) => row['QUERY PLAN']).join('\n');
      });
    const report = {
      tenants: TENANTS,
      usersPerTenant: USERS_PER_TENANT,
      rounds: ROUNDS,
      off,
      on,
      ratio: Object.fromEntries(
        Object.entries(on).map(([key, value]) => [
          key,
          Number((value / off[key as keyof typeof off]).toFixed(2)),
        ]),
      ),
      plan,
    };
    const out = process.env.SDLC_RLS_REPORT;
    if (out) fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
    else console.info(JSON.stringify(report, null, 2));
    expect(plan).toMatch(/Index|Bitmap/);
    for (const ratio of Object.values(report.ratio)) expect(ratio).toBeLessThan(MAX_SLOWDOWN);
  }, 300_000);
});
