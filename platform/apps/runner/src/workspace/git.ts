// The runner clones the repository for a run (D-08 C04 AC2, QUESTIONS #52, ADR-M25 §2.1, §2.11).
// The sandbox never talks to GitHub and never sees the token.
//
// The run's short-lived single-repository token reaches git only through the environment of the
// git process, as an `http.<origin>/.extraheader` (GIT_CONFIG_COUNT/KEY/VALUE, git 2.31+):
// - never in the command line (visible in `ps`), the clone URL or `.git/config`;
// - sent only to the configured Git host origin, not to a redirect elsewhere.
// The git process also gets no system or user configuration, no terminal prompt, no hooks, no
// submodules, and only the HTTPS protocol (HTTP only with the development setting).
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type { RedactedSecret } from '@sdlc/contracts';

import { RunnerError } from '../errors.js';

export interface GitSettings {
  /** Git host origin, for example `https://github.com`. */
  readonly baseUrl: URL;
  /** Allows an `http://` host: development and tests only. */
  readonly allowPlaintext: boolean;
  readonly timeoutMs: number;
}

export interface CloneInput {
  /** `owner/name` from the contract. */
  readonly repo: string;
  /** 40 hex characters from the contract. */
  readonly baseSha: string;
  /** `agent/INT-…` from the contract. */
  readonly branch: string;
  readonly token: RedactedSecret;
  /** Empty directory the clone goes into; the caller removes it. */
  readonly dir: string;
}

export type CloneFailure = 'clone_failed' | 'base_sha_not_found' | 'token_leaked';

/** Why a network step of the push failed (C08): codes only, never git's own text. */
export type PushFailure = 'clone_failed' | 'remote_read_failed' | 'push_rejected';

export class PushError extends RunnerError {
  constructor(readonly reason: PushFailure) {
    super('runner.workspace.push_failed', { reason });
  }
}

export class CloneError extends RunnerError {
  constructor(readonly reason: CloneFailure) {
    super('runner.workspace.clone_failed', { reason });
  }
}

const REPO = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const SHA = /^[0-9a-f]{40}$/;
/** A run's branch, or `evaluation`: the local branch of an evaluation run's clone (task L04). */
const BRANCH = /^(?:agent\/INT-[0-9]{4}-[0-9]{4,9}|evaluation)$/;
/** X13 PR 3a (ADR-M74 §2.5 step 4): the memory branch of one run, pushed only. */
export const MEMORY_BRANCH = /^agent\/INT-[0-9]{4}-[0-9]{4,9}-memory-[1-9][0-9]{0,3}$/;

/** Environment of every git process: nothing inherited but PATH. */
function baseEnv(home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: 'true',
    GIT_LFS_SKIP_SMUDGE: '1',
  };
}

/** The token as an extra HTTP header for the Git host origin only. */
export function authEnv(settings: GitSettings, token: RedactedSecret): NodeJS.ProcessEnv {
  const basic = Buffer.from(`x-access-token:${token.reveal()}`, 'utf8').toString('base64');
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `http.${settings.baseUrl.origin}/.extraheader`,
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
}

/** Safety options for every git command. */
function safetyArgs(settings: GitSettings): string[] {
  return [
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'protocol.allow=never',
    '-c',
    'protocol.https.allow=always',
    ...(settings.allowPlaintext ? ['-c', 'protocol.http.allow=always'] : []),
    '-c',
    'submodule.recurse=false',
    '-c',
    'core.symlinks=true',
    '-c',
    'advice.detachedHead=false',
  ];
}

function git(args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { env, timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      // Git's own error text is not passed on: it can hold the URL or server messages.
      if (error) reject(new Error('git failed'));
      else resolve(stdout.trim());
    });
  });
}

/** Checks the inputs of a push: repository, branch (`agent/INT-…`) and commit. */
function checkPushInput(repo: string, branch: string, commit?: string): void {
  const named = BRANCH.test(branch) || MEMORY_BRANCH.test(branch);
  if (!REPO.test(repo) || !named || (commit !== undefined && !SHA.test(commit))) {
    throw new PushError('push_rejected');
  }
}

/**
 * Clones `repo` without a working tree for a push (task C08, ADR-M38 §2.2): the runner builds the
 * commit in the index only, so no file of the change is ever written to its disk. The token goes
 * into the git process's environment only, as for `cloneForRun`, and is checked to be nowhere in
 * `.git`. Returns the repository directory (`<dir>/repo`); `<dir>/home` is git's HOME.
 */
export async function cloneForPush(
  settings: GitSettings,
  input: { readonly repo: string; readonly token: RedactedSecret; readonly dir: string },
): Promise<string> {
  if (!REPO.test(input.repo)) throw new PushError('clone_failed');
  const home = path.join(input.dir, 'home');
  const repoDir = path.join(input.dir, 'repo');
  fs.mkdirSync(home, { mode: 0o700 });
  try {
    await git(
      [
        ...safetyArgs(settings),
        'clone',
        '--quiet',
        '--no-tags',
        '--no-checkout',
        '--no-recurse-submodules',
        '--',
        cloneUrl(settings, input.repo),
        repoDir,
      ],
      { ...baseEnv(home), ...authEnv(settings, input.token) },
      settings.timeoutMs,
    );
  } catch {
    throw new PushError('clone_failed');
  }
  const config = fs.readFileSync(path.join(repoDir, '.git', 'config'), 'utf8');
  if (config.includes(input.token.reveal()) || /extraheader|authorization/i.test(config)) {
    throw new PushError('clone_failed');
  }
  return repoDir;
}

/** The commit `refs/heads/<branch>` points to on the Git host now, or null when it does not exist. */
export async function remoteBranchHead(
  settings: GitSettings,
  input: {
    readonly repo: string;
    readonly branch: string;
    readonly token: RedactedSecret;
    readonly home: string;
  },
): Promise<string | null> {
  checkPushInput(input.repo, input.branch);
  let out: string;
  try {
    out = await git(
      [
        ...safetyArgs(settings),
        'ls-remote',
        '--refs',
        '--',
        cloneUrl(settings, input.repo),
        `refs/heads/${input.branch}`,
      ],
      { ...baseEnv(input.home), ...authEnv(settings, input.token) },
      settings.timeoutMs,
    );
  } catch {
    throw new PushError('remote_read_failed');
  }
  // `ls-remote` matches patterns by their trailing components: keep the exact ref only, so a ref
  // such as `refs/heads/x/refs/heads/agent/INT-…` can neither hide nor block the branch.
  const exact = out
    .split('\n')
    .map((line) => line.split('\t'))
    .filter(([, ref]) => ref === `refs/heads/${input.branch}`);
  if (exact.length === 0) return null;
  const sha = exact.length === 1 ? exact[0]![0] : undefined;
  if (!sha || !SHA.test(sha)) throw new PushError('remote_read_failed');
  return sha;
}

/**
 * Pushes `commit` to `refs/heads/<branch>` with an explicit refspec and no force (ADR-M25 §2.1,
 * ADR-M38 §2.2): the Git host accepts it only as a new branch or a fast-forward. Branch
 * protection on the default branch is the backstop (N6); the branch pattern is checked here too.
 */
export async function pushCommit(
  settings: GitSettings,
  input: {
    readonly repoDir: string;
    readonly repo: string;
    readonly branch: string;
    readonly commit: string;
    readonly token: RedactedSecret;
    readonly home: string;
  },
): Promise<void> {
  checkPushInput(input.repo, input.branch, input.commit);
  try {
    await git(
      [
        ...safetyArgs(settings),
        '-C',
        input.repoDir,
        'push',
        '--quiet',
        '--no-verify',
        '--',
        cloneUrl(settings, input.repo),
        `${input.commit}:refs/heads/${input.branch}`,
      ],
      { ...baseEnv(input.home), ...authEnv(settings, input.token) },
      settings.timeoutMs,
    );
  } catch {
    throw new PushError('push_rejected');
  }
}

export function cloneUrl(settings: GitSettings, repo: string): string {
  return `${settings.baseUrl.origin}/${repo}.git`;
}

/**
 * Clones `repo`, checks out `baseSha` on the new branch `branch`, and checks that the token is
 * nowhere in the repository's configuration. Returns the repository directory.
 */
export async function cloneForRun(settings: GitSettings, input: CloneInput): Promise<string> {
  if (!REPO.test(input.repo) || !SHA.test(input.baseSha) || !BRANCH.test(input.branch)) {
    throw new CloneError('clone_failed');
  }
  const home = path.join(input.dir, 'home');
  const repoDir = path.join(input.dir, 'repo');
  fs.mkdirSync(home, { mode: 0o700 });
  const env = baseEnv(home);
  const safety = safetyArgs(settings);

  try {
    await git(
      [
        ...safety,
        'clone',
        '--quiet',
        '--no-tags',
        '--no-checkout',
        '--no-recurse-submodules',
        '--',
        cloneUrl(settings, input.repo),
        repoDir,
      ],
      { ...env, ...authEnv(settings, input.token) },
      settings.timeoutMs,
    );
  } catch {
    throw new CloneError('clone_failed');
  }
  try {
    // The base commit must be in the clone; the branch starts there.
    await git(
      [...safety, '-C', repoDir, 'checkout', '--quiet', '-b', input.branch, input.baseSha],
      env,
      settings.timeoutMs,
    );
  } catch {
    throw new CloneError('base_sha_not_found');
  }
  const head = await git([...safety, '-C', repoDir, 'rev-parse', 'HEAD'], env, settings.timeoutMs);
  if (head !== input.baseSha) throw new CloneError('base_sha_not_found');

  // Defence in depth: the token must not be stored anywhere in `.git` config files.
  const config = fs.readFileSync(path.join(repoDir, '.git', 'config'), 'utf8');
  if (config.includes(input.token.reveal()) || /extraheader|authorization/i.test(config)) {
    throw new CloneError('token_leaked');
  }
  return repoDir;
}
