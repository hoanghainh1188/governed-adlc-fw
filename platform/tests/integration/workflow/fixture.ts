// Shared set-up of the intent workflow tests (task B07): a tenant, one GitHub project, the 2+N
// people with their numeric GitHub account IDs, and the in-process GitHub stub. Used by the
// database tests of `stepIntent` (integration/db) and the Temporal tests (integration/workflow).
import { createSimplePolicyEngine } from '@sdlc/adapter-policy-simple';

import type { Intent } from '../../../packages/core/src/db/schema.js';
import type { PollableProject } from '../../../packages/core/src/db/system-scope.js';
import { parseTenantId } from '../../../packages/core/src/db/tenant-id.js';
import type { TenantScope } from '../../../packages/core/src/db/tenant-scope.js';
import { pollProject } from '../../../packages/core/src/git-events/poll-project.js';
import { Registry } from '../../../packages/core/src/registry/registry.js';
import type { IntentWorkflowSignals } from '../../../packages/contracts/src/intent-workflow.js';
import { startHarness, type Harness } from '../../git-github/helpers.js';
import { comment, user } from '../../git-github/stub-github.js';
import { seedAiRecord } from '../ai-record-seed.js';
import type { TestDatabase } from '../db/helpers.js';

export const SPEC_HASH = '5'.repeat(64);
export const PLAN_HASH = '6'.repeat(64);
export const COMMIT = 'c'.repeat(40);

/** Numeric GitHub account IDs and logins (QUESTIONS #45). */
export const PEOPLE = {
  a: { gh: 3001, login: 'alice', role: 'person_a' },
  b: { gh: 3002, login: 'bob', role: 'person_b' },
  gov: { gh: 3003, login: 'gina', role: 'governance' },
} as const;
export type Person = keyof typeof PEOPLE;

export interface WorkflowFixture {
  readonly scope: TenantScope;
  readonly registry: Registry;
  readonly target: PollableProject;
  readonly users: Readonly<Record<Person, string>>;
  readonly h: Harness;
  /** A new intent on its own issue (a draft: the workflow submits it). */
  newIntent(extra?: { riskTier?: 'low' | 'medium' | 'high' | 'critical' }): Promise<Intent>;
  /** Links a spec (G2 input) and submits a plan (G3 input). */
  addInputs(intent: Intent, plan?: { changeFlags?: readonly 'migration'[] }): Promise<void>;
  /**
   * A comment on the intent's issue, read by the next poll. `who` is one of the fixture's people,
   * or any GitHub account (C11: an account that is not linked to a platform user).
   */
  comment(intent: Intent, body: string, who: Person | { gh: number; login: string }): void;
  /** One poll of the project (comment commands, replies, notices, status comments). */
  poll(signals?: IntentWorkflowSignals): ReturnType<typeof pollProject>;
  /** Bodies of the comments the platform posted on an issue. */
  posted(intent: Intent): string[];
  close(): Promise<void>;
}

export async function createWorkflowFixture(
  db: TestDatabase,
  now: () => Date,
  /** O07: the load test makes one tenant per fixture, each with its own slug. */
  options: { readonly tenantSlug?: string } = {},
): Promise<WorkflowFixture> {
  const registry = new Registry({
    policyFactory: (config) => createSimplePolicyEngine({ config }),
    now,
  });
  const tenant = await db.app.system.createTenant({
    slug: options.tenantSlug ?? 'internal',
    name: 'Internal',
  });
  const tenantId = parseTenantId(tenant.id);
  const scope = db.app.forTenant(tenantId);
  const project = await scope.projects.create({
    slug: 'shop',
    name: 'Shop',
    git_provider: 'github',
    repo_full_name: 'acme/shop',
  });
  const users = {} as Record<Person, string>;
  for (const [person, p] of Object.entries(PEOPLE) as [Person, (typeof PEOPLE)[Person]][]) {
    const created = await scope.users.create({
      display_name: person,
      email: `${person}@example.com`,
    });
    users[person] = created.id;
    await scope.roleBindings.grant({ user_id: created.id, project_id: project.id, role: p.role });
    await scope.userIdentities.link({
      user_id: created.id,
      provider: 'github',
      external_id: String(p.gh),
      external_login: p.login,
    });
  }
  // B12: the submit (Draft → G1) needs a project AI record that allows the data class (FR-19).
  await seedAiRecord(scope, project.id, users.a);
  const target: PollableProject = { tenantId, projectId: project.id, repoFullName: 'acme/shop' };

  const h = await startHarness();
  const comments: ReturnType<typeof comment>[] = [];
  let nextComment = 7000;
  let issue = 100;
  h.stub.on('GET', '/repos/acme/shop', { body: { id: 1 } });
  h.stub.on('GET', '/repos/acme/shop/issues/comments', (req) => ({
    body: comments.filter((c) => Date.parse(c.updated_at) >= Date.parse(req.query.get('since')!)),
  }));
  h.stub.on('GET', '/repos/acme/shop/pulls', { body: [] });

  const poll = (signals?: IntentWorkflowSignals) =>
    pollProject(
      {
        db: db.app,
        gitHost: h.adapter(),
        registry,
        now: () => h.stub.now,
        ...(signals ? { intentSignals: signals } : {}),
      },
      target,
    );
  await poll(); // first poll: no history

  return {
    scope,
    registry,
    target,
    users,
    h,
    async newIntent(extra = {}) {
      issue += 1;
      h.stub.on('POST', `/repos/acme/shop/issues/${String(issue)}/comments`, {
        status: 201,
        body: { id: 1 },
      });
      return registry.createIntent(scope, {
        projectId: project.id,
        title: 'Cancel an order',
        createdBy: users.a,
        riskTier: extra.riskTier ?? 'medium',
        dataClass: 'internal',
        issueNumber: issue,
      });
    },
    async addInputs(intent, plan = {}) {
      await registry.linkSpec(scope, intent.id, {
        path: 'docs/specs/t07.md',
        commitSha: COMMIT,
        contentSha256: SPEC_HASH,
        structure: 'manual_heading',
        acceptanceCriteria: 1,
        actorType: 'human',
        actorId: users.a,
      });
      await registry.submitPlan(scope, intent.id, {
        plannedFiles: ['apps/api/src/orders/**'],
        planSha256: PLAN_HASH,
        changeFlags: plan.changeFlags ?? [],
        actorType: 'human',
        actorId: users.a,
      });
    },
    comment(intent, body, who) {
      nextComment += 1;
      // Comments are listed by `updated_at >= since`; one second apart keeps them in order.
      const at = new Date(h.stub.now.getTime() + (nextComment - 7000) * 1000)
        .toISOString()
        .replace(/\.\d{3}Z$/, 'Z');
      comments.push(
        comment(nextComment, intent.issue_number!, at, body, {
          author:
            typeof who === 'string'
              ? user(PEOPLE[who].gh, PEOPLE[who].login)
              : user(who.gh, who.login),
        }),
      );
    },
    poll,
    posted: (intent) =>
      h.stub
        .requestsTo('POST', `/repos/acme/shop/issues/${String(intent.issue_number)}/comments`)
        .map((r) => (r.body as { body: string }).body),
    close: () => h.stub.stop(),
  };
}
