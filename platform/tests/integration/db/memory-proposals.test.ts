// X13 PR 3b on a live PostgreSQL (design/ADR-M74 §2.3–§2.5, 0.5; QUESTIONS #716; §5 "Approval by
// a non-producer" and "Separate pull request"): the worker's memory loop takes a run's pushed
// memory branch to its own pull request after the code merge at G7, records a version only when a
// person who may approve (Person A or Person B, not a producer, not a bot) merged it, and deletes
// the memory branch of an intent that closed without a merge. The memory pull request never
// blocks a gate. Only codes, IDs and hashes reach the database. The Git host is an in-memory fake;
// the GitHub adapter's `deleteBranch` is covered in `platform/tests/git-github/delete-branch.test.ts`.
import {
  GitHostError,
  MEMORY_DIR,
  memorySetOf,
  type BranchDeletion,
  type FolderEntry,
  type GitActor,
  type NewPullRequest,
  type PullRequestInfo,
  type RepoRef,
} from '@sdlc/contracts';
import { t as message } from '@sdlc/messages';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

import { DbError } from '../../../packages/core/src/db/errors.js';
import type { Intent } from '../../../packages/core/src/db/schema.js';
import {
  stepMemoryWork,
  type MemoryProposalDeps,
} from '../../../packages/core/src/memory/proposals.js';
import { memorySetSha256 } from '../../../packages/core/src/memory/set.js';
import { startRun } from '../../../packages/core/src/workflow/run-lifecycle.js';
import { atG4, harness, T0, type Harness } from '../g4-harness.js';
import { PEOPLE } from '../workflow/fixture.js';
import { createTestDatabase, describeDb, tamper, type TestDatabase } from './helpers.js';

const HEAD = 'a'.repeat(40);
const MERGE = 'b'.repeat(40);
const person = (gh: number): GitActor => ({ id: String(gh), login: `u${gh}`, type: 'user' });
const bot: GitActor = { id: '9999', login: 'merge-bot[bot]', type: 'bot' };

/** Pull request numbers, unique across the tests (proposals of earlier tests stay open). */
let nextPr = 100;

/** An in-memory Git host: pull requests by number, branches, the memory folder per commit. */
class FakeGitHost {
  readonly prs = new Map<number, PullRequestInfo>();
  readonly opened: NewPullRequest[] = [];
  readonly deleted: string[] = [];
  readonly branches = new Map<string, string>();
  readonly folders = new Map<string, FolderEntry[]>();
  commitAuthors: GitActor[] = [];
  down = false;

  readonly gitHost: MemoryProposalDeps['gitHost'] = {
    findOpenPullRequest: (_ref: RepoRef, head: string) =>
      Promise.resolve(
        [...this.prs.values()].find((p) => p.headRef === head && p.state === 'open') ?? null,
      ),
    openPullRequest: (_ref: RepoRef, input: NewPullRequest) => {
      if (this.down) return Promise.reject(new GitHostError('network_error'));
      this.opened.push(input);
      const pr = this.pr(nextPr++, input.head, this.branches.get(input.head) ?? HEAD);
      return Promise.resolve(pr);
    },
    getPullRequest: (_ref: RepoRef, number: number) => {
      const pr = this.prs.get(number);
      return pr ? Promise.resolve(pr) : Promise.reject(new GitHostError('not_found'));
    },
    getCommitAuthors: () => Promise.resolve({ accounts: this.commitAuthors, withoutAccount: 0 }),
    listFolder: (_ref: RepoRef, commit: string, folder: string) => {
      expect(folder).toBe(MEMORY_DIR);
      return Promise.resolve(this.folders.get(commit) ?? []);
    },
    deleteBranch: (_ref: RepoRef, branch: string, expected: string): Promise<BranchDeletion> => {
      const head = this.branches.get(branch);
      if (head === undefined) return Promise.resolve('absent');
      if (head !== expected) return Promise.resolve('moved');
      this.branches.delete(branch);
      this.deleted.push(branch);
      return Promise.resolve('deleted');
    },
  };

  pr(number: number, headRef: string, headSha: string): PullRequestInfo {
    const pr: PullRequestInfo = {
      number,
      state: 'open',
      draft: false,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headSha,
      headRef,
      baseRef: 'main',
      author: person(1),
      mergedBy: null,
      changedFiles: 1,
      url: `https://github.com/acme/shop/pull/${String(number)}`,
    };
    this.prs.set(number, pr);
    return pr;
  }

  merge(number: number, by: GitActor | null): void {
    const pr = this.prs.get(number)!;
    this.prs.set(number, {
      ...pr,
      state: 'closed',
      merged: true,
      mergedAt: T0.toISOString(),
      mergeCommitSha: MERGE,
      mergedBy: by,
    });
  }

  close(number: number): void {
    this.prs.set(number, { ...this.prs.get(number)!, state: 'closed' });
  }
}

const NOTES: FolderEntry[] = [{ name: 'build.md', kind: 'file', sha: 'c'.repeat(40) }];

describeDb('X13 PR 3b: memory pull requests on PostgreSQL', () => {
  let db: TestDatabase;
  let t: Harness;
  let git: FakeGitHost;

  beforeAll(async () => {
    db = await createTestDatabase();
    t = await harness(db);
  }, 60_000);

  afterAll(async () => {
    await t?.f.close();
    await db?.drop();
  });

  beforeEach(async () => {
    t.setClock(T0);
    await t.setConfig(`run:\n  agent_key: ${t.agent.key}\n`);
    git = new FakeGitHost();
    git.folders.set(MERGE, NOTES);
  });

  const deps = (): MemoryProposalDeps => ({ gitHost: git.gitHost, now: () => new Date() });
  const scope = () => t.f.scope;
  const tenantId = () => t.f.target.tenantId;

  /** A succeeded run that pushed its memory branch (as PR 3a leaves it). */
  async function pushedRun(): Promise<{ intent: Intent; runId: string; branch: string }> {
    const intent = await atG4(t, 'medium');
    for (let i = 0; i < 12; i += 1) {
      if ((await t.settleRuns(intent)).outcome === 'run_prepare') break;
    }
    const started = await startRun(scope(), t.runDeps, intent.id);
    if (!started.ok) throw new Error(`not started: ${started.reason}`);
    const runId = started.run.runId;
    const now = new Date('2026-09-28T02:00:00.000Z');
    await scope().runs.claimForProvisioning(runId, now);
    await scope().runs.transition(runId, { from: ['provisioning'], to: 'running', now });
    await scope().runs.transition(runId, {
      from: ['running'],
      to: 'succeeded',
      now,
      finishedAt: now,
    });
    await scope().runEvents.append(runId, 'memory_branch_pushed', {
      head_sha: HEAD,
      parent_sha: '1'.repeat(40),
      memory_sha256: 'd'.repeat(64),
    });
    const branch = `agent/${intent.code}-memory-1`;
    git.branches.set(branch, HEAD);
    return { intent, runId, branch };
  }

  const codeMerged = (runId: string) =>
    scope().runEvents.append(runId, 'pr_merged', { pr_number: 7, head_sha: '2'.repeat(40) });

  /** One pass of the loop over the work of this tenant. */
  async function pass(): Promise<string[]> {
    const outcomes: string[] = [];
    for (const work of await db.app.system.listMemoryWork(100)) {
      if (work.tenantId !== tenantId()) continue;
      // Like the loop: an error skips only that item (proposals of earlier tests are on another
      // fake Git host).
      outcomes.push(
        await stepMemoryWork(scope(), deps(), work).catch((error: unknown) => {
          if (error instanceof GitHostError) return `error:${error.code}`;
          throw error;
        }),
      );
    }
    return outcomes;
  }

  const proposalOf = async (intent: Intent) =>
    (await scope().memoryProposals.listForIntent(intent.id))[0];
  const intentAudit = async (intent: Intent) =>
    (
      await scope().audit.listForEntity(intent.id, [
        'memory.pr_opened',
        'memory.pr_closed',
        'memory.branch_deleted',
      ])
    ).map((e) => [e.action, e.payload]);
  const projectAudit = async () =>
    (
      await scope().audit.listForEntity(t.f.target.projectId, [
        'memory.approved',
        'memory.approval_refused',
      ])
    ).map((e) => [e.action, e.payload]);

  /** A memory pull request opened for a merged run. */
  async function opened() {
    const run = await pushedRun();
    await pass();
    await codeMerged(run.runId);
    await pass();
    const proposal = await proposalOf(run.intent);
    return { ...run, proposal: proposal!, pr: proposal!.pr_number! };
  }

  it('waits while the intent is open; after the code merge opens the memory pull request', async () => {
    const { intent, runId, branch } = await pushedRun();
    expect(await pass()).toContain('recorded_pushed');
    expect(await proposalOf(intent)).toMatchObject({
      state: 'pushed',
      head_sha: HEAD,
      run_id: runId,
    });
    // The intent is still open: nothing on the Git host, and no gate waits for it.
    await pass();
    expect(git.opened).toEqual([]);

    await codeMerged(runId);
    await pass();
    expect(git.opened).toEqual([
      {
        head: branch,
        base: 'main',
        title: message('memory.pr.title', { code: intent.code, attempt: 1 }),
        body: message('memory.pr.body', { code: intent.code, run_id: runId, attempt: 1 }),
      },
    ]);
    expect(git.opened[0]!.title).toBe(`MEMORY ${intent.code} run 1`);
    const proposal = await proposalOf(intent);
    expect(proposal).toMatchObject({ state: 'opened', pr_number: proposal!.pr_number });
    expect(proposal!.pr_number).toBeGreaterThanOrEqual(100);
    expect(await intentAudit(intent)).toEqual([
      ['memory.pr_opened', { run_id: runId, pr_number: proposal!.pr_number }],
    ]);
    // The next passes only look at it: one pull request, never a second.
    await pass();
    expect(git.opened).toHaveLength(1);
  });

  it('a person who may approve and produced nothing merges it: the next version', async () => {
    const { intent, runId, pr } = await opened();
    git.merge(pr, person(PEOPLE.b.gh));
    await pass();
    const before = await scope().memoryVersions.latest(t.f.target.projectId);
    expect(before).toMatchObject({
      source: 'memory_pr',
      set_sha256: memorySetSha256(memorySetOf(NOTES)),
      commit_sha: MERGE,
      approved_by: t.f.users.b,
      pr_number: pr,
      intent_id: intent.id,
      run_id: runId,
    });
    expect(await proposalOf(intent)).toMatchObject({ state: 'recorded', version: before!.version });
    expect((await projectAudit()).at(-1)).toEqual([
      'memory.approved',
      { version: before!.version, set_sha256: before!.set_sha256, source: 'memory_pr' },
    ]);
    // The same set merged again later: recorded, nothing new.
    const again = await opened();
    git.merge(again.pr, person(PEOPLE.b.gh));
    await pass();
    expect(await proposalOf(again.intent)).toMatchObject({ state: 'recorded', cause: 'unchanged' });
    expect((await scope().memoryVersions.latest(t.f.target.projectId))?.version).toBe(
      before!.version,
    );
  });

  it('merged by a producer, a bot, governance or an unknown account: no version, audited', async () => {
    const cases: [GitActor, string][] = [
      [person(PEOPLE.a.gh), 'producer'], // the intent's creator
      [bot, 'bot'],
      [person(PEOPLE.gov.gh), 'not_allowed'],
      [person(424242), 'not_linked'],
    ];
    for (const [by, cause] of cases) {
      const { intent, pr } = await opened();
      const before = (await scope().memoryVersions.latest(t.f.target.projectId))?.version;
      git.merge(pr, by);
      await pass();
      expect(await proposalOf(intent)).toMatchObject({ state: 'refused', cause, version: null });
      expect((await scope().memoryVersions.latest(t.f.target.projectId))?.version).toBe(before);
      expect((await projectAudit()).at(-1)).toEqual([
        'memory.approval_refused',
        { cause, source: 'memory_pr' },
      ]);
    }
    // A commit author of the memory pull request is a producer too (FR-11).
    const { intent, pr } = await opened();
    git.commitAuthors = [person(PEOPLE.b.gh)];
    git.merge(pr, person(PEOPLE.b.gh));
    await pass();
    expect(await proposalOf(intent)).toMatchObject({ state: 'refused', cause: 'producer' });
    git.commitAuthors = [];
  });

  it('closed without a merge: closed, no version', async () => {
    const { intent, runId, pr } = await opened();
    git.close(pr);
    await pass();
    expect(await proposalOf(intent)).toMatchObject({ state: 'closed', cause: 'not_merged' });
    expect((await intentAudit(intent)).at(-1)).toEqual([
      'memory.pr_closed',
      { run_id: runId, pr_number: pr },
    ]);
  });

  it('the intent closed without a merge: the memory branch is deleted, never offered', async () => {
    const { intent, runId, branch } = await pushedRun();
    await pass();
    await tamper(db.name, `UPDATE intents SET status = 'cancelled' WHERE id = $1`, [intent.id]);
    await pass();
    expect(git.deleted).toEqual([branch]);
    expect(git.opened).toEqual([]);
    expect(await proposalOf(intent)).toMatchObject({ state: 'deleted', cause: 'intent_closed' });
    expect(await intentAudit(intent)).toEqual([
      ['memory.branch_deleted', { run_id: runId, result: 'deleted' }],
    ]);

    // Someone else moved a memory branch: left as it is.
    const other = await pushedRun();
    await pass();
    git.branches.set(other.branch, 'e'.repeat(40));
    await tamper(db.name, `UPDATE intents SET status = 'cancelled' WHERE id = $1`, [
      other.intent.id,
    ]);
    await pass();
    expect(git.branches.get(other.branch)).toBe('e'.repeat(40));
    expect(await proposalOf(other.intent)).toMatchObject({ state: 'deleted', cause: 'moved' });
  });

  it('a memory branch someone else changed is never offered for approval (failed)', async () => {
    const { intent, runId, branch } = await pushedRun();
    await pass();
    git.branches.set(branch, 'f'.repeat(40));
    await codeMerged(runId);
    await pass();
    expect(await proposalOf(intent)).toMatchObject({ state: 'failed', cause: 'branch_moved' });
  });

  it('a Git host error leaves the proposal for the next pass; a final state never changes', async () => {
    const { intent, runId } = await pushedRun();
    await pass();
    await codeMerged(runId);
    git.down = true;
    expect(await pass()).toContain('error:network_error');
    expect(await proposalOf(intent)).toMatchObject({ state: 'pushed' });
    git.down = false;
    await pass();
    const proposal = (await proposalOf(intent))!;
    git.merge(proposal.pr_number!, bot);
    await pass();
    await expect(
      scope().memoryProposals.move(proposal.id, 'refused', 'opened', new Date()),
    ).rejects.toBeInstanceOf(DbError);
    // Never stored: a branch name, a path or a title.
    const rows = JSON.stringify(await scope().memoryProposals.listForIntent(intent.id));
    expect(rows).not.toMatch(/agent\/|memory\/|MEMORY|build\.md/);
  });
});
