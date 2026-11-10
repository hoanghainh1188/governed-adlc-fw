// H03b: RetentionLoop runs runClientPurgePass under the same advisory lock, before the anchor.
import { describe, expect, it } from 'vitest';

import type { ClientPurgePassResult } from '../../packages/core/src/retention/client-purge-pass.js';
import { RetentionLoop } from '../../apps/worker/src/retention-loop.js';

const clientPurgeCounts: ClientPurgePassResult = {
  tenantsSeen: 1,
  tenantsDue: 1,
  tenantsStarted: 1,
  tenantsBlocked: 0,
  tenantsPurged: 1,
  evidencePurged: 2,
  evidenceRefused: 0,
  knowledgeDropped: 0,
  usersAnonymized: 3,
  failed: 0,
};

describe('H03b: client purge in the retention loop', () => {
  it('runs client purge before the anchor under the same lock', async () => {
    const order: string[] = [];
    const logs: { level: string; event: string; fields: Record<string, unknown> }[] = [];
    const loop = new RetentionLoop({
      clientPurge: () => {
        order.push('clientPurge');
        return Promise.resolve({ ...clientPurgeCounts });
      },
      anchor: () => {
        order.push('anchor');
        return Promise.resolve({
          tenants: 1,
          skipped: 0,
          written: 1,
          exists: 0,
          empty: 0,
          checked: 0,
          mismatched: 0,
          unlocked: 0,
          failed: 0,
        });
      },
      withLock: async (fn) => {
        order.push('lock');
        return { ran: true, value: await fn() };
      },
      logger: { log: (level, event, fields = {}) => logs.push({ level, event, fields }) },
      mode: 'purge',
      intervalMs: 60_000,
    });
    const pass = await loop.tick();
    expect(order).toEqual(['lock', 'clientPurge', 'anchor']);
    expect(pass).toMatchObject({ outcome: 'done', clientPurge: clientPurgeCounts });
    expect(logs.find((l) => l.event === 'worker.client_purge_pass')?.fields).toMatchObject({
      tenantsPurged: 1,
      evidencePurged: 2,
    });
  });

  it('logs a failed client purge by code and never stops the retention pass', async () => {
    let purged = false;
    const logs: { level: string; event: string; fields: Record<string, unknown> }[] = [];
    const loop = new RetentionLoop({
      clientPurge: () =>
        Promise.reject(Object.assign(new Error('secret text'), { code: 'evidence_forbidden' })),
      pass: () => {
        purged = true;
        return Promise.resolve({
          eligible: 0,
          purged: 0,
          refused: 0,
          failed: 0,
          locksExtended: 0,
          holdsApplied: 0,
          holdsReleased: 0,
          guardTripped: 0,
          projectsPurged: 0,
          archivesScheduled: 0,
          orphansFound: 0,
          orphansSwept: 0,
          langfuseDue: 0,
          langfuseRequested: 0,
          langfuseConfirmed: 0,
          langfuseMismatched: 0,
          langfuseGuardTripped: 0,
          langfuseRawFound: 0,
          langfuseRawSwept: 0,
          langfuseCompacted: 0,
          knowledgeDue: 0,
          knowledgePurged: 0,
          knowledgeSwept: 0,
          orphanCursor: null,
        });
      },
      withLock: async (fn) => ({ ran: true, value: await fn() }),
      logger: { log: (level, event, fields = {}) => logs.push({ level, event, fields }) },
      mode: 'purge',
      intervalMs: 60_000,
    });
    expect(await loop.tick()).toMatchObject({ outcome: 'done', clientPurge: null });
    expect(purged).toBe(true);
    expect(logs.find((l) => l.event === 'worker.client_purge_failed')?.fields).toEqual({
      error: 'evidence_forbidden',
    });
    expect(JSON.stringify(logs)).not.toContain('secret text');
  });
});
