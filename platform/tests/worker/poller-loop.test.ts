// D-08 B06 AC1 (scheduling part): the poller loop polls each project on its own interval from the
// project configuration, never runs two polls of one project at once, picks up a configuration
// change without a restart and waits for GitHub's rate-limit reset (design/ADR-M27 §2.1).
import { GitHostError } from '@sdlc/contracts';
import { describe, expect, it } from 'vitest';

import {
  INVALID_CONFIG_RETRY_MS,
  PollerLoop,
  type PollerLoopDeps,
} from '../../apps/worker/src/poller-loop.js';
import { currentLogContext } from '../../packages/core/src/observability/index.js';

/** The worker is typed against the built `@sdlc/core`; take its types from the loop. */
type PollableProject = Awaited<ReturnType<PollerLoopDeps['listProjects']>>[number];
type PollableRepository = Parameters<PollerLoopDeps['poll']>[0];

const TENANT = '00000000-0000-4000-8000-000000000001' as PollableProject['tenantId'];
const P1: PollableProject = { tenantId: TENANT, projectId: 'p1', repoFullName: 'acme/one' };
const P2: PollableProject = { tenantId: TENANT, projectId: 'p2', repoFullName: 'acme/two' };

interface Harness {
  readonly loop: PollerLoop;
  readonly polls: string[];
  readonly logs: { event: string; fields: Record<string, unknown> }[];
  readonly intervals: Map<string, number>;
  projects: PollableProject[];
  clock: number;
  pollImpl: (group: PollableRepository) => Promise<unknown>;
}

function harness(maxConcurrentPolls = 4): Harness {
  const h: Harness = {
    polls: [],
    logs: [],
    intervals: new Map([
      ['p1', 30],
      ['p2', 60],
    ]),
    projects: [P1, P2],
    clock: 0,
    pollImpl: () => Promise.resolve(),
    loop: undefined as unknown as PollerLoop,
  };
  (h as { loop: PollerLoop }).loop = new PollerLoop({
    listProjects: () => Promise.resolve(h.projects),
    intervalSeconds: (p) => {
      const seconds = h.intervals.get(p.projectId);
      return seconds === undefined
        ? Promise.reject(Object.assign(new Error('bad'), { code: 'config_invalid' }))
        : Promise.resolve(seconds);
    },
    poll: (g) => {
      h.polls.push(g.projectIds.join('+'));
      return h.pollImpl(g);
    },
    now: () => h.clock,
    logger: { log: (_level, event, fields) => h.logs.push({ event, fields: { ...fields } }) },
    maxConcurrentPolls,
  });
  return h;
}

/** Lets the started polls reach the Git host (they read the intervals first). */
const settle = (): Promise<void> => new Promise((r) => setImmediate(r));

async function tickAt(h: Harness, ms: number): Promise<void> {
  h.clock = ms;
  await h.loop.tick();
  await h.loop.idle();
}

describe('poller loop', () => {
  it('A08 AC1: a poll runs with its tenant in the log context', async () => {
    const h = harness();
    const seen: unknown[] = [];
    h.pollImpl = async () => {
      await Promise.resolve();
      seen.push(currentLogContext());
    };
    await tickAt(h, 0);
    expect(seen).toEqual([{ tenantId: TENANT }, { tenantId: TENANT }]);
    expect(currentLogContext()).toEqual({});
  });

  it('polls every project at once after a (re)start, then on its own interval', async () => {
    const h = harness();
    await tickAt(h, 0);
    expect(h.polls).toEqual(['p1', 'p2']);
    await tickAt(h, 29_999);
    expect(h.polls).toEqual(['p1', 'p2']);
    await tickAt(h, 30_000);
    expect(h.polls).toEqual(['p1', 'p2', 'p1']);
    await tickAt(h, 60_000);
    expect(h.polls).toEqual(['p1', 'p2', 'p1', 'p1', 'p2']);
  });

  it('reads the interval before every poll, so a configuration change applies without a restart', async () => {
    const h = harness();
    await tickAt(h, 0);
    h.intervals.set('p1', 5);
    await tickAt(h, 30_000); // due under the old interval; the new one is used from now on
    await tickAt(h, 35_000);
    expect(h.polls.filter((p) => p === 'p1')).toHaveLength(3);
  });

  it('never runs two polls of one repository at once', async () => {
    const h = harness();
    let release!: () => void;
    h.pollImpl = (p) =>
      p.projectIds.includes('p1') ? new Promise<void>((r) => (release = r)) : Promise.resolve();
    h.clock = 0;
    await h.loop.tick();
    h.clock = 120_000;
    await h.loop.tick();
    await h.loop.tick();
    expect(h.polls.filter((p) => p === 'p1')).toHaveLength(1);
    release();
    await h.loop.idle();
  });

  it('limits the polls running at the same time', async () => {
    const h = harness(1);
    let release!: () => void;
    h.pollImpl = () => new Promise<void>((r) => (release = r));
    await h.loop.tick();
    await settle();
    expect(h.polls).toEqual(['p1']);
    release();
    await h.loop.idle();
    await h.loop.tick();
    await settle();
    expect(h.polls).toEqual(['p1', 'p2']);
    release();
    await h.loop.idle();
  });

  it('polls the longest-waiting projects first, so none is starved', async () => {
    const h = harness(1);
    const P3 = { ...P1, projectId: 'p3', repoFullName: 'acme/three' };
    h.projects = [P1, P2, P3];
    h.intervals.set('p3', 30);
    h.intervals.set('p2', 30);
    for (const ms of [0, 1, 2, 30_000, 30_001, 30_002]) await tickAt(h, ms);
    expect(h.polls).toEqual(['p1', 'p2', 'p3', 'p1', 'p2', 'p3']);
  });

  it('waits for the rate-limit reset of the Git host', async () => {
    const h = harness();
    h.projects = [P1];
    h.pollImpl = () =>
      Promise.reject(
        new GitHostError('rate_limited', { retry_at: new Date(600_000).toISOString() }),
      );
    await tickAt(h, 0);
    h.pollImpl = () => Promise.resolve();
    await tickAt(h, 30_000);
    await tickAt(h, 599_999);
    expect(h.polls).toEqual(['p1']);
    await tickAt(h, 600_000);
    expect(h.polls).toEqual(['p1', 'p1']);
    expect(h.logs.map((l) => l.event)).toContain('worker.poll_failed');
    expect(h.logs.find((l) => l.event === 'worker.poll_failed')?.fields.error).toBe('rate_limited');
  });

  it('logs the catalog key of an OpenBao error (for example a missing GitHub App key)', async () => {
    const h = harness();
    h.projects = [P1];
    h.pollImpl = () =>
      Promise.reject(
        Object.assign(new Error('No secret at shared/github-app.'), { key: 'secrets.not_found' }),
      );
    await tickAt(h, 0);
    expect(h.logs.find((l) => l.event === 'worker.poll_failed')?.fields).toMatchObject({
      project_id: 'p1',
      error: 'secrets.not_found',
    });
  });

  it('skips a project whose configuration cannot be read, and tries it again later', async () => {
    const h = harness();
    h.intervals.delete('p2');
    await tickAt(h, 0);
    expect(h.polls).toEqual(['p1']);
    expect(h.logs.find((l) => l.event === 'worker.poll_config_invalid')?.fields).toMatchObject({
      project_id: 'p2',
      error: 'config_invalid',
    });
    h.intervals.set('p2', 60);
    await tickAt(h, INVALID_CONFIG_RETRY_MS);
    expect(h.polls).toContain('p2');
  });

  it('forgets projects that are no longer pollable', async () => {
    const h = harness();
    await tickAt(h, 0);
    h.projects = [P1];
    await tickAt(h, 120_000);
    expect(h.polls).toEqual(['p1', 'p2', 'p1']);
  });

  it('stops cleanly: no new polls after stop, running ones finish', async () => {
    const h = harness();
    h.loop.start(10);
    await new Promise((r) => setTimeout(r, 30));
    await h.loop.stop();
    const count = h.polls.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(h.polls.length).toBe(count);
  });

  describe('O06 PR 2c: one poll per repository (ADR-M106 §2.4)', () => {
    const P1B: PollableProject = { ...P1, projectId: 'p1b' };
    const OTHER_TENANT = '00000000-0000-4000-8000-000000000002' as PollableProject['tenantId'];

    it('polls the projects of one tenant on one repository together', async () => {
      const h = harness();
      const seen: PollableRepository[] = [];
      h.pollImpl = (g) => {
        seen.push(g);
        return Promise.resolve();
      };
      h.projects = [P1, P1B, P2, { ...P1, tenantId: OTHER_TENANT, projectId: 'p9' }];
      h.intervals.set('p9', 30);
      await tickAt(h, 0);
      expect([...h.polls].sort()).toEqual(['p1+p1b', 'p2', 'p9']);
      expect(seen.find((g) => g.projectIds.length === 2)).toEqual({
        tenantId: TENANT,
        repoFullName: 'acme/one',
        projectIds: ['p1', 'p1b'],
      });
    });

    it('uses the shortest interval of the group', async () => {
      const h = harness();
      h.projects = [P1, P1B];
      h.intervals.set('p1b', 10);
      await tickAt(h, 0);
      await tickAt(h, 10_000);
      expect(h.polls).toEqual(['p1+p1b', 'p1+p1b']);
    });

    it('a project whose configuration cannot be read does not stop the group', async () => {
      const h = harness();
      h.projects = [P1, P1B];
      await tickAt(h, 0);
      expect(h.polls).toEqual(['p1+p1b']);
      expect(h.logs.find((l) => l.event === 'worker.poll_config_invalid')?.fields).toMatchObject({
        project_id: 'p1b',
      });
      // No interval at all: the group waits.
      h.intervals.delete('p1');
      await tickAt(h, 30_000);
      expect(h.polls).toEqual(['p1+p1b']);
      h.intervals.set('p1', 30);
      await tickAt(h, 30_000 + INVALID_CONFIG_RETRY_MS);
      expect(h.polls).toEqual(['p1+p1b', 'p1+p1b']);
    });

    it('a project that leaves the repository gets its own poll', async () => {
      const h = harness();
      h.projects = [P1, P1B];
      h.intervals.set('p1b', 30);
      await tickAt(h, 0);
      h.projects = [P1, { ...P1B, repoFullName: 'acme/moved' }];
      await tickAt(h, 30_000);
      expect(h.polls[0]).toBe('p1+p1b');
      expect(h.polls.slice(1).sort()).toEqual(['p1', 'p1b']);
    });
  });
});
