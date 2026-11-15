// Migration 0061: break-glass grants (task H08 PR 2, design/ADR-M111 §2.1, §2.5, §2.6; QUESTIONS
// #741–#744). Rules for every migration: see the header of 0001-tenancy.ts and design/ADR-M09.
// Migrations 0001–0060 are merged and never edited.
//
// - `break_glass_grants`: one row per request for one open intent. Codes, IDs, times and two
//   `https://` links only (the reason and the review stay in GitHub comments, R030). The row moves
//   only along ADR-M111 §2.5 (trigger SDA32): requested → active | refused | lapsed;
//   active → revoked | expired. Its identity (who, what, why, how long) never changes; the review
//   is written once, after the grant ended. Never deleted: no DELETE grant.
// - At most one open grant (`requested` or `active`) per intent.
// - The escalation trigger `break_glass` (ADR-M111 §2.6): the stand-in for the incident.
// - Row-level security and both policies of ADR-M110 §2.1, as every table with `tenant_id`.
import { defineMigration } from './define.js';

const URL_CHECK = (column: string) =>
  `${column} ~ '^https://[^[:space:]@]+$' AND char_length(${column}) <= 512`;
const TENANT = `(SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid)`;

export const migration0061BreakGlass = defineMigration({
  up: [
    // PostgreSQL 12+ allows ADD VALUE in a transaction; the value is not used in this one.
    `ALTER TYPE escalation_trigger ADD VALUE 'break_glass'`,

    `CREATE TABLE break_glass_grants (
       id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       tenant_id           uuid NOT NULL,
       project_id          uuid NOT NULL,
       intent_id           uuid NOT NULL,
       operator_id         uuid NOT NULL,
       scopes              text[] NOT NULL CHECK (
                             cardinality(scopes) BETWEEN 1 AND 3
                             AND scopes <@ ARRAY['runner_priority', 'budget',
                                                 'hotl_window_skip']::text[]),
       duration_seconds    integer NOT NULL CHECK (duration_seconds BETWEEN 60 AND 28800),
       budget_increase_usd numeric(18,6) CHECK (budget_increase_usd > 0),
       reason_url          text NOT NULL CHECK (${URL_CHECK('reason_url')}),
       status              text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested',
                             'active', 'refused', 'revoked', 'expired', 'lapsed')),
       created_at          timestamptz NOT NULL DEFAULT now(),
       lapses_at           timestamptz NOT NULL,
       approver_id         uuid,
       decided_at          timestamptz,
       expires_at          timestamptz,
       escalation_id       uuid,
       ended_at            timestamptz,
       -- Null for an operator on the server (\`system\`).
       revoked_by          uuid,
       review_url          text CHECK (${URL_CHECK('review_url')}),
       reviewed_by         uuid,
       reviewed_at         timestamptz,
       review_overdue_at   timestamptz,
       CONSTRAINT break_glass_grants_tenant_id_id_key UNIQUE (tenant_id, id),
       CONSTRAINT break_glass_grants_project_fkey FOREIGN KEY (tenant_id, project_id)
         REFERENCES projects (tenant_id, id) ON DELETE RESTRICT,
       CONSTRAINT break_glass_grants_intent_fkey FOREIGN KEY (tenant_id, intent_id)
         REFERENCES intents (tenant_id, id) ON DELETE RESTRICT,
       CONSTRAINT break_glass_grants_operator_fkey FOREIGN KEY (tenant_id, operator_id)
         REFERENCES users (tenant_id, id) ON DELETE RESTRICT,
       CONSTRAINT break_glass_grants_approver_fkey FOREIGN KEY (tenant_id, approver_id)
         REFERENCES users (tenant_id, id) ON DELETE RESTRICT,
       CONSTRAINT break_glass_grants_revoker_fkey FOREIGN KEY (tenant_id, revoked_by)
         REFERENCES users (tenant_id, id) ON DELETE RESTRICT,
       CONSTRAINT break_glass_grants_reviewer_fkey FOREIGN KEY (tenant_id, reviewed_by)
         REFERENCES users (tenant_id, id) ON DELETE RESTRICT,
       CONSTRAINT break_glass_grants_escalation_fkey FOREIGN KEY (tenant_id, escalation_id)
         REFERENCES escalations (tenant_id, id) ON DELETE RESTRICT,
       -- Rule M21: the requester and the approver are two different people.
       CONSTRAINT break_glass_grants_two_people CHECK (approver_id IS NULL
                                                       OR approver_id <> operator_id),
       -- The amount comes with the \`budget\` scope, and only with it.
       CONSTRAINT break_glass_grants_budget CHECK (
         (budget_increase_usd IS NOT NULL) = ('budget' = ANY (scopes))),
       CONSTRAINT break_glass_grants_decided CHECK (
         status IN ('requested', 'lapsed')
         OR (approver_id IS NOT NULL AND decided_at IS NOT NULL)),
       CONSTRAINT break_glass_grants_was_active CHECK (
         status NOT IN ('active', 'revoked', 'expired')
         OR (expires_at IS NOT NULL AND escalation_id IS NOT NULL)),
       CONSTRAINT break_glass_grants_ended CHECK (
         (ended_at IS NULL) = (status IN ('requested', 'active'))),
       CONSTRAINT break_glass_grants_review CHECK (
         (review_url IS NULL) = (reviewed_by IS NULL)
         AND (review_url IS NULL) = (reviewed_at IS NULL))
     )`,
    `CREATE UNIQUE INDEX break_glass_grants_one_open ON break_glass_grants (tenant_id, intent_id)
       WHERE status IN ('requested', 'active')`,
    `CREATE INDEX break_glass_grants_intent_idx ON break_glass_grants (tenant_id, intent_id)`,
    `CREATE INDEX break_glass_grants_project_idx
       ON break_glass_grants (tenant_id, project_id, created_at)`,
    // The worker loop (ADR-M111 §2.5): open grants due to end, ended grants due for review.
    `CREATE INDEX break_glass_grants_open_idx ON break_glass_grants (tenant_id, status)
       WHERE status IN ('requested', 'active')`,

    // Allowed moves (ADR-M111 §2.5). The identity of a grant never changes; the decision, the end
    // and the review are each written once.
    `CREATE FUNCTION break_glass_grants_moves() RETURNS trigger
       LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
     BEGIN
       IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
          OR NEW.project_id IS DISTINCT FROM OLD.project_id
          OR NEW.intent_id IS DISTINCT FROM OLD.intent_id
          OR NEW.operator_id IS DISTINCT FROM OLD.operator_id
          OR NEW.scopes IS DISTINCT FROM OLD.scopes
          OR NEW.duration_seconds IS DISTINCT FROM OLD.duration_seconds
          OR NEW.budget_increase_usd IS DISTINCT FROM OLD.budget_increase_usd
          OR NEW.reason_url IS DISTINCT FROM OLD.reason_url
          OR NEW.created_at IS DISTINCT FROM OLD.created_at
          OR NEW.lapses_at IS DISTINCT FROM OLD.lapses_at THEN
         RAISE EXCEPTION 'break-glass grant %: fixed columns', OLD.id USING ERRCODE = 'SDA32';
       END IF;
       IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
            (OLD.status = 'requested' AND NEW.status IN ('active', 'refused', 'lapsed'))
         OR (OLD.status = 'active' AND NEW.status IN ('revoked', 'expired'))) THEN
         RAISE EXCEPTION 'break-glass grant %: % → % not allowed', OLD.id, OLD.status, NEW.status
           USING ERRCODE = 'SDA32';
       END IF;
       IF OLD.status <> 'requested' AND (
            NEW.approver_id IS DISTINCT FROM OLD.approver_id
            OR NEW.decided_at IS DISTINCT FROM OLD.decided_at
            OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
            OR NEW.escalation_id IS DISTINCT FROM OLD.escalation_id) THEN
         RAISE EXCEPTION 'break-glass grant %: already decided', OLD.id USING ERRCODE = 'SDA32';
       END IF;
       IF OLD.ended_at IS NOT NULL AND (
            NEW.ended_at IS DISTINCT FROM OLD.ended_at
            OR NEW.revoked_by IS DISTINCT FROM OLD.revoked_by) THEN
         RAISE EXCEPTION 'break-glass grant %: already ended', OLD.id USING ERRCODE = 'SDA32';
       END IF;
       IF OLD.review_url IS NOT NULL AND (
            NEW.review_url IS DISTINCT FROM OLD.review_url
            OR NEW.reviewed_by IS DISTINCT FROM OLD.reviewed_by
            OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at) THEN
         RAISE EXCEPTION 'break-glass grant %: already reviewed', OLD.id USING ERRCODE = 'SDA32';
       END IF;
       IF NEW.review_url IS NOT NULL AND NEW.status NOT IN ('revoked', 'expired') THEN
         RAISE EXCEPTION 'break-glass grant %: reviewed before it ended', OLD.id
           USING ERRCODE = 'SDA32';
       END IF;
       IF OLD.review_overdue_at IS NOT NULL
          AND NEW.review_overdue_at IS DISTINCT FROM OLD.review_overdue_at THEN
         RAISE EXCEPTION 'break-glass grant %: overdue already recorded', OLD.id
           USING ERRCODE = 'SDA32';
       END IF;
       RETURN NEW;
     END $$`,
    `CREATE TRIGGER break_glass_grants_moves BEFORE UPDATE ON break_glass_grants
       FOR EACH ROW EXECUTE FUNCTION break_glass_grants_moves()`,
    `REVOKE ALL ON break_glass_grants FROM PUBLIC`,
    `GRANT SELECT, INSERT ON break_glass_grants TO platform_app`,
    `GRANT UPDATE (status, approver_id, decided_at, expires_at, escalation_id, ended_at,
       revoked_by, review_url, reviewed_by, reviewed_at, review_overdue_at)
       ON break_glass_grants TO platform_app`,

    // ADR-M110 §2.1.
    `ALTER TABLE break_glass_grants ENABLE ROW LEVEL SECURITY`,
    `ALTER TABLE break_glass_grants FORCE ROW LEVEL SECURITY`,
    `CREATE POLICY tenant_isolation ON break_glass_grants TO platform_app
       USING (tenant_id = ${TENANT}) WITH CHECK (tenant_id = ${TENANT})`,
    `CREATE POLICY owner_all ON break_glass_grants TO platform USING (true) WITH CHECK (true)`,
  ],
  // Development only (ADR-M09). PostgreSQL never removes an enum value: `break_glass` stays.
  down: [`DROP TABLE break_glass_grants`, `DROP FUNCTION break_glass_grants_moves()`],
});
