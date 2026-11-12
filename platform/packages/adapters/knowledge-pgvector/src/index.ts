// Knowledge store adapter: the `knowledge-db` PostgreSQL with pgvector (task X04 PR 3a,
// design/ADR-M89 §2.1). See `PgVectorKnowledgeStore`.
export { PgVectorKnowledgeStore, projectRole, projectSchema } from './store.js';
// X04 PR 3b: the read side, for the `read_documents` tool (its run's own login).
export {
  KnowledgeReadError,
  PgVectorKnowledgeReader,
  type KnowledgeHit,
  type KnowledgeSearch,
  type PgVectorKnowledgeReaderOptions,
} from './reader.js';
// X06 (design/ADR-M108 §2.4): the code index, schema `kcode_p<…>` in the same `knowledge-db`.
export { PgCodeIndexStore, type PgCodeIndexStoreOptions } from './code-store.js';
