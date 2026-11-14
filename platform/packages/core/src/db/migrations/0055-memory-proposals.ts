// Migration 0055: the memory proposals of runs (task X13 PR 3b, design/D-05 §6.11 version 1.62,
// ADR-M74 §2.5 steps 5–6, 0.5; QUESTIONS #716). Rules for every migration: see the header of
// 0001-tenancy.ts and design/ADR-M09. Migrations 0001–0054 are merged and never edited.
//
// - `memory_proposals`: one row per memory branch a run pushed (`memory_branch_pushed`, PR 3a).
//   The worker's memory loop moves it on: `pushed` → `opened` (the memory pull request, after the
//   code pull request's merge at G7) → `recorded` (a version, or the same set again) or `refused`
//   (merged by a bot, a producer or a person who may not approve) or `closed` (closed without a
//   merge); `pushed` → `deleted` (another run's memory, or the intent closed without a merge) or
//   `failed` (the branch moved). Mutable for its state only, because the steps happen over days;
//   every change of state is also an audit event. Codes, IDs and hashes only (R030): never a path,
//   a branch name, a title or memory text. Never deleted: no DELETE grant.
import { defineMigration } from './define.js';

const STATES = `('pushed', 'opened', 'recorded', 'refused', 'closed', 'deleted', 'failed')`;

export const migration0055MemoryProposals = defineMigration({
  up: [
    `CREATE TABLE memory_proposals (
       id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       tenant_id   uuid NOT NULL,
       project_id  uuid NOT NULL,
       intent_id   uuid NOT NULL,
       run_id      uuid NOT NULL,
       head_sha    char(40) NOT NULL CHECK (head_sha ~ '^[0-9a-f]{40}$'),
       state       text NOT NULL DEFAULT 'pushed' CHECK (state IN ${STATES}),
       pr_number   integer CHECK (pr_number >= 1),
       version     integer CHECK (version >= 1),
       cause       text CHECK (cause ~ '^[a-z][a-z0-9_]{0,63}$'),
       created_at  timestamptz NOT NULL DEFAULT now(),
       updated_at  timestamptz NOT NULL DEFAULT now(),
       CONSTRAINT memory_proposals_tenant_id_id_key UNIQUE (tenant_id, id),
       CONSTRAINT memory_proposals_one_per_run UNIQUE (tenant_id, run_id),
       CONSTRAINT memory_proposals_project_fkey FOREIGN KEY (tenant_id, project_id)
         REFERENCES projects (tenant_id, id) ON DELETE RESTRICT,
       CONSTRAINT memory_proposals_intent_fkey FOREIGN KEY (tenant_id, intent_id)
         REFERENCES intents (tenant_id, id) ON DELETE RESTRICT,
       CONSTRAINT memory_proposals_run_fkey FOREIGN KEY (tenant_id, run_id)
         REFERENCES runs (tenant_id, id) ON DELETE RESTRICT,
       -- A pull request number from \`opened\` on; a version only when recorded.
       CONSTRAINT memory_proposals_pr_state CHECK (
         (state IN ('pushed', 'deleted', 'failed')) = (pr_number IS NULL)),
       CONSTRAINT memory_proposals_version_state CHECK (version IS NULL OR state = 'recorded')
     )`,
    `CREATE INDEX memory_proposals_open_idx ON memory_proposals (updated_at)
       WHERE state IN ('pushed', 'opened')`,
    `CREATE INDEX memory_proposals_intent_idx ON memory_proposals (tenant_id, intent_id)`,
    // The memory loop finds new memory branches without reading every run event.
    `CREATE INDEX run_events_memory_pushed_idx ON run_events (created_at)
       WHERE event_type = 'memory_branch_pushed'`,
    // A final state never changes again (ADR-M74 §2.5).
    `CREATE FUNCTION memory_proposals_guard() RETURNS trigger LANGUAGE plpgsql AS $$
     BEGIN
       IF OLD.state NOT IN ('pushed', 'opened') THEN
         RAISE EXCEPTION 'memory proposal %: state % is final', OLD.id, OLD.state
           USING ERRCODE = 'SDA30';
       END IF;
       IF OLD.state = 'opened' AND NEW.state = 'pushed' THEN
         RAISE EXCEPTION 'memory proposal %: never back to pushed', OLD.id USING ERRCODE = 'SDA30';
       END IF;
       RETURN NEW;
     END $$`,
    `CREATE TRIGGER memory_proposals_guard BEFORE UPDATE ON memory_proposals
       FOR EACH ROW EXECUTE FUNCTION memory_proposals_guard()`,
    `REVOKE ALL ON memory_proposals FROM PUBLIC`,
    `GRANT SELECT, INSERT ON memory_proposals TO platform_app`,
    `GRANT UPDATE (state, pr_number, version, cause, updated_at) ON memory_proposals
       TO platform_app`,
  ],
  // Development only (ADR-M09).
  down: [
    `DROP INDEX run_events_memory_pushed_idx`,
    `DROP TABLE memory_proposals`,
    `DROP FUNCTION memory_proposals_guard()`,
  ],
});
