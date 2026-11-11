// L01 PR 2 (design/ADR-M71 §4.4, QUESTIONS #669): live test of the mutual TLS link between the
// platform (profile `models-remote`, service vllm-link) and a separate GPU host
// (gpu-host/docker-compose.yml). Needs Docker and OpenSSL 3; no GPU. Skipped unless
// SDLC_VLLM_LINK_TEST=1. Run with: pnpm test:vllm-link
//
// Two throw-away Compose projects on this Docker Engine (own names, own port +37000), removed
// afterwards; the owner's stack is never touched. On the GPU host's project the stub model
// (integration/litellm/stub-model.mjs) stands in for vLLM: same port, same OpenAI-style routes.
// The certificates come from gpu-link/tls.sh with a throw-away CA made here (test only).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { deployDir } from '../../deploy/compose';

const enabled = process.env.SDLC_VLLM_LINK_TEST === '1';
const LINUX = process.platform === 'linux';
const SETUP_TIMEOUT_MS = 10 * 60 * 1000;
const PORT = 8443 + 37000;
const HOST = 'gpu.vllm-link.test';
// Same pinned image as the other live tests.
const NODE_IMAGE =
  'node:24.21.0-alpine3.23@sha256:9ec4a2e289874ed0d722e1772ec2de45d2801541db8612f3638b26f128c69ac2';
const STUB = path.join(deployDir, '../tests/integration/litellm/stub-model.mjs');

interface Result {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** One answer of the client script. */
interface Probe {
  name: string;
  status?: number;
  error?: string;
  body?: string;
}

// The client: a Node script in the pinned Node image. Mode `link`: plain HTTP to vllm:8000 on the
// network `models`, as LiteLLM calls it. Mode `direct`: HTTPS to the gateway, with the client
// certificate of the folder given (or none).
const CLIENT = String.raw`
const http = require('node:http'); const https = require('node:https'); const fs = require('node:fs');
const [mode, host, port, certDir] = process.argv.slice(1);
const tls = mode === 'direct' ? {
  ca: fs.readFileSync('/certs/trust/ca.pem'), servername: host,
  ...(certDir ? { cert: fs.readFileSync(certDir + '/client.pem'), key: fs.readFileSync(certDir + '/client-key.pem') } : {}),
} : {};
function req(name, method, p, body) {
  return new Promise((resolve) => {
    const lib = mode === 'direct' ? https : http;
    const r = lib.request({ host, port, method, path: p, agent: false, timeout: 10000,
      headers: body ? { 'content-type': 'application/json' } : {}, ...tls }, (res) => {
      let data = ''; res.setEncoding('utf8'); res.on('data', (c) => { if (data.length < 300) data += c; });
      res.on('end', () => resolve({ name, status: res.statusCode, body: data.slice(0, 300) }));
    });
    r.on('timeout', () => r.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    r.on('error', (e) => resolve({ name, error: e.code || e.message }));
    if (body) r.write(body); r.end();
  });
}
(async () => {
  const chat = JSON.stringify({ model: 'stub', messages: [{ role: 'user', content: 'hi' }] });
  const out = mode === 'direct' ? [await req('health', 'GET', '/health')] : [
    await req('chat', 'POST', '/v1/chat/completions', chat),
    await req('completions', 'POST', '/v1/completions', '{}'),
    await req('models', 'GET', '/v1/models'),
    await req('health', 'GET', '/health'),
    await req('invocations', 'POST', '/invocations', chat),
    await req('metrics', 'GET', '/metrics'),
    await req('chat_get', 'GET', '/v1/chat/completions'),
  ];
  process.stdout.write(JSON.stringify(out));
})();
`;

describe.skipIf(!enabled)(
  'vLLM on a separate GPU host: the mutual TLS link (live)',
  { timeout: 120_000 },
  () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-vllm-link-it-'));
    const name = `vllmlink${process.pid}`;
    const platformEnv = path.join(tmp, 'platform.env');
    const gpuEnv = path.join(tmp, 'gpu.env');
    const override = path.join(tmp, 'gpu-stub.yml');
    const tlsScript = path.join(deployDir, 'gpu-link/tls.sh');
    // The folders the two projects read; their content is swapped in the "wrong server" cases.
    const gpuTls = path.join(tmp, 'gpu-tls');
    const platformTls = path.join(tmp, 'platform-tls');
    let linkAddr = '127.0.0.1';
    const certs = (set: string) => path.join(tmp, set);

    const run = (cmd: string, args: string[], env: NodeJS.ProcessEnv = {}): Result => {
      const r = spawnSync(cmd, args, {
        encoding: 'utf8',
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 16 * 1024 * 1024,
      });
      return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    };
    const ok = (r: Result, what: string): Result => {
      if (r.status !== 0)
        throw new Error(`${what} failed (exit ${r.status}): ${r.stderr}${r.stdout}`);
      return r;
    };
    const gpuCompose = (...args: string[]) =>
      run('docker', [
        'compose',
        '-f',
        path.join(deployDir, 'gpu-host/docker-compose.yml'),
        '-f',
        override,
        '--env-file',
        gpuEnv,
        ...args,
      ]);
    const platformCompose = (...args: string[]) =>
      run('docker', [
        'compose',
        '-f',
        path.join(deployDir, 'docker-compose.yml'),
        '--env-file',
        platformEnv,
        '--profile',
        'models-remote',
        ...args,
      ]);
    const setEnv = (file: string, values: Record<string, string>) => {
      let text = fs.readFileSync(file, 'utf8');
      for (const [key, value] of Object.entries(values)) {
        const line = new RegExp(`^${key}=.*$`, 'm');
        text = line.test(text) ? text.replace(line, `${key}=${value}`) : `${text}${key}=${value}\n`;
      }
      fs.writeFileSync(file, text, { mode: 0o600 });
    };
    /** Replaces the files of `dest` with those of `src` (a set made by tls.sh). */
    const useCerts = (src: string, dest: string) => {
      fs.rmSync(dest, { recursive: true, force: true });
      fs.cpSync(src, dest, { recursive: true });
    };
    /** The gateway with the files now in gpuTls: the copy job, then a fresh start (no old session). */
    const restartGateway = () => {
      ok(gpuCompose('run', '--rm', '--no-deps', 'vllm-gateway-tls-init'), 'vllm-gateway-tls-init');
      ok(gpuCompose('restart', 'vllm-gateway'), 'restart vllm-gateway');
      ok(
        gpuCompose('up', '-d', '--wait', '--wait-timeout', '60', 'vllm-gateway'),
        'gateway healthy',
      );
    };
    const probe = (args: string[], mode: 'link' | 'direct', extra: string[]): Probe[] => {
      const r = ok(
        run('docker', [
          'run',
          '--rm',
          ...extra,
          '-v',
          `${tmp}:/certs:ro`,
          NODE_IMAGE,
          'node',
          '-e',
          CLIENT,
          mode,
          ...args,
        ]),
        `client (${mode})`,
      );
      return JSON.parse(r.stdout) as Probe[];
    };
    /** Through the link, as LiteLLM calls it: http://vllm:8000 on the network `models`. */
    const viaLink = () => probe(['vllm', '8000'], 'link', ['--network', `${name}-models`]);
    /** Straight to the gateway with the client certificate of `set` (or none). */
    const direct = (set: string | null) =>
      probe([HOST, String(PORT), set ? `/certs/${set}/platform` : ''], 'direct', [
        '--add-host',
        `${HOST}:${LINUX ? linkAddr : 'host-gateway'}`,
      ]);
    const byName = (probes: Probe[]) => Object.fromEntries(probes.map((p) => [p.name, p]));

    beforeAll(() => {
      ok(run('docker', ['pull', '-q', NODE_IMAGE]), 'pull node image');
      // A throw-away CA that tls.sh issue uses, like the internal CA of openbao/tls.sh ca.
      const ca = path.join(tmp, 'ca');
      fs.mkdirSync(ca);
      const key = path.join(ca, 'ca-key.pem');
      ok(
        run('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', key]),
        'CA key',
      );
      ok(
        run('openssl', [
          ...['req', '-x509', '-new', '-key', key, '-sha256', '-days', '2'],
          ...[
            '-subj',
            '/CN=Throw-away GPU link test CA',
            '-addext',
            'basicConstraints=critical,CA:TRUE',
          ],
          ...['-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-out', path.join(ca, 'ca.pem')],
        ]),
        'CA',
      );
      ok(run(tlsScript, ['issue', ca, HOST, certs('good')]), 'tls.sh issue');
      ok(run(tlsScript, ['issue', ca, 'other.vllm-link.test', certs('wrong-name')]), 'wrong name');
      ok(
        run(tlsScript, ['issue', ca, HOST, certs('wrong-cn')], {
          SDLC_GPU_LINK_CLIENT_CN: 'someone',
        }),
        'wrong CN',
      );
      ok(run(tlsScript, ['dev', HOST, certs('other-ca')]), 'tls.sh dev (another CA)');
      // The verifying side always trusts the good CA.
      fs.mkdirSync(path.join(tmp, 'trust'));
      fs.copyFileSync(path.join(ca, 'ca.pem'), path.join(tmp, 'trust/ca.pem'));
      fs.rmSync(ca, { recursive: true });
      useCerts(path.join(certs('good'), 'gpu-host'), gpuTls);
      useCerts(path.join(certs('good'), 'platform'), platformTls);
      for (const dir of [tmp, ...fs.readdirSync(tmp).map((d) => path.join(tmp, d))])
        if (fs.statSync(dir).isDirectory()) fs.chmodSync(dir, 0o755);
      // The client container reads the keys as another user: test copies only.
      for (const set of ['good', 'wrong-cn', 'other-ca'])
        fs.chmodSync(path.join(certs(set), 'platform/client-key.pem'), 0o644);

      if (LINUX) {
        // Linux: host-gateway is the default bridge's gateway; publish the gateway there only.
        linkAddr = ok(
          run('docker', [
            'network',
            'inspect',
            'bridge',
            '-f',
            '{{(index .IPAM.Config 0).Gateway}}',
          ]),
          'bridge gateway',
        ).stdout.trim();
      }
      fs.copyFileSync(path.join(deployDir, 'gpu-host/.env.example'), gpuEnv);
      setEnv(gpuEnv, {
        COMPOSE_PROJECT_NAME: `${name}-gpu`,
        SDLC_GPU_LINK_ADDR: linkAddr,
        SDLC_GPU_LINK_PORT: String(PORT),
        SDLC_GPU_LINK_TLS_DIR: gpuTls,
        SDLC_GPU_LINK_READ_TIMEOUT: '30',
      });
      // The stub in place of vLLM: same service, network, port and user; no GPU, no weights.
      fs.writeFileSync(
        override,
        [
          'services:',
          '  vllm:',
          `    image: ${NODE_IMAGE}`,
          '    command: !override [node, /stub.mjs]',
          '    environment:',
          "      STUB_OPEN: '1'",
          "      STUB_PORT: '8000'",
          '    volumes: !override',
          `      - ${STUB}:/stub.mjs:ro`,
          '    shm_size: 64m',
          '    deploy: !reset {}',
          '    healthcheck: !override',
          '      test: [CMD, wget, -q, -O, /dev/null, "http://127.0.0.1:8000/health"]',
          '      interval: 2s',
          '      retries: 30',
          '',
        ].join('\n'),
      );
      fs.copyFileSync(path.join(deployDir, '.env.example'), platformEnv);
      setEnv(platformEnv, {
        COMPOSE_PROJECT_NAME: name,
        SDLC_GPU_HOST_NAME: HOST,
        SDLC_GPU_HOST_ADDR: LINUX ? linkAddr : 'host-gateway',
        SDLC_GPU_LINK_PORT: String(PORT),
        SDLC_VLLM_LINK_TLS_DIR: platformTls,
        // Read by Compose for openbao-tls-init (not started here): any folder will do.
        SDLC_OPENBAO_TLS_DIR: tmp,
        SDLC_GPU_LINK_READ_TIMEOUT: '30',
      });
      ok(
        gpuCompose('up', '-d', '--wait', '--wait-timeout', '180', 'vllm', 'vllm-gateway'),
        'GPU host up',
      );
      ok(platformCompose('up', '-d', '--wait', '--wait-timeout', '180', 'vllm-link'), 'link up');
    }, SETUP_TIMEOUT_MS);

    afterAll(() => {
      if (process.env.SDLC_KEEP_STACK !== '1') {
        gpuCompose('--profile', 'pull', 'down', '--volumes', '--remove-orphans');
        platformCompose('down', '--volumes', '--remove-orphans');
      }
      fs.rmSync(tmp, { recursive: true, force: true });
    }, SETUP_TIMEOUT_MS);

    it('a call through the link reaches the model; the four routes only', () => {
      const p = byName(viaLink());
      expect(p.chat?.status, JSON.stringify(p.chat)).toBe(200);
      expect(p.chat?.body).toContain('"content":"ok"');
      expect(p.models?.status).toBe(200);
      expect(p.health?.status).toBe(200);
      // The stub answers 404 for /v1/completions itself; what counts is that the link and the
      // gateway let it through to the model (not their own 404 or 403 page).
      expect(p.completions?.body).toContain('not found');
      expect(p.invocations?.status).toBe(404);
      expect(p.invocations?.body).not.toContain('not found');
      expect(p.metrics?.status).toBe(404);
      expect(p.chat_get?.status).toBe(403);
    });

    it('the gateway accepts the link certificate and refuses none, another CA or another name', () => {
      expect(direct('good')[0]?.status).toBe(200);
      // nginx answers 400 ("No required SSL certificate" / "certificate error") before any route.
      expect(direct(null)[0]?.status).toBe(400);
      expect(direct('other-ca')[0]?.status).toBe(400);
      // Signed by the link's CA but not the link: 403 (a company CA's other certificates).
      expect(direct('wrong-cn')[0]?.status).toBe(403);
    });

    it('the link refuses a GPU host whose certificate comes from another CA or names another host', () => {
      const linkErrors = () => platformCompose('logs', '--no-color', 'vllm-link').stdout;
      try {
        useCerts(path.join(certs('other-ca'), 'gpu-host'), gpuTls);
        restartGateway();
        expect(byName(viaLink()).health?.status).toBe(502);
        expect(linkErrors()).toContain('upstream SSL certificate verify error');
        useCerts(path.join(certs('wrong-name'), 'gpu-host'), gpuTls);
        restartGateway();
        expect(byName(viaLink()).health?.status).toBe(502);
        expect(linkErrors()).toContain(`upstream SSL certificate does not match "${HOST}"`);
      } finally {
        useCerts(path.join(certs('good'), 'gpu-host'), gpuTls);
        restartGateway();
      }
      expect(byName(viaLink()).health?.status).toBe(200);
    });

    it('tls.sh reload copies the files again and nginx keeps serving on both sides', () => {
      ok(
        run(tlsScript, ['reload', 'gpu-host'], { SDLC_GPU_HOST_ENV_FILE: gpuEnv }),
        'reload gpu-host',
      );
      ok(run(tlsScript, ['reload', 'platform'], { SDLC_ENV_FILE: platformEnv }), 'reload platform');
      expect(byName(viaLink()).chat?.status).toBe(200);
    });

    it('logs no header, body or query string on either side', () => {
      const logs =
        gpuCompose('logs', '--no-color', 'vllm-gateway').stdout +
        platformCompose('logs', '--no-color', 'vllm-link').stdout;
      expect(logs).toContain('"path":"/v1/chat/completions"');
      expect(logs).not.toMatch(/content-type|"messages"|hi"/i);
    });
  },
);
