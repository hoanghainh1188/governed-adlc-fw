// The index of a project's documents (task X04 PR 3a, design/ADR-M89). The store holds client
// content (document paths and text) and can be deleted; the platform's own tables hold only IDs,
// hashes and counts. Core uses these interfaces; the adapter `@sdlc/adapter-knowledge-pgvector`
// implements the store on the `knowledge-db` PostgreSQL with pgvector (QUESTIONS #534).
import type { RedactedSecret } from './secrets.js';

const PROJECT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The project's schema in `knowledge-db`: an identifier from its UUID only (ADR-M89 §2.1). */
export function knowledgeSchema(projectId: string): string {
  if (!PROJECT_UUID.test(projectId)) throw new KnowledgeError('store_unavailable');
  return `kdocs_p${projectId.replaceAll('-', '')}`;
}

/**
 * The project's read role (no login). A run's tool logs in as a member of it only (X04 PR 3b,
 * QUESTIONS #537, #540): the OpenBao database role of the run grants this role and nothing else.
 */
export function knowledgeReadRole(projectId: string): string {
  return `${knowledgeSchema(projectId)}_read`;
}

/**
 * The role OpenBao's database secrets engine logs in as (X04 PR 3b): it creates and drops the
 * per-run logins, and holds each project's read role with the admin option only.
 */
export const KNOWLEDGE_ISSUER_ROLE = 'kdocs_issuer';
/** The database of the index in `knowledge-db`. */
export const KNOWLEDGE_DATABASE = 'knowledge';

/** One chunk of a document, keyed by the SHA-256 of its model and text (ADR-M89 §2.3). */
export interface KnowledgeChunk {
  readonly sha256: string;
  readonly text: string;
}

/** One document of an index version, with its chunks in order. */
export interface KnowledgeDocument {
  /** Relative path in the repository: client data, kept in the store only. */
  readonly path: string;
  /** SHA-256 (hex) of the file's bytes. */
  readonly contentSha256: string;
  /** Chunk keys in document order. */
  readonly chunks: readonly string[];
}

/** An index version to write: the documents of one base commit for one model. */
export interface KnowledgeIndexInput {
  readonly tenantId: string;
  readonly projectId: string;
  /** The platform's `knowledge_indexes.id`: the store uses the same ID. */
  readonly indexId: string;
  readonly baseSha: string;
  readonly model: string;
  readonly documents: readonly KnowledgeDocument[];
}

/**
 * The kind of an index version (X06, ADR-M108 §2.5): the documents of X04 or the code of X06. The
 * platform's `knowledge_indexes.kind`; each kind has its own store and its own schema per project.
 */
export const KNOWLEDGE_INDEX_KINDS = ['docs', 'code'] as const;
export type KnowledgeIndexKind = (typeof KNOWLEDGE_INDEX_KINDS)[number];

/**
 * What the retention pass and the client data deletion need of an index store (X06, ADR-M108
 * §2.7): the document store and the code store both implement it.
 */
export interface IndexStoreLifecycle {
  /** Deletes one index version and the rows no other version of the project uses. */
  deleteIndexVersion(projectId: string, indexId: string): Promise<{ readonly chunks: number }>;
  /** The project's index versions with their creation times (the retention sweep). */
  listIndexVersions(
    projectId: string,
  ): Promise<readonly { readonly id: string; readonly createdAt: Date }[]>;
  /**
   * Deletes shared rows no version uses that were stored before `before` (a build that failed or
   * stopped half way). Returns how many. A store with no shared rows returns 0.
   */
  deleteOrphanChunks(projectId: string, before: Date): Promise<number>;
  /** Deletes the project's schema and read role (an archived project). Idempotent. */
  dropProject(projectId: string): Promise<void>;
}

export interface KnowledgeStore extends IndexStoreLifecycle {
  /** Creates the project's schema and read role when they do not exist. Idempotent. */
  ensureProject(input: { readonly tenantId: string; readonly projectId: string }): Promise<void>;
  /** The chunk keys of `sha256s` the project does not hold yet for `model`. */
  missingChunks(
    projectId: string,
    model: string,
    sha256s: readonly string[],
  ): Promise<readonly string[]>;
  /** Stores chunks with their embeddings. A chunk already stored is kept as it is. */
  putChunks(input: {
    readonly tenantId: string;
    readonly projectId: string;
    readonly model: string;
    readonly chunks: readonly (KnowledgeChunk & { readonly embedding: readonly number[] })[];
  }): Promise<void>;
  /** Writes an index version and its documents in one transaction. */
  putIndexVersion(input: KnowledgeIndexInput): Promise<void>;
  close(): Promise<void>;
}

/**
 * Embeddings through the model gateway with the run's own virtual key (ADR-M89 §2.3): the key's
 * labels make the cost count for the run (R027). The key is revealed only in the request.
 */
export interface RunKeyEmbedder {
  embed(key: RedactedSecret, model: string, inputs: readonly string[]): Promise<number[][]>;
}

/** Why an index could not be built or stored. Codes only; texts in the message catalog. */
export const KNOWLEDGE_ERROR_CODES = [
  'store_unavailable',
  'too_many_files',
  'file_too_large',
  'too_many_bytes',
  'too_many_chunks',
  'tree_truncated',
  'file_unreadable',
  'model_not_allowed',
  'embedding_failed',
  /** X04 PR 3b: the tool's database login or model key could not be issued (OpenBao, LiteLLM). */
  'credentials_unavailable',
  /** X06 (ADR-M108 §2.6): more symbol rows than `code_index.max_symbols`. */
  'too_many_symbols',
] as const;
export type KnowledgeErrorCode = (typeof KNOWLEDGE_ERROR_CODES)[number];

export class KnowledgeError extends Error {
  override readonly name = 'KnowledgeError';

  constructor(readonly code: KnowledgeErrorCode) {
    super(`knowledge.${code}`);
  }
}

/**
 * The line a `read_documents` tool writes to its own log for each answer (X04 PR 3b, ADR-M89
 * §2.5, QUESTIONS #533, #536): the document IDs and content hashes it returned, and the number of
 * chunks. Never a query, a path or a text. The runner reads these lines from outside the sandbox at
 * the end of the run and records `knowledge_read`.
 */
export const KNOWLEDGE_READ_LOG_EVENT = 'sdlc.knowledge_read';

export interface KnowledgeReadLogLine {
  readonly event: typeof KNOWLEDGE_READ_LOG_EVENT;
  /** `[doc_id, content_sha256]` of each document of the answer. */
  readonly documents: readonly (readonly [string, string])[];
  readonly chunks: number;
}
