// D-08 B02 on a live PostgreSQL: intents with per-tenant codes (AC1), max_autonomy from the
// policy engine and stored change flags (AC2), append-only gate decisions with approval binding
// and void decisions (AC3), and an audit event for every change in the same transaction (AC4).
// Also: separation of duties (FR-11), POLICY at G4 (QUESTIONS #6), no pass after a G5 breach
// (QUESTIONS #21), no free-text reason (ADR-M20).
import { createSimplePolicyEngine } from '@sdlc/adapter-policy-simple';
import { loadProjectConfig } from '@sdlc/config';
import type { PolicyEngine } from '@sdlc/contracts';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DbError } from '../../../packages/core/src/db/errors.js';
import type { GateDecisionRow, Intent } from '../../../packages/core/src/db/schema.js';
import { parseTenantId } from '../../../packages/core/src/db/tenant-id.js';
import type { TenantScope } from '../../../packages/core/src/db/tenant-scope.js';
import type { HumanDecisionInput } from '../../../packages/core/src/db/repositories/gate-decisions.js';
import type { NewIntent } from '../../../packages/core/src/db/repositories/intents.js';
import type { RegistryDeps } from '../../../packages/core/src/registry/effective-config.js';
import { RegistryError } from '../../../packages/core/src/registry/errors.js';
import { Registry } from '../../../packages/core/src/registry/registry.js';
import { createTestDatabase, describeDb, tamper, type TestDatabase } from './helpers.js';

const HASH = (c: string) => c.repeat(64);
const COMMIT = 'c'.repeat(40);
const NOW = new Date('2026-09-25T03:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

const deps = (now: Date = NOW, policyFactory = createSimplePolicyEngine): RegistryDeps => ({
  policyFactory: (config) => policyFactory({ config }),
  now: () => now,
});

interface Seeded {
  readonly scope: TenantScope;
  readonly projectId: string;
  readonly personA: string;
  readonly personB: string;
  readonly second: string;
  readonly outsider: string;
}

async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RegistryError) return `${error.code}:${String(error.reason ?? '')}`;
    if (error instanceof DbError) return `db:${error.code}`;
    throw error;
  }
  return 'resolved';
}

describeDb('B02: registry on PostgreSQL', () => {
  let t: TestDatabase;
  let tenantCount = 0;
  const registry = new Registry(deps());

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
    const [personA, personB, second, outsider] = await Promise.all(
      ['a', 'b', 'second', 'outsider'].map(user),
    );
    const grant = (user_id: string, role: 'person_a' | 'person_b' | 'second_approver') =>
      scope.roleBindings.grant({ user_id, project_id: project.id, role });
    await grant(personA!, 'person_a');
    await grant(personB!, 'person_b');
    await grant(second!, 'second_approver');
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
    return {
      scope,
      projectId: project.id,
      personA: personA!,
      personB: personB!,
      second: second!,
      outsider: outsider!,
    };
  }

  const newIntent = (s: Seeded, extra: Partial<NewIntent> = {}): NewIntent => ({
    projectId: s.projectId,
    title: 'Add Japanese labels',
    createdBy: s.personA,
    riskTier: 'low',
    dataClass: 'internal',
    ...extra,
  });

  const auditActions = async (s: Seeded) =>
    (
      await sql<{
        action: string;
      }>`SELECT action FROM audit_log WHERE tenant_id = ${s.scope.tenantId} ORDER BY seq`.execute(
        t.owner,
      )
    ).rows.map((r) => r.action);

  const approve = (
    s: Seeded,
    intent: Intent,
    actorId: string,
    extra: Partial<HumanDecisionInput> = {},
  ): HumanDecisionInput => ({
    intentId: intent.id,
    gate: 'G1',
    decision: 'approve',
    actor: { type: 'human', id: actorId },
    inputSha256: HASH('1'),
    producers: [],
    source: 'cli',
    ...extra,
  });

  describe('AC1: intent codes INT-YYYY-NNNN, unique per tenant, status draft', () => {
    it('numbers intents per tenant from 0001 and starts in draft', async () => {
      const a = await seed();
      const b = await seed();
      const first = await registry.createIntent(a.scope, newIntent(a));
      const second = await registry.createIntent(a.scope, newIntent(a));
      const other = await registry.createIntent(b.scope, newIntent(b));
      expect([first.code, second.code, other.code]).toEqual([
        'INT-2026-0001',
        'INT-2026-0002',
        'INT-2026-0001',
      ]);
      expect(first).toMatchObject({ status: 'draft', current_gate: null, description: '' });
      expect(await a.scope.intents.getByCode('INT-2026-0002')).toMatchObject({ id: second.id });
      expect(await b.scope.intents.getById(first.id)).toBeUndefined();
    });

    it('never gives the same code twice to concurrent creators', async () => {
      const s = await seed();
      const codes = (
        await Promise.all(
          Array.from({ length: 20 }, () => registry.createIntent(s.scope, newIntent(s))),
        )
      ).map((i) => i.code);
      expect(new Set(codes).size).toBe(20);
      expect([...codes].sort()).toEqual(
        Array.from({ length: 20 }, (_, n) => `INT-2026-${String(n + 1).padStart(4, '0')}`),
      );
    });

    it('starts again at 0001 when the UTC year changes', async () => {
      const s = await seed();
      const late = new Registry(deps(new Date('2026-12-31T23:59:59.999Z')));
      const early = new Registry(deps(new Date('2027-01-01T00:00:00.000Z')));
      expect((await late.createIntent(s.scope, newIntent(s))).code).toBe('INT-2026-0001');
      expect((await early.createIntent(s.scope, newIntent(s))).code).toBe('INT-2027-0001');
      expect((await late.createIntent(s.scope, newIntent(s))).code).toBe('INT-2026-0002');
    });

    it('the unique constraint is the backstop when the lock is skipped', async () => {
      const s = await seed();
      const intent = await registry.createIntent(s.scope, newIntent(s));
      await expect(
        sql`INSERT INTO intents (tenant_id, code, project_id, title, created_by, risk_tier, data_class, max_autonomy, budget_usd)
            VALUES (${s.scope.tenantId}, ${intent.code}, ${s.projectId}, 'x', ${s.personA}, 'low', 'internal', 'L2', 1)`.execute(
          t.appAs(s.scope.tenantId),
        ),
      ).rejects.toMatchObject({ code: '23505' });
    });

    it('refuses an archived or unknown project', async () => {
      const s = await seed();
      await tamper(t.name, `UPDATE projects SET status = 'archived' WHERE id = $1`, [s.projectId]);
      expect(await rejection(registry.createIntent(s.scope, newIntent(s)))).toBe(
        'project_not_active:',
      );
    });
  });

  describe('AC2: max_autonomy from the policy engine; change flags stored', () => {
    it.each([
      ['critical', 'internal', 'L0'],
      ['high', 'internal', 'L1'],
      ['medium', 'internal', 'L2'],
      ['low', 'internal', 'L2'],
      ['low', 'prohibited', 'L0'],
    ] as const)('%s / %s -> %s', async (riskTier, dataClass, expected) => {
      const s = await seed();
      const intent = await registry.createIntent(s.scope, newIntent(s, { riskTier, dataClass }));
      expect(intent.max_autonomy).toBe(expected);
    });

    it('uses the PolicyEngine interface and the project configuration in force', async () => {
      const s = await seed('autonomy:\n  max_by_risk:\n    low: L1\n    medium: L1\n');
      const intent = await registry.createIntent(s.scope, newIntent(s));
      expect(intent.max_autonomy).toBe('L1');

      const stub = new Registry({
        policyFactory: (config) =>
          ({
            ...createSimplePolicyEngine({ config }),
            maxAutonomy: () => 'L0',
          }) satisfies PolicyEngine,
        now: () => NOW,
      });
      expect((await stub.createIntent(s.scope, newIntent(s))).max_autonomy).toBe('L0');
    });

    it('takes the default intent budget from the configuration', async () => {
      const s = await seed('budget:\n  default_intent_usd: 7.5\n');
      expect((await registry.createIntent(s.scope, newIntent(s))).budget_usd).toBe('7.500000');
      expect(
        (await registry.createIntent(s.scope, newIntent(s, { budgetUsd: '12.25' }))).budget_usd,
      ).toBe('12.250000');
    });

    it('refuses a stored configuration whose YAML was changed outside the platform', async () => {
      const s = await seed('budget:\n  default_intent_usd: 7.5\n');
      await tamper(t.name, `UPDATE project_configs SET config_yaml = $1 WHERE project_id = $2`, [
        'budget:\n  default_intent_usd: 70\n',
        s.projectId,
      ]);
      expect(await rejection(registry.createIntent(s.scope, newIntent(s)))).toBe(
        'config_hash_mismatch:',
      );
    });

    it('refuses a stored configuration whose hash no longer matches its unchanged YAML (B13 AC8)', async () => {
      // What a release that changes a default looks like: the start-up check re-hashes it.
      const s = await seed('budget:\n  default_intent_usd: 7.5\n');
      await tamper(t.name, `UPDATE project_configs SET config_hash = $1 WHERE project_id = $2`, [
        HASH('9'),
        s.projectId,
      ]);
      expect(await rejection(registry.createIntent(s.scope, newIntent(s)))).toBe(
        'config_defaults_drift:',
      );
    });

    it('stores plan versions with change flags, and spec versions', async () => {
      const s = await seed();
      const intent = await registry.createIntent(s.scope, newIntent(s));
      const actor = { actorType: 'human', actorId: s.personB } as const;
      const p1 = await registry.submitPlan(s.scope, intent.id, {
        ...actor,
        plannedFiles: ['apps/web/src/**'],
        planSha256: HASH('a'),
        changeFlags: ['migration', 'personal_data', 'migration'],
      });
      const p2 = await registry.submitPlan(s.scope, intent.id, {
        ...actor,
        plannedFiles: ['apps/api/src/orders.ts'],
        planSha256: HASH('b'),
      });
      expect(p1).toMatchObject({ version: 1, change_flags: ['migration', 'personal_data'] });
      expect(p2).toMatchObject({ version: 2, change_flags: [], proposed_by_type: 'human' });
      expect(await s.scope.plans.latest(intent.id)).toMatchObject({ id: p2.id });
      expect((await s.scope.plans.list(intent.id)).map((p) => p.change_flags)).toEqual([
        ['migration', 'personal_data'],
        [],
      ]);

      const spec = await registry.linkSpec(s.scope, intent.id, {
        actorType: 'human',
        actorId: s.personA,
        path: 'docs/specs/T01.md',
        commitSha: COMMIT,
        contentSha256: HASH('d'),
        structure: 'manual_heading',
        acceptanceCriteria: 1,
        sourceTool: 'manual',
      });
      expect(spec).toMatchObject({ version: 1, content_sha256: HASH('d') });
      expect(
        await rejection(
          registry.linkSpec(s.scope, intent.id, {
            actorType: 'human',
            actorId: s.personA,
            path: '../secrets.md',
            commitSha: COMMIT,
            contentSha256: HASH('d'),
            structure: 'manual_heading',
            acceptanceCriteria: 1,
          }),
        ),
      ).toBe('db:invalid_value');
    });
  });

  describe('AC3: gate decisions', () => {
    it('stores an approval with oversight mode, role, bound hash, scope and expiry from config', async () => {
      const s = await seed();
      const intent = await registry.createIntent(s.scope, newIntent(s));
      const decision = await registry.decide(
        s.scope,
        approve(s, intent, s.personA, {
          scope: { environment: 'staging', resources: ['db:orders', 'db:orders'] },
          reasonRef: 'https://github.com/org/shop/issues/1#issuecomment-1',
          eventSource: null,
        }),
      );
      expect(decision).toMatchObject({
        gate: 'G1',
        decision: 'approve',
        oversight_mode: 'HITL',
        approver_role: 'person_a',
        actor_type: 'human',
        decided_by: s.personA,
        input_sha256: HASH('1'),
        scope: { environment: 'staging', resources: ['db:orders'] },
        source: 'cli',
        voids_decision_id: null,
      });
      expect(decision.expires_at?.getTime()).toBe(NOW.getTime() + 7 * DAY_MS);
      expect(decision.config_hash).toMatch(/^[0-9a-f]{64}$/);

      const s2 = await seed('oversight:\n  approval_expiry: { value: 1, unit: days }\n');
      const i2 = await registry.createIntent(s2.scope, newIntent(s2));
      const d2 = await registry.decide(s2.scope, approve(s2, i2, s2.personA));
      expect(d2.expires_at?.getTime()).toBe(NOW.getTime() + DAY_MS);
      expect(d2.config_hash).not.toBe(decision.config_hash);
    });

    it('QUESTIONS #6: G4 at Low risk is a POLICY check decided by the system', async () => {
      const s = await seed();
      const intent = await registry.createIntent(s.scope, newIntent(s));
      const pass = await registry.decide(s.scope, {
        intentId: intent.id,
        gate: 'G4',
        decision: 'pass',
        actor: { type: 'system' },
        inputSha256: HASH('4'),
        source: 'workflow',
      });
      expect(pass).toMatchObject({
        oversight_mode: 'POLICY',
        actor_type: 'system',
        decided_by: null,
      });
      expect(
        await rejection(
          registry.decide(
            s.scope,
            approve(s, intent, s.personA, { gate: 'G4', decision: 'block', reasonCode: 'other' }),
          ),
        ),
      ).toBe('decision_not_allowed:no_human_decision');
      // The database refuses POLICY anywhere else, even without the registry.
      await expect(
        sql`INSERT INTO gate_decisions (tenant_id, intent_id, gate, decision, oversight_mode, actor_type, input_sha256, config_hash, source)
            VALUES (${s.scope.tenantId}, ${intent.id}, 'G3', 'pass', 'POLICY', 'system', ${HASH('3')}, ${HASH('3')}, 'workflow')`.execute(
          t.appAs(s.scope.tenantId),
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('a HITL gate never passes without a person; G2 at Low (HOTL) may', async () => {
      const s = await seed();
      const intent = await registry.createIntent(s.scope, newIntent(s));
      const system = (gate: 'G1' | 'G2') => ({
        intentId: intent.id,
        gate,
        decision: 'pass' as const,
        actor: { type: 'system' as const },
        inputSha256: HASH('2'),
        source: 'workflow' as const,
      });
      expect(await rejection(registry.decide(s.scope, system('G1')))).toBe(
        'decision_not_allowed:hitl_needs_a_person',
      );
      expect(await registry.decide(s.scope, system('G2'))).toMatchObject({
        oversight_mode: 'HOTL',
      });
    });

    it('QUESTIONS #21: a G5 breach never passes, even where G5 is HOTL', async () => {
      const s = await seed();
      const intent = await registry.createIntent(s.scope, newIntent(s));
      const g5 = {
        intentId: intent.id,
        gate: 'G5' as const,
        actor: { type: 'system' as const },
        inputSha256: HASH('5'),
        source: 'workflow' as const,
        context: { breached: true },
      };
      expect(await rejection(registry.decide(s.scope, { ...g5, decision: 'pass' }))).toBe(
        'decision_not_allowed:breach_never_passes',
      );
      const fail = await registry.decide(s.scope, {
        ...g5,
        decision: 'fail',
        reasonCode: 'budget_exceeded',
      });
      expect(fail).toMatchObject({ decision: 'fail', reason_code: 'budget_exceeded' });
    });

    it('FR-11: producers, people without the role and agents never approve; nothing is stored', async () => {
      const s = await seed();
      const intent = await registry.createIntent(s.scope, newIntent(s));
      const g7 = (actorId: string, producers: string[] = []) =>
        approve(s, intent, actorId, { gate: 'G7', producers });
      expect(await rejection(registry.decide(s.scope, g7(s.personB, [s.personB])))).toBe(
        'approval_refused:producer',
      );
      expect(await rejection(registry.decide(s.scope, g7(s.outsider)))).toBe(
        'approval_refused:role_missing',
      );
      expect(await rejection(registry.decide(s.scope, g7(s.personA)))).toBe(
        'approval_refused:role_missing',
      );
      const agent = {
        ...g7(s.personB),
        actor: { type: 'agent', id: s.personB },
      } as unknown as HumanDecisionInput;
      expect(await rejection(registry.decide(s.scope, agent))).toBe(
        'decision_not_allowed:agent_never_decides',
      );
      expect(await s.scope.gateDecisions.listForIntent(intent.id)).toEqual([]);
      // A revoked role does not count either.
      const [binding] = await s.scope.roleBindings.listForUser(s.personB);
      await s.scope.roleBindings.revoke(binding!.id);
      expect(await rejection(registry.decide(s.scope, g7(s.personB)))).toBe(
        'approval_refused:role_missing',
      );
    });

    it('FR-16: dual approval at G7 for a flagged plan needs Person B and a second approver', async () => {
      const s = await seed();
      const intent = await registry.createIntent(s.scope, newIntent(s));
      await registry.submitPlan(s.scope, intent.id, {
        actorType: 'human',
        actorId: s.personA,
        plannedFiles: ['apps/api/**'],
        planSha256: HASH('e'),
        changeFlags: ['personal_data'],
      });
      const g7 = (actorId: string) => approve(s, intent, actorId, { gate: 'G7' });
      const first = await registry.decide(s.scope, g7(s.personB));
      expect(first.approver_role).toBe('person_b');
      expect(await rejection(registry.decide(s.scope, g7(s.personB)))).toBe(
        'approval_refused:already_approved',
      );
      const second = await registry.decide(s.scope, g7(s.second));
      expect(second.approver_role).toBe('second_approver');
      expect(await rejection(registry.decide(s.scope, g7(s.personB)))).toBe(
        'approval_refused:already_approved',
      );
    });

    it('reason_code is required for reject; the explanation stays on the Git host', async () => {
      const s = await seed();
      const intent = await registry.createIntent(s.scope, newIntent(s));
      const reject = approve(s, intent, s.personA, { decision: 'reject' });
      expect(await rejection(registry.decide(s.scope, reject))).toBe(
        'decision_not_allowed:reason_required',
      );
      expect(
        await rejection(
          registry.decide(s.scope, {
            ...reject,
            reasonCode: 'spec_unclear',
            reasonRef: 'see the spec, Tanaka-san',
          }),
        ),
      ).toBe('db:invalid_value');
      const row = await registry.decide(s.scope, {
        ...reject,
        reasonCode: 'spec_unclear',
        reasonRef: 'https://github.com/org/shop/issues/3#issuecomment-9',
      });
      expect(row).toMatchObject({
        reason_code: 'spec_unclear',
        approver_role: 'person_a',
        expires_at: null,
      });
      await expect(
        sql`INSERT INTO gate_decisions (tenant_id, intent_id, gate, decision, oversight_mode, approver_role, actor_type, decided_by, input_sha256, config_hash, source)
            VALUES (${s.scope.tenantId}, ${intent.id}, 'G1', 'reject', 'HITL', 'person_a', 'human', ${s.personA}, ${HASH('1')}, ${HASH('1')}, 'cli')`.execute(
          t.appAs(s.scope.tenantId),
        ),
      ).rejects.toMatchObject({ code: '23514' });
      expect(Object.keys(row)).not.toContain('reason');
    });

    it('is append-only: platform_app has no UPDATE, DELETE or TRUNCATE; the owner is stopped by triggers', async () => {
      const s = await seed();
      const intent = await registry.createIntent(s.scope, newIntent(s));
      const row = await registry.decide(s.scope, approve(s, intent, s.personA));
      for (const statement of [
        sql`UPDATE gate_decisions SET decision = 'reject' WHERE id = ${row.id}`,
        sql`DELETE FROM gate_decisions WHERE id = ${row.id}`,
        // CASCADE: since B06, git_event_receipts references gate_decisions, and a plain TRUNCATE
        // is refused by that foreign key (0A000) before the trigger runs.
        sql`TRUNCATE gate_decisions CASCADE`,
      ]) {
        await expect(statement.execute(t.appRaw)).rejects.toMatchObject({ code: '42501' });
        await expect(statement.execute(t.owner)).rejects.toMatchObject({ code: 'SDA01' });
      }
    });

    describe('approval binding (FR-17): re-check writes void decisions', () => {
      async function approved(expiryDays = 7) {
        const s = await seed(
          `oversight:\n  approval_expiry: { value: ${String(expiryDays)}, unit: days }\n`,
        );
        const intent = await registry.createIntent(s.scope, newIntent(s));
        const approval = await registry.decide(
          s.scope,
          approve(s, intent, s.personA, { scope: { environment: 'staging' } }),
        );
        return { s, intent, approval };
      }
      const current = (intent: Intent, extra: object = {}) => ({
        intentId: intent.id,
        gate: 'G1' as const,
        inputSha256: HASH('1'),
        scope: { environment: 'staging' },
        ...extra,
      });

      it('keeps a valid approval', async () => {
        const { s, intent, approval } = await approved();
        const result = await registry.revalidateApprovals(s.scope, current(intent));
        expect(result.valid.map((a) => a.id)).toEqual([approval.id]);
        expect(result.voided).toEqual([]);
      });

      it.each([
        ['input_mismatch', { inputSha256: HASH('2') }, NOW],
        ['scope_mismatch', { scope: { environment: 'production' } }, NOW],
        ['expired', {}, new Date(NOW.getTime() + 7 * DAY_MS)],
      ] as const)('%s -> void, linked to the approval', async (reason, change, at) => {
        const { s, intent, approval } = await approved();
        const later = new Registry(deps(at));
        const result = await later.revalidateApprovals(s.scope, current(intent, change));
        expect(result.valid).toEqual([]);
        expect(result.voided).toHaveLength(1);
        expect(result.voided[0]).toMatchObject({
          decision: 'void',
          actor_type: 'system',
          reason_code: reason,
          voids_decision_id: approval.id,
          oversight_mode: approval.oversight_mode,
          input_sha256: approval.input_sha256,
        });
        // A voided approval is gone for good: no second void, not counted any more.
        const again = await later.revalidateApprovals(s.scope, current(intent, change));
        expect(again).toEqual({ valid: [], voided: [] });
        expect(await s.scope.gateDecisions.currentApprovalsFor(intent.id, 'G1')).toEqual([]);
        // After the void, the same person may approve the new input again.
        const fresh = await later.decide(
          s.scope,
          approve(s, intent, s.personA, { inputSha256: HASH('2') }),
        );
        expect(fresh.decision).toBe('approve');
      });

      it('the database refuses a second void of the same approval and a void of a non-approval', async () => {
        const { s, intent, approval } = await approved();
        const [voided] = (
          await registry.revalidateApprovals(s.scope, current(intent, { inputSha256: HASH('2') }))
        ).voided as GateDecisionRow[];
        const insertVoid = (target: string) =>
          sql`INSERT INTO gate_decisions (tenant_id, intent_id, gate, decision, oversight_mode, actor_type, reason_code, input_sha256, config_hash, source, voids_decision_id)
              VALUES (${s.scope.tenantId}, ${intent.id}, 'G1', 'void', 'HITL', 'system', 'expired', ${HASH('1')}, ${HASH('1')}, 'workflow', ${target})`.execute(
            t.appAs(s.scope.tenantId),
          );
        await expect(insertVoid(approval.id)).rejects.toMatchObject({ code: '23505' });
        await expect(insertVoid(voided!.id)).rejects.toMatchObject({ code: 'SDA04' });
      });

      it('an expired approval does not count towards dual approval', async () => {
        const s = await seed();
        const intent = await registry.createIntent(s.scope, newIntent(s, { riskTier: 'critical' }));
        const g7 = (id: string) => approve(s, intent, id, { gate: 'G7' });
        await registry.decide(s.scope, g7(s.personB));
        const later = new Registry(deps(new Date(NOW.getTime() + 8 * DAY_MS)));
        // Person B's approval expired, so Person B may approve again.
        expect((await later.decide(s.scope, g7(s.personB))).approver_role).toBe('person_b');
      });
    });
  });

  describe('AC4: every change is written to the audit log in the same transaction', () => {
    it('appends one event per change, and the chain stays intact', async () => {
      const s = await seed();
      const intent = await registry.createIntent(s.scope, newIntent(s));
      await registry.linkSpec(s.scope, intent.id, {
        actorType: 'system',
        actorId: null,
        path: 'docs/specs/T01.md',
        commitSha: COMMIT,
        contentSha256: HASH('d'),
        structure: 'manual_heading',
        acceptanceCriteria: 1,
      });
      await registry.submitPlan(s.scope, intent.id, {
        actorType: 'human',
        actorId: s.personA,
        plannedFiles: ['a.ts'],
        planSha256: HASH('a'),
      });
      await registry.decide(s.scope, approve(s, intent, s.personA));
      await registry.revalidateApprovals(s.scope, {
        intentId: intent.id,
        gate: 'G1',
        inputSha256: HASH('2'),
      });
      await s.scope.intents.updateState(intent.id, {
        status: 'in_gate',
        currentGate: 'G2',
        actorType: 'system',
        actorId: null,
      });
      expect(await auditActions(s)).toEqual([
        'intent.created',
        'spec.linked',
        'plan.submitted',
        'gate.decided',
        'gate.decided',
        'intent.state_changed',
      ]);
      expect((await s.scope.audit.verify()).broken).toBeUndefined();
      expect(
        await rejection(
          s.scope.intents.updateState(intent.id, {
            status: 'running',
            currentGate: 'G4',
            actorType: 'agent' as 'system',
            actorId: s.personA,
          }),
        ),
      ).toBe('db:invalid_value');

      const rows = (
        await sql<{ action: string; payload: Record<string, unknown>; actor_type: string }>`
          SELECT action, payload, actor_type FROM audit_log WHERE tenant_id = ${s.scope.tenantId} ORDER BY seq`.execute(
          t.owner,
        )
      ).rows;
      expect(rows[0]!.payload).toEqual({
        code: intent.code,
        project_id: s.projectId,
        risk_tier: 'low',
        data_class: 'internal',
        max_autonomy: 'L2',
      });
      expect(rows[4]!.payload).toMatchObject({ decision: 'void', reason_code: 'input_mismatch' });
      expect(rows[4]!.actor_type).toBe('system');
      // Never the title, paths, summaries or reasons.
      expect(JSON.stringify(rows)).not.toMatch(/Japanese|docs\/specs|a\.ts/);
    });

    it('a failing write leaves neither the row nor its audit event', async () => {
      const s = await seed();
      const intent = await registry.createIntent(s.scope, newIntent(s));
      const before = await auditActions(s);
      await expect(
        s.scope.transaction(async (tx) => {
          await registry.decide(tx, approve(s, intent, s.personA));
          throw new Error('crash after the write');
        }),
      ).rejects.toThrow('crash after the write');
      expect(await s.scope.gateDecisions.listForIntent(intent.id)).toEqual([]);
      expect(await auditActions(s)).toEqual(before);
      // A refused decision writes nothing either.
      await rejection(registry.decide(s.scope, approve(s, intent, s.outsider)));
      expect(await auditActions(s)).toEqual(before);
    });
  });

  it('D-05 D2: a plan cannot point to another tenant intent', async () => {
    const a = await seed();
    const b = await seed();
    const intent = await registry.createIntent(a.scope, newIntent(a));
    expect(
      await rejection(
        registry.submitPlan(b.scope, intent.id, {
          actorType: 'human',
          actorId: b.personA,
          plannedFiles: ['x'],
          planSha256: HASH('a'),
        }),
      ),
    ).toBe('intent_not_found:');
    await expect(
      sql`INSERT INTO plans (tenant_id, intent_id, version, planned_files, plan_sha256, proposed_by_type)
          VALUES (${b.scope.tenantId}, ${intent.id}, 1, '{x}', ${HASH('a')}, 'human')`.execute(
        t.appAs(b.scope.tenantId),
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });
});
