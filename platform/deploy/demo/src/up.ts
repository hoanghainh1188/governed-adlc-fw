// `pnpm demo:up` (D-08 V23, issue #561): starts a self-contained 5-minute local demo stack in
// Lite Mode (`core` + `platform`), auto-unseals a throw-away dev OpenBao, seeds two demo users
// (`demo-person-a`, `demo-person-b`), and configures U10 uploaded plans — no GitHub account,
// GitHub App, or external LLM key required.
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { databaseUrl } from '../../steps/dist/env-file.js';
import type { Exec, ExecResult } from '../../steps/dist/exec.js';
import { DeployStepError, FreshDeployment } from '../../steps/dist/fresh-deployment.js';
import { SecretBag } from '../../steps/dist/secrets.js';

import {
  DEMO_PERSON_A,
  DEMO_PERSON_B,
  DEMO_PROJECT_NAME,
  DEMO_PROJECT_SLUG,
  DEMO_REPO,
  DEMO_TENANT,
  DEMO_TENANT_NAME,
  demoProjectConfig,
  type DemoPerson,
} from './demo-config.js';
import {
  DEMO_CREDENTIALS_COMMANDS,
  DEMO_PROFILES,
  DEMO_PROJECT,
  demoApiUrl,
  demoEnv,
  envSecrets,
  envValue,
} from './env-file.js';

export type { Exec, ExecResult };
export { DeployStepError as DemoStepError };

/** One `adlc ...` command invoked in-process via `runCli`. */
export type Sdlc = (
  argv: readonly string[],
  env: Readonly<Record<string, string>>,
  stdin?: string,
) => Promise<ExecResult>;

export interface DemoUpDeps {
  readonly repoRoot: string;
  /** Isolated folder holding `.env`, `openbao-tls/`, `person-a/`, and `person-b/`. */
  readonly demoDir: string;
  readonly project?: string;
  readonly exec: Exec;
  readonly sdlc: Sdlc;
  readonly log: (line: string) => void;
}

export interface DemoUpResult {
  readonly apiUrl: string;
  readonly composeProject: string;
  readonly envFile: string;
  readonly personAConfigHome: string;
  readonly personBConfigHome: string;
}

/** OpenBao unseal threshold used by `bootstrap.sh init` with `SDLC_OPENBAO_THROWAWAY=1`. */
const KEY_THRESHOLD = 2;

/** Generates a throw-away RSA private key in memory so OpenBao holds a valid PEM without GitHub. */
function generateThrowawayGithubKey(): string {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  return privateKey;
}

export async function demoUp(deps: DemoUpDeps): Promise<DemoUpResult> {
  const bag = new SecretBag();
  const deployDir = path.join(deps.repoRoot, 'platform/deploy');
  const envFile = path.join(deps.demoDir, '.env');
  const personAConfigHome = path.join(deps.demoDir, 'person-a');
  const personBConfigHome = path.join(deps.demoDir, 'person-b');

  fs.mkdirSync(deps.demoDir, { recursive: true, mode: 0o700 });

  const run = (
    cmd: string,
    args: readonly string[],
    input = '',
    env: Record<string, string> = {},
  ) => deps.exec(cmd, args, { input, env: { SDLC_ENV_FILE: envFile, ...env } });

  // Step 1: Generate isolated Lite Mode env file + local OpenBao dev TLS certs inside `.demo/`.
  deps.log('[1/6] Generating isolated demo environment (.demo/.env, Lite Mode)...');
  const initEnv = await run(path.join(deployDir, 'scripts/init-env.sh'), [envFile]);
  if (initEnv.status !== 0) throw new DeployStepError('compose:env', bag.redact(initEnv.stderr));
  const envText = demoEnv(fs.readFileSync(envFile, 'utf8'), deps.project ?? DEMO_PROJECT);
  fs.writeFileSync(envFile, envText, { mode: 0o600 });
  const apiUrl = demoApiUrl(envText);
  for (const value of envSecrets(envText)) bag.keep(value);

  const composeProject = envValue(envText, 'COMPOSE_PROJECT_NAME') ?? DEMO_PROJECT;
  const deploy = new FreshDeployment({
    repoRoot: deps.repoRoot,
    envFile,
    composeProject,
    exec: deps.exec,
    bag,
    bootstrapEnv: { SDLC_OPENBAO_THROWAWAY: '1' },
  });
  const ok = (r: ExecResult, what: string): ExecResult => deploy.ok(r, what);

  // Step 2: Start core stores and auto-unseal throw-away OpenBao in memory.
  deps.log('[2/6] Starting core stores (PostgreSQL, OpenBao, SeaweedFS) and unsealing OpenBao...');
  await deploy.startStores();
  const { shares, rootToken } = await deploy.initOpenBao({ shares: 3, threshold: KEY_THRESHOLD });
  let adminToken = '';
  try {
    try {
      await deploy.unseal(shares.slice(0, KEY_THRESHOLD));
    } finally {
      for (const share of shares) bag.drop(share);
      shares.length = 0;
    }
    adminToken = await deploy.configure(rootToken);
  } finally {
    if (!adminToken) await deploy.revoke(rootToken);
    bag.drop(rootToken);
  }

  // Step 3: Store throw-away GitHub App placeholder key + issue API/worker credentials.
  deps.log('[3/6] Provisioning throw-away OpenBao secrets and process credentials...');
  try {
    const throwawayKey = bag.keep(generateThrowawayGithubKey());
    await deploy.storeGithubApp(adminToken, 'demo-no-github-app', throwawayKey);
    bag.drop(throwawayKey);
    for (const command of DEMO_CREDENTIALS_COMMANDS) {
      await deploy.credentials(adminToken, command);
    }
  } finally {
    await deploy.revoke(adminToken);
    bag.drop(adminToken);
  }

  // Step 4: Run database migrations.
  deps.log('[4/6] Running database migrations...');
  await deploy.migrate(databaseUrl(envText, 'platform'));
  const opsUrl = bag.keep(databaseUrl(envText, 'platform_app'));

  // Step 5: Start Lite Mode platform stack (`core` + `platform`, no observability/models/sandbox).
  deps.log('[5/6] Starting platform services (API, Dashboard, Worker, Temporal)...');
  await deploy.up(DEMO_PROFILES);

  // Step 6: Seed demo tenant, project, Person A & Person B, project config, AI record, and CLI logins.
  deps.log('[6/6] Seeding demo tenant, demo-person-a, demo-person-b, and project configuration...');
  const sdlcJson = async (argv: readonly string[], env: Record<string, string>, what: string) => {
    const r = ok(await deps.sdlc([...argv, '--json'], env), what);
    return JSON.parse(r.stdout) as Record<string, unknown>;
  };
  const ops = (argv: readonly string[]) =>
    sdlcJson(['ops', ...argv], { SDLC_DB_URL: opsUrl }, `adlc ops ${argv[0]}`);
  const tokens = { a: '', b: '' };
  const asA = (argv: readonly string[]) =>
    sdlcJson(
      argv,
      { SDLC_API_URL: apiUrl, SDLC_API_TOKEN: tokens.a },
      `adlc ${argv.slice(0, 3).join(' ')}`,
    );

  const boot = await ops([
    'bootstrap',
    '--tenant',
    DEMO_TENANT,
    '--tenant-name',
    DEMO_TENANT_NAME,
    '--email',
    DEMO_PERSON_A.email,
    '--name',
    DEMO_PERSON_A.name,
  ]);
  tokens.a = bag.keep(String(boot.token));

  await asA([
    'admin',
    'project',
    'create',
    '--slug',
    DEMO_PROJECT_SLUG,
    '--name',
    DEMO_PROJECT_NAME,
    '--repo',
    DEMO_REPO,
  ]);
  await ops([
    'role',
    'grant',
    '--tenant',
    DEMO_TENANT,
    '--project',
    DEMO_PROJECT_SLUG,
    '--email',
    DEMO_PERSON_A.email,
    '--role',
    DEMO_PERSON_A.role,
  ]);
  await asA([
    'admin',
    'user',
    'create',
    '--email',
    DEMO_PERSON_B.email,
    '--name',
    DEMO_PERSON_B.name,
  ]);
  await asA([
    'admin',
    'role',
    'grant',
    '--project',
    DEMO_PROJECT_SLUG,
    '--user',
    DEMO_PERSON_B.email,
    '--role',
    DEMO_PERSON_B.role,
  ]);
  const issued = await ops([
    'token',
    'issue',
    '--tenant',
    DEMO_TENANT,
    '--email',
    DEMO_PERSON_B.email,
    '--name',
    'demo',
    '--days',
    '30',
  ]);
  tokens.b = bag.keep(String(issued.token));

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-demo-'));
  try {
    const shown = await asA(['admin', 'config', 'show', '--project', DEMO_PROJECT_SLUG]);
    const configPath = path.join(work, `${DEMO_PROJECT_SLUG}.yaml`);
    fs.writeFileSync(configPath, demoProjectConfig());
    await asA([
      'admin',
      'config',
      'set',
      '--project',
      DEMO_PROJECT_SLUG,
      '--file',
      configPath,
      '--expected-version',
      String(shown.version),
    ]);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }

  await asA([
    'ai-record',
    'set',
    '--project',
    DEMO_PROJECT_SLUG,
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

  await login(DEMO_PERSON_A, personAConfigHome, tokens.a);
  await login(DEMO_PERSON_B, personBConfigHome, tokens.b);

  return {
    apiUrl,
    composeProject,
    envFile,
    personAConfigHome,
    personBConfigHome,
  };

  async function login(_person: DemoPerson, configHome: string, token: string): Promise<void> {
    fs.mkdirSync(configHome, { recursive: true, mode: 0o700 });
    ok(
      await deps.sdlc(
        ['login', '--api-url', apiUrl, '--token-stdin', '--json'],
        { XDG_CONFIG_HOME: configHome },
        token,
      ),
      'adlc login',
    );
  }
}
