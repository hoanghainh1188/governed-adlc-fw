// Migration 0052: the tool permission `read_code` (task X06 PR 2, design/D-05 §6.1 version 1.72,
// ADR-M108 §2.8, ADR-M69 §2.2). Rules for every migration: see the header of 0001-tenancy.ts and
// design/ADR-M09. Migrations 0001–0051 are merged and never edited.
//
// - `tools.permissions` may hold `read_code` besides `read_documents` (the catalogue of
//   `@sdlc/contracts`), never both: a tool reads one index with one login.
import { defineMigration } from './define.js';

function check(catalogue: string, oneIndex: boolean): string {
  const both = oneIndex
    ? `\n       AND NOT (permissions @> ARRAY['read_code', 'read_documents'])`
    : '';
  return `ALTER TABLE tools ADD CONSTRAINT tools_permissions_check CHECK (
       cardinality(permissions) >= 1
       AND permissions <@ ${catalogue}
       AND tool_codes_are_distinct(permissions, '^[a-z_]+$', 10)${both})`;
}

export const migration0052ReadCodePermission = defineMigration({
  up: [
    `ALTER TABLE tools DROP CONSTRAINT tools_permissions_check`,
    check(`ARRAY['read_code', 'read_documents']`, true),
  ],
  // Development only (ADR-M09).
  down: [
    `ALTER TABLE tools DROP CONSTRAINT tools_permissions_check`,
    check(`ARRAY['read_documents']`, false),
  ],
});
