// D-08 B06 on a live PostgreSQL, with the in-process GitHub stub (design/ADR-M27):
// AC1 polling: cursor and effects in one transaction, idempotent by event ID, crash safety,
//     concurrent pollers, replies at least once;
// AC2 the three comment commands record gate decisions with codes and the comment URL only;
// AC3 GitHub accounts map to users by numeric ID, bots never decide, roles are checked;
// AC4 bad syntax and missing permission get a reply from the message catalog.
import { createSimplePolicyEngine } from '@sdlc/adapter-policy-simple';
import {
  GATE_REASON_CODES,
  GitHostError,
  type GitEvent,
  type GitHostAdapter,
} from '@sdlc/contracts';
import { t } from '@sdlc/messages';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { handleGitEvent } from '../../../packages/core/src/commands/git-event-handler.js';
import { DbError } from '../../../packages/core/src/db/errors.js';
import type { Intent } from '../../../packages/core/src/db/schema.js';
import type { PollableProject } from '../../../packages/core/src/db/system-scope.js';
import { parseTenantId, type TenantId } from '../../../packages/core/src/db/tenant-id.js';
import type { TenantScope } from '../../../packages/core/src/db/tenant-scope.js';
import {
  pollProject,
  pollRepository,
  type PollableRepository,
  type PollDeps,
} from '../../../packages/core/src/git-events/poll-project.js';
import { Registry } from '../../../packages/core/src/registry/registry.js';
import { startHarness, type Harness } from '../../git-github/helpers.js';
import { comment, user } from '../../git-github/stub-github.js';
import { createTestDatabase, describeDb, tamper, type TestDatabase } from './helpers.js';

const policyFactory: ConstructorParameters<typeof Registry>[0]['policyFactory'] = (config) =>
  createSimplePolicyEngine({ config });

/** Numeric GitHub account IDs of the people (never the login, QUESTIONS #45). */
const GH = { a: 1001, b: 1002, viewer: 1003, outsider: 1004, disabled: 1005, otherTenant: 1006 };

type Person = keyof typeof GH;

/** Proxy helper: the adapter's own member, with methods bound to the adapter (private fields). */
function delegate(target: GitHostAdapter, prop: string | symbol, receiver: unknown): unknown {
  const value: unknown = Reflect.get(target, prop, receiver);
  return typeof value === 'function'
    ? (value as (...args: unknown[]) => unknown).bind(target)
    : value;
}

interface Seeded {
  readonly tenantId: TenantId;
  readonly scope: TenantScope;
  readonly target: PollableProject;
  readonly users: Record<Person, string>;
}

describeDb('B06: GitHub poller and comment commands on PostgreSQL', () => {
  let db: TestDatabase;
  let h: Harness;
  let seeded: Seeded;
  let registry: Registry;
  const comments: ReturnType<typeof comment>[] = [];
  let nextCommentId = 100;
  let clockSeconds = 10;

  /** A new comment, one second after the previous one. */
  function post(
    issue: number,
    body: string,
    author: ReturnType<typeof user> = user(GH.a, 'harry'),
    opts: { pull?: boolean } = {},
  ): number {
    const id = (nextCommentId += 1);
    clockSeconds += 1;
    const at = new Date(Date.parse('2026-09-26T08:00:00Z') + clockSeconds * 1000)
      .toISOString()
      .replace('.000Z', 'Z');
    comments.push(comment(id, issue, at, body, { ...opts, author }));
    return id;
  }

  const deps = (extra: Partial<PollDeps> = {}): PollDeps => ({
    db: db.app,
    gitHost: h.adapter(),
    registry,
    now: () => h.stub.now,
    ...extra,
  });

  const poll = (extra: Partial<PollDeps> = {}) => pollProject(deps(extra), seeded.target);

  async function decisions(): Promise<Record<string, unknown>[]> {
    return (
      await sql<
        Record<string, unknown>
      >`SELECT * FROM gate_decisions ORDER BY created_at, id`.execute(db.owner)
    ).rows;
  }

  async function receipt(commentId: number): Promise<Record<string, unknown> | undefined> {
    return (
      await sql<Record<string, unknown>>`SELECT * FROM git_event_receipts
        WHERE event_id = ${`github:comment:${String(commentId)}`}`.execute(db.owner)
    ).rows[0];
  }

  const replies = (issue: number): string[] =>
    h.stub
      .requestsTo('POST', `/repos/acme/shop/issues/${String(issue)}/comments`)
      .map((r) => (r.body as { body: string }).body);

  /**
   * A new intent waiting at `gate`. B07: a decision counts only at the intent's current gate; the
   * workflow does not run in these tests, so the intent is moved there directly.
   */
  async function newIntent(issue: number, gate: 'G1' | 'G2' | 'G3' = 'G1'): Promise<Intent> {
    const intent = await registry.createIntent(seeded.scope, {
      projectId: seeded.target.projectId,
      title: `Intent on issue ${String(issue)}`,
      createdBy: seeded.users.a,
      riskTier: 'low',
      dataClass: 'internal',
      issueNumber: issue,
    });
    return seeded.scope.intents.updateState(intent.id, {
      status: 'in_gate',
      currentGate: gate,
      actorType: 'system',
      actorId: null,
    });
  }

  beforeAll(async () => {
    db = await createTestDatabase();
    registry = new Registry({ policyFactory, now: () => new Date('2026-09-26T08:00:00Z') });

    const tenant = await db.app.system.createTenant({ slug: 'internal', name: 'Internal' });
    const tenantId = parseTenantId(tenant.id);
    const scope = db.app.forTenant(tenantId);
    const project = await scope.projects.create({
      slug: 'shop',
      name: 'Shop',
      git_provider: 'github',
      repo_full_name: 'acme/shop',
    });
    const roles: Record<Person, 'person_a' | 'person_b' | 'viewer' | null> = {
      a: 'person_a',
      b: 'person_b',
      viewer: 'viewer',
      outsider: null,
      disabled: 'person_a',
      otherTenant: 'person_a',
    };
    const users = {} as Record<Person, string>;
    for (const [person, role] of Object.entries(roles) as [Person, (typeof roles)[Person]][]) {
      if (person === 'otherTenant') continue;
      const created = await scope.users.create({
        display_name: person,
        email: `${person}@example.com`,
      });
      users[person] = created.id;
      if (role)
        await scope.roleBindings.grant({ user_id: created.id, project_id: project.id, role });
      await scope.userIdentities.link({
        user_id: created.id,
        provider: 'github',
        external_id: String(GH[person]),
        external_login: person,
      });
    }
    await scope.users.setStatus(users.disabled, 'disabled');

    // Another tenant links the account 1006; tenant "internal" does not know it.
    const other = await db.app.system.createTenant({ slug: 'other', name: 'Other' });
    const otherScope = db.app.forTenant(parseTenantId(other.id));
    const otherUser = await otherScope.users.create({ display_name: 'x', email: 'x@example.com' });
    await otherScope.userIdentities.link({
      user_id: otherUser.id,
      provider: 'github',
      external_id: String(GH.otherTenant),
      external_login: 'x',
    });
    users.otherTenant = otherUser.id;

    seeded = {
      tenantId,
      scope,
      users,
      target: { tenantId, projectId: project.id, repoFullName: 'acme/shop' },
    };

    h = await startHarness();
    h.stub.on('GET', '/repos/acme/shop', { body: { id: 1 } });
    h.stub.on('GET', '/repos/acme/shop/issues/comments', (req) => ({
      body: comments.filter((c) => Date.parse(c.updated_at) >= Date.parse(req.query.get('since')!)),
    }));
    h.stub.on('GET', '/repos/acme/shop/pulls', { body: [] });
    for (const issue of [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 99]) {
      h.stub.on('POST', `/repos/acme/shop/issues/${String(issue)}/comments`, {
        status: 201,
        body: { id: 1 },
      });
    }
    // First poll: no history (INITIAL_EVENT_CURSOR).
    post(3, '/approve G1');
    expect((await poll()).events).toBe(0);
    comments.length = 0;
  }, 60_000);

  afterAll(async () => {
    await h?.stub.stop();
    await db?.drop();
  });

  describe('listPollableProjects (system scope)', () => {
    it('returns IDs and the repository name only, of active GitHub projects of active tenants', async () => {
      const extra = await seeded.scope.projects.create({
        slug: 'gl',
        name: 'GitLab project',
        git_provider: 'gitlab',
        repo_full_name: 'acme/gl',
      });
      const archived = await seeded.scope.projects.create({
        slug: 'old',
        name: 'Old',
        git_provider: 'github',
        repo_full_name: 'acme/old',
      });
      await tamper(db.name, `UPDATE projects SET status = 'archived' WHERE id = $1`, [archived.id]);
      const suspended = await db.app.system.createTenant({ slug: 'gone', name: 'Gone' });
      await db.app.forTenant(parseTenantId(suspended.id)).projects.create({
        slug: 'x',
        name: 'X',
        git_provider: 'github',
        repo_full_name: 'acme/x',
      });
      await tamper(db.name, `UPDATE tenants SET status = 'suspended' WHERE id = $1`, [
        suspended.id,
      ]);

      const listed = await db.app.system.listPollableProjects();
      expect(listed).toEqual([seeded.target]);
      for (const row of listed) {
        expect(Object.keys(row).sort()).toEqual(['projectId', 'repoFullName', 'tenantId']);
      }
      expect(listed.map((p) => p.projectId)).not.toContain(extra.id);
    });
  });

  describe('AC2: comment commands record gate decisions', () => {
    it('/approve G1 records an approval with the comment URL and no reply', async () => {
      const intent = await newIntent(3);
      const id = post(3, '/approve G1\n\nScope and risk look right.');
      const result = await poll();
      expect(result).toMatchObject({ status: 'polled', outcomes: { decided: 1 } });
      const [decision] = await decisions();
      expect(decision).toMatchObject({
        intent_id: intent.id,
        gate: 'G1',
        decision: 'approve',
        decided_by: seeded.users.a,
        approver_role: 'person_a',
        source: 'github_comment',
        event_source: 'polling',
        reason_code: null,
        reason_ref: `https://github.com/acme/shop/issues/3#issuecomment-${String(id)}`,
      });
      expect(await receipt(id)).toMatchObject({
        outcome: 'decided',
        gate_decision_id: decision!.id,
        reply_code: null,
      });
      expect(replies(3)).toEqual([]);
    });

    it('/reject and /request-changes store the reason code and a link, never the reason text', async () => {
      await newIntent(4);
      await newIntent(5);
      const rejected = post(4, '/reject G1 spec-unclear AC2 does not say which warehouse');
      const changed = post(5, '/request-changes G1\nPlease narrow the scope to one screen.');
      await poll();
      const rows = await decisions();
      expect(rows.find((r) => r.decision === 'reject')).toMatchObject({
        reason_code: 'spec_unclear',
        reason_ref: `https://github.com/acme/shop/issues/4#issuecomment-${String(rejected)}`,
      });
      expect(rows.find((r) => r.decision === 'request_changes')).toMatchObject({
        reason_code: 'other',
        reason_ref: `https://github.com/acme/shop/issues/5#issuecomment-${String(changed)}`,
      });
    });
  });

  describe('AC3: accounts, bots, roles', () => {
    beforeEach(() => {
      comments.length = 0;
    });

    it('maps by numeric account ID: a renamed login still decides, the same login with another ID does not', async () => {
      await newIntent(6);
      const renamed = post(6, '/request-changes G1 other see issue', user(GH.a, 'harry-renamed'));
      const impostor = post(6, '/approve G1', user(9999, 'a'));
      await poll();
      expect(await receipt(renamed)).toMatchObject({ outcome: 'decided' });
      expect(await receipt(impostor)).toMatchObject({
        outcome: 'user_not_linked',
        reply_code: 'user_not_linked',
      });
    });

    it('ignores bots, even with the numeric ID of a person, and never replies to them', async () => {
      await newIntent(7);
      const before = (await decisions()).length;
      const bot = post(7, '/approve G1', user(GH.a, 'sdlc-bot[bot]', 'Bot'));
      await poll();
      expect(await receipt(bot)).toMatchObject({ outcome: 'ignored_bot', reply_code: null });
      expect((await decisions()).length).toBe(before);
      expect(replies(7)).toEqual([]);
    });

    it('refuses the wrong role, the viewer, a person without role, a disabled user and another tenant', async () => {
      await newIntent(8);
      const byB = post(8, '/approve G1', user(GH.b, 'b'));
      const byViewer = post(8, '/approve G1', user(GH.viewer, 'viewer'));
      const byOutsider = post(8, '/approve G1', user(GH.outsider, 'outsider'));
      const byDisabled = post(8, '/approve G1', user(GH.disabled, 'disabled'));
      const byOtherTenant = post(8, '/approve G1', user(GH.otherTenant, 'x'));
      const before = (await decisions()).length;
      await poll();
      expect((await decisions()).length).toBe(before);
      expect(await receipt(byB)).toMatchObject({
        outcome: 'refused',
        reply_params: { gate: 'G1', reason: 'role_missing' },
      });
      expect(await receipt(byViewer)).toMatchObject({
        outcome: 'refused',
        reply_params: { gate: 'G1', reason: 'role_missing' },
      });
      expect(await receipt(byOutsider)).toMatchObject({
        outcome: 'refused',
        reply_code: 'intent_not_found',
      });
      expect(await receipt(byDisabled)).toMatchObject({ outcome: 'user_not_linked' });
      expect(await receipt(byOtherTenant)).toMatchObject({ outcome: 'user_not_linked' });
      const texts = replies(8);
      expect(texts).toHaveLength(5);
      expect(texts[0]).toContain(t('gate.reason.role_missing'));
    });

    it('the same person cannot approve the same gate twice', async () => {
      const intent = await newIntent(9);
      post(9, '/approve G1');
      const again = post(9, '/approve G1');
      await poll();
      expect(await receipt(again)).toMatchObject({ outcome: 'refused' });
      expect((await decisions()).filter((d) => d.intent_id === intent.id)).toHaveLength(1);
    });
  });

  describe('AC4: replies from the message catalog', () => {
    beforeEach(() => {
      comments.length = 0;
    });

    it('answers bad syntax with the syntax and the valid reason codes; stores no text', async () => {
      await newIntent(10);
      const id = post(10, '/reject G1');
      await poll();
      expect(await receipt(id)).toMatchObject({
        outcome: 'syntax_error',
        reply_code: 'syntax_reason_missing',
        reply_params: {},
      });
      const [text] = replies(10);
      expect(text).toContain(t('comment.reply.syntax_reason_missing'));
      for (const code of GATE_REASON_CODES) expect(text).toContain(code);
    });

    it('answers unlinked, not-current gates and missing input; stays silent on other comments', async () => {
      await newIntent(12);
      // QUESTIONS #68 option A (B07): a second open intent on the same issue is refused, so a
      // comment always names exactly one intent.
      await expect(newIntent(12)).rejects.toMatchObject({ code: 'issue_already_linked' });
      await newIntent(13, 'G2');
      const unlinked = post(99, '/approve G1');
      const onPull = post(11, '/approve G1', user(GH.a, 'harry'), { pull: true });
      // E03: every gate G1–G8 is decided by a command now; G8 only when the intent waits there.
      const unsupported = post(13, '/approve G8');
      const noSpec = post(13, '/approve G2');
      const notCurrent = post(13, '/approve G3');
      const chat = post(13, 'LGTM, will /approve G1 after lunch');
      await poll();
      expect(await receipt(unlinked)).toMatchObject({ reply_code: 'intent_not_linked' });
      // A pull request comment matches `pr_number`, not `issue_number`.
      expect(await receipt(onPull)).toMatchObject({ reply_code: 'intent_not_linked' });
      expect(await receipt(unsupported)).toMatchObject({ reply_code: 'gate_not_current' });
      expect(await receipt(noSpec)).toMatchObject({ reply_code: 'gate_input_missing' });
      expect(await receipt(notCurrent)).toMatchObject({ reply_code: 'gate_not_current' });
      expect(await receipt(chat)).toBeUndefined();
      expect(replies(13)).toEqual([
        expect.stringContaining(t('comment.reply.gate_not_current', { gate: 'G8' })),
        expect.stringContaining(t('comment.reply.gate_input_missing', { gate: 'G2' })),
        expect.stringContaining(t('comment.reply.gate_not_current', { gate: 'G3' })),
      ]);
    });
  });

  describe('AC1: one transaction, idempotent, crash safe', () => {
    beforeEach(() => {
      comments.length = 0;
    });

    it('a crash before the commit applies nothing; the next poll applies the event exactly once', async () => {
      class CrashingRegistry extends Registry {
        override async decide(
          ...args: Parameters<Registry['decide']>
        ): ReturnType<Registry['decide']> {
          await super.decide(...args);
          throw new Error('process crashed');
        }
      }
      await newIntent(14);
      const cursorBefore = await seeded.scope.gitEventCursors.get(seeded.target.projectId);
      const id = post(14, '/approve G1');
      const before = (await decisions()).length;
      await expect(poll({ registry: new CrashingRegistry({ policyFactory }) })).rejects.toThrow(
        'process crashed',
      );
      expect((await decisions()).length).toBe(before);
      // The attempt is counted outside the rolled-back batch; nothing else is recorded.
      expect(await receipt(id)).toMatchObject({
        outcome: 'failing',
        event_attempts: 1,
        gate_decision_id: null,
        reply_code: null,
      });
      expect((await seeded.scope.gitEventCursors.get(seeded.target.projectId))?.cursor).toBe(
        cursorBefore?.cursor,
      );
      await poll();
      await poll();
      expect((await decisions()).length).toBe(before + 1);
      expect(await receipt(id)).toMatchObject({ outcome: 'decided', event_attempts: 1 });
      expect(replies(14)).toEqual([]);
    });

    it('a poison event is retried N times across restarts, then given up with one reply; the rest is applied', async () => {
      const poisonIntent = await newIntent(17);
      const goodIntent = await newIntent(18);
      /** A programming error for one intent only; a new instance per poll, as after a restart. */
      class BuggyRegistry extends Registry {
        override async decide(
          ...args: Parameters<Registry['decide']>
        ): ReturnType<Registry['decide']> {
          if (args[1].intentId === poisonIntent.id) throw new TypeError('bug in the handler');
          return super.decide(...args);
        }
      }
      const logs: { level: string; event: string; fields: Record<string, unknown> }[] = [];
      const pollBuggy = () =>
        poll({
          registry: new BuggyRegistry({ policyFactory }),
          maxEventAttempts: 3,
          logger: {
            log: (level, event, fields) => logs.push({ level, event, fields: { ...fields } }),
          },
        });
      const poison = post(17, '/approve G1');
      const good = post(18, '/approve G1');

      for (const attempt of [1, 2]) {
        await expect(pollBuggy()).rejects.toThrow(TypeError);
        expect(await receipt(poison)).toMatchObject({
          outcome: 'failing',
          event_attempts: attempt,
        });
        expect(await receipt(good)).toBeUndefined(); // rolled back with the batch
      }
      const third = await pollBuggy();
      expect(third).toMatchObject({
        status: 'polled',
        outcomes: { failed_internal: 1, decided: 1 },
      });
      expect(await receipt(poison)).toMatchObject({
        outcome: 'failed_internal',
        event_attempts: 3,
        gate_decision_id: null,
        reply_code: 'failed',
        reply_params: { gate: 'G1' },
      });
      expect(await receipt(good)).toMatchObject({ outcome: 'decided' });
      const rows = await decisions();
      expect(rows.filter((d) => d.intent_id === poisonIntent.id)).toEqual([]);
      expect(rows.filter((d) => d.intent_id === goodIntent.id)).toHaveLength(1);

      const failedLog = logs.find((l) => l.event === 'worker.event_failed');
      expect(failedLog).toMatchObject({
        level: 'error',
        fields: { event_id: `github:comment:${String(poison)}`, attempts: 3, error: 'TypeError' },
      });
      expect(JSON.stringify(logs)).not.toContain('bug in the handler');

      // Later batches are applied, the given-up event is skipped, and the reply is posted once.
      const later = post(18, '/request-changes G1 tests_insufficient');
      await pollBuggy();
      await pollBuggy();
      expect(await receipt(later)).toMatchObject({ outcome: 'decided' });
      expect(await receipt(poison)).toMatchObject({ event_attempts: 3 });
      expect(replies(17)).toEqual([
        expect.stringContaining(t('comment.reply.failed', { gate: 'G1' })),
      ]);
    });

    it('a value the database refuses is answered "failed"; it never blocks the later events', async () => {
      class RefusingRegistry extends Registry {
        override async decide(
          ...args: Parameters<Registry['decide']>
        ): ReturnType<Registry['decide']> {
          if (args[1].decision === 'reject') throw new DbError('conflict', 'duplicate');
          return super.decide(...args);
        }
      }
      const intent = await newIntent(16);
      const refused = post(16, '/reject G1 spec_unclear');
      const approved = post(16, '/approve G1');
      const result = await poll({ registry: new RefusingRegistry({ policyFactory }) });
      expect(result).toMatchObject({ status: 'polled', outcomes: { failed: 1, decided: 1 } });
      expect(await receipt(refused)).toMatchObject({ outcome: 'failed', reply_code: 'failed' });
      expect(await receipt(approved)).toMatchObject({ outcome: 'decided' });
      expect((await decisions()).filter((d) => d.intent_id === intent.id)).toHaveLength(1);
      expect(replies(16)).toEqual([
        expect.stringContaining(t('comment.reply.failed', { gate: 'G1' })),
      ]);
    });

    it('an event handled twice (overlap window, webhook later) is skipped by its receipt', async () => {
      const id = post(14, '/reject G1');
      await poll();
      const replay: GitEvent = {
        kind: 'comment_created',
        id: `github:comment:${String(id)}`,
        source: 'webhook',
        repo: { owner: 'acme', name: 'shop' },
        occurredAt: '2026-09-26T08:10:00Z',
        url: `https://github.com/acme/shop/issues/14#issuecomment-${String(id)}`,
        issueNumber: 14,
        isPullRequest: false,
        commentId: String(id),
        author: { id: String(GH.a), login: 'harry', type: 'user' },
        body: '/reject G1',
      };
      const handled = await handleGitEvent(
        seeded.scope,
        { registry, now: () => registry.now() },
        { id: seeded.target.projectId, provider: 'github' },
        replay,
      );
      expect(handled).toEqual({ outcome: 'duplicate' });
    });

    it('two pollers with the same cursor: one applies the batch, the other rolls back', async () => {
      await newIntent(15);
      const id = post(15, '/approve G1');
      let arrived = 0;
      let open!: () => void;
      const gate = new Promise<void>((resolve) => (open = resolve));
      const barrier = (adapter: GitHostAdapter): GitHostAdapter =>
        new Proxy(adapter, {
          get(target, prop, receiver) {
            if (prop === 'listEventsSince') {
              return async (...args: Parameters<GitHostAdapter['listEventsSince']>) => {
                const result = await target.listEventsSince(...args);
                arrived += 1;
                if (arrived === 2) open();
                await gate;
                return result;
              };
            }
            return delegate(target, prop, receiver);
          },
        });
      const before = (await decisions()).length;
      const results = await Promise.all([
        poll({ gitHost: barrier(h.adapter()) }),
        poll({ gitHost: barrier(h.adapter()) }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual(['cursor_moved', 'polled']);
      expect((await decisions()).length).toBe(before + 1);
      expect(await receipt(id)).toMatchObject({ outcome: 'decided' });
    });

    it('replies are posted at least once after the commit, then never again; given up after the limit', async () => {
      const failing = (adapter: GitHostAdapter, failures: { left: number }): GitHostAdapter =>
        new Proxy(adapter, {
          get(target, prop, receiver) {
            if (prop === 'createIssueComment' && failures.left > 0) {
              return () => {
                failures.left -= 1;
                return Promise.reject(new GitHostError('network_error'));
              };
            }
            return delegate(target, prop, receiver);
          },
        });
      const posted = replies(14).length;
      const id = post(14, '/approve G9');
      const first = await poll({ gitHost: failing(h.adapter(), { left: 1 }) });
      expect(first).toMatchObject({ outcomes: { syntax_error: 1 }, repliesFailed: 1 });
      expect(await receipt(id)).toMatchObject({ reply_attempts: 1, reply_posted_at: null });
      expect(replies(14)).toHaveLength(posted);
      await poll();
      await poll();
      expect(replies(14)).toHaveLength(posted + 1);
      expect(await receipt(id)).toMatchObject({ reply_attempts: 2 });

      const abandoned = post(14, '/approve');
      await poll({ gitHost: failing(h.adapter(), { left: 10 }), maxReplyAttempts: 2 });
      await poll({ gitHost: failing(h.adapter(), { left: 10 }), maxReplyAttempts: 2 });
      expect(await receipt(abandoned)).toMatchObject({ reply_attempts: 2 });
      expect((await receipt(abandoned))?.reply_abandoned_at).toBeInstanceOf(Date);
      await poll();
      expect(replies(14)).toHaveLength(posted + 1);
    });
  });

  describe('reply bookkeeping', () => {
    it('never reopens a reply another poller already delivered', async () => {
      const [row] = (
        await sql<{ id: string; reply_attempts: number }>`SELECT id, reply_attempts
          FROM git_event_receipts WHERE reply_posted_at IS NOT NULL LIMIT 1`.execute(db.owner)
      ).rows;
      const at = new Date('2026-09-26T09:00:00Z');
      const receipts = seeded.scope.gitEventReceipts;
      expect(await receipts.markReplyPosted(row!.id, row!.reply_attempts + 1, at)).toBe(false);
      expect(await receipts.markReplyFailed(row!.id, row!.reply_attempts + 1, at)).toBe(false);
    });
  });

  describe('storage rules', () => {
    it('keeps no comment text in any table', async () => {
      const dump = JSON.stringify(
        await Promise.all(
          ['git_event_receipts', 'gate_decisions', 'audit_log', 'git_event_cursors'].map(
            async (table) => (await sql`SELECT * FROM ${sql.table(table)}`.execute(db.owner)).rows,
          ),
        ),
      );
      for (const text of ['warehouse', 'narrow the scope', 'Scope and risk', 'after lunch']) {
        expect(dump).not.toContain(text);
      }
    });

    it('platform_app cannot delete receipts, change a final result or reopen a delivered reply', async () => {
      const [row] = (
        await sql<{ id: string }>`SELECT id FROM git_event_receipts
          WHERE reply_posted_at IS NOT NULL LIMIT 1`.execute(db.owner)
      ).rows;
      await expect(
        sql`DELETE FROM git_event_receipts WHERE id = ${row!.id}`.execute(db.appRaw),
      ).rejects.toThrow(/permission denied/);
      await expect(
        sql`UPDATE git_event_receipts SET event_id = 'github:comment:1' WHERE id = ${row!.id}`.execute(
          db.appRaw,
        ),
      ).rejects.toThrow(/permission denied/);
      // The result of a receipt is fixed once it is no longer `failing`.
      for (const change of [
        sql`outcome = 'decided'`,
        sql`reply_code = 'forbidden'`,
        sql`event_attempts = event_attempts + 1`,
      ]) {
        await expect(
          sql`UPDATE git_event_receipts SET ${change} WHERE id = ${row!.id}`.execute(db.appRaw),
        ).rejects.toThrow(/final/);
      }
      await expect(
        sql`UPDATE git_event_receipts SET reply_attempts = 50 WHERE id = ${row!.id}`.execute(
          db.appRaw,
        ),
      ).rejects.toThrow(/final/);
    });

    it('a given-up event can never get a gate decision; a failing receipt holds no result', async () => {
      const [row] = (
        await sql<{ id: string }>`SELECT id FROM gate_decisions LIMIT 1`.execute(db.owner)
      ).rows;
      const insert = (outcome: string, extra: string) =>
        sql`INSERT INTO git_event_receipts
              (tenant_id, project_id, event_id, outcome, issue_number, gate_decision_id, reply_code, reply_params)
            VALUES (${seeded.tenantId}, ${seeded.target.projectId}, ${`github:comment:${extra}`},
                    ${outcome}, 3, ${row!.id}, NULL, NULL)`.execute(db.appRaw);
      await expect(insert('failed_internal', '901')).rejects.toThrow(/check/);
      await expect(insert('failing', '902')).rejects.toThrow(/check/);
    });

    it('the database refuses free text in reply parameters and event IDs', async () => {
      const insert = (eventId: string, params: string) =>
        sql`INSERT INTO git_event_receipts
              (tenant_id, project_id, event_id, outcome, issue_number, reply_code, reply_params)
            VALUES (${seeded.tenantId}, ${seeded.target.projectId}, ${eventId}, 'refused', 3,
                    'failed', ${params}::jsonb)`.execute(db.appRaw);
      await expect(insert('github:comment:777', '{"gate":"G1 please"}')).rejects.toThrow(/check/);
      await expect(insert('github:comment:778', '{"gate":"alice@example.com"}')).rejects.toThrow(
        /check/,
      );
      await expect(insert('some text', '{}')).rejects.toThrow(/check/);
    });
  });

  describe('O06 PR 2c: one poll per repository (ADR-M106 §2.4, QUESTIONS #679)', () => {
    let group: PollableRepository;
    let second: string;

    const pollGroup = () => pollRepository(deps(), group);

    const commentReads = (): number =>
      h.stub.requestsTo('GET', '/repos/acme/shop/issues/comments').length;

    async function receiptProjects(commentId: number): Promise<string[]> {
      return (
        await sql<{ project_id: string }>`SELECT project_id FROM git_event_receipts
          WHERE event_id = ${`github:comment:${String(commentId)}`}`.execute(db.owner)
      ).rows.map((r) => r.project_id);
    }

    async function intentIn(projectId: string, issue: number): Promise<Intent> {
      const intent = await registry.createIntent(seeded.scope, {
        projectId,
        title: `Intent on issue ${String(issue)}`,
        createdBy: seeded.users.a,
        riskTier: 'low',
        dataClass: 'internal',
        issueNumber: issue,
      });
      return seeded.scope.intents.updateState(intent.id, {
        status: 'in_gate',
        currentGate: 'G1',
        actorType: 'system',
        actorId: null,
      });
    }

    beforeAll(async () => {
      // Two packages of one repository: each project has its folder (migration 0049).
      await seeded.scope.projects.update(seeded.target.projectId, { repo_path: 'apps/shop' });
      const admin = await seeded.scope.projects.create({
        slug: 'admin',
        name: 'Admin',
        git_provider: 'github',
        repo_full_name: 'acme/shop',
        repo_path: 'apps/admin',
      });
      second = admin.id;
      await seeded.scope.roleBindings.grant({
        user_id: seeded.users.a,
        project_id: second,
        role: 'person_a',
      });
      for (const issue of [20, 21, 22, 23, 24]) {
        h.stub.on('POST', `/repos/acme/shop/issues/${String(issue)}/comments`, {
          status: 201,
          body: { id: 1 },
        });
      }
      group = {
        tenantId: seeded.tenantId,
        repoFullName: 'acme/shop',
        projectIds: [seeded.target.projectId, second],
      };
      // The new project was never polled: the group reads from the first project's cursor.
      comments.length = 0;
      await pollGroup();
    });

    it('the worker lists both projects; one read of GitHub serves the group', async () => {
      const listed = await db.app.system.listPollableProjects();
      expect(listed.map((p) => p.projectId).sort()).toEqual([...group.projectIds].sort());
      const before = commentReads();
      const result = await pollGroup();
      expect(commentReads() - before).toBe(1);
      expect(result.projects.map((p) => p.result.status)).toEqual(['polled', 'polled']);
      const cursors = await Promise.all(
        group.projectIds.map((id) => seeded.scope.gitEventCursors.get(id)),
      );
      expect(cursors[0]?.cursor).toBe(cursors[1]?.cursor);
    });

    it('a command goes to the project whose intent has the issue', async () => {
      const intent = await intentIn(second, 20);
      const id = post(20, '/approve G1');
      const result = await pollGroup();
      expect(result.projects.find((p) => p.projectId === second)?.result.outcomes).toEqual({
        decided: 1,
      });
      expect(
        result.projects.find((p) => p.projectId === seeded.target.projectId)?.result.outcomes,
      ).toEqual({});
      expect((await decisions()).filter((d) => d.intent_id === intent.id)).toHaveLength(1);
      expect(await receiptProjects(id)).toEqual([second]);
      expect(replies(20)).toEqual([]);
    });

    it('a command no project knows is answered once, by the first project of the group', async () => {
      const id = post(21, '/approve G1');
      await pollGroup();
      const lead = [...group.projectIds].sort()[0]!;
      expect(await receiptProjects(id)).toEqual([lead]);
      expect(replies(21)).toEqual([
        expect.stringContaining(t('comment.reply.intent_not_linked', { gate: 'G1' })),
      ]);
    });

    it('open intents of two projects on one issue: intent_ambiguous, no decision', async () => {
      const first = await intentIn(seeded.target.projectId, 22);
      const other = await intentIn(second, 22);
      const id = post(22, '/approve G1');
      await pollGroup();
      expect(await receiptProjects(id)).toHaveLength(1);
      expect(
        (await decisions()).filter((d) => d.intent_id === first.id || d.intent_id === other.id),
      ).toEqual([]);
      expect(replies(22)).toEqual([
        expect.stringContaining(t('comment.reply.intent_ambiguous', { gate: 'G1' })),
      ]);
    });

    it('reads from the oldest cursor: a project left behind misses nothing, the other skips by receipt', async () => {
      const intent = await intentIn(seeded.target.projectId, 23);
      const behind = (await seeded.scope.gitEventCursors.get(seeded.target.projectId))!.cursor;
      const late = await intentIn(second, 24);
      const early = post(24, '/approve G1');
      await pollGroup();
      // The first project's cursor goes back, as after a failed batch.
      await tamper(db.name, `UPDATE git_event_cursors SET cursor = $1 WHERE project_id = $2`, [
        behind,
        seeded.target.projectId,
      ]);
      const id = post(23, '/approve G1');
      const before = commentReads();
      const result = await pollGroup();
      expect(commentReads() - before).toBe(1);
      expect((await decisions()).filter((d) => d.intent_id === intent.id)).toHaveLength(1);
      // The earlier comment came again to the second project: its receipt makes it a duplicate.
      expect(result.projects.find((p) => p.projectId === second)?.result.outcomes).toEqual({
        duplicate: 1,
      });
      expect((await decisions()).filter((d) => d.intent_id === late.id)).toHaveLength(1);
      expect(await receiptProjects(early)).toEqual([second]);
      expect(await receiptProjects(id)).toEqual([seeded.target.projectId]);
    });
  });
});
