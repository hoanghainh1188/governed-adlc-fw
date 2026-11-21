// D-08 task A03: live test of the OpenBao bootstrap (AC1–AC4), design/ADR-M19.
// Needs Docker. Skipped unless SDLC_OPENBAO_TEST=1. Run with: pnpm test:openbao
//
// Uses a throw-away Compose project (own name, ports, subnet, random env file) that starts only
// the openbao service; everything is removed afterwards. The key shares and tokens are
// THROW-AWAY TEST KEYS. They stay in variables of this process: never printed, never written to
// a file, never part of an assertion message or snapshot (errors go through redact()).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { deployDir } from '../../deploy/compose';
import {
  containerIp,
  hostPortBindings,
  isolateEnv,
  networkGateways,
  baoClientArgs,
  openbaoImage,
  sealStatusOnNetwork,
  type SealStatus,
} from '../throwaway-compose';

const enabled = process.env.SDLC_OPENBAO_TEST === '1';
const PORT_OFFSET = 21000;
const SETUP_TIMEOUT_MS = 5 * 60 * 1000;
const TEST_TIMEOUT_MS = 2 * 60 * 1000;
const ROLES = ['api', 'worker', 'runner', 'cost-controller'] as const;
type Role = (typeof ROLES)[number];

interface Result {
  status: number | null;
  stdout: string;
  stderr: string;
}

describe.skipIf(!enabled)('OpenBao bootstrap (live)', { timeout: TEST_TIMEOUT_MS }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-openbao-it-'));
  const envFile = path.join(tmp, 'it.env');
  const project = `sdlcbao${process.pid}`;
  const network = `${project}-net`;
  // Subnet ranges per live test file stay disjoint: bootstrap 100–149, run-contract-signing
  // 150–199, compose-up 200–224, secrets-client 225–249.
  const subnet = `172.30.${100 + (process.pid % 50)}.0/24`;
  const gateway = subnet.replace(/0\/24$/, '1');
  const bootstrap = path.join(deployDir, 'openbao/bootstrap.sh');
  let image = '';

  // Throw-away secrets, kept in memory only.
  const secrets: string[] = [];
  let shares: string[] = [];
  let firstRootToken = '';
  let adminToken = '';
  const roleIds = new Map<Role, string>();
  const secretIds = new Map<Role, string>();

  const keep = (value: string): string => {
    if (value) secrets.push(value);
    return value;
  };
  const redact = (text: string): string =>
    secrets.reduce((acc, s) => acc.split(s).join('<redacted>'), text);

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
    if (r.status !== 0) throw new Error(`${what} failed (exit ${r.status}): ${redact(r.stderr)}`);
    return r;
  };
  const composeWith = (input: string, ...args: string[]): Result =>
    run(
      'docker',
      ['compose', '-f', path.join(deployDir, 'docker-compose.yml'), '--env-file', envFile, ...args],
      input,
    );
  const compose = (...args: string[]): Result => composeWith('', ...args);
  const bootstrapCmd = (args: string[], input = '', env: NodeJS.ProcessEnv = {}): Result =>
    run(bootstrap, args, input, { SDLC_OPENBAO_TEST: '1', ...env });

  // Runs a shell script in a fresh container on the Compose network (inside the secret-ID
  // CIDR), like a platform process. The first stdin line is exported as BAO_TOKEN when non-empty.
  const onNetwork = (script: string, input: string, args: string[] = []): Result =>
    run(
      'docker',
      [
        'run',
        '--rm',
        '-i',
        '--network',
        network,
        ...baoClientArgs(network),
        '--entrypoint',
        'sh',
        image,
        '-c',
        `IFS= read -r t; [ -n "$t" ] && export BAO_TOKEN="$t"; ${script}`,
        'sh',
        ...args,
      ],
      input,
    );
  // The same, but inside the openbao container itself (source 127.0.0.1, outside the CIDR).
  const inOpenbao = (script: string, input: string): Result =>
    composeWith(
      input,
      'exec',
      '-T',
      'openbao',
      'sh',
      '-c',
      `IFS= read -r t; [ -n "$t" ] && export BAO_TOKEN="$t"; ${script}`,
    );

  // The same, but from the Docker HOST network namespace to the container IP (the real host on
  // Linux, the VM on Docker Desktop). Source address: the network gateway (QUESTIONS #37).
  const onHost = (script: string, input: string): Result => {
    const container = compose('ps', '-q', 'openbao').stdout.trim();
    return run(
      'docker',
      [
        'run',
        '--rm',
        '-i',
        '--network',
        'host',
        // The certificate names openbao, not the IP: map the name to the container's IP (A10).
        '--add-host',
        `openbao:${containerIp(container, network)}`,
        ...baoClientArgs(network),
        '--entrypoint',
        'sh',
        image,
        '-c',
        `IFS= read -r t; [ -n "$t" ] && export BAO_TOKEN="$t"; ${script}`,
      ],
      input,
    );
  };
  const login = (role: Role, via: 'network' | 'openbao' | 'host' = 'network'): Result => {
    const script =
      'IFS= read -r r; IFS= read -r s; printf %s "$s" | bao write -field=token auth/approle/login role_id="$r" secret_id=-';
    const input = `\n${roleIds.get(role)}\n${secretIds.get(role)}\n`;
    if (via === 'host') return onHost(script, input);
    return via === 'network' ? onNetwork(script, input) : inOpenbao(script, input);
  };
  const loginToken = (role: Role): string => keep(ok(login(role), `login ${role}`).stdout.trim());

  // Tries each "op path" and prints "path allowed|denied|error".
  const PROBE = `for p in "$@"; do
      op="\${p%% *}"; path="\${p#* }"
      case "$op" in
        read) out="$(bao read -format=json "$path" 2>&1)" ;;
        sign) out="$(bao write -format=json "$path" input=aGVsbG8= 2>&1)" ;;
      esac && { echo "$path allowed"; continue; }
      case "$out" in *"Code: 403"*) echo "$path denied" ;; *) echo "$path error" ;; esac
    done`;
  const probe = (token: string, ...checks: string[]): Map<string, string> => {
    const r = ok(onNetwork(PROBE, `${token}\n`, checks), 'probe');
    return new Map(
      r.stdout
        .trim()
        .split('\n')
        .map((l) => l.split(' ') as [string, string]),
    );
  };
  const asAdmin = (script: string): Result =>
    ok(onNetwork(script, `${adminToken}\n`), 'admin command');

  // No host port since A11: read the status from a container on the network.
  const sealStatus = (): Promise<SealStatus> => sealStatusOnNetwork(network);
  const newRootToken = (): string => {
    const r = ok(
      bootstrapCmd(['root-token', '--stdout-not-tty'], shares.slice(0, 2).join('\n') + '\n'),
      'root-token',
    );
    const token = keep(r.stdout.trim().split('\n').at(-1)!.trim());
    expect(token.length).toBeGreaterThan(20);
    return token;
  };
  const configure = (token: string, ...args: string[]): Result =>
    bootstrapCmd(['configure', ...args], `${token}\n`);

  beforeAll(() => {
    ok(run(path.join(deployDir, 'scripts/init-env.sh'), [envFile]), 'init-env');
    const text = isolateEnv(fs.readFileSync(envFile, 'utf8'), {
      project,
      subnet,
      gateway,
      portOffset: PORT_OFFSET,
    });
    fs.writeFileSync(envFile, text, { mode: 0o600 });
    image = openbaoImage();
    ok(compose('--profile', 'core', 'up', '-d', '--wait', 'openbao'), 'compose up openbao');
  }, SETUP_TIMEOUT_MS);

  afterAll(() => {
    compose('--profile', 'core', 'down', '--volumes', '--remove-orphans');
    fs.rmSync(tmp, { recursive: true, force: true });
  }, SETUP_TIMEOUT_MS);

  describe('AC1: initialisation, key shares printed once, never to a file', () => {
    it('refuses to print secrets when output is not a terminal', async () => {
      const r = bootstrapCmd(['init']);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/not a terminal/);
      expect((await sealStatus()).initialized).toBe(false);
    });

    it('rejects the test-only option outside the test mode', async () => {
      const r = run(bootstrap, ['init', '--stdout-not-tty'], '', { SDLC_OPENBAO_TEST: '' });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/unknown option/);
      expect((await sealStatus()).initialized).toBe(false);
    });

    it('A11: OpenBao publishes no port; the network gateway is SDLC_NETWORK_GATEWAY', () => {
      const container = compose('ps', '-q', 'openbao').stdout.trim();
      const bindings = hostPortBindings(container);
      expect(Object.keys(bindings)).toContain('8200/tcp');
      for (const [port, binding] of Object.entries(bindings)) expect(binding, port).toBeNull();
      expect(networkGateways(network)).toEqual([gateway]);
    });

    it('initialises with 3 shares, threshold 2, and prints each share once', async () => {
      const r = ok(bootstrapCmd(['init', '--stdout-not-tty']), 'init');
      shares = [...r.stdout.matchAll(/^Unseal Key \d+: (\S+)$/gm)].map((m) => keep(m[1]!));
      firstRootToken = keep(/^Initial Root Token: (\S+)$/m.exec(r.stdout)?.[1] ?? '');
      expect(shares.length).toBe(3); // never the array itself: a failure would print it
      expect(new Set(shares).size).toBe(3);
      expect(firstRootToken.length).toBeGreaterThan(0);
      for (const s of shares) expect(r.stdout.split(s).length - 1).toBe(1);
      expect(await sealStatus()).toMatchObject({ initialized: true, sealed: true, n: 3, t: 2 });
    });

    it('a second init refuses and prints nothing secret', () => {
      const r = bootstrapCmd(['init', '--stdout-not-tty']);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/already initialised/);
      expect(r.stdout).not.toMatch(/Unseal Key|Root Token/);
    });

    it('configure on a sealed OpenBao fails with a clear message', () => {
      const r = configure(firstRootToken);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/OpenBao is sealed; unseal it first/);
    });

    it('one share keeps it sealed; a second share unseals it', async () => {
      // Only one share on stdin: the script stops at end of input, still sealed.
      const one = bootstrapCmd(['unseal'], `${shares[0]}\n`);
      expect(one.status).not.toBe(0);
      expect(one.stderr).toMatch(/still sealed/);
      expect(await sealStatus()).toMatchObject({ sealed: true, progress: 1 });
      ok(bootstrapCmd(['unseal'], `${shares[2]}\n`), 'unseal (2nd share)');
      expect((await sealStatus()).sealed).toBe(false);
    });

    it('no share and no root token is stored in the container or the working folders', () => {
      // grep reads the patterns from stdin, so the secrets never appear on a command line.
      const r = ok(
        composeWith(
          [...shares, firstRootToken].join('\n') + '\n',
          'exec',
          '-T',
          'openbao',
          'sh',
          '-c',
          'grep -rlF -f /dev/stdin /openbao /tmp /root /home /etc /var 2>/dev/null; true',
        ),
        'scan container',
      );
      expect(r.stdout.trim()).toBe('');
      const hostHits: string[] = [];
      const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(p);
          else if (entry.isFile()) {
            const content = fs.readFileSync(p, 'utf8');
            if ([...shares, firstRootToken].some((s) => content.includes(s))) hostHits.push(p);
          }
        }
      };
      walk(tmp);
      walk(deployDir);
      expect(hostHits).toEqual([]);
    });
  });

  describe('AC2: KV v2, Transit Ed25519 key run-contract, AppRoles, policies', () => {
    it('configure applies everything and revokes the root token', () => {
      const r = ok(configure(firstRootToken), 'configure');
      expect(r.stdout).toMatch(/root token is revoked/);
      const lookup = onNetwork('bao read auth/token/lookup-self', `${firstRootToken}\n`);
      expect(lookup.status).not.toBe(0);
      expect(lookup.stderr).toMatch(/Code: 403/);
    });

    it('a platform-admin token (max 1 hour) delivers AppRole credentials', () => {
      const root = newRootToken();
      // Asking for 8 hours still gives at most 1 hour (token role platform-admin).
      adminToken = keep(
        ok(
          onNetwork('bao token create -role=platform-admin -ttl=8h -field=token', `${root}\n`),
          'admin token',
        ).stdout.trim(),
      );
      ok(onNetwork('bao token revoke -self', `${root}\n`), 'revoke root');
      const info = asAdmin(
        'for f in creation_ttl renewable policies; do bao read -field=$f auth/token/lookup-self; echo; done',
      ).stdout.split('\n');
      expect(info.slice(0, 3)).toEqual(['3600', 'false', '[default platform-admin]']);
      for (const role of ROLES) {
        roleIds.set(
          role,
          asAdmin(`bao read -field=role_id auth/approle/role/${role}/role-id`).stdout.trim(),
        );
        secretIds.set(
          role,
          keep(
            asAdmin(
              `bao write -f -field=secret_id auth/approle/role/${role}/secret-id`,
            ).stdout.trim(),
          ),
        );
      }
      // Throw-away values standing in for real secrets.
      asAdmin(
        'bao kv put -mount=kv cost-controller/litellm-master-key value=test-master-key >/dev/null && ' +
          'bao kv put -mount=kv shared/github-app private_key=test-app-key >/dev/null && ' +
          'bao kv put -mount=kv runner/db password=test-runner-db >/dev/null',
      );
    });

    it('the admin token cannot change policies, mounts or the Transit key', () => {
      const result = probe(
        adminToken,
        'read sys/policy/runner',
        'read sys/mounts',
        'read transit/export/signing-key/run-contract',
      );
      expect([...result.values()]).toEqual(['denied', 'denied', 'denied']);
    });

    it('KV is version 2 and the Transit key is Ed25519, not exportable, not deletable', () => {
      const root = newRootToken();
      const r = ok(
        onNetwork(
          'bao read -field=options sys/mounts/kv; echo; for f in type exportable deletion_allowed allow_plaintext_backup latest_version; do bao read -field=$f transit/keys/run-contract; echo; done; bao token revoke -self',
          `${root}\n`,
        ),
        'read config',
      );
      expect(r.stdout.split('\n').map((l) => l.trim())).toEqual(
        expect.arrayContaining(['map[version:2]', 'ed25519', 'false', '1']),
      );
      expect(r.stdout).not.toMatch(/\btrue\b/);
    });

    it('each AppRole logs in from the Compose network', () => {
      for (const role of ROLES) expect(loginToken(role).length).toBeGreaterThan(20);
    });

    it('A11: the bound CIDRs are the subnet without the gateway (QUESTIONS #37)', () => {
      const expected = ok(
        run(path.join(deployDir, 'openbao/cidr-exclude.sh'), [subnet, gateway]),
        'cidr-exclude',
      )
        .stdout.trim()
        .split(',')
        .sort();
      // Reading a role needs a root token (platform-admin cannot): make one, revoke it after.
      const rootToken = newRootToken();
      const read = ok(
        onNetwork(
          'bao read -format=json auth/approle/role/worker; bao token revoke -self >/dev/null',
          `${rootToken}\n`,
        ),
        'read role',
      ).stdout;
      const data = (
        JSON.parse(read) as {
          data: Record<string, string[]>;
        }
      ).data;
      for (const field of ['secret_id_bound_cidrs', 'token_bound_cidrs']) {
        // OpenBao shows a /32 block as a bare address in token_bound_cidrs.
        const listed = (data[field] ?? []).map((c) => (c.includes('/') ? c : `${c}/32`)).sort();
        expect(listed, field).toEqual(expected);
        expect(listed, field).not.toContain(`${gateway}/32`);
      }
    });

    it('A11: a secret ID does not work from the Docker host (source: the gateway)', () => {
      const r = login('runner', 'host');
      expect(r.status).not.toBe(0);
      const audit = inOpenbao(
        'grep "approle/login" /openbao/logs/audit.log | tail -1 | grep -o \'"remote_address":"[^"]*"\'',
        '',
      );
      expect(audit.stdout.trim()).toBe(`"remote_address":"${gateway}"`);
    });

    it('A11: a login token does not work from the Docker host either', () => {
      const token = loginToken('runner');
      const outside = onHost('bao read -field=policies auth/token/lookup-self', `${token}\n`);
      expect(outside.status).not.toBe(0);
      expect(outside.stderr).toMatch(/Code: 403/);
    });

    it('a secret ID does not work outside the bound subnet', () => {
      const r = login('runner', 'openbao');
      expect(r.status).not.toBe(0);
    });

    it('a login token does not work outside the bound subnet (token_bound_cidrs, A04)', () => {
      const token = loginToken('runner');
      const lookup = 'bao read -field=policies auth/token/lookup-self';
      expect(ok(onNetwork(lookup, `${token}\n`), 'lookup on the network').stdout).toMatch(/runner/);
      const outside = inOpenbao(lookup, `${token}\n`);
      expect(outside.status).not.toBe(0);
      expect(outside.stderr).toMatch(/Code: 403/);
    });

    it('worker signs a Run Contract; runner verifies it; runner and api cannot sign', () => {
      const worker = loginToken('worker');
      const sig = ok(
        onNetwork(
          'bao write -field=signature transit/sign/run-contract input=aGVsbG8=',
          `${worker}\n`,
        ),
        'sign',
      ).stdout.trim();
      expect(sig).toMatch(/^vault:v1:/);
      const runner = loginToken('runner');
      const valid = ok(
        onNetwork(
          'bao write -field=valid transit/verify/run-contract input=aGVsbG8= signature="$1"',
          `${runner}\n`,
          [sig],
        ),
        'verify',
      ).stdout.trim();
      expect(valid).toBe('true');
      expect(probe(runner, 'sign transit/sign/run-contract').get('transit/sign/run-contract')).toBe(
        'denied',
      );
      expect(
        probe(loginToken('api'), 'sign transit/sign/run-contract').get('transit/sign/run-contract'),
      ).toBe('denied');
    });
  });

  describe('AC3: each AppRole reads only its own secrets', () => {
    const MASTER_KEY = 'kv/data/cost-controller/litellm-master-key';
    const GITHUB_APP = 'kv/data/shared/github-app';
    const RUNNER_DB = 'kv/data/runner/db';
    const EXPORT = 'transit/export/signing-key/run-contract';
    const expected: Record<Role, Record<string, string>> = {
      api: {
        [MASTER_KEY]: 'denied',
        [GITHUB_APP]: 'allowed',
        [RUNNER_DB]: 'denied',
        [EXPORT]: 'denied',
      },
      worker: {
        [MASTER_KEY]: 'denied',
        [GITHUB_APP]: 'allowed', // QUESTIONS #42: the worker polls GitHub
        [RUNNER_DB]: 'denied',
        [EXPORT]: 'denied',
      },
      runner: {
        [MASTER_KEY]: 'denied',
        [GITHUB_APP]: 'denied', // QUESTIONS #44: the worker hands the runner a wrapped token
        [RUNNER_DB]: 'allowed',
        [EXPORT]: 'denied',
      },
      'cost-controller': {
        [MASTER_KEY]: 'allowed',
        [GITHUB_APP]: 'denied',
        [RUNNER_DB]: 'denied',
        [EXPORT]: 'denied',
      },
    };

    it('runner can NOT read the LiteLLM master key; cost-controller can', () => {
      expect(probe(loginToken('runner'), `read ${MASTER_KEY}`).get(MASTER_KEY)).toBe('denied');
      expect(probe(loginToken('cost-controller'), `read ${MASTER_KEY}`).get(MASTER_KEY)).toBe(
        'allowed',
      );
    });

    it.each(ROLES)('access matrix for %s', (role) => {
      const result = probe(
        loginToken(role),
        ...Object.keys(expected[role]).map((p) => `read ${p}`),
      );
      expect(Object.fromEntries(result)).toEqual(expected[role]);
    });
  });

  describe('AC4: running the bootstrap again keeps the existing configuration', () => {
    let publicKeyBefore = '';

    it('configure runs again with a new root token and succeeds', () => {
      publicKeyBefore = asAdmin('bao read -field=keys transit/keys/run-contract').stdout.trim();
      const r = ok(configure(newRootToken()), 'configure (second run)');
      expect(r.stdout).toMatch(/transit key run-contract already exists; not changed/);
      expect(r.stdout).toMatch(/root token is revoked/);
    });

    it('role IDs, issued secret IDs, stored secrets and the Transit key are unchanged', () => {
      for (const role of ROLES) {
        expect(
          asAdmin(`bao read -field=role_id auth/approle/role/${role}/role-id`).stdout.trim(),
        ).toBe(roleIds.get(role));
        expect(login(role).status).toBe(0);
      }
      expect(asAdmin('bao read -field=keys transit/keys/run-contract').stdout.trim()).toBe(
        publicKeyBefore,
      );
      expect(
        probe(loginToken('cost-controller'), 'read kv/data/cost-controller/litellm-master-key').get(
          'kv/data/cost-controller/litellm-master-key',
        ),
      ).toBe('allowed');
    });

    it('configure refuses a non-root token', () => {
      const r = configure(adminToken);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/root token is required/);
    });

    it('the audit log is on its own volume and holds no clear-text secret', () => {
      const r = composeWith(
        [...shares, 'test-master-key', ...secretIds.values()].join('\n') + '\n',
        'exec',
        '-T',
        'openbao',
        'sh',
        '-c',
        'test -s /openbao/logs/audit.log && grep -cF -f /dev/stdin /openbao/logs/audit.log; true',
      );
      expect(r.stdout.trim()).toBe('0');
      const volumes = run('docker', ['volume', 'ls', '--format', '{{.Name}}']);
      expect(volumes.stdout).toMatch(new RegExp(`^${project}_openbao-audit$`, 'm'));
    });

    it('after a restart OpenBao is sealed again and configure says so', async () => {
      ok(compose('--profile', 'core', 'restart', 'openbao'), 'restart');
      ok(compose('--profile', 'core', 'up', '-d', '--wait', 'openbao'), 'wait healthy');
      expect((await sealStatus()).sealed).toBe(true);
      const r = configure('x');
      expect(r.stderr).toMatch(/OpenBao is sealed; unseal it first/);
    });
  });

  // A10 PR 3a, runbook T11 section 8.3. Runs last: it replaces the key shares.
  describe('A10: rekey for a changed key holder', () => {
    /**
     * `bootstrap.sh rekey` with the current shares on stdin; `answer` gets the new shares it
     * printed and returns what is typed back at the check. The new shares stay in memory only.
     */
    const rekey = (
      current: string[],
      answer: (printed: string[]) => string[],
    ): Promise<Result & { printed: string[] }> =>
      new Promise((resolve, reject) => {
        const child = spawn(bootstrap, ['rekey', '--stdout-not-tty'], {
          env: { ...process.env, SDLC_ENV_FILE: envFile, SDLC_OPENBAO_TEST: '1' },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        let answered = false;
        const printedShares = (): string[] =>
          [...stdout.matchAll(/^Unseal Key \d+: (\S+)$/gm)].map((m) => keep(m[1]!));
        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8');
          if (!answered && /Each holder copies their own share now/.test(stdout)) {
            answered = true;
            child.stdin.end(
              answer(printedShares())
                .map((s) => `${s}\n`)
                .join(''),
            );
          }
        });
        child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
        child.on('error', reject);
        child.on('close', (status) => {
          resolve({ status, stdout, stderr, printed: printedShares() });
        });
        child.stdin.on('error', () => undefined); // the command may stop before it reads
        child.stdin.write(current.map((s) => `${s}\n`).join(''));
        // A run that stops before it prints shares never asks for an answer.
        if (current.length < 2) child.stdin.end();
      });
    const rekeyStarted = (): boolean =>
      /"started": true|"verification_nonce": "[^"]/.test(
        ok(
          inOpenbao('BAO_ADDR=http://127.0.0.1:8210 bao read -format=json sys/rekey/init', '\n'),
          'rekey status',
        ).stdout,
      );
    const unsealWith = (a: string, b: string): Result => bootstrapCmd(['unseal'], `${a}\n${b}\n`);
    const restart = (): void => {
      ok(compose('--profile', 'core', 'restart', 'openbao'), 'restart');
      ok(compose('--profile', 'core', 'up', '-d', '--wait', 'openbao'), 'wait healthy');
    };

    beforeAll(() => {
      ok(unsealWith(shares[0]!, shares[1]!), 'unseal before the rekey');
    });

    it('refuses to print shares when output is not a terminal, and --cancel with another option', () => {
      const r = bootstrapCmd(['rekey'], `${shares[0]}\n${shares[1]}\n`);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/not a terminal/);
      const both = bootstrapCmd(['rekey', '--cancel', '--pgp-keys=/nonexistent']);
      expect(both.status).not.toBe(0);
      expect(both.stderr).toMatch(/--cancel takes no other option/);
      expect(bootstrapCmd(['unseal', '--cancel']).stderr).toMatch(/unknown option: --cancel/);
      expect(rekeyStarted()).toBe(false);
    });

    it('one current share is not enough: nothing printed, no rekey left open', async () => {
      const r = await rekey([shares[0]!], () => []);
      expect(r.status).not.toBe(0);
      expect(redact(r.stderr)).toMatch(/the key shares are unchanged/);
      expect(r.printed.length).toBe(0);
      expect(rekeyStarted()).toBe(false);
    });

    it('a file that is not a PGP public key stops the rekey before any share is asked for', () => {
      const notAKey = path.join(tmp, 'holder.asc');
      fs.writeFileSync(notAKey, 'hello\n');
      const r = bootstrapCmd(
        ['rekey', '--stdout-not-tty', `--pgp-keys=${notAKey},${notAKey},${notAKey}`],
        `${shares[0]}\n${shares[1]}\n`,
      );
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/is not a PGP public key/);
      const two = bootstrapCmd(['rekey', '--stdout-not-tty', `--pgp-keys=${notAKey}`], '');
      expect(two.stderr).toMatch(/is not a PGP public key|needs 3 files/);
      expect(rekeyStarted()).toBe(false);
    });

    it('new shares typed back wrongly: the rekey is dropped and the OLD shares still work', async () => {
      const r = await rekey([shares[0]!, shares[2]!], (printed) => [printed[0]!, shares[1]!]);
      expect(r.status).not.toBe(0);
      expect(r.printed.length).toBe(3);
      expect(redact(r.stderr)).toMatch(/the new key shares were not confirmed/);
      expect(redact(r.stderr)).toMatch(/the rekey is dropped; the key shares are unchanged/);
      expect(redact(r.stderr)).not.toMatch(/KEEP BOTH/);
      expect(rekeyStarted()).toBe(false);
      restart();
      ok(unsealWith(shares[0]!, shares[1]!), 'unseal with the old shares');
      expect((await sealStatus()).sealed).toBe(false);
    });

    it('--cancel drops a rekey that another run left open', async () => {
      // Left open on purpose: started by hand, never updated.
      ok(
        inOpenbao(
          `printf '{"secret_shares":3,"secret_threshold":2}' | BAO_ADDR=http://127.0.0.1:8210 bao write sys/rekey/init - >/dev/null`,
          '\n',
        ),
        'open a rekey',
      );
      expect(rekeyStarted()).toBe(true);
      const blocked = await rekey([shares[0]!, shares[1]!], () => []);
      expect(blocked.status).not.toBe(0);
      expect(blocked.printed.length).toBe(0);
      const r = ok(bootstrapCmd(['rekey', '--cancel']), 'rekey --cancel');
      expect(r.stdout).toMatch(/the key shares are unchanged/);
      expect(rekeyStarted()).toBe(false);
    });

    it('a run killed while it waits for the check leaves a rekey open; --cancel drops it', async () => {
      // The answer never comes: the command is killed hard, so it cannot drop the rekey itself.
      const killed = await new Promise<number | null>((resolve, reject) => {
        const child = spawn(bootstrap, ['rekey', '--stdout-not-tty'], {
          env: { ...process.env, SDLC_ENV_FILE: envFile, SDLC_OPENBAO_TEST: '1' },
          stdio: ['pipe', 'pipe', 'ignore'],
        });
        let stdout = '';
        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8');
          for (const m of stdout.matchAll(/^Unseal Key \d+: (\S+)$/gm)) keep(m[1]!);
          if (/Each holder copies their own share now/.test(stdout)) child.kill('SIGKILL');
        });
        child.on('error', reject);
        child.on('close', (status) => resolve(status));
        child.stdin.on('error', () => undefined);
        child.stdin.write(`${shares[0]}\n${shares[1]}\n`);
      });
      expect(killed).not.toBe(0);
      expect(rekeyStarted()).toBe(true);
      const blocked = await rekey([shares[0]!, shares[1]!], () => []);
      expect(redact(blocked.stderr)).toMatch(/a rekey is already in progress/);
      expect(blocked.printed.length).toBe(0);
      // The refused run must not drop the other run's rekey.
      expect(rekeyStarted()).toBe(true);
      ok(bootstrapCmd(['rekey', '--cancel']), 'rekey --cancel');
      expect(rekeyStarted()).toBe(false);
      restart();
      ok(unsealWith(shares[1]!, shares[2]!), 'unseal with the old shares');
    });

    it('two current shares make 3 new shares; after the check only the NEW shares unseal', async () => {
      const old = [...shares];
      const r = await rekey([old[1]!, old[2]!], (printed) => [printed[2]!, printed[0]!]);
      expect(r.status, redact(r.stderr)).toBe(0);
      expect(r.printed.length).toBe(3);
      expect(new Set([...r.printed, ...old]).size).toBe(6);
      for (const s of r.printed) expect(r.stdout.split(s).length - 1).toBe(1);
      expect(r.stdout).toMatch(/the OLD shares no longer work/);
      expect(rekeyStarted()).toBe(false);
      expect(await sealStatus()).toMatchObject({ sealed: false, n: 3, t: 2 });

      restart();
      const stale = unsealWith(old[0]!, old[1]!);
      expect(stale.status).not.toBe(0);
      expect((await sealStatus()).sealed).toBe(true);
      shares = r.printed;
      ok(unsealWith(shares[0]!, shares[1]!), 'unseal with the new shares');
      expect((await sealStatus()).sealed).toBe(false);
    });

    it('the data is unchanged and a root token comes from the new shares', () => {
      const rootToken = newRootToken();
      const r = ok(
        inOpenbao(
          'BAO_ADDR=http://127.0.0.1:8210 bao read -field=type transit/keys/run-contract; ' +
            'BAO_ADDR=http://127.0.0.1:8210 bao token revoke -self >/dev/null',
          `${rootToken}\n`,
        ),
        'read the Transit key',
      );
      expect(r.stdout.trim()).toBe('ed25519');
    });

    it('no new share is stored in the container or the working folder', () => {
      const r = ok(
        composeWith(
          shares.join('\n') + '\n',
          'exec',
          '-T',
          'openbao',
          'sh',
          '-c',
          'grep -rlF -f /dev/stdin /openbao /tmp /root /home /etc /var 2>/dev/null; true',
        ),
        'scan container',
      );
      expect(r.stdout.trim()).toBe('');
      for (const entry of fs.readdirSync(tmp, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const content = fs.readFileSync(path.join(tmp, entry.name), 'utf8');
        expect(
          shares.some((s) => content.includes(s)),
          entry.name,
        ).toBe(false);
      }
    });
  });
});
