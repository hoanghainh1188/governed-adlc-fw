// O08 AC4, AC5 (design/ADR-M112 §2.6): a webhook hint makes the groups of its repository due at
// once; it never polls before GitHub's rate-limit reset; a hint during a poll gives one more poll,
// however many hints came; a hint for an unknown repository changes nothing; with webhooks on the
// interval is the reconciliation interval, and off returns to the normal one. The hint listener
// connects again with a growing delay and polls everything once after a reconnect.
import { GitHostError } from '@sdlc/contracts';
import { describe, expect, it } from 'vitest';

import {
  HINT_RETRY_MAX_MS,
  HINT_RETRY_MIN_MS,
  HintListener,
} from '../../apps/worker/src/hint-listener.js';
import {
  HINT_FAILURE_BACKOFF_MS,
  pollIntervalSeconds,
  PollerLoop,
  type PollerLoopDeps,
  type PollReason,
} from '../../apps/worker/src/poller-loop.js';

type PollableProject = Awaited<ReturnType<PollerLoopDeps['listProjects']>>[number];
type Subscription = Awaited<ReturnType<ConstructorParameters<typeof HintListener>[0]['listen']>>;

const TENANT = '00000000-0000-4000-8000-000000000001' as PollableProject['tenantId'];
const ONE: PollableProject = { tenantId: TENANT, projectId: 'p1', repoFullName: 'acme/One' };
const TWO: PollableProject = { tenantId: TENANT, projectId: 'p2', repoFullName: 'acme/two' };

interface Harness {
  readonly loop: PollerLoop;
  readonly polls: { readonly project: string; readonly reason: PollReason }[];
  clock: number;
  pollImpl: () => Promise<unknown>;
}

function harness(): Harness {
  const h: Harness = {
    polls: [],
    clock: 0,
    pollImpl: () => Promise.resolve(),
    loop: undefined as unknown as PollerLoop,
  };
  (h as { loop: PollerLoop }).loop = new PollerLoop({
    listProjects: () => Promise.resolve([ONE, TWO]),
    intervalSeconds: () => Promise.resolve(300),
    poll: (group, reason) => {
      h.polls.push({ project: group.projectIds.join('+'), reason });
      return h.pollImpl();
    },
    now: () => h.clock,
    logger: { log: () => undefined },
    maxConcurrentPolls: 4,
  });
  return h;
}

async function tickAt(h: Harness, ms: number): Promise<void> {
  h.clock = ms;
  await h.loop.tick();
  await h.loop.idle();
}

describe('O08: webhook hints in the poller loop', () => {
  it('a hint polls its repository at the next tick, long before the interval (name in any case)', async () => {
    const h = harness();
    await tickAt(h, 0);
    expect(h.polls).toHaveLength(2);
    h.polls.length = 0;
    h.loop.hint('ACME/one');
    await tickAt(h, 1_000);
    expect(h.polls).toEqual([{ project: 'p1', reason: 'hinted' }]);
    // The next poll of the group is again on its interval.
    await tickAt(h, 2_000);
    expect(h.polls).toHaveLength(1);
    await tickAt(h, 301_000);
    expect(h.polls.slice(1).map((p) => p.reason)).toEqual(['scheduled', 'scheduled']);
  });

  it('a hint for a repository that no project polls changes nothing', async () => {
    const h = harness();
    await tickAt(h, 0);
    h.polls.length = 0;
    h.loop.hint('acme/unknown');
    await tickAt(h, 1_000);
    expect(h.polls).toEqual([]);
  });

  it('a hint never polls before the rate-limit reset of the Git host', async () => {
    const h = harness();
    h.pollImpl = () =>
      Promise.reject(
        new GitHostError('rate_limited', { retry_at: new Date(600_000).toISOString() }),
      );
    await tickAt(h, 0);
    h.pollImpl = () => Promise.resolve();
    h.polls.length = 0;
    h.loop.hint('acme/one');
    await tickAt(h, 1_000);
    expect(h.polls).toEqual([]);
    await tickAt(h, 600_000);
    expect(h.polls.find((p) => p.project === 'p1')).toEqual({ project: 'p1', reason: 'hinted' });
  });

  it('after a failed poll without a reset time, a hint waits for the backoff', async () => {
    const h = harness();
    h.pollImpl = () => Promise.reject(new GitHostError('server_error', { status: 502 }));
    await tickAt(h, 0);
    h.pollImpl = () => Promise.resolve();
    h.polls.length = 0;
    h.loop.hint('acme/one');
    await tickAt(h, 1_000);
    expect(h.polls).toEqual([]);
    await tickAt(h, HINT_FAILURE_BACKOFF_MS);
    expect(h.polls.find((p) => p.project === 'p1')).toEqual({ project: 'p1', reason: 'hinted' });
  });

  it('hints during a running poll give exactly one more poll after it', async () => {
    const h = harness();
    const releases: (() => void)[] = [];
    h.pollImpl = () =>
      new Promise((resolve) => {
        releases.push(() => {
          resolve(undefined);
        });
      });
    h.clock = 0;
    await h.loop.tick();
    // Both groups are running now; three hints for one of them.
    h.loop.hint('acme/one');
    h.loop.hint('acme/one');
    await h.loop.tick();
    h.loop.hint('acme/one');
    await h.loop.tick();
    h.pollImpl = () => Promise.resolve();
    for (const release of releases) release();
    await h.loop.idle();
    await tickAt(h, 1_000);
    const p1 = h.polls.filter((p) => p.project === 'p1');
    expect(p1).toEqual([
      { project: 'p1', reason: 'scheduled' },
      { project: 'p1', reason: 'hinted' },
    ]);
  });

  it('a started loop polls at once after a hint, without waiting for its tick', async () => {
    const h = harness();
    h.loop.start(60_000);
    await new Promise((r) => setImmediate(r));
    await h.loop.idle();
    h.polls.length = 0;
    const before = Date.now();
    h.loop.hint('acme/two');
    for (let i = 0; i < 50 && h.polls.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    await h.loop.stop();
    expect(h.polls).toEqual([{ project: 'p2', reason: 'hinted' }]);
    expect(Date.now() - before).toBeLessThan(1_000);
  });

  it('hintAll makes every group due (after the hint connection came back)', async () => {
    const h = harness();
    await tickAt(h, 0);
    h.polls.length = 0;
    h.loop.hintAll();
    await tickAt(h, 1_000);
    expect(h.polls.map((p) => p.project).sort()).toEqual(['p1', 'p2']);
  });
});

describe('O08 AC4: the interval with webhooks on and off', () => {
  const github = (enabled: boolean) => ({
    poll_interval_seconds: 30,
    webhooks: { enabled, reconcile_interval_seconds: 300 },
  });

  it('is the reconciliation interval with webhooks on, the normal one when off', () => {
    expect(pollIntervalSeconds(github(true))).toBe(300);
    expect(pollIntervalSeconds(github(false))).toBe(30);
  });
});

describe('O08: the hint listener', () => {
  function subscription(): { sub: Subscription; end: (code: string) => void } {
    let end: (code: string) => void = () => undefined;
    const ended = new Promise<string>((resolve) => {
      end = resolve;
    });
    return { sub: { ended, close: () => (end('closed'), Promise.resolve()) }, end };
  }

  it('passes hints on, connects again with a growing delay, and polls everything after a reconnect', async () => {
    const sleeps: number[] = [];
    const hints: string[] = [];
    let reconnects = 0;
    const subs: ReturnType<typeof subscription>[] = [];
    let failures = 2;
    let onHintSeen: ((hint: { host: 'github'; repository: string }) => void) | undefined;
    const events: string[] = [];
    const listener = new HintListener({
      listen: (onHint) => {
        if (subs.length === 1 && failures > 0) {
          failures -= 1;
          return Promise.reject(
            Object.assign(new Error('postgres://u:pw@db/x'), { code: 'ECONNREFUSED' }),
          );
        }
        onHintSeen = onHint;
        const s = subscription();
        subs.push(s);
        return Promise.resolve(s.sub);
      },
      onHint: (hint) => hints.push(hint.repository),
      onReconnect: () => {
        reconnects += 1;
      },
      logger: { log: (_level, event, fields) => events.push(`${event}:${JSON.stringify(fields)}`) },
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });
    listener.start();
    await new Promise((r) => setImmediate(r));
    onHintSeen?.({ host: 'github', repository: 'acme/shop' });
    expect(hints).toEqual(['acme/shop']);
    expect(reconnects).toBe(0);
    subs[0]!.end('57P01');
    for (let i = 0; i < 20 && subs.length < 2; i += 1) await new Promise((r) => setImmediate(r));
    expect(subs).toHaveLength(2);
    expect(reconnects).toBe(1);
    expect(sleeps).toEqual([HINT_RETRY_MIN_MS, HINT_RETRY_MIN_MS * 2, HINT_RETRY_MIN_MS * 4]);
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(HINT_RETRY_MAX_MS);
    // Codes only: never the error message (it can hold the database URL).
    expect(events.join('\n')).not.toContain('postgres://');
    expect(events).toContain('worker.hints_connect_failed:{"code":"ECONNREFUSED"}');
    expect(events).toContain('worker.hints_lost:{"code":"57P01"}');
    await listener.stop();
  });

  it('a failed first connect polls everything once it connects; stop ends a wait at once', async () => {
    let calls = 0;
    let reconnects = 0;
    const first = subscription();
    const listener = new HintListener({
      listen: () => {
        calls += 1;
        return calls === 1
          ? Promise.reject(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))
          : Promise.resolve(first.sub);
      },
      onHint: () => undefined,
      onReconnect: () => {
        reconnects += 1;
      },
      logger: { log: () => undefined },
      sleep: () => Promise.resolve(),
    });
    listener.start();
    for (let i = 0; i < 20 && calls < 2; i += 1) await new Promise((r) => setImmediate(r));
    expect(reconnects).toBe(1);
    await listener.stop();

    // A real wait (no test sleep): stop does not wait for it.
    const waiting = new HintListener({
      listen: () => Promise.reject(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })),
      onHint: () => undefined,
      onReconnect: () => undefined,
      logger: { log: () => undefined },
    });
    waiting.start();
    await new Promise((r) => setImmediate(r));
    const before = Date.now();
    await waiting.stop();
    expect(Date.now() - before).toBeLessThan(500);
  });
});
