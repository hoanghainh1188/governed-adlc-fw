// H08 PR 3b (design/ADR-M111 §2.2): what an active break-glass grant changes, with a fake scope.
// `runner_priority` puts a run first only while the grant is active, only for the operator's run or
// a run the platform started by itself (never one another person allowed); `hotl_window_skip`
// ends the G2 and G3 windows only.
import { describe, expect, it } from 'vitest';

import {
  breakGlassRunPriority,
  grantWithScope,
  SKIPPABLE_WINDOW_GATES,
} from '../../packages/core/src/break-glass/active.js';
import type { BreakGlassGrant, Run } from '../../packages/core/src/db/schema.js';
import type { TenantScope } from '../../packages/core/src/db/tenant-scope.js';

const NOW = new Date('2026-11-16T03:00:00.000Z');
const OPERATOR = '00000000-0000-4000-8000-0000000000a1';
const OTHER = '00000000-0000-4000-8000-0000000000b1';

function grant(extra: Partial<BreakGlassGrant> = {}): BreakGlassGrant {
  return {
    id: 'g1',
    tenant_id: 't1',
    project_id: 'p1',
    intent_id: 'i1',
    operator_id: OPERATOR,
    scopes: ['runner_priority'],
    duration_seconds: 3600,
    budget_increase_usd: null,
    reason_url: 'https://github.com/acme/shop/issues/1#issuecomment-1',
    status: 'active',
    created_at: NOW,
    lapses_at: NOW,
    approver_id: OTHER,
    decided_at: NOW,
    expires_at: new Date(NOW.getTime() + 3_600_000),
    escalation_id: 'e1',
    ended_at: null,
    revoked_by: null,
    review_url: null,
    reviewed_by: null,
    reviewed_at: null,
    review_overdue_at: null,
    ...extra,
  };
}

function scopeWith(open: BreakGlassGrant | undefined, triggeredBy: string | null): TenantScope {
  return {
    breakGlass: { openForIntent: () => Promise.resolve(open) },
    runs: {
      getById: (id: string) =>
        Promise.resolve(
          id === 'r1'
            ? ({ id: 'r1', intent_id: 'i1', triggered_by: triggeredBy } as Run)
            : undefined,
        ),
    },
  } as unknown as TenantScope;
}

describe('runner_priority', () => {
  it.each([
    ['the operator allowed the run', grant(), OPERATOR, true],
    ['the platform started it (G4 by policy)', grant(), null, true],
    ['another person allowed it', grant(), OTHER, false],
    ['the grant names another scope', grant({ scopes: ['budget'] }), OPERATOR, false],
    ['the grant expired', grant({ expires_at: NOW }), OPERATOR, false],
    [
      'the grant is only requested',
      grant({ status: 'requested', expires_at: null }),
      OPERATOR,
      false,
    ],
    ['no grant', undefined, OPERATOR, false],
  ] as const)('%s → %s', async (_name, open, by, expected) => {
    expect(await breakGlassRunPriority(scopeWith(open, by), 'r1', NOW)).toBe(expected);
  });

  it('an unknown run never goes first', async () => {
    expect(await breakGlassRunPriority(scopeWith(grant(), OPERATOR), 'r2', NOW)).toBe(false);
  });
});

describe('hotl_window_skip', () => {
  it('ends only the windows of G2 and G3', () => {
    expect(SKIPPABLE_WINDOW_GATES).toEqual(['G2', 'G3']);
  });

  it('applies to the intent while the grant is active', async () => {
    const skip = grant({ scopes: ['hotl_window_skip'] });
    expect(await grantWithScope(scopeWith(skip, null), 'i1', NOW, 'hotl_window_skip')).toBe(skip);
    const later = new Date(NOW.getTime() + 3_600_000);
    expect(await grantWithScope(scopeWith(skip, null), 'i1', later, 'hotl_window_skip')).toBe(
      undefined,
    );
  });
});
