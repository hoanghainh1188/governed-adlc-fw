// X13 PR 3a (ADR-M74 §2.5 step 2, §5 "Caps" and "Separate pull request"): after a run, the runner
// splits the memory part out of the staged change in its own clone. Valid memory files (added,
// changed, removed) leave the index, so the code diff never holds them; anything else under
// `.sdlc/memory/` stays in the change, where G5 fails it `out_of_scope`. The proposed set's hash
// is the one the worker would compute from the Git host's listing.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MEMORY_DIR, memorySetOf, type FolderEntry } from '@sdlc/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { splitMemory } from '../../apps/runner/src/workspace/memory-split.js';
import { computeProposal, diffIndex } from '../../apps/runner/src/workspace/proposal.js';
import { memorySetSha256 } from '../../packages/core/src/memory/set.js';

const OPTIONS = { timeoutMs: 10_000, maxPatchBytes: 10 * 1024 * 1024 };
const LIMITS = { max_files: 20, max_file_chars: 500 };
let root: string;
let repo: string;
let home: string;
let base: string;

function git(...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    env: {
      PATH: process.env.PATH,
      HOME: home,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.invalid',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.invalid',
    },
  })
    .toString()
    .trim();
}

const memory = (name: string) => path.join(repo, MEMORY_DIR, name);
const write = (rel: string, content: string | Buffer) => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), content);
};

/** The set hash the worker computes from the Git host's listing of a tree. */
function setHashOf(tree: string): string {
  const kinds: Record<string, FolderEntry['kind']> = {
    '100644': 'file',
    '100755': 'executable',
    '120000': 'symlink',
    '040000': 'folder',
  };
  const entries = git('ls-tree', tree, '--', `${MEMORY_DIR}/`)
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [meta, p] = line.split('\t');
      const [mode, , sha] = meta!.split(' ');
      return { name: p!.slice(MEMORY_DIR.length + 1), kind: kinds[mode!]!, sha: sha! };
    });
  return memorySetSha256(memorySetOf(entries));
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-split-'));
  repo = path.join(root, 'repo');
  home = path.join(root, 'home');
  fs.mkdirSync(repo);
  fs.mkdirSync(home);
  git('init', '-q');
  write('src/a.ts', 'a\n');
  write(`${MEMORY_DIR}/build.md`, 'Run pnpm test.\n');
  write(`${MEMORY_DIR}/old.md`, 'old note\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  base = git('rev-parse', 'HEAD');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

async function stageAndSplit(limits = LIMITS) {
  const whole = await computeProposal(repo, home, base, OPTIONS);
  const split = await splitMemory(repo, home, base, whole.changedFiles, limits, OPTIONS);
  const code = await diffIndex(repo, home, base, OPTIONS);
  return { whole, split, code };
}

describe('splitMemory', () => {
  it('takes added, changed and removed notes out of the change; the code part stays', async () => {
    write('src/a.ts', 'a2\n');
    write(`${MEMORY_DIR}/api.md`, 'The api needs the db service.\n');
    fs.writeFileSync(memory('build.md'), 'Run pnpm test:api.\n');
    fs.rmSync(memory('old.md'));
    const { split, code } = await stageAndSplit();
    expect(split).toMatchObject({ added: 1, changed: 1, removed: 1, kept: 0 });
    expect(split?.paths).toEqual([
      `${MEMORY_DIR}/api.md`,
      `${MEMORY_DIR}/build.md`,
      `${MEMORY_DIR}/old.md`,
    ]);
    // The code diff and its paths hold no memory path.
    expect(code.changedFiles).toEqual(['src/a.ts']);
    expect(code.patch.toString()).not.toContain(MEMORY_DIR);
    // The memory patch holds the memory paths only.
    expect(split?.patch.toString()).toContain('Run pnpm test:api.');
    expect(split?.patch.toString()).not.toContain('src/a.ts');
    // The proposed set's hash: what the worker computes from the tree with the memory applied.
    git('add', '-A');
    git('reset', '-q', base, '--', 'src/a.ts');
    expect(split?.setSha256).toBe(setHashOf(git('write-tree')));
  });

  it('leaves anything that is not a valid note in the change (G5: out_of_scope)', async () => {
    write(`${MEMORY_DIR}/nested/deep.md`, 'x\n');
    write(`${MEMORY_DIR}/notes.txt`, 'x\n');
    write(`${MEMORY_DIR}/agents.md`, 'an instruction file\n');
    write(`${MEMORY_DIR}/Bad_Name.md`, 'x\n');
    write(`${MEMORY_DIR}/big.md`, 'y'.repeat(501));
    write(`${MEMORY_DIR}/latin1.md`, Buffer.from([0x63, 0x61, 0x66, 0xe9]));
    fs.symlinkSync('../../src/a.ts', memory('link.md'));
    write(`${MEMORY_DIR}/fine.md`, 'A fine note.\n');
    const { split, code } = await stageAndSplit();
    expect(split?.paths).toEqual([`${MEMORY_DIR}/fine.md`]);
    expect(split?.kept).toBe(7);
    expect(code.changedFiles.filter((p) => p.startsWith(MEMORY_DIR)).length).toBe(7);
  });

  it('new notes past max_files all stay in the change; changes still split', async () => {
    write(`${MEMORY_DIR}/one.md`, '1\n');
    write(`${MEMORY_DIR}/two.md`, '2\n');
    fs.writeFileSync(memory('build.md'), 'changed\n');
    const { split, code } = await stageAndSplit({ ...LIMITS, max_files: 3 });
    expect(split).toMatchObject({ added: 0, changed: 1, kept: 2 });
    expect(code.changedFiles).toEqual([`${MEMORY_DIR}/one.md`, `${MEMORY_DIR}/two.md`]);
  });

  it('no memory path: null, and the index is untouched', async () => {
    write('src/a.ts', 'a3\n');
    const { whole, split, code } = await stageAndSplit();
    expect(split).toBeNull();
    expect(code.patch.equals(whole.patch)).toBe(true);
  });

  it('a symbolic link at base replaced by a file stays in the change (fail closed)', async () => {
    fs.symlinkSync('build.md', memory('alias.md'));
    git('add', '-A');
    git('commit', '-q', '-m', 'link');
    base = git('rev-parse', 'HEAD');
    fs.rmSync(memory('alias.md'));
    write(`${MEMORY_DIR}/alias.md`, 'now a file\n');
    const { split, code } = await stageAndSplit();
    expect(split).toBeNull();
    expect(code.changedFiles).toEqual([`${MEMORY_DIR}/alias.md`]);
  });
});
