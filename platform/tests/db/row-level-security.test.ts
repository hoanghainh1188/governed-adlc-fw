// D-08 H09 AC1 (ADR-M110 §2.1): every table with `tenant_id` has row-level security enabled and
// forced, with the policy `tenant_isolation` for `platform_app` and `owner_all` for `platform`,
// in the SQL the migrations run. A new table in `TENANT_COLUMN` without it fails here; the live
// test (tests/integration/db/row-level-security.test.ts) also lists the tables of the database.
import { describe, expect, it } from 'vitest';

import { MIGRATIONS } from '../../packages/core/src/db/migrations/index.js';
import { TENANT_COLUMN } from '../../packages/core/src/db/schema.js';

const upSql = Object.values(MIGRATIONS)
  .flatMap((m) => m.statements.up)
  .join(';\n');

/** Tables without row-level security, and why (ADR-M110 §2.4). */
const WITHOUT_RLS: Readonly<Record<string, string>> = {
  tenants: 'the root of every tenant loop; it has no tenant_id',
};

const TENANT_TABLES = Object.entries(TENANT_COLUMN)
  .filter(([, column]) => column === 'tenant_id')
  .map(([table]) => table);

const TENANT_EXPR =
  "\\(SELECT NULLIF\\(current_setting\\('app\\.tenant_id', true\\), ''\\)::uuid\\)";

describe('H09 AC1: row-level security on every table with tenant_id', () => {
  it('covers every table of TENANT_COLUMN except the listed exceptions', () => {
    const others = Object.entries(TENANT_COLUMN)
      .filter(([, column]) => column !== 'tenant_id')
      .map(([table]) => table);
    expect(others).toEqual(Object.keys(WITHOUT_RLS));
    expect(TENANT_TABLES.length).toBeGreaterThanOrEqual(51);
  });

  it.each(TENANT_TABLES)('%s: enabled, forced, both policies', (table) => {
    expect(upSql).toMatch(new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`));
    expect(upSql).toMatch(new RegExp(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`));
    expect(upSql).toMatch(
      new RegExp(
        `CREATE POLICY tenant_isolation ON ${table} TO platform_app\\s+USING \\(tenant_id = ${TENANT_EXPR}\\) WITH CHECK \\(tenant_id = ${TENANT_EXPR}\\)`,
      ),
    );
    expect(upSql).toMatch(
      new RegExp(
        `CREATE POLICY owner_all ON ${table} TO platform USING \\(true\\) WITH CHECK \\(true\\)`,
      ),
    );
  });

  it('never grants BYPASSRLS and never turns row-level security off', () => {
    expect(upSql).not.toMatch(/BYPASSRLS/i);
    expect(upSql).not.toMatch(/DISABLE ROW LEVEL SECURITY|NO FORCE ROW LEVEL SECURITY/i);
    expect(upSql).not.toMatch(/row_security\s*=\s*off/i);
  });
});
