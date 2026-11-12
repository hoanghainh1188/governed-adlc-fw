// Agent efficiency metrics (task V13, D-02 FR-12, FR-53, D-07 §5, design/ADR-M79). Read only:
// grouped queries per (project, agent key, agent version, model), always for one tenant, with
// `tenant_id = <tenant>` on every table occurrence (D-05 D2, the tenant guard).
//
// - The runs in scope are the runs created in the half-open range [from, to) (UTC).
// - A run's model is the model in its `model_selected` run event (QUESTIONS #434, option C). A run
//   without the event (older runs, or a name the event cannot hold) falls back to the model with
//   the most cost in its cost records; without cost records either, the model is `unknown`.
// - Intent measures (CI on the first try, merged, cost per merged intent, lead time) count under
//   the run that made the event (the first `ci_checked`, the last `pr_merged`; QUESTIONS #433).
// - V14 (ADR-M79 §2.6): the human-effort estimate (`intents.human_effort_hours`) is compared with
//   the lead time of the merged intents that have both.
// - Sums are made in SQL; money and token sums come back as strings (D-05 D6).
import type { RunStatus } from '@sdlc/contracts';
import { sql, type Kysely } from 'kysely';

import type { Database } from '../schema.js';
import { TenantRepository } from './base.js';

/** Which runs the metrics read. */
export interface AgentMetricsQuery {
  readonly from: Date;
  readonly to: Date;
  readonly projectId?: string;
  readonly agentKey?: string;
  readonly model?: string;
  /** Final run statuses whose cost is wasted (D-07 §5). */
  readonly wastedStatuses: readonly RunStatus[];
}

/** The model of a run without cost records. */
export const UNKNOWN_MODEL = 'unknown';

export interface AgentRowKey {
  readonly project: string;
  readonly agentKey: string;
  readonly agentVersion: string;
  readonly model: string;
}

export interface RunCountRow extends AgentRowKey {
  readonly status: RunStatus;
  readonly stopReason: string | null;
  readonly retry: boolean;
  readonly count: number;
}

export interface RunCostRow extends AgentRowKey {
  readonly inputTokens: string;
  readonly outputTokens: string;
  readonly cachedInputTokens: string;
  readonly costUsd: string;
  readonly wastedCostUsd: string;
}

export interface CiFirstTryRow extends AgentRowKey {
  readonly total: number;
  readonly passed: number;
}

export interface MergedRow extends AgentRowKey {
  readonly merged: number;
  readonly withoutChanges: number;
  /** The intents' whole cost, as a decimal string. */
  readonly costUsd: string;
  readonly leadTimeCount: number;
  readonly leadTimeSumSeconds: string;
  readonly leadTimeMaxSeconds: number | null;
  /** V14: merged intents with both a lead time and a human-effort estimate. */
  readonly estimatedCount: number;
  /** Their estimates' sum in hours, as a decimal string. */
  readonly estimatedHoursSum: string;
  /** Their lead times' sum in seconds, as a digit string. */
  readonly estimatedLeadSumSeconds: string;
}

export interface ScopeBreachRow extends AgentRowKey {
  readonly count: number;
}

type RunsDb = Database & { rr: RunScopeRow; rc: RunCostScopeRow };
interface RunScopeRow {
  run_id: string;
  intent_id: string;
  project: string;
  agent_key: string;
  agent_version: string;
  model: string;
  status: RunStatus;
  stop_reason: string | null;
  retry: boolean;
}
interface RunCostScopeRow {
  run_id: string;
  input_tokens: string;
  output_tokens: string;
  cached_tokens: string;
  cost: string;
}

export class AgentMetricsRepository extends TenantRepository {
  /** Runs per (row key, status, stop reason, retry). */
  async runCounts(query: AgentMetricsQuery): Promise<RunCountRow[]> {
    const rows = await this.run(
      this.scoped(query)
        .selectFrom('rr')
        .$if(query.model !== undefined, (qb) => qb.where('rr.model', '=', query.model!))
        .select((eb) => [
          'rr.project',
          'rr.agent_key',
          'rr.agent_version',
          'rr.model',
          'rr.status',
          'rr.stop_reason',
          'rr.retry',
          eb.fn.countAll<string>().as('count'),
        ])
        .groupBy(['rr.project', 'rr.agent_key', 'rr.agent_version', 'rr.model'])
        .groupBy(['rr.status', 'rr.stop_reason', 'rr.retry'])
        .execute(),
    );
    return rows.map((row) => ({
      ...this.key(row),
      status: row.status,
      stopReason: row.stop_reason,
      retry: row.retry,
      count: Number(row.count),
    }));
  }

  /** Tokens and cost of the runs per row key, and the cost of the wasted ones. */
  async runCosts(query: AgentMetricsQuery): Promise<RunCostRow[]> {
    const wasted = [...query.wastedStatuses];
    const rows = await this.run(
      this.scoped(query)
        .selectFrom('rr')
        .$if(query.model !== undefined, (qb) => qb.where('rr.model', '=', query.model!))
        .innerJoin('rc', 'rc.run_id', 'rr.run_id')
        .select([
          'rr.project',
          'rr.agent_key',
          'rr.agent_version',
          'rr.model',
          sql<string>`coalesce(sum(rc.input_tokens), 0)::text`.as('input_tokens'),
          sql<string>`coalesce(sum(rc.output_tokens), 0)::text`.as('output_tokens'),
          sql<string>`coalesce(sum(rc.cached_tokens), 0)::text`.as('cached_tokens'),
          sql<string>`coalesce(sum(rc.cost), 0)::text`.as('cost'),
          sql<string>`coalesce(sum(rc.cost) filter (where rr.status in (${sql.join(wasted)})), 0)::text`.as(
            'wasted_cost',
          ),
        ])
        .groupBy(['rr.project', 'rr.agent_key', 'rr.agent_version', 'rr.model'])
        .execute(),
    );
    return rows.map((row) => ({
      ...this.key(row),
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cachedInputTokens: row.cached_tokens,
      costUsd: row.cost,
      wastedCostUsd: row.wasted_cost,
    }));
  }

  /** The first `ci_checked` of each intent: how many, and how many passed (state `passed`). */
  async ciFirstTry(query: AgentMetricsQuery): Promise<CiFirstTryRow[]> {
    const tenantId = this.tenantId;
    const rows = await this.run(
      this.scoped(query)
        .with('ci', (qb) =>
          qb
            .selectFrom('run_events as e')
            .innerJoin('runs as r', (join) =>
              join.onRef('r.tenant_id', '=', 'e.tenant_id').onRef('r.id', '=', 'e.run_id'),
            )
            .where('e.tenant_id', '=', tenantId)
            .where('r.tenant_id', '=', tenantId)
            .where('e.event_type', '=', 'ci_checked')
            .distinctOn('r.intent_id')
            .orderBy('r.intent_id')
            .orderBy('e.id')
            .select(['e.run_id as run_id', sql<string>`e.payload->>'state'`.as('state')]),
        )
        .selectFrom('rr')
        .$if(query.model !== undefined, (qb) => qb.where('rr.model', '=', query.model!))
        .innerJoin('ci', 'ci.run_id', 'rr.run_id')
        .select((eb) => [
          'rr.project',
          'rr.agent_key',
          'rr.agent_version',
          'rr.model',
          eb.fn.countAll<string>().as('total'),
          sql<string>`count(*) filter (where ci.state = 'passed')`.as('passed'),
        ])
        .groupBy(['rr.project', 'rr.agent_key', 'rr.agent_version', 'rr.model'])
        .execute(),
    );
    return rows.map((row) => ({
      ...this.key(row),
      total: Number(row.total),
      passed: Number(row.passed),
    }));
  }

  /**
   * The intents merged (the last `pr_merged` of each intent) per row key of the merged run: how
   * many, how many without a G7 request for changes before the merge, their whole cost and lead
   * time (`intent.closed`).
   */
  async merged(query: AgentMetricsQuery): Promise<MergedRow[]> {
    const tenantId = this.tenantId;
    const rows = await this.run(
      this.scoped(query)
        .with('mg', (qb) =>
          qb
            .selectFrom('run_events as e')
            .innerJoin('runs as r', (join) =>
              join.onRef('r.tenant_id', '=', 'e.tenant_id').onRef('r.id', '=', 'e.run_id'),
            )
            .where('e.tenant_id', '=', tenantId)
            .where('r.tenant_id', '=', tenantId)
            .where('e.event_type', '=', 'pr_merged')
            .distinctOn('r.intent_id')
            .orderBy('r.intent_id')
            .orderBy('e.id', 'desc')
            .select((eb) => [
              'e.run_id as run_id',
              'r.intent_id as intent_id',
              eb
                .not(
                  eb.exists(
                    eb
                      .selectFrom('gate_decisions as d')
                      .select(sql.lit(1).as('one'))
                      .where('d.tenant_id', '=', tenantId)
                      .whereRef('d.intent_id', '=', 'r.intent_id')
                      .where('d.gate', '=', 'G7')
                      .where('d.decision', '=', 'request_changes')
                      .whereRef('d.created_at', '<', 'e.created_at'),
                  ),
                )
                .as('clean'),
              eb
                .selectFrom('cost_records as c')
                .select(sql<string>`coalesce(sum(c.cost_usd), 0)`.as('cost'))
                .where('c.tenant_id', '=', tenantId)
                .whereRef('c.intent_id', '=', 'r.intent_id')
                .as('cost'),
              eb
                .selectFrom('audit_log as a')
                .select(sql<number>`max((a.payload->>'lead_time_seconds')::bigint)`.as('lead'))
                .where('a.tenant_id', '=', tenantId)
                .where('a.action', '=', 'intent.closed')
                .whereRef('a.entity_id', '=', 'r.intent_id')
                .as('lead'),
              eb
                .selectFrom('intents as i')
                .select('i.human_effort_hours')
                .where('i.tenant_id', '=', tenantId)
                .whereRef('i.id', '=', 'r.intent_id')
                .as('estimate'),
            ]),
        )
        .selectFrom('rr')
        .$if(query.model !== undefined, (qb) => qb.where('rr.model', '=', query.model!))
        .innerJoin('mg', 'mg.run_id', 'rr.run_id')
        .select((eb) => [
          'rr.project',
          'rr.agent_key',
          'rr.agent_version',
          'rr.model',
          eb.fn.countAll<string>().as('merged'),
          sql<string>`count(*) filter (where mg.clean)`.as('clean'),
          sql<string>`coalesce(sum(mg.cost), 0)::text`.as('cost'),
          sql<string>`count(mg.lead)`.as('lead_count'),
          sql<string>`coalesce(sum(mg.lead), 0)::text`.as('lead_sum'),
          sql<string | null>`max(mg.lead)::text`.as('lead_max'),
          sql<string>`count(*) filter (where mg.estimate is not null and mg.lead is not null)`.as(
            'est_count',
          ),
          sql<string>`coalesce(sum(mg.estimate) filter (where mg.lead is not null), 0)::text`.as(
            'est_hours',
          ),
          sql<string>`coalesce(sum(mg.lead) filter (where mg.estimate is not null), 0)::text`.as(
            'est_lead',
          ),
        ])
        .groupBy(['rr.project', 'rr.agent_key', 'rr.agent_version', 'rr.model'])
        .execute(),
    );
    return rows.map((row) => ({
      ...this.key(row),
      merged: Number(row.merged),
      withoutChanges: Number(row.clean),
      costUsd: row.cost,
      leadTimeCount: Number(row.lead_count),
      leadTimeSumSeconds: row.lead_sum,
      leadTimeMaxSeconds: row.lead_max === null ? null : Number(row.lead_max),
      estimatedCount: Number(row.est_count),
      estimatedHoursSum: row.est_hours,
      estimatedLeadSumSeconds: row.est_lead,
    }));
  }

  /** G5 `out_of_scope` failures, counted under the intent's latest run before the decision. */
  async scopeBreaches(query: AgentMetricsQuery): Promise<ScopeBreachRow[]> {
    const tenantId = this.tenantId;
    const rows = await this.run(
      this.scoped(query)
        .with('g5', (qb) =>
          qb
            .selectFrom('gate_decisions as d')
            .where('d.tenant_id', '=', tenantId)
            .where('d.gate', '=', 'G5')
            .where('d.decision', '=', 'fail')
            .where('d.reason_code', '=', 'out_of_scope')
            .select((eb) => [
              eb
                .selectFrom('runs as r')
                .select('r.id')
                .where('r.tenant_id', '=', tenantId)
                .whereRef('r.intent_id', '=', 'd.intent_id')
                .whereRef('r.created_at', '<=', 'd.created_at')
                .orderBy('r.created_at', 'desc')
                .limit(1)
                .as('run_id'),
            ]),
        )
        .selectFrom('rr')
        .$if(query.model !== undefined, (qb) => qb.where('rr.model', '=', query.model!))
        .innerJoin('g5', 'g5.run_id', 'rr.run_id')
        .select((eb) => [
          'rr.project',
          'rr.agent_key',
          'rr.agent_version',
          'rr.model',
          eb.fn.countAll<string>().as('count'),
        ])
        .groupBy(['rr.project', 'rr.agent_key', 'rr.agent_version', 'rr.model'])
        .execute(),
    );
    return rows.map((row) => ({ ...this.key(row), count: Number(row.count) }));
  }

  /** Cost records of the range that belong to no run (counted apart, never in a row). */
  async unattributedCost(query: Pick<AgentMetricsQuery, 'from' | 'to' | 'projectId'>) {
    const tenantId = this.tenantId;
    const row = await this.run(
      this.db
        .selectFrom('cost_records as c')
        .where('c.tenant_id', '=', tenantId)
        .where('c.run_id', 'is', null)
        .where('c.occurred_at', '>=', query.from)
        .where('c.occurred_at', '<', query.to)
        .$if(query.projectId !== undefined, (qb) =>
          qb.where('c.project_id', '=', query.projectId ?? ''),
        )
        .select(sql<string>`coalesce(sum(c.cost_usd), 0)::text`.as('cost'))
        .executeTakeFirst(),
    );
    return row?.cost ?? '0';
  }

  private key(row: {
    project: string;
    agent_key: string;
    agent_version: string;
    model: string;
  }): AgentRowKey {
    return {
      project: row.project,
      agentKey: row.agent_key,
      agentVersion: row.agent_version,
      model: row.model,
    };
  }

  /**
   * The db with the two shared CTEs: `rr`, the runs created in the range with their project, agent
   * and model, and `rc`, the tokens and cost per run.
   */
  private scoped(query: AgentMetricsQuery) {
    const tenantId = this.tenantId;
    return this.db
      .with('rc', (qb) =>
        qb
          .selectFrom('cost_records as c')
          .where('c.tenant_id', '=', tenantId)
          .where('c.run_id', 'is not', null)
          .select([
            'c.run_id as run_id',
            sql<string>`sum(c.input_tokens)`.as('input_tokens'),
            sql<string>`sum(c.output_tokens)`.as('output_tokens'),
            sql<string>`sum(c.cached_input_tokens)`.as('cached_tokens'),
            sql<string>`sum(c.cost_usd)`.as('cost'),
          ])
          .groupBy('c.run_id'),
      )
      .with('rr', (qb) =>
        qb
          .selectFrom('runs as r')
          .innerJoin('intents as i', (join) =>
            join.onRef('i.tenant_id', '=', 'r.tenant_id').onRef('i.id', '=', 'r.intent_id'),
          )
          .innerJoin('projects as p', (join) =>
            join.onRef('p.tenant_id', '=', 'i.tenant_id').onRef('p.id', '=', 'i.project_id'),
          )
          .innerJoin('agents as a', (join) =>
            join.onRef('a.tenant_id', '=', 'r.tenant_id').onRef('a.id', '=', 'r.agent_id'),
          )
          .where('r.tenant_id', '=', tenantId)
          .where('i.tenant_id', '=', tenantId)
          .where('p.tenant_id', '=', tenantId)
          .where('a.tenant_id', '=', tenantId)
          .where('r.created_at', '>=', query.from)
          .where('r.created_at', '<', query.to)
          .$if(query.projectId !== undefined, (b) =>
            b.where('i.project_id', '=', query.projectId ?? ''),
          )
          .$if(query.agentKey !== undefined, (b) => b.where('a.agent_key', '=', query.agentKey!))
          .select((eb) => [
            'r.id as run_id',
            'r.intent_id as intent_id',
            'p.slug as project',
            'a.agent_key as agent_key',
            'r.agent_version as agent_version',
            eb.fn
              .coalesce(
                eb
                  .selectFrom('run_events as me')
                  .select(sql<string>`me.payload->>'model'`.as('model'))
                  .where('me.tenant_id', '=', tenantId)
                  .whereRef('me.run_id', '=', 'r.id')
                  .where('me.event_type', '=', 'model_selected')
                  .orderBy('me.id')
                  .limit(1),
                eb
                  .selectFrom('cost_records as m')
                  .select('m.model')
                  .where('m.tenant_id', '=', tenantId)
                  .whereRef('m.run_id', '=', 'r.id')
                  .groupBy('m.model')
                  .orderBy(sql`sum(m.cost_usd)`, 'desc')
                  .orderBy('m.model')
                  .limit(1),
                sql.lit(UNKNOWN_MODEL),
              )
              .as('model'),
            'r.status as status',
            'r.stop_reason as stop_reason',
            sql<boolean>`r.attempt > 1`.as('retry'),
          ]),
      ) as unknown as ModelFiltered;
  }
}

// The CTE columns are known to the builder only inside `with`; this alias keeps the chained
// `selectFrom('rr')` calls typed.
type ModelFiltered = Kysely<RunsDb>;
