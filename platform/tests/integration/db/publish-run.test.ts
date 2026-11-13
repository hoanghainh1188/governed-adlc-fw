// D-08 C08 AC1 and AC3 (N6, at unit level), design/ADR-M38 §2.2, QUESTIONS #52, #155, #156: the
// runner pushes the run's checked changes. A live PostgreSQL, a local Git host (git's own
// smart-HTTP server, `stub-git.ts`) that protects `main` like branch protection, and a fake
// evidence store that holds the stored diff.
// - the commit is made from the stored diff (never what the sandbox reported): same tree as the
//   change, parent `base_sha`, author `sdlc-agent <agent-<id>@agents.sdlc.invalid>`, fixed dates;
// - pushed with an explicit refspec, no force; the run event `branch_pushed` and `runs.head_sha`;
// - idempotent: a repeated activity answers `pushed` without a new commit;
// - refusals (final): a diff that is not the one G5 checked, the paths G5 checked differ, an
//   empty change, a branch someone else moved; failures (may pass): an unusable token;
// - the token travels only as a header, never in a URL, and is never stored;
// - the Git host refuses a push to `main` (N6) even with a `contents: write` token;
// - X13 PR 3a (ADR-M74 §2.5 step 4): a run that proposed memory gets its memory part pushed after
//   the code, as one commit on `base_sha` to `agent/INT-…-memory-<attempt>`; a memory failure is
//   `memory_publish_failed` and never changes the outcome of the code push.
import { execFile, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

import { pushCommit, runnerSettingsFromEnv } from '../../../apps/runner/src/index.js';
import { publishRun, type PublishDeps } from '../../../apps/runner/src/workspace/publish.js';
import { EvidenceError, type SecretUnwrapper } from '../../../packages/contracts/src/index.js';
import type { Intent } from '../../../packages/core/src/db/schema.js';
import { startRun } from '../../../packages/core/src/workflow/run-lifecycle.js';
import { Redacted } from '../../../packages/secrets/src/index.js';
import { StubGitHost } from '../../runner/stub-git.js';
import { atG4, harness, T0, type Harness } from '../g4-harness.js';
import { createTestDatabase, describeDb, tamper, type TestDatabase } from './helpers.js';

const execFileAsync = promisify(execFile);
const TOKEN = 'ghs_c08PushTokenCanary00000000000000000';
const REPO = 'acme/shop';
const GIT_ENV = {
  PATH: process.env.PATH,
  GIT_TERMINAL_PROMPT: '0',
  HOME: os.tmpdir(),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};

/** The stub host's token as an extra header (fixture clones and the N6 probe). */
function authEnv(origin: string): Record<string, string> {
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `http.${origin}/.extraheader`,
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${TOKEN}`).toString('base64')}`,
  };
}

let origin = '';

function git(cwd: string, ...args: string[]): Buffer {
  return execFileSync('git', args, { cwd, env: { ...GIT_ENV, ...authEnv(origin) }, stdio: 'pipe' });
}

/** A diff as the runner computes it at the end of a run (`computeProposal`), and its paths. */
function makeDiff(bare: string, base: string, change: (dir: string) => void) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-c08-diff-'));
  try {
    // From disk: a synchronous git call must never talk to the stub server of this process.
    git(work, 'clone', '--quiet', bare, '.');
    git(work, 'checkout', '--quiet', base);
    change(work);
    git(work, 'add', '-A', '-f', '--', '.');
    const args = ['diff', '--cached', '--no-renames', '--no-ext-diff', '--no-textconv'];
    const patch = git(work, ...args, '--binary', '--full-index', base);
    const paths = git(work, ...args, '--name-only', '-z', base)
      .toString('utf8')
      .split('\0')
      .filter((p) => p.length > 0)
      .sort();
    return {
      patch,
      sha256: crypto.createHash('sha256').update(patch).digest('hex'),
      pathsSha256: crypto.createHash('sha256').update(JSON.stringify(paths), 'utf8').digest('hex'),
      tree: git(work, 'write-tree').toString().trim(),
    };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

class FakeEvidence {
  readonly files = new Map<string, Buffer>();
  get(uri: string): Promise<Buffer> {
    const file = this.files.get(uri);
    return file ? Promise.resolve(file) : Promise.reject(new EvidenceError('not_found'));
  }
}

/** Single use, like an OpenBao wrapping token. */
class FakeUnwrapper implements SecretUnwrapper {
  readonly used = new Set<string>();
  unwrap(wrapped: { reveal(): string }) {
    const key = wrapped.reveal();
    if (this.used.has(key)) return Promise.reject(new Error('already used'));
    this.used.add(key);
    return Promise.resolve({ token: new Redacted(TOKEN) });
  }
}

describeDb('C08: the runner pushes the checked changes (stub Git host, PostgreSQL)', () => {
  let db: TestDatabase;
  let t: Harness;
  let host: StubGitHost;
  let base: string;
  let workDir: string;
  let evidence: FakeEvidence;
  let unwrapper: FakeUnwrapper;
  let wraps = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    t = await harness(db);
    host = await StubGitHost.start(TOKEN);
    origin = host.origin;
    ({ first: base } = host.createRepo(REPO, {
      'README.md': 'pilot\n',
      'src/main.ts': 'export const a = 1;\n',
      'src/old.ts': 'old\n',
    }));
    host.allowPush(REPO, { protect: ['main'] });
  }, 60_000);

  afterAll(async () => {
    await host?.stop();
    await t?.f.close();
    await db?.drop();
  });

  beforeEach(async () => {
    t.setClock(T0);
    t.world.base = base;
    await t.setConfig(`run:\n  agent_key: ${t.agent.key}\n`);
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-c08-work-'));
    evidence = new FakeEvidence();
    unwrapper = new FakeUnwrapper();
    host.requests.length = 0;
  });

  const settings = () =>
    runnerSettingsFromEnv({
      SDLC_RUNNER_GIT_BASE_URL: host.origin,
      SDLC_RUNNER_GIT_ALLOW_PLAINTEXT: '1',
      SDLC_RUNNER_WORK_DIR: workDir,
    });
  const deps = (): PublishDeps => ({
    db: db.app as unknown as PublishDeps['db'],
    settings: settings(),
    diffEvidence: evidence,
    unwrapper,
  });
  const input = (runId: string) => {
    wraps += 1;
    return { tenantId: t.f.target.tenantId, runId, wrappedPushToken: `wrap-${String(wraps)}` };
  };

  /** A succeeded run of a new intent, with its stored and checked diff (as the runner leaves it). */
  async function succeededRun(
    diff: ReturnType<typeof makeDiff>,
    options: {
      pathsSha256?: string;
      memory?: ReturnType<typeof makeDiff> & { readonly storedSha256?: string };
    } = {},
  ): Promise<{ intent: Intent; runId: string; branch: string }> {
    const intent = await atG4(t, 'medium');
    for (let i = 0; i < 12; i += 1) {
      const step = await t.settleRuns(intent);
      if (step.outcome === 'run_prepare') break;
    }
    const started = await startRun(t.f.scope, t.runDeps, intent.id);
    if (!started.ok) throw new Error(`not started: ${started.reason}`);
    const runId = started.run.runId;
    const now = new Date('2026-09-28T02:00:00.000Z');
    await t.f.scope.runs.claimForProvisioning(runId, now);
    await t.f.scope.runs.transition(runId, { from: ['provisioning'], to: 'running', now });
    const uri = `s3://evidence/diffs/${t.f.target.tenantId}/${intent.id}/${runId}.patch`;
    evidence.files.set(uri, diff.patch);
    await t.f.scope.transaction(async (tx) => {
      await tx.evidenceItems.record({
        intentId: intent.id,
        runId,
        kind: 'diff',
        storageUri: uri,
        sha256: diff.sha256,
        sizeBytes: diff.patch.length,
      });
      await tx.runEvents.append(runId, 'diff_stored', {
        sha256: diff.sha256,
        size_bytes: diff.patch.length,
        changed_files: 1,
      });
      await tx.runEvents.append(runId, 'changes_checked', {
        changed_files: 1,
        out_of_scope: 0,
        instruction_files: 0,
        paths_sha256: options.pathsSha256 ?? diff.pathsSha256,
      });
      await tx.runEvents.append(runId, 'secrets_scanned', {
        result: 'clean',
        findings: 0,
        rules: 'built_in',
      });
      // H05: the size a person reviews, within the review limits.
      await tx.runEvents.append(runId, 'diff_measured', {
        result: 'measured',
        review_files: 1,
        review_lines: 2,
        generated_files: 0,
        generated_lines: 0,
        binary_files: 0,
      });
      const memory = options.memory;
      if (memory) {
        const memoryUri = `s3://evidence/diffs/${t.f.target.tenantId}/${intent.id}/${runId}.memory.patch`;
        evidence.files.set(memoryUri, memory.patch);
        await tx.evidenceItems.record({
          intentId: intent.id,
          runId,
          kind: 'memory_diff',
          storageUri: memoryUri,
          sha256: memory.storedSha256 ?? memory.sha256,
          sizeBytes: memory.patch.length,
        });
        await tx.runEvents.append(runId, 'memory_proposed', {
          files_added: 1,
          files_changed: 0,
          files_removed: 0,
          kept_in_change: 0,
          set_sha256: 'c'.repeat(64),
          memory_sha256: memory.storedSha256 ?? memory.sha256,
          paths_sha256: memory.pathsSha256,
        });
      }
    });
    await t.f.scope.runs.transition(runId, {
      from: ['running'],
      to: 'succeeded',
      now,
      finishedAt: now,
    });
    return { intent, runId, branch: `agent/${intent.code}` };
  }

  const events = async (runId: string) =>
    (await t.f.scope.runEvents.list(runId))
      .filter((e) => ['branch_pushed', 'publish_refused', 'publish_failed'].includes(e.event_type))
      .map((e) => [e.event_type, e.payload]);

  const standardChange = (dir: string) => {
    fs.writeFileSync(path.join(dir, 'src/main.ts'), 'export const a = 2;\n');
    fs.writeFileSync(path.join(dir, 'src/new.ts'), 'export const b = 3;\n');
    fs.writeFileSync(path.join(dir, 'logo.bin'), Buffer.from([0, 1, 2, 255, 0]));
    fs.symlinkSync('/etc/passwd', path.join(dir, 'link'));
    fs.rmSync(path.join(dir, 'src/old.ts'));
  };

  it('pushes one commit made from the stored diff; idempotent; the token stays a header', async () => {
    const diff = makeDiff(path.join(host.root, `${REPO}.git`), base, standardChange);
    const { runId, branch, intent } = await succeededRun(diff);
    expect(await publishRun(deps(), input(runId))).toEqual({ outcome: 'pushed' });

    const head = host.branchHead(REPO, branch);
    expect(head).toMatch(/^[0-9a-f]{40}$/);
    expect(host.gitIn(REPO, 'rev-parse', `${head!}^{tree}`)).toBe(diff.tree);
    expect(host.gitIn(REPO, 'rev-parse', `${head!}^`)).toBe(base);
    expect(host.gitIn(REPO, 'log', '-1', '--format=%an <%ae>|%cn <%ce>|%s|%at', head!)).toBe(
      `sdlc-agent <agent-${t.agent.id}@agents.sdlc.invalid>|sdlc-agent <agent-${t.agent.id}@agents.sdlc.invalid>|sdlc: ${intent.code} run ${runId}|${String(Date.parse('2026-09-28T02:00:00.000Z') / 1000)}`,
    );
    // The link is a link in Git, never followed by the runner.
    expect(host.gitIn(REPO, 'cat-file', '-p', `${head!}:link`)).toBe('/etc/passwd');

    expect(await events(runId)).toEqual([
      [
        'branch_pushed',
        {
          head_sha: head,
          parent_sha: base,
          diff_sha256: diff.sha256,
          paths_sha256: diff.pathsSha256,
        },
      ],
    ]);
    expect((await t.f.scope.runs.getById(runId))?.head_sha).toBe(head);

    // A repeated activity: nothing new.
    expect(await publishRun(deps(), input(runId))).toEqual({ outcome: 'pushed' });
    expect(host.branchHead(REPO, branch)).toBe(head);
    expect((await events(runId)).length).toBe(1);

    // The token: an authorization header only; never in a URL; nothing left on disk.
    expect(host.requests.every((r) => r.authorized && !r.url.includes(TOKEN))).toBe(true);
    expect(fs.readdirSync(workDir)).toEqual([]);
    const stored = JSON.stringify(await t.f.scope.runEvents.list(runId));
    expect(stored).not.toContain(TOKEN);
  });

  it('a lost activity with the push done: the same commit again, accepted as pushed', async () => {
    const diff = makeDiff(path.join(host.root, `${REPO}.git`), base, (dir) =>
      fs.writeFileSync(path.join(dir, 'README.md'), 'pilot 2\n'),
    );
    const { runId, branch } = await succeededRun(diff);
    expect(await publishRun(deps(), input(runId))).toEqual({ outcome: 'pushed' });
    const head = host.branchHead(REPO, branch);
    // Forget the record (a crash between the push and the record): the runner makes the same
    // commit (fixed dates) and finds it on the branch.
    await tamper(
      db.name,
      `DELETE FROM run_events WHERE run_id = $1 AND event_type = 'branch_pushed'`,
      [runId],
    );
    await tamper(db.name, 'UPDATE runs SET head_sha = NULL WHERE id = $1', [runId]);
    expect(await publishRun(deps(), input(runId))).toEqual({ outcome: 'pushed' });
    expect(host.branchHead(REPO, branch)).toBe(head);
  });

  it('refuses a diff that is not the one G5 checked, or whose paths differ (diff_mismatch)', async () => {
    const diff = makeDiff(path.join(host.root, `${REPO}.git`), base, (dir) =>
      fs.writeFileSync(path.join(dir, 'src/main.ts'), 'x\n'),
    );
    const one = await succeededRun(diff);
    evidence.files.set([...evidence.files.keys()].at(-1)!, Buffer.from('other bytes\n'));
    expect(await publishRun(deps(), input(one.runId))).toEqual({
      outcome: 'refused',
      reason: 'diff_mismatch',
    });
    const two = await succeededRun(diff, { pathsSha256: 'b'.repeat(64) });
    expect(await publishRun(deps(), input(two.runId))).toEqual({
      outcome: 'refused',
      reason: 'diff_mismatch',
    });
    expect(host.branchHead(REPO, two.branch)).toBeNull();
    // Final: asked again, the runner answers the same without trying.
    expect(await publishRun(deps(), input(two.runId))).toEqual({
      outcome: 'refused',
      reason: 'diff_mismatch',
    });
  });

  it('reads only the diff of the run itself: another storage path is refused (changes_missing)', async () => {
    const diff = makeDiff(path.join(host.root, `${REPO}.git`), base, (dir) =>
      fs.writeFileSync(path.join(dir, 'README.md'), 'other\n'),
    );
    const { runId, intent } = await succeededRun(diff);
    const other = `s3://evidence/diffs/${t.f.target.tenantId}/${intent.id}/other.patch`;
    evidence.files.set(other, diff.patch);
    await tamper(db.name, 'UPDATE evidence_items SET storage_uri = $1 WHERE run_id = $2', [
      other,
      runId,
    ]);
    expect(await publishRun(deps(), input(runId))).toEqual({
      outcome: 'refused',
      reason: 'changes_missing',
    });
  });

  it('refuses an empty change (empty_diff)', async () => {
    const diff = makeDiff(path.join(host.root, `${REPO}.git`), base, () => undefined);
    const { runId } = await succeededRun(diff);
    expect(await publishRun(deps(), input(runId))).toEqual({
      outcome: 'refused',
      reason: 'empty_diff',
    });
  });

  it('refuses when someone else moved the agent branch (branch_moved); never forces', async () => {
    const diff = makeDiff(path.join(host.root, `${REPO}.git`), base, (dir) =>
      fs.writeFileSync(path.join(dir, 'src/new.ts'), 'y\n'),
    );
    const { runId, branch } = await succeededRun(diff);
    const second = host.gitIn(REPO, 'rev-parse', 'refs/heads/main');
    host.gitIn(REPO, 'update-ref', `refs/heads/${branch}`, second);
    expect(await publishRun(deps(), input(runId))).toEqual({
      outcome: 'refused',
      reason: 'branch_moved',
    });
    expect(host.branchHead(REPO, branch)).toBe(second);
  });

  it('an unusable token is a failure that may pass (publish_failed)', async () => {
    const diff = makeDiff(path.join(host.root, `${REPO}.git`), base, (dir) =>
      fs.writeFileSync(path.join(dir, 'src/b.ts'), 'z\n'),
    );
    const { runId } = await succeededRun(diff);
    const used = input(runId);
    await unwrapper.unwrap(new Redacted(used.wrappedPushToken));
    expect(await publishRun(deps(), used)).toEqual({
      outcome: 'failed',
      reason: 'token_unavailable',
    });
    expect(await events(runId)).toEqual([['publish_failed', { reason: 'token_unavailable' }]]);
    // The next attempt with a new token works.
    expect(await publishRun(deps(), input(runId))).toEqual({ outcome: 'pushed' });
  });

  const memoryEvents = async (runId: string) =>
    (await t.f.scope.runEvents.list(runId))
      .filter((e) => e.event_type.startsWith('memory_') && e.event_type !== 'memory_proposed')
      .map((e) => [e.event_type, e.payload]);
  const bare = () => path.join(host.root, `${REPO}.git`);
  const note = (name: string, text: string) => (dir: string) => {
    fs.mkdirSync(path.join(dir, '.sdlc/memory'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.sdlc/memory', name), text);
  };

  it('X13 PR 3a: pushes the memory part to its own branch after the code', async () => {
    const diff = makeDiff(bare(), base, (dir) =>
      fs.writeFileSync(path.join(dir, 'src/main.ts'), 'export const a = 7;\n'),
    );
    const memory = makeDiff(bare(), base, note('build.md', 'Run pnpm test.\n'));
    const { runId, branch, intent } = await succeededRun(diff, { memory });
    expect(await publishRun(deps(), input(runId))).toEqual({ outcome: 'pushed' });

    const memoryBranch = `${branch}-memory-1`;
    const head = host.branchHead(REPO, memoryBranch);
    expect(head).toMatch(/^[0-9a-f]{40}$/);
    expect(host.gitIn(REPO, 'rev-parse', `${head!}^{tree}`)).toBe(memory.tree);
    expect(host.gitIn(REPO, 'rev-parse', `${head!}^`)).toBe(base);
    expect(host.gitIn(REPO, 'log', '-1', '--format=%s', head!)).toBe(
      `sdlc: ${intent.code} run ${runId} memory`,
    );
    // The code branch never holds a memory path.
    const code = host.branchHead(REPO, branch)!;
    expect(host.gitIn(REPO, 'ls-tree', '-r', '--name-only', code)).not.toContain('.sdlc/memory');
    expect(await memoryEvents(runId)).toEqual([
      ['memory_branch_pushed', { head_sha: head, parent_sha: base, memory_sha256: memory.sha256 }],
    ]);
    // A repeated activity: nothing new.
    expect(await publishRun(deps(), input(runId))).toEqual({ outcome: 'pushed' });
    expect((await memoryEvents(runId)).length).toBe(1);
  }, 60_000);

  it('X13 PR 3a: a run without a memory proposal pushes no memory branch', async () => {
    const diff = makeDiff(bare(), base, (dir) =>
      fs.writeFileSync(path.join(dir, 'src/main.ts'), 'export const a = 8;\n'),
    );
    const { runId, branch } = await succeededRun(diff);
    expect(await publishRun(deps(), input(runId))).toEqual({ outcome: 'pushed' });
    expect(host.branchHead(REPO, `${branch}-memory-1`)).toBeNull();
    expect(await memoryEvents(runId)).toEqual([]);
  });

  it('X13 PR 3a: a memory failure is recorded and never changes the code push', async () => {
    const code = (text: string) => (dir: string) =>
      fs.writeFileSync(path.join(dir, 'src/main.ts'), text);
    // Paths that are not the ones the runner split out.
    const one = await succeededRun(makeDiff(bare(), base, code('one\n')), {
      memory: { ...makeDiff(bare(), base, note('a.md', 'a\n')), pathsSha256: 'd'.repeat(64) },
    });
    expect(await publishRun(deps(), input(one.runId))).toEqual({ outcome: 'pushed' });
    expect(await memoryEvents(one.runId)).toEqual([
      ['memory_publish_failed', { reason: 'diff_mismatch' }],
    ]);
    expect(host.branchHead(REPO, `${one.branch}-memory-1`)).toBeNull();

    // A stored memory diff that is not the recorded one.
    const two = await succeededRun(makeDiff(bare(), base, code('two\n')), {
      memory: { ...makeDiff(bare(), base, note('b.md', 'b\n')), storedSha256: 'e'.repeat(64) },
    });
    expect(await publishRun(deps(), input(two.runId))).toEqual({ outcome: 'pushed' });
    expect(await memoryEvents(two.runId)).toEqual([
      ['memory_publish_failed', { reason: 'diff_mismatch' }],
    ]);

    // Someone else moved the memory branch: never forced.
    const three = await succeededRun(makeDiff(bare(), base, code('three\n')), {
      memory: makeDiff(bare(), base, note('c.md', 'c\n')),
    });
    const second = host.gitIn(REPO, 'rev-parse', 'refs/heads/main');
    host.gitIn(REPO, 'update-ref', `refs/heads/${three.branch}-memory-1`, second);
    expect(await publishRun(deps(), input(three.runId))).toEqual({ outcome: 'pushed' });
    expect(await memoryEvents(three.runId)).toEqual([
      ['memory_publish_failed', { reason: 'branch_moved' }],
    ]);
    expect(host.branchHead(REPO, `${three.branch}-memory-1`)).toBe(second);
  }, 60_000);

  it('N6: the Git host refuses a push to main, even with a write token', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-c08-n6-'));
    try {
      git(dir, 'clone', '--quiet', path.join(host.root, `${REPO}.git`), 'repo');
      const repoDir = path.join(dir, 'repo');
      git(repoDir, 'commit', '--quiet', '--allow-empty', '-m', 'probe');
      const commit = git(repoDir, 'rev-parse', 'HEAD').toString().trim();
      fs.mkdirSync(path.join(dir, 'home'));
      // The runner's own guard refuses the branch name first…
      await expect(
        pushCommit(settings().git, {
          repoDir,
          repo: REPO,
          branch: 'main',
          commit,
          token: new Redacted(TOKEN),
          home: path.join(dir, 'home'),
        }),
      ).rejects.toMatchObject({ reason: 'push_rejected' });
      // …and the Git host's protection refuses it when another tool tries (async: the stub
      // server runs in this process).
      await expect(
        execFileAsync(
          'git',
          [
            '-C',
            repoDir,
            'push',
            '--quiet',
            `${host.origin}/${REPO}.git`,
            `${commit}:refs/heads/main`,
          ],
          { env: { ...GIT_ENV, ...authEnv(host.origin) } },
        ),
      ).rejects.toThrow();
      expect(host.branchHead(REPO, 'main')).not.toBe(commit);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
