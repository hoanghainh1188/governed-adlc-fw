// D-08 U06 on a live PostgreSQL, through the Nest app and Fastify `inject()` (no port), with a
// software passkey: the CSRF layers on every session write (AC1), the actions switch (AC2),
// passkeys (AC3), the step-up challenge and its use in a transaction (AC4), and refusals for
// another origin, session or tenant (AC5) (design/ADR-M73 §2.3, §2.4; QUESTIONS #410–#414).
import { sql } from 'kysely';
import { t, type MessageKey } from '@sdlc/messages';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { WebSignInProvider } from '../../../packages/contracts/src/index.js';
import { createApp, type ApiDeps } from '../../../apps/api/src/app.js';
import type { Principal } from '../../../apps/api/src/auth/principal.js';
import { PasskeysService } from '../../../apps/api/src/passkeys/passkeys.service.js';
import { WebAuthnCeremonies } from '../../../apps/api/src/passkeys/webauthn.js';
import type { WebSignInSettings } from '../../../apps/api/src/settings.js';
import { bootstrapTenant } from '../../../packages/core/src/admin/bootstrap.js';
import { issueApiToken } from '../../../packages/core/src/admin/tokens.js';
import { parseTenantId } from '../../../packages/core/src/db/tenant-id.js';
import type { TenantScope } from '../../../packages/core/src/db/tenant-scope.js';
import { createJsonLogger } from '../../../packages/core/src/observability/index.js';
import {
  PasskeyError,
  consumeStepUp,
  stepUpRequestSha256,
  type StepUpBinding,
  type VerifiedStepUp,
} from '../../../packages/core/src/passkeys/index.js';
import {
  deriveCsrfToken,
  hashCsrfToken,
  startWebSession,
} from '../../../packages/core/src/web-sessions/index.js';
import { hashSessionSecret } from '../../../packages/core/src/db/repositories/web-sessions.js';
import { SoftAuthenticator } from '../../passkeys/soft-authenticator.js';
import { tokenIssuedAt } from '../token-clock.js';
import { createTestDatabase, describeDb, type TestDatabase } from './helpers.js';

type App = Awaited<ReturnType<typeof createApp>>;
const asApiDb = (db: TestDatabase): ApiDeps['db'] => db.app as unknown as ApiDeps['db'];
const START = new Date(Math.floor(Date.now() / 1000) * 1000);
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

/** Never called: these tests open sessions with `startWebSession` directly. */
const NO_GITHUB: WebSignInProvider = {
  authorizeUrl: () => Promise.reject(new Error('not used')),
  exchangeCode: () => Promise.reject(new Error('not used')),
  accountId: () => Promise.reject(new Error('not used')),
  revokeToken: () => Promise.resolve(),
};

interface Reply {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string | string[] | number | undefined>>;
  readonly body: string;
  json(): Record<string, unknown> & { error?: { code: string; message: string } };
}

interface Session {
  readonly id: string;
  readonly secret: string;
  readonly csrf: string;
  readonly userId: string;
}

describeDb('U06: CSRF, the actions switch, passkeys and the step-up', () => {
  let t0: TestDatabase;
  let app: App;
  let off: App;
  let clock = START;
  const lines: string[] = [];
  let acme: TenantScope;
  let other: TenantScope;
  let adminToken: string;
  let otherAdminToken: string;
  const people: Record<string, { id: string; identityId: string; token: string }> = {};
  let intentCode: string;
  let intentId: string;
  let projectId: string;

  const inject = async (
    target: App,
    method: 'GET' | 'POST' | 'DELETE' | 'PUT',
    url: string,
    headers: Record<string, string> = {},
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

  const expectError = (reply: Reply, status: number, code: string) => {
    expect(reply.statusCode, reply.body).toBe(status);
    expect(reply.json().error?.code).toBe(code);
    expect(reply.json().error?.message).toBe(t(`api.error.${code}` as MessageKey));
  };

  /** A session opened now for a person (as the GitHub callback does). */
  async function open(key: string, scope: TenantScope = acme): Promise<Session> {
    const person = people[key]!;
    // `web_sessions.created_at` (the GitHub sign-in, for the 5-minute registration window) is
    // the database's clock: the test clock follows it at each sign-in.
    clock = new Date();
    const started = await startWebSession(scope, {
      userId: person.id,
      identityId: person.identityId,
      now: clock,
      maxAgeMs: SETTINGS.maxAgeMs,
    });
    return {
      id: started.session.id,
      secret: started.secret,
      csrf: deriveCsrfToken(started.secret),
      userId: person.id,
    };
  }

  /** The headers of a write from the dashboard page: cookie, CSRF token, same origin, JSON. */
  const page = (s: Session, extra: Record<string, string> = {}): Record<string, string> => ({
    cookie: `__Host-sdlc_session=${s.secret}`,
    'x-sdlc-csrf': s.csrf,
    origin: ORIGIN,
    'sec-fetch-site': 'same-origin',
    ...extra,
  });
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  /** Registers a software passkey for the session; returns it. */
  async function registerKey(s: Session, key = new SoftAuthenticator({ origin: ORIGIN })) {
    const options = await inject(app, 'POST', '/v1/me/passkeys/registration-options', page(s));
    expect(options.statusCode, options.body).toBe(200);
    const body = options.json() as {
      challenge_id: string;
      options: { challenge: string; rp: { id: string } };
    };
    const reply = await inject(app, 'POST', '/v1/me/passkeys', page(s), {
      challenge_id: body.challenge_id,
      response: key.register(body.options),
    });
    expect(reply.statusCode, reply.body).toBe(201);
    return { key, passkeyId: String(reply.json().id) };
  }

  const decision = { decision: 'approve', reason_code: null };
  const stepUpBody = (extra: Record<string, unknown> = {}) => ({
    action: 'gate.decide',
    intent: intentCode,
    gate: 'G1',
    expected_input_sha256: 'e'.repeat(64),
    request: decision,
    ...extra,
  });
  const bindingOf = (request: Record<string, unknown> = decision): StepUpBinding => ({
    action: 'gate.decide',
    intentId,
    escalationId: null,
    gate: 'G1',
    decision: String(request.decision),
    expectedInputSha256: 'e'.repeat(64),
    requestSha256: stepUpRequestSha256(request),
  });

  const service = () =>
    new PasskeysService({
      ceremonies: new WebAuthnCeremonies(ORIGIN),
      now: () => clock,
      log: createJsonLogger({ write: (line) => lines.push(line) }),
    });
  /** The test database is the core source class; the api is typed against its declarations. */
  const principal = (s: Session, scope: TenantScope = acme): Principal => ({
    tenantId: scope.tenantId as unknown as Principal['tenantId'],
    userId: s.userId,
    credential: { kind: 'session', id: s.id, signedInAt: clock },
    scope: scope as unknown as Principal['scope'],
  });

  /** A step-up challenge from the API and the passkey's answer, checked by the api's service. */
  async function stepUp(s: Session, key: SoftAuthenticator): Promise<VerifiedStepUp> {
    const reply = await inject(app, 'POST', '/v1/auth/step-up', page(s), stepUpBody());
    expect(reply.statusCode, reply.body).toBe(200);
    const body = reply.json() as { challenge_id: string; options: { challenge: string } };
    return service().verifyStepUp(principal(s), {
      challenge_id: body.challenge_id,
      response: key.authenticate(body.options) as never,
    });
  }

  async function person(scope: TenantScope, key: string, account: string) {
    const user = await scope.users.create({ display_name: key, email: `${key}@x.example.com` });
    const identity = await scope.userIdentities.link({
      user_id: user.id,
      provider: 'github',
      external_id: account,
      external_login: key,
    });
    const token = (await issueApiToken(scope, { userId: user.id, name: key, now: tokenIssuedAt() }))
      .token;
    return { id: user.id, identityId: identity.id, token };
  }

  beforeAll(async () => {
    t0 = await createTestDatabase();
    const boot = await bootstrapTenant(t0.app, {
      tenantSlug: 'acme',
      tenantName: 'Acme',
      adminEmail: 'admin@acme.example.com',
      adminName: 'Admin',
      now: START,
    });
    acme = t0.app.forTenant(parseTenantId(boot.tenant.id));
    adminToken = boot.token.token;
    const second = await bootstrapTenant(t0.app, {
      tenantSlug: 'globex',
      tenantName: 'Globex',
      adminEmail: 'admin@globex.example.com',
      adminName: 'Admin',
      now: START,
    });
    other = t0.app.forTenant(parseTenantId(second.tenant.id));
    otherAdminToken = second.token.token;
    for (const [key, account] of [
      ['alice', '2001'],
      ['bob', '2002'],
      ['carol', '2003'],
      ['dave', '2004'],
      ['erin', '2005'],
    ] as const) {
      people[key] = await person(acme, key, account);
    }
    people.gina = await person(other, 'gina', '2001');
    const project = await acme.projects.create({
      slug: 'shop',
      name: 'Shop',
      git_provider: 'github',
      repo_full_name: 'org/shop',
    });
    projectId = project.id;
    for (const key of ['alice', 'bob', 'erin']) {
      await acme.roleBindings.grant({
        user_id: people[key]!.id,
        project_id: project.id,
        role: 'person_a',
      });
    }
    const log = createJsonLogger({ write: (line) => lines.push(line) });
    const base = {
      db: asApiDb(t0),
      settings: { rateLimitPerMinute: 10_000, authFailuresPerMinute: 1000 },
      now: () => clock,
      logger: { error: (...args: unknown[]) => lines.push(args.map(String).join(' ')) },
      log,
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
    const created = await inject(app, 'POST', '/v1/intents', bearer(people.alice!.token), {
      project: 'shop',
      title: 'Add Japanese labels',
      risk_tier: 'low',
      data_class: 'internal',
    });
    expect(created.statusCode, created.body).toBe(201);
    intentCode = String(created.json().code);
    intentId = String(created.json().id);
  }, 60_000);

  beforeEach(() => {
    clock = new Date(clock.getTime() + MIN);
  });

  afterAll(async () => {
    await app?.close();
    await off?.close();
    await t0?.drop();
  });

  describe('AC1: CSRF on every session write', () => {
    it('GET /v1/auth/session gives the session its CSRF token; a token caller gets 404', async () => {
      const s = await open('alice');
      const reply = await inject(app, 'GET', '/v1/auth/session', {
        cookie: `__Host-sdlc_session=${s.secret}`,
      });
      expect(reply.statusCode, reply.body).toBe(200);
      expect(reply.headers['cache-control']).toBe('no-store');
      // Only the hash is stored.
      const row = await acme.webSessions.getById(s.id);
      expect(reply.json()).toEqual({
        csrf_token: s.csrf,
        signed_in_at: row?.created_at.toISOString(),
        actions: true,
      });
      expect(row?.csrf_sha256).toBe(hashCsrfToken(s.csrf));
      expectError(
        await inject(app, 'GET', '/v1/auth/session', bearer(people.alice!.token)),
        404,
        'not_found',
      );
      expect((await inject(app, 'GET', '/v1/auth/config')).json()).toEqual({
        github: true,
        actions: true,
      });
    });

    it('sign-out with all three layers works and answers no-store', async () => {
      const s = await open('alice');
      const reply = await inject(app, 'POST', '/v1/auth/sign-out', page(s));
      expect(reply.statusCode, reply.body).toBe(204);
      expect(reply.headers['cache-control']).toBe('no-store');
    });

    it.each([
      ['no CSRF header', { 'x-sdlc-csrf': '' }],
      ['another CSRF token', { 'x-sdlc-csrf': deriveCsrfToken('x'.repeat(43)) }],
      ['another origin', { origin: 'http://evil.localhost:8090' }],
      ['no origin', { origin: '' }],
      ['a cross-site fetch', { 'sec-fetch-site': 'cross-site' }],
      ['a same-site fetch', { 'sec-fetch-site': 'same-site' }],
    ])('refuses a session write with %s (csrf_refused)', async (_name, override) => {
      const s = await open('alice');
      const headers = Object.fromEntries(
        Object.entries(page(s, override)).filter(([, value]) => value !== ''),
      );
      expectError(await inject(app, 'POST', '/v1/auth/sign-out', headers), 403, 'csrf_refused');
      expectError(
        await inject(app, 'POST', '/v1/me/passkeys/registration-options', headers),
        403,
        'csrf_refused',
      );
      // The session is still open: nothing happened.
      expect((await acme.webSessions.getById(s.id))?.revoked_at).toBeNull();
    });

    it('refuses a body that is not JSON (a cross-site form can send text/plain)', async () => {
      const s = await open('alice');
      for (const type of [
        'text/plain',
        'application/x-www-form-urlencoded',
        'multipart/form-data',
      ]) {
        // Refused before any handler: by Fastify (415, a type it does not parse) or the guard.
        const reply = await t0Inject(s, type);
        expect([403, 415], `${type}: ${reply.body}`).toContain(reply.statusCode);
      }
      const json = await inject(
        app,
        'POST',
        '/v1/auth/step-up',
        page(s, { 'content-type': 'application/json; charset=utf-8' }),
        stepUpBody(),
      );
      expect(json.statusCode).not.toBe(403);
    });

    async function t0Inject(s: Session, type: string): Promise<Reply> {
      return await app
        .getHttpAdapter()
        .getInstance()
        .inject({
          method: 'POST',
          url: '/v1/auth/step-up',
          headers: { ...page(s), 'content-type': type },
          payload: 'action=gate.decide',
        });
    }

    it('a session made before U06 (no CSRF hash) can read but never write', async () => {
      const secret = 'S'.repeat(43);
      const row = await acme.webSessions.create({
        user_id: people.alice!.id,
        identity_id: people.alice!.identityId,
        secret_sha256: hashSessionSecret(secret),
        last_seen_at: clock,
        expires_at: new Date(clock.getTime() + SETTINGS.maxAgeMs),
      });
      expect(row.csrf_sha256).toBeNull();
      const cookie = { cookie: `__Host-sdlc_session=${secret}` };
      expect((await inject(app, 'GET', '/v1/me', cookie)).statusCode).toBe(200);
      const s: Session = {
        id: row.id,
        secret,
        csrf: deriveCsrfToken(secret),
        userId: people.alice!.id,
      };
      expectError(await inject(app, 'POST', '/v1/auth/sign-out', page(s)), 403, 'csrf_refused');
    });

    it('unmarked routes stay closed to sessions; decisions need a step-up (U07)', async () => {
      const s = await open('alice');
      for (const [method, url] of [
        ['POST', '/v1/me/tokens'],
        // U09 opened the admin passkey removal to sessions, with a step-up; tokens stay closed.
        ['POST', `/v1/admin/users/${people.bob!.id}/tokens`],
      ] as const) {
        expectError(
          await inject(app, method, url, page(s), { decision: 'approve' }),
          403,
          'session_write_not_allowed',
        );
      }
      // A gate decision from a session needs a step-up.
      expectError(
        await inject(app, 'POST', `/v1/intents/${intentCode}/gates/G1/decisions`, page(s), {
          decision: 'approve',
        }),
        403,
        'step_up_refused',
      );
      // Nothing was recorded.
      expect(await acme.gateDecisions.listForIntent(intentId)).toEqual([]);
    });

    it('bearer requests are unchanged: no CSRF header, no origin', async () => {
      const reply = await inject(app, 'POST', '/v1/me/tokens', bearer(people.alice!.token), {
        name: 'laptop',
      });
      expect(reply.statusCode, reply.body).toBe(201);
    });
  });

  describe('AC2: the actions switch', () => {
    it('off: sessions read and sign out, but passkeys and step-ups are refused', async () => {
      expect((await inject(off, 'GET', '/v1/auth/config')).json()).toEqual({
        github: true,
        actions: false,
      });
      const s = await open('bob');
      const session = await inject(off, 'GET', '/v1/auth/session', {
        cookie: `__Host-sdlc_session=${s.secret}`,
      });
      expect(session.json().actions).toBe(false);
      for (const url of ['/v1/me/passkeys/registration-options', '/v1/auth/step-up']) {
        expectError(
          await inject(off, 'POST', url, page(s), stepUpBody()),
          403,
          'dashboard_actions_off',
        );
      }
      expect((await inject(off, 'POST', '/v1/auth/sign-out', page(s))).statusCode).toBe(204);
    });
  });

  describe('AC3: passkeys', () => {
    it('registers within 5 minutes of the sign-in; lists; audits without IDs', async () => {
      const s = await open('carol');
      const { passkeyId, key } = await registerKey(s);
      const list = await inject(app, 'GET', '/v1/me/passkeys', bearer(people.carol!.token));
      expect(list.json().items).toEqual([
        expect.objectContaining({
          id: passkeyId,
          aaguid: null,
          revoked_at: null,
          last_used_at: null,
        }),
      ]);
      const row = await acme.webauthnCredentials.getById(passkeyId);
      expect(row).toMatchObject({ credential_id: key.id, algorithm: -7, sign_count: '1' });
      const audit = await sql<{ action: string; payload: unknown; entity_id: string }>`
        SELECT action, payload, entity_id FROM audit_log
        WHERE tenant_id = ${acme.tenantId} AND action LIKE 'passkey.%'`.execute(t0.owner);
      expect(audit.rows).toEqual([
        { action: 'passkey.registered', payload: {}, entity_id: people.carol!.id },
      ]);
      const all = JSON.stringify((await sql`SELECT payload FROM audit_log`.execute(t0.owner)).rows);
      expect(all).not.toContain(key.id);
      expect(all).not.toContain(passkeyId);
      expect(all).not.toContain(s.id);
    });

    it('refuses a registration more than 5 minutes after the sign-in, a reused challenge, a token', async () => {
      const s = await open('dave');
      // Options at 4 minutes (allowed), the answer after 5: refused, the challenge still open.
      clock = new Date(clock.getTime() + 4 * MIN);
      const options = await inject(app, 'POST', '/v1/me/passkeys/registration-options', page(s));
      const body = options.json() as {
        challenge_id: string;
        options: { challenge: string; rp: { id: string } };
      };
      const key = new SoftAuthenticator({ origin: ORIGIN });
      const answer = key.register(body.options);
      clock = new Date(clock.getTime() + MIN + 1000);
      expectError(
        await inject(app, 'POST', '/v1/me/passkeys', page(s), {
          challenge_id: body.challenge_id,
          response: answer,
        }),
        403,
        'recent_signin_required',
      );
      expectError(
        await inject(app, 'POST', '/v1/me/passkeys/registration-options', page(s)),
        403,
        'recent_signin_required',
      );
      const fresh = await open('dave');
      const first = await registerKey(fresh);
      expect(first.passkeyId).toBeTruthy();
      // The challenge of the first session is not this session's.
      expectError(
        await inject(app, 'POST', '/v1/me/passkeys', page(fresh), {
          challenge_id: body.challenge_id,
          response: answer,
        }),
        409,
        'challenge_refused',
      );
      expectError(
        await inject(
          app,
          'POST',
          '/v1/me/passkeys/registration-options',
          bearer(people.dave!.token),
        ),
        403,
        'session_write_not_allowed',
      );
    });

    it('refuses an answer that does not verify (another site), and the 11th passkey', async () => {
      const s = await open('erin');
      const options = await inject(app, 'POST', '/v1/me/passkeys/registration-options', page(s));
      const body = options.json() as {
        challenge_id: string;
        options: { challenge: string; rp: { id: string } };
      };
      const foreign = new SoftAuthenticator({ origin: 'https://other.example.com' });
      expectError(
        await inject(app, 'POST', '/v1/me/passkeys', page(s), {
          challenge_id: body.challenge_id,
          response: foreign.register({ ...body.options, rp: { id: 'other.example.com' } }),
        }),
        400,
        'passkey_refused',
      );
      expect(lines.join('\n')).toContain('api.passkey_refused');
      for (let i = 0; i < 10; i += 1) await registerKey(s);
      const more = await inject(app, 'POST', '/v1/me/passkeys/registration-options', page(s));
      const m = more.json() as {
        challenge_id: string;
        options: { challenge: string; rp: { id: string } };
      };
      expect(m.options).toBeDefined();
      expectError(
        await inject(app, 'POST', '/v1/me/passkeys', page(s), {
          challenge_id: m.challenge_id,
          response: new SoftAuthenticator({ origin: ORIGIN }).register(m.options),
        }),
        409,
        'too_many_passkeys',
      );
    });

    it('a person removes their own passkey once; a tenant admin lists and removes; other tenants never', async () => {
      const s = await open('bob');
      const one = await registerKey(s);
      const two = await registerKey(s);
      const removed = await inject(app, 'DELETE', `/v1/me/passkeys/${one.passkeyId}`, page(s));
      expect(removed.statusCode, removed.body).toBe(200);
      expect(removed.json().revoked_at).toBe(clock.toISOString());
      expectError(
        await inject(app, 'DELETE', `/v1/me/passkeys/${one.passkeyId}`, page(s)),
        404,
        'passkey_not_found',
      );
      // Another person cannot remove Bob's passkey as their own.
      expectError(
        await inject(
          app,
          'DELETE',
          `/v1/me/passkeys/${two.passkeyId}`,
          bearer(people.alice!.token),
        ),
        404,
        'passkey_not_found',
      );
      expectError(
        await inject(
          app,
          'GET',
          `/v1/admin/users/${people.bob!.id}/passkeys`,
          bearer(people.alice!.token),
        ),
        403,
        'forbidden',
      );
      const list = await inject(
        app,
        'GET',
        `/v1/admin/users/${people.bob!.id}/passkeys`,
        bearer(adminToken),
      );
      expect((list.json().items as unknown[]).length).toBe(2);
      expectError(
        await inject(
          app,
          'GET',
          `/v1/admin/users/${people.bob!.id}/passkeys`,
          bearer(otherAdminToken),
        ),
        404,
        'user_not_found',
      );
      const byAdmin = await inject(
        app,
        'DELETE',
        `/v1/admin/users/${people.bob!.id}/passkeys/${two.passkeyId}`,
        bearer(adminToken),
      );
      expect(byAdmin.statusCode, byAdmin.body).toBe(200);
      const audit = await sql<{ payload: { reason: string }; actor_id: string }>`
        SELECT payload, actor_id FROM audit_log
        WHERE tenant_id = ${acme.tenantId} AND action = 'passkey.revoked' AND entity_id = ${people.bob!.id}
        ORDER BY seq`.execute(t0.owner);
      expect(audit.rows.map((r) => r.payload.reason)).toEqual(['self', 'admin']);
      expect((await acme.webauthnCredentials.getById(two.passkeyId))?.revoked_by).not.toBe(
        people.bob!.id,
      );
    });
  });

  describe('AC4: the step-up', () => {
    it('a challenge is bound to the action and used once, in the decision transaction', async () => {
      const s = await open('alice');
      const { key } = await registerKey(s);
      const verified = await stepUp(s, key);
      // A decision that rolls back leaves the challenge unused.
      await expect(
        acme.transaction(async (tx) => {
          await consumeStepUp(tx, verified, bindingOf(), clock);
          throw new Error('the decision failed');
        }),
      ).rejects.toThrow('the decision failed');
      const row = await acme.passkeyChallenges.getById(verified.challengeId);
      expect(row?.used_at).toBeNull();
      expect(row).toMatchObject({
        action: 'gate.decide',
        intent_id: intentId,
        gate: 'G1',
        decision: 'approve',
        request_sha256: stepUpRequestSha256(decision),
      });
      // Another decision body, another action, another session: refused.
      for (const binding of [
        bindingOf({ decision: 'reject', reason_code: null }),
        { ...bindingOf(), gate: 'G2' as const },
        { ...bindingOf(), expectedInputSha256: 'f'.repeat(64) },
      ]) {
        await expect(
          acme.transaction((tx) => consumeStepUp(tx, verified, binding, clock)),
        ).rejects.toThrowError(expect.objectContaining({ code: 'step_up_refused' }));
      }
      const otherSession = await open('alice');
      await expect(
        acme.transaction((tx) =>
          consumeStepUp(tx, { ...verified, sessionId: otherSession.id }, bindingOf(), clock),
        ),
      ).rejects.toThrowError(expect.objectContaining({ code: 'step_up_refused' }));
      // Used once.
      await acme.transaction((tx) => consumeStepUp(tx, verified, bindingOf(), clock));
      expect((await acme.passkeyChallenges.getById(verified.challengeId))?.used_at).toEqual(clock);
      await expect(
        acme.transaction((tx) => consumeStepUp(tx, verified, bindingOf(), clock)),
      ).rejects.toBeInstanceOf(PasskeyError);
      await expect(
        service().verifyStepUp(principal(s), {
          challenge_id: verified.challengeId,
          response: key.authenticate({ challenge: 'x' }) as never,
        }),
      ).rejects.toMatchObject({ code: 'step_up_refused' });
    });

    it('two uses at once: only one wins', async () => {
      const s = await open('alice');
      const { key } = await registerKey(s);
      const verified = await stepUp(s, key);
      const results = await Promise.allSettled([
        acme.transaction((tx) => consumeStepUp(tx, verified, bindingOf(), clock)),
        acme.transaction((tx) => consumeStepUp(tx, verified, bindingOf(), clock)),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    });

    it('refuses an expired challenge, a revoked passkey, a counter that does not go up', async () => {
      const s = await open('alice');
      const { key, passkeyId } = await registerKey(s);
      const late = await stepUp(s, key);
      clock = new Date(clock.getTime() + 2 * MIN);
      await expect(
        acme.transaction((tx) => consumeStepUp(tx, late, bindingOf(), clock)),
      ).rejects.toMatchObject({ code: 'step_up_refused' });
      const fresh = await open('alice');
      const kept = await stepUp(fresh, key);
      await acme.webauthnCredentials.recordUse(
        passkeyId,
        people.alice!.id,
        kept.signCount + 5,
        clock,
      );
      await expect(
        acme.transaction((tx) => consumeStepUp(tx, kept, bindingOf(), clock)),
      ).rejects.toMatchObject({ code: 'step_up_refused' });
      key.setCounter(100);
      const third = await stepUp(fresh, key);
      await inject(app, 'DELETE', `/v1/me/passkeys/${passkeyId}`, page(fresh));
      await expect(
        acme.transaction((tx) => consumeStepUp(tx, third, bindingOf(), clock)),
      ).rejects.toMatchObject({ code: 'step_up_refused' });
    });

    it('a synced passkey (counter always 0) works', async () => {
      const s = await open('alice');
      const { key } = await registerKey(
        s,
        new SoftAuthenticator({ origin: ORIGIN, counter: null }),
      );
      const verified = await stepUp(s, key);
      expect(verified.signCount).toBe(0);
      await acme.transaction((tx) => consumeStepUp(tx, verified, bindingOf(), clock));
      const again = await stepUp(s, key);
      await acme.transaction((tx) => consumeStepUp(tx, again, bindingOf(), clock));
    });

    it('needs a passkey, a readable intent, a known shape; at most 5 open challenges', async () => {
      const s = await open('carol');
      // Carol has a passkey but no role on the project: the intent is not found.
      const c = await open('carol');
      await registerKey(c);
      expectError(
        await inject(app, 'POST', '/v1/auth/step-up', page(s), stepUpBody()),
        404,
        'intent_not_found',
      );
      const b = await open('bob');
      await acme.roleBindings.grant({
        user_id: people.bob!.id,
        project_id: projectId,
        role: 'person_b',
      });
      // Bob's passkeys were all removed above.
      expectError(
        await inject(app, 'POST', '/v1/auth/step-up', page(b), stepUpBody()),
        404,
        'passkey_not_found',
      );
      const a = await open('alice');
      await registerKey(a);
      expectError(
        await inject(app, 'POST', '/v1/auth/step-up', page(a), stepUpBody({ gate: 'G9' })),
        400,
        'invalid_request',
      );
      expectError(
        await inject(app, 'POST', '/v1/auth/step-up', page(a), stepUpBody({ action: 'run.kill' })),
        400,
        'invalid_request',
      );
      expectError(
        await inject(
          app,
          'POST',
          '/v1/auth/step-up',
          page(a),
          stepUpBody({ request: { reason: 'x' } }),
        ),
        400,
        'invalid_request',
      );
      for (let i = 0; i < 5; i += 1) {
        expect(
          (await inject(app, 'POST', '/v1/auth/step-up', page(a), stepUpBody())).statusCode,
        ).toBe(200);
      }
      expectError(
        await inject(app, 'POST', '/v1/auth/step-up', page(a), stepUpBody()),
        429,
        'too_many_challenges',
      );
    });
  });

  describe('AC5: other sessions and tenants; the tables', () => {
    it("a session of another tenant never reaches this tenant's challenges or passkeys", async () => {
      const g = await open('gina', other);
      expect((await inject(app, 'GET', '/v1/me/passkeys', page(g))).json().items).toEqual([]);
      expectError(
        await inject(app, 'POST', '/v1/auth/step-up', page(g), stepUpBody()),
        404,
        'intent_not_found',
      );
    });

    it('triggers SDA18, SDA19, SDA20; no DELETE for platform_app', async () => {
      const s = await open('alice');
      const { key, passkeyId } = await registerKey(s);
      const verified = await stepUp(s, key);
      const raw = t0.appRaw;
      await expect(
        sql`UPDATE web_sessions SET csrf_sha256 = ${'0'.repeat(64)} WHERE id = ${s.id}`.execute(
          raw,
        ),
      ).rejects.toThrow();
      await expect(
        sql`UPDATE passkey_challenges SET used_at = ${clock} WHERE id = ${verified.challengeId}`.execute(
          raw,
        ),
      ).resolves.toBeDefined();
      await expect(
        sql`UPDATE passkey_challenges SET used_at = ${clock} WHERE id = ${verified.challengeId}`.execute(
          raw,
        ),
      ).rejects.toThrow(/used once/);
      await expect(sql`DELETE FROM passkey_challenges`.execute(raw)).rejects.toThrow();
      await expect(sql`DELETE FROM webauthn_credentials`.execute(raw)).rejects.toThrow();
      await expect(
        sql`UPDATE webauthn_credentials SET sign_count = 0 WHERE id = ${passkeyId}`.execute(raw),
      ).rejects.toThrow(/only grows/);
      await expect(
        sql`UPDATE webauthn_credentials SET revoked_at = ${clock}, revoked_by = ${people.alice!.id} WHERE id = ${passkeyId}`.execute(
          raw,
        ),
      ).resolves.toBeDefined();
      await expect(
        sql`UPDATE webauthn_credentials SET last_used_at = ${clock} WHERE id = ${passkeyId}`.execute(
          raw,
        ),
      ).rejects.toThrow(/revoked once/);
      // Even the owner cannot change the key itself.
      await expect(
        sql`UPDATE webauthn_credentials SET credential_id = ${'Z'.repeat(43)} WHERE id = ${passkeyId}`.execute(
          t0.owner,
        ),
      ).rejects.toThrow(/only the counter/);
    });

    it('logs and tables hold no session secret, CSRF token or challenge', async () => {
      const s = await open('alice');
      const { key } = await registerKey(s);
      await stepUp(s, key);
      const rows = await Promise.all([
        sql`SELECT * FROM web_sessions`.execute(t0.owner),
        sql`SELECT * FROM passkey_challenges`.execute(t0.owner),
        sql`SELECT * FROM webauthn_credentials`.execute(t0.owner),
        sql`SELECT * FROM audit_log`.execute(t0.owner),
      ]);
      const dump = JSON.stringify(rows.map((r) => r.rows));
      const all = lines.join('\n') + dump;
      expect(all).not.toContain(s.secret);
      expect(all).not.toContain(s.csrf);
    });
  });
});
