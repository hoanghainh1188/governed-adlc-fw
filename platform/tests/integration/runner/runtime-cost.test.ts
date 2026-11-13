// Task H06 AC2 (ADR-M25 §2.12): the cost of the stronger sandbox runtime, measured. Runs only with
// SDLC_RUNNER_TEST=1 and SDLC_RUNNER_SANDBOX_RUNTIME set (`pnpm test:runner` in the CI job
// `sandbox-runsc`). The same fixture sandbox starts several times under the Engine's default
// runtime and under the configured one; the test records the time from `createSandbox` to the
// sandbox's first output and the memory Docker reports for it. It writes the numbers to the job
// summary (GITHUB_STEP_SUMMARY) and to the test output; the deploy README keeps the measured values.
// Numbers only: no host name, no path, no log line.
import crypto from 'node:crypto';
import fs from 'node:fs';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createSandbox,
  DockerClient,
  packTar,
  runnerSettingsFromEnv,
  teardownSandbox,
  type RunnerSettings,
} from '../../../apps/runner/src/index.js';
import {
  BUSYBOX,
  buildFixtureImage,
  docker,
  dockerSocket,
  liveEnabled,
  liveRuntimeOption,
  waitForProbes,
  type FixtureImage,
} from './live-helpers';

const runtime = liveRuntimeOption().sandboxRuntime;
const ROUNDS = 3;
const TENANT = '55555555-5555-4555-8555-555555555555';
const suffix = crypto.randomBytes(4).toString('hex');

interface Sample {
  readonly startMs: number;
  readonly memoryMiB: number;
}

/** `12.5MiB / 256MiB` → 12.5; units as `docker stats` prints them. */
function mebibytes(usage: string): number {
  const match = /^([0-9.]+)\s*(B|KiB|MiB|GiB)\b/.exec(usage.trim());
  if (!match) return Number.NaN;
  const factor = { B: 1 / 1024 / 1024, KiB: 1 / 1024, MiB: 1, GiB: 1024 }[match[2] as 'B'];
  return Number(match[1]) * factor;
}

const median = (values: readonly number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? Number.NaN;

describe.skipIf(!liveEnabled || runtime === undefined)(
  'H06 live: the cost of the sandbox runtime',
  () => {
    let fixture: FixtureImage | undefined;
    const clients = new Map<string, { client: DockerClient; settings: RunnerSettings }>();

    beforeAll(async () => {
      docker('pull', '-q', BUSYBOX);
      fixture = await buildFixtureImage(`h06-${suffix}`);
      for (const name of ['default', runtime!]) {
        const settings = runnerSettingsFromEnv({
          SDLC_RUNNER_DOCKER_SOCKET: dockerSocket(),
          SDLC_RUNNER_INSTANCE: `h06-${name}-${suffix}`,
          SDLC_RUNNER_SANDBOX_MEMORY_MB: '256',
          SDLC_RUNNER_SANDBOX_RUNTIME: name === 'default' ? '' : name,
        });
        clients.set(name, {
          settings,
          client: new DockerClient({
            socketPath: settings.dockerSocket,
            timeoutMs: 120_000,
            ...(settings.sandboxRuntime ? { sandboxRuntime: settings.sandboxRuntime } : {}),
          }),
        });
      }
    }, 300_000);

    afterAll(() => fixture?.cleanup(), 120_000);

    async function sample(name: string): Promise<Sample> {
      const { client, settings } = clients.get(name)!;
      const runId = crypto.randomUUID();
      const started = performance.now();
      try {
        const sandbox = await createSandbox(client, settings, {
          runId,
          tenantId: TENANT,
          image: fixture!.image,
          adapter: 'openhands',
          egressAllowlist: [],
          workspaceTar: packTar([
            { type: 'dir', path: '.' },
            { type: 'file', path: 'probe-targets', content: Buffer.from('\n') },
          ]),
        });
        const probes = await waitForProbes(client, sandbox.containerId);
        const startMs = performance.now() - started;
        expect(probes.get('uid')).toBe('10001');
        const usage = docker(
          'stats',
          '--no-stream',
          '--format',
          '{{.MemUsage}}',
          sandbox.containerId,
        );
        return { startMs, memoryMiB: mebibytes(usage) };
      } finally {
        await teardownSandbox(client, runId).catch(() => undefined);
      }
    }

    it('measures start time and memory, default runtime against the configured one (AC2)', async () => {
      const results = new Map<string, Sample[]>();
      for (let round = 0; round < ROUNDS; round++) {
        for (const name of clients.keys()) {
          results.set(name, [...(results.get(name) ?? []), await sample(name)]);
        }
      }
      const rows = [...results].map(([name, samples]) => {
        const start = median(samples.map((s) => s.startMs));
        const memory = median(samples.map((s) => s.memoryMiB));
        expect(start).toBeGreaterThan(0);
        return `| ${name === 'default' ? 'runc (default)' : name} | ${start.toFixed(0)} | ${memory.toFixed(1)} |`;
      });
      const table = [
        `### H06: sandbox runtime cost (median of ${String(ROUNDS)}, fixture sandbox)`,
        '',
        '| Runtime | Start to first output (ms) | Memory after start (MiB) |',
        '|---|---|---|',
        ...rows,
        '',
      ].join('\n');
      process.stdout.write(`${table}\n`);
      const summary = process.env.GITHUB_STEP_SUMMARY;
      if (summary) fs.appendFileSync(summary, `${table}\n`);
    }, 900_000);
  },
);
