// D-08 C04, ADR-M25: live test of the Compose profile "sandbox" with the sdlc-runner container.
// Needs Docker. Skipped unless SDLC_RUNNER_COMPOSE_TEST=1. Run with: pnpm test:runner-compose
//
// Own throw-away Compose project (own name, ports, subnet, random env file), removed afterwards.
// It runs like the server: OpenBao initialised, unsealed and configured with the bootstrap script;
// `bootstrap.sh runner-credentials` stores the platform_app password at kv/runner/database and
// delivers the runner's AppRole credentials. The runner reaches Docker through the socket proxy
// only, cleans up at start (a leftover object of its instance is removed, one of another instance
// stays) and turns healthy through its heartbeat file. C06 session 2b: `bootstrap.sh
// runner-evidence-credentials` gives the runner a SeaweedFS identity that may only write under
// `evidence/proposals/` and, since C07, `evidence/diffs/` (no overwrite, versions kept after a
// delete; a rotation disables the old key); it reads `evidence/diffs/` only (C08, QUESTIONS #155). Key shares, tokens and passwords are
// THROW-AWAY TEST KEYS: kept in variables, never printed, never in an assertion message.
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DeleteObjectCommand, ListObjectVersionsCommand, S3Client } from '@aws-sdk/client-s3';
import { S3EvidenceStore } from '@sdlc/adapter-evidence-s3';
import type { RedactedSecret } from '@sdlc/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LABELS, MANAGED_BY } from '../../../apps/runner/src/index.js';
import { createKysely } from '../../../packages/core/src/db/connection.js';
import { migrateToLatest } from '../../../packages/core/src/db/migrator.js';
import { deployDir, parseEnvFile } from '../../deploy/compose';
import { isolateEnv } from '../throwaway-compose';

const enabled = process.env.SDLC_RUNNER_COMPOSE_TEST === '1';
const PORT_OFFSET = 25000;
const SETUP_TIMEOUT_MS = 15 * 60 * 1000;

interface Result {
  status: number | null;
  stdout: string;
  stderr: string;
}

describe.skipIf(!enabled)(
  'sdlc-runner in the Compose profile sandbox (live)',
  { timeout: 180_000 },
  () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-runner-it-'));
    const envFile = path.join(tmp, 'it.env');
    const project = `sdlcrun${process.pid}`;
    const subnet = `172.30.${175 + (process.pid % 25)}.0/24`;
    const gatewayIp = subnet.replace(/0\/24$/, '1');
    const bootstrap = path.join(deployDir, 'openbao/bootstrap.sh');
    const profiles = ['--profile', 'core', '--profile', 'sandbox'];
    const leftover = `sdlc-ws-${crypto.randomUUID()}`;
    const foreign = `sdlc-ws-${crypto.randomUUID()}`;

    const secrets: string[] = [];
    const keep = (value: string): string => {
      if (value) secrets.push(value);
      return value;
    };
    const redact = (text: string): string =>
      secrets.reduce((acc, s) => acc.split(s).join('<redacted>'), text);
    let rootToken = '';
    let s3Url = '';
    let admin: { accessKeyId: string; secretAccessKey: string } | undefined;
    const secret = (value: string): RedactedSecret =>
      ({ reveal: () => value, toString: () => '[redacted]' }) as RedactedSecret;
    /** The runner's evidence keys, read from OpenBao with the throw-away root token. */
    const evidenceKeys = (): { access_key: string; secret_key: string } => {
      const composeArgs = ['compose', '-f', path.join(deployDir, 'docker-compose.yml')];
      const read = run(
        'docker',
        [
          ...composeArgs,
          '--env-file',
          envFile,
          '--profile',
          'core',
          'exec',
          '-T',
          'openbao',
          'sh',
          '-c',
          'IFS= read -r BAO_TOKEN && export BAO_TOKEN && ' +
            'bao kv get -mount=kv -format=json -field=data runner/evidence',
        ],
        `${rootToken}\n`,
      );
      const data = JSON.parse(ok(read, 'kv get runner/evidence').stdout) as {
        access_key: string;
        secret_key: string;
      };
      keep(data.access_key);
      keep(data.secret_key);
      return data;
    };
    const runnerStore = (keys: { access_key: string; secret_key: string }, keyPrefix: string) =>
      new S3EvidenceStore({
        endpoint: s3Url,
        bucket: 'evidence',
        keyPrefix,
        accessKeyId: secret(keys.access_key),
        secretAccessKey: secret(keys.secret_key),
        timeoutMs: 10_000,
      });

    const run = (cmd: string, args: string[], input = '', env: NodeJS.ProcessEnv = {}): Result => {
      const r = spawnSync(cmd, args, {
        encoding: 'utf8',
        input,
        env: { ...process.env, SDLC_ENV_FILE: envFile, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    };
    const ok = (r: Result, what: string): Result => {
      if (r.status !== 0) {
        throw new Error(`${what} failed (exit ${r.status}): ${redact(r.stderr + r.stdout)}`);
      }
      return r;
    };
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
    const volume = (name: string, labels: Record<string, string>) =>
      ok(
        run('docker', [
          'volume',
          'create',
          ...Object.entries(labels).flatMap(([k, v]) => ['--label', `${k}=${v}`]),
          name,
        ]),
        'volume create',
      );
    const volumeExists = (name: string) =>
      run('docker', ['volume', 'ls', '-q', '--filter', `name=^${name}$`]).stdout.trim() === name;
    const upRunner = () => {
      const r = compose(
        ...profiles,
        'up',
        '-d',
        '--build',
        '--wait',
        '--wait-timeout',
        '180',
        'sdlc-runner',
      );
      if (r.status !== 0) {
        const logs = compose(
          ...profiles,
          'logs',
          '--no-color',
          'sdlc-runner',
          'docker-socket-proxy',
        );
        throw new Error(
          `sdlc-runner did not start: ${redact(logs.stdout + logs.stderr).slice(-3000)}`,
        );
      }
    };

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
      admin = {
        accessKeyId: keep(env.get('SEAWEEDFS_S3_ACCESS_KEY')!),
        secretAccessKey: keep(env.get('SEAWEEDFS_S3_SECRET_KEY')!),
      };
      s3Url = `http://127.0.0.1:${env.get('SEAWEEDFS_S3_HOST_PORT')!}`;

      ok(compose('--profile', 'core', 'up', '-d', '--wait', 'openbao', 'postgres'), 'compose up');
      const init = ok(bootstrapCmd(['init', '--stdout-not-tty']), 'init');
      const shares = [...init.stdout.matchAll(/^Unseal Key \d+: (\S+)$/gm)].map((m) => keep(m[1]!));
      rootToken = keep(/^Initial Root Token: (\S+)$/m.exec(init.stdout)?.[1] ?? '');
      ok(bootstrapCmd(['unseal'], `${shares[0]}\n${shares[1]}\n`), 'unseal');
      ok(bootstrapCmd(['configure', '--keep-token'], `${rootToken}\n`), 'configure');

      const owner = createKysely({
        connectionString: `postgresql://platform:${encodeURIComponent(env.get('PLATFORM_DB_PASSWORD')!)}@127.0.0.1:${5432 + PORT_OFFSET}/platform`,
        maxConnections: 1,
      });
      const { error } = await migrateToLatest(owner);
      await owner.destroy();
      if (error) throw new Error('migration failed', { cause: error });

      // Left by a crashed runner of this instance (a reserved workspace, no database row), and an
      // object of another runner deployment on the same Docker host.
      const run1 = leftover.slice('sdlc-ws-'.length);
      const tenant = crypto.randomUUID();
      const labels = (instance: string, runId: string) => ({
        [LABELS.managed]: MANAGED_BY,
        [LABELS.instance]: instance,
        [LABELS.runId]: runId,
        [LABELS.tenantId]: tenant,
      });
      volume(leftover, labels(project, run1));
      volume(foreign, labels(`${project}-other`, foreign.slice('sdlc-ws-'.length)));

      ok(bootstrapCmd(['runner-credentials'], `${rootToken}\n`), 'runner-credentials');
      ok(compose('--profile', 'core', 'up', '-d', '--wait', 'seaweedfs'), 'seaweedfs up');
      const evidence = ok(
        bootstrapCmd(['runner-evidence-credentials'], `${rootToken}\n`),
        'runner-evidence-credentials',
      );
      expect(evidence.stdout).toContain('runner-evidence');
      upRunner();
    }, SETUP_TIMEOUT_MS);

    afterAll(() => {
      compose(...profiles, 'down', '--volumes', '--remove-orphans');
      run('docker', ['volume', 'rm', '-f', leftover, foreign]);
      fs.rmSync(tmp, { recursive: true, force: true });
    }, SETUP_TIMEOUT_MS);

    it('starts healthy, cleans up its own leftovers at start, leaves other instances alone', () => {
      expect(volumeExists(leftover)).toBe(false);
      expect(volumeExists(foreign)).toBe(true);
      const logs = compose(...profiles, 'logs', '--no-color', 'sdlc-runner');
      expect(logs.stdout + logs.stderr).toContain('"event":"runner.started"');
      expect(logs.stdout + logs.stderr).toContain('"event":"runner.clean_up.start"');
    });

    it('reaches Docker only through the proxy; the proxy refuses anything off its list', () => {
      const inspect = ok(
        run('docker', ['inspect', '--format', '{{json .Mounts}}', `${project}-sdlc-runner-1`]),
        'inspect',
      ).stdout;
      expect(inspect).not.toContain('docker.sock"'); // the raw socket is not mounted
      const probe = ok(
        compose(
          ...profiles,
          'exec',
          '-T',
          'sdlc-runner',
          'node',
          '-e',
          `const h=require('http');const s=process.env.SDLC_RUNNER_DOCKER_SOCKET;
         const q=(m,p)=>new Promise(r=>h.request({socketPath:s,method:m,path:p},x=>{x.resume();r(x.statusCode)}).end());
         (async()=>console.log([await q('GET','/v1.44/_ping'),await q('GET','/v1.44/info'),await q('GET','/v1.44/version'),await q('POST','/v1.44/containers/x/exec')].join(' ')))()`,
        ),
        'probe',
      ).stdout.trim();
      // H06 (ADR-M25 §2.12): GET /info is on the list (the runner reads the Engine's runtimes).
      expect(probe).toBe('200 200 403 403');
    });

    it('listens on no port, so joining a run network gives the sandbox nothing to reach (C05)', () => {
      // /proc/net/tcp{,6}: state 0A is LISTEN. The runner container has no listening socket of its
      // own. Docker's embedded DNS listens on 127.0.0.11 inside every container on a user network
      // (0B00007F, ADR-M10 §2.4); it is Docker's, reachable only from inside the container.
      const sockets = ok(
        compose(...profiles, 'exec', '-T', 'sdlc-runner', 'cat', '/proc/net/tcp', '/proc/net/tcp6'),
        'proc net',
      ).stdout;
      const listening = sockets
        .split('\n')
        .slice(1)
        .map((line) => line.trim().split(/\s+/))
        .filter((f) => f[3] === '0A' && !f[1]?.startsWith('0B00007F:'));
      expect(listening).toEqual([]);
      const env = ok(
        run('docker', ['inspect', '--format', '{{json .Config.Env}}', `${project}-sdlc-runner-1`]),
        'inspect env',
      ).stdout;
      expect(env).toContain(`SDLC_RUNNER_SELF_CONTAINER=${project}-sdlc-runner-1`);
    });

    it('holds no secret in its environment, image or logs; credential files are private', () => {
      const container = ok(compose(...profiles, 'ps', '-q', 'sdlc-runner'), 'ps').stdout.trim();
      const inspect = ok(run('docker', ['inspect', container]), 'inspect').stdout;
      const logs = ok(compose(...profiles, 'logs', 'sdlc-runner'), 'logs');
      for (const secret of secrets) {
        expect(inspect.includes(secret), 'a secret is in docker inspect').toBe(false);
        expect((logs.stdout + logs.stderr).includes(secret), 'a secret is in the logs').toBe(false);
      }
      const files = ok(
        compose(
          ...profiles,
          'exec',
          '-T',
          'sdlc-runner',
          'sh',
          '-c',
          'stat -c "%a %U" /run/sdlc/approle/*',
        ),
        'stat',
      ).stdout.trim();
      expect(files.split('\n')).toEqual(['600 node', '600 node']);
    });

    it('C06 2b: the runner starts with its evidence identity (no evidence_missing)', () => {
      const logs = compose(...profiles, 'logs', '--no-color', 'sdlc-runner');
      expect(logs.stdout + logs.stderr).not.toContain('runner.evidence_missing');
      expect(logs.stdout + logs.stderr).not.toContain('runner.evidence_off');
    });

    it('C07, C08: the evidence identity writes and reads run diffs under diffs/; no overwrite', async () => {
      const keys = evidenceKeys();
      const tenant = crypto.randomUUID();
      const store = runnerStore(keys, 'diffs/');
      try {
        const stored = await store.put(tenant, 'i/r.patch', Buffer.from('diff\n'), 'text/x-diff');
        expect(stored.uri).toBe(`s3://evidence/diffs/${tenant}/i/r.patch`);
        await expect(
          store.put(tenant, 'i/r.patch', Buffer.from('other\n'), 'text/x-diff'),
        ).rejects.toMatchObject({ code: 'exists' });
        // C08 (QUESTIONS #155 A): the push reads the checked diff back.
        expect((await store.get(stored.uri)).toString()).toBe('diff\n');
      } finally {
        store.destroy();
      }
    });

    it('C06 2b: the evidence identity writes under proposals/ (and diffs/) only; no read of proposals, no overwrite; versions kept', async () => {
      const keys = evidenceKeys();
      const tenant = crypto.randomUUID();
      const store = runnerStore(keys, 'proposals/');
      const outside = runnerStore(keys, 'packs/');
      const s3 = new S3Client({
        endpoint: s3Url,
        region: 'us-east-1',
        forcePathStyle: true,
        credentials: admin!,
      });
      try {
        const stored = await store.put(tenant, 'i/r.patch', Buffer.from('diff\n'), 'text/x-diff');
        expect(stored.uri).toBe(`s3://evidence/proposals/${tenant}/i/r.patch`);
        await expect(
          store.put(tenant, 'i/r.patch', Buffer.from('other\n'), 'text/x-diff'),
        ).rejects.toMatchObject({ code: 'exists' });
        await expect(store.get(stored.uri)).rejects.toMatchObject({ code: 'forbidden' });
        await expect(
          outside.put(tenant, 'i/r.patch', Buffer.from('x'), 'text/x-diff'),
        ).rejects.toMatchObject({ code: 'forbidden' });

        // Write includes delete in SeaweedFS (ADR-M33 §2.9 gap 1): versioning keeps the content.
        const runnerS3 = new S3Client({
          endpoint: s3Url,
          region: 'us-east-1',
          forcePathStyle: true,
          credentials: { accessKeyId: keys.access_key, secretAccessKey: keys.secret_key },
        });
        const key = `proposals/${tenant}/i/r.patch`;
        await runnerS3.send(new DeleteObjectCommand({ Bucket: 'evidence', Key: key }));
        runnerS3.destroy();
        const versions = await s3.send(
          new ListObjectVersionsCommand({ Bucket: 'evidence', Prefix: key }),
        );
        expect(versions.Versions?.length ?? 0).toBeGreaterThanOrEqual(1);
        expect(versions.DeleteMarkers?.length ?? 0).toBe(1);
      } finally {
        store.destroy();
        outside.destroy();
        s3.destroy();
      }
    });

    it('C06 2b: runner-evidence-credentials rotates: the old key stops working', async () => {
      const old = evidenceKeys();
      ok(bootstrapCmd(['runner-evidence-credentials'], `${rootToken}\n`), 'rotate evidence');
      const fresh = evidenceKeys();
      expect(fresh.access_key).not.toBe(old.access_key);
      const tenant = crypto.randomUUID();
      const oldStore = runnerStore(old, 'proposals/');
      const newStore = runnerStore(fresh, 'proposals/');
      const oldDiffs = runnerStore(old, 'diffs/');
      const newDiffs = runnerStore(fresh, 'diffs/');
      try {
        await expect(
          oldStore.put(tenant, 'i/a.patch', Buffer.from('x'), 'text/x-diff'),
        ).rejects.toMatchObject({ code: 'forbidden' });
        await expect(
          oldDiffs.put(tenant, 'i/a.patch', Buffer.from('x'), 'text/x-diff'),
        ).rejects.toMatchObject({ code: 'forbidden' });
        await newStore.put(tenant, 'i/b.patch', Buffer.from('x'), 'text/x-diff');
        await newDiffs.put(tenant, 'i/b.patch', Buffer.from('x'), 'text/x-diff');
      } finally {
        oldStore.destroy();
        newStore.destroy();
        oldDiffs.destroy();
        newDiffs.destroy();
      }
    });

    it('runner-credentials can run again (rotation); the runner starts with the new secret ID', () => {
      ok(bootstrapCmd(['runner-credentials'], `${rootToken}\n`), 'runner-credentials again');
      ok(compose(...profiles, 'restart', 'sdlc-runner'), 'restart');
      upRunner();
    });
  },
);
