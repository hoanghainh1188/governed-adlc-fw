// B03: the sdlc-api service in docker-compose.yml (design/ADR-M26 section 2.6). No secret in its
// environment; the database password comes from OpenBao with the AppRole "api"; hardened container.
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { deployDir, loadCompose, parseEnvFile, readDeployFile, root } from './compose';

interface ApiService {
  image: string;
  profiles: string[];
  build: { context: string; dockerfile: string };
  environment: Record<string, string>;
  ports: string[];
  volumes: string[];
  read_only: boolean;
  cap_drop: string[];
  cap_add?: string[];
  privileged?: boolean;
  user?: string;
  security_opt: string[];
  healthcheck: { test: string[] };
  depends_on: Record<string, { condition: string }>;
}

const api = loadCompose().services['sdlc-api'] as unknown as ApiService;
const envExample = parseEnvFile(readDeployFile('.env.example'));

describe('sdlc-api service', () => {
  it('is in the platform profile only, built from the api Dockerfile, tagged with the package version', () => {
    expect(api.profiles).toEqual(['platform']);
    expect(api.build).toEqual({ context: '../..', dockerfile: 'platform/apps/api/Dockerfile' });
    const pkg = JSON.parse(
      fs.readFileSync(path.join(root, 'platform/apps/api/package.json'), 'utf8'),
    ) as { version: string };
    expect(api.image).toBe(`sdlc-api:${pkg.version}`);
  });

  it('has no secret in its environment; the AppRole credentials are files on its own volume', () => {
    for (const name of Object.keys(api.environment)) {
      expect(name, name).not.toMatch(/PASSWORD|SECRET_ID$|TOKEN|DEV_DB_URL|DEV_MODE/);
    }
    expect(api.environment).toMatchObject({
      SDLC_OPENBAO_ROLE_ID_FILE: '/run/sdlc/approle/role_id',
      SDLC_OPENBAO_SECRET_ID_FILE: '/run/sdlc/approle/secret_id',
    });
    expect(api.volumes).toEqual([
      'api-approle:/run/sdlc/approle',
      // A10 (ADR-M63): the CA that verifies OpenBao's certificate, read-only.
      'openbao-ca:/run/sdlc/openbao-ca:ro',
    ]);
  });

  it('U01: serves the dashboard built into the image, on the same 127.0.0.1 port (ADR-M54)', () => {
    expect(api.environment.SDLC_API_DASHBOARD_DIR).toBe('/app/dashboard');
    const dockerfile = fs.readFileSync(path.join(root, 'platform/apps/api/Dockerfile'), 'utf8');
    expect(dockerfile).toContain('pnpm --filter @sdlc/dashboard build');
    expect(dockerfile).toContain(
      'COPY --from=build --chown=root:root /repo/platform/apps/dashboard/dist/web /app/dashboard',
    );
    expect(dockerfile).toContain('ENV SDLC_API_DASHBOARD_DIR=/app/dashboard');
  });

  it('publishes on 127.0.0.1 only, on its own host port', () => {
    expect(api.ports).toEqual(['${SDLC_BIND_ADDR:-127.0.0.1}:${SDLC_API_HOST_PORT:-8090}:8080']);
    expect(envExample.get('SDLC_API_HOST_PORT')).toBe('8090');
    expect(envExample.get('SDLC_API_HOST_PORT')).not.toBe(envExample.get('TEMPORAL_UI_HOST_PORT'));
  });

  it('runs hardened: read-only root file system, no capabilities, no privilege gain', () => {
    expect(api.read_only).toBe(true);
    expect(api.cap_drop).toEqual(['ALL']);
    expect(api.security_opt).toEqual(['no-new-privileges:true']);
    expect(api.healthcheck.test).toEqual(['CMD', 'node', '/app/dist/healthcheck.js']);
  });

  it('the long-running service never gets a capability back (review of PR #90)', () => {
    expect(api.cap_add).toBeUndefined();
    expect(api.privileged).toBeUndefined();
    expect(api.user).toBeUndefined(); // the image's USER node applies
    const text = readDeployFile('docker-compose.yml');
    const start = text.indexOf('\n  sdlc-api:\n');
    const rest = text.slice(start + 1);
    const next = rest.slice(1).search(/\n {2}[a-z][a-z0-9-]*:\n/);
    const block = next === -1 ? rest : rest.slice(0, next + 1);
    expect(block).toContain('cap_drop: [ALL]');
    expect(block).not.toMatch(/cap_add|privileged|pid:|network_mode|docker\.sock/);
    for (const port of api.ports) expect(port).toMatch(/^\$\{SDLC_BIND_ADDR:-127\.0\.0\.1\}:/);
  });

  it('capabilities are added back only to the one-shot credentials step, as root, removed after', () => {
    const bootstrap = fs.readFileSync(path.join(deployDir, 'openbao/bootstrap.sh'), 'utf8');
    const lines = bootstrap.split('\n');
    const withCaps = lines.filter((line) => line.includes('--cap-add'));
    expect(withCaps).toHaveLength(1);
    const at = lines.indexOf(withCaps[0]!);
    const command = lines.slice(at - 1, at + 1).join(' ');
    expect(command).toMatch(/compose .*run --rm -T --no-deps --user root/);
    // One helper delivers every platform AppRole: api, worker, runner (B06, ADR-M27), the
    // worker's cost-controller (C06, ADR-M33 §2.5) and the backup job (A10, ADR-M63 §5).
    expect(withCaps[0]).toMatch(
      /^\s+--cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER --entrypoint sh "\$2" -c '$/,
    );
    const inFunction = bootstrap.slice(bootstrap.indexOf('deliver_approle() {'));
    expect(inFunction.indexOf('--cap-add')).toBeLessThan(inFunction.indexOf('\n}'));
  });

  it('bootstrap.sh delivers the api credentials; the Dockerfile runs as node', () => {
    const bootstrap = fs.readFileSync(path.join(deployDir, 'openbao/bootstrap.sh'), 'utf8');
    expect(bootstrap).toMatch(/^ {2}api-credentials\) cmd_api_credentials ;;$/m);
    expect(bootstrap).toMatch(
      /^cmd_api_credentials\(\) \{ platform_credentials api sdlc-api; \}$/m,
    );
    expect(bootstrap).toContain('bao kv put -mount=kv "$1/database" password=-');
    const dockerfile = fs.readFileSync(path.join(root, 'platform/apps/api/Dockerfile'), 'utf8');
    expect(dockerfile).toMatch(/^USER node$/m);
    expect(dockerfile).not.toMatch(/ARG .*(PASSWORD|TOKEN|SECRET)|ENV .*(PASSWORD|TOKEN|SECRET)/);
  });

  it('E02: reads Evidence Packs with its own SeaweedFS identity from OpenBao (api-evidence-credentials)', () => {
    expect(api.environment.SDLC_API_EVIDENCE_URL).toBe('http://seaweedfs:8333');
    expect(api.environment.SDLC_API_EVIDENCE_BUCKET).toBe('evidence');
    expect(api.depends_on['seaweedfs-init']).toEqual({
      condition: 'service_completed_successfully',
    });
    const bootstrap = fs.readFileSync(path.join(deployDir, 'openbao/bootstrap.sh'), 'utf8');
    expect(bootstrap).toMatch(/^ {2}api-evidence-credentials\) cmd_api_evidence_credentials ;;$/m);
    expect(bootstrap).toMatch(
      /^cmd_api_evidence_credentials\(\) \{ pack_evidence_credentials api sdlcapiev sdlc-api; \}$/m,
    );
    // E03: the api and the worker share the helper (one identity each); E05 made it generic.
    const fn = /^pack_evidence_credentials\(\) \{[\s\S]*?^\}$/m.exec(bootstrap)?.[0] ?? '';
    // Read proposals and diffs (the hash re-check), read and write packs; nothing else.
    expect(fn).toContain(
      "'Read:evidence/proposals/*,Read:evidence/diffs/*,Read:evidence/packs/*,Write:evidence/packs/*'",
    );
    expect(fn).toMatch(/s3_credentials "\$1" evidence "\$2"/);
    const helper = /^s3_credentials\(\) \{[\s\S]*?^\}$/m.exec(bootstrap)?.[0] ?? '';
    expect(helper).toContain('echo "s3.configure -user $identity -delete -apply" |');
    expect(helper).toContain('identity="$role-$name"');
    expect(helper).toContain('-actions %s -apply');
    expect(helper).toMatch(/compose exec -T seaweedfs \$weed >\/dev\/null 2>&1/);
    expect(helper).toContain('bao kv put -mount=kv "$1/$2" - >/dev/null');
    expect(helper).not.toContain('s3.config.show');
    // The AppRole "api" reads kv/data/api/* already: the credential needs no policy change.
    const policy = readDeployFile('openbao/bootstrap/policies/api.hcl');
    expect(policy).toContain('path "kv/data/api/*"');
  });

  it('U05: the GitHub sign-in is off by default; its client secret is at kv/api/github-oauth, read by the api only', () => {
    expect(api.environment.SDLC_API_WEB_SIGNIN).toBe('${SDLC_API_WEB_SIGNIN:-off}');
    // U06: actions in the dashboard are off unless the operator turns them on.
    expect(api.environment.SDLC_API_DASHBOARD_ACTIONS).toBe('${SDLC_API_DASHBOARD_ACTIONS:-off}');
    expect(envExample.get('SDLC_API_DASHBOARD_ACTIONS')).toBe('off');
    expect(api.environment.SDLC_API_PUBLIC_ORIGIN).toBe('${SDLC_API_PUBLIC_ORIGIN:-}');
    expect(envExample.get('SDLC_API_WEB_SIGNIN')).toBe('off');
    const bootstrap = readDeployFile('openbao/bootstrap.sh');
    const fn = /^cmd_api_github_oauth_credentials\(\) \{[\s\S]*?^\}$/m.exec(bootstrap)?.[0] ?? '';
    expect(fn).toContain('bao kv put -mount=kv api/github-oauth - >/dev/null');
    // The secret goes on the container's stdin, never as an argument; nothing is printed.
    expect(fn).not.toMatch(/client_secret=\$/);
    expect(fn).toContain("read_tty_secret 'Admin or root token (hidden)'");
    expect(policyPaths('api')).toContain('kv/data/api/*');
    for (const role of ['worker', 'runner', 'cost-controller', 'litellm', 'backup']) {
      for (const path of policyPaths(role)) {
        expect(path.startsWith('kv/data/api'), `${role}: ${path}`).toBe(false);
        expect(path, role).not.toBe('kv/data/*');
      }
    }
  });
});

function policyPaths(role: string): string[] {
  const policy = readDeployFile(`openbao/bootstrap/policies/${role}.hcl`);
  return [...policy.matchAll(/^path "([^"]+)"/gm)].map((m) => m[1]!);
}
