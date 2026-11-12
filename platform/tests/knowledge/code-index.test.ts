// X06 PR 1 (design/ADR-M108 §2.3, §2.6): the code index, without a database.
// - `isSkippedPath`, `resolveImport`: installed and built folders are skipped; relative imports of
//   scripts and Python find their file of the same index, never outside the repository.
// - `buildCodeIndex` with fakes and the real Tree-sitter extractor: a new index (files, symbols,
//   resolved imports, kind `code`, no model), the reuse of a ready index, every limit (never a
//   partial index), one large or slow file left out and counted, a truncated tree, an unreadable
//   file, the race with another run of the same commit, an index purged meanwhile.
// The tables and the store: tests/integration/db/knowledge-index.test.ts and
// tests/integration/knowledge/code-store.test.ts.
import { TreeSitterExtractor } from '@sdlc/adapter-code-treesitter';
import {
  CODE_INDEX_FORMAT,
  GitHostError,
  KnowledgeError,
  type CodeIndexInput,
  type CodeIndexStore,
  type CodeLanguage,
  type CodeSymbolExtractor,
  type ProjectConfig,
} from '@sdlc/contracts';
import { describe, expect, it } from 'vitest';

import { DbError } from '../../packages/core/src/db/errors.js';
import type { TenantScope } from '../../packages/core/src/db/tenant-scope.js';
import {
  buildCodeIndex,
  type BuildCodeIndexInput,
} from '../../packages/core/src/knowledge/code-indexer.js';
import { isSkippedPath, resolveImport } from '../../packages/core/src/knowledge/code-paths.js';

const PROJECT = '22222222-2222-4222-8222-222222222222';
const SHA = 'a'.repeat(40);
const LIMITS: ProjectConfig['code_index'] = {
  max_files: 10,
  max_file_bytes: 2_000,
  max_total_bytes: 5_000,
  max_symbols: 50,
  parse_timeout_ms: 2_000,
};

describe('X06: which files and which imports (ADR-M108 §2.3, §2.6)', () => {
  it('skips installed and built folders and minified bundles', () => {
    for (const path of [
      'node_modules/x/index.js',
      'web/node_modules/y.ts',
      'vendor/a.go',
      'dist/main.js',
      'app/build/x.py',
      'target/A.java',
      'pkg/__pycache__/m.py',
      'public/app.min.js',
    ]) {
      expect(isSkippedPath(path), path).toBe(true);
    }
    for (const path of ['src/build.ts', 'dist.ts', 'src/vendors/a.ts', 'lib/app.js']) {
      expect(isSkippedPath(path), path).toBe(false);
    }
  });

  const files = new Set([
    'src/a.ts',
    'src/b.ts',
    'src/util/index.ts',
    'src/view.vue',
    'src/legacy.js',
    'app/__init__.py',
    'app/models.py',
    'app/sub/views.py',
  ]);
  const resolve = (from: string, language: CodeLanguage, module: string) =>
    resolveImport(from, language, module, files);

  it('resolves relative script imports, `.js` to `.ts`, folders to their index', () => {
    expect(resolve('src/a.ts', 'typescript', './b')).toBe('src/b.ts');
    expect(resolve('src/a.ts', 'typescript', './b.js')).toBe('src/b.ts');
    expect(resolve('src/a.ts', 'typescript', './util')).toBe('src/util/index.ts');
    expect(resolve('src/util/index.ts', 'typescript', '../a')).toBe('src/a.ts');
    expect(resolve('src/a.ts', 'vue', './view.vue')).toBe('src/view.vue');
    expect(resolve('src/a.ts', 'javascript', './legacy')).toBe('src/legacy.js');
  });

  it('never resolves a package, a missing file, the file itself or a path outside', () => {
    expect(resolve('src/a.ts', 'typescript', 'react')).toBeNull();
    expect(resolve('src/a.ts', 'typescript', '@scope/x')).toBeNull();
    expect(resolve('src/a.ts', 'typescript', './missing')).toBeNull();
    expect(resolve('src/a.ts', 'typescript', './a')).toBeNull();
    expect(resolve('src/a.ts', 'typescript', '../../../etc/passwd')).toBeNull();
    expect(resolve('src/Main.java', 'java', 'src.a')).toBeNull();
    expect(resolve('main.go', 'go', './src')).toBeNull();
  });

  it('resolves relative Python imports', () => {
    expect(resolve('app/sub/views.py', 'python', '..models')).toBe('app/models.py');
    expect(resolve('app/models.py', 'python', '.')).toBe('app/__init__.py');
    expect(resolve('app/models.py', 'python', 'os')).toBeNull();
    expect(resolve('app/models.py', 'python', '....x')).toBeNull();
  });

  it('`from . import x` names the package, never a sibling module; `.` in scripts is the index', () => {
    const tree = new Set([
      'pkg.py',
      'pkg/__init__.py',
      'pkg/a.py',
      '__init__.py',
      'm.py',
      'index.ts',
    ]);
    expect(resolveImport('pkg/a.py', 'python', '.', tree)).toBe('pkg/__init__.py');
    expect(resolveImport('m.py', 'python', '.', tree)).toBe('__init__.py');
    expect(resolveImport('src/x.ts', 'typescript', '..', tree)).toBe('index.ts');
    expect(resolveImport('src/util/index.ts', 'typescript', '.', files)).toBeNull();
    expect(resolveImport('src/b.ts', 'typescript', './util', files)).toBe('src/util/index.ts');
    expect(isSkippedPath('src/a\u0000.ts')).toBe(true);
  });
});

interface Row {
  id: string;
  documents: number;
  chunks: number;
  purged: boolean;
}

/** A fake `knowledgeIndexes` repository and code store, enough for `buildCodeIndex`. */
function fakes(
  files: Record<string, string>,
  options: { paths?: () => string[]; extractor?: CodeSymbolExtractor } = {},
) {
  const rowsById = new Map<string, Row>();
  const created: Record<string, unknown>[] = [];
  const finds: unknown[][] = [];
  const uses: { indexId: string; runId: string }[] = [];
  const versions: CodeIndexInput[] = [];
  const deleted: string[] = [];
  let conflictWith: Row | undefined;
  const repo = {
    findReady: (...args: unknown[]) => {
      finds.push(args);
      return Promise.resolve([...rowsById.values()].find((r) => !r.purged));
    },
    create: (input: { id: string; documents: number; chunks: number }) => {
      created.push(input);
      if (conflictWith) {
        rowsById.set(conflictWith.id, conflictWith);
        conflictWith = undefined;
        return Promise.reject(new DbError('conflict', 'duplicate'));
      }
      const row = { id: input.id, documents: input.documents, chunks: input.chunks, purged: false };
      rowsById.set(row.id, row);
      return Promise.resolve(row);
    },
    recordUse: (input: { indexId: string; runId: string }) => {
      if (rowsById.get(input.indexId)?.purged !== false) return Promise.resolve(false);
      uses.push({ indexId: input.indexId, runId: input.runId });
      return Promise.resolve(true);
    },
  };
  const scope = { tenantId: '11111111-1111-4111-8111-111111111111', knowledgeIndexes: repo };
  const store: CodeIndexStore = {
    ensureProject: () => Promise.resolve(),
    putIndexVersion: (input) => {
      versions.push(input);
      return Promise.resolve();
    },
    deleteIndexVersion: (_p, id) => {
      deleted.push(id);
      return Promise.resolve({ chunks: 0 });
    },
    listIndexVersions: () => Promise.resolve([]),
    deleteOrphanChunks: () => Promise.resolve(0),
    dropProject: () => Promise.resolve(),
    close: () => Promise.resolve(),
  };
  const deps = {
    gitHost: {
      listPaths: () => Promise.resolve(options.paths ? options.paths() : Object.keys(files)),
      getFileAtCommit: (_ref: unknown, path: string) =>
        path in files
          ? Promise.resolve(files[path]!)
          : Promise.reject(new GitHostError('not_found')),
    },
    store,
    extractor: options.extractor ?? new TreeSitterExtractor(),
  };
  return {
    scope: scope as unknown as TenantScope,
    deps,
    rowsById,
    created,
    finds,
    uses,
    versions,
    deleted,
    conflictNext: (row: Row) => {
      conflictWith = row;
    },
  };
}

const input = (overrides: Partial<BuildCodeIndexInput> = {}): BuildCodeIndexInput => ({
  ref: { owner: 'o', name: 'r' },
  projectId: PROJECT,
  baseSha: SHA,
  runId: '33333333-3333-4333-8333-333333333333',
  intentId: '44444444-4444-4444-8444-444444444444',
  limits: LIMITS,
  now: new Date('2026-11-12T10:00:00Z'),
  ...overrides,
});

const SOURCES = {
  'src/a.ts': "import { b } from './b.js';\nexport function a() { return b(); }",
  'src/b.ts': 'export function b() { return 1; }',
  'README.md': '# not code',
  'node_modules/x/index.js': 'function skipped() {}',
};

describe('X06: buildCodeIndex (ADR-M108 §2.6)', () => {
  it('builds a code index: files, symbols, resolved imports, kind `code`, the format as model', async () => {
    const f = fakes(SOURCES);
    const built = await buildCodeIndex(f.scope, f.deps, input());
    expect(built).toMatchObject({ reused: false, files: 2, skipped: 0 });
    expect(built.symbols).toBe(3);
    expect(f.versions).toHaveLength(1);
    const version = f.versions[0]!;
    expect(version).toMatchObject({ projectId: PROJECT, baseSha: SHA, format: CODE_INDEX_FORMAT });
    expect(version.files.map((file) => file.path)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(version.files[0]!.imports).toEqual([{ module: './b.js', targetPath: 'src/b.ts' }]);
    expect(version.files[0]!.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(f.created).toEqual([
      expect.objectContaining({
        id: built.indexId,
        model: CODE_INDEX_FORMAT,
        kind: 'code',
        documents: 2,
        chunks: 3,
      }),
    ]);
    expect(f.finds[0]).toEqual([PROJECT, SHA, CODE_INDEX_FORMAT, 'code']);
    expect(f.uses).toEqual([{ indexId: built.indexId, runId: input().runId }]);
  });

  it('reuses a ready index of the same commit and records the use', async () => {
    const f = fakes(SOURCES);
    f.rowsById.set('ready', { id: 'ready', documents: 7, chunks: 70, purged: false });
    expect(await buildCodeIndex(f.scope, f.deps, input())).toEqual({
      indexId: 'ready',
      reused: true,
      files: 7,
      symbols: 70,
      skipped: 0,
    });
    expect(f.versions).toHaveLength(0);
    expect(f.uses).toEqual([{ indexId: 'ready', runId: input().runId }]);
  });

  it('builds again when the ready index was purged meanwhile', async () => {
    const f = fakes(SOURCES);
    f.rowsById.set('gone', { id: 'gone', documents: 1, chunks: 1, purged: false });
    const repo = (f.scope as unknown as { knowledgeIndexes: { recordUse: unknown } })
      .knowledgeIndexes;
    const original = repo.recordUse as (i: { indexId: string }) => Promise<boolean>;
    repo.recordUse = (i: { indexId: string; runId: string }) =>
      i.indexId === 'gone' ? Promise.resolve(false) : original(i);
    const built = await buildCodeIndex(f.scope, f.deps, input());
    expect(built.reused).toBe(false);
    expect(f.versions).toHaveLength(1);
  });

  it.each([
    ['too_many_files', { max_files: 1 }],
    ['too_many_bytes', { max_total_bytes: 40 }],
    ['too_many_symbols', { max_symbols: 2 }],
  ] as const)('fails with %s and writes nothing', async (code, limit) => {
    const f = fakes(SOURCES);
    const error = await buildCodeIndex(f.scope, f.deps, input({ limits: { ...LIMITS, ...limit } }))
      .then(() => undefined)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KnowledgeError);
    expect((error as KnowledgeError).code).toBe(code);
    expect(f.versions).toHaveLength(0);
    expect(f.created).toHaveLength(0);
    expect(f.uses).toHaveLength(0);
  });

  it('leaves out one file over the bytes limit, counts it and goes on', async () => {
    const f = fakes({ ...SOURCES, 'src/big.ts': `// ${'x'.repeat(3_000)}` });
    const built = await buildCodeIndex(f.scope, f.deps, input());
    expect(built).toMatchObject({ files: 2, skipped: 1 });
    expect(f.versions[0]!.files.map((file) => file.path)).not.toContain('src/big.ts');
  });

  it('fails when the files read, those left out included, pass four times the total', async () => {
    const big = `// ${'x'.repeat(3_000)}`;
    const many = Object.fromEntries(
      Array.from({ length: 7 }, (_, i) => [`src/gen${String(i)}.ts`, big]),
    );
    const f = fakes({ ...SOURCES, ...many });
    await expect(buildCodeIndex(f.scope, f.deps, input())).rejects.toMatchObject({
      code: 'too_many_bytes',
    });
    expect(f.versions).toHaveLength(0);
  });

  it('leaves out a file whose parse runs past the time limit', async () => {
    const real = new TreeSitterExtractor();
    const extractor: CodeSymbolExtractor = {
      languageOf: (path) => real.languageOf(path),
      extract: (language, content, timeout) =>
        content.includes('slow')
          ? Promise.resolve({ skipped: 'parse_timeout' as const })
          : real.extract(language, content, timeout),
    };
    const f = fakes({ ...SOURCES, 'src/slow.ts': 'slow' }, { extractor });
    expect(await buildCodeIndex(f.scope, f.deps, input())).toMatchObject({ files: 2, skipped: 1 });
  });

  it('fails on a tree the host lists only in part, and on a file it cannot read', async () => {
    const truncated = fakes(SOURCES, {
      paths: () => {
        throw new GitHostError('tree_truncated');
      },
    });
    await expect(buildCodeIndex(truncated.scope, truncated.deps, input())).rejects.toMatchObject({
      code: 'tree_truncated',
    });
    const unreadable = fakes(SOURCES, { paths: () => [...Object.keys(SOURCES), 'src/gone.ts'] });
    await expect(buildCodeIndex(unreadable.scope, unreadable.deps, input())).rejects.toMatchObject({
      code: 'file_unreadable',
    });
    expect(unreadable.versions).toHaveLength(0);
  });

  it('fails without a store', async () => {
    const f = fakes(SOURCES);
    await expect(
      buildCodeIndex(f.scope, { ...f.deps, store: undefined }, input()),
    ).rejects.toMatchObject({ code: 'store_unavailable' });
  });

  it('uses the index of another run of the same commit and drops its own copy', async () => {
    const f = fakes(SOURCES);
    f.conflictNext({ id: 'other', documents: 2, chunks: 3, purged: false });
    const built = await buildCodeIndex(f.scope, f.deps, input());
    expect(built).toMatchObject({ indexId: 'other', reused: true });
    expect(f.deleted).toEqual([f.versions[0]!.indexId]);
    expect(f.uses).toEqual([{ indexId: 'other', runId: input().runId }]);
  });
});
