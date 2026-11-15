// `POST /v1/webhooks/github` (task O08, design/ADR-M112 §2.3–§2.5, D-08 O08 AC2, AC3).
//
// - Registered on Fastify directly, in its own context: the raw body (up to 1 MiB) is kept as a
//   Buffer for the signature check, and the route is outside the token and session guards (the
//   signature is the authentication). Without `SDLC_API_GITHUB_WEBHOOKS=on` it does not exist.
// - A verified delivery only wakes the worker's poll of its repository (`NOTIFY`): the event kind
//   and the repository name are the only things read from the body, and nothing of it is stored,
//   logged or passed on (R031). The poll reads the events again from GitHub, through the same
//   handler, cursor and receipts as every poll (R037).
// - A refused delivery is logged by code only, never with a header, the delivery ID or the body.
import { GitHostError, type GitEvent } from '@sdlc/contracts';
import type { GitHint, PlatformLogger } from '@sdlc/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { RateLimiter } from '../auth/rate-limiter.js';
import type { GitHubWebhookSettings } from '../settings.js';
import { DeliveryIds } from './delivery-ids.js';
import { WebhookSecretMissing, type WebhookVerifier } from './verifier.js';

export const GITHUB_WEBHOOK_PATH = '/v1/webhooks/github';

/** Largest delivery read; equal to the webhook listener's body limit in the access proxy. */
export const WEBHOOK_BODY_LIMIT_BYTES = 1024 * 1024;

/** GitHub's delivery IDs are GUIDs. */
const DELIVERY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVENT_NAME = /^[a-z_]{1,64}$/;

/** Why a delivery was refused: the only value its log line holds. */
export type WebhookRefusal =
  | 'rate_limited'
  | 'bad_headers'
  | 'too_large'
  | 'bad_signature'
  | 'secret_unavailable'
  | 'hint_failed'
  | 'failed';

/** What the api knows about deliveries, for the doctor check of PR 3 (ADR-M112 §2.9). */
export class WebhookState {
  /** When the last delivery with a correct signature arrived (ms since the epoch); 0: never. */
  lastVerifiedAt = 0;
}

export interface GitHubWebhookDeps {
  readonly settings: GitHubWebhookSettings;
  readonly verifier: WebhookVerifier;
  /** Sends the hint (`PlatformDatabase.notifyGitHint`). */
  readonly notify: (hint: GitHint) => Promise<void>;
  readonly log: PlatformLogger;
  readonly state?: WebhookState;
  /** Milliseconds since the epoch. */
  readonly now?: () => number;
}

type Fastify = ReturnType<ReturnType<NestFastifyApplication['getHttpAdapter']>['getInstance']>;

interface Reply {
  code(status: number): { send(body?: unknown): unknown };
}

/** The request's headers with string values only (Node lowers their names). */
function headersOf(raw: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value === 'string') out[name] = value;
  }
  return out;
}

function repositoryOf(event: GitEvent): string {
  return `${event.repo.owner}/${event.repo.name}`;
}

export function registerGitHubWebhooks(app: NestFastifyApplication, deps: GitHubWebhookDeps): void {
  const now = deps.now ?? Date.now;
  const state = deps.state ?? new WebhookState();
  const ids = new DeliveryIds(deps.settings.dedupeMs, now);
  const perAddress = new RateLimiter(deps.settings.ratePerMinute, 60_000, now);

  const refuse = (reply: Reply, status: number, reason: WebhookRefusal): unknown => {
    deps.log.log(status >= 500 ? 'error' : 'warn', 'webhook.refused', { reason });
    return reply.code(status).send({ code: reason });
  };
  const accept = (
    reply: Reply,
    event: 'webhook.accepted' | 'webhook.duplicate' | 'webhook.ignored',
    fields: { delivery_id: string; event: string },
  ): unknown => {
    deps.log.log('info', event, fields);
    return reply.code(202).send();
  };

  const fastify: Fastify = app.getHttpAdapter().getInstance();
  void fastify.register((child, _options, done) => {
    // This context parses JSON bodies as raw bytes only; the rest of the api keeps its parser.
    child.removeAllContentTypeParsers();
    child.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer', bodyLimit: WEBHOOK_BODY_LIMIT_BYTES },
      (_request, body, done) => {
        done(null, body);
      },
    );
    child.setErrorHandler((error: { code?: unknown }, _request, reply) => {
      const code = typeof error.code === 'string' ? error.code : '';
      if (code === 'FST_ERR_CTP_BODY_TOO_LARGE') return refuse(reply, 413, 'too_large');
      if (code.startsWith('FST_ERR_CTP_')) return refuse(reply, 400, 'bad_headers');
      return refuse(reply, 500, 'failed');
    });

    // Before the body is read: the rate limit and the headers, so a refused request never makes
    // the api buffer up to 1 MiB.
    child.addHook('onRequest', (request, reply, done) => {
      if (!perAddress.hit(request.ip)) {
        refuse(reply, 429, 'rate_limited');
        return;
      }
      const delivery = request.headers['x-github-delivery'];
      const kind = request.headers['x-github-event'];
      if (
        typeof delivery !== 'string' ||
        !DELIVERY_ID.test(delivery) ||
        typeof kind !== 'string' ||
        !EVENT_NAME.test(kind)
      ) {
        refuse(reply, 400, 'bad_headers');
        return;
      }
      done();
    });

    child.post(
      GITHUB_WEBHOOK_PATH,
      { bodyLimit: WEBHOOK_BODY_LIMIT_BYTES },
      async (request, reply) => {
        // The rate limit and the header formats were checked in `onRequest`.
        const headers = headersOf(request.headers);
        const delivery = headers['x-github-delivery'] ?? '';
        const kind = headers['x-github-event'] ?? '';
        const body = request.body;
        if (!DELIVERY_ID.test(delivery) || !EVENT_NAME.test(kind) || !Buffer.isBuffer(body)) {
          return refuse(reply, 400, 'bad_headers');
        }
        const fields = { delivery_id: delivery.toLowerCase(), event: kind };

        let event: GitEvent | null;
        try {
          event = await deps.verifier.verify(headers, body);
        } catch (error) {
          if (error instanceof WebhookSecretMissing) {
            return refuse(reply, 503, 'secret_unavailable');
          }
          if (!(error instanceof GitHostError)) return refuse(reply, 500, 'failed');
          if (error.code === 'webhook_bad_signature') return refuse(reply, 401, 'bad_signature');
          if (error.code === 'webhook_disabled') return refuse(reply, 503, 'secret_unavailable');
          // The signature was correct; the adapter maps no event from it (`ping`, an action we do
          // not read, or a payload without a repository). Nothing to wake.
          event = null;
        }
        state.lastVerifiedAt = now();
        if (event === null) return accept(reply, 'webhook.ignored', fields);
        if (ids.has(fields.delivery_id)) return accept(reply, 'webhook.duplicate', fields);

        try {
          await deps.notify({ host: 'github', repository: repositoryOf(event) });
        } catch {
          // GitHub records a failed delivery; the reconciliation poll reads the events later.
          return refuse(reply, 503, 'hint_failed');
        }
        // Recorded only once the hint left, so a redelivery after a failed hint still wakes.
        ids.add(fields.delivery_id);
        return accept(reply, 'webhook.accepted', fields);
      },
    );
    done();
  });
}
