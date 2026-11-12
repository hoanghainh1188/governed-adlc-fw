// Options of the GitHub adapter (design/ADR-M23 §2.6). These are technical settings, not
// handbook rules: the polling interval (`github.poll_interval_seconds`) is project configuration
// and belongs to the poller (B06), not to this adapter.
import type { GitHostLogger, RedactedSecret, SecretReader } from '@sdlc/contracts';
import { GitHostError } from '@sdlc/contracts';

export interface GitHubAdapterOptions {
  /** Reads the GitHub App key (`shared/github-app`: `client_id` or `app_id`, `private_key`). */
  readonly secrets: SecretReader;
  /** KV path of the GitHub App entry. Default `shared/github-app` (D-03 §8.2). */
  readonly secretPath?: string;
  /** REST API base URL. Default `https://api.github.com`. */
  readonly apiUrl?: string;
  /** Allows an `http://` API URL. Tests only (the in-process GitHub stub). */
  readonly allowPlaintext?: boolean;
  /** Webhook secret. Without it, `verifyWebhook` refuses every request (webhooks come later). */
  readonly webhookSecret?: RedactedSecret;
  readonly logger?: GitHostLogger;
  /** Clock, for tests. */
  readonly now?: () => Date;
  /** Waits between retries, for tests. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Timeout of one HTTP request. Default 15 000 ms. */
  readonly requestTimeoutMs?: number;
  /** Retries of a GET after a network error or a 5xx answer. Default 2. POSTs are never retried. */
  readonly maxRetries?: number;
  /** First retry delay; doubled for each retry. Default 500 ms. */
  readonly retryBaseDelayMs?: number;
  /** An installation token is replaced this long before it expires. Default 300 s. */
  readonly tokenRefreshMarginSeconds?: number;
  /** The App key is read again after this time, so a rotated key needs no restart. Default 600 s. */
  readonly keyCacheSeconds?: number;
  /** Polling reads this far back before the cursor, for items the host shows late. Default 60 s. */
  readonly pollOverlapSeconds?: number;
  /** Pages of 100 items per stream and poll. Default 4. */
  readonly maxPagesPerPoll?: number;
  /** Open pull requests checked for CI results per poll. Default 50. */
  readonly maxOpenPullRequests?: number;
  /** Largest file `getFileAtCommit` returns. Default 1 MiB. */
  readonly maxFileBytes?: number;
  /** Most Git trees calls `listPaths` makes for one large commit (O06, ADR-M106). Default 200. */
  readonly maxTreeRequests?: number;
}

export interface ResolvedOptions {
  readonly secrets: SecretReader;
  readonly secretPath: string;
  readonly apiUrl: URL;
  readonly webhookSecret: RedactedSecret | undefined;
  readonly logger: GitHostLogger;
  readonly now: () => Date;
  readonly sleep: (ms: number) => Promise<void>;
  readonly requestTimeoutMs: number;
  readonly maxRetries: number;
  readonly retryBaseDelayMs: number;
  readonly tokenRefreshMarginSeconds: number;
  readonly keyCacheSeconds: number;
  readonly pollOverlapSeconds: number;
  readonly maxPagesPerPoll: number;
  readonly maxOpenPullRequests: number;
  readonly maxFileBytes: number;
  readonly maxTreeRequests: number;
}

/** KV path of the GitHub App entry (D-03 §8.2, OpenBao policies api, worker, runner). */
export const DEFAULT_GITHUB_APP_SECRET_PATH = 'shared/github-app';

const silentLogger: GitHostLogger = { log: () => undefined };

function count(
  name: string,
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const v = value ?? fallback;
  if (!Number.isInteger(v) || v < min || v > max) {
    throw new GitHostError('invalid_input', { field: name, minimum: min, maximum: max });
  }
  return v;
}

export function resolveOptions(options: GitHubAdapterOptions): ResolvedOptions {
  let apiUrl: URL;
  try {
    apiUrl = new URL(options.apiUrl ?? 'https://api.github.com');
  } catch {
    throw new GitHostError('invalid_input', { field: 'apiUrl' });
  }
  const plaintextAllowed = options.allowPlaintext === true && apiUrl.protocol === 'http:';
  if (
    (apiUrl.protocol !== 'https:' && !plaintextAllowed) ||
    apiUrl.username ||
    apiUrl.password ||
    apiUrl.search ||
    apiUrl.hash
  ) {
    throw new GitHostError('invalid_input', { field: 'apiUrl' });
  }
  if (!apiUrl.pathname.endsWith('/')) apiUrl.pathname += '/';
  return {
    secrets: options.secrets,
    secretPath: options.secretPath ?? DEFAULT_GITHUB_APP_SECRET_PATH,
    apiUrl,
    webhookSecret: options.webhookSecret,
    logger: options.logger ?? silentLogger,
    now: options.now ?? (() => new Date()),
    sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    requestTimeoutMs: count('requestTimeoutMs', options.requestTimeoutMs, 15_000, 100, 120_000),
    maxRetries: count('maxRetries', options.maxRetries, 2, 0, 5),
    retryBaseDelayMs: count('retryBaseDelayMs', options.retryBaseDelayMs, 500, 0, 60_000),
    tokenRefreshMarginSeconds: count(
      'tokenRefreshMarginSeconds',
      options.tokenRefreshMarginSeconds,
      300,
      60,
      1800,
    ),
    keyCacheSeconds: count('keyCacheSeconds', options.keyCacheSeconds, 600, 0, 86_400),
    pollOverlapSeconds: count('pollOverlapSeconds', options.pollOverlapSeconds, 60, 0, 3600),
    maxPagesPerPoll: count('maxPagesPerPoll', options.maxPagesPerPoll, 4, 1, 20),
    maxOpenPullRequests: count('maxOpenPullRequests', options.maxOpenPullRequests, 50, 1, 500),
    maxFileBytes: count('maxFileBytes', options.maxFileBytes, 1024 * 1024, 1, 100 * 1024 * 1024),
    maxTreeRequests: count('maxTreeRequests', options.maxTreeRequests, 200, 1, 5000),
  };
}
