// Building the code index of a project for a run (task X06, design/ADR-M108 §2.6). Called in the
// run preparation after G4 for a `read_code` grant (PR 2), like the document index of X04:
//
//   a ready code index of the same base commit and format → reused (a new use)
//   else: the source files at `base_sha` (Git host) → Tree-sitter: definitions, references,
//   imports → relative imports resolved to files of the index → the version written to
//   `knowledge-db` (schema `kcode_p<…>`) → recorded in `knowledge_indexes` (kind `code`) → a use
//
// No model call: nothing to cost, every data class. More files, bytes or symbols than the limits,
// a commit listed only in part, a file the host cannot read: `KnowledgeError`, and no index
// (never a partial one). One file too large or too slow to parse is left out and counted. Paths
// and names stay in memory and in `knowledge-db`; the platform's tables get IDs and counts only.
import { createHash, randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';

import {
  CODE_INDEX_FORMAT,
  GitHostError,
  KnowledgeError,
  type CodeFile,
  type CodeIndexStore,
  type CodeLanguage,
  type CodeSymbolExtractor,
  type ExtractedCode,
  type GitHostAdapter,
  type ProjectConfig,
  type RepoRef,
} from '@sdlc/contracts';

import { DbError } from '../db/errors.js';
import type { TenantScope } from '../db/tenant-scope.js';
import { isSkippedPath, resolveImport } from './code-paths.js';

export interface CodeIndexDeps {
  readonly gitHost: Pick<GitHostAdapter, 'listPaths' | 'getFileAtCommit'>;
  /** Undefined when `knowledge-db` is not set up: every index then fails (`store_unavailable`). */
  readonly store: CodeIndexStore | undefined;
  readonly extractor: CodeSymbolExtractor;
}

export interface BuildCodeIndexInput {
  readonly ref: RepoRef;
  readonly projectId: string;
  readonly baseSha: string;
  readonly runId: string;
  readonly intentId: string;
  readonly limits: ProjectConfig['code_index'];
  readonly now: Date;
}

export interface BuiltCodeIndex {
  readonly indexId: string;
  readonly reused: boolean;
  readonly files: number;
  readonly symbols: number;
  /** Files left out (too large or too slow to parse) in this build; 0 for a reused index. */
  readonly skipped: number;
}

interface ReadFiles {
  readonly files: (Omit<CodeFile, 'imports'> & { readonly modules: readonly string[] })[];
  readonly bytes: number;
  readonly symbols: number;
  readonly skipped: number;
}

/** All bytes read, files left out included, are at most this many times `max_total_bytes`. */
export const FETCH_FACTOR = 4;

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

async function listSourcePaths(
  deps: CodeIndexDeps,
  input: BuildCodeIndexInput,
): Promise<{ path: string; language: CodeLanguage }[]> {
  let paths: string[];
  try {
    paths = await deps.gitHost.listPaths(input.ref, input.baseSha);
  } catch (error) {
    if (error instanceof GitHostError && error.code === 'tree_truncated') {
      throw new KnowledgeError('tree_truncated');
    }
    throw new KnowledgeError('file_unreadable');
  }
  const sources: { path: string; language: CodeLanguage }[] = [];
  for (const path of [...paths].sort()) {
    if (isSkippedPath(path)) continue;
    const language = deps.extractor.languageOf(path);
    if (language) sources.push({ path, language });
  }
  if (sources.length > input.limits.max_files) throw new KnowledgeError('too_many_files');
  return sources;
}

async function extract(
  deps: CodeIndexDeps,
  language: CodeLanguage,
  content: string,
  timeoutMs: number,
): Promise<ExtractedCode | undefined> {
  const result = await deps.extractor.extract(language, content, timeoutMs);
  return 'skipped' in result ? undefined : result;
}

async function readSources(deps: CodeIndexDeps, input: BuildCodeIndexInput): Promise<ReadFiles> {
  const sources = await listSourcePaths(deps, input);
  const files: ReadFiles['files'] = [];
  let bytes = 0;
  let fetched = 0;
  let symbols = 0;
  let skipped = 0;
  for (const { path, language } of sources) {
    let content: string;
    try {
      content = await deps.gitHost.getFileAtCommit(input.ref, path, input.baseSha);
    } catch {
      throw new KnowledgeError('file_unreadable');
    }
    const size = Buffer.byteLength(content, 'utf8');
    // The host has no file sizes in its listing: the files left out count here, so a repository
    // of huge generated files cannot make the build read without end (ADR-M108 §2.6).
    fetched += size;
    if (fetched > FETCH_FACTOR * input.limits.max_total_bytes) {
      throw new KnowledgeError('too_many_bytes');
    }
    if (size > input.limits.max_file_bytes) {
      skipped += 1;
      continue;
    }
    bytes += size;
    if (bytes > input.limits.max_total_bytes) throw new KnowledgeError('too_many_bytes');
    const extracted = await extract(deps, language, content, input.limits.parse_timeout_ms);
    if (!extracted) {
      skipped += 1;
      continue;
    }
    symbols += extracted.symbols.length;
    if (symbols > input.limits.max_symbols) throw new KnowledgeError('too_many_symbols');
    files.push({
      path,
      language,
      contentSha256: sha256(content),
      symbols: extracted.symbols,
      modules: extracted.imports,
    });
    // Parsing is synchronous WebAssembly: give the worker's other activities a turn.
    await setImmediate();
  }
  return { files, bytes, symbols, skipped };
}

/** Resolves each file's relative imports to the files of the same index. */
function withImports(read: ReadFiles): CodeFile[] {
  const paths = new Set(read.files.map((file) => file.path));
  return read.files.map(({ modules, ...file }) => ({
    ...file,
    imports: modules.map((module) => ({
      module,
      targetPath: resolveImport(file.path, file.language, module, paths),
    })),
  }));
}

/** The ready code index of the run's commit, or a new one. Records the run's use either way. */
export async function buildCodeIndex(
  scope: TenantScope,
  deps: CodeIndexDeps,
  input: BuildCodeIndexInput,
): Promise<BuiltCodeIndex> {
  const { store } = deps;
  if (!store) throw new KnowledgeError('store_unavailable');
  const use = (indexId: string) =>
    scope.knowledgeIndexes.recordUse({
      indexId,
      runId: input.runId,
      intentId: input.intentId,
      at: input.now,
    });
  const findReady = () =>
    scope.knowledgeIndexes.findReady(input.projectId, input.baseSha, CODE_INDEX_FORMAT, 'code');
  await store.ensureProject({ tenantId: scope.tenantId, projectId: input.projectId });
  const ready = await findReady();
  // A ready index the retention pass purges meanwhile is built again.
  if (ready && (await use(ready.id))) {
    return reusedResult(ready);
  }

  const read = await readSources(deps, input);
  const files = withImports(read);
  const indexId = randomUUID();
  await store.putIndexVersion({
    tenantId: scope.tenantId,
    projectId: input.projectId,
    indexId,
    baseSha: input.baseSha,
    format: CODE_INDEX_FORMAT,
    files,
  });
  try {
    await scope.knowledgeIndexes.create({
      id: indexId,
      projectId: input.projectId,
      baseSha: input.baseSha,
      model: CODE_INDEX_FORMAT,
      kind: 'code',
      documents: files.length,
      chunks: read.symbols,
      bytes: read.bytes,
    });
  } catch (error) {
    if (!(error instanceof DbError && error.code === 'conflict')) throw error;
    // Another run of the same commit recorded its index first: use that one, drop this copy.
    await store.deleteIndexVersion(input.projectId, indexId);
    const other = await findReady();
    if (!other || !(await use(other.id))) throw new KnowledgeError('store_unavailable');
    return reusedResult(other);
  }
  if (!(await use(indexId))) throw new KnowledgeError('store_unavailable');
  return {
    indexId,
    reused: false,
    files: files.length,
    symbols: read.symbols,
    skipped: read.skipped,
  };
}

function reusedResult(index: {
  readonly id: string;
  readonly documents: number;
  readonly chunks: number;
}): BuiltCodeIndex {
  return {
    indexId: index.id,
    reused: true,
    files: index.documents,
    symbols: index.chunks,
    skipped: 0,
  };
}
