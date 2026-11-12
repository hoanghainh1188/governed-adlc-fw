// O06 (ADR-M106 §2.4): a project's folder in its repository; the same rule as the CHECK of
// migration 0049.
import { describe, expect, it } from 'vitest';

import {
  isInsideRepoPath,
  isRepoPath,
  MAX_REPO_PATH_LENGTH,
  repoPathsOverlap,
} from '../../packages/contracts/src/index.js';

describe('isRepoPath', () => {
  it.each(['', 'web', 'packages/web', 'a.b/c_d/e-f', 'x'.repeat(MAX_REPO_PATH_LENGTH)])(
    'accepts %j',
    (value) => expect(isRepoPath(value)).toBe(true),
  );

  it.each([
    '/web',
    'web/',
    'a//b',
    '.',
    '..',
    'a/./b',
    'a/../b',
    'a b',
    'a\\b',
    'x'.repeat(MAX_REPO_PATH_LENGTH + 1),
  ])('refuses %j', (value) => expect(isRepoPath(value)).toBe(false));
});

describe('isInsideRepoPath and repoPathsOverlap', () => {
  it('the empty folder holds every path; a folder only its own', () => {
    expect(isInsideRepoPath('src/a.ts', '')).toBe(true);
    expect(isInsideRepoPath('packages/web/src/a.ts', 'packages/web')).toBe(true);
    expect(isInsideRepoPath('packages/web2/a.ts', 'packages/web')).toBe(false);
    expect(isInsideRepoPath('packages/web', 'packages/web')).toBe(false);
  });

  it.each([
    ['', 'a', true],
    ['a', 'a', true],
    ['a', 'a/b', true],
    ['a/b', 'a', true],
    ['a', 'ab', false],
    ['a/b', 'a/c', false],
  ])('%j and %j overlap: %s', (a, b, expected) => {
    expect(repoPathsOverlap(a, b)).toBe(expected);
    expect(repoPathsOverlap(b, a)).toBe(expected);
  });
});
