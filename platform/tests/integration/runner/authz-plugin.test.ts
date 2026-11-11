// H07 AC3 (ADR-M105): a privileged containers/create that bypasses docker/guard.ts is refused by
// the Engine's AuthZ plugin. Runs with `pnpm test:runner` (SDLC_RUNNER_TEST=1). On the rootless
// CI Engine the plugin is enabled by test-rootless-docker.sh; on a developer Engine without the
// plugin the test returns early.
import http from 'node:http';
import { describe, expect, it } from 'vitest';

import { liveEnabled } from './live-helpers.js';

const enabled = liveEnabled;

function dockerSocket(): string {
  const host = process.env.DOCKER_HOST ?? 'unix:///var/run/docker.sock';
  if (!host.startsWith('unix://')) {
    throw new Error(`authz-plugin test needs a unix DOCKER_HOST, got ${host}`);
  }
  return host.slice('unix://'.length);
}

function dockerRequest(
  method: string,
  requestPath: string,
  body?: unknown,
): Promise<{ status: number; body: string }> {
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath: dockerSocket(),
        path: requestPath,
        method,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': payload.length }
          : { 'Content-Length': 0 },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function authzEnabled(): Promise<boolean> {
  const { status, body } = await dockerRequest('GET', '/info');
  if (status !== 200) return false;
  try {
    const info = JSON.parse(body) as { Plugins?: { Authorization?: string[] | null } };
    const list = info.Plugins?.Authorization ?? [];
    return Array.isArray(list) && list.length > 0;
  } catch {
    return false;
  }
}

describe.skipIf(!enabled)('Docker AuthZ plugin on the Engine (H07 AC3)', () => {
  it('refuses a privileged containers/create when the guard is bypassed', async () => {
    if (!(await authzEnabled())) {
      // Developer / compose Engine without the plugin: AC3 is covered on runner-rootless.
      return;
    }
    const name = `sdlc-authz-probe-${Date.now()}`;
    const { status, body } = await dockerRequest('POST', `/v1.44/containers/create?name=${name}`, {
      Image: 'docker.io/library/busybox:1.37.0',
      HostConfig: { Privileged: true },
    });
    // dockerd returns 403 when an AuthZ plugin denies the request.
    expect(status, body).toBe(403);
    expect(body.toLowerCase()).toMatch(/authz|authorization|denied|plugin/i);
  });
});
