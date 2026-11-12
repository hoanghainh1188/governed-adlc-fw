// `adlc metrics agents` (task V13, ADR-M79) is further down. `adlc metrics gates` over the API (task E06, D-08 E06 AC1, D-02 FR-12, ADR-M47, handbook Ch.19
// §19.8c). Per project and gate: the waits that people ended (first round, and after a request for
// changes), the platform's HOTL and AUDIT passes, and the intents at the gate now. Wall-clock time
// from the gate's entry, never working hours, never per person. The whole tenant needs a tenant
// admin; `--project` needs a role in project config `access.metrics_read_roles` (never `viewer`).
import { t, type MessageKey } from '@sdlc/messages';

import {
  agentMetricsSchema,
  gateMetricsSchema,
  type AgentMetricsView,
  type GateMetricsView,
  type WaitStatsView,
} from '../api/schemas.js';
import { parseCommand, withApi } from '../api/session.js';
import { EXIT, type CliContext } from '../context.js';
import { clean, say, show, toJson } from '../output.js';

const GATES = new Set(['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8']);
const MODES = new Set(['HITL', 'HOTL', 'AUDIT', 'POLICY']);
const RISKS = new Set(['low', 'medium', 'high', 'critical']);

export async function runMetrics(args: readonly string[], ctx: CliContext): Promise<number> {
  const [command, ...rest] = args;
  if (command === 'gates') return gates(rest, ctx);
  if (command === 'agents') return agents(rest, ctx);
  return usage(ctx);
}

async function gates(args: readonly string[], ctx: CliContext): Promise<number> {
  const parsed = parseCommand(args, {
    project: { type: 'string' },
    gate: { type: 'string' },
    mode: { type: 'string' },
    risk: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
  });
  if (!parsed) return usage(ctx);
  const { project, gate, mode, risk, from, to } = parsed.values as Record<
    string,
    string | undefined
  >;
  if (gate !== undefined && !GATES.has(gate)) return usage(ctx);
  if (mode !== undefined && !MODES.has(mode)) return usage(ctx);
  if (risk !== undefined && !RISKS.has(risk)) return usage(ctx);
  const json = parsed.values.json === true;
  return withApi(ctx, json, async (client) => {
    const body = await client.get('/v1/metrics/gates', gateMetricsSchema, {
      project,
      gate,
      mode,
      risk,
      from,
      to,
    });
    if (json) ctx.stdout(toJson(body));
    else printMetrics(ctx, body.metrics);
    return EXIT.ok;
  });
}

async function agents(args: readonly string[], ctx: CliContext): Promise<number> {
  const parsed = parseCommand(args, {
    project: { type: 'string' },
    agent: { type: 'string' },
    model: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
  });
  if (!parsed) return usage(ctx);
  const { project, agent, model, from, to } = parsed.values as Record<string, string | undefined>;
  const json = parsed.values.json === true;
  return withApi(ctx, json, async (client) => {
    const body = await client.get('/v1/metrics/agents', agentMetricsSchema, {
      project,
      agent,
      model,
      from,
      to,
    });
    if (json) ctx.stdout(toJson(body));
    else printAgentMetrics(ctx, body.metrics);
    return EXIT.ok;
  });
}

/** `3` of `4` → `75%`; `-` without a base (exported for tests). */
export function formatShare(part: number, whole: number): string {
  return whole === 0 ? '-' : `${String(Math.round((part * 100) / whole))}%`;
}

const OK_STATUSES = ['succeeded', 'succeeded_proposal_only'];

/**
 * V14 (ADR-M79 §2.6): the merged intents' lead time as a percentage of the human-effort estimate,
 * with how many intents had one (`-` without an estimate or from an older server).
 */
export function formatEstimate(
  effort: AgentMetricsView['rows'][number]['merged']['human_effort'],
): string {
  if (!effort || effort.count === 0 || effort.lead_to_estimate_percent === null) return '-';
  return `${effort.lead_to_estimate_percent.toFixed(1)}% (${effort.count})`;
}

/** One line per (project, agent version, model): the run measures (exported for tests). */
export function agentRunTable(metrics: AgentMetricsView): string[] {
  const body = metrics.rows.map((row) => {
    const ended = row.runs.total - row.runs.in_progress;
    const ok = OK_STATUSES.reduce((sum, status) => sum + (row.runs.by_status[status] ?? 0), 0);
    return [
      clean(row.project),
      clean(`${row.agent} ${row.agent_version}`),
      clean(row.model),
      String(row.runs.total),
      formatShare(ok, ended),
      String(row.runs.retries),
      formatShare(row.ci.first_try_passed, row.ci.first_try_total),
      String(row.merged.intents),
      formatShare(row.merged.without_changes_requested, row.merged.intents),
      String(row.scope_breaches),
      formatDuration(row.merged.lead_time.avg_seconds),
      formatEstimate(row.merged.human_effort),
    ];
  });
  if (body.length === 0) return [];
  const header = [
    'cli.metrics.column.project',
    'cli.metrics.column.agent',
    'cli.metrics.column.model',
    'cli.metrics.column.runs',
    'cli.metrics.column.run_ok',
    'cli.metrics.column.retries',
    'cli.metrics.column.ci_first',
    'cli.metrics.column.merged',
    'cli.metrics.column.merged_clean',
    'cli.metrics.column.breaches',
    'cli.metrics.column.lead_avg',
    'cli.metrics.column.lead_estimate',
  ] as const satisfies readonly MessageKey[];
  return table(
    header.map((key) => t(key)),
    body,
    3,
  );
}

/** One line per (project, agent version, model): tokens and cost (exported for tests). */
export function agentCostTable(metrics: AgentMetricsView): string[] {
  const body = metrics.rows.map((row) => [
    clean(row.project),
    clean(`${row.agent} ${row.agent_version}`),
    clean(row.model),
    row.tokens.input,
    row.tokens.output,
    row.tokens.cache_share_percent === null ? '-' : `${String(row.tokens.cache_share_percent)}%`,
    row.cost.total_usd,
    row.cost.wasted_usd,
    row.cost.per_run_usd ?? '-',
    row.cost.per_merged_intent_usd ?? '-',
  ]);
  if (body.length === 0) return [];
  const header = [
    'cli.metrics.column.project',
    'cli.metrics.column.agent',
    'cli.metrics.column.model',
    'cli.metrics.column.input',
    'cli.metrics.column.output',
    'cli.metrics.column.cache',
    'cli.metrics.column.cost',
    'cli.metrics.column.wasted',
    'cli.metrics.column.cost_run',
    'cli.metrics.column.cost_merged',
  ] as const satisfies readonly MessageKey[];
  return table(
    header.map((key) => t(key)),
    body,
    3,
  );
}

function printAgentMetrics(ctx: CliContext, metrics: AgentMetricsView): void {
  const scope =
    metrics.scope.kind === 'tenant'
      ? t('cli.metrics.scope.tenant')
      : t('cli.metrics.scope.project', { project: clean(show(metrics.scope.project)) });
  say(ctx, 'cli.metrics.agents_header', { scope, from: metrics.from, to: metrics.to });
  const filters = [
    metrics.filters.agent === null ? null : `agent ${metrics.filters.agent}`,
    metrics.filters.model === null ? null : `model ${metrics.filters.model}`,
  ].filter((value): value is string => value !== null);
  if (filters.length > 0) say(ctx, 'cli.metrics.filters', { filters: clean(filters.join(', ')) });
  const runs = agentRunTable(metrics);
  if (runs.length === 0) {
    say(ctx, 'cli.metrics.no_runs');
  } else {
    for (const line of runs) ctx.stdout(line);
    ctx.stdout('');
    for (const line of agentCostTable(metrics)) ctx.stdout(line);
  }
  say(ctx, 'cli.metrics.unattributed', { cost: metrics.unattributed_cost_usd });
  if (metrics.truncated) say(ctx, 'cli.metrics.truncated', { max: metrics.rows.length });
  say(ctx, 'cli.metrics.agents_note');
}

const UNITS = [
  ['d', 86_400],
  ['h', 3_600],
  ['m', 60],
  ['s', 1],
] as const;

/** `93784` → `1d 2h`: the two largest units, rounded down; `-` for no value (exported for tests). */
export function formatDuration(seconds: number | null): string {
  if (seconds === null) return '-';
  const first = UNITS.findIndex(([, size]) => seconds >= size);
  if (first === -1) return '0s';
  const [unit, size] = UNITS[first]!;
  const amount = Math.floor(seconds / size);
  const next = UNITS[first + 1];
  const rest = next ? Math.floor((seconds - amount * size) / next[1]) : 0;
  return next && rest > 0
    ? `${String(amount)}${unit} ${String(rest)}${next[0]}`
    : `${String(amount)}${unit}`;
}

const WAIT_COLUMNS = [
  ['cli.metrics.column.count', (s) => String(s.count)],
  ['cli.metrics.column.avg', (s) => formatDuration(s.avg_seconds)],
  ['cli.metrics.column.p50', (s) => formatDuration(s.p50_seconds)],
  ['cli.metrics.column.p90', (s) => formatDuration(s.p90_seconds)],
  ['cli.metrics.column.max', (s) => formatDuration(s.max_seconds)],
] as const satisfies readonly (readonly [MessageKey, (s: WaitStatsView) => string])[];

/** Aligns a table: the first columns on the left, numbers on the right. */
function table(header: readonly string[], body: readonly string[][], left: number): string[] {
  const lines = [header, ...body];
  const widths = header.map((_, i) => Math.max(...lines.map((line) => (line[i] ?? '').length)));
  const render = (line: readonly string[]) =>
    line
      .map((cell, i) => (i < left ? cell.padEnd(widths[i] ?? 0) : cell.padStart(widths[i] ?? 0)))
      .join('  ')
      .trimEnd();
  return [render(header), widths.map((w) => '-'.repeat(w)).join('  '), ...body.map(render)];
}

/** Finished waits: one line per (project, gate, round) with at least one decision (exported for tests). */
export function waitTable(metrics: GateMetricsView): string[] {
  const body: string[][] = [];
  for (const row of metrics.rows) {
    const rounds = [
      ['cli.metrics.round.first', row.first_round],
      ['cli.metrics.round.after_changes', row.after_changes],
    ] as const;
    for (const [label, stats] of rounds) {
      if (stats.count === 0) continue;
      body.push([
        clean(row.project),
        row.gate,
        t(label),
        ...WAIT_COLUMNS.map(([, value]) => value(stats)),
      ]);
    }
  }
  if (body.length === 0) return [];
  const header = [
    t('cli.metrics.column.project'),
    t('cli.metrics.column.gate'),
    t('cli.metrics.column.round'),
    ...WAIT_COLUMNS.map(([k]) => t(k)),
  ];
  return table(header, body, 3);
}

/** Auto passes and the intents at the gate now: one line per (project, gate) with either (exported for tests). */
export function nowTable(metrics: GateMetricsView): string[] {
  const body = metrics.rows
    .filter((row) => row.auto_passed > 0 || row.open.count > 0)
    .map((row) => [
      clean(row.project),
      row.gate,
      String(row.auto_passed),
      String(row.open.count),
      formatDuration(row.open.oldest_seconds),
    ]);
  if (body.length === 0) return [];
  const header = [
    t('cli.metrics.column.project'),
    t('cli.metrics.column.gate'),
    t('cli.metrics.column.auto_passed'),
    t('cli.metrics.column.at_gate'),
    t('cli.metrics.column.oldest'),
  ];
  return table(header, body, 2);
}

function printMetrics(ctx: CliContext, metrics: GateMetricsView): void {
  const scope =
    metrics.scope.kind === 'tenant'
      ? t('cli.metrics.scope.tenant')
      : t('cli.metrics.scope.project', { project: clean(show(metrics.scope.project)) });
  say(ctx, 'cli.metrics.header', { scope, from: metrics.from, to: metrics.to });
  const filters = [
    metrics.filters.gate,
    metrics.filters.mode,
    metrics.filters.risk === null ? null : `risk ${metrics.filters.risk}`,
  ].filter((value): value is string => value !== null);
  if (filters.length > 0) say(ctx, 'cli.metrics.filters', { filters: clean(filters.join(', ')) });
  const waits = waitTable(metrics);
  if (waits.length === 0) say(ctx, 'cli.metrics.no_decisions');
  else for (const line of waits) ctx.stdout(line);
  const now = nowTable(metrics);
  if (now.length > 0) {
    say(ctx, 'cli.metrics.now_header', { as_of: metrics.as_of });
    for (const line of now) ctx.stdout(line);
  }
  if (metrics.truncated) say(ctx, 'cli.metrics.truncated', { max: metrics.rows.length });
  say(ctx, 'cli.metrics.note');
}

function usage(ctx: CliContext): number {
  ctx.stderr(t('cli.metrics.usage'));
  return EXIT.usage;
}
