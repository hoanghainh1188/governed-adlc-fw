// `listFolder` and `listPathCommits` of the GitHub adapter (X13 PR 1, design/ADR-M74 0.2,
// QUESTIONS #715): one folder of a commit with each entry's kind and object ID, and the commits
// that changed a path, newest first, with their authors' numeric account IDs.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startHarness, type Harness } from './helpers';
import { REPO, SHA_A, SHA_B, user } from './stub-github';

let h: Harness;

beforeEach(async () => {
  h = await startHarness();
});

afterEach(async () => {
  await h.stub.stop();
});

const SDLC = 'c'.repeat(40);
const MEMORY = 'd'.repeat(40);
const BLOB = 'e'.repeat(40);
const tree = (sha: string) => `/repos/acme/shop/git/trees/${sha}`;
const item = (path: string, mode: string, sha = BLOB) => ({
  path,
  mode,
  type: mode === '040000' ? 'tree' : mode === '160000' ? 'commit' : 'blob',
  sha,
});

describe('listFolder', () => {
  function repo(memory: unknown[]): void {
    h.stub.on('GET', tree(SHA_A), {
      body: {
        sha: SHA_A,
        truncated: false,
        tree: [item('.sdlc', '040000', SDLC), item('README.md', '100644')],
      },
    });
    h.stub.on('GET', tree(SDLC), {
      body: {
        sha: SDLC,
        truncated: false,
        tree: [item('memory', '040000', MEMORY), item('plans', '040000', SHA_B)],
      },
    });
    h.stub.on('GET', tree(MEMORY), { body: { sha: MEMORY, truncated: false, tree: memory } });
  }

  it('walks to the folder without recursion and returns each entry with its kind and ID', async () => {
    repo([
      item('z.md', '100644', SHA_B),
      item('a.md', '100755'),
      item('link.md', '120000'),
      item('vendor', '160000'),
      item('sub', '040000'),
    ]);
    await expect(h.adapter().listFolder(REPO, SHA_A, '.sdlc/memory')).resolves.toEqual([
      { name: 'a.md', kind: 'executable', sha: BLOB },
      { name: 'link.md', kind: 'symlink', sha: BLOB },
      { name: 'sub', kind: 'folder', sha: BLOB },
      { name: 'vendor', kind: 'submodule', sha: BLOB },
      { name: 'z.md', kind: 'file', sha: SHA_B },
    ]);
    for (const sha of [SHA_A, SDLC, MEMORY]) {
      const [request] = h.stub.requestsTo('GET', tree(sha));
      expect(request?.query.get('recursive')).toBeNull();
    }
  });

  it('returns [] when the folder is missing or is a file', async () => {
    h.stub.on('GET', tree(SHA_A), {
      body: { sha: SHA_A, truncated: false, tree: [item('.sdlc', '100644')] },
    });
    await expect(h.adapter().listFolder(REPO, SHA_A, '.sdlc/memory')).resolves.toEqual([]);
  });

  it('fails closed on a cut listing and on an unknown mode', async () => {
    repo([]);
    h.stub.on('GET', tree(MEMORY), { body: { sha: MEMORY, truncated: true, tree: [] } });
    await expect(h.adapter().listFolder(REPO, SHA_A, '.sdlc/memory')).rejects.toMatchObject({
      code: 'tree_truncated',
    });
    repo([{ path: 'x.md', mode: '100664', type: 'blob', sha: BLOB }]);
    await expect(h.adapter().listFolder(REPO, SHA_A, '.sdlc/memory')).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });

  it.each(['', '/x', 'a/../b', 'a//b', '.', 'a/'])(
    'refuses the folder %j without a call',
    async (folder) => {
      await expect(h.adapter().listFolder(REPO, SHA_A, folder)).rejects.toMatchObject({
        code: 'invalid_input',
      });
      expect(h.stub.requestsTo('GET', tree(SHA_A))).toHaveLength(0);
    },
  );
});

describe('listPathCommits', () => {
  const COMMITS = '/repos/acme/shop/commits';
  const commit = (sha: string, author: ReturnType<typeof user> | null) => ({
    sha,
    author,
    commit: { message: 'free text' },
  });
  const sha = (n: number) => n.toString(16).padStart(40, '0');

  it('lists the commits of the path from the head, newest first, with author IDs', async () => {
    h.stub.on('GET', COMMITS, {
      body: [
        commit(sha(3), user(3002, 'bob')),
        commit(sha(2), null),
        commit(sha(1), user(3001, 'alice')),
      ],
    });
    const result = await h.adapter().listPathCommits(REPO, SHA_A, '.sdlc/memory', { max: 100 });
    expect(result).toEqual({
      complete: true,
      commits: [
        { sha: sha(3), author: { id: '3002', login: 'bob', type: 'user' } },
        { sha: sha(2), author: null },
        { sha: sha(1), author: { id: '3001', login: 'alice', type: 'user' } },
      ],
    });
    const [request] = h.stub.requestsTo('GET', COMMITS);
    expect(request?.query.get('sha')).toBe(SHA_A);
    expect(request?.query.get('path')).toBe('.sdlc/memory');
    expect(request?.query.get('per_page')).toBe('100');
  });

  it('stops before stopAt', async () => {
    h.stub.on('GET', COMMITS, {
      body: [commit(sha(3), null), commit(sha(2), null), commit(sha(1), null)],
    });
    const result = await h
      .adapter()
      .listPathCommits(REPO, SHA_A, '.sdlc/memory', { stopAt: sha(2), max: 100 });
    expect(result).toEqual({ complete: true, commits: [{ sha: sha(3), author: null }] });
  });

  it('is not complete past max', async () => {
    h.stub.on('GET', COMMITS, (req) =>
      req.query.get('page') === '2'
        ? { body: [commit(sha(1), null)] }
        : {
            body: [commit(sha(3), null), commit(sha(2), null)],
            headers: {
              link: `<${h.stub.address}${COMMITS}?sha=${SHA_A}&path=.sdlc%2Fmemory&per_page=2&page=2>; rel="next"`,
            },
          },
    );
    const result = await h.adapter().listPathCommits(REPO, SHA_A, '.sdlc/memory', { max: 2 });
    expect(result.complete).toBe(false);
    expect(result.commits.map((c) => c.sha)).toEqual([sha(3), sha(2)]);
  });

  it('refuses a bad head, stopAt, max or path without a call', async () => {
    const a = h.adapter();
    await expect(a.listPathCommits(REPO, 'main', '.sdlc/memory', { max: 1 })).rejects.toMatchObject(
      { code: 'invalid_input' },
    );
    await expect(
      a.listPathCommits(REPO, SHA_A, '.sdlc/memory', { stopAt: 'x', max: 1 }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(a.listPathCommits(REPO, SHA_A, '.sdlc/memory', { max: 0 })).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(
      a.listPathCommits(REPO, SHA_A, '.sdlc/memory', { max: 101 }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(a.listPathCommits(REPO, SHA_A, '../x', { max: 1 })).rejects.toMatchObject({
      code: 'invalid_input',
    });
    expect(h.stub.requestsTo('GET', COMMITS)).toHaveLength(0);
  });
});
