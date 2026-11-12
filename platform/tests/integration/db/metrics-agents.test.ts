// D-08 V13 on a live PostgreSQL, through the Nest app and Fastify `inject()` (no port): the agent
// efficiency report (ADR-M79). AC1: per agent version and model, from runs, run events, gate
// decisions, `intent.closed` and cost records, with no new table. AC2: every measure on seeded
// data. AC3: who may read it (QUESTIONS #430: a tenant admin, or a role in BOTH cost_read_roles
// and metrics_read_roles), the range, exact decimals, tenant isolation, and numbers and codes only.
// V14 AC2 (ADR-M79 §2.6): the merged intents' lead time against the human-effort estimate.
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp, type ApiDeps } from '../../../apps/api/src/app.js';
import { issueApiToken } from '../../../packages/core/src/admin/tokens.js';
import type { TenantScope } from '../../../packages/core/src/db/tenant-scope.js';
import { issueRun, seedOtherProject, seedRun, type SeededRun } from '../cost-seed.js';
import { tokenIssuedAt } from '../token-clock.js';
import { createTestDatabase, describeDb, tamper, type TestDatabase } from './helpers.js';

type App = Awaited<ReturnType<typeof createApp>>;
const asApiDb = (db: TestDatabase): ApiDeps['db'] => db.app as unknown as ApiDeps['db'];

const HOUR = 3_600_000;
const NOW = new Date();
const BASE = new Date(NOW.getTime() - 5 * 24 * HOUR);
const at = (hours: number) => new Date(BASE.getTime() + hours * HOUR);
const BIG = 'model-big';
const SMALL = 'model-small';
const PICK = 'model-pick';

type Who = 'admin' | 'a' | 'pm' | 'second' | 'viewer' | 'outsider';

interface Tenant {
  readonly seeded: SeededRun;
  readonly scope: TenantScope;
  readonly opsProjectId: string;
  readonly opsIntentId: string;
  readonly opsRunId: string;
  readonly tokens: Record<Who, string>;
  readonly emails: string[];
}

interface Row {
  readonly project: string;
  readonly agent: string;
  readonly agent_version: string;
  readonly model: string;
  readonly runs: {
    readonly total: number;
    readonly in_progress: number;
    readonly by_status: Record<string, number>;
    readonly by_stop_reason: Record<string, number>;
    readonly retries: number;
  };
  readonly ci: { readonly first_try_total: number; readonly first_try_passed: number };
  readonly merged: {
    readonly intents: number;
    readonly without_changes_requested: number;
    readonly lead_time: {
      readonly count: number;
      readonly avg_seconds: number | null;
      readonly max_seconds: number | null;
    };
    readonly human_effort: {
      readonly count: number;
      readonly estimate_hours_sum: string | null;
      readonly lead_time_seconds_sum: number | null;
      readonly lead_to_estimate_percent: number | null;
    };
  };
  readonly scope_breaches: number;
  readonly tokens: {
    readonly input: string;
    readonly output: string;
    readonly cached_input: string;
    readonly cache_share_percent: number | null;
  };
  readonly cost: {
    readonly total_usd: string;
    readonly wasted_usd: string;
    readonly per_run_usd: string | null;
    readonly per_merged_intent_usd: string | null;
  };
}

interface Metrics {
  readonly scope: Record<string, string>;
  readonly from: string;
  readonly to: string;
  readonly filters: Record<string, string | null>;
  readonly rows: readonly Row[];
  readonly unattributed_cost_usd: string;
  readonly truncated: boolean;
}

describeDb('V13: agent efficiency report on PostgreSQL', () => {
  let t0: TestDatabase;
  let app: App;
  let tenantA: Tenant;
  let tenantB: Tenant;
  let source = 0;

  async function record(
    scope: TenantScope,
    r: {
      projectId: string;
      intentId?: string | null;
      runId?: string | null;
      model: string;
      input: number;
      output: number;
      cached?: number;
      cost: string;
    },
  ): Promise<void> {
    await scope.costRecords.insertIfNew({
      projectId: r.projectId,
      intentId: r.intentId ?? null,
      runId: r.runId ?? null,
      gate: null,
      agent: null,
      model: r.model,
      providerType: 'api',
      inputTokens: r.input,
      outputTokens: r.output,
      cachedInputTokens: r.cached ?? 0,
      costUsd: r.cost,
      sourceRef: `req-${String(++source)}`,
      occurredAt: at(2),
    });
  }

  /** Sets a run's status, stop reason and creation time (the runner and workflow do this live). */
  const shapeRun = (runId: string, status: string, stopReason: string | null, created: Date) =>
    tamper(
      t0.name,
      `UPDATE runs SET status = $1, stop_reason = $2, created_at = $3 WHERE id = $4`,
      [status, stopReason, created, runId],
    );

  const event = (tenantId: string, runId: string, type: string, payload: object, when: Date) =>
    tamper(
      t0.name,
      `INSERT INTO run_events (tenant_id, run_id, event_type, payload, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [tenantId, runId, type, JSON.stringify(payload), when],
    );

  const decision = (
    tenantId: string,
    intentId: string,
    gate: string,
    kind: 'fail' | 'request_changes',
    when: Date,
    humanId?: string,
  ) =>
    tamper(
      t0.name,
      `INSERT INTO gate_decisions (tenant_id, intent_id, gate, decision, oversight_mode, actor_type,
         decided_by, approver_role, reason_code, input_sha256, config_hash, source, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, $11, $12)`,
      [
        tenantId,
        intentId,
        gate,
        kind,
        kind === 'fail' ? 'HOTL' : 'HITL',
        kind === 'fail' ? 'system' : 'human',
        kind === 'fail' ? null : (humanId ?? null),
        kind === 'fail' ? null : 'person_b',
        kind === 'fail' ? 'out_of_scope' : 'tests_insufficient',
        'd'.repeat(64),
        kind === 'fail' ? 'workflow' : 'cli',
        when,
      ],
    );

  const closed = (tenantId: string, intentId: string, leadSeconds: number, when: Date) =>
    tamper(
      t0.name,
      `INSERT INTO audit_log (tenant_id, seq, hash_version, actor_type, action, entity_type,
         entity_id, payload, prev_hash, hash, occurred_at)
       VALUES ($1, (SELECT coalesce(max(seq), 0) + 1 FROM audit_log WHERE tenant_id = $1), 1,
         'system', 'intent.closed', 'intent', $2, $3, $4, $4, $5)`,
      [
        tenantId,
        intentId,
        JSON.stringify({
          pack_id: randomUUID(),
          pack_version: 1,
          release_sha256: 'e'.repeat(64),
          lead_time_seconds: leadSeconds,
          runs: 1,
          g7_change_requests: 0,
          cost_usd: '0.9',
          input_tokens: '1',
          output_tokens: '1',
        }),
        '0'.repeat(64),
        when,
      ],
    );

  const ci = (tenantId: string, runId: string, state: string, when: Date) =>
    event(
      tenantId,
      runId,
      'ci_checked',
      {
        pr_number: 7,
        pr_state: 'open',
        head_sha: 'a'.repeat(40),
        state,
        checks_sha256: 'c'.repeat(64),
        findings: 'none',
        critical: 0,
        high: 0,
        medium: 0,
        low: 0,
      },
      when,
    );

  const merge = (tenantId: string, runId: string, when: Date) =>
    event(
      tenantId,
      runId,
      'pr_merged',
      { pr_number: 7, head_sha: 'a'.repeat(40), merge_commit_sha: 'b'.repeat(40) },
      when,
    );

  async function seedTenant(slug: string): Promise<Tenant> {
    const seeded = await seedRun(t0.app, { slug, models: [BIG, SMALL], now: at(0) });
    const { scope } = seeded;
    const ops = await seedOtherProject(seeded, { slug: 'ops', models: [BIG, SMALL], now: at(0) });
    const roles: Record<Who, string | null> = {
      admin: null,
      a: 'person_a',
      pm: 'pm_brse',
      second: 'second_approver',
      viewer: 'viewer',
      outsider: null,
    };
    const tokens = {} as Record<Who, string>;
    const emails: string[] = [];
    for (const [who, role] of Object.entries(roles) as [Who, string | null][]) {
      const email = `${who}@${slug}.example.com`;
      const user =
        who === 'a' ? seeded.personA : (await scope.users.create({ display_name: who, email })).id;
      emails.push(email);
      if (role) {
        await scope.roleBindings.grant({
          user_id: user,
          project_id: seeded.projectId,
          role: role as 'person_a',
        });
      }
      if (who === 'admin') await scope.tenantRoles.grant({ user_id: user, role: 'tenant_admin' });
      tokens[who] = (
        await issueApiToken(scope, { userId: user, name: who, now: tokenIssuedAt() })
      ).token;
    }
    return {
      seeded,
      scope,
      opsProjectId: ops.projectId,
      opsIntentId: ops.intentId,
      opsRunId: ops.runId,
      tokens,
      emails,
    };
  }

  const inject = async (url: string, token: string) =>
    await app
      .getHttpAdapter()
      .getInstance()
      .inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });

  const metrics = async (url: string, token: string): Promise<Metrics> => {
    const reply = await inject(url, token);
    expect(reply.statusCode, reply.body).toBe(200);
    return reply.json<{ metrics: Metrics }>().metrics;
  };

  const refused = async (url: string, token: string, status: number, code: string) => {
    const reply = await inject(url, token);
    expect(reply.statusCode, reply.body).toBe(status);
    expect(reply.json<{ error: { code: string } }>().error.code).toBe(code);
    return reply.json<{ error: { details?: { path: string; issue: string }[] } }>();
  };

  const find = (m: Metrics, project: string, model: string): Row => {
    const row = m.rows.find((r) => r.project === project && r.model === model);
    if (!row) throw new Error(`no row ${project}/${model}`);
    return row;
  };

  beforeAll(async () => {
    t0 = await createTestDatabase();
    tenantA = await seedTenant('acme');
    tenantB = await seedTenant('other');
    const a = tenantA;
    const id = a.scope.tenantId;
    const shop = a.seeded.projectId;
    const intent = a.seeded.intentId;
    const ids = {
      intentId: intent,
      planId: a.seeded.planId,
      personA: a.seeded.personA,
      agentId: a.seeded.agentId,
    };
    const opts = { models: [BIG, SMALL], now: at(0) };
    const r1 = a.seeded.runId; // attempt 1: failed, its CI failed on the first try
    const r2 = await issueRun(a.scope, ids, opts); // attempt 2: succeeded and merged
    const r3 = await issueRun(a.scope, ids, opts); // attempt 3: killed, no cost records
    const r4 = await issueRun(a.scope, ids, opts); // attempt 4: still running
    await shapeRun(r1, 'failed', 'agent_error', at(0));
    await shapeRun(r2, 'succeeded', null, at(1));
    await shapeRun(r3, 'stopped_killed', 'killed', at(2));
    await shapeRun(r4, 'running', null, at(3));
    const q1 = a.opsIntentId;
    const opsRun = a.opsRunId;
    await shapeRun(opsRun, 'succeeded', null, at(1));
    // 0.5 + 0.3 + 0.1 must be exactly 0.9: money is never a float.
    await record(a.scope, {
      projectId: shop,
      intentId: intent,
      runId: r1,
      model: BIG,
      input: 1000,
      output: 200,
      cached: 100,
      cost: '0.5',
    });
    await record(a.scope, {
      projectId: shop,
      intentId: intent,
      runId: r2,
      model: BIG,
      input: 400,
      output: 100,
      cost: '0.3',
    });
    await record(a.scope, {
      projectId: shop,
      intentId: intent,
      runId: r2,
      model: SMALL,
      input: 50,
      output: 10,
      cost: '0.1',
    });
    await record(a.scope, {
      projectId: a.opsProjectId,
      intentId: q1,
      runId: opsRun,
      model: BIG,
      input: 10,
      output: 5,
      cost: '0.2',
    });
    // A cost record with no run: counted apart, never in a row.
    await record(a.scope, { projectId: shop, model: BIG, input: 1, output: 1, cost: '1' });
    // QUESTIONS #434: the model G4 chose (run event) wins; runs without it fall back to cost.
    await event(id, r3, 'model_selected', { model: PICK }, at(2));
    await event(id, opsRun, 'model_selected', { model: SMALL }, at(1)); // its cost is all BIG
    await ci(id, r1, 'failed', at(0.4)); // the first CI of the intent: not passed
    await ci(id, r2, 'passed', at(1.1));
    await decision(id, intent, 'G7', 'request_changes', at(1.05), a.seeded.personA); // before the merge
    await decision(id, intent, 'G5', 'fail', at(1.5)); // after r2, before r3: counted under r2
    await merge(id, r2, at(1.2));
    await closed(id, intent, 7200, at(1.3));
    await ci(id, opsRun, 'passed', at(1.1));
    await merge(id, opsRun, at(1.2));
    await closed(id, q1, 1800, at(1.3));
    // V14: Person A estimated 4 hours for the shop intent; the ops intent has no estimate.
    await a.scope.intents.recordEffortEstimate(intent, {
      hours: '4',
      actorId: a.seeded.personA,
    });
    // Another tenant's data is never counted.
    const b = tenantB;
    await shapeRun(b.seeded.runId, 'failed', 'agent_error', at(0));
    await shapeRun(b.opsRunId, 'succeeded', null, at(0));
    await record(b.scope, {
      projectId: b.seeded.projectId,
      intentId: b.seeded.intentId,
      runId: b.seeded.runId,
      model: BIG,
      input: 777,
      output: 777,
      cost: '77.7',
    });
    app = await createApp({
      db: asApiDb(t0),
      settings: { rateLimitPerMinute: 1000, authFailuresPerMinute: 1000 },
      now: () => NOW,
      logger: { error: () => undefined },
    });
  }, 90_000);

  afterAll(async () => {
    await app?.close();
    await t0?.drop();
  });

  describe('AC1, AC2: the measures (tenant admin, the last 30 days)', () => {
    it('groups by project, agent version and the model with the most cost', async () => {
      const m = await metrics('/v1/metrics/agents', tenantA.tokens.admin);
      expect(m.scope).toEqual({ kind: 'tenant' });
      expect(m.rows.map((r) => [r.project, r.model])).toEqual([
        ['ops', SMALL],
        ['shop', BIG],
        ['shop', PICK],
        ['shop', 'unknown'],
      ]);
      expect(new Set(m.rows.map((r) => r.agent_version))).toEqual(new Set(['1.4.0']));
      expect(m.unattributed_cost_usd).toBe('1.000000');
      expect(m.truncated).toBe(false);
    });

    it('counts runs by status and stop reason, retries and runs in progress', async () => {
      const m = await metrics('/v1/metrics/agents', tenantA.tokens.admin);
      expect(find(m, 'shop', BIG).runs).toEqual({
        total: 2,
        in_progress: 0,
        by_status: { failed: 1, succeeded: 1 },
        by_stop_reason: { agent_error: 1 },
        retries: 1,
      });
      expect(find(m, 'shop', PICK).runs).toEqual({
        total: 1,
        in_progress: 0,
        by_status: { stopped_killed: 1 },
        by_stop_reason: { killed: 1 },
        retries: 1,
      });
      expect(find(m, 'shop', 'unknown').runs).toEqual({
        total: 1,
        in_progress: 1,
        by_status: { running: 1 },
        by_stop_reason: {},
        retries: 1,
      });
    });

    it('measures CI on the first try, the G7 changes, the G5 breaches and the lead time', async () => {
      const m = await metrics('/v1/metrics/agents', tenantA.tokens.admin);
      const shop = find(m, 'shop', BIG);
      // The first CI of the intent failed (r1); r2's later CI passing does not count.
      expect(shop.ci).toEqual({ first_try_total: 1, first_try_passed: 0 });
      // The merged run is r2; a G7 request for changes came before the merge.
      expect(shop.merged).toEqual({
        intents: 1,
        without_changes_requested: 0,
        lead_time: { count: 1, avg_seconds: 7200, max_seconds: 7200 },
        // V14 AC2: 7200 s of lead time against an estimate of 4 hours (14400 s) = 50 %.
        human_effort: {
          count: 1,
          estimate_hours_sum: '4',
          lead_time_seconds_sum: 7200,
          lead_to_estimate_percent: 50,
        },
      });
      expect(shop.scope_breaches).toBe(1);
      const ops = find(m, 'ops', SMALL);
      expect(ops.ci).toEqual({ first_try_total: 1, first_try_passed: 1 });
      expect(ops.merged).toEqual({
        intents: 1,
        without_changes_requested: 1,
        lead_time: { count: 1, avg_seconds: 1800, max_seconds: 1800 },
        // V14 AC2: no estimate → null, never 0.
        human_effort: {
          count: 0,
          estimate_hours_sum: null,
          lead_time_seconds_sum: null,
          lead_to_estimate_percent: null,
        },
      });
      expect(ops.scope_breaches).toBe(0);
      expect(find(m, 'shop', 'unknown').ci).toEqual({ first_try_total: 0, first_try_passed: 0 });
    });

    it('sums tokens and cost exactly: wasted, per run, per merged intent, cache share', async () => {
      const m = await metrics('/v1/metrics/agents', tenantA.tokens.admin);
      const shop = find(m, 'shop', BIG);
      expect(shop.tokens).toEqual({
        input: '1450',
        output: '310',
        cached_input: '100',
        cache_share_percent: 6.9,
      });
      expect(shop.cost).toEqual({
        total_usd: '0.900000',
        wasted_usd: '0.500000',
        per_run_usd: '0.450000',
        // The whole cost of the merged intent (all its runs), once.
        per_merged_intent_usd: '0.900000',
      });
      // A row without cost records: zero amounts, a share of null (no input), never a guess.
      expect(find(m, 'shop', 'unknown').tokens.cache_share_percent).toBeNull();
      expect(find(m, 'shop', 'unknown').cost).toEqual({
        total_usd: '0.000000',
        wasted_usd: '0.000000',
        per_run_usd: '0.000000',
        per_merged_intent_usd: null,
      });
    });

    it('takes the model from model_selected first, then from the cost records (QUESTIONS #434)', async () => {
      const m = await metrics('/v1/metrics/agents', tenantA.tokens.admin);
      // The ops run's only cost is on BIG, but G4 chose SMALL: the event wins, the cost follows.
      expect(m.rows.some((r) => r.project === 'ops' && r.model === BIG)).toBe(false);
      expect(find(m, 'ops', SMALL).cost.total_usd).toBe('0.200000');
      // r3 has no cost record: the event still names its model.
      expect(find(m, 'shop', PICK).runs.total).toBe(1);
      // r1 and r2 have no event (older runs): the most costly model of their records.
      expect(find(m, 'shop', BIG).runs.total).toBe(2);
    });

    it('filters by agent and model, and by project', async () => {
      const agent = (await metrics('/v1/metrics/agents', tenantA.tokens.admin)).rows[0]!.agent;
      const byModel = await metrics(
        `/v1/metrics/agents?agent=${agent}&model=${BIG}&project=shop`,
        tenantA.tokens.admin,
      );
      expect(byModel.rows.map((r) => [r.project, r.model])).toEqual([['shop', BIG]]);
      expect(byModel.filters).toEqual({ agent, model: BIG });
      const none = await metrics('/v1/metrics/agents?agent=nobody', tenantA.tokens.admin);
      expect(none.rows).toEqual([]);
    });

    it('takes runs created in the half-open range [from, to)', async () => {
      const day = (d: Date) => d.toISOString().slice(0, 10);
      const after = await metrics(
        `/v1/metrics/agents?from=${day(new Date(NOW.getTime() - 24 * HOUR))}`,
        tenantA.tokens.admin,
      );
      expect(after.rows).toEqual([]);
      const exact = await metrics(
        `/v1/metrics/agents?from=${at(1)
          .toISOString()
          .replace(/\.\d+Z$/, 'Z')}&to=${at(2)
          .toISOString()
          .replace(/\.\d+Z$/, 'Z')}`,
        tenantA.tokens.admin,
      );
      // Only r2 and the ops run were created in [at(1), at(2)); r3 at at(2) is excluded.
      expect(exact.rows.map((r) => [r.project, r.runs.total])).toEqual([
        ['ops', 1],
        ['shop', 1],
      ]);
    });

    it('holds codes, counts and amounts only: no e-mail, name or user ID', async () => {
      const body = (await inject('/v1/metrics/agents', tenantA.tokens.admin)).body;
      for (const email of tenantA.emails) expect(body).not.toContain(email);
      expect(body).not.toContain(tenantA.seeded.personA);
      expect(body).not.toMatch(/"(user|actor|person)/);
    });
  });

  describe('AC3: who may read it (QUESTIONS #430) and tenant isolation', () => {
    it('lets a role in both lists read one project, and a tenant admin the whole tenant', async () => {
      const a = await metrics('/v1/metrics/agents?project=shop', tenantA.tokens.a);
      expect(a.scope).toEqual({ kind: 'project', project: 'shop' });
      expect(a.rows.map((r) => r.project)).toEqual(['shop', 'shop', 'shop']);
      await metrics('/v1/metrics/agents?project=shop', tenantA.tokens.pm);
      await metrics('/v1/metrics/agents?project=ops', tenantA.tokens.admin);
    });

    it('refuses: a role in only one list and the viewer (403), no role (404)', async () => {
      const url = '/v1/metrics/agents?project=shop';
      // second_approver reads metrics but not cost: the report needs both.
      await refused(url, tenantA.tokens.second, 403, 'forbidden');
      await refused(url, tenantA.tokens.viewer, 403, 'forbidden');
      await refused(url, tenantA.tokens.outsider, 404, 'project_not_found');
      await refused('/v1/metrics/agents?project=ops', tenantA.tokens.a, 404, 'project_not_found');
      await refused(
        '/v1/metrics/agents?project=nope',
        tenantA.tokens.admin,
        404,
        'project_not_found',
      );
    });

    it('refuses the whole tenant without a tenant admin (403)', async () => {
      await refused('/v1/metrics/agents', tenantA.tokens.a, 403, 'forbidden');
      await refused('/v1/metrics/agents', tenantA.tokens.pm, 403, 'forbidden');
    });

    it('refuses a bad range and an unknown parameter (400)', async () => {
      const t = tenantA.tokens.admin;
      const empty = await refused(
        '/v1/metrics/agents?from=2026-09-02&to=2026-09-01',
        t,
        400,
        'invalid_request',
      );
      expect(empty.error.details).toEqual([{ path: 'query.to', issue: 'range_empty' }]);
      const long = await refused(
        '/v1/metrics/agents?from=2024-01-01&to=2026-01-01',
        t,
        400,
        'invalid_request',
      );
      expect(long.error.details).toEqual([{ path: 'query.to', issue: 'range_too_long' }]);
      await refused('/v1/metrics/agents?from=yesterday', t, 400, 'invalid_request');
      await refused('/v1/metrics/agents?person=x', t, 400, 'invalid_request');
    });

    it('never counts another tenant', async () => {
      const m = await metrics('/v1/metrics/agents', tenantB.tokens.admin);
      expect(m.rows.map((r) => [r.project, r.runs.total])).toEqual([
        ['ops', 1],
        ['shop', 1],
      ]);
      expect(find(m, 'shop', BIG).cost.total_usd).toBe('77.700000');
      expect(m.unattributed_cost_usd).toBe('0.000000');
    });
  });
});
