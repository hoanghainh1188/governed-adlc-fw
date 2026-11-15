// D-08 C03 on a live PostgreSQL, with a fake model gateway (the live LiteLLM test is
// tests/integration/litellm/litellm-live.test.ts).
// AC2: one key per run with the seven labels, the contract's models and a cap. AC3: endRun revokes
// the key first. AC4: sync into cost_records, never twice. AC5 / FR-51: the cap is the smallest of
// run, intent and tenant-month budgets; an exhausted intent or tenant budget is refused.
// Also: cost_records is append-only and tenant-safe (D-05 D2, D3).
import crypto from 'node:crypto';

import type {
  CostLabels,
  CreateRunKey,
  ModelGateway,
  ModelRef,
  SpendRecord,
  TenantBudget,
  VirtualKey,
} from '@sdlc/contracts';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CostController,
  CostError,
  type CostLogEvent,
} from '../../../packages/core/src/cost/index.js';
import { DbError } from '../../../packages/core/src/db/errors.js';
import { seedRun, type SeededRun } from '../cost-seed.js';
import { createTestDatabase, describeDb, tamper, type TestDatabase } from './helpers.js';

const NOW = new Date('2026-09-26T08:00:00.000Z');
const MODEL = 'claude-haiku-4-5';
const HASH = (c: string) => c.repeat(64);

class FakeGateway implements ModelGateway {
  readonly calls: string[] = [];
  readonly keys: CreateRunKey[] = [];
  readonly budgets: TenantBudget[] = [];
  spend: SpendRecord[] = [];
  unreadable = 0;
  models: ModelRef[] = [{ model: MODEL, providerType: 'api' }];
  failListSpend = false;

  ensureTenantBudget(input: TenantBudget) {
    this.calls.push('ensureTenantBudget');
    this.budgets.push(input);
    return Promise.resolve({ tenantGroupId: `sdlc-tenant-${input.tenantSlug}` });
  }
  createRunKey(input: CreateRunKey): Promise<VirtualKey> {
    this.calls.push('createRunKey');
    this.keys.push(input);
    return Promise.resolve({
      keyId: HASH('f'),
      key: { reveal: () => 'sk-virtual' },
      expiresAt: new Date(NOW.getTime() + input.durationMinutes * 60_000),
    });
  }
  revokeKey() {
    this.calls.push('revokeKey');
    return Promise.resolve();
  }
  revokeRunKey() {
    this.calls.push('revokeRunKey');
    return Promise.resolve();
  }
  getSpend() {
    return Promise.resolve({ spendUsd: '0', maxBudgetUsd: null });
  }
  listModels() {
    return Promise.resolve(this.models);
  }
  listSpend() {
    this.calls.push('listSpend');
    if (this.failListSpend) return Promise.reject(new Error('gateway down'));
    return Promise.resolve({ records: this.spend, unreadable: this.unreadable });
  }
}

type Seeded = SeededRun;

describeDb('C03: Cost Controller on PostgreSQL', () => {
  let t: TestDatabase;
  let tenantCount = 0;

  beforeAll(async () => {
    t = await createTestDatabase();
  }, 60_000);
  afterAll(() => t?.drop());

  const seed = (
    options: { monthly?: string | null; intentBudget?: string; runBudget?: string } = {},
  ): Promise<Seeded> =>
    seedRun(t.app, {
      ...options,
      slug: `acme-${String(++tenantCount)}`,
      models: [MODEL],
      now: NOW,
    });

  function controller(gateway = new FakeGateway(), now = NOW) {
    const logs: [string, CostLogEvent, Record<string, unknown>][] = [];
    const c = new CostController({
      gateway,
      db: t.app,
      now: () => now,
      logger: { log: (level, event, fields) => logs.push([level, event, { ...fields }]) },
    });
    return { c, gateway, logs };
  }

  const labelsOf = (s: Seeded): CostLabels => ({
    tenant: s.slug,
    project: 'shop',
    intent_id: s.intentCode,
    run_id: s.runId,
    gate: 'G4',
    agent: 'coder-openhands',
    data_class: 'internal',
  });

  let refCount = 0;
  const call = (s: Seeded, extra: Partial<SpendRecord> = {}): SpendRecord => ({
    sourceRef: `chatcmpl-${String(++refCount)}`,
    model: MODEL,
    status: 'success',
    inputTokens: 1000,
    outputTokens: 100,
    cachedInputTokens: 200,
    costUsd: '0.0012',
    occurredAt: NOW,
    labels: labelsOf(s),
    ...extra,
  });

  /** Spend already recorded for the intent (a previous run). */
  async function spent(s: Seeded, costUsd: string, occurredAt = NOW): Promise<void> {
    await s.scope.costRecords.insertIfNew({
      projectId: s.projectId,
      intentId: s.intentId,
      runId: s.runId,
      gate: 'G4',
      agent: 'coder-openhands',
      model: MODEL,
      providerType: 'api',
      inputTokens: 1,
      outputTokens: 1,
      cachedInputTokens: 0,
      costUsd,
      sourceRef: `prior-${String(++refCount)}`,
      occurredAt,
    });
  }

  async function errorCode(promise: Promise<unknown>): Promise<string> {
    try {
      await promise;
    } catch (error) {
      if (error instanceof CostError || error instanceof DbError) return error.code;
      throw error;
    }
    return 'resolved';
  }

  describe('AC2: issueRunKey', () => {
    it('labels from the database, models and cap from the Run Contract, tenant team first', async () => {
      const s = await seed();
      const { c, gateway } = controller();
      const issued = await c.issueRunKey({
        tenantId: s.scope.tenantId,
        runId: s.runId,
        gate: 'G4',
        agent: 'coder-openhands',
      });
      expect(gateway.calls).toEqual(['ensureTenantBudget', 'createRunKey']);
      expect(gateway.budgets).toEqual([{ tenantSlug: s.slug, monthlyBudgetUsd: '100' }]);
      expect(gateway.keys).toEqual([
        {
          runId: s.runId,
          labels: labelsOf(s),
          maxBudgetUsd: '2',
          models: [MODEL],
          // max_duration_min 60 + the contract's 15-minute start window
          durationMinutes: 75,
          tenantGroupId: `sdlc-tenant-${s.slug}`,
        },
      ]);
      expect([issued.maxBudgetUsd, issued.limitedBy]).toEqual(['2', 'run']);
      expect(issued.labels).toEqual(labelsOf(s));
    });

    it('refuses a label that is not a code, before calling the gateway', async () => {
      const s = await seed();
      const { c, gateway } = controller();
      const input = { tenantId: s.scope.tenantId, runId: s.runId, gate: 'G4' } as const;
      expect(await errorCode(c.issueRunKey({ ...input, agent: 'coder openhands' }))).toBe(
        'invalid_label',
      );
      expect(await errorCode(c.issueRunKey({ ...input, agent: 'x@example.com' }))).toBe(
        'invalid_label',
      );
      expect(gateway.calls).toEqual([]);
    });

    it('refuses an unknown run, and a run of another tenant', async () => {
      const a = await seed();
      const b = await seed();
      const { c } = controller();
      const input = { gate: 'G4', agent: 'coder-openhands' } as const;
      expect(
        await errorCode(c.issueRunKey({ ...input, tenantId: a.scope.tenantId, runId: b.runId })),
      ).toBe('run_not_found');
      expect(
        await errorCode(
          c.issueRunKey({ ...input, tenantId: a.scope.tenantId, runId: crypto.randomUUID() }),
        ),
      ).toBe('run_not_found');
    });

    it('refuses a run that has already started', async () => {
      const s = await seed();
      await sql`UPDATE runs SET status = 'running' WHERE id = ${s.runId}`.execute(
        t.appAs(s.scope.tenantId),
      );
      const { c, gateway } = controller();
      expect(
        await errorCode(
          c.issueRunKey({ tenantId: s.scope.tenantId, runId: s.runId, gate: 'G4', agent: 'a' }),
        ),
      ).toBe('run_not_startable');
      expect(gateway.calls).toEqual([]);
    });
  });

  describe('AC5 / FR-51: budgets at three levels', () => {
    const issue = (c: CostController, s: Seeded) =>
      c.issueRunKey({ tenantId: s.scope.tenantId, runId: s.runId, gate: 'G4', agent: 'a' });

    it('intent level: the cap is what is left of the intent budget', async () => {
      const s = await seed({ intentBudget: '3', runBudget: '2' });
      await spent(s, '1.25');
      const { c } = controller();
      const issued = await issue(c, s);
      expect([issued.maxBudgetUsd, issued.limitedBy]).toEqual(['1.75', 'intent']);
    });

    it('intent level: nothing left → refused, no key is created', async () => {
      const s = await seed({ intentBudget: '1' });
      await spent(s, '0.6');
      await spent(s, '0.4');
      const { c, gateway } = controller();
      expect(await errorCode(issue(c, s))).toBe('intent_budget_exhausted');
      expect(gateway.calls).toEqual([]);
    });

    it('tenant level: the cap is what is left of this UTC month; last month does not count', async () => {
      const s = await seed({ monthly: '5', intentBudget: '100', runBudget: '3' });
      await spent(s, '4', new Date('2026-08-31T23:59:59.000Z')); // August (UTC)
      await spent(s, '3.5', new Date('2026-09-01T00:00:00.000Z')); // September
      const { c } = controller();
      const issued = await issue(c, s);
      expect([issued.maxBudgetUsd, issued.limitedBy]).toEqual(['1.5', 'tenant']);
    });

    it('tenant level: nothing left this month → refused', async () => {
      const s = await seed({ monthly: '2', intentBudget: '100' });
      await spent(s, '2');
      const { c, gateway } = controller();
      expect(await errorCode(issue(c, s))).toBe('tenant_budget_exhausted');
      expect(gateway.calls).toEqual([]);
    });

    it('tenant level: no monthly budget → no team cap, and a warning is logged', async () => {
      const s = await seed({ monthly: null });
      const { c, gateway, logs } = controller();
      const issued = await issue(c, s);
      expect(issued.limitedBy).toBe('run');
      expect(gateway.budgets).toEqual([{ tenantSlug: s.slug, monthlyBudgetUsd: null }]);
      expect(logs).toContainEqual([
        'warn',
        'cost.tenant_budget_unset',
        { tenant_id: s.scope.tenantId },
      ]);
    });
  });

  describe('AC4: syncSpend', () => {
    it('records each call once, with IDs from the database; a second sync inserts nothing', async () => {
      const s = await seed();
      const { c, gateway } = controller();
      gateway.spend = [
        call(s),
        call(s, { costUsd: '0.0005', occurredAt: new Date(NOW.getTime() + 1000) }),
      ];
      const range = {
        from: new Date(NOW.getTime() - 60_000),
        to: new Date(NOW.getTime() + 60_000),
      };
      expect(await c.syncSpend(range)).toEqual({
        seen: 2,
        inserted: 2,
        duplicates: 0,
        skipped: {},
      });
      expect(await c.syncSpend(range)).toEqual({
        seen: 2,
        inserted: 0,
        duplicates: 2,
        skipped: {},
      });

      const rows = await s.scope.costRecords.listForRun(s.runId);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        tenant_id: s.scope.tenantId,
        project_id: s.projectId,
        intent_id: s.intentId,
        run_id: s.runId,
        gate: 'G4',
        agent: 'coder-openhands',
        model: MODEL,
        provider_type: 'api',
        input_tokens: '1000',
        output_tokens: '100',
        cached_input_tokens: '200',
        cost_usd: '0.001200',
      });
      expect(await s.scope.costRecords.totalForIntent(s.intentId)).toBe('0.001700');
    });

    it('never drops a call silently: every skipped call is counted by reason and logged', async () => {
      const a = await seed();
      const b = await seed();
      const { c, gateway, logs } = controller();
      gateway.spend = [
        call(a, {
          status: 'failure',
          inputTokens: 0,
          outputTokens: 0,
          cachedInputTokens: 0,
          costUsd: '0',
        }),
        call(a, { labels: {} }),
        call(a, { labels: { ...labelsOf(a), tenant: 'nobody' } }),
        // Tenant B's label with tenant A's run: never crosses tenants.
        call(a, { labels: { ...labelsOf(a), tenant: b.slug } }),
        call(a, { labels: { ...labelsOf(a), intent_id: 'INT-2026-9999' } }),
        call(a, { labels: { ...labelsOf(a), project: 'other' } }),
        call(a, { model: 'not-served' }),
        call(a),
      ];
      gateway.unreadable = 2;
      const result = await c.syncSpend({ from: new Date(0), to: new Date(NOW.getTime() + 1) });
      expect(result).toEqual({
        seen: 10,
        inserted: 1,
        duplicates: 0,
        skipped: {
          no_usage: 1,
          unlabelled: 1,
          unknown_tenant: 1,
          unknown_run: 1,
          label_mismatch: 2,
          unknown_model: 1,
          unreadable: 2,
        },
      });
      expect(logs).toContainEqual([
        'warn',
        'cost.sync_skipped',
        { unreadable: 2, unknown_tenant: 1, unknown_run: 1, label_mismatch: 2, unknown_model: 1 },
      ]);
      expect(await b.scope.costRecords.listForRun(a.runId)).toEqual([]);
    });

    it('a failed call that still cost something is recorded', async () => {
      const s = await seed();
      const { c, gateway } = controller();
      gateway.spend = [call(s, { status: 'failure', costUsd: '0.0003' })];
      expect(
        (await c.syncSpend({ from: new Date(0), to: new Date(NOW.getTime() + 1) })).inserted,
      ).toBe(1);
    });
  });

  describe('AC3: endRun', () => {
    it('revokes the key, then syncs the run spend', async () => {
      const s = await seed();
      const { c, gateway } = controller(new FakeGateway(), new Date(NOW.getTime() + 60_000));
      gateway.spend = [call(s)];
      const result = await c.endRun({ keyId: HASH('f'), syncFrom: NOW });
      expect(gateway.calls).toEqual(['revokeKey', 'listSpend']);
      expect(result.inserted).toBe(1);
    });

    it('revokes the key even when the sync fails', async () => {
      const { c, gateway } = controller();
      gateway.failListSpend = true;
      await expect(c.endRun({ keyId: HASH('f'), syncFrom: NOW })).rejects.toThrow('gateway down');
      expect(gateway.calls[0]).toBe('revokeKey');
    });
  });

  describe('cost_records is append-only and tenant-safe (D-05 D2, D3)', () => {
    it('platform_app cannot UPDATE, DELETE or TRUNCATE (no grant)', async () => {
      for (const statement of [
        sql`UPDATE cost_records SET cost_usd = 0`,
        sql`DELETE FROM cost_records`,
        sql`TRUNCATE cost_records`,
      ]) {
        await expect(statement.execute(t.appRaw)).rejects.toMatchObject({ code: '42501' });
      }
    });

    it('the owner cannot either (trigger); a superuser edit is possible only with triggers off', async () => {
      const s = await seed();
      await spent(s, '1');
      for (const statement of [
        sql`UPDATE cost_records SET cost_usd = 0`,
        sql`DELETE FROM cost_records`,
        sql`TRUNCATE cost_records`,
      ]) {
        await expect(statement.execute(t.owner)).rejects.toMatchObject({ code: 'SDA01' });
      }
      // The admin path of the A07 tamper test still works (for completeness, not a feature).
      await tamper(t.name, `UPDATE cost_records SET cost_usd = 0 WHERE tenant_id = $1`, [
        s.scope.tenantId,
      ]);
    });

    it("refuses a record that points at another tenant's project or run", async () => {
      const a = await seed();
      const b = await seed();
      const record = {
        projectId: b.projectId,
        intentId: null,
        runId: null,
        gate: null,
        agent: null,
        model: MODEL,
        providerType: 'api',
        inputTokens: 1,
        outputTokens: 1,
        cachedInputTokens: 0,
        costUsd: '0.1',
        sourceRef: 'cross-1',
        occurredAt: NOW,
      } as const;
      expect(await errorCode(a.scope.costRecords.insertIfNew(record))).toBe('reference_not_found');
      expect(
        await errorCode(
          a.scope.costRecords.insertIfNew({
            ...record,
            projectId: a.projectId,
            intentId: b.intentId,
            runId: b.runId,
          }),
        ),
      ).toBe('reference_not_found');
    });

    it('the same source_ref may exist once per tenant', async () => {
      const a = await seed();
      const b = await seed();
      const { c, gateway } = controller();
      const ref = 'shared-ref-1';
      gateway.spend = [call(a, { sourceRef: ref }), call(b, { sourceRef: ref })];
      expect(
        (await c.syncSpend({ from: new Date(0), to: new Date(NOW.getTime() + 1) })).inserted,
      ).toBe(2);
    });

    it('refuses free text and bad amounts before the database', async () => {
      const s = await seed();
      const base = {
        projectId: s.projectId,
        intentId: s.intentId,
        runId: s.runId,
        gate: 'G4',
        agent: 'coder-openhands',
        model: MODEL,
        providerType: 'api',
        inputTokens: 10,
        outputTokens: 1,
        cachedInputTokens: 0,
        costUsd: '0.1',
        sourceRef: 'ok-1',
        occurredAt: NOW,
      } as const;
      for (const bad of [
        { agent: 'the coder' },
        { model: 'model with spaces' },
        { sourceRef: 'a b' },
        { costUsd: '0.0000001' },
        { costUsd: '-1' },
        { inputTokens: -1 },
        { cachedInputTokens: 11 },
        { runId: s.runId, intentId: null },
      ]) {
        expect(
          await errorCode(s.scope.costRecords.insertIfNew({ ...base, ...bad })),
          JSON.stringify(bad),
        ).toBe('invalid_value');
      }
    });
  });
});
