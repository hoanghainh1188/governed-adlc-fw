// H07: the AuthZ plugin HTTP server activates and denies a privileged create (unit, no dockerd).
import { createConnection } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { startAuthzPlugin } from '../../deploy/docker-authz/src/server.js';

function post(
  socketPath: string,
  url: string,
  body: unknown,
): Promise<{ status: number; json: unknown }> {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  return new Promise((resolve, reject) => {
    const sock = createConnection(socketPath);
    const chunks: Buffer[] = [];
    sock.on('data', (c) => chunks.push(c));
    sock.on('error', reject);
    sock.on('connect', () => {
      sock.write(
        [
          `POST ${url} HTTP/1.1`,
          'Host: localhost',
          'Content-Type: application/json',
          `Content-Length: ${payload.length}`,
          'Connection: close',
          '',
          '',
        ].join('\r\n'),
      );
      sock.write(payload);
    });
    sock.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const sep = raw.indexOf('\r\n\r\n');
      const head = sep === -1 ? raw : raw.slice(0, sep);
      const status = Number(/^HTTP\/\d\.\d (\d+)/.exec(head)?.[1] ?? 0);
      const text = sep === -1 ? '' : raw.slice(sep + 4);
      resolve({ status, json: text ? (JSON.parse(text) as unknown) : null });
    });
  });
}

describe('AuthZ plugin server (H07)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('activates as authz and denies a privileged create body', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sdlc-authz-'));
    dirs.push(dir);
    const socketPath = join(dir, 'sdlc-authz.sock');
    const plugin = await startAuthzPlugin({ socketPath });
    try {
      const activate = await post(socketPath, '/Plugin.Activate', {});
      expect(activate.status).toBe(200);
      expect(activate.json).toEqual({ Implements: ['authz'] });

      const denied = await post(socketPath, '/AuthZPlugin.AuthZReq', {
        RequestMethod: 'POST',
        RequestURI: '/v1.44/containers/create',
        RequestBody: Buffer.from(
          JSON.stringify({ HostConfig: { Privileged: true } }),
          'utf8',
        ).toString('base64'),
      });
      expect(denied.status).toBe(200);
      expect(denied.json).toMatchObject({ Allow: false, Msg: 'authz.denied:privileged' });

      const allowed = await post(socketPath, '/AuthZPlugin.AuthZReq', {
        RequestMethod: 'POST',
        RequestURI: '/v1.44/containers/create',
        RequestBody: Buffer.from(
          JSON.stringify({
            Image: 'x@sha256:' + 'a'.repeat(64),
            HostConfig: { NetworkMode: 'sdlc-run-00000000-0000-0000-0000-000000000001' },
          }),
          'utf8',
        ).toString('base64'),
      });
      expect(allowed.json).toEqual({ Allow: true });

      const res = await post(socketPath, '/AuthZPlugin.AuthZRes', {
        RequestMethod: 'POST',
        RequestURI: '/v1.44/containers/create',
        ResponseStatusCode: 201,
      });
      expect(res.json).toEqual({ Allow: true });
    } finally {
      await plugin.close();
    }
  });
});
