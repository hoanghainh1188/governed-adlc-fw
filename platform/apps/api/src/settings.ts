// Settings of the api process (task B03, ADR-M26 section 2.6). Infrastructure settings come from
// the environment, never from project configuration. No secret is ever read from an environment
// variable: the database password comes from OpenBao, the AppRole credentials from files.
import { TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE, type TemporalSettings } from '@sdlc/workflow-client';
import { z } from 'zod';

export const API_ENV = {
  host: 'SDLC_API_HOST',
  port: 'SDLC_API_PORT',
  dbHost: 'SDLC_API_DB_HOST',
  dbPort: 'SDLC_API_DB_PORT',
  dbName: 'SDLC_API_DB_NAME',
  dbSecretPath: 'SDLC_API_DB_SECRET_PATH',
  rateLimitPerMinute: 'SDLC_API_RATE_LIMIT_PER_MINUTE',
  authFailuresPerMinute: 'SDLC_API_AUTH_FAILURES_PER_MINUTE',
  devMode: 'SDLC_API_DEV_MODE',
  devDbUrl: 'SDLC_API_DEV_DB_URL',
  temporalAddress: 'SDLC_API_TEMPORAL_ADDRESS',
  temporalNamespace: 'SDLC_API_TEMPORAL_NAMESPACE',
  githubApiUrl: 'SDLC_API_GITHUB_API_URL',
  evidenceUrl: 'SDLC_API_EVIDENCE_URL',
  evidenceBucket: 'SDLC_API_EVIDENCE_BUCKET',
  evidenceSecretPath: 'SDLC_API_EVIDENCE_SECRET_PATH',
  evidenceMaxItemMb: 'SDLC_API_EVIDENCE_MAX_ITEM_MB',
  dashboardDir: 'SDLC_API_DASHBOARD_DIR',
  webSignIn: 'SDLC_API_WEB_SIGNIN',
  publicOrigin: 'SDLC_API_PUBLIC_ORIGIN',
  githubWebUrl: 'SDLC_API_GITHUB_WEB_URL',
  githubOauthSecretPath: 'SDLC_API_GITHUB_OAUTH_SECRET_PATH',
  sessionIdleMinutes: 'SDLC_API_SESSION_IDLE_MINUTES',
  sessionMaxHours: 'SDLC_API_SESSION_MAX_HOURS',
  trustedProxy: 'SDLC_API_TRUSTED_PROXY',
  dashboardActions: 'SDLC_API_DASHBOARD_ACTIONS',
  githubWebhooks: 'SDLC_API_GITHUB_WEBHOOKS',
  githubWebhookSecretPath: 'SDLC_API_GITHUB_WEBHOOK_SECRET_PATH',
  webhookDedupeSeconds: 'SDLC_API_WEBHOOK_DEDUPE_SECONDS',
  webhookRatePerMinute: 'SDLC_API_WEBHOOK_RATE_PER_MINUTE',
} as const;

/** Fields of the KV entry written by `openbao:bootstrap api-evidence-credentials` (E02). */
export const EVIDENCE_ACCESS_KEY_FIELD = 'access_key';
export const EVIDENCE_SECRET_KEY_FIELD = 'secret_key';
/** The api writes Evidence Packs under this prefix only (SeaweedFS `Write:evidence/packs/*`). */
export const EVIDENCE_PACK_KEY_PREFIX = 'packs/';

/** The database role of every platform process (ADR-M09 section 2.3). */
export const DB_USER = 'platform_app';

const port = z.coerce.number().int().min(1).max(65_535);
const perMinute = z.coerce.number().int().min(1).max(100_000);

const schema = z.object({
  [API_ENV.host]: z.string().min(1).default('127.0.0.1'),
  [API_ENV.port]: port.default(8080),
  [API_ENV.dbHost]: z.string().min(1).default('postgres'),
  [API_ENV.dbPort]: port.default(5432),
  [API_ENV.dbName]: z
    .string()
    .regex(/^[a-z_][a-z0-9_]{0,62}$/)
    .default('platform'),
  // Path in the KV engine; the `api` AppRole may read `kv/data/api/*` only (ADR-M19 section 2.4).
  [API_ENV.dbSecretPath]: z
    .string()
    .regex(/^api\/[A-Za-z0-9_.-]+$/)
    .default('api/database'),
  [API_ENV.rateLimitPerMinute]: perMinute.default(120),
  [API_ENV.authFailuresPerMinute]: perMinute.default(10),
  [API_ENV.devMode]: z.enum(['', '0', '1']).default(''),
  [API_ENV.devDbUrl]: z.string().optional(),
  // The intent workflow (B07, ADR-M30); `off`: no wake signals, development mode only.
  [API_ENV.temporalAddress]: z
    .string()
    .refine((v) => v === 'off' || TEMPORAL_ADDRESS.test(v))
    .default('temporal:7233'),
  [API_ENV.temporalNamespace]: z.string().regex(TEMPORAL_NAMESPACE).default('default'),
  // The Git host the spec endpoints read (B08, ADR-M39 §2.2); the App key comes from OpenBao.
  [API_ENV.githubApiUrl]: z
    .string()
    .regex(/^https:\/\/[^\s]+$/)
    .default('https://api.github.com'),
  // The Evidence Pack store (E02, ADR-M48): SeaweedFS's S3 API on the Compose network; `off`
  // turns the pack endpoints off (they answer evidence_unavailable). An origin only.
  [API_ENV.evidenceUrl]: z
    .string()
    .refine((v) => v === 'off' || isOrigin(v))
    .default('http://seaweedfs:8333'),
  [API_ENV.evidenceBucket]: z
    .string()
    .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/)
    .default('evidence'),
  [API_ENV.evidenceSecretPath]: z
    .string()
    .regex(/^api\/[A-Za-z0-9_.-]+$/)
    .default('api/evidence'),
  // The largest evidence file the api reads back to check its hash, one file at a time.
  [API_ENV.evidenceMaxItemMb]: z.coerce.number().int().min(1).max(4096).default(256),
  // The read-only dashboard's built files (U01, ADR-M54); `off`: no dashboard routes.
  [API_ENV.dashboardDir]: z
    .string()
    .refine((v) => v === 'off' || v.startsWith('/'))
    .default('off'),
  // Dashboard sign-in with GitHub (U05, ADR-M73 §2.2); `off` by default.
  [API_ENV.webSignIn]: z.enum(['off', 'github']).default('off'),
  // The origin people open the dashboard at; the GitHub callback URL is built from it.
  [API_ENV.publicOrigin]: z
    .string()
    .refine((v) => v === '' || isOrigin(v))
    .default(''),
  [API_ENV.githubWebUrl]: z
    .string()
    .refine((v) => isOrigin(v) && v.startsWith('https://'))
    .default('https://github.com'),
  [API_ENV.githubOauthSecretPath]: z
    .string()
    .regex(/^api\/[A-Za-z0-9_.-]+$/)
    .default('api/github-oauth'),
  [API_ENV.sessionIdleMinutes]: z.coerce.number().int().min(5).max(120).default(30),
  [API_ENV.sessionMaxHours]: z.coerce.number().int().min(1).max(24).default(8),
  // Writes from the dashboard (U06, ADR-M73 §2.3): off by default; on needs the GitHub sign-in.
  [API_ENV.dashboardActions]: z.enum(['off', 'on']).default('off'),
  // GitHub webhooks (O08, ADR-M112 §2.7): off by default; on needs OpenBao for the secret.
  [API_ENV.githubWebhooks]: z.enum(['off', 'on']).default('off'),
  [API_ENV.githubWebhookSecretPath]: z
    .string()
    .regex(/^api\/[A-Za-z0-9_.-]+$/)
    .default('api/github-webhook'),
  // GitHub lets a person redeliver the deliveries of the past 3 days.
  [API_ENV.webhookDedupeSeconds]: z.coerce.number().int().min(60).max(604_800).default(259_200),
  [API_ENV.webhookRatePerMinute]: perMinute.default(1200),
  // Team access (V09, ADR-M67 §2.5): the one address whose X-Forwarded-For the api trusts, the
  // proxy's fixed address on the network `access`. Empty: trust no forwarded header.
  [API_ENV.trustedProxy]: z
    .string()
    .refine((v) => v === '' || isIpv4(v))
    .default(''),
  NODE_ENV: z.string().optional(),
});

/** A dotted IPv4 address (four numbers 0-255, no leading zeros). */
export function isIpv4(value: string): boolean {
  const parts = value.split('.');
  return parts.length === 4 && parts.every((p) => /^(0|[1-9]\d{0,2})$/.test(p) && Number(p) <= 255);
}

function isOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      url.username === '' &&
      url.password === '' &&
      url.pathname === '/' &&
      url.search === '' &&
      url.hash === '' &&
      !value.endsWith('#') &&
      !value.endsWith('?')
    );
  } catch {
    return false;
  }
}

export type Database =
  | {
      readonly kind: 'openbao';
      readonly host: string;
      readonly port: number;
      readonly name: string;
      readonly secretPath: string;
    }
  | { readonly kind: 'dev_url'; readonly url: string };

export interface ApiSettings {
  readonly host: string;
  readonly port: number;
  readonly database: Database;
  readonly rateLimitPerMinute: number;
  readonly authFailuresPerMinute: number;
  /** Where to wake intent workflows (B07); null: no signals (development only). */
  readonly temporal: TemporalSettings | null;
  /** GitHub API base URL for the spec endpoints (B08). */
  readonly githubApiUrl: string;
  /** The Evidence Pack store (E02, ADR-M48); null: `SDLC_API_EVIDENCE_URL=off`. */
  readonly evidence: {
    readonly url: string;
    readonly bucket: string;
    readonly secretPath: string;
    readonly maxItemBytes: number;
  } | null;
  /** The dashboard's built files (U01, ADR-M54): an absolute folder; null: `off`. */
  readonly dashboardDir: string | null;
  /** Dashboard sign-in with GitHub (U05, ADR-M73 §2.2); null: `SDLC_API_WEB_SIGNIN=off`. */
  readonly webSignIn: WebSignInSettings | null;
  /**
   * The team access proxy's address (V09, ADR-M67 §2.5): Fastify's `trustProxy`, so the client
   * address comes from `X-Forwarded-For` only on requests from this peer; null: never.
   */
  readonly trustedProxy: string | null;
  /** GitHub webhooks (O08, ADR-M112 §2.4, §2.7); null: `SDLC_API_GITHUB_WEBHOOKS=off`. */
  readonly githubWebhooks: GitHubWebhookSettings | null;
}

export interface GitHubWebhookSettings {
  /** KV path of the webhook secret (field `secret`), readable by the `api` AppRole only. */
  readonly secretPath: string;
  /** How long a delivery ID counts as already seen. */
  readonly dedupeMs: number;
  /** Deliveries per client address and minute. */
  readonly ratePerMinute: number;
}

export interface WebSignInSettings {
  /** The origin people open the dashboard at, for example `http://localhost:8090`. */
  readonly publicOrigin: string;
  /** `<publicOrigin>/v1/auth/github/callback`: listed in the GitHub App's settings. */
  readonly callbackUrl: string;
  readonly githubWebUrl: string;
  readonly githubApiUrl: string;
  readonly oauthSecretPath: string;
  readonly idleMs: number;
  readonly maxAgeMs: number;
  /**
   * `SDLC_API_DASHBOARD_ACTIONS=on` (U06, ADR-M73 §2.3): sessions may use the routes marked
   * `'actions'` (passkeys, the step-up; the decisions with U07). Default false.
   */
  readonly actions?: boolean;
}

/** The callback path of the sign-in (the GitHub App lists `<origin>` + this). */
export const GITHUB_CALLBACK_PATH = '/v1/auth/github/callback';

/**
 * A public origin is allowed when it is `https://`, or plain `http://` on `localhost` only
 * (ADR-M73 §2.3): cookies are `Secure`, and browsers treat only `localhost` as a secure context
 * without TLS. `127.0.0.1` is refused too: WebAuthn (U06) refuses an IP address as a site name.
 */
export function isAllowedPublicOrigin(value: string): boolean {
  if (!isOrigin(value)) return false;
  const url = new URL(value);
  return url.protocol === 'https:' || url.hostname === 'localhost';
}

/** A setting is missing or wrong. `key` is a message catalog key; `name` the variable. */
export class SettingsError extends Error {
  override readonly name = 'SettingsError';

  constructor(
    readonly key:
      | 'api.settings.invalid'
      | 'api.settings.dev_mode_in_production'
      | 'api.settings.dev_url_missing'
      | 'api.settings.temporal_off_in_production'
      | 'api.settings.public_origin_missing'
      | 'api.settings.public_origin_insecure'
      | 'api.settings.actions_need_signin'
      | 'api.settings.webhooks_need_openbao'
      | 'api.settings.webhook_secret_missing',
    readonly setting: string,
  ) {
    super(`${key}: ${setting}`);
  }
}

export function loadSettings(env: Readonly<Record<string, string | undefined>>): ApiSettings {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new SettingsError('api.settings.invalid', String(parsed.error.issues[0]?.path[0] ?? ''));
  }
  const v = parsed.data;
  const dev = v[API_ENV.devMode] === '1';
  if (dev && v.NODE_ENV === 'production') {
    throw new SettingsError('api.settings.dev_mode_in_production', API_ENV.devMode);
  }
  const temporalOff = v[API_ENV.temporalAddress] === 'off';
  if (temporalOff && !dev) {
    throw new SettingsError('api.settings.temporal_off_in_production', API_ENV.temporalAddress);
  }
  let database: Database;
  if (dev) {
    const url = v[API_ENV.devDbUrl];
    if (!url) throw new SettingsError('api.settings.dev_url_missing', API_ENV.devDbUrl);
    database = { kind: 'dev_url', url };
  } else {
    database = {
      kind: 'openbao',
      host: v[API_ENV.dbHost],
      port: v[API_ENV.dbPort],
      name: v[API_ENV.dbName],
      secretPath: v[API_ENV.dbSecretPath],
    };
  }
  // U06 (ADR-M73 §2.3): actions are writes of a dashboard session, so they need the sign-in, and
  // with it a public origin that is https://, or http:// on localhost (checked below).
  const actions = v[API_ENV.dashboardActions] === 'on';
  if (actions && v[API_ENV.webSignIn] !== 'github') {
    throw new SettingsError('api.settings.actions_need_signin', API_ENV.dashboardActions);
  }
  // O08 (ADR-M112 §2.8): the webhook secret lives in OpenBao only, so dev mode has no webhooks.
  const webhooksOn = v[API_ENV.githubWebhooks] === 'on';
  if (webhooksOn && dev) {
    throw new SettingsError('api.settings.webhooks_need_openbao', API_ENV.githubWebhooks);
  }
  let webSignIn: WebSignInSettings | null = null;
  if (v[API_ENV.webSignIn] === 'github') {
    const origin = v[API_ENV.publicOrigin];
    if (origin === '') {
      throw new SettingsError('api.settings.public_origin_missing', API_ENV.publicOrigin);
    }
    if (!isAllowedPublicOrigin(origin)) {
      throw new SettingsError('api.settings.public_origin_insecure', API_ENV.publicOrigin);
    }
    const publicOrigin = new URL(origin).origin;
    webSignIn = {
      publicOrigin,
      callbackUrl: `${publicOrigin}${GITHUB_CALLBACK_PATH}`,
      githubWebUrl: new URL(v[API_ENV.githubWebUrl]).origin,
      githubApiUrl: v[API_ENV.githubApiUrl],
      oauthSecretPath: v[API_ENV.githubOauthSecretPath],
      idleMs: v[API_ENV.sessionIdleMinutes] * 60_000,
      maxAgeMs: v[API_ENV.sessionMaxHours] * 3_600_000,
      actions,
    };
  }
  return {
    host: v[API_ENV.host],
    webSignIn,
    trustedProxy: v[API_ENV.trustedProxy] === '' ? null : v[API_ENV.trustedProxy],
    githubWebhooks: webhooksOn
      ? {
          secretPath: v[API_ENV.githubWebhookSecretPath],
          dedupeMs: v[API_ENV.webhookDedupeSeconds] * 1000,
          ratePerMinute: v[API_ENV.webhookRatePerMinute],
        }
      : null,
    port: v[API_ENV.port],
    database,
    rateLimitPerMinute: v[API_ENV.rateLimitPerMinute],
    authFailuresPerMinute: v[API_ENV.authFailuresPerMinute],
    githubApiUrl: v[API_ENV.githubApiUrl],
    dashboardDir: v[API_ENV.dashboardDir] === 'off' ? null : v[API_ENV.dashboardDir],
    evidence:
      v[API_ENV.evidenceUrl] === 'off'
        ? null
        : {
            url: new URL(v[API_ENV.evidenceUrl]).origin,
            bucket: v[API_ENV.evidenceBucket],
            secretPath: v[API_ENV.evidenceSecretPath],
            maxItemBytes: v[API_ENV.evidenceMaxItemMb] * 1024 * 1024,
          },
    temporal: temporalOff
      ? null
      : { address: v[API_ENV.temporalAddress], namespace: v[API_ENV.temporalNamespace] },
  };
}
