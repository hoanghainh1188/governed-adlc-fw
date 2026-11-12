// JSON of the gate waiting-time metrics (task E06, ADR-M47). Codes, times and whole seconds only;
// never a person. The two groups of finished waits stay apart (QUESTIONS #205).
import type { AgentMetrics, GateMetrics, WaitStats } from '@sdlc/core';

function waits(s: WaitStats): Record<string, unknown> {
  return {
    count: s.count,
    avg_seconds: s.avgSeconds,
    max_seconds: s.maxSeconds,
    p50_seconds: s.p50Seconds,
    p90_seconds: s.p90Seconds,
  };
}

export function presentGateMetrics(m: GateMetrics): Record<string, unknown> {
  return {
    metrics: {
      scope: m.scope,
      from: m.from.toISOString(),
      to: m.to.toISOString(),
      as_of: m.asOf.toISOString(),
      clock: 'wall_clock',
      filters: { gate: m.filters.gate, mode: m.filters.mode, risk: m.filters.riskTier },
      rows: m.rows.map((row) => ({
        project: row.project,
        gate: row.gate,
        first_round: waits(row.firstRound),
        after_changes: waits(row.afterChanges),
        auto_passed: row.autoPassed,
        open: { count: row.open.count, oldest_seconds: row.open.oldestSeconds },
      })),
      truncated: m.truncated,
    },
  };
}

/** JSON of the agent efficiency report (task V13, ADR-M79). Codes, counts and amounts only. */
export function presentAgentMetrics(m: AgentMetrics): Record<string, unknown> {
  return {
    metrics: {
      scope: m.scope,
      from: m.from.toISOString(),
      to: m.to.toISOString(),
      filters: m.filters,
      rows: m.rows.map((row) => ({
        project: row.project,
        agent: row.agent,
        agent_version: row.agentVersion,
        model: row.model,
        runs: {
          total: row.runs.total,
          in_progress: row.runs.inProgress,
          by_status: row.runs.byStatus,
          by_stop_reason: row.runs.byStopReason,
          retries: row.runs.retries,
        },
        ci: { first_try_total: row.ci.firstTryTotal, first_try_passed: row.ci.firstTryPassed },
        merged: {
          intents: row.merged.intents,
          without_changes_requested: row.merged.withoutChangesRequested,
          lead_time: {
            count: row.merged.leadTime.count,
            avg_seconds: row.merged.leadTime.avgSeconds,
            max_seconds: row.merged.leadTime.maxSeconds,
          },
          human_effort: {
            count: row.merged.humanEffort.count,
            estimate_hours_sum: row.merged.humanEffort.estimateHoursSum,
            lead_time_seconds_sum: row.merged.humanEffort.leadTimeSecondsSum,
            lead_to_estimate_percent: row.merged.humanEffort.leadToEstimatePercent,
          },
        },
        scope_breaches: row.scopeBreaches,
        tokens: {
          input: row.tokens.input,
          output: row.tokens.output,
          cached_input: row.tokens.cachedInput,
          cache_share_percent: row.tokens.cacheSharePercent,
        },
        cost: {
          total_usd: row.cost.totalUsd,
          wasted_usd: row.cost.wastedUsd,
          per_run_usd: row.cost.perRunUsd,
          per_merged_intent_usd: row.cost.perMergedIntentUsd,
        },
      })),
      unattributed_cost_usd: m.unattributedCostUsd,
      truncated: m.truncated,
    },
  };
}
