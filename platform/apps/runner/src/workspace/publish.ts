// The push of a run's checked changes (task C08 PR 1, D-08 C08 AC1, design/ADR-M38 §2.2,
// QUESTIONS #52, #155 A, #156; ADR-M29 §2.5: nothing the sandbox reports is used).
//
// After G5 passed a run and its block window closed, the worker issues a single-repository token
// with `contents: write` and hands it over wrapped; the runner then:
//  1. reads the run, its contract and its run events: the diff G5 checked (`diff_stored`) and the
//     SHA-256 of its sorted changed paths (`changes_checked`). A run already pushed is answered
//     `pushed` again (a repeated activity); a run refused before stays refused;
//  2. reads the stored diff back from the evidence store (the runner's identity may read
//     `evidence/diffs/*`, QUESTIONS #155) and checks its SHA-256: another file → `diff_mismatch`;
//  3. clones the repository without a working tree (`cloneForPush`); the token is only in git's
//     environment; reads the branch on the Git host (`remoteBranchHead`);
//  4. builds the commit in a private index only: `read-tree <base_sha>`, `apply --cached
//     --binary` of the diff, `write-tree`. No file of the change is written to disk, so links in
//     the change are never followed. The changed paths must hash to what G5 checked
//     (`diff_mismatch`); no change at all → `empty_diff`;
//  5. one commit on `base_sha`, author and committer `sdlc-agent
//     <agent-<agent_id>@agents.sdlc.invalid>` (QUESTIONS #80), message `sdlc: <INT-…> run <run_id>`,
//     both dates = the run's end: a repeated push makes the same commit, so it is idempotent;
//  6. the branch must be absent, at `base_sha` (the next run of the intent, QUESTIONS #134) or
//     already at the commit; anything else → `branch_moved` (someone else changed it). Push with an
//     explicit refspec, no force; read the branch again: it must show the commit;
//  7. records `branch_pushed` and sets `runs.head_sha` once (migration 0017), in one transaction;
//  8. (C11, ADR-M42 §2.4) revokes the push token, whatever the outcome (`token_revoked`). A
//     wrapping token that cannot be opened is recorded as `wrap_token_reused`.
//  9. (X13 PR 3a, ADR-M74 §2.5 step 4) when the run proposed memory (`memory_proposed`), pushes
//     the stored `memory_diff` the same way to the run's memory branch
//     `agent/INT-…-memory-<attempt>`: one commit on `base_sha`, the memory paths checked against
//     what the runner split out. Recorded as `memory_branch_pushed`, or `memory_publish_failed`
//     with a code: it never changes the outcome of the code push and never blocks a gate.
// Final refusals are recorded as `publish_refused` (a person decides, QUESTIONS #156); causes that
// may pass (the token, the Git host, the evidence store) as `publish_failed`. Codes only: never a
// path, git's text or the token.
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type {
  EvidenceStore,
  PublishRunInput,
  PublishRunResult,
  RedactedSecret,
  SecretUnwrapper,
} from '@sdlc/contracts';
import { parseTenantId, publishState, type PlatformDatabase, type TenantScope } from '@sdlc/core';
import { Redacted } from '@sdlc/secrets';

import { RunnerError } from '../errors.js';
import type { RunnerSettings } from '../settings.js';
import {
  isRefusedWrapToken,
  recordWrapTokenReused,
  revokeAfterUse,
  type GitTokenRevoker,
} from '../tokens.js';
import { cloneForPush, MEMORY_BRANCH, PushError, pushCommit, remoteBranchHead } from './git.js';
import { gitArgs, gitEnv } from './proposal.js';

export interface PublishDeps {
  readonly db: PlatformDatabase;
  readonly settings: Pick<RunnerSettings, 'git' | 'workDir' | 'workspaceMaxBytes'>;
  /** The diffs store (key prefix `diffs/`) with a credential that may read. */
  readonly diffEvidence?: Pick<EvidenceStore, 'get'>;
  readonly unwrapper: SecretUnwrapper;
  /** Revokes the push token right after the push (C11, ADR-M42 §2.4; ADR-M38 §2.3). */
  readonly tokenRevoker?: GitTokenRevoker;
}

/** Final causes: the runner never pushes this run (QUESTIONS #156). */
export type PublishRefusal =
  | 'not_succeeded'
  | 'contract_invalid'
  | 'changes_missing'
  | 'diff_mismatch'
  | 'empty_diff'
  | 'diff_not_applicable'
  | 'base_not_found'
  | 'branch_moved';

/** Causes that may pass on a new attempt. */
export type PublishFailure =
  | 'evidence_unavailable'
  | 'token_unavailable'
  | 'clone_failed'
  | 'remote_read_failed'
  | 'push_rejected'
  | 'record_failed'
  /** Anything else (local git, the file system, the database): see the runner's log. */
  | 'internal';

class Refused extends Error {
  constructor(readonly reason: PublishRefusal) {
    super(reason);
  }
}

class Failed extends Error {
  constructor(readonly reason: PublishFailure) {
    super(reason);
  }
}

const SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const BRANCH = /^agent\/(INT-[0-9]{4}-[0-9]{4,9})$/;
const REPO = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface Facts {
  readonly runId: string;
  readonly repo: string;
  readonly branch: string;
  readonly intentCode: string;
  readonly baseSha: string;
  readonly agentId: string;
  readonly finishedAt: Date;
  /** The run's attempt number: names its memory branch (X13 PR 3a). */
  readonly attempt: number;
  readonly diffSha256: string;
  readonly diffUri: string;
  readonly pathsSha256: string;
}

/** Pushes the run's checked changes (see the header). Never throws for a known cause. */
export async function publishRun(
  deps: PublishDeps,
  input: PublishRunInput,
): Promise<PublishRunResult> {
  const scope = deps.db.forTenant(parseTenantId(input.tenantId));
  const state = await publishState(scope, input.runId);
  if (state.pushed) return { outcome: 'pushed' };
  if (state.refused) return { outcome: 'refused', reason: state.refused };
  try {
    const facts = await readFacts(scope, input.runId);
    if (!deps.diffEvidence) throw new Failed('evidence_unavailable');
    const token = await unwrapToken(deps.unwrapper, input.wrappedPushToken, () =>
      // Opened by someone else, or expired before this attempt (C11, ADR-M42 §2.5).
      recordWrapTokenReused(scope, input.runId, 'push'),
    );
    const dir = fs.mkdtempSync(path.join(deps.settings.workDir, 'publish-'));
    try {
      const patch = await readPatch(deps.diffEvidence, facts);
      const repoDir = await cloneForPush(deps.settings.git, { repo: facts.repo, token, dir });
      const head = await pushChanges(deps, facts, patch, token, dir, repoDir);
      await record(scope, input.runId, facts, head);
      // X13 PR 3a: the memory part goes to its own branch; never changes the outcome above.
      await publishMemory(deps, scope, facts, token, dir, repoDir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      // The push token ends with the push, whatever the outcome (C11).
      await revokeAfterUse(deps.tokenRevoker, scope, input.runId, token, 'push');
    }
    return { outcome: 'pushed' };
  } catch (error) {
    if (error instanceof Refused) {
      await scope.runEvents.append(input.runId, 'publish_refused', { reason: error.reason });
      return { outcome: 'refused', reason: error.reason };
    }
    const reason: PublishFailure =
      error instanceof Failed
        ? error.reason
        : error instanceof PushError
          ? error.reason
          : 'internal';
    await scope.runEvents.append(input.runId, 'publish_failed', { reason });
    return { outcome: 'failed', reason };
  }
}

async function readFacts(scope: TenantScope, runId: string): Promise<Facts> {
  const run = await scope.runs.getById(runId);
  if (!run || run.status !== 'succeeded' || run.finished_at === null) {
    throw new Refused('not_succeeded');
  }
  const contract = (await scope.runContracts.getByRunId(runId))?.contract_json;
  const repo = contract?.repo;
  const branch = contract?.branch;
  const baseSha = contract?.base_sha;
  const agentId = contract?.agent_id;
  const match = typeof branch === 'string' ? BRANCH.exec(branch) : null;
  // The stored contract was verified when the run started; check it again against the platform's
  // own records: the project's repository and the intent's own branch (security review).
  const project = await scope.projects.getById(String(contract?.project_id));
  const intent = await scope.intents.getById(run.intent_id);
  if (
    typeof repo !== 'string' ||
    !REPO.test(repo) ||
    repo !== project?.repo_full_name ||
    !match ||
    branch !== run.branch ||
    branch !== `agent/${intent?.code ?? ''}` ||
    typeof baseSha !== 'string' ||
    !SHA.test(baseSha) ||
    baseSha !== run.base_sha ||
    typeof agentId !== 'string' ||
    !UUID.test(agentId)
  ) {
    throw new Refused('contract_invalid');
  }
  let diffSha256: string | null = null;
  let pathsSha256: string | null = null;
  for (const event of await scope.runEvents.list(runId)) {
    const p = event.payload;
    if (event.event_type === 'diff_stored') diffSha256 = String(p.sha256);
    if (event.event_type === 'changes_checked') pathsSha256 = String(p.paths_sha256);
  }
  const item = (await scope.evidenceItems.listForIntent(run.intent_id)).find(
    (e) => e.run_id === runId && e.kind === 'diff',
  );
  if (
    diffSha256 === null ||
    pathsSha256 === null ||
    !SHA256.test(diffSha256) ||
    !SHA256.test(pathsSha256) ||
    !item ||
    item.sha256 !== diffSha256 ||
    // Only the run's own diff, at the path the runner wrote it (ADR-M34 §2.2).
    !item.storage_uri.endsWith(`/diffs/${scope.tenantId}/${run.intent_id}/${runId}.patch`)
  ) {
    throw new Refused('changes_missing');
  }
  return {
    runId,
    repo,
    branch,
    intentCode: match[1]!,
    baseSha,
    agentId,
    finishedAt: new Date(run.finished_at),
    attempt: run.attempt,
    diffSha256,
    diffUri: item.storage_uri,
    pathsSha256,
  };
}

async function unwrapToken(
  unwrapper: SecretUnwrapper,
  wrapped: string,
  onRefused: () => Promise<void>,
): Promise<RedactedSecret> {
  try {
    const token = (await unwrapper.unwrap(new Redacted(wrapped))).token;
    if (!token) throw new Error('no token field');
    return token;
  } catch (error) {
    if (isRefusedWrapToken(error)) await onRefused();
    throw new Failed('token_unavailable');
  }
}

async function readPatch(store: Pick<EvidenceStore, 'get'>, facts: Facts): Promise<Buffer> {
  return readStored(store, facts.diffUri, facts.diffSha256);
}

/** Reads a stored diff back and checks its SHA-256 against what the runner recorded. */
async function readStored(
  store: Pick<EvidenceStore, 'get'>,
  uri: string,
  expectedSha256: string,
): Promise<Buffer> {
  let patch: Buffer;
  try {
    patch = await store.get(uri);
  } catch {
    throw new Failed('evidence_unavailable');
  }
  const sha256 = crypto.createHash('sha256').update(patch).digest('hex');
  if (sha256 !== expectedSha256) throw new Refused('diff_mismatch');
  if (patch.length === 0) throw new Refused('empty_diff');
  return patch;
}

/** Builds the commit and pushes it; returns the pushed commit. */
async function pushChanges(
  deps: PublishDeps,
  facts: Facts,
  patch: Buffer,
  token: RedactedSecret,
  dir: string,
  repoDir: string,
): Promise<string> {
  const home = path.join(dir, 'home');
  const commit = await buildCommit(
    deps,
    {
      ...facts,
      patch,
      pathsSha256: facts.pathsSha256,
      message: `sdlc: ${facts.intentCode} run ${facts.runId}`,
    },
    repoDir,
    home,
    dir,
  );
  const target = { repo: facts.repo, branch: facts.branch, baseSha: facts.baseSha };
  return pushTo(deps, target, { repoDir, home, token, commit });
}

/**
 * Pushes `commit` to `target.branch` with an explicit refspec, no force. The branch must be
 * absent, at `baseSha` or already at the commit; anything else → `branch_moved`.
 */
async function pushTo(
  deps: PublishDeps,
  target: { readonly repo: string; readonly branch: string; readonly baseSha: string },
  local: {
    readonly repoDir: string;
    readonly home: string;
    readonly token: RedactedSecret;
    readonly commit: string;
  },
): Promise<string> {
  const git = deps.settings.git;
  const { commit } = local;
  const remote = { repo: target.repo, branch: target.branch, token: local.token, home: local.home };
  const before = await remoteBranchHead(git, remote);
  if (before === commit) return commit;
  if (before !== null && before !== target.baseSha) throw new Refused('branch_moved');
  try {
    await pushCommit(git, { ...remote, repoDir: local.repoDir, commit });
  } catch (error) {
    // Someone else may have changed the branch between the read and the push.
    const now = await remoteBranchHead(git, remote).catch(() => undefined);
    if (now === commit) return commit;
    if (now !== undefined && now !== null && now !== target.baseSha) {
      throw new Refused('branch_moved');
    }
    throw error;
  }
  const after = await remoteBranchHead(git, remote);
  if (after !== commit) throw new Refused('branch_moved');
  return commit;
}

interface MemoryFacts {
  readonly branch: string;
  readonly uri: string;
  readonly memorySha256: string;
  readonly pathsSha256: string;
}

/** The run's memory proposal to push, or null (none, or already pushed). */
async function readMemoryFacts(scope: TenantScope, facts: Facts): Promise<MemoryFacts | null> {
  let memorySha256: string | null = null;
  let pathsSha256: string | null = null;
  for (const event of await scope.runEvents.list(facts.runId)) {
    if (event.event_type === 'memory_branch_pushed') return null;
    if (event.event_type === 'memory_proposed') {
      memorySha256 = String(event.payload.memory_sha256);
      pathsSha256 = String(event.payload.paths_sha256);
    }
  }
  if (memorySha256 === null || pathsSha256 === null) return null;
  const run = await scope.runs.getById(facts.runId);
  const item = run
    ? (await scope.evidenceItems.listForIntent(run.intent_id)).find(
        (e) => e.run_id === facts.runId && e.kind === 'memory_diff',
      )
    : undefined;
  const suffix = `/diffs/${scope.tenantId}/${run?.intent_id ?? ''}/${facts.runId}.memory.patch`;
  const branch = `${facts.branch}-memory-${String(facts.attempt)}`;
  if (
    !SHA256.test(memorySha256) ||
    !SHA256.test(pathsSha256) ||
    !item ||
    item.sha256 !== memorySha256 ||
    !item.storage_uri.endsWith(suffix) ||
    !MEMORY_BRANCH.test(branch)
  ) {
    throw new Refused('changes_missing');
  }
  return { branch, uri: item.storage_uri, memorySha256, pathsSha256 };
}

/**
 * Pushes the run's memory part to its memory branch (step 9 of the header). Never throws: a
 * failure is the run event `memory_publish_failed`; the code push stays as it is.
 */
async function publishMemory(
  deps: PublishDeps,
  scope: TenantScope,
  facts: Facts,
  token: RedactedSecret,
  dir: string,
  repoDir: string,
): Promise<void> {
  try {
    const memory = await readMemoryFacts(scope, facts);
    if (!memory) return;
    if (!deps.diffEvidence) throw new Failed('evidence_unavailable');
    const patch = await readStored(deps.diffEvidence, memory.uri, memory.memorySha256);
    const work = path.join(dir, 'memory');
    fs.mkdirSync(work, { mode: 0o700 });
    const home = path.join(dir, 'home');
    const commit = await buildCommit(
      deps,
      {
        ...facts,
        patch,
        pathsSha256: memory.pathsSha256,
        message: `sdlc: ${facts.intentCode} run ${facts.runId} memory`,
      },
      repoDir,
      home,
      work,
    );
    const target = { repo: facts.repo, branch: memory.branch, baseSha: facts.baseSha };
    const head = await pushTo(deps, target, { repoDir, home, token, commit });
    await scope.runEvents.append(facts.runId, 'memory_branch_pushed', {
      head_sha: head,
      parent_sha: facts.baseSha,
      memory_sha256: memory.memorySha256,
    });
  } catch (error) {
    const reason =
      error instanceof Refused || error instanceof Failed || error instanceof PushError
        ? error.reason
        : 'internal';
    // Recording the failure may fail too (the database): the code push is recorded already, and
    // a run without `memory_branch_pushed` gets no memory pull request. Never thrown.
    await scope.runEvents
      .append(facts.runId, 'memory_publish_failed', { reason })
      .catch(() => undefined);
  }
}

/** Local git in the push clone: hardened (`gitArgs`), with a private index and fixed identity. */
function localGit(
  repoDir: string,
  home: string,
  env: Readonly<Record<string, string>>,
  args: string[],
  options: { readonly timeoutMs: number; readonly maxBytes: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      gitArgs(repoDir, ['-c', 'commit.gpgSign=false', '-c', 'apply.whitespace=nowarn', ...args]),
      {
        env: { ...gitEnv(home), ...env },
        timeout: options.timeoutMs,
        maxBuffer: options.maxBytes,
        encoding: 'buffer',
      },
      (error, stdout) => {
        // Git's own text is never passed on.
        if (error) reject(new RunnerError('runner.workspace.proposal_failed'));
        else resolve(stdout);
      },
    );
  });
}

/** What one commit is made of: the stored diff on the run's base, and its checked paths. */
interface CommitInput {
  readonly baseSha: string;
  readonly agentId: string;
  readonly finishedAt: Date;
  readonly patch: Buffer;
  readonly pathsSha256: string;
  readonly message: string;
}

async function buildCommit(
  deps: PublishDeps,
  facts: CommitInput,
  repoDir: string,
  home: string,
  dir: string,
): Promise<string> {
  const options = {
    timeoutMs: deps.settings.git.timeoutMs,
    maxBytes: Math.max(deps.settings.workspaceMaxBytes, 1024 * 1024),
  };
  const date = `@${String(Math.floor(facts.finishedAt.getTime() / 1000))} +0000`;
  const email = `agent-${facts.agentId}@agents.sdlc.invalid`;
  const env = {
    GIT_INDEX_FILE: path.join(dir, 'index'),
    GIT_AUTHOR_NAME: 'sdlc-agent',
    GIT_AUTHOR_EMAIL: email,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: 'sdlc-agent',
    GIT_COMMITTER_EMAIL: email,
    GIT_COMMITTER_DATE: date,
  };
  const run = (args: string[]) => localGit(repoDir, home, env, args, options);
  try {
    await run(['rev-parse', '--verify', '--quiet', `${facts.baseSha}^{commit}`]);
    await run(['read-tree', facts.baseSha]);
  } catch {
    throw new Refused('base_not_found');
  }
  const patchFile = path.join(dir, 'change.patch');
  fs.writeFileSync(patchFile, facts.patch, { mode: 0o600 });
  try {
    await run(['apply', '--cached', '--binary', '--', patchFile]);
  } catch {
    throw new Refused('diff_not_applicable');
  }
  const names = await run(['diff', '--cached', '--no-renames', '--name-only', '-z', facts.baseSha]);
  const sorted = names
    .toString('utf8')
    .split('\0')
    .filter((name) => name.length > 0)
    .sort();
  if (sorted.length === 0) throw new Refused('empty_diff');
  // Same hash as the runner's check at the end of the run (`checkChangedPaths`).
  const pathsSha256 = crypto
    .createHash('sha256')
    .update(JSON.stringify(sorted), 'utf8')
    .digest('hex');
  if (pathsSha256 !== facts.pathsSha256) throw new Refused('diff_mismatch');
  const tree = (await run(['write-tree'])).toString('utf8').trim();
  const commit = (await run(['commit-tree', tree, '-p', facts.baseSha, '-m', facts.message]))
    .toString('utf8')
    .trim();
  if (!SHA.test(commit)) throw new RunnerError('runner.workspace.proposal_failed');
  return commit;
}

async function record(
  scope: TenantScope,
  runId: string,
  facts: Facts,
  head: string,
): Promise<void> {
  await scope.transaction(async (tx) => {
    // A concurrent attempt pushed the same commit and recorded it first: nothing to add.
    if ((await tx.runs.getById(runId))?.head_sha === head) return;
    await tx.runEvents.append(runId, 'branch_pushed', {
      head_sha: head,
      parent_sha: facts.baseSha,
      diff_sha256: facts.diffSha256,
      paths_sha256: facts.pathsSha256,
    });
    if (!(await tx.runs.recordPushedHead(runId, head, new Date()))) {
      throw new Failed('record_failed');
    }
  });
}
