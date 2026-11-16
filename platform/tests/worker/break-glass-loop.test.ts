// H08 PR 3b (design/ADR-M111 §2.5): the worker's break-glass loop passes over every tenant, logs
// counts only when something moved, and an error in one tenant never stops the others.
import { describe, expect, it } from 'vitest';

import { BreakGlassLoop, type BreakGlassLoopDeps } from '../../apps/worker/src/break-glass-loop.js';

type TenantId = Parameters<BreakGlassLoopDeps['pass']>[0];

const NOW = new Date('2026-11-16T03:00:00.000Z');
const A = '00000000-0000-4000-8000-00000000000a' as TenantId;
const B = '00000000-0000-4000-8000-00000000000b' as TenantId;

describe('BreakGlassLoop', () => {
  it('runs the pass for every tenant and logs codes and counts only', async () => {
    const seen: string[] = [];
    const logs: [string, string, Record<string, unknown>][] = [];
    const loop = new BreakGlassLoop({
      listTenants: () => Promise.resolve([A, B]),
      pass: (tenant, now) => {
        seen.push(tenant);
        expect(now).toBe(NOW);
        if (tenant === A) return Promise.reject(Object.assign(new Error('x'), { code: 'db_down' }));
        return Promise.resolve({ expired: 1, lapsed: 0, reviewOverdue: 2 });
      },
      now: () => NOW,
      logger: { log: (level, event, fields) => logs.push([level, event, fields ?? {}]) },
    });
    await loop.tick();
    expect(seen).toEqual([A, B]);
    expect(logs).toEqual([
      ['error', 'worker.break_glass_failed', { tenant_id: A, error: 'db_down' }],
      [
        'info',
        'worker.break_glass_pass',
        { tenant_id: B, expired: 1, lapsed: 0, review_overdue: 2 },
      ],
    ]);
  });

  it('logs nothing when nothing moved', async () => {
    const logs: unknown[] = [];
    const loop = new BreakGlassLoop({
      listTenants: () => Promise.resolve([A]),
      pass: () => Promise.resolve({ expired: 0, lapsed: 0, reviewOverdue: 0 }),
      now: () => NOW,
      logger: { log: (...args) => logs.push(args) },
    });
    await loop.tick();
    expect(logs).toEqual([]);
  });
});
