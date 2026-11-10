// H03c: derivePhase and legal-basis helpers (static; live flows in integration/db).
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DELETION_LEGAL_BASIS,
  derivePhase,
} from '../../packages/core/src/client-data/deletion.js';
import type { AuditLogRow } from '../../packages/core/src/db/schema.js';

function event(action: string, seq: number): AuditLogRow {
  return {
    id: String(seq),
    tenant_id: '00000000-0000-4000-8000-000000000001',
    seq: String(seq),
    occurred_at: new Date('2026-11-10T12:00:00.000Z'),
    created_at: new Date('2026-11-10T12:00:00.000Z'),
    actor_type: 'human',
    actor_id: '11111111-2222-4333-8444-555555555555',
    action,
    entity_type: 'tenant',
    entity_id: '00000000-0000-4000-8000-000000000001',
    payload: {},
    prev_hash: '0'.repeat(64),
    hash: 'a'.repeat(64),
    hash_version: 1,
  };
}

describe('H03c: derivePhase', () => {
  it('maps the audit chain and treats purged as terminal', () => {
    expect(derivePhase('active', [])).toBe('none');
    expect(derivePhase('active', [event('client_data.deletion_requested', 1)])).toBe('requested');
    expect(
      derivePhase('pending_deletion', [
        event('client_data.deletion_requested', 1),
        event('client_data.deletion_approved', 2),
      ]),
    ).toBe('approved');
    expect(
      derivePhase('active', [
        event('client_data.deletion_requested', 1),
        event('client_data.deletion_cancelled', 2),
      ]),
    ).toBe('cancelled');
    expect(
      derivePhase('pending_deletion', [
        event('client_data.deletion_requested', 1),
        event('client_data.deletion_approved', 2),
        event('client_data.deletion_started', 3),
      ]),
    ).toBe('started');
    expect(
      derivePhase('pending_deletion', [
        event('client_data.deletion_started', 1),
        event('client_data.purge_blocked_by_hold', 2),
      ]),
    ).toBe('blocked');
    expect(
      derivePhase('pending_deletion', [
        event('client_data.deletion_started', 1),
        event('client_data.deleted', 2),
      ]),
    ).toBe('deleted');
    expect(derivePhase('purged', [event('client_data.deleted', 1)])).toBe('purged');
  });

  it('restarts after cancel when a new request is appended', () => {
    expect(
      derivePhase('active', [
        event('client_data.deletion_requested', 1),
        event('client_data.deletion_cancelled', 2),
        event('client_data.deletion_requested', 3),
      ]),
    ).toBe('requested');
  });

  it('default legal basis is a short audit code', () => {
    expect(DEFAULT_DELETION_LEGAL_BASIS).toMatch(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/);
  });
});
