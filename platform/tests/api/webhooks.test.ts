// O08 AC2, AC3 (design/ADR-M112 §2.3–§2.5): `POST /v1/webhooks/github` checks the signature with
// the secret from OpenBao before it reads the body, limits the body and the rate, logs a refused
// delivery by code only, sends one hint per new delivery ID with the repository name only, and
// never stores or logs the body.
import { createHmac } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp, type ApiDeps } from '../../apps/api/src/app.js';
import { loadSettings } from '../../apps/api/src/settings.js';
import { DeliveryIds, MAX_DELIVERY_IDS } from '../../apps/api/src/webhooks/delivery-ids.js';
import {
  GITHUB_WEBHOOK_PATH,
  WEBHOOK_BODY_LIMIT_BYTES,
  WebhookState,
} from '../../apps/api/src/webhooks/github-webhooks.js';
import {
  OpenBaoWebhookVerifier,
  WEBHOOK_SECRET_REFRESH_MS,
  WEBHOOK_SECRET_RETRY_MS,
  WebhookSecretMissing,
} from '../../apps/api/src/webhooks/verifier.js';
import { comment, FakeSecrets } from '../git-github/stub-github.js';

const SECRET = 'o08-test-webhook-secret';
const DELIVERY = '72d3162e-cc78-11e3-81ab-4c9367dc0958';
const COMMENT_TEXT = '/approve G3 a sentence that must never reach a log';
const repository = { name: 'shop', owner: { login: 'acme' } };

type App = Awaited<ReturnType<typeof createApp>>;
type Hint = Parameters<NonNullable<NonNullable<ApiDeps['githubWebhooks']>['notify']>>[0];

interface Log {
  readonly level: string;
  readonly event: string;
  readonly fields: Record<string, unknown>;
}

function commentPayload(): unknown {
  return {
    action: 'created',
    repository,
    issue: { number: 3 },
    comment: comment(10, 3, '2026-11-15T08:01:00Z', COMMENT_TEXT),
  };
}

function signed(
  event: string,
  payload: unknown,
  opts: { key?: string; delivery?: string } = {},
): { headers: Record<string, string>; payload: Buffer } {
  const body = Buffer.from(JSON.stringify(payload));
  const signature = createHmac('sha256', opts.key ?? SECRET)
    .update(body)
    .digest('hex');
  return {
    headers: {
      'content-type': 'application/json',
      'x-github-event': event,
      'x-github-delivery': opts.delivery ?? DELIVERY,
      'x-hub-signature-256': `sha256=${signature}`,
    },
    payload: body,
  };
}

describe('O08: the GitHub webhook route', () => {
  let app: App;
  let hints: Hint[];
  let logs: Log[];
  let clock: number;
  let state: WebhookState;
  let notifyImpl: (hint: Hint) => Promise<void>;
  let secrets: FakeSecrets;

  async function start(ratePerMinute = 1000): Promise<void> {
    secrets = new FakeSecrets();
    secrets.data = { secret: SECRET };
    const log = {
      log: (level: string, event: string, fields: Record<string, unknown> = {}) => {
        logs.push({ level, event, fields: { ...fields } });
      },
    };
    const verifier = new OpenBaoWebhookVerifier({
      secrets,
      secretPath: 'api/github-webhook',
      apiUrl: 'https://api.github.invalid',
      log,
      now: () => clock,
    });
    await verifier.load();
    app = await createApp({
      // The webhook route never touches the database except through `notify`.
      db: {} as ApiDeps['db'],
      settings: { rateLimitPerMinute: 100, authFailuresPerMinute: 100 },
      log,
      githubWebhooks: {
        settings: { secretPath: 'api/github-webhook', dedupeMs: 60_000, ratePerMinute },
        verifier,
        notify: (hint) => notifyImpl(hint),
        state,
        now: () => clock,
      },
    });
  }

  beforeEach(async () => {
    hints = [];
    logs = [];
    clock = Date.parse('2026-11-15T08:00:00Z');
    state = new WebhookState();
    notifyImpl = (hint) => {
      hints.push(hint);
      return Promise.resolve();
    };
    await start();
  });

  afterEach(async () => {
    await app.close();
  });

  const post = async (headers: Record<string, string>, payload: Buffer | string) =>
    await app
      .getHttpAdapter()
      .getInstance()
      .inject({ method: 'POST', url: GITHUB_WEBHOOK_PATH, headers, payload });

  /** No log line holds the body, the comment, a signature or (for a refusal) the delivery ID. */
  function expectCleanLogs(): void {
    const text = JSON.stringify(logs);
    expect(text).not.toContain(COMMENT_TEXT);
    expect(text).not.toContain('sha256=');
    expect(text).not.toContain(SECRET);
    for (const line of logs.filter((l) => l.event === 'webhook.refused')) {
      expect(Object.keys(line.fields)).toEqual(['reason']);
    }
  }

  it('AC3: a verified comment wakes the poll of its repository with the name only, answers 202', async () => {
    const { headers, payload } = signed('issue_comment', commentPayload());
    const reply = await post(headers, payload);
    expect(reply.statusCode).toBe(202);
    expect(hints).toEqual([{ host: 'github', repository: 'acme/shop' }]);
    expect(state.lastVerifiedAt).toBe(clock);
    expect(logs).toContainEqual({
      level: 'info',
      event: 'webhook.accepted',
      fields: { delivery_id: DELIVERY, event: 'issue_comment' },
    });
    expectCleanLogs();
  });

  it('AC3: a repeated delivery ID changes nothing (one hint); a new ID wakes again', async () => {
    const first = signed('issue_comment', commentPayload());
    expect((await post(first.headers, first.payload)).statusCode).toBe(202);
    expect((await post(first.headers, first.payload)).statusCode).toBe(202);
    expect(hints).toHaveLength(1);
    expect(logs.map((l) => l.event)).toContain('webhook.duplicate');
    const other = signed('issue_comment', commentPayload(), {
      delivery: '72d3162e-cc78-11e3-81ab-4c9367dc0959',
    });
    expect((await post(other.headers, other.payload)).statusCode).toBe(202);
    expect(hints).toHaveLength(2);
  });

  it('AC2: a wrong or missing signature is refused with 401 before anything is read', async () => {
    const forged = signed('issue_comment', commentPayload(), { key: 'not-the-secret' });
    expect((await post(forged.headers, forged.payload)).statusCode).toBe(401);
    const unsigned = Object.fromEntries(
      Object.entries(forged.headers).filter(([name]) => name !== 'x-hub-signature-256'),
    );
    expect((await post(unsigned, forged.payload)).statusCode).toBe(401);
    // A body changed after signing.
    const good = signed('issue_comment', commentPayload());
    const changed = Buffer.from(good.payload.toString('utf8').replace('G3', 'G7'));
    expect((await post(good.headers, changed)).statusCode).toBe(401);
    expect(hints).toEqual([]);
    expect(state.lastVerifiedAt).toBe(0);
    expect(logs.filter((l) => l.event === 'webhook.refused').map((l) => l.fields)).toEqual([
      { reason: 'bad_signature' },
      { reason: 'bad_signature' },
      { reason: 'bad_signature' },
    ]);
    expectCleanLogs();
  });

  it('AC2: bad headers and other content types answer 400 by code', async () => {
    const good = signed('issue_comment', commentPayload());
    expect(
      (await post({ ...good.headers, 'x-github-delivery': 'd1' }, good.payload)).statusCode,
    ).toBe(400);
    expect(
      (await post({ ...good.headers, 'x-github-event': 'Bad Event' }, good.payload)).statusCode,
    ).toBe(400);
    expect(
      (await post({ ...good.headers, 'content-type': 'application/x-www-form-urlencoded' }, 'a=1'))
        .statusCode,
    ).toBe(400);
    expect(hints).toEqual([]);
    expectCleanLogs();
  });

  it('AC2: a body over 1 MiB answers 413 and is not read further', async () => {
    const big = signed('issue_comment', { padding: 'x'.repeat(WEBHOOK_BODY_LIMIT_BYTES) });
    const reply = await post(big.headers, big.payload);
    expect(reply.statusCode).toBe(413);
    expect(logs.filter((l) => l.event === 'webhook.refused').map((l) => l.fields)).toEqual([
      { reason: 'too_large' },
    ]);
    // A body just under the limit is read (and, unsigned for its kind, ignored).
    const fits = signed('issue_comment', { padding: 'x'.repeat(WEBHOOK_BODY_LIMIT_BYTES - 1000) });
    expect((await post(fits.headers, fits.payload)).statusCode).toBe(202);
  });

  it('AC2: deliveries over the rate limit answer 429', async () => {
    await app.close();
    await start(2);
    const one = signed('ping', { zen: 'x', hook_id: 1 });
    expect((await post(one.headers, one.payload)).statusCode).toBe(202);
    expect((await post(one.headers, one.payload)).statusCode).toBe(202);
    expect((await post(one.headers, one.payload)).statusCode).toBe(429);
    clock += 60_000;
    expect((await post(one.headers, one.payload)).statusCode).toBe(202);
  });

  it('a verified ping (or an event the adapter does not read) is accepted and wakes nothing', async () => {
    const ping = signed('ping', { zen: 'Keep it logically awesome.', hook_id: 1 });
    expect((await post(ping.headers, ping.payload)).statusCode).toBe(202);
    const edited = signed('issue_comment', { ...(commentPayload() as object), action: 'edited' });
    expect((await post(edited.headers, edited.payload)).statusCode).toBe(202);
    expect(hints).toEqual([]);
    expect(state.lastVerifiedAt).toBe(clock);
    expect(logs.filter((l) => l.event === 'webhook.ignored')).toHaveLength(2);
  });

  it('a failed hint answers 503, and a redelivery of the same ID still wakes', async () => {
    notifyImpl = () => Promise.reject(new Error('connection refused'));
    const { headers, payload } = signed('issue_comment', commentPayload());
    expect((await post(headers, payload)).statusCode).toBe(503);
    notifyImpl = (hint) => {
      hints.push(hint);
      return Promise.resolve();
    };
    expect((await post(headers, payload)).statusCode).toBe(202);
    expect(hints).toHaveLength(1);
    expect(logs.filter((l) => l.event === 'webhook.refused').map((l) => l.fields)).toEqual([
      { reason: 'hint_failed' },
    ]);
  });

  it('ADR-M112 §2.8: the secret is read again after 10 minutes; a failed read keeps the old one', async () => {
    const reads = secrets.reads;
    const { headers, payload } = signed('ping', { zen: 'x', hook_id: 1 });
    await post(headers, payload);
    expect(secrets.reads).toBe(reads);
    clock += WEBHOOK_SECRET_REFRESH_MS;
    secrets.data = { secret: 'rotated-secret' };
    expect((await post(headers, payload)).statusCode).toBe(401);
    const rotated = signed('ping', { zen: 'x', hook_id: 1 }, { key: 'rotated-secret' });
    expect((await post(rotated.headers, rotated.payload)).statusCode).toBe(202);
    clock += WEBHOOK_SECRET_REFRESH_MS;
    secrets.data = {};
    expect((await post(rotated.headers, rotated.payload)).statusCode).toBe(202);
    expect(logs.map((l) => l.event)).toContain('webhook.secret_refresh_failed');
  });
  it('AC2: a signature of the wrong length or not in hex is refused with 401', async () => {
    const good = signed('issue_comment', commentPayload());
    for (const value of ['sha256=abc', `sha256=${'z'.repeat(64)}`, `sha1=${'a'.repeat(40)}`]) {
      const headers = { ...good.headers, 'x-hub-signature-256': value };
      expect((await post(headers, good.payload)).statusCode).toBe(401);
    }
    expect(hints).toEqual([]);
  });

  it('AC2: the rate limit applies before the body is read (429, not 413)', async () => {
    await app.close();
    await start(1);
    const one = signed('ping', { zen: 'x', hook_id: 1 });
    expect((await post(one.headers, one.payload)).statusCode).toBe(202);
    const big = signed('ping', { padding: 'x'.repeat(2 * WEBHOOK_BODY_LIMIT_BYTES) });
    expect((await post(big.headers, big.payload)).statusCode).toBe(429);
  });

  it('the other API routes keep their JSON parser, their 64 KiB limit and their guard', async () => {
    const inject = (payload: string) =>
      app
        .getHttpAdapter()
        .getInstance()
        .inject({
          method: 'POST',
          url: '/v1/intents',
          headers: { 'content-type': 'application/json' },
          payload,
        });
    expect((await inject(JSON.stringify({ title: 'x' }))).statusCode).toBe(401);
    expect((await inject(JSON.stringify({ title: 'x'.repeat(70 * 1024) }))).statusCode).toBe(413);
  });

  it('a failing secret read is tried once a minute, never once per delivery', async () => {
    const { headers, payload } = signed('ping', { zen: 'x', hook_id: 1 });
    clock += WEBHOOK_SECRET_REFRESH_MS;
    let reads = 0;
    secrets.read = () => {
      reads += 1;
      return Promise.reject(new Error('sealed'));
    };
    // Concurrent deliveries share one read; the old secret still verifies.
    const replies = await Promise.all([post(headers, payload), post(headers, payload)]);
    expect(replies.map((r) => r.statusCode)).toEqual([202, 202]);
    expect(reads).toBe(1);
    await post(headers, payload);
    expect(reads).toBe(1);
    clock += WEBHOOK_SECRET_RETRY_MS;
    await post(headers, payload);
    expect(reads).toBe(2);
  });
});

describe('O08: without SDLC_API_GITHUB_WEBHOOKS=on', () => {
  it('the route does not exist (404)', async () => {
    const app = await createApp({
      db: {} as ApiDeps['db'],
      settings: { rateLimitPerMinute: 100, authFailuresPerMinute: 100 },
    });
    const { headers, payload } = signed('issue_comment', commentPayload());
    const reply = await app
      .getHttpAdapter()
      .getInstance()
      .inject({ method: 'POST', url: GITHUB_WEBHOOK_PATH, headers, payload });
    expect(reply.statusCode).toBe(404);
    await app.close();
  });

  it('settings: off by default; on is refused in development mode; values are checked', () => {
    expect(loadSettings({}).githubWebhooks).toBeNull();
    expect(loadSettings({ SDLC_API_GITHUB_WEBHOOKS: 'on' }).githubWebhooks).toEqual({
      secretPath: 'api/github-webhook',
      dedupeMs: 259_200_000,
      ratePerMinute: 1200,
    });
    expect(() =>
      loadSettings({
        SDLC_API_GITHUB_WEBHOOKS: 'on',
        SDLC_API_DEV_MODE: '1',
        SDLC_API_DEV_DB_URL: 'postgres://x',
        SDLC_API_TEMPORAL_ADDRESS: 'off',
      }),
    ).toThrow(/webhooks_need_openbao/);
    expect(() =>
      loadSettings({
        SDLC_API_GITHUB_WEBHOOKS: 'on',
        SDLC_API_GITHUB_WEBHOOK_SECRET_PATH: 'worker/x',
      }),
    ).toThrow(/settings.invalid/);
    expect(() => loadSettings({ SDLC_API_GITHUB_WEBHOOKS: 'yes' })).toThrow(/settings.invalid/);
  });

  it('a missing secret stops the start (WebhookSecretMissing)', async () => {
    const secrets = new FakeSecrets();
    secrets.data = {};
    const verifier = new OpenBaoWebhookVerifier({
      secrets,
      secretPath: 'api/github-webhook',
      apiUrl: 'https://api.github.invalid',
      log: { log: () => undefined },
    });
    await expect(verifier.load()).rejects.toBeInstanceOf(WebhookSecretMissing);
  });
});

describe('O08: repeated delivery IDs in memory (QUESTIONS #751)', () => {
  it('expire after their time and never grow past the cap', () => {
    let now = 0;
    const ids = new DeliveryIds(1000, () => now, 3);
    ids.add('a');
    expect(ids.has('a')).toBe(true);
    now = 1000;
    expect(ids.has('a')).toBe(false);
    ids.add('b');
    ids.add('c');
    ids.add('d');
    ids.add('e');
    expect(ids.size).toBeLessThanOrEqual(3);
    expect(ids.has('b')).toBe(false);
    expect(ids.has('e')).toBe(true);
    expect(MAX_DELIVERY_IDS).toBe(10_000);
  });
});
