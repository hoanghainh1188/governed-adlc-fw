// Migration 0054: the evidence kind `memory_diff` (design/D-05 section 6.6, version 1.63; D-08
// X13 PR 3a; design/ADR-M74 §2.5, 0.4; QUESTIONS #716). Rules for every migration: see the header
// of 0001-tenancy.ts and design/ADR-M09. Migrations 0001–0053 are merged and never edited.
//
// - `memory_diff`: the memory part of a run's change (`.sdlc/memory/<name>.md` files only), split
//   out of the run's diff by the runner when the project's `memory.mode` is `read_propose`. Stored
//   in the diffs store next to the run's `diff`; the runner pushes it to the run's memory branch
//   after G5. The run event `memory_proposed` holds its SHA-256 and counts, never a path or a text.
import { defineMigration } from './define.js';

const KINDS = `('spec', 'plan', 'proposal', 'diff', 'ci_result', 'test_report', 'scan_report',
  'review', 'cost_summary', 'disclosure_note', 'knowledge_read', 'context_snapshot', 'memory_diff')`;

const OLD_KINDS = `('spec', 'plan', 'proposal', 'diff', 'ci_result', 'test_report', 'scan_report',
  'review', 'cost_summary', 'disclosure_note', 'knowledge_read', 'context_snapshot')`;

export const migration0054MemoryDiffEvidence = defineMigration({
  up: [
    `ALTER TABLE evidence_items DROP CONSTRAINT evidence_items_kind_check`,
    `ALTER TABLE evidence_items ADD CONSTRAINT evidence_items_kind_check CHECK (kind IN ${KINDS})`,
  ],
  down: [
    `ALTER TABLE evidence_items DROP CONSTRAINT evidence_items_kind_check`,
    `ALTER TABLE evidence_items ADD CONSTRAINT evidence_items_kind_check CHECK (kind IN ${OLD_KINDS})`,
  ],
});
