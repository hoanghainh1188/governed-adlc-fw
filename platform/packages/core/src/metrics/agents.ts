// Agent efficiency report (task V13, D-02 FR-12, FR-53, D-07 §5, D-08 V13, design/ADR-M79). For one
// tenant: the whole tenant or one project, one row per (project, agent key and version, model).
//
// - Built from data the platform already records (runs, run events, gate decisions,
//   `intent.closed`, cost records); read only, no new table.
// - Who (QUESTIONS #430): a tenant admin, or for one project a role in BOTH `access.cost_read_roles`
//   and `access.metrics_read_roles` (never `viewer`, rules M28, M29). The whole tenant: tenant
//   admins only. No role on the project: the project is not found (ADR-M26 §2.5).
// - Counts, seconds and amounts only; never a person or a text. Money is a decimal string with 6
//   decimals and token sums are digit strings (D-05 D6).
// - A measure without data is null, never 0. Runs still in progress are counted apart.
// - V14 (ADR-M79 §2.6): the merged intents' lead time compared with a person's estimate of the
//   human effort, when the intents have one.
import type { RunStatus } from '@sdlc/contracts';

import { isTenantAdmin } from '../admin/actor.js';
import { CommandError } from '../commands/errors.js';
import { fromMicros, toMicros } from '../cost/money.js';
import {
  IN_PROGRESS_RUN_STATUSES,
  WASTED_RUN_STATUSES,
  formatUsd6,
  type CostReportRangeIssue,
} from '../cost/report.js';
import type { AgentRowKey, MergedRow } from '../db/repositories/agent-metrics.js';
import type { TenantScope } from '../db/tenant-scope.js';
import { loadEffectiveConfig } from '../registry/effective-config.js';
import { checkGateMetricsRange, resolveGateMetricsRange, type GateMetricsRange } from './gates.js';

/** Default range: the last 30 days. */
export const AGENT_METRICS_DEFAULT_DAYS = 30;
/** Most rows one report shows; more → `truncated`. */
export const AGENT_METRICS_MAX_ROWS = 500;

export type AgentMetricsRange = GateMetricsRange;

/** Same defaults and limits as the gate metrics (ADR-M47 §2.4). */
export const resolveAgentMetricsRange = resolveGateMetricsRange;
export const checkAgentMetricsRange = (
  range: AgentMetricsRange,
): CostReportRangeIssue | undefined => checkGateMetricsRange(range);

export interface AgentMetricsInput {
  readonly projectSlug?: string;
  readonly agentKey?: string;
  readonly model?: string;
  readonly from?: Date;
  readonly to?: Date;
}

export interface AgentMetricsRow {
  readonly project: string;
  readonly agent: string;
  readonly agentVersion: string;
  readonly model: string;
  readonly runs: {
    readonly total: number;
    /** Runs still in progress: left out of every rate. */
    readonly inProgress: number;
    readonly byStatus: Readonly<Record<string, number>>;
    readonly byStopReason: Readonly<Record<string, number>>;
    /** Runs that were another attempt (attempt above 1). */
    readonly retries: number;
  };
  readonly ci: { readonly firstTryTotal: number; readonly firstTryPassed: number };
  readonly merged: {
    readonly intents: number;
    readonly withoutChangesRequested: number;
    readonly leadTime: {
      readonly count: number;
      readonly avgSeconds: number | null;
      readonly maxSeconds: number | null;
    };
    /**
     * V14 (ADR-M79 §2.6, QUESTIONS #691): the merged intents with a lead time and a person's
     * estimate of the human effort; their sums, and the lead time as a percentage of the estimate
     * (one decimal). Null sums and percentage without such an intent.
     */
    readonly humanEffort: {
      readonly count: number;
      readonly estimateHoursSum: string | null;
      readonly leadTimeSecondsSum: number | null;
      readonly leadToEstimatePercent: number | null;
    };
  };
  readonly scopeBreaches: number;
  readonly tokens: {
    readonly input: string;
    readonly output: string;
    readonly cachedInput: string;
    /** Cached share of the input tokens, in percent with one decimal; null without input. */
    readonly cacheSharePercent: number | null;
  };
  readonly cost: {
    readonly totalUsd: string;
    readonly wastedUsd: string;
    readonly perRunUsd: string | null;
    readonly perMergedIntentUsd: string | null;
  };
}

export type AgentMetricsScope =
  { readonly kind: 'tenant' } | { readonly kind: 'project'; readonly project: string };

export interface AgentMetrics {
  readonly scope: AgentMetricsScope;
  readonly from: Date;
  readonly to: Date;
  readonly filters: { readonly agent: string | null; readonly model: string | null };
  readonly rows: readonly AgentMetricsRow[];
  /** Cost records of the range that belong to no run (never in a row). */
  readonly unattributedCostUsd: string;
  readonly truncated: boolean;
}

const rowKey = (k: AgentRowKey) => [k.project, k.agentKey, k.agentVersion, k.model].join('\u0000');

const div = (micros: bigint, by: bigint): string => fromMicros(micros / by);

/** Cached share of the input tokens in percent with one decimal (exported for tests). */
export function cacheShare(cached: string, input: string): number | null {
  const base = BigInt(input);
  if (base === 0n) return null;
  // Rounded half up to one decimal.
  return Number((BigInt(cached) * 2000n + base) / (2n * base)) / 10;
}

/**
 * The lead time as a percentage of the estimated hours, one decimal, rounded half up (exported
 * for tests). Null when the estimate is 0 hours.
 */
export function leadToEstimatePercent(leadSeconds: string, estimateHours: string): number | null {
  // Hours in micro-hours; seconds per micro-hour = 3600 / 1e6.
  const microHours = toMicros(estimateHours);
  if (microHours <= 0n) return null;
  // percent × 10 = lead × 1000 / (hours × 3600) = lead × 1e6 × 1000 / (microHours × 3600)
  const numerator = BigInt(leadSeconds) * 1_000_000_000n;
  const denominator = microHours * 3600n;
  return Number((numerator * 2n + denominator) / (2n * denominator)) / 10;
}

function humanEffort(merged: MergedRow | undefined): AgentMetricsRow['merged']['humanEffort'] {
  if (!merged || merged.estimatedCount === 0) {
    return {
      count: 0,
      estimateHoursSum: null,
      leadTimeSecondsSum: null,
      leadToEstimatePercent: null,
    };
  }
  return {
    count: merged.estimatedCount,
    estimateHoursSum: fromMicros(toMicros(merged.estimatedHoursSum)),
    leadTimeSecondsSum: Number(merged.estimatedLeadSumSeconds),
    leadToEstimatePercent: leadToEstimatePercent(
      merged.estimatedLeadSumSeconds,
      merged.estimatedHoursSum,
    ),
  };
}

/** Merges the groupings into one row per key, sorted by project, agent, version and model. */
export function mergeAgentMetrics(parts: {
  readonly counts: Awaited<ReturnType<TenantScope['agentMetrics']['runCounts']>>;
  readonly costs: Awaited<ReturnType<TenantScope['agentMetrics']['runCosts']>>;
  readonly ci: Awaited<ReturnType<TenantScope['agentMetrics']['ciFirstTry']>>;
  readonly merged: Awaited<ReturnType<TenantScope['agentMetrics']['merged']>>;
  readonly breaches: Awaited<ReturnType<TenantScope['agentMetrics']['scopeBreaches']>>;
}): AgentMetricsRow[] {
  const keys = new Map<string, AgentRowKey>();
  // Every row has runs: the other groupings are joined to the runs in the range.
  for (const row of parts.counts) keys.set(rowKey(row), row);
  const inProgress = new Set<RunStatus>(IN_PROGRESS_RUN_STATUSES);
  const rows = [...keys.values()].map((key): AgentMetricsRow => {
    const k = rowKey(key);
    const counts = parts.counts.filter((c) => rowKey(c) === k);
    const cost = parts.costs.find((c) => rowKey(c) === k);
    const ci = parts.ci.find((c) => rowKey(c) === k);
    const merged = parts.merged.find((c) => rowKey(c) === k);
    const byStatus: Record<string, number> = {};
    const byStopReason: Record<string, number> = {};
    let total = 0;
    let running = 0;
    let retries = 0;
    for (const c of counts) {
      total += c.count;
      byStatus[c.status] = (byStatus[c.status] ?? 0) + c.count;
      if (c.stopReason !== null)
        byStopReason[c.stopReason] = (byStopReason[c.stopReason] ?? 0) + c.count;
      if (inProgress.has(c.status)) running += c.count;
      if (c.retry) retries += c.count;
    }
    const totalMicros = toMicros(cost?.costUsd ?? '0');
    const mergedCount = merged?.merged ?? 0;
    return {
      project: key.project,
      agent: key.agentKey,
      agentVersion: key.agentVersion,
      model: key.model,
      runs: { total, inProgress: running, byStatus, byStopReason, retries },
      ci: { firstTryTotal: ci?.total ?? 0, firstTryPassed: ci?.passed ?? 0 },
      merged: {
        intents: mergedCount,
        withoutChangesRequested: merged?.withoutChanges ?? 0,
        leadTime: {
          count: merged?.leadTimeCount ?? 0,
          avgSeconds:
            merged && merged.leadTimeCount > 0
              ? Number(BigInt(merged.leadTimeSumSeconds) / BigInt(merged.leadTimeCount))
              : null,
          maxSeconds: merged?.leadTimeMaxSeconds ?? null,
        },
        humanEffort: humanEffort(merged),
      },
      scopeBreaches: parts.breaches.find((b) => rowKey(b) === k)?.count ?? 0,
      tokens: {
        input: cost?.inputTokens ?? '0',
        output: cost?.outputTokens ?? '0',
        cachedInput: cost?.cachedInputTokens ?? '0',
        cacheSharePercent: cacheShare(cost?.cachedInputTokens ?? '0', cost?.inputTokens ?? '0'),
      },
      cost: {
        totalUsd: formatUsd6(cost?.costUsd ?? '0'),
        wastedUsd: formatUsd6(cost?.wastedCostUsd ?? '0'),
        perRunUsd: total > 0 ? formatUsd6(div(totalMicros, BigInt(total))) : null,
        perMergedIntentUsd:
          merged && mergedCount > 0
            ? formatUsd6(div(toMicros(merged.costUsd), BigInt(mergedCount)))
            : null,
      },
    };
  });
  return rows.sort(
    (a, b) =>
      a.project.localeCompare(b.project) ||
      a.agent.localeCompare(b.agent) ||
      a.agentVersion.localeCompare(b.agentVersion, undefined, { numeric: true }) ||
      a.model.localeCompare(b.model),
  );
}

/** Finds the scope and checks that the person may read it (QUESTIONS #430). */
async function resolveScope(
  scope: TenantScope,
  userId: string,
  projectSlug: string | undefined,
): Promise<{ scope: AgentMetricsScope; projectId?: string }> {
  const admin = await isTenantAdmin(scope, userId);
  if (projectSlug === undefined) {
    if (!admin) throw new CommandError('forbidden', 'the whole tenant needs a tenant admin');
    return { scope: { kind: 'tenant' } };
  }
  const project = await scope.projects.getBySlug(projectSlug);
  if (!project) throw new CommandError('project_not_found', `project ${projectSlug} not found`);
  if (!admin) {
    const roles = (await scope.roleBindings.listForUser(userId))
      .filter((binding) => binding.project_id === project.id)
      .map((binding) => binding.role);
    if (roles.length === 0) {
      throw new CommandError('project_not_found', 'project_not_found: no role on the project');
    }
    const { config } = await loadEffectiveConfig(scope.projectConfigs, project.id);
    const both = roles.some(
      (role) =>
        config.access.cost_read_roles.includes(role) &&
        config.access.metrics_read_roles.includes(role),
    );
    if (!both) {
      throw new CommandError(
        'forbidden',
        'a role in both access.cost_read_roles and access.metrics_read_roles is needed',
      );
    }
  }
  return { scope: { kind: 'project', project: project.slug }, projectId: project.id };
}

/**
 * Builds the agent efficiency report (D-08 V13). The caller checks the range first
 * (`checkAgentMetricsRange`); a refused range here is a programming error.
 */
export async function buildAgentMetrics(
  scope: TenantScope,
  actor: { readonly userId: string },
  input: AgentMetricsInput,
  now: Date,
): Promise<AgentMetrics> {
  const range = resolveAgentMetricsRange(input, now);
  if (checkAgentMetricsRange(range) !== undefined) throw new RangeError('agent metrics: bad range');
  const resolved = await resolveScope(scope, actor.userId, input.projectSlug);
  const query = {
    from: range.from,
    to: range.to,
    wastedStatuses: WASTED_RUN_STATUSES,
    ...(resolved.projectId === undefined ? {} : { projectId: resolved.projectId }),
    ...(input.agentKey === undefined ? {} : { agentKey: input.agentKey }),
    ...(input.model === undefined ? {} : { model: input.model }),
  };
  const repo = scope.agentMetrics;
  const [counts, costs, ci, merged, breaches, unattributed] = await Promise.all([
    repo.runCounts(query),
    repo.runCosts(query),
    repo.ciFirstTry(query),
    repo.merged(query),
    repo.scopeBreaches(query),
    repo.unattributedCost(query),
  ]);
  const rows = mergeAgentMetrics({ counts, costs, ci, merged, breaches });
  return {
    scope: resolved.scope,
    from: range.from,
    to: range.to,
    filters: { agent: input.agentKey ?? null, model: input.model ?? null },
    rows: rows.slice(0, AGENT_METRICS_MAX_ROWS),
    unattributedCostUsd: formatUsd6(unattributed),
    truncated: rows.length > AGENT_METRICS_MAX_ROWS,
  };
}
