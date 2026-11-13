// X13 PR 2 (ADR-M74 §2.6, §2.8, §5): the runner reads the memory notes at the run's base commit
// from its own clone with hardened git, computes the same set hash as the worker, checks it
// against the contract, cleans and caps the text, and records `memory_read` with codes and counts.
// Any failure gives a run without memory, never a failed run. A marker in a note never reaches the
// run event.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  MEMORY_DIR,
  memorySetOf,
  type FolderEntry,
  type ProjectConfig,
  type RunContract,
} from '@sdlc/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadMemory, renderMemory } from '../../apps/runner/src/agent/memory.js';
import {
  MEMORY_FILE_MAX_BYTES,
  memoryFilesReader,
  readMemoryFiles,
} from '../../apps/runner/src/workspace/memory-files.js';
import { memorySetSha256 } from '../../packages/core/src/memory/set.js';
import { CONTRACT } from '../agent/helpers';

type TenantScope = Parameters<typeof loadMemory>[0];

const MARKER = 'canary-memory-7f3a';
let root: string;
let withNotes: string;
let large: string;

function git(args: string[]): string {
  return execFileSync('git', ['-C', path.join(root, 'repo'), ...args], {
    env: {
      PATH: process.env.PATH,
      HOME: path.join(root, 'home'),
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

/** The worker's view of the folder at a commit: `git ls-tree` with modes, like `listFolder`. */
function workerHash(commit: string): string {
  const kinds: Record<string, FolderEntry['kind']> = {
    '100644': 'file',
    '100755': 'executable',
    '120000': 'symlink',
    '040000': 'folder',
  };
  const entries = git(['ls-tree', commit, '--', `${MEMORY_DIR}/`])
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [meta, p] = line.split('\t');
      const [mode, , sha] = meta!.split(' ');
      return { name: p!.slice(MEMORY_DIR.length + 1), kind: kinds[mode!]!, sha: sha! };
    });
  return memorySetSha256(memorySetOf(entries));
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-files-'));
  fs.mkdirSync(path.join(root, 'home'));
  const repo = path.join(root, 'repo');
  const dir = path.join(repo, MEMORY_DIR);
  fs.mkdirSync(path.join(dir, 'nested'), { recursive: true });
  git(['init', '-q']);
  fs.writeFileSync(path.join(dir, 'build.md'), `Run the API tests with pnpm test:api. ${MARKER}\n`);
  fs.writeFileSync(path.join(dir, 'api.md'), 'The api needs the db service.\r\n');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not memory');
  fs.writeFileSync(path.join(dir, 'agents.md'), 'an instruction file, never memory');
  fs.writeFileSync(path.join(dir, 'nested', 'deep.md'), 'not memory');
  fs.symlinkSync('../../README.md', path.join(dir, 'link.md'));
  fs.writeFileSync(path.join(repo, 'README.md'), 'readme');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'notes']);
  withNotes = git(['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(dir, 'huge.md'), 'a'.repeat(MEMORY_FILE_MAX_BYTES + 1));
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'huge']);
  large = git(['rev-parse', 'HEAD']);
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('readMemoryFiles', () => {
  it('reads the memory files only, sorted, with the same set hash as the worker', async () => {
    const read = await readMemoryFiles(root, withNotes, 20, 10_000);
    expect(read.kind).toBe('ok');
    if (read.kind !== 'ok') return;
    expect(read.files.map((f) => f.name)).toEqual(['api.md', 'build.md']);
    expect(read.setFiles).toBe(2);
    expect(read.setSha256).toBe(workerHash(withNotes));
    expect(read.files[1]?.bytes.toString()).toContain(MARKER);
  });

  it('reads at most maxFiles files, but hashes the whole set', async () => {
    const read = await memoryFilesReader(root, 10_000)(withNotes, 1);
    expect(read).toMatchObject({ kind: 'ok', setFiles: 2, setSha256: workerHash(withNotes) });
    if (read.kind === 'ok') expect(read.files.map((f) => f.name)).toEqual(['api.md']);
  });

  it('a file over the byte cap, a missing commit or a bad SHA: unreadable', async () => {
    await expect(readMemoryFiles(root, large, 20, 10_000)).resolves.toEqual({ kind: 'unreadable' });
    await expect(readMemoryFiles(root, 'e'.repeat(40), 20, 10_000)).resolves.toEqual({
      kind: 'unreadable',
    });
    await expect(readMemoryFiles(root, 'HEAD', 20, 10_000)).resolves.toEqual({
      kind: 'unreadable',
    });
  });
});

describe('renderMemory', () => {
  const limits = {
    mode: 'read',
    max_files: 20,
    max_file_chars: 500,
    max_total_chars: 1000,
  } as const;

  it('one "Memory file:" line per file, cleaned text, cut per file and in total', () => {
    const out = renderMemory(
      [
        { name: 'a.md', text: 'one​ two\r\n' },
        { name: 'b.md', text: 'x'.repeat(600) },
      ],
      limits,
    );
    expect(out.text.startsWith('Memory file: a.md\none  two\n\nMemory file: b.md\n')).toBe(true);
    expect(out.text).toContain('[The platform cut this note here.]');
    expect(out.truncated).toBe(true);
    const total = renderMemory(
      Array.from({ length: 5 }, (_, i) => ({ name: `${i}.md`, text: 'y'.repeat(400) })),
      limits,
    );
    expect(total.text.length).toBeLessThanOrEqual(1000);
    expect(total.text.endsWith('[The platform cut the notes here.]')).toBe(true);
  });
});

describe('loadMemory', () => {
  const events: { type: string; payload: Record<string, unknown> }[] = [];
  const scope = {
    runEvents: {
      append: (_runId: string, type: string, payload: Record<string, unknown>) => {
        events.push({ type, payload });
        return Promise.resolve();
      },
    },
  } as unknown as TenantScope;
  const LIMITS: ProjectConfig['memory'] = {
    mode: 'read',
    max_files: 20,
    max_file_chars: 4000,
    max_total_chars: 12000,
  };
  const contract = (memory: RunContract['memory'], base = withNotes): RunContract => ({
    ...CONTRACT,
    schema_version: 5,
    base_sha: base,
    tool_grants: [],
    repo_path: '',
    root_instructions_sha256: null,
    ...(memory === undefined ? {} : { memory }),
  });
  const reader = memoryFilesReader;
  const last = () => events.at(-1);

  it('reads an approved set whose hash holds; the event has the version, hash and counts', async () => {
    const set = workerHash(withNotes);
    const block = await loadMemory(
      scope,
      contract({ reason: 'approved', version: 4, set_sha256: set }),
      LIMITS,
      reader(root, 10_000),
    );
    expect(block?.files).toBe(2);
    expect(block?.text).toContain('Memory file: build.md');
    expect(block?.text).toContain(MARKER);
    expect(last()).toEqual({
      type: 'memory_read',
      payload: {
        reason: 'read',
        version: 4,
        set_sha256: set,
        files: 2,
        chars: block?.text.length,
        truncated: 'no',
      },
    });
    // Never stored: the marker, a name or a path.
    const dump = JSON.stringify(events);
    expect(dump).not.toContain(MARKER);
    expect(dump).not.toContain('build');
    expect(dump).not.toContain(MEMORY_DIR);
  });

  it('runs without memory on a hash mismatch, an unreadable clone or no clone', async () => {
    const approved = { reason: 'approved' as const, version: 1, set_sha256: 'f'.repeat(64) };
    await expect(
      loadMemory(scope, contract(approved), LIMITS, reader(root, 10_000)),
    ).resolves.toBeUndefined();
    expect(last()?.payload).toMatchObject({ reason: 'hash_mismatch', files: 0 });
    const big = { ...approved, set_sha256: workerHash(large) };
    await expect(
      loadMemory(scope, contract(big, large), LIMITS, reader(root, 10_000)),
    ).resolves.toBeUndefined();
    expect(last()?.payload).toMatchObject({ reason: 'unreadable' });
    await expect(loadMemory(scope, contract(approved), LIMITS, undefined)).resolves.toBeUndefined();
    expect(last()?.payload).toMatchObject({ reason: 'unreadable' });
  });

  it('records G4\'s reason when the set is not approved, and "off" when memory was turned off', async () => {
    for (const reason of ['none', 'unapproved', 'revoked', 'tree_truncated'] as const) {
      await loadMemory(
        scope,
        contract({ reason, version: null, set_sha256: null }),
        LIMITS,
        reader(root, 10_000),
      );
      expect(last()?.payload).toEqual({ reason, files: 0, chars: 0, truncated: 'no' });
    }
    const set = workerHash(withNotes);
    const block = await loadMemory(
      scope,
      contract({ reason: 'approved', version: 4, set_sha256: set }),
      { ...LIMITS, mode: 'off' },
      reader(root, 10_000),
    );
    expect(block).toBeUndefined();
    expect(last()?.payload).toEqual({ reason: 'off', files: 0, chars: 0, truncated: 'no' });
  });

  it('a contract without memory (schema 2–4) records nothing', async () => {
    const before = events.length;
    await expect(
      loadMemory(scope, CONTRACT, LIMITS, reader(root, 10_000)),
    ).resolves.toBeUndefined();
    expect(events.length).toBe(before);
  });

  it('marks the text cut when files are left out by max_files', async () => {
    const set = workerHash(withNotes);
    const block = await loadMemory(
      scope,
      contract({ reason: 'approved', version: 4, set_sha256: set }),
      { ...LIMITS, max_files: 1 },
      reader(root, 10_000),
    );
    expect(block).toMatchObject({ files: 1, truncated: true });
    expect(last()?.payload).toMatchObject({ reason: 'read', files: 1, truncated: 'yes' });
  });
});
