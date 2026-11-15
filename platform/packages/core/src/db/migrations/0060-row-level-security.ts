// Migration 0060: row-level security on every table with `tenant_id` (task H09 PR 2,
// design/ADR-M110 §2.1). Rules for every migration: see the header of 0001-tenancy.ts and
// design/ADR-M09. Migrations 0001–0059 are merged and never edited.
//
// - RLS is enabled and forced, so the policies apply to the owner too.
// - `tenant_isolation` for `platform_app`: a row is visible and writable only when its `tenant_id`
//   is the tenant set in the transaction (`set_config('app.tenant_id', …, true)`, the tenant-bound
//   driver of `forTenant`). `NULLIF(…, '')`: after a local setting ends PostgreSQL returns '',
//   and ''::uuid is an error; without a tenant no row matches. `(SELECT …)` is computed once per
//   query, so the index on `tenant_id` is still used.
// - `owner_all` for `platform`: migrations, the definer functions of 0046 and 0059 and the test
//   seeds keep the access they have today. No role gets BYPASSRLS.
// - `tenants` has no `tenant_id` and stays without RLS (ADR-M110 §2.4).
// - The list is written out here, not imported: a merged migration never changes. A later table
//   with `tenant_id` gets the same statements in its own migration (the live test lists them).
import { defineMigration } from './define.js';

const TABLES = [
  'projects',
  'project_configs',
  'project_ai_records',
  'users',
  'user_identities',
  'role_bindings',
  'api_tokens',
  'git_event_cursors',
  'audit_log',
  'intents',
  'spec_refs',
  'plans',
  'gate_decisions',
  'runs',
  'run_contracts',
  'run_events',
  'cost_records',
  'git_event_receipts',
  'escalations',
  'escalation_notices',
  'agents',
  'intent_notices',
  'project_ai_record_versions',
  'evidence_items',
  'evidence_packs',
  'evidence_holds',
  'langfuse_purges',
  'evaluations',
  'evaluation_runs',
  'evaluation_run_results',
  'evaluation_run_contracts',
  'evaluation_plans',
  'evaluation_plan_versions',
  'evaluation_configurations',
  'evaluation_tasks',
  'evaluation_task_decisions',
  'evaluation_task_check_contracts',
  'tenant_role_bindings',
  'agent_approvals',
  'tools',
  'tool_approvals',
  'knowledge_indexes',
  'knowledge_index_uses',
  'project_memory_versions',
  'memory_proposals',
  'intent_lessons',
  'intent_lesson_outcomes',
  'project_memory_revocations',
  'web_sessions',
  'webauthn_credentials',
  'passkey_challenges',
] as const;

const TENANT = `(SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid)`;

export const migration0060RowLevelSecurity = defineMigration({
  up: TABLES.flatMap((table) => [
    `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`,
    `ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`,
    `CREATE POLICY tenant_isolation ON ${table} TO platform_app
       USING (tenant_id = ${TENANT}) WITH CHECK (tenant_id = ${TENANT})`,
    `CREATE POLICY owner_all ON ${table} TO platform USING (true) WITH CHECK (true)`,
  ]),
  // Development only (ADR-M09).
  down: TABLES.flatMap((table) => [
    `DROP POLICY owner_all ON ${table}`,
    `DROP POLICY tenant_isolation ON ${table}`,
    `ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY`,
    `ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY`,
  ]),
});
