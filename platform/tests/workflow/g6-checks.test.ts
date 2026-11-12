// D-08 C08 AC2, QUESTIONS #159, design/ADR-M38 §2.7: how G6 maps check results. Passed: success,
// neutral, skipped. Failed: failure, error, timed_out. Pending: not finished, cancelled, stale,
// action_required, a required check that is missing, or no check at all.
import type { CheckItem } from '@sdlc/contracts';
import { describe, expect, it } from 'vitest';

import { evaluateChecks } from '../../packages/core/src/workflow/g6-ci.js';

let id = 0;
function check(
  name: string,
  conclusion: CheckItem['conclusion'],
  source: CheckItem['source'] = 'check_run',
): CheckItem {
  id += 1;
  return { source, id: String(id), name, completed: conclusion !== null, conclusion };
}

describe('evaluateChecks (QUESTIONS #159)', () => {
  it.each(['success', 'neutral', 'skipped'] as const)('%s passes', (conclusion) => {
    expect(evaluateChecks([check('ci-ok', conclusion)], []).state).toBe('passed');
  });

  it.each(['failure', 'error', 'timed_out'] as const)('%s fails', (conclusion) => {
    expect(evaluateChecks([check('lint', 'success'), check('test', conclusion)], []).state).toBe(
      'failed',
    );
  });

  it.each(['cancelled', 'stale', 'action_required', null] as const)(
    '%s is pending (a person may run it again)',
    (conclusion) => {
      expect(evaluateChecks([check('test', conclusion)], []).state).toBe('pending');
    },
  );

  it('no check at all is missing: a repository without CI never passes G6 (O06 AC3)', () => {
    expect(evaluateChecks([], []).state).toBe('missing');
    // Required names do not change it: the commit has no check of any name.
    expect(evaluateChecks([], ['ci-ok']).state).toBe('missing');
  });

  it('a check of another name than the required one is pending, not missing', () => {
    expect(evaluateChecks([check('lint', 'success')], ['ci-ok']).state).toBe('pending');
  });

  it('a failure wins over pending checks', () => {
    expect(evaluateChecks([check('a', null), check('b', 'failure')], []).state).toBe('failed');
  });

  it('required checks: only the named ones count; a missing one is pending', () => {
    const checks = [check('ci-ok', 'success'), check('nightly', 'failure')];
    expect(evaluateChecks(checks, ['ci-ok']).state).toBe('passed');
    expect(evaluateChecks(checks, ['ci-ok', 'deploy-preview']).state).toBe('pending');
  });

  it('a status and a check run with the same required name: the worse one counts', () => {
    const checks = [check('ci-ok', 'success'), check('ci-ok', 'failure', 'status')];
    expect(evaluateChecks(checks, ['ci-ok']).state).toBe('failed');
  });

  it('the hash covers names and outcomes, in any order; it never holds a name', () => {
    const a = evaluateChecks([check('lint', 'success'), check('test', 'success')], []);
    const b = evaluateChecks([check('test', 'success'), check('lint', 'success')], []);
    const c = evaluateChecks([check('lint', 'success'), check('test', null)], []);
    expect(a.checksSha256).toBe(b.checksSha256);
    expect(a.checksSha256).not.toBe(c.checksSha256);
    expect(a.checksSha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
