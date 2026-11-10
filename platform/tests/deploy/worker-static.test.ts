// B06: the sdlc-worker service in docker-compose.yml (design/ADR-M27 section 2.5). No port, no
// secret in its environment; the database password and the GitHub App key come from OpenBao with
// the AppRole "worker"; hardened container like sdlc-api.
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { deployDir, loadCompose, readDeployFile, root } from './compose';

interface WorkerService {
  image: string;
  profiles: string[];
  build: { context: string; dockerfile: string };
  environment: Record<string, string>;
  ports?: string[];
  volumes: string[];
  read_only: boolean;
  cap_drop: string[];
  cap_add?: string[];
  privileged?: boolean;
  user?: string;
  security_opt: string[];
  healthcheck: { test: string[] };
}

const compose = loadCompose();
const worker = compose.services['sdlc-worker'] as unknown as WorkerService;

describe('sdlc-worker service', () => {
  it('is in the platform profile only, built from the worker Dockerfile, tagged with the package version', () => {
    expect(worker.profiles).toEqual(['platform']);
    expect(worker.build).toEqual({
      context: '../..',
      dockerfile: 'platform/apps/worker/Dockerfile',
    });
    const pkg = JSON.parse(
      fs.readFileSync(path.join(root, 'platform/apps/worker/package.json'), 'utf8'),
    ) as { version: string };
    expect(worker.image).toBe(`sdlc-worker:${pkg.version}`);
  });

  it('publishes no port and has no secret in its environment', () => {
    expect(worker.ports).toBeUndefined();
    for (const name of Object.keys(worker.environment)) {
      expect(name, name).not.toMatch(/PASSWORD|SECRET_ID$|TOKEN|DEV_DB_URL|DEV_MODE|KEY/);
    }
    expect(worker.environment).toMatchObject({
      SDLC_OPENBAO_ROLE_ID_FILE: '/run/sdlc/approle/role_id',
      SDLC_OPENBAO_SECRET_ID_FILE: '/run/sdlc/approle/secret_id',
    });
    expect(worker.volumes).toEqual([
      'worker-approle:/run/sdlc/approle',
      // C06 session 2a (ADR-M33 §2.5): the second AppRole, cost-controller; files, not values.
      'worker-cost-approle:/run/sdlc/cost-approle',
      // A10 (ADR-M63): the CA that verifies OpenBao's certificate, read-only.
      'openbao-ca:/run/sdlc/openbao-ca:ro',
    ]);
    expect(worker.environment).toMatchObject({
      SDLC_WORKER_COST_ROLE_ID_FILE: '/run/sdlc/cost-approle/role_id',
      SDLC_WORKER_COST_SECRET_ID_FILE: '/run/sdlc/cost-approle/secret_id',
    });
    expect(readDeployFile('docker-compose.yml')).toMatch(/^ {2}worker-approle:$/m);
    expect(readDeployFile('docker-compose.yml')).toMatch(/^ {2}worker-cost-approle:$/m);
  });

  it('runs hardened: read-only root file system, no capabilities, no privilege gain', () => {
    expect(worker.read_only).toBe(true);
    expect(worker.cap_drop).toEqual(['ALL']);
    expect(worker.cap_add).toBeUndefined();
    expect(worker.privileged).toBeUndefined();
    expect(worker.user).toBeUndefined(); // the image's USER node applies
    expect(worker.security_opt).toEqual(['no-new-privileges:true']);
    expect(worker.healthcheck.test).toEqual(['CMD', 'node', '/app/dist/healthcheck.js']);
    const text = readDeployFile('docker-compose.yml');
    const start = text.indexOf('\n  sdlc-worker:\n');
    const rest = text.slice(start + 1);
    const next = rest.slice(1).search(/\n {2}[a-z][a-z0-9-]*:\n/);
    const block = next === -1 ? rest : rest.slice(0, next + 1);
    expect(block).not.toMatch(/cap_add|privileged|pid:|network_mode|docker\.sock/);
  });

  it('bootstrap.sh delivers the worker credentials through the shared helper', () => {
    const bootstrap = fs.readFileSync(path.join(deployDir, 'openbao/bootstrap.sh'), 'utf8');
    expect(bootstrap).toMatch(/^ {2}worker-credentials\) cmd_worker_credentials ;;$/m);
    expect(bootstrap).toMatch(
      /^cmd_worker_credentials\(\) \{\n {2}platform_credentials worker sdlc-worker\n {2}cost_controller_credentials\n\}$/m,
    );
    expect(bootstrap).toContain(
      'deliver_approle cost-controller sdlc-worker /run/sdlc/cost-approle platform',
    );
  });

  it('E03: builds release packs with its own SeaweedFS identity from OpenBao (worker-evidence-credentials)', () => {
    expect(worker.environment).toMatchObject({
      SDLC_WORKER_EVIDENCE_URL: 'http://seaweedfs:8333',
      SDLC_WORKER_EVIDENCE_BUCKET: 'evidence',
    });
    const depends = (compose.services['sdlc-worker'] as { depends_on: Record<string, unknown> })
      .depends_on;
    expect(depends['seaweedfs-init']).toEqual({ condition: 'service_completed_successfully' });
    const bootstrap = fs.readFileSync(path.join(deployDir, 'openbao/bootstrap.sh'), 'utf8');
    expect(bootstrap).toMatch(
      /^ {2}worker-evidence-credentials\) cmd_worker_evidence_credentials ;;$/m,
    );
    expect(bootstrap).toMatch(
      /^cmd_worker_evidence_credentials\(\) \{ pack_evidence_credentials worker sdlcwrkev sdlc-worker; \}$/m,
    );
  });

  it('E05: runs the evidence retention loop in report mode by default with its own purge identity', () => {
    expect(worker.environment).toMatchObject({
      SDLC_WORKER_RETENTION_URL: 'http://seaweedfs:8333',
      SDLC_WORKER_RETENTION_BUCKET: 'evidence',
      SDLC_WORKER_RETENTION_MODE: '${SDLC_WORKER_RETENTION_MODE:-report}',
      SDLC_WORKER_RETENTION_ARCHIVE_GRACE_DAYS: '${SDLC_WORKER_RETENTION_ARCHIVE_GRACE_DAYS:-7}',
      SDLC_CLIENT_DELETION_GRACE_DAYS: '${SDLC_CLIENT_DELETION_GRACE_DAYS:-14}',
      // O04 (ADR-M103): housekeeping of the session tables, on by default.
      SDLC_WORKER_HOUSEKEEPING_MODE: '${SDLC_WORKER_HOUSEKEEPING_MODE:-remove}',
      SDLC_WORKER_SESSION_KEEP_DAYS: '${SDLC_WORKER_SESSION_KEEP_DAYS:-30}',
      SDLC_WORKER_CHALLENGE_KEEP_HOURS: '${SDLC_WORKER_CHALLENGE_KEEP_HOURS:-24}',
    });
    const bootstrap = fs.readFileSync(path.join(deployDir, 'openbao/bootstrap.sh'), 'utf8');
    expect(bootstrap).toMatch(/^ {2}worker-purge-credentials\) cmd_worker_purge_credentials ;;$/m);
    expect(bootstrap).toMatch(
      /^cmd_worker_purge_credentials\(\) \{ s3_credentials worker purge sdlcwrkpg "\$PURGE_ACTIONS" sdlc-worker; \}$/m,
    );
    // Delete (Write), bypass, legal hold and lock on the three evidence prefixes, list the bucket;
    // never Read, never another prefix or bucket.
    const actions =
      /^PURGE_ACTIONS=''\n[\s\S]*?^PURGE_ACTIONS="List:evidence\$PURGE_ACTIONS"$/m.exec(
        bootstrap,
      )?.[0];
    expect(actions).toContain('for prefix in proposals diffs packs; do');
    expect(actions).toContain(
      'for action in Write BypassGovernanceRetention PutObjectLegalHold PutObjectRetention GetObjectRetention; do',
    );
    expect(actions).not.toMatch(/Read[:\s]|Admin/);
  });

  it('E05: the bucket evidence is locked GOVERNANCE for 180 days by seaweedfs-init', () => {
    const init = compose.services['seaweedfs-init'] as unknown as {
      environment: Record<string, string>;
    };
    expect(init.environment.SEAWEEDFS_LOCKED_BUCKETS?.split(' ')).toContain(
      'evidence:GOVERNANCE:180',
    );
    const script = readDeployFile('seaweedfs/create-buckets.sh');
    expect(script).toContain('s3.bucket.lock -name $bucket -enable');
    // The admin keys reach curl on stdin, never as arguments.
    expect(script).toContain('curl -sS -f -K - --aws-sigv4');
    expect(script).not.toMatch(/--user\s/);
  });

  it('the worker AppRole policy reads its own KV path and the GitHub App key, nothing else of other processes', () => {
    const policy = fs.readFileSync(
      path.join(deployDir, 'openbao/bootstrap/policies/worker.hcl'),
      'utf8',
    );
    const paths = [...policy.matchAll(/^path "([^"]+)"/gm)].map((m) => m[1]);
    expect(paths).toContain('kv/data/worker/*');
    expect(paths).toContain('kv/data/shared/github-app');
    expect(paths.filter((p) => p!.startsWith('kv/'))).toEqual([
      'kv/data/worker/*',
      'kv/data/shared/github-app',
    ]);
  });

  it('the Dockerfile runs as node and bakes in no secret', () => {
    const dockerfile = fs.readFileSync(path.join(root, 'platform/apps/worker/Dockerfile'), 'utf8');
    expect(dockerfile).toMatch(/^USER node$/m);
    expect(dockerfile).toContain('pnpm --filter @sdlc/worker deploy --legacy --prod /out');
    expect(dockerfile).not.toMatch(/ARG .*(PASSWORD|TOKEN|SECRET)|ENV .*(PASSWORD|TOKEN|SECRET)/);
  });

  it('E05 PR 2: the bucket audit-anchors is versioned and locked COMPLIANCE for 731 days', () => {
    const init = compose.services['seaweedfs-init'] as unknown as {
      environment: Record<string, string>;
    };
    expect(init.environment.SEAWEEDFS_BUCKETS?.split(' ')).toContain('audit-anchors');
    expect(init.environment.SEAWEEDFS_VERSIONED_BUCKETS?.split(' ')).toContain('audit-anchors');
    expect(init.environment.SEAWEEDFS_LOCKED_BUCKETS?.split(' ')).toEqual([
      'evidence:GOVERNANCE:180',
      'audit-anchors:COMPLIANCE:731',
    ]);
  });

  it('E05 PR 2: writes the daily audit anchor with its own identity, on audit-anchors only', () => {
    expect(worker.environment).toMatchObject({
      SDLC_WORKER_ANCHOR_URL: 'http://seaweedfs:8333',
      SDLC_WORKER_ANCHOR_BUCKET: 'audit-anchors',
    });
    const bootstrap = fs.readFileSync(path.join(deployDir, 'openbao/bootstrap.sh'), 'utf8');
    expect(bootstrap).toMatch(
      /^ {2}worker-anchor-credentials\) cmd_worker_anchor_credentials ;;$/m,
    );
    expect(bootstrap).toMatch(
      /^cmd_worker_anchor_credentials\(\) \{ s3_credentials worker anchor sdlcwrkan "\$ANCHOR_ACTIONS" sdlc-worker; \}$/m,
    );
    expect(/^ANCHOR_ACTIONS='([^']*)'$/m.exec(bootstrap)?.[1]?.split(',')).toEqual([
      'Write:audit-anchors',
      'Read:audit-anchors',
      'List:audit-anchors',
      'GetObjectRetention:audit-anchors',
    ]);
  });

  it('E08: the Langfuse purge is off unless set, and holds no key in the environment', () => {
    expect(worker.environment).toMatchObject({
      SDLC_WORKER_LANGFUSE_URL: '${SDLC_WORKER_LANGFUSE_URL:-off}',
      SDLC_WORKER_LANGFUSE_PROJECT_ID: '${LANGFUSE_INIT_PROJECT_ID:-sdlc-platform}',
      SDLC_WORKER_LANGFUSE_CLICKHOUSE_URL: 'http://clickhouse:8123',
      SDLC_WORKER_LANGFUSE_RAW_URL: 'http://seaweedfs:8333',
      SDLC_WORKER_LANGFUSE_RAW_BUCKET: 'langfuse',
      SDLC_WORKER_LANGFUSE_RAW_MAX_AGE_HOURS: '${SDLC_WORKER_LANGFUSE_RAW_MAX_AGE_HOURS:-24}',
    });
    // Its key, the ClickHouse password and the S3 key come from OpenBao (kv/worker/langfuse).
    expect(JSON.stringify(worker.environment)).not.toMatch(
      /LANGFUSE_(PUBLIC|SECRET)|CLICKHOUSE_PASSWORD/,
    );
  });

  it('A10: no ClickHouse user manages users over the network; sdlc_admin is loopback only', () => {
    const clickhouse = compose.services.clickhouse as unknown as {
      environment: Record<string, string>;
      volumes: string[];
    };
    // `langfuse` (the network user) has no access management (ADR-M63 §6).
    expect(clickhouse.environment).not.toHaveProperty('CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT');
    expect(JSON.stringify(compose)).not.toMatch(/ACCESS_MANAGEMENT/);
    expect(clickhouse.volumes).toContain(
      './clickhouse/sdlc-admin.xml:/etc/clickhouse-server/users.d/sdlc-admin.xml:ro',
    );
    const xml = fs.readFileSync(path.join(deployDir, 'clickhouse/sdlc-admin.xml'), 'utf8');
    // Well-formed: a double hyphen inside a comment stops ClickHouse at start.
    for (const comment of xml.match(/<!--[\s\S]*?-->/g) ?? []) {
      expect(comment.slice(4, -3)).not.toContain('--');
    }
    const body = xml.replace(/<!--[\s\S]*?-->/g, '');
    // Loopback only, and no access_management switch (the grants below are the whole right).
    expect([...body.matchAll(/<ip>([^<]*)<\/ip>/g)].map((m) => m[1])).toEqual(['::1', '127.0.0.1']);
    expect(body).not.toMatch(/<host|<host_regexp|access_management/);
    expect([...body.matchAll(/<query>([^<]*)<\/query>/g)].map((m) => m[1])).toEqual([
      'GRANT CREATE USER, ALTER USER, DROP USER ON *.*',
      'GRANT SHOW USERS ON *.*',
      'GRANT ALTER DELETE ON default.events_full WITH GRANT OPTION',
      'GRANT ALTER DELETE ON default.events_core WITH GRANT OPTION',
    ]);
    // The only user it declares.
    expect([...body.matchAll(/<users>\s*<([a-z_]+)>/g)].map((m) => m[1])).toEqual(['sdlc_admin']);
  });

  it('E08: worker-langfuse-credentials: List and delete under events/otel only, ALTER DELETE only', () => {
    const bootstrap = fs.readFileSync(path.join(deployDir, 'openbao/bootstrap.sh'), 'utf8');
    expect(bootstrap).toMatch(
      /^ {2}worker-langfuse-credentials\) cmd_worker_langfuse_credentials ;;$/m,
    );
    expect(/^LANGFUSE_RAW_ACTIONS='([^']*)'$/m.exec(bootstrap)?.[1]?.split(',')).toEqual([
      'List:langfuse',
      'Write:langfuse/events/otel/*',
    ]);
    const command =
      /^cmd_worker_langfuse_credentials\(\) \{[\s\S]*?^\}$/m.exec(bootstrap)?.[0] ?? '';
    expect(command).not.toBe('');
    // Never a read action, never another bucket or prefix.
    expect(command).not.toMatch(/Read:/);
    // The exact grants, checked after they are applied.
    const grants = [...command.matchAll(/GRANT ([A-Z ]+) ON (\S+) TO sdlc_purge/g)].map((m) =>
      [m[1], m[2]].join(' '),
    );
    expect(new Set(grants)).toEqual(
      new Set(['ALTER DELETE default.events_full', 'ALTER DELETE default.events_core']),
    );
    expect(command).toContain('REVOKE ALL ON *.* FROM sdlc_purge');
    // As the loopback-only admin, never as `langfuse`.
    expect(command).toContain("ch_admin='clickhouse-client --user sdlc_admin --multiquery'");
    // Secrets go through pipes: never a clickhouse-client password argument or a host file.
    expect(command).not.toMatch(/--password/);
    expect(command).toContain('bao kv put -mount=kv worker/langfuse -');
    // The Langfuse key is read like a token, never from an argument.
    expect(command).toMatch(/lf_secret="\$\(read_secret /);
  });
});
