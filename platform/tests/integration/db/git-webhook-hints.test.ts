// D-08 O08 AC3, AC5 on a live PostgreSQL, with the in-process GitHub stub (design/ADR-M112):
// a hint sent with `NOTIFY` reaches the worker's `LISTEN`, the poller loop polls the repository at
// once through the same `pollRepository` (handler, cursor, receipts) as every poll, and the
// workflow is signalled in under 3 seconds. A repeated hint changes nothing; events that arrive in
// any order are applied in the cursor's order; without hints (a webhook outage) the
// reconciliation poll applies the events; a lost listener connection comes back and polls once.
import { createSimplePolicyEngine } from '@sdlc/adapter-policy-simple';
import type { IntentWorkflowRef } from '@sdlc/contracts';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { HintListener } from '../../../apps/worker/src/hint-listener.js';
import { PollerLoop, type PollerLoopDeps } from '../../../apps/worker/src/poller-loop.js';
import { parseTenantId, type TenantId } from '../../../packages/core/src/db/tenant-id.js';
import type { TenantScope } from '../../../packages/core/src/db/tenant-scope.js';
import { pollRepository } from '../../../packages/core/src/git-events/poll-project.js';
import { Registry } from '../../../packages/core/src/registry/registry.js';
import { startHarness, type Harness } from '../../git-github/helpers.js';
import { comment, user } from '../../git-github/stub-github.js';
import { createTestDatabase, describeDb, tamper, type TestDatabase } from './helpers.js';

const GH_A = 1001;
const RECONCILE_MS = 300_000;

/** Waits until `check` is true, checking every 10 ms, for at most `ms`. */
async function until(check: () => boolean | Promise<boolean>, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('condition not reached');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describeDb('O08: webhook hints through NOTIFY and LISTEN on PostgreSQL', () => {
  let db: TestDatabase;
  let h: Harness;
  let scope: TenantScope;
  let tenantId: TenantId;
  let projectId: string;
  let userA: string;
  let registry: Registry;
  let loop: PollerLoop;
  let listener: HintListener;
  const comments: ReturnType<typeof comment>[] = [];
  const wakes: { readonly intentId: string; readonly at: number }[] = [];
  const events: string[] = [];
  let nextCommentId = 500;
  let clockSeconds = 10;
  /** The loop's clock: real time plus an offset, so a test can jump past the interval. */
  let offsetMs = 0;

  function post(issue: number, body: string): void {
    const id = (nextCommentId += 1);
    clockSeconds += 1;
    const at = new Date(Date.parse('2026-09-26T08:00:00Z') + clockSeconds * 1000)
      .toISOString()
      .replace('.000Z', 'Z');
    comments.push(comment(id, issue, at, body, { author: user(GH_A, 'harry') }));
  }

  async function newIntent(issue: number): Promise<string> {
    const intent = await registry.createIntent(scope, {
      projectId,
      title: `Intent on issue ${String(issue)}`,
      createdBy: userA,
      riskTier: 'low',
      dataClass: 'internal',
      issueNumber: issue,
    });
    await scope.intents.updateState(intent.id, {
      status: 'in_gate',
      currentGate: 'G1',
      actorType: 'system',
      actorId: null,
    });
    return intent.id;
  }

  async function decisionsOf(intentIds: readonly string[]): Promise<string[]> {
    const rows = (
      await sql<{ intent_id: string }>`SELECT intent_id FROM gate_decisions
        ORDER BY created_at, id`.execute(db.owner)
    ).rows;
    return rows.map((r) => r.intent_id).filter((id) => intentIds.includes(id));
  }

  const hint = (): Promise<void> =>
    db.app.notifyGitHint({ host: 'github', repository: 'acme/shop' });

  beforeAll(async () => {
    db = await createTestDatabase();
    registry = new Registry({
      policyFactory: (config) => createSimplePolicyEngine({ config }),
      now: () => new Date('2026-09-26T08:00:00Z'),
    });
    const tenant = await db.app.system.createTenant({ slug: 'internal', name: 'Internal' });
    tenantId = parseTenantId(tenant.id);
    scope = db.app.forTenant(tenantId);
    const project = await scope.projects.create({
      slug: 'shop',
      name: 'Shop',
      git_provider: 'github',
      repo_full_name: 'acme/shop',
    });
    projectId = project.id;
    const a = await scope.users.create({ display_name: 'a', email: 'a@example.com' });
    userA = a.id;
    await scope.roleBindings.grant({ user_id: a.id, project_id: project.id, role: 'person_a' });
    await scope.userIdentities.link({
      user_id: a.id,
      provider: 'github',
      external_id: String(GH_A),
      external_login: 'harry',
    });

    h = await startHarness();
    h.stub.on('GET', '/repos/acme/shop', { body: { id: 1 } });
    h.stub.on('GET', '/repos/acme/shop/issues/comments', (req) => ({
      body: comments.filter((c) => Date.parse(c.updated_at) >= Date.parse(req.query.get('since')!)),
    }));
    h.stub.on('GET', '/repos/acme/shop/pulls', { body: [] });

    const gitHost = h.adapter();
    // The worker is typed against the built `@sdlc/core` and this test against its sources: the
    // same shapes, but two copies of the tenant ID brand, hence the two casts.
    const deps: PollerLoopDeps = {
      listProjects: async () =>
        (await db.app.system.listPollableProjects()) as unknown as Awaited<
          ReturnType<PollerLoopDeps['listProjects']>
        >,
      // Webhooks on: the reconciliation interval.
      intervalSeconds: () => Promise.resolve(RECONCILE_MS / 1000),
      poll: (group) =>
        pollRepository(
          {
            db: db.app,
            gitHost,
            registry,
            now: () => h.stub.now,
            intentSignals: {
              wake: (ref: IntentWorkflowRef) => {
                wakes.push({ intentId: ref.intentId, at: Date.now() });
                return Promise.resolve();
              },
              kill: () => Promise.resolve(),
            },
          },
          group as unknown as Parameters<typeof pollRepository>[1],
        ),
      now: () => Date.now() + offsetMs,
      logger: { log: () => undefined },
      maxConcurrentPolls: 2,
    };
    loop = new PollerLoop(deps);
    // The first poll (at start) only sets the cursor: no history.
    loop.start(60_000);
    await until(async () => {
      const rows = (
        await sql<{ n: number }>`SELECT count(*)::int AS n FROM git_event_cursors`.execute(db.owner)
      ).rows;
      return (rows[0]?.n ?? 0) > 0;
    });
    await loop.idle();
    listener = new HintListener({
      listen: (onHint) => db.app.listenGitHints(onHint),
      onHint: (one) => {
        loop.hint(one.repository);
      },
      onReconnect: () => {
        events.push('reconnect');
        loop.hintAll();
      },
      logger: { log: (_level, event) => events.push(event) },
    });
    listener.start();
    await until(() => events.includes('worker.hints_listening'));
  }, 60_000);

  afterAll(async () => {
    await listener?.stop();
    await loop?.stop();
    await h?.stub.stop();
    await db?.drop();
  });

  it('AC5: from the hint to the workflow signal in under 3 seconds', async () => {
    const intentId = await newIntent(3);
    post(3, '/approve G1');
    const start = Date.now();
    await hint();
    await until(() => wakes.some((w) => w.intentId === intentId), 3_000);
    const wake = wakes.find((w) => w.intentId === intentId)!;
    expect(wake.at - start).toBeLessThan(3_000);
    expect(await decisionsOf([intentId])).toEqual([intentId]);
  });

  it('AC3: a repeated hint (a replayed or duplicate delivery) changes nothing', async () => {
    const intentId = await newIntent(4);
    post(4, '/approve G1');
    await hint();
    await until(() => wakes.some((w) => w.intentId === intentId));
    await loop.idle();
    const before = wakes.length;
    const receipts = async (): Promise<number | undefined> =>
      (
        await sql<{ n: number }>`SELECT count(*)::int AS n FROM git_event_receipts`.execute(
          db.owner,
        )
      ).rows[0]?.n;
    const receiptsBefore = await receipts();
    await hint();
    await hint();
    await new Promise((r) => setTimeout(r, 300));
    await loop.idle();
    expect(await decisionsOf([intentId])).toEqual([intentId]);
    expect(await receipts()).toBe(receiptsBefore);
    // The extra polls found no new event, so nothing was woken again.
    expect(wakes.length).toBe(before);
  });

  it('AC5: events delivered out of order are applied in the cursor order', async () => {
    const early = await newIntent(5);
    const late = await newIntent(6);
    post(5, '/approve G1');
    post(6, '/approve G1');
    // The delivery of the later comment arrives first; one poll reads both, oldest first.
    await hint();
    await until(
      () => wakes.some((w) => w.intentId === early) && wakes.some((w) => w.intentId === late),
    );
    // Both decisions share the poll's transaction; the wakes follow the order of handling.
    expect(wakes.map((w) => w.intentId).filter((id) => id === early || id === late)).toEqual([
      early,
      late,
    ]);
    expect((await decisionsOf([early, late])).sort()).toEqual([early, late].sort());
  });

  it('AC5: during a webhook outage (no hints), the reconciliation poll applies the events', async () => {
    await loop.idle();
    const intentId = await newIntent(7);
    post(7, '/approve G1');
    await new Promise((r) => setTimeout(r, 200));
    expect(await decisionsOf([intentId])).toEqual([]);
    offsetMs += RECONCILE_MS + 1_000;
    await loop.tick();
    await loop.idle();
    expect(await decisionsOf([intentId])).toEqual([intentId]);
  });

  it('a lost LISTEN connection comes back, polls once, and takes hints again', async () => {
    // Ends the listener's connection, as a PostgreSQL restart would (superuser only).
    await tamper(
      db.name,
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = $1 AND application_name LIKE '%-hints'`,
      [db.name],
    );
    await until(() => events.includes('reconnect'), 10_000);
    expect(events).toContain('worker.hints_lost');
    const intentId = await newIntent(8);
    post(8, '/approve G1');
    await hint();
    await until(() => wakes.some((w) => w.intentId === intentId), 3_000);
  }, 20_000);
});
