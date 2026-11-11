// D-08 task A02: static checks of the Docker Compose infrastructure (no Docker needed).
// The live checks are in platform/tests/integration/deploy/compose-up.test.ts.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  deployDir,
  isSecretName,
  jobNames,
  loadCompose,
  parseEnvFile,
  readDeployFile,
  root,
  servicesInProfile,
} from './compose';

const compose = loadCompose();
const composeText = readDeployFile('docker-compose.yml');
// The compose file without comment lines: the header comments name rules and banned tools.
const composeCode = composeText
  .split('\n')
  .filter((line) => !line.trim().startsWith('#'))
  .join('\n');
const envExample = parseEnvFile(readDeployFile('.env.example'));
const services = compose.services;
const service = (name: string) => {
  const s = services[name];
  if (!s) throw new Error(`service ${name} missing`);
  return s;
};
const env = (name: string) => service(name).environment ?? {};

const CORE = [
  'litellm',
  'openbao',
  'openbao-tls-init',
  'postgres',
  'seaweedfs',
  'seaweedfs-init',
  'temporal',
  'temporal-namespace',
  'temporal-schema',
  'temporal-ui',
  'valkey',
];
const OBSERVABILITY_ONLY = ['clickhouse', 'langfuse-web', 'langfuse-worker', 'otel-collector'];
const JOBS = [
  'access-tls-init',
  'backup-agent',
  'openbao-tls-init',
  'seaweedfs-init',
  'temporal-namespace',
  'temporal-schema',
  'vllm-link-tls-init',
  'vllm-pull',
];

function createdDatabases(): string[] {
  const script = readDeployFile('postgres/init/01-create-databases.sh');
  return [...script.matchAll(/^create_db \S+ "\$\w+" (.+)$/gm)].flatMap((m) => m[1]!.split(/\s+/));
}

describe('AC1: core profile', () => {
  it('contains exactly postgres, temporal (+ ui and jobs), litellm, valkey, seaweedfs, openbao', () => {
    expect(servicesInProfile(compose, 'core')).toEqual(CORE);
  });

  it('creates separate databases for platform, temporal and litellm', () => {
    expect(createdDatabases()).toEqual(
      expect.arrayContaining(['platform', 'temporal', 'temporal_visibility', 'litellm']),
    );
  });

  it('runs Temporal on PostgreSQL, without Elasticsearch', () => {
    expect(env('temporal')).toMatchObject({ DB: 'postgres12', POSTGRES_SEEDS: 'postgres' });
    expect(env('temporal').ENABLE_ES).toBeUndefined();
    expect(composeCode).not.toMatch(/elasticsearch|opensearch/i);
  });

  it('gives LiteLLM a database (budgets block nothing without one, D-07 section 3) and Valkey', () => {
    expect(env('litellm').DATABASE_URL).toMatch(/@postgres:5432\/litellm$/);
    expect(env('litellm').REDIS_HOST).toBe('valkey');
  });

  it('never starts OpenBao in dev mode', () => {
    expect(service('openbao').command).toEqual(['server']);
    expect(composeCode).not.toMatch(/-dev\b|BAO_DEV_ROOT_TOKEN_ID/);
    expect(readDeployFile('openbao/openbao.hcl')).toMatch(/storage "raft"/);
  });

  it('creates the evidence bucket in SeaweedFS', () => {
    expect(env('seaweedfs-init').SEAWEEDFS_BUCKETS?.split(' ')).toContain('evidence');
  });
});

describe('AC2: observability profile', () => {
  it('adds Langfuse web and worker, ClickHouse and the collector; core services stay available', () => {
    const observability = servicesInProfile(compose, 'observability');
    expect(observability.filter((s) => !CORE.includes(s))).toEqual(OBSERVABILITY_ONLY);
    for (const name of OBSERVABILITY_ONLY)
      expect(service(name).profiles).toEqual(['observability']);
  });

  it('creates a langfuse database', () => {
    expect(createdDatabases()).toContain('langfuse');
  });

  it('shares SeaweedFS and Valkey with the core profile', () => {
    for (const name of ['langfuse-web', 'langfuse-worker']) {
      const e = env(name);
      expect(e.DATABASE_URL).toMatch(/@postgres:5432\/langfuse$/);
      expect(e.REDIS_HOST).toBe('valkey');
      expect(e.LANGFUSE_S3_EVENT_UPLOAD_ENDPOINT).toBe('http://seaweedfs:8333');
      expect(e.LANGFUSE_S3_MEDIA_UPLOAD_ENDPOINT).toBe('http://seaweedfs:8333');
      expect(e.CLICKHOUSE_URL).toBe('http://clickhouse:8123');
      expect(e.TELEMETRY_ENABLED).toBe('false');
    }
    expect(env('seaweedfs-init').SEAWEEDFS_BUCKETS?.split(' ')).toContain('langfuse');
  });

  it('disables open sign-up and creates the admin by headless initialisation', () => {
    const e = env('langfuse-web');
    expect(e.AUTH_DISABLE_SIGNUP).toBe('true');
    for (const key of [
      'LANGFUSE_INIT_ORG_ID',
      'LANGFUSE_INIT_PROJECT_ID',
      'LANGFUSE_INIT_PROJECT_PUBLIC_KEY',
      'LANGFUSE_INIT_PROJECT_SECRET_KEY',
      'LANGFUSE_INIT_USER_EMAIL',
      'LANGFUSE_INIT_USER_PASSWORD',
    ]) {
      expect(e[key], key).toBeDefined();
    }
    expect(e.LANGFUSE_INIT_USER_PASSWORD).toMatch(/^\$\{LANGFUSE_INIT_USER_PASSWORD:\?/);
  });
});

describe('AC3: healthchecks and pinned images', () => {
  it('gives every long-running service a healthcheck', () => {
    for (const [name, s] of Object.entries(services)) {
      if (JOBS.includes(name)) continue;
      expect(s.healthcheck?.test, `${name} healthcheck`).toBeDefined();
      expect(s.restart, `${name} restart`).toBe('unless-stopped');
    }
  });

  it('runs one-shot jobs once, and up.sh knows every job', () => {
    expect(jobNames(compose)).toEqual(JOBS);
    const upScript = fs.readFileSync(path.join(deployDir, 'scripts/up.sh'), 'utf8');
    const listed = /^JOBS="([^"]+)"$/m.exec(upScript)?.[1]?.split(' ').sort();
    expect(listed).toEqual(JOBS);
  });

  it('waits for dependencies to be healthy or completed, never just started', () => {
    for (const [name, s] of Object.entries(services)) {
      for (const [dep, cond] of Object.entries(s.depends_on ?? {})) {
        const expected = JOBS.includes(dep) ? 'service_completed_successfully' : 'service_healthy';
        expect(cond.condition, `${name} -> ${dep}`).toBe(expected);
      }
    }
  });

  it('pins every image to an exact version; the sandbox profile also by digest (ADR-M17, ADR-M25)', () => {
    // PostgreSQL (17.11) and SeaweedFS (4.47) release with two-part versions; the others use three or more.
    const twoPartVersioning = ['postgres', 'chrislusf/seaweedfs'];
    // Built from this repo; the tag follows the package version.
    const built = ['sdlc-api', 'sdlc-runner', 'otel-collector'];
    for (const [name, s] of Object.entries(services)) {
      const full = s.image ?? '';
      const at = full.indexOf('@');
      const image = at < 0 ? full : full.slice(0, at);
      const digest = at < 0 ? undefined : full.slice(at + 1);
      const repository = image.slice(0, image.lastIndexOf(':'));
      const tag = image.slice(image.lastIndexOf(':') + 1);
      expect(full, name).not.toMatch(/\$|:latest/);
      const exact = twoPartVersioning.includes(repository)
        ? /^\d+\.\d+(-[a-z0-9.]+)?$/
        : /^v?\d+\.\d+\.\d+(\.\d+)?(-[a-z0-9.]+)?$/;
      expect(tag, `${name}: ${full}`).toMatch(exact);
      // ADR-M17 pins by tag until Dependabot keeps digests current. The runner's services are
      // pinned by tag AND digest (ADR-M25 §2.5, §2.9, §2.10; QUESTIONS #54).
      // The team access proxy (V09, ADR-M67 §2.1), knowledge-db (X04 PR 3a, ADR-M89 §2.1) and vLLM
      // (L01, ADR-M71 §2.1) too, and the link to a separate GPU host (L01 PR 2, ADR-M71 §4.2).
      const byDigest =
        [
          'sandbox',
          'access',
          'knowledge',
          'models-local',
          'models-local-pull',
          'models-remote',
        ].some((p) => (s.profiles ?? []).includes(p)) && !built.includes(name);
      if (byDigest) expect(digest, `${name} digest`).toMatch(/^sha256:[0-9a-f]{64}$/);
      else expect(digest, `${name} digest`).toBeUndefined();
    }
  });

  it('uses no MinIO, Redis or Elasticsearch image (D-01 section 5.8e)', () => {
    for (const [name, s] of Object.entries(services)) {
      expect(s.image, name).not.toMatch(/minio|redis|elasticsearch|opensearch/i);
    }
  });
});

describe('AC4: no secrets in the repo', () => {
  const references = [...composeCode.matchAll(/\$\{([A-Z0-9_]+)(:[?-])?([^}]*)\}/g)];

  // Development-only keys: with the profile "models" (the server) they come from OpenBao and stay
  // empty in .env; litellm/start.sh refuses to start without either (C03, design/ADR-M24).
  const OPTIONAL_DEV_SECRETS = ['LITELLM_MASTER_KEY', 'LITELLM_SALT_KEY'];

  it('requires every secret variable (${VAR:?}), with no inline default', () => {
    const secrets = references.filter((m) => isSecretName(m[1]!));
    expect(secrets.length).toBeGreaterThan(15);
    for (const m of secrets) {
      if (OPTIONAL_DEV_SECRETS.includes(m[1]!)) continue;
      expect(m[2], `${m[1]} must use \${VAR:?}`).toBe(':?');
    }
  });

  it('the LiteLLM master and salt keys are optional and empty by default (C03)', () => {
    for (const name of OPTIONAL_DEV_SECRETS) {
      const found = references.filter((m) => m[1] === name);
      expect(found.length, name).toBe(1);
      expect([found[0]![2], found[0]![3]], name).toEqual([':-', '']);
    }
  });

  it('keeps only CHANGEME placeholders for secrets in .env.example', () => {
    for (const [key, value] of envExample) {
      if (isSecretName(key)) expect(value, key).toBe('CHANGEME');
    }
  });

  it('documents every variable used by the compose file in .env.example', () => {
    for (const m of references) expect(envExample.has(m[1]!), m[1]).toBe(true);
  });

  it('contains no well-known default passwords', () => {
    const files = [
      composeCode,
      readDeployFile('.env.example'),
      readDeployFile('litellm/config.yaml'),
      readDeployFile('openbao/openbao.hcl'),
    ];
    for (const text of files) {
      expect(text).not.toMatch(
        /miniosecret|myredissecret|mysecret|dbpassword|sk-1234|POSTGRES_PASSWORD: postgres/,
      );
      expect(text).not.toMatch(/sk-[A-Za-z0-9]{16,}|pk-lf-[a-f0-9]{8,}/);
    }
  });

  it('ignores platform/deploy/.env in Git but keeps .env.example', () => {
    const ignored = (file: string) => {
      try {
        execFileSync('git', ['check-ignore', '-q', '--no-index', file], { cwd: root });
        return true;
      } catch {
        return false;
      }
    };
    expect(ignored('platform/deploy/.env')).toBe(true);
    expect(ignored('platform/deploy/prod.env')).toBe(true);
    expect(ignored('platform/deploy/.env.example')).toBe(false);
  });

  it('binds published ports to SDLC_BIND_ADDR, 127.0.0.1 by default', () => {
    expect(envExample.get('SDLC_BIND_ADDR')).toBe('127.0.0.1');
    for (const [name, s] of Object.entries(services)) {
      for (const port of s.ports ?? []) {
        // The sandbox image registry has no authentication: always 127.0.0.1 (runbook T11).
        if (name === 'registry') expect(port, name).toMatch(/^127\.0\.0\.1:/);
        // Team access (V09, ADR-M67 §2.2): the only port beyond this machine, and only when set.
        else if (name === 'sdlc-access')
          expect(port, name).toBe(
            '${SDLC_ACCESS_BIND_ADDR:-127.0.0.1}:${SDLC_ACCESS_HOST_PORT:-8443}:8443',
          );
        else expect(port, name).toMatch(/^\$\{SDLC_BIND_ADDR:-127\.0\.0\.1\}:/);
      }
    }
    for (const name of [
      'valkey',
      'clickhouse',
      'langfuse-worker',
      'openbao',
      'npm-proxy',
      'docker-socket-proxy',
      'sdlc-runner',
    ])
      expect(service(name).ports).toBeUndefined();
  });
});

describe('Valkey shared by LiteLLM and Langfuse', () => {
  it('has an explicit maxmemory from .env and the noeviction policy', () => {
    const command = JSON.stringify(service('valkey').command);
    expect(command).toContain('maxmemory %s');
    expect(command).toContain('\\"$$VALKEY_MAXMEMORY\\"');
    expect(command).toContain('maxmemory-policy noeviction');
    expect(env('valkey').VALKEY_MAXMEMORY).toBe('${VALKEY_MAXMEMORY:-256mb}');
    expect(envExample.get('VALKEY_MAXMEMORY')).toMatch(/^\d+(mb|gb)$/);
  });

  it('never passes the password as a server argument', () => {
    const command = JSON.stringify(service('valkey').command);
    expect(command).not.toContain('--requirepass');
    expect(command).toContain('requirepass %s');
    expect(command).toContain('exec docker-entrypoint.sh valkey-server /tmp/valkey.conf');
  });
});

describe('init-env.sh', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-init-env-'));
  const script = path.join(deployDir, 'scripts/init-env.sh');
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('writes random values of the right format to a mode 600 file and prints no secret', () => {
    const output = path.join(tmp, 'generated.env');
    const stdout = execFileSync(script, [output], { encoding: 'utf8' });
    expect(fs.statSync(output).mode & 0o777).toBe(0o600);

    const generated = parseEnvFile(fs.readFileSync(output, 'utf8'));
    expect([...generated.keys()]).toEqual([...envExample.keys()]);
    for (const [key, value] of generated) {
      if (envExample.get(key) === 'CHANGEME') {
        expect(value, key).not.toBe('CHANGEME');
        expect(value.length, key).toBeGreaterThanOrEqual(16);
        expect(stdout).not.toContain(value);
      } else if (key === 'SDLC_DOCKER_GID') {
        expect(value, key).toMatch(/^[0-9]+$/); // detected (C04, ADR-M25 §2.5)
      } else if (key === 'SDLC_OPENBAO_TLS_DIR') {
        // A10 (ADR-M63): a throw-away CA next to the env file; the CA key is deleted at once.
        const dir = path.join(tmp, 'openbao-tls');
        expect(value, key).toBe(dir);
        expect(fs.readdirSync(dir).sort()).toEqual(['ca.pem', 'server-key.pem', 'server.pem']);
        expect(fs.statSync(path.join(dir, 'server-key.pem')).mode & 0o777).toBe(0o600);
        expect(fs.statSync(path.join(dir, 'ca.pem')).mode & 0o777).toBe(0o644);
      } else {
        expect(value, key).toBe(envExample.get(key));
      }
    }
    expect(generated.get('LITELLM_MASTER_KEY')).toMatch(/^sk-[a-f0-9]{48}$/);
    expect(generated.get('LANGFUSE_INIT_PROJECT_PUBLIC_KEY')).toMatch(/^pk-lf-[a-f0-9]{32}$/);
    expect(generated.get('LANGFUSE_INIT_PROJECT_SECRET_KEY')).toMatch(/^sk-lf-[a-f0-9]{48}$/);
    expect(generated.get('LANGFUSE_ENCRYPTION_KEY')).toMatch(/^[a-f0-9]{64}$/);
  });

  it('generates different secrets on each run', () => {
    const a = path.join(tmp, 'a.env');
    const b = path.join(tmp, 'b.env');
    execFileSync(script, [a]);
    execFileSync(script, [b]);
    expect(parseEnvFile(fs.readFileSync(a, 'utf8')).get('POSTGRES_SUPERUSER_PASSWORD')).not.toBe(
      parseEnvFile(fs.readFileSync(b, 'utf8')).get('POSTGRES_SUPERUSER_PASSWORD'),
    );
  });

  it('never overwrites an existing file', () => {
    const output = path.join(tmp, 'existing.env');
    fs.writeFileSync(output, 'KEEP=me\n');
    expect(() => execFileSync(script, [output], { stdio: 'pipe' })).toThrow();
    expect(fs.readFileSync(output, 'utf8')).toBe('KEEP=me\n');
  });

  // O02 (QUESTIONS #582): the upgrade's README step 3, `pnpm compose:env --add-missing`.
  describe('--add-missing', () => {
    const missing = 'KNOWLEDGE_DB_SUPERUSER_PASSWORD';

    it('appends only the keys the file lacks, with random secrets, and changes no line that is there', () => {
      const output = path.join(tmp, 'upgrade.env');
      execFileSync(script, [output]);
      const before = fs
        .readFileSync(output, 'utf8')
        .split('\n')
        .filter((line) => !line.startsWith(`${missing}=`) && !line.startsWith('SDLC_VLLM_'))
        .join('\n')
        .replace(/\n$/, ''); // a last line without its newline
      fs.writeFileSync(output, before, { mode: 0o644 });

      const stdout = execFileSync(script, ['--add-missing', output], { encoding: 'utf8' });
      const after = fs.readFileSync(output, 'utf8');
      expect(after.startsWith(`${before}\n`)).toBe(true);
      expect(fs.statSync(output).mode & 0o777).toBe(0o600);
      const env = parseEnvFile(after);
      expect([...env.keys()].sort()).toEqual([...envExample.keys()].sort());
      expect(env.get(missing)).toMatch(/^[a-f0-9]{48}$/);
      expect(env.get('SDLC_VLLM_MODEL')).toBe(envExample.get('SDLC_VLLM_MODEL'));
      expect(stdout).toContain(missing);
      expect(stdout).not.toContain(env.get(missing));

      const again = execFileSync(script, ['--add-missing', output], { encoding: 'utf8' });
      expect(again).toContain('nothing added');
      expect(fs.readFileSync(output, 'utf8')).toBe(after);
    });

    it('refuses a file that does not exist, and makes none', () => {
      const output = path.join(tmp, 'absent.env');
      expect(() => execFileSync(script, ['--add-missing', output], { stdio: 'pipe' })).toThrow();
      expect(fs.existsSync(output)).toBe(false);
    });
  });
});
