// H08 PR 3a on a live PostgreSQL (design/ADR-M111 §2.4, §2.9, D-08 H08 AC2; QUESTIONS #742): the
// break-glass endpoints for `adlc break-glass`. Each action has a person as its actor (a personal
// token); Person A or B requests, governance or Person B approves, never the requester or a
// producer; revoke at once; the review closes the incident; the list shows only readable projects.
// Refusals map to stable codes. The Git host is a fake.
import { GitHubAdapter } from '@sdlc/adapter-git-github';
import {
  GitHostError,
  type IssueCommentText,
  type RedactedSecret,
  type RepoRef,
  type TokenScope,
} from '@sdlc/contracts';
import { Redacted } from '@sdlc/secrets';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

import { createApp, type ApiDeps } from '../../../apps/api/src/app.js';
import { SQL_BREAK_GLASS } from '../../../deploy/doctor/src/commands.js';
import { parseBreakGlass } from '../../../deploy/doctor/src/host.js';
import { issueApiToken } from '../../../packages/core/src/admin/tokens.js';
import { parseTenantId } from '../../../packages/core/src/db/tenant-id.js';
import type { TenantScope } from '../../../packages/core/src/db/tenant-scope.js';
import { tokenIssuedAt } from '../token-clock.js';
import { createTestDatabase, describeDb, type TestDatabase } from './helpers.js';

const NOW = new Date('2026-11-15T03:00:00.000Z');
const pure = new GitHubAdapter({ secrets: { read: () => Promise.reject(new Error('unused')) } });

class FakeGitHost {
  comments = new Map<string, number>();
  down = false;
  readonly gitHost = {
    commentIdOf: (ref: RepoRef, url: string) => pure.commentIdOf(ref, url),
    issueShortLivedToken: (repo: RepoRef, scope: TokenScope) =>
      Promise.resolve({
        token: new Redacted('ghs_fake'),
        expiresAt: NOW.toISOString(),
        repo,
        permissions: scope.permissions,
      }),
    getIssueComment: (_t: RedactedSecret, _r: RepoRef, id: string): Promise<IssueCommentText> => {
      if (this.down) return Promise.reject(new GitHostError('network_error'));
      const issue = this.comments.get(id);
      if (issue === undefined) return Promise.reject(new GitHostError('not_found'));
      return Promise.resolve({
        commentId: id,
        issueNumber: issue,
        author: { id: '4001', login: 'a', type: 'user' },
        body: 'Orders fail in production. canary-incident-55',
      });
    },
    revokeShortLivedToken: () => Promise.resolve(),
  };
}

describeDb('H08 PR 3a: break-glass through the API on PostgreSQL', () => {
  let db: TestDatabase;
  let scope: TenantScope;
  let app: Awaited<ReturnType<typeof createApp>>;
  const git = new FakeGitHost();
  const users = {} as Record<'a' | 'b' | 'gov' | 'second' | 'outsider', string>;
  const tokens = {} as Record<keyof typeof users, string>;
  const woken: string[] = [];
  let nextIssue = 200;
  let nextComment = 5000;

  beforeAll(async () => {
    db = await createTestDatabase();
    const tenant = await db.app.system.createTenant({ slug: 'internal', name: 'Internal' });
    scope = db.app.forTenant(parseTenantId(tenant.id));
    const shop = await scope.projects.create({
      slug: 'shop',
      name: 'Shop',
      git_provider: 'github',
      repo_full_name: 'acme/shop',
    });
    const docs = await scope.projects.create({
      slug: 'docs',
      name: 'Docs',
      git_provider: 'github',
      repo_full_name: 'acme/docs',
    });
    const roles = {
      a: ['person_a', shop.id],
      b: ['person_b', shop.id],
      gov: ['governance', shop.id],
      second: ['second_approver', shop.id],
      outsider: ['person_a', docs.id],
    } as const;
    for (const key of Object.keys(roles) as (keyof typeof users)[]) {
      const user = await scope.users.create({ display_name: key, email: `${key}@example.com` });
      users[key] = user.id;
      await scope.roleBindings.grant({
        user_id: user.id,
        project_id: roles[key][1],
        role: roles[key][0],
      });
      tokens[key] = (
        await issueApiToken(scope, { userId: user.id, name: key, now: tokenIssuedAt() })
      ).token;
    }
    app = await createApp({
      db: db.app as unknown as ApiDeps['db'],
      settings: { rateLimitPerMinute: 1000, authFailuresPerMinute: 1000 },
      now: () => NOW,
      lessonGitHost: git.gitHost,
      intentSignals: {
        wake: (ref) => {
          woken.push(ref.intentId);
          return Promise.resolve();
        },
        kill: () => Promise.resolve(),
      },
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

  /** A new intent of `shop` created by Person A, with its own issue. */
  async function intent() {
    nextIssue += 1;
    const created = await inject('POST', '/v1/intents', 'a', {
      project: 'shop',
      title: 'Fix the order export',
      risk_tier: 'high',
      data_class: 'internal',
      issue_number: nextIssue,
    });
    expect(created.status).toBe(201);
    return { code: created.body.code as string, issue: nextIssue };
  }

  function comment(issue: number): string {
    nextComment += 1;
    git.comments.set(String(nextComment), issue);
    return `https://github.com/acme/shop/issues/${String(issue)}#issuecomment-${String(nextComment)}`;
  }

  const request = (code: string, issue: number, who: keyof typeof users = 'a', extra = {}) =>
    inject('POST', `/v1/intents/${code}/break-glass`, who, {
      scopes: ['runner_priority'],
      hours: 2,
      reason_url: comment(issue),
      ...extra,
    });

  it('Person A requests, Person B approves: an active grant and an incident code', async () => {
    const { code, issue } = await intent();
    const requested = await request(code, issue);
    expect(requested.status).toBe(201);
    expect(requested.body).toMatchObject({
      intent: code,
      project: 'shop',
      status: 'requested',
      scopes: ['runner_priority'],
      duration_seconds: 7200,
      incident: null,
    });
    const approved = await inject('POST', `/v1/intents/${code}/break-glass/approve`, 'b', {});
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({
      status: 'active',
      approver_id: users.b,
      expires_at: '2026-11-15T05:00:00.000Z',
    });
    expect(approved.body.incident).toMatch(/^ESC-2026-\d{4,}$/);
  });

  it('refuses the requester, Person A and the second approver as approvers', async () => {
    const { code, issue } = await intent();
    expect((await request(code, issue, 'b')).status).toBe(201);
    for (const [who, reason] of [
      ['b', 'same_person'],
      ['a', 'forbidden'],
      ['second', 'forbidden'],
    ] as const) {
      const refused = await inject('POST', `/v1/intents/${code}/break-glass/approve`, who, {});
      expect(refused.status, who).toBe(403);
      expect(refused.body.error).toMatchObject({ code: 'forbidden', reason });
    }
    // Governance may (the producer rule is covered in break-glass.test.ts).
    expect(
      (await inject('POST', `/v1/intents/${code}/break-glass/approve`, 'gov', {})).status,
    ).toBe(200);
  });

  it('maps refusals to stable codes, and checks the request body', async () => {
    const { code, issue } = await intent();
    const cases: [object, number, string, string | undefined][] = [
      [{ scopes: ['merge'] }, 400, 'invalid_request', undefined],
      [{ hours: 9 }, 400, 'invalid_request', undefined],
      [{ note: 'free text' }, 400, 'invalid_request', undefined],
      [{ scopes: ['budget'] }, 409, 'break_glass_refused', 'budget_invalid'],
      [{ reason_url: comment(issue + 1000) }, 409, 'break_glass_refused', 'comment_not_on_intent'],
    ];
    for (const [extra, status, codeOf, reason] of cases) {
      const refused = await request(code, issue, 'a', extra);
      expect(refused.status, JSON.stringify(extra)).toBe(status);
      expect(refused.body.error?.code).toBe(codeOf);
      if (reason !== undefined) expect(refused.body.error?.reason).toBe(reason);
    }
    git.down = true;
    const down = await request(code, issue);
    expect(down.status).toBe(503);
    expect(down.body.error).toMatchObject({
      code: 'git_host_unavailable',
      reason: 'network_error',
    });
    git.down = false;
    expect((await request(code, issue, 'outsider')).status).toBe(404);
    expect((await request(code, issue, 'gov')).body.error?.code).toBe('forbidden');
  });

  it('revoke, review and list', async () => {
    const { code, issue } = await intent();
    await request(code, issue);
    await inject('POST', `/v1/intents/${code}/break-glass/approve`, 'gov', {});
    const revoked = await inject('POST', `/v1/intents/${code}/break-glass/revoke`, 'b', {});
    expect(revoked.body).toMatchObject({ status: 'revoked', revoked_by: users.b });
    expect(revoked.body.incident).toMatch(/^ESC-/);
    const again = await inject('POST', `/v1/intents/${code}/break-glass/revoke`, 'b', {});
    expect(again.body.error).toMatchObject({ code: 'break_glass_refused', reason: 'no_grant' });
    const review = comment(issue);
    const reviewed = await inject('POST', `/v1/intents/${code}/break-glass/review`, 'a', {
      comment_url: review,
    });
    expect(reviewed.status).toBe(200);
    expect(reviewed.body).toMatchObject({ review_url: review, reviewed_by: users.a });
    // PR 3b: approve, revoke and review wake the intent (the step reads the grant again); the
    // request does not. One more wake: the intent's creation.
    const id = (await scope.intents.getByCode(code))!.id;
    expect(woken.filter((w) => w === id)).toHaveLength(4);

    const listed = await inject('GET', '/v1/break-glass?project=shop', 'second');
    expect(listed.status).toBe(200);
    const items = listed.body.items as { intent: string; status: string }[];
    expect(items.find((g) => g.intent === code)?.status).toBe('revoked');
    const open = await inject('GET', '/v1/break-glass?open=true', 'b');
    expect((open.body.items as { status: string }[]).every((g) => g.status !== 'revoked')).toBe(
      true,
    );
    expect((await inject('GET', '/v1/break-glass', 'outsider')).body.items).toEqual([]);
    expect((await inject('GET', '/v1/break-glass?project=shop', 'outsider')).status).toBe(404);
  });

  it('PR 4: the doctor query lists the active grants only, as ID, intent code and UTC expiry', async () => {
    const { code, issue } = await intent();
    await request(code, issue);
    const approved = await inject('POST', `/v1/intents/${code}/break-glass/approve`, 'b', {});
    // The query doctor runs, as the owner role `platform` (policy `owner_all`, never BYPASSRLS).
    const { rows } = await sql<{ out: unknown }>`${sql.raw(SQL_BREAK_GLASS)}`.execute(db.owner);
    const grants = parseBreakGlass(JSON.stringify(Object.values(rows[0] ?? {})[0]));
    expect(grants).not.toBeNull();
    expect(grants).toContainEqual({
      id: approved.body.id,
      intent: code,
      expiresAt: '2026-11-15T05:00:00Z',
    });
    // Requested, refused and revoked grants are not listed.
    const listed = await inject('GET', '/v1/break-glass', 'b');
    const active = (listed.body.items as { id: string; status: string }[])
      .filter((g) => g.status === 'active')
      .map((g) => g.id)
      .sort();
    expect(grants!.map((g) => g.id).sort()).toEqual(active);
  });

  it('stores codes, IDs, times and the links only: never the words of the comment', async () => {
    const { rows } = await sql<{ row: string }>`
      SELECT row_to_json(g)::text AS row FROM break_glass_grants g`.execute(db.owner);
    expect(rows.length).toBeGreaterThan(0);
    for (const { row } of rows) expect(row).not.toContain('canary-incident-55');
    const audit = await sql<{ payload: string }>`
      SELECT payload::text AS payload FROM audit_log WHERE action LIKE 'break_glass.%'`.execute(
      db.owner,
    );
    for (const { payload } of audit.rows) {
      expect(payload).not.toMatch(/https?:|canary|issuecomment/);
    }
  });
});
