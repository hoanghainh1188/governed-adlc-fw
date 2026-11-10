// D-08 B13 PR 1 on a live PostgreSQL, through the Nest app and Fastify `inject()` (no port):
// AC1 tenant admins (QUESTIONS #150), AC2 projects, users, identities and project roles, every
// change audited with IDs and codes only, roles revoked through `revoked_at`; AC3 identities by
// numeric account ID; AC4 configuration upload; AC6 cross-tenant isolation, wrong roles refused,
// audit chain intact; separation of duties (QUESTIONS #151, #154).
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { t, type MessageKey } from '@sdlc/messages';

import { createApp, type ApiDeps } from '../../../apps/api/src/app.js';
import { bootstrapTenant } from '../../../packages/core/src/admin/bootstrap.js';
import { issueApiToken } from '../../../packages/core/src/admin/tokens.js';
import { parseTenantId } from '../../../packages/core/src/db/tenant-id.js';
import type { TenantScope } from '../../../packages/core/src/db/tenant-scope.js';
import { createJsonLogger } from '../../../packages/core/src/observability/index.js';
import { tokenIssuedAt } from '../token-clock.js';
import { createTestDatabase, describeDb, type TestDatabase } from './helpers.js';

type App = Awaited<ReturnType<typeof createApp>>;
const asApiDb = (db: TestDatabase): ApiDeps['db'] => db.app as unknown as ApiDeps['db'];

const NOW = new Date('2026-10-03T03:00:00.000Z');

interface Body {
  readonly [field: string]: unknown;
  readonly id: string;
  readonly items: readonly Record<string, unknown>[];
  readonly warnings: readonly { key: string; path: string; message: string }[];
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly reason?: string;
    readonly details?: readonly { path: string; issue: string; message?: string }[];
  };
}

interface Reply {
  readonly statusCode: number;
  json(): Body;
}

interface Tenant {
  readonly slug: string;
  readonly scope: TenantScope;
  readonly adminId: string;
  readonly adminToken: string;
}

describeDb('B13: admin onboarding on PostgreSQL', () => {
  let t0: TestDatabase;
  let app: App;
  const lines: string[] = [];
  let a: Tenant;
  let b: Tenant;

  const inject = async (
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    token: string,
    body?: unknown,
  ): Promise<Reply> =>
    await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method,
        url,
        headers: { authorization: `Bearer ${token}` },
        ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
      });

  const ok = (reply: Reply, status = 200): Body => {
    expect(reply.statusCode, JSON.stringify(reply.json())).toBe(status);
    return reply.json();
  };

  const refused = (reply: Reply, status: number, code: string): Body['error'] => {
    expect(reply.statusCode, JSON.stringify(reply.json())).toBe(status);
    const error = reply.json().error;
    expect(error.code).toBe(code);
    expect(error.message).toBe(t(`api.error.${code}` as MessageKey));
    return error;
  };

  async function seedTenant(slug: string): Promise<Tenant> {
    const result = await bootstrapTenant(t0.app, {
      tenantSlug: slug,
      tenantName: slug,
      adminEmail: `admin@${slug}.example.com`,
      adminName: `Admin ${slug}`,
      now: tokenIssuedAt(),
    });
    return {
      slug,
      scope: t0.app.forTenant(parseTenantId(result.tenant.id)),
      adminId: result.user.id,
      adminToken: result.token.token,
    };
  }

  /** A user created through the API, with a token issued on the server. */
  async function person(tenant: Tenant, key: string): Promise<{ id: string; token: string }> {
    const created = ok(
      await inject('POST', '/v1/admin/users', tenant.adminToken, {
        email: `${key}@${tenant.slug}.example.com`,
        display_name: `Person ${key}`,
      }),
      201,
    );
    const issued = await issueApiToken(tenant.scope, {
      userId: created.id,
      name: key,
      now: tokenIssuedAt(),
    });
    return { id: created.id, token: issued.token };
  }

  const project = async (tenant: Tenant, slug: string): Promise<Body> =>
    ok(
      await inject('POST', '/v1/admin/projects', tenant.adminToken, {
        slug,
        name: `Project ${slug}`,
        repo_full_name: `org/${slug}`,
      }),
      201,
    );

  const grant = (tenant: Tenant, token: string, slug: string, userId: string, role: string) =>
    inject('POST', `/v1/admin/projects/${slug}/roles`, token, { user_id: userId, role });

  const audit = async (tenant: Tenant) =>
    (
      await sql<{ action: string; actor_type: string; payload: Record<string, unknown> }>`
        SELECT action, actor_type, payload FROM audit_log WHERE tenant_id = ${tenant.scope.tenantId}
        ORDER BY seq`.execute(t0.owner)
    ).rows;

  beforeAll(async () => {
    t0 = await createTestDatabase();
    a = await seedTenant('acme');
    b = await seedTenant('beta');
    app = await createApp({
      db: asApiDb(t0),
      settings: { rateLimitPerMinute: 10_000, authFailuresPerMinute: 1000 },
      now: () => NOW,
      logger: { error: (...args: unknown[]) => lines.push(args.map(String).join(' ')) },
      log: createJsonLogger({ write: (line) => lines.push(line) }),
    });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await t0?.drop();
  });

  describe('AC1: tenant admins', () => {
    it('the bootstrap makes the first user a tenant admin; /v1/me says so', async () => {
      expect(ok(await inject('GET', '/v1/me', a.adminToken)).tenant_admin).toBe(true);
      const other = await person(a, 'plain');
      expect(ok(await inject('GET', '/v1/me', other.token)).tenant_admin).toBe(false);
    });

    it('a person without the role uses no admin endpoint', async () => {
      const other = await person(a, 'nobody');
      refused(await inject('GET', '/v1/admin/projects', other.token), 403, 'forbidden');
      refused(await inject('GET', '/v1/admin/users', other.token), 403, 'forbidden');
      refused(await inject('GET', '/v1/admin/tenant-admins', other.token), 403, 'forbidden');
      refused(
        await inject('POST', '/v1/admin/tenant-admins', other.token, { user_id: other.id }),
        403,
        'forbidden',
      );
    });

    it('nobody grants the role to themselves; the last tenant admin is never removed', async () => {
      refused(
        await inject('POST', '/v1/admin/tenant-admins', a.adminToken, { user_id: a.adminId }),
        403,
        'self_action',
      );
      const own = ok(await inject('GET', '/v1/admin/tenant-admins', a.adminToken)).items;
      expect(own).toHaveLength(1);
      refused(
        await inject('DELETE', `/v1/admin/tenant-admins/${String(own[0]!.id)}`, a.adminToken),
        409,
        'last_tenant_admin',
      );
      refused(
        await inject('POST', `/v1/admin/users/${a.adminId}/disable`, a.adminToken),
        403,
        'self_action',
      );
    });

    it('a second admin can be granted; then two revocations at once leave one admin', async () => {
      const second = await person(a, 'second-admin');
      const granted = ok(
        await inject('POST', '/v1/admin/tenant-admins', a.adminToken, { user_id: second.id }),
        201,
      );
      refused(
        await inject('POST', '/v1/admin/tenant-admins', a.adminToken, { user_id: second.id }),
        409,
        'already_exists',
      );
      const first = ok(await inject('GET', '/v1/admin/tenant-admins', a.adminToken)).items.find(
        (row) => row.user_id === a.adminId,
      )!;
      // Each admin removes the other at the same time: only one may succeed. The other is refused
      // in one of two correct ways, depending on timing: 409 `last_tenant_admin` when both pass the
      // access check before either commits, or 403 `forbidden` when the winner commits first and
      // the loser is no longer a tenant admin when its request is checked.
      const replies = await Promise.all([
        inject('DELETE', `/v1/admin/tenant-admins/${String(first.id)}`, second.token),
        inject('DELETE', `/v1/admin/tenant-admins/${granted.id}`, a.adminToken),
      ]);
      const winner = replies.findIndex((reply) => reply.statusCode === 200);
      expect(winner, JSON.stringify(replies.map((reply) => reply.statusCode))).not.toBe(-1);
      const loser = replies[1 - winner]!;
      if (loser.statusCode === 403) refused(loser, 403, 'forbidden');
      else refused(loser, 409, 'last_tenant_admin');
      // Put the tenant back in its start state: the original admin stays, the second goes.
      if (winner === 0) {
        const back = ok(
          await inject('POST', '/v1/admin/tenant-admins', second.token, { user_id: a.adminId }),
          201,
        );
        expect(back.user_id).toBe(a.adminId);
        ok(await inject('DELETE', `/v1/admin/tenant-admins/${granted.id}`, a.adminToken));
      }
      const rows = ok(
        await inject('GET', '/v1/admin/tenant-admins?include_revoked=true', a.adminToken),
      ).items;
      expect(rows.filter((row) => row.revoked_at === null).map((row) => row.user_id)).toEqual([
        a.adminId,
      ]);
    });

    it('a revoked tenant role never changes again (SDA11)', async () => {
      const revoked = await a.scope.tenantRoles.list({ includeRevoked: true });
      const row = revoked.find((binding) => binding.revoked_at !== null)!;
      await expect(
        sql`UPDATE tenant_role_bindings SET revoked_at = now() WHERE id = ${row.id}`.execute(
          t0.appRaw,
        ),
      ).rejects.toMatchObject({ code: 'SDA11' });
    });
  });

  describe('AC2: projects and users', () => {
    it('creates, lists, changes and archives a project', async () => {
      const created = await project(a, 'shop');
      expect(created).toMatchObject({ slug: 'shop', git_provider: 'github', status: 'active' });
      refused(
        await inject('POST', '/v1/admin/projects', a.adminToken, {
          slug: 'shop',
          name: 'Again',
          repo_full_name: 'org/again',
        }),
        409,
        'already_exists',
      );
      const bad = refused(
        await inject('POST', '/v1/admin/projects', a.adminToken, {
          slug: 'bad',
          name: 'Bad',
          repo_full_name: 'no-slash',
        }),
        400,
        'invalid_request',
      );
      expect(bad.details).toEqual([{ path: 'body.repo_full_name', issue: 'invalid' }]);
      const changed = ok(
        await inject('PATCH', '/v1/admin/projects/shop', a.adminToken, { default_branch: 'trunk' }),
      );
      expect(changed.default_branch).toBe('trunk');
      expect(ok(await inject('GET', '/v1/admin/projects', a.adminToken)).items).toHaveLength(1);
      await project(a, 'old');
      expect(ok(await inject('POST', '/v1/admin/projects/old/archive', a.adminToken)).status).toBe(
        'archived',
      );
      refused(
        await inject('POST', '/v1/admin/projects/old/archive', a.adminToken),
        409,
        'project_archived',
      );
    });

    it('creates and changes users; a disabled user’s token stops working at once', async () => {
      const user = await person(a, 'dana');
      refused(
        await inject('POST', '/v1/admin/users', a.adminToken, {
          email: 'DANA@acme.example.com',
          display_name: 'Dana again',
        }),
        409,
        'already_exists',
      );
      const renamed = ok(
        await inject('PATCH', `/v1/admin/users/${user.id}`, a.adminToken, { display_name: 'Dana' }),
      );
      expect(renamed).toMatchObject({ display_name: 'Dana', tenant_admin: false });
      ok(await inject('GET', '/v1/me', user.token));
      expect(
        ok(await inject('POST', `/v1/admin/users/${user.id}/disable`, a.adminToken)).status,
      ).toBe('disabled');
      refused(await inject('GET', '/v1/me', user.token), 401, 'unauthorized');
      ok(await inject('POST', `/v1/admin/users/${user.id}/enable`, a.adminToken));
      ok(await inject('GET', '/v1/me', user.token));
    });
  });

  describe('AC3: Git host identities by numeric account ID', () => {
    it('links by ID, refuses a login, and unlinks without deleting', async () => {
      const user = await person(a, 'gh');
      const path = `/v1/admin/users/${user.id}/identities`;
      refused(
        await inject('POST', path, a.adminToken, { external_id: 'octocat', external_login: 'o' }),
        400,
        'invalid_request',
      );
      const linked = ok(
        await inject('POST', path, a.adminToken, {
          external_id: '583231',
          external_login: 'octocat',
        }),
        201,
      );
      expect(await a.scope.userIdentities.findByExternalId('github', '583231')).toMatchObject({
        user_id: user.id,
      });
      // The same account cannot belong to two people of the tenant.
      const other = await person(a, 'gh2');
      refused(
        await inject('POST', `/v1/admin/users/${other.id}/identities`, a.adminToken, {
          external_id: '583231',
          external_login: 'octocat',
        }),
        409,
        'already_exists',
      );
      ok(await inject('DELETE', `${path}/${linked.id}`, a.adminToken));
      expect(await a.scope.userIdentities.findByExternalId('github', '583231')).toBeUndefined();
      expect(ok(await inject('GET', path, a.adminToken)).items).toEqual([]);
      expect(
        ok(await inject('GET', `${path}?include_unlinked=true`, a.adminToken)).items,
      ).toHaveLength(1);
      // Unlinked, it can be linked to the other person.
      ok(
        await inject('POST', `/v1/admin/users/${other.id}/identities`, a.adminToken, {
          external_id: '583231',
          external_login: 'octocat',
        }),
        201,
      );
      refused(
        await inject('DELETE', `${path}/${linked.id}`, a.adminToken),
        404,
        'identity_not_found',
      );
      // H03a / ADR-M97: an unlinked identity may still have its login scrubbed; other columns stay
      // final (SDA11). The owner role is used so the trigger, not the column grant, is what refuses.
      await sql`UPDATE user_identities SET external_login = 'redacted-login'
                 WHERE id = ${linked.id}`.execute(t0.appRaw);
      await expect(
        sql`UPDATE user_identities SET external_id = '9999' WHERE id = ${linked.id}`.execute(
          t0.owner,
        ),
      ).rejects.toMatchObject({ code: 'SDA11' });
    });

    it('the database refuses a login in external_id', async () => {
      await expect(
        a.scope.userIdentities.link({
          user_id: a.adminId,
          provider: 'github',
          external_id: 'octocat',
          external_login: 'octocat',
        }),
      ).rejects.toMatchObject({ code: 'invalid_value' });
    });
  });

  describe('AC2: project roles and separation of duties', () => {
    it('grants, refuses self-grants and conflicting pairs, revokes through revoked_at', async () => {
      await project(a, 'roles');
      const ann = await person(a, 'ann');
      const bob = await person(a, 'bob');
      const granted = ok(await grant(a, a.adminToken, 'roles', ann.id, 'person_a'), 201);
      refused(await grant(a, a.adminToken, 'roles', ann.id, 'person_a'), 409, 'already_exists');
      const conflict = refused(
        await grant(a, a.adminToken, 'roles', ann.id, 'person_b'),
        409,
        'conflicting_role',
      );
      expect(conflict.reason).toBe('person_a');
      ok(await grant(a, a.adminToken, 'roles', bob.id, 'person_b'), 201);
      refused(
        await grant(a, a.adminToken, 'roles', bob.id, 'second_approver'),
        409,
        'conflicting_role',
      );
      refused(await grant(a, a.adminToken, 'roles', a.adminId, 'viewer'), 403, 'self_action');

      const revoked = ok(
        await inject(
          'DELETE',
          `/v1/admin/projects/roles/roles/${String(granted.id)}`,
          a.adminToken,
        ),
      );
      // The database clock sets it, like `created_at`: app and database clocks may differ.
      expect(revoked.revoked_at).toEqual(expect.any(String));
      const history = ok(
        await inject('GET', '/v1/admin/projects/roles/roles?include_revoked=true', a.adminToken),
      ).items;
      expect(history.find((row) => row.id === granted.id)?.revoked_at).toBe(revoked.revoked_at);
      // Revoked, Person A no longer conflicts.
      ok(await grant(a, a.adminToken, 'roles', ann.id, 'person_b'), 201);
    });

    it('the project role admin manages the project’s roles, nothing else', async () => {
      await project(a, 'team');
      const lead = await person(a, 'lead');
      const dev = await person(a, 'dev');
      const outsider = await person(a, 'outsider');
      ok(await grant(a, a.adminToken, 'team', lead.id, 'admin'), 201);
      ok(await grant(a, a.adminToken, 'team', dev.id, 'viewer'), 201);
      ok(await grant(a, lead.token, 'team', dev.id, 'person_a'), 201);
      refused(await grant(a, lead.token, 'team', lead.id, 'person_b'), 403, 'self_action');
      refused(await grant(a, dev.token, 'team', outsider.id, 'viewer'), 403, 'forbidden');
      expect(ok(await inject('GET', '/v1/admin/projects/team/roles', dev.token)).items.length).toBe(
        3,
      );
      refused(
        await inject('GET', '/v1/admin/projects/team/roles', outsider.token),
        404,
        'project_not_found',
      );
      refused(await inject('GET', '/v1/admin/projects/team', lead.token), 403, 'forbidden');
      refused(
        await inject('POST', '/v1/admin/projects', lead.token, {
          slug: 'mine',
          name: 'Mine',
          repo_full_name: 'org/mine',
        }),
        403,
        'forbidden',
      );
    });

    it('refuses roles on an archived project and for a disabled user', async () => {
      const user = await person(a, 'late');
      refused(await grant(a, a.adminToken, 'old', user.id, 'viewer'), 409, 'project_archived');
      ok(await inject('POST', `/v1/admin/users/${user.id}/disable`, a.adminToken));
      refused(await grant(a, a.adminToken, 'shop', user.id, 'viewer'), 409, 'user_not_active');
    });
  });

  describe('AC4: project configuration upload', () => {
    const path = '/v1/admin/projects/conf/config';

    it('shows the defaults, then stores a valid YAML with its warnings', async () => {
      await project(a, 'conf');
      const defaults = ok(await inject('GET', path, a.adminToken));
      expect(defaults).toMatchObject({ version: 0, config_yaml: '', override_sha256: null });
      const yaml =
        '# a comment\noversight:\n  matrix:\n    G2:\n      medium: { mode: HOTL, roles: [person_a], approvals: 1 }\n';
      const saved = ok(
        await inject('PUT', path, a.adminToken, { expected_version: 0, config_yaml: yaml }),
      );
      expect(saved).toMatchObject({ version: 1, config_yaml: yaml, updated_by: a.adminId });
      expect(saved.warnings.map((w) => [w.key, w.path])).toEqual([
        ['config.warning.mode_loosened', 'oversight.matrix.G2.medium.mode'],
      ]);
      expect(saved.warnings[0]!.message).toContain('oversight.matrix.G2.medium.mode');
      const event = (await audit(a)).filter((row) => row.action === 'config.changed').at(-1)!;
      expect(event.payload).toEqual({
        version: 1,
        config_hash: saved.config_hash,
        override_sha256: saved.override_sha256,
        cause: 'upload',
        warning_count: 1,
        warnings: ['mode_loosened:oversight.matrix.G2.medium.mode'],
      });
      expect(JSON.stringify(event.payload)).not.toContain('comment');
    });

    it('refuses a breach of a mandatory rule with the rule of each line', async () => {
      const error = refused(
        await inject('PUT', path, a.adminToken, {
          expected_version: 1,
          config_yaml: 'access:\n  conflicting_roles: []\n',
        }),
        422,
        'config_rejected',
      );
      expect(error.details).toHaveLength(1);
      expect(error.details?.[0]).toMatchObject({
        path: 'body.config_yaml.access.conflicting_roles',
        issue: 'config.rule.person_a_person_b_conflict',
      });
      expect(error.details?.[0]?.message).toContain('rule M21');
    });

    it('refuses a stale version, a viewer, a stranger and an oversized YAML', async () => {
      refused(
        await inject('PUT', path, a.adminToken, { expected_version: 0, config_yaml: '' }),
        409,
        'config_version_conflict',
      );
      const viewer = await person(a, 'conf-viewer');
      ok(await grant(a, a.adminToken, 'conf', viewer.id, 'viewer'), 201);
      expect(ok(await inject('GET', path, viewer.token)).version).toBe(1);
      refused(
        await inject('PUT', path, viewer.token, { expected_version: 1, config_yaml: '' }),
        403,
        'forbidden',
      );
      const stranger = await person(a, 'conf-stranger');
      refused(await inject('GET', path, stranger.token), 404, 'project_not_found');
      refused(
        await inject('PUT', path, a.adminToken, {
          expected_version: 1,
          config_yaml: `# ${'x'.repeat(33 * 1024)}\n`,
        }),
        400,
        'invalid_request',
      );
    });

    it('a conflicting pair from the stored configuration is enforced', async () => {
      ok(
        await inject('PUT', path, a.adminToken, {
          expected_version: 1,
          config_yaml: 'access:\n  conflicting_roles: [[person_a, person_b], [pm_brse, viewer]]\n',
        }),
      );
      const pm = await person(a, 'conf-pm');
      ok(await grant(a, a.adminToken, 'conf', pm.id, 'pm_brse'), 201);
      refused(await grant(a, a.adminToken, 'conf', pm.id, 'viewer'), 409, 'conflicting_role');
      // The pair person_b + second_approver is not in this project's list.
      const pb = await person(a, 'conf-pb');
      ok(await grant(a, a.adminToken, 'conf', pb.id, 'person_b'), 201);
      ok(await grant(a, a.adminToken, 'conf', pb.id, 'second_approver'), 201);
    });
  });

  describe('AC6: tenant isolation', () => {
    it('another tenant’s admin sees none of this tenant’s objects', async () => {
      await project(b, 'beta-only');
      const roles = await a.scope.roleBindings.listForProject(
        (await a.scope.projects.getBySlug('roles'))!.id,
      );
      const identity = (await a.scope.userIdentities.listForUser(a.adminId)).at(0);
      const adminRow = (await a.scope.tenantRoles.list())[0]!;
      refused(
        await inject('GET', '/v1/admin/projects/shop', b.adminToken),
        404,
        'project_not_found',
      );
      refused(
        await inject('PUT', '/v1/admin/projects/shop/config', b.adminToken, {
          expected_version: 0,
          config_yaml: '',
        }),
        404,
        'project_not_found',
      );
      refused(
        await inject('GET', `/v1/admin/users/${a.adminId}`, b.adminToken),
        404,
        'user_not_found',
      );
      refused(
        await inject('POST', `/v1/admin/users/${a.adminId}/disable`, b.adminToken),
        404,
        'user_not_found',
      );
      refused(
        await inject('POST', '/v1/admin/projects/beta-only/roles', b.adminToken, {
          user_id: a.adminId,
          role: 'viewer',
        }),
        404,
        'user_not_found',
      );
      refused(
        await inject('DELETE', `/v1/admin/projects/beta-only/roles/${roles[0]!.id}`, b.adminToken),
        404,
        'role_binding_not_found',
      );
      refused(
        await inject('DELETE', `/v1/admin/tenant-admins/${adminRow.id}`, b.adminToken),
        404,
        'role_binding_not_found',
      );
      if (identity) {
        refused(
          await inject(
            'DELETE',
            `/v1/admin/users/${b.adminId}/identities/${identity.id}`,
            b.adminToken,
          ),
          404,
          'identity_not_found',
        );
      }
      const users = ok(await inject('GET', '/v1/admin/users', b.adminToken)).items;
      expect(users.map((user) => user.id)).toEqual([b.adminId]);
      expect(
        ok(await inject('GET', '/v1/admin/projects', b.adminToken)).items.map((p) => p.slug),
      ).toEqual(['beta-only']);
    });
  });

  describe('AC2, AC6: audit', () => {
    it('every change is audited with IDs and codes only, and both chains verify', async () => {
      const rows = await audit(a);
      const actions = new Set(rows.map((row) => row.action));
      for (const action of [
        'tenant_role.granted',
        'tenant_role.revoked',
        'project.created',
        'project.updated',
        'project.archived',
        'user.created',
        'user.updated',
        'user.disabled',
        'user.enabled',
        'identity.linked',
        'identity.unlinked',
        'role.granted',
        'role.revoked',
        'config.changed',
      ]) {
        expect(actions, action).toContain(action);
      }
      // Only the bootstrap and the tokens issued on the server are the operator's (`system`);
      // every admin change through the API names the person who made it.
      expect(
        new Set(rows.filter((row) => row.actor_type === 'system').map((row) => row.action)),
      ).toEqual(
        new Set(['tenant.created', 'user.created', 'tenant_role.granted', 'api_token.issued']),
      );
      expect(
        rows.filter((row) => row.action === 'user.created' && row.actor_type === 'system'),
      ).toHaveLength(1);
      const dump = JSON.stringify(rows);
      for (const secret of ['@acme.example.com', 'Person', 'octocat', '583231', 'org/', 'trunk']) {
        expect(dump, secret).not.toContain(secret);
      }
      expect((await a.scope.audit.verify()).broken).toBeUndefined();
      expect((await b.scope.audit.verify()).broken).toBeUndefined();
    });

    it('no log line holds a token', () => {
      const all = lines.join('\n');
      expect(all).not.toMatch(/sdlc_pat_/);
    });
  });
});
