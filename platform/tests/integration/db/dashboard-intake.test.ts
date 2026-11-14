// D-08 U08 on a live PostgreSQL, through the Nest app and Fastify `inject()` (no port): the wave 2
// actions from a dashboard session (design/ADR-M73 §2.1, MVP1-UI-SCOPE §3.3), with no step-up:
// - AC1: create an intent, then link its spec (the two calls of U03); a refused link keeps the
//   intent;
// - AC2: submit the plan file; build an Evidence Pack (201, then 200 when nothing changed);
// - AC3: the project's `access.*` roles decide, the same as for the CLI (a viewer and a wrong role
//   are refused); every write still needs the CSRF token, and actions off refuses them.
// The Git host and the evidence store are in-memory fakes, as in `spec-linking.test.ts` and
// `evidence-pack.test.ts`.
import crypto from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type {
  EvidenceGetOptions,
  EvidenceStore,
  StoredEvidence,
  WebSignInProvider,
} from '../../../packages/contracts/src/index.js';
import { EvidenceError } from '../../../packages/contracts/src/index.js';
import { createApp, type ApiDeps } from '../../../apps/api/src/app.js';
import type { WebSignInSettings } from '../../../apps/api/src/settings.js';
import { deriveCsrfToken, startWebSession } from '../../../packages/core/src/web-sessions/index.js';
import { FakeSpecGitHost, SPEC_PATH } from '../fake-spec-git-host.js';
import { harness, T0, type Harness } from '../g4-harness.js';
import { createTestDatabase, describeDb, type TestDatabase } from './helpers.js';

type App = Awaited<ReturnType<typeof createApp>>;
type Who = 'a' | 'b' | 'viewer';
const asApiDb = (db: TestDatabase): ApiDeps['db'] => db.app as unknown as ApiDeps['db'];
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

const sha256 = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');

/** Keys as SeaweedFS holds them: `packs/<tenant>/<path>`. */
class MemoryStore implements EvidenceStore {
  readonly objects = new Map<string, Buffer>();

  put(tenantId: string, path: string, content: Buffer): Promise<StoredEvidence> {
    const key = `packs/${tenantId}/${path}`;
    if (this.objects.has(key)) return Promise.reject(new EvidenceError('exists'));
    this.objects.set(key, Buffer.from(content));
    return Promise.resolve({
      uri: `s3://evidence/${key}`,
      sha256: sha256(content),
      sizeBytes: content.length,
    });
  }

  get(uri: string, options: EvidenceGetOptions = {}): Promise<Buffer> {
    const body = this.objects.get(uri.slice('s3://evidence/'.length));
    if (!body) return Promise.reject(new EvidenceError('not_found'));
    if (options.maxBytes !== undefined && body.length > options.maxBytes) {
      return Promise.reject(new EvidenceError('too_large'));
    }
    return Promise.resolve(body);
  }
}

/** A plan file of schema version 1 (template T13) for an intent. */
const planYaml = (code: string): string =>
  [
    'plan:',
    `  intent_id: ${code}`,
    '  change_flags: []',
    'tasks:',
    '  - id: T1',
    '    summary: Cancel an order and return the stock',
    '    allowed_paths:',
    '      - "apps/api/src/orders/**"',
    '    tools: [file_editor, terminal]',
    '',
  ].join('\n');

interface Reply {
  readonly statusCode: number;
  readonly body: string;
  json(): Record<string, unknown> & { error?: { code: string; reason?: string } };
}

interface Session {
  readonly secret: string;
  readonly csrf: string;
}

describeDb('U08: create, spec link, plan and Evidence Pack from a dashboard session', () => {
  let db: TestDatabase;
  let t: Harness;
  let app: App;
  let off: App;
  const git = new FakeSpecGitHost();
  const sessions = {} as Record<Who, Session>;

  const injectOn = async (
    on: App,
    url: string,
    headers: Record<string, string>,
    payload?: unknown,
    method: 'GET' | 'POST' = 'POST',
  ): Promise<Reply> =>
    await on
      .getHttpAdapter()
      .getInstance()
      .inject({
        method,
        url,
        headers,
        ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
      });

  /** The headers of a write from the dashboard page: cookie, CSRF token, same origin. */
  const page = (s: Session): Record<string, string> => ({
    cookie: `__Host-sdlc_session=${s.secret}`,
    'x-sdlc-csrf': s.csrf,
    origin: ORIGIN,
    'sec-fetch-site': 'same-origin',
  });
  const post = (who: Who, url: string, body: unknown = {}) =>
    injectOn(app, url, page(sessions[who]), body);
  const get = (who: Who, url: string) => injectOn(app, url, page(sessions[who]), undefined, 'GET');

  async function open(userId: string): Promise<Session> {
    const [identity] = await t.f.scope.userIdentities.listForUser(userId);
    const started = await startWebSession(t.f.scope, {
      userId,
      identityId: identity!.id,
      now: new Date(),
      maxAgeMs: SETTINGS.maxAgeMs,
    });
    return { secret: started.secret, csrf: deriveCsrfToken(started.secret) };
  }

  /** The body of `adlc intent create` as the page sends it. */
  const intentBody = (title: string) => ({
    project: 'shop',
    title,
    description: '',
    risk_tier: 'medium',
    data_class: 'internal',
  });

  async function created(title: string): Promise<string> {
    const reply = await post('a', '/v1/intents', intentBody(title));
    expect(reply.statusCode, reply.body).toBe(201);
    return String(reply.json().code);
  }

  beforeAll(async () => {
    db = await createTestDatabase();
    t = await harness(db);
    t.setClock(T0);
    const scope = t.f.scope;
    const viewer = await scope.users.create({ display_name: 'v', email: 'v@example.com' });
    await scope.roleBindings.grant({
      user_id: viewer.id,
      project_id: t.f.target.projectId,
      role: 'viewer',
    });
    await scope.userIdentities.link({
      user_id: viewer.id,
      provider: 'github',
      external_id: '3099',
      external_login: 'vera',
    });
    const deps = {
      db: asApiDb(db),
      settings: { rateLimitPerMinute: 10_000, authFailuresPerMinute: 1000 },
      now: () => new Date(),
      logger: { error: () => undefined },
      gitHost: git,
      evidence: { store: new MemoryStore(), maxItemBytes: 1024 * 1024 },
    };
    const limits = { starts: 10_000, callbacks: 10_000, passkeys: 10_000 };
    app = await createApp({
      ...deps,
      webSignIn: { settings: SETTINGS, provider: NO_GITHUB, limits },
    });
    off = await createApp({
      ...deps,
      webSignIn: { settings: { ...SETTINGS, actions: false }, provider: NO_GITHUB, limits },
    });
    sessions.a = await open(t.f.users.a);
    sessions.b = await open(t.f.users.b);
    sessions.viewer = await open(viewer.id);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await off?.close();
    await t?.f.close();
    await db?.drop();
  });

  describe('AC1: create an intent, then link its spec', () => {
    it('Person A creates and links with no step-up; the actor is the person', async () => {
      const code = await created('Cancel an order');
      const linked = await post('a', `/v1/intents/${code}/specs`, {
        path: SPEC_PATH,
        source_tool: 'manual',
      });
      expect(linked.statusCode, linked.body).toBe(201);
      expect(linked.json()).toMatchObject({ intent: code, version: 1, path: SPEC_PATH });

      const intent = (await t.f.scope.intents.getByCode(code))!;
      expect(intent.created_by).toBe(t.f.users.a);
      const audit = await t.f.scope.audit.listForEntity(intent.id, ['spec.linked']);
      expect(audit.at(-1)?.actor_id).toBe(t.f.users.a);
    });

    it('a refused link keeps the intent: 422 with the cause, the intent has no spec', async () => {
      const code = await created('Refund an order');
      const refused = await post('a', `/v1/intents/${code}/specs`, { path: 'docs/specs/none.md' });
      expect(refused.statusCode, refused.body).toBe(422);
      expect(refused.json().error).toMatchObject({ code: 'spec_invalid', reason: 'missing' });

      const shown = await get('a', `/v1/intents/${code}`);
      expect(shown.statusCode, shown.body).toBe(200);
      expect(shown.json()).toMatchObject({ code, spec: null });
    });

    it('X08b (QUESTIONS #728): a session never sends from_lesson; nothing is created', async () => {
      const refused = await post('a', '/v1/intents', {
        ...intentBody('From a lesson'),
        from_lesson: crypto.randomUUID(),
      });
      expect(refused.statusCode, refused.body).toBe(403);
      expect(refused.json().error?.code).toBe('session_write_not_allowed');
    });

    it('a viewer creates nothing (M16); Person B links no spec (access.spec_link_roles)', async () => {
      const refused = await post('viewer', '/v1/intents', intentBody('Not mine'));
      expect(refused.statusCode, refused.body).toBe(403);
      expect(refused.json().error?.code).toBe('forbidden');

      const code = await created('Ship an order');
      for (const who of ['b', 'viewer'] as const) {
        const link = await post(who, `/v1/intents/${code}/specs`, { path: SPEC_PATH });
        expect(link.statusCode, `${who}: ${link.body}`).toBe(403);
        expect(link.json().error?.code).toBe('forbidden');
      }
      expect(await t.f.scope.specRefs.latest((await t.f.scope.intents.getByCode(code))!.id)).toBe(
        undefined,
      );
    });
  });

  describe('AC2: submit the plan file, build an Evidence Pack', () => {
    it('Person A submits the plan; Person B and a viewer are refused', async () => {
      const code = await created('Plan an order change');
      git.commit({ [`.sdlc/plans/${code}.yaml`]: planYaml(code) });
      for (const who of ['b', 'viewer'] as const) {
        const refused = await post(who, `/v1/intents/${code}/plans`);
        expect(refused.statusCode, `${who}: ${refused.body}`).toBe(403);
        expect(refused.json().error?.code).toBe('forbidden');
      }
      const submitted = await post('a', `/v1/intents/${code}/plans`);
      expect(submitted.statusCode, submitted.body).toBe(201);
      expect(submitted.json()).toMatchObject({ intent: code, version: 1 });
    });

    it('a plan file that is not there: refused with the reason the page shows', async () => {
      const code = await created('No plan yet');
      const refused = await post('a', `/v1/intents/${code}/plans`);
      expect(refused.statusCode, refused.body).toBe(422);
      expect(refused.json().error).toMatchObject({ code: 'plan_invalid', reason: 'missing' });
    });

    it('Person B builds a pack (201), again with nothing changed (200); a viewer cannot (M30)', async () => {
      const code = await created('Pack an order');
      const refused = await post('viewer', `/v1/intents/${code}/evidence-packs`);
      expect(refused.statusCode, refused.body).toBe(403);

      const built = await post('b', `/v1/intents/${code}/evidence-packs`);
      expect(built.statusCode, built.body).toBe(201);
      expect(built.json()).toMatchObject({ created: true, pack: { intent: code, version: 1 } });
      const again = await post('b', `/v1/intents/${code}/evidence-packs`);
      expect(again.statusCode, again.body).toBe(200);
      expect(again.json()).toMatchObject({ created: false, pack: { version: 1 } });
    });
  });

  describe('AC3: the session rules still hold', () => {
    it('without the CSRF token every U08 write is refused, nothing is created', async () => {
      const code = await created('CSRF check');
      const noCsrf = Object.fromEntries(
        Object.entries(page(sessions.a)).filter(([name]) => name !== 'x-sdlc-csrf'),
      );
      for (const [url, body] of [
        ['/v1/intents', intentBody('Forged')],
        [`/v1/intents/${code}/specs`, { path: SPEC_PATH }],
        [`/v1/intents/${code}/plans`, {}],
        [`/v1/intents/${code}/evidence-packs`, {}],
      ] as const) {
        const reply = await injectOn(app, url, noCsrf, body);
        expect(reply.statusCode, `${url}: ${reply.body}`).toBe(403);
        expect(reply.json().error?.code).toBe('csrf_refused');
      }
      const forged = await get('a', '/v1/intents?project=shop');
      expect(JSON.stringify(forged.json())).not.toContain('Forged');
    });

    it('with dashboard actions off every U08 write answers dashboard_actions_off', async () => {
      const code = await created('Actions off');
      for (const url of [
        '/v1/intents',
        `/v1/intents/${code}/specs`,
        `/v1/intents/${code}/plans`,
        `/v1/intents/${code}/evidence-packs`,
      ]) {
        const reply = await injectOn(off, url, page(sessions.a), {});
        expect(reply.statusCode, `${url}: ${reply.body}`).toBe(403);
        expect(reply.json().error?.code).toBe('dashboard_actions_off');
      }
    });
  });
});
