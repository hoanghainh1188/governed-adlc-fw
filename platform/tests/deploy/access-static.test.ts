// V09 (design/ADR-M67): team access through a TLS reverse proxy, the static checks (no Docker):
// the profile `access` in docker-compose.yml, the nginx template, access/check-settings.sh (the
// checks up.sh runs first) and access/tls.sh. The live test is pnpm test:access.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parse } from 'yaml';
import { afterAll, describe, expect, it } from 'vitest';

import { deployDir, loadCompose, readDeployFile, root, servicesInProfile } from './compose';

interface Service {
  image?: string;
  profiles?: string[];
  restart?: string;
  networks?: string[] | Record<string, { ipv4_address?: string } | null>;
  network_mode?: string;
  environment?: Record<string, string>;
  ports?: string[];
  volumes?: string[];
  tmpfs?: string[];
  read_only?: boolean;
  cap_drop?: string[];
  cap_add?: string[];
  privileged?: boolean;
  user?: string;
  security_opt?: string[];
  depends_on?: Record<string, { condition: string }>;
  healthcheck?: { test?: string[] };
}
interface Network {
  name?: string;
  internal?: boolean;
  ipam?: { config?: { subnet?: string; gateway?: string; ip_range?: string }[] };
}

const compose = loadCompose();
const raw = parse(readDeployFile('docker-compose.yml'), { merge: true }) as {
  networks: Record<string, Network>;
  volumes: Record<string, unknown>;
};
const services = compose.services as unknown as Record<string, Service>;
const proxy = services['sdlc-access']!;
const job = services['access-tls-init']!;
const template = readDeployFile('access/nginx.conf.template');
// The template without comment lines.
const code = template
  .split('\n')
  .filter((l) => !l.trim().startsWith('#'))
  .join('\n');
const networksOf = (s: Service): string[] =>
  Array.isArray(s.networks) ? s.networks : Object.keys(s.networks ?? {});

describe('V09: the profile access in docker-compose.yml', () => {
  it('holds the certificate job and the proxy only', () => {
    expect(servicesInProfile(compose, 'access')).toEqual(['access-tls-init', 'sdlc-access']);
    expect(job.restart).toBe('no');
    expect(raw.volumes).toHaveProperty('access-tls');
  });

  it('pins nginx-unprivileged by tag and digest, the same image for both (ADR-M67 §2.1)', () => {
    expect(proxy.image).toMatch(
      /^nginxinc\/nginx-unprivileged:\d+\.\d+\.\d+-alpine@sha256:[0-9a-f]{64}$/,
    );
    expect(job.image).toBe(proxy.image);
    // Not an image the project builds: not one of the images of the release lock (ADR-M94 §2.4).
    expect(readDeployFile('scripts/images.sh')).not.toContain('nginx');
  });

  it('publishes the LAN port and the webhook port, each on its own address (127.0.0.1 when unset)', () => {
    expect(proxy.ports).toEqual([
      '${SDLC_ACCESS_BIND_ADDR:-127.0.0.1}:${SDLC_ACCESS_HOST_PORT:-8443}:8443',
      // O08 (ADR-M112 §2.1): GitHub webhooks only on their own listener.
      '${SDLC_ACCESS_WEBHOOK_BIND_ADDR:-127.0.0.1}:${SDLC_ACCESS_WEBHOOK_HOST_PORT:-8444}:8444',
    ]);
    for (const [name, s] of Object.entries(services)) {
      if (name === 'sdlc-access') continue;
      for (const port of s.ports ?? []) {
        expect(port, name).not.toContain('SDLC_ACCESS_BIND_ADDR');
        expect(port, name).not.toContain('SDLC_ACCESS_WEBHOOK_BIND_ADDR');
      }
    }
    // Unset, the allow-list admits no peer through Docker's port mapping.
    expect(proxy.environment?.SDLC_ACCESS_WEBHOOK_ALLOW_CIDR).toBe(
      '${SDLC_ACCESS_WEBHOOK_ALLOW_CIDR:-127.0.0.1/32}',
    );
    expect(services['sdlc-api']?.environment?.SDLC_API_GITHUB_WEBHOOKS).toBe(
      '${SDLC_API_GITHUB_WEBHOOKS:-off}',
    );
  });

  it('the network access: its own subnet, the proxy and the api only, `sdlc` unchanged (§2.5)', () => {
    const access = raw.networks.access!;
    expect(access.name).toBe('${COMPOSE_PROJECT_NAME:-sdlc}-access');
    // A published port needs a network that is not internal.
    expect(access.internal).toBeUndefined();
    expect(access.ipam?.config).toEqual([
      {
        subnet: '${SDLC_ACCESS_NETWORK_SUBNET:-172.30.1.0/29}',
        ip_range: '${SDLC_ACCESS_NETWORK_IP_RANGE:-172.30.1.0/30}',
      },
    ]);
    // ADR-M67 §2.6: the network `sdlc` keeps its subnet and gateway, and no allocation range.
    expect(raw.networks.sdlc?.ipam?.config).toEqual([
      {
        subnet: '${SDLC_NETWORK_SUBNET:-172.30.0.0/24}',
        gateway: '${SDLC_NETWORK_GATEWAY:-172.30.0.1}',
      },
    ]);
    const onAccess = Object.entries(services)
      .filter(([, s]) => networksOf(s).includes('access'))
      .map(([n]) => n)
      .sort();
    expect(onAccess).toEqual(['sdlc-access', 'sdlc-api']);
    expect(networksOf(proxy)).toEqual(['access']);
    expect(proxy.networks).toEqual({
      access: { ipv4_address: '${SDLC_ACCESS_PROXY_IP:-172.30.1.6}' },
    });
    // The api joins it always (ADR-M67 §2.5) and trusts only the proxy's address.
    expect(networksOf(services['sdlc-api']!)).toEqual(['sdlc', 'access']);
    expect(services['sdlc-api']!.environment?.SDLC_API_TRUSTED_PROXY).toBe(
      '${SDLC_API_TRUSTED_PROXY:-}',
    );
  });

  it('the proxy is hardened: non-root, read-only, no capability, no Docker socket', () => {
    expect(proxy.read_only).toBe(true);
    expect(proxy.cap_drop).toEqual(['ALL']);
    expect(proxy.cap_add).toBeUndefined();
    expect(proxy.privileged).toBeUndefined();
    expect(proxy.user).toBeUndefined(); // the image's own user, uid 101
    expect(proxy.security_opt).toEqual(['no-new-privileges:true']);
    expect(proxy.tmpfs).toEqual([
      '/etc/nginx/conf.d:uid=101,gid=101,mode=0755',
      '/tmp:uid=101,gid=101,mode=0755',
    ]);
    expect(proxy.volumes).toEqual([
      './access/nginx.conf.template:/etc/nginx/templates/sdlc-access.conf.template:ro',
      'access-tls:/etc/nginx/tls:ro',
    ]);
    expect(JSON.stringify(proxy)).not.toMatch(/docker\.sock|SDLC_ACCESS_TLS_DIR/);
    expect(proxy.depends_on).toEqual({
      'access-tls-init': { condition: 'service_completed_successfully' },
      'sdlc-api': { condition: 'service_healthy' },
    });
    expect(proxy.healthcheck?.test?.join(' ')).toContain('http://127.0.0.1:8081/healthz');
  });

  it('only the job mounts the host folder, read-only, without network; never a CA key', () => {
    expect(job.network_mode).toBe('none');
    expect(job.volumes).toEqual([
      '${SDLC_ACCESS_TLS_DIR:-./access/tls-dir-not-set}:/src:ro',
      'access-tls:/tls',
    ]);
    // Long syntax: Docker never creates the folder on the host when it is missing.
    expect(readDeployFile('docker-compose.yml')).toMatch(
      /source: \$\{SDLC_ACCESS_TLS_DIR:-[^}]+\}\n\s+target: \/src\n\s+read_only: true\n\s+bind:\n\s+create_host_path: false/,
    );
    const script = (job as { command?: string[] }).command?.join('\n') ?? '';
    expect(script).toContain('chmod 0600 /tls/server-key.pem.new');
    expect(script).not.toContain('ca-key');
    for (const [name, s] of Object.entries(services)) {
      if (name === 'access-tls-init') continue;
      for (const v of s.volumes ?? []) expect(v, name).not.toContain('SDLC_ACCESS_TLS_DIR');
    }
  });

  it('the template gets SDLC_ACCESS_* only, each set by the compose file', () => {
    const env = proxy.environment ?? {};
    expect(env.NGINX_ENVSUBST_FILTER).toBe('^SDLC_ACCESS_');
    const used = [...new Set([...template.matchAll(/\$\{([A-Z0-9_]+)\}/g)].map((m) => m[1]!))];
    expect(used.length).toBeGreaterThan(3);
    for (const name of used) {
      expect(name).toMatch(/^SDLC_ACCESS_/);
      expect(env, name).toHaveProperty(name);
    }
    for (const key of Object.keys(env))
      expect(key).toMatch(/^(SDLC_ACCESS_|NGINX_ENVSUBST_FILTER$)/);
  });

  it('up.sh knows the job and runs the setting checks first; compose:down stops the profile', () => {
    const up = readDeployFile('scripts/up.sh');
    expect(/^JOBS="([^"]+)"/m.exec(up)?.[1]?.split(' ')).toContain('access-tls-init');
    expect(up).toContain('"$deploy_dir/access/check-settings.sh" "$env_file" "$@"');
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['compose:down']).toContain('--profile access');
    expect(pkg.scripts['compose:access']).toBe(
      'platform/deploy/scripts/up.sh core platform access',
    );
    expect(pkg.scripts['access:tls']).toBe('platform/deploy/access/tls.sh');
  });
});

describe('V09: the nginx template (ADR-M67 §2.2-§2.5)', () => {
  /** The blocks `location … { … }` of the template: each closes at the server's indent (2). */
  const locations = [...code.matchAll(/location ([^{]+)\{([\s\S]*?)\n {2}\}/g)].map((m) => ({
    match: m[1]!.trim(),
    body: m[2]!,
  }));

  it('one TLS listener and the health listener on 127.0.0.1; no plain listener', () => {
    const listens = [...code.matchAll(/^\s*listen ([^;]+);/gm)].map((m) => m[1]!.trim());
    expect(listens).toEqual(['8443 ssl default_server', '8443 ssl', '8444 ssl', '127.0.0.1:8081']);
    expect(code).not.toMatch(/listen\s+80\b/);
    expect(code).toContain('ssl_protocols TLSv1.2 TLSv1.3;');
    expect(code).toContain('ssl_session_tickets off;');
    expect(code).toContain('server_tokens off;');
  });

  it('plain HTTP on the TLS port is refused with 400; an unknown Host gets 421', () => {
    expect(code.match(/error_page 497 = @plain_http;/g)).toHaveLength(3);
    expect(code).toMatch(/location @plain_http \{[^}]*return 400 /);
    expect(code).toMatch(/server_name _;[\s\S]*?return 421;/);
    expect(code).not.toMatch(/return 30[12] https/);
  });

  it('the route allow-list, /health/ready included; everything else 404', () => {
    const routes = locations.map((l) => l.match).filter((m) => !m.startsWith('@'));
    expect(routes).toEqual([
      '/',
      '= /',
      '/dashboard/',
      '/v1/auth/',
      '/v1/webhooks/',
      '/v1/',
      '= /health/live',
      '= /health/ready',
      '/',
      '= /v1/webhooks/github',
      '/',
      '= /healthz',
      '/',
    ]);
    const proxied = locations.filter((l) => l.body.includes('proxy_pass')).map((l) => l.match);
    expect(proxied).toEqual([
      '/dashboard/',
      '/v1/auth/',
      '/v1/',
      '= /health/live',
      '= /health/ready',
      '= /v1/webhooks/github',
    ]);
    for (const l of locations.filter((x) => x.body.includes('proxy_pass')))
      expect(l.body).toMatch(/limit_req zone=sdlc_(api|auth|webhook) burst=/);
    // O08: the LAN listener never passes a webhook on.
    expect(locations.find((l) => l.match === '/v1/webhooks/')?.body.trim()).toBe('return 404;');
    expect(code).toMatch(/location \/ \{\s*return 404;\s*\}/);
  });

  it('O08: the webhook listener: one POST route, an allow-list, its own limits (ADR-M112 §2.1)', () => {
    const server = /server \{\s*listen 8444 ssl;([\s\S]*?)\n\}/.exec(code)?.[1] ?? '';
    expect(server).toContain('server_name _;');
    expect(server).toMatch(/allow \$\{SDLC_ACCESS_WEBHOOK_ALLOW_CIDR\};\s*deny all;/);
    expect(server).toMatch(/if \(\$request_method != POST\) \{\s*return 405;/);
    expect(server).toMatch(/location \/ \{\s*return 404;\s*\}/);
    expect(server).toContain('proxy_set_header X-Forwarded-For $remote_addr;');
    expect(server).not.toMatch(/Content-Security-Policy/i);
    // The body limit equals the api's webhook limit.
    const route = fs.readFileSync(
      path.join(root, 'platform/apps/api/src/webhooks/github-webhooks.ts'),
      'utf8',
    );
    const mib = /WEBHOOK_BODY_LIMIT_BYTES = 1024 \* 1024;/.test(route) ? 1 : 0;
    expect(mib).toBe(1);
    expect(server).toContain('client_max_body_size 1m;');
    expect(code).toMatch(
      /limit_req_zone \$binary_remote_addr zone=sdlc_webhook:10m rate=\$\{SDLC_ACCESS_WEBHOOK_RATE_PER_SECOND\}r\/s;/,
    );
  });

  it('headers: HSTS and the rest at server level only; no CSP set or removed', () => {
    for (const h of [
      'Strict-Transport-Security "max-age=31536000"',
      'X-Content-Type-Options "nosniff"',
      'X-Frame-Options "DENY"',
      'Referrer-Policy "no-referrer"',
    ])
      expect(code).toContain(`add_header ${h} always;`);
    expect(code).not.toMatch(/includeSubDomains|preload/);
    expect(code).not.toMatch(/Content-Security-Policy/i);
    // A location with its own add_header would drop the server's.
    for (const l of locations) expect(l.body, l.match).not.toContain('add_header');
  });

  it('the client address is overwritten, never appended; no forwarded proto or host', () => {
    expect(code).toContain('proxy_set_header X-Forwarded-For $remote_addr;');
    expect(code).not.toContain('$proxy_add_x_forwarded_for');
    for (const h of ['Forwarded', 'X-Forwarded-Proto', 'X-Forwarded-Host', 'X-Real-IP'])
      expect(code).toContain(`proxy_set_header ${h} "";`);
    expect(code).toContain('set $sdlc_api http://sdlc-api:8080;');
    expect(code).toContain('resolver 127.0.0.11');
  });

  it('limits: the body limit equals the api, timeouts, per-client zones', () => {
    const app = fs.readFileSync(path.join(root, 'platform/apps/api/src/app.ts'), 'utf8');
    const kib = Number(/const BODY_LIMIT_BYTES = (\d+) \* 1024;/.exec(app)?.[1]);
    expect(code).toContain(`client_max_body_size ${kib}k;`);
    expect(code).toMatch(
      /limit_req_zone \$binary_remote_addr zone=sdlc_api:10m rate=\$\{SDLC_ACCESS_RATE_PER_SECOND\}r\/s;/,
    );
    expect(code).toMatch(
      /limit_req_zone \$binary_remote_addr zone=sdlc_auth:10m rate=\$\{SDLC_ACCESS_SIGNIN_RATE_PER_MINUTE\}r\/m;/,
    );
    expect(code).toContain('limit_conn sdlc_conn ${SDLC_ACCESS_CONN_PER_ADDR};');
    expect(code).toContain('limit_req_status 429;');
    for (const d of [
      'client_header_timeout 10s',
      'client_body_timeout 10s',
      'proxy_read_timeout 120s',
    ])
      expect(code).toContain(`${d};`);
  });

  it('logs hold no header, no query string and no request line', () => {
    const format = /log_format sdlc_access[^;]+;/.exec(code)?.[0] ?? '';
    expect(format).toContain('$uri');
    expect(format).not.toMatch(/\$request\b|\$request_uri|\$args|\$query_string|\$http_/);
    expect(code).not.toMatch(/access_log (?!\/dev\/stdout sdlc_access|off)/);
  });
});

// One shell process per case: a GitHub runner is about three times slower than a
// developer machine, so the 5 s default is too short for these tests.
const SHELL_TEST_TIMEOUT_MS = 30_000;

describe(
  'V09: access/check-settings.sh and access/tls.sh',
  { timeout: SHELL_TEST_TIMEOUT_MS },
  () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-access-static-'));
    afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const tls = path.join(deployDir, 'access/tls.sh');
    const check = path.join(deployDir, 'access/check-settings.sh');
    const baseEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin' };

    const good: Record<string, string> = {
      SDLC_ACCESS_BIND_ADDR: '192.168.10.5',
      SDLC_ACCESS_HOST_PORT: '8443',
      SDLC_ACCESS_HOSTNAME: 'sdlc.example.internal',
      SDLC_ACCESS_IPS: '192.168.10.5',
      SDLC_ACCESS_TLS_DIR: '',
      SDLC_ACCESS_NETWORK_SUBNET: '172.30.1.0/29',
      SDLC_ACCESS_NETWORK_IP_RANGE: '172.30.1.0/30',
      SDLC_ACCESS_PROXY_IP: '172.30.1.6',
      SDLC_API_TRUSTED_PROXY: '172.30.1.6',
      SDLC_API_WEB_SIGNIN: 'github',
      SDLC_API_PUBLIC_ORIGIN: 'https://sdlc.example.internal:8443',
      SDLC_NETWORK_SUBNET: '172.30.0.0/24',
    };
    let n = 0;
    const envFile = (values: Record<string, string>): string => {
      n += 1;
      const file = path.join(tmp, `e${n}.env`);
      fs.writeFileSync(
        file,
        Object.entries(values)
          .map(([k, v]) => `${k}=${v}`)
          .join('\n') + '\n',
        { mode: 0o600 },
      );
      return file;
    };
    const run = (cmd: string, args: string[], env: Record<string, string> = {}) =>
      spawnSync(cmd, args, { encoding: 'utf8', env: { ...baseEnv, ...env } });

    // A throw-away certificate for the checks (the CA key is deleted by tls.sh dev).
    const devEnv = envFile(good);
    const dev = run(tls, ['dev'], { SDLC_ENV_FILE: devEnv });
    const certDir = path.join(tmp, 'access-tls');
    const withCert = { ...good, SDLC_ACCESS_TLS_DIR: certDir };

    it('tls.sh dev: a throw-away CA, no CA key kept, the key mode 600, the folder recorded', () => {
      expect(dev.status, dev.stderr).toBe(0);
      expect(fs.readdirSync(certDir).sort()).toEqual(['ca.pem', 'server-key.pem', 'server.pem']);
      expect(fs.statSync(path.join(certDir, 'server-key.pem')).mode & 0o777).toBe(0o600);
      expect(fs.readFileSync(devEnv, 'utf8')).toContain(`SDLC_ACCESS_TLS_DIR=${certDir}`);
      const checked = run(tls, ['check'], { SDLC_ENV_FILE: devEnv });
      expect(checked.status, checked.stderr).toBe(0);
    });

    it('tls.sh refuses an IP address as the host name, a missing name, and names it lacks', () => {
      const ip = run(tls, ['dev'], {
        SDLC_ENV_FILE: envFile({ ...good, SDLC_ACCESS_HOSTNAME: '192.168.10.5' }),
      });
      expect(ip.status).toBe(1);
      expect(ip.stderr).toMatch(/not an IP address/);
      expect(
        run(tls, ['dev'], { SDLC_ENV_FILE: envFile({ ...good, SDLC_ACCESS_HOSTNAME: '' }) }).status,
      ).toBe(1);
      const other = run(tls, ['check'], {
        SDLC_ENV_FILE: envFile({ ...withCert, SDLC_ACCESS_HOSTNAME: 'other.example.internal' }),
      });
      expect(other.status).toBe(1);
      expect(other.stderr).toMatch(/does not name other\.example\.internal/);
    });

    it('tls.sh import and server refuse a folder in the repository; import refuses a CA key', () => {
      const inRepo = envFile({
        ...good,
        SDLC_ACCESS_TLS_DIR: path.join(root, 'platform/deploy/x-tls'),
      });
      const imported = run(tls, ['import', certDir], { SDLC_ENV_FILE: inRepo });
      expect(imported.status).toBe(1);
      expect(imported.stderr).toMatch(/outside the repository/);
      const withKey = path.join(tmp, 'with-key');
      fs.mkdirSync(withKey);
      for (const f of ['ca.pem', 'server.pem', 'server-key.pem'])
        fs.copyFileSync(path.join(certDir, f), path.join(withKey, f));
      fs.writeFileSync(path.join(withKey, 'ca-key.pem'), 'x');
      const target = path.join(tmp, 'imported');
      const refused = run(tls, ['import', withKey], {
        SDLC_ENV_FILE: envFile({ ...good, SDLC_ACCESS_TLS_DIR: target }),
      });
      expect(refused.status).toBe(1);
      expect(fs.existsSync(target)).toBe(false);
      fs.rmSync(path.join(withKey, 'ca-key.pem'));
      const ok = run(tls, ['import', withKey], {
        SDLC_ENV_FILE: envFile({ ...good, SDLC_ACCESS_TLS_DIR: target }),
      });
      expect(ok.status, ok.stderr).toBe(0);
      expect(fs.statSync(path.join(target, 'server-key.pem')).mode & 0o777).toBe(0o600);
    });

    const checkWith = (values: Record<string, string>, profiles = ['core', 'platform', 'access']) =>
      run(check, [envFile(values), ...profiles]);

    it('check-settings: good settings pass', () => {
      const r = checkWith(withCert);
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
    });

    it('check-settings: refuses every setting that would expose or confuse the proxy', () => {
      const cases: [Record<string, string>, RegExp][] = [
        [{ SDLC_ACCESS_BIND_ADDR: '' }, /set SDLC_ACCESS_BIND_ADDR/],
        [{ SDLC_ACCESS_BIND_ADDR: 'lan' }, /not an IPv4 address/],
        [{ SDLC_ACCESS_HOSTNAME: '' }, /set SDLC_ACCESS_HOSTNAME/],
        [{ SDLC_ACCESS_PROXY_IP: '172.30.1.2' }, /inside the allocation range/],
        [{ SDLC_ACCESS_PROXY_IP: '172.30.1.1' }, /gateway/],
        [{ SDLC_ACCESS_PROXY_IP: '172.30.2.6' }, /not a host address/],
        [
          {
            SDLC_ACCESS_NETWORK_SUBNET: '172.30.0.0/29',
            SDLC_ACCESS_NETWORK_IP_RANGE: '172.30.0.0/30',
            SDLC_ACCESS_PROXY_IP: '172.30.0.6',
            SDLC_API_TRUSTED_PROXY: '172.30.0.6',
          },
          /overlaps SDLC_NETWORK_SUBNET/,
        ],
        [{ SDLC_ACCESS_NETWORK_IP_RANGE: '172.30.9.0/30' }, /not inside/],
        [{ SDLC_API_TRUSTED_PROXY: '' }, /SDLC_API_TRUSTED_PROXY=172\.30\.1\.6/],
        [
          { SDLC_API_PUBLIC_ORIGIN: 'http://localhost:8090' },
          /must be https:\/\/sdlc\.example\.internal:8443/,
        ],
        [{ SDLC_API_PUBLIC_ORIGIN: '' }, /set SDLC_API_PUBLIC_ORIGIN/],
        [{ SDLC_ACCESS_TLS_DIR: '' }, /set SDLC_ACCESS_TLS_DIR/],
        [{ SDLC_ACCESS_TLS_DIR: path.join(tmp, 'none') }, /certificate cannot be used/],
      ];
      for (const [change, message] of cases) {
        const r = checkWith({ ...withCert, ...change });
        expect(r.status, JSON.stringify(change)).toBe(1);
        expect(r.stderr, JSON.stringify(change)).toMatch(message);
      }
      const noPlatform = checkWith(withCert, ['core', 'access']);
      expect(noPlatform.status).toBe(1);
      expect(noPlatform.stderr).toMatch(/profile platform/);
    });

    it('O08: check-settings: the webhook listener needs an address, an allow-list and its own port', () => {
      const webhook = {
        ...withCert,
        SDLC_ACCESS_WEBHOOK_BIND_ADDR: '192.168.10.5',
        SDLC_ACCESS_WEBHOOK_ALLOW_CIDR: '10.20.0.8/32',
        SDLC_API_GITHUB_WEBHOOKS: 'on',
      };
      const ok = checkWith(webhook);
      expect(ok.stderr).toBe('');
      expect(ok.status).toBe(0);
      const cases: [Record<string, string>, RegExp][] = [
        [{ SDLC_ACCESS_WEBHOOK_BIND_ADDR: 'dmz' }, /SDLC_ACCESS_WEBHOOK_BIND_ADDR is not an IPv4/],
        [{ SDLC_ACCESS_WEBHOOK_ALLOW_CIDR: '' }, /set SDLC_ACCESS_WEBHOOK_ALLOW_CIDR/],
        [
          { SDLC_ACCESS_WEBHOOK_ALLOW_CIDR: '10.0.0.1; allow all' },
          /not one IPv4 address or network/,
        ],
        [{ SDLC_ACCESS_WEBHOOK_ALLOW_CIDR: '10.0.0.0/33' }, /not one IPv4 address or network/],
        [{ SDLC_ACCESS_WEBHOOK_ALLOW_CIDR: '10.0.0.300' }, /not one IPv4 address or network/],
        [{ SDLC_ACCESS_WEBHOOK_HOST_PORT: '8443' }, /must differ from SDLC_ACCESS_HOST_PORT/],
      ];
      for (const [change, message] of cases) {
        const r = checkWith({ ...webhook, ...change });
        expect(r.status, JSON.stringify(change)).toBe(1);
        expect(r.stderr, JSON.stringify(change)).toMatch(message);
      }
      const everyone = checkWith({ ...webhook, SDLC_ACCESS_WEBHOOK_ALLOW_CIDR: '0.0.0.0/0' });
      expect(everyone.status).toBe(0);
      expect(everyone.stderr).toMatch(/warning: SDLC_ACCESS_WEBHOOK_ALLOW_CIDR=0\.0\.0\.0\/0/);
      const off = checkWith({ ...webhook, SDLC_API_GITHUB_WEBHOOKS: 'off' });
      expect(off.status).toBe(0);
      expect(off.stderr).toMatch(
        /warning: the webhook listener is set, but SDLC_API_GITHUB_WEBHOOKS is off/,
      );
      const noListener = checkWith({ ...withCert, SDLC_API_GITHUB_WEBHOOKS: 'on' });
      expect(noListener.status).toBe(0);
      expect(noListener.stderr).toMatch(
        /warning: SDLC_API_GITHUB_WEBHOOKS=on, but SDLC_ACCESS_WEBHOOK_BIND_ADDR is empty/,
      );
    });

    it('check-settings: 0.0.0.0 and port 443 are allowed; 0.0.0.0 warns', () => {
      const all = checkWith({ ...withCert, SDLC_ACCESS_BIND_ADDR: '0.0.0.0' });
      expect(all.status).toBe(0);
      expect(all.stderr).toMatch(/warning: SDLC_ACCESS_BIND_ADDR=0\.0\.0\.0/);
      const p443 = checkWith({
        ...withCert,
        SDLC_ACCESS_HOST_PORT: '443',
        SDLC_API_PUBLIC_ORIGIN: 'https://sdlc.example.internal',
      });
      expect(p443.status, p443.stderr).toBe(0);
    });

    it('up.sh stops before Docker when the profile access is not ready', () => {
      const bin = path.join(tmp, 'bin');
      fs.mkdirSync(bin, { recursive: true });
      fs.writeFileSync(path.join(bin, 'docker'), '#!/bin/sh\necho docker-called >&2\nexit 3\n', {
        mode: 0o755,
      });
      const r = spawnSync(
        'sh',
        [path.join(deployDir, 'scripts/up.sh'), 'core', 'platform', 'access'],
        {
          encoding: 'utf8',
          env: {
            PATH: `${bin}:/usr/bin:/bin`,
            SDLC_ENV_FILE: envFile({ ...withCert, SDLC_ACCESS_BIND_ADDR: '' }),
            SDLC_IMAGES: 'local',
          },
        },
      );
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/the profile access is not ready; nothing started/);
      expect(r.stderr).not.toContain('docker-called');
    });
  },
);
