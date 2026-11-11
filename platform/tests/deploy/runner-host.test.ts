// D-08 O01 AC1, AC2 (design/ADR-M91): static checks of the runner on its own Docker Engine (no
// Docker needed).
// - The runner host's Compose file has the same runner, socket proxy and package proxy as
//   docker-compose.yml (allowed differences listed below), and no platform service, volume or
//   network.
// - Each relay is the pinned HAProxy image, hardened, with one fixed target on the link address.
// - The platform's overlay publishes the link ports on SDLC_RUNNER_LINK_ADDR only.
// - The runner host sends no traces and its files hold no secret.
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import { LINK_SERVICES } from '../../deploy/doctor/src/checks/runner.js';
import { deployDir, readDeployFile } from './compose';

interface Service {
  image?: string;
  profiles?: string[];
  restart?: string;
  user?: string;
  network_mode?: string;
  networks?: string[];
  read_only?: boolean;
  cap_drop?: string[];
  cap_add?: string[];
  privileged?: boolean;
  security_opt?: string[];
  volumes?: string[];
  tmpfs?: string[];
  ports?: string[];
  environment?: Record<string, string>;
  extra_hosts?: string[];
  depends_on?: Record<string, { condition: string }>;
  build?: unknown;
  [key: string]: unknown;
}
interface File {
  services: Record<string, Service>;
  volumes?: Record<string, unknown>;
  networks?: Record<string, { name?: string }>;
}

const load = (relative: string) => parse(readDeployFile(relative), { merge: true }) as File;
const platform = load('docker-compose.yml');
const host = load('runner-host/docker-compose.yml');
const overlay = load('docker-compose.runner-link.yml');
const svc = (file: File, name: string): Service => {
  const s = file.services[name];
  if (!s) throw new Error(`service ${name} missing`);
  return s;
};

const LINK = '${SDLC_RUNNER_LINK_ADDR:?set SDLC_RUNNER_LINK_ADDR in runner-host/.env}';
const OVERLAY_LINK = '${SDLC_RUNNER_LINK_ADDR:?set SDLC_RUNNER_LINK_ADDR in .env}';
const HAPROXY =
  'haproxy:3.2.26-alpine@sha256:dfba86f031bd4c9039f10f8cc5de75991d1b6766d5460f0335b980408503baad';
const COPIED = ['docker-socket-proxy', 'npm-proxy', 'sdlc-runner'] as const;
/** The keys a copied service may change on the runner host (ADR-M91 §2.7). */
const ALLOWED_DIFFERENCES = ['depends_on', 'networks', 'extra_hosts', 'build'];
/** The relays: their configuration file and the link port of their one target. */
const RELAYS = {
  litellm: { cfg: 'litellm.cfg', listen: 4000, target: 4000, profile: 'sandbox' },
  'knowledge-db': { cfg: 'knowledge-db.cfg', listen: 5432, target: 5433, profile: 'knowledge' },
  registry: { cfg: 'registry.cfg', listen: 5000, target: 5050, profile: 'vm' },
} as const;

/** A copied service without its allowed differences, with paths relative to platform/deploy. */
function comparable(s: Service, onHost: boolean): Service {
  const out: Service = { ...s };
  for (const key of ALLOWED_DIFFERENCES) delete out[key];
  if (onHost && out.volumes) {
    out.volumes = out.volumes.map((v) =>
      v
        .replace('${SDLC_DOCKER_SOCKET:-/var/run/docker.sock}:', '/var/run/docker.sock:')
        .replace(/^\.\.\/verdaccio\//, './verdaccio/'),
    );
  }
  return out;
}

describe('O01: the runner host Compose file', () => {
  it('holds the runner, the proxies, the relays and the CA job, and nothing else', () => {
    expect(Object.keys(host.services).sort()).toEqual([
      'docker-socket-proxy',
      'knowledge-db',
      'litellm',
      'npm-proxy',
      'openbao-ca-init',
      'registry',
      'runner-approle-init',
      'sdlc-runner',
    ]);
  });

  it.each(COPIED)('%s has the same definition as in docker-compose.yml', (name) => {
    expect(comparable(svc(host, name), true)).toEqual(comparable(svc(platform, name), false));
  });

  it('the proxy reads the runner Engine socket only, read-only (R061: the allowlist is unchanged)', () => {
    expect(svc(host, 'docker-socket-proxy').volumes).toEqual([
      '${SDLC_DOCKER_SOCKET:-/var/run/docker.sock}:/var/run/docker.sock:ro',
      'docker-proxy:/run/docker-proxy',
    ]);
  });

  it('the runner reaches the platform by its service names on the link address', () => {
    const runner = svc(host, 'sdlc-runner');
    expect(runner.extra_hosts).toEqual(
      ['postgres', 'openbao', 'temporal', 'seaweedfs'].map((n) => `${n}:${LINK}`),
    );
    expect(runner.networks).toEqual(['sdlc']);
    expect(Object.keys(runner.depends_on ?? {}).sort()).toEqual([
      'docker-socket-proxy',
      'litellm',
      'npm-proxy',
      'openbao-ca-init',
    ]);
    // The relays keep the container names of the platform's services (ADR-M91 §2.7).
    expect(runner.environment?.['SDLC_RUNNER_EGRESS_SERVICES']).toContain(
      'litellm=${COMPOSE_PROJECT_NAME:-sdlc}-litellm-1:4000',
    );
    expect(runner.environment?.['SDLC_RUNNER_TOOL_SERVICES']).toContain(
      'knowledge-db=${COMPOSE_PROJECT_NAME:-sdlc}-knowledge-db-1:5432',
    );
  });

  it('no platform volume and its own network, never the platform network', () => {
    expect(Object.keys(host.volumes ?? {}).sort()).toEqual([
      'docker-proxy',
      'npm-proxy-storage',
      'openbao-ca',
      'runner-approle',
      'runner-work',
    ]);
    expect(host.volumes?.['docker-proxy']).toEqual(platform.volumes?.['docker-proxy']);
    expect(Object.keys(host.networks ?? {})).toEqual(['sdlc']);
    expect(host.networks?.['sdlc']?.name).toBe('${COMPOSE_PROJECT_NAME:-sdlc}-runner-net');
    expect(host.networks?.['sdlc']?.name).not.toBe(platform.networks?.['sdlc']?.name);
  });

  it('every image is one of the runner, the proxies or the pinned relay image', () => {
    const allowed = new Set([...COPIED.map((n) => svc(platform, n).image), HAPROXY]);
    for (const [name, s] of Object.entries(host.services)) {
      expect(allowed.has(s.image), name).toBe(true);
    }
  });

  it.each(Object.entries(RELAYS))(
    'relay %s: hardened, one fixed target on the link address',
    (name, r) => {
      const s = svc(host, name);
      expect(s.image).toBe(HAPROXY);
      expect(s.profiles).toEqual([r.profile]);
      expect(s.read_only).toBe(true);
      expect(s.cap_drop).toEqual(['ALL']);
      expect(s.cap_add).toBeUndefined();
      expect(s.privileged).toBeUndefined();
      expect(s.security_opt).toEqual(['no-new-privileges:true']);
      expect(s.networks).toEqual(['sdlc']);
      expect(s.volumes).toEqual([`./haproxy/${r.cfg}:/usr/local/etc/haproxy/haproxy.cfg:ro`]);
      expect(s.environment).toEqual({ SDLC_RUNNER_LINK_ADDR: LINK });
      expect(s.ports ?? []).toEqual(
        name === 'registry' ? ['127.0.0.1:${SDLC_REGISTRY_HOST_PORT:-5050}:5000'] : [],
      );
      const cfg = readDeployFile(`runner-host/haproxy/${r.cfg}`);
      const lines = cfg.split('\n').filter((l) => !l.trim().startsWith('#'));
      expect(lines.filter((l) => /^\s*server\s/.test(l))).toEqual([
        `  server upstream "\${SDLC_RUNNER_LINK_ADDR}:${r.target}"`,
      ]);
      expect(lines.filter((l) => /^\s*bind\s/.test(l))).toEqual([
        '  bind 127.0.0.1:8405',
        `  bind :${r.listen}`,
      ]);
      // No log of requests, addresses or bodies; no runtime API.
      expect(lines.some((l) => /^\s*(log|stats|option\s+httplog|option\s+tcplog)\b/.test(l))).toBe(
        false,
      );
    },
  );

  it('the registry relay forwards GET and HEAD only (QUESTIONS #599)', () => {
    const cfg = readDeployFile('runner-host/haproxy/registry.cfg');
    expect(cfg).toMatch(/^ {2}mode http$/m);
    expect(cfg).toMatch(/^ {2}http-request deny deny_status 405 unless METH_GET or METH_HEAD$/m);
  });

  it('openbao-ca-init copies the public CA certificate only, on no network (QUESTIONS #598)', () => {
    const s = svc(host, 'openbao-ca-init');
    expect(s.restart).toBe('no');
    expect(s.network_mode).toBe('none');
    expect(s.cap_drop).toEqual(['ALL']);
    expect(s.volumes).toEqual([
      '${SDLC_OPENBAO_CA_FILE:-/etc/sdlc/openbao-ca.pem}:/src/ca.pem:ro',
      'openbao-ca:/ca',
    ]);
    expect(JSON.stringify(s)).toContain('PRIVATE KEY');
  });

  it('runner-approle-init mounts the runner credentials volume only, on no network (QUESTIONS #597)', () => {
    const s = svc(host, 'runner-approle-init');
    expect(s.image).toBe(HAPROXY);
    expect(s.profiles).toEqual(['credentials']);
    expect(s.network_mode).toBe('none');
    expect(s.read_only).toBe(true);
    expect(s.cap_drop).toEqual(['ALL']);
    expect(s.volumes).toEqual(['runner-approle:/run/sdlc/approle']);
    // The same volume and path as the runner's.
    expect(svc(host, 'sdlc-runner').volumes).toContain('runner-approle:/run/sdlc/approle');
  });

  it('runner-host.sh reads the socket group with the pinned relay image when it is not set', () => {
    const script = fs.readFileSync(path.join(deployDir, 'scripts/runner-host.sh'), 'utf8');
    expect(script).toContain(`RELAY_IMAGE="${HAPROXY}"`);
    expect(script).toContain('docker run --rm --network none --read-only --cap-drop ALL');
    expect(script).toContain(':/s:ro" --entrypoint stat "$RELAY_IMAGE" -c %g /s');
    expect(readDeployFile('runner-host/.env.example')).toMatch(/^SDLC_DOCKER_GID=$/m);
  });

  it('no telemetry and no secret: no OTEL setting, no password, token or key variable', () => {
    const text = readDeployFile('runner-host/docker-compose.yml');
    expect(text).not.toMatch(/OTEL|otel-collector/);
    expect(text).not.toMatch(/\$\{[A-Z_]*(PASSWORD|TOKEN|SECRET|_KEY)[A-Z_]*/);
    const example = readDeployFile('runner-host/.env.example');
    expect(example).not.toMatch(/^[A-Z_]*(PASSWORD|TOKEN|SECRET|_KEY)[A-Z_]*=/m);
    expect(example).toMatch(/^SDLC_RUNNER_LINK_ADDR=$/m);
  });

  it('the release overlay changes the runner image only', () => {
    const images = load('runner-host/docker-compose.images.yml');
    expect(Object.keys(images.services)).toEqual(['sdlc-runner']);
    const platformImages = load('docker-compose.images.yml');
    expect(images.services['sdlc-runner']?.image).toBe(
      platformImages.services['sdlc-runner']?.image?.replace(
        'run through scripts/up.sh',
        'run through scripts/runner-host.sh',
      ),
    );
  });
});

describe('O01: the link overlay of the platform (docker-compose.runner-link.yml)', () => {
  const expected: Record<string, string[]> = {
    postgres: ['5432:5432'],
    openbao: ['8200:8200'],
    temporal: ['7233:7233'],
    seaweedfs: ['8333:8333'],
    litellm: ['4000:4000'],
    'knowledge-db': ['5433:5432'],
    registry: ['5050:5000'],
  };

  it('publishes the link services on SDLC_RUNNER_LINK_ADDR only, and nothing else', () => {
    expect(Object.keys(overlay.services).sort()).toEqual([...LINK_SERVICES]);
    for (const [name, s] of Object.entries(overlay.services)) {
      expect(s.ports, name).toEqual(expected[name]!.map((p) => `${OVERLAY_LINK}:${p}`));
      const keys = Object.keys(s).filter((k) => k !== 'ports');
      expect(keys, name).toEqual(name === 'registry' ? ['profiles'] : []);
    }
    expect(svc(overlay, 'registry').profiles).toEqual(['sandbox', 'runner-link']);
  });

  it('the link ports are the ports the runner and the relays use', () => {
    const env = svc(host, 'sdlc-runner').environment ?? {};
    expect(env['SDLC_RUNNER_DB_HOST']).toBe('postgres');
    expect(env['SDLC_RUNNER_TEMPORAL_ADDRESS']).toBe('temporal:7233');
    expect(env['SDLC_RUNNER_EVIDENCE_URL']).toBe('http://seaweedfs:8333');
    expect(env['SDLC_OPENBAO_ADDR']).toBe('https://openbao:8200');
    // Each relay's target is the link port the overlay publishes for its service.
    for (const [name, r] of Object.entries(RELAYS)) {
      expect(expected[name]?.[0]?.split(':')[0], name).toBe(String(r.target));
    }
  });

  it('up.sh adds the overlay only with SDLC_RUNNER_LINK_ADDR, and then refuses the profile sandbox', () => {
    const up = readDeployFile('scripts/up.sh');
    expect(up).toContain(
      'link_addr="$(sed -n \'s/^SDLC_RUNNER_LINK_ADDR=//p\' "$env_file" | tail -n 1)"',
    );
    expect(up).toMatch(
      /if \[ -n "\$link_addr" \]; then\n\s+set -- -f "\$deploy_dir\/docker-compose\.runner-link\.yml" "\$@"/,
    );
    expect(up).toMatch(/\*" sandbox "\*\)\n\s+echo "up: SDLC_RUNNER_LINK_ADDR is set/);
  });

  it('the runner host refuses an Engine that holds the platform data', () => {
    const script = fs.readFileSync(path.join(deployDir, 'scripts/runner-host.sh'), 'utf8');
    expect(script).toContain('--filter label=com.docker.compose.volume=postgres-data');
  });
});
