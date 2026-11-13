// The index of a project's documents for the worker (task X04 PR 3a, design/ADR-M89 §2.1): the
// `knowledge-db` store with the admin password from OpenBao (`kv/worker/knowledge-db`, field
// `password`; never an environment value, R034) and the embedder on LiteLLM. Missing: the index
// is off, the worker starts, and a run with a `read_documents` tool fails (`tool_unavailable`).
// X06 (ADR-M108): the code index lives in the same `knowledge-db` (its own schema per project),
// parsed with Tree-sitter; it opens and stays off with the document index.
import { TreeSitterExtractor } from '@sdlc/adapter-code-treesitter';
import { PgCodeIndexStore, PgVectorKnowledgeStore } from '@sdlc/adapter-knowledge-pgvector';
import { LiteLLMEmbedder } from '@sdlc/adapter-model-litellm';
import type { GitHostAdapter, SecretReader } from '@sdlc/contracts';
import type { CodeIndexDeps, KnowledgeDeps, PlatformLogger } from '@sdlc/core';
import { t } from '@sdlc/messages';
import { SecretsError } from '@sdlc/secrets';

import type { WorkerKnowledgeSettings } from './settings.js';

/** The field of the KV entry that holds `knowledge-db`'s admin password. */
export const KNOWLEDGE_PASSWORD_FIELD = 'password';

export interface OpenedKnowledge {
  readonly deps: KnowledgeDeps | undefined;
  /** X06: the code index; undefined exactly when `deps` is. */
  readonly code: CodeIndexDeps | undefined;
  close(): Promise<void>;
}

export async function openKnowledge(
  settings: WorkerKnowledgeSettings | null,
  secrets: SecretReader,
  gitHost: GitHostAdapter,
  litellmUrl: string,
  log: PlatformLogger,
): Promise<OpenedKnowledge> {
  const off: OpenedKnowledge = {
    deps: undefined,
    code: undefined,
    close: () => Promise.resolve(),
  };
  if (!settings) {
    log.log('warn', 'worker.knowledge_off', { message: t('worker.start.knowledge_off') });
    return off;
  }
  let password;
  try {
    password = (await secrets.read(settings.secretPath)).data[KNOWLEDGE_PASSWORD_FIELD];
  } catch (error) {
    if (!(error instanceof SecretsError) || error.key !== 'secrets.not_found') throw error;
  }
  if (!password || password.reveal().length === 0) {
    log.log('warn', 'worker.knowledge_missing', { message: t('worker.start.knowledge_missing') });
    return off;
  }
  const url = new URL(settings.url);
  url.password = password.reveal();
  const store = new PgVectorKnowledgeStore({ connectionString: url.toString() });
  const codeStore = new PgCodeIndexStore({ connectionString: url.toString() });
  return {
    deps: { gitHost, store, embedder: new LiteLLMEmbedder({ baseUrl: litellmUrl }) },
    code: { gitHost, store: codeStore, extractor: new TreeSitterExtractor() },
    close: async () => {
      await Promise.all([store.close(), codeStore.close()]);
    },
  };
}
