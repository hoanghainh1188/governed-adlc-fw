// D-08 U09 PR 1 on PostgreSQL, through the Nest app (design/ADR-M73 §2.4b, MVP1-UI-SCOPE §3.4,
// QUESTIONS #681–#685): the administration changes a dashboard session may send, with a software
// passkey.
// - every change of a session needs the passkey step-up (AC3), the containment ones too (#681);
//   with the actions switch off they are refused; the token routes stay refused to sessions (#684);
// - the step-up is bound to the area, the change, the path and the body: another body, another
//   path, another area or a used answer is refused; a refused change leaves the challenge unused;
// - a token (the CLI) writes as before, and may not send `step_up`;
// - the API still decides: a self-grant and Person A = Person B are refused through a session
//   (AC1, M21); the actor is the person's user ID and no session or challenge ID reaches the audit
//   log.
import { createSimplePolicyEngine } from '@sdlc/adapter-policy-simple';
import { t, type MessageKey } from '@sdlc/messages';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { WebSignInProvider } from '../../../packages/contracts/src/index.js';
import { createApp, type ApiDeps } from '../../../apps/api/src/app.js';
import type { WebSignInSettings } from '../../../apps/api/src/settings.js';
import { bootstrapTenant } from '../../../packages/core/src/admin/bootstrap.js';
import { parseTenantId } from '../../../packages/core/src/db/tenant-id.js';
import type { TenantScope } from '../../../packages/core/src/db/tenant-scope.js';
import { deriveCsrfToken, startWebSession } from '../../../packages/core/src/web-sessions/index.js';
import { SoftAuthenticator } from '../../passkeys/soft-authenticator.js';
import { tokenIssuedAt } from '../token-clock.js';
import { createTestDatabase, describeDb, type TestDatabase } from './helpers.js';

type App = Awaited<ReturnType<typeof createApp>>;
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
const MIN = 60_000;
const ORIGIN = 'http://localhost:8090';
const SETTINGS: WebSignInSettings = {
  publicOrigin: ORIGIN,
  callbackUrl: `${ORIGIN}/v1/auth/github/callback`,
  githubWebUrl: 'https://github.com',
  githubApiUrl: 'https://api.github.com',
  oauthSecretPath: 'api/github-oauth',
  idleMs: 30 * MIN,
  maxAgeMs: 8 * 60 * MIN,
  actions: true,
};
const NO_GITHUB: WebSignInProvider = {
  authorizeUrl: () => Promise.reject(new Error('not used')),
  exchangeCode: () => Promise.reject(new Error('not used')),
  accountId: () => Promise.reject(new Error('not used')),
  revokeToken: () => Promise.resolve(),
};
const UUID = '00000000-0000-4000-8000-000000000000';
const AI_RECORD = {
  expected_version: 0,
  ai_allowed: 'yes',
  allowed_data_classes: ['internal'],
  prod_logs_allowed: 'no',
  disclosure_format: 'standard_note',
};

interface Reply {
  readonly statusCode: number;
  readonly body: string;
  json(): Record<string, unknown> & { error?: { code: string; message: string } };
}
interface Session {
  readonly id: string;
  readonly secret: string;
  readonly csrf: string;
  readonly userId: string;
  readonly identityId: string;
  /** The person's own software passkey. */
  readonly key: SoftAuthenticator;
}
interface Answer {
  readonly challenge_id: string;
  readonly response: unknown;
}

describeDb('U09 PR 1: administration changes from a dashboard session', () => {
  let db: TestDatabase;
  let app: App;
  let off: App;
  let scope: TenantScope;
  let adminId: string;
  let adminToken: string;
  let admin: Session;
  let ann: Session;
  let annId: string;
  let bobId: string;
  const sessions: Session[] = [];

  const inject = async (
    target: App,
    method: Method,
    url: string,
    headers: Record<string, string>,
    payload?: unknown,
  ): Promise<Reply> =>
    await target
      .getHttpAdapter()
      .getInstance()
      .inject({
        method,
        url,
        headers,
        ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
      });
  const page = (s: Session) => ({
    cookie: `__Host-sdlc_session=${s.secret}`,
    'x-sdlc-csrf': s.csrf,
    origin: ORIGIN,
    'sec-fetch-site': 'same-origin',
  });
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  const expectError = (reply: Reply, status: number, code: string) => {
    expect(reply.statusCode, reply.body).toBe(status);
    expect(reply.json().error?.code).toBe(code);
    expect(reply.json().error?.message).toBe(t(`api.error.${code}` as MessageKey));
  };

  async function start(
    userId: string,
    identityId: string,
    key: SoftAuthenticator,
  ): Promise<Session> {
    const started = await startWebSession(scope, {
      userId,
      identityId,
      now: new Date(),
      maxAgeMs: SETTINGS.maxAgeMs,
    });
    const session = {
      id: started.session.id,
      secret: started.secret,
      csrf: deriveCsrfToken(started.secret),
      userId,
      identityId,
      key,
    };
    sessions.push(session);
    return session;
  }

  /**
   * A new session of the same person with the same passkey: a session holds at most 5 open
   * challenges, and a refused change leaves its challenge open.
   */
  const again = (s: Session): Promise<Session> => start(s.userId, s.identityId, s.key);

  async function open(userId: string, account: string): Promise<Session> {
    const identity = await scope.userIdentities.link({
      user_id: userId,
      provider: 'github',
      external_id: account,
      external_login: `u${account}`,
    });
    const session = await start(userId, identity.id, new SoftAuthenticator({ origin: ORIGIN }));
    const options = await inject(
      app,
      'POST',
      '/v1/me/passkeys/registration-options',
      page(session),
    );
    const body = options.json() as { challenge_id: string; options: { challenge: string } };
    const registered = await inject(app, 'POST', '/v1/me/passkeys', page(session), {
      challenge_id: body.challenge_id,
      response: session.key.register(body.options as never),
    });
    expect(registered.statusCode, registered.body).toBe(201);
    return session;
  }

  /** The step-up answer for a change: `request` is the body with `decision` and `target`. */
  async function stepUp(
    s: Session,
    action: string,
    request: Record<string, unknown>,
  ): Promise<Answer> {
    const reply = await inject(app, 'POST', '/v1/auth/step-up', page(s), { action, request });
    expect(reply.statusCode, reply.body).toBe(200);
    const body = reply.json() as { challenge_id: string; options: { challenge: string } };
    return { challenge_id: body.challenge_id, response: s.key.authenticate(body.options) };
  }

  /** Sends a change from a session with a step-up bound to exactly that change. */
  async function change(
    s: Session,
    method: Method,
    url: string,
    action: string,
    decision: string,
    body: Record<string, unknown> = {},
  ): Promise<Reply> {
    const answer = await stepUp(s, action, { ...body, decision, target: url });
    return inject(app, method, url, page(s), { ...body, step_up: answer });
  }

  const auditRows = async () =>
    (
      await sql<{ action: string; actor_id: string | null; payload: unknown }>`
        SELECT action, actor_id, payload FROM audit_log WHERE tenant_id = ${scope.tenantId}
        ORDER BY seq`.execute(db.owner)
    ).rows;

  beforeAll(async () => {
    db = await createTestDatabase();
    const boot = await bootstrapTenant(db.app, {
      tenantSlug: 'acme',
      tenantName: 'acme',
      adminEmail: 'admin@acme.example.com',
      adminName: 'Admin',
      now: tokenIssuedAt(),
    });
    scope = db.app.forTenant(parseTenantId(boot.tenant.id));
    adminId = boot.user.id;
    adminToken = boot.token.token;
    const base = {
      db: db.app as unknown as ApiDeps['db'],
      settings: { rateLimitPerMinute: 10_000, authFailuresPerMinute: 1000 },
    };
    app = await createApp({
      ...base,
      webSignIn: {
        settings: SETTINGS,
        provider: NO_GITHUB,
        limits: { starts: 10_000, callbacks: 10_000, passkeys: 10_000 },
      },
    });
    off = await createApp({
      ...base,
      webSignIn: { settings: { ...SETTINGS, actions: false }, provider: NO_GITHUB },
    });
    const created = async (body: Record<string, unknown>, url: string) => {
      const reply = await inject(app, 'POST', url, bearer(adminToken), body);
      expect(reply.statusCode, reply.body).toBe(201);
      return String(reply.json().id);
    };
    await created({ slug: 'shop', name: 'Shop', repo_full_name: 'org/shop' }, '/v1/admin/projects');
    annId = await created(
      { email: 'ann@acme.example.com', display_name: 'Ann' },
      '/v1/admin/users',
    );
    bobId = await created(
      { email: 'bob@acme.example.com', display_name: 'Bob' },
      '/v1/admin/users',
    );
    await created({ user_id: annId, role: 'person_a' }, '/v1/admin/projects/shop/roles');
    admin = await open(adminId, '4001');
    ann = await open(annId, '4002');
  }, 60_000);

  beforeEach(async () => {
    admin = await again(admin);
    ann = await again(ann);
  });

  afterAll(async () => {
    await app?.close();
    await off?.close();
    await db?.drop();
  });

  describe('AC3: every change of a session needs the step-up', () => {
    // Every route U09 opens to sessions, with a body of the right shape: without `step_up` each
    // answers 403 `step_up_refused` before any change.
    const routes: readonly [Method, string, Record<string, unknown>][] = [
      ['POST', '/v1/admin/projects', { slug: 'x', name: 'X', repo_full_name: 'org/x' }],
      ['PATCH', '/v1/admin/projects/shop', { name: 'Shop 2' }],
      ['POST', '/v1/admin/projects/shop/archive', {}],
      ['POST', '/v1/admin/projects/shop/roles', { user_id: UUID, role: 'viewer' }],
      ['DELETE', `/v1/admin/projects/shop/roles/${UUID}`, {}],
      ['PUT', '/v1/admin/projects/shop/config', { expected_version: 0, config_yaml: '' }],
      ['POST', '/v1/admin/users', { email: 'x@acme.example.com', display_name: 'X' }],
      ['PATCH', `/v1/admin/users/${UUID}`, { display_name: 'X' }],
      ['POST', `/v1/admin/users/${UUID}/disable`, {}],
      ['POST', `/v1/admin/users/${UUID}/enable`, {}],
      ['POST', `/v1/admin/users/${UUID}/identities`, { external_id: '1', external_login: 'x' }],
      ['DELETE', `/v1/admin/users/${UUID}/identities/${UUID}`, {}],
      ['DELETE', `/v1/admin/users/${UUID}/sessions`, {}],
      ['DELETE', `/v1/admin/users/${UUID}/passkeys/${UUID}`, {}],
      ['POST', '/v1/admin/tenant-admins', { user_id: UUID }],
      ['DELETE', `/v1/admin/tenant-admins/${UUID}`, {}],
      ['PATCH', '/v1/admin/agents/coder', { version: '2' }],
      ['POST', '/v1/admin/agents/coder/approvals', { purpose: 'activate', as: 'owner' }],
      ['POST', '/v1/admin/agents/coder/suspend', { reason_code: 'incident' }],
      ['POST', '/v1/admin/agents/coder/quarantine', { reason_code: 'incident' }],
      ['PUT', '/v1/admin/agents/coder/owner', { owner_id: UUID }],
      ['POST', '/v1/admin/agents/coder/recertify', {}],
      ['PUT', '/v1/projects/shop/ai-record', AI_RECORD],
      ['PUT', '/v1/intents/INT-2026-0001/evidence-hold', {}],
      ['DELETE', '/v1/intents/INT-2026-0001/evidence-hold', {}],
    ];

    it.each(routes)('%s %s: refused without a step-up', async (method, url, body) => {
      const reply = await inject(app, method, url, page(admin), body);
      // The body shape is checked first: a bad shape would be a 400, never a write.
      if (reply.statusCode === 400) throw new Error(`${method} ${url}: ${reply.body}`);
      expectError(reply, 403, 'step_up_refused');
    });

    it('with the actions switch off, every change of a session is refused', async () => {
      for (const [method, url, body] of routes) {
        expectError(
          await inject(off, method, url, page(admin), body),
          403,
          'dashboard_actions_off',
        );
      }
    });

    it('API tokens stay in the CLI: the token routes refuse a session (QUESTIONS #684)', async () => {
      expectError(
        await inject(app, 'POST', `/v1/admin/users/${annId}/tokens`, page(admin), { name: 'x' }),
        403,
        'session_write_not_allowed',
      );
      expectError(
        await inject(app, 'DELETE', `/v1/admin/users/${annId}/tokens/${UUID}`, page(admin), {}),
        403,
        'session_write_not_allowed',
      );
    });
  });

  describe('the binding of the step-up', () => {
    const url = '/v1/admin/projects';
    const body = { slug: 'web', name: 'Web', repo_full_name: 'org/web' };

    it('refuses an answer for another body, path or area, then accepts the right one once', async () => {
      const send = (answer: Answer, sent = body) =>
        inject(app, 'POST', url, page(admin), { ...sent, step_up: answer });
      const otherBody = await stepUp(admin, 'admin.project', {
        ...body,
        name: 'Other',
        decision: 'create',
        target: url,
      });
      expectError(await send(otherBody), 403, 'step_up_refused');
      const otherPath = await stepUp(admin, 'admin.project', {
        ...body,
        decision: 'create',
        target: '/v1/admin/projects/web',
      });
      expectError(await send(otherPath), 403, 'step_up_refused');
      const otherArea = await stepUp(admin, 'admin.user', {
        ...body,
        decision: 'create',
        target: url,
      });
      expectError(await send(otherArea), 403, 'step_up_refused');

      const right = await stepUp(admin, 'admin.project', {
        ...body,
        decision: 'create',
        target: url,
      });
      const created = await send(right);
      expect(created.statusCode, created.body).toBe(201);
      expect((await scope.passkeyChallenges.getById(right.challenge_id))?.used_at).not.toBeNull();
      // A used answer is refused, even for the same change.
      expectError(await send(right, { ...body, slug: 'web2' }), 403, 'step_up_refused');
    });

    it('a token writes without a step-up and may not send one', async () => {
      const created = await inject(app, 'POST', url, bearer(adminToken), {
        slug: 'cli',
        name: 'CLI',
        repo_full_name: 'org/cli',
      });
      expect(created.statusCode, created.body).toBe(201);
      const withStepUp = await inject(app, 'POST', url, bearer(adminToken), {
        slug: 'cli2',
        name: 'CLI 2',
        repo_full_name: 'org/cli2',
        step_up: { challenge_id: UUID, response: {} },
      });
      expectError(withStepUp, 400, 'invalid_request');
    });
  });

  describe('AC1: the API still decides (M21)', () => {
    it('a self-grant is refused, and the challenge stays unused', async () => {
      const url = '/v1/admin/projects/shop/roles';
      const body = { user_id: adminId, role: 'viewer' };
      const answer = await stepUp(admin, 'admin.project', {
        ...body,
        decision: 'role_grant',
        target: url,
      });
      expectError(
        await inject(app, 'POST', url, page(admin), { ...body, step_up: answer }),
        403,
        'self_action',
      );
      expect((await scope.passkeyChallenges.getById(answer.challenge_id))?.used_at).toBeNull();
    });

    it('Person A = Person B is refused', async () => {
      const reply = await change(
        admin,
        'POST',
        '/v1/admin/projects/shop/roles',
        'admin.project',
        'role_grant',
        {
          user_id: annId,
          role: 'person_b',
        },
      );
      expectError(reply, 409, 'conflicting_role');
    });

    it('a person who is not a tenant admin is refused, with a valid step-up', async () => {
      const reply = await change(
        ann,
        'POST',
        '/v1/admin/tenant-admins',
        'admin.tenant_admin',
        'grant',
        {
          user_id: bobId,
        },
      );
      expectError(reply, 403, 'forbidden');
    });
  });

  describe('AC1, AC2: the changes work from a session', () => {
    it('roles, identities (numeric ID), users, tenant admins and the configuration', async () => {
      const granted = await change(
        admin,
        'POST',
        '/v1/admin/projects/shop/roles',
        'admin.project',
        'role_grant',
        {
          user_id: bobId,
          role: 'person_b',
        },
      );
      expect(granted.statusCode, granted.body).toBe(201);
      // A DELETE carries its step-up in a JSON body.
      const revoked = await change(
        admin,
        'DELETE',
        `/v1/admin/projects/shop/roles/${String(granted.json().id)}`,
        'admin.project',
        'role_revoke',
      );
      expect(revoked.statusCode, revoked.body).toBe(200);
      expect(revoked.json().revoked_at).not.toBeNull();

      const linked = await change(
        admin,
        'POST',
        `/v1/admin/users/${bobId}/identities`,
        'admin.user',
        'identity_link',
        {
          external_id: '5001',
          external_login: 'bob',
        },
      );
      expect(linked.statusCode, linked.body).toBe(201);
      const notNumeric = await change(
        admin,
        'POST',
        `/v1/admin/users/${bobId}/identities`,
        'admin.user',
        'identity_link',
        {
          external_id: 'bob',
          external_login: 'bob',
        },
      );
      expectError(notNumeric, 400, 'invalid_request');

      const renamed = await change(
        admin,
        'PATCH',
        `/v1/admin/users/${bobId}`,
        'admin.user',
        'update',
        {
          display_name: 'Robert',
        },
      );
      expect(renamed.statusCode, renamed.body).toBe(200);
      const promoted = await change(
        admin,
        'POST',
        '/v1/admin/tenant-admins',
        'admin.tenant_admin',
        'grant',
        {
          user_id: bobId,
        },
      );
      expect(promoted.statusCode, promoted.body).toBe(201);
      const demoted = await change(
        admin,
        'DELETE',
        `/v1/admin/tenant-admins/${String(promoted.json().id)}`,
        'admin.tenant_admin',
        'revoke',
      );
      expect(demoted.statusCode, demoted.body).toBe(200);

      const yaml =
        'oversight:\n  matrix:\n    G2:\n      medium: { mode: HOTL, roles: [person_a], approvals: 1 }\n';
      const saved = await change(
        admin,
        'PUT',
        '/v1/admin/projects/shop/config',
        'admin.project',
        'config',
        {
          expected_version: 0,
          config_yaml: yaml,
        },
      );
      expect(saved.statusCode, saved.body).toBe(200);
      expect(saved.json()).toMatchObject({ version: 1, config_yaml: yaml, updated_by: adminId });
      // A stale version is refused (the page shows the difference to the stored version first).
      const stale = await change(
        admin,
        'PUT',
        '/v1/admin/projects/shop/config',
        'admin.project',
        'config',
        {
          expected_version: 0,
          config_yaml: '',
        },
      );
      expect(stale.statusCode, stale.body).toBe(409);
    });

    it('the AI record (person_a) and an evidence hold (tenant admin)', async () => {
      const record = await change(
        ann,
        'PUT',
        '/v1/projects/shop/ai-record',
        'admin.ai_record',
        'save',
        AI_RECORD,
      );
      expect(record.statusCode, record.body).toBe(200);

      const project = await scope.projects.getBySlug('shop');
      const intent = await scope.intents.create(
        {
          projectId: project!.id,
          title: 'Cancel an order',
          createdBy: annId,
          riskTier: 'medium',
          dataClass: 'internal',
        },
        { policyFactory: (config) => createSimplePolicyEngine({ config }), now: () => new Date() },
      );
      const url = `/v1/intents/${intent.code}/evidence-hold`;
      const held = await change(admin, 'PUT', url, 'admin.evidence_hold', 'hold');
      expect(held.statusCode, held.body).toBe(201);
      const released = await change(admin, 'DELETE', url, 'admin.evidence_hold', 'release');
      expect(released.statusCode, released.body).toBe(200);
    });

    it('a passkey revoked by an admin, a person signed out and disabled, then enabled', async () => {
      const listed = await inject(app, 'GET', `/v1/admin/users/${annId}/passkeys`, page(admin));
      const passkeyId = String((listed.json().items as { id: string }[])[0]!.id);
      const revoked = await change(
        admin,
        'DELETE',
        `/v1/admin/users/${annId}/passkeys/${passkeyId}`,
        'admin.passkey',
        'revoke',
      );
      expect(revoked.statusCode, revoked.body).toBe(200);
      const ended = await change(
        admin,
        'DELETE',
        `/v1/admin/users/${annId}/sessions`,
        'admin.user',
        'sessions_end',
      );
      expect(ended.statusCode, ended.body).toBe(200);
      const disabled = await change(
        admin,
        'POST',
        `/v1/admin/users/${annId}/disable`,
        'admin.user',
        'disable',
      );
      expect(disabled.statusCode, disabled.body).toBe(200);
      const enabled = await change(
        admin,
        'POST',
        `/v1/admin/users/${annId}/enable`,
        'admin.user',
        'enable',
      );
      expect(enabled.statusCode, enabled.body).toBe(200);
    });
  });

  describe('AC3: the audit log', () => {
    it('names the person as actor and holds no session or challenge ID', async () => {
      const rows = await auditRows();
      const changes = rows.filter((row) => row.action.startsWith('role.'));
      expect(changes.length).toBeGreaterThan(0);
      expect(changes.every((row) => row.actor_id === adminId)).toBe(true);
      const text = JSON.stringify(rows);
      for (const s of sessions) expect(text).not.toContain(s.id);
      const challenges = (
        await sql<{
          id: string;
        }>`SELECT id FROM passkey_challenges WHERE tenant_id = ${scope.tenantId}`.execute(db.owner)
      ).rows;
      expect(challenges.length).toBeGreaterThan(0);
      for (const c of challenges) expect(text).not.toContain(c.id);
    });
  });
});
