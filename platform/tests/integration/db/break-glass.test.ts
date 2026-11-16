// H08 PR 2 on a live PostgreSQL (design/ADR-M111 §2.1–§2.8, D-08 H08 AC2, AC3, AC5; QUESTIONS
// #741–#744): break-glass grants in the core. Two different people (rule M21), the approver is
// governance or Person B and never a producer; scopes, durations and budget amounts are checked;
// a grant expires, lapses and is revoked; the stand-in escalation is Critical and never freezes;
// the review closes it; the audit log and the table hold codes, IDs and links only (R030, R031);
// trigger SDA32 refuses moves that ADR-M111 §2.5 does not allow. The Git host is a fake.
import { createSimplePolicyEngine } from '@sdlc/adapter-policy-simple';
import { GitHubAdapter } from '@sdlc/adapter-git-github';
import { loadProjectConfig } from '@sdlc/config';
import {
  GitHostError,
  type IssueCommentText,
  type RedactedSecret,
  type RepoRef,
  type TokenScope,
} from '@sdlc/contracts';
import { Redacted } from '@sdlc/secrets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  activeGrant,
  approveBreakGlass,
  breakGlassReviewPending,
  refuseBreakGlass,
  requestBreakGlass,
  reviewBreakGlass,
  revokeBreakGlass,
  runBreakGlassPass,
  type RequestBreakGlassInput,
} from '../../../packages/core/src/break-glass/index.js';
import { BreakGlassError } from '../../../packages/core/src/break-glass/errors.js';
import { DbError } from '../../../packages/core/src/db/errors.js';
import type { Intent } from '../../../packages/core/src/db/schema.js';
import { parseTenantId } from '../../../packages/core/src/db/tenant-id.js';
import type { TenantScope } from '../../../packages/core/src/db/tenant-scope.js';
import { isFreezing } from '../../../packages/core/src/escalation/freeze.js';
import type { RegistryDeps } from '../../../packages/core/src/registry/effective-config.js';
import { createTestDatabase, describeDb, tamper, type TestDatabase } from './helpers.js';

const T0 = new Date('2026-11-15T03:00:00.000Z');
const HOUR = 3_600_000;
const at = (hours: number) => new Date(T0.getTime() + hours * HOUR);
const pure = new GitHubAdapter({ secrets: { read: () => Promise.reject(new Error('unused')) } });
const registryDeps: RegistryDeps = {
  policyFactory: (config) => createSimplePolicyEngine({ config }),
  now: () => T0,
};

/** Comments by ID and the issue each is on. */
class FakeGitHost {
  comments = new Map<string, number>();
  readonly gitHost = {
    commentIdOf: (ref: RepoRef, url: string) => pure.commentIdOf(ref, url),
    issueShortLivedToken: (repo: RepoRef, scope: TokenScope) =>
      Promise.resolve({
        token: new Redacted('ghs_fake'),
        expiresAt: T0.toISOString(),
        repo,
        permissions: scope.permissions,
      }),
    getIssueComment: (_t: RedactedSecret, _r: RepoRef, id: string): Promise<IssueCommentText> => {
      const issue = this.comments.get(id);
      if (issue === undefined) return Promise.reject(new GitHostError('not_found'));
      return Promise.resolve({
        commentId: id,
        issueNumber: issue,
        author: { id: '4001', login: 'a', type: 'user' },
        body: 'Production orders fail since 02:00. canary-incident-91',
      });
    },
    revokeShortLivedToken: () => Promise.resolve(),
  };
}

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof BreakGlassError) return error.code;
    if (error instanceof DbError) return `db:${error.code}`;
    throw error;
  }
  return 'resolved';
}

interface World {
  readonly scope: TenantScope;
  readonly intent: Intent;
  readonly users: Record<'a' | 'b' | 'b2' | 'gov' | 'second' | 'viewer' | 'stranger', string>;
}

describeDb('H08 PR 2: break-glass grants on PostgreSQL', () => {
  let t: TestDatabase;
  let tenants = 0;
  let nextComment = 7000;
  const git = new FakeGitHost();

  beforeAll(async () => {
    t = await createTestDatabase();
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  });

  /** A tenant, a project, its people and one open intent created by `creator` (default Person A). */
  async function world(opts: { configYaml?: string; creator?: 'a' | 'gov' } = {}): Promise<World> {
    const slug = `tenant-${String(++tenants)}`;
    const tenant = await t.app.system.createTenant({ slug, name: slug });
    const scope = t.app.forTenant(parseTenantId(tenant.id));
    const project = await scope.projects.create({
      slug: 'shop',
      name: 'Shop',
      git_provider: 'github',
      repo_full_name: 'acme/shop',
    });
    const users = {} as World['users'];
    const roles = {
      a: 'person_a',
      b: 'person_b',
      b2: 'person_b',
      gov: 'governance',
      second: 'second_approver',
      viewer: 'viewer',
      stranger: null,
    } as const;
    for (const [key, role] of Object.entries(roles) as [keyof World['users'], string | null][]) {
      users[key] = (
        await scope.users.create({ display_name: key, email: `${key}@example.com` })
      ).id;
      if (role) {
        await scope.roleBindings.grant({
          user_id: users[key],
          project_id: project.id,
          role: role as 'person_a',
        });
      }
    }
    if (opts.configYaml !== undefined) {
      const loaded = loadProjectConfig(opts.configYaml);
      if (!loaded.ok) throw new Error('bad test config');
      await scope.projectConfigs.save(project.id, {
        configYaml: opts.configYaml,
        configHash: loaded.configHash,
        updatedBy: null,
        expectedVersion: 0,
      });
    }
    const intent = await scope.intents.create(
      {
        projectId: project.id,
        title: 'Fix the order export',
        createdBy: users[opts.creator ?? 'a'],
        riskTier: 'high',
        dataClass: 'internal',
        issueNumber: 41,
      },
      registryDeps,
    );
    return { scope, intent, users };
  }

  /** A comment on the intent's issue that exists on the fake Git host. */
  function comment(issue = 41): string {
    nextComment += 1;
    git.comments.set(String(nextComment), issue);
    return `https://github.com/acme/shop/issues/${String(issue)}#issuecomment-${String(nextComment)}`;
  }

  const request = (w: World, extra: Partial<RequestBreakGlassInput> = {}) =>
    requestBreakGlass(w.scope, git, {
      intentRef: w.intent.code,
      scopes: ['runner_priority'],
      hours: 2,
      reasonUrl: comment(),
      actorId: w.users.a,
      now: T0,
      ...extra,
    });

  const approve = (w: World, who: keyof World['users'], now = at(0.1)) =>
    approveBreakGlass(w.scope, { intentRef: w.intent.code, actorId: w.users[who], now });

  describe('AC2: two people; the approver is governance or Person B, never a producer', () => {
    it('Person A requests, Person B approves: active, with a Critical non-freezing incident', async () => {
      const w = await world();
      const { grant } = await request(w);
      expect(grant.status).toBe('requested');
      const { grant: active, incident } = await approve(w, 'b');
      expect(active.status).toBe('active');
      expect(active.approver_id).toBe(w.users.b);
      expect(active.expires_at).toEqual(new Date(at(0.1).getTime() + 2 * HOUR));
      expect(incident).toMatch(/^ESC-2026-\d{4,}$/);
      const escalation = await w.scope.escalations.getById(active.escalation_id!);
      expect(escalation).toMatchObject({
        trigger: 'break_glass',
        severity: 'critical',
        route: 'policy',
        response_level: 'notify',
        status: 'open',
        code: incident,
      });
      expect(isFreezing(escalation!)).toBe(false);
      // The intent itself is not changed: same status, gate, budget (ADR-M111 §2.3).
      const after = await w.scope.intents.getById(w.intent.id);
      expect(after).toMatchObject({
        status: w.intent.status,
        current_gate: w.intent.current_gate,
        budget_usd: w.intent.budget_usd,
        run_budget_usd: w.intent.run_budget_usd,
      });
    });

    it('governance approves too', async () => {
      const w = await world();
      await request(w);
      expect((await approve(w, 'gov')).grant.status).toBe('active');
    });

    it('the requester never approves (rule M21)', async () => {
      const w = await world();
      await request(w, { actorId: w.users.b });
      expect(await failure(approve(w, 'b'))).toBe('same_person');
      expect(
        await failure(
          refuseBreakGlass(w.scope, {
            intentRef: w.intent.code,
            actorId: w.users.b,
            now: at(0.1),
          }),
        ),
      ).toBe('same_person');
    });

    it('a producer of the intent never approves', async () => {
      const w = await world({ creator: 'gov' });
      await request(w);
      expect(await failure(approve(w, 'gov'))).toBe('producer');
      expect((await approve(w, 'b')).grant.status).toBe('active');
    });

    it('other roles never request or approve; a disabled or unknown user never acts', async () => {
      const w = await world();
      for (const who of ['gov', 'second', 'viewer', 'stranger'] as const) {
        expect(await failure(request(w, { actorId: w.users[who] })), who).toMatch(
          /^(forbidden|intent_not_found)$/,
        );
      }
      await request(w);
      for (const who of ['a', 'second', 'viewer'] as const) {
        expect(await failure(approve(w, who)), who).toBe('forbidden');
      }
      await w.scope.users.setStatus(w.users.b, 'disabled');
      expect(await failure(approve(w, 'b'))).toBe('forbidden');
      expect(
        await failure(
          approveBreakGlass(w.scope, {
            intentRef: w.intent.code,
            actorId: '00000000-0000-4000-8000-000000000000',
            now: at(0.1),
          }),
        ),
      ).toBe('intent_not_found');
    });

    it('a refused request ends without effect; a new one may follow', async () => {
      const w = await world();
      await request(w);
      const { grant } = await refuseBreakGlass(w.scope, {
        intentRef: w.intent.code,
        actorId: w.users.gov,
        now: at(0.1),
      });
      expect(grant).toMatchObject({ status: 'refused', escalation_id: null });
      expect(await breakGlassReviewPending(w.scope, w.intent.id)).toBe(false);
      expect((await request(w, { now: at(0.2) })).grant.status).toBe('requested');
    });
  });

  describe('AC5: scope limits', () => {
    it.each([
      ['an unknown scope', { scopes: ['merge'] }, 'scope_invalid'],
      ['no scope', { scopes: [] }, 'scope_invalid'],
      ['a scope twice', { scopes: ['budget', 'budget'], budgetIncreaseUsd: '5' }, 'scope_invalid'],
      ['zero hours', { hours: 0 }, 'duration_invalid'],
      ['more than max_hours', { hours: 5 }, 'duration_invalid'],
      ['half an hour', { hours: 0.5 }, 'duration_invalid'],
      ['budget without an amount', { scopes: ['budget'] }, 'budget_invalid'],
      ['an amount without budget', { budgetIncreaseUsd: '5' }, 'budget_invalid'],
      [
        'an amount over the cap',
        { scopes: ['budget'], budgetIncreaseUsd: '50.000001' },
        'budget_invalid',
      ],
      ['a zero amount', { scopes: ['budget'], budgetIncreaseUsd: '0' }, 'budget_invalid'],
      ['a comment elsewhere', { reasonUrl: 'https://example.com/note' }, 'comment_invalid'],
      ['a comment on another issue', { reasonUrl: 'ON_ISSUE_42' }, 'comment_not_on_intent'],
      [
        'a missing comment',
        { reasonUrl: 'https://github.com/acme/shop/issues/41#issuecomment-1' },
        'comment_not_found',
      ],
    ] as const)('refuses %s', async (_name, extra, code) => {
      const w = await world();
      const given: Partial<RequestBreakGlassInput> =
        'reasonUrl' in extra && extra.reasonUrl === 'ON_ISSUE_42'
          ? { ...extra, reasonUrl: comment(42) }
          : { ...extra };
      expect(await failure(request(w, given))).toBe(code);
      expect(await w.scope.breakGlass.listForIntent(w.intent.id)).toEqual([]);
    });

    it('keeps the amount and the scopes in a fixed order', async () => {
      const w = await world();
      const { grant } = await request(w, {
        scopes: ['hotl_window_skip', 'budget'],
        budgetIncreaseUsd: '12.500000',
      });
      expect(grant.scopes).toEqual(['budget', 'hotl_window_skip']);
      expect(grant.budget_increase_usd).toBe('12.500000');
    });

    it('the budget scope raises the intent and run budgets once, at the approval (R045)', async () => {
      const w = await world();
      await request(w, { scopes: ['budget'], budgetIncreaseUsd: '7.25' });
      const before = (await w.scope.intents.getById(w.intent.id))!;
      const { grant } = await approve(w, 'b');
      const after = (await w.scope.intents.getById(w.intent.id))!;
      expect(Number(after.budget_usd) - Number(before.budget_usd)).toBeCloseTo(7.25, 6);
      // No run budget yet: the project's default (2) plus the amount.
      expect(Number(after.run_budget_usd)).toBeCloseTo(9.25, 6);
      const raised = await w.scope.audit.listForEntity(w.intent.id, ['intent.budget_increased']);
      expect(raised).toHaveLength(1);
      expect(raised[0]?.payload).toMatchObject({ escalation_id: grant.escalation_id });
      await revokeBreakGlass(w.scope, {
        intentRef: w.intent.code,
        actor: { type: 'system' },
        now: at(1),
      });
      expect((await w.scope.intents.getById(w.intent.id))!.budget_usd).toBe(after.budget_usd);
    });

    it('refuses a scope the project does not allow, and a project that turned it off', async () => {
      const limited = await world({ configYaml: 'break_glass:\n  allowed_scopes: [budget]\n' });
      expect(await failure(request(limited))).toBe('scope_invalid');
      const off = await world({ configYaml: 'break_glass:\n  enabled: false\n' });
      expect(await failure(request(off))).toBe('disabled');
    });

    it('one open grant per intent; never for a finished intent', async () => {
      const w = await world();
      await request(w);
      expect(await failure(request(w))).toBe('already_open');
      const done = await world();
      await tamper(t.name, `UPDATE intents SET status = 'done' WHERE id = $1`, [done.intent.id]);
      expect(await failure(request(done))).toBe('intent_not_open');
    });

    it('the database refuses a scope outside the closed list', async () => {
      const w = await world();
      expect(
        await failure(
          w.scope.breakGlass.request({
            project_id: w.intent.project_id,
            intent_id: w.intent.id,
            operator_id: w.users.a,
            scopes: ['merge' as 'budget'],
            duration_seconds: 3600,
            reason_url: comment(),
            lapses_at: at(1),
          }),
        ),
      ).toMatch(/^db:/);
    });

    it('only the operator, only the named scope, only before expiry', async () => {
      const w = await world();
      await request(w, { scopes: ['runner_priority', 'budget'], budgetIncreaseUsd: '5' });
      await approve(w, 'b');
      const id = w.intent.id;
      expect(await activeGrant(w.scope, id, at(1), 'runner_priority', w.users.a)).toBeDefined();
      expect(await activeGrant(w.scope, id, at(1), 'budget', w.users.a)).toBeDefined();
      expect(await activeGrant(w.scope, id, at(1), 'hotl_window_skip', w.users.a)).toBeUndefined();
      expect(await activeGrant(w.scope, id, at(1), 'runner_priority', w.users.b)).toBeUndefined();
      // Expired at 2.1 h, even before the worker pass ends it.
      expect(await activeGrant(w.scope, id, at(2.2), 'runner_priority', w.users.a)).toBeUndefined();
    });
  });

  describe('AC5: expiry, lapse and revoke', () => {
    it('the pass expires an active grant and lapses an old request, once', async () => {
      const w1 = await world();
      await request(w1);
      await approve(w1, 'b');
      const w2 = await world();
      await request(w2);
      expect(await runBreakGlassPass(w1.scope, at(1))).toEqual({
        expired: 0,
        lapsed: 0,
        reviewOverdue: 0,
      });
      expect(await runBreakGlassPass(w1.scope, at(2.2))).toMatchObject({ expired: 1 });
      expect(await runBreakGlassPass(w1.scope, at(2.3))).toMatchObject({ expired: 0 });
      expect(await runBreakGlassPass(w2.scope, at(0.6))).toMatchObject({ lapsed: 1 });
      const [ended] = await w1.scope.breakGlass.listForIntent(w1.intent.id);
      expect(ended).toMatchObject({ status: 'expired', ended_at: at(2.2) });
      expect(await breakGlassReviewPending(w1.scope, w1.intent.id)).toBe(true);
      const [lapsed] = await w2.scope.breakGlass.listForIntent(w2.intent.id);
      expect(lapsed?.status).toBe('lapsed');
      expect(await breakGlassReviewPending(w2.scope, w2.intent.id)).toBe(false);
    });

    it('a request is not approved after it lapsed', async () => {
      const w = await world();
      await request(w);
      expect(await failure(approve(w, 'b', at(0.6)))).toBe('lapsed');
    });

    it.each(['a', 'b', 'b2', 'gov', 'system'] as const)('%s may revoke at once', async (who) => {
      const w = await world();
      await request(w);
      await approve(w, 'b');
      const actor =
        who === 'system'
          ? ({ type: 'system' } as const)
          : ({ type: 'human', id: w.users[who] } as const);
      const { grant } = await revokeBreakGlass(w.scope, {
        intentRef: w.intent.code,
        actor,
        now: at(0.5),
      });
      expect(grant).toMatchObject({
        status: 'revoked',
        ended_at: at(0.5),
        revoked_by: who === 'system' ? null : w.users[who],
      });
      expect(
        await activeGrant(w.scope, w.intent.id, at(0.6), 'runner_priority', w.users.a),
      ).toBeUndefined();
      expect(
        await failure(revokeBreakGlass(w.scope, { intentRef: w.intent.code, actor, now: at(0.7) })),
      ).toBe('no_grant');
    });

    it('other roles never revoke', async () => {
      const w = await world();
      await request(w);
      await approve(w, 'b');
      for (const who of ['second', 'viewer'] as const) {
        expect(
          await failure(
            revokeBreakGlass(w.scope, {
              intentRef: w.intent.code,
              actor: { type: 'human', id: w.users[who] },
              now: at(0.5),
            }),
          ),
          who,
        ).toBe('forbidden');
      }
    });
  });

  describe('the review (ADR-M111 §2.8)', () => {
    it('is recorded after the end, closes the incident, and is due within the review window', async () => {
      const w = await world();
      await request(w);
      const { grant } = await approve(w, 'b');
      const review = () =>
        reviewBreakGlass(w.scope, git, {
          intentRef: w.intent.code,
          commentUrl: comment(),
          actorId: w.users.a,
          now: at(30),
        });
      expect(await failure(review())).toBe('nothing_to_review');
      expect(await breakGlassReviewPending(w.scope, w.intent.id)).toBe(true);
      await revokeBreakGlass(w.scope, {
        intentRef: w.intent.code,
        actor: { type: 'human', id: w.users.gov },
        now: at(1),
      });
      expect(await runBreakGlassPass(w.scope, at(48.9))).toMatchObject({ reviewOverdue: 0 });
      expect(await runBreakGlassPass(w.scope, at(49.1))).toMatchObject({ reviewOverdue: 1 });
      const overdue = (await w.scope.intentNotices.listForIntent(w.intent.id)).filter(
        (n) => n.kind === 'break_glass_review_overdue',
      );
      expect(overdue.map((n) => [...n.audience_roles].sort())).toEqual([
        ['governance', 'person_a', 'person_b'],
      ]);
      expect(await runBreakGlassPass(w.scope, at(50))).toMatchObject({ reviewOverdue: 0 });
      expect(
        await failure(
          reviewBreakGlass(w.scope, git, {
            intentRef: w.intent.code,
            commentUrl: comment(),
            actorId: w.users.gov,
            now: at(50),
          }),
        ),
      ).toBe('forbidden');
      const { grant: reviewed, incident } = await review();
      expect(reviewed.review_url).toMatch(/^https:\/\/github\.com\/acme\/shop\/issues\/41#/);
      expect((await w.scope.escalations.getById(grant.escalation_id!))?.status).toBe('closed');
      expect(incident).toMatch(/^ESC-/);
      expect(await breakGlassReviewPending(w.scope, w.intent.id)).toBe(false);
      expect(await failure(review())).toBe('nothing_to_review');
    });
  });

  describe('AC3, AC5: codes, IDs and links only; trigger SDA32', () => {
    it('writes every audit event with codes, IDs and durations, never a link or text', async () => {
      const w = await world();
      const { grant } = await request(w, { scopes: ['budget'], budgetIncreaseUsd: '5.5' });
      await approve(w, 'b');
      await revokeBreakGlass(w.scope, {
        intentRef: w.intent.code,
        actor: { type: 'system' },
        now: at(1),
      });
      await reviewBreakGlass(w.scope, git, {
        intentRef: w.intent.code,
        commentUrl: comment(),
        actorId: w.users.b,
        now: at(2),
      });
      const events = await w.scope.audit.listForEntity(grant.id);
      expect(events.map((e) => e.action)).toEqual([
        'break_glass.requested',
        'break_glass.approved',
        'break_glass.revoked',
        'break_glass.reviewed',
      ]);
      expect(events[1]?.payload).toMatchObject({
        approver_id: w.users.b,
        scopes: ['budget'],
        expires_in: 7200,
        budget_increase_usd: '5.5',
      });
      for (const event of events) {
        const text = JSON.stringify(event.payload);
        expect(text, event.action).not.toMatch(/https?:|github|canary|issuecomment/);
      }
    });

    it('refuses moves and edits that ADR-M111 §2.5 does not allow', async () => {
      const w = await world();
      const { grant } = await request(w);
      await approve(w, 'b');
      const edits = [
        { status: 'requested' as const },
        { approver_id: w.users.gov },
        { review_url: 'https://github.com/acme/shop/issues/41#issuecomment-5' },
      ];
      for (const set of edits) {
        expect(await failure(w.scope.breakGlass.update(grant.id, set)), JSON.stringify(set)).toBe(
          'db:immutable',
        );
      }
      await revokeBreakGlass(w.scope, {
        intentRef: w.intent.code,
        actor: { type: 'system' },
        now: at(1),
      });
      expect(await failure(w.scope.breakGlass.update(grant.id, { status: 'active' }))).toBe(
        'db:immutable',
      );
      expect(await failure(w.scope.breakGlass.update(grant.id, { ended_at: at(2) }))).toBe(
        'db:immutable',
      );
    });
  });
});
