// Migration 0053: approved and revoked agent memory sets (task X13 PR 1, design/D-05 §6.11 version
// 1.62, ADR-M74 §2.3, §2.7, QUESTIONS #711–#715). Rules for every migration: see the header of
// 0001-tenancy.ts and design/ADR-M09. Migrations 0001–0052 are merged and never edited.
//
// - `project_memory_versions` (append-only): one row per memory set a person approved for a
//   project: its number, the SHA-256 of the set, a default-branch commit that holds it, how it was
//   approved and by whom. Codes, IDs and hashes only: never a path in clear or memory text (R030).
// - `project_memory_revocations` (append-only): at most one per version; a run never reads a
//   revoked set again. A revocation is never undone.
// - Both kept like the audit log; archiving a project keeps them (ADR-M74 §2.9).
import { defineMigration } from './define.js';

const SHA40 = `~ '^[0-9a-f]{40}$'`;

export const migration0053MemoryVersions = defineMigration({
  up: [
    `CREATE TABLE project_memory_versions (
       id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       tenant_id   uuid NOT NULL,
       project_id  uuid NOT NULL,
       version     integer NOT NULL CHECK (version >= 1),
       set_sha256  char(64) NOT NULL CHECK (set_sha256 ~ '^[0-9a-f]{64}$'),
       commit_sha  char(40) NOT NULL CHECK (commit_sha ${SHA40}),
       source      text NOT NULL CHECK (source IN ('memory_pr', 'cli')),
       approved_by uuid NOT NULL,
       pr_number   integer CHECK (pr_number >= 1),
       intent_id   uuid,
       run_id      uuid,
       created_at  timestamptz NOT NULL DEFAULT now(),
       CONSTRAINT project_memory_versions_tenant_id_id_key UNIQUE (tenant_id, id),
       CONSTRAINT project_memory_versions_one_number
         UNIQUE (tenant_id, project_id, version),
       CONSTRAINT project_memory_versions_project_fkey FOREIGN KEY (tenant_id, project_id)
         REFERENCES projects (tenant_id, id) ON DELETE RESTRICT,
       CONSTRAINT project_memory_versions_approver_fkey FOREIGN KEY (tenant_id, approved_by)
         REFERENCES users (tenant_id, id) ON DELETE RESTRICT,
       CONSTRAINT project_memory_versions_intent_fkey FOREIGN KEY (tenant_id, intent_id)
         REFERENCES intents (tenant_id, id) ON DELETE RESTRICT,
       CONSTRAINT project_memory_versions_run_fkey FOREIGN KEY (tenant_id, run_id)
         REFERENCES runs (tenant_id, id) ON DELETE RESTRICT,
       -- A memory pull request names its number and the run that proposed the set; a CLI
       -- approval names none of them (ADR-M74 §2.3).
       CONSTRAINT project_memory_versions_source_refs CHECK (
         (source = 'memory_pr'
            AND pr_number IS NOT NULL AND intent_id IS NOT NULL AND run_id IS NOT NULL)
         OR (source = 'cli' AND pr_number IS NULL AND intent_id IS NULL AND run_id IS NULL))
     )`,
    `CREATE INDEX project_memory_versions_set_idx
       ON project_memory_versions (tenant_id, project_id, set_sha256)`,
    `CREATE TRIGGER project_memory_versions_no_update_delete BEFORE UPDATE OR DELETE
       ON project_memory_versions FOR EACH ROW EXECUTE FUNCTION forbid_mutation()`,
    `CREATE TRIGGER project_memory_versions_no_truncate BEFORE TRUNCATE
       ON project_memory_versions FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation()`,
    `REVOKE ALL ON project_memory_versions FROM PUBLIC`,
    `GRANT SELECT, INSERT ON project_memory_versions TO platform_app`,

    `CREATE TABLE project_memory_revocations (
       id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       tenant_id  uuid NOT NULL,
       project_id uuid NOT NULL,
       version    integer NOT NULL,
       revoked_by uuid NOT NULL,
       reason     text NOT NULL CHECK (reason IN ('poisoned', 'wrong', 'other')),
       created_at timestamptz NOT NULL DEFAULT now(),
       CONSTRAINT project_memory_revocations_one_per_version
         UNIQUE (tenant_id, project_id, version),
       CONSTRAINT project_memory_revocations_version_fkey
         FOREIGN KEY (tenant_id, project_id, version)
         REFERENCES project_memory_versions (tenant_id, project_id, version) ON DELETE RESTRICT,
       CONSTRAINT project_memory_revocations_revoker_fkey FOREIGN KEY (tenant_id, revoked_by)
         REFERENCES users (tenant_id, id) ON DELETE RESTRICT
     )`,
    `CREATE TRIGGER project_memory_revocations_no_update_delete BEFORE UPDATE OR DELETE
       ON project_memory_revocations FOR EACH ROW EXECUTE FUNCTION forbid_mutation()`,
    `CREATE TRIGGER project_memory_revocations_no_truncate BEFORE TRUNCATE
       ON project_memory_revocations FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation()`,
    `REVOKE ALL ON project_memory_revocations FROM PUBLIC`,
    `GRANT SELECT, INSERT ON project_memory_revocations TO platform_app`,
  ],
  // Development only (ADR-M09).
  down: [`DROP TABLE project_memory_revocations`, `DROP TABLE project_memory_versions`],
});
