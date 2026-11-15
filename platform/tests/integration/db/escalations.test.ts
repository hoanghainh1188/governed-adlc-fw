// D-08 B11 on a live PostgreSQL (PR 1): raising escalations (AC1), routing from the project
// configuration and role bindings (AC2), the durable clocks advanced by the worker (AC3) and the
// freeze (AC4). Also: codes-only storage kept 2 years (D-05 §10), the status-move trigger, the
// grants, cross-tenant isolation and the audit chain (handbook Ch.6 §6.4–§6.5, QUESTIONS #21,
// #73–#76, design/ADR-M28).
import { createSimplePolicyEngine } from '@sdlc/adapter-policy-simple';
import { loadProjectConfig } from '@sdlc/config';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DbError } from '../../../packages/core/src/db/errors.js';
import { PlatformDatabase } from '../../../packages/core/src/db/platform-database.js';
import type { Escalation, Intent } from '../../../packages/core/src/db/schema.js';
import { parseTenantId } from '../../../packages/core/src/db/tenant-id.js';
import type { TenantScope } from '../../../packages/core/src/db/tenant-scope.js';
import { advanceEscalation } from '../../../packages/core/src/escalation/advance.js';
import { EscalationError } from '../../../packages/core/src/escalation/errors.js';
import { assertActionAllowed, checkFreeze } from '../../../packages/core/src/escalation/freeze.js';
import {
  raiseEscalation,
  type RaiseEscalationInput,
} from '../../../packages/core/src/escalation/raise.js';
import type { RegistryDeps } from '../../../packages/core/src/registry/effective-config.js';
import { createTestDatabase, describeDb, urlFor, type TestDatabase } from './helpers.js';

const HASH = 'e'.repeat(64);
/** Monday 2026-09-28 10:00 in Asia/Ho_Chi_Minh (the default calendar). */
const T0 = new Date('2026-09-28T03:00:00.000Z');
const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);

const registryDeps: RegistryDeps = {
  policyFactory: (config) => createSimplePolicyEngine({ config }),
  now: () => T0,
};

interface Seeded {
  readonly scope: TenantScope;
  readonly projectId: string;
  readonly intent: Intent;
  readonly personA: string;
  readonly personB: string;
  readonly second: string;
  readonly governance: string;
  readonly bindingIds: Readonly<Record<string, string>>;
}

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof EscalationError) return `escalation:${error.code}`;
    if (error instanceof DbError) return `db:${error.code}`;
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return `pg:${code}`;
    throw error;
  }
  return 'resolved';
}

describeDb('B11: escalations on PostgreSQL', () => {
  let t: TestDatabase;
  let tenantCount = 0;

  beforeAll(async () => {
    t = await createTestDatabase();
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  });

  async function seed(configYaml?: string): Promise<Seeded> {
    const slug = `tenant-${String(++tenantCount)}`;
    const tenant = await t.app.system.createTenant({ slug, name: slug });
    const scope = t.app.forTenant(parseTenantId(tenant.id));
    const project = await scope.projects.create({
      slug: 'shop',
      name: 'Shop',
      git_provider: 'github',
      repo_full_name: 'org/shop',
    });
    const user = async (name: string) =>
      (await scope.users.create({ display_name: name, email: `${name}@example.com` })).id;
    const personA = await user('a');
    const personB = await user('b');
    const second = await user('second');
    const governance = await user('gov');
    const bindingIds: Record<string, string> = {};
    for (const [id, role] of [
      [personA, 'person_a'],
      [personB, 'person_b'],
      [second, 'second_approver'],
      [governance, 'governance'],
    ] as const) {
      bindingIds[role] = (
        await scope.roleBindings.grant({ user_id: id, project_id: project.id, role })
      ).id;
    }
    if (configYaml !== undefined) {
      const loaded = loadProjectConfig(configYaml);
      if (!loaded.ok) throw new Error('bad test config');
      await scope.projectConfigs.save(project.id, {
        configYaml,
        configHash: loaded.configHash,
        updatedBy: null,
        expectedVersion: 0,
      });
    }
    const intent = await scope.intents.create(
      {
        projectId: project.id,
        title: 'Cancel an order',
        createdBy: personA,
        riskTier: 'medium',
        dataClass: 'internal',
        issueNumber: 7,
      },
      registryDeps,
    );
    return {
      scope,
      projectId: project.id,
      intent,
      personA,
      personB,
      second,
      governance,
      bindingIds,
    };
  }

  const input = (s: Seeded, extra: Partial<RaiseEscalationInput> = {}): RaiseEscalationInput => ({
    intentId: s.intent.id,
    trigger: 'out_of_scope',
    route: 'technical',
    severity: 'critical',
    responseLevel: 'pause',
    packet: { subject_kind: 'plan', subject_sha256: HASH, gate: 'G5', reason_code: 'out_of_scope' },
    producers: [],
    raisedBy: { type: 'system' },
    ...extra,
  });

  const raise = (s: Seeded, extra: Partial<RaiseEscalationInput> = {}, at: Date = T0) =>
    raiseEscalation(s.scope, input(s, extra), { now: () => at });

  const auditRows = async (s: Seeded) =>
    (
      await sql<{
        action: string;
        payload: Record<string, unknown>;
      }>`SELECT action, payload FROM audit_log WHERE tenant_id = ${s.scope.tenantId}
         AND action LIKE 'escalation.%' ORDER BY seq`.execute(t.owner)
    ).rows;

  const notices = async (s: Seeded, e: Escalation) =>
    (await s.scope.escalationNotices.listForEscalation(e.id)).map(
      (n) => `${n.kind}/${n.step}/${n.audience_role}`,
    );

  describe('AC1: raise an escalation with severity, response level and decision packet', () => {
    it('stores it with the next ESC code, both clocks, an audit event and the first notices', async () => {
      const s = await seed();
      const first = await raise(s);
      const secondEsc = await raise(s, {
        severity: 'low',
        responseLevel: 'notify',
        packet: { subject_kind: 'intent', subject_sha256: HASH },
      });
      expect(first.code).toBe('ESC-2026-0001');
      expect(secondEsc.code).toBe('ESC-2026-0002');
      expect(first).toMatchObject({
        status: 'open',
        current_step: 'owner',
        owner_id: s.personB,
        backup_owner_id: s.second,
        packet: { subject_kind: 'plan', subject_sha256: HASH, gate: 'G5' },
      });
      expect(first.ack_due_at.toISOString()).toBe(minutes(15).toISOString());
      expect(first.remind_at?.toISOString()).toBe(minutes(11).toISOString());
      expect(first.resolve_due_at?.toISOString()).toBe(minutes(60).toISOString());
      expect(first.next_check_at?.toISOString()).toBe(minutes(11).toISOString());
      expect(secondEsc.resolve_due_at).toBeNull(); // Low: next planned work

      const audit = await auditRows(s);
      expect(audit[0]).toEqual({
        action: 'escalation.created',
        payload: {
          code: 'ESC-2026-0001',
          intent_id: s.intent.id,
          trigger: 'out_of_scope',
          route: 'technical',
          severity: 'critical',
          response_level: 'pause',
          step: 'owner',
          subject_sha256: HASH,
          gate: 'G5',
        },
      });
      // Critical tells governance at once, with Person A and B (codes table §6.3, Ch.6 §6.4).
      expect(await notices(s, first)).toEqual([
        'raised/owner/person_b',
        'raised/owner/governance',
        'raised/owner/person_a',
      ]);
    });

    it('refuses a G5 breach below pause (QUESTIONS #21), a bad packet and a closed intent', async () => {
      const s = await seed();
      expect(await failure(raise(s, { responseLevel: 'notify' }))).toBe(
        'escalation:response_level_too_low',
      );
      expect(
        await failure(
          raise(s, { packet: { subject_kind: 'plan', subject_sha256: HASH, why: 'x' } }),
        ),
      ).toBe('escalation:invalid_packet');
      expect(await failure(raise(s, { intentId: '00000000-0000-4000-8000-000000000999' }))).toBe(
        'escalation:not_found',
      );
      await s.scope.intents.updateState(s.intent.id, {
        status: 'cancelled',
        currentGate: null,
        actorType: 'system',
        actorId: null,
      });
      expect(await failure(raise(s))).toBe('escalation:intent_not_open');
    });
  });

  describe('AC2: routing from the configuration and role bindings, with a backup owner', () => {
    it('routes by route; never to a producer (FR-18)', async () => {
      const s = await seed();
      const intentRoute = await raise(s, { route: 'intent' });
      expect([intentRoute.owner_id, intentRoute.backup_owner_id]).toEqual([s.personA, s.personB]);
      const policy = await raise(s, { route: 'policy' });
      expect([policy.owner_id, policy.backup_owner_id]).toEqual([s.governance, null]);
      const produced = await raise(s, { route: 'intent', producers: [s.personA] });
      expect([produced.current_step, produced.owner_id, produced.backup_owner_id]).toEqual([
        'backup',
        null,
        s.personB,
      ]);
      expect(produced.producer_ids).toEqual([s.personA]);
    });

    it('uses the project configuration, not fixed roles', async () => {
      const s = await seed(
        'escalation:\n  routing:\n    technical: { owner_role: second_approver, backup_role: person_a }\n',
      );
      const e = await raise(s);
      expect([e.owner_id, e.backup_owner_id]).toEqual([s.second, s.personA]);
    });

    it('a role with no holder is skipped; nobody at all → unrouted, frozen at governance', async () => {
      const s = await seed();
      await s.scope.roleBindings.revoke(s.bindingIds.person_b!);
      const skipped = await raise(s);
      expect([skipped.current_step, skipped.owner_id, skipped.backup_owner_id]).toEqual([
        'backup',
        null,
        s.second,
      ]);
      await s.scope.roleBindings.revoke(s.bindingIds.second_approver!);
      await s.scope.roleBindings.revoke(s.bindingIds.governance!);
      const unrouted = await raise(s);
      expect(unrouted.current_step).toBe('governance');
      expect((await auditRows(s)).map((r) => r.action)).toContain('escalation.unrouted');
      expect((await checkFreeze(s.scope, s.intent.id, 'run_start')).allowed).toBe(false);
    });
  });

  describe('AC3: acknowledge and resolve clocks in the database, advanced by the worker', () => {
    it('reminds, moves to backup then governance, and flags the resolve deadline', async () => {
      const s = await seed();
      const e = await raise(s);
      // The due list crosses tenants (other tests share this database): keep this tenant's rows.
      const due = async (at: Date) =>
        (await t.app.system.listDueEscalations(at, 1000)).filter(
          (d) => d.tenantId === s.scope.tenantId,
        );
      expect(await due(minutes(10))).toEqual([]);
      expect(await due(minutes(11))).toEqual([{ tenantId: s.scope.tenantId, escalationId: e.id }]);
      expect((await advanceEscalation(s.scope, e.id, minutes(11))).outcome).toBe('advanced');
      expect((await advanceEscalation(s.scope, e.id, minutes(11))).outcome).toBe('unchanged');
      await advanceEscalation(s.scope, e.id, minutes(15));
      const atBackup = (await s.scope.escalations.getById(e.id))!;
      expect(atBackup).toMatchObject({ current_step: 'backup', status: 'open' });
      expect(atBackup.step_due_at.toISOString()).toBe(minutes(30).toISOString());
      expect(atBackup.ack_missed_at?.toISOString()).toBe(minutes(15).toISOString());

      // A new process (after a restart) continues from the stored clocks.
      const restarted = PlatformDatabase.connect({
        connectionString: urlFor(t.name, 'platform_app'),
        maxConnections: 2,
      });
      try {
        const result = await advanceEscalation(
          restarted.forTenant(s.scope.tenantId),
          e.id,
          minutes(120),
        );
        expect(result.effects.map((x) => x.kind)).toEqual([
          'reminded',
          'step_changed',
          'reminded',
          'governance_overdue',
          'resolve_overdue',
        ]);
      } finally {
        await restarted.close();
      }
      const final = (await s.scope.escalations.getById(e.id))!;
      expect(final.current_step).toBe('governance');
      expect(final.next_check_at).toBeNull();
      expect((await auditRows(s)).map((r) => r.action)).toEqual([
        'escalation.created',
        'escalation.reminded',
        'escalation.step_changed',
        'escalation.reminded',
        'escalation.step_changed',
        'escalation.reminded',
        'escalation.ack_overdue',
        'escalation.resolve_overdue',
        'escalation.incident_due',
      ]);
      expect(await notices(s, e)).toContain('incident_due/governance/governance');
      expect(await due(minutes(500))).toEqual([]);
    });

    it('two workers at the same time: exactly one applies the step', async () => {
      const s = await seed();
      const e = await raise(s);
      const results = await Promise.all([
        advanceEscalation(s.scope, e.id, minutes(15)),
        advanceEscalation(s.scope, e.id, minutes(15)),
      ]);
      const applied = results.flatMap((r) => r.effects.map((x) => x.kind));
      expect(applied).toEqual(['reminded', 'step_changed']);
      const steps = (await auditRows(s)).filter((r) => r.action === 'escalation.step_changed');
      expect(steps).toHaveLength(1);
    });

    it('chooses the backup again when the owner step runs out (roles change hands)', async () => {
      const s = await seed();
      const e = await raise(s);
      await s.scope.roleBindings.revoke(s.bindingIds.second_approver!);
      await advanceEscalation(s.scope, e.id, minutes(15));
      const row = (await s.scope.escalations.getById(e.id))!;
      expect([row.current_step, row.backup_owner_id]).toEqual(['governance', null]);
    });
  });

  describe('AC4: only safe-list actions continue while an escalation is open', () => {
    it('pause freezes at once; safe and containment actions continue; closed unfreezes', async () => {
      const s = await seed();
      const e = await raise(s);
      const refused = await failure(assertActionAllowed(s.scope, s.intent.id, 'run_start'));
      expect(refused).toBe('escalation:frozen');
      await expect(assertActionAllowed(s.scope, s.intent.id, 'merge')).rejects.toMatchObject({
        escalationCodes: [e.code],
      });
      await assertActionAllowed(s.scope, s.intent.id, 'sandbox_test');
      await assertActionAllowed(s.scope, s.intent.id, 'kill_run');
      await sql`UPDATE escalations SET status = 'closed', closed_at = now(), next_check_at = NULL
                WHERE tenant_id = ${s.scope.tenantId} AND id = ${e.id}`.execute(
        t.appAs(s.scope.tenantId),
      );
      await assertActionAllowed(s.scope, s.intent.id, 'run_start');
    });

    it('notify freezes only once the acknowledgement is missed (QUESTIONS #76)', async () => {
      const s = await seed();
      const e = await raise(s, {
        packet: { subject_kind: 'intent', subject_sha256: HASH },
        responseLevel: 'notify',
      });
      expect((await checkFreeze(s.scope, s.intent.id, 'gate_advance')).allowed).toBe(true);
      await advanceEscalation(s.scope, e.id, minutes(15));
      expect(await checkFreeze(s.scope, s.intent.id, 'gate_advance')).toEqual({
        allowed: false,
        escalationCodes: [e.code],
      });
    });

    it('the safe list comes from the project configuration', async () => {
      const s = await seed('escalation:\n  safe_actions: [read_only]\n');
      await raise(s);
      await assertActionAllowed(s.scope, s.intent.id, 'read_only');
      expect(await failure(assertActionAllowed(s.scope, s.intent.id, 'sandbox_test'))).toBe(
        'escalation:frozen',
      );
    });
  });

  describe('storage: codes only, kept 2 years, allowed moves only', () => {
    const insert = (s: Seeded, packet: string) =>
      sql`INSERT INTO escalations (tenant_id, code, intent_id, trigger, route, severity,
            response_level, packet, current_step, ack_due_at, step_due_at)
          VALUES (${s.scope.tenantId}, 'ESC-2026-9999', ${s.intent.id}, 'time', 'intent', 'low',
            'notify', ${packet}::jsonb, 'owner', now(), now())`.execute(t.appAs(s.scope.tenantId));

    it('the database refuses free text and nested values in the packet', async () => {
      const s = await seed();
      expect(await failure(insert(s, JSON.stringify({ goal: 'fix the order bug' })))).toBe(
        'pg:23514',
      );
      expect(await failure(insert(s, JSON.stringify({ who: 'alice@example.com' })))).toBe(
        'pg:23514',
      );
      expect(await failure(insert(s, JSON.stringify({ nested: { a: 'b' } })))).toBe('pg:23514');
      expect(await failure(insert(s, JSON.stringify({ ref: 'https://a b' })))).toBe('pg:23514');
    });

    it('allows only the status moves of ADR-M28; nothing changes once closed', async () => {
      const s = await seed();
      const e = await raise(s);
      const update = (set: ReturnType<typeof sql>) =>
        sql`UPDATE escalations SET ${set} WHERE tenant_id = ${s.scope.tenantId} AND id = ${e.id}`.execute(
          t.appAs(s.scope.tenantId),
        );
      await update(sql`status = 'acknowledged', acknowledged_by = ${s.personB},
                       acknowledged_at = now()`);
      expect(await failure(update(sql`status = 'open'`))).toBe('pg:SDA07');
      expect(await failure(update(sql`acknowledged_by = ${s.second}`))).toBe('pg:SDA07');
      await update(sql`status = 'closed', closed_at = now(), next_check_at = NULL`);
      expect(await failure(update(sql`current_step = 'backup'`))).toBe('pg:SDA07');
    });

    it('a producer never acknowledges or decides (FR-18); the owner is never a producer', async () => {
      const s = await seed();
      const e = await raise(s, { producers: [s.personA] });
      expect(
        await failure(
          sql`UPDATE escalations SET status = 'acknowledged', acknowledged_by = ${s.personA},
              acknowledged_at = now() WHERE tenant_id = ${s.scope.tenantId} AND id = ${e.id}`.execute(
            t.appAs(s.scope.tenantId),
          ),
        ),
      ).toBe('pg:23514');
    });

    it('platform_app cannot change the identity, packet or producers, nor delete', async () => {
      const s = await seed();
      const e = await raise(s);
      for (const statement of [
        sql`UPDATE escalations SET packet = '{}'::jsonb WHERE id = ${e.id}`,
        sql`UPDATE escalations SET producer_ids = '{}' WHERE id = ${e.id}`,
        sql`UPDATE escalations SET severity = 'low' WHERE id = ${e.id}`,
        sql`DELETE FROM escalations WHERE id = ${e.id}`,
        sql`DELETE FROM escalation_notices`,
      ]) {
        expect(await failure(statement.execute(t.appRaw))).toBe('pg:42501');
      }
    });

    it('a posted notice is final', async () => {
      const s = await seed();
      const e = await raise(s);
      const [notice] = await s.scope.escalationNotices.listForEscalation(e.id);
      await sql`UPDATE escalation_notices SET posted_at = now() WHERE id = ${notice!.id}`.execute(
        t.appAs(s.scope.tenantId),
      );
      expect(
        await failure(
          sql`UPDATE escalation_notices SET attempts = 3 WHERE id = ${notice!.id}`.execute(
            t.appAs(s.scope.tenantId),
          ),
        ),
      ).toBe('pg:SDA08');
    });

    it('stores no text of the intent anywhere in the escalation', async () => {
      const s = await seed();
      const e = await raise(s);
      const row = await sql<
        Record<string, unknown>
      >`SELECT * FROM escalations WHERE id = ${e.id}`.execute(t.owner);
      expect(JSON.stringify(row.rows)).not.toContain('Cancel an order');
      expect(JSON.stringify(await auditRows(s))).not.toContain('Cancel an order');
    });
  });

  describe('tenant isolation and audit chain', () => {
    it('another tenant sees nothing; the due list gives IDs only; the chain verifies', async () => {
      const a = await seed();
      const b = await seed();
      const e = await raise(a);
      expect(await b.scope.escalations.getById(e.id)).toBeUndefined();
      expect(await b.scope.escalations.getByCode(e.code)).toBeUndefined();
      expect((await checkFreeze(b.scope, a.intent.id, 'run_start')).allowed).toBe(true);
      const due = await t.app.system.listDueEscalations(minutes(11), 100);
      for (const item of due)
        expect(Object.keys(item).sort()).toEqual(['escalationId', 'tenantId']);
      expect(await advanceEscalation(b.scope, e.id, minutes(15))).toEqual({
        outcome: 'skipped',
        effects: [],
      });
      await advanceEscalation(a.scope, e.id, minutes(20));
      expect((await a.scope.audit.verify()).broken).toBeUndefined();
    });
  });
});
