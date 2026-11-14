// D-08 A06 AC2 (and the B02 registry tables) on a live PostgreSQL: tables, columns, enums, composite foreign keys (D-05 D2),
// unique constraints and the privileges of the application role.
import {
  ACTOR_TYPES,
  AUTONOMY_LEVELS,
  CHANGE_FLAGS,
  DATA_CLASSES,
  EVENT_SOURCES,
  GATE_CHECK_MODES,
  GATE_CODES,
  GATE_DECISIONS,
  GATE_REASON_CODES,
  INTENT_STATUSES,
  PROJECT_ROLES,
  RISK_TIERS,
} from '@sdlc/contracts';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  migrateDown,
  migrateToLatest,
  migrationStatus,
} from '../../../packages/core/src/db/migrator.js';
import { MIGRATIONS } from '../../../packages/core/src/db/migrations/index.js';
import { TABLE_COLUMNS } from '../../../packages/core/src/db/schema.js';
import { DB_ENUMS } from '../../../packages/core/src/db/vocabulary.js';
import { createTestDatabase, describeDb, type TestDatabase } from './helpers.js';

const TABLES = Object.keys(TABLE_COLUMNS).sort();
// Columns platform_app may UPDATE (ADR-M09 section 2.3). Everything else, including every id,
// tenant_id and created_at, is fixed once inserted.
const UPDATABLE: Record<string, readonly string[]> = {
  tenants: ['name', 'monthly_budget_usd', 'status'],
  // O06 (migration 0049): the folder, changed only while no intent is open (admin module).
  projects: ['name', 'repo_full_name', 'default_branch', 'status', 'repo_path'],
  // B13: the hash of the stored YAML (QUESTIONS #95).
  project_configs: ['version', 'config_yaml', 'config_hash', 'updated_by', 'override_sha256'],
  project_ai_records: [
    'version',
    'ai_allowed',
    'allowed_data_classes',
    'prod_logs_allowed',
    'disclosure_format',
    'confirmed_at',
    'updated_by',
    'record_ref',
    'record_sha256',
  ],
  users: ['display_name', 'email', 'status'],
  // B13: an identity is unlinked, never deleted.
  user_identities: ['external_login', 'unlinked_at'],
  role_bindings: ['revoked_at'],
  api_tokens: ['last_used_at', 'revoked_at'],
  git_event_cursors: ['cursor', 'last_polled_at'],
  // Append-only (D-05 D3, A07): no column is updatable.
  audit_log: [],
  // B02: only the current state of an intent changes; history is in gate_decisions and audit_log.
  // B07: when the intent entered its gate (waiting time, FR-12).
  // C07 (migration 0015): the budgets, only up (trigger SDA12).
  intents: [
    // X08a (migration 0056): only to the tombstone of a client data deletion (trigger SDA31).
    'title',
    'description',
    'budget_usd',
    'current_gate',
    'status',
    'issue_number',
    'pr_number',
    'updated_at',
    'gate_entered_at',
    'run_budget_usd',
    // U02 (migration 0025): why the intent waits, written by the workflow's step.
    'waiting_reason',
    'waiting_cause',
    'waiting_since',
    'waiting_until',
    // V14 (migration 0050): a person's estimate of the human effort; trigger SDA29.
    'human_effort_hours',
  ],
  spec_refs: [],
  plans: [],
  // Append-only (D-05 D3, B02).
  gate_decisions: [],
  // C02: the state of a run changes until it is final (trigger); its inputs never do.
  runs: [
    'head_sha',
    'status',
    'stop_reason',
    'started_at',
    'finished_at',
    'iterations',
    'killed_by',
    'updated_at',
  ],
  // Written once; revocation (MVP+) will get its own grant.
  run_contracts: [],
  // Append-only (D-05 D3, C02).
  run_events: [],
  // Append-only (D-05 D3, C03).
  cost_records: [],
  // B06: a `failing` receipt gets its result once; then only the reply delivery moves (trigger).
  git_event_receipts: [
    'outcome',
    'gate_decision_id',
    'reply_code',
    'reply_params',
    'event_attempts',
    'reply_attempts',
    'reply_posted_at',
    'reply_abandoned_at',
    // B11: the escalation a `/ack` or `/decide` comment acted on (fixed with the result, trigger).
    'escalation_id',
  ],
  // B11: state, clocks, acknowledgement and decision; identity, trigger, packet, producers never.
  escalations: [
    'backup_owner_id',
    'current_step',
    'status',
    'step_due_at',
    'remind_at',
    'reminded_step',
    'ack_missed_at',
    'governance_overdue_at',
    'resolve_due_at',
    'resolve_overdue_at',
    'next_check_at',
    'acknowledged_by',
    'acknowledged_at',
    'decision',
    'decided_by',
    'decided_at',
    'closed_at',
    'updated_at',
  ],
  // B11: only the delivery moves (trigger: final once posted or abandoned).
  escalation_notices: ['attempts', 'posted_at', 'abandoned_at'],
  // C10: state, owner and configuration (trigger: allowed moves, new version); never the key.
  agents: [
    'version',
    'status',
    'owner_id',
    'model_ref',
    'instructions_ref',
    'instructions_sha256',
    'allowed_tools',
    'max_autonomy',
    'approved_environments',
    'last_recertified_at',
    'updated_at',
    // X03 (migration 0037): configuration, changed only with a new version (trigger SDA09).
    'adapter',
    // O06 (migration 0049): the second pinned file, configuration too.
    'root_instructions_ref',
    'root_instructions_sha256',
  ],
  // B07: the status comments; only the delivery moves (trigger: final once posted or abandoned).
  intent_notices: ['attempts', 'posted_at', 'abandoned_at'],
  // Append-only (B12, ADR-M32): every version of the project AI record, written by a trigger.
  project_ai_record_versions: [],
  // C06 session 2b: written once; the purge (E05, migration 0023) sets `purged_at` once and moves
  // the lock forward (trigger SDA15: everything else fixed).
  evidence_items: ['purged_at', 'lock_extended_until'],
  // E02 (migration 0021): written once; E03 (migration 0022) seals one version; E05 (migration
  // 0023) sets `purged_at` once and moves the lock forward (trigger SDA14: everything else fixed).
  // `retention_hold` is not used (QUESTIONS #235): no grant.
  evidence_packs: ['sealed_at', 'purged_at', 'lock_extended_until'],
  // E05 (migration 0023, QUESTIONS #235): a hold is released once; the loop records what it
  // applied (trigger SDA16).
  evidence_holds: ['applied_at', 'released_at', 'released_by', 'release_applied_at'],
  // B13: a tenant role is withdrawn by `revoked_at`, never deleted (trigger: final once set).
  tenant_role_bindings: ['revoked_at'],
  // Append-only (B13 AC7): approvals of the agent register.
  agent_approvals: [],
  // X04 (migration 0038): state, owner and configuration of the tool register (trigger SDA25:
  // allowed moves, a new version for a configuration change); never the key.
  tools: [
    'version',
    'status',
    'owner_id',
    'transport',
    'image_ref',
    'image_digest',
    'permissions',
    'allowed_data_classes',
    'backing_services',
    'model_ref',
    'last_recertified_at',
    'updated_at',
  ],
  // Append-only (X04): approvals of the tool register.
  tool_approvals: [],
  // E08 (migration 0024, QUESTIONS #253): a request again until confirmed once (trigger SDA17).
  langfuse_purges: ['traces', 'attempts', 'last_requested_at', 'confirmed_at'],
  // L04 (migration 0029): the state of an evaluation and of its runs; the budget only goes up
  // (SDA21); a run moves only along the machine (SDA22). Results are append-only.
  evaluations: ['budget_usd', 'status', 'stop_reason', 'finished_at', 'updated_at'],
  evaluation_runs: [
    'attempt',
    'status',
    'stop_reason',
    'runner_instance',
    'started_at',
    'finished_at',
    'updated_at',
  ],
  evaluation_run_results: [],
  // L04 PR 4a (migration 0030): a contract is written once for an attempt and never changed.
  evaluation_run_contracts: [],
  // L05 (migration 0031): a plan's state; its identity is fixed, archived is final, the version
  // only goes up (SDA23). Versions and resolved configurations are append-only.
  evaluation_plans: [
    'current_version',
    'status',
    'pause_reason',
    'paused_until',
    'next_run_at',
    'seen_sha256',
    'updated_at',
    // Migration 0032: a person's Run now and the worker's last refusal (QUESTIONS #476).
    'run_requested_at',
    'run_requested_by',
    'last_refusal',
    'last_refusal_at',
  ],
  evaluation_plan_versions: [],
  evaluation_configurations: [],
  // L07 (migration 0033): a task's card reference and state; its identity is fixed, gone is final
  // (SDA24). Review decisions are append-only.
  evaluation_tasks: [
    'card_commit',
    'card_sha256',
    'base_commit',
    'merge_commit',
    'status',
    'check_code',
    'updated_at',
    // Migration 0034: the hand-overs of a check.
    'check_attempt',
  ],
  evaluation_task_decisions: [],
  evaluation_task_check_contracts: [],
  // X04 PR 3a (migration 0039): an index's use and purge dates (trigger SDA26); its uses are
  // append-only.
  knowledge_indexes: ['last_used_at', 'purged_at'],
  knowledge_index_uses: [],
  // Append-only (X13, migration 0053): approved and revoked agent memory sets.
  project_memory_versions: [],
  project_memory_revocations: [],
  // X13 PR 3b (migration 0055): the memory loop moves a proposal's state; trigger SDA30.
  memory_proposals: ['state', 'pr_number', 'version', 'cause', 'updated_at'],
  // X08b (migration 0057): append-only.
  intent_lessons: [],
  intent_lesson_outcomes: [],
  // U05 (migration 0027): seen time only grows; the end is set once (trigger SDA18). No DELETE.
  web_sessions: ['last_seen_at', 'revoked_at', 'end_reason'],
  // U06 (migration 0028): the counter and the last use only grow; revoked once (SDA20). No DELETE.
  webauthn_credentials: ['sign_count', 'last_used_at', 'revoked_at', 'revoked_by'],
  // U06: a challenge is used once, before it expires (SDA19). No DELETE (QUESTIONS #412).
  passkey_challenges: ['used_at'],
};

describeDb('AC2: migrations on PostgreSQL', () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await createTestDatabase();
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  });

  const rows = async <T>(query: ReturnType<typeof sql<T>>) => (await query.execute(t.owner)).rows;

  it('applies every migration and records it', async () => {
    const status = await migrationStatus(t.owner);
    expect(status.map((m) => m.name)).toEqual(Object.keys(MIGRATIONS));
    expect(status.every((m) => m.executedAt instanceof Date)).toBe(true);
  });

  it('creates exactly the tables of the schema model, with the same columns in order (no drift)', async () => {
    const tables = await rows<{ table_name: string }>(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name NOT LIKE 'kysely_%' ORDER BY table_name`);
    expect(tables.map((r) => r.table_name)).toEqual(TABLES);
    for (const [table, columns] of Object.entries(TABLE_COLUMNS)) {
      const actual = await rows<{ column_name: string }>(sql`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ${table} ORDER BY ordinal_position`);
      expect(
        actual.map((r) => r.column_name),
        table,
      ).toEqual([...columns]);
    }
  });

  it('gives every table except tenants tenant_id uuid NOT NULL, and every table created_at', async () => {
    const cols = await rows<{
      table_name: string;
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(sql`
      SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name IN ('tenant_id', 'created_at')`);
    for (const table of TABLES) {
      const createdAt = cols.find((c) => c.table_name === table && c.column_name === 'created_at');
      expect(createdAt, table).toMatchObject({
        data_type: 'timestamp with time zone',
        is_nullable: 'NO',
        column_default: 'now()',
      });
      const tenantId = cols.find((c) => c.table_name === table && c.column_name === 'tenant_id');
      if (table === 'tenants') expect(tenantId).toBeUndefined();
      else expect(tenantId, table).toMatchObject({ data_type: 'uuid', is_nullable: 'NO' });
    }
  });

  it('creates only the enums used now, with the canonical values', async () => {
    const enums = await rows<{ name: string; values: string[] }>(sql`
      SELECT t.typname AS name, array_agg(e.enumlabel ORDER BY e.enumsortorder)::text[] AS values
      FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
      JOIN pg_namespace n ON n.oid = t.typnamespace AND n.nspname = 'public'
      GROUP BY t.typname ORDER BY t.typname`);
    expect(Object.fromEntries(enums.map((e) => [e.name, e.values]))).toEqual(
      Object.fromEntries(Object.entries(DB_ENUMS).map(([k, v]) => [k, [...v]])),
    );
  });

  it('the registry enums match the @sdlc/contracts lists (B02)', async () => {
    const enums = await rows<{ name: string; values: string[] }>(sql`
      SELECT t.typname AS name, array_agg(e.enumlabel ORDER BY e.enumsortorder)::text[] AS values
      FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
      JOIN pg_namespace n ON n.oid = t.typnamespace AND n.nspname = 'public'
      GROUP BY t.typname`);
    const byName = Object.fromEntries(enums.map((e) => [e.name, e.values]));
    expect(byName).toMatchObject({
      gate_code: [...GATE_CODES],
      risk_tier: [...RISK_TIERS],
      autonomy_level: [...AUTONOMY_LEVELS],
      change_flag: [...CHANGE_FLAGS],
      intent_status: [...INTENT_STATUSES],
      gate_decision: [...GATE_DECISIONS],
      gate_check_mode: [...GATE_CHECK_MODES],
      gate_reason_code: [...GATE_REASON_CODES],
      event_source: [...EVENT_SOURCES],
    });
    // Oversight modes alone are not stored anywhere yet, so that enum does not exist.
    expect(byName.oversight_mode).toBeUndefined();
  });

  it('the data_class, project_role and actor_type enums match the @sdlc/contracts lists', async () => {
    // The migrations keep literal values (ADR-M09 section 2.2); this catches drift from contracts.
    const enums = await rows<{ name: string; values: string[] }>(sql`
      SELECT t.typname AS name, array_agg(e.enumlabel ORDER BY e.enumsortorder)::text[] AS values
      FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
      JOIN pg_namespace n ON n.oid = t.typnamespace AND n.nspname = 'public'
      WHERE t.typname IN ('data_class', 'project_role', 'actor_type')
      GROUP BY t.typname`);
    const byName = Object.fromEntries(enums.map((e) => [e.name, e.values]));
    expect(byName.data_class).toEqual([...DATA_CLASSES]);
    expect(byName.project_role).toEqual([...PROJECT_ROLES]);
    expect(byName.actor_type).toEqual([...ACTOR_TYPES]);
  });

  it('D-05 D2: every foreign key between tenant tables includes tenant_id on both sides', async () => {
    const fks = await rows<{
      name: string;
      child: string;
      parent: string;
      child_cols: string[];
      parent_cols: string[];
      on_delete: string;
    }>(sql`
      SELECT c.conname AS name, c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent,
        (SELECT array_agg(a.attname ORDER BY k.ord)::text[] FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord)
          JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS child_cols,
        (SELECT array_agg(a.attname ORDER BY k.ord)::text[] FROM unnest(c.confkey) WITH ORDINALITY k(attnum, ord)
          JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum) AS parent_cols,
        c.confdeltype AS on_delete
      FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace AND n.nspname = 'public'
      WHERE c.contype = 'f' AND c.conrelid::regclass::text NOT LIKE 'kysely_%'`);
    // C03: cost_records → projects, intents, runs; B06: receipts → projects, gate_decisions;
    // B11: escalations → intents, runs, users ×4; notices → escalations; receipts → escalations.
    // C10: agents → users; runs → agents.
    // B07: intent_notices → intents, gate_decisions.
    // B12: project_ai_record_versions → project_ai_records, users.
    // C06: intent_notices → agents; evidence_items → intents, runs (session 2b).
    // B13: tenant_role_bindings → tenants, users; agent_approvals → agents, users.
    // B09: plans → users (submitted_by).
    // E02: evidence_packs → intents, users (built_by).
    // E05: evidence_holds → intents, users ×2 (held_by, released_by).
    // E08: langfuse_purges → intents.
    // U05: web_sessions → users, user_identities.
    // U06: webauthn_credentials → users ×2 (user_id, revoked_by); passkey_challenges → users,
    // web_sessions, intents, escalations.
    // L04: evaluations → projects, users; evaluation_runs → evaluations; evaluation_run_results →
    // evaluation_runs; cost_records → evaluation_runs; evaluation_run_contracts → evaluation_runs.
    // L05: evaluation_plans → projects, users; evaluation_plan_versions → evaluation_plans, users;
    // evaluations → evaluation_plans; evaluation_configurations → evaluations, agents;
    // evaluation_plans → users (run_requested_by, migration 0032).
    // L07: evaluation_tasks → projects, intents, users; evaluation_task_decisions →
    // evaluation_tasks, users; evaluation_task_check_contracts → evaluation_tasks (0034).
    // L09: agent_approvals → evaluations (0036).
    // X04: tools → users; tool_approvals → tools, users (0038).
    // X04 PR 3a: knowledge_indexes → projects; knowledge_index_uses → knowledge_indexes, runs,
    // intents (0039).
    // X13: project_memory_versions → projects, users, intents, runs; project_memory_revocations →
    // project_memory_versions (by version), users (0053).
    // X13 PR 3b: memory_proposals → projects, intents, runs (0055).
    // X08b: intent_lessons → projects, intents, users; intent_lesson_outcomes → intent_lessons,
    // users, intents (the follow-up) (0057).
    expect(fks).toHaveLength(109);
    for (const fk of fks) {
      expect(fk.on_delete, fk.name).toBe('r'); // RESTRICT: no hard deletes (D-05 D7)
      if (fk.name === 'gate_decisions_voids_fkey') {
        // A void cancels an approval of the same tenant, intent and gate (ADR-M20).
        expect([fk.child_cols, fk.parent_cols]).toEqual([
          ['tenant_id', 'intent_id', 'gate', 'voids_decision_id'],
          ['tenant_id', 'intent_id', 'gate', 'id'],
        ]);
      } else if (fk.name === 'project_ai_record_versions_record_fkey') {
        // The AI record's key is its project (1–1, D-05 §6.1); the history refers to it (B12).
        expect([fk.child_cols, fk.parent_cols]).toEqual([
          ['tenant_id', 'project_id'],
          ['tenant_id', 'project_id'],
        ]);
      } else if (fk.name === 'project_memory_revocations_version_fkey') {
        // A revocation names the project's version number (X13, D-05 §6.11).
        expect([fk.child_cols, fk.parent_cols]).toEqual([
          ['tenant_id', 'project_id', 'version'],
          ['tenant_id', 'project_id', 'version'],
        ]);
      } else if (fk.parent === 'tenants') {
        expect([fk.child_cols, fk.parent_cols], fk.name).toEqual([['tenant_id'], ['id']]);
      } else {
        expect(fk.child_cols[0], fk.name).toBe('tenant_id');
        expect(fk.parent_cols, fk.name).toEqual(['tenant_id', 'id']);
      }
    }
    // Every tenant table that has no composite parent references tenants directly.
    for (const table of ['projects', 'users', 'audit_log', 'tenant_role_bindings']) {
      expect(
        fks.some((fk) => fk.child === table && fk.parent === 'tenants'),
        table,
      ).toBe(true);
    }
  });

  it('has the unique constraints of D-05 section 9 and the approved additions', async () => {
    const indexes = await rows<{ indexname: string; indexdef: string }>(sql`
      SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexdef LIKE 'CREATE UNIQUE%'`);
    const defs = indexes.map((i) =>
      i.indexdef.replace(/^.* USING btree /, `${i.indexdef.split(' ON ')[1]!.split(' ')[0]} `),
    );
    for (const expected of [
      'public.tenants (slug)',
      'public.projects (tenant_id, slug)',
      'public.users (tenant_id, lower(email))',
      // B13: only linked identities are unique, so an account can be linked again.
      'public.user_identities (tenant_id, provider, external_id) WHERE (unlinked_at IS NULL)',
      'public.tenant_role_bindings (tenant_id, user_id, role) WHERE (revoked_at IS NULL)',
      'public.role_bindings (tenant_id, user_id, project_id, role) WHERE (revoked_at IS NULL)',
      'public.api_tokens (token_hash)',
      'public.intents (tenant_id, code)',
      'public.spec_refs (tenant_id, intent_id, version)',
      'public.plans (tenant_id, intent_id, version)',
      'public.gate_decisions (tenant_id, voids_decision_id) WHERE (voids_decision_id IS NOT NULL)',
      'public.agents (tenant_id, agent_key)',
      // E02: one row per build; one sealed version per intent (E03).
      'public.evidence_packs (tenant_id, intent_id, version)',
      'public.evidence_packs (tenant_id, intent_id) WHERE (sealed_at IS NOT NULL)',
      // E05: one active hold per intent.
      'public.evidence_holds (tenant_id, intent_id) WHERE (released_at IS NULL)',
      // U05: the cookie names no tenant: the secret's hash is unique across tenants.
      'public.web_sessions (secret_sha256)',
      // U06: a passkey and a challenge are unique across tenants.
      'public.webauthn_credentials (credential_id)',
      'public.passkey_challenges (challenge_sha256)',
    ]) {
      expect(defs, expected).toContain(expected);
    }
  });

  it('api_tokens has no column for the raw token and only accepts a SHA-256 hex hash', async () => {
    expect(TABLE_COLUMNS.api_tokens).not.toContain('token');
    const checks = await rows<{ def: string }>(sql`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'api_tokens'::regclass AND contype = 'c'`);
    expect(checks.map((c) => c.def).join('\n')).toMatch(/token_hash.*\[0-9a-f\]\{64\}/);
  });

  it('platform_app: SELECT and INSERT; UPDATE only on mutable columns; never DELETE, TRUNCATE or DDL', async () => {
    for (const table of TABLES) {
      const [p] = await rows<Record<string, boolean>>(sql`
        SELECT has_table_privilege('platform_app', ${`public.${table}`}, 'SELECT') AS select,
               has_table_privilege('platform_app', ${`public.${table}`}, 'INSERT') AS insert,
               has_table_privilege('platform_app', ${`public.${table}`}, 'UPDATE') AS update,
               has_table_privilege('platform_app', ${`public.${table}`}, 'DELETE') AS delete,
               has_table_privilege('platform_app', ${`public.${table}`}, 'TRUNCATE') AS truncate,
               has_table_privilege('platform_app', ${`public.${table}`}, 'TRIGGER') AS trigger,
               has_table_privilege('platform_app', ${`public.${table}`}, 'REFERENCES') AS references`);
      expect(p, table).toEqual({
        select: true,
        insert: true,
        update: false,
        delete: false,
        truncate: false,
        trigger: false,
        references: false,
      });
      const updatable = await rows<{ column_name: string }>(sql`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ${table}
          AND has_column_privilege('platform_app', ${`public.${table}`}, column_name, 'UPDATE')
        ORDER BY ordinal_position`);
      expect(
        updatable.map((c) => c.column_name),
        table,
      ).toEqual(UPDATABLE[table]);
    }
    await expect(sql`DELETE FROM users`.execute(t.appRaw)).rejects.toMatchObject({ code: '42501' });
    await expect(sql`TRUNCATE users`.execute(t.appRaw)).rejects.toMatchObject({ code: '42501' });
    await expect(sql`CREATE TABLE x (id int)`.execute(t.appRaw)).rejects.toMatchObject({
      code: '42501',
    });
    await expect(sql`SELECT * FROM kysely_migration`.execute(t.appRaw)).rejects.toMatchObject({
      code: '42501',
    });
    await expect(
      sql`UPDATE users SET tenant_id = gen_random_uuid()`.execute(t.appRaw),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('migrating again does nothing; down and up again work (development only)', async () => {
    const again = await migrateToLatest(t.owner);
    expect(again.error).toBeUndefined();
    expect(again.results).toEqual([]);
    for (const name of Object.keys(MIGRATIONS).reverse()) {
      const down = await migrateDown(t.owner);
      expect(down.error, name).toBeUndefined();
    }
    const tables = await rows<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name NOT LIKE 'kysely_%'`);
    expect(tables[0]!.n).toBe(0);
    const up = await migrateToLatest(t.owner);
    expect(up.error).toBeUndefined();
    expect(up.results?.map((r) => r.status)).toEqual(Object.keys(MIGRATIONS).map(() => 'Success'));
  });
});
