// D-08 A07 on a live PostgreSQL: append-only audit log (AC1), per-tenant hash chain (AC2),
// concurrent writers (AC3), `adlc audit verify` detects a modified record (AC4), audited config
// and AI record saves, and QUESTIONS #12 (a revoked role binding never changes again).
import { createHash } from 'node:crypto';

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EXIT, processContext, runCli, type CliContext } from '../../../apps/cli/src/index.js';
import { GENESIS_HASH, recordHash } from '../../../packages/core/src/audit/hash-chain.js';
import { PlatformDatabase } from '../../../packages/core/src/db/platform-database.js';
import type { AuditLogRow } from '../../../packages/core/src/db/schema.js';
import { parseTenantId } from '../../../packages/core/src/db/tenant-id.js';
import type { TenantScope } from '../../../packages/core/src/db/tenant-scope.js';
import { createTestDatabase, describeDb, tamper, type TestDatabase, urlFor } from './helpers.js';

const HASH = (c: string) => c.repeat(64);

interface Seeded {
  readonly slug: string;
  readonly scope: TenantScope;
  readonly projectId: string;
  readonly userId: string;
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

describeDb('A07: audit log on PostgreSQL', () => {
  let t: TestDatabase;
  let tenantCount = 0;

  beforeAll(async () => {
    t = await createTestDatabase();
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  });

  async function seed(): Promise<Seeded> {
    const slug = `tenant-${++tenantCount}`;
    const tenant = await t.app.system.createTenant({ slug, name: slug });
    const scope = t.app.forTenant(parseTenantId(tenant.id));
    const project = await scope.projects.create({
      slug: 'shop',
      name: 'Shop',
      git_provider: 'github',
      repo_full_name: `${slug}/shop`,
    });
    const user = await scope.users.create({ display_name: 'Reviewer', email: 'r@example.com' });
    return { slug, scope, projectId: project.id, userId: user.id };
  }

  /** Appends `n` config.changed events and returns the rows. */
  async function appendMany(s: Seeded, n: number): Promise<AuditLogRow[]> {
    const rows: AuditLogRow[] = [];
    for (let version = 1; version <= n; version++) {
      rows.push(
        await s.scope.audit.append({
          action: 'config.changed',
          actorType: 'human',
          actorId: s.userId,
          entityId: s.projectId,
          payload: { version, config_hash: HASH('a') },
        }),
      );
    }
    return rows;
  }

  function cli(): { ctx: CliContext; out: string[]; err: string[] } {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      ctx: {
        env: { SDLC_DB_URL: urlFor(t.name, 'platform_app') },
        stdout: (line) => out.push(line),
        stderr: (line) => err.push(line),
        // The CLI's own connection (the built `@sdlc/core` for the type checker).
        connect: processContext().connect,
      },
    };
  }

  describe('AC1: append-only', () => {
    it('platform_app has no UPDATE, DELETE or TRUNCATE privilege', async () => {
      const s = await seed();
      await appendMany(s, 1);
      for (const statement of [
        sql`UPDATE audit_log SET action = 'x.y'`,
        sql`DELETE FROM audit_log`,
        sql`TRUNCATE audit_log`,
      ]) {
        await expect(statement.execute(t.appRaw)).rejects.toMatchObject({ code: '42501' });
      }
    });

    it('triggers refuse UPDATE, DELETE and TRUNCATE even for the owner role', async () => {
      const s = await seed();
      await appendMany(s, 1);
      for (const statement of [
        sql`UPDATE audit_log SET action = 'x.y'`,
        sql`DELETE FROM audit_log`,
        sql`TRUNCATE audit_log`,
      ]) {
        await expect(statement.execute(t.owner)).rejects.toMatchObject({ code: 'SDA01' });
      }
    });
  });

  describe('AC2: per-tenant hash chain', () => {
    it('starts each tenant at seq 1 from the genesis hash and links every record', async () => {
      const a = await seed();
      const b = await seed();
      const rowsA = await appendMany(a, 3);
      const rowsB = await appendMany(b, 2);
      for (const rows of [rowsA, rowsB]) {
        expect(rows.map((r) => r.seq)).toEqual(rows.map((_, i) => String(i + 1)));
        expect(rows[0]!.prev_hash).toBe(GENESIS_HASH);
        for (let i = 1; i < rows.length; i++) expect(rows[i]!.prev_hash).toBe(rows[i - 1]!.hash);
      }
      const row = rowsA[1]!;
      expect(row.hash).toBe(
        recordHash({
          hashVersion: row.hash_version,
          tenantId: row.tenant_id,
          seq: 2,
          actorType: row.actor_type,
          actorId: row.actor_id,
          action: row.action,
          entityType: row.entity_type,
          entityId: row.entity_id,
          payload: row.payload,
          occurredAt: row.occurred_at,
          prevHash: row.prev_hash,
        }),
      );
      expect(row.payload).toEqual({ version: 2, config_hash: HASH('a') });
      expect(await a.scope.audit.verify()).toMatchObject({ checked: 3, lastSeq: 3 });
      expect(await b.scope.audit.verify()).toMatchObject({ checked: 2, lastSeq: 2 });
    });

    it('verify reads long chains in batches', async () => {
      const s = await seed();
      await appendMany(s, 7);
      for (const batchSize of [1, 2, 3, 7, 100]) {
        expect(await s.scope.audit.verify(batchSize), String(batchSize)).toMatchObject({
          checked: 7,
          lastSeq: 7,
        });
      }
      await tamper(t.name, `DELETE FROM audit_log WHERE tenant_id = $1 AND seq = 5`, [
        s.scope.tenantId,
      ]);
      expect((await s.scope.audit.verify(2)).broken).toEqual({ seq: 6, reason: 'seq_gap' });
    });

    it('the chain link trigger refuses a row that does not follow the last one', async () => {
      const s = await seed();
      const [last] = await appendMany(s, 1);
      const insert = (seq: number, prevHash: string) =>
        sql`INSERT INTO audit_log (tenant_id, seq, hash_version, actor_type, action, payload,
              prev_hash, hash, occurred_at)
            VALUES (${last!.tenant_id}, ${seq}, 1, 'system', 'config.changed', '{}',
              ${prevHash}, ${HASH('c')}, now())`.execute(t.appAs(last!.tenant_id));
      await expect(insert(3, last!.hash)).rejects.toMatchObject({ code: 'SDA02' });
      await expect(insert(2, HASH('d'))).rejects.toMatchObject({ code: 'SDA02' });
      await expect(insert(1, GENESIS_HASH)).rejects.toMatchObject({ code: 'SDA02' });
    });

    it('rejects undeclared payload fields and wrong actors before writing', async () => {
      const s = await seed();
      const append = s.scope.audit.append.bind(s.scope.audit) as (e: unknown) => Promise<unknown>;
      const base = {
        action: 'ai_record.changed',
        actorType: 'human',
        actorId: s.userId,
        entityId: s.projectId,
        payload: {
          version: 1,
          record_sha256: HASH('r'),
          ai_allowed: 'yes',
          prod_logs_allowed: 'no',
          disclosure_format: 'standard_note',
          consent: 'confirmed',
          updated_by: s.userId,
        },
      };
      for (const event of [
        { ...base, payload: { ...base.payload, confirmed_by: 'Client contact' } },
        { ...base, payload: { version: 1 } },
        { ...base, action: 'user.renamed' },
        { ...base, actorType: 'system' },
        { ...base, actorType: 'human', actorId: null },
      ]) {
        await expect(append(event)).rejects.toMatchObject({ code: 'invalid_value' });
      }
      expect(await s.scope.audit.verify()).toMatchObject({ checked: 0 });
    });
  });

  describe('AC3: concurrent writers', () => {
    it('two processes writing to the same tenants never corrupt seq or prev_hash', async () => {
      const a = await seed();
      const b = await seed();
      const second = PlatformDatabase.connect({
        connectionString: urlFor(t.name, 'platform_app'),
        maxConnections: 4,
      });
      try {
        const writers = [t.app, second].flatMap((db) =>
          [a, b].map((s) => db.forTenant(s.scope.tenantId)),
        );
        await Promise.all(
          writers.flatMap((scope, w) =>
            Array.from({ length: 25 }, (_, i) =>
              scope.audit.append({
                action: 'config.changed',
                actorType: 'system',
                actorId: null,
                entityId: w % 2 === 0 ? a.projectId : b.projectId,
                payload: { version: w * 100 + i + 1, config_hash: HASH('b') },
              }),
            ),
          ),
        );
      } finally {
        await second.close();
      }
      for (const s of [a, b]) {
        expect(await s.scope.audit.verify()).toMatchObject({ checked: 50, lastSeq: 50 });
        expect(await s.scope.audit.verify()).not.toHaveProperty('broken');
      }
    }, 30_000);
  });

  describe('AC4: adlc audit verify detects a modified record', () => {
    it('reports an intact chain with exit code 0', async () => {
      const s = await seed();
      await appendMany(s, 3);
      const { ctx, out } = cli();
      expect(await runCli(['ops', 'audit', 'verify', '--tenant', s.slug], ctx)).toBe(EXIT.ok);
      expect(out).toEqual([`${s.slug}: audit chain intact, 3 records checked.`]);
    });

    it.each([
      [
        'a changed payload',
        `UPDATE audit_log SET payload = '{"version": 9, "config_hash": "${HASH('a')}"}' WHERE tenant_id = $1 AND seq = 3`,
        { seq: 3, reason: 'hash_mismatch' },
      ],
      [
        'a changed time',
        `UPDATE audit_log SET occurred_at = occurred_at + interval '1 second' WHERE tenant_id = $1 AND seq = 2`,
        { seq: 2, reason: 'hash_mismatch' },
      ],
      [
        'a changed actor',
        `UPDATE audit_log SET actor_type = 'system', actor_id = NULL WHERE tenant_id = $1 AND seq = 4`,
        { seq: 4, reason: 'hash_mismatch' },
      ],
      [
        'a deleted record',
        `DELETE FROM audit_log WHERE tenant_id = $1 AND seq = 2`,
        { seq: 3, reason: 'seq_gap' },
      ],
      [
        'a rewritten hash',
        `UPDATE audit_log SET hash = '${HASH('f')}' WHERE tenant_id = $1 AND seq = 1`,
        { seq: 1, reason: 'hash_mismatch' },
      ],
    ])('finds %s', async (_name, statement, broken) => {
      const s = await seed();
      await appendMany(s, 5);
      await tamper(t.name, statement, [s.scope.tenantId]);
      expect((await s.scope.audit.verify()).broken).toEqual(broken);
      const { ctx, out } = cli();
      expect(await runCli(['ops', 'audit', 'verify', '--tenant', s.slug, '--json'], ctx)).toBe(
        EXIT.failed,
      );
      expect(JSON.parse(out.join('\n'))).toEqual([
        expect.objectContaining({ tenant: s.slug, ok: false, broken }),
      ]);
    });

    it('prints the broken seq and reason from the message catalog', async () => {
      const s = await seed();
      await appendMany(s, 3);
      await tamper(
        t.name,
        `UPDATE audit_log SET action = 'ai_record.changed' WHERE tenant_id = $1 AND seq = 2`,
        [s.scope.tenantId],
      );
      const { ctx, out } = cli();
      expect(await runCli(['ops', 'audit', 'verify', '--tenant', s.slug], ctx)).toBe(EXIT.failed);
      expect(out).toEqual([
        `${s.slug}: audit chain broken at seq 2: the record was changed after it was written (hash mismatch). 1 records before it are intact.`,
      ]);
    });

    it('checks every tenant without --tenant, and refuses an unknown slug', async () => {
      const { ctx, out } = cli();
      // Earlier tests left broken chains in some tenants.
      expect(await runCli(['ops', 'audit', 'verify'], ctx)).toBe(EXIT.failed);
      expect(out.length).toBe(tenantCount);
      const unknown = cli();
      expect(await runCli(['ops', 'audit', 'verify', '--tenant', 'nope'], unknown.ctx)).toBe(
        EXIT.usage,
      );
      expect(unknown.err).toEqual(['No tenant with the slug nope.']);
    });
  });

  describe('audited saves (ADR-M09 section 2.7)', () => {
    it('project config save appends config.changed with version, config_hash and the YAML hash only', async () => {
      const s = await seed();
      await s.scope.projectConfigs.save(s.projectId, {
        configYaml: 'secret: text that must not reach the audit log',
        configHash: HASH('1'),
        updatedBy: null,
        expectedVersion: 0,
      });
      await s.scope.projectConfigs.save(s.projectId, {
        configYaml: 'v2',
        configHash: HASH('2'),
        updatedBy: s.userId,
        expectedVersion: 1,
      });
      await expect(
        s.scope.projectConfigs.save(s.projectId, {
          configYaml: 'stale',
          configHash: HASH('3'),
          updatedBy: s.userId,
          expectedVersion: 1,
        }),
      ).rejects.toMatchObject({ code: 'version_conflict' });
      const rows = await rowsOf(s);
      expect(
        rows.map((r) => [
          r.action,
          r.actor_type,
          r.actor_id,
          r.entity_type,
          r.entity_id,
          r.payload,
        ]),
      ).toEqual([
        [
          'config.changed',
          'system',
          null,
          'project',
          s.projectId,
          {
            version: 1,
            config_hash: HASH('1'),
            override_sha256: sha256('secret: text that must not reach the audit log'),
          },
        ],
        [
          'config.changed',
          'human',
          s.userId,
          'project',
          s.projectId,
          { version: 2, config_hash: HASH('2'), override_sha256: sha256('v2') },
        ],
      ]);
      expect(await s.scope.audit.verify()).toMatchObject({ checked: 2 });
    });

    it('AI record save appends ai_record.changed with codes, version and hash only', async () => {
      const s = await seed();
      await s.scope.projectAiRecords.save(s.projectId, {
        aiAllowed: 'yes_with_conditions',
        allowedDataClasses: ['internal'],
        prodLogsAllowed: 'no',
        disclosureFormat: 'standard_note',
        recordRef: 'https://docs.example.test/project/ai-record',
        actorType: 'human',
        confirmedAt: '2026-09-25',
        updatedBy: s.userId,
        expectedVersion: 0,
      });
      const rows = await rowsOf(s);
      const saved = await s.scope.projectAiRecords.get(s.projectId);
      expect(rows.map((r) => [r.action, r.payload])).toEqual([
        [
          'ai_record.changed',
          {
            version: 1,
            record_sha256: saved!.record_sha256,
            ai_allowed: 'yes_with_conditions',
            prod_logs_allowed: 'no',
            disclosure_format: 'standard_note',
            consent: 'confirmed',
            updated_by: s.userId,
          },
        ],
      ]);
      // Never the link to the human record.
      expect(JSON.stringify(rows)).not.toMatch(/https:|example\.test/);
    });

    it('a save and its audit event commit or roll back together', async () => {
      const s = await seed();
      await expect(
        s.scope.transaction(async (scope) => {
          await scope.projectConfigs.save(s.projectId, {
            configYaml: 'x',
            configHash: HASH('4'),
            updatedBy: null,
            expectedVersion: 0,
          });
          throw new Error('abort');
        }),
      ).rejects.toThrow('abort');
      expect(await s.scope.projectConfigs.get(s.projectId)).toBeUndefined();
      expect(await rowsOf(s)).toEqual([]);
    });

    async function rowsOf(s: Seeded) {
      return (
        await sql<AuditLogRow>`SELECT * FROM audit_log WHERE tenant_id = ${s.scope.tenantId} ORDER BY seq`.execute(
          t.owner,
        )
      ).rows;
    }
  });

  describe('QUESTIONS #12: a revoked role binding never changes again', () => {
    it('refuses un-revoking and re-revoking, for the app role and the owner', async () => {
      const s = await seed();
      const binding = await s.scope.roleBindings.grant({
        user_id: s.userId,
        project_id: s.projectId,
        role: 'person_b',
      });
      await s.scope.roleBindings.revoke(binding.id);
      for (const db of [t.appAs(s.scope.tenantId), t.owner]) {
        await expect(
          sql`UPDATE role_bindings SET revoked_at = NULL WHERE id = ${binding.id}`.execute(db),
        ).rejects.toMatchObject({ code: 'SDA03' });
        await expect(
          sql`UPDATE role_bindings SET revoked_at = now() WHERE id = ${binding.id}`.execute(db),
        ).rejects.toMatchObject({ code: 'SDA03' });
      }
      expect(await s.scope.roleBindings.revoke(binding.id)).toBeUndefined();
      expect(await s.scope.roleBindings.getById(binding.id)).toBeUndefined();
      const again = await s.scope.roleBindings.grant({
        user_id: s.userId,
        project_id: s.projectId,
        role: 'person_b',
      });
      expect(again.id).not.toBe(binding.id);
    });

    it('still allows revoking an active binding', async () => {
      const s = await seed();
      const binding = await s.scope.roleBindings.grant({
        user_id: s.userId,
        project_id: s.projectId,
        role: 'viewer',
      });
      expect((await s.scope.roleBindings.revoke(binding.id))?.revoked_at).toBeInstanceOf(Date);
    });
  });
});
