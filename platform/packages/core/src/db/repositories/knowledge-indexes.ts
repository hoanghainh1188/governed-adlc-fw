// The platform's record of the indexes of a project: its documents (design/D-05 section 6.1, D-08
// X04 PR 3a, design/ADR-M89 §2.2) and its code (X06, ADR-M108 §2.5, `kind`). Codes, IDs, hashes and
// counts only. The index versions themselves (paths, texts, embeddings, symbols) live in
// `knowledge-db` behind `KnowledgeStore` and `CodeIndexStore`.
import type { KnowledgeIndexKind } from '@sdlc/contracts';
import { sql } from 'kysely';

import type { KnowledgeIndex, KnowledgeIndexUse } from '../schema.js';
import { TenantRepository } from './base.js';

export interface NewKnowledgeIndex {
  readonly projectId: string;
  readonly baseSha: string;
  readonly model: string;
  /** X06: `docs` when absent. */
  readonly kind?: KnowledgeIndexKind;
  readonly documents: number;
  readonly chunks: number;
  readonly bytes: number;
}

export class KnowledgeIndexRepository extends TenantRepository {
  /** The ready (not purged) index of a project's commit, model and kind, if any. */
  findReady(
    projectId: string,
    baseSha: string,
    model: string,
    kind: KnowledgeIndexKind = 'docs',
  ): Promise<KnowledgeIndex | undefined> {
    return this.run(
      this.db
        .selectFrom('knowledge_indexes')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('project_id', '=', projectId)
        .where('base_sha', '=', baseSha)
        .where('model', '=', model)
        .where('kind', '=', kind)
        .where('purged_at', 'is', null)
        .executeTakeFirst(),
    );
  }

  /** Records a built index; `conflict` when another run recorded the same commit, model and kind. */
  create(input: NewKnowledgeIndex & { readonly id: string }): Promise<KnowledgeIndex> {
    return this.run(
      this.db
        .insertInto('knowledge_indexes')
        .values({
          id: input.id,
          tenant_id: this.tenantId,
          project_id: input.projectId,
          base_sha: input.baseSha,
          model: input.model,
          kind: input.kind ?? 'docs',
          documents: input.documents,
          chunks: input.chunks,
          bytes: input.bytes,
        })
        .returningAll()
        .executeTakeFirstOrThrow(),
    );
  }

  /**
   * Records that a run uses a ready index; a second record of the same run is kept once. False
   * when the index was purged meanwhile (nothing recorded). The use date moves first: the
   * retention pass decides under the row's lock and never purges an index used within retention.
   */
  async recordUse(input: {
    readonly indexId: string;
    readonly runId: string;
    readonly intentId: string;
    readonly at: Date;
  }): Promise<boolean> {
    const touched = await this.run(
      this.db
        .updateTable('knowledge_indexes')
        .set({ last_used_at: sql<Date>`greatest(last_used_at, ${input.at})` })
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', input.indexId)
        .where('purged_at', 'is', null)
        .executeTakeFirst(),
    );
    if (Number(touched.numUpdatedRows) !== 1) return false;
    await this.run(
      this.db
        .insertInto('knowledge_index_uses')
        .values({
          tenant_id: this.tenantId,
          index_id: input.indexId,
          run_id: input.runId,
          intent_id: input.intentId,
        })
        .onConflict((oc) => oc.columns(['tenant_id', 'index_id', 'run_id']).doNothing())
        .execute(),
    );
    return true;
  }

  /**
   * X04 PR 3b: the ready index version a run recorded a use of, in the run's own project; else
   * undefined. The runner checks the index ID it was handed before a tool reads it, so a tool never
   * gets another project's (or another run's) index.
   */
  usedByRun(
    indexId: string,
    runId: string,
    projectId: string,
  ): Promise<KnowledgeIndex | undefined> {
    return this.run(
      this.db
        .selectFrom('knowledge_indexes as k')
        .innerJoin('knowledge_index_uses as u', (join) =>
          join.onRef('u.tenant_id', '=', 'k.tenant_id').onRef('u.index_id', '=', 'k.id'),
        )
        .selectAll('k')
        .where('k.tenant_id', '=', this.tenantId)
        .where('k.id', '=', indexId)
        .where('k.project_id', '=', projectId)
        .where('k.purged_at', 'is', null)
        .where('u.tenant_id', '=', this.tenantId)
        .where('u.run_id', '=', runId)
        .executeTakeFirst(),
    );
  }

  /** The index versions a run recorded a use of (X04 PR 3b: its `knowledge_read`). */
  async usesOfRun(
    runId: string,
  ): Promise<readonly { readonly indexId: string; readonly model: string }[]> {
    const rows = await this.run(
      this.db
        .selectFrom('knowledge_index_uses as u')
        .innerJoin('knowledge_indexes as k', (join) =>
          join.onRef('k.tenant_id', '=', 'u.tenant_id').onRef('k.id', '=', 'u.index_id'),
        )
        .select(['k.id as id', 'k.model as model'])
        .where('u.tenant_id', '=', this.tenantId)
        .where('k.tenant_id', '=', this.tenantId)
        .where('u.run_id', '=', runId)
        .execute(),
    );
    return rows.map((row) => ({ indexId: row.id, model: row.model }));
  }

  /** Locks a ready index for the retention decision (inside a transaction); undefined if purged. */
  lockReady(indexId: string): Promise<KnowledgeIndex | undefined> {
    return this.run(
      this.db
        .selectFrom('knowledge_indexes')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', indexId)
        .where('purged_at', 'is', null)
        .forUpdate()
        .executeTakeFirst(),
    );
  }

  /** The project's ready indexes, oldest use first (the retention pass). */
  listReady(projectId: string, limit: number): Promise<KnowledgeIndex[]> {
    return this.run(
      this.db
        .selectFrom('knowledge_indexes')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('project_id', '=', projectId)
        .where('purged_at', 'is', null)
        .orderBy('last_used_at')
        .orderBy('id')
        .limit(limit)
        .execute(),
    );
  }

  /** Of `ids`, those that are ready (not purged) indexes of the project (the retention sweep). */
  async readyIds(projectId: string, ids: readonly string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await this.run(
      this.db
        .selectFrom('knowledge_indexes')
        .select('id')
        .where('tenant_id', '=', this.tenantId)
        .where('project_id', '=', projectId)
        .where('id', 'in', [...ids])
        .where('purged_at', 'is', null)
        .execute(),
    );
    return new Set(rows.map((row) => row.id));
  }

  /** The intents that used an index. */
  async intentsOf(indexId: string): Promise<string[]> {
    const rows: KnowledgeIndexUse[] = await this.run(
      this.db
        .selectFrom('knowledge_index_uses')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('index_id', '=', indexId)
        .execute(),
    );
    return [...new Set(rows.map((row) => row.intent_id))];
  }

  /** Marks an index purged once; false when another pass marked it first. */
  async markPurged(indexId: string, at: Date): Promise<boolean> {
    const result = await this.run(
      this.db
        .updateTable('knowledge_indexes')
        .set({ purged_at: at })
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', indexId)
        .where('purged_at', 'is', null)
        .executeTakeFirst(),
    );
    return Number(result.numUpdatedRows) === 1;
  }
}
