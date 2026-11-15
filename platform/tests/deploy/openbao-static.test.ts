// D-08 task A03: static checks of the OpenBao bootstrap (no Docker needed), design/ADR-M19.
// The live checks are in platform/tests/integration/openbao/bootstrap.test.ts.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { deployDir, loadCompose, parseEnvFile, readDeployFile, root } from './compose';

const BOOTSTRAP = path.join(deployDir, 'openbao/bootstrap.sh');
const SCRIPTS = [
  'openbao/bootstrap.sh',
  'openbao/cidr-exclude.sh',
  'openbao/bootstrap/configure.sh',
  'openbao/bootstrap/root-token.sh',
  'openbao/tls.sh',
];
const settings = parseEnvFile(readDeployFile('openbao/bootstrap/bootstrap.conf'));
const roles = (settings.get('APPROLE_ROLES') ?? '').split(' ').filter(Boolean);
const policyDir = path.join(deployDir, 'openbao/bootstrap/policies');
const policyNames = fs
  .readdirSync(policyDir)
  .filter((f) => f.endsWith('.hcl'))
  .map((f) => f.replace(/\.hcl$/, ''))
  .sort();

interface Rule {
  path: string;
  capabilities: string[];
}

/** Reads the `path "…" { capabilities = [...] }` blocks of a policy file. */
function policyRules(name: string): Rule[] {
  const text = fs.readFileSync(path.join(policyDir, `${name}.hcl`), 'utf8');
  return [...text.matchAll(/path "([^"]+)"\s*\{\s*capabilities\s*=\s*\[([^\]]*)\]\s*\}/g)].map(
    (m) => ({
      path: m[1]!,
      capabilities: [...m[2]!.matchAll(/"([a-z]+)"/g)].map((c) => c[1]!),
    }),
  );
}

/** OpenBao path matching: "+" is one segment, a trailing "*" is any suffix. */
function matches(pattern: string, target: string): boolean {
  const regex = pattern
    .split('')
    .map((ch, i) => {
      if (ch === '+') return '[^/]+';
      if (ch === '*' && i === pattern.length - 1) return '.*';
      return ch.replace(/[.?^${}()|[\]\\/]/g, '\\$&');
    })
    .join('');
  return new RegExp(`^${regex}$`).test(target);
}

const canRead = (name: string, target: string): boolean =>
  policyRules(name).some((r) => matches(r.path, target) && r.capabilities.includes('read'));

const runBootstrap = (args: string[], env: NodeJS.ProcessEnv = {}) =>
  spawnSync(BOOTSTRAP, args, {
    encoding: 'utf8',
    env: { ...process.env, SDLC_OPENBAO_TEST: '', SDLC_ENV_FILE: '/nonexistent/.env', ...env },
  });

describe('OpenBao bootstrap scripts', () => {
  it.each(SCRIPTS)('%s is valid POSIX sh and executable', (file) => {
    const full = path.join(deployDir, file);
    expect(spawnSync('sh', ['-n', full]).status).toBe(0);
    expect(fs.statSync(full).mode & 0o111).not.toBe(0);
  });

  it('never sends init or root-token output to a file or through tee', () => {
    for (const file of SCRIPTS) {
      for (const line of readDeployFile(file).split('\n')) {
        if (/operator init|root-token\.sh/.test(line) && !line.trim().startsWith('#')) {
          expect(line, `${file}: ${line}`).not.toMatch(/\btee\b|[^2&]>\s*[^&/]|>>/);
        }
      }
    }
  });

  it('--help does not mention the test-only option', () => {
    const r = runBootstrap(['--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Usage:/);
    expect(r.stdout + r.stderr).not.toMatch(/stdout-not-tty/);
  });

  it('rejects --stdout-not-tty unless SDLC_OPENBAO_TEST=1', () => {
    for (const cmd of ['init', 'root-token']) {
      const r = runBootstrap([cmd, '--stdout-not-tty']);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/unknown option: --stdout-not-tty/);
    }
    // With the test variable the option is accepted; the run stops later (no env file).
    const r = runBootstrap(['init', '--stdout-not-tty'], { SDLC_OPENBAO_TEST: '1' });
    expect(r.stderr).not.toMatch(/unknown option/);
    expect(r.stderr).toMatch(/not found; run scripts\/init-env\.sh first/);
  });

  it('builds a missing service image before compose run, and reads the accessor from the last line', () => {
    // On a fresh machine `compose run` builds a missing image and prints the build log on stdout,
    // before the accessor (fresh deployment in CI, 2026-10-09).
    const text = fs.readFileSync(BOOTSTRAP, 'utf8');
    const ensure = /^ensure_service_image\(\) \{[\s\S]*?^\}$/m.exec(text)?.[0] ?? '';
    expect(ensure).toContain('config --images "$1"');
    expect(ensure).toMatch(/build "\$1" >&2/);
    for (const fn of ['deliver_approle', 'cmd_litellm_credentials']) {
      const body = new RegExp(`^${fn}\\(\\) \\{[\\s\\S]*?^\\}$`, 'm').exec(text)?.[0] ?? '';
      expect(body, fn).not.toBe('');
      const ensureAt = body.indexOf('ensure_service_image');
      expect(ensureAt, fn).toBeGreaterThan(-1);
      expect(ensureAt, fn).toBeLessThan(body.indexOf(' run --rm -T'));
      const lastLine = body.indexOf(`accessor="$(printf '%s\\n' "$accessor" | tail -n 1)"`);
      expect(lastLine, fn).toBeGreaterThan(-1);
      expect(lastLine, fn).toBeLessThan(body.indexOf('revoke_other_secret_ids'));
    }
  });

  it('refuses unknown commands and options', () => {
    expect(runBootstrap(['destroy']).status).toBe(2);
    expect(runBootstrap(['init', '--keep-token']).stderr).toMatch(/unknown option/);
  });
});

describe('OpenBao bootstrap settings (bootstrap.conf)', () => {
  it('uses 3 key shares with an unseal threshold of 2 (D-03 section 10.2)', () => {
    expect(settings.get('BAO_KEY_SHARES')).toBe('3');
    expect(settings.get('BAO_KEY_THRESHOLD')).toBe('2');
  });

  it('uses an Ed25519 Transit key named run-contract (D-08 A03 AC2)', () => {
    expect(settings.get('TRANSIT_KEY')).toBe('run-contract');
    expect(settings.get('TRANSIT_KEY_TYPE')).toBe('ed25519');
  });

  it('rotates the Run Contract signing key every 90 days by itself (O05, ADR-M102)', () => {
    expect(settings.get('TRANSIT_AUTO_ROTATE_PERIOD')).toBe('2160h');
  });

  it('has the approved token and secret ID lifetimes', () => {
    expect(settings.get('APPROLE_TOKEN_TTL')).toBe('1h');
    expect(settings.get('APPROLE_TOKEN_MAX_TTL')).toBe('4h');
    expect(settings.get('APPROLE_SECRET_ID_TTL')).toBe('2160h'); // 90 days, never unlimited
    expect(settings.get('ADMIN_TOKEN_MAX_TTL')).toBe('1h');
    expect(settings.get('SECRET_ID_BOUND_CIDRS')).toBe('compose-network');
  });

  it('has one AppRole per platform process (AC2), the LiteLLM sidecar (C03), the backup job (A10), one policy each', () => {
    expect(roles).toEqual(['api', 'worker', 'runner', 'cost-controller', 'litellm', 'backup']);
    expect(policyNames).toEqual([...roles, 'platform-admin'].sort());
  });
});

describe('the signing key rotates on its own (configure.sh, O05, ADR-M102)', () => {
  const configure = readDeployFile('openbao/bootstrap/configure.sh');

  it('sets auto_rotate_period on the key, also on an existing key, and checks it', () => {
    expect(configure).toContain('rotate_period="$(setting TRANSIT_AUTO_ROTATE_PERIOD)"');
    expect(configure).toMatch(
      /bao write "\$key_path\/config" auto_rotate_period="\$rotate_period"/,
    );
    expect(configure).toMatch(/bao read -field=auto_rotate_period "\$key_path"/);
  });

  it('refuses a period that is not whole hours of at least 1h', () => {
    expect(configure).toMatch(/TRANSIT_AUTO_ROTATE_PERIOD must be/);
  });

  it("never raises min_decryption_version: revoking an old version is a person's step (T11 §8.4)", () => {
    expect(configure).not.toMatch(/min_decryption_version/);
  });
});

describe('rotate-credentials (bootstrap.sh, O05, ADR-M102)', () => {
  const bootstrap = fs.readFileSync(BOOTSTRAP, 'utf8');
  const body = bootstrap.slice(
    bootstrap.indexOf('cmd_rotate_credentials() {'),
    bootstrap.indexOf('\n}\n', bootstrap.indexOf('cmd_rotate_credentials() {')),
  );

  it('is a command of bootstrap.sh, listed in its usage', () => {
    expect(bootstrap).toMatch(/^\s+rotate-credentials\)\s+cmd_rotate_credentials ;;$/m);
    expect(bootstrap).toMatch(/\| rotate-credentials[ )|]/);
    expect(bootstrap).toMatch(/^ {2}rotate-credentials {2,}\S/m);
  });

  it('asks for the admin token once and renews exactly the AppRole secret IDs doctor watches', () => {
    expect(body.match(/read_secret '/g)).toHaveLength(1);
    const calls = [...body.matchAll(/\b(cmd_[a-z_]+_credentials)\b/g)]
      .map((m) => m[1])
      .filter((name) => name !== 'cmd_rotate_credentials');
    expect([...new Set(calls)]).toEqual([
      'cmd_api_credentials',
      'cmd_worker_credentials',
      'cmd_runner_credentials',
      'cmd_litellm_credentials',
      'cmd_backup_credentials',
    ]);
  });

  it('skips an AppRole that has no secret ID yet (a profile or feature not set up)', () => {
    expect(bootstrap).toMatch(/secret_id_state\(\) \{[\s\S]*?auth\/approle\/role\/\$1\/secret-id/);
    expect(body).toMatch(/not set up here; skipped/);
    // A wrong token must not look like "nothing set up": it is checked first.
    expect(body.indexOf('bao token lookup')).toBeLessThan(body.indexOf('for role in'));
  });
});

describe('AppRoles (configure.sh)', () => {
  const configure = readDeployFile('openbao/bootstrap/configure.sh');

  it('binds secret IDs and login tokens to the same CIDRs (A04, ADR-M21 §2.5)', () => {
    expect(configure).toMatch(/^\s+secret_id_bound_cidrs="\$role_cidrs" \\$/m);
    expect(configure).toMatch(/^\s+token_bound_cidrs="\$role_cidrs" \\$/m);
    expect(configure).toMatch(/^\s+role_cidrs="\$cidrs"$/m);
  });

  it('only the AppRole runner also accepts SDLC_RUNNER_SOURCE_CIDR (O01, QUESTIONS #596)', () => {
    const assignments = configure.match(/^\s+(\[.*\] && )*role_cidrs=.*$/gm) ?? [];
    expect(assignments.map((l) => l.trim())).toEqual([
      'role_cidrs="$cidrs"',
      '[ "$role" = runner ] && [ -n "$runner_cidr" ] && role_cidrs="$cidrs,$runner_cidr"',
    ]);
    const bootstrap = readDeployFile('openbao/bootstrap.sh');
    expect(bootstrap).toContain('sed -n \'s/^SDLC_RUNNER_SOURCE_CIDR=//p\' "$env_file"');
    // One IPv4 block, checked before it reaches OpenBao.
    expect(bootstrap).toContain(
      "grep -Eq '^([0-9]{1,3}\\.){3}[0-9]{1,3}/([0-9]|[12][0-9]|3[0-2])$'",
    );
    expect(bootstrap).toContain('set -- "$@" --runner-cidr "$runner_cidr"');
  });
});

describe('OpenBao policies', () => {
  const allPolicies = policyNames;

  it('every policy file parses into at least one rule', () => {
    for (const name of allPolicies) expect(policyRules(name).length, name).toBeGreaterThan(0);
  });

  it('no policy touches sys/ (except worker wrapping), Transit export, backup, restore or key changes', () => {
    for (const name of allPolicies) {
      for (const rule of policyRules(name)) {
        // One exception (QUESTIONS #44): the worker wraps the run token for the runner.
        if (name === 'worker' && rule.path === 'sys/wrapping/wrap') {
          expect(rule.capabilities).toEqual(['update']);
          continue;
        }
        // X04 PR 3b (QUESTIONS #540): the worker revokes the database logins of one run's tools,
        // `kdocs-<run_id>` only; revoke-prefix needs `sudo`.
        if (name === 'worker' && rule.path === 'sys/leases/revoke-prefix/database/creds/kdocs-*') {
          expect(rule.capabilities).toEqual(['update', 'sudo']);
          continue;
        }
        // The worker makes and deletes the database role of one run only (`kdocs-<run_id>`).
        if (name === 'worker' && rule.path === 'database/roles/kdocs-*') {
          expect(rule.capabilities).toEqual(['create', 'update', 'delete']);
          continue;
        }
        // The other (A10, ADR-M63 §5, QUESTIONS #328): the backup job reads the Raft snapshot only.
        if (name === 'backup') {
          expect(rule).toEqual({ path: 'sys/storage/raft/snapshot', capabilities: ['read'] });
          continue;
        }
        expect(rule.path, name).not.toMatch(/^sys\/|^transit\/(export|backup|restore)\//);
        if (rule.path.startsWith('transit/keys/'))
          expect(rule.capabilities, name).toEqual(['read']);
        expect(rule.capabilities, name).not.toContain('delete');
        expect(rule.capabilities, name).not.toContain('sudo');
      }
    }
  });

  it('only cost-controller and the LiteLLM sidecar can read the LiteLLM master key (AC3, C03)', () => {
    const target = 'kv/data/cost-controller/litellm-master-key';
    expect(roles.filter((r) => canRead(r, target))).toEqual(['cost-controller', 'litellm']);
    expect(canRead('runner', target)).toBe(false);
  });

  it('only the LiteLLM sidecar can read model provider keys and the salt key (QUESTIONS #1)', () => {
    expect(roles.filter((r) => canRead(r, 'kv/data/litellm/providers/anthropic'))).toEqual([
      'litellm',
    ]);
    expect(roles.filter((r) => canRead(r, 'kv/data/litellm/salt-key'))).toEqual(['litellm']);
  });

  it('the LiteLLM sidecar reads exactly its keys and the master key, and writes nothing (C03)', () => {
    expect(policyRules('litellm')).toEqual([
      { path: 'kv/data/litellm/providers/*', capabilities: ['read'] },
      { path: 'kv/metadata/litellm/providers/*', capabilities: ['list'] },
      { path: 'kv/data/litellm/salt-key', capabilities: ['read'] },
      { path: 'kv/data/cost-controller/litellm-master-key', capabilities: ['read'] },
    ]);
    expect(canRead('litellm', 'kv/data/cost-controller/other')).toBe(false);
    expect(canRead('litellm', 'kv/data/shared/github-app')).toBe(false);
  });

  it('only api and worker can read the GitHub App key; not the runner (D-03 §8.2, QUESTIONS #42, #44)', () => {
    expect(roles.filter((r) => canRead(r, 'kv/data/shared/github-app'))).toEqual(['api', 'worker']);
  });

  it('the worker policy states the wrapping it needs (QUESTIONS #44); no other policy adds it', () => {
    // OpenBao's built-in `default` policy also allows sys/wrapping/wrap for every token. Wrapping
    // only packages data the caller already holds, so it grants no access (ADR-M25 §2.11); the
    // worker line keeps the handoff working even if the default policy is ever tightened.
    const wrappers = roles.filter((r) =>
      policyRules(r).some((rule) => matches(rule.path, 'sys/wrapping/wrap')),
    );
    expect(wrappers).toEqual(['worker']);
  });

  it('each AppRole reads only its own kv subtree besides shared/github-app', () => {
    // litellm reads only the provider keys and the salt key inside its subtree (C03).
    const own = (role: string) =>
      role === 'litellm' ? 'kv/data/litellm/providers/x' : `kv/data/${role}/x`;
    for (const role of roles) {
      for (const other of roles.filter((r) => r !== role)) {
        expect(canRead(role, `kv/data/${other}/x`), `${role} → ${other}`).toBe(false);
      }
      // The backup job reads no secret at all, only the Raft snapshot (A10).
      expect(canRead(role, own(role)), role).toBe(role !== 'backup');
    }
  });

  it('only worker can sign Run Contracts', () => {
    const signers = roles.filter((r) =>
      policyRules(r).some((rule) => matches(rule.path, 'transit/sign/run-contract')),
    );
    expect(signers).toEqual(['worker']);
  });
});

describe('OpenBao in Compose', () => {
  const compose = loadCompose();
  const openbao = compose.services.openbao!;
  const hcl = readDeployFile('openbao/openbao.hcl');

  it('mounts the bootstrap folder read-only, outside the server config folder', () => {
    expect(openbao.volumes).toContain('./openbao/bootstrap:/openbao/bootstrap:ro');
  });

  it('keeps the audit log on its own named volume', () => {
    expect(openbao.volumes).toContain('openbao-audit:/openbao/logs');
    expect(readDeployFile('docker-compose.yml')).toMatch(/^ {2}openbao-audit:$/m);
  });

  it('declares a file audit device in openbao.hcl, writing to the audit volume', () => {
    expect(hcl).toMatch(
      /audit "file" "file" \{[^}]*file_path\s*=\s*"\/openbao\/logs\/audit\.log"/s,
    );
  });

  it('opens the key-share endpoints only on the in-container listener 127.0.0.1:8210', () => {
    const listeners = [...hcl.matchAll(/listener "tcp" \{([^}]*)\}/g)].map((m) => m[1]!);
    expect(listeners).toHaveLength(2);
    const [main, keyHolder] = listeners;
    expect(main).toMatch(/address\s*=\s*"0\.0\.0\.0:8200"/);
    expect(main).not.toMatch(/disable_unauthed/);
    // A10 (ADR-M63): TLS on the Compose network; the in-container listener stays plain.
    expect(main).not.toMatch(/tls_disable/);
    expect(main).toMatch(/tls_cert_file\s*=\s*"\/openbao\/tls\/server\.pem"/);
    expect(main).toMatch(/tls_key_file\s*=\s*"\/openbao\/tls\/server-key\.pem"/);
    expect(keyHolder).toMatch(/tls_disable\s*=\s*true/);
    expect(hcl).toMatch(/api_addr\s*=\s*"https:\/\/openbao:8200"/);
    expect(keyHolder).toMatch(/address\s*=\s*"127\.0\.0\.1:8210"/);
    expect(keyHolder).toMatch(/disable_unauthed_generate_root_endpoints\s*=\s*false/);
    expect(openbao.ports).toBeUndefined();
  });

  it('pins the Compose network subnet and gateway that secret IDs are bound to', () => {
    expect(readDeployFile('docker-compose.yml')).toMatch(
      /- subnet: \$\{SDLC_NETWORK_SUBNET:-172\.30\.0\.0\/24\}\n\s+gateway: \$\{SDLC_NETWORK_GATEWAY:-172\.30\.0\.1\}/,
    );
    const env = parseEnvFile(readDeployFile('.env.example'));
    expect(env.get('SDLC_NETWORK_SUBNET')).toBe('172.30.0.0/24');
    expect(env.get('SDLC_NETWORK_GATEWAY')).toBe('172.30.0.1');
  });

  it('configure binds AppRoles to the subnet without the gateway (QUESTIONS #37)', () => {
    const bootstrap = readDeployFile('openbao/bootstrap.sh');
    expect(bootstrap).toMatch(/\{\{\.Subnet\}\}\|\{\{\.Gateway\}\}/);
    expect(bootstrap).toMatch(/"\$deploy_dir\/openbao\/cidr-exclude\.sh" "\$subnet" "\$gateway"/);
  });
});

// A file that exists locally but is Git-ignored (for example by the `*.env` rule) passes every
// local test and is missing in CI. These checks fail locally for that class of error.
describe('files used by the OpenBao bootstrap are tracked by Git', () => {
  const tracked = new Set(
    execFileSync('git', ['ls-files', '-z', '--', 'platform/deploy'], {
      cwd: root,
      encoding: 'utf8',
    })
      .split('\0')
      .filter(Boolean),
  );
  const repoPath = (full: string): string => path.relative(root, full).split(path.sep).join('/');
  const trackedUnder = (dir: string): string[] =>
    [...tracked].filter((f) => f.startsWith(`${repoPath(dir)}/`));
  const filesOnDisk = (dir: string): string[] =>
    fs
      .readdirSync(dir, { withFileTypes: true, recursive: true })
      .filter((e) => e.isFile())
      .map((e) => path.join(e.parentPath, e.name));

  // Bind mounts of the openbao service: host path (under platform/deploy) → container path.
  const mounts = (loadCompose().services.openbao?.volumes ?? [])
    .map((v) => v.split(':'))
    .filter(([source]) => source!.startsWith('./'))
    .map(([source, target]) => ({ host: path.join(deployDir, source!), container: target! }));

  it('every bind-mounted file and every file inside a mounted folder is tracked', () => {
    expect(mounts.length).toBeGreaterThan(0);
    for (const { host } of mounts) {
      const isDir = fs.existsSync(host) && fs.statSync(host).isDirectory();
      if (isDir) {
        expect(trackedUnder(host).length, repoPath(host)).toBeGreaterThan(0);
        for (const file of filesOnDisk(host))
          expect(tracked.has(repoPath(file)), repoPath(file)).toBe(true);
      } else {
        expect(tracked.has(repoPath(host)), repoPath(host)).toBe(true);
      }
    }
  });

  it('every file the bootstrap scripts refer to is tracked', () => {
    // Host path of a path written in a script: $deploy_dir/… on the host; $in_container/…,
    // $dir/… and /openbao/bootstrap/… inside the container (mapped back through the mounts).
    const bootstrapMount = mounts.find((m) => m.container === '/openbao/bootstrap');
    expect(bootstrapMount).toBeDefined();
    const prefixes: [RegExp, string][] = [
      [/\$deploy_dir\/([\w./*-]+)/g, deployDir],
      [/\$(?:in_container|dir)\/([\w./*-]+)/g, bootstrapMount!.host],
      [/\/openbao\/bootstrap\/([\w./*-]+)/g, bootstrapMount!.host],
    ];
    const referenced = new Set<string>();
    for (const script of SCRIPTS) {
      const code = readDeployFile(script)
        .split('\n')
        .filter((line) => !line.trim().startsWith('#'))
        .join('\n');
      for (const [pattern, base] of prefixes) {
        for (const m of code.matchAll(pattern)) {
          const rel = m[1]!.replace(/\/$/, '');
          if (rel) referenced.add(repoPath(path.join(base, rel)));
        }
      }
    }
    expect([...referenced]).toEqual(
      expect.arrayContaining([
        'platform/deploy/openbao/bootstrap/bootstrap.conf',
        'platform/deploy/openbao/bootstrap/configure.sh',
        'platform/deploy/openbao/bootstrap/root-token.sh',
      ]),
    );
    // The only exception: the Compose env file holds secrets. init-env.sh creates it; it must
    // never be tracked (and is checked to be Git-ignored in compose-static.test.ts).
    const NEVER_TRACKED = new Set(['platform/deploy/.env']);
    for (const ref of [...referenced].filter((r) => !NEVER_TRACKED.has(r))) {
      if (ref.includes('*')) {
        const regex = new RegExp(`^${ref.replace(/[.]/g, '\\.').replace(/\*/g, '[^/]*')}$`);
        expect(
          [...tracked].some((f) => regex.test(f)),
          ref,
        ).toBe(true);
      } else {
        const isTrackedFile = tracked.has(ref);
        const isTrackedDir = [...tracked].some((f) => f.startsWith(`${ref}/`));
        expect(isTrackedFile || isTrackedDir, ref).toBe(true);
      }
    }
  });

  it('bootstrap.conf is not Git-ignored', () => {
    const r = spawnSync(
      'git',
      ['check-ignore', '-q', '--no-index', 'platform/deploy/openbao/bootstrap/bootstrap.conf'],
      { cwd: root },
    );
    expect(r.status).toBe(1); // 1 = not ignored
  });
});

describe('github-webhook-secret (bootstrap.sh, O08, ADR-M112 §2.8)', () => {
  const bootstrap = fs.readFileSync(BOOTSTRAP, 'utf8');
  const start = bootstrap.indexOf('cmd_github_webhook_secret() {');
  const body = bootstrap.slice(start, bootstrap.indexOf('\n}\n', start));

  it('is a command of bootstrap.sh, listed in its usage', () => {
    expect(bootstrap).toMatch(/^\s+github-webhook-secret\)\s+cmd_github_webhook_secret ;;$/m);
    expect(bootstrap).toMatch(/\| github-webhook-secret[ )|]/);
    expect(bootstrap).toMatch(/^ {2}github-webhook-secret\n {23}\S/m);
  });

  it('stores the secret where only the api reads it, through stdin, never an argument', () => {
    expect(canRead('api', 'kv/data/api/github-webhook')).toBe(true);
    for (const other of policyNames.filter((n) => !['api', 'platform-admin'].includes(n))) {
      expect(canRead(other, 'kv/data/api/github-webhook'), other).toBe(false);
    }
    expect(body).toContain('bao kv put -mount=kv api/github-webhook -');
    // The value travels on stdin only: never on a command line of the host or the container.
    const execCall = body.slice(
      body.indexOf('bao_exec'),
      body.indexOf('||', body.indexOf('bao_exec')),
    );
    expect(execCall).not.toContain('$webhook_secret');
    expect(body).toContain('unset webhook_secret');
    expect(body).toContain('od -An -tx1 -N32 /dev/urandom');
    // Shown once, then the screen and its scroll-back are cleared.
    expect(body).toContain("printf '\\033[2J\\033[3J\\033[H'");
  });

  it('refuses to run without a terminal, before asking for anything', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-o08-'));
    try {
      const env = path.join(tmp, '.env');
      fs.writeFileSync(env, 'COMPOSE_PROJECT_NAME=sdlc-test\n', { mode: 0o600 });
      const r = runBootstrap(['github-webhook-secret'], { SDLC_ENV_FILE: env });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/run it in your own terminal/);
      expect(r.stdout).toBe('');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
