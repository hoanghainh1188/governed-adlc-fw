// D-08 B05 AC3: comment on issues and pull requests; read a file at a commit. Also the other
// read calls of D-03 §7.1 used by later tasks: pull request, changed files (G5), CI status (G6),
// approvals (G7). Against the in-process GitHub stub.
import { MAX_COMMENT_CHARS } from '@sdlc/adapter-git-github';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startHarness, type Harness } from './helpers';
import { checkRun, pull, REPO, review, SHA_A, SHA_B, status, user } from './stub-github';

let h: Harness;

beforeEach(async () => {
  h = await startHarness();
});

afterEach(async () => {
  await h.stub.stop();
});

describe('createIssueComment (AC3)', () => {
  it('posts the body to the issue comments endpoint (issues and pull requests alike)', async () => {
    h.stub.on('POST', '/repos/acme/shop/issues/12/comments', { status: 201, body: { id: 9 } });
    await h.adapter().createIssueComment(REPO, 12, 'Gate G3: waiting for approval.');
    const [req] = h.stub.requestsTo('POST', '/repos/acme/shop/issues/12/comments');
    expect(req?.body).toEqual({ body: 'Gate G3: waiting for approval.' });
    expect(req?.headers['x-github-api-version']).toBe('2022-11-28');
    expect(req?.headers.accept).toBe('application/vnd.github+json');
  });

  it('refuses an empty or too long body and a bad issue number, without calling GitHub', async () => {
    const a = h.adapter();
    await expect(a.createIssueComment(REPO, 1, '  ')).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(
      a.createIssueComment(REPO, 1, 'x'.repeat(MAX_COMMENT_CHARS + 1)),
    ).rejects.toMatchObject({
      code: 'body_too_large',
      params: { max_chars: 65_536 },
    });
    await expect(a.createIssueComment(REPO, 0, 'x')).rejects.toMatchObject({
      code: 'invalid_input',
    });
    expect(h.stub.requests).toHaveLength(0);
  });

  it('never retries a POST after a server error (a retry could post twice)', async () => {
    h.stub.on('POST', '/repos/acme/shop/issues/1/comments', { status: 502 });
    await expect(h.adapter().createIssueComment(REPO, 1, 'x')).rejects.toMatchObject({
      code: 'server_error',
      params: { status: 502 },
    });
    expect(h.stub.requestsTo('POST', '/repos/acme/shop/issues/1/comments')).toHaveLength(1);
  });
});

describe('getFileAtCommit (AC3)', () => {
  const PATH = '/repos/acme/shop/contents/docs/specs/T06%20tax.md';
  const raw = (bytes: Buffer) => ({
    raw: bytes,
    headers: { 'content-type': 'application/vnd.github.raw+json' },
  });

  it('reads the raw file at the commit, byte for byte (CRLF and BOM kept)', async () => {
    const text = '﻿# T06 消費税計算\r\nAC1: 10% / 8%\r\n';
    h.stub.on('GET', PATH, raw(Buffer.from(text, 'utf8')));
    const content = await h.adapter().getFileAtCommit(REPO, 'docs/specs/T06 tax.md', SHA_A);
    expect(content).toBe(text);
    const [req] = h.stub.requestsTo('GET', PATH);
    expect(req?.query.get('ref')).toBe(SHA_A);
    expect(req?.headers.accept).toBe('application/vnd.github.raw+json');
  });

  it('refuses a file that is not UTF-8', async () => {
    h.stub.on('GET', PATH, raw(Buffer.from([0xff, 0xfe, 0x00, 0x41])));
    await expect(
      h.adapter().getFileAtCommit(REPO, 'docs/specs/T06 tax.md', SHA_A),
    ).rejects.toMatchObject({ code: 'file_not_utf8' });
  });

  it('refuses a file larger than maxFileBytes', async () => {
    h.stub.on('GET', PATH, raw(Buffer.alloc(2048, 0x61)));
    await expect(
      h.adapter({ maxFileBytes: 1024 }).getFileAtCommit(REPO, 'docs/specs/T06 tax.md', SHA_A),
    ).rejects.toMatchObject({ code: 'file_too_large', params: { max_bytes: 1024 } });
  });

  it('refuses a directory', async () => {
    h.stub.on('GET', '/repos/acme/shop/contents/docs', { body: [{ name: 'a.md', type: 'file' }] });
    await expect(h.adapter().getFileAtCommit(REPO, 'docs', SHA_A)).rejects.toMatchObject({
      code: 'not_a_file',
    });
  });

  it('maps a missing file to not_found', async () => {
    await expect(h.adapter().getFileAtCommit(REPO, 'nope.md', SHA_A)).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it.each(['../secret', '/etc/passwd', 'a//b', 'a/./b', 'a\\b', ''])(
    'refuses the path %j without calling GitHub',
    async (path) => {
      await expect(h.adapter().getFileAtCommit(REPO, path, SHA_A)).rejects.toMatchObject({
        code: 'invalid_input',
      });
      expect(h.stub.requests).toHaveLength(0);
    },
  );

  it('refuses a ref that is not a commit SHA (a branch name could move)', async () => {
    await expect(h.adapter().getFileAtCommit(REPO, 'a.md', 'main')).rejects.toMatchObject({
      code: 'invalid_input',
      params: { field: 'sha' },
    });
  });
});

describe('getBranchHead (C06, QUESTIONS #109)', () => {
  const REF = '/repos/acme/shop/git/ref/heads/release/v1';

  it('returns the commit the branch points to', async () => {
    h.stub.on('GET', REF, {
      body: { ref: 'refs/heads/release/v1', object: { type: 'commit', sha: SHA_A } },
    });
    await expect(h.adapter().getBranchHead(REPO, 'release/v1')).resolves.toBe(SHA_A);
    expect(h.stub.requestsTo('GET', REF)).toHaveLength(1);
  });

  it('refuses a reference that is not a commit', async () => {
    h.stub.on('GET', REF, { body: { object: { type: 'tag', sha: SHA_A } } });
    await expect(h.adapter().getBranchHead(REPO, 'release/v1')).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });

  it('maps a missing branch to not_found', async () => {
    await expect(h.adapter().getBranchHead(REPO, 'gone')).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it.each(['', '../main', 'a..b', '-x', 'a//b', '.hidden', 'x.lock', 'a b', 'a?b', 'a/'])(
    'refuses the branch name %j without calling GitHub',
    async (branch) => {
      await expect(h.adapter().getBranchHead(REPO, branch)).rejects.toMatchObject({
        code: 'invalid_input',
        params: { field: 'branch' },
      });
      expect(h.stub.requests).toHaveLength(0);
    },
  );
});

describe('listPaths (C07, QUESTIONS #126)', () => {
  const TREE = `/repos/acme/shop/git/trees/${SHA_A}`;

  it('returns every non-directory path of the commit, sorted, in one recursive call', async () => {
    h.stub.on('GET', TREE, {
      body: {
        sha: SHA_A,
        truncated: false,
        tree: [
          { path: 'src', type: 'tree', mode: '040000', sha: SHA_A },
          { path: 'src/main.ts', type: 'blob', mode: '100644', sha: SHA_A },
          { path: 'AGENTS.md', type: 'blob', mode: '100644', sha: SHA_A },
          { path: 'vendor/lib', type: 'commit', mode: '160000', sha: SHA_A },
          { path: 'link', type: 'blob', mode: '120000', sha: SHA_A },
        ],
      },
    });
    await expect(h.adapter().listPaths(REPO, SHA_A)).resolves.toEqual([
      'AGENTS.md',
      'link',
      'src/main.ts',
      'vendor/lib',
    ]);
    const [request] = h.stub.requestsTo('GET', TREE);
    expect(request?.query.get('recursive')).toBe('1');
  });

  it('fails closed when GitHub cuts a folder even without recursive (tree_truncated)', async () => {
    h.stub.on('GET', TREE, { body: { sha: SHA_A, truncated: true, tree: [] } });
    await expect(h.adapter().listPaths(REPO, SHA_A)).rejects.toMatchObject({
      code: 'tree_truncated',
    });
  });

  describe('a tree GitHub cuts short (O06 AC1, ADR-M106)', () => {
    const SUB_APPS = 'c'.repeat(40);
    const SUB_WEB = 'd'.repeat(40);
    const SUB_LIB = 'e'.repeat(40);
    const tree = (treeSha: string) => `/repos/acme/shop/git/trees/${treeSha}`;
    const blob = (path: string) => ({ path, type: 'blob', mode: '100644', sha: SHA_B });
    const dir = (path: string, treeSha: string) => ({
      path,
      type: 'tree',
      mode: '040000',
      sha: treeSha,
    });

    /** root → apps (cut) → web (whole), lib (whole); root also has AGENTS.md. */
    function bigRepo(): void {
      h.stub.on('GET', tree(SHA_A), (req) =>
        req.query.get('recursive') === '1'
          ? { body: { sha: SHA_A, truncated: true, tree: [blob('partial')] } }
          : {
              body: {
                sha: SHA_A,
                truncated: false,
                tree: [blob('AGENTS.md'), dir('apps', SUB_APPS)],
              },
            },
      );
      h.stub.on('GET', tree(SUB_APPS), (req) =>
        req.query.get('recursive') === '1'
          ? { body: { sha: SUB_APPS, truncated: true, tree: [] } }
          : {
              body: {
                sha: SUB_APPS,
                truncated: false,
                tree: [dir('web', SUB_WEB), dir('lib', SUB_LIB), blob('README.md')],
              },
            },
      );
      h.stub.on('GET', tree(SUB_WEB), {
        body: {
          sha: SUB_WEB,
          truncated: false,
          tree: [dir('src', SHA_B), blob('src/AGENTS.md'), blob('src/main.ts')],
        },
      });
      h.stub.on('GET', tree(SUB_LIB), {
        body: { sha: SUB_LIB, truncated: false, tree: [blob('index.ts')] },
      });
    }

    it('lists it in parts: every path, full, sorted, never the cut listing', async () => {
      bigRepo();
      await expect(h.adapter().listPaths(REPO, SHA_A)).resolves.toEqual([
        'AGENTS.md',
        'apps/README.md',
        'apps/lib/index.ts',
        'apps/web/src/AGENTS.md',
        'apps/web/src/main.ts',
      ]);
      // root: recursive + plain; apps: recursive + plain; web, lib: recursive only.
      expect(h.stub.requestsTo('GET', tree(SHA_A))).toHaveLength(2);
      expect(h.stub.requestsTo('GET', tree(SUB_APPS))).toHaveLength(2);
      expect(h.stub.requestsTo('GET', tree(SUB_WEB))).toHaveLength(1);
      expect(h.stub.requestsTo('GET', tree(SUB_LIB))).toHaveLength(1);
    });

    it('fails closed past maxTreeRequests (tree_truncated)', async () => {
      bigRepo();
      await expect(h.adapter({ maxTreeRequests: 5 }).listPaths(REPO, SHA_A)).rejects.toMatchObject({
        code: 'tree_truncated',
      });
      expect(h.stub.requests.filter((r) => r.path.includes('/git/trees/'))).toHaveLength(5);
      await expect(h.adapter({ maxTreeRequests: 6 }).listPaths(REPO, SHA_A)).resolves.toHaveLength(
        5,
      );
    });

    it.each(['a/b', '..', '.'])('refuses a folder entry named %j', async (name) => {
      h.stub.on('GET', tree(SHA_A), (req) =>
        req.query.get('recursive') === '1'
          ? { body: { truncated: true, tree: [] } }
          : { body: { truncated: false, tree: [dir(name, SUB_LIB)] } },
      );
      await expect(h.adapter().listPaths(REPO, SHA_A)).rejects.toMatchObject({
        code: 'invalid_response',
      });
    });

    it('refuses a sub-tree without a valid SHA', async () => {
      h.stub.on('GET', tree(SHA_A), (req) =>
        req.query.get('recursive') === '1'
          ? { body: { truncated: true, tree: [] } }
          : { body: { truncated: false, tree: [dir('apps', '../x')] } },
      );
      await expect(h.adapter().listPaths(REPO, SHA_A)).rejects.toMatchObject({
        code: 'invalid_response',
      });
    });
  });

  it('refuses an unknown entry type', async () => {
    h.stub.on('GET', TREE, {
      body: { truncated: false, tree: [{ path: 'x', type: 'tag', sha: SHA_A }] },
    });
    await expect(h.adapter().listPaths(REPO, SHA_A)).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });

  it('refuses a commit that is not a SHA without calling GitHub', async () => {
    await expect(h.adapter().listPaths(REPO, 'main')).rejects.toMatchObject({
      code: 'invalid_input',
      params: { field: 'sha' },
    });
    expect(h.stub.requests).toHaveLength(0);
  });
});

describe('getPullRequest and getChangedFiles', () => {
  it('returns the pull request without its free-text title or body', async () => {
    h.stub.on('GET', '/repos/acme/shop/pulls/7', { body: pull(7, '2026-09-26T07:00:00Z') });
    const pr = await h.adapter().getPullRequest(REPO, 7);
    expect(pr).toEqual({
      number: 7,
      state: 'open',
      draft: false,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headSha: SHA_A,
      headRef: 'agent/INT-2026-0007',
      baseRef: 'main',
      author: { id: '2002', login: 'agent-bot[bot]', type: 'bot' },
      mergedBy: null,
      changedFiles: 2,
      url: 'https://github.com/acme/shop/pull/7',
    });
  });

  it('lists changed files over all pages, with both paths of a rename', async () => {
    h.stub.on('GET', '/repos/acme/shop/pulls/7', {
      body: { ...pull(7, '2026-09-26T07:00:00Z'), changed_files: 3 },
    });
    h.stub.on('GET', '/repos/acme/shop/pulls/7/files', (req) =>
      req.query.get('page') === '2'
        ? { body: [{ filename: 'apps/api/src/b.ts', status: 'modified' }] }
        : {
            body: [
              { filename: 'apps/web/src/a.vue', status: 'modified' },
              {
                filename: 'apps/api/src/new-name.ts',
                previous_filename: 'apps/api/src/old-name.ts',
                status: 'renamed',
              },
            ],
            headers: {
              link: `<${h.stub.address}/repos/acme/shop/pulls/7/files?per_page=100&page=2>; rel="next"`,
            },
          },
    );
    expect(await h.adapter().getChangedFiles(REPO, 7)).toEqual([
      'apps/api/src/b.ts',
      'apps/api/src/new-name.ts',
      'apps/api/src/old-name.ts',
      'apps/web/src/a.vue',
    ]);
  });

  it('fails instead of returning a partial list (more than 3000 files, or a short list)', async () => {
    h.stub.on('GET', '/repos/acme/shop/pulls/7', {
      body: { ...pull(7, '2026-09-26T07:00:00Z'), changed_files: 3001 },
    });
    await expect(h.adapter().getChangedFiles(REPO, 7)).rejects.toMatchObject({
      code: 'too_many_files',
      params: { max_files: 3000 },
    });
    h.stub.on('GET', '/repos/acme/shop/pulls/7', {
      body: { ...pull(7, '2026-09-26T07:00:00Z'), changed_files: 5 },
    });
    h.stub.on('GET', '/repos/acme/shop/pulls/7/files', { body: [{ filename: 'a.ts' }] });
    await expect(h.adapter().getChangedFiles(REPO, 7)).rejects.toMatchObject({
      code: 'invalid_response',
      params: { field: 'files' },
    });
  });
});

describe('getCheckStatus', () => {
  const RUNS = `/repos/acme/shop/commits/${SHA_A}/check-runs`;
  const STATUS = `/repos/acme/shop/commits/${SHA_A}/status`;

  it.each([
    ['none', [], []],
    [
      'success',
      [checkRun(1, 'lint', 'success', '2026-09-26T07:00:00Z')],
      [status(5, 'ci/x', 'success', '2026-09-26T07:00:00Z')],
    ],
    [
      'pending',
      [checkRun(1, 'lint', null, null)],
      [status(5, 'ci/x', 'success', '2026-09-26T07:00:00Z')],
    ],
    [
      'failure',
      [checkRun(1, 'lint', null, null), checkRun(2, 'test', 'timed_out', '2026-09-26T07:00:00Z')],
      [],
    ],
    [
      'failure',
      [checkRun(1, 'lint', 'skipped', '2026-09-26T07:00:00Z')],
      [status(5, 'ci/x', 'error', '2026-09-26T07:00:00Z')],
    ],
  ])('summarises check runs and commit statuses as %s', async (state, runs, statuses) => {
    h.stub.on('GET', RUNS, { body: { total_count: runs.length, check_runs: runs } });
    h.stub.on('GET', STATUS, { body: { state: 'x', statuses } });
    const summary = await h.adapter().getCheckStatus(REPO, SHA_A);
    expect(summary.state).toBe(state);
    expect(summary.checks).toHaveLength(runs.length + statuses.length);
    expect(h.stub.requestsTo('GET', RUNS)[0]?.query.get('filter')).toBe('latest');
  });

  it('refuses a ref that is not a SHA', async () => {
    await expect(h.adapter().getCheckStatus(REPO, 'main')).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });
});

describe('getApprovals', () => {
  it("counts each reviewer's latest decision, bound to the reviewed commit", async () => {
    const b = user(3003, 'person-b');
    const second = user(4004, 'second');
    const other = user(5005, 'other');
    h.stub.on('GET', '/repos/acme/shop/pulls/7/reviews', {
      body: [
        review(1, b, 'CHANGES_REQUESTED', '2026-09-26T06:00:00Z'),
        review(2, b, 'APPROVED', '2026-09-26T07:00:00Z', 'c'.repeat(40)),
        review(3, b, 'COMMENTED', '2026-09-26T07:30:00Z'), // a comment keeps the approval
        review(4, second, 'APPROVED', '2026-09-26T06:30:00Z'),
        review(5, second, 'CHANGES_REQUESTED', '2026-09-26T07:10:00Z'), // changed their mind
        review(6, other, 'DISMISSED', '2026-09-26T06:00:00Z'), // a dismissed approval
        review(7, other, 'PENDING', null), // not submitted
      ],
    });
    expect(await h.adapter().getApprovals(REPO, 7)).toEqual([
      {
        reviewId: '2',
        reviewer: { id: '3003', login: 'person-b', type: 'user' },
        commitSha: 'c'.repeat(40),
        submittedAt: '2026-09-26T07:00:00.000Z',
        url: 'https://github.com/acme/shop/pull/7#pullrequestreview-2',
      },
    ]);
  });

  it('marks App and bot reviewers as bots (they never count as approvers, QUESTIONS #45)', async () => {
    h.stub.on('GET', '/repos/acme/shop/pulls/7/reviews', {
      body: [review(1, user(9, 'sdlc-platform[bot]', 'Bot'), 'APPROVED', '2026-09-26T07:00:00Z')],
    });
    const [approval] = await h.adapter().getApprovals(REPO, 7);
    expect(approval?.reviewer.type).toBe('bot');
  });
});

describe('getReviews, getCommitAuthors, mergedBy (E01)', () => {
  it("keeps each reviewer's latest decision, dismissed reviews included", async () => {
    const b = user(3003, 'person-b');
    const other = user(5005, 'other');
    h.stub.on('GET', '/repos/acme/shop/pulls/7/reviews', {
      body: [
        review(1, b, 'APPROVED', '2026-09-26T06:00:00Z'),
        review(2, b, 'CHANGES_REQUESTED', '2026-09-26T07:00:00Z'),
        review(3, b, 'COMMENTED', '2026-09-26T07:30:00Z'), // keeps the request for changes
        review(4, other, 'DISMISSED', '2026-09-26T06:00:00Z'),
        review(5, other, 'PENDING', null),
      ],
    });
    const reviews = await h.adapter().getReviews(REPO, 7);
    expect(reviews.map((r) => [r.eventId, r.reviewer.id, r.state])).toEqual([
      ['github:review:2', '3003', 'changes_requested'],
      ['github:review:4', '5005', 'dismissed'],
    ]);
    expect(await h.adapter().getApprovals(REPO, 7)).toEqual([]);
  });

  it('commit authors: accounts by numeric ID, commits without an account counted', async () => {
    h.stub.on('GET', '/repos/acme/shop/pulls/7/commits', {
      body: [
        { sha: 'a'.repeat(40), author: user(2002, 'agent-bot[bot]', 'Bot'), commit: {} },
        { sha: 'b'.repeat(40), author: null, commit: { author: { email: 'x@example.com' } } },
        { sha: 'c'.repeat(40), author: user(3003, 'person-b'), commit: {} },
        { sha: 'd'.repeat(40), author: user(3003, 'person-b'), commit: {} },
      ],
    });
    const authors = await h.adapter().getCommitAuthors(REPO, 7);
    expect(authors).toEqual({
      accounts: [
        { id: '2002', login: 'agent-bot[bot]', type: 'bot' },
        { id: '3003', login: 'person-b', type: 'user' },
      ],
      withoutAccount: 1,
    });
    expect(JSON.stringify(authors)).not.toContain('example.com');
  });

  it('a merged pull request names who merged it', async () => {
    h.stub.on('GET', '/repos/acme/shop/pulls/7', {
      body: {
        ...pull(7, '2026-09-26T08:00:00Z', SHA_A, 'closed'),
        merged_at: '2026-09-26T09:00:00Z',
        merge_commit_sha: 'f'.repeat(40),
        merged_by: user(3003, 'person-b'),
      },
    });
    expect(await h.adapter().getPullRequest(REPO, 7)).toMatchObject({
      merged: true,
      mergeCommitSha: 'f'.repeat(40),
      mergedBy: { id: '3003', login: 'person-b', type: 'user' },
    });
  });
});

describe('getMergedChange, getCommitParents, compareChangedFiles (L07, ADR-M85 §2.3)', () => {
  const SHA_C = 'c'.repeat(40);
  const merged = (extra: Record<string, unknown> = {}) => ({
    body: {
      ...pull(7, '2026-10-20T07:00:00Z', SHA_A, 'closed'),
      merged_at: '2026-10-20T07:00:00Z',
      merge_commit_sha: SHA_C,
      merged_by: user(1001, 'harry'),
      commits: 3,
      changed_files: 3,
      ...extra,
    },
  });

  it('returns the files with their status, the commit count and the merge parents', async () => {
    h.stub.on('GET', '/repos/acme/shop/pulls/7', merged());
    h.stub.on('GET', '/repos/acme/shop/pulls/7/files', {
      body: [
        { filename: 'src/b.ts', status: 'modified' },
        { filename: 'src/b.test.ts', status: 'added' },
        { filename: 'src/new.ts', previous_filename: 'src/old.ts', status: 'renamed' },
      ],
    });
    h.stub.on('GET', `/repos/acme/shop/git/commits/${SHA_C}`, {
      body: { sha: SHA_C, parents: [{ sha: SHA_B }, { sha: SHA_A }] },
    });
    expect(await h.adapter().getMergedChange(REPO, 7)).toEqual({
      mergeCommitSha: SHA_C,
      mergeCommitParents: [SHA_B, SHA_A],
      commitCount: 3,
      files: [
        { path: 'src/b.test.ts', status: 'added', previousPath: null },
        { path: 'src/b.ts', status: 'modified', previousPath: null },
        { path: 'src/new.ts', status: 'renamed', previousPath: 'src/old.ts' },
      ],
    });
  });

  it('refuses a pull request that is not merged, a short list and an unknown status', async () => {
    h.stub.on('GET', '/repos/acme/shop/pulls/7', { body: pull(7, '2026-10-20T07:00:00Z') });
    await expect(h.adapter().getMergedChange(REPO, 7)).rejects.toMatchObject({
      code: 'invalid_input',
      params: { field: 'pr' },
    });
    h.stub.on('GET', '/repos/acme/shop/pulls/7', merged());
    h.stub.on('GET', '/repos/acme/shop/pulls/7/files', {
      body: [{ filename: 'a.ts', status: 'added' }],
    });
    await expect(h.adapter().getMergedChange(REPO, 7)).rejects.toMatchObject({
      code: 'invalid_response',
      params: { field: 'files' },
    });
    h.stub.on('GET', '/repos/acme/shop/pulls/7', merged({ changed_files: 1 }));
    h.stub.on('GET', '/repos/acme/shop/pulls/7/files', {
      body: [{ filename: 'a.ts', status: 'unchanged' }],
    });
    await expect(h.adapter().getMergedChange(REPO, 7)).rejects.toMatchObject({
      code: 'invalid_response',
      params: { field: 'file.status' },
    });
  });

  it('reads the parents of a commit and checks the commit it got', async () => {
    h.stub.on('GET', `/repos/acme/shop/git/commits/${SHA_C}`, {
      body: { sha: SHA_C, parents: [{ sha: SHA_B }] },
    });
    expect(await h.adapter().getCommitParents(REPO, SHA_C)).toEqual([SHA_B]);
    h.stub.on('GET', `/repos/acme/shop/git/commits/${SHA_C}`, {
      body: { sha: SHA_A, parents: [] },
    });
    await expect(h.adapter().getCommitParents(REPO, SHA_C)).rejects.toMatchObject({
      code: 'invalid_response',
      params: { field: 'commit.sha' },
    });
    await expect(h.adapter().getCommitParents(REPO, 'main')).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });

  it('compares two commits: both paths of a rename, sorted; never a partial list', async () => {
    const COMPARE = `/repos/acme/shop/compare/${SHA_B}...${SHA_C}`;
    h.stub.on('GET', COMPARE, {
      body: {
        files: [
          { filename: 'src/z.ts', status: 'modified' },
          { filename: 'src/new.ts', previous_filename: 'src/old.ts', status: 'renamed' },
        ],
      },
    });
    expect(await h.adapter().compareChangedFiles(REPO, SHA_B, SHA_C)).toEqual([
      'src/new.ts',
      'src/old.ts',
      'src/z.ts',
    ]);
    h.stub.on('GET', COMPARE, {
      body: {
        files: Array.from({ length: 300 }, (_, i) => ({
          filename: `f${String(i)}.ts`,
          status: 'added',
        })),
      },
    });
    await expect(h.adapter().compareChangedFiles(REPO, SHA_B, SHA_C)).rejects.toMatchObject({
      code: 'too_many_files',
      params: { max_files: 300 },
    });
    await expect(h.adapter().compareChangedFiles(REPO, 'x', SHA_C)).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });
});
