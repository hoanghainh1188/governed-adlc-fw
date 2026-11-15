// The webhook signature check with the secret from OpenBao (task O08, design/ADR-M112 §2.4,
// §2.8). The secret is read at start (a missing secret stops the start) and again every 10
// minutes, like the GitHub App key (ADR-M23 §2.2), so a rotated value applies without a restart.
// The check itself is the Git host adapter's `verifyWebhook` (constant-time HMAC compare before
// any part of the body is read).
import { GitHubAdapter } from '@sdlc/adapter-git-github';
import type { GitEvent, RedactedSecret, SecretReader } from '@sdlc/contracts';
import type { PlatformLogger } from '@sdlc/core';

/** The field of the KV entry that holds the secret. */
export const WEBHOOK_SECRET_FIELD = 'secret';

/** How often the secret is read again. */
export const WEBHOOK_SECRET_REFRESH_MS = 10 * 60_000;

/**
 * After a failed read, the next one waits this long, so deliveries (signed or not) never make
 * one OpenBao read each.
 */
export const WEBHOOK_SECRET_RETRY_MS = 60_000;

/** Checks one delivery; throws `GitHostError` (`webhook_bad_signature`, …) like the adapter. */
export interface WebhookVerifier {
  verify(headers: Record<string, string>, rawBody: Buffer): Promise<GitEvent>;
}

export interface OpenBaoWebhookVerifierOptions {
  readonly secrets: SecretReader;
  readonly secretPath: string;
  readonly apiUrl: string;
  readonly log: PlatformLogger;
  readonly now?: () => number;
}

/** The secret is missing or empty at start. */
export class WebhookSecretMissing extends Error {
  override readonly name = 'WebhookSecretMissing';
}

export class OpenBaoWebhookVerifier implements WebhookVerifier {
  readonly #options: OpenBaoWebhookVerifierOptions;
  readonly #now: () => number;
  #adapter: GitHubAdapter | undefined;
  #readAt = 0;
  /** At most one read at a time; concurrent deliveries wait for the same one. */
  #refreshing: Promise<void> | undefined;

  constructor(options: OpenBaoWebhookVerifierOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  /** Reads the secret. Throws `WebhookSecretMissing` when it is not there. */
  async load(): Promise<void> {
    const secret = await this.#read().catch(() => undefined);
    if (!secret) throw new WebhookSecretMissing(this.#options.secretPath);
    this.#use(secret);
  }

  async verify(headers: Record<string, string>, rawBody: Buffer): Promise<GitEvent> {
    if (this.#now() - this.#readAt >= WEBHOOK_SECRET_REFRESH_MS) {
      this.#refreshing ??= this.#refresh().finally(() => {
        this.#refreshing = undefined;
      });
      await this.#refreshing;
    }
    if (this.#adapter === undefined) throw new WebhookSecretMissing(this.#options.secretPath);
    return this.#adapter.verifyWebhook(headers, rawBody);
  }

  /** A failed read keeps the secret it has and tries again after `WEBHOOK_SECRET_RETRY_MS`. */
  async #refresh(): Promise<void> {
    let code: 'missing' | 'unreadable';
    try {
      const secret = await this.#read();
      if (secret) {
        this.#use(secret);
        return;
      }
      code = 'missing';
    } catch {
      code = 'unreadable';
    }
    this.#readAt = this.#now() - WEBHOOK_SECRET_REFRESH_MS + WEBHOOK_SECRET_RETRY_MS;
    this.#options.log.log('warn', 'webhook.secret_refresh_failed', { code });
  }

  async #read(): Promise<RedactedSecret | undefined> {
    const entry = await this.#options.secrets.read(this.#options.secretPath);
    const secret = entry.data[WEBHOOK_SECRET_FIELD];
    return secret && secret.reveal().length > 0 ? secret : undefined;
  }

  #use(secret: RedactedSecret): void {
    this.#adapter = new GitHubAdapter({
      secrets: this.#options.secrets,
      apiUrl: this.#options.apiUrl,
      webhookSecret: secret,
    });
    this.#readAt = this.#now();
  }
}
