// V09 (design/ADR-M67): live test of team access through the TLS proxy (profile `access`). Needs
// Docker. Skipped unless SDLC_ACCESS_TEST=1. Run with: pnpm test:access
//
// Own throw-away Compose project (own name, subnet, network `access`, ports +36000, random env
// file, throw-away OpenBao keys and a throw-away CA), removed afterwards; the owner's stack is never
// touched. The "other machine" is a container on its own Docker network that reaches the proxy
// through the host (host-gateway), like a colleague's laptop on the LAN. Key shares, tokens and
// passwords are THROW-AWAY TEST KEYS: kept in variables, never printed, never in an assertion.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DASHBOARD_CSP } from '../../../apps/api/src/dashboard/static.js';
import { processContext, runCli, type CliContext } from '../../../apps/cli/src/index.js';
import { createKysely } from '../../../packages/core/src/db/connection.js';
import { migrateToLatest } from '../../../packages/core/src/db/migrator.js';
import { deployDir, parseEnvFile, root } from '../../deploy/compose';
import { isolateEnv } from '../throwaway-compose';

const enabled = process.env.SDLC_ACCESS_TEST === '1';
const PORT_OFFSET = 36000;
const SETUP_TIMEOUT_MS = 15 * 60 * 1000;
const HOSTNAME = 'sdlc-access.test';
// Docker Desktop (macOS) routes host-gateway to the host's loopback, so the "api port is not
// reachable" check needs Linux (CI); everything else runs everywhere.
const LINUX = process.platform === 'linux';

interface Result {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** What the client container prints: one answer per probe. */
interface Probe {
  name: string;
  status?: number;
  error?: string;
  headers?: Record<string, string>;
  body?: string;
}

describe.skipIf(!enabled)('team access through the TLS proxy (live)', { timeout: 180_000 }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-access-it-'));
  const envFile = path.join(tmp, 'it.env');
  const project = `sdlcaccess${process.pid}`;
  const subnet = `172.31.${90 + (process.pid % 40)}.0/24`;
  const gatewayIp = subnet.replace(/0\/24$/, '1');
  const clientNet = `${project}-client`;
  const clientSubnet = `172.31.${130 + (process.pid % 40)}.0/24`;
  const bootstrap = path.join(deployDir, 'openbao/bootstrap.sh');
  const proxyPort = 8443 + PORT_OFFSET;
  const apiPort = 8090 + PORT_OFFSET;
  let bindAddr = '127.0.0.1';
  let proxyIp = '';
  let caDir = '';

  const secrets: string[] = [];
  const keep = (value: string): string => {
    if (value) secrets.push(value);
    return value;
  };
  const redact = (text: string): string =>
    secrets.reduce((acc, s) => acc.split(s).join('<redacted>'), text);
  let apiToken = '';
  let apiImage = '';

  const run = (cmd: string, args: string[], input = '', env: NodeJS.ProcessEnv = {}): Result => {
    const r = spawnSync(cmd, args, {
      encoding: 'utf8',
      input,
      env: { ...process.env, SDLC_ENV_FILE: envFile, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024,
    });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  const ok = (r: Result, what: string): Result => {
    if (r.status !== 0)
      throw new Error(`${what} failed (exit ${r.status}): ${redact(r.stderr + r.stdout)}`);
    return r;
  };
  const profiles = ['--profile', 'core', '--profile', 'platform', '--profile', 'access'];
  const compose = (...args: string[]): Result =>
    run('docker', [
      'compose',
      '-f',
      path.join(deployDir, 'docker-compose.yml'),
      '--env-file',
      envFile,
      ...args,
    ]);
  const bootstrapCmd = (args: string[], input = ''): Result =>
    run(bootstrap, args, input, { SDLC_OPENBAO_TEST: '1' });
  const setEnv = (values: Record<string, string>) => {
    let text = fs.readFileSync(envFile, 'utf8');
    for (const [key, value] of Object.entries(values)) {
      const line = new RegExp(`^${key}=.*$`, 'm');
      text = line.test(text) ? text.replace(line, `${key}=${value}`) : `${text}${key}=${value}\n`;
    }
    fs.writeFileSync(envFile, text, { mode: 0o600 });
  };

  // The client: a Node script in the api image (no extra image to pull), on its own network.
  const CLIENT = String.raw`
const tls = require('node:tls'); const https = require('node:https'); const http = require('node:http');
const fs = require('node:fs');
const [host, port, apiPort, token, mode] = process.argv.slice(1);
// With a CA mounted, an unreadable file fails the run at once (never a silent fallback).
const ca = process.env.SDLC_CA_MOUNTED === '1' ? fs.readFileSync('/ca/ca.pem') : undefined;
const pick = (h) => Object.fromEntries(['strict-transport-security','x-content-type-options',
  'x-frame-options','referrer-policy','permissions-policy','content-security-policy','content-type',
  'server'].filter((k) => h[k] !== undefined).map((k) => [k, String(h[k])]));
function req(name, opts, body) {
  return new Promise((resolve) => {
    const lib = opts.plain ? http : https;
    const r = lib.request({ host, port, method: 'GET', agent: false, servername: host,
      ...(opts.plain ? {} : { ca: opts.noCa ? undefined : ca }), timeout: 8000, ...opts.o }, (res) => {
      let data = ''; res.setEncoding('utf8'); res.on('data', (c) => { if (data.length < 400) data += c; });
      res.on('end', () => resolve({ name, status: res.statusCode, headers: pick(res.headers), body: data.slice(0, 400) }));
    });
    r.on('timeout', () => r.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    r.on('error', (e) => resolve({ name, error: e.code || e.message }));
    if (body) r.write(body); r.end();
  });
}
async function forgedRun() {
  // A forged X-Forwarded-For per request: the api's limit on failed sign-ins (10 a minute per
  // address) must still count this one client.
  // Let the proxy's own bucket refill first (a burst ran before): 40 at 10 a second.
  await new Promise((r) => setTimeout(r, 6000));
  const forged = [];
  for (let i = 0; i < 14; i++) {
    forged.push(await req('forged_' + i, { o: { path: '/v1/me', headers: {
      authorization: 'Bearer sdlc_pat_' + 'y'.repeat(43), 'x-forwarded-for': '10.9.' + i + '.1',
      forwarded: 'for=10.9.' + i + '.2' } } }));
  }
  return [{ name: 'forged', body: JSON.stringify(forged.map((f) => [f.status || f.error, f.headers && f.headers['content-type']])) }];
}
(async () => {
  if (mode === 'forged') { process.stdout.write(JSON.stringify(await forgedRun())); return; }
  const out = [];
  const auth = { authorization: 'Bearer ' + token };
  out.push(await req('live', { o: { path: '/health/live' } }));
  out.push(await req('ready', { o: { path: '/health/ready' } }));
  out.push(await req('dashboard', { o: { path: '/dashboard/' } }));
  out.push(await req('root', { o: { path: '/' } }));
  out.push(await req('me', { o: { path: '/v1/me', headers: auth } }));
  out.push(await req('metrics', { o: { path: '/metrics' } }));
  out.push(await req('docs', { o: { path: '/docs' } }));
  out.push(await req('no_ca', { noCa: true, o: { path: '/health/live' } }));
  out.push(await req('plain', { plain: true, o: { path: '/health/live' } }));
  out.push(await req('wrong_host', { o: { path: '/health/live', headers: { host: 'other.example.internal' } } }));
  out.push(await req('big_body', { o: { path: '/v1/intents', method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' } } }, 'x'.repeat(65 * 1024 + 1)));
  // The api's own port on the host: never reachable from another machine.
  out.push(await req('api_port', { plain: true, o: { port: apiPort, path: '/health/live' } }));
  // A burst: the proxy's per-client limit (10 a second, burst 40) answers 429.
  const burst = await Promise.all(Array.from({ length: 120 }, (_, i) => req('b' + i, { o: { path: '/health/live' } })));
  out.push({ name: 'burst', body: JSON.stringify(burst.map((b) => b.status || b.error)) });
  process.stdout.write(JSON.stringify(out));
})();
`;

  // What the operator hands people: a copy of ca.pem only (the public CA certificate), readable
  // by the client's user. SDLC_ACCESS_TLS_DIR itself is mode 700 and holds the key: on Linux the
  // client container's user cannot read it (Docker Desktop hides that).
  let caCopies = 0;
  const clientCa = (dir: string): string => {
    caCopies += 1;
    const out = path.join(tmp, `client-ca-${caCopies}`);
    fs.mkdirSync(out, { mode: 0o755 });
    fs.chmodSync(out, 0o755);
    fs.copyFileSync(path.join(dir, 'ca.pem'), path.join(out, 'ca.pem'));
    fs.chmodSync(path.join(out, 'ca.pem'), 0o644);
    return out;
  };
  const client = (ca: string | null, mode: 'main' | 'forged' = 'main'): Probe[] => {
    const args = [
      'run',
      '--rm',
      '--network',
      clientNet,
      '--add-host',
      `${HOSTNAME}:host-gateway`,
      '--read-only',
      '--cap-drop',
      'ALL',
      '--entrypoint',
      'node',
      ...(ca ? ['-v', `${clientCa(ca)}:/ca:ro`, '-e', 'SDLC_CA_MOUNTED=1'] : []),
      apiImage,
      '-e',
      CLIENT,
      HOSTNAME,
      String(proxyPort),
      String(apiPort),
      apiToken,
      mode,
    ];
    const r = ok(run('docker', args), 'client');
    return JSON.parse(r.stdout) as Probe[];
  };
  const by = (probes: Probe[], name: string): Probe => {
    const p = probes.find((x) => x.name === name);
    if (!p) throw new Error(`no probe ${name}`);
    return p;
  };
  let probes: Probe[] = [];

  beforeAll(async () => {
    ok(run(path.join(deployDir, 'scripts/init-env.sh'), [envFile]), 'init-env');
    const text = isolateEnv(fs.readFileSync(envFile, 'utf8'), {
      project,
      subnet,
      gateway: gatewayIp,
      portOffset: PORT_OFFSET,
    });
    fs.writeFileSync(envFile, text, { mode: 0o600 });
    const env = parseEnvFile(text);
    keep(env.get('PLATFORM_APP_DB_PASSWORD')!);
    keep(env.get('PLATFORM_DB_PASSWORD')!);
    proxyIp = env.get('SDLC_ACCESS_PROXY_IP')!;
    if (LINUX) {
      bindAddr = ok(
        run('docker', ['network', 'inspect', 'bridge', '-f', '{{(index .IPAM.Config 0).Gateway}}']),
        'bridge gateway',
      ).stdout.trim();
    }
    setEnv({
      SDLC_ACCESS_BIND_ADDR: bindAddr,
      SDLC_ACCESS_HOSTNAME: HOSTNAME,
      SDLC_ACCESS_IPS: bindAddr,
      SDLC_API_TRUSTED_PROXY: proxyIp,
    });
    ok(run(path.join(deployDir, 'access/tls.sh'), ['dev']), 'access tls dev');
    caDir = path.join(tmp, 'access-tls');
    expect(fs.existsSync(path.join(caDir, 'ca.pem'))).toBe(true);

    ok(compose('--profile', 'core', 'up', '-d', '--wait', 'openbao', 'postgres'), 'compose up');
    const init = ok(bootstrapCmd(['init', '--stdout-not-tty']), 'init');
    const shares = [...init.stdout.matchAll(/^Unseal Key \d+: (\S+)$/gm)].map((m) => keep(m[1]!));
    const rootToken = keep(/^Initial Root Token: (\S+)$/m.exec(init.stdout)?.[1] ?? '');
    ok(bootstrapCmd(['unseal'], `${shares[0]}\n${shares[1]}\n`), 'unseal');
    ok(bootstrapCmd(['configure', '--keep-token'], `${rootToken}\n`), 'configure');
    const pgUrl = (user: string, password: string) =>
      `postgresql://${user}:${encodeURIComponent(password)}@127.0.0.1:${5432 + PORT_OFFSET}/platform`;
    const owner = createKysely({
      connectionString: pgUrl('platform', env.get('PLATFORM_DB_PASSWORD')!),
      maxConnections: 1,
    });
    const { error } = await migrateToLatest(owner);
    await owner.destroy();
    if (error) throw new Error('migration failed', { cause: error });
    ok(bootstrapCmd(['api-credentials'], `${rootToken}\n`), 'api-credentials');

    // The checks up.sh runs before it starts the profile.
    ok(
      run(path.join(deployDir, 'access/check-settings.sh'), [
        envFile,
        'core',
        'platform',
        'access',
      ]),
      'check-settings',
    );
    const up = compose(
      ...profiles,
      'up',
      '-d',
      '--build',
      '--wait',
      '--wait-timeout',
      '180',
      'sdlc-access',
    );
    if (up.status !== 0) {
      const logs = compose(
        ...profiles,
        'logs',
        '--no-color',
        'sdlc-access',
        'sdlc-api',
        'access-tls-init',
      );
      throw new Error(`the proxy did not start: ${redact(logs.stdout + logs.stderr).slice(-4000)}`);
    }
    // The image the compose file builds for sdlc-api (it holds node, used as the client below).
    apiImage = 'sdlc-api:0.0.0';

    const appUrl = pgUrl('platform_app', env.get('PLATFORM_APP_DB_PASSWORD')!);
    const out: string[] = [];
    const ctx: CliContext = {
      env: { SDLC_DB_URL: appUrl },
      stdout: (line) => out.push(line),
      stderr: () => undefined,
      connect: processContext().connect,
    };
    const code = await runCli(
      [
        'ops',
        'bootstrap',
        '--tenant',
        'internal',
        '--tenant-name',
        'Internal',
        '--email',
        'admin@example.com',
        '--name',
        'Admin',
        '--json',
      ],
      ctx,
    );
    if (code !== 0) throw new Error('adlc ops bootstrap failed');
    apiToken = keep((JSON.parse(out.join('\n')) as { token: string }).token);

    ok(
      run('docker', [
        'network',
        'create',
        '--subnet',
        clientSubnet,
        '--label',
        `sdlc.test=${project}`,
        clientNet,
      ]),
      'client network',
    );
    probes = client(caDir);
  }, SETUP_TIMEOUT_MS);

  afterAll(() => {
    compose(...profiles, 'down', '--volumes', '--remove-orphans');
    run('docker', ['network', 'rm', clientNet]);
    fs.rmSync(tmp, { recursive: true, force: true });
  }, SETUP_TIMEOUT_MS);

  it('AC1: TLS verified with the CA, refused without it; the routes, /health/ready included', () => {
    expect(by(probes, 'live').status).toBe(200);
    expect(by(probes, 'ready').status).toBe(200);
    expect(by(probes, 'me').status).toBe(200);
    expect(by(probes, 'dashboard').status).toBe(200);
    expect(by(probes, 'root').status).toBe(308);
    expect(by(probes, 'metrics').status).toBe(404);
    expect(by(probes, 'docs').status).toBe(404);
    expect(by(probes, 'no_ca').error).toMatch(/SELF_SIGNED|UNABLE_TO|CERT/);
  });

  it('AC1: from another machine only the proxy answers; the api port stays on this machine', () => {
    if (LINUX) expect(by(probes, 'api_port').error).toMatch(/ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH/);
    const published = ok(compose(...profiles, 'ps', '--format', 'json'), 'ps').stdout;
    const rows = published.trim().startsWith('[')
      ? (JSON.parse(published) as Record<string, unknown>[])
      : published
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l) as Record<string, unknown>);
    for (const row of rows) {
      const publishers =
        (row.Publishers as { URL: string; PublishedPort: number; TargetPort: number }[] | null) ??
        [];
      for (const p of publishers) {
        if (!p.PublishedPort) continue;
        // O08 (ADR-M112 §2.4c): the webhook listener (8444) is unset here, so on this machine only.
        if (row.Service === 'sdlc-access' && p.TargetPort !== 8444) expect(p.URL).toBe(bindAddr);
        else
          expect(p.URL, `${String(row.Service)}:${String(p.TargetPort)}`).toMatch(
            /^(127\.0\.0\.1|::1)$/,
          );
      }
    }
  });

  it('AC1: the proxy reaches the api and nothing else on the platform', () => {
    const reach = (url: string) =>
      compose(
        ...profiles,
        'exec',
        '-T',
        'sdlc-access',
        'wget',
        '-q',
        '-T',
        '3',
        '-O',
        '/dev/null',
        url,
      ).status;
    expect(reach('http://sdlc-api:8080/health/live')).toBe(0);
    for (const url of [
      'http://postgres:5432/',
      'https://openbao:8200/',
      'http://seaweedfs:8333/',
      'http://temporal:7233/',
    ])
      expect(reach(url), url).not.toBe(0);
  });

  it('AC2: plain HTTP refused (400), a wrong Host 421, a large body 413', () => {
    expect(by(probes, 'plain').status).toBe(400);
    expect(by(probes, 'wrong_host').status).toBe(421);
    expect(by(probes, 'big_body').status).toBe(413);
  });

  it("AC2: the security headers; the api's dashboard CSP unchanged", () => {
    const h = by(probes, 'live').headers ?? {};
    expect(h['strict-transport-security']).toBe('max-age=31536000');
    expect(h['x-content-type-options']).toBe('nosniff');
    expect(h['x-frame-options']).toBe('DENY');
    expect(h['referrer-policy']).toBe('no-referrer');
    expect(h.server).toBe('nginx');
    const d = by(probes, 'dashboard').headers ?? {};
    expect(d['content-security-policy']).toBe(DASHBOARD_CSP);
    // One copy of each header (the api's copies are hidden): no comma-joined duplicates.
    expect(d['x-frame-options']).toBe('DENY');
    expect(d['x-content-type-options']).toBe('nosniff');
  });

  it('AC2: a per-client rate limit at the proxy', () => {
    const burst = JSON.parse(by(probes, 'burst').body ?? '[]') as (number | string)[];
    expect(burst.filter((s) => s === 429).length).toBeGreaterThan(0);
    expect(burst.filter((s) => s === 200).length).toBeGreaterThan(0);
  });

  it('AC3: the CLI through the proxy with NODE_EXTRA_CA_CERTS; refused without it', () => {
    ok(
      run('pnpm', ['exec', 'tsc', '-b', 'platform/apps/cli'], '', { SDLC_ENV_FILE: '' }),
      'build cli',
    );
    const cli = (extra: NodeJS.ProcessEnv) =>
      spawnSync('node', [path.join(root, 'platform/apps/cli/dist/main.js'), 'whoami', '--json'], {
        cwd: root,
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH ?? '',
          HOME: tmp,
          XDG_CONFIG_HOME: path.join(tmp, 'xdg'),
          SDLC_API_URL: `https://${bindAddr}:${proxyPort}`,
          SDLC_API_TOKEN: apiToken,
          ...extra,
        },
      });
    const good = cli({ NODE_EXTRA_CA_CERTS: path.join(caDir, 'ca.pem') });
    expect(good.status, redact(good.stderr)).toBe(0);
    expect(good.stdout).toContain('admin@example.com');
    expect(cli({}).status).not.toBe(0);
  });

  it('AC3: a renewed certificate is read without a restart; a missing one stops the job', () => {
    const before = ok(compose(...profiles, 'ps', '-q', 'sdlc-access'), 'ps').stdout.trim();
    const started = ok(
      run('docker', ['inspect', '-f', '{{.State.StartedAt}}', before]),
      'inspect',
    ).stdout;
    // A new throw-away CA and certificate, then `tls.sh reload`.
    fs.rmSync(caDir, { recursive: true, force: true });
    ok(run(path.join(deployDir, 'access/tls.sh'), ['dev']), 'tls dev again');
    ok(run(path.join(deployDir, 'access/tls.sh'), ['reload']), 'tls reload');
    const after = client(caDir);
    expect(by(after, 'live').status).toBe(200);
    expect(
      ok(run('docker', ['inspect', '-f', '{{.State.StartedAt}}', before]), 'inspect').stdout,
    ).toBe(started);
    // Without the files the job fails, so the proxy cannot start with them missing.
    fs.rmSync(path.join(caDir, 'server.pem'));
    const job = compose(...profiles, 'run', '--rm', '--no-deps', 'access-tls-init');
    expect(job.status).not.toBe(0);
    // The job's own message; on Docker Desktop the shared folder may still list the file, and cp fails.
    expect(job.stderr).toMatch(
      /server\.pem missing in SDLC_ACCESS_TLS_DIR|can't open '\/src\/server\.pem'/,
    );
  });

  // Last: it blocks this client's address at the api for a minute (and, where Docker shows local
  // clients with one address, the CLI's too).
  it('AC2: a forged X-Forwarded-For does not escape the api limit (only the proxy is trusted)', () => {
    const forged = JSON.parse(by(client(caDir, 'forged'), 'forged').body ?? '[]') as [
      number,
      string,
    ][];
    // The first ones are refused tokens (401); then the api's own limit for this address: a JSON 429.
    expect(forged[0]?.[0]).toBe(401);
    expect(
      forged.some(([status, type]) => status === 429 && type.includes('json')),
      JSON.stringify(forged),
    ).toBe(true);
  });

  it('holds no secret in the proxy environment or logs', () => {
    const container = ok(compose(...profiles, 'ps', '-q', 'sdlc-access'), 'ps').stdout.trim();
    const inspect = ok(run('docker', ['inspect', container]), 'inspect').stdout;
    const logs = ok(compose(...profiles, 'logs', 'sdlc-access'), 'logs');
    for (const secret of secrets) {
      expect(inspect.includes(secret), 'a secret is in docker inspect').toBe(false);
      expect((logs.stdout + logs.stderr).includes(secret), 'a secret is in the logs').toBe(false);
    }
    // The access log holds the path, never a query string or a header.
    expect(logs.stdout).toContain('"path":"/health/live"');
    expect(logs.stdout).not.toMatch(/authorization|Bearer/i);
  });
});
