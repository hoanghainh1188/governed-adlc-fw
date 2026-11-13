// D-08 C04, ADR-M25: static checks of the Compose profile "sandbox" (no Docker needed).
// - Only the socket proxy mounts the Docker socket, read-only, on no network (AC4: the runner
//   never gets the raw socket).
// - The proxy allowlist and the runner's ALLOWED_ENDPOINTS accept exactly the same requests.
// - The runner, Verdaccio and the registry run hardened; the registry listens on 127.0.0.1 only.
// - The sandbox image honours the image contract (ADR-M25 §2.3).
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import { isAllowedEndpoint } from '../../apps/runner/src/index.js';
import { deployDir, loadCompose, readDeployFile, root, servicesInProfile } from './compose';

interface Service {
  image?: string;
  profiles?: string[];
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
  command?: string[];
  environment?: Record<string, string>;
  group_add?: string[];
  depends_on?: Record<string, { condition: string }>;
}

const compose = loadCompose() as unknown as {
  services: Record<string, Service>;
  volumes: Record<string, { driver_opts?: Record<string, string> } | null>;
};
const services = compose.services;
const svc = (name: string): Service => {
  const s = services[name];
  if (!s) throw new Error(`service ${name} missing`);
  return s;
};
const read = (relative: string) => fs.readFileSync(path.join(root, relative), 'utf8');

const AGENT_SERVER =
  'ghcr.io/openhands/agent-server:1.48.0-python-slim@sha256:8fcfab2dedb4b41b6aef219b9fa9b1f2588033fad3d998ae6aa11fe8c4fcf8b7';

describe('profile sandbox: services', () => {
  it('holds the runner, the socket proxy, the package proxy and the registry', () => {
    expect(servicesInProfile(compose, 'sandbox')).toEqual([
      'docker-socket-proxy',
      'npm-proxy',
      'registry',
      'sdlc-runner',
    ]);
  });

  it('every service is hardened: read-only root, no capabilities, no privilege gain', () => {
    for (const name of servicesInProfile(compose, 'sandbox')) {
      const s = svc(name);
      expect(s.read_only, name).toBe(true);
      expect(s.cap_drop, name).toEqual(['ALL']);
      expect(s.cap_add, name).toBeUndefined();
      expect(s.privileged, name).toBeUndefined();
      expect(s.security_opt, name).toEqual(['no-new-privileges:true']);
    }
  });
});

describe('Docker access (ADR-M25 §2.5)', () => {
  it('only the socket proxy mounts the Docker socket, read-only (AC4)', () => {
    for (const [name, s] of Object.entries(services)) {
      const mounts = (s.volumes ?? []).filter((v) => v.includes('docker.sock'));
      if (name === 'docker-socket-proxy') {
        expect(mounts).toEqual(['/var/run/docker.sock:/var/run/docker.sock:ro']);
      } else {
        expect(mounts, name).toEqual([]);
      }
    }
  });

  it('the proxy joins no network, publishes nothing and runs without root', () => {
    const proxy = svc('docker-socket-proxy');
    expect(proxy.network_mode).toBe('none');
    expect(proxy.ports).toBeUndefined();
    expect(proxy.user).toBe('65534:${SDLC_DOCKER_GID:-0}');
    expect(proxy.command).toEqual(
      expect.arrayContaining([
        '-proxysocketendpoint=/run/docker-proxy/docker.sock',
        '-proxysocketendpointfilemode=0660',
        '-allowbindmountfrom=/nonexistent-sdlc-no-bind-mounts',
      ]),
    );
    // The filtered socket lives in memory, in a volume only the proxy and the runner mount.
    expect(compose.volumes['docker-proxy']?.driver_opts?.type).toBe('tmpfs');
    const users = Object.entries(services)
      .filter(([, s]) => (s.volumes ?? []).some((v) => v.startsWith('docker-proxy:')))
      .map(([name]) => name)
      .sort();
    expect(users).toEqual(['docker-socket-proxy', 'sdlc-runner']);
  });

  // The proxy allowlist must equal the runner's own allowlist (docker/client.ts).
  const allow = new Map<string, RegExp>(
    (svc('docker-socket-proxy').command ?? [])
      .map((arg) => /^-allow(GET|POST|PUT|DELETE|HEAD|PATCH)=(.+)$/.exec(arg))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => [m[1]!, new RegExp(`^${m[2]!}$`)]),
  );
  const proxyAllows = (method: string, apiPath: string) =>
    allow.get(method)?.test(`/v1.44${apiPath}`) ?? false;

  const RUN = '11111111-1111-4111-8111-111111111111';
  const IMAGE = `localhost:5050/sdlc/sandbox-node24@sha256:${'a'.repeat(64)}`;
  const CORPUS: readonly [string, string][] = [
    // Allowed by the runner.
    ['GET', '/_ping'],
    // Task H06: the runner reads the Engine's runtimes at start.
    ['GET', '/info'],
    ['GET', `/images/${IMAGE}/json`],
    ['GET', '/images/busybox:1.37.0/json'],
    ['POST', '/images/create'],
    ['GET', '/containers/json'],
    ['POST', '/containers/create'],
    ['GET', `/containers/sdlc-sandbox-${RUN}/json`],
    ['POST', `/containers/sdlc-sandbox-${RUN}/start`],
    ['POST', `/containers/sdlc-sandbox-${RUN}/wait`],
    ['GET', `/containers/sdlc-sandbox-${RUN}/logs`],
    ['PUT', `/containers/sdlc-sandbox-${RUN}/archive`],
    ['GET', `/containers/sdlc-sandbox-${RUN}/archive`],
    ['DELETE', `/containers/sdlc-sandbox-${RUN}`],
    ['GET', '/networks'],
    ['POST', '/networks/create'],
    ['GET', `/networks/sdlc-run-${RUN}`],
    ['POST', `/networks/sdlc-run-${RUN}/connect`],
    ['POST', `/networks/sdlc-run-${RUN}/disconnect`],
    ['DELETE', `/networks/sdlc-run-${RUN}`],
    ['GET', '/volumes'],
    ['POST', '/volumes/create'],
    ['DELETE', `/volumes/sdlc-ws-${RUN}`],
    // Never allowed.
    ['POST', `/containers/sdlc-sandbox-${RUN}/exec`],
    ['POST', '/exec/abc/start'],
    ['POST', `/containers/sdlc-sandbox-${RUN}/attach`],
    ['POST', `/containers/sdlc-sandbox-${RUN}/update`],
    ['POST', `/containers/sdlc-sandbox-${RUN}/kill`],
    ['POST', `/containers/sdlc-sandbox-${RUN}/pause`],
    // C06 2b: only a run sandbox's files are ever read.
    ['GET', '/containers/postgres/archive'],
    ['GET', '/containers/sdlc-sdlc-runner-1/archive'],
    ['GET', `/containers/sdlc-sandbox-${RUN}x/archive`],
    ['POST', '/build'],
    ['POST', '/commit'],
    ['GET', '/info/x'],
    ['GET', '/version'],
    ['GET', '/system/df'],
    ['GET', '/events'],
    ['POST', `/images/${IMAGE}/push`],
    ['POST', '/images/busybox/tag'],
    ['DELETE', '/images/busybox'],
    ['POST', '/images/load'],
    ['POST', '/containers/prune'],
    ['POST', '/networks/prune'],
    ['POST', '/volumes/prune'],
    ['GET', '/plugins'],
    ['POST', '/swarm/init'],
    ['GET', '/secrets'],
    ['POST', '/session'],
    ['GET', '/containers/../info'],
    ['GET', '/networks/../info'],
    ['DELETE', '/containers/a/b'],
    ['HEAD', '/_ping'],
    ['PATCH', '/containers/json'],
  ];

  it.each(CORPUS)('%s %s: proxy and runner agree', (method, apiPath) => {
    expect(proxyAllows(method, apiPath)).toBe(isAllowedEndpoint(method, apiPath));
  });

  it('allows only the methods the runner uses', () => {
    expect([...allow.keys()].sort()).toEqual(['DELETE', 'GET', 'POST', 'PUT']);
  });
});

describe('sdlc-runner service', () => {
  const runner = svc('sdlc-runner');
  const env = runner.environment ?? {};

  it('reaches Docker through the proxy socket only, with the socket group', () => {
    expect(env.SDLC_RUNNER_DOCKER_SOCKET).toBe('/run/docker-proxy/docker.sock');
    expect(runner.group_add).toEqual(['${SDLC_DOCKER_GID:-0}']);
    expect(runner.volumes).toEqual([
      'docker-proxy:/run/docker-proxy',
      'runner-approle:/run/sdlc/approle',
      'runner-work:/var/lib/sdlc-runner/work',
      // A10 (ADR-M63): the CA that verifies OpenBao's certificate, read-only.
      'openbao-ca:/run/sdlc/openbao-ca:ro',
    ]);
    expect(runner.depends_on?.['docker-socket-proxy']).toEqual({ condition: 'service_healthy' });
  });

  it('has no secret in its environment; OpenBao credentials are files', () => {
    for (const [key, value] of Object.entries(env)) {
      expect(key).not.toMatch(/PASSWORD|TOKEN|SECRET(?!_ID_FILE)|KEY(?!_)/);
      expect(String(value)).not.toMatch(/\$\{[A-Z_]*(PASSWORD|SECRET|KEY)/);
    }
    expect(env.SDLC_OPENBAO_ROLE_ID_FILE).toBe('/run/sdlc/approle/role_id');
    expect(env.SDLC_OPENBAO_SECRET_ID_FILE).toBe('/run/sdlc/approle/secret_id');
  });

  it('sandbox egress is LiteLLM and the package proxy, from configuration (D-03 §9)', () => {
    expect(env.SDLC_RUNNER_EGRESS_SERVICES).toBe(
      'litellm=${COMPOSE_PROJECT_NAME:-sdlc}-litellm-1:4000,npm-proxy=${COMPOSE_PROJECT_NAME:-sdlc}-npm-proxy-1:4873',
    );
    expect(env.SDLC_RUNNER_NPM_REGISTRY).toBe('http://npm-proxy:4873/');
    // X04 PR 3b (ADR-M69 §2.4): never on the run network; a tool's own service network only.
    expect(env.SDLC_RUNNER_TOOL_SERVICES).toBe(
      'knowledge-db=${COMPOSE_PROJECT_NAME:-sdlc}-knowledge-db-1:5432,litellm=${COMPOSE_PROJECT_NAME:-sdlc}-litellm-1:4000',
    );
    expect(env.SDLC_RUNNER_MAX_SANDBOXES).toBe('${SDLC_RUNNER_MAX_SANDBOXES:-1}');
    // H06 (ADR-M25 §2.12): empty by default, the Engine's own runtime.
    expect(env.SDLC_RUNNER_SANDBOX_RUNTIME).toBe('${SDLC_RUNNER_SANDBOX_RUNTIME:-}');
    expect(env.SDLC_RUNNER_MAX_EVAL_SANDBOXES).toBe('${SDLC_RUNNER_MAX_EVAL_SANDBOXES:-1}');
    expect(env.SDLC_RUNNER_SWEEP_INTERVAL_SECONDS).toBe(
      '${SDLC_RUNNER_SWEEP_INTERVAL_SECONDS:-300}',
    );
  });

  it('keeps the heartbeat on a tmpfs; publishes no port', () => {
    expect(runner.tmpfs).toEqual(['/tmp']);
    expect(runner.ports).toBeUndefined();
  });

  it('bootstrap.sh delivers the runner credentials; the image runs as node with git', () => {
    const bootstrap = fs.readFileSync(path.join(deployDir, 'openbao/bootstrap.sh'), 'utf8');
    expect(bootstrap).toMatch(/^ {2}runner-credentials\) cmd_runner_credentials ;;$/m);
    const credentials = /^cmd_runner_credentials\(\) \{[\s\S]*?^\}$/m.exec(bootstrap)?.[0] ?? '';
    expect(credentials).toMatch(/^ {2}platform_credentials runner sdlc-runner sandbox$/m);
    // O01 (QUESTIONS #597): to the runner host's own Engine with SDLC_RUNNER_DOCKER_HOST, through
    // the runner-host Compose file; the secret ID still goes on stdin (deliver_approle).
    expect(credentials).toContain("'' | ssh://?* | unix:///?*) ;;");
    expect(credentials).toMatch(
      /^ {4}platform_credentials runner runner-approle-init credentials 1000:1000$/m,
    );
    expect(bootstrap).toMatch(
      /DOCKER_HOST="\$delivery_host" docker compose \\\n\s+-f "\$deploy_dir\/runner-host\/docker-compose\.yml"/,
    );
    expect(bootstrap).toMatch(/issue_secret_id "\$1" \|\n\s+service_compose --profile core/);
    // C06 2b: the write-only evidence identity; its keys reach `weed shell` on stdin only and its
    // output (which prints secrets) is discarded.
    expect(bootstrap).toMatch(
      /^ {2}runner-evidence-credentials\) cmd_runner_evidence_credentials ;;$/m,
    );
    const evidence =
      /^cmd_runner_evidence_credentials\(\) \{[\s\S]*?^\}$/m.exec(bootstrap)?.[0] ?? '';
    expect(evidence).toContain(
      '-actions Write:evidence/proposals/*,Write:evidence/diffs/*,Read:evidence/diffs/* -apply',
    );
    expect(evidence).toContain('echo "s3.configure -user runner-evidence -delete -apply" |');
    expect(evidence).toMatch(/compose exec -T seaweedfs \$weed >\/dev\/null 2>&1/);
    expect(evidence).toContain('bao kv put -mount=kv runner/evidence - >/dev/null');
    expect(evidence).not.toContain('s3.config.show');
    expect(env.SDLC_RUNNER_EVIDENCE_URL).toBe('http://seaweedfs:8333');
    expect(env.SDLC_RUNNER_EVIDENCE_BUCKET).toBe('evidence');
    expect(runner.depends_on?.['seaweedfs-init']).toEqual({
      condition: 'service_completed_successfully',
    });
    expect(svc('seaweedfs-init').environment?.SEAWEEDFS_VERSIONED_BUCKETS?.split(' ')).toContain(
      'evidence',
    );
    const dockerfile = read('platform/apps/runner/Dockerfile');
    expect(dockerfile).toMatch(/^USER node$/m);
    expect(dockerfile).toMatch(/apt-get install -y --no-install-recommends git ca-certificates/);
    expect(dockerfile).not.toMatch(/ARG .*(PASSWORD|TOKEN|SECRET)|ENV .*(PASSWORD|TOKEN|SECRET)/);
  });

  it('C12: every key length check stops the script on its own (`|| exit 1`), never `[ … ] && [ … ]`', () => {
    const bootstrap = fs.readFileSync(path.join(deployDir, 'openbao/bootstrap.sh'), 'utf8');
    // Under `set -e` a failed test before the last command of an `&&` list does not stop the
    // script, so a key of the wrong length would be stored.
    expect(bootstrap).not.toMatch(/\[ "\$\{#\w+\}" -eq \d+ \] &&/);
    const checks = bootstrap.match(/^\s*\[ "\$\{#\w+\}" -eq \d+ \].*$/gm) ?? [];
    expect(checks.length).toBeGreaterThanOrEqual(2);
    for (const check of checks) expect(check.trim()).toMatch(/\] \|\| exit 1$/);
    const evidence =
      /^cmd_runner_evidence_credentials\(\) \{[\s\S]*?^\}$/m.exec(bootstrap)?.[0] ?? '';
    expect(evidence).toContain('[ "${#access}" -eq 30 ] || exit 1');
    expect(evidence).toContain('[ "${#secret}" -eq 60 ] || exit 1');
  });
});

describe('npm-proxy (Verdaccio, ADR-M25 §2.10)', () => {
  const config = parse(readDeployFile('verdaccio/config.yaml')) as {
    web: { enable: boolean };
    uplinks: Record<string, { url: string }>;
    packages: Record<string, { access: string; publish: string; unpublish: string }>;
  };

  it('has one uplink, registry.npmjs.org; nobody publishes; no web UI', () => {
    expect(Object.values(config.uplinks).map((u) => u.url)).toEqual([
      'https://registry.npmjs.org/',
    ]);
    for (const rule of Object.values(config.packages)) {
      expect(rule.publish).toBe('$nobody');
      expect(rule.unpublish).toBe('$nobody');
    }
    expect(config.web.enable).toBe(false);
  });

  it('is on the platform network only, publishes no port, config read-only', () => {
    const proxy = svc('npm-proxy');
    expect(proxy.networks).toEqual(['sdlc']);
    expect(proxy.ports).toBeUndefined();
    expect(proxy.volumes).toContain('./verdaccio/config.yaml:/verdaccio/conf/config.yaml:ro');
  });
});

describe('registry (QUESTIONS #54)', () => {
  it('listens on 127.0.0.1 only', () => {
    expect(svc('registry').ports).toEqual(['127.0.0.1:${SDLC_REGISTRY_HOST_PORT:-5050}:5000']);
  });
});

describe('sandbox image node24 (ADR-M25 §2.3, §2.9)', () => {
  const dockerfile = read('platform/sandbox-images/node24/Dockerfile');
  const code = dockerfile
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');

  it('builds on the pinned Agent Server of ADR-M10', () => {
    expect(dockerfile).toMatch(
      new RegExp(`^FROM ${AGENT_SERVER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'),
    );
  });

  it('honours the image contract: /workspace owned by 10001, a health check, user 10001', () => {
    expect(dockerfile).toContain('chown 10001:10001 /workspace');
    expect(dockerfile).toMatch(/^HEALTHCHECK /m);
    expect(dockerfile).toMatch(/^USER 10001:10001$/m);
    expect(dockerfile).toMatch(/node --version \| grep -Eq '\^v24\\\.'/);
  });

  it('keeps the Agent Server state out of the workspace; corepack for pnpm; no secret', () => {
    expect(dockerfile).toContain('corepack enable pnpm');
    expect(dockerfile).toMatch(/OH_CONVERSATIONS_PATH=\/home\/openhands\//);
    expect(dockerfile).toMatch(/OH_BASH_EVENTS_DIR=\/home\/openhands\//);
    expect(code).not.toMatch(/NPM_CONFIG_REGISTRY|COREPACK_NPM_REGISTRY/); // set by the runner
    expect(code).not.toMatch(/ARG .*(PASSWORD|TOKEN|SECRET|KEY)|_KEY=/);
  });
});
