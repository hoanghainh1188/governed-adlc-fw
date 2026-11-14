// Migration 0056: finding past intents (task X08a, design/D-05 §6.2 version 1.73, ADR-M109 §2.1,
// 0.2; QUESTIONS #706, #722, #725). Rules for every migration: see the header of 0001-tenancy.ts
// and design/ADR-M09. Migrations 0001–0055 are merged and never edited.
//
// - `intents.search_tsv`: a generated column, the `simple` text search vector of the title and
//   the description (no stemming: English, Vietnamese and Japanese text alike). It is no new copy
//   of the text to purge: it follows the two columns by itself. A GIN index serves `q` of
//   `GET /v1/intents` (the choice of index: ADR-M109 0.2, measured on 10,000 intents).
// - `intents.closed_at`: when the intent became `done`, `rejected`, `cancelled` or `blocked`
//   (QUESTIONS #722). Set by the trigger `intents_closed_at` from the move's `updated_at` (the
//   registry's clock) and cleared if the intent leaves a final status; never written by the app.
//   Finished intents get their `updated_at` (nothing updates an intent once it is finished).
//   No CHECK: `platform_app` cannot write the column, and every status change goes through the
//   trigger.
// - Client data deletion (QUESTIONS #725, ADR-M97 1.x): `platform_app` may update `title` and
//   `description`, but the trigger `intents_scrub_only` (SQLSTATE SDA31) allows only the
//   tombstone: the title `Redacted intent <code>` and an empty description.
import { defineMigration } from './define.js';

const FINAL = `('done', 'rejected', 'cancelled', 'blocked')`;

const CLOSED_AT = `CREATE FUNCTION intents_closed_at()
       RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
     BEGIN
       IF NEW.status IN ${FINAL} AND (OLD.status NOT IN ${FINAL} OR OLD.closed_at IS NULL) THEN
         NEW.closed_at := COALESCE(NEW.updated_at, now());
       ELSIF NEW.status NOT IN ${FINAL} THEN
         NEW.closed_at := NULL;
       ELSE
         NEW.closed_at := OLD.closed_at;
       END IF;
       RETURN NEW;
     END $$`;

const SCRUB_ONLY = `CREATE FUNCTION intents_scrub_only()
       RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
     BEGIN
       IF (NEW.title IS DISTINCT FROM OLD.title OR NEW.description IS DISTINCT FROM OLD.description)
          AND (NEW.title <> 'Redacted intent ' || OLD.code OR NEW.description <> '') THEN
         RAISE EXCEPTION 'intent %: the title and description change only to the tombstone', OLD.id
           USING ERRCODE = 'SDA31';
       END IF;
       RETURN NEW;
     END $$`;

export const migration0056IntentSearch = defineMigration({
  up: [
    `ALTER TABLE intents ADD COLUMN search_tsv tsvector
       GENERATED ALWAYS AS (to_tsvector('simple', title || ' ' || description)) STORED`,
    `CREATE INDEX intents_search_tsv_idx ON intents USING gin (search_tsv)`,
    `ALTER TABLE intents ADD COLUMN closed_at timestamptz`,
    `UPDATE intents SET closed_at = updated_at WHERE status IN ${FINAL}`,
    `CREATE INDEX intents_tenant_id_closed_at_idx ON intents (tenant_id, closed_at)
       WHERE closed_at IS NOT NULL`,
    CLOSED_AT,
    `CREATE TRIGGER intents_closed_at BEFORE UPDATE OF status ON intents
       FOR EACH ROW EXECUTE FUNCTION intents_closed_at()`,
    SCRUB_ONLY,
    `CREATE TRIGGER intents_scrub_only BEFORE UPDATE OF title, description ON intents
       FOR EACH ROW EXECUTE FUNCTION intents_scrub_only()`,
    `GRANT UPDATE (title, description) ON intents TO platform_app`,
  ],
  // Development only (ADR-M09).
  down: [
    `REVOKE UPDATE (title, description) ON intents FROM platform_app`,
    `DROP TRIGGER intents_scrub_only ON intents`,
    `DROP FUNCTION intents_scrub_only()`,
    `DROP TRIGGER intents_closed_at ON intents`,
    `DROP FUNCTION intents_closed_at()`,
    `ALTER TABLE intents DROP COLUMN closed_at`,
    `ALTER TABLE intents DROP COLUMN search_tsv`,
  ],
});
