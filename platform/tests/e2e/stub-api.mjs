// A stub of the API for the dashboard's smoke test (U01 AC6, design/ADR-M54 §2.6). It serves the
// built dashboard through the api's own `registerDashboard` (the real file list and CSP) and
// answers the GET endpoints the dashboard reads with fixed, fictional data. Anything else: 405.
// Settings: SDLC_DASHBOARD_E2E_PORT, SDLC_DASHBOARD_E2E_TOKEN (made by the test at run time).
//
// U05 (ADR-M73 §2.2): on `localhost` (not on 127.0.0.1) GitHub sign-in is on. The stub plays the
// API and GitHub in one: `start` sets the pre-login cookie and sends the browser straight to the
// callback (GitHub "approves" at once); the tenant `demo` signs in, any other is refused. The
// cookies have the API's attributes; a request with a token and a cookie answers 400; sign-out
// needs the session cookie and the `localhost` origin. No real GitHub, no secret.
//
// U06 (ADR-M73 §2.3, §2.4): on `localhost` actions are on. Every write needs the session cookie,
// the `localhost` origin, the session's CSRF token and a JSON body or none, like the API. The
// passkey endpoints check the browser's answers with the api's own WebAuthn code (its build), so
// the test proves the ceremony between a real browser and the real check.
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';

import { loadDashboardFiles, registerDashboard } from '../../apps/api/dist/dashboard/static.js';
import { WebAuthnCeremonies } from '../../apps/api/dist/passkeys/webauthn.js';
import { stepUpRequestSha256 } from '../../packages/core/dist/passkeys/index.js';
import { decisionWrite, isDecisionPath } from './decisions-stub.mjs';
import { intakeWrite, isIntakePath } from './intake-stub.mjs';
import { evalPlans } from './eval-stub.mjs';
import { adminRead, adminWrite, isAdminPath, resetAdmin } from './admin-stub.mjs';
import { fixtures } from './fixtures.mjs';

const root = path.resolve(import.meta.dirname, '../../..');
const port = Number(process.env.SDLC_DASHBOARD_E2E_PORT ?? 4791);
const token = process.env.SDLC_DASHBOARD_E2E_TOKEN ?? '';
if (!/^sdlc_pat_[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('SDLC_DASHBOARD_E2E_TOKEN');

/** The Fastify routes `registerDashboard` adds, kept in a list. */
const routes = [];
registerDashboard(
  { get: (pattern, handler) => routes.push({ pattern, handler }) },
  await loadDashboardFiles(path.join(root, 'platform/apps/dashboard/dist/web')),
);

function fastifyReply(res) {
  const reply = {
    header: (name, value) => (res.setHeader(name, value), reply),
    code: (status) => ((res.statusCode = status), reply),
    type: (contentType) => (res.setHeader('content-type', contentType), reply),
    redirect: (url, status) => (res.writeHead(status, { location: url }).end(), reply),
    send: (body) => (res.end(body), reply),
  };
  return reply;
}

function json(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

const error = (code) => ({ error: { code, message: code } });

const random = () => randomBytes(32).toString('base64url');
const LOCAL_ORIGIN = `http://localhost:${port}`;
/** Pending sign-ins: handle → { state, tenant }. Sessions: secret → true. */
const pending = new Map();
const sessions = new Set();

function cookieOf(req, name) {
  const found = (req.headers.cookie ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`))
    .map((part) => part.slice(name.length + 1));
  return found.length === 1 ? found[0] : undefined;
}

const oauthCookie = (value, age) =>
  `__Host-sdlc_oauth=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${age}`;
const sessionCookie = (value, age) =>
  `__Host-sdlc_session=${value}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${age}`;

function redirect(res, location, cookies = []) {
  res.writeHead(302, { location, 'cache-control': 'no-store', 'set-cookie': cookies });
  res.end();
}

/** The sign-in endpoints of U05; true when the request was one of them. */
function signIn(req, res, url) {
  const github = (req.headers.host ?? '').startsWith('localhost:');
  if (url.pathname === '/v1/auth/config' && req.method === 'GET') {
    json(res, 200, { github, actions: github });
    return true;
  }
  if (!github) return false;
  if (url.pathname === '/v1/auth/github/start' && req.method === 'GET') {
    const handle = random();
    const state = random();
    pending.set(handle, { state, tenant: url.searchParams.get('tenant') ?? '' });
    redirect(res, `/v1/auth/github/callback?code=demo&state=${state}`, [oauthCookie(handle, 600)]);
    return true;
  }
  if (url.pathname === '/v1/auth/github/callback' && req.method === 'GET') {
    const handle = cookieOf(req, '__Host-sdlc_oauth');
    const entry = handle && pending.get(handle);
    const clear = oauthCookie('', 0);
    if (!entry || entry.state !== url.searchParams.get('state') || entry.tenant !== 'demo') {
      redirect(res, '/dashboard/?signin=refused', [clear]);
      return true;
    }
    pending.delete(handle);
    const secret = random();
    sessions.add(secret);
    redirect(res, '/dashboard/', [clear, sessionCookie(secret, 28_800)]);
    return true;
  }
  if (url.pathname === '/v1/auth/session' && req.method === 'GET') {
    const secret = cookieOf(req, '__Host-sdlc_session');
    if (!secret || !sessions.has(secret)) return (json(res, 401, error('session_ended')), true);
    json(res, 200, {
      csrf_token: csrfOf(secret),
      signed_in_at: new Date().toISOString(),
      actions: true,
    });
    return true;
  }
  const writes = { '/v1/auth/sign-out': 'POST', '/v1/me/sessions': 'DELETE' };
  if (writes[url.pathname] === req.method) {
    const secret = cookieOf(req, '__Host-sdlc_session');
    if (!secret || !sessions.has(secret)) return (json(res, 401, error('session_ended')), true);
    if (!writeAllowed(req, secret)) return (json(res, 403, error('csrf_refused')), true);
    const ended = url.pathname === '/v1/me/sessions' ? sessions.size : 1;
    if (url.pathname === '/v1/me/sessions') sessions.clear();
    else sessions.delete(secret);
    res.writeHead(url.pathname === '/v1/me/sessions' ? 200 : 204, {
      'set-cookie': sessionCookie('', 0),
      'content-type': 'application/json; charset=utf-8',
    });
    res.end(url.pathname === '/v1/me/sessions' ? JSON.stringify({ ended }) : undefined);
    return true;
  }
  return false;
}

const csrfOf = (secret) =>
  createHmac('sha256', secret).update('sdlc-csrf-1', 'utf8').digest('base64url');

/** The three CSRF layers of the API (ADR-M73 §2.3) and a JSON body or none. */
function writeAllowed(req, secret) {
  const type = req.headers['content-type'];
  const body =
    type === undefined
      ? req.headers['content-length'] === undefined || req.headers['content-length'] === '0'
      : /^application\/json/.test(type);
  const site = req.headers['sec-fetch-site'];
  return (
    req.headers.origin === LOCAL_ORIGIN &&
    (site === undefined || site === 'same-origin') &&
    req.headers['x-sdlc-csrf'] === csrfOf(secret) &&
    body
  );
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        resolve(
          chunks.length === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString('utf8')),
        );
      } catch {
        resolve(undefined);
      }
    });
  });
}

const ceremonies = new WebAuthnCeremonies(LOCAL_ORIGIN);
const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
/** Registration challenges: ID → SHA-256 of the challenge. Passkeys of the one demo person. */
const challenges = new Map();
const passkeys = [];
const presentPasskey = ({ id, aaguid, created_at, last_used_at, revoked_at }) => ({
  id,
  aaguid,
  created_at,
  last_used_at,
  revoked_at,
});

/** The passkey endpoints of U06 (a GitHub session on `localhost`); true when one answered. */
async function passkeyRoutes(req, res, url) {
  if (!url.pathname.startsWith('/v1/me/passkeys')) return false;
  const secret = cookieOf(req, '__Host-sdlc_session');
  if (!secret || !sessions.has(secret)) return (json(res, 401, error('session_ended')), true);
  if (req.method === 'GET' && url.pathname === '/v1/me/passkeys') {
    return (json(res, 200, { items: passkeys.map(presentPasskey) }), true);
  }
  if (req.method === 'GET') return false;
  if (!writeAllowed(req, secret)) return (json(res, 403, error('csrf_refused')), true);
  const body = await readBody(req);
  if (req.method === 'POST' && url.pathname === '/v1/me/passkeys/registration-options') {
    const challenge = randomBytes(32).toString('base64url');
    const id = randomUUID();
    challenges.set(id, sha256(challenge));
    const options = await ceremonies.registrationOptions({
      challenge,
      user: { id: 'demo-user', email: 'demo@example.com', displayName: 'Demo' },
      exclude: passkeys.filter((p) => p.revoked_at === null).map((p) => p.credentialId),
    });
    return (json(res, 200, { challenge_id: id, options, expires_in_seconds: 120 }), true);
  }
  if (req.method === 'POST' && url.pathname === '/v1/me/passkeys') {
    const hash = challenges.get(body?.challenge_id);
    challenges.delete(body?.challenge_id);
    if (!hash) return (json(res, 409, error('challenge_refused')), true);
    try {
      const verified = await ceremonies.verifyRegistration(body.response, hash);
      const row = {
        id: randomUUID(),
        credentialId: verified.credentialId,
        publicKey: verified.publicKey,
        signCount: 0,
        aaguid: verified.aaguid,
        created_at: new Date().toISOString(),
        last_used_at: null,
        revoked_at: null,
      };
      passkeys.push(row);
      return (json(res, 201, presentPasskey(row)), true);
    } catch {
      return (json(res, 400, error('passkey_refused')), true);
    }
  }
  const match = /^\/v1\/me\/passkeys\/([0-9a-f-]{36})$/.exec(url.pathname);
  if (req.method === 'DELETE' && match) {
    const row = passkeys.find((p) => p.id === match[1] && p.revoked_at === null);
    if (!row) return (json(res, 404, error('passkey_not_found')), true);
    row.revoked_at = new Date().toISOString();
    return (json(res, 200, presentPasskey(row)), true);
  }
  return false;
}

/** Step-up challenges: ID → { challenge SHA-256, action, request SHA-256, bound input hash }. */
const stepUps = new Map();

/**
 * Checks a step-up answer like the API: the challenge, the binding, the passkey, once. U07:
 * `expected`, when given, is the input hash the decision carries; the challenge must hold it.
 */
async function stepUpHolds(answer, action, requestSha256, expected) {
  const open = answer && stepUps.get(answer.challenge_id);
  stepUps.delete(answer?.challenge_id);
  if (!open || open.action !== action || open.requestSha256 !== requestSha256) return false;
  if (expected !== undefined && open.expected !== expected) return false;
  const passkey = passkeys.find(
    (p) => p.revoked_at === null && p.credentialId === answer.response?.id,
  );
  if (!passkey) return false;
  try {
    passkey.signCount = await ceremonies.verifyAuthentication(answer.response, open.sha, passkey);
    passkey.last_used_at = new Date().toISOString();
    return true;
  } catch {
    return false;
  }
}

async function stepUpAndPlans(req, res, url) {
  const local = (req.headers.host ?? '').startsWith('localhost:');
  const secret = cookieOf(req, '__Host-sdlc_session');
  if (url.pathname === '/v1/auth/step-up' && req.method === 'POST' && local) {
    if (!secret || !sessions.has(secret)) return (json(res, 401, error('session_ended')), true);
    if (!writeAllowed(req, secret)) return (json(res, 403, error('csrf_refused')), true);
    const body = await readBody(req);
    const allow = passkeys.filter((p) => p.revoked_at === null).map((p) => p.credentialId);
    if (allow.length === 0) return (json(res, 404, error('passkey_not_found')), true);
    const challenge = randomBytes(32).toString('base64url');
    const id = randomUUID();
    stepUps.set(id, {
      sha: sha256(challenge),
      action: body?.action,
      requestSha256: stepUpRequestSha256(body?.request ?? {}),
      expected: body?.expected_input_sha256 ?? null,
    });
    const options = await ceremonies.authenticationOptions({ challenge, allow });
    return (json(res, 200, { challenge_id: id, options, expires_in_seconds: 120 }), true);
  }
  // U07: gate decisions, kills, escalation acknowledgements and decisions, from a session.
  if (req.method === 'POST' && local && isDecisionPath(url.pathname)) {
    if (!secret || !sessions.has(secret)) return (json(res, 401, error('session_ended')), true);
    if (!writeAllowed(req, secret)) return (json(res, 403, error('csrf_refused')), true);
    const body = (await readBody(req)) ?? {};
    const answer = await decisionWrite(url, body, (action, expected) => {
      // The API binds the body without the step-up and the hash (`stepUpRequestSha256`).
      const rest = { ...body };
      delete rest.step_up;
      delete rest.expected_input_sha256;
      return stepUpHolds(body.step_up, action, stepUpRequestSha256(rest), expected);
    });
    return (json(res, answer.status, answer.body), true);
  }
  // U08: create an intent, link its spec, submit the plan, build a pack; no step-up.
  if (req.method === 'POST' && local && isIntakePath(url.pathname)) {
    if (!secret || !sessions.has(secret)) return (json(res, 401, error('session_ended')), true);
    if (!writeAllowed(req, secret)) return (json(res, 403, error('csrf_refused')), true);
    const answer = intakeWrite(url, (await readBody(req)) ?? {});
    return (json(res, answer.status, answer.body), true);
  }
  const isPlanPath =
    url.pathname.startsWith('/v1/eval-plans/') ||
    url.pathname.startsWith('/v1/evaluations') ||
    /^\/v1\/projects\/[a-z0-9-]+\/eval-plans$/.test(url.pathname);
  if (!isPlanPath) return false;
  if (req.method === 'GET') {
    if (!authenticate(req, res)) return true;
    const answer = evalPlans.read(url);
    return (
      answer ? json(res, answer.status ?? 200, answer.body) : json(res, 404, error('not_found')),
      true
    );
  }
  if (req.method !== 'POST' || !local) return false;
  if (!secret || !sessions.has(secret)) return (json(res, 401, error('session_ended')), true);
  if (!writeAllowed(req, secret)) return (json(res, 403, error('csrf_refused')), true);
  const body = (await readBody(req)) ?? {};
  const answer = await evalPlans.write(url, body, (action, target) => {
    const { step_up: stepUp, ...rest } = body;
    const decision = action.slice('eval_plan.'.length);
    return stepUpHolds(stepUp, action, stepUpRequestSha256({ ...rest, decision, target }));
  });
  return (json(res, answer.status, answer.body), true);
}

/**
 * U09: the administration reads (a token or a session) and changes (a session on `localhost`, the
 * CSRF layers and a passkey step-up). `POST /v1/__stub/admin-reset` puts the tenant back for the
 * next test; the dashboard never calls it.
 */
async function adminRoutes(req, res, url) {
  if (url.pathname === '/v1/__stub/admin-reset' && req.method === 'POST') {
    resetAdmin();
    res.writeHead(204).end();
    return true;
  }
  if (!isAdminPath(url.pathname)) return false;
  if (req.method === 'GET') {
    const answer = adminRead(url);
    if (answer === undefined) return false;
    if (!authenticate(req, res)) return true;
    return (json(res, answer.status ?? 200, answer.body), true);
  }
  const local = (req.headers.host ?? '').startsWith('localhost:');
  const secret = cookieOf(req, '__Host-sdlc_session');
  if (!local) return false;
  if (!secret || !sessions.has(secret)) return (json(res, 401, error('session_ended')), true);
  if (!writeAllowed(req, secret)) return (json(res, 403, error('csrf_refused')), true);
  const body = (await readBody(req)) ?? {};
  const answer = await adminWrite(req.method, url, body, (stepUp, action, request) =>
    stepUpHolds(stepUp, action, stepUpRequestSha256(request)),
  );
  return (json(res, answer.status, answer.body), true);
}

/** The caller's credential: the token, a session cookie, or neither. Both: 400. */
function authenticate(req, res) {
  const bearer = req.headers.authorization;
  const secret = cookieOf(req, '__Host-sdlc_session');
  if (bearer !== undefined && secret !== undefined) {
    json(res, 400, error('credentials_ambiguous'));
    return false;
  }
  if (secret !== undefined) {
    if (sessions.has(secret)) return true;
    res.setHeader('set-cookie', sessionCookie('', 0));
    json(res, 401, error('session_ended'));
    return false;
  }
  if (bearer === `Bearer ${token}`) return true;
  json(res, 401, error('unauthorized'));
  return false;
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    if (url.pathname === '/dashboard' || url.pathname.startsWith('/dashboard/')) {
      const route =
        url.pathname === '/dashboard'
          ? routes.find((r) => r.pattern === '/dashboard')
          : routes.find((r) => r.pattern === '/dashboard/*');
      const rest = url.pathname === '/dashboard' ? '' : url.pathname.slice('/dashboard/'.length);
      route.handler({ params: { '*': rest }, headers: req.headers }, fastifyReply(res));
      return;
    }
    if (!url.pathname.startsWith('/v1/')) return json(res, 404, error('not_found'));
    if (signIn(req, res, url)) return;
    if ((req.headers.host ?? '').startsWith('localhost:') && (await passkeyRoutes(req, res, url))) {
      return;
    }
    // L05: the step-up and the evaluation plans (reads with a token or a session; writes from a
    // session on `localhost` only, with the CSRF layers and, where the API needs it, a passkey).
    if (await stepUpAndPlans(req, res, url)) return;
    if (await adminRoutes(req, res, url)) return;
    // The dashboard is read only: the stub refuses every other method (the test counts them).
    if (req.method !== 'GET') return json(res, 405, error('method_not_allowed'));
    if (!authenticate(req, res)) return;
    const answer = fixtures(url);
    return answer
      ? json(res, answer.status ?? 200, answer.body)
      : json(res, 404, error('not_found'));
  })
  .listen(port, '127.0.0.1');
