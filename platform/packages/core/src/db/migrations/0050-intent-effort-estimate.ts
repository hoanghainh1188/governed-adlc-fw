// Migration 0050: the human-effort baseline of an intent (task V14, design/D-05 §6.2 version 1.70,
// ADR-M79 §2.6, QUESTIONS #691–#693). Rules for every migration: see the header of
// 0001-tenancy.ts and design/ADR-M09. Migrations 0001–0049 are merged and never edited.
//
// - `intents.human_effort_hours`: a person's estimate of the hours the work would take without an
//   agent. A number only, never a text. Null by default (no estimate). From 0.25 to 10000 hours,
//   at most two decimals (CHECK; numeric(7,2) holds the decimals).
// - The trigger `intents_effort_estimate` refuses (SQLSTATE SDA29) a change of the estimate on a
//   finished intent (`done`, `rejected`, `cancelled`, `blocked`, the status before the update),
//   and an estimate that goes back to null (QUESTIONS #692).
// - `platform_app` may update the column; who may write it is checked in the core module
//   (`access.intent_create_roles` or a tenant admin, QUESTIONS #693).
import { defineMigration } from './define.js';

const EFFORT_CHECK = `CHECK (human_effort_hours IS NULL
       OR (human_effort_hours >= 0.25 AND human_effort_hours <= 10000))`;

const EFFORT_TRIGGER = `CREATE FUNCTION intents_effort_estimate()
       RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
     BEGIN
       IF NEW.human_effort_hours IS DISTINCT FROM OLD.human_effort_hours THEN
         IF OLD.status IN ('done', 'rejected', 'cancelled', 'blocked') THEN
           RAISE EXCEPTION 'intent %: the estimate of a finished intent never changes', OLD.id
             USING ERRCODE = 'SDA29';
         END IF;
         IF NEW.human_effort_hours IS NULL THEN
           RAISE EXCEPTION 'intent %: an estimate never goes back to null', OLD.id
             USING ERRCODE = 'SDA29';
         END IF;
       END IF;
       RETURN NEW;
     END $$`;

export const migration0050IntentEffortEstimate = defineMigration({
  up: [
    `ALTER TABLE intents ADD COLUMN human_effort_hours numeric(7,2)
       CONSTRAINT intents_human_effort_hours_check ${EFFORT_CHECK}`,
    EFFORT_TRIGGER,
    `CREATE TRIGGER intents_effort_estimate BEFORE UPDATE OF human_effort_hours ON intents
       FOR EACH ROW EXECUTE FUNCTION intents_effort_estimate()`,
    `GRANT UPDATE (human_effort_hours) ON intents TO platform_app`,
  ],
  // Development only (ADR-M09).
  down: [
    `REVOKE UPDATE (human_effort_hours) ON intents FROM platform_app`,
    `DROP TRIGGER intents_effort_estimate ON intents`,
    `DROP FUNCTION intents_effort_estimate()`,
    `ALTER TABLE intents DROP COLUMN human_effort_hours`,
  ],
});
