// D-08 L04 (PR 3) on a live PostgreSQL (design/ADR-M81 §2.2–§2.7; D-05 §6.8; QUESTIONS #460–#464):
// - AC3 tables: evaluations, runs and results have their own tables with codes and numbers only,
//   per tenant; the results are append-only; the status moves only forward (triggers SDA21, SDA22);
// - AC2 budget: the cost of an evaluation's runs is read from the cost records; the key cap is what
//   is left; the evaluation stops `stopped_budget` when it is used up; the budget only goes up;
//   evaluation costs never appear in the cost report of intents;
// - AC4 data classes: `prohibited` never, the project's AI record decides, `client_restricted` goes
//   to self-hosted models only, a model the policy does not allow is refused;
// - `adlc ops eval start` queues an evaluation as the system, with an audit event of IDs and codes.
import path from 'node:path';

import { createSimplePolicyEngine } from '@sdlc/adapter-policy-simple';
import { t } from '@sdlc/messages';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EXIT, processContext, runCli, type CliContext } from '../../../apps/cli/src/index.js';
import { DbError } from '../../../packages/core/src/db/errors.js';
import type { TenantScope } from '../../../packages/core/src/db/tenant-scope.js';
import { parseTenantId } from '../../../packages/core/src/db/tenant-id.js';
import type { NewEvaluationRunResult } from '../../../packages/core/src/db/repositories/evaluation-runs.js';
import {
  EvaluationError,
  evaluationBudget,
  nextRunKeyCap,
  startEvaluation,
  stopEvaluationIfBudgetUsed,
  type EvaluationErrorCode,
  type EvaluationPolicyFactory,
  type StartEvaluationInput,
} from '../../../packages/core/src/evaluation/index.js';
import { repoRoot } from '../../workspace/helpers';
import { createTestDatabase, describeDb, urlFor, type TestDatabase } from './helpers.js';

const NOW = new Date('2026-10-14T08:00:00.000Z');
const HARDWARE = {
  cpu_model: 'Apple M4 Pro',
  cpu_cores: 12,
  memory_gb: 24,
  docker_version: '29.8.2',
  gpu: null,
  runner_instance: 'runner-1',
};
const RESULT: NewEvaluationRunResult = {
  instructions_sha256: 'a'.repeat(64),
  outcome: 'finished',
  status: 'succeeded',
  stop_reason: null,
  applied: true,
  resolved: true,
  fail_to_pass_passed: true,
  pass_to_pass_passed: true,
  ci_passed: true,
  scope_breach: false,
  out_of_plan_files: 0,
  lint_findings: 0,
  diff_files: 2,
  diff_lines_added: 20,
  diff_lines_removed: 3,
  seconds: 90,
  iterations: 7,
  model_calls: 7,
  input_tokens: 1000,
  output_tokens: 200,
  cached_input_tokens: 0,
  cost_usd: '0.012300',
  hardware: HARDWARE,
};
const SELF_HOSTED = {
  id: 'gpt-oss-20b',
  model: 'gpt-oss-20b',
  providerType: 'self_hosted',
  agentVersion: '1.0.0',
  maxIterations: 30,
  maxDurationMin: 20,
} as const;
const API = {
  id: 'haiku',
  model: 'claude-haiku-4-5-20251001',
  providerType: 'api',
  agentVersion: '1.0.0',
  maxIterations: 30,
  maxDurationMin: 20,
} as const;

const policyFactory: EvaluationPolicyFactory = (config, models) =>
  createSimplePolicyEngine({ config, models });

describeDb('L04 PR 3: evaluations on PostgreSQL', () => {
  let db: TestDatabase;
  let scope: TenantScope;
  let other: TenantScope;
  let projectId: string;
  let bareProject: string;

  const input = (over: Partial<StartEvaluationInput> = {}): StartEvaluationInput => ({
    projectId,
    dataClass: 'internal',
    taskSetVersion: 1,
    configName: 'local',
    baseSha: '7'.repeat(40),
    taskIds: ['feat-tax', 'bug-merge-order'],
    configurations: [SELF_HOSTED],
    runsPerTask: 2,
    budgetUsd: '1',
    startedBy: null,
    now: NOW,
    ...over,
  });
  const start = (over: Partial<StartEvaluationInput> = {}, s: TenantScope = scope) =>
    startEvaluation(s, input(over), { policyFactory });
  const refusal = async (promise: Promise<unknown>): Promise<EvaluationErrorCode> => {
    const error = await promise.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(EvaluationError);
    return (error as EvaluationError).code;
  };

  /** A tenant with a project `shop` whose AI record allows internal and client_restricted data. */
  async function seedTenant(
    slug: string,
  ): Promise<{ scope: TenantScope; projectId: string; userId: string }> {
    const tenant = await db.app.system.createTenant({ slug, name: slug, monthlyBudgetUsd: null });
    const tenantScope = db.app.forTenant(parseTenantId(tenant.id));
    const project = await tenantScope.projects.create({
      slug: 'shop',
      name: 'Shop',
      git_provider: 'github',
      repo_full_name: `org/${slug}`,
    });
    const user = await tenantScope.users.create({
      display_name: 'pam',
      email: `pam@${slug}.example.com`,
    });
    await tenantScope.projectAiRecords.save(project.id, {
      aiAllowed: 'yes',
      allowedDataClasses: ['internal', 'client_restricted'],
      prodLogsAllowed: 'no',
      disclosureFormat: 'standard_note',
      confirmedAt: null,
      recordRef: null,
      updatedBy: user.id,
      expectedVersion: 0,
      actorType: 'human',
      today: '2026-10-14',
    });
    return { scope: tenantScope, projectId: project.id, userId: user.id };
  }

  beforeAll(async () => {
    db = await createTestDatabase();
    ({ scope, projectId } = await seedTenant('acme'));
    other = (await seedTenant('beta')).scope;
    bareProject = (
      await scope.projects.create({
        slug: 'bare',
        name: 'Bare',
        git_provider: 'github',
        repo_full_name: 'org/bare',
      })
    ).id;
  }, 60_000);

  afterAll(async () => {
    await db?.drop();
  });

  describe('starting an evaluation', () => {
    it('queues one run per configuration × task × run number, with an audit event of codes', async () => {
      const evaluation = await start({
        configurations: [SELF_HOSTED, { ...SELF_HOSTED, id: 'qwen', model: 'qwen3-8b' }],
      });
      expect(evaluation).toMatchObject({
        code: 'EVAL-2026-0001',
        status: 'queued',
        data_class: 'internal',
        runs_per_task: 2,
        config_name: 'local',
        started_by: null,
      });
      const runs = await scope.evaluationRuns.listForEvaluation(evaluation.id);
      expect(runs).toHaveLength(2 * 2 * 2);
      expect(runs.every((r) => r.status === 'queued' && r.attempt === 1)).toBe(true);
      expect(new Set(runs.map((r) => r.model))).toEqual(new Set(['gpt-oss-20b', 'qwen3-8b']));
      const [audit] = await scope.audit.listForEntity(evaluation.id, ['evaluation.started']);
      expect(audit).toMatchObject({ actor_type: 'system', actor_id: null });
      expect(audit!.payload).toEqual({
        project_id: projectId,
        code: 'EVAL-2026-0001',
        data_class: 'internal',
        task_set_version: 1,
        config_name: 'local',
        runs_total: 8,
        budget_usd: '1',
      });
    });

    it('numbers evaluations per tenant and year', async () => {
      expect((await start()).code).toBe('EVAL-2026-0002');
      const otherProject = (await other.projects.list())[0]!.id;
      const first = await startEvaluation(
        other,
        input({ projectId: otherProject, now: new Date('2027-01-02T00:00:00Z') }),
        { policyFactory },
      );
      expect(first.code).toBe('EVAL-2027-0001');
    });

    it('keeps tenants apart: another tenant sees nothing and cannot use the project', async () => {
      const [mine] = await scope.evaluations.list({ limit: 1 });
      expect(await other.evaluations.getById(mine!.id)).toBeUndefined();
      expect(await other.evaluationRuns.listForEvaluation(mine!.id)).toEqual([]);
      expect((await other.evaluations.list({ limit: 50 })).map((e) => e.code)).toEqual([
        'EVAL-2027-0001',
      ]);
      expect(await refusal(start({}, other))).toBe('project_not_found');
    });

    it.each([
      [
        'a data class that is prohibited',
        { dataClass: 'prohibited' as const },
        'data_class_prohibited',
      ],
      ['a project without an AI record', { projectId: '' }, 'ai_record_missing'],
      [
        'a data class the AI record does not allow',
        { dataClass: 'public' as const },
        'data_class_not_allowed',
      ],
      [
        'an API model for client_restricted data',
        { dataClass: 'client_restricted' as const, configurations: [API] },
        'self_hosted_only',
      ],
      ['zero runs', { runsPerTask: 0 }, 'invalid_input'],
      ['a budget of zero', { budgetUsd: '0' }, 'invalid_input'],
      ['a budget that is not USD', { budgetUsd: '1e3' }, 'invalid_input'],
      ['a repeated task', { taskIds: ['feat-tax', 'feat-tax'] }, 'invalid_input'],
      ['a task code with a space', { taskIds: ['feat tax'] }, 'invalid_input'],
      [
        'too many runs',
        {
          runsPerTask: 50,
          taskIds: Array.from({ length: 64 }, (_, i) => `t${String(i)}`),
          configurations: [SELF_HOSTED, { ...SELF_HOSTED, id: 'b' }],
        },
        'invalid_input',
      ],
    ] as const)('refuses %s', async (_name, over, code) => {
      const resolved =
        'projectId' in over && over.projectId === '' ? { ...over, projectId: bareProject } : over;
      expect(await refusal(start(resolved as Partial<StartEvaluationInput>))).toBe(code);
    });

    it('refuses a model the policy does not allow, an unknown project and an archived one', async () => {
      const nothingAllowed = (config: Parameters<typeof policyFactory>[0]) =>
        createSimplePolicyEngine({ config, models: [] });
      expect(
        await refusal(startEvaluation(scope, input(), { policyFactory: nothingAllowed })),
      ).toBe('model_not_allowed');
      expect(await refusal(start({ projectId: '11111111-1111-4111-8111-111111111111' }))).toBe(
        'project_not_found',
      );
      const archived = (
        await scope.projects.create({
          slug: 'old',
          name: 'Old',
          git_provider: 'github',
          repo_full_name: 'o/old',
        })
      ).id;
      await scope.projects.setStatus(archived, 'archived');
      expect(await refusal(start({ projectId: archived }))).toBe('project_not_active');
    });

    it('allows client_restricted data on self-hosted models', async () => {
      const evaluation = await start({ dataClass: 'client_restricted' });
      expect(evaluation.data_class).toBe('client_restricted');
    });

    it('refuses a prohibited data class in the database too, and writes nothing for a refusal', async () => {
      await expect(
        sql`INSERT INTO evaluations (tenant_id, project_id, code, data_class, task_set_version, config_name, task_ids, configuration_ids, runs_per_task, budget_usd)
            VALUES (${scope.tenantId}, ${projectId}, 'EVAL-2026-9999', 'prohibited', 1, 'local', '{a}', '{b}', 1, 1)`.execute(
          db.owner,
        ),
      ).rejects.toThrow();
      expect(await scope.evaluations.getByCode('EVAL-2026-9999')).toBeUndefined();
    });
  });

  describe('runs and results', () => {
    // A tenant of its own, so the queue holds only the runs of these tests.
    let q: TenantScope;
    let qProject: string;
    let scoredRunId = '';
    const begin = (over: Partial<StartEvaluationInput> = {}) =>
      startEvaluation(q, input({ projectId: qProject, ...over }), { policyFactory });

    beforeAll(async () => {
      ({ scope: q, projectId: qProject } = await seedTenant('gamma'));
    });

    it('claims queued runs once, moves the evaluation to running, and keeps a preempted attempt out of the results', async () => {
      const evaluation = await begin({ taskIds: ['feat-tax'], runsPerTask: 1 });
      const [claimed, ...none] = await q.evaluationRuns.claimQueued(5, 'runner-1');
      expect(none).toEqual([]);
      expect(claimed).toMatchObject({ status: 'running', attempt: 1, runner_instance: 'runner-1' });
      expect(await q.evaluationRuns.claimQueued(5, 'runner-2')).toEqual([]);
      expect((await q.evaluations.getById(evaluation.id))!.status).toBe('running');

      // A real run needs the slot: stop, queue again with the next attempt, no result for attempt 1.
      expect(await q.evaluationRuns.markPreempted(claimed!.id)).toBe(true);
      expect(await q.evaluationRuns.markPreempted(claimed!.id)).toBe(false);
      await expect(q.evaluationRuns.recordResult(claimed!.id, RESULT)).rejects.toThrow(
        /not running/,
      );
      expect(await q.evaluationRuns.requeue(claimed!.id)).toBe(true);
      expect(await q.evaluationRuns.getById(claimed!.id)).toMatchObject({
        status: 'queued',
        attempt: 2,
        runner_instance: null,
        started_at: null,
      });
      const [second] = await q.evaluationRuns.claimQueued(5, 'runner-2');
      expect(second).toMatchObject({
        id: claimed!.id,
        status: 'running',
        attempt: 2,
        runner_instance: 'runner-2',
      });

      const row = await q.evaluationRuns.recordResult(second!.id, RESULT);
      expect(row).toMatchObject({
        attempt: 2,
        resolved: true,
        hw_cpu_model: 'Apple M4 Pro',
        hw_runner_instance: 'runner-1',
      });
      expect(await q.evaluationRuns.getById(second!.id)).toMatchObject({ status: 'scored' });
      const results = await q.evaluationRuns.resultsForEvaluation(evaluation.id);
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        configuration_id: 'gpt-oss-20b',
        task_id: 'feat-tax',
        run_index: 1,
      });
      expect(await scope.evaluationRuns.resultsForEvaluation(evaluation.id)).toEqual([]);
      scoredRunId = second!.id;
    });

    it('the results are append-only: no second result, no update, no delete', async () => {
      const [result] = await q.evaluationRuns.resultsForEvaluation(
        (await q.evaluationRuns.getById(scoredRunId))!.evaluation_id,
      );
      await expect(
        sql`UPDATE evaluation_run_results SET resolved = false WHERE id = ${result!.id}`.execute(
          db.appAs(q.tenantId),
        ),
      ).rejects.toThrow();
      await expect(
        sql`DELETE FROM evaluation_run_results WHERE id = ${result!.id}`.execute(
          db.appAs(q.tenantId),
        ),
      ).rejects.toThrow();
      // Even the owner role cannot: the trigger refuses it.
      await expect(
        sql`UPDATE evaluation_run_results SET resolved = false WHERE id = ${result!.id}`.execute(
          db.owner,
        ),
      ).rejects.toThrow();
      await expect(q.evaluationRuns.recordResult(scoredRunId, RESULT)).rejects.toThrow();
    });

    it('a finished run never changes, and no move outside the machine is allowed', async () => {
      const evaluation = await begin({ taskIds: ['feat-tax'], runsPerTask: 1 });
      const [queued] = await q.evaluationRuns.listForEvaluation(evaluation.id);
      // queued → scored is not a move.
      await expect(
        sql`UPDATE evaluation_runs SET status = 'scored', finished_at = now() WHERE id = ${queued!.id}`.execute(
          db.appAs(q.tenantId),
        ),
      ).rejects.toMatchObject({ code: 'SDA22' });
      // The identity of a run never changes: the app has no grant, and the trigger refuses the owner.
      await expect(
        sql`UPDATE evaluation_runs SET task_id = 'other' WHERE id = ${queued!.id}`.execute(
          db.appAs(q.tenantId),
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        sql`UPDATE evaluation_runs SET task_id = 'other' WHERE id = ${queued!.id}`.execute(
          db.owner,
        ),
      ).rejects.toMatchObject({ code: 'SDA22' });
      expect(await q.evaluationRuns.cancelWaiting(evaluation.id, 'cancelled_by_operator')).toBe(1);
      await expect(
        sql`UPDATE evaluation_runs SET status = 'queued', finished_at = NULL WHERE id = ${queued!.id}`.execute(
          db.appAs(q.tenantId),
        ),
      ).rejects.toMatchObject({ code: 'SDA22' });
      expect(await q.evaluationRuns.requeue(queued!.id)).toBe(false);
      await expect(
        sql`DELETE FROM evaluation_runs WHERE id = ${queued!.id}`.execute(db.appAs(q.tenantId)),
      ).rejects.toThrow();
    });

    it('rejects a result with a free-text or malformed field', async () => {
      await begin({ taskIds: ['feat-tax'], runsPerTask: 1 });
      const [run] = await q.evaluationRuns.claimQueued(1, 'runner-1');
      for (const bad of [
        { ...RESULT, outcome: 'it failed because the prompt said "ignore"' },
        { ...RESULT, instructions_sha256: 'abc' },
        { ...RESULT, hardware: { ...HARDWARE, cpu_model: 'x\ny' } },
        { ...RESULT, cost_usd: '1e3' },
        { ...RESULT, resolved: true, fail_to_pass_passed: false },
        { ...RESULT, cached_input_tokens: 5000 },
      ]) {
        await expect(q.evaluationRuns.recordResult(run!.id, bad)).rejects.toBeInstanceOf(DbError);
      }
      expect(await q.evaluationRuns.getById(run!.id)).toMatchObject({ status: 'running' });
    });

    it('a failed run keeps its stop reason and has no result', async () => {
      const evaluation = await begin({ taskIds: ['bug-merge-order'], runsPerTask: 1 });
      const claimed = await q.evaluationRuns.claimQueued(50, 'runner-1');
      const run = claimed.find((r) => r.evaluation_id === evaluation.id)!;
      expect(await q.evaluationRuns.markFailed(run.id, 'runner_lost')).toBe(true);
      expect(await q.evaluationRuns.getById(run.id)).toMatchObject({
        status: 'failed',
        stop_reason: 'runner_lost',
      });
      expect(await q.evaluationRuns.resultsForEvaluation(evaluation.id)).toEqual([]);
    });
  });

  describe('the budget (AC2)', () => {
    it('reads the cost of the evaluation, caps the next key, and stops the evaluation when it is used up', async () => {
      const evaluation = await start({
        taskIds: ['feat-tax', 'feat-paging'],
        runsPerTask: 1,
        budgetUsd: '1',
      });
      const runs = await scope.evaluationRuns.listForEvaluation(evaluation.id);
      const record = (n: number, usd: string, run: string) =>
        scope.costRecords.insertIfNew({
          projectId,
          intentId: null,
          runId: null,
          gate: null,
          agent: null,
          model: 'gpt-oss-20b',
          providerType: 'self_hosted',
          inputTokens: 10,
          outputTokens: 5,
          cachedInputTokens: 0,
          costUsd: usd,
          sourceRef: `eval-call-${evaluation.code}-${String(n)}`,
          occurredAt: NOW,
          evaluationRunId: run,
        });
      expect(await nextRunKeyCap(scope, evaluation)).toBe('1');
      await record(1, '0.6', runs[0]!.id);
      expect(await evaluationBudget(scope, evaluation)).toEqual({
        budgetUsd: '1',
        spentUsd: '0.6',
        remainingUsd: '0.4',
        used: false,
      });
      expect(await nextRunKeyCap(scope, evaluation)).toBe('0.4');
      expect(await stopEvaluationIfBudgetUsed(scope, evaluation.id)).toBe(false);

      await record(2, '0.5', runs[1]!.id);
      expect(await nextRunKeyCap(scope, evaluation)).toBeNull();
      expect((await evaluationBudget(scope, evaluation)).remainingUsd).toBe('0');
      expect(await stopEvaluationIfBudgetUsed(scope, evaluation.id)).toBe(true);
      expect(await stopEvaluationIfBudgetUsed(scope, evaluation.id)).toBe(false);

      expect(await scope.evaluations.getById(evaluation.id)).toMatchObject({
        status: 'stopped_budget',
        stop_reason: 'budget_used',
      });
      const after = await scope.evaluationRuns.listForEvaluation(evaluation.id);
      expect(after.every((r) => r.status === 'cancelled' && r.stop_reason === 'budget_used')).toBe(
        true,
      );
      const [finished] = await scope.audit.listForEntity(evaluation.id, ['evaluation.finished']);
      expect(finished!.payload).toEqual({
        status: 'stopped_budget',
        stop_reason: 'budget_used',
        runs_scored: 0,
        runs_failed: 0,
        runs_cancelled: 2,
        cost_usd: '1.1',
      });
      // A final evaluation never changes again.
      await expect(
        sql`UPDATE evaluations SET status = 'running', finished_at = NULL WHERE id = ${evaluation.id}`.execute(
          db.appAs(scope.tenantId),
        ),
      ).rejects.toMatchObject({ code: 'SDA21' });
    });

    it('the budget only goes up, and the fixed columns never change', async () => {
      const evaluation = await start({ budgetUsd: '2' });
      await expect(
        sql`UPDATE evaluations SET budget_usd = 1 WHERE id = ${evaluation.id}`.execute(
          db.appAs(scope.tenantId),
        ),
      ).rejects.toMatchObject({ code: 'SDA21' });
      await sql`UPDATE evaluations SET budget_usd = 3 WHERE id = ${evaluation.id}`.execute(
        db.appAs(scope.tenantId),
      );
      await expect(
        sql`UPDATE evaluations SET runs_per_task = 9 WHERE id = ${evaluation.id}`.execute(
          db.appAs(scope.tenantId),
        ),
      ).rejects.toThrow();
      await expect(
        sql`DELETE FROM evaluations WHERE id = ${evaluation.id}`.execute(db.appAs(scope.tenantId)),
      ).rejects.toThrow();
    });

    it('a cost record belongs to an intent or an evaluation run, never both; evaluations stay out of the cost report', async () => {
      const evaluation = await start({ budgetUsd: '5', taskIds: ['feat-tax'], runsPerTask: 1 });
      const [run] = await scope.evaluationRuns.listForEvaluation(evaluation.id);
      const base = {
        projectId,
        gate: null,
        agent: null,
        model: 'gpt-oss-20b',
        providerType: 'self_hosted' as const,
        inputTokens: 1,
        outputTokens: 1,
        cachedInputTokens: 0,
        costUsd: '0.25',
        occurredAt: NOW,
      };
      await expect(
        scope.costRecords.insertIfNew({
          ...base,
          intentId: '22222222-2222-4222-8222-222222222222',
          runId: null,
          sourceRef: 'both-1',
          evaluationRunId: run!.id,
        }),
      ).rejects.toBeInstanceOf(DbError);
      await scope.costRecords.insertIfNew({
        ...base,
        intentId: null,
        runId: null,
        sourceRef: 'only-eval-1',
        evaluationRunId: run!.id,
      });
      expect(await scope.costRecords.totalForEvaluation(evaluation.id)).toBe('0.250000');
      const totals = await scope.costRecords.reportTotals({
        from: new Date('2026-10-01T00:00:00Z'),
        to: new Date('2026-11-01T00:00:00Z'),
        wastedStatuses: ['failed'],
      });
      expect(totals.calls).toBe('0');
      // A record of another tenant's evaluation run is refused by the foreign key.
      await expect(
        other.costRecords.insertIfNew({
          ...base,
          projectId: (await other.projects.list())[0]!.id,
          intentId: null,
          runId: null,
          sourceRef: 'x-1',
          evaluationRunId: run!.id,
        }),
      ).rejects.toThrow();
    });
  });

  describe('adlc ops eval start (QUESTIONS #464)', () => {
    async function cli(argv: string[]) {
      const out: string[] = [];
      const err: string[] = [];
      const ctx: CliContext = {
        env: { SDLC_DB_URL: urlFor(db.name, 'platform_app') },
        stdout: (line) => out.push(line),
        stderr: (line) => err.push(line),
        connect: processContext().connect,
        cwd: repoRoot(),
      };
      const code = await runCli(argv, ctx);
      return { code, out: out.join('\n'), err: err.join('\n') };
    }
    const stub = path.join(repoRoot(), 'platform/eval/configs/stub.yaml');
    const args = (...extra: string[]) => [
      'ops',
      'eval',
      'start',
      '--tenant',
      'acme',
      '--project',
      'shop',
      '--config',
      stub,
      '--budget',
      '2',
      ...extra,
    ];

    it('queues the runs as the system and prints the code, never a path or a task', async () => {
      const { code, out, err } = await cli(
        args('--tasks', 'feat-tax,feat-paging', '--n', '3', '--json'),
      );
      expect(code, err).toBe(EXIT.ok);
      const printed = JSON.parse(out) as { evaluation: string; runs: number; data_class: string };
      expect(printed).toMatchObject({ runs: 6, data_class: 'internal' });
      const evaluation = (await scope.evaluations.getByCode(printed.evaluation))!;
      expect(evaluation).toMatchObject({
        config_name: 'stub',
        task_ids: ['feat-paging', 'feat-tax'].sort(),
        configuration_ids: ['stub'],
      });
      expect(
        (await scope.evaluationRuns.listForEvaluation(evaluation.id)).every(
          (r) => r.provider_type === 'self_hosted' && r.model === 'stub-model',
        ),
      ).toBe(true);
      expect(out).not.toContain(repoRoot());
    });

    it('prints a line for people', async () => {
      const { code, out } = await cli(args('--tasks', 'feat-tax', '--n', '1'));
      expect(code).toBe(EXIT.ok);
      expect(out).toMatch(/^Evaluation EVAL-2026-\d{4} queued for project shop: 1 runs/);
    });

    it('refuses with a message from the catalog: prohibited data, a missing AI record, an unknown project', async () => {
      const prohibited = await cli(args('--data-class', 'prohibited'));
      expect(prohibited).toMatchObject({
        code: EXIT.failed,
        err: t('cli.ops.eval.error.data_class_prohibited'),
      });
      const unknown = await cli([
        'ops',
        'eval',
        'start',
        '--tenant',
        'acme',
        '--project',
        'nope',
        '--config',
        stub,
        '--budget',
        '2',
      ]);
      expect(unknown).toMatchObject({
        code: EXIT.failed,
        err: t('cli.ops.eval.error.project_not_found'),
      });
      const bare = await cli([
        'ops',
        'eval',
        'start',
        '--tenant',
        'acme',
        '--project',
        'bare',
        '--config',
        stub,
        '--budget',
        '2',
      ]);
      expect(bare).toMatchObject({
        code: EXIT.failed,
        err: t('cli.ops.eval.error.ai_record_missing'),
      });
    });

    it('prints the usage for missing or bad options and a clear error for a bad file', async () => {
      expect((await cli(['ops', 'eval', 'start', '--tenant', 'acme'])).code).toBe(EXIT.usage);
      expect((await cli(args('--budget', 'lots'))).code).toBe(EXIT.usage);
      expect((await cli(args('--n', '0.5'))).code).toBe(EXIT.usage);
      const missing = await cli([
        'ops',
        'eval',
        'start',
        '--tenant',
        'acme',
        '--project',
        'shop',
        '--config',
        '/nope.yaml',
        '--budget',
        '2',
      ]);
      expect(missing.code).toBe(EXIT.failed);
      expect(missing.err).toContain('could not be read');
    });
  });
});
