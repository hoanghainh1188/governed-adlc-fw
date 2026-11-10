// D-08 A06 AC3 + AC4 on a live PostgreSQL: tenant A never reads or changes tenant B data,
// through any repository; cross-tenant references are rejected by the database (D-05 D2).
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DbError } from '../../../packages/core/src/db/errors.js';
import { hashApiToken } from '../../../packages/core/src/db/repositories/api-tokens.js';
import type { TenantScope } from '../../../packages/core/src/db/tenant-scope.js';
import { parseTenantId, type TenantId } from '../../../packages/core/src/db/tenant-id.js';
import { createTestDatabase, describeDb, type TestDatabase } from './helpers.js';

interface Seed {
  tenantId: TenantId;
  scope: TenantScope;
  projectId: string;
  userId: string;
  identityId: string;
  bindingId: string;
  tokenId: string;
  token: string;
}

const DAY = 86_400_000;
const HASH = (c: string) => c.repeat(64);

describeDb('AC3 + AC4: tenant isolation on PostgreSQL', () => {
  let t: TestDatabase;
  let a: Seed;
  let b: Seed;

  /** Seeds one tenant. Both tenants get the same slugs, emails and GitHub account ID on purpose. */
  async function seed(slug: string): Promise<Seed> {
    const tenant = await t.app.system.createTenant({
      slug,
      name: `Tenant ${slug}`,
      monthlyBudgetUsd: '100.5',
    });
    const tenantId = parseTenantId(tenant.id);
    const scope = t.app.forTenant(tenantId);
    const project = await scope.projects.create({
      slug: 'shop',
      name: 'Shop',
      git_provider: 'github',
      repo_full_name: `${slug}/shop`,
    });
    const user = await scope.users.create({ display_name: 'Harry', email: 'Harry@Example.com' });
    const identity = await scope.userIdentities.link({
      user_id: user.id,
      provider: 'github',
      external_id: '1001',
      external_login: 'harry',
    });
    const binding = await scope.roleBindings.grant({
      user_id: user.id,
      project_id: project.id,
      role: 'person_a',
    });
    const token = `sdlc_${slug}_secret_token`;
    const apiToken = await scope.apiTokens.create({
      user_id: user.id,
      name: 'laptop',
      token_hash: hashApiToken(token),
      expires_at: new Date(Date.now() + DAY),
    });
    await scope.projectConfigs.save(project.id, {
      configYaml: `tenant: ${slug}`,
      configHash: HASH(slug === 'tenant-a' ? 'a' : 'b'),
      updatedBy: user.id,
      expectedVersion: 0,
    });
    await scope.projectAiRecords.save(project.id, {
      aiAllowed: 'yes_with_conditions',
      allowedDataClasses: ['internal', 'client_confidential'],
      prodLogsAllowed: 'yes_masked',
      disclosureFormat: 'standard_note',
      recordRef: 'https://docs.example.test/project/ai-record',
      actorType: 'human',
      confirmedAt: '2026-09-24',
      updatedBy: user.id,
      expectedVersion: 0,
    });
    await scope.gitEventCursors.save(project.id, `${slug}-cursor-1`);
    return {
      tenantId,
      scope,
      projectId: project.id,
      userId: user.id,
      identityId: identity.id,
      bindingId: binding.id,
      tokenId: apiToken.id,
      token,
    };
  }

  beforeAll(async () => {
    t = await createTestDatabase();
    a = await seed('tenant-a');
    b = await seed('tenant-b');
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  });

  describe('reads: tenant A never sees tenant B rows', () => {
    it('get by ID returns nothing for B IDs', async () => {
      expect(await a.scope.projects.getById(b.projectId)).toBeUndefined();
      expect(await a.scope.users.getById(b.userId)).toBeUndefined();
      expect(await a.scope.apiTokens.getById(b.tokenId)).toBeUndefined();
      expect(await a.scope.projectConfigs.get(b.projectId)).toBeUndefined();
      expect(await a.scope.projectAiRecords.get(b.projectId)).toBeUndefined();
      expect(await a.scope.gitEventCursors.get(b.projectId)).toBeUndefined();
      expect(await a.scope.userIdentities.listForUser(b.userId)).toEqual([]);
      expect(await a.scope.roleBindings.listForUser(b.userId)).toEqual([]);
      expect(await a.scope.roleBindings.listForProject(b.projectId)).toEqual([]);
      expect(await a.scope.apiTokens.listForUser(b.userId)).toEqual([]);
    });

    it('lookups by shared natural keys return the own tenant row only', async () => {
      expect((await a.scope.projects.getBySlug('shop'))?.id).toBe(a.projectId);
      expect((await b.scope.projects.getBySlug('shop'))?.id).toBe(b.projectId);
      expect((await a.scope.users.getByEmail('harry@example.com'))?.id).toBe(a.userId);
      expect((await b.scope.users.getByEmail('HARRY@EXAMPLE.COM'))?.id).toBe(b.userId);
      expect((await a.scope.userIdentities.findByExternalId('github', '1001'))?.id).toBe(
        a.identityId,
      );
      expect((await b.scope.userIdentities.findByExternalId('github', '1001'))?.id).toBe(
        b.identityId,
      );
    });

    it('lists contain only the own tenant rows', async () => {
      for (const s of [a, b]) {
        const lists = [
          await s.scope.projects.list(),
          await s.scope.users.list(),
          await s.scope.userIdentities.listForUser(s.userId),
          await s.scope.roleBindings.listForProject(s.projectId),
          await s.scope.apiTokens.listForUser(s.userId),
        ];
        for (const list of lists) {
          expect(list).toHaveLength(1);
          expect(list.every((row) => row.tenant_id === s.tenantId)).toBe(true);
        }
      }
    });

    it('a tenant ID without data sees nothing', async () => {
      const empty = t.app.forTenant(parseTenantId('00000000-0000-4000-8000-000000000000'));
      expect(await empty.projects.list()).toEqual([]);
      expect(await empty.users.getById(a.userId)).toBeUndefined();
    });
  });

  describe('writes: tenant A never changes tenant B rows', () => {
    it('status change and token revocation on B IDs do nothing', async () => {
      expect(await a.scope.users.setStatus(b.userId, 'disabled')).toBeUndefined();
      expect((await b.scope.users.getById(b.userId))?.status).toBe('active');
      expect(await a.scope.apiTokens.revoke(b.tokenId)).toBeUndefined();
      expect((await b.scope.apiTokens.getById(b.tokenId))?.revoked_at).toBeNull();
    });

    it('versioned records of B cannot be replaced from A', async () => {
      await expect(
        a.scope.projectConfigs.save(b.projectId, {
          configYaml: 'hijack: true',
          configHash: HASH('c'),
          updatedBy: a.userId,
          expectedVersion: 1,
        }),
      ).rejects.toMatchObject({ code: 'version_conflict' });
      expect((await b.scope.projectConfigs.get(b.projectId))?.config_yaml).toBe('tenant: tenant-b');
    });

    it('D-05 D2: references to another tenant are rejected by composite foreign keys', async () => {
      // Tables keyed by project_id alone hit the primary key first: still rejected, nothing written.
      const crossTenant: [string, () => Promise<unknown>][] = [
        [
          'reference_not_found',
          () =>
            a.scope.roleBindings.grant({
              user_id: b.userId,
              project_id: a.projectId,
              role: 'person_b',
            }),
        ],
        [
          'reference_not_found',
          () =>
            a.scope.roleBindings.grant({
              user_id: a.userId,
              project_id: b.projectId,
              role: 'person_b',
            }),
        ],
        [
          'reference_not_found',
          () =>
            a.scope.userIdentities.link({
              user_id: b.userId,
              provider: 'gitlab',
              external_id: '7',
              external_login: 'x',
            }),
        ],
        [
          'reference_not_found',
          () =>
            a.scope.apiTokens.create({
              user_id: b.userId,
              name: 'x',
              token_hash: HASH('d'),
              expires_at: new Date(Date.now() + DAY),
            }),
        ],
        [
          'reference_not_found',
          () =>
            a.scope.projectConfigs.save(a.projectId, {
              configYaml: 'x',
              configHash: HASH('e'),
              updatedBy: b.userId,
              expectedVersion: 1,
            }),
        ],
        ['conflict', () => a.scope.gitEventCursors.save(b.projectId, 'hijack')],
        [
          'version_conflict',
          () =>
            a.scope.projectConfigs.save(b.projectId, {
              configYaml: 'x',
              configHash: HASH('e'),
              updatedBy: null,
              expectedVersion: 0,
            }),
        ],
      ];
      for (const [code, attempt] of crossTenant) {
        await expect(attempt()).rejects.toMatchObject({ code });
      }
      expect((await b.scope.gitEventCursors.get(b.projectId))?.cursor).toBe('tenant-b-cursor-1');
      expect((await b.scope.projectConfigs.get(b.projectId))?.config_yaml).toBe('tenant: tenant-b');
      expect(await b.scope.roleBindings.listForProject(b.projectId)).toHaveLength(1);
    });

    it('the database rejects a cross-tenant row even when the guard is bypassed', async () => {
      await expect(
        sql`INSERT INTO role_bindings (tenant_id, user_id, project_id, role)
            VALUES (${a.tenantId}, ${b.userId}, ${a.projectId}, 'person_b')`.execute(t.appRaw),
      ).rejects.toMatchObject({ code: '23503' });
    });
  });

  describe('constraints and versioning', () => {
    it('unique within the tenant: project slug, email ignoring case, role binding', async () => {
      await expect(
        a.scope.projects.create({
          slug: 'shop',
          name: 'Again',
          git_provider: 'github',
          repo_full_name: 'x/y',
        }),
      ).rejects.toMatchObject({ code: 'conflict' });
      await expect(
        a.scope.users.create({ display_name: 'H', email: 'HARRY@example.COM' }),
      ).rejects.toMatchObject({
        code: 'conflict',
      });
      await expect(
        a.scope.roleBindings.grant({
          user_id: a.userId,
          project_id: a.projectId,
          role: 'person_a',
        }),
      ).rejects.toMatchObject({ code: 'conflict' });
    });

    it('token hashes are unique across tenants; raw tokens are never stored', async () => {
      await expect(
        b.scope.apiTokens.create({
          user_id: b.userId,
          name: 'copy',
          token_hash: hashApiToken(a.token),
          expires_at: new Date(Date.now() + DAY),
        }),
      ).rejects.toMatchObject({ code: 'conflict' });
      await expect(
        a.scope.apiTokens.create({
          user_id: a.userId,
          name: 'raw',
          token_hash: a.token,
          expires_at: new Date(Date.now() + DAY),
        }),
      ).rejects.toBeInstanceOf(DbError);
      const stored = await sql<Record<string, unknown>>`SELECT * FROM api_tokens`.execute(t.owner);
      const dump = JSON.stringify(stored.rows);
      expect(dump).not.toContain(a.token);
      expect(dump).not.toContain(b.token);
    });

    it('versioned save: N → N + 1, stale versions are rejected', async () => {
      const v1 = await a.scope.projectConfigs.get(a.projectId);
      expect(v1).toMatchObject({ version: 1, config_hash: HASH('a'), updated_by: a.userId });
      const v2 = await a.scope.projectConfigs.save(a.projectId, {
        configYaml: 'tenant: a, v2',
        configHash: HASH('f'),
        updatedBy: null,
        expectedVersion: 1,
      });
      expect(v2.version).toBe(2);
      await expect(
        a.scope.projectConfigs.save(a.projectId, {
          configYaml: 'stale',
          configHash: HASH('0'),
          updatedBy: null,
          expectedVersion: 1,
        }),
      ).rejects.toMatchObject({ code: 'version_conflict' });
      await expect(
        a.scope.projectConfigs.save(a.projectId, {
          configYaml: 'dup',
          configHash: HASH('0'),
          updatedBy: null,
          expectedVersion: 0,
        }),
      ).rejects.toMatchObject({ code: 'version_conflict' });
    });

    it('AI record round trip: data class array and date', async () => {
      const record = await a.scope.projectAiRecords.get(a.projectId);
      expect(record).toMatchObject({
        version: 1,
        allowed_data_classes: ['internal', 'client_confidential'],
        confirmed_at: '2026-09-24',
        prod_logs_allowed: 'yes_masked',
      });
      const v2 = await a.scope.projectAiRecords.save(a.projectId, {
        aiAllowed: 'no',
        allowedDataClasses: [],
        prodLogsAllowed: 'no',
        disclosureFormat: 'client_format',
        recordRef: null,
        actorType: 'human',
        confirmedAt: null,
        updatedBy: a.userId,
        expectedVersion: 1,
      });
      expect(v2).toMatchObject({ version: 2, allowed_data_classes: [], ai_allowed: 'no' });
      await expect(
        a.scope.projectAiRecords.save(a.projectId, {
          aiAllowed: 'yes',
          allowedDataClasses: ['not_a_class' as never],
          prodLogsAllowed: 'no',
          disclosureFormat: 'client_format',
          recordRef: null,
          actorType: 'human',
          confirmedAt: null,
          updatedBy: a.userId,
          expectedVersion: 2,
        }),
      ).rejects.toMatchObject({ code: 'invalid_input', field: 'allowed_data_classes' });
    });

    it('git event cursor: insert then update', async () => {
      const saved = await a.scope.gitEventCursors.save(a.projectId, 'tenant-a-cursor-2');
      expect(saved.cursor).toBe('tenant-a-cursor-2');
    });

    it('a transaction rolls back every write on error', async () => {
      await expect(
        a.scope.transaction(async (trx) => {
          await trx.users.create({ display_name: 'Temp', email: 'temp@example.com' });
          throw new Error('stop');
        }),
      ).rejects.toThrow('stop');
      expect(await a.scope.users.getByEmail('temp@example.com')).toBeUndefined();
    });
  });

  describe('role revocation (QUESTIONS #11)', () => {
    it('revoke hides the binding from default reads and keeps it as history', async () => {
      const user = await a.scope.users.create({
        display_name: 'Reviewer',
        email: 'rev@example.com',
      });
      const granted = await a.scope.roleBindings.grant({
        user_id: user.id,
        project_id: a.projectId,
        role: 'person_b',
      });
      expect(granted.revoked_at).toBeNull();

      const revoked = await a.scope.roleBindings.revoke(granted.id);
      expect(revoked?.revoked_at).toBeInstanceOf(Date);
      expect(await a.scope.roleBindings.getById(granted.id)).toBeUndefined();
      expect(await a.scope.roleBindings.listForUser(user.id)).toEqual([]);
      expect(
        (await a.scope.roleBindings.listForProject(a.projectId)).map((rb) => rb.id),
      ).not.toContain(granted.id);
      expect(
        await a.scope.roleBindings.getById(granted.id, { includeRevoked: true }),
      ).toMatchObject({ id: granted.id, revoked_at: revoked!.revoked_at });
      // Already revoked: nothing to do.
      expect(await a.scope.roleBindings.revoke(granted.id)).toBeUndefined();
    });

    it('the same role can be granted again after revocation, but not twice while active', async () => {
      const user = await a.scope.users.create({
        display_name: 'Again',
        email: 'again@example.com',
      });
      const grant = () =>
        a.scope.roleBindings.grant({ user_id: user.id, project_id: a.projectId, role: 'person_b' });
      const first = await grant();
      await expect(grant()).rejects.toMatchObject({ code: 'conflict' });
      await a.scope.roleBindings.revoke(first.id);
      const second = await grant();
      expect(second.id).not.toBe(first.id);
      expect((await a.scope.roleBindings.listForUser(user.id)).map((rb) => rb.id)).toEqual([
        second.id,
      ]);
      expect(
        await a.scope.roleBindings.listForUser(user.id, { includeRevoked: true }),
      ).toHaveLength(2);
    });

    it('tenant A cannot revoke a tenant B binding', async () => {
      expect(await a.scope.roleBindings.revoke(b.bindingId)).toBeUndefined();
      expect(
        await a.scope.roleBindings.getById(b.bindingId, { includeRevoked: true }),
      ).toBeUndefined();
      expect((await b.scope.roleBindings.getById(b.bindingId))?.revoked_at).toBeNull();
    });

    it('the database allows only revoked_at to change, and never before creation', async () => {
      await expect(
        sql`UPDATE role_bindings SET role = 'admin' WHERE id = ${a.bindingId}`.execute(t.appRaw),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        sql`UPDATE role_bindings SET revoked_at = created_at - interval '1 day'
            WHERE id = ${a.bindingId}`.execute(t.appRaw),
      ).rejects.toMatchObject({ code: '23514' });
    });
  });

  describe('system scope', () => {
    it('resolves an API token hash to its tenant and user', async () => {
      expect(await t.app.system.resolveApiToken(hashApiToken(b.token))).toEqual({
        tenantId: b.tenantId,
        userId: b.userId,
        tokenId: b.tokenId,
        tenantStatus: 'active',
      });
      expect(await t.app.system.resolveApiToken(hashApiToken('unknown'))).toBeUndefined();
      await expect(t.app.system.resolveApiToken(b.token)).rejects.toMatchObject({
        code: 'invalid_value',
      });
    });

    it('does not resolve expired or revoked tokens, or tokens of disabled users', async () => {
      const later = new Date(Date.now() + 2 * DAY);
      expect(await t.app.system.resolveApiToken(hashApiToken(a.token), later)).toBeUndefined();
      const user = await a.scope.users.create({ display_name: 'Dev', email: 'dev@example.com' });
      const token = await a.scope.apiTokens.create({
        user_id: user.id,
        name: 'dev',
        token_hash: hashApiToken('dev-token'),
        expires_at: new Date(Date.now() + DAY),
      });
      expect(await t.app.system.resolveApiToken(hashApiToken('dev-token'))).toBeDefined();
      await a.scope.users.setStatus(user.id, 'disabled');
      expect(await t.app.system.resolveApiToken(hashApiToken('dev-token'))).toBeUndefined();
      await a.scope.users.setStatus(user.id, 'active');
      const revoked = await a.scope.apiTokens.revoke(token.id);
      expect(revoked?.revoked_at).toBeInstanceOf(Date);
      expect(await t.app.system.resolveApiToken(hashApiToken('dev-token'))).toBeUndefined();
    });

    it('tenant slugs are unique; numeric budgets keep full precision', async () => {
      await expect(
        t.app.system.createTenant({ slug: 'tenant-a', name: 'Dup' }),
      ).rejects.toMatchObject({
        code: 'conflict',
      });
      expect((await t.app.system.getTenant(a.tenantId))?.monthly_budget_usd).toBe('100.500000');
      expect((await t.app.system.getTenantBySlug('tenant-b'))?.id).toBe(b.tenantId);
    });
  });
});
