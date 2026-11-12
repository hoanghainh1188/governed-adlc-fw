// `adlc metrics gates` (E06 AC1, D-02 FR-12, ADR-M47) against a mocked API: the filters go to the
// API as query parameters; the table shows, per project and gate, the count, average, median, p90
// and maximum of the waits of the first round and after changes, apart (QUESTIONS #205); the
// platform passes and the intents at the gate now in their own table (QUESTIONS #207); the
// wall-clock note ends every output; refusals come back with their code.
import { t } from '@sdlc/messages';
import { describe, expect, it } from 'vitest';

import { agentMetricsSchema, gateMetricsSchema } from '../../apps/cli/src/api/schemas.js';
import {
  agentCostTable,
  agentRunTable,
  formatDuration,
  formatEstimate,
  formatShare,
  nowTable,
  waitTable,
} from '../../apps/cli/src/commands/metrics.js';
import { EXIT } from '../../apps/cli/src/index.js';
import { agentMetricsBody, gateMetricsBody } from './fixtures.js';
import { apiError, TOKEN, useHarness } from './harness.js';

const harness = useHarness();
const GATES = 'GET /v1/metrics/gates';
const AGENTS = 'GET /v1/metrics/agents';

describe('formatDuration', () => {
  it.each([
    [null, '-'],
    [0, '0s'],
    [45, '45s'],
    [60, '1m'],
    [125, '2m 5s'],
    [3600, '1h'],
    [5400, '1h 30m'],
    [86_400, '1d'],
    [93_784, '1d 2h'],
    [172_800, '2d'],
    [31_622_400, '366d'],
  ])('%j → %j (the two largest units, rounded down)', (seconds, text) => {
    expect(formatDuration(seconds)).toBe(text);
  });
});

describe('adlc metrics gates', () => {
  it('sends the scope, filters and range as query parameters (AC1)', async () => {
    const h = await harness({ routes: { [GATES]: { status: 200, body: gateMetricsBody() } } });
    const args = ['metrics', 'gates', '--project', 'pilot', '--gate', 'G3', '--mode', 'HITL'];
    const range = ['--risk', 'medium', '--from', '2026-09-01', '--to', '2026-10-01T00:00:00Z'];
    expect(await h.run([...args, ...range])).toBe(EXIT.ok);
    const url = h.requests[0]!.url;
    expect(url.pathname).toBe('/v1/metrics/gates');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      project: 'pilot',
      gate: 'G3',
      mode: 'HITL',
      risk: 'medium',
      from: '2026-09-01',
      to: '2026-10-01T00:00:00Z',
    });
  });

  it('sends no parameter for the default (the whole tenant, the last 30 days)', async () => {
    const h = await harness({
      routes: { [GATES]: { status: 200, body: gateMetricsBody({ tenant: true }) } },
    });
    expect(await h.run(['metrics', 'gates'])).toBe(EXIT.ok);
    expect([...h.requests[0]!.url.searchParams]).toEqual([]);
    expect(h.out[0]).toContain(t('cli.metrics.scope.tenant'));
  });

  it('prints average and maximum per gate and project, the two rounds apart (AC1)', async () => {
    const h = await harness({ routes: { [GATES]: { status: 200, body: gateMetricsBody() } } });
    expect(await h.run(['metrics', 'gates', '--project', 'pilot'])).toBe(EXIT.ok);
    expect(h.out[0]).toBe(
      t('cli.metrics.header', {
        scope: t('cli.metrics.scope.project', { project: 'pilot' }),
        from: '2026-09-04T00:00:00.000Z',
        to: '2026-10-04T00:00:00.000Z',
      }),
    );
    const text = h.out.join('\n');
    for (const label of [
      'cli.metrics.column.project',
      'cli.metrics.column.gate',
      'cli.metrics.column.avg',
      'cli.metrics.column.max',
      'cli.metrics.column.p50',
      'cli.metrics.column.p90',
    ] as const) {
      expect(text).toContain(t(label));
    }
    // count, average, median, p90, maximum
    const first = t('cli.metrics.round.first');
    const after = t('cli.metrics.round.after_changes');
    expect(text).toMatch(
      new RegExp(`pilot\\s+G3\\s+${first}\\s+4\\s+1h 30m\\s+1h\\s+1d 1h\\s+1d 2h`),
    );
    expect(text).toMatch(new RegExp(`pilot\\s+G3\\s+${after}\\s+1\\s+2d\\s+2d\\s+2d\\s+2d`));
    // G2 has no decision by a person: no line in the first table.
    expect(waitTable(gateMetricsSchema.parse(gateMetricsBody()).metrics)).toHaveLength(4);
    // Platform passes and the intents at the gate now.
    expect(text).toContain(t('cli.metrics.now_header', { as_of: '2026-10-04T09:00:00.000Z' }));
    expect(text).toMatch(/pilot\s+G2\s+3\s+0\s+-/);
    expect(text).toMatch(/pilot\s+G3\s+0\s+2\s+45s/);
    expect(h.out.at(-1)).toBe(t('cli.metrics.note'));
  });

  it('says when no person decided, and still prints the note', async () => {
    const h = await harness({
      routes: { [GATES]: { status: 200, body: gateMetricsBody({ empty: true }) } },
    });
    expect(await h.run(['metrics', 'gates', '--project', 'pilot'])).toBe(EXIT.ok);
    expect(h.out).toContain(t('cli.metrics.no_decisions'));
    expect(h.out.at(-1)).toBe(t('cli.metrics.note'));
  });

  it('says when the rows were cut at the limit', async () => {
    const h = await harness({
      routes: { [GATES]: { status: 200, body: gateMetricsBody({ truncated: true }) } },
    });
    expect(await h.run(['metrics', 'gates'])).toBe(EXIT.ok);
    expect(h.out).toContain(t('cli.metrics.truncated', { max: 2 }));
  });

  it('--json prints the validated body: raw seconds, the rounds apart, null when nothing', async () => {
    const h = await harness({ routes: { [GATES]: { status: 200, body: gateMetricsBody() } } });
    expect(await h.run(['metrics', 'gates', '--project', 'pilot', '--json'])).toBe(EXIT.ok);
    const body = JSON.parse(h.out.join('\n')) as {
      metrics: { clock: string; rows: Record<string, Record<string, unknown>>[] };
    };
    expect(body).toEqual(gateMetricsBody());
    expect(body.metrics.clock).toBe('wall_clock');
    expect(body.metrics.rows[1]!['first_round']).toEqual({
      count: 4,
      avg_seconds: 5400,
      max_seconds: 93784,
      p50_seconds: 3600,
      p90_seconds: 90000,
    });
    expect(body.metrics.rows[0]!['first_round']!['avg_seconds']).toBeNull();
  });

  it.each([
    [403, 'forbidden'],
    [404, 'project_not_found'],
  ])('reports a refusal %i %s (exit 1) without the token', async (status, code) => {
    const h = await harness({ routes: { [GATES]: apiError(status, code) } });
    expect(await h.run(['metrics', 'gates', '--project', 'pilot'])).toBe(EXIT.failed);
    expect(h.err.join('\n')).toContain(code);
    expect([...h.out, ...h.err].join('\n')).not.toContain(TOKEN);
  });

  it('a refused range comes back as a usage error (exit 2) naming the issue', async () => {
    const h = await harness({
      routes: {
        [GATES]: {
          status: 400,
          body: {
            error: {
              code: 'invalid_request',
              message: 'The request is not valid.',
              details: [{ path: 'query.to', issue: 'range_too_long' }],
            },
          },
        },
      },
    });
    expect(await h.run(['metrics', 'gates', '--from', '2024-01-01'])).toBe(EXIT.usage);
    expect(h.err.join('\n')).toContain('range_too_long');
  });

  it('refuses a body with a fractional or negative number of seconds', async () => {
    for (const bad of [1.5, -1]) {
      const body = gateMetricsBody() as {
        metrics: { rows: { open: Record<string, unknown> }[] };
      };
      body.metrics.rows[1]!.open['oldest_seconds'] = bad;
      const h = await harness({ routes: { [GATES]: { status: 200, body } } });
      expect(await h.run(['metrics', 'gates'])).not.toBe(EXIT.ok);
      expect(h.out).toEqual([]);
    }
  });

  it.each([
    [['metrics']],
    [['metrics', 'cost']],
    [['metrics', 'gates', '--gate', 'G9']],
    [['metrics', 'gates', '--mode', 'auto']],
    [['metrics', 'gates', '--risk', 'extreme']],
    [['metrics', 'gates', '--by', 'person']],
    [['metrics', 'gates', 'extra']],
  ])('%j prints the usage (exit 2)', async (args) => {
    const h = await harness({ routes: {} });
    expect(await h.run(args)).toBe(EXIT.usage);
    expect(h.err.join('\n')).toContain(t('cli.metrics.usage'));
    expect(h.requests).toHaveLength(0);
  });
});

describe('tables', () => {
  it('align their columns', () => {
    const metrics = gateMetricsSchema.parse(gateMetricsBody()).metrics;
    for (const lines of [waitTable(metrics), nowTable(metrics)]) {
      expect(new Set(lines.map((line) => line.length)).size).toBe(1);
    }
  });
});

describe('formatShare', () => {
  it.each([
    [0, 0, '-'],
    [0, 4, '0%'],
    [1, 3, '33%'],
    [2, 3, '67%'],
    [4, 4, '100%'],
  ])('%j of %j → %j', (part, whole, text) => {
    expect(formatShare(part, whole)).toBe(text);
  });
});

describe('adlc metrics agents (V13, ADR-M79)', () => {
  it('sends the scope, filters and range as query parameters', async () => {
    const h = await harness({ routes: { [AGENTS]: { status: 200, body: agentMetricsBody() } } });
    const args = ['metrics', 'agents', '--project', 'pilot', '--agent', 'coder-openhands'];
    expect(await h.run([...args, '--model', 'model-big', '--from', '2026-09-01'])).toBe(EXIT.ok);
    expect(h.requests[0]!.url.pathname).toBe('/v1/metrics/agents');
    expect(Object.fromEntries(h.requests[0]!.url.searchParams)).toEqual({
      project: 'pilot',
      agent: 'coder-openhands',
      model: 'model-big',
      from: '2026-09-01',
    });
  });

  it('sends no parameter for the default (the whole tenant, the last 30 days)', async () => {
    const h = await harness({
      routes: { [AGENTS]: { status: 200, body: agentMetricsBody({ tenant: true }) } },
    });
    expect(await h.run(['metrics', 'agents'])).toBe(EXIT.ok);
    expect([...h.requests[0]!.url.searchParams]).toEqual([]);
    expect(h.out[0]).toContain(t('cli.metrics.scope.tenant'));
  });

  it('prints the run table, the cost table, the unattributed cost and the note', async () => {
    const h = await harness({ routes: { [AGENTS]: { status: 200, body: agentMetricsBody() } } });
    expect(await h.run(['metrics', 'agents', '--project', 'pilot'])).toBe(EXIT.ok);
    const text = h.out.join('\n');
    expect(h.out[0]).toBe(
      t('cli.metrics.agents_header', {
        scope: t('cli.metrics.scope.project', { project: 'pilot' }),
        from: '2026-09-04T00:00:00.000Z',
        to: '2026-10-04T00:00:00.000Z',
      }),
    );
    // runs, ended well (2 of 3 ended), retries, CI first try, merged, no changes asked, breaches, lead
    expect(text).toMatch(
      /pilot\s+coder-openhands 1\.4\.0\s+model-big\s+4\s+67%\s+1\s+50%\s+2\s+50%\s+1\s+1h 30m\s+25\.0% \(1\)/,
    );
    // The row without a merge: no share, no lead time.
    expect(text).toMatch(/model-big|unknown\s+4\s+67%\s+1\s+50%\s+0\s+-\s+1\s+-/);
    expect(text).toMatch(/1450\s+310\s+6\.9%\s+0\.900000\s+0\.500000\s+0\.225000\s+0\.900000/);
    expect(h.out).toContain(t('cli.metrics.unattributed', { cost: '1.000000' }));
    expect(h.out.at(-1)).toBe(t('cli.metrics.agents_note'));
  });

  it('says when no run was created, and still prints the note', async () => {
    const h = await harness({
      routes: { [AGENTS]: { status: 200, body: agentMetricsBody({ empty: true }) } },
    });
    expect(await h.run(['metrics', 'agents', '--project', 'pilot'])).toBe(EXIT.ok);
    expect(h.out).toContain(t('cli.metrics.no_runs'));
    expect(
      agentRunTable(agentMetricsSchema.parse(agentMetricsBody({ empty: true })).metrics),
    ).toEqual([]);
    expect(h.out.at(-1)).toBe(t('cli.metrics.agents_note'));
  });

  it('says when the rows were cut at the limit', async () => {
    const h = await harness({
      routes: { [AGENTS]: { status: 200, body: agentMetricsBody({ truncated: true }) } },
    });
    expect(await h.run(['metrics', 'agents'])).toBe(EXIT.ok);
    expect(h.out).toContain(t('cli.metrics.truncated', { max: 2 }));
  });

  it('--json prints the validated body: amounts as strings, null when nothing', async () => {
    const h = await harness({ routes: { [AGENTS]: { status: 200, body: agentMetricsBody() } } });
    expect(await h.run(['metrics', 'agents', '--project', 'pilot', '--json'])).toBe(EXIT.ok);
    const body = JSON.parse(h.out.join('\n')) as {
      metrics: { rows: { cost: Record<string, unknown> }[] };
    };
    expect(body.metrics.rows[0]!.cost.total_usd).toBe('0.900000');
    expect(body.metrics.rows[1]!.cost.per_merged_intent_usd).toBeNull();
    expect(agentCostTable(agentMetricsSchema.parse(agentMetricsBody()).metrics)).toHaveLength(4);
  });

  // V14 (ADR-M79 §2.6, AC2): the lead time compared with the human-effort estimate.
  it('V14: shows the lead time against the estimate, and - without one', async () => {
    const h = await harness({ routes: { [AGENTS]: { status: 200, body: agentMetricsBody() } } });
    expect(await h.run(['metrics', 'agents', '--project', 'pilot'])).toBe(EXIT.ok);
    expect(h.out.join('\n')).toContain(t('cli.metrics.column.lead_estimate'));
    const lines = agentRunTable(agentMetricsSchema.parse(agentMetricsBody()).metrics);
    expect(lines.find((line) => line.includes('model-big'))).toMatch(/1h 30m\s+25\.0% \(1\)$/);
    expect(lines.find((line) => line.includes('unknown'))).toMatch(/\s-\s+-$/);
    expect(h.out.at(-1)).toBe(t('cli.metrics.agents_note'));
  });

  it('V14: --json carries the comparison; numbers only', async () => {
    const h = await harness({ routes: { [AGENTS]: { status: 200, body: agentMetricsBody() } } });
    expect(await h.run(['metrics', 'agents', '--project', 'pilot', '--json'])).toBe(EXIT.ok);
    const body = JSON.parse(h.out.join('\n')) as {
      metrics: { rows: { merged: { human_effort: unknown } }[] };
    };
    expect(body.metrics.rows[0]!.merged.human_effort).toEqual({
      count: 1,
      estimate_hours_sum: '8',
      lead_time_seconds_sum: 7200,
      lead_to_estimate_percent: 25,
    });
    expect(body.metrics.rows[1]!.merged.human_effort).toEqual({
      count: 0,
      estimate_hours_sum: null,
      lead_time_seconds_sum: null,
      lead_to_estimate_percent: null,
    });
  });

  it('V14: formats the comparison; - without an estimate or from an older server', () => {
    expect(formatEstimate(undefined)).toBe('-');
    expect(
      formatEstimate({
        count: 0,
        estimate_hours_sum: null,
        lead_time_seconds_sum: null,
        lead_to_estimate_percent: null,
      }),
    ).toBe('-');
    expect(
      formatEstimate({
        count: 3,
        estimate_hours_sum: '12.5',
        lead_time_seconds_sum: 90000,
        lead_to_estimate_percent: 200,
      }),
    ).toBe('200.0% (3)');
  });

  it('shows a refusal with its code (exit 1)', async () => {
    const h = await harness({
      routes: { [AGENTS]: apiError(403, 'forbidden') },
    });
    expect(await h.run(['metrics', 'agents', '--project', 'pilot'])).toBe(EXIT.failed);
    expect(h.err.join('\n')).toContain('forbidden');
  });

  it('refuses an unknown option (usage, exit 2)', async () => {
    const h = await harness({});
    expect(await h.run(['metrics', 'agents', '--person', 'x'])).toBe(EXIT.usage);
    expect(h.requests).toHaveLength(0);
  });
});
