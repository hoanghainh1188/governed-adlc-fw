// H03b (ADR-M97): client-deletion grace clock and purgeDecision cause.
import { describe, expect, it } from 'vitest';

import {
  clientDeletionDue,
  DEFAULT_CLIENT_DELETION_GRACE_DAYS,
} from '../../packages/core/src/retention/client-purge-pass.js';
import { addDays, purgeDecision } from '../../packages/core/src/retention/rules.js';

const T0 = new Date('2026-01-01T00:00:00.000Z');

describe('H03b: client deletion grace', () => {
  it('defaults to 14 days and is due on day 14, not day 13', () => {
    expect(DEFAULT_CLIENT_DELETION_GRACE_DAYS).toBe(14);
    expect(clientDeletionDue(addDays(T0, 13), T0, 14)).toBe(false);
    expect(clientDeletionDue(addDays(T0, 14), T0, 14)).toBe(true);
    expect(clientDeletionDue(addDays(T0, 14), null, 14)).toBe(false);
  });
});

describe('H03b: purgeDecision client_deletion', () => {
  const base = {
    now: T0,
    intentStatus: 'done',
    intentUpdatedAt: T0,
    createdAt: T0,
    held: false,
    retentionDays: null as number | null,
    archivePurgeDue: false,
  };

  it('purges finished not-held rows with cause client_deletion before 180 days', () => {
    expect(purgeDecision({ ...base, clientDeletionDue: true })).toEqual({
      purge: true,
      cause: 'client_deletion',
    });
  });

  it('keeps open and held intents even when client deletion is due', () => {
    expect(purgeDecision({ ...base, clientDeletionDue: true, intentStatus: 'running' })).toEqual({
      purge: false,
      reason: 'open',
    });
    expect(purgeDecision({ ...base, clientDeletionDue: true, held: true })).toEqual({
      purge: false,
      reason: 'held',
    });
  });
});
