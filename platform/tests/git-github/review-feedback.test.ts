// D-08 E01 AC4, design/ADR-M41 §2.7, D-03 §7.1: the runner reads the feedback of a request for
// changes with its own token (no App key): one review by its ID with its line comments, or one
// comment by its ID. Against the in-process GitHub stub.
import { Redacted } from '@sdlc/secrets';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MAX_REVIEW_FEEDBACK_COMMENTS } from '../../packages/adapters/git-github/src/adapter.js';
import { startHarness, type Harness } from './helpers';
import { REPO } from './stub-github';

let h: Harness;

beforeEach(async () => {
  h = await startHarness();
});

afterEach(async () => {
  await h.stub.stop();
});

const SHA = 'e'.repeat(40);
const USER = { id: 3002, login: 'bob', type: 'User' };

function issued(): string {
  return (h.stub.issueToken({}).body as { token: string }).token;
}

describe('getReviewFeedback (E01 PR 2)', () => {
  it('reads one review by its ID and its line comments, with the caller token only', async () => {
    const token = issued();
    h.stub.on('GET', '/repos/acme/shop/pulls/7/reviews/55', {
      status: 200,
      body: { id: 55, user: USER, state: 'CHANGES_REQUESTED', commit_id: SHA, body: 'Fix it.' },
    });
    h.stub.on('GET', '/repos/acme/shop/pulls/7/reviews/55/comments', {
      status: 200,
      body: [
        { path: 'a.ts', line: 3, body: 'here' },
        { path: 'b.ts', line: null, original_line: null, body: null },
      ],
    });
    const feedback = await h.adapter().getReviewFeedback(new Redacted(token), REPO, 7, '55');
    expect(feedback).toEqual({
      reviewId: '55',
      reviewer: { id: '3002', login: 'bob', type: 'user' },
      state: 'changes_requested',
      commitSha: SHA,
      body: 'Fix it.',
      comments: [
        { path: 'a.ts', line: 3, body: 'here' },
        { path: 'b.ts', line: null, body: '' },
      ],
      commentsTruncated: false,
    });
    for (const request of h.stub.requests) {
      expect(request.headers.authorization).toBe(`Bearer ${token}`);
    }
    expect(h.secrets.reads).toBe(0); // no App key
    const [list] = h.stub.requestsTo('GET', '/repos/acme/shop/pulls/7/reviews/55/comments');
    expect(list?.query.get('per_page')).toBe(String(MAX_REVIEW_FEEDBACK_COMMENTS));
  });

  it('refuses an answer for another review, and bad IDs before any call', async () => {
    const token = new Redacted(issued());
    h.stub.on('GET', '/repos/acme/shop/pulls/7/reviews/55', {
      status: 200,
      body: { id: 56, user: USER, state: 'CHANGES_REQUESTED', commit_id: SHA, body: '' },
    });
    await expect(h.adapter().getReviewFeedback(token, REPO, 7, '55')).rejects.toMatchObject({
      code: 'invalid_response',
    });
    const before = h.stub.requests.length;
    for (const bad of ['', '0', '01', '5/../6', 'abc']) {
      await expect(h.adapter().getReviewFeedback(token, REPO, 7, bad)).rejects.toMatchObject({
        code: 'invalid_input',
      });
    }
    await expect(
      h.adapter().getReviewFeedback(new Redacted(''), REPO, 7, '55'),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    expect(h.stub.requests.length).toBe(before);
  });

  it('a missing review is `not_found`, never a partial answer', async () => {
    await expect(
      h.adapter().getReviewFeedback(new Redacted(issued()), REPO, 7, '99'),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('getIssueComment (E01 PR 2)', () => {
  it('reads one comment by its ID with the caller token', async () => {
    const token = issued();
    h.stub.on('GET', '/repos/acme/shop/issues/comments/901', {
      status: 200,
      body: { id: 901, user: USER, body: '/request-changes G7 fix the totals' },
    });
    expect(await h.adapter().getIssueComment(new Redacted(token), REPO, '901')).toEqual({
      commentId: '901',
      issueNumber: null,
      author: { id: '3002', login: 'bob', type: 'user' },
      body: '/request-changes G7 fix the totals',
    });
    const [request] = h.stub.requestsTo('GET', '/repos/acme/shop/issues/comments/901');
    expect(request?.headers.authorization).toBe(`Bearer ${token}`);
    expect(h.secrets.reads).toBe(0);
  });

  it('X08b: names the issue or pull request of the comment from its issue_url', async () => {
    h.stub.on('GET', '/repos/acme/shop/issues/comments/902', {
      status: 200,
      body: {
        id: 902,
        user: USER,
        body: 'words',
        issue_url: 'https://api.github.com/repos/acme/shop/issues/42',
      },
    });
    const comment = await h.adapter().getIssueComment(new Redacted(issued()), REPO, '902');
    expect(comment.issueNumber).toBe(42);
  });
});
