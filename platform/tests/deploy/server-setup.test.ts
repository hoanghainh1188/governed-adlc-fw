// D-08 V16 AC2–AC6: `pnpm server:setup` against a simulated OpenBao, Compose and database (a fake
// `exec`) and a scripted terminal. What it checks:
// - key custody: `-pgp-keys` with the holders' keys (the default), else one share per holder, the
//   screen and scroll-back cleared after each copy; no share in any file;
// - the root token reaches `configure` only, one admin token covers steps 4 and 5, a stop before
//   `configure` revokes the root token, no token on a command line or in an environment variable;
// - each step skips what is done on a second start, and a stop is reported on the next start;
// - the settings file and the progress file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { MessageKey, MessageParams } from '@sdlc/messages';

import type { Exec, ExecOptions } from '../../deploy/steps/dist/exec.js';
import { CREDENTIALS_COMMANDS } from '../../deploy/steps/dist/fresh-deployment.js';
import { SecretBag } from '../../deploy/steps/dist/secrets.js';
import {
  parseProgress,
  progressFileFor,
  readProgress,
} from '../../deploy/server-setup/src/progress.js';
import {
  accessOrigin,
  parseSettings,
  pgpKeyBase64,
  SettingsError,
  usesPgp,
  type ServerSettings,
} from '../../deploy/server-setup/src/settings.js';
import {
  applyEnvKeys,
  EnvKeyConflict,
  settingsEnvKeys,
} from '../../deploy/server-setup/src/env-keys.js';
import {
  isTrialProject,
  serverSetup,
  SetupRefused,
  SetupStopped,
} from '../../deploy/server-setup/src/setup.js';
import {
  CLEAR_SCREEN,
  PromptAborted,
  terminalRefusal,
  type Terminal,
} from '../../deploy/server-setup/src/terminal.js';
import { repoRoot } from '../workspace/helpers.js';

const KEYS = { shares: 3, threshold: 2 } as const;
/** The fake env file's made-up database passwords (kept out of `KEY=value` literals: Gitleaks). */
const OWNER_DB = ['pw', 'owner', '0123456789'].join('-');
const APP_DB = ['pw', 'app', '0123456789'].join('-');
/** The armor header of a PGP secret key, built from parts so secret scanners skip the test. */
const SECRET_KEY_HEADER = ['-----BEGIN PGP', 'PRIVATE KEY BLOCK-----'].join(' ');
const temp: string[] = [];
afterEach(() => {
  for (const dir of temp.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

interface Call {
  readonly cmd: string;
  readonly args: readonly string[];
  readonly opts: ExecOptions;
}

/** A tiny OpenBao: tokens, shares, KV paths and delivered credentials, all in memory. */
class FakeHost {
  state: 'uninitialised' | 'sealed' | 'unsealed' = 'uninitialised';
  readonly plainShares = [
    'share-one-AAAAAAAAAAAAAAAAAAAAAA',
    'share-two-BBBBBBBBBBBBBBBBBBBBBB',
    'share-three-CCCCCCCCCCCCCCCCCCCC',
  ];
  readonly roots = new Set<string>();
  readonly admins = new Set<string>();
  readonly revoked = new Set<string>();
  readonly kv = new Map<string, string>();
  readonly delivered: string[] = [];
  readonly calls: Call[] = [];
  pgpKeysAtInit = -1;
  configureRuns = 0;
  migrations = 2;
  /** A call that fails: return true to make it exit 1. */
  failWhen: (c: Call) => boolean = () => false;
  private serial = 0;

  constructor(private readonly envFile: string) {}

  /** Every secret the fake made: none of them may be in an argument or an environment value. */
  get secrets(): string[] {
    return [...this.plainShares, ...this.roots, ...this.admins, ...this.revoked, OWNER_DB, APP_DB];
  }

  private token(kind: 'root' | 'admin'): string {
    this.serial += 1;
    const t = `${kind === 'root' ? 's.ROOT' : 'hvs.ADMIN'}${String(this.serial).padStart(24, '0')}`;
    (kind === 'root' ? this.roots : this.admins).add(t);
    return t;
  }

  private valid(t: string): 'root' | 'admin' | undefined {
    if (this.revoked.has(t)) return undefined;
    if (this.roots.has(t)) return 'root';
    if (this.admins.has(t)) return 'admin';
    return undefined;
  }

  readonly exec: Exec = (cmd, args, opts = {}) => {
    const call = { cmd, args, opts };
    this.calls.push(call);
    if (this.failWhen(call)) return Promise.resolve({ status: 1, stdout: '', stderr: 'boom' });
    return Promise.resolve(this.answer(call));
  };

  private answer({ cmd, args, opts }: Call): { status: number; stdout: string; stderr: string } {
    const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
    const fail = (stderr: string) => ({ status: 1, stdout: '', stderr });
    const input = (opts.input ?? '').split('\n');
    const base = path.basename(cmd);
    if (base === 'init-env.sh') {
      // Like the real script (R078): it never overwrites an env file.
      if (fs.existsSync(this.envFile)) {
        return fail(`init-env: ${this.envFile} already exists; not overwriting.`);
      }
      {
        fs.writeFileSync(
          this.envFile,
          [
            'COMPOSE_PROJECT_NAME=sdlcsrv',
            `PLATFORM_DB_PASSWORD=${OWNER_DB}`,
            `PLATFORM_APP_DB_PASSWORD=${APP_DB}`,
            'LITELLM_MASTER_KEY=sk-from-init-env-000000000000',
            'LITELLM_SALT_KEY=sk-from-init-env-111111111111',
            'POSTGRES_HOST_PORT=5432',
            '',
          ].join('\n'),
          { mode: 0o600 },
        );
      }
      return ok();
    }
    if (base === 'bootstrap.sh') {
      const [command, ...rest] = args;
      if (command === 'status') return ok(`bootstrap: OpenBao is ${this.state}\n`);
      if (command === 'unseal') {
        const given = input.filter((l) => l !== '');
        if (given.length < KEYS.threshold || !given.every((s) => this.plainShares.includes(s)))
          return fail('the key share was rejected');
        this.state = 'unsealed';
        return ok('bootstrap: OpenBao is unsealed\n');
      }
      if (command === 'configure') {
        if (this.valid(input[0] ?? '') !== 'root') return fail('a root token is required');
        this.configureRuns += 1;
        const admin = rest.includes('--issue-admin-token') ? this.token('admin') : '';
        if (!rest.includes('--keep-token')) this.revoked.add(input[0]!);
        return ok(
          `configure: done; the root token is revoked\n${admin ? `admin-token: ${admin}\n` : ''}`,
        );
      }
      if (command?.endsWith('-credentials')) {
        if (this.valid(input[0] ?? '') !== 'admin') return fail('permission denied');
        if (command === 'api-github-oauth-credentials' && opts.detached !== true)
          return fail('would read /dev/tty');
        this.delivered.push(command);
        return ok(`delivered ${command}\n`);
      }
      return fail(`unexpected bootstrap ${command}`);
    }
    if (cmd === 'docker') {
      const exec = args.indexOf('exec');
      if (exec < 0) return ok(); // up -d --wait, restart
      const script = args.at(-1) ?? '';
      if (script.includes('operator init')) {
        if (this.state !== 'uninitialised') return fail('already initialised');
        this.pgpKeysAtInit = input.filter((l) => l !== '').length;
        this.state = 'sealed';
        const shares =
          this.pgpKeysAtInit > 0
            ? this.plainShares.map((s) => `wcBMA${Buffer.from(s).toString('base64')}`)
            : this.plainShares;
        return ok(JSON.stringify({ unseal_keys_b64: shares, root_token: this.token('root') }));
      }
      if (script === '/openbao/bootstrap/root-token.sh') {
        const given = input.filter((l) => l !== '');
        if (!given.every((s) => this.plainShares.includes(s))) return fail('rejected');
        return ok(`${this.token('root')}\n`);
      }
      const token = input[0] ?? '';
      // A sealed OpenBao answers no token question: never "invalid".
      if (this.state !== 'unsealed') return fail('Error: Vault is sealed');
      if (script.includes('auth/token/accessors')) {
        if (this.valid(token) !== 'root') return fail('permission denied');
        const others = [...this.roots].filter((r) => r !== token && this.valid(r));
        for (const r of others) this.revoked.add(r);
        return ok(`revoked=${others.length}\n`);
      }
      if (script.includes('token revoke -self')) {
        if (!this.valid(token)) return fail('Error: permission denied');
        this.revoked.add(token);
        return ok();
      }
      if (script.includes('token lookup -self')) {
        return this.valid(token) ? ok('3400\n') : fail('Error: permission denied');
      }
      const put = /kv put -mount=kv ([a-z/-]+)/g;
      if (script.includes('kv put')) {
        // Steps 4 and 7 use the admin token, never a root token.
        if (this.valid(token) !== 'admin') return fail('permission denied');
        for (const m of script.matchAll(put)) this.kv.set(m[1]!, 'set');
        return ok();
      }
      return fail(`unexpected docker exec ${script}`);
    }
    if (cmd === 'node' && args[0]?.endsWith('migrate-cli.js')) {
      if (!(opts.input ?? '').startsWith(`postgres://platform:${OWNER_DB}@`)) return fail('no url');
      const applied = Array.from(
        { length: this.migrations },
        (_, i) => `Applied migration 00${i}.`,
      );
      this.migrations = 0;
      return ok(applied.length ? `${applied.join('\n')}\n` : 'The database is up to date.\n');
    }
    if (cmd === 'node' && args[0]?.endsWith('doctor/dist/main.js'))
      return ok('doctor: all checks pass\n');
    if (base === 'up.sh') return ok('up: done\n');
    if (base === 'tls.sh' && args[0] === 'import') return ok('access-tls: copied\n');
    return fail(`unexpected ${cmd}`);
  }
}

type Event =
  | { kind: 'say' | 'warn' | 'pause' | 'hidden'; key: MessageKey; params?: MessageParams }
  | { kind: 'secret'; text: string }
  | { kind: 'clear' }
  | { kind: 'print'; text: string };

/** A terminal that answers prompts from the holders' plain shares and the given answers. */
class ScriptedTerminal implements Terminal {
  readonly events: Event[] = [];
  private shareIndex = 0;
  abortAt?: (key: MessageKey) => boolean;
  onSay?: (key: MessageKey) => void;
  constructor(private readonly host: FakeHost) {}
  say(key: MessageKey, params?: MessageParams) {
    this.events.push({ kind: 'say', key, ...(params ? { params } : {}) });
    this.onSay?.(key);
  }
  warn(key: MessageKey, params?: MessageParams) {
    this.events.push({ kind: 'warn', key, ...(params ? { params } : {}) });
  }
  print(text: string) {
    this.events.push({ kind: 'print', text });
  }
  hidden(key: MessageKey, params?: MessageParams): Promise<string> {
    this.events.push({ kind: 'hidden', key, ...(params ? { params } : {}) });
    if (this.abortAt?.(key)) return Promise.reject(new PromptAborted());
    if (key === 'server_setup.share.prompt') {
      const share = this.host.plainShares[this.shareIndex % KEYS.threshold]!;
      this.shareIndex += 1;
      return Promise.resolve(share);
    }
    if (key === 'server_setup.secret.provider_key')
      return Promise.resolve('sk-ant-typed-000000000000');
    if (key === 'server_setup.langfuse.public_key') return Promise.resolve('pk-lf-0000');
    if (key === 'server_setup.langfuse.secret_key') return Promise.resolve('sk-lf-0000');
    if (key === 'server_setup.secret.github_client_secret')
      return Promise.resolve('client-secret-00000000000000');
    return Promise.reject(new Error(`unexpected prompt ${key}`));
  }
  pause(key: MessageKey, params?: MessageParams): Promise<void> {
    this.events.push({ kind: 'pause', key, ...(params ? { params } : {}) });
    if (this.abortAt?.(key)) return Promise.reject(new PromptAborted());
    return Promise.resolve();
  }
  showSecret(text: string) {
    this.events.push({ kind: 'secret', text });
  }
  clear() {
    this.events.push({ kind: 'clear' });
  }
  said(key: MessageKey): boolean {
    return this.events.some((e) => 'key' in e && e.key === key);
  }
}

function fixture(overrides: Partial<ServerSettings> = {}, pgp = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-server-setup-'));
  temp.push(dir);
  const file = (name: string, text: string) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, text, { mode: 0o600 });
    return p;
  };
  const appKeyFile = file(
    'app.pem',
    '-----BEGIN RSA PRIVATE KEY-----\nMIIfake\n-----END RSA PRIVATE KEY-----\n',
  );
  const envFile = path.join(dir, 'deploy.env');
  const holders = ['Ana', 'Binh', 'Chi'].map((name) =>
    pgp ? { name, pgpKeyFile: file(`${name}.asc`, armoredKey()) } : { name },
  );
  const settings: ServerSettings = {
    keyHolders: holders,
    appClientId: 'Iv23test',
    appKeyFile,
    providers: [{ provider: 'anthropic' }],
    optional: [],
    throwawayTls: true,
    envFile,
    ...overrides,
  };
  const host = new FakeHost(envFile);
  const term = new ScriptedTerminal(host);
  let stop = false;
  const deps = {
    repoRoot: dir,
    envFile,
    exec: host.exec,
    terminal: term,
    bag: new SecretBag(),
    keys: KEYS,
    stopRequested: () => stop,
    now: () => new Date('2026-10-29T08:00:00Z'),
  };
  return { dir, envFile, settings, host, term, deps, requestStop: () => (stop = true) };
}

/** An armored PGP public key: a public-key packet (tag 6, new format 0xC6). */
function armoredKey(): string {
  const body = Buffer.concat([Buffer.from([0xc6, 0x33, 0x04]), Buffer.alloc(120, 7)]).toString(
    'base64',
  );
  return `-----BEGIN PGP PUBLIC KEY BLOCK-----\nComment: test\n\n${body.match(/.{1,64}/g)!.join('\n')}\n=abcd\n-----END PGP PUBLIC KEY BLOCK-----\n`;
}

/** Every argument and environment value the children got. */
function exposed(host: FakeHost): string {
  return host.calls
    .map((c) => [c.cmd, ...c.args, ...Object.values(c.opts.env ?? {})].join('\u0000'))
    .join('\n');
}

describe('V16 AC2: it refuses to run without a terminal', () => {
  it('stdout first, then stdin', () => {
    expect(terminalRefusal(true, false)).toBe('stdout_not_terminal');
    expect(terminalRefusal(false, true)).toBe('stdin_not_terminal');
    expect(terminalRefusal(false, false)).toBe('stdout_not_terminal');
    expect(terminalRefusal(true, true)).toBeUndefined();
  });

  it('clears the screen and the scroll-back with ESC [3J', () => {
    expect(CLEAR_SCREEN).toContain('\u001b[3J');
    expect(CLEAR_SCREEN).toContain('\u001b[2J');
  });
});

describe('V16 AC1–AC5: a whole run', () => {
  it('runs steps 2 to 7 in order and ends with doctor', async () => {
    const f = fixture();
    const r = await serverSetup(f.settings, f.deps);
    expect(r).toMatchObject({ outcome: 'done', doctorOk: true });
    const steps = f.term.events
      .filter((e) => e.kind === 'say' && e.key.startsWith('server_setup.step.'))
      .map((e) => ('key' in e ? e.key.slice(-1) : ''));
    expect(steps).toEqual(['2', '3', '4', '5', '6', '7']);
    expect(f.host.delivered).toEqual([...CREDENTIALS_COMMANDS]);
    expect([...f.host.kv.keys()].sort()).toEqual([
      'cost-controller/litellm-master-key',
      'litellm/providers/anthropic',
      'litellm/salt-key',
      'shared/github-app',
    ]);
    expect(f.host.state).toBe('unsealed');
    const last = f.host.calls.at(-1)!;
    expect(last.args[0]).toMatch(/doctor\/dist\/main\.js$/);
    expect(last.args).toContain('--env');
    expect(f.term.said('server_setup.doctor')).toBe(true);
  });

  it('a second run keeps the env file of the first one and goes on (no init-env)', async () => {
    const f = fixture();
    await serverSetup(f.settings, f.deps);
    const before = fs.readFileSync(f.envFile, 'utf8');
    const first = f.host.calls.length;
    const again = new ScriptedTerminal(f.host);
    const result = await serverSetup(f.settings, { ...f.deps, terminal: again });
    expect(result.outcome).toBe('done');
    const second = f.host.calls.slice(first);
    expect(second.some((c) => path.basename(c.cmd) === 'init-env.sh')).toBe(false);
    expect(fs.readFileSync(f.envFile, 'utf8')).toBe(before);
  });

  it('makes the env file in server mode: no LiteLLM keys in it, mode 600', async () => {
    const f = fixture();
    await serverSetup(f.settings, f.deps);
    const env = fs.readFileSync(f.envFile, 'utf8');
    expect(env).toMatch(/^LITELLM_MASTER_KEY=$/m);
    expect(env).toMatch(/^LITELLM_SALT_KEY=$/m);
    expect(fs.statSync(f.envFile).mode & 0o777).toBe(0o600);
  });

  it('builds the database URL from the env file and passes it on stdin', async () => {
    const f = fixture();
    await serverSetup(f.settings, f.deps);
    const migrate = f.host.calls.find((c) => c.args[0]?.endsWith('migrate-cli.js'))!;
    expect(migrate.args).toEqual([expect.any(String), 'latest', '--url-stdin']);
    expect(migrate.opts.input).toBe(`postgres://platform:${OWNER_DB}@127.0.0.1:5432/platform\n`);
    expect(Object.keys(migrate.opts.env ?? {})).not.toContain('SDLC_DB_MIGRATION_URL');
  });

  it('every docker compose call names the project of the env file', async () => {
    const f = fixture();
    await serverSetup(f.settings, f.deps);
    for (const c of f.host.calls.filter((x) => x.cmd === 'docker'))
      expect(c.args.slice(0, 3)).toEqual(['compose', '-p', 'sdlcsrv']);
  });
});

describe('V16 AC2: key custody', () => {
  it('without PGP keys: one share per holder, cleared after each confirmation', async () => {
    const f = fixture();
    await serverSetup(f.settings, f.deps);
    expect(f.host.pgpKeysAtInit).toBe(0);
    const secrets = f.term.events.map((e, i) => ({ e, i })).filter(({ e }) => e.kind === 'secret');
    expect(secrets.map(({ e }) => ('text' in e ? e.text : ''))).toEqual(f.host.plainShares);
    for (const [n, { i }] of secrets.entries()) {
      // Before: the screen is cleared and the holder is called by name.
      expect(f.term.events[i - 3]).toEqual({ kind: 'clear' });
      expect(f.term.events[i - 2]).toMatchObject({
        kind: 'pause',
        key: 'server_setup.share.call',
        params: { holder: ['Ana', 'Binh', 'Chi'][n] },
      });
      // After: the holder confirms the copy, then the screen and scroll-back are cleared.
      expect(f.term.events[i + 1]).toMatchObject({
        kind: 'pause',
        key: 'server_setup.share.copied',
      });
      expect(f.term.events[i + 2]).toEqual({ kind: 'clear' });
    }
  });

  it('with the three holders’ PGP keys, -pgp-keys is the default and no share is seen in clear', async () => {
    const f = fixture({}, true);
    expect(usesPgp(f.settings)).toBe(true);
    await serverSetup(f.settings, f.deps);
    expect(f.host.pgpKeysAtInit).toBe(3);
    const init = f.host.calls.find((c) => (c.args.at(-1) ?? '').includes('operator init'))!;
    expect(init.args.at(-1)).toContain('-pgp-keys=');
    const shown = f.term.events.flatMap((e) => (e.kind === 'secret' ? [e.text] : []));
    expect(shown).toHaveLength(3);
    for (const s of shown) expect(f.host.plainShares).not.toContain(s);
    expect(f.term.said('server_setup.share.pgp')).toBe(true);
  });

  it('writes no share and no token to any file', async () => {
    const f = fixture();
    await serverSetup(f.settings, f.deps);
    const files = fs.readdirSync(f.dir).map((n) => fs.readFileSync(path.join(f.dir, n), 'utf8'));
    for (const secret of [...f.host.plainShares, ...f.host.roots, ...f.host.admins])
      for (const text of files) expect(text).not.toContain(secret);
  });

  it('refuses a PGP key file that is not a public key, before init', async () => {
    const f = fixture({}, true);
    fs.writeFileSync(f.settings.keyHolders[1]!.pgpKeyFile!, `${SECRET_KEY_HEADER}\n`);
    const error = await serverSetup(f.settings, f.deps).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SetupStopped);
    expect((error as SetupStopped).cause).toBeInstanceOf(SetupRefused);
    expect(f.host.state).toBe('uninitialised');
  });
});

describe('V16 AC3: tokens', () => {
  it('the root token goes to configure only, and configure revokes it', async () => {
    const f = fixture();
    await serverSetup(f.settings, f.deps);
    expect(f.host.roots.size).toBe(1);
    const root = [...f.host.roots][0]!;
    const withRoot = f.host.calls.filter((c) => (c.opts.input ?? '').includes(root));
    expect(withRoot.map((c) => c.args[0])).toEqual(['configure']);
    expect(withRoot[0]!.args).toContain('--issue-admin-token');
    expect(f.host.revoked.has(root)).toBe(true);
  });

  it('one admin token for steps 4 and 5, revoked at the end', async () => {
    const f = fixture();
    await serverSetup(f.settings, f.deps);
    expect(f.host.configureRuns).toBe(1);
    expect(f.host.admins.size).toBe(1);
    expect(f.host.revoked.has([...f.host.admins][0]!)).toBe(true);
  });

  it('no share and no token on a command line or in an environment variable', async () => {
    const f = fixture({
      optional: ['knowledge', 'observability', 'dashboard-signin', 'dashboard-actions'],
      dashboard: { publicOrigin: 'https://sdlc.example.com' },
    });
    await serverSetup(f.settings, f.deps);
    const text = exposed(f.host);
    for (const secret of [
      ...f.host.secrets,
      'sk-ant-typed-000000000000',
      'sk-lf-0000',
      'client-secret-00000000000000',
    ])
      expect(text).not.toContain(secret);
  });

  it.each([
    ['a failed configure', 'configure'],
    ['a signal after unseal', 'signal'],
  ] as const)('%s revokes the root token of init', async (_name, how) => {
    const f = fixture();
    if (how === 'configure') f.host.failWhen = (c) => c.args[0] === 'configure';
    // SIGINT, SIGTERM or SIGHUP during unseal: seen before configure.
    if (how === 'signal')
      f.term.onSay = (k) => {
        if (k === 'server_setup.unseal.explain') f.requestStop();
      };
    const error = (await serverSetup(f.settings, f.deps).catch((e: unknown) => e)) as SetupStopped;
    expect(error).toBeInstanceOf(SetupStopped);
    expect(error.step).toBe('3');
    expect(error.rootRevoked).toBe(true);
    expect(f.host.revoked.has([...f.host.roots][0]!)).toBe(true);
    const p = readProgress(progressFileFor(f.envFile));
    expect(p.stopped).toMatchObject({ step: '3', rootRevoked: true });
    expect(p.leftoverRoot).toBeUndefined();
    expect(p.stopped?.reason).toBe(how === 'configure' ? 'failed' : 'interrupted');
  });

  it.each([
    ['a Ctrl-C at the unseal prompt', 'abort'],
    ['a signal after the shares were handed out', 'signal'],
  ] as const)(
    '%s while OpenBao is sealed: said plainly, and the next start revokes that root token',
    async (_name, how) => {
      const f = fixture();
      if (how === 'abort') f.term.abortAt = (k) => k === 'server_setup.share.prompt';
      if (how === 'signal')
        f.term.onSay = (k) => {
          if (k === 'server_setup.share.all_copied') f.requestStop();
        };
      const error = (await serverSetup(f.settings, f.deps).catch(
        (e: unknown) => e,
      )) as SetupStopped;
      // A sealed OpenBao cannot revoke anything: never reported as revoked.
      expect(error).toMatchObject({ step: '3', rootRevoked: false });
      const old = [...f.host.roots][0]!;
      expect(f.host.revoked.has(old)).toBe(false);
      expect(readProgress(progressFileFor(f.envFile)).leftoverRoot).toBe(true);

      const again = new ScriptedTerminal(f.host);
      await serverSetup(f.settings, { ...f.deps, terminal: again, stopRequested: () => false });
      expect(again.events).toContainEqual(
        expect.objectContaining({ kind: 'warn', key: 'server_setup.resume.root_not_revoked' }),
      );
      expect(again.events).toContainEqual(
        expect.objectContaining({ key: 'server_setup.resume.root_revoked', params: { count: 1 } }),
      );
      for (const t of [...f.host.roots, ...f.host.admins]) expect(f.host.revoked.has(t)).toBe(true);
      expect(readProgress(progressFileFor(f.envFile)).leftoverRoot).toBeUndefined();
    },
  );

  it('one Ctrl-C while the shares are handed out warns and shows the share again', async () => {
    const f = fixture();
    let aborts = 0;
    f.term.abortAt = (k) => k === 'server_setup.share.copied' && aborts++ === 0;
    expect((await serverSetup(f.settings, f.deps)).outcome).toBe('done');
    expect(f.term.said('server_setup.share.stop_warning')).toBe(true);
    const shown = f.term.events.flatMap((e) => (e.kind === 'secret' ? [e.text] : []));
    expect(shown).toEqual([f.host.plainShares[0], ...f.host.plainShares]);
  });

  it('a second Ctrl-C there stops the command', async () => {
    const f = fixture();
    f.term.abortAt = (k) =>
      k === 'server_setup.share.copied' || k === 'server_setup.share.stop_confirm';
    const error = (await serverSetup(f.settings, f.deps).catch((e: unknown) => e)) as SetupStopped;
    expect(error).toMatchObject({ step: '3', reason: 'interrupted' });
  });

  it('a configure that fails after it made the admin token revokes that token', async () => {
    const f = fixture();
    const real = f.host.exec;
    const wrapped: Exec = async (cmd, args, opts) => {
      const r = await real(cmd, args, opts);
      return args[0] === 'configure' ? { ...r, status: 1 } : r;
    };
    await serverSetup(f.settings, { ...f.deps, exec: wrapped }).catch(() => undefined);
    expect(f.host.admins.size).toBe(1);
    for (const t of [...f.host.roots, ...f.host.admins]) expect(f.host.revoked.has(t)).toBe(true);
  });

  it('refuses a secret file that others can read', async () => {
    const f = fixture();
    fs.chmodSync(f.settings.appKeyFile, 0o644);
    const error = (await serverSetup(f.settings, f.deps).catch((e: unknown) => e)) as SetupStopped;
    expect(error.step).toBe('4');
    expect((error.cause as SetupRefused).code).toBe('secret_file_mode');
  });

  it('a stop after configure leaves no admin token valid', async () => {
    const f = fixture();
    f.host.failWhen = (c) => c.args[0] === 'worker-credentials';
    await serverSetup(f.settings, f.deps).catch(() => undefined);
    for (const t of [...f.host.roots, ...f.host.admins]) expect(f.host.revoked.has(t)).toBe(true);
  });
});

describe('V16 AC5: a second start', () => {
  it('after a failure in step 5: says where it stopped, skips what is done, asks two shares', async () => {
    const f = fixture();
    f.host.failWhen = (c) => c.args[0] === 'runner-credentials';
    const error = (await serverSetup(f.settings, f.deps).catch((e: unknown) => e)) as SetupStopped;
    expect(error.step).toBe('5');
    expect(f.host.delivered).toEqual(CREDENTIALS_COMMANDS.slice(0, 3));

    f.host.failWhen = () => false;
    const again = new ScriptedTerminal(f.host);
    await serverSetup(f.settings, { ...f.deps, terminal: again });
    expect(again.events[0]).toMatchObject({
      kind: 'say',
      key: 'server_setup.resume',
      params: { step: '5', reason: 'failed' },
    });
    // No second init and no share shown; step 4 is not done again; step 5 goes on where it stopped.
    expect(again.events.some((e) => e.kind === 'secret')).toBe(false);
    expect(f.host.delivered).toEqual([...CREDENTIALS_COMMANDS]);
    expect(f.host.kv.size).toBe(4);
    // The new admin token came from a new root token through configure, which revoked it.
    expect(f.host.configureRuns).toBe(2);
    for (const t of [...f.host.roots, ...f.host.admins]) expect(f.host.revoked.has(t)).toBe(true);
    expect(readProgress(progressFileFor(f.envFile)).stopped).toBeUndefined();
  });

  it.each(['3', '4', '5', '6', '7'])(
    'after a stop before step %s, a new start finishes',
    async (n) => {
      const f = fixture();
      // A signal during step n-1 is seen at the start of step n (in step 3: before unseal, while
      // OpenBao is sealed, so that root token is revoked by the next start).
      f.term.onSay = (k) => {
        if (k === `server_setup.step.${Number(n) - 1}`) f.requestStop();
      };
      const error = (await serverSetup(f.settings, f.deps).catch(
        (e: unknown) => e,
      )) as SetupStopped;
      expect(error).toMatchObject({
        step: String(Number(n) - 1),
        reason: 'interrupted',
        rootRevoked: n !== '4',
      });
      const again = new ScriptedTerminal(f.host);
      const r = await serverSetup(f.settings, {
        ...f.deps,
        terminal: again,
        stopRequested: () => false,
      });
      expect(r.outcome).toBe('done');
      expect(f.host.delivered).toEqual([...CREDENTIALS_COMMANDS]);
      expect(f.host.kv.size).toBe(4);
      for (const t of [...f.host.roots, ...f.host.admins]) expect(f.host.revoked.has(t)).toBe(true);
    },
  );

  it('a stop between steps is reported on the next start', async () => {
    const f = fixture();
    let stop = false;
    f.term.onSay = (k) => {
      if (k === 'server_setup.migrate.done') stop = true;
    };
    const error = (await serverSetup(f.settings, { ...f.deps, stopRequested: () => stop }).catch(
      (e: unknown) => e,
    )) as SetupStopped;
    expect(error).toMatchObject({ step: '6', reason: 'interrupted', rootRevoked: true });
    const again = new ScriptedTerminal(f.host);
    await serverSetup(f.settings, { ...f.deps, terminal: again });
    expect(again.events[0]).toMatchObject({ key: 'server_setup.resume', params: { step: '6' } });
    expect(f.host.delivered).toEqual([...CREDENTIALS_COMMANDS]);
  });

  it('a new env file on a server stops after step 2 for the company certificate', async () => {
    const f = fixture({ throwawayTls: false });
    expect((await serverSetup(f.settings, f.deps)).outcome).toBe('tls');
    expect(f.term.said('server_setup.tls.replace_first')).toBe(true);
    expect(f.host.calls.some((c) => c.cmd === 'docker')).toBe(false);
    expect((await serverSetup(f.settings, f.deps)).outcome).toBe('done');
  });

  it('refuses an existing env file with LiteLLM keys, and a trial project', async () => {
    const f = fixture();
    fs.writeFileSync(
      f.envFile,
      'COMPOSE_PROJECT_NAME=sdlc\nLITELLM_MASTER_KEY=sk-x\nLITELLM_SALT_KEY=\n',
    );
    const e1 = (await serverSetup(f.settings, f.deps).catch((e: unknown) => e)) as SetupStopped;
    expect((e1.cause as SetupRefused).code).toBe('litellm_keys_in_env');
    fs.writeFileSync(f.envFile, 'COMPOSE_PROJECT_NAME=sdlc-trial\nLITELLM_MASTER_KEY=\n');
    const e2 = (await serverSetup(f.settings, f.deps).catch((e: unknown) => e)) as SetupStopped;
    expect((e2.cause as SetupRefused).code).toBe('trial_project');
    expect(isTrialProject('sdlctrialit123')).toBe(true);
    expect(isTrialProject('sdlc')).toBe(false);
  });

  it('a failure names the step', async () => {
    const f = fixture();
    f.host.failWhen = (c) => path.basename(c.cmd) === 'up.sh';
    const error = (await serverSetup(f.settings, f.deps).catch((e: unknown) => e)) as SetupStopped;
    expect(error).toMatchObject({ step: '7', reason: 'failed' });
    expect((error.cause as { step: string }).step).toBe('up.sh');
  });
});

describe('V16 AC4: the optional parts', () => {
  it('run their credentials commands and write their .env keys', async () => {
    const f = fixture({
      optional: ['observability', 'knowledge', 'dashboard-signin', 'dashboard-actions'],
      dashboard: { publicOrigin: 'https://sdlc.example.com' },
    });
    await serverSetup(f.settings, f.deps);
    expect(f.host.delivered.slice(CREDENTIALS_COMMANDS.length)).toEqual([
      'api-github-oauth-credentials',
      'worker-knowledge-credentials',
      'knowledge-issuer-credentials',
      'worker-langfuse-credentials',
    ]);
    const env = fs.readFileSync(f.envFile, 'utf8');
    expect(env).toMatch(/^SDLC_API_WEB_SIGNIN=github$/m);
    expect(env).toMatch(/^SDLC_API_PUBLIC_ORIGIN=https:\/\/sdlc\.example\.com$/m);
    expect(env).toMatch(/^SDLC_API_DASHBOARD_ACTIONS=on$/m);
    const up = f.host.calls.find((c) => path.basename(c.cmd) === 'up.sh')!;
    expect(up.args).toEqual([
      'core',
      'models',
      'platform',
      'sandbox',
      'observability',
      'knowledge',
    ]);
  });

  it('a provider key comes from its file, or else from a hidden prompt', async () => {
    const f = fixture();
    await serverSetup(f.settings, f.deps);
    expect(f.term.events).toContainEqual(
      expect.objectContaining({ kind: 'hidden', key: 'server_setup.secret.provider_key' }),
    );
    const g = fixture();
    const keyFile = path.join(g.dir, 'anthropic.key');
    fs.writeFileSync(keyFile, 'sk-ant-file-0000000000\n', { mode: 0o600 });
    await serverSetup(
      { ...g.settings, providers: [{ provider: 'anthropic', apiKeyFile: keyFile }] },
      g.deps,
    );
    expect(
      g.term.events.some(
        (e) => e.kind === 'hidden' && e.key === 'server_setup.secret.provider_key',
      ),
    ).toBe(false);
  });
});

describe('V16 AC4: the settings file', () => {
  const home = '/home/op';
  const base = {
    key_holders: [{ name: 'Ana' }, { name: 'Binh' }, { name: 'Chi' }],
    github_app: { client_id: 'Iv23abc', private_key_file: '~/secrets/app.pem' },
    model_providers: [{ provider: 'anthropic', api_key_file: '/srv/keys/anthropic' }],
  };
  const yaml = (o: object) => JSON.stringify(o);

  it('reads the fields and expands ~/', () => {
    const s = parseSettings(yaml(base), home, 3);
    expect(s.appKeyFile).toBe('/home/op/secrets/app.pem');
    expect(s.optional).toEqual([]);
    expect(s.throwawayTls).toBe(false);
    expect(usesPgp(s)).toBe(false);
  });

  it.each([
    [{ ...base, key_holders: base.key_holders.slice(0, 2) }, 'key_holders'],
    [
      {
        ...base,
        key_holders: [{ name: 'Ana', pgp_public_key_file: '/k' }, { name: 'B' }, { name: 'C' }],
      },
      'key_holders.pgp_public_key_file',
    ],
    [{ ...base, optional: ['dashboard-actions'] }, 'optional'],
    [{ ...base, optional: ['dashboard-signin'] }, 'dashboard'],
    [{ ...base, optional: ['nope'] }, 'optional[0]'],
    [{ ...base, model_providers: [{ provider: 'vllm' }] }, 'model_providers[0].provider'],
    [{ ...base, github_app: { client_id: '--x', private_key_file: '/k' } }, 'github_app.client_id'],
    [
      { ...base, github_app: { client_id: 'Iv23abc', private_key_file: 'relative.pem' } },
      'github_app.private_key_file',
    ],
  ])('names the first bad field (%#)', (doc, field) => {
    expect(() => parseSettings(yaml(doc), home, 3)).toThrow(SettingsError);
    try {
      parseSettings(yaml(doc), home, 3);
    } catch (e) {
      expect((e as SettingsError).field).toBe(field);
    }
  });

  it('the example file in the repository is valid', () => {
    const text = fs.readFileSync(
      path.join(repoRoot(), 'platform/deploy/server-setup/server-settings.example.yaml'),
      'utf8',
    );
    const s = parseSettings(text, home, 3);
    expect(s.keyHolders).toHaveLength(3);
    expect(usesPgp(s)).toBe(true);
  });

  it('a PGP key: armored or base64, never a secret key', () => {
    const armored = armoredKey();
    const b64 = pgpKeyBase64(armored);
    expect(pgpKeyBase64(b64)).toBe(b64);
    const secret = Buffer.concat([Buffer.from([0xc5, 0x33]), Buffer.alloc(120, 7)]).toString(
      'base64',
    );
    expect(() => pgpKeyBase64(secret)).toThrow();
    expect(() => pgpKeyBase64(`${SECRET_KEY_HEADER}\nx\n`)).toThrow();
  });
});

describe('V16 AC3, AC5: the progress file', () => {
  it('holds step names and codes only, and drops anything malformed', () => {
    expect(parseProgress('not json')).toEqual({ v: 1, done: [], credentials: [] });
    expect(
      parseProgress(
        JSON.stringify({
          done: ['2', '3.configure', 's.ROOT000'],
          credentials: ['api-credentials', 'hvs.X'],
          stopped: { step: '5', reason: 'failed', at: 't', rootRevoked: true },
        }),
      ),
    ).toEqual({
      v: 1,
      done: ['2', '3.configure'],
      credentials: ['api-credentials'],
      stopped: { step: '5', reason: 'failed', at: 't', rootRevoked: true },
    });
  });

  it('is written mode 600 next to the env file', async () => {
    const f = fixture();
    await serverSetup(f.settings, f.deps);
    const file = progressFileFor(f.envFile);
    expect(path.dirname(file)).toBe(f.dir);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe('V20: team access and the runner link in the settings', () => {
  const home = '/home/op';
  const base = {
    key_holders: [{ name: 'Ana' }, { name: 'Binh' }, { name: 'Chi' }],
    github_app: { client_id: 'Iv23abc', private_key_file: '/srv/app.pem' },
    model_providers: [{ provider: 'anthropic' }],
  };
  const access = {
    hostname: 'sdlc.example.internal',
    bind_addr: '192.0.2.10',
    tls_dir: '/etc/sdlc/access-tls',
    certificate_folder: '~/access-cert',
  };
  const runnerLink = {
    link_addr: '10.203.0.1',
    source_cidr: '10.203.0.1/32',
    docker_host: 'unix:///run/user/1001/docker.sock',
  };
  const parse = (o: object) => parseSettings(JSON.stringify(o), home, 3);
  const field = (o: object): string => {
    try {
      parse(o);
    } catch (e) {
      if (e instanceof SettingsError) return e.field;
      throw e;
    }
    return '(none)';
  };

  it('AC1: reads access, with the default port and the derived public origin', () => {
    const s = parse({ ...base, access, optional: ['dashboard-signin'] });
    expect(s.access).toEqual({
      hostname: 'sdlc.example.internal',
      bindAddr: '192.0.2.10',
      port: 8443,
      ips: [],
      tlsDir: '/etc/sdlc/access-tls',
      certificateFolder: '/home/op/access-cert',
    });
    expect(s.dashboard?.publicOrigin).toBe('https://sdlc.example.internal:8443');
    expect(accessOrigin({ hostname: 'a.example', port: 443 })).toBe('https://a.example');
  });

  it('AC1: one public origin behind the proxy; a host name, never an IP address', () => {
    expect(
      field({
        ...base,
        access,
        optional: ['dashboard-signin'],
        dashboard: { public_origin: 'https://other.example.internal' },
      }),
    ).toBe('dashboard.public_origin');
    expect(
      parse({
        ...base,
        access: { ...access, port: 443 },
        optional: ['dashboard-signin'],
        dashboard: { public_origin: 'https://sdlc.example.internal' },
      }).dashboard?.publicOrigin,
    ).toBe('https://sdlc.example.internal');
    expect(field({ ...base, access: { ...access, hostname: '192.0.2.10' } })).toBe(
      'access.hostname',
    );
    expect(field({ ...base, access: { ...access, hostname: 'localhost' } })).toBe(
      'access.hostname',
    );
    expect(field({ ...base, access: { ...access, bind_addr: 'lan' } })).toBe('access.bind_addr');
    expect(field({ ...base, access: { ...access, port: 70000 } })).toBe('access.port');
    expect(field({ ...base, access: { ...access, cli_ips: ['x'] } })).toBe('access.cli_ips[0]');
    expect(field({ ...base, access: { ...access, tls_dir: 'rel' } })).toBe('access.tls_dir');
  });

  it('AC2: reads runner_link and refuses what bootstrap.sh would refuse', () => {
    expect(parse({ ...base, runner_link: runnerLink }).runnerLink).toEqual({
      linkAddr: '10.203.0.1',
      sourceCidr: '10.203.0.1/32',
      dockerHost: 'unix:///run/user/1001/docker.sock',
    });
    expect(
      parse({ ...base, runner_link: { ...runnerLink, docker_host: 'ssh://sdlc-runner@10.66.0.2' } })
        .runnerLink?.dockerHost,
    ).toBe('ssh://sdlc-runner@10.66.0.2');
    expect(field({ ...base, runner_link: { ...runnerLink, source_cidr: '10.203.0.1' } })).toBe(
      'runner_link.source_cidr',
    );
    expect(field({ ...base, runner_link: { ...runnerLink, source_cidr: '10.0.0.1/33' } })).toBe(
      'runner_link.source_cidr',
    );
    expect(field({ ...base, runner_link: { ...runnerLink, docker_host: 'tcp://x:2375' } })).toBe(
      'runner_link.docker_host',
    );
    expect(field({ ...base, runner_link: { ...runnerLink, link_addr: '10.203.0' } })).toBe(
      'runner_link.link_addr',
    );
  });

  it('AC3: env keys: set when empty or a template default, kept when equal, refused when different', () => {
    const s = parse({
      ...base,
      access: { ...access, cli_ips: ['192.0.2.10'] },
      runner_link: runnerLink,
    });
    const env =
      'SDLC_ACCESS_HOST_PORT=8443\nSDLC_ACCESS_PROXY_IP=172.30.1.9\nSDLC_ACCESS_BIND_ADDR=\n';
    const keys = settingsEnvKeys(s, env);
    expect(Object.fromEntries(keys)).toEqual({
      SDLC_ACCESS_BIND_ADDR: '192.0.2.10',
      SDLC_ACCESS_HOST_PORT: '8443',
      SDLC_ACCESS_HOSTNAME: 'sdlc.example.internal',
      SDLC_ACCESS_TLS_DIR: '/etc/sdlc/access-tls',
      SDLC_API_TRUSTED_PROXY: '172.30.1.9',
      SDLC_ACCESS_IPS: '192.0.2.10',
      SDLC_RUNNER_LINK_ADDR: '10.203.0.1',
      SDLC_RUNNER_SOURCE_CIDR: '10.203.0.1/32',
      SDLC_RUNNER_DOCKER_HOST: 'unix:///run/user/1001/docker.sock',
    });
    const first = applyEnvKeys(env, keys);
    expect(first.changed).not.toContain('SDLC_ACCESS_HOST_PORT');
    expect(first.text).toMatch(/^SDLC_ACCESS_BIND_ADDR=192\.0\.2\.10$/m);
    expect(applyEnvKeys(first.text, keys)).toEqual({ text: first.text, changed: [] });
    expect(
      applyEnvKeys('SDLC_ACCESS_HOST_PORT=8443\n', [['SDLC_ACCESS_HOST_PORT', '9443']]).changed,
    ).toEqual(['SDLC_ACCESS_HOST_PORT']);
    expect(() =>
      applyEnvKeys('SDLC_RUNNER_LINK_ADDR=10.66.0.1\n', [['SDLC_RUNNER_LINK_ADDR', '10.203.0.1']]),
    ).toThrow(EnvKeyConflict);
  });

  /** The same settings without access, the runner link and the dashboard sign-in. */
  function withoutLink(s: ServerSettings): ServerSettings {
    const { access: _a, runnerLink: _r, dashboard: _d, ...rest } = s;
    void _a;
    void _r;
    void _d;
    return { ...rest, optional: [] };
  }

  function linked() {
    const f = fixture();
    const settings: ServerSettings = {
      ...f.settings,
      optional: ['knowledge', 'dashboard-signin'],
      dashboard: { publicOrigin: 'https://sdlc.example.internal:8443' },
      access: {
        hostname: 'sdlc.example.internal',
        bindAddr: '192.0.2.10',
        port: 8443,
        ips: [],
        tlsDir: path.join(f.dir, 'access-tls'),
        certificateFolder: path.join(f.dir, 'cert'),
      },
      runnerLink: {
        linkAddr: '10.203.0.1',
        sourceCidr: '10.203.0.1/32',
        dockerHost: 'unix:///run/user/1001/docker.sock',
      },
    };
    // The env file as `configure` and the credentials commands see it.
    const seen: Record<string, string> = {};
    const exec: Exec = (cmd, args, opts) => {
      if (path.basename(cmd) === 'bootstrap.sh' && fs.existsSync(f.envFile)) {
        seen[args[0] ?? ''] = fs.readFileSync(f.envFile, 'utf8');
      }
      return f.host.exec(cmd, args, opts);
    };
    return { ...f, settings, seen, deps: { ...f.deps, exec } };
  }

  it('AC1, AC2: writes the keys before configure, imports the certificate, starts access and runner-link', async () => {
    const f = linked();
    const r = await serverSetup(f.settings, f.deps);
    expect(r.outcome).toBe('done');
    expect(f.seen.configure).toMatch(/^SDLC_RUNNER_SOURCE_CIDR=10\.203\.0\.1\/32$/m);
    expect(f.seen['runner-credentials']).toMatch(
      /^SDLC_RUNNER_DOCKER_HOST=unix:\/\/\/run\/user\/1001\/docker\.sock$/m,
    );
    const env = fs.readFileSync(f.envFile, 'utf8');
    expect(env).toMatch(/^SDLC_ACCESS_HOSTNAME=sdlc\.example\.internal$/m);
    expect(env).toMatch(/^SDLC_API_TRUSTED_PROXY=172\.30\.1\.6$/m);
    expect(env).toMatch(/^SDLC_API_PUBLIC_ORIGIN=https:\/\/sdlc\.example\.internal:8443$/m);
    expect(fs.statSync(f.envFile).mode & 0o777).toBe(0o600);

    const index = (pred: (c: Call) => boolean) => f.host.calls.findIndex(pred);
    const up = index((c) => path.basename(c.cmd) === 'up.sh');
    const tls = index((c) => path.basename(c.cmd) === 'tls.sh');
    const rm = index((c) => c.cmd === 'docker' && c.args.includes('rm'));
    expect(tls).toBeGreaterThan(-1);
    expect(rm).toBeGreaterThan(-1);
    expect(tls).toBeLessThan(up);
    expect(rm).toBeLessThan(up);
    expect(f.host.calls[tls]!.args).toEqual(['import', path.join(f.dir, 'cert')]);
    expect(f.host.calls[up]!.args).toEqual([
      'core',
      'models',
      'platform',
      'runner-link',
      'knowledge',
      'access',
    ]);
    expect(f.host.calls[rm]!.args).toEqual(
      expect.arrayContaining(['sdlc-runner', 'docker-socket-proxy', 'npm-proxy', '--stop']),
    );
    // On its own Engine the runner restarts on the runner host: only the worker restarts here.
    const restart = f.host.calls.find((c) => c.cmd === 'docker' && c.args.includes('restart'))!;
    expect(restart.args.slice(restart.args.indexOf('restart') + 1)).toEqual(['sdlc-worker']);
    expect(f.term.said('server_setup.access.ready')).toBe(true);
    expect(f.term.said('server_setup.runner_link.next')).toBe(true);
    expect(f.host.delivered).toContain('runner-credentials');
  });

  it('AC3: a second run changes nothing and imports nothing again', async () => {
    const f = linked();
    await serverSetup(f.settings, f.deps);
    const before = fs.readFileSync(f.envFile, 'utf8');
    const first = f.host.calls.length;
    const again = new ScriptedTerminal(f.host);
    await serverSetup(f.settings, { ...f.deps, terminal: again });
    const second = f.host.calls.slice(first);
    expect(fs.readFileSync(f.envFile, 'utf8')).toBe(before);
    expect(again.said('server_setup.env.keys')).toBe(false);
    expect(second.some((c) => path.basename(c.cmd) === 'tls.sh')).toBe(false);
    expect(second.some((c) => c.cmd === 'docker' && c.args.includes('rm'))).toBe(false);
    expect(f.host.configureRuns).toBe(1);
  });

  it('AC3: refuses an env key that holds another value, and changes nothing', async () => {
    const f = linked();
    await serverSetup(withoutLink(f.settings), f.deps);
    const env = fs.readFileSync(f.envFile, 'utf8').concat('SDLC_RUNNER_LINK_ADDR=10.66.0.1\n');
    fs.writeFileSync(f.envFile, env, { mode: 0o600 });
    const again = new ScriptedTerminal(f.host);
    const error = await serverSetup(f.settings, { ...f.deps, terminal: again }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SetupStopped);
    expect((error as SetupStopped).cause).toBeInstanceOf(SetupRefused);
    expect(((error as SetupStopped).cause as SetupRefused).code).toBe('env_conflict');
    expect(((error as SetupStopped).cause as SetupRefused).params).toMatchObject({
      key: 'SDLC_RUNNER_LINK_ADDR',
    });
    expect(fs.readFileSync(f.envFile, 'utf8')).toBe(env);
  });

  it('AC2: a runner link added after configure runs configure again and delivers the runner credentials again', async () => {
    const f = linked();
    await serverSetup(withoutLink(f.settings), f.deps);
    expect(f.host.configureRuns).toBe(1);
    const delivered = f.host.delivered.filter((c) => c === 'runner-credentials').length;
    const again = new ScriptedTerminal(f.host);
    await serverSetup(
      { ...withoutLink(f.settings), runnerLink: f.settings.runnerLink! },
      {
        ...f.deps,
        terminal: again,
      },
    );
    expect(again.said('server_setup.runner_link.configure_again')).toBe(true);
    expect(f.host.configureRuns).toBe(2);
    expect(f.host.delivered.filter((c) => c === 'runner-credentials').length).toBe(delivered + 1);
    expect(f.seen.configure).toMatch(/^SDLC_RUNNER_SOURCE_CIDR=10\.203\.0\.1\/32$/m);
  });
});
