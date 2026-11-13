// The memory set and its hash (X13 PR 1, design/ADR-M74 §2.1, QUESTIONS #715): which folder
// entries are memory files, the canonical JSON (RFC 8785) and its SHA-256, and that the memory
// folder is never an agent instruction path (ADR-M74 §2.1, ADR-M34 §2.4).
import { createHash } from 'node:crypto';

import { canonicalJson } from '@sdlc/config';
import {
  isAgentInstructionPath,
  isMemoryFile,
  MEMORY_DIR,
  memorySetCanonicalJson,
  memorySetOf,
  type FolderEntry,
} from '@sdlc/contracts';
import { describe, expect, it } from 'vitest';

import { memorySetSha256, readMemorySet } from '../../packages/core/src/memory/set.js';

const SHA = (c: string) => c.repeat(40);
const entry = (name: string, kind: FolderEntry['kind'] = 'file', sha = SHA('a')): FolderEntry => ({
  name,
  kind,
  sha,
});

describe('memory files (ADR-M74 0.2 §2.1)', () => {
  it.each([
    ['build.md', 'file', true],
    ['run-tests.md', 'executable', true],
    ['a.md', 'file', true],
    [`${'a'.repeat(64)}.md`, 'file', true],
    [`${'a'.repeat(65)}.md`, 'file', false],
    ['Build.md', 'file', false],
    ['-x.md', 'file', false],
    ['notes.txt', 'file', false],
    ['notes.md.bak', 'file', false],
    ['.md', 'file', false],
    ['link.md', 'symlink', false],
    ['sub.md', 'folder', false],
    ['mod.md', 'submodule', false],
    // An agent instruction file in any folder (ADR-M34 §2.4): G4 would refuse it, never memory.
    ['agents.md', 'file', false],
  ] as const)('%s (%s) is memory: %s', (name, kind, expected) => {
    expect(isMemoryFile(entry(name, kind))).toBe(expected);
  });

  it('the set keeps memory files only, sorted by path, with their blob IDs', () => {
    const set = memorySetOf([
      entry('zeta.md', 'file', SHA('1')),
      entry('README.txt'),
      entry('alpha.md', 'executable', SHA('2')),
      entry('nested', 'folder'),
      entry('link.md', 'symlink'),
    ]);
    expect(set).toEqual([
      { path: `${MEMORY_DIR}/alpha.md`, blob: SHA('2') },
      { path: `${MEMORY_DIR}/zeta.md`, blob: SHA('1') },
    ]);
  });
});

describe('set_sha256', () => {
  const set = memorySetOf([entry('build.md', 'file', SHA('b')), entry('api.md', 'file', SHA('c'))]);

  it('is the SHA-256 of the RFC 8785 canonical JSON of the sorted list', () => {
    const canonical = memorySetCanonicalJson(set);
    expect(canonical).toBe(canonicalJson(set));
    expect(memorySetSha256(set)).toBe(createHash('sha256').update(canonical, 'utf8').digest('hex'));
  });

  it('changes when a file, a blob or a name changes; an empty set has its own hash', () => {
    const base = memorySetSha256(set);
    const otherBlob = memorySetOf([
      entry('build.md', 'file', SHA('d')),
      entry('api.md', 'file', SHA('c')),
    ]);
    const renamed = memorySetOf([
      entry('make.md', 'file', SHA('b')),
      entry('api.md', 'file', SHA('c')),
    ]);
    expect(memorySetSha256(otherBlob)).not.toBe(base);
    expect(memorySetSha256(renamed)).not.toBe(base);
    expect(memorySetSha256([])).toBe(createHash('sha256').update('[]').digest('hex'));
  });

  it('readMemorySet lists the memory folder only and keeps the hash and the count', async () => {
    const calls: string[] = [];
    const facts = await readMemorySet(
      {
        listFolder: (_ref, sha, folder) => {
          calls.push(`${sha}:${folder}`);
          return Promise.resolve([entry('build.md', 'file', SHA('b')), entry('x', 'folder')]);
        },
      },
      { owner: 'acme', name: 'shop' },
      SHA('e'),
    );
    expect(calls).toEqual([`${SHA('e')}:${MEMORY_DIR}`]);
    expect(facts).toEqual({
      setSha256: memorySetSha256(memorySetOf([entry('build.md', 'file', SHA('b'))])),
      files: 1,
    });
  });
});

describe('the memory folder is not an agent instruction path (ADR-M74 §2.1)', () => {
  it('no memory file is an instruction path, so memory never causes instructions_unpinned', () => {
    const names = ['build.md', 'run-tests.md', 'claude.md', 'gemini.md', 'agent.md', 'agents.md'];
    for (const set of [memorySetOf(names.map((name) => entry(name)))]) {
      expect(set.map((e) => e.path)).not.toContain(`${MEMORY_DIR}/agents.md`);
      for (const file of set) expect(isAgentInstructionPath(file.path), file.path).toBe(false);
    }
  });
});
