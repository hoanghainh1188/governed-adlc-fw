// `deleteBranch` of the GitHub adapter (X13 PR 3b, design/ADR-M74 0.5 §2.5 step 5, D-03 §7.1):
// only a memory branch (`agent/INT-…-memory-<attempt>`), only when it still points to the pushed
// commit, with a `contents: write` token for this call only, revoked right after.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startHarness, type Harness } from './helpers';
import { REPO, SHA_A, SHA_B } from './stub-github';

let h: Harness;

beforeEach(async () => {
  h = await startHarness();
});

afterEach(async () => {
  await h.stub.stop();
});

const BRANCH = 'agent/INT-2026-0001-memory-2';
const REF = `/repos/acme/shop/git/ref/heads/${BRANCH}`;
const REFS = `/repos/acme/shop/git/refs/heads/${BRANCH}`;
const head = (sha: string) => ({
  body: { ref: `refs/heads/${BRANCH}`, object: { type: 'commit', sha } },
});

describe('deleteBranch (X13 PR 3b)', () => {
  it('deletes a memory branch at the expected commit with a write token, then revokes it', async () => {
    h.stub.on('GET', REF, head(SHA_A));
    h.stub.on('DELETE', REFS, { status: 204 });
    h.stub.on('DELETE', '/installation/token', { status: 204 });
    await expect(h.adapter().deleteBranch(REPO, BRANCH, SHA_A)).resolves.toBe('deleted');
    const [deletion] = h.stub.requestsTo('DELETE', REFS);
    const token = h.stub.issuedTokens.at(-1)!;
    expect(token.body.permissions).toEqual({ contents: 'write' });
    expect(deletion?.headers.authorization).toBe(`Bearer ${token.token}`);
    expect(h.stub.requestsTo('DELETE', '/installation/token')[0]?.headers.authorization).toBe(
      `Bearer ${token.token}`,
    );
  });

  it('a branch at another commit is left as it is (moved); a missing one is absent', async () => {
    h.stub.on('GET', REF, head(SHA_B));
    await expect(h.adapter().deleteBranch(REPO, BRANCH, SHA_A)).resolves.toBe('moved');
    expect(h.stub.requestsTo('DELETE', REFS)).toEqual([]);
    h.stub.on('GET', REF, { status: 404, body: { message: 'Not Found' } });
    await expect(h.adapter().deleteBranch(REPO, BRANCH, SHA_A)).resolves.toBe('absent');
  });

  it('never deletes another branch: the code branch, main or a bad name', async () => {
    for (const branch of ['agent/INT-2026-0001', 'main', 'agent/INT-2026-0001-memory-0', '../x']) {
      await expect(h.adapter().deleteBranch(REPO, branch, SHA_A)).rejects.toMatchObject({
        code: 'invalid_input',
      });
    }
    await expect(h.adapter().deleteBranch(REPO, BRANCH, 'not-a-sha')).rejects.toMatchObject({
      code: 'invalid_input',
    });
    expect(h.stub.requests.filter((r) => r.method === 'DELETE')).toEqual([]);
  });
});
