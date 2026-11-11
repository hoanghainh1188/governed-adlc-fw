// `pnpm server:setup` (D-08 V16, QUESTIONS #616, design/ADR-M98): platform/deploy/README.md
// "Fresh deployment (operator)" steps 2–7 on a server, in that order, with the shared steps of
// `trial:up` and `test:fresh-deploy` (`platform/deploy/steps`, R081). What it guarantees:
// - key custody as runbook T11 §3.2: with the key holders' PGP keys `init -pgp-keys` (the default),
//   else the shares one holder at a time, the screen and scroll-back cleared after each copy;
// - the root token is used only for `configure`, which revokes it and gives one admin token for
//   steps 4, 5 and 7; a stop before `configure` revokes the root token; the admin token is revoked
//   at the end;
// - no share and no token in a file, an environment variable, a command line or a log: they stay
//   in memory (`SecretBag`) and reach the children on stdin;
// - a new start skips what is done (OpenBao's state, the progress file) and says where the last run
//   stopped; a failure names the step and its README section; it ends with `doctor`;
// - with `access` and `runner_link` in the settings (V20): the team access proxy and the runner on
//   its own Engine, their env keys written in step 2 (the runner host's address before `configure`).
import fs from 'node:fs';
import path from 'node:path';

import type { MessageKey } from '@sdlc/messages';

import {
  databaseUrl,
  envSecrets,
  envValue,
  hostPort,
  setEnvValue,
} from '../../steps/dist/env-file.js';
import type { Exec } from '../../steps/dist/exec.js';
import {
  CREDENTIALS_COMMANDS,
  DeployStepError,
  FreshDeployment,
  PROFILES,
  type ProviderSecret,
} from '../../steps/dist/fresh-deployment.js';
import type { SecretBag } from '../../steps/dist/secrets.js';

import {
  progressFileFor,
  readProgress,
  writeProgress,
  type Progress,
  type StopReason,
} from './progress.js';
import { applyEnvKeys, EnvKeyConflict, settingsEnvKeys } from './env-keys.js';
import { accessOrigin, pgpKeyBase64, usesPgp, type ServerSettings } from './settings.js';
import { PromptAborted, type Terminal } from './terminal.js';

/** The README step of each marker, and its section (`platform/deploy/README.md#…`). */
export const README_SECTIONS = {
  '2': '#2-settings-file',
  '3': '#3-openbao',
  '4': '#4-shared-secrets',
  '5': '#5-credentials-of-every-process',
  '6': '#6-database',
  '7': '#7-start-the-platform',
} as const;
export type Step = keyof typeof README_SECTIONS;

const STEP_MESSAGES = {
  '2': 'server_setup.step.2',
  '3': 'server_setup.step.3',
  '4': 'server_setup.step.4',
  '5': 'server_setup.step.5',
  '6': 'server_setup.step.6',
  '7': 'server_setup.step.7',
} as const satisfies Record<Step, MessageKey>;

/** An admin token with less time left than this is replaced before the next command. */
const ADMIN_MIN_SECONDS = { step4: 600, command: 120 } as const;

/** A refusal before anything is changed; `code` is a catalog suffix, never a value. */
export class SetupRefused extends Error {
  constructor(
    readonly code:
      | 'litellm_keys_in_env'
      | 'trial_project'
      | 'no_project'
      | 'pgp_key_invalid'
      | 'no_share'
      | 'secret_file'
      | 'secret_file_mode'
      | 'env_conflict',
    readonly params: Readonly<Record<string, string>> = {},
  ) {
    super(`server:setup refused: ${code}`);
  }
}

/** The person stopped the command (Ctrl-C at a prompt or a signal between steps). */
export class SetupInterrupted extends Error {
  constructor() {
    super('server:setup interrupted');
  }
}

/** Where the run stopped: thrown by `serverSetup` around the cause. */
export class SetupStopped extends Error {
  constructor(
    readonly step: Step,
    readonly reason: StopReason,
    readonly rootRevoked: boolean,
    override readonly cause: unknown,
  ) {
    super(`server:setup stopped at step ${step}`);
  }
}

export interface SetupDeps {
  readonly repoRoot: string;
  readonly envFile: string;
  readonly exec: Exec;
  readonly terminal: Terminal;
  readonly bag: SecretBag;
  /** `BAO_KEY_SHARES` and `BAO_KEY_THRESHOLD` of `bootstrap.conf`. */
  readonly keys: { readonly shares: number; readonly threshold: number };
  /** True after Ctrl-C, SIGTERM or SIGHUP: the command stops before the next step. */
  readonly stopRequested: () => boolean;
  readonly now: () => Date;
}

export interface SetupResult {
  /** `tls`: a new env file; the command stopped after step 2 for the company certificate. */
  readonly outcome: 'done' | 'tls';
  readonly doctorOk?: boolean;
  readonly apiUrl?: string;
}

/** `true` when the Compose project is a trial's (`trial:up`, its live test). Pure. */
export function isTrialProject(project: string): boolean {
  return /^sdlc-trial/.test(project) || project.startsWith('sdlctrialit');
}

export async function serverSetup(settings: ServerSettings, deps: SetupDeps): Promise<SetupResult> {
  const { terminal: term, bag } = deps;
  const progressFile = progressFileFor(deps.envFile);
  let progress: Progress = readProgress(progressFile);
  const save = (p: Progress) => {
    progress = p;
    writeProgress(progressFile, p);
  };
  const isDone = (marker: string) => progress.done.includes(marker);
  const markDone = (marker: string) =>
    save({
      v: 1,
      done: [...new Set([...progress.done, marker])],
      credentials: progress.credentials,
      ...(progress.leftoverRoot ? { leftoverRoot: true as const } : {}),
    });
  const markDelivered = (command: string) =>
    save({ ...progress, credentials: [...new Set([...progress.credentials, command])] });
  const unmark = (marker: string, command?: string) =>
    save({
      ...progress,
      done: progress.done.filter((m) => m !== marker),
      credentials: progress.credentials.filter((c) => c !== command),
    });

  if (progress.stopped) {
    term.say('server_setup.resume', {
      step: progress.stopped.step,
      reason: progress.stopped.reason,
      at: progress.stopped.at,
    });
    if (!progress.stopped.rootRevoked) term.warn('server_setup.resume.root_not_revoked');
  }

  let step: Step = '2';
  let deploy: FreshDeployment | undefined;
  let rootToken = '';
  let adminToken = '';
  const begin = (n: Step) => {
    if (deps.stopRequested()) throw new SetupInterrupted();
    step = n;
    term.say(STEP_MESSAGES[n]);
  };
  const checkStop = () => {
    if (deps.stopRequested()) throw new SetupInterrupted();
  };

  try {
    // Step 2: the settings file. `compose:env` never overwrites (R078), so a new start keeps the
    // env file of the first run and does not call it again.
    begin('2');
    const existed = fs.existsSync(deps.envFile);
    if (!existed) {
      const initEnv = await deps.exec(
        path.join(deps.repoRoot, 'platform/deploy/scripts/init-env.sh'),
        [deps.envFile],
        { env: { SDLC_ENV_FILE: deps.envFile } },
      );
      if (initEnv.status !== 0) {
        throw new DeployStepError('compose:env', bag.redact(initEnv.stderr).trim());
      }
    }
    let envText = fs.readFileSync(deps.envFile, 'utf8');
    for (const value of envSecrets(envText)) bag.keep(value);
    if (!existed) {
      // On the server LiteLLM gets its keys from OpenBao (T11 §5d), never from the file.
      envText = setEnvValue(setEnvValue(envText, 'LITELLM_MASTER_KEY', ''), 'LITELLM_SALT_KEY', '');
      fs.writeFileSync(deps.envFile, envText, { mode: 0o600 });
    } else if (envValue(envText, 'LITELLM_MASTER_KEY') || envValue(envText, 'LITELLM_SALT_KEY')) {
      throw new SetupRefused('litellm_keys_in_env', { path: deps.envFile });
    }
    const composeProject = envValue(envText, 'COMPOSE_PROJECT_NAME') ?? '';
    if (composeProject === '') throw new SetupRefused('no_project', { path: deps.envFile });
    if (isTrialProject(composeProject)) {
      throw new SetupRefused('trial_project', { project: composeProject });
    }
    envText = writeSettingsKeys(envText);
    const d = new FreshDeployment({
      repoRoot: deps.repoRoot,
      envFile: deps.envFile,
      composeProject,
      exec: deps.exec,
      bag,
    });
    deploy = d;
    markDone('2');
    if (!existed && !settings.throwawayTls) {
      // OpenBao's certificate comes from the company CA before step 3 (T11 §3c).
      term.say('server_setup.tls.replace_first', { path: deps.envFile });
      return { outcome: 'tls' };
    }

    /** Key shares at a hidden prompt, one per holder present (T11 §3.2 step 5, §5). */
    const askShares = async (): Promise<string[]> => {
      const shares: string[] = [];
      for (let n = 1; n <= deps.keys.threshold; n += 1) {
        const share = (
          await term.hidden('server_setup.share.prompt', {
            n,
            threshold: deps.keys.threshold,
          })
        ).trim();
        if (share === '') throw new SetupRefused('no_share');
        shares.push(bag.keep(share));
      }
      return shares;
    };
    /** `configure` with a root token: it revokes the root token and gives the admin token. */
    const configureWith = async (root: string): Promise<void> => {
      rootToken = root;
      if (progress.leftoverRoot) {
        // An earlier run stopped while OpenBao was sealed: its root token is revoked now.
        const revoked = await d.revokeOtherRootTokens(root);
        term.say('server_setup.resume.root_revoked', { count: revoked });
        const { leftoverRoot: _done, ...rest } = progress;
        void _done;
        save(rest);
      }
      adminToken = await d.configure(root);
      bag.drop(rootToken);
      rootToken = '';
    };
    /** The admin token, replaced through `configure` when it has too little time left. */
    const ensureAdmin = async (minSeconds: number): Promise<string> => {
      if (adminToken) {
        const ttl = await d.tokenTtl(adminToken);
        if (ttl !== undefined && ttl >= minSeconds) return adminToken;
        await revokeAdmin();
      }
      term.say('server_setup.admin.needs_root');
      await configureWith(await d.rootTokenFromShares(await askShares()));
      return adminToken;
    };

    // Step 3: OpenBao, PostgreSQL and SeaweedFS; init, unseal, configure.
    begin('3');
    await d.startStores();
    let state = await d.openbaoState();
    if (state === 'uninitialised') {
      const pgpKeys = usesPgp(settings) ? settings.keyHolders.map(readPgpKey) : undefined;
      term.say(pgpKeys ? 'server_setup.init.pgp' : 'server_setup.init.plain', {
        holders: settings.keyHolders.map((h) => h.name).join(', '),
      });
      await term.pause('server_setup.init.ready');
      const init = await d.initOpenBao({ ...deps.keys, ...(pgpKeys ? { pgpKeys } : {}) });
      rootToken = init.rootToken;
      markDone('3.init');
      await showShares(init.shares, pgpKeys !== undefined);
      init.shares.length = 0;
      state = 'sealed';
    }
    checkStop();
    if (state === 'sealed') {
      term.say('server_setup.unseal.explain', { threshold: deps.keys.threshold });
      await d.unseal(await askShares());
    }
    checkStop();
    if (!isDone('3.configure')) {
      // In the run of `init`, its own root token; after a stop, a new one from two shares.
      if (!rootToken) {
        term.say('server_setup.admin.needs_root');
        rootToken = await d.rootTokenFromShares(await askShares());
      }
      await configureWith(rootToken);
      markDone('3.configure');
    }

    // Step 4: the shared secrets, from the files of the settings or a hidden prompt.
    begin('4');
    if (!isDone('4')) {
      const token = await ensureAdmin(ADMIN_MIN_SECONDS.step4);
      await d.storeGithubApp(token, settings.appClientId, readSecretFile(settings.appKeyFile));
      await d.storeLitellmKeys(token);
      for (const p of settings.providers) {
        checkStop();
        await d.storeProvider(token, await providerSecret(p));
      }
      markDone('4');
    }

    // Step 5: the credentials of every process, one command at a time.
    begin('5');
    for (const command of CREDENTIALS_COMMANDS) {
      if (progress.credentials.includes(command)) continue;
      checkStop();
      await d.credentials(await ensureAdmin(ADMIN_MIN_SECONDS.command), command);
      markDelivered(command);
    }
    markDone('5');

    // Step 6: the database; the owner's URL is built from the env file and goes on stdin.
    begin('6');
    const applied = await d.migrate(bag.keep(databaseUrl(envText, 'platform')));
    term.say('server_setup.migrate.done', { applied });
    markDone('6');

    // Step 7: the platform, with the optional parts of the settings.
    begin('7');
    const has = (part: ServerSettings['optional'][number]) => settings.optional.includes(part);
    if (has('dashboard-signin') && settings.dashboard) {
      if (!isDone('7.dashboard-signin')) {
        const secret = settings.dashboard.clientSecretFile
          ? readSecretFile(settings.dashboard.clientSecretFile)
          : await term.hidden('server_setup.secret.github_client_secret');
        // Without a controlling terminal, the command reads the token from stdin, not /dev/tty.
        await d.credentials(
          await ensureAdmin(ADMIN_MIN_SECONDS.command),
          'api-github-oauth-credentials',
          `${bag.keep(secret.trim())}\n`,
          true,
        );
        markDelivered('api-github-oauth-credentials');
        markDone('7.dashboard-signin');
      }
      envText = setEnvValue(envText, 'SDLC_API_WEB_SIGNIN', 'github');
      envText = setEnvValue(envText, 'SDLC_API_PUBLIC_ORIGIN', settings.dashboard.publicOrigin);
    }
    if (has('dashboard-actions'))
      envText = setEnvValue(envText, 'SDLC_API_DASHBOARD_ACTIONS', 'on');
    if (envText !== fs.readFileSync(deps.envFile, 'utf8')) {
      fs.writeFileSync(deps.envFile, envText, { mode: 0o600 });
    }
    // The runner on its own Engine: the profile runner-link instead of sandbox (README runner step
    // 4); `up.sh` refuses sandbox while SDLC_RUNNER_LINK_ADDR is set.
    const link = settings.runnerLink !== undefined;
    const profiles = [
      ...PROFILES.map((p) => (p === 'sandbox' && link ? 'runner-link' : p)),
      ...(has('observability') ? ['observability'] : []),
      ...(has('knowledge') ? ['knowledge'] : []),
      ...(settings.access ? ['access'] : []),
    ];
    if (settings.access?.certificateFolder && !isDone('7.access-tls')) {
      // The company CA's certificate for the proxy (README "Team access" step 3, T11 §3d).
      checkStop();
      const imported = await deps.exec(
        path.join(deps.repoRoot, 'platform/deploy/access/tls.sh'),
        ['import', settings.access.certificateFolder],
        { env: { SDLC_ENV_FILE: deps.envFile } },
      );
      if (imported.status !== 0) {
        throw new DeployStepError('access:tls import', bag.redact(imported.stderr).trim());
      }
      markDone('7.access-tls');
    }
    if (link && !isDone('7.runner-moved')) {
      // A runner of an earlier start on the platform's Engine goes first (README runner step 4).
      checkStop();
      d.ok(
        await d.compose(
          '',
          '--profile',
          'sandbox',
          'rm',
          '--stop',
          '--force',
          'sdlc-runner',
          'docker-socket-proxy',
          'npm-proxy',
        ),
        'compose rm sdlc-runner',
      );
      markDone('7.runner-moved');
    }
    checkStop();
    await d.up(profiles);
    markDone('7.up');
    const restart = async (...services: string[]) =>
      d.ok(
        await d.compose('', ...profiles.flatMap((p) => ['--profile', p]), 'restart', ...services),
        `restart ${services.join(' ')}`,
      );
    if (has('knowledge') && !isDone('7.knowledge')) {
      for (const command of ['worker-knowledge-credentials', 'knowledge-issuer-credentials']) {
        if (progress.credentials.includes(command)) continue;
        checkStop();
        await d.credentials(await ensureAdmin(ADMIN_MIN_SECONDS.command), command);
        markDelivered(command);
      }
      // On its own Engine the runner restarts on the runner host (said at the end).
      await restart(...(link ? ['sdlc-worker'] : ['sdlc-worker', 'sdlc-runner']));
      markDone('7.knowledge');
    }
    if (has('observability') && !isDone('7.observability')) {
      term.say('server_setup.langfuse.explain', {
        url: `http://127.0.0.1:${hostPort(envText, 'LANGFUSE_HOST_PORT', 3000)}`,
      });
      const publicKey = (await term.hidden('server_setup.langfuse.public_key')).trim();
      const secretKey = bag.keep((await term.hidden('server_setup.langfuse.secret_key')).trim());
      await d.credentials(
        await ensureAdmin(ADMIN_MIN_SECONDS.command),
        'worker-langfuse-credentials',
        `${publicKey}\n${secretKey}\n`,
      );
      markDelivered('worker-langfuse-credentials');
      await restart('sdlc-worker');
      markDone('7.observability');
    }
    markDone('7');
    if (settings.access)
      term.say('server_setup.access.ready', { url: accessOrigin(settings.access) });
    if (link) {
      term.say('server_setup.runner_link.next', { profiles: has('knowledge') ? ' knowledge' : '' });
    }

    // The admin token is not needed any more; then `doctor` (read only, prints no secret).
    await revokeAdmin();
    term.say('server_setup.doctor');
    const doctor = await deps.exec(
      'node',
      [path.join(deps.repoRoot, 'platform/deploy/doctor/dist/main.js'), '--env', deps.envFile],
      { env: { SDLC_ENV_FILE: deps.envFile } },
    );
    term.print(bag.redact(`${doctor.stdout}${doctor.stderr}`).trim());
    save({
      v: 1,
      done: progress.done,
      credentials: progress.credentials,
      ...(progress.leftoverRoot ? { leftoverRoot: true as const } : {}),
    });
    return {
      outcome: 'done',
      doctorOk: doctor.status === 0,
      apiUrl: `http://127.0.0.1:${hostPort(envText, 'SDLC_API_HOST_PORT', 8090)}`,
    };
  } catch (error) {
    const reason: StopReason =
      error instanceof SetupInterrupted || error instanceof PromptAborted
        ? 'interrupted'
        : 'failed';
    // No root token stays valid once the command has stopped (QUESTIONS #616 (a)).
    let rootRevoked = true;
    if (rootToken && deploy) {
      // Revoked, or definitely no longer valid; a sealed or unreachable OpenBao is not an answer.
      rootRevoked =
        (await deploy.revoke(rootToken)) ||
        (await deploy.tokenState(rootToken)).state === 'invalid';
    } else if (rootToken) {
      rootRevoked = false;
    }
    save({
      ...progress,
      ...(rootRevoked ? {} : { leftoverRoot: true as const }),
      stopped: { step, reason, at: deps.now().toISOString(), rootRevoked },
    });
    throw new SetupStopped(step, reason, rootRevoked, error);
  } finally {
    await revokeAdmin();
    if (rootToken) bag.drop(rootToken);
    rootToken = '';
  }

  /**
   * The env keys of `access` and `runner_link` (V20), written in step 2. A new runner host address
   * after `configure` means `configure` again (only it lets the AppRole runner accept the address);
   * a new runner Docker host means the runner's credentials again, into the runner host's volume.
   */
  function writeSettingsKeys(text: string): string {
    let result: ReturnType<typeof applyEnvKeys>;
    try {
      result = applyEnvKeys(text, settingsEnvKeys(settings, text));
    } catch (error) {
      if (!(error instanceof EnvKeyConflict)) throw error;
      throw new SetupRefused('env_conflict', { key: error.key, path: deps.envFile });
    }
    if (result.changed.length === 0) return text;
    fs.writeFileSync(deps.envFile, result.text, { mode: 0o600 });
    term.say('server_setup.env.keys', { keys: result.changed.join(', ') });
    if (result.changed.includes('SDLC_RUNNER_SOURCE_CIDR') && isDone('3.configure')) {
      term.say('server_setup.runner_link.configure_again');
      unmark('3.configure');
    }
    if (result.changed.includes('SDLC_RUNNER_DOCKER_HOST')) {
      unmark('7.runner-moved', 'runner-credentials');
      unmark('5');
    }
    return result.text;
  }

  /** Revokes the admin token; says so when OpenBao does not confirm it (review V16). */
  async function revokeAdmin(): Promise<void> {
    if (!adminToken) return;
    const token = adminToken;
    adminToken = '';
    const done =
      deploy !== undefined &&
      ((await deploy.revoke(token)) || (await deploy.tokenState(token)).state === 'invalid');
    if (!done) term.warn('server_setup.admin.not_revoked');
    bag.drop(token);
  }

  /** Each holder sees only their own share; the screen and scroll-back are cleared after it. */
  async function showShares(shares: readonly string[], pgp: boolean): Promise<void> {
    const total = shares.length;
    for (const [i, share] of shares.entries()) {
      const holder = settings.keyHolders[i]?.name ?? String(i + 1);
      for (;;) {
        term.clear();
        try {
          await term.pause('server_setup.share.call', { holder, n: i + 1, total });
          term.say(pgp ? 'server_setup.share.pgp' : 'server_setup.share.plain', {
            holder,
            n: i + 1,
            total,
          });
          term.showSecret(share);
          await term.pause('server_setup.share.copied', { holder });
          break;
        } catch (error) {
          if (!(error instanceof PromptAborted)) throw error;
          // The shares exist only here: a stop now means a new init on wiped volumes (review
          // V16). A second Ctrl-C stops; Enter shows this holder's share again.
          term.clear();
          term.warn('server_setup.share.stop_warning', { shown: i, total });
          await term.pause('server_setup.share.stop_confirm');
        } finally {
          term.clear();
        }
      }
    }
    term.say('server_setup.share.all_copied', { total });
  }

  function readPgpKey(holder: ServerSettings['keyHolders'][number]): string {
    try {
      return pgpKeyBase64(fs.readFileSync(holder.pgpKeyFile ?? '', 'utf8'));
    } catch {
      throw new SetupRefused('pgp_key_invalid', { holder: holder.name });
    }
  }

  /** A secret file of the settings: readable by its owner only (mode 600 or stricter). */
  function readSecretFile(file: string): string {
    let mode: number;
    try {
      mode = fs.statSync(file).mode;
    } catch {
      throw new SetupRefused('secret_file', { path: file });
    }
    if ((mode & 0o077) !== 0) throw new SetupRefused('secret_file_mode', { path: file });
    try {
      return bag.keep(fs.readFileSync(file, 'utf8'));
    } catch {
      throw new SetupRefused('secret_file', { path: file });
    }
  }

  async function providerSecret(p: ServerSettings['providers'][number]): Promise<ProviderSecret> {
    if (p.provider === 'ollama') return { provider: 'ollama', apiBase: p.apiBase };
    const apiKey = p.apiKeyFile
      ? readSecretFile(p.apiKeyFile)
      : await term.hidden('server_setup.secret.provider_key', { provider: p.provider });
    return { provider: 'anthropic', apiKey: bag.keep(apiKey.trim()) };
  }
}
