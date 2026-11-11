// The steps of `platform/deploy/README.md` "Fresh deployment (operator)" on a throw-away Compose
// project, for the live tests `pnpm test:fresh-deploy` (E07 AC3) and `pnpm test:upgrade` (O02).
// Every step runs the scripts, the compose file and the `adlc` command of one checkout: this
// repository, or a release tag checked out as a git worktree (`at(root)` switches; the upgrade test
// deploys a release, then upgrades to another checkout on the same project and volumes).
//
// Key shares, tokens, passwords and keys are THROW-AWAY TEST VALUES: kept in memory, never printed,
// never in an assertion message (`redact`). What differs from a real deployment, and why:
// - `init --stdout-not-tty` and stdin instead of hidden prompts (the bootstrap's test switch);
// - the GitHub App key is a throw-away RSA key: the worker's polls of GitHub fail and are logged,
//   which does not stop the platform; the first intent needs no GitHub call;
// - the model provider key is a throw-away value: LiteLLM serves the Anthropic entry of
//   `config.ctmpl` (rendered from OpenBao), and no model call is made;
// - the root token stands in for the admin token of README step 3 (it has every right).
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { parseEnvFile } from '../../deploy/compose';
import { isolateEnv, type ThrowawayProject } from '../throwaway-compose';

/** The profiles of a server (README step 7). */
export const SERVER_PROFILES = ['core', 'models', 'platform', 'sandbox'] as const;
/** README step 5, in its order. */
export const CREDENTIALS_COMMANDS = [
  'litellm-credentials',
  'api-credentials',
  'worker-credentials',
  'runner-credentials',
  'runner-evidence-credentials',
  'api-evidence-credentials',
  'worker-evidence-credentials',
  'worker-purge-credentials',
  'worker-anchor-credentials',
  'backup-credentials',
] as const;
export const MODEL = 'claude-haiku-4-5-20251001';

export type Who = 'admin' | 'a' | 'b';

export interface Result {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface DeploymentOptions {
  /** The checkout whose scripts, compose file, migrations and CLI run. */
  readonly root: string;
  /** Temporary folder of the test (the env file, AGENTS.md, the CLI's HOME). */
  readonly tmp: string;
  readonly envFile: string;
  readonly project: ThrowawayProject;
}

/** What one deployment keeps across steps and checkouts (secrets in memory only). */
interface DeploymentState {
  readonly secrets: string[];
  shares: string[];
  rootToken: string;
  appUrl: string;
  readonly tokens: Record<Who, string>;
}

export class Deployment {
  readonly apiUrl: string;

  constructor(
    readonly options: DeploymentOptions,
    private readonly state: DeploymentState = {
      secrets: [],
      shares: [],
      rootToken: '',
      appUrl: '',
      tokens: { admin: '', a: '', b: '' },
    },
  ) {
    this.apiUrl = `http://127.0.0.1:${8090 + options.project.portOffset}`;
  }

  /** The same deployment (project, volumes, secrets) driven from another checkout. */
  at(root: string): Deployment {
    return new Deployment({ ...this.options, root }, this.state);
  }

  get deployDir(): string {
    return path.join(this.options.root, 'platform/deploy');
  }

  get composeProfileArgs(): string[] {
    return SERVER_PROFILES.flatMap((p) => ['--profile', p]);
  }

  keep(value: string): string {
    if (value) this.state.secrets.push(value);
    return value;
  }

  redact(text: string): string {
    return this.state.secrets.reduce((acc, s) => acc.split(s).join('<redacted>'), text);
  }

  run(cmd: string, args: string[], input = '', env: NodeJS.ProcessEnv = {}): Result {
    const r = spawnSync(cmd, args, {
      cwd: this.options.root,
      encoding: 'utf8',
      input,
      env: { ...process.env, SDLC_ENV_FILE: this.options.envFile, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  }

  ok(r: Result, what: string): Result {
    if (r.status !== 0) {
      throw new Error(
        `${what} failed (exit ${r.status}): ${this.redact(r.stderr + r.stdout).slice(-4000)}`,
      );
    }
    return r;
  }

  compose(input: string, ...args: string[]): Result {
    return this.run(
      'docker',
      [
        'compose',
        '-f',
        path.join(this.deployDir, 'docker-compose.yml'),
        '--env-file',
        this.options.envFile,
        ...args,
      ],
      input,
    );
  }

  bootstrap(args: string[], input = ''): Result {
    return this.run(path.join(this.deployDir, 'openbao/bootstrap.sh'), args, input, {
      SDLC_OPENBAO_TEST: '1',
    });
  }

  /** An admin command in the OpenBao container; the root token and the values come on stdin. */
  admin(script: string, input: string): void {
    this.ok(
      this.compose(
        `${this.state.rootToken}\n${input}`,
        'exec',
        '-T',
        'openbao',
        'sh',
        '-c',
        `IFS= read -r t; export BAO_TOKEN="$t"; ${script}`,
      ),
      'admin command',
    );
  }

  /**
   * `adlc … --json` of this checkout, like a person: the API with a token, or (`operator`) the
   * database. A clean environment: nothing of the shell's `SDLC_*` reaches it.
   */
  sdlc(who: Who | 'operator', argv: readonly string[]): Record<string, unknown> {
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: this.options.tmp };
    if (who === 'operator') env.SDLC_DB_URL = this.state.appUrl;
    else {
      env.SDLC_API_URL = this.apiUrl;
      env.SDLC_API_TOKEN = this.state.tokens[who];
    }
    const r = spawnSync(
      'node',
      [path.join(this.options.root, 'platform/apps/cli/dist/main.js'), ...argv, '--json'],
      { cwd: this.options.tmp, encoding: 'utf8', env, maxBuffer: 16 * 1024 * 1024 },
    );
    if (r.status !== 0) {
      throw new Error(
        `sdlc ${argv.slice(0, 3).join(' ')} → ${String(r.status)}: ${this.redact(r.stderr ?? '')}`,
      );
    }
    return JSON.parse(r.stdout) as Record<string, unknown>;
  }

  /** README step 2: the settings file (server mode: no LiteLLM keys in .env). */
  settingsFile(): Map<string, string> {
    this.ok(
      this.run(path.join(this.deployDir, 'scripts/init-env.sh'), [this.options.envFile]),
      'compose:env',
    );
    const text = isolateEnv(fs.readFileSync(this.options.envFile, 'utf8'), this.options.project)
      .replace(/^LITELLM_MASTER_KEY=.*$/m, 'LITELLM_MASTER_KEY=')
      .replace(/^LITELLM_SALT_KEY=.*$/m, 'LITELLM_SALT_KEY=');
    fs.writeFileSync(this.options.envFile, text, { mode: 0o600 });
    const env = parseEnvFile(text);
    this.keep(env.get('PLATFORM_APP_DB_PASSWORD')!);
    this.keep(env.get('PLATFORM_DB_PASSWORD')!);
    return env;
  }

  /** The env file as it is now. */
  env(): Map<string, string> {
    return parseEnvFile(fs.readFileSync(this.options.envFile, 'utf8'));
  }

  /** Starts only OpenBao, PostgreSQL and SeaweedFS (README step 3; Upgrade step 5). */
  startStores(): void {
    this.ok(
      this.compose(
        '',
        '--profile',
        'core',
        'up',
        '-d',
        '--wait',
        'openbao',
        'postgres',
        'seaweedfs',
      ),
      'openbao, postgres and seaweedfs',
    );
  }

  /** README step 3: init, unseal, configure (the root token is kept for steps 4 and 5). */
  initOpenBao(): void {
    const init = this.ok(this.bootstrap(['init', '--stdout-not-tty']), 'init');
    this.state.shares = [...init.stdout.matchAll(/^Unseal Key \d+: (\S+)$/gm)].map((m) =>
      this.keep(m[1]!),
    );
    this.state.rootToken = this.keep(/^Initial Root Token: (\S+)$/m.exec(init.stdout)?.[1] ?? '');
    this.unseal();
    this.ok(
      this.bootstrap(['configure', '--keep-token'], `${this.state.rootToken}\n`),
      'configure',
    );
  }

  /** Two key shares, as two key holders do after a restart. */
  unseal(): void {
    this.ok(
      this.bootstrap(['unseal'], `${this.state.shares[0]}\n${this.state.shares[1]}\n`),
      'unseal',
    );
  }

  /** `root-token` from two key shares (README step 3: `configure` revoked the last one). */
  newRootToken(): void {
    const r = this.ok(
      this.bootstrap(
        ['root-token', '--stdout-not-tty'],
        `${this.state.shares[0]}\n${this.state.shares[1]}\n`,
      ),
      'root-token',
    );
    this.state.rootToken = this.keep(r.stdout.trim().split('\n').pop() ?? '');
  }

  /** README step 4: the shared secrets (throw-away values, from stdin, never on a command line). */
  sharedSecrets(): void {
    const pem = this.keep(
      generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
        type: 'pkcs1',
        format: 'pem',
      }) as string,
    );
    this.admin(
      'IFS= read -r CLIENT_ID; bao kv put -mount=kv shared/github-app client_id="$CLIENT_ID" private_key=- >/dev/null',
      `Iv23fresh0deploy0test\n${pem}`,
    );
    const random = () => this.keep(`sk-${randomBytes(24).toString('hex')}`);
    this.admin(
      'IFS= read -r m; IFS= read -r s; IFS= read -r p; ' +
        'printf %s "$m" | bao kv put -mount=kv cost-controller/litellm-master-key value=- >/dev/null && ' +
        'printf %s "$s" | bao kv put -mount=kv litellm/salt-key value=- >/dev/null && ' +
        'printf %s "$p" | bao kv put -mount=kv litellm/providers/anthropic api_key=- >/dev/null',
      `${random()}\n${random()}\n${random()}\n`,
    );
  }

  /** A credentials command (README step 5) or `configure`, with the root token on stdin. */
  credentials(command: string): void {
    this.ok(this.bootstrap([command], `${this.state.rootToken}\n`), command);
  }

  /** README step 6: the migrations of this checkout. */
  migrate(): void {
    const env = this.env();
    const pgUrl = (user: string, password: string) =>
      `postgres://${user}:${encodeURIComponent(password)}@127.0.0.1:${5432 + this.options.project.portOffset}/platform`;
    this.ok(
      this.run(
        'node',
        [path.join(this.options.root, 'platform/packages/core/dist/db/migrate-cli.js'), 'latest'],
        '',
        { SDLC_DB_MIGRATION_URL: pgUrl('platform', env.get('PLATFORM_DB_PASSWORD')!) },
      ),
      'db:migrate',
    );
    this.state.appUrl = this.keep(pgUrl('platform_app', env.get('PLATFORM_APP_DB_PASSWORD')!));
  }

  /**
   * After steps 2–7 ran elsewhere (`pnpm server:setup` in `fresh-deploy.test.ts`, D-08 V16): the
   * operator's database URL of step 8, built from the env file as the README says.
   */
  adoptDatabase(): void {
    const env = this.env();
    this.state.appUrl = this.keep(
      `postgres://platform_app:${encodeURIComponent(env.get('PLATFORM_APP_DB_PASSWORD')!)}@127.0.0.1:${5432 + this.options.project.portOffset}/platform`,
    );
  }

  /** README step 7: `up.sh` with every profile of the server; the logs on a failure. */
  up(): Result {
    const up = this.run(path.join(this.deployDir, 'scripts/up.sh'), [...SERVER_PROFILES], '', {
      SDLC_WAIT_TIMEOUT: '900',
    });
    if (up.status !== 0) {
      const logs = this.compose(
        '',
        ...this.composeProfileArgs,
        'logs',
        '--no-color',
        '--tail',
        '80',
      );
      throw new Error(`up.sh failed: ${this.redact(up.stderr + logs.stdout).slice(-6000)}`);
    }
    return up;
  }

  /** README step 8: the tenant and its first admin (the token is printed once). */
  tenant(): void {
    const boot = this.sdlc('operator', [
      'ops',
      'bootstrap',
      '--tenant',
      'fresh',
      '--tenant-name',
      'Fresh',
      '--email',
      'admin@fresh.test',
      '--name',
      'Admin',
    ]);
    this.state.tokens.admin = this.keep(String(boot.token));
  }

  /** README step 9: the project and its team (Person A and Person B, each with a token). */
  team(): void {
    this.sdlc('admin', [
      'admin',
      'project',
      'create',
      '--slug',
      'pilot',
      '--name',
      'Pilot',
      '--repo',
      'acme/fresh-deploy',
    ]);
    const people = [
      { who: 'a' as const, email: 'a@fresh.test', gh: '7001', login: 'fresh-a', role: 'person_a' },
      { who: 'b' as const, email: 'b@fresh.test', gh: '7002', login: 'fresh-b', role: 'person_b' },
    ];
    for (const p of people) {
      this.sdlc('admin', ['admin', 'user', 'create', '--email', p.email, '--name', p.who]);
      this.sdlc('admin', [
        'admin',
        'identity',
        'link',
        '--user',
        p.email,
        '--github-id',
        p.gh,
        '--github-login',
        p.login,
      ]);
      this.sdlc('admin', [
        'admin',
        'role',
        'grant',
        '--project',
        'pilot',
        '--user',
        p.email,
        '--role',
        p.role,
      ]);
      const issued = this.sdlc('admin', [
        'admin',
        'token',
        'issue',
        '--user',
        p.email,
        '--name',
        `${p.who}-laptop`,
      ]);
      this.state.tokens[p.who] = this.keep(String(issued.token));
    }
  }

  /** README step 10: `build.sh node24` (`--no-push` on Docker Desktop); the image by digest. */
  buildSandboxImage(): string {
    const desktop = /Docker Desktop/i.test(
      this.run('docker', ['info', '--format', '{{.OperatingSystem}}']).stdout,
    );
    const built = this.ok(
      this.run(
        path.join(this.options.root, 'platform/sandbox-images/build.sh'),
        ['node24', ...(desktop ? ['--no-push'] : [])],
        '',
        { SDLC_SANDBOX_REGISTRY: `localhost:${5050 + this.options.project.portOffset}` },
      ),
      'sandbox-image:build',
    );
    return built.stdout.trim().split('\n').pop() ?? '';
  }

  /** README step 10 on a release checkout: the published image of `images.lock`. */
  publishedSandboxImage(): string {
    return this.ok(
      this.run(path.join(this.deployDir, 'scripts/images.sh'), ['get', 'SANDBOX_NODE24']),
      'images get SANDBOX_NODE24',
    ).stdout.trim();
  }

  /** `pnpm images mode` of this checkout: `published` or `local`. */
  imagesMode(): string {
    return this.ok(
      this.run(path.join(this.deployDir, 'scripts/images.sh'), ['mode']),
      'images mode',
    ).stdout.trim();
  }

  /** README steps 11–13: the agent, the project configuration, the project AI record. */
  agentConfigAndRecord(image: string): void {
    const agentsMd = path.join(this.options.tmp, 'AGENTS.md');
    fs.writeFileSync(agentsMd, '# Agent instructions\n\n- Keep changes small.\n');
    this.sdlc('admin', [
      'admin',
      'agent',
      'register',
      '--key',
      'coder',
      '--version',
      '1.0.0',
      '--owner',
      'a@fresh.test',
      '--model',
      MODEL,
      '--instructions',
      'AGENTS.md@v1',
      '--instructions-file',
      agentsMd,
      '--tools',
      'file_editor,terminal',
      '--max-autonomy',
      'L2',
      '--environments',
      'sandbox',
    ]);
    this.approveAgent();

    const shown = this.sdlc('admin', ['admin', 'config', 'show', '--project', 'pilot']);
    const config = path.join(this.options.tmp, 'pilot.yaml');
    fs.writeFileSync(
      config,
      [
        'run:',
        '  agent_key: coder',
        'sandbox:',
        `  image: ${image}`,
        'verification:',
        '  required_checks: [ci-ok]',
        '',
      ].join('\n'),
    );
    this.sdlc('admin', [
      'admin',
      'config',
      'set',
      '--project',
      'pilot',
      '--file',
      config,
      '--expected-version',
      String(shown.version),
    ]);

    this.sdlc('a', [
      'ai-record',
      'set',
      '--project',
      'pilot',
      '--expected-version',
      '0',
      '--ai-allowed',
      'yes',
      '--classes',
      'public,internal',
      '--prod-logs',
      'no',
      '--disclosure',
      'standard_note',
    ]);
  }

  /** The agent's two approvals (README step 11): its owner (Person A), then Person B. */
  approveAgent(): void {
    for (const as of ['owner', 'person_b'] as const) {
      this.sdlc(as === 'owner' ? 'a' : 'b', [
        'admin',
        'agent',
        'approve',
        '--key',
        'coder',
        '--purpose',
        'activate',
        '--as',
        as,
      ]);
    }
  }

  /** A token that another part showed once (`pnpm server:setup`'s step 8, V19). */
  useToken(who: Who, token: string): void {
    this.state.tokens[who] = this.keep(token);
  }

  /**
   * The V17 project file of steps 9, 11 and 12 for `pnpm server:setup` (V19): the team of `team()`
   * (GitHub logins `fresh-a` 7001, `fresh-b` 7002) and the agent and configuration of
   * `agentConfigAndRecord()`. The command adds the sandbox image.
   */
  projectFile(): string {
    fs.writeFileSync(
      path.join(this.options.tmp, 'AGENTS.md'),
      '# Agent instructions\n\n- Keep changes small.\n',
    );
    const file = path.join(this.options.tmp, 'project.yaml');
    fs.writeFileSync(
      file,
      [
        'format: 1',
        'project: {slug: pilot, name: Pilot, repository: acme/fresh-deploy}',
        'team:',
        '  - {email: a@fresh.test, name: a, github_login: fresh-a, roles: [person_a]}',
        '  - {email: b@fresh.test, name: b, github_login: fresh-b, roles: [person_b]}',
        'agent:',
        `  {key: coder, version: 1.0.0, owner: a@fresh.test, model: ${MODEL}, instructions: AGENTS.md@v1,`,
        '   instructions_file: AGENTS.md, tools: [file_editor, terminal], max_autonomy: L2,',
        '   environments: [sandbox]}',
        'config:',
        '  run: {agent_key: coder}',
        '  verification: {required_checks: [ci-ok]}',
        '',
      ].join('\n'),
    );
    return file;
  }

  /** What `pnpm server:setup` leaves to people (V19): the team's first tokens, the approvals. */
  peopleSteps(): void {
    for (const p of [
      { who: 'a' as const, email: 'a@fresh.test' },
      { who: 'b' as const, email: 'b@fresh.test' },
    ]) {
      const issued = this.sdlc('admin', [
        'admin',
        'token',
        'issue',
        '--user',
        p.email,
        '--name',
        `${p.who}-laptop`,
      ]);
      this.state.tokens[p.who] = this.keep(String(issued.token));
    }
    this.approveAgent();
  }

  /** README step 14: a new intent of Person A; its code. */
  createIntent(title: string): string {
    const created = this.sdlc('a', [
      'intent',
      'create',
      '--project',
      'pilot',
      '--title',
      title,
      '--risk',
      'low',
      '--data-class',
      'internal',
    ]);
    return String(created.code);
  }

  /** Waits until the intent is at `gate` (or the time is up); the last `intent show`. */
  async waitForGate(code: string, gate: string, ms = 120_000): Promise<Record<string, unknown>> {
    const deadline = Date.now() + ms;
    for (;;) {
      const shown = this.sdlc('a', ['intent', 'show', code]);
      if (shown.current_gate === gate || Date.now() > deadline) return shown;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  /** The services of the server profiles and their state, one `<service> <state> <health>` each. */
  services(): string[] {
    const ps = this.ok(
      this.compose(
        '',
        ...this.composeProfileArgs,
        'ps',
        '--format',
        '{{.Service}} {{.State}} {{.Health}}',
      ),
      'ps',
    );
    return ps.stdout.split('\n').filter((l) => l.trim() !== '');
  }

  /** Removes the project with its volumes (every profile that may hold one). */
  down(): void {
    this.compose(
      '',
      ...this.composeProfileArgs,
      '--profile',
      'observability',
      // A10: the backup job's AppRole volume belongs to the profile `backup` only.
      '--profile',
      'backup',
      '--profile',
      'knowledge',
      'down',
      '--volumes',
      '--remove-orphans',
    );
  }
}
