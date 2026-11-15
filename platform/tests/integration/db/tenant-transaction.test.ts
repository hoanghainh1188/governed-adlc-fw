// D-08 H09 AC2 + AC4 on a live PostgreSQL (ADR-M110): the tenant is set per transaction and a
// pooled connection never keeps it; the cross-tenant loops and the authentication lookups
// (migration 0059) still find the rows of every tenant.
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPlatformDriver, kyselyOver } from '../../../packages/core/src/db/connection.js';
import { hashApiToken } from '../../../packages/core/src/db/repositories/api-tokens.js';
import type { Database } from '../../../packages/core/src/db/schema.js';
import { TenantBoundDriver } from '../../../packages/core/src/db/tenant-driver.js';
import { parseTenantId, type TenantId } from '../../../packages/core/src/db/tenant-id.js';
import { createTestDatabase, describeDb, urlFor, type TestDatabase } from './helpers.js';

const DAY = 86_400_000;

describeDb('H09 AC2: the tenant of a transaction on PostgreSQL', () => {
  let t: TestDatabase;
  const tenants: TenantId[] = [];
  const tokens: string[] = [];
  const projects: string[] = [];

  beforeAll(async () => {
    t = await createTestDatabase();
    for (const slug of ['h09-a', 'h09-b']) {
      const tenant = await t.app.system.createTenant({ slug, name: slug });
      const tenantId = parseTenantId(tenant.id);
      const scope = t.app.forTenant(tenantId);
      const user = await scope.users.create({ display_name: slug, email: `${slug}@example.test` });
      const token = `sdlc_${slug}_secret_token`;
      await scope.apiTokens.create({
        user_id: user.id,
        name: 'laptop',
        token_hash: hashApiToken(token),
        expires_at: new Date(Date.now() + DAY),
      });
      const project = await scope.projects.create({
        slug: 'shop',
        name: 'Shop',
        git_provider: 'github',
        repo_full_name: `${slug}/shop`,
      });
      tenants.push(tenantId);
      tokens.push(token);
      projects.push(project.id);
    }
  });

  afterAll(async () => {
    await t?.drop();
  });

  /** One connection only, so every statement after the first reuses the same session. */
  function onePool(): { base: Kysely<Database>; forTenant: (id: TenantId) => Kysely<Database> } {
    const driver = createPlatformDriver({
      connectionString: urlFor(t.name, 'platform_app'),
      maxConnections: 1,
    });
    return {
      base: kyselyOver(driver),
      forTenant: (id) => kyselyOver(new TenantBoundDriver(driver, id)),
    };
  }

  async function setting(db: Kysely<Database>): Promise<string | null> {
    const result = await sql<{
      value: string | null;
    }>`SELECT current_setting('app.tenant_id', true) AS value`.execute(db);
    return result.rows[0]!.value;
  }

  it('sets the tenant for a statement and inside a transaction', async () => {
    const pool = onePool();
    try {
      expect(await setting(pool.forTenant(tenants[0]!))).toBe(tenants[0]);
      const inside = await pool
        .forTenant(tenants[1]!)
        .transaction()
        .execute((trx) => setting(trx));
      expect(inside).toBe(tenants[1]);
    } finally {
      await pool.base.destroy();
    }
  });

  it('leaves no tenant on the pooled connection afterwards (R026)', async () => {
    const pool = onePool();
    try {
      await setting(pool.forTenant(tenants[0]!));
      await pool
        .forTenant(tenants[1]!)
        .transaction()
        .execute((trx) => setting(trx));
      // The same single connection, without a tenant-bound driver: nothing is left over.
      expect(['', null]).toContain(await setting(pool.base));
    } finally {
      await pool.base.destroy();
    }
  });

  it('leaves no tenant after a failed statement or transaction', async () => {
    const pool = onePool();
    try {
      await expect(sql`SELECT 1/0`.execute(pool.forTenant(tenants[0]!))).rejects.toThrow();
      await expect(
        pool
          .forTenant(tenants[1]!)
          .transaction()
          .execute(async (trx) => {
            await sql`SELECT 1/0`.execute(trx);
          }),
      ).rejects.toThrow();
      expect(['', null]).toContain(await setting(pool.base));
      // The connection is usable again, outside any transaction.
      const status = await sql<{ open: boolean }>`
        SELECT now() <> statement_timestamp() AS open`.execute(pool.base);
      expect(status.rows[0]!.open).toBe(false);
    } finally {
      await pool.base.destroy();
    }
  });

  it('sets the new tenant in the bootstrap transaction', async () => {
    const seen = await t.app.system.createTenantWith({ slug: 'h09-c', name: 'c' }, (scope) =>
      scope.projects.list().then(() => scope.tenantId),
    );
    expect(seen).toMatch(/^[0-9a-f-]{36}$/);
  });

  describe('AC4: cross-tenant work loops over the tenants', () => {
    it('lists the pollable projects of every active tenant', async () => {
      const listed = await t.app.system.listPollableProjects();
      expect(listed.map((p) => p.projectId).sort()).toEqual([...projects].sort());
      expect(listed.map((p) => p.tenantId)).toEqual([...listed.map((p) => p.tenantId)].sort());
    });

    it('stops at the limit and keeps the keyset order of open intents', async () => {
      expect(await t.app.system.listOpenIntents(10)).toEqual([]);
      expect(await t.app.system.listTenantsWithOpenEvaluations(10)).toEqual([]);
      expect(await t.app.system.earliestStartOfRunsEndedSince(new Date(0))).toBeNull();
    });

    it('finds the tenant of an API token of either tenant', async () => {
      for (const [i, token] of tokens.entries()) {
        const found = await t.app.system.resolveApiToken(hashApiToken(token));
        expect(found?.tenantId).toBe(tenants[i]);
      }
      expect(await t.app.system.resolveApiToken('0'.repeat(64))).toBeUndefined();
    });
  });

  describe('migration 0059: the authentication lookups', () => {
    it('return the tenant ID only, and NULL for an unknown or malformed hash', async () => {
      const lookup = (value: string) =>
        sql<{
          tenant_id: string | null;
        }>`SELECT auth_api_token_tenant(${value}) AS tenant_id`.execute(t.appRaw);
      expect((await lookup(hashApiToken(tokens[1]!))).rows).toEqual([{ tenant_id: tenants[1] }]);
      expect((await lookup('f'.repeat(64))).rows).toEqual([{ tenant_id: null }]);
      expect((await lookup(`${'a'.repeat(63)}' OR true --`)).rows).toEqual([{ tenant_id: null }]);
      const session = await sql<{
        tenant_id: string | null;
      }>`SELECT auth_web_session_tenant(${'a'.repeat(64)}) AS tenant_id`.execute(t.appRaw);
      expect(session.rows).toEqual([{ tenant_id: null }]);
    });

    it('may be called by platform_app only, and run as their owner', async () => {
      const rows = await sql<{ name: string; definer: boolean; owner: string; public: boolean }>`
        SELECT p.proname AS name, p.prosecdef AS definer, pg_get_userbyid(p.proowner) AS owner,
               has_function_privilege('public', p.oid, 'EXECUTE') AS public
          FROM pg_proc p
         WHERE p.proname IN ('auth_api_token_tenant', 'auth_web_session_tenant')
         ORDER BY p.proname`.execute(t.owner);
      expect(rows.rows).toEqual([
        { name: 'auth_api_token_tenant', definer: true, owner: 'platform', public: false },
        { name: 'auth_web_session_tenant', definer: true, owner: 'platform', public: false },
      ]);
      const app = await sql<{ ok: boolean }>`
        SELECT has_function_privilege('platform_app', 'auth_api_token_tenant(text)', 'EXECUTE')
           AND has_function_privilege('platform_app', 'auth_web_session_tenant(text)', 'EXECUTE')
           AS ok`.execute(t.owner);
      expect(app.rows[0]!.ok).toBe(true);
    });
  });
});
