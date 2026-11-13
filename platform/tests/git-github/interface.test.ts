// D-08 B05 AC4: the adapter implements `GitHostAdapter` exactly as D-03 section 7.1 defines it.
// The type check is at compile time (`pnpm typecheck`); this test compares the method names and
// parameter counts of the design doc, the contracts interface and the class.
import fs from 'node:fs';
import path from 'node:path';

import { GitHubAdapter } from '@sdlc/adapter-git-github';
import { GIT_HOST_ERROR_CODES, GitHostError, type GitHostAdapter } from '@sdlc/contracts';
import { describe, expect, it } from 'vitest';

import { gitHostErrorMessage } from '../../packages/core/src/git-host/errors.js';
import { repoRoot } from '../workspace/helpers';
import { FakeSecrets } from './stub-github';

// Compile-time check: the class is assignable to the interface.
const implemented: GitHostAdapter = new GitHubAdapter({ secrets: new FakeSecrets() });

/** Parameters in a list, ignoring commas inside `<…>` and `{…}` types. */
function countParams(list: string): number {
  let depth = 0;
  let count = list.trim() === '' ? 0 : 1;
  for (const ch of list.replace(/,\s*$/, '')) {
    if (ch === '<' || ch === '{') depth += 1;
    else if (ch === '>' || ch === '}') depth -= 1;
    else if (ch === ',' && depth === 0) count += 1;
  }
  return count;
}

/** `name(params)` pairs of the `interface GitHostAdapter { … }` block in a TypeScript text. */
function methods(text: string): Map<string, number> {
  const block = /interface GitHostAdapter \{([\s\S]*?)\n\}/.exec(text)?.[1] ?? '';
  const found = new Map<string, number>();
  for (const m of block.matchAll(/^\s+([a-zA-Z]+)\(([^)]*)\)/gm)) {
    found.set(m[1]!, countParams(m[2]!));
  }
  return found;
}

const root = repoRoot();
const design = methods(fs.readFileSync(path.join(root, 'design/D-03-mvp-architecture.md'), 'utf8'));
const contract = methods(
  fs.readFileSync(path.join(root, 'platform/packages/contracts/src/git-host.ts'), 'utf8'),
);

describe('GitHostAdapter matches D-03 section 7.1 (AC4)', () => {
  it('the design doc lists the twenty-five methods', () => {
    expect([...design.keys()]).toEqual([
      'createIssueComment',
      'getPullRequest',
      'getChangedFiles',
      'getCheckStatus',
      'getApprovals',
      'getReviews',
      'getCommitAuthors',
      'getMergedChange',
      'getCommitParents',
      'compareChangedFiles',
      'getFileAtCommit',
      'getBranchHead',
      'listPaths',
      'listFolder',
      'listPathCommits',
      'issueShortLivedToken',
      'revokeShortLivedToken',
      'openPullRequest',
      'findOpenPullRequest',
      'getSecurityFindings',
      'getReviewFeedback',
      'getIssueComment',
      'listEventsSince',
      'oldestEventCursor',
      'verifyWebhook',
    ]);
  });

  it('the contracts interface has the same methods and parameters', () => {
    expect(contract).toEqual(design);
  });

  it('the GitHub adapter implements exactly these public methods', () => {
    const own = Object.getOwnPropertyNames(GitHubAdapter.prototype).filter(
      (name) => name !== 'constructor',
    );
    expect(own.sort()).toEqual([...design.keys()].sort());
    for (const [name, count] of design) {
      const fn = (implemented as unknown as Record<string, (...args: unknown[]) => unknown>)[name];
      expect(fn?.length, name).toBe(count);
    }
  });
});

describe('Git host errors have catalog texts (NFR-08)', () => {
  it.each(GIT_HOST_ERROR_CODES)('%s renders without a placeholder left', (code) => {
    const text = gitHostErrorMessage(
      new GitHostError(code, {
        retry_at: '2026-09-26T08:00:00.000Z',
        max_chars: 1,
        max_bytes: 1,
        max_files: 1,
      }),
    );
    expect(text).not.toMatch(/\{[a-z_]+\}/);
    expect(text.length).toBeGreaterThan(10);
  });
});
