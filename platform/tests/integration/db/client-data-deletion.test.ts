// D-08 H03a on a live PostgreSQL: tenant states, anonymizeUser + scrubProjectConfigs in one
// transaction, append-only rows and the hash chain unchanged (ADR-M97 §2; QUESTIONS #611–#615).
import { createSimplePolicyEngine } from '@sdlc/adapter-policy-simple';
import { loadProjectConfig } from '@sdlc/config';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { GENESIS_HASH } from '../../../packages/core/src/audit/hash-chain.js';
import {
  anonymizedDisplayName,
  anonymizedEmail,
  anonymizedExternalLogin,
  projectConfigTombstoneHash,
  projectConfigTombstoneYaml,
} from '../../../packages/core/src/db/repositories/client-data-deletion.js';
import { overrideSha256 } from '../../../packages/core/src/db/repositories/project-configs.js';
import type { AuditLogRow, GateDecisionRow } from '../../../packages/core/src/db/schema.js';
import { parseTenantId } from '../../../packages/core/src/db/tenant-id.js';
import type { TenantScope } from '../../../packages/core/src/db/tenant-scope.js';
import type { RegistryDeps } from '../../../packages/core/src/registry/effective-config.js';
import { createTestDatabase, describeDb, type TestDatabase } from './helpers.js';

const HASH = (c: string) => c.repeat(64);
const registryDeps: RegistryDeps = {
  policyFactory: (config) => createSimplePolicyEngine({ config }),
  now: () => new Date('2026-11-10T12:00:00.000Z'),
};

interface Seeded {
  readonly scope: TenantScope;
  readonly projectId: string;
  readonly userId: string;
  readonly identityId: string;
  readonly unlinkedIdentityId: string;
}

describeDb('H03a: client data deletion on PostgreSQL', () => {
  let t: TestDatabase;
  let n = 0;

  beforeAll(async () => {
    t = await createTestDatabase();
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  });

  async function seed(): Promise<Seeded> {
    const slug = `h03a-${++n}`;
    const tenant = await t.app.system.createTenant({ slug, name: slug });
    const scope = t.app.forTenant(parseTenantId(tenant.id));
    const project = await scope.projects.create({
      slug: 'shop',
      name: 'Shop',
      git_provider: 'github',
      repo_full_name: `${slug}/shop`,
    });
    const user = await scope.users.create({
      display_name: 'Alice Example',
      email: 'alice@example.com',
    });
    const linked = await scope.userIdentities.link({
      user_id: user.id,
      provider: 'github',
      external_id: '1001',
      external_login: 'alice-gh',
    });
    const unlinked = await scope.userIdentities.link({
      user_id: user.id,
      provider: 'github',
      external_id: '1002',
      external_login: 'alice-old',
    });
    await scope.userIdentities.unlink(unlinked.id);
    const loaded = loadProjectConfig('');
    if (!loaded.ok) throw new Error('default configuration must load');
    await scope.projectConfigs.save(project.id, {
      configYaml: '',
      configHash: loaded.configHash,
      updatedBy: user.id,
      expectedVersion: 0,
      cause: 'upload',
    });
    return {
      scope,
      projectId: project.id,
      userId: user.id,
      identityId: linked.id,
      unlinkedIdentityId: unlinked.id,
    };
  }

  it('AC1: tenants may be pending_deletion or purged; other statuses stay refused', async () => {
    const s = await seed();
    for (const status of ['pending_deletion', 'purged'] as const) {
      await sql`UPDATE tenants SET status = ${status} WHERE id = ${s.scope.tenantId}`.execute(
        t.appRaw,
      );
      const row = await t.app.system.getTenant(s.scope.tenantId);
      expect(row?.status).toBe(status);
    }
    await expect(
      sql`UPDATE tenants SET status = ${'gone'} WHERE id = ${s.scope.tenantId}`.execute(t.appRaw),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('AC2: anonymizeUser and scrubProjectConfigs scrub PII in one transaction; FKs stay', async () => {
    const s = await seed();
    const intent = await s.scope.intents.create(
      {
        projectId: s.projectId,
        title: 'Cancel an order',
        createdBy: s.userId,
        riskTier: 'medium',
        dataClass: 'internal',
      },
      registryDeps,
    );
    await sql`
      INSERT INTO gate_decisions (
        tenant_id, intent_id, gate, decision, oversight_mode, actor_type, decided_by,
        approver_role, expires_at, input_sha256, config_hash, source
      ) VALUES (
        ${s.scope.tenantId}, ${intent.id}, 'G1', 'approve', 'HITL', 'human', ${s.userId},
        'person_b', ${new Date('2026-12-01T00:00:00.000Z')}, ${HASH('a')}, ${HASH('b')}, 'cli'
      )`.execute(t.appRaw);

    const purgedAt = new Date('2026-11-10T12:00:00.000Z');
    await s.scope.transaction(async (tx) => {
      await tx.clientDataDeletion.anonymizeUser(s.userId);
      await tx.clientDataDeletion.scrubProjectConfigs(purgedAt);
    });

    const user = await s.scope.users.getById(s.userId);
    expect(user).toMatchObject({
      email: anonymizedEmail(s.userId),
      display_name: anonymizedDisplayName(s.userId),
      status: 'disabled',
    });
    const linked = await s.scope.userIdentities.getById(s.identityId);
    expect(linked?.external_login).toBe(anonymizedExternalLogin(s.identityId));
    const unlinked = await s.scope.userIdentities.getById(s.unlinkedIdentityId, {
      includeUnlinked: true,
    });
    expect(unlinked?.external_login).toBe(anonymizedExternalLogin(s.unlinkedIdentityId));
    expect(unlinked?.unlinked_at).toBeInstanceOf(Date);

    const config = await s.scope.projectConfigs.get(s.projectId);
    const yaml = projectConfigTombstoneYaml(purgedAt);
    expect(config).toMatchObject({
      config_yaml: yaml,
      config_hash: projectConfigTombstoneHash(yaml),
      override_sha256: overrideSha256(yaml),
      version: 2,
      updated_by: s.userId,
    });

    const decision = await sql<GateDecisionRow>`
      SELECT * FROM gate_decisions WHERE tenant_id = ${s.scope.tenantId}`.execute(t.appRaw);
    expect(decision.rows).toHaveLength(1);
    expect(decision.rows[0]?.decided_by).toBe(s.userId);
  });

  it('AC3: gate_decisions, audit_log and the hash chain are unchanged after scrubbing', async () => {
    const s = await seed();
    await s.scope.audit.append({
      action: 'config.changed',
      actorType: 'human',
      actorId: s.userId,
      entityId: s.projectId,
      payload: { version: 9, config_hash: HASH('c') },
    });
    const intent = await s.scope.intents.create(
      {
        projectId: s.projectId,
        title: 'Cancel an order',
        createdBy: s.userId,
        riskTier: 'medium',
        dataClass: 'internal',
      },
      registryDeps,
    );
    await sql`
      INSERT INTO gate_decisions (
        tenant_id, intent_id, gate, decision, oversight_mode, actor_type, decided_by,
        approver_role, expires_at, input_sha256, config_hash, source
      ) VALUES (
        ${s.scope.tenantId}, ${intent.id}, 'G1', 'approve', 'HITL', 'human', ${s.userId},
        'person_b', ${new Date('2026-12-01T00:00:00.000Z')}, ${HASH('e')}, ${HASH('f')}, 'cli'
      )`.execute(t.appRaw);

    const beforeAudit = await sql<AuditLogRow>`
      SELECT * FROM audit_log WHERE tenant_id = ${s.scope.tenantId} ORDER BY seq`.execute(t.appRaw);
    const beforeGates = await sql<GateDecisionRow>`
      SELECT * FROM gate_decisions WHERE tenant_id = ${s.scope.tenantId} ORDER BY id`.execute(
      t.appRaw,
    );
    expect(beforeAudit.rows[0]?.prev_hash).toBe(GENESIS_HASH);
    expect(await s.scope.audit.verify()).toEqual({
      checked: beforeAudit.rows.length,
      lastSeq: beforeAudit.rows.length,
      lastHash: beforeAudit.rows.at(-1)!.hash,
    });

    await s.scope.transaction(async (tx) => {
      await tx.clientDataDeletion.anonymizeUser(s.userId);
      await tx.clientDataDeletion.scrubProjectConfigs(new Date('2026-11-10T13:00:00.000Z'));
    });

    const afterAudit = await sql<AuditLogRow>`
      SELECT * FROM audit_log WHERE tenant_id = ${s.scope.tenantId} ORDER BY seq`.execute(t.appRaw);
    const afterGates = await sql<GateDecisionRow>`
      SELECT * FROM gate_decisions WHERE tenant_id = ${s.scope.tenantId} ORDER BY id`.execute(
      t.appRaw,
    );
    expect(afterAudit.rows).toEqual(beforeAudit.rows);
    expect(afterGates.rows).toEqual(beforeGates.rows);
    expect(await s.scope.audit.verify()).toEqual({
      checked: beforeAudit.rows.length,
      lastSeq: beforeAudit.rows.length,
      lastHash: beforeAudit.rows.at(-1)!.hash,
    });

    for (const statement of [
      sql`UPDATE audit_log SET action = 'x.y' WHERE tenant_id = ${s.scope.tenantId}`,
      sql`DELETE FROM audit_log WHERE tenant_id = ${s.scope.tenantId}`,
      sql`UPDATE gate_decisions SET decision = 'reject' WHERE tenant_id = ${s.scope.tenantId}`,
      sql`DELETE FROM gate_decisions WHERE tenant_id = ${s.scope.tenantId}`,
    ]) {
      await expect(statement.execute(t.appRaw)).rejects.toMatchObject({ code: '42501' });
      await expect(statement.execute(t.owner)).rejects.toMatchObject({ code: 'SDA01' });
    }
  });

  it('anonymizeUser is idempotent; scrub refuses changing other columns of an unlinked identity', async () => {
    const s = await seed();
    await s.scope.clientDataDeletion.anonymizeUser(s.userId);
    const again = await s.scope.clientDataDeletion.anonymizeUser(s.userId);
    expect(again.user.email).toBe(anonymizedEmail(s.userId));
    await expect(
      sql`UPDATE user_identities SET external_id = '9999'
          WHERE tenant_id = ${s.scope.tenantId} AND id = ${s.unlinkedIdentityId}`.execute(t.owner),
    ).rejects.toMatchObject({ code: 'SDA11' });
  });
});
