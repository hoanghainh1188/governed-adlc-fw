// Migration 0057: lessons recorded at G8 (task X08b PR 1, design/D-05 §6.12 version 1.73,
// ADR-M109 §2.2–§2.5; QUESTIONS #707, #708, #726). Rules for every migration: see the header of
// 0001-tenancy.ts and design/ADR-M09. Migrations 0001–0056 are merged and never edited.
//
// - `intent_lessons` (append-only): one row per lesson a person recorded on an intent: its codes
//   (category, target), the GitHub comment that holds the words (its `https://` URL and numeric
//   ID), who recorded it and how. Never text (R030): the words stay on GitHub.
// - `intent_lesson_outcomes` (append-only): the lesson was `applied` (with a link to the change)
//   or `dropped` (with a reason code). The state of a lesson is its latest outcome; none: `open`.
//   Recorded by X08b PR 2 (`adlc lesson apply|drop`).
// - Both kept like the audit log; archiving a project and a client data deletion keep them
//   (ADR-M109 §2.4).
import { defineMigration } from './define.js';

// A PostgreSQL regex repeats at most 255 times: the length is its own check.
const URL_CHECK = (column: string) =>
  `${column} ~ '^https://[^[:space:]]+$' AND char_length(${column}) <= 512`;

export const migration0057IntentLessons = defineMigration({
  up: [
    `CREATE TABLE intent_lessons (
       id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       tenant_id    uuid NOT NULL,
       project_id   uuid NOT NULL,
       intent_id    uuid NOT NULL,
       category     text NOT NULL CHECK (category IN ('gate', 'rework', 'agent_assumption',
                      'instructions', 'process', 'tooling', 'other')),
       target       text NOT NULL CHECK (target IN ('agents_md', 'memory', 'handbook', 'config',
                      'none')),
       comment_url  text NOT NULL CHECK (${URL_CHECK('comment_url')}),
       comment_id   text NOT NULL CHECK (comment_id ~ '^[0-9]{1,20}$'),
       recorded_by  uuid NOT NULL,
       source       text NOT NULL CHECK (source IN ('github_comment', 'api', 'web')),
       created_at   timestamptz NOT NULL DEFAULT now(),
       CONSTRAINT intent_lessons_tenant_id_id_key UNIQUE (tenant_id, id),
       -- One lesson per comment.
       CONSTRAINT intent_lessons_one_per_comment UNIQUE (tenant_id, project_id, comment_id),
       CONSTRAINT intent_lessons_project_fkey FOREIGN KEY (tenant_id, project_id)
         REFERENCES projects (tenant_id, id) ON DELETE RESTRICT,
       CONSTRAINT intent_lessons_intent_fkey FOREIGN KEY (tenant_id, intent_id)
         REFERENCES intents (tenant_id, id) ON DELETE RESTRICT,
       CONSTRAINT intent_lessons_recorder_fkey FOREIGN KEY (tenant_id, recorded_by)
         REFERENCES users (tenant_id, id) ON DELETE RESTRICT
     )`,
    `CREATE INDEX intent_lessons_intent_idx ON intent_lessons (tenant_id, intent_id)`,
    `CREATE INDEX intent_lessons_project_idx ON intent_lessons (tenant_id, project_id, created_at)`,
    `CREATE TRIGGER intent_lessons_no_update_delete BEFORE UPDATE OR DELETE
       ON intent_lessons FOR EACH ROW EXECUTE FUNCTION forbid_mutation()`,
    `CREATE TRIGGER intent_lessons_no_truncate BEFORE TRUNCATE
       ON intent_lessons FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation()`,
    `REVOKE ALL ON intent_lessons FROM PUBLIC`,
    `GRANT SELECT, INSERT ON intent_lessons TO platform_app`,

    `CREATE TABLE intent_lesson_outcomes (
       id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       tenant_id   uuid NOT NULL,
       lesson_id   uuid NOT NULL,
       outcome     text NOT NULL CHECK (outcome IN ('applied', 'dropped')),
       link_url    text CHECK (${URL_CHECK('link_url')}),
       reason      text CHECK (reason IN ('duplicate', 'not_valid', 'record_only', 'other')),
       -- The intent created with \`adlc intent create --from-lesson\` (X08b PR 2), if any.
       follow_up_intent_id uuid,
       decided_by  uuid NOT NULL,
       created_at  timestamptz NOT NULL DEFAULT now(),
       CONSTRAINT intent_lesson_outcomes_lesson_fkey FOREIGN KEY (tenant_id, lesson_id)
         REFERENCES intent_lessons (tenant_id, id) ON DELETE RESTRICT,
       CONSTRAINT intent_lesson_outcomes_decider_fkey FOREIGN KEY (tenant_id, decided_by)
         REFERENCES users (tenant_id, id) ON DELETE RESTRICT,
       CONSTRAINT intent_lesson_outcomes_follow_up_fkey FOREIGN KEY (tenant_id, follow_up_intent_id)
         REFERENCES intents (tenant_id, id) ON DELETE RESTRICT,
       -- \`applied\` names the change; \`dropped\` names why.
       CONSTRAINT intent_lesson_outcomes_fields CHECK (
         (outcome = 'applied' AND link_url IS NOT NULL AND reason IS NULL)
         OR (outcome = 'dropped' AND reason IS NOT NULL AND link_url IS NULL))
     )`,
    `CREATE INDEX intent_lesson_outcomes_lesson_idx
       ON intent_lesson_outcomes (tenant_id, lesson_id, created_at)`,
    `CREATE TRIGGER intent_lesson_outcomes_no_update_delete BEFORE UPDATE OR DELETE
       ON intent_lesson_outcomes FOR EACH ROW EXECUTE FUNCTION forbid_mutation()`,
    `CREATE TRIGGER intent_lesson_outcomes_no_truncate BEFORE TRUNCATE
       ON intent_lesson_outcomes FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation()`,
    `REVOKE ALL ON intent_lesson_outcomes FROM PUBLIC`,
    `GRANT SELECT, INSERT ON intent_lesson_outcomes TO platform_app`,
  ],
  // Development only (ADR-M09).
  down: [`DROP TABLE intent_lesson_outcomes`, `DROP TABLE intent_lessons`],
});
