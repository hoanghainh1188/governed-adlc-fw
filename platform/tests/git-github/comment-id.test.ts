// `commentIdOf` of the GitHub adapter (X08b PR 2, design/ADR-M109 §2.3, D-03 §7.1 version 1.58,
// QUESTIONS #729): the numeric comment ID of a web address of a comment of the project's
// repository, on an issue or a pull request; null for any other address. No call to GitHub.
import { GitHubAdapter } from '@sdlc/adapter-git-github';
import { describe, expect, it } from 'vitest';

const secrets = { read: () => Promise.reject(new Error('no secret needed')) };
const REPO = { owner: 'acme', name: 'shop' };

describe('commentIdOf (X08b)', () => {
  const github = new GitHubAdapter({ secrets });

  it('reads the ID of a comment of an issue or a pull request', () => {
    expect(
      github.commentIdOf(REPO, 'https://github.com/acme/shop/issues/42#issuecomment-123'),
    ).toBe('123');
    expect(github.commentIdOf(REPO, 'https://github.com/acme/shop/pull/7#issuecomment-99')).toBe(
      '99',
    );
  });

  it('refuses another repository, another host, or something that is not a comment', () => {
    for (const url of [
      'https://github.com/acme/other/issues/42#issuecomment-123',
      'https://github.com/evil/shop/issues/42#issuecomment-123',
      'https://git.example.com/acme/shop/issues/42#issuecomment-123',
      'http://github.com/acme/shop/issues/42#issuecomment-123',
      'https://github.com/acme/shop/issues/42',
      'https://github.com/acme/shop/issues/42#issuecomment-',
      'https://github.com/acme/shop/issues/42#issuecomment-0123',
      'https://github.com/acme/shop/issues/0#issuecomment-1',
      'https://github.com/acme/shop/issues/42#issuecomment-1?x=y',
      'https://github.com/acme/shop/discussions/42#discussioncomment-1',
      'https://github.com/acme/shop/issues/42/../43#issuecomment-1',
    ]) {
      expect(github.commentIdOf(REPO, url), url).toBeNull();
    }
  });

  it('uses the GitHub Enterprise Server host for another API', () => {
    const ghes = new GitHubAdapter({ secrets, apiUrl: 'https://git.example.com/api/v3' });
    expect(
      ghes.commentIdOf(REPO, 'https://git.example.com/acme/shop/issues/3#issuecomment-5'),
    ).toBe('5');
    expect(
      ghes.commentIdOf(REPO, 'https://github.com/acme/shop/issues/3#issuecomment-5'),
    ).toBeNull();
  });
});
