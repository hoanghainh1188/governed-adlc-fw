// Legacy Docker AuthZ plugin HTTP server (ADR-M105). Listens on a Unix socket; dockerd calls
// Plugin.Activate, AuthZPlugin.AuthZReq and AuthZPlugin.AuthZRes. Request bodies are checked with
// the shared evaluator; responses are always allowed.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { chmodSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

import { evaluateAuthzRaw, type AuthzDecision } from './authz-eval.js';

export interface AuthzPluginOptions {
  readonly socketPath: string;
}

interface AuthzRequest {
  readonly User?: string;
  readonly UserAuthNMethod?: string;
  readonly RequestMethod?: string;
  readonly RequestURI?: string;
  /** Docker sends the raw body as a base64 string in JSON. */
  readonly RequestBody?: string;
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
  try {
    return Buffer.from(encoded, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

function decide(req: AuthzRequest): AuthzDecision {
  const method = req.RequestMethod ?? '';
  const uri = req.RequestURI ?? '';
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

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
    const decision = decide(parsed);
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
  mkdirSync(dirname(socketPath), { recursive: true });
  try {
    unlinkSync(socketPath);
  } catch {
    // No stale socket.
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch(() => {
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
        reject(err);
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
