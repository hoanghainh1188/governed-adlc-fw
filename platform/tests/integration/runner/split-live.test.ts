// D-08 O01 AC1, AC2 (design/ADR-M91): live test of the runner on its own Docker Engine. Two Engines
// on one machine, as on a server without a second VM: the machine's own Engine runs the platform
// (core and knowledge, with the link overlay), and a rootless Engine runs the runner host's Compose
// project. Skipped unless SDLC_RUNNER_SPLIT_TEST=1. Run with: pnpm test:runner-split
// (CI job `runner-rootless`, after the rootless Engine and the link address are set up).
//
// Environment:
//   SDLC_RUNNER_SPLIT_LINK_ADDR      the link address, a host address of this machine (CI: a dummy
//                                    interface)
//   SDLC_RUNNER_SPLIT_DOCKER_HOST    the runner's rootless Engine (unix:///run/user/<uid>/docker.sock)
//   SDLC_RUNNER_SPLIT_PLATFORM_HOST  the platform's Engine (default unix:///var/run/docker.sock)
//
// It runs like the server: OpenBao initialised, unsealed and configured with the bootstrap script,
// with SDLC_RUNNER_SOURCE_CIDR for the runner role (QUESTIONS #596); `runner-credentials` delivers
// the runner's AppRole to the rootless Engine (#597); the runner host gets OpenBao's CA certificate
// (#598). Key shares, tokens and passwords are THROW-AWAY TEST KEYS: kept in variables, never
// printed, never in an assertion message.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createKysely } from '../../../packages/core/src/db/connection.js';
import { migrateToLatest } from '../../../packages/core/src/db/migrator.js';
import { deployDir, parseEnvFile } from '../../deploy/compose';
import { isolateEnv } from '../throwaway-compose';

const enabled = process.env.SDLC_RUNNER_SPLIT_TEST === '1';
const LINK = process.env.SDLC_RUNNER_SPLIT_LINK_ADDR ?? '';
const RUNNER_HOST = process.env.SDLC_RUNNER_SPLIT_DOCKER_HOST ?? '';
const PLATFORM_HOST = process.env.SDLC_RUNNER_SPLIT_PLATFORM_HOST ?? 'unix:///var/run/docker.sock';
const PORT_OFFSET = 37000;
const SETUP_TIMEOUT_MS = 20 * 60 * 1000;
/** Volumes of the platform that must never be on the runner's Engine (ADR-M91 §1). */
const PLATFORM_VOLUMES = [
  'postgres-data',
  'knowledge-db-data',
  'seaweedfs-data',
  'openbao-data',
  'openbao-tls',
  'api-approle',
  'worker-approle',
  'worker-cost-approle',
  'litellm-approle',
  'registry-data',
];

interface Result {
  status: number | null;
  stdout: string;
  stderr: string;
}

describe.skipIf(!enabled)(
  'the runner on its own rootless Docker Engine (live)',
  { timeout: 180_000 },
  () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-runner-split-'));
    const envFile = path.join(tmp, 'it.env');
    const hostEnvFile = path.join(tmp, 'runner-host.env');
    const project = `sdlcsplit${process.pid}`;
    const subnet = `172.30.${175 + (process.pid % 25)}.0/24`;
    const gatewayIp = subnet.replace(/0\/24$/, '1');
    const bootstrap = path.join(deployDir, 'openbao/bootstrap.sh');
    const platformFiles = [
      '-f',
      path.join(deployDir, 'docker-compose.yml'),
      '-f',
      path.join(deployDir, 'docker-compose.runner-link.yml'),
    ];
    const hostFiles = ['-f', path.join(deployDir, 'runner-host/docker-compose.yml')];
    const hostProfiles = ['--profile', 'sandbox', '--profile', 'knowledge'];

    const secrets: string[] = [];
    const keep = (value: string): string => {
      if (value) secrets.push(value);
      return value;
    };
    const redact = (text: string): string =>
      secrets.reduce((acc, s) => acc.split(s).join('<redacted>'), text);

    const run = (
      cmd: string,
      args: string[],
      dockerHost: string,
      input = '',
      env: NodeJS.ProcessEnv = {},
    ): Result => {
      const r = spawnSync(cmd, args, {
        encoding: 'utf8',
        input,
        env: { ...process.env, SDLC_ENV_FILE: envFile, DOCKER_HOST: dockerHost, ...env },
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
    const platform = (...args: string[]) =>
      run('docker', ['compose', ...platformFiles, '--env-file', envFile, ...args], PLATFORM_HOST);
    const runnerHost = (...args: string[]) =>
      run(
        'docker',
        ['compose', ...hostFiles, '--env-file', hostEnvFile, ...hostProfiles, ...args],
        RUNNER_HOST,
      );
    const onRunnerEngine = (...args: string[]) => run('docker', args, RUNNER_HOST);
    const bootstrapCmd = (args: string[], input = ''): Result =>
      run(bootstrap, args, PLATFORM_HOST, input, { SDLC_OPENBAO_TEST: '1' });
    const hostLogs = () => {
      const logs = runnerHost('logs', '--no-color');
      return redact(logs.stdout + logs.stderr);
    };

    beforeAll(async () => {
      if (!LINK || !RUNNER_HOST.startsWith('unix:///')) {
        throw new Error('set SDLC_RUNNER_SPLIT_LINK_ADDR and SDLC_RUNNER_SPLIT_DOCKER_HOST');
      }
      ok(run(path.join(deployDir, 'scripts/init-env.sh'), [envFile], PLATFORM_HOST), 'init-env');
      const isolated = isolateEnv(fs.readFileSync(envFile, 'utf8'), {
        project,
        subnet,
        gateway: gatewayIp,
        portOffset: PORT_OFFSET,
      })
        .replace(/^SDLC_RUNNER_LINK_ADDR=.*$/m, `SDLC_RUNNER_LINK_ADDR=${LINK}`)
        .replace(/^SDLC_RUNNER_SOURCE_CIDR=.*$/m, `SDLC_RUNNER_SOURCE_CIDR=${LINK}/32`)
        .replace(/^SDLC_RUNNER_DOCKER_HOST=.*$/m, `SDLC_RUNNER_DOCKER_HOST=${RUNNER_HOST}`);
      fs.writeFileSync(envFile, isolated, { mode: 0o600 });
      const env = parseEnvFile(isolated);
      for (const key of [
        'PLATFORM_APP_DB_PASSWORD',
        'PLATFORM_DB_PASSWORD',
        'LITELLM_MASTER_KEY',
        'KNOWLEDGE_DB_SUPERUSER_PASSWORD',
      ]) {
        keep(env.get(key) ?? '');
      }

      // The runner host's env file: no secret (runner-host/.env.example).
      const socket = RUNNER_HOST.slice('unix://'.length);
      const caFile = path.join(env.get('SDLC_OPENBAO_TLS_DIR')!, 'ca.pem');
      fs.writeFileSync(
        hostEnvFile,
        fs
          .readFileSync(path.join(deployDir, 'runner-host/.env.example'), 'utf8')
          .replace(/^COMPOSE_PROJECT_NAME=.*$/m, `COMPOSE_PROJECT_NAME=${project}`)
          .replace(/^SDLC_RUNNER_LINK_ADDR=.*$/m, `SDLC_RUNNER_LINK_ADDR=${LINK}`)
          .replace(/^SDLC_DOCKER_SOCKET=.*$/m, `SDLC_DOCKER_SOCKET=${socket}`)
          .replace(/^SDLC_OPENBAO_CA_FILE=.*$/m, `SDLC_OPENBAO_CA_FILE=${caFile}`),
        { mode: 0o600 },
      );

      ok(
        platform(
          '--profile',
          'core',
          '--profile',
          'knowledge',
          'up',
          '-d',
          '--wait',
          '--wait-timeout',
          '300',
          'openbao',
          'postgres',
          'temporal',
          'seaweedfs',
          'litellm',
          'knowledge-db',
        ),
        'platform up',
      );
      // One-shot jobs that the runner's services wait for on the platform's Engine (depends_on):
      // the Temporal namespace and the bucket `evidence`.
      ok(platform('--profile', 'core', 'run', '--rm', 'temporal-namespace'), 'temporal-namespace');
      ok(platform('--profile', 'core', 'run', '--rm', 'seaweedfs-init'), 'seaweedfs-init');
      const init = ok(bootstrapCmd(['init', '--stdout-not-tty']), 'init');
      const shares = [...init.stdout.matchAll(/^Unseal Key \d+: (\S+)$/gm)].map((m) => keep(m[1]!));
      const rootToken = keep(/^Initial Root Token: (\S+)$/m.exec(init.stdout)?.[1] ?? '');
      ok(bootstrapCmd(['unseal'], `${shares[0]}\n${shares[1]}\n`), 'unseal');
      ok(bootstrapCmd(['configure', '--keep-token'], `${rootToken}\n`), 'configure');

      const owner = createKysely({
        connectionString: `postgresql://platform:${encodeURIComponent(env.get('PLATFORM_DB_PASSWORD')!)}@127.0.0.1:${5432 + PORT_OFFSET}/platform`,
        maxConnections: 1,
      });
      const { error } = await migrateToLatest(owner);
      await owner.destroy();
      if (error) throw new Error('migration failed', { cause: error });

      const delivered = ok(
        bootstrapCmd(['runner-credentials'], `${rootToken}\n`),
        'runner-credentials',
      );
      expect(delivered.stdout).toContain("the runner's credentials go to the runner host's Engine");
      // OpenBao and SeaweedFS only: unchanged by the split set-up.
      ok(
        bootstrapCmd(['runner-evidence-credentials'], `${rootToken}\n`),
        'runner-evidence-credentials',
      );

      const up = run(
        path.join(deployDir, 'scripts/runner-host.sh'),
        ['up', 'knowledge'],
        RUNNER_HOST,
        '',
        { SDLC_RUNNER_HOST_ENV_FILE: hostEnvFile, SDLC_WAIT_TIMEOUT: '240' },
      );
      if (up.status !== 0) {
        throw new Error(
          `runner-host up failed: ${redact(up.stderr + up.stdout)}\n${hostLogs().slice(-4000)}`,
        );
      }
    }, SETUP_TIMEOUT_MS);

    afterAll(() => {
      runnerHost('down', '--volumes', '--remove-orphans');
      onRunnerEngine('network', 'rm', `${project}-probe`);
      platform(
        '--profile',
        'core',
        '--profile',
        'knowledge',
        'down',
        '--volumes',
        '--remove-orphans',
      );
      fs.rmSync(tmp, { recursive: true, force: true });
    }, SETUP_TIMEOUT_MS);

    it('the runner starts healthy on its own Engine: OpenBao login, database and Temporal over the link', () => {
      const logs = hostLogs();
      expect(logs).toContain('"event":"openbao.login"');
      expect(logs).toContain('"event":"runner.started"');
      expect(logs).not.toContain('runner.start_failed');
      expect(logs).not.toContain('runner.evidence_missing');
      expect(logs).toContain('openbao-ca-init: CA certificate in place');
      const state = ok(
        onRunnerEngine('inspect', '-f', '{{.State.Health.Status}}', `${project}-sdlc-runner-1`),
        'inspect runner',
      ).stdout.trim();
      expect(state).toBe('healthy');
      // The platform's Engine runs no runner and no socket proxy.
      const there = ok(platform('ps', '--format', '{{.Service}}'), 'platform ps').stdout;
      expect(there.split('\n')).not.toContain('sdlc-runner');
      expect(there.split('\n')).not.toContain('docker-socket-proxy');
    });

    it('the credential files reached the runner host privately (QUESTIONS #597)', () => {
      const files = ok(
        runnerHost('exec', '-T', 'sdlc-runner', 'sh', '-c', 'stat -c "%a %U" /run/sdlc/approle/*'),
        'stat',
      ).stdout.trim();
      expect(files.split('\n')).toEqual(['600 node', '600 node']);
      const inspect = ok(onRunnerEngine('inspect', `${project}-sdlc-runner-1`), 'inspect').stdout;
      for (const secret of secrets) {
        expect(inspect.includes(secret), 'a secret is in docker inspect').toBe(false);
        expect(hostLogs().includes(secret), 'a secret is in the logs').toBe(false);
      }
    });

    it('a run network reaches LiteLLM and knowledge-db through the relays only (ADR-M91 §2.2)', () => {
      // Like a run: an internal network, the relays attached under their aliases.
      const net = `${project}-probe`;
      ok(onRunnerEngine('network', 'create', '--internal', net), 'network create');
      ok(
        onRunnerEngine('network', 'connect', '--alias', 'litellm', net, `${project}-litellm-1`),
        'connect litellm',
      );
      ok(
        onRunnerEngine(
          'network',
          'connect',
          '--alias',
          'knowledge-db',
          net,
          `${project}-knowledge-db-1`,
        ),
        'connect knowledge-db',
      );
      const image = ok(
        onRunnerEngine('inspect', '-f', '{{.Config.Image}}', `${project}-sdlc-runner-1`),
        'runner image',
      ).stdout.trim();
      // LiteLLM's liveliness answer, and PostgreSQL's answer to an SSLRequest ('N' or 'S').
      const probe = ok(
        onRunnerEngine(
          'run',
          '--rm',
          '--network',
          net,
          '--read-only',
          '--cap-drop',
          'ALL',
          '--entrypoint',
          'node',
          image,
          '-e',
          `const net=require('net');
           const http=require('http');
           const pg=()=>new Promise((ok,no)=>{const s=net.connect(5432,'knowledge-db',()=>s.write(Buffer.from([0,0,0,8,4,210,22,47])));
             s.once('data',d=>{s.destroy();ok(d.toString('latin1',0,1))});s.once('error',no);setTimeout(()=>no(new Error('timeout')),10000)});
           const llm=()=>new Promise((ok,no)=>http.get('http://litellm:4000/health/liveliness',r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>ok(r.statusCode+' '+b))}).on('error',no));
           const outside=()=>new Promise(ok=>{const s=net.connect(443,'1.1.1.1');s.once('connect',()=>{s.destroy();ok('open')});s.once('error',()=>ok('closed'));setTimeout(()=>{s.destroy();ok('closed')},3000)});
           (async()=>console.log(JSON.stringify({pg:await pg(),llm:await llm(),outside:await outside()})))().catch(e=>{console.error(e.message);process.exit(1)});`,
        ),
        'probe',
      ).stdout.trim();
      const answer = JSON.parse(probe) as { pg: string; llm: string; outside: string };
      expect(['N', 'S']).toContain(answer.pg);
      expect(answer.llm).toMatch(/^200 /);
      expect(answer.outside).toBe('closed');
    });

    it("the runner's Engine holds no platform volume, network or service (ADR-M91 §2.1)", () => {
      const volumes = ok(onRunnerEngine('volume', 'ls', '--format', '{{.Name}}'), 'volumes').stdout;
      for (const v of PLATFORM_VOLUMES) {
        expect(volumes.split('\n'), v).not.toContain(`${project}_${v}`);
      }
      const networks = ok(onRunnerEngine('network', 'ls', '--format', '{{.Name}}'), 'networks')
        .stdout.split('\n')
        .filter((n) => n.startsWith(project));
      expect(networks).not.toContain(`${project}-net`);
      expect(networks).toContain(`${project}-runner-net`);
      const services = ok(runnerHost('ps', '-a', '--format', '{{.Service}}'), 'ps')
        .stdout.split('\n')
        .filter(Boolean)
        .sort();
      expect(services).toEqual([
        'docker-socket-proxy',
        'knowledge-db',
        'litellm',
        'npm-proxy',
        'openbao-ca-init',
        'sdlc-runner',
      ]);
    });

    it('the platform publishes OpenBao on the link address only, with TLS', () => {
      const ports = ok(
        run('docker', ['port', `${project}-openbao-1`], PLATFORM_HOST),
        'openbao ports',
      ).stdout.trim();
      expect(ports.split('\n')).toEqual([`8200/tcp -> ${LINK}:8200`]);
    });

    it('doctor: runner.engine is ok (the runner has its own Engine)', () => {
      const doctor = run(
        'node',
        [path.join(deployDir, 'doctor/dist/main.js'), '--env', envFile, '--json'],
        PLATFORM_HOST,
      );
      const checks = (JSON.parse(doctor.stdout) as { checks: { id: string; status: string }[] })
        .checks;
      expect(checks.filter((c) => c.id === 'runner.engine')).toEqual([
        expect.objectContaining({ status: 'ok' }),
      ]);
      expect(checks.filter((c) => c.id === 'access.ports' && c.status === 'failed')).toEqual([]);
    });
  },
);
