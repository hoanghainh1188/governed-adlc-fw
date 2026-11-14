// D-08 W01 AC3 (R030a in design/RULES.md): every append-only table refuses UPDATE, DELETE and
// TRUNCATE with database triggers (D-05). One list for all of them, checked against the SQL the
// migrations run; a table with such a trigger that is missing from the list fails too.
import { describe, expect, it } from 'vitest';

import { APPEND_ONLY_TABLES } from '../../deploy/doctor/src/commands.js';
import { MIGRATIONS } from '../../packages/core/src/db/migrations/index.js';

const upSql = Object.values(MIGRATIONS)
  .flatMap((m) => m.statements.up)
  .join(';\n');

/** The append-only tables of CLAUDE.md ("and any later one"). */
const APPEND_ONLY = [
  'audit_log',
  'gate_decisions',
  'run_events',
  'cost_records',
  'project_ai_record_versions',
  'agent_approvals',
  'tool_approvals',
  'evaluation_run_contracts',
  'evaluation_run_results',
  'evaluation_plan_versions',
  'evaluation_configurations',
  'evaluation_task_decisions',
  'evaluation_task_check_contracts',
  'knowledge_index_uses',
  'project_memory_versions',
  'project_memory_revocations',
  // X08b (migration 0057).
  'intent_lessons',
  'intent_lesson_outcomes',
];

const trigger = (event: string, table: string) =>
  new RegExp(`CREATE TRIGGER \\w+\\s+BEFORE\\s+${event}\\s+ON\\s+${table}\\b`);

describe('W01: append-only tables (R030a)', () => {
  it.each(APPEND_ONLY)('%s refuses UPDATE, DELETE and TRUNCATE', (table) => {
    expect(upSql).toMatch(trigger('UPDATE\\s+OR\\s+DELETE', table));
    expect(upSql).toMatch(trigger('TRUNCATE', table));
  });

  it('lists every table whose rows can be neither updated nor deleted', () => {
    const guarded = [...upSql.matchAll(/BEFORE\s+UPDATE\s+OR\s+DELETE\s+ON\s+(\w+)/g)].map(
      (m) => m[1],
    );
    expect([...new Set(guarded)].sort()).toEqual([...APPEND_ONLY].sort());
  });

  it('pnpm doctor watches the size of every one of them (O04, db.table_size)', () => {
    expect([...APPEND_ONLY_TABLES].sort()).toEqual([...APPEND_ONLY].sort());
  });
});
