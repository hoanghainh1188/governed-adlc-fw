// `webUrl` of the GitHub adapter (X08a, design/ADR-M109 0.2 §2.1, D-03 §7.1): the web address of
// an issue, a pull request or a file at a commit, for the `links` of an intent. No call to GitHub.
import { GitHubAdapter } from '@sdlc/adapter-git-github';
import { describe, expect, it } from 'vitest';

const secrets = { read: () => Promise.reject(new Error('no secret needed')) };
const REPO = { owner: 'acme', name: 'shop' };
const SHA = 'c'.repeat(40);

describe('webUrl (X08a)', () => {
  it('names github.com for the public API', () => {
    const github = new GitHubAdapter({ secrets });
    expect(github.webUrl(REPO, { kind: 'issue', number: 12 })).toBe(
      'https://github.com/acme/shop/issues/12',
    );
    expect(github.webUrl(REPO, { kind: 'pull_request', number: 7 })).toBe(
      'https://github.com/acme/shop/pull/7',
    );
    expect(github.webUrl(REPO, { kind: 'file', path: 'docs/specs/t 07.md', commitSha: SHA })).toBe(
      `https://github.com/acme/shop/blob/${SHA}/docs/specs/t%2007.md`,
    );
  });

  it('names the GitHub Enterprise Server host for another API', () => {
    const ghes = new GitHubAdapter({ secrets, apiUrl: 'https://git.example.com/api/v3' });
    expect(ghes.webUrl(REPO, { kind: 'issue', number: 3 })).toBe(
      'https://git.example.com/acme/shop/issues/3',
    );
  });

  it('refuses a number, a commit or a path it cannot name', () => {
    const github = new GitHubAdapter({ secrets });
    for (const target of [
      { kind: 'issue', number: 0 },
      { kind: 'pull_request', number: 1.5 },
      { kind: 'file', path: 'a.md', commitSha: 'main' },
      { kind: 'file', path: '../etc/passwd', commitSha: SHA },
      { kind: 'file', path: '', commitSha: SHA },
    ] as const) {
      expect(() => github.webUrl(REPO, target)).toThrow(/invalid_input/);
    }
    expect(() => github.webUrl({ owner: '..', name: 'x' }, { kind: 'issue', number: 1 })).toThrow();
  });
});
