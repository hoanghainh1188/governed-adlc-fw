// X08b PR 2 on a live PostgreSQL (design/ADR-M109 §2.3–§2.5, D-08 X08b AC1, AC3–AC5; QUESTIONS
// #729, #730): the lesson endpoints for the CLI. `POST /v1/intents/:intent/lessons` checks the
// comment address (the project's repository, the intent's issue or pull request) and that the
// comment exists, with a read token used once; apply and drop add outcomes; `GET /v1/lessons` and
// `GET /v1/metrics/lessons` count them; `from_lesson` links a follow-up intent; `has_lessons`
// filters intents. Codes, IDs and links only reach the database (R030). The Git host is a fake;
// the GitHub adapter is covered in `platform/tests/git-github/comment-id.test.ts`.
import { GitHubAdapter } from '@sdlc/adapter-git-github';
import {
  GitHostError,
  type IssueCommentText,
  type RedactedSecret,
  type RepoRef,
  type TokenScope,
} from '@sdlc/contracts';
import { Redacted } from '@sdlc/secrets';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

import { createApp, type ApiDeps } from '../../../apps/api/src/app.js';
import { issueApiToken } from '../../../packages/core/src/admin/tokens.js';
import { parseTenantId } from '../../../packages/core/src/db/tenant-id.js';
import type { TenantScope } from '../../../packages/core/src/db/tenant-scope.js';
import { tokenIssuedAt } from '../token-clock.js';
import { createTestDatabase, describeDb, tamper, type TestDatabase } from './helpers.js';

const NOW = new Date('2026-11-14T10:00:00.000Z');
const DAY = 86_400_000;
const pure = new GitHubAdapter({ secrets: { read: () => Promise.reject(new Error('unused')) } });

/** Comments by ID and the issue or pull request each is on; counts the tokens it gave out. */
class FakeLessonGitHost {
  comments = new Map<string, number>();
  down = false;
  issued: TokenScope[] = [];
  revoked = 0;
  readonly gitHost = {
    commentIdOf: (ref: RepoRef, url: string) => pure.commentIdOf(ref, url),
    issueShortLivedToken: (repo: RepoRef, scope: TokenScope) => {
      this.issued.push(scope);
      return Promise.resolve({
        token: new Redacted('ghs_fake'),
        expiresAt: NOW.toISOString(),
        repo,
        permissions: scope.permissions,
      });
    },
    getIssueComment: (
      _token: RedactedSecret,
      _ref: RepoRef,
      id: string,
    ): Promise<IssueCommentText> => {
      if (this.down) return Promise.reject(new GitHostError('network_error'));
      const issue = this.comments.get(id);
      if (issue === undefined) return Promise.reject(new GitHostError('not_found'));
      return Promise.resolve({
        commentId: id,
        issueNumber: issue,
        author: { id: '4001', login: 'a', type: 'user' },
        body: 'The agent assumed the old export format. canary-lesson-77',
      });
    },
    revokeShortLivedToken: () => {
      this.revoked += 1;
      return Promise.resolve();
    },
  };
}

const commentUrl = (issue: number, id: number, repo = 'acme/shop', kind = 'issues') =>
  `https://github.com/${repo}/${kind}/${String(issue)}#issuecomment-${String(id)}`;

describeDb('X08b PR 2: lessons through the API on PostgreSQL', () => {
  let db: TestDatabase;
  let scope: TenantScope;
  let git: FakeLessonGitHost;
  let app: Awaited<ReturnType<typeof createApp>>;
  const users = {} as Record<'a' | 'b' | 'gov' | 'admin' | 'outsider' | 'stranger', string>;
  const tokens = {} as Record<keyof typeof users, string>;
  let nextIssue = 100;
  let nextComment = 9000;

  beforeAll(async () => {
    db = await createTestDatabase();
    const tenant = await db.app.system.createTenant({ slug: 'internal', name: 'Internal' });
    scope = db.app.forTenant(parseTenantId(tenant.id));
    const project = await scope.projects.create({
      slug: 'shop',
      name: 'Shop',
      git_provider: 'github',
      repo_full_name: 'acme/shop',
    });
    // Another project: `outsider` holds Person A there and nothing on `shop`.
    const other = await scope.projects.create({
      slug: 'docs',
      name: 'Docs',
      git_provider: 'github',
      repo_full_name: 'acme/docs',
    });
    const roles = {
      a: ['person_a', project.id],
      b: ['person_b', project.id],
      gov: ['governance', project.id],
      admin: null,
      outsider: ['person_a', other.id],
      stranger: null,
    } as const;
    for (const key of Object.keys(roles) as (keyof typeof users)[]) {
      const user = await scope.users.create({ display_name: key, email: `${key}@example.com` });
      users[key] = user.id;
      const role = roles[key];
      if (role) {
        await scope.roleBindings.grant({ user_id: user.id, project_id: role[1], role: role[0] });
      }
      tokens[key] = (
        await issueApiToken(scope, { userId: user.id, name: key, now: tokenIssuedAt() })
      ).token;
    }
    await scope.tenantRoles.grant({ user_id: users.admin, role: 'tenant_admin' });
    git = new FakeLessonGitHost();
    app = await createApp({
      db: db.app as unknown as ApiDeps['db'],
      settings: { rateLimitPerMinute: 1000, authFailuresPerMinute: 1000 },
      now: () => NOW,
      lessonGitHost: git.gitHost,
    });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });

  beforeEach(() => {
    git.down = false;
  });

  const inject = async (
    method: 'GET' | 'POST',
    url: string,
    who: keyof typeof users,
    body?: unknown,
  ) => {
    const reply = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method,
        url,
        headers: { authorization: `Bearer ${tokens[who]}` },
        ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
      });
    return {
      status: reply.statusCode,
      body: reply.json<Record<string, unknown> & { error?: { code: string; reason?: string } }>(),
    };
  };

  /** An intent of `shop` with an issue, at G8 or finished some days ago. */
  async function intentAt(state: 'G8' | 'G3' | { closedDaysAgo: number }) {
    nextIssue += 1;
    const created = await inject('POST', '/v1/intents', 'a', {
      project: 'shop',
      title: 'Export orders',
      risk_tier: 'low',
      data_class: 'internal',
      issue_number: nextIssue,
    });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    if (state === 'G8' || state === 'G3') {
      await tamper(
        db.name,
        `UPDATE intents SET status = 'in_gate', current_gate = $1, gate_entered_at = now() WHERE id = $2`,
        [state, id],
      );
    } else {
      const closed = new Date(NOW.getTime() - state.closedDaysAgo * DAY);
      await tamper(
        db.name,
        `UPDATE intents SET status = 'done', current_gate = 'G8', gate_entered_at = NULL,
           updated_at = $1, closed_at = $1 WHERE id = $2`,
        [closed, id],
      );
    }
    return { id, code: created.body.code as string, issue: nextIssue };
  }

  /** A comment on that issue that exists on the fake Git host. */
  function comment(issue: number): string {
    nextComment += 1;
    git.comments.set(String(nextComment), issue);
    return commentUrl(issue, nextComment);
  }

  const add = (who: keyof typeof users, code: string, url: string, extra: object = {}) =>
    inject('POST', `/v1/intents/${code}/lessons`, who, {
      category: 'agent_assumption',
      target: 'agents_md',
      comment_url: url,
      ...extra,
    });

  it('Person A adds a lesson at G8: checked comment, one read token revoked, codes only', async () => {
    const intent = await intentAt('G8');
    const url = comment(intent.issue);
    const before = { issued: git.issued.length, revoked: git.revoked };
    const reply = await add('a', intent.code, url);
    expect(reply.status).toBe(201);
    expect(reply.body).toMatchObject({
      intent: intent.code,
      project: 'shop',
      category: 'agent_assumption',
      target: 'agents_md',
      source: 'api',
      comment_url: url,
      comment_id: String(nextComment),
      recorded_by: users.a,
      state: 'open',
      outcome: null,
    });
    expect(git.issued.slice(before.issued)).toEqual([
      { permissions: { issues: 'read', pull_requests: 'read' } },
    ]);
    expect(git.revoked).toBe(before.revoked + 1);
    const events = await scope.audit.listForEntity(intent.id, ['lesson.recorded']);
    expect(events.map((e) => e.payload)).toEqual([
      {
        lesson_id: reply.body.id,
        category: 'agent_assumption',
        target: 'agents_md',
        comment_id: String(nextComment),
        source: 'api',
      },
    ]);
    const stored = JSON.stringify([await scope.lessons.listForIntent(intent.id), events]);
    expect(stored).not.toMatch(/canary|export format/);
  });

  it('refuses a bad address, a missing comment, another issue and a duplicate', async () => {
    const intent = await intentAt('G8');
    const reason = async (url: string) => (await add('b', intent.code, url)).body.error?.reason;
    expect(await reason(commentUrl(intent.issue, 1, 'acme/other'))).toBe('comment_invalid');
    expect(await reason(`https://github.com/acme/shop/issues/${String(intent.issue)}`)).toBe(
      'comment_invalid',
    );
    expect(await reason(commentUrl(intent.issue, 424242))).toBe('comment_not_found');
    expect(await reason(comment(intent.issue + 5000))).toBe('comment_not_on_intent');
    const url = comment(intent.issue);
    expect((await add('b', intent.code, url)).status).toBe(201);
    const duplicate = await add('a', intent.code, url);
    expect([duplicate.status, duplicate.body.error?.code, duplicate.body.error?.reason]).toEqual([
      409,
      'lesson_refused',
      'duplicate',
    ]);
    git.down = true;
    const down = await add('a', intent.code, comment(intent.issue));
    expect([down.status, down.body.error?.code, down.body.error?.reason]).toEqual([
      503,
      'git_host_unavailable',
      'network_error',
    ]);
    expect(await scope.lessons.listForIntent(intent.id)).toHaveLength(1);
  });

  it('the window and the roles: G3 and an old close refused; governance 403; no role 404', async () => {
    const early = await intentAt('G3');
    const old = await intentAt({ closedDaysAgo: 20 });
    const recent = await intentAt({ closedDaysAgo: 3 });
    expect((await add('a', early.code, comment(early.issue))).body.error?.reason).toBe(
      'window_closed',
    );
    expect((await add('a', old.code, comment(old.issue))).body.error?.reason).toBe('window_closed');
    expect((await add('gov', recent.code, comment(recent.issue))).status).toBe(403);
    expect((await add('outsider', recent.code, comment(recent.issue))).status).toBe(404);
    expect((await add('stranger', recent.code, comment(recent.issue))).status).toBe(404);
    // A tenant admin may record on any project.
    expect((await add('admin', recent.code, comment(recent.issue))).status).toBe(201);
  });

  it('apply with a link, drop with a reason: the latest outcome is the state, audited', async () => {
    const intent = await intentAt('G8');
    const lesson = (await add('a', intent.code, comment(intent.issue))).body;
    const id = lesson.id as string;
    const link = 'https://github.com/acme/shop/pull/12';
    const applied = await inject('POST', `/v1/lessons/${id}/apply`, 'b', { link_url: link });
    expect(applied.status).toBe(200);
    expect(applied.body).toMatchObject({
      state: 'applied',
      outcome: { outcome: 'applied', link_url: link, reason: null, decided_by: users.b },
    });
    const dropped = await inject('POST', `/v1/lessons/${id}/drop`, 'a', { reason: 'duplicate' });
    expect(dropped.body).toMatchObject({ state: 'dropped', outcome: { reason: 'duplicate' } });
    expect((await inject('GET', `/v1/lessons/${id}`, 'b')).body.state).toBe('dropped');
    const events = await scope.audit.listForEntity(intent.id, ['lesson.applied', 'lesson.dropped']);
    expect(events.map((e) => [e.action, e.payload])).toEqual([
      ['lesson.applied', { lesson_id: id }],
      ['lesson.dropped', { lesson_id: id, reason: 'duplicate' }],
    ]);
    // Refusals: governance, an outsider, a bad reason, an http link, an unknown lesson.
    expect(
      (await inject('POST', `/v1/lessons/${id}/drop`, 'gov', { reason: 'other' })).status,
    ).toBe(403);
    expect(
      (await inject('POST', `/v1/lessons/${id}/drop`, 'outsider', { reason: 'other' })).status,
    ).toBe(404);
    expect((await inject('POST', `/v1/lessons/${id}/drop`, 'a', { reason: 'nope' })).status).toBe(
      400,
    );
    expect(
      (await inject('POST', `/v1/lessons/${id}/apply`, 'a', { link_url: 'http://x.example' }))
        .status,
    ).toBe(400);
    const unknown = await inject('GET', `/v1/lessons/${crypto.randomUUID()}`, 'a');
    expect([unknown.status, unknown.body.error?.code]).toEqual([404, 'lesson_not_found']);
  });

  it('from_lesson: a follow-up intent, recorded as applied; links show lessons and follow-ups', async () => {
    const intent = await intentAt('G8');
    const id = (await add('a', intent.code, comment(intent.issue))).body.id as string;
    const follow = await inject('POST', '/v1/intents', 'a', {
      project: 'shop',
      title: 'Fix the agent instructions',
      risk_tier: 'low',
      data_class: 'internal',
      from_lesson: id,
    });
    expect(follow.status).toBe(201);
    const lesson = (await inject('GET', `/v1/lessons/${id}`, 'a')).body;
    expect(lesson).toMatchObject({
      state: 'applied',
      outcome: { follow_up_intent_id: follow.body.id, link_url: null },
    });
    const events = await scope.audit.listForEntity(intent.id, ['lesson.applied']);
    expect(events.map((e) => e.payload)).toEqual([
      { lesson_id: id, follow_up_intent_id: follow.body.id },
    ]);
    const shown = (await inject('GET', `/v1/intents/${intent.code}`, 'b')).body as {
      links: { lessons: unknown[]; follow_ups: string[] };
    };
    expect(shown.links.lessons).toMatchObject([
      { id, category: 'agent_assumption', target: 'agents_md', state: 'applied' },
    ]);
    expect(JSON.stringify(shown.links.lessons)).toMatch(/#issuecomment-/);
    expect(shown.links.follow_ups).toEqual([follow.body.code]);
    // Governance never decides a lesson: refused before any intent is created.
    const before = (await inject('GET', '/v1/intents?project=shop&limit=100', 'a')).body
      .items as unknown[];
    const refused = await inject('POST', '/v1/intents', 'gov', {
      project: 'shop',
      title: 'x',
      risk_tier: 'low',
      data_class: 'internal',
      from_lesson: id,
    });
    expect(refused.status).toBe(403);
    const after = (await inject('GET', '/v1/intents?project=shop&limit=100', 'a')).body
      .items as unknown[];
    expect(after).toHaveLength(before.length);
  });

  it('has_lessons: at least one lesson, whatever its state (QUESTIONS #730)', async () => {
    const withLesson = await intentAt('G8');
    const lessonId = (await add('a', withLesson.code, comment(withLesson.issue))).body.id as string;
    await inject('POST', `/v1/lessons/${lessonId}/drop`, 'a', { reason: 'record_only' });
    const without = await intentAt('G8');
    const codes = async (flag: string) =>
      (
        (await inject('GET', `/v1/intents?project=shop&has_lessons=${flag}&limit=100`, 'a')).body
          .items as { code: string }[]
      ).map((i) => i.code);
    expect(await codes('true')).toContain(withLesson.code);
    expect(await codes('true')).not.toContain(without.code);
    expect(await codes('false')).toContain(without.code);
    expect(await codes('false')).not.toContain(withLesson.code);
    expect((await inject('GET', '/v1/intents?has_lessons=maybe', 'a')).status).toBe(400);
  });

  it('lists and counts the lessons of readable projects; open and since filters', async () => {
    const all = (await inject('GET', '/v1/lessons?project=shop', 'b')).body.items as {
      state: string;
      created_at: string;
    }[];
    expect(all.length).toBeGreaterThan(4);
    const open = (await inject('GET', '/v1/lessons?project=shop&open=true', 'b')).body.items as {
      state: string;
    }[];
    expect(open.every((l) => l.state === 'open')).toBe(true);
    expect(open.length).toBe(all.filter((l) => l.state === 'open').length);
    const future = await inject('GET', '/v1/lessons?since=2999-01-01', 'b');
    expect(future.body.items).toEqual([]);
    // The outsider holds no role on `shop`: no lesson of it, and the project is not found.
    expect((await inject('GET', '/v1/lessons', 'outsider')).body.items).toEqual([]);
    expect((await inject('GET', '/v1/lessons?project=shop', 'outsider')).status).toBe(404);

    const metrics = (await inject('GET', '/v1/metrics/lessons?project=shop', 'b')).body as {
      recorded: number;
      open: number;
      applied: number;
      dropped: number;
      by_category: Record<string, number>;
      by_target: Record<string, number>;
      median_days_to_outcome: number | null;
    };
    expect(metrics.recorded).toBe(all.length);
    expect(metrics.open + metrics.applied + metrics.dropped).toBe(all.length);
    expect(metrics.applied).toBe(all.filter((l) => l.state === 'applied').length);
    expect(metrics.by_category).toEqual({ agent_assumption: all.length });
    expect(metrics.by_target).toEqual({ agents_md: all.length });
    // Outcomes were recorded at once in this test: the median is about zero days.
    expect(metrics.median_days_to_outcome).toBe(0);
  });

  it('tenant isolation: another tenant sees none of these lessons', async () => {
    const second = await db.app.system.createTenant({ slug: 'other', name: 'Other' });
    const otherScope = db.app.forTenant(parseTenantId(second.id));
    await otherScope.projects.create({
      slug: 'shop',
      name: 'Shop',
      git_provider: 'github',
      repo_full_name: 'acme/shop',
    });
    const user = await otherScope.users.create({ display_name: 'x', email: 'x@example.com' });
    await otherScope.tenantRoles.grant({ user_id: user.id, role: 'tenant_admin' });
    const token = (
      await issueApiToken(otherScope, { userId: user.id, name: 'x', now: tokenIssuedAt() })
    ).token;
    const reply = await app
      .getHttpAdapter()
      .getInstance()
      .inject({ method: 'GET', url: '/v1/lessons', headers: { authorization: `Bearer ${token}` } });
    expect(reply.json()).toEqual({ items: [] });
    const anyLesson = (
      await scope.lessons.listForProjects([(await scope.projects.getBySlug('shop'))!.id])
    )[0]!;
    const show = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'GET',
        url: `/v1/lessons/${anyLesson.id}`,
        headers: { authorization: `Bearer ${token}` },
      });
    expect(show.statusCode).toBe(404);
  });
});
