// The only place that talks to the API (design/ADR-M54 §2.1, §2.3): GET requests to the same
// origin, the token in the Authorization header only, every body checked with the CLI's zod
// schemas (`@sdlc/api-schemas`). A static test refuses any other `fetch` or method.
//
// U05 (ADR-M73 §2.2): with a GitHub sign-in the browser sends its `HttpOnly` session cookie
// (`credentials: 'same-origin'`) and no Authorization header: never both.
//
// U06 (ADR-M73 §2.3): writes go through `send` only, with the session cookie and the session's
// CSRF token in `X-SDLC-CSRF`, a JSON body or none. The paths are fixed in `writes.ts`; a static
// test refuses any other. U09 (ADR-M73 §2.4b): the administration changes add PUT and PATCH.
import { errorEnvelopeSchema, webSessionSchema } from '@sdlc/api-schemas';
import type { z } from 'zod';

import { session } from '../session.js';

/** A refusal or a failure, by code. `status` 0: the request never got an API answer. */
export class ApiError extends Error {
  override readonly name = 'ApiError';
  constructor(
    readonly status: number,
    readonly code: string,
    /** The API's refusal reason, a code (L05: `evaluation.error.<reason>` in the catalog). */
    readonly reason?: string,
    /** U09: the API's details (a refused configuration: each problem, in the API's words). */
    readonly details?: readonly {
      readonly path: string;
      readonly issue: string;
      readonly message?: string | undefined;
    }[],
  ) {
    super(code);
  }
}

export type Query = Readonly<Record<string, string | number | undefined>>;

/** `/v1/…` with its query; every value is encoded. */
export function apiPath(path: string, query: Query = {}): string {
  if (!path.startsWith('/v1/')) throw new ApiError(0, 'invalid_path');
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  const search = params.toString();
  return search === '' ? path : `${path}?${search}`;
}

/** One path segment from server data or a route (an intent code, a slug, a version). */
export function segment(value: string | number): string {
  return encodeURIComponent(String(value));
}

/** How a GET authenticates: a token, the session cookie, or nothing (a public read). */
type Credential = { readonly token: string } | { readonly cookie: true } | { readonly none: true };

function credentialFor(options: {
  readonly token?: string;
  readonly cookie?: boolean;
}): Credential {
  if (options.token !== undefined) return { token: options.token };
  if (options.cookie === true) return { cookie: true };
  const token = session.token();
  if (token !== null) return { token };
  if (session.cookie()) return { cookie: true };
  throw new ApiError(401, 'unauthorized');
}

/**
 * GET with an explicit token (sign-in), the session cookie (`cookie: true`: checking for a
 * GitHub sign-in at start), or the tab's current sign-in.
 */
export async function getJson<S extends z.ZodType>(
  path: string,
  schema: S,
  options: {
    readonly signal?: AbortSignal;
    readonly token?: string;
    readonly cookie?: boolean;
  } = {},
): Promise<z.infer<S>> {
  const credential = credentialFor(options);
  const body = await request(path, 'GET', credential, options.signal);
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ApiError(200, 'invalid_response');
  return parsed.data;
}

/** A public GET (no credential at all): `GET /v1/auth/config`. */
export async function getPublicJson<S extends z.ZodType>(
  path: string,
  schema: S,
  options: { readonly signal?: AbortSignal } = {},
): Promise<z.infer<S>> {
  const body = await request(path, 'GET', { none: true }, options.signal);
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ApiError(200, 'invalid_response');
  return parsed.data;
}

/** The session's CSRF token: from memory, or read once from `GET /v1/auth/session` (U06). */
async function csrfToken(): Promise<string> {
  const known = session.csrf();
  if (known !== null) return known;
  const read = await getJson(apiPath('/v1/auth/session'), webSessionSchema, { cookie: true });
  session.setWebSession({ csrfToken: read.csrf_token, actions: read.actions });
  return read.csrf_token;
}

/** The methods of a write. */
export type WriteMethod = 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * A write of the GitHub session (U06): a fixed path of `writes.ts`, the cookie, the CSRF token, a
 * JSON body or none. The answer is checked with `schema`; `null` for no body.
 */
export async function send<S extends z.ZodType>(
  path: string,
  method: WriteMethod,
  schema: S | null,
  body?: unknown,
): Promise<z.infer<S> | undefined> {
  if (!session.cookie()) throw new ApiError(401, 'unauthorized');
  const csrf = await csrfToken();
  const answer = await request(path, method, { cookie: true }, { csrf, body });
  if (schema === null) return undefined;
  const parsed = schema.safeParse(answer);
  if (!parsed.success) throw new ApiError(200, 'invalid_response');
  return parsed.data;
}

/** A write's CSRF token and JSON body (U06). */
interface Write {
  readonly csrf: string;
  readonly body?: unknown;
}

async function request(
  path: string,
  method: 'GET' | WriteMethod,
  credential: Credential,
  writeOrSignal?: Write | AbortSignal,
): Promise<unknown> {
  const write = writeOrSignal instanceof AbortSignal ? undefined : writeOrSignal;
  const signal = writeOrSignal instanceof AbortSignal ? writeOrSignal : undefined;
  const headers: Record<string, string> = { accept: 'application/json' };
  if ('token' in credential) headers.authorization = `Bearer ${credential.token}`;
  if (write) headers['x-sdlc-csrf'] = write.csrf;
  if (write?.body !== undefined) headers['content-type'] = 'application/json';
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers,
      credentials: 'cookie' in credential ? 'same-origin' : 'omit',
      cache: 'no-store',
      redirect: 'error',
      // A write needs its Origin header (the API checks it, ADR-M73 §2.3): with `no-referrer` and
      // a non-CORS mode the Fetch standard sends `Origin: null` (security review of U05 PR 2).
      referrerPolicy: method === 'GET' ? 'no-referrer' : 'same-origin',
      mode: 'same-origin',
      ...(write?.body !== undefined ? { body: JSON.stringify(write.body) } : {}),
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError(0, 'network');
  }
  if (response.status === 204) return undefined;
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const envelope = errorEnvelopeSchema.safeParse(body);
    const code = envelope.success ? envelope.data.error.code : 'unexpected';
    const reason = envelope.success ? envelope.data.error.reason : undefined;
    const details = envelope.success ? envelope.data.error.details : undefined;
    // An expired or revoked token or session ends the tab's sign-in; the person signs in again.
    if (response.status === 401 && endsCurrentSignIn(credential)) session.signOut();
    throw new ApiError(response.status, code, reason, details);
  }
  return body;
}

function endsCurrentSignIn(credential: Credential): boolean {
  if ('token' in credential) return session.token() === credential.token;
  if ('cookie' in credential) return session.cookie();
  return false;
}
