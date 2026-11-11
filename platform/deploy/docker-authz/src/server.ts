// Legacy Docker AuthZ plugin HTTP server (ADR-M105). Listens on a Unix socket; dockerd calls
// Plugin.Activate, AuthZPlugin.AuthZReq and AuthZPlugin.AuthZRes. Request bodies are checked with
// the shared evaluator; responses are always allowed. A request from the operator's own Docker CLI
// (the header OPERATOR_HEADER with the operator key) skips the denylist (QUESTIONS #661).
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { chmodSync, mkdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

import { evaluateAuthzRaw, type AuthzDecision } from './authz-eval.js';

/**
 * The header the operator's Docker CLI sends (`HttpHeaders` in its Docker configuration file). The
 * runner never has the key: it lives in a file of the Engine's user (mode 600) and in that user's
 * Docker configuration, never in a container, an environment value or a log.
 */
export const OPERATOR_HEADER = 'X-Sdlc-Operator';

/** The shortest key the plugin accepts (hex of 32 random bytes is 64). */
const OPERATOR_KEY_MIN_LENGTH = 32;

export interface AuthzPluginOptions {
  readonly socketPath: string;
  /**
   * A file that holds the operator key (one line, mode 600). Missing, empty, too short or readable
   * by others: no request skips the denylist.
   */
  readonly operatorKeyFile?: string;
}

interface AuthzRequest {
  readonly User?: string;
  readonly UserAuthNMethod?: string;
  readonly RequestMethod?: string;
  /**
   * Docker's authorization.Request JSON tag is `RequestUri` (lowercase i), not `RequestURI`
   * (moby/pkg/authorization/api.go). Accept both so unit fixtures and Engine agree.
   */
  readonly RequestUri?: string;
  readonly RequestURI?: string;
  /** Docker sends the raw body as a base64 string in JSON. */
  readonly RequestBody?: string;
  /** The client's request headers (Go canonical names, one value each). */
  readonly RequestHeaders?: Record<string, unknown>;
}

const sha256 = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

/** SHA-256 of the operator key, or null when there is no usable key file. */
function loadOperatorKeyHash(file: string | undefined): Buffer | null {
  if (file === undefined) return null;
  try {
    // A key others can read is not a secret: refuse it rather than trust it.
    if ((statSync(file).mode & 0o077) !== 0) return null;
    const key = readFileSync(file, 'utf8').trim();
    return key.length >= OPERATOR_KEY_MIN_LENGTH ? sha256(key) : null;
  } catch {
    return null;
  }
}

/** True when the request carries the operator key (header name in any case). */
function isOperator(req: AuthzRequest, keyHash: Buffer | null): boolean {
  if (keyHash === null) return false;
  const headers = req.RequestHeaders;
  if (headers === null || typeof headers !== 'object') return false;
  const name = OPERATOR_HEADER.toLowerCase();
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  if (entry === undefined || typeof entry[1] !== 'string') return false;
  return timingSafeEqual(sha256(entry[1].trim()), keyHash);
}

function requestUri(req: AuthzRequest): string {
  return req.RequestUri ?? req.RequestURI ?? '';
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': body.length,
  });
  res.end(body);
}

function decodeRequestBody(encoded: string | undefined): string | null {
  if (encoded === undefined || encoded === '') return null;
  // Docker's plugin client JSON-encodes []byte as base64. Some callers may already send UTF-8 JSON.
  if (encoded.startsWith('{') || encoded.startsWith('[')) return encoded;
  try {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    if (decoded.startsWith('{') || decoded.startsWith('[')) return decoded;
    return decoded;
  } catch {
    return null;
  }
}

function decide(req: AuthzRequest): AuthzDecision {
  const method = req.RequestMethod ?? '';
  const uri = requestUri(req);
  const raw = decodeRequestBody(req.RequestBody);
  if (
    method.toUpperCase() === 'POST' &&
    (/\/containers\/create(?:\?|$)/.test(uri) || /\/networks\/create(?:\?|$)/.test(uri)) &&
    raw === null &&
    req.RequestBody !== undefined &&
    req.RequestBody !== ''
  ) {
    return { allow: false, reason: 'invalid_body_encoding' };
  }
  return evaluateAuthzRaw(method, uri, raw);
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  operatorKeyHash: Buffer | null,
): Promise<void> {
  const url = req.url ?? '/';
  if (req.method === 'POST' && (url === '/Plugin.Activate' || url.endsWith('/Plugin.Activate'))) {
    sendJson(res, 200, { Implements: ['authz'] });
    return;
  }
  if (
    req.method === 'POST' &&
    (url === '/AuthZPlugin.AuthZRes' || url.endsWith('/AuthZPlugin.AuthZRes'))
  ) {
    // Responses never carry a create-body risk the denylist must stop (QUESTIONS #660).
    sendJson(res, 200, { Allow: true });
    return;
  }
  if (
    req.method === 'POST' &&
    (url === '/AuthZPlugin.AuthZReq' || url.endsWith('/AuthZPlugin.AuthZReq'))
  ) {
    const raw = await readBody(req);
    let parsed: AuthzRequest;
    try {
      parsed = JSON.parse(raw.toString('utf8')) as AuthzRequest;
    } catch {
      sendJson(res, 200, { Allow: false, Msg: 'authz.invalid_request', Err: 'invalid_json' });
      return;
    }
    const operator = isOperator(parsed, operatorKeyHash);
    const decision: AuthzDecision = operator ? { allow: true } : decide(parsed);
    // Codes only (R031): method, URI path shape, allow/deny reason — never body text or a header.
    const pathShape = requestUri(parsed).replace(/\?.*/, '');
    process.stderr.write(
      `authz: ${parsed.RequestMethod ?? '?'} ${pathShape} allow=${decision.allow}` +
        `${operator ? ' operator=1' : ''}` +
        `${decision.reason ? ` reason=${decision.reason}` : ''}\n`,
    );
    if (decision.allow) {
      sendJson(res, 200, { Allow: true });
      return;
    }
    sendJson(res, 200, {
      Allow: false,
      Msg: `authz.denied:${decision.reason ?? 'refused'}`,
    });
    return;
  }
  sendJson(res, 404, { Allow: false, Err: 'not_found' });
}

/** Start the AuthZ plugin on `socketPath`. Removes a stale socket file first. */
export async function startAuthzPlugin(options: AuthzPluginOptions): Promise<{
  readonly close: () => Promise<void>;
}> {
  const { socketPath } = options;
  const operatorKeyHash = loadOperatorKeyHash(options.operatorKeyFile);
  mkdirSync(dirname(socketPath), { recursive: true });
  try {
    unlinkSync(socketPath);
  } catch {
    // No stale socket.
  }

  const server = createServer((req, res) => {
    void handle(req, res, operatorKeyHash).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { Allow: false, Err: 'internal' });
      else res.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      try {
        chmodSync(socketPath, 0o660);
        resolve();
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  });

  return {
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => {
          try {
            unlinkSync(socketPath);
          } catch {
            // Already gone.
          }
          if (err) reject(err);
          else resolve();
        });
      }),
  };
}
