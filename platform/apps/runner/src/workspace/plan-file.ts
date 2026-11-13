// The runner reads the plan file of a run from its own clone (task B09 PR 2, design/ADR-M40 §2.7,
// QUESTIONS #169): `.sdlc/plans/<intent code>.yaml` at the plan's `commit_sha`, never from the
// sandbox. The clone is full (`cloneForRun` has no depth limit), so every commit of the default
// branch is in it; the clone token is revoked right after the clone (C11), so nothing is fetched:
// a commit that is not in the clone fails closed (`commit_missing`).
//
// Hardened git only (`gitArgs`, `gitEnv`: no system or user configuration, no hooks, no
// fsmonitor, no replace objects), no token, no network. The object must be a regular file in the
// commit's tree (mode 100644 or 100755: never a symbolic link or a submodule), at most 64 KiB,
// checked before its bytes are read. `cat-file blob` returns the stored bytes: no attribute,
// filter or text conversion applies. The bytes are client text: returned to the caller only.
import { execFile } from 'node:child_process';
import path from 'node:path';

import { PLAN_MAX_BYTES } from '@sdlc/core';

import { gitArgs, gitEnv } from './proposal.js';

/** Why a plan file cannot be read from the clone (run event `plan_unavailable`). */
export type PlanBlobFailure =
  | 'commit_missing'
  | 'missing'
  | 'not_a_file'
  | 'too_large'
  // git could not answer (a timeout, a broken clone): never a fact about the file.
  | 'git_failed';

export type PlanBlobRead =
  | { readonly kind: 'ok'; readonly bytes: Buffer }
  | { readonly kind: 'unreadable'; readonly cause: PlanBlobFailure };

/** Reads a plan file at a commit; the runner builds it from the run's kept clone. */
export type PlanFileReader = (commitSha: string, filePath: string) => Promise<PlanBlobRead>;

const SHA = /^[0-9a-f]{40}$/;
const OID = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;
const PLAN_FILE = /^\.sdlc\/plans\/INT-[0-9]{4}-[0-9]{4,9}\.yaml$/;
const REGULAR_FILE_MODES: ReadonlySet<string> = new Set(['100644', '100755']);

export class GitFailed extends Error {
  /** True when git ran and said no (an exit code); false when it was killed or did not start. */
  constructor(readonly answered: boolean) {
    super('git failed');
  }
}

export function gitIn(
  cloneDir: string,
  args: readonly string[],
  timeoutMs: number,
  maxBuffer: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      gitArgs(path.join(cloneDir, 'repo'), args),
      {
        env: gitEnv(path.join(cloneDir, 'home')),
        timeout: timeoutMs,
        maxBuffer,
        encoding: 'buffer',
      },
      (error, stdout) => {
        // Git's own text is never passed on.
        if (error) reject(new GitFailed(typeof error.code === 'number' && !error.killed));
        else resolve(stdout);
      },
    );
  });
}

/**
 * The plan file `filePath` at `commitSha` in the runner's clone (`<cloneDir>/repo`, git's HOME
 * `<cloneDir>/home`). Every outcome is a result: a git failure (a timeout, a broken clone) is
 * `git_failed`, never a fact about the file.
 */
export async function readPlanBlob(
  cloneDir: string,
  commitSha: string,
  filePath: string,
  timeoutMs: number,
): Promise<PlanBlobRead> {
  try {
    return await readBlob(cloneDir, commitSha, filePath, timeoutMs);
  } catch (error) {
    if (error instanceof GitFailed) return { kind: 'unreadable', cause: 'git_failed' };
    throw error;
  }
}

async function readBlob(
  cloneDir: string,
  commitSha: string,
  filePath: string,
  timeoutMs: number,
): Promise<PlanBlobRead> {
  if (!SHA.test(commitSha) || !PLAN_FILE.test(filePath)) {
    return { kind: 'unreadable', cause: 'missing' };
  }
  const small = 64 * 1024;
  try {
    await gitIn(cloneDir, ['cat-file', '-e', `${commitSha}^{commit}`], timeoutMs, small);
  } catch (error) {
    // Only git's own "no such object" answer means the commit is not in the clone.
    if (error instanceof GitFailed && error.answered) {
      return { kind: 'unreadable', cause: 'commit_missing' };
    }
    throw error;
  }
  // `<mode> <type> <oid>\t<path>`, or nothing when the path is not in the tree.
  const entry = (
    await gitIn(cloneDir, ['ls-tree', '-z', commitSha, '--', filePath], timeoutMs, small)
  )
    .toString('utf8')
    .split('\0')[0];
  if (!entry) return { kind: 'unreadable', cause: 'missing' };
  const [meta, name] = entry.split('\t');
  const [mode, type, oid] = (meta ?? '').split(' ');
  if (name !== filePath || type !== 'blob' || !mode || !REGULAR_FILE_MODES.has(mode)) {
    return { kind: 'unreadable', cause: 'not_a_file' };
  }
  if (!oid || !OID.test(oid)) return { kind: 'unreadable', cause: 'not_a_file' };
  const size = Number(
    (await gitIn(cloneDir, ['cat-file', '-s', oid], timeoutMs, small)).toString(),
  );
  if (!Number.isSafeInteger(size) || size > PLAN_MAX_BYTES) {
    return { kind: 'unreadable', cause: 'too_large' };
  }
  const bytes = await gitIn(cloneDir, ['cat-file', 'blob', oid], timeoutMs, PLAN_MAX_BYTES + 1);
  if (bytes.length !== size) return { kind: 'unreadable', cause: 'not_a_file' };
  return { kind: 'ok', bytes };
}

/** The reader of one run's kept clone. */
export function planFileReader(cloneDir: string, timeoutMs: number): PlanFileReader {
  return (commitSha, filePath) => readPlanBlob(cloneDir, commitSha, filePath, timeoutMs);
}
