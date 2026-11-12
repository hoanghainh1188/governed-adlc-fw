// C07 PR 2 (ADR-M34 §2.8): the order of the G5 checks and the share of the cap spent, without a
// database. Behaviour on PostgreSQL: tests/integration/db/gate-g5.test.ts.
import { loadProjectConfig } from '@sdlc/config';
import type { RunStatus, ValidatedProjectConfig } from '@sdlc/contracts';
import { describe, expect, it } from 'vitest';

import type { Run } from '../../packages/core/src/db/schema.js';
import {
  reviewSizeOf,
  spentPercent,
  type G5Facts,
  type G5SecretScan,
} from '../../packages/core/src/workflow/g5-facts.js';
import { allowsReviewSize, g5Breach, reviewHold } from '../../packages/core/src/workflow/g5.js';

const loaded = loadProjectConfig('');
if (!loaded.ok) throw new Error('default configuration refused');
const CONFIG: ValidatedProjectConfig = loaded.config;

function facts(
  status: RunStatus,
  stopReason: string | null,
  changes: { out?: number; instructions?: number; outside?: number } | null = {},
  spentUsd = '0',
  secrets: G5SecretScan | null = { result: 'clean', findings: 0 },
): G5Facts {
  return {
    run: { status, stop_reason: stopReason } as Run,
    diffSha256: 'd'.repeat(64),
    changes:
      changes === null
        ? null
        : {
            changedFiles: 3,
            outOfScope: changes.out ?? 0,
            instructionFiles: changes.instructions ?? 0,
            outsideFolder: changes.outside ?? 0,
            pathsSha256: 'a'.repeat(64),
          },
    secrets,
    review: { files: 3, lines: 40 },
    keyCapUsd: '2',
    spentUsd,
    intentSpentUsd: spentUsd,
    inputSha256: 'f'.repeat(64),
  };
}

const check = (f: G5Facts) => {
  const breach = g5Breach(f, CONFIG);
  return breach && [breach.reason, breach.check, breach.escalation?.route ?? null];
};

describe('g5Breach: instruction files, then scope, then caps', () => {
  it('passes a succeeded run in scope within its cap', () => {
    expect(check(facts('succeeded', null))).toBeNull();
  });

  it('O06: a change outside the project folder fails like scope, after the instruction files', () => {
    expect(check(facts('succeeded', null, { outside: 1 }))).toEqual([
      'out_of_scope',
      'outside_project_path',
      null,
    ]);
    expect(check(facts('succeeded', null, { outside: 1, out: 2 }))?.[1]).toBe(
      'outside_project_path',
    );
    expect(check(facts('succeeded', null, { outside: 1, instructions: 1 }))?.[1]).toBe(
      'instructions_changed',
    );
  });

  it('instruction files come first, even with files out of scope and a budget stop', () => {
    expect(check(facts('stopped_budget', 'max_budget', { out: 2, instructions: 1 }))).toEqual([
      'instructions_unpinned',
      'instructions_changed',
      'security',
    ]);
  });

  it('H04: a secret in the added lines holds the run with a security escalation, before scope and caps', () => {
    const found = { result: 'found', findings: 2 } as const;
    expect(check(facts('stopped_budget', 'max_budget', { out: 2 }, '0', found))).toEqual([
      'secret_in_diff',
      'secret_found',
      'security',
    ]);
    // Instruction files still come first.
    expect(check(facts('succeeded', null, { instructions: 1 }, '0', found))).toEqual([
      'instructions_unpinned',
      'instructions_changed',
      'security',
    ]);
  });

  it('H04: a failed or missing scan holds the run with a technical escalation (QUESTIONS #587, #590)', () => {
    const failed = { result: 'failed', findings: 0 } as const;
    expect(check(facts('succeeded', null, {}, '0', failed))).toEqual([
      'secret_scan_failed',
      'secret_scan_failed',
      'technical',
    ]);
    expect(check(facts('succeeded', null, { out: 1 }, '0', null))).toEqual([
      'secret_scan_failed',
      'secret_scan_failed',
      'technical',
    ]);
  });

  it('scope comes before the caps; it never escalates (back to G3)', () => {
    expect(check(facts('stopped_budget', 'max_budget', { out: 1 }))).toEqual([
      'out_of_scope',
      'out_of_scope',
      null,
    ]);
    expect(check(facts('stopped_scope', 'out_of_scope'))).toEqual([
      'out_of_scope',
      'out_of_scope',
      null,
    ]);
  });

  it('the cost cap is budget_exceeded; the other caps are run_cap_reached, never budget_exceeded', () => {
    expect(check(facts('stopped_budget', 'max_budget'))).toEqual([
      'budget_exceeded',
      'max_budget',
      'intent',
    ]);
    expect(check(facts('stopped_budget', 'max_iterations'))).toEqual([
      'run_cap_reached',
      'max_iterations',
      'intent',
    ]);
    expect(check(facts('stopped_timeout', 'max_duration'))).toEqual([
      'run_cap_reached',
      'max_duration',
      'intent',
    ]);
    expect(check(facts('stopped_stalled', 'agent_stuck'))).toEqual([
      'run_cap_reached',
      'stalled',
      'intent',
    ]);
  });

  it('a synced spend at the stop share is a budget breach, whatever the run status', () => {
    expect(check(facts('succeeded', null, {}, '2'))).toEqual([
      'budget_exceeded',
      'spend_at_stop',
      'intent',
    ]);
    expect(check(facts('stopped_budget', 'max_iterations', {}, '2'))).toEqual([
      'budget_exceeded',
      'spend_at_stop',
      'intent',
    ]);
    expect(check(facts('succeeded', null, {}, '1.99'))).toBeNull();
  });

  it('fails closed without the runner record of the changes', () => {
    expect(check(facts('succeeded', null, null))).toEqual([
      'input_mismatch',
      'changes_missing',
      'technical',
    ]);
  });
});

describe('spentPercent', () => {
  it('whole percent of the key cap, rounded down; null without a cap', () => {
    expect(spentPercent({ keyCapUsd: '2', spentUsd: '1.7' })).toBe(85);
    expect(spentPercent({ keyCapUsd: '3', spentUsd: '1' })).toBe(33);
    expect(spentPercent({ keyCapUsd: null, spentUsd: '1' })).toBeNull();
    expect(spentPercent({ keyCapUsd: '0', spentUsd: '1' })).toBeNull();
  });
});

describe('H05: the review size (ADR-M95)', () => {
  const measured = (payload: Record<string, unknown>) => [{ event_type: 'diff_measured', payload }];

  it('reviewSizeOf reads the last measurement; failed, missing or malformed is null (#603)', () => {
    expect(
      reviewSizeOf([
        ...measured({ result: 'measured', review_files: 1, review_lines: 1 }),
        ...measured({ result: 'measured', review_files: 41, review_lines: 7 }),
      ]),
    ).toEqual({ files: 41, lines: 7 });
    expect(reviewSizeOf(measured({ result: 'failed', cause: 'numstat_failed' }))).toBeNull();
    expect(reviewSizeOf([])).toBeNull();
    expect(reviewSizeOf(measured({ result: 'measured', review_files: '4' }))).toBeNull();
  });

  it('reviewHold reads the policy override; the cause says whether the size is known', () => {
    const held = { overrides: ['review_too_large'] as const };
    expect(reviewHold(held, { review: { files: 41, lines: 0 } })).toBe('review_too_large');
    expect(reviewHold(held, { review: null })).toBe('review_size_unknown');
    expect(reviewHold({ overrides: [] }, { review: null })).toBeNull();
  });

  it('only the allowing reason codes count for a held run (#604)', () => {
    for (const code of ['generated_change', 'mechanical_change', 'cannot_split']) {
      expect(allowsReviewSize(code)).toBe(true);
    }
    for (const code of [null, 'other', 'review_too_large', 'spec_unclear']) {
      expect(allowsReviewSize(code)).toBe(false);
    }
  });

  it('a size over the limits is never a breach (no escalation, no fail)', () => {
    expect(
      check({ ...facts('succeeded', null), review: { files: 999, lines: 99_999 } }),
    ).toBeNull();
    expect(check({ ...facts('succeeded', null), review: null })).toBeNull();
  });
});
