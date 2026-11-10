// Authentication for every route that is not public (D-08 B03 AC1, AC2; U05, ADR-M73 §2.2).
//
// - A bearer token (CLI): checked for shape, hashed, and looked up by its hash only.
// - A dashboard session cookie (U05): the same, by the SHA-256 of the session secret; idle and
//   absolute timeouts, active user and tenant, identity still linked.
// - Never both: a request with an `Authorization` header and a session cookie is refused.
// - A session reads (`GET`, `HEAD`). It writes only to a route marked `@SessionAction()` (U06,
//   ADR-M73 §2.3, QUESTIONS #410), and only with all three CSRF layers: the cookie is
//   `SameSite=Strict`; `X-SDLC-CSRF` holds the session's CSRF token; `Origin` equals the public
//   origin (and `Sec-Fetch-Site` is `same-origin` when the browser sends it). The body is
//   `application/json`, or there is none. A route marked `'actions'` also needs
//   `SDLC_API_DASHBOARD_ACTIONS=on`. Bearer requests are unchanged.
// Tokens and secrets are never logged.
import { SetMetadata, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { timingSafeEqual } from 'node:crypto';

import {
  hashApiToken,
  hashCsrfToken,
  hashSessionSecret,
  isApiTokenFormat,
  type AuthTenantStatus,
  type PlatformDatabase,
  type TenantId,
} from '@sdlc/core';

import { ApiError } from '../errors/api-error.js';
import { clearCookie, hasCookie, readCookie, SESSION_COOKIE } from './cookies.js';
import type { AuthenticatedRequest, Credential } from './principal.js';
import type { RateLimiter } from './rate-limiter.js';

const PUBLIC = 'sdlc:public';
const SESSION_ACTION = 'sdlc:session-action';

/** Marks a route that needs no token (health checks, the sign-in redirects). */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(PUBLIC, true);

/**
 * Which writes a dashboard session may send (U06, ADR-M73 §2.3). `always`: sign out, open whatever
 * `SDLC_API_DASHBOARD_ACTIONS` says; `actions`: only with actions on. A write route without this
 * marker refuses every session (`session_write_not_allowed`). The CSRF layers apply to both.
 */
export type SessionActionKind = 'always' | 'actions';

export const SessionAction = (kind: SessionActionKind): MethodDecorator =>
  SetMetadata(SESSION_ACTION, kind);

/** The header that carries the session's CSRF token (ADR-M73 §2.3). */
export const CSRF_HEADER = 'x-sdlc-csrf';

/** `last_used_at` / `last_seen_at` are written at most once per credential per interval. */
const TOUCH_INTERVAL_MS = 60_000;

const READ_METHODS = new Set(['GET', 'HEAD']);

interface GuardRequest extends AuthenticatedRequest {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly ip: string;
  readonly method: string;
  readonly url?: string;
}

export interface SessionGuardSettings {
  /** The idle timeout (setting `SDLC_API_SESSION_IDLE_MINUTES`). */
  readonly idleMs: number;
  /** The only `Origin` a session's write may come from. */
  readonly publicOrigin: string;
  /** `SDLC_API_DASHBOARD_ACTIONS=on` (U06): routes marked `'actions'` take sessions. */
  readonly actions: boolean;
}

export interface AuthGuardDeps {
  readonly reflector: Reflector;
  readonly db: PlatformDatabase;
  /** Requests per token or session and minute. */
  readonly requests: RateLimiter;
  /** Failed authentications per client address and minute. */
  readonly failures: RateLimiter;
  readonly now: () => Date;
  /** Dashboard sessions (U05). Undefined: sign-in is off and session cookies are ignored. */
  readonly sessions?: SessionGuardSettings;
}

interface Resolved {
  readonly tenantId: TenantId;
  readonly userId: string;
  readonly credential: Credential;
  /** A session's CSRF token hash (U06); null before U06; undefined for a token. */
  readonly csrfSha256?: string | null;
  /** H03c: `pending_deletion` may only call the client data-deletion routes (and `GET /v1/me`). */
  readonly tenantStatus: AuthTenantStatus;
}

export class AuthGuard implements CanActivate {
  readonly #lastTouch = new Map<string, number>();

  constructor(private readonly deps: AuthGuardDeps) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.deps.reflector.getAllAndOverride<boolean | undefined>(PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<GuardRequest>();
    const client = `ip:${request.ip}`;
    if (this.deps.failures.blocked(client)) throw new ApiError(429, 'rate_limited');

    const sessions = this.deps.sessions;
    const cookieSent = sessions !== undefined && hasCookie(request.headers.cookie, SESSION_COOKIE);
    if (cookieSent && request.headers.authorization !== undefined) {
      this.deps.failures.hit(client);
      throw new ApiError(400, 'credentials_ambiguous');
    }

    const now = this.deps.now();
    const resolved = cookieSent
      ? await this.#session(request, sessions, now)
      : await this.#token(request, now);
    if (!resolved && cookieSent) {
      // An ended or expired session is normal: never counted against the address (the secret is
      // 32 random bytes, not guessable), and the browser is told to drop the cookie, so a stale
      // cookie neither blocks other clients on the address nor turns later bearer requests into
      // `credentials_ambiguous` (security review of U05, MEDIUM-2).
      context
        .switchToHttp()
        .getResponse<{ header(name: string, value: string): unknown }>()
        .header('set-cookie', clearCookie(SESSION_COOKIE));
      throw new ApiError(401, 'session_ended');
    }
    if (!resolved) {
      this.deps.failures.hit(client);
      throw new ApiError(401, 'unauthorized');
    }
    if (resolved.credential.kind === 'session') {
      this.#checkSessionWrite(context, request, sessions!, resolved.csrfSha256 ?? null);
    }
    if (
      resolved.tenantStatus === 'pending_deletion' &&
      !allowedDuringPendingDeletion(request.method, requestPath(request))
    ) {
      throw new ApiError(403, 'forbidden');
    }
    if (!this.deps.requests.hit(`${resolved.credential.kind}:${resolved.credential.id}`)) {
      throw new ApiError(429, 'rate_limited');
    }
    const scope = this.deps.db.forTenant(resolved.tenantId);
    await this.#touch(resolved.credential, scope, now);
    request.principal = { ...resolved, scope };
    return true;
  }

  async #token(request: GuardRequest, now: Date): Promise<Resolved | undefined> {
    const token = bearerToken(request.headers.authorization);
    if (token === undefined || !isApiTokenFormat(token)) return undefined;
    const found = await this.deps.db.system.resolveApiToken(hashApiToken(token), now);
    return found
      ? {
          tenantId: found.tenantId,
          userId: found.userId,
          credential: { kind: 'token', id: found.tokenId },
          tenantStatus: found.tenantStatus,
        }
      : undefined;
  }

  async #session(
    request: GuardRequest,
    settings: SessionGuardSettings | undefined,
    now: Date,
  ): Promise<Resolved | undefined> {
    const secret = readCookie(request.headers.cookie, SESSION_COOKIE);
    if (secret === undefined || settings === undefined) return undefined;
    const idleSince = new Date(now.getTime() - settings.idleMs);
    const found = await this.deps.db.system.resolveWebSession(
      hashSessionSecret(secret),
      now,
      idleSince,
    );
    return found
      ? {
          tenantId: found.tenantId,
          userId: found.userId,
          credential: { kind: 'session', id: found.sessionId, signedInAt: found.createdAt },
          csrfSha256: found.csrfSha256,
          tenantStatus: found.tenantStatus,
        }
      : undefined;
  }

  /**
   * U06 (ADR-M73 §2.3): a session reads; it writes only to a marked route, with the three CSRF
   * layers and a JSON body (or none). Every session write answers `no-store`.
   */
  #checkSessionWrite(
    context: ExecutionContext,
    request: GuardRequest,
    settings: SessionGuardSettings,
    csrfSha256: string | null,
  ): void {
    if (READ_METHODS.has(request.method)) return;
    const kind = this.deps.reflector.get<SessionActionKind | undefined>(
      SESSION_ACTION,
      context.getHandler(),
    );
    if (kind === undefined) throw new ApiError(403, 'session_write_not_allowed');
    if (kind === 'actions' && !settings.actions) throw new ApiError(403, 'dashboard_actions_off');
    const headers = request.headers;
    const fetchSite = headers['sec-fetch-site'];
    const sameOrigin =
      headers.origin === settings.publicOrigin &&
      (fetchSite === undefined || fetchSite === 'same-origin');
    if (!sameOrigin || !csrfMatches(headers[CSRF_HEADER], csrfSha256) || !jsonOrEmpty(headers)) {
      throw new ApiError(403, 'csrf_refused');
    }
    context
      .switchToHttp()
      .getResponse<{ header(name: string, value: string): unknown }>()
      .header('cache-control', 'no-store');
  }

  async #touch(
    credential: Credential,
    scope: ReturnType<PlatformDatabase['forTenant']>,
    now: Date,
  ): Promise<void> {
    const key = `${credential.kind}:${credential.id}`;
    const at = now.getTime();
    const last = this.#lastTouch.get(key);
    if (last !== undefined && at - last < TOUCH_INTERVAL_MS) return;
    // Keep only credentials used within the interval, so the map never grows with old ones.
    for (const [id, time] of this.#lastTouch) {
      if (at - time >= TOUCH_INTERVAL_MS) this.#lastTouch.delete(id);
    }
    this.#lastTouch.set(key, at);
    if (credential.kind === 'token') await scope.apiTokens.touchLastUsed(credential.id, now);
    else await scope.webSessions.touch(credential.id, now);
  }
}

/** The header's token matches the session's stored hash (constant time). */
function csrfMatches(header: string | string[] | undefined, stored: string | null): boolean {
  if (stored === null || typeof header !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(header)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(hashCsrfToken(header), 'utf8'), Buffer.from(stored, 'utf8'));
}

/**
 * The body is JSON, or there is none. A cross-site form can send `text/plain`, which Fastify
 * would parse too (ADR-M73 §2.3: JSON bodies only).
 */
function jsonOrEmpty(headers: Readonly<Record<string, string | string[] | undefined>>): boolean {
  const type = headers['content-type'];
  if (typeof type === 'string') {
    return /^application\/json\s*(;\s*charset=utf-8\s*)?$/i.test(type.trim());
  }
  const length = headers['content-length'];
  return (
    type === undefined &&
    headers['transfer-encoding'] === undefined &&
    (length === undefined || length === '0')
  );
}

/**
 * H03c: while the tenant is in the deletion grace period, only cancel/status (and `GET /v1/me`)
 * stay reachable so the tenant admin can abort. Every other authenticated route is refused.
 */
function allowedDuringPendingDeletion(method: string, path: string): boolean {
  if (path === '/v1/me' && method === 'GET') return true;
  return path === '/v1/client/data-deletion' || path.startsWith('/v1/client/data-deletion/');
}

function requestPath(request: GuardRequest): string {
  const raw = typeof request.url === 'string' ? request.url : '';
  const path = raw.split('?')[0] ?? '';
  return path.length === 0 ? '/' : path;
}

function bearerToken(header: string | string[] | undefined): string | undefined {
  if (typeof header !== 'string') return undefined;
  const match = /^Bearer ([^\s]+)$/.exec(header);
  return match?.[1];
}
