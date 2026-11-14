// X13 PR 3b (design/ADR-M74 0.5 §2.5): the memory loop steps each item of its batch in the item's
// tenant, keeps going when one fails, and logs codes and IDs only. The steps themselves:
// tests/integration/db/memory-proposals.test.ts.
import { describe, expect, it } from 'vitest';

import { MemoryLoop, type MemoryLoopDeps } from '../../apps/worker/src/memory-loop.js';
import { currentLogContext } from '../../packages/core/src/observability/index.js';

type Work = Awaited<ReturnType<MemoryLoopDeps['listWork']>>[number];

const TENANT = '00000000-0000-4000-8000-000000000001' as Work['tenantId'];
const run = (id: string): Work => ({ tenantId: TENANT, kind: 'run', runId: id });
const proposal = (id: string): Work => ({ tenantId: TENANT, kind: 'proposal', proposalId: id });

function harness(items: Work[], outcome: Awaited<ReturnType<MemoryLoopDeps['step']>>) {
  const stepped: unknown[] = [];
  const contexts: unknown[] = [];
  const listed: number[] = [];
  const logs: { level: string; event: string; fields: Record<string, unknown> }[] = [];
  const loop = new MemoryLoop({
    listWork: (limit) => {
      listed.push(limit);
      return Promise.resolve(items.slice(0, limit));
    },
    step: (item) => {
      stepped.push(item);
      contexts.push(currentLogContext());
      if (item.kind === 'proposal' && item.proposalId === 'bad') {
        return Promise.reject(Object.assign(new Error('git'), { code: 'network_error' }));
      }
      return Promise.resolve(outcome);
    },
    logger: { log: (level, event, fields) => logs.push({ level, event, fields: { ...fields } }) },
    batchSize: 2,
  });
  return { loop, stepped, contexts, listed, logs };
}

describe('memory loop', () => {
  it('steps one batch in each item tenant and logs the outcome codes', async () => {
    const h = harness([run('r1'), proposal('p1'), proposal('p2')], 'opened');
    await h.loop.tick();
    expect(h.listed).toEqual([2]);
    expect(h.stepped).toEqual([run('r1'), proposal('p1')]);
    expect(h.contexts).toEqual([{ tenantId: TENANT }, { tenantId: TENANT }]);
    expect(h.logs).toEqual([
      {
        level: 'info',
        event: 'worker.memory_step',
        fields: { tenant_id: TENANT, run_id: 'r1', outcome: 'opened' },
      },
      {
        level: 'info',
        event: 'worker.memory_step',
        fields: { tenant_id: TENANT, proposal_id: 'p1', outcome: 'opened' },
      },
    ]);
  });

  it('a failed item is logged with a code and the next one still runs; waiting is not logged', async () => {
    const h = harness([proposal('bad'), proposal('p2')], 'waiting');
    await h.loop.tick();
    expect(h.stepped).toHaveLength(2);
    expect(h.logs).toEqual([
      {
        level: 'warn',
        event: 'worker.memory_step_failed',
        fields: { tenant_id: TENANT, proposal_id: 'bad', error: 'network_error' },
      },
    ]);
  });
});
