// The code index of a project (task X06, design/ADR-M108): the definitions, references and imports
// of its source files at a run's base commit, built with Tree-sitter. The store holds client
// content (paths and symbol names) in `knowledge-db` and can be deleted; the platform's own
// `knowledge_indexes` row (kind `code`) holds only IDs, hashes and counts. Core uses these
// interfaces; `@sdlc/adapter-code-treesitter` parses and `@sdlc/adapter-knowledge-pgvector` stores.
import { KnowledgeError, type IndexStoreLifecycle } from './knowledge.js';

const PROJECT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The project's code schema in `knowledge-db`: from its UUID only (ADR-M108 §2.4). */
export function codeIndexSchema(projectId: string): string {
  if (!PROJECT_UUID.test(projectId)) throw new KnowledgeError('store_unavailable');
  return `kcode_p${projectId.replaceAll('-', '')}`;
}

/** The project's code read role (no login): a `read_code` login is a member of it only. */
export function codeIndexReadRole(projectId: string): string {
  return `${codeIndexSchema(projectId)}_read`;
}

/**
 * The index format, recorded as `knowledge_indexes.model` (ADR-M108 §2.5). A change of the
 * queries or of what is stored is a new format, so an old index is never read with new rules.
 */
export const CODE_INDEX_FORMAT = 'tree-sitter-1';

/** The languages of the first format (ADR-M108 §2.3, QUESTIONS #698). */
export const CODE_LANGUAGES = [
  'typescript',
  'tsx',
  'javascript',
  'vue',
  'python',
  'java',
  'go',
] as const;
export type CodeLanguage = (typeof CODE_LANGUAGES)[number];

/** What a definition is. A reference has the kind of its use (`call`, `new`, `type`). */
export const CODE_SYMBOL_KINDS = [
  'class',
  'interface',
  'type',
  'enum',
  'function',
  'method',
  'variable',
  'call',
  'new',
  'type_ref',
] as const;
export type CodeSymbolKind = (typeof CODE_SYMBOL_KINDS)[number];

export type CodeSymbolRole = 'def' | 'ref';

export interface CodeSymbol {
  readonly name: string;
  readonly kind: CodeSymbolKind;
  readonly role: CodeSymbolRole;
  /** 1-based line in the file. */
  readonly line: number;
}

/** What the parser read of one file. */
export interface ExtractedCode {
  readonly symbols: readonly CodeSymbol[];
  /** The module name of each import, as written (`./x`, `react`, `.models`). */
  readonly imports: readonly string[];
}

/** Why one file was left out of an index (ADR-M108 §2.6). Counted, never named. */
export type CodeSkipReason = 'too_large' | 'parse_timeout';

/**
 * The Tree-sitter parser (ADR-M108 §2.1). Client code in, names and lines out; it never runs the
 * code. `extract` returns `{ skipped }` when the file's parse takes longer than `timeoutMs`.
 */
export interface CodeSymbolExtractor {
  /** The language of a path, or undefined when the path is not indexed. */
  languageOf(path: string): CodeLanguage | undefined;
  extract(
    language: CodeLanguage,
    content: string,
    timeoutMs: number,
  ): Promise<ExtractedCode | { readonly skipped: 'parse_timeout' }>;
}

/** One file of a code index version. */
export interface CodeFile {
  /** Relative path in the repository: client data, kept in the store only. */
  readonly path: string;
  readonly language: CodeLanguage;
  /** SHA-256 (hex) of the file's bytes. */
  readonly contentSha256: string;
  readonly symbols: readonly CodeSymbol[];
  /** Imports with the path of the file of the same index they resolve to, if any. */
  readonly imports: readonly { readonly module: string; readonly targetPath: string | null }[];
}

/** A code index version to write: the files of one base commit for one format. */
export interface CodeIndexInput {
  readonly tenantId: string;
  readonly projectId: string;
  /** The platform's `knowledge_indexes.id`: the store uses the same ID. */
  readonly indexId: string;
  readonly baseSha: string;
  readonly format: string;
  readonly files: readonly CodeFile[];
}

export interface CodeIndexStore extends IndexStoreLifecycle {
  /** Creates the project's code schema and read role when they do not exist. Idempotent. */
  ensureProject(input: { readonly tenantId: string; readonly projectId: string }): Promise<void>;
  /** Writes an index version and its files, symbols and imports in one transaction. */
  putIndexVersion(input: CodeIndexInput): Promise<void>;
  close(): Promise<void>;
}
