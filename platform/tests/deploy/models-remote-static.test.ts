// D-08 L01 AC1 (static part of L01 PR 2, no Docker, no GPU): vLLM on a separate GPU host, linked to
// the platform with mutual TLS (design/ADR-M71 §4, QUESTIONS #666–#669). The GPU host's Compose
// file, the gateway and link templates, the profile `models-remote`, up.sh and gpu-link/tls.sh.
// The live part: integration/deploy/vllm-link.test.ts (pnpm test:vllm-link).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parse } from 'yaml';
import { afterAll, describe, expect, it } from 'vitest';

import { deployDir, parseEnvFile, readDeployFile } from './compose';

interface Service {
  image?: string;
  profiles?: string[];
  restart?: string;
  networks?: string[] | Record<string, { aliases?: string[] } | null>;
  network_mode?: string;
  user?: string;
  environment?: Record<string, string>;
  command?: string[];
  entrypoint?: string[];
  ports?: string[];
  volumes?: unknown[];
  extra_hosts?: string[];
  read_only?: boolean;
  cap_drop?: string[];
  security_opt?: string[];
  depends_on?: Record<string, { condition: string }>;
}
interface Compose {
  name?: string;
  services: Record<string, Service>;
  networks: Record<string, { name?: string; internal?: boolean }>;
  volumes: Record<string, unknown>;
}

const platform = parse(readDeployFile('docker-compose.yml'), { merge: true }) as Compose;
const gpu = parse(readDeployFile('gpu-host/docker-compose.yml'), { merge: true }) as Compose;
const gpuText = readDeployFile('gpu-host/docker-compose.yml');
const gateway = readDeployFile('gpu-host/gateway.conf.template');
const link = readDeployFile('gpu-link/link.conf.template');
const envExample = parseEnvFile(readDeployFile('.env.example'));
const gpuEnvExample = parseEnvFile(readDeployFile('gpu-host/.env.example'));
const root = parse(readDeployFile('../../package.json')) as { scripts: Record<string, string> };

const NGINX = /^nginxinc\/nginx-unprivileged:\d+\.\d+\.\d+-alpine@sha256:[0-9a-f]{64}$/;
const networksOf = (s: Service): string[] =>
  Array.isArray(s.networks) ? s.networks : Object.keys(s.networks ?? {});
/** The `location` blocks of an nginx template, as `= path` strings. */
const locations = (conf: string) =>
  [...conf.matchAll(/^\s*location (= \S+|\/) \{/gm)].map((m) => m[1]);
// The four routes, the 404 for everything else, and nginx's own health page (127.0.0.1 only).
const ROUTES = [
  '= /v1/chat/completions',
  '= /v1/completions',
  '= /v1/models',
  '= /health',
  '/',
  '= /healthz',
];

describe('the GPU host Compose file (ADR-M71 §4.1, QUESTIONS #666, #667)', () => {
  it('holds vllm, vllm-pull and the gateway only: no platform service, volume or network', () => {
    expect(Object.keys(gpu.services).sort()).toEqual([
      'vllm',
      'vllm-gateway',
      'vllm-gateway-tls-init',
      'vllm-pull',
    ]);
    expect(Object.keys(gpu.volumes).sort()).toEqual(['gateway-tls', 'vllm-models']);
    expect(Object.keys(gpu.networks).sort()).toEqual(['link', 'models', 'pull']);
    expect(gpu.name).toBe('${COMPOSE_PROJECT_NAME:-sdlc-gpu}');
    expect(gpuEnvExample.get('COMPOSE_PROJECT_NAME')).toBe('sdlc-gpu');
    for (const n of Object.values(gpu.networks))
      expect(n.name).toMatch(/^\$\{COMPOSE_PROJECT_NAME:-sdlc-gpu\}-/);
  });

  it('keeps vllm and vllm-pull equal to the platform file; only networks and profiles differ', () => {
    for (const name of ['vllm', 'vllm-pull']) {
      const without = (svc: Service) =>
        Object.fromEntries(
          Object.entries(svc).filter(([key]) => key !== 'networks' && key !== 'profiles'),
        );
      expect(without(gpu.services[name]!), name).toEqual(without(platform.services[name]!));
    }
    expect(gpu.services.vllm!.profiles).toBeUndefined();
    expect(gpu.services['vllm-pull']!.profiles).toEqual(['pull']);
    expect(gpu.services['vllm-pull']!.networks).toEqual(['pull']);
  });

  it('keeps vllm on the internal network models with the gateway only, with no port (R137)', () => {
    expect(gpu.networks.models).toEqual({
      name: '${COMPOSE_PROJECT_NAME:-sdlc-gpu}-models',
      internal: true,
    });
    expect(gpu.services.vllm!.networks).toEqual(['models']);
    expect(gpu.services.vllm!.ports).toBeUndefined();
    const members = Object.entries(gpu.services)
      .filter(([, s]) => networksOf(s).includes('models'))
      .map(([n]) => n)
      .sort();
    expect(members).toEqual(['vllm', 'vllm-gateway']);
    expect(gpu.networks.link!.internal).toBeUndefined();
    const onLink = Object.entries(gpu.services).filter(([, s]) => networksOf(s).includes('link'));
    expect(onLink.map(([n]) => n)).toEqual(['vllm-gateway']);
  });

  it('publishes one port, the gateway, only on the required SDLC_GPU_LINK_ADDR', () => {
    const published = Object.entries(gpu.services).filter(([, s]) => s.ports);
    expect(published.map(([n]) => n)).toEqual(['vllm-gateway']);
    expect(gpu.services['vllm-gateway']!.ports).toEqual([
      '${SDLC_GPU_LINK_ADDR:?set SDLC_GPU_LINK_ADDR in gpu-host/.env}:${SDLC_GPU_LINK_PORT:-8443}:8443',
    ]);
    expect(gpuEnvExample.get('SDLC_GPU_LINK_ADDR')).toBe('');
  });

  it('runs the gateway as the pinned nginx of the access proxy, hardened, with its template', () => {
    const g = gpu.services['vllm-gateway']!;
    expect(g.image).toMatch(NGINX);
    expect(g.image).toBe(platform.services['sdlc-access']!.image);
    expect(g.image).toBe(gpu.services['vllm-gateway-tls-init']!.image);
    expect(g.read_only).toBe(true);
    expect(g.cap_drop).toEqual(['ALL']);
    expect(g.security_opt).toEqual(['no-new-privileges:true']);
    expect(g.user).toBeUndefined();
    expect(g.environment?.NGINX_ENVSUBST_FILTER).toBe('^SDLC_GPU_LINK_');
    expect(g.volumes).toContain(
      './gateway.conf.template:/etc/nginx/templates/sdlc-gpu-link.conf.template:ro',
    );
    expect(g.volumes).toContain('gateway-tls:/etc/nginx/tls:ro');
    expect(g.depends_on).toEqual({
      'vllm-gateway-tls-init': { condition: 'service_completed_successfully' },
    });
  });

  it('copies the TLS files with no network, refuses a missing file and a CA key', () => {
    const init = gpu.services['vllm-gateway-tls-init']!;
    expect(init.network_mode).toBe('none');
    expect(init.restart).toBe('no');
    const script = init.command?.join('\n') ?? '';
    expect(script).toContain('for f in ca.pem server.pem server-key.pem');
    expect(script).toContain('test ! -e /src/ca-key.pem');
    expect(script).toContain('chmod 0600 /tls/server-key.pem.new');
    expect(gpuText).toContain('source: ${SDLC_GPU_LINK_TLS_DIR:-./gpu-link-tls-dir-not-set}');
    expect(gpuText).toContain('create_host_path: false');
  });

  it('gpu-host/.env.example gives the same defaults as the file and the platform settings', () => {
    const defaults = [...gpuText.matchAll(/\$\{(SDLC_[A-Z_]+):-([^}]*)\}/g)];
    expect(defaults.length).toBeGreaterThan(0);
    for (const [, name, value] of defaults) {
      // The placeholder of an unset folder is not a default an operator keeps.
      if (name === 'SDLC_GPU_LINK_TLS_DIR') expect(gpuEnvExample.get(name), name).toBe('');
      else expect(gpuEnvExample.get(name!), name).toBe(value);
    }
    for (const [name, value] of gpuEnvExample) {
      if (name.startsWith('SDLC_VLLM_')) expect(envExample.get(name), name).toBe(value);
    }
    expect([...gpuEnvExample.keys()].join(' ')).not.toMatch(/KEY|TOKEN|SECRET|PASSWORD/);
  });
});

describe('the gateway template (ADR-M71 §4.1, QUESTIONS #666)', () => {
  it('requires a client certificate of the link CA whose CN names the link', () => {
    expect(gateway).toMatch(/^ssl_verify_client on;$/m);
    expect(gateway).toMatch(/^ssl_client_certificate \/etc\/nginx\/tls\/ca\.pem;$/m);
    expect(gateway).not.toMatch(/ssl_verify_client (optional|off)/);
    expect(gateway).toContain('"~(^|,)CN=${SDLC_GPU_LINK_CLIENT_CN}(,|$)" 1;');
    expect(gateway).toMatch(/if \(\$sdlc_link_client = 0\) \{\s*return 403;/);
    expect(gateway).toMatch(/^\s*listen 8443 ssl;$/m);
    // The only other listener is the health page on loopback.
    expect([...gateway.matchAll(/^\s*listen (.+);$/gm)].map((m) => m[1])).toEqual([
      '8443 ssl',
      '127.0.0.1:8081',
    ]);
  });

  it('forwards the four routes to vllm only; everything else is 404 (no /invocations)', () => {
    expect(locations(gateway)).toEqual(ROUTES);
    expect(gateway).toMatch(/location \/ \{\s*return 404;/);
    expect(gateway).not.toContain('invocations');
    expect(gateway).toContain('set $sdlc_vllm http://vllm:8000;');
    expect([...gateway.matchAll(/proxy_pass (\S+);/g)].map((m) => m[1])).toEqual(
      Array(4).fill('$sdlc_vllm'),
    );
  });

  it('logs no header, no body and no query string; streams answers', () => {
    const format = /log_format sdlc_gpu_link[\s\S]*?;\n/.exec(gateway)?.[0] ?? '';
    expect(format).toContain('$uri');
    expect(format).not.toMatch(
      /\$request\b|\$request_uri|\$args|\$query_string|\$http_|\$request_body|\$ssl_client/,
    );
    expect(gateway).toMatch(/^proxy_buffering off;$/m);
    expect(gateway).toContain('proxy_set_header Authorization "";');
  });
});

describe('the link template (ADR-M71 §4.2, QUESTIONS #667)', () => {
  it('listens on 8000 without TLS (LiteLLM entry unchanged) and calls the gateway over TLS', () => {
    expect([...link.matchAll(/^\s*listen (.+);$/gm)].map((m) => m[1])).toEqual([
      '8000',
      '127.0.0.1:8081',
    ]);
    expect(link).toContain('server ${SDLC_GPU_HOST_NAME}:${SDLC_GPU_LINK_PORT} max_fails=0;');
    expect([...link.matchAll(/proxy_pass (\S+);/g)].map((m) => m[1])).toEqual(
      Array(4).fill('https://sdlc_gpu_gateway'),
    );
  });

  it('presents its client certificate and verifies the GPU host certificate and name', () => {
    expect(link).toMatch(/^proxy_ssl_verify on;$/m);
    expect(link).not.toMatch(/proxy_ssl_verify off/);
    expect(link).toMatch(/^proxy_ssl_certificate \/etc\/nginx\/tls\/client\.pem;$/m);
    expect(link).toMatch(/^proxy_ssl_certificate_key \/etc\/nginx\/tls\/client-key\.pem;$/m);
    expect(link).toMatch(/^proxy_ssl_trusted_certificate \/etc\/nginx\/tls\/ca\.pem;$/m);
    expect(link).toMatch(/^proxy_ssl_name \$\{SDLC_GPU_HOST_NAME\};$/m);
  });

  it('forwards the same four routes only and logs no header or query string', () => {
    expect(locations(link)).toEqual(ROUTES);
    const format = /log_format sdlc_vllm_link[\s\S]*?;\n/.exec(link)?.[0] ?? '';
    expect(format).toContain('$uri');
    expect(format).not.toMatch(
      /\$request\b|\$request_uri|\$args|\$query_string|\$http_|\$request_body/,
    );
  });
});

describe('the profile models-remote (ADR-M71 §4.2, QUESTIONS #667)', () => {
  const linkSvc = platform.services['vllm-link']!;
  const init = platform.services['vllm-link-tls-init']!;

  it('is optional: only vllm-link and its job, started by compose:models-remote only', () => {
    const inProfile = Object.entries(platform.services)
      .filter(([, s]) => (s.profiles ?? []).includes('models-remote'))
      .map(([n]) => n)
      .sort();
    expect(inProfile).toEqual(['vllm-link', 'vllm-link-tls-init']);
    expect(linkSvc.profiles).toEqual(['models-remote']);
    expect(root.scripts['compose:models-remote']).toBe(
      'platform/deploy/scripts/up.sh core models models-remote',
    );
    expect(root.scripts['compose:down']).toContain('--profile models-remote ');
    for (const [name, script] of Object.entries(root.scripts)) {
      if (name === 'compose:models-remote' || name === 'compose:down') continue;
      expect(script, name).not.toMatch(/models-remote/);
    }
  });

  it('is on models with the alias vllm and on its own network models-link, with no port', () => {
    expect(linkSvc.networks).toEqual({ models: { aliases: ['vllm'] }, 'models-link': {} });
    expect(linkSvc.ports).toBeUndefined();
    expect(platform.networks.models!.internal).toBe(true);
    expect(platform.networks['models-link']).toEqual({
      name: '${COMPOSE_PROJECT_NAME:-sdlc}-models-link',
    });
    const onLink = Object.entries(platform.services).filter(([, s]) =>
      networksOf(s).includes('models-link'),
    );
    expect(onLink.map(([n]) => n)).toEqual(['vllm-link']);
  });

  it('names the GPU host at its address, from the settings, with the same nginx image', () => {
    expect(linkSvc.extra_hosts).toEqual([
      '${SDLC_GPU_HOST_NAME:-gpu-host-name-not-set}:${SDLC_GPU_HOST_ADDR:-127.0.0.1}',
    ]);
    expect(linkSvc.image).toBe(platform.services['sdlc-access']!.image);
    expect(init.image).toBe(linkSvc.image);
    expect(linkSvc.environment?.NGINX_ENVSUBST_FILTER).toBe('^SDLC_GPU_');
    expect(linkSvc.read_only).toBe(true);
    expect(linkSvc.cap_drop).toEqual(['ALL']);
    expect(linkSvc.volumes).toContain(
      './gpu-link/link.conf.template:/etc/nginx/templates/sdlc-vllm-link.conf.template:ro',
    );
    expect(init.network_mode).toBe('none');
    const script = init.command?.join('\n') ?? '';
    expect(script).toContain('for f in ca.pem client.pem client-key.pem');
    expect(script).toContain('test ! -e /src/ca-key.pem');
    expect(platform.volumes).toHaveProperty('vllm-link-tls');
  });

  it('.env.example gives every setting the same default as the compose file', () => {
    const code = readDeployFile('docker-compose.yml');
    const defaults = [...code.matchAll(/\$\{(SDLC_GPU_[A-Z_]+):-([^}]*)\}/g)];
    expect(defaults.length).toBeGreaterThan(0);
    for (const [, name, value] of defaults) {
      // The placeholders of an unset name or address are not defaults an operator keeps.
      if (name === 'SDLC_GPU_HOST_NAME' || name === 'SDLC_GPU_HOST_ADDR') {
        expect(envExample.get(name), name).toBe('');
        continue;
      }
      expect(envExample.get(name!), name).toBe(value);
    }
    expect(envExample.get('SDLC_VLLM_LINK_TLS_DIR')).toBe('');
    expect(envExample.get('SDLC_GPU_LINK_PORT')).toBe(gpuEnvExample.get('SDLC_GPU_LINK_PORT'));
  });

  it('the GPU host scripts run the GPU host file only', () => {
    for (const cmd of ['env', 'pull', 'up', 'down'])
      expect(root.scripts[`gpu-host:${cmd}`]).toBe(`platform/deploy/scripts/gpu-host.sh ${cmd}`);
    expect(root.scripts['gpu-link:tls']).toBe('platform/deploy/gpu-link/tls.sh');
    const script = readDeployFile('scripts/gpu-host.sh');
    expect(script).toContain('docker compose -f "$host_dir/docker-compose.yml"');
    expect(script).toContain('label=com.docker.compose.volume=postgres-data');
  });
});

// One shell process per case: a GitHub runner is slower than a developer machine.
const SHELL_TEST_TIMEOUT_MS = 30_000;

describe(
  'up.sh and gpu-link/tls.sh (QUESTIONS #667, #668)',
  { timeout: SHELL_TEST_TIMEOUT_MS },
  () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-gpu-link-static-'));
    afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const tls = path.join(deployDir, 'gpu-link/tls.sh');
    const up = path.join(deployDir, 'scripts/up.sh');
    const gpuHost = path.join(deployDir, 'scripts/gpu-host.sh');
    // No docker on PATH: a script that would reach Docker fails, so a refusal must come first.
    const baseEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin' };
    const run = (cmd: string, args: string[], env: Record<string, string> = {}) =>
      spawnSync(cmd, args, { encoding: 'utf8', env: { ...baseEnv, ...env } });
    const envFile = (name: string, values: Record<string, string>) => {
      const file = path.join(tmp, name);
      fs.writeFileSync(
        file,
        Object.entries(values)
          .map(([k, v]) => `${k}=${v}`)
          .join('\n') + '\n',
        { mode: 0o600 },
      );
      return file;
    };

    it('up.sh refuses models-local with models-remote, and models-remote without its settings', () => {
      const f = envFile('up.env', { COMPOSE_PROJECT_NAME: 'x' });
      const both = run(up, ['core', 'models', 'models-local', 'models-remote'], {
        SDLC_ENV_FILE: f,
      });
      expect(both.status).toBe(1);
      expect(both.stderr).toContain('models-local and models-remote cannot run together');
      const bare = run(up, ['core', 'models', 'models-remote'], { SDLC_ENV_FILE: f });
      expect(bare.status).toBe(1);
      expect(bare.stderr).toContain('SDLC_GPU_HOST_NAME is not set');
      const noTls = envFile('up2.env', {
        SDLC_GPU_HOST_NAME: 'gpu.example.internal',
        SDLC_GPU_HOST_ADDR: '10.0.0.5',
      });
      const r = run(up, ['core', 'models', 'models-remote'], { SDLC_ENV_FILE: noTls });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('SDLC_VLLM_LINK_TLS_DIR is not set');
    });

    it('gpu-host.sh env never overwrites; up refuses an empty link address', () => {
      const f = path.join(tmp, 'gpu.env');
      const first = run(gpuHost, ['env'], { SDLC_GPU_HOST_ENV_FILE: f });
      expect(first.status, first.stderr).toBe(0);
      expect(fs.statSync(f).mode & 0o777).toBe(0o600);
      const again = run(gpuHost, ['env'], { SDLC_GPU_HOST_ENV_FILE: f });
      expect(again.status).toBe(1);
      expect(again.stderr).toContain('already exists');
      const upEmpty = run(gpuHost, ['up'], { SDLC_GPU_HOST_ENV_FILE: f });
      expect(upEmpty.status).toBe(1);
      expect(upEmpty.stderr).toContain('SDLC_GPU_LINK_ADDR is empty');
    });

    // Both sides from one throw-away CA (its key deleted by tls.sh dev).
    const certs = path.join(tmp, 'certs');
    const dev = run(tls, ['dev', 'gpu.example.internal', certs]);

    it('dev: two folders, no CA key, keys mode 600, each side valid', () => {
      expect(dev.status, dev.stderr).toBe(0);
      expect(fs.readdirSync(certs).sort()).toEqual(['gpu-host', 'platform']);
      expect(fs.readdirSync(path.join(certs, 'gpu-host')).sort()).toEqual([
        'ca.pem',
        'server-key.pem',
        'server.pem',
      ]);
      expect(fs.readdirSync(path.join(certs, 'platform')).sort()).toEqual([
        'ca.pem',
        'client-key.pem',
        'client.pem',
      ]);
      expect(fs.statSync(path.join(certs, 'gpu-host/server-key.pem')).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.join(certs, 'platform/client-key.pem')).mode & 0o777).toBe(0o600);
      const s = run(tls, ['check', path.join(certs, 'gpu-host'), 'gpu.example.internal']);
      expect(s.status, s.stderr).toBe(0);
      const c = run(tls, ['check', path.join(certs, 'platform')]);
      expect(c.status, c.stderr).toBe(0);
    });

    it('check refuses another host name, another client name, a CA key and a swapped purpose', () => {
      const other = run(tls, ['check', path.join(certs, 'gpu-host'), 'other.example.internal']);
      expect(other.status).toBe(1);
      expect(other.stderr).toContain('does not name other.example.internal');
      const cn = run(tls, ['check', path.join(certs, 'platform')], {
        SDLC_GPU_LINK_CLIENT_CN: 'someone',
      });
      expect(cn.status).toBe(1);
      expect(cn.stderr).toContain('does not hold CN=someone');
      // The client certificate where a server certificate belongs: wrong purpose.
      const swapped = path.join(tmp, 'swapped');
      fs.mkdirSync(swapped);
      fs.copyFileSync(path.join(certs, 'platform/ca.pem'), path.join(swapped, 'ca.pem'));
      fs.copyFileSync(path.join(certs, 'platform/client.pem'), path.join(swapped, 'server.pem'));
      fs.copyFileSync(
        path.join(certs, 'platform/client-key.pem'),
        path.join(swapped, 'server-key.pem'),
      );
      const p = run(tls, ['check', swapped]);
      expect(p.status).toBe(1);
      expect(p.stderr).toContain('not signed by ca.pem for server use');
      fs.writeFileSync(path.join(swapped, 'ca-key.pem'), 'x');
      const key = run(tls, ['check', swapped]);
      expect(key.status).toBe(1);
      expect(key.stderr).toContain('holds a CA key');
    });

    it('dev and issue refuse an IP address as the name and a folder that is not empty', () => {
      const ip = run(tls, ['dev', '10.0.0.5', path.join(tmp, 'ip')]);
      expect(ip.status).toBe(1);
      expect(ip.stderr).toContain('not an IP address');
      const full = run(tls, ['dev', 'gpu.example.internal', certs]);
      expect(full.status).toBe(1);
      expect(full.stderr).toContain('is not empty');
      const noCa = run(tls, ['issue', certs, 'gpu.example.internal', path.join(tmp, 'n')]);
      expect(noCa.status).toBe(1);
      expect(noCa.stderr).toContain('holds no CA');
    });

    /** A CA folder (ca.pem, ca-key.pem) that lasts `days`, as openbao/tls.sh ca makes one. */
    const makeCa = (name: string, days: number): string => {
      const ca = path.join(tmp, name);
      fs.mkdirSync(ca);
      const key = path.join(ca, 'ca-key.pem');
      const mk = (args: string[]) => expect(run('openssl', args).status).toBe(0);
      mk(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', key]);
      mk([
        ...['req', '-x509', '-new', '-key', key, '-sha256', '-days', String(days)],
        ...['-subj', '/CN=test CA', '-addext', 'basicConstraints=critical,CA:TRUE'],
        ...['-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-out', path.join(ca, 'ca.pem')],
      ]);
      return ca;
    };

    it('issue: with a CA folder, both sides valid, no CA key; never into the repository', () => {
      const ca = makeCa('ca', 800);
      const out = path.join(tmp, 'issued');
      const issued = run(tls, ['issue', ca, 'gpu.example.internal', out]);
      expect(issued.status, issued.stderr).toBe(0);
      expect(fs.existsSync(path.join(out, 'gpu-host/ca-key.pem'))).toBe(false);
      expect(fs.existsSync(path.join(out, 'platform/ca-key.pem'))).toBe(false);
      const s1 = run(tls, ['check', path.join(out, 'gpu-host'), 'gpu.example.internal']);
      expect(s1.status, s1.stderr).toBe(0);
      const c1 = run(tls, ['check', path.join(out, 'platform')]);
      expect(c1.status, c1.stderr).toBe(0);
      const inRepo = run(tls, [
        'issue',
        ca,
        'gpu.example.internal',
        path.join(deployDir, 'gpu-link/x'),
      ]);
      expect(inRepo.status).toBe(1);
      expect(inRepo.stderr).toContain('outside the repository');
    });

    it('check fails 30 days before the end (here: a CA that lasts 20 days)', () => {
      const ca = makeCa('ca-short', 20);
      const out = path.join(tmp, 'issued-short');
      expect(run(tls, ['issue', ca, 'gpu.example.internal', out]).status).toBe(0);
      const soon = run(tls, ['check', path.join(out, 'platform')]);
      expect(soon.status).toBe(1);
      expect(soon.stderr).toContain('ends within 30 days');
    });
  },
);
