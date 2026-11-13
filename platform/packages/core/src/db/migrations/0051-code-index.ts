// Migration 0051: the code index in the platform's record of indexes (task X06 PR 1, design/D-05
// §6.1 version 1.71, ADR-M108 §2.5, QUESTIONS #699). Rules for every migration: see the header of
// 0001-tenancy.ts and design/ADR-M09. Migrations 0001–0050 are merged and never edited.
//
// - `knowledge_indexes.kind`: `docs` (the documents of X04, every existing row) or `code` (X06).
//   Fixed after insert: the guard of 0039 (SQLSTATE SDA26) now also compares `kind`.
// - At most one ready (not purged) row per tenant, project, base commit, model **and kind**.
// - `knowledge_index_uses` is unchanged: one row per run and index version, for both kinds.
import { defineMigration } from './define.js';

/** The guard of migration 0039, with `kind` among the fixed columns when `withKind`. */
function guard(withKind: boolean): string {
  const kind = withKind ? ', NEW.kind' : '';
  const oldKind = withKind ? ', OLD.kind' : '';
  return `CREATE OR REPLACE FUNCTION knowledge_indexes_guard() RETURNS trigger
       LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
     BEGIN
       IF (NEW.id, NEW.tenant_id, NEW.project_id, NEW.base_sha, NEW.model, NEW.documents,
           NEW.chunks, NEW.bytes, NEW.created_at${kind})
          IS DISTINCT FROM
          (OLD.id, OLD.tenant_id, OLD.project_id, OLD.base_sha, OLD.model, OLD.documents,
           OLD.chunks, OLD.bytes, OLD.created_at${oldKind}) THEN
         RAISE EXCEPTION 'knowledge index %: only its use and purge dates change', OLD.id
           USING ERRCODE = 'SDA26';
       END IF;
       IF OLD.purged_at IS NOT NULL AND NEW.purged_at IS DISTINCT FROM OLD.purged_at THEN
         RAISE EXCEPTION 'knowledge index %: purged once', OLD.id USING ERRCODE = 'SDA26';
       END IF;
       IF NEW.last_used_at < OLD.last_used_at THEN
         RAISE EXCEPTION 'knowledge index %: the use date never goes back', OLD.id
           USING ERRCODE = 'SDA26';
       END IF;
       RETURN NEW;
     END $$`;
}

export const migration0051CodeIndex = defineMigration({
  up: [
    `ALTER TABLE knowledge_indexes ADD COLUMN kind text NOT NULL DEFAULT 'docs'
       CONSTRAINT knowledge_indexes_kind_check CHECK (kind IN ('docs', 'code'))`,
    `DROP INDEX knowledge_indexes_one_ready_per_commit`,
    `CREATE UNIQUE INDEX knowledge_indexes_one_ready_per_commit
       ON knowledge_indexes (tenant_id, project_id, base_sha, model, kind) WHERE purged_at IS NULL`,
    guard(true),
  ],
  // Development only (ADR-M09).
  down: [
    guard(false),
    `DROP INDEX knowledge_indexes_one_ready_per_commit`,
    `CREATE UNIQUE INDEX knowledge_indexes_one_ready_per_commit
       ON knowledge_indexes (tenant_id, project_id, base_sha, model) WHERE purged_at IS NULL`,
    `ALTER TABLE knowledge_indexes DROP COLUMN kind`,
  ],
});
