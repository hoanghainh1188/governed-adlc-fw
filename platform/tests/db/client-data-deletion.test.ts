// D-08 H03a (static): anonymization helpers and the migration that adds tenant states
// (ADR-M97 §2, QUESTIONS #611–#615). Live scrubbing is in integration/db/client-data-deletion.test.ts.
import { describe, expect, it } from 'vitest';

import { MIGRATIONS } from '../../packages/core/src/db/migrations/index.js';
import {
  anonymizedDisplayName,
  anonymizedEmail,
  anonymizedExternalLogin,
  projectConfigTombstoneHash,
  projectConfigTombstoneYaml,
} from '../../packages/core/src/db/repositories/client-data-deletion.js';
import { TENANT_STATUSES } from '../../packages/core/src/db/vocabulary.js';
import { overrideSha256 } from '../../packages/core/src/db/repositories/project-configs.js';

const upSql = Object.values(MIGRATIONS)
  .flatMap((m) => m.statements.up)
  .join(';\n');

describe('H03a: client data deletion helpers (static)', () => {
  it('AC1: tenant vocabulary and the CHECK include pending_deletion and purged', () => {
    expect(TENANT_STATUSES).toEqual(['active', 'suspended', 'pending_deletion', 'purged']);
    expect(upSql).toMatch(
      /CHECK \(status IN \('active', 'suspended', 'pending_deletion', 'purged'\)\)/,
    );
  });

  it('AC2: anonymized email, display name and login match ADR-M97 §2.1', () => {
    const userId = 'e4b2d3c1-0000-0000-0000-000000000001';
    const identityId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    expect(anonymizedEmail(userId)).toBe(`deleted-${userId}@redacted.invalid`);
    expect(anonymizedDisplayName(userId)).toBe('Redacted User e4b2d3c1');
    expect(anonymizedExternalLogin(identityId)).toBe(`redacted-${identityId}`);
  });

  it('project config tombstone YAML hashes match override_sha256 and config_hash', () => {
    const purgedAt = new Date('2026-11-10T12:00:00.000Z');
    const yaml = projectConfigTombstoneYaml(purgedAt);
    expect(yaml).toBe('redacted: true\npurged_at: 2026-11-10T12:00:00.000Z\n');
    expect(projectConfigTombstoneHash(yaml)).toBe(overrideSha256(yaml));
    expect(projectConfigTombstoneHash(yaml)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('AC3: the migration does not add UPDATE or DELETE paths on append-only tables', () => {
    const migration = MIGRATIONS['0047-client-data-deletion']!;
    const sql = migration.statements.up.join('\n');
    for (const table of ['audit_log', 'gate_decisions', 'run_events', 'cost_records']) {
      expect(sql).not.toMatch(new RegExp(`\\b(UPDATE|DELETE)\\b[\\s\\S]*\\b${table}\\b`, 'i'));
      expect(sql).not.toMatch(new RegExp(`GRANT\\s+(UPDATE|DELETE)[^;]*\\b${table}\\b`, 'i'));
    }
  });
});
