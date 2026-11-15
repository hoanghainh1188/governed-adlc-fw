// D-08 L05 (PR 2) on PostgreSQL (design/ADR-M82, QUESTIONS #470–#475): evaluation plans.
// - who: `access.eval_roles` (a viewer, another project's member and another tenant are refused);
// - configurations from the agent register or a model with the default agent; prompt variants
//   stored as path, commit and SHA-256 only, read again at start;
// - versions are append-only, a stale version is refused, archived is final (trigger SDA23);
// - budgets: the monthly cap pauses the plan and refuses a start, never below the month's spend;
// - one open evaluation per plan; an evaluation of a plan has its configurations and no file;
// - the audit events hold codes, IDs, amounts and hashes only.
import { createHash } from 'node:crypto';

import { createSimplePolicyEngine } from '@sdlc/adapter-policy-simple';
import { GitHostError, type ModelRef } from '@sdlc/contracts';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DbError } from '../../../packages/core/src/db/errors.js';
import {
  archiveEvaluationPlan,
  changeEvaluationPlan,
  createEvaluationPlan,
  EvaluationError,
  nextScheduledRun,
  planChangeNeedsStepUp,
  startEvaluationPlan,
  type EvaluationPlanDeps,
  type PlanContentInput,
} from '../../../packages/core/src/evaluation/index.js';
import { EVAL_BASE_SHA } from '../evaluation-seed.js';
import { seedPlanWorld, type PlanWorld } from '../plan-seed.js';
import { createTestDatabase, describeDb, type TestDatabase } from './helpers.js';

const NOW = new Date('2026-10-14T08:00:00.000Z');
const PROMPT = 'Run the tests first.\n';
const PROMPT_SHA = createHash('sha256').update(PROMPT, 'utf8').digest('hex');
const HEAD = 'c'.repeat(40);
const MODELS: ModelRef[] = [
  { model: 'gpt-oss-20b', providerType: 'self_hosted' },
  { model: 'qwen3-8b', providerType: 'self_hosted' },
];

type World = PlanWorld;

async function errorCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    if (error instanceof EvaluationError || error instanceof DbError) return error.code;
    throw error;
  }
}

describeDb('L05 PR 2: evaluation plans on PostgreSQL', () => {
  let t: TestDatabase;
  let tenants = 0;
  let files: Map<string, string>;
  let models: ModelRef[];
  beforeAll(async () => {
    t = await createTestDatabase();
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  });

  const deps = (): EvaluationPlanDeps => ({
    policyFactory: (config, list) => createSimplePolicyEngine({ config, models: list }),
    models: () => Promise.resolve(models),
    taskSet: (version) =>
      Promise.resolve(
        version === 1
          ? { version: 1, baseSha: EVAL_BASE_SHA, taskIds: ['feat-tax', 'bug-stock'] }
          : undefined,
      ),
    gitHost: {
      getBranchHead: () => Promise.resolve(HEAD),
      getFileAtCommit: (_ref, path) => {
        const text = files.get(path);
        return text === undefined
          ? Promise.reject(new GitHostError('not_found'))
          : Promise.resolve(text);
      },
    },
    now: () => NOW,
  });

  async function world(): Promise<World> {
    files = new Map([['eval/prompts/short.md', PROMPT]]);
    models = [...MODELS];
    return seedPlanWorld(t.app, `plans-${String(++tenants)}`, NOW);
  }

  const content = (over: Partial<PlanContentInput> = {}): PlanContentInput => ({
    dataClass: 'internal',
    taskSetVersion: 1,
    taskIds: ['feat-tax'],
    runsPerTask: 2,
    budgetPerRunUsd: '2',
    monthlyCapUsd: '5',
    trigger: 'once',
    configurations: [
      { id: 'reg-qwen', agentKey: 'openhands-qwen', maxIterations: 30, maxDurationMin: 20 },
      {
        id: 'oss-short',
        model: 'gpt-oss-20b',
        providerType: 'self_hosted',
        maxIterations: 30,
        maxDurationMin: 20,
        promptPath: 'eval/prompts/short.md',
      },
    ],
    ...over,
  });

  const create = (w: World, over: Partial<PlanContentInput> = {}, code = 'weekly-models') =>
    createEvaluationPlan(w.scope, deps(), {
      projectId: w.projectId,
      code,
      content: content(over),
      userId: w.users.a,
    });

  describe('who', () => {
    it('a person with a role in access.eval_roles creates and runs; others are refused', async () => {
      const w = await world();
      const plan = await create(w);
      expect(plan).toMatchObject({ code: 'weekly-models', status: 'active', current_version: 1 });
      const refuse = (userId: string) =>
        errorCode(
          createEvaluationPlan(w.scope, deps(), {
            projectId: w.projectId,
            code: 'other',
            content: content(),
            userId,
          }),
        );
      expect(await refuse(w.users.viewer)).toBe('forbidden');
      expect(await refuse(w.users.outsider)).toBe('project_not_found');
      expect(
        await errorCode(
          startEvaluationPlan(w.scope, deps(), {
            planId: plan.id,
            actor: { type: 'human', userId: w.users.viewer },
          }),
        ),
      ).toBe('forbidden');
    });

    it('another tenant never sees the plan', async () => {
      const w = await world();
      const plan = await create(w);
      const other = await world();
      expect(await other.scope.evaluationPlans.getById(plan.id)).toBeUndefined();
      expect(
        await errorCode(
          startEvaluationPlan(other.scope, deps(), {
            planId: plan.id,
            actor: { type: 'human', userId: other.users.a },
          }),
        ),
      ).toBe('plan_not_found');
    });
  });

  describe('content', () => {
    it('stores the prompt variant as path, commit and SHA-256 only', async () => {
      const w = await world();
      const plan = await create(w);
      const version = await w.scope.evaluationPlans.getVersion(plan.id, 1);
      expect(version?.configurations[1]).toEqual({
        id: 'oss-short',
        agent_key: null,
        model: 'gpt-oss-20b',
        provider_type: 'self_hosted',
        max_iterations: 30,
        max_duration_min: 20,
        prompt: { path: 'eval/prompts/short.md', commit: HEAD, sha256: PROMPT_SHA },
      });
      expect(JSON.stringify(version)).not.toContain('Run the tests');
    });

    it('refuses what it cannot resolve', async () => {
      const w = await world();
      const code = (over: Partial<PlanContentInput>) => errorCode(create(w, over, 'x'));
      expect(
        await code({
          configurations: [{ id: 'a', agentKey: 'nobody', maxIterations: 30, maxDurationMin: 20 }],
        }),
      ).toBe('agent_not_found');
      expect(
        await code({
          configurations: [
            {
              id: 'a',
              model: 'gpt-oss-20b',
              providerType: 'self_hosted',
              maxIterations: 30,
              maxDurationMin: 20,
              promptPath: 'eval/missing.md',
            },
          ],
        }),
      ).toBe('prompt_not_found');
      expect(
        await code({
          configurations: [
            {
              id: 'a',
              model: 'claude-x',
              providerType: 'api',
              maxIterations: 30,
              maxDurationMin: 20,
            },
          ],
        }),
      ).toBe('model_not_allowed');
      expect(await code({ taskIds: ['nope'] })).toBe('task_not_found');
      expect(await code({ taskSetVersion: 9 })).toBe('task_set_not_found');
      expect(await code({ monthlyCapUsd: '1' })).toBe('invalid_input');
      expect(await code({ dataClass: 'prohibited' })).toBe('invalid_input');
      expect(await code({ trigger: 'schedule', schedule: null })).toBe('invalid_input');
      await create(w, {}, 'dup');
      expect(await errorCode(create(w, {}, 'dup'))).toBe('plan_code_taken');
    });
  });

  describe('versions', () => {
    it('a change writes the next version with the changed fields; a stale one is refused', async () => {
      const w = await world();
      const plan = await create(w);
      const { plan: changed, changed: fields } = await changeEvaluationPlan(w.scope, deps(), {
        planId: plan.id,
        expectedVersion: 1,
        content: content({ runsPerTask: 3, budgetPerRunUsd: '2.5' }),
        userId: w.users.a,
      });
      expect(changed.current_version).toBe(2);
      expect(fields).toEqual(['runs_per_task', 'budget_per_run_usd']);
      expect(
        await errorCode(
          changeEvaluationPlan(w.scope, deps(), {
            planId: plan.id,
            expectedVersion: 1,
            content: content({ runsPerTask: 4 }),
            userId: w.users.a,
          }),
        ),
      ).toBe('plan_changed');
      const audit = (await w.scope.audit.listForEntity(plan.id)).map((e) => e.action);
      expect(audit).toEqual(['evaluation_plan.created', 'evaluation_plan.changed']);
      expect((await w.scope.evaluationPlans.listVersions(plan.id)).map((v) => v.version)).toEqual([
        1, 2,
      ]);
    });

    it('archived is final: no start, no resume, no schedule', async () => {
      const w = await world();
      const plan = await create(w);
      await archiveEvaluationPlan(w.scope, { planId: plan.id, userId: w.users.a });
      expect(
        await errorCode(
          startEvaluationPlan(w.scope, deps(), {
            planId: plan.id,
            actor: { type: 'human', userId: w.users.a },
          }),
        ),
      ).toBe('plan_archived');
      expect(await w.scope.evaluationPlans.resume(plan.id)).toBe(false);
      expect(await w.scope.evaluationPlans.setSchedule(plan.id, { nextRunAt: NOW })).toBe(false);
      expect((await w.scope.evaluationPlans.getById(plan.id))?.status).toBe('archived');
    });

    it('the database refuses changes to fixed columns, archived plans and old versions', async () => {
      const w = await world();
      const plan = await create(w);
      // The app has no grant on the code; the owner is refused by the trigger.
      await expect(
        sql`UPDATE evaluation_plans SET code = 'other' WHERE id = ${plan.id}`.execute(
          t.appAs(w.scope.tenantId),
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        sql`UPDATE evaluation_plans SET code = 'other' WHERE id = ${plan.id}`.execute(t.owner),
      ).rejects.toMatchObject({ code: 'SDA23' });
      await expect(
        sql`UPDATE evaluation_plans SET current_version = 0 WHERE id = ${plan.id}`.execute(
          t.appAs(w.scope.tenantId),
        ),
      ).rejects.toMatchObject({ code: 'SDA23' });
      // Versions are append-only.
      await expect(
        sql`UPDATE evaluation_plan_versions SET runs_per_task = 9 WHERE plan_id = ${plan.id}`.execute(
          t.appAs(w.scope.tenantId),
        ),
      ).rejects.toThrow();
      await archiveEvaluationPlan(w.scope, { planId: plan.id, userId: w.users.a });
      await expect(
        sql`UPDATE evaluation_plans SET status = 'active' WHERE id = ${plan.id}`.execute(
          t.appAs(w.scope.tenantId),
        ),
      ).rejects.toMatchObject({ code: 'SDA23' });
      await expect(
        sql`DELETE FROM evaluation_plans WHERE id = ${plan.id}`.execute(t.owner),
      ).rejects.toThrow();
    });

    it('needs the step-up for a schedule, on_change or a higher budget', () => {
      const base = {
        dataClass: 'internal' as const,
        taskSetVersion: 1,
        taskIds: null,
        runsPerTask: 1,
        budgetPerRunUsd: '1',
        monthlyCapUsd: '5',
        trigger: 'once' as const,
        schedule: null,
        configurations: [],
      };
      expect(planChangeNeedsStepUp(null, base)).toBe(false);
      expect(planChangeNeedsStepUp(null, { ...base, trigger: 'on_change' })).toBe(true);
      expect(planChangeNeedsStepUp(base, { ...base, monthlyCapUsd: '6' })).toBe(true);
      expect(planChangeNeedsStepUp(base, { ...base, budgetPerRunUsd: '0.5' })).toBe(false);
    });
  });

  describe('runs', () => {
    it('starts an evaluation with the resolved configurations and no file', async () => {
      const w = await world();
      const plan = await create(w);
      files.set('eval/prompts/short.md', 'Changed.\n');
      const evaluation = await startEvaluationPlan(w.scope, deps(), {
        planId: plan.id,
        actor: { type: 'human', userId: w.users.a },
      });
      expect(evaluation).toMatchObject({
        config_name: null,
        plan_id: plan.id,
        plan_version: 1,
        budget_usd: '2.000000',
        status: 'queued',
      });
      const configs = await w.scope.evaluations.configurations(evaluation.id);
      expect(configs.map((c) => [c.configuration_id, c.model, c.agent_version])).toEqual([
        ['oss-short', 'gpt-oss-20b', '1.0.0'],
        ['reg-qwen', 'qwen3-8b', '1.0.0'],
      ]);
      // The prompt was read again: the run records the file as it is now.
      expect(configs[0]).toMatchObject({
        instructions_path: 'eval/prompts/short.md',
        instructions_commit: HEAD,
        instructions_sha256: createHash('sha256').update('Changed.\n').digest('hex'),
      });
      expect(configs[1]?.instructions_path).toBeNull();
      expect((await w.scope.evaluationRuns.listForEvaluation(evaluation.id)).length).toBe(4);
      const audit = (await w.scope.audit.listForEntity(plan.id)).map((e) => e.action);
      expect(audit).toContain('evaluation_plan.run_started');
      // One open evaluation per plan.
      expect(
        await errorCode(
          startEvaluationPlan(w.scope, deps(), {
            planId: plan.id,
            actor: { type: 'human', userId: w.users.a },
          }),
        ),
      ).toBe('evaluation_open');
    });

    it('the monthly cap pauses the plan and refuses a start; a cap never goes below the spend', async () => {
      const w = await world();
      const plan = await create(w);
      const evaluation = await startEvaluationPlan(w.scope, deps(), {
        planId: plan.id,
        actor: { type: 'human', userId: w.users.a },
      });
      const [run] = await w.scope.evaluationRuns.listForEvaluation(evaluation.id);
      await w.scope.costRecords.insertIfNew({
        projectId: w.projectId,
        intentId: null,
        runId: null,
        gate: null,
        agent: null,
        model: 'gpt-oss-20b',
        providerType: 'self_hosted',
        inputTokens: 1,
        outputTokens: 1,
        cachedInputTokens: 0,
        costUsd: '5',
        sourceRef: `plan-cap-${evaluation.id}`,
        occurredAt: NOW,
        evaluationRunId: run!.id,
      });
      await w.scope.evaluations.finish(evaluation.id, 'completed', null);
      expect(
        await errorCode(
          startEvaluationPlan(w.scope, deps(), {
            planId: plan.id,
            actor: { type: 'system', reason: 'schedule' },
          }),
        ),
      ).toBe('monthly_cap_used');
      expect(await w.scope.evaluationPlans.getById(plan.id)).toMatchObject({
        status: 'paused',
        pause_reason: 'monthly_cap_used',
        paused_until: new Date('2026-11-01T00:00:00.000Z'),
      });
      expect(
        await errorCode(
          changeEvaluationPlan(w.scope, deps(), {
            planId: plan.id,
            expectedVersion: 1,
            content: content({ monthlyCapUsd: '4' }),
            userId: w.users.a,
          }),
        ),
      ).toBe('cap_below_spent');
      // A higher cap ends the pause.
      await changeEvaluationPlan(w.scope, deps(), {
        planId: plan.id,
        expectedVersion: 1,
        content: content({ monthlyCapUsd: '8' }),
        userId: w.users.a,
      });
      expect((await w.scope.evaluationPlans.getById(plan.id))?.status).toBe('active');
    });

    it('a schedule sets the next run in UTC', async () => {
      const w = await world();
      const plan = await create(w, {
        trigger: 'schedule',
        schedule: { every: 'weekly', hour: 6, weekday: 1 },
      });
      expect(plan.next_run_at).toEqual(new Date('2026-10-19T06:00:00.000Z'));
      expect(nextScheduledRun({ every: 'daily', hour: 9, weekday: null }, NOW)).toEqual(
        new Date('2026-10-14T09:00:00.000Z'),
      );
      expect(nextScheduledRun({ every: 'daily', hour: 8, weekday: null }, NOW)).toEqual(
        new Date('2026-10-15T08:00:00.000Z'),
      );
    });

    it('the operator evaluation of L04 still needs its configuration file and no plan', async () => {
      const w = await world();
      expect(
        await errorCode(
          w.scope.evaluations.create({
            projectId: w.projectId,
            dataClass: 'internal',
            taskSetVersion: 1,
            configName: null,
            baseSha: EVAL_BASE_SHA,
            taskIds: ['feat-tax'],
            configurations: [
              {
                id: 'a',
                model: 'gpt-oss-20b',
                providerType: 'self_hosted',
                agentVersion: '1.0.0',
                maxIterations: 1,
                maxDurationMin: 1,
              },
            ],
            runsPerTask: 1,
            budgetUsd: '1',
            startedBy: null,
          }),
        ),
      ).toBe('invalid_value');
    });
  });
});
