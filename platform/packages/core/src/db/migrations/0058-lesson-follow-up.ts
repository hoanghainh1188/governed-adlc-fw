// Migration 0058: a lesson applied by a follow-up intent (task X08b PR 2, design/D-05 §6.12
// version 1.73, ADR-M109 §2.5, 0.4). Rules for every migration: see the header of 0001-tenancy.ts
// and design/ADR-M09. Migrations 0001–0057 are merged and never edited.
//
// - `intent_lesson_outcomes`: an `applied` outcome names the change with a link, or with the
//   intent created by `adlc intent create --from-lesson` (`follow_up_intent_id`), or both. Before,
//   it needed a link; a follow-up intent has no address the platform can build in core.
import { defineMigration } from './define.js';

export const migration0058LessonFollowUp = defineMigration({
  up: [
    `ALTER TABLE intent_lesson_outcomes DROP CONSTRAINT intent_lesson_outcomes_fields`,
    `ALTER TABLE intent_lesson_outcomes ADD CONSTRAINT intent_lesson_outcomes_fields CHECK (
       (outcome = 'applied' AND (link_url IS NOT NULL OR follow_up_intent_id IS NOT NULL)
          AND reason IS NULL)
       OR (outcome = 'dropped' AND reason IS NOT NULL AND link_url IS NULL
          AND follow_up_intent_id IS NULL))`,
  ],
  // Development only (ADR-M09).
  down: [
    `ALTER TABLE intent_lesson_outcomes DROP CONSTRAINT intent_lesson_outcomes_fields`,
    `ALTER TABLE intent_lesson_outcomes ADD CONSTRAINT intent_lesson_outcomes_fields CHECK (
       (outcome = 'applied' AND link_url IS NOT NULL AND reason IS NULL)
       OR (outcome = 'dropped' AND reason IS NOT NULL AND link_url IS NULL))`,
  ],
});
