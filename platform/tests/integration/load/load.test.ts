// D-08 O07 AC1 (NFR-01; QUESTIONS #717–#720): a repeatable load test with stub models. Many
// intents of many tenants go from G1 to `done` at once, through the poller, the intent workflow
// on the Compose Temporal, the runner's task queue (a fake runner, QUESTIONS #717) and the
// database. Skipped unless SDLC_LOAD_TEST=1. Run with: pnpm test:load (QUESTIONS #718: on a
// developer machine, or by hand on CI; never on a pull request).
//
// The people decide G1–G3 and G8 with comment commands, read by the real poller; CI, the review
// and the merge at G6–G7 are fakes that answer at once and wake the intent, as the poller's check
// and review events would. The test checks only that every intent ends `done`; the numbers go to
// a JSON report (`SDLC_LOAD_REPORT=<file>`, else printed): time per gate, intents per minute, the
// database's size, the test process's memory and CPU, the Temporal container's, and the GitHub
// API calls per project and hour against GitHub's limit (QUESTIONS #720). Scale (QUESTIONS #719):
// `SDLC_LOAD_TENANTS` (default 20), `SDLC_LOAD_INTENTS` per tenant (25), `SDLC_LOAD_RUNNER_SLOTS`
// (2), `SDLC_LOAD_RUN_MS` (1000), `SDLC_LOAD_POLL_MS` (2000), `SDLC_LOAD_TIMEOUT_MINUTES` (60).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Intent } from '../../../packages/core/src/db/schema.js';
import { PEOPLE } from '../workflow/fixture.js';
import { loadSettings, LoadStack, type LoadTenant } from './stack.js';

const enabled = process.env.SDLC_LOAD_TEST === '1';

/** GitHub's documented limit for an App installation's token: 5,000 requests per hour. */
export const GITHUB_INSTALLATION_LIMIT_PER_HOUR = 5000;
/** The default `github.poll_interval_seconds` of the project configuration. */
const DEFAULT_POLL_SECONDS = 30;

/** Who decides each HITL gate of a Medium intent by comment (like `atG4`, E03). */
const DECIDER: Readonly<Record<string, keyof typeof PEOPLE>> = {
  G1: 'a',
  G2: 'a',
  G3: 'b',
  G8: 'b',
};

interface Tracked {
  readonly tenant: LoadTenant;
  intent: Intent;
  readonly createdAt: number;
  doneAt?: number;
}

function quantile(values: readonly number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}

const seconds = (ms: number | null) => (ms === null ? null : Math.round(ms / 100) / 10);

/** `docker stats` of one container: CPU percent and memory, or null. */
function containerStats(name: string): { cpu: string; memory: string } | null {
  try {
    const out = execFileSync(
      'docker',
      ['stats', '--no-stream', '--format', '{{.CPUPerc}}|{{.MemUsage}}', name],
      { encoding: 'utf8' },
    ).trim();
    const [cpu, memory] = out.split('|');
    return { cpu: cpu ?? '', memory: memory ?? '' };
  } catch {
    return null;
  }
}

describe.skipIf(!enabled)('O07: load test (many intents and tenants at once)', () => {
  const settings = loadSettings();
  const stack = new LoadStack(settings);
  let peakRss = 0;
  const temporalSamples: { cpu: string; memory: string }[] = [];

  beforeAll(async () => {
    await stack.start();
  }, 900_000);

  afterAll(async () => {
    await stack.stop();
  }, 300_000);

  it(
    'every intent goes from G1 to done; the numbers go to the report',
    async () => {
      const tracked: Tracked[] = [];
      const cpuStart = process.cpuUsage();
      const dbStart = await databaseBytes();
      const started = Date.now();
      for (const tenant of stack.tenants) {
        for (let i = 0; i < settings.intentsPerTenant; i += 1) {
          const intent = await tenant.f.newIntent({ riskTier: 'medium' });
          await tenant.f.addInputs(intent);
          tracked.push({ tenant, intent, createdAt: Date.now() });
        }
      }
      await Promise.all(tracked.map((t) => stack.signals.wake(t.tenant.ref(t.intent))));

      const decided = new Set<string>();
      const woken = new Set<string>();
      const polls = new Map<LoadTenant, number>();
      const deadline = started + settings.timeoutMs;
      while (tracked.some((t) => t.doneAt === undefined)) {
        if (Date.now() > deadline) throw new Error(`timed out: ${report().done} done`);
        await Promise.all(stack.tenants.map((tenant) => drive(tenant)));
        peakRss = Math.max(peakRss, process.memoryUsage().rss);
        if (temporalSamples.length < 1000) {
          const stats = containerStats(stack.temporalContainer);
          if (stats) temporalSamples.push(stats);
        }
        await new Promise((resolve) => setTimeout(resolve, settings.pollMs));
      }

      async function drive(tenant: LoadTenant): Promise<void> {
        tenant.f.h.stub.now = new Date();
        for (const t of tracked.filter((x) => x.tenant === tenant && x.doneAt === undefined)) {
          t.intent = (await tenant.f.scope.intents.getById(t.intent.id))!;
          const { status, current_gate: gate } = t.intent;
          if (status === 'done') {
            t.doneAt = Date.now();
            continue;
          }
          if (status !== 'in_gate' || gate === null) continue;
          const key = `${t.intent.id}:${gate}`;
          const who = DECIDER[gate];
          if (who !== undefined && !decided.has(key) && (await ready(tenant, t.intent, gate))) {
            decided.add(key);
            tenant.f.comment(t.intent, `/approve ${gate}`, who);
          }
          if ((gate === 'G6' || gate === 'G7') && t.intent.pr_number !== null) {
            // What the poller's check and review events would wake: once when CI passed (the
            // pull request is linked), once at G7 for the review, once after the merge.
            const merged = await mergeWhenReady(tenant, t.intent);
            const wakeKey = `${t.intent.id}:${gate}:${String(merged)}`;
            if (!woken.has(wakeKey)) {
              woken.add(wakeKey);
              await stack.signals.wake(tenant.ref(t.intent));
            }
          }
        }
        await tenant.f.poll(stack.signals);
        polls.set(tenant, (polls.get(tenant) ?? 0) + 1);
      }

      /** G8 waits for its release pack before Person B approves (E03). */
      async function ready(tenant: LoadTenant, intent: Intent, gate: string): Promise<boolean> {
        if (gate !== 'G8') return true;
        return (await tenant.f.scope.evidencePacks.listForIntent(intent.id)).length > 0;
      }

      /** Person B merges once G7 says the pull request may be merged (E01). */
      async function mergeWhenReady(tenant: LoadTenant, intent: Intent): Promise<boolean> {
        const pr = tenant.prs.get(intent.pr_number!);
        if (!pr || pr.merged) return pr?.merged ?? false;
        const kinds = (await tenant.f.scope.intentNotices.listForIntent(intent.id)).map(
          (n) => n.kind,
        );
        if (kinds.includes('g7_merge_ready')) pr.merged = true;
        return pr.merged;
      }

      async function databaseBytes(): Promise<number> {
        const row = await sql<{
          bytes: string;
        }>`SELECT pg_database_size(current_database())::text AS bytes`.execute(stack.db.owner);
        return Number(row.rows[0]!.bytes);
      }

      /** Per gate: the time from the gate's first decision before it to its own decision. */
      async function gateTimes(): Promise<
        Record<string, { p50: number | null; p95: number | null }>
      > {
        const byGate = new Map<string, number[]>();
        for (const t of tracked) {
          const decisions = await t.tenant.f.scope.gateDecisions.listForIntent(t.intent.id);
          let previous = t.createdAt;
          for (const d of [...decisions].sort(
            (x, y) => x.created_at.getTime() - y.created_at.getTime(),
          )) {
            const at = d.created_at.getTime();
            const list = byGate.get(d.gate) ?? [];
            list.push(at - previous);
            byGate.set(d.gate, list);
            previous = at;
          }
        }
        return Object.fromEntries(
          [...byGate.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([gate, values]) => [
              gate,
              { p50: seconds(quantile(values, 0.5)), p95: seconds(quantile(values, 0.95)) },
            ]),
        );
      }

      function report() {
        const done = tracked.filter((t) => t.doneAt !== undefined);
        return { done: done.length };
      }

      const finished = Date.now();
      // A quiet repository: five polls per tenant with nothing new.
      const quietBefore = stack.tenants.reduce((n, t) => n + t.f.h.stub.requests.length, 0);
      for (let i = 0; i < 5; i += 1) {
        for (const tenant of stack.tenants) {
          tenant.f.h.stub.now = new Date();
          await tenant.f.poll(stack.signals);
        }
      }
      const quietPerPoll =
        (stack.tenants.reduce((n, t) => n + t.f.h.stub.requests.length, 0) - quietBefore) /
        (5 * stack.tenants.length);
      // The quiet polls of each tenant are not part of the busy numbers.
      const quietRequests = () => Math.round(quietPerPoll * 5);

      const durations = tracked.map((t) => t.doneAt! - t.createdAt);
      const wallMinutes = (finished - started) / 60_000;
      const github = stack.tenants.map((tenant) => {
        const pollCount = polls.get(tenant) ?? 0;
        const pollerRequests = tenant.f.h.stub.requests.length - quietRequests();
        const fake = Object.values(tenant.fakeCalls).reduce((a, b) => a + b, 0);
        return { pollCount, pollerRequests, fake };
      });
      const sum = (pick: (g: (typeof github)[number]) => number) =>
        github.reduce((a, g) => a + pick(g), 0);
      // The poller's requests per poll (comment listing, notices, replies), and the other reads
      // and writes per intent (G4–G8 fakes): an hour of one project at the default interval.
      const perPoll =
        sum((g) => g.pollerRequests) /
        Math.max(
          1,
          sum((g) => g.pollCount),
        );
      const perIntent = sum((g) => g.fake) / tracked.length;
      const pollsPerHour = 3600 / DEFAULT_POLL_SECONDS;
      const cpu = process.cpuUsage(cpuStart);
      const dbEnd = await databaseBytes();
      const result = {
        task: 'O07',
        date: new Date().toISOString(),
        machine: {
          platform: `${os.platform()} ${os.release()}`,
          cpus: os.cpus().length,
          cpu_model: os.cpus()[0]?.model ?? null,
          memory_gb: Math.round(os.totalmem() / 1024 ** 3),
        },
        settings,
        intents: tracked.length,
        tenants: stack.tenants.length,
        wall_minutes: Math.round(wallMinutes * 10) / 10,
        intents_per_minute: Math.round((tracked.length / wallMinutes) * 10) / 10,
        end_to_end_seconds: {
          p50: seconds(quantile(durations, 0.5)),
          p95: seconds(quantile(durations, 0.95)),
          max: seconds(Math.max(...durations)),
        },
        gate_seconds: await gateTimes(),
        runner: stack.runner,
        database_mb: {
          before: Math.round(dbStart / 1024 ** 2),
          after: Math.round(dbEnd / 1024 ** 2),
          per_intent_kb: Math.round((dbEnd - dbStart) / 1024 / tracked.length),
        },
        test_process: {
          peak_rss_mb: Math.round(peakRss / 1024 ** 2),
          cpu_seconds: Math.round((cpu.user + cpu.system) / 1e6),
        },
        temporal_container: {
          samples: temporalSamples.length,
          last: temporalSamples.at(-1) ?? null,
        },
        github: {
          polls: sum((g) => g.pollCount),
          poller_requests: sum((g) => g.pollerRequests),
          requests_per_poll: Math.round(perPoll * 100) / 100,
          quiet_requests_per_poll: Math.round(quietPerPoll * 100) / 100,
          quiet_projects_per_installation_at_default_interval: Math.floor(
            GITHUB_INSTALLATION_LIMIT_PER_HOUR / Math.max(1, quietPerPoll * pollsPerHour),
          ),
          other_requests_per_intent: Math.round(perIntent * 10) / 10,
          default_poll_interval_seconds: DEFAULT_POLL_SECONDS,
          poller_requests_per_project_hour: Math.round(perPoll * pollsPerHour),
          installation_limit_per_hour: GITHUB_INSTALLATION_LIMIT_PER_HOUR,
          projects_per_installation_at_default_interval: Math.floor(
            GITHUB_INSTALLATION_LIMIT_PER_HOUR / Math.max(1, perPoll * pollsPerHour),
          ),
        },
      };
      const json = `${JSON.stringify(result, null, 2)}\n`;
      if (process.env.SDLC_LOAD_REPORT) fs.writeFileSync(process.env.SDLC_LOAD_REPORT, json);
      else process.stdout.write(json);

      for (const t of tracked) expect(t.intent.status).toBe('done');
      expect(stack.runner.executed).toBe(tracked.length);
      expect(stack.runner.maxActive).toBeLessThanOrEqual(settings.runnerSlots);
    },
    4 * 60 * 60_000,
  );
});
