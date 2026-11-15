// D-08 C07 PR 2 on a live PostgreSQL, without Temporal (design/ADR-M34 §2.8–§2.9, QUESTIONS #21,
// #82, #130–#134, D-09 N1 and N3). The test plays the runner: it ends the run and appends the run
// events the runner records (`diff_stored`, `changes_checked`); `prepareRun` records `key_issued`.
// - AC1 (N1): files outside the plan → G5 `fail out_of_scope` → back to G3, HITL at every tier;
//   the same plan is refused, a new plan is approved;
// - instruction files → `fail instructions_unpinned`, paused, a `security` escalation (#132);
// - AC2 (N3): the cost cap, or a synced spend at the stop share → `fail budget_exceeded`, paused, an
//   `intent` escalation at `pause`; the iteration cap, the time cap and a stall → `run_cap_reached`;
// - AC3 (#133): `resume` with `budget_increase_usd` raises the intent budget and the next run's
//   cap (only through a decision that names it; a comment never does); without it, nothing grows;
//   an expired or mismatched decision is voided; the database refuses a budget that goes down;
// - decision A: `modify` → G3 HITL, the same plan allowed; decision B: `terminate` → `cancelled`;
// - decision C: the runner's budget warning writes the run event and the notice together;
// - a succeeded run in scope passes (HOTL) to G6; FR-11: the run's producer never decides G5;
// - H05 (ADR-M95, QUESTIONS #456, #601–#604): a change at the review limits passes; over them, or
//   not measured, G5 is HITL with a waiting cause; an approval needs an allowing reason code; a
//   request for changes splits the plan at G3.
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { decideGate } from '../../../packages/core/src/commands/gate-command.js';
import { DbError } from '../../../packages/core/src/db/errors.js';
import type { Intent } from '../../../packages/core/src/db/schema.js';
import {
  acknowledgeEscalation,
  closeEscalation,
  decideEscalation,
} from '../../../packages/core/src/escalation/decide.js';
import { recordBudgetWarning } from '../../../packages/core/src/run-events/budget-warning.js';
import { renderIntentNotice } from '../../../packages/core/src/git-events/intent-notices.js';
import { finishRun, startRun } from '../../../packages/core/src/workflow/run-lifecycle.js';
import {
  atG4,
  decideAt,
  HOUR,
  harness,
  MODEL,
  BASE_1,
  notices,
  T0,
  type Harness,
  waitingFor,
} from '../g4-harness.js';
import { LATER_WALL_CLOCK, withWallClock } from '../wall-clock.js';
import { createTestDatabase, describeDb, type TestDatabase } from './helpers.js';

const DAY = 24 * HOUR;
const PATHS = 'a'.repeat(64);
const DIFF = 'd'.repeat(64);

type RunEnd =
  | { status: 'succeeded' }
  | { status: 'stopped_budget'; reason: 'max_budget' | 'max_iterations' }
  | { status: 'stopped_timeout'; reason: 'max_duration' }
  | { status: 'stopped_stalled'; reason: 'agent_stuck' };

interface Changes {
  readonly outOfScope?: number;
  readonly instructionFiles?: number;
  /** H04: the runner's secret scan; `none` records no `secrets_scanned` event. */
  readonly secrets?: 'clean' | 'found' | 'failed' | 'none';
  /** H05: the review size (`diff_measured`); `failed` or `none` (no event): not measured. */
  readonly review?: { readonly files: number; readonly lines: number } | 'failed' | 'none';
}

describeDb('C07 PR 2: gate G5 on PostgreSQL', () => {
  let db: TestDatabase;
  let t: Harness;
  let source = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    t = await harness(db);
  }, 60_000);

  afterAll(async () => {
    await t?.f.close();
    await db?.drop();
  });

  beforeEach(async () => {
    t.setClock(T0);
    Object.assign(t.world, { base: BASE_1, models: [MODEL], gitDown: false, tenantBudget: null });
    t.calls.keys.length = 0;
    t.calls.revoked.length = 0;
    await t.setConfig(`run:\n  agent_key: ${t.agent.key}\n`);
  });

  const reload = (intent: Intent) => t.reload(intent);
  /** The escalation actions on the test clock (the registry's). */
  const clockDeps = { now: () => t.f.registry.now() };
  const g5 = async (intent: Intent) =>
    (await t.f.scope.gateDecisions.listForIntent(intent.id, 'G5')).map((d) => [
      d.decision,
      d.reason_code,
      d.oversight_mode,
    ]);
  const checks = async (intent: Intent) =>
    (await t.f.scope.audit.listForEntity(intent.id, ['gate.g5_check_failed'])).map(
      (e) => (e.payload as { check: string }).check,
    );

  /** Starts a run of an intent decided at G4, plays the runner, and finishes it (→ G5). */
  async function runToG5(intent: Intent, end: RunEnd, changes: Changes = {}): Promise<string> {
    expect(await t.settleRuns(intent)).toEqual({ outcome: 'run_prepare' });
    const started = await startRun(t.f.scope, t.runDeps, intent.id);
    if (!started.ok) throw new Error(`not started: ${started.reason}`);
    const runId = started.run.runId;
    const now = new Date();
    await t.f.scope.runs.claimForProvisioning(runId, now);
    await t.f.scope.runs.transition(runId, { from: ['provisioning'], to: 'running', now });
    await t.f.scope.runEvents.append(runId, 'diff_stored', {
      sha256: DIFF,
      size_bytes: 120,
      changed_files: 2,
    });
    await t.f.scope.runEvents.append(runId, 'changes_checked', {
      changed_files: 2,
      out_of_scope: changes.outOfScope ?? 0,
      instruction_files: changes.instructionFiles ?? 0,
      paths_sha256: PATHS,
    });
    const secrets = changes.secrets ?? 'clean';
    if (secrets !== 'none') {
      await t.f.scope.runEvents.append(runId, 'secrets_scanned', {
        result: secrets,
        findings: secrets === 'found' ? 2 : 0,
        rules: 'built_in',
        ...(secrets === 'found' ? { rule_ids: 'aws-access-token:private-key' } : {}),
        ...(secrets === 'failed' ? { cause: 'scanner_missing' } : {}),
      });
    }
    const review = changes.review ?? { files: 2, lines: 30 };
    if (review === 'failed') {
      await t.f.scope.runEvents.append(runId, 'diff_measured', {
        result: 'failed',
        cause: 'numstat_failed',
      });
    } else if (review !== 'none') {
      await t.f.scope.runEvents.append(runId, 'diff_measured', {
        result: 'measured',
        review_files: review.files,
        review_lines: review.lines,
        generated_files: 1,
        generated_lines: 4000,
        binary_files: 0,
      });
    }
    await t.f.scope.runs.transition(runId, {
      from: ['running'],
      to: end.status,
      now,
      ...('reason' in end ? { stopReason: end.reason } : {}),
      finishedAt: now,
    });
    expect(await t.settleRuns(intent)).toEqual({ outcome: 'run_ended', runId });
    await finishRun(t.f.scope, t.runDeps, intent.id, runId);
    expect(await reload(intent)).toMatchObject({ status: 'in_gate', current_gate: 'G5' });
    return runId;
  }

  async function spend(intent: Intent, runId: string, usd: string): Promise<void> {
    source += 1;
    await t.f.scope.costRecords.insertIfNew({
      projectId: t.f.target.projectId,
      intentId: intent.id,
      runId,
      gate: 'G4',
      agent: t.agent.key,
      model: MODEL,
      providerType: 'self_hosted',
      inputTokens: 100,
      outputTokens: 10,
      cachedInputTokens: 0,
      costUsd: usd,
      sourceRef: `req-${String(source)}`,
      occurredAt: T0,
    });
  }

  async function g5Escalation(intent: Intent) {
    const escalation = (await t.f.scope.escalations.listForIntent(intent.id)).at(-1);
    if (!escalation) throw new Error('no escalation');
    return escalation;
  }

  async function decide(
    intent: Intent,
    who: 'a' | 'b',
    decision: 'resume' | 'modify' | 'roll_back' | 'terminate',
    extra: { actions?: ('run_start' | 'budget_increase')[]; budgetIncreaseUsd?: string } = {},
  ) {
    const escalation = await g5Escalation(intent);
    await acknowledgeEscalation(
      t.f.scope,
      {
        escalationId: escalation.id,
        actorId: t.f.users[who],
      },
      clockDeps,
    );
    await decideEscalation(
      t.f.scope,
      {
        escalationId: escalation.id,
        actorId: t.f.users[who],
        decision,
        ...extra,
      },
      clockDeps,
    );
    return escalation;
  }

  describe('outcomes, in the order instruction files, scope, caps', () => {
    it('a succeeded run in scope: a system pass (HOTL) and G6; the block window applies', async () => {
      const intent = await atG4(t, 'medium');
      await runToG5(intent, { status: 'succeeded' });
      expect(await t.settleRuns(intent)).toMatchObject({
        outcome: 'waiting',
        reason: 'hotl_block_window',
      });
      expect(await reload(intent)).toMatchObject({ status: 'in_gate', current_gate: 'G6' });
      expect(await g5(intent)).toEqual([['pass', null, 'HOTL']]);
      expect(await notices(t, intent)).toContain('hotl_passed');
      expect(await t.f.scope.escalations.listForIntent(intent.id)).toEqual([]);

      // Within the block window, Person A sends the changes back: a new run after G4.
      await decideGate(t.f.registry, t.f.scope, {
        intent: await reload(intent),
        gate: 'G5',
        decision: 'request_changes',
        actorId: t.f.users.a,
        reasonCode: 'tests_insufficient',
        source: 'cli',
      });
      expect(await t.settleRuns(intent)).toEqual({ outcome: 'run_prepare' });
      expect(await notices(t, intent)).toContain('returned');
    });

    it('instruction files changed: fail instructions_unpinned, paused, a security escalation (#132)', async () => {
      const intent = await atG4(t, 'medium');
      // Also out of scope: the instruction files are checked first.
      await runToG5(intent, { status: 'succeeded' }, { instructionFiles: 1, outOfScope: 1 });
      expect(await t.settleRuns(intent)).toEqual({ outcome: 'waiting', reason: 'g5_review' });
      expect(await reload(intent)).toMatchObject({ status: 'paused', current_gate: 'G5' });
      expect(await g5(intent)).toEqual([['fail', 'instructions_unpinned', 'HOTL']]);
      expect(await checks(intent)).toEqual(['instructions_changed']);
      expect(await g5Escalation(intent)).toMatchObject({
        route: 'security',
        trigger: 'risky_action',
        response_level: 'pause',
        packet: { subject_kind: 'g5_input', gate: 'G5', reason_code: 'instructions_unpinned' },
      });
      expect(await notices(t, intent)).toContain('g5_breach');
      // Recorded once: the next steps change nothing.
      await t.settleRuns(intent);
      expect(await g5(intent)).toHaveLength(1);
    });

    it('H04 AC2: a secret in the diff: fail secret_in_diff, paused, a security escalation; never G6', async () => {
      const intent = await atG4(t, 'medium');
      // Also out of scope: the secret is checked before the scope.
      await runToG5(intent, { status: 'succeeded' }, { secrets: 'found', outOfScope: 1 });
      expect(await t.settleRuns(intent)).toEqual({ outcome: 'waiting', reason: 'g5_review' });
      expect(await reload(intent)).toMatchObject({ status: 'paused', current_gate: 'G5' });
      expect(await g5(intent)).toEqual([['fail', 'secret_in_diff', 'HOTL']]);
      expect(await checks(intent)).toEqual(['secret_found']);
      expect(await g5Escalation(intent)).toMatchObject({
        route: 'security',
        trigger: 'risky_action',
        packet: { subject_kind: 'g5_input', gate: 'G5', reason_code: 'secret_in_diff' },
      });
      // A person decides; nothing moves on by itself (G6 publishes the branch: never reached).
      await t.settleRuns(intent);
      expect(await reload(intent)).toMatchObject({ status: 'paused', current_gate: 'G5' });
      expect(await g5(intent)).toHaveLength(1);
    });

    it.each(['failed', 'none'] as const)(
      'H04 (QUESTIONS #587, #590): a scan %s: fail secret_scan_failed, paused, a technical escalation',
      async (secrets) => {
        const intent = await atG4(t, 'medium');
        await runToG5(intent, { status: 'succeeded' }, { secrets });
        expect(await t.settleRuns(intent)).toEqual({ outcome: 'waiting', reason: 'g5_review' });
        expect(await reload(intent)).toMatchObject({ status: 'paused', current_gate: 'G5' });
        expect(await g5(intent)).toEqual([['fail', 'secret_scan_failed', 'HOTL']]);
        expect(await checks(intent)).toEqual(['secret_scan_failed']);
        expect(await g5Escalation(intent)).toMatchObject({
          route: 'technical',
          packet: { reason_code: 'secret_scan_failed' },
        });
      },
    );

    it.each([
      [
        { status: 'stopped_budget', reason: 'max_budget' } as const,
        'budget_exceeded',
        'max_budget',
      ],
      [
        { status: 'stopped_budget', reason: 'max_iterations' } as const,
        'run_cap_reached',
        'max_iterations',
      ],
      [
        { status: 'stopped_timeout', reason: 'max_duration' } as const,
        'run_cap_reached',
        'max_duration',
      ],
      [{ status: 'stopped_stalled', reason: 'agent_stuck' } as const, 'run_cap_reached', 'stalled'],
    ])(
      '%o: fail %s (cause %s), paused, an intent escalation at pause (N3)',
      async (end, reason, check) => {
        const intent = await atG4(t, 'medium');
        await runToG5(intent, end);
        expect(await t.settleRuns(intent)).toEqual({ outcome: 'waiting', reason: 'g5_review' });
        expect(await g5(intent)).toEqual([['fail', reason, 'HOTL']]);
        expect(await checks(intent)).toEqual([check]);
        expect(await g5Escalation(intent)).toMatchObject({
          route: 'intent',
          trigger: 'accumulated_risk',
          response_level: 'pause',
          severity: 'high',
          producer_ids: [],
        });
      },
    );

    it('a succeeded run whose synced spend reached the stop share: budget_exceeded (ADR-M34 §2.6)', async () => {
      const intent = await atG4(t, 'medium');
      const runId = await runToG5(intent, { status: 'succeeded' });
      await spend(intent, runId, '2'); // the key's cap is 2 (fake Cost Controller)
      await t.settleRuns(intent);
      expect(await g5(intent)).toEqual([['fail', 'budget_exceeded', 'HOTL']]);
      expect(await checks(intent)).toEqual(['spend_at_stop']);
    });
  });

  describe('AC1 (N1): back to G3', () => {
    it('Low risk: G3 becomes HITL, the same plan is refused, a new plan is approved', async () => {
      const intent = await t.f.newIntent({ riskTier: 'low' });
      await t.settle(intent);
      await decideAt(t, intent, 'G1', 'a');
      await t.f.addInputs(intent);
      await t.settle(intent); // G2 and G3 pass (HOTL); G4 waits for the block windows
      t.setClock(new Date(T0.getTime() + DAY));
      await runToG5(intent, { status: 'succeeded' }, { outOfScope: 1 });

      expect(await t.settleRuns(intent)).toMatchObject({
        outcome: 'waiting',
        reason: 'new_plan_needed',
      });
      expect(await reload(intent)).toMatchObject({ status: 'in_gate', current_gate: 'G3' });
      // U01 (#261): Low risk, but G3 is HITL after the return; the API shows it.
      expect(await waitingFor(t, intent)).toMatchObject({ gate: 'G3', mode: 'HITL' });
      expect(await g5(intent)).toEqual([['fail', 'out_of_scope', 'HOTL']]);
      expect(await checks(intent)).toEqual(['out_of_scope']);
      expect(await t.f.scope.escalations.listForIntent(intent.id)).toEqual([]);
      expect(await notices(t, intent)).toContain('scope_returned');

      // The same plan: refused (QUESTIONS #131).
      const approveG3 = async () =>
        decideGate(t.f.registry, t.f.scope, {
          intent: await reload(intent),
          gate: 'G3',
          decision: 'approve',
          actorId: t.f.users.b,
          source: 'cli',
        });
      await expect(approveG3()).rejects.toMatchObject({ code: 'plan_refused' });

      // A new plan: G3 stays HITL (no HOTL pass at Low) and waits for Person B.
      await t.f.registry.submitPlan(t.f.scope, intent.id, {
        plannedFiles: ['apps/api/src/orders/**', 'apps/api/src/stock/**'],
        planSha256: '7'.repeat(64),
        changeFlags: [],
        actorType: 'human',
        actorId: t.f.users.a,
      });
      expect(await t.settleRuns(intent)).toMatchObject({ outcome: 'waiting', reason: 'decision' });
      await approveG3();
      await t.settleRuns(intent);
      const g3 = await t.f.scope.gateDecisions.listForIntent(intent.id, 'G3');
      expect(g3.map((d) => [d.decision, d.oversight_mode])).toEqual([
        ['pass', 'HOTL'],
        ['approve', 'HITL'],
      ]);
      expect((await reload(intent)).current_gate).toBe('G4');
    });
  });

  describe('AC3: the decision on the escalation', () => {
    it('resume with a budget increase (API): intent budget + X, next run cap = cap + X, back to G4', async () => {
      const intent = await atG4(t, 'medium');
      const before = (await reload(intent)).budget_usd;
      await runToG5(intent, { status: 'stopped_budget', reason: 'max_budget' });
      await t.settleRuns(intent);
      const escalation = await decide(intent, 'a', 'resume', {
        actions: ['run_start', 'budget_increase'],
        budgetIncreaseUsd: '1.5',
      });
      expect(await t.settleRuns(intent)).toEqual({ outcome: 'run_prepare' });
      const after = await reload(intent);
      expect(Number(after.budget_usd)).toBeCloseTo(Number(before) + 1.5, 6);
      expect(after.run_budget_usd).toBe('3.500000'); // the stopped run's cap 2 + 1.5
      expect((await t.f.scope.escalations.getById(escalation.id))?.status).toBe('closed');
      expect(await notices(t, intent)).toContain('run_resumed');
      const [raised] = await t.f.scope.audit.listForEntity(intent.id, ['intent.budget_increased']);
      expect(raised?.payload).toMatchObject({
        escalation_id: escalation.id,
        added_usd: '1.5',
        run_budget_usd: '3.5',
      });
      // The new run's contract carries the new cap (#134: a new run from base_sha after G4).
      const started = await startRun(t.f.scope, t.runDeps, intent.id);
      if (!started.ok) throw new Error('not started');
      const contract = await t.f.scope.runContracts.getByRunId(started.run.runId);
      expect(contract?.contract_json).toMatchObject({ max_budget_usd: '3.5', base_sha: BASE_1 });
    });

    it('resume without a budget increase: back to G4, the budgets do not change', async () => {
      const intent = await atG4(t, 'medium');
      const before = await reload(intent);
      await runToG5(intent, { status: 'stopped_budget', reason: 'max_iterations' });
      await t.settleRuns(intent);
      await decide(intent, 'a', 'resume');
      expect(await t.settleRuns(intent)).toEqual({ outcome: 'run_prepare' });
      expect(await reload(intent)).toMatchObject({
        budget_usd: before.budget_usd,
        run_budget_usd: null,
      });
    });

    it('a resume that names only budget_increase is out of scope: the intent keeps waiting', async () => {
      const intent = await atG4(t, 'medium');
      await runToG5(intent, { status: 'stopped_budget', reason: 'max_budget' });
      await t.settleRuns(intent);
      await decide(intent, 'a', 'resume', {
        actions: ['budget_increase'],
        budgetIncreaseUsd: '1',
      });
      expect(await t.settleRuns(intent)).toEqual({ outcome: 'waiting', reason: 'g5_review' });
      expect((await reload(intent)).run_budget_usd).toBeNull();
    });

    it('a comment never raises a budget: /decide resume resumes with the same budgets', async () => {
      const intent = await atG4(t, 'medium');
      const before = await reload(intent);
      await runToG5(intent, { status: 'stopped_budget', reason: 'max_budget' });
      await t.settleRuns(intent);
      const escalation = await g5Escalation(intent);
      t.f.comment(intent, `/ack ${escalation.code}`, 'a');
      t.f.comment(intent, `/decide ${escalation.code} resume budget_exceeded more budget`, 'a');
      await t.f.poll();
      expect((await t.f.scope.escalations.getById(escalation.id))?.decision).not.toHaveProperty(
        'budget_increase_usd',
      );
      expect(await t.settleRuns(intent)).toEqual({ outcome: 'run_prepare' });
      expect(await reload(intent)).toMatchObject({
        budget_usd: before.budget_usd,
        run_budget_usd: null,
      });
    });

    // The test clock decides; the real date never does (a decision once expired on the wall
    // clock and this test broke after 2026-10-06).
    it.each([
      ['the real date', null],
      ['2027-06-01', LATER_WALL_CLOCK],
    ] as const)(
      'an expired decision is voided; a decision on another result is voided (FR-17), wall clock %s',
      async (_, wallClock) =>
        withWallClock(wallClock, async () => {
          const intent = await atG4(t, 'medium');
          const runId = await runToG5(intent, { status: 'stopped_budget', reason: 'max_budget' });
          await t.settleRuns(intent);
          const escalation = await decide(intent, 'a', 'resume');
          t.setClock(new Date(T0.getTime() + 15 * DAY)); // approval_expiry: 7 working days
          expect(await t.settleRuns(intent)).toEqual({ outcome: 'waiting', reason: 'g5_review' });
          expect((await t.f.scope.escalations.getById(escalation.id))?.status).toBe('acknowledged');

          // A late spend sync changes the G5 input: the new decision is voided, the escalation
          // closed, and G5 raises a new escalation bound to the new input.
          await decideEscalation(
            t.f.scope,
            { escalationId: escalation.id, actorId: t.f.users.a, decision: 'resume' },
            clockDeps,
          );
          await spend(intent, runId, '0.01');
          expect(await t.settleRuns(intent)).toEqual({ outcome: 'waiting', reason: 'g5_review' });
          const voided = await t.f.scope.audit.listForEntity(escalation.id, [
            'escalation.decision_voided',
          ]);
          expect(voided.map((e) => (e.payload as { reason: string }).reason)).toEqual([
            'expired',
            'input_mismatch',
          ]);
          expect((await t.f.scope.escalations.getById(escalation.id))?.status).toBe('closed');
          const latest = await g5Escalation(intent);
          expect(latest.id).not.toBe(escalation.id);
          expect(latest.packet.subject_sha256).not.toBe(escalation.packet.subject_sha256);
          expect(await g5(intent)).toEqual([
            ['fail', 'budget_exceeded', 'HOTL'],
            ['fail', 'budget_exceeded', 'HOTL'],
          ]);
          expect(await reload(intent)).toMatchObject({ status: 'paused', current_gate: 'G5' });
        }),
    );

    it('decision A: modify → G3, HITL from now on, the same plan may be approved', async () => {
      const intent = await atG4(t, 'medium');
      await runToG5(intent, { status: 'stopped_timeout', reason: 'max_duration' });
      await t.settleRuns(intent);
      const escalation = await decide(intent, 'a', 'modify');
      expect(await t.settleRuns(intent)).toMatchObject({ outcome: 'waiting', reason: 'decision' });
      expect(await reload(intent)).toMatchObject({ status: 'in_gate', current_gate: 'G3' });
      expect((await t.f.scope.escalations.getById(escalation.id))?.status).toBe('closed');
      expect(await notices(t, intent)).toContain('g5_returned');
      await decideGate(t.f.registry, t.f.scope, {
        intent: await reload(intent),
        gate: 'G3',
        decision: 'approve',
        actorId: t.f.users.b,
        source: 'cli',
      });
      await t.settleRuns(intent);
      expect((await reload(intent)).current_gate).toBe('G4');
    });

    it('decision A: roll_back → G3 as well', async () => {
      const intent = await atG4(t, 'medium');
      await runToG5(intent, { status: 'stopped_stalled', reason: 'agent_stuck' });
      await t.settleRuns(intent);
      await decide(intent, 'a', 'roll_back');
      await t.settleRuns(intent);
      expect(await reload(intent)).toMatchObject({ status: 'in_gate', current_gate: 'G3' });
    });

    it('an escalation closed without a decision acted on: G5 raises a new one', async () => {
      const intent = await atG4(t, 'medium');
      await runToG5(intent, { status: 'stopped_budget', reason: 'max_iterations' });
      await t.settleRuns(intent);
      const first = await g5Escalation(intent);
      await closeEscalation(
        t.f.scope,
        { escalationId: first.id, closedBy: { type: 'human', id: t.f.users.gov } },
        clockDeps,
      );
      expect(await t.settleRuns(intent)).toEqual({ outcome: 'waiting', reason: 'g5_review' });
      const second = await g5Escalation(intent);
      expect(second.id).not.toBe(first.id);
      expect(second.status).toBe('open');
      expect(await reload(intent)).toMatchObject({ status: 'paused', current_gate: 'G5' });
    });

    it('decision B: terminate → cancelled, the escalation closed, notice terminated', async () => {
      const intent = await atG4(t, 'medium');
      await runToG5(intent, { status: 'stopped_budget', reason: 'max_budget' });
      await t.settleRuns(intent);
      const escalation = await decide(intent, 'a', 'terminate');
      expect(await t.settleRuns(intent)).toEqual({ outcome: 'finished', status: 'cancelled' });
      expect((await t.f.scope.escalations.getById(escalation.id))?.status).toBe('closed');
      expect(await notices(t, intent)).toContain('terminated');
    });
  });

  describe('budgets only go up (trigger SDA12)', () => {
    it('refuses a lower intent budget or run budget, and a run budget back to null', async () => {
      const intent = await t.f.newIntent();
      await t.f.scope.intents.raiseBudget(intent.id, {
        addUsd: '1',
        runBudgetUsd: '3',
        escalationId: '00000000-0000-4000-8000-000000000001',
      });
      for (const change of [
        sql`budget_usd = budget_usd - 0.5`,
        sql`run_budget_usd = 2`,
        sql`run_budget_usd = NULL`,
      ]) {
        const attempt = sql`UPDATE intents SET ${change} WHERE id = ${intent.id}`.execute(
          db.appAs(t.f.scope.tenantId),
        );
        await expect(attempt).rejects.toThrow(/only goes up/);
      }
      await expect(
        t.f.scope.intents.raiseBudget(intent.id, {
          addUsd: '1',
          runBudgetUsd: '2',
          escalationId: '00000000-0000-4000-8000-000000000001',
        }),
      ).rejects.toBeInstanceOf(DbError);
    });
  });

  describe('decision C: the budget warning during the run (FR-52)', () => {
    it('writes the run event and the notice together; the comment shows the percent', async () => {
      const intent = await atG4(t, 'medium');
      expect(await t.settleRuns(intent)).toEqual({ outcome: 'run_prepare' });
      const started = await startRun(t.f.scope, t.runDeps, intent.id);
      if (!started.ok) throw new Error('not started');
      await recordBudgetWarning(
        t.f.scope,
        { runId: started.run.runId, intentId: intent.id },
        { spend_usd: '1.7', max_budget_usd: '2', percent: 85 },
      );
      const events = await t.f.scope.runEvents.list(started.run.runId);
      expect(events.map((e) => e.event_type)).toContain('budget_warning');
      const notice = (await t.f.scope.intentNotices.listForIntent(intent.id)).at(-1)!;
      expect(notice).toMatchObject({ kind: 'budget_warning', status: 'running', gate: 'G4' });
      const body = renderIntentNotice(notice, {
        code: intent.code,
        deciders: [],
        mentions: ['@alice'],
        reasonCode: null,
        percent: 85,
      });
      expect(body).toContain('85 %');
    });
  });

  describe('H05: the review limits (40 files, 1500 lines by default)', () => {
    const decideG5 = async (
      intent: Intent,
      decision: 'approve' | 'request_changes',
      reasonCode: 'generated_change' | 'review_too_large' | null,
    ) =>
      decideGate(t.f.registry, t.f.scope, {
        intent: await reload(intent),
        gate: 'G5',
        decision,
        actorId: t.f.users.a,
        reasonCode,
        source: 'cli',
      });
    const splits = async (intent: Intent) =>
      (await t.f.scope.audit.listForEntity(intent.id, ['gate.g5_split_requested'])).map(
        (e) => (e.payload as { check: string }).check,
      );

    it('AC3: a change at the limits passes (HOTL); generated files are not counted', async () => {
      const intent = await atG4(t, 'medium');
      await runToG5(intent, { status: 'succeeded' }, { review: { files: 40, lines: 1500 } });
      await t.settleRuns(intent);
      expect(await reload(intent)).toMatchObject({ status: 'in_gate', current_gate: 'G6' });
      expect(await g5(intent)).toEqual([['pass', null, 'HOTL']]);
    });

    it('AC2: one file over: HITL with the cause review_too_large; an approval needs a reason code', async () => {
      const intent = await atG4(t, 'medium');
      await runToG5(intent, { status: 'succeeded' }, { review: { files: 41, lines: 100 } });
      expect(await t.settleRuns(intent)).toMatchObject({
        outcome: 'waiting',
        reason: 'g5_decision',
        cause: 'review_too_large',
      });
      expect(await reload(intent)).toMatchObject({
        status: 'in_gate',
        current_gate: 'G5',
        waiting_reason: 'g5_decision',
        waiting_cause: 'review_too_large',
      });
      // Medium risk is HOTL by the matrix; the size makes it HITL, and the API shows it.
      expect(await waitingFor(t, intent)).toMatchObject({ gate: 'G5', mode: 'HITL' });
      // Never a breach: no fail decision, no escalation.
      expect(await g5(intent)).toEqual([]);
      expect(await t.f.scope.escalations.listForIntent(intent.id)).toEqual([]);

      await expect(decideG5(intent, 'approve', null)).rejects.toMatchObject({
        code: 'review_reason_required',
      });
      await decideG5(intent, 'approve', 'generated_change');
      await t.settleRuns(intent);
      expect(await reload(intent)).toMatchObject({ status: 'in_gate', current_gate: 'G6' });
      expect(await g5(intent)).toEqual([['approve', 'generated_change', 'HITL']]);
    });

    it('AC2: lines over, then a request for changes: back to G3 (HITL) to split the plan', async () => {
      const intent = await atG4(t, 'medium');
      await runToG5(intent, { status: 'succeeded' }, { review: { files: 3, lines: 1501 } });
      await t.settleRuns(intent);
      expect((await reload(intent)).waiting_cause).toBe('review_too_large');

      await decideG5(intent, 'request_changes', 'review_too_large');
      await t.settleRuns(intent);
      expect(await reload(intent)).toMatchObject({ status: 'in_gate', current_gate: 'G3' });
      expect(await waitingFor(t, intent)).toMatchObject({ gate: 'G3', mode: 'HITL' });
      expect(await splits(intent)).toEqual(['review_too_large']);
      expect(await notices(t, intent)).toContain('g5_returned');
      // Not a scope failure: the same plan is not refused, a person decides at G3.
      expect(await checks(intent)).toEqual([]);
    });

    it.each(['failed', 'none'] as const)(
      'QUESTIONS #603: a size %s: HITL with the cause review_size_unknown',
      async (review) => {
        const intent = await atG4(t, 'medium');
        await runToG5(intent, { status: 'succeeded' }, { review });
        expect(await t.settleRuns(intent)).toMatchObject({
          outcome: 'waiting',
          reason: 'g5_decision',
          cause: 'review_size_unknown',
        });
        expect(await g5(intent)).toEqual([]);
        await decideG5(intent, 'approve', 'generated_change');
        await t.settleRuns(intent);
        expect((await reload(intent)).current_gate).toBe('G6');
      },
    );

    it('the limits are per project: a lower limit holds a smaller change', async () => {
      await t.setConfig(
        [
          'run:',
          `  agent_key: ${t.agent.key}`,
          '  review_limits: { max_changed_files: 2, max_changed_lines: 10 }',
          '',
        ].join('\n'),
      );
      const intent = await atG4(t, 'medium');
      await runToG5(intent, { status: 'succeeded' }, { review: { files: 2, lines: 11 } });
      expect(await t.settleRuns(intent)).toMatchObject({ cause: 'review_too_large' });
    });
  });

  describe('FR-11: a G5 that is HITL (configuration)', () => {
    it('the person who allowed the run never approves its changes; another person does', async () => {
      await t.setConfig(
        [
          'run:',
          `  agent_key: ${t.agent.key}`,
          'oversight:',
          '  matrix:',
          '    G4:',
          '      medium: { mode: HITL, roles: [person_a] }',
          '    G5:',
          '      medium: { mode: HITL, roles: [person_a, person_b] }',
          '',
        ].join('\n'),
      );
      const intent = await atG4(t, 'medium');
      await t.settle(intent);
      await t.decide(await reload(intent), 'approve', 'a'); // Person A allows the run
      await runToG5(intent, { status: 'succeeded' });
      expect(await t.settleRuns(intent)).toMatchObject({
        outcome: 'waiting',
        reason: 'g5_decision',
      });
      const approveG5 = async (who: 'a' | 'b') =>
        decideGate(t.f.registry, t.f.scope, {
          intent: await reload(intent),
          gate: 'G5',
          decision: 'approve',
          actorId: t.f.users[who],
          source: 'cli',
        });
      await expect(approveG5('a')).rejects.toMatchObject({ code: 'approval_refused' });

      // FR-12: past the gate deadline (1 working day), one overdue escalation; the run's
      // producer is never its owner or decider.
      t.setClock(new Date(T0.getTime() + 3 * DAY));
      expect(await t.settleRuns(intent)).toEqual({ outcome: 'waiting', reason: 'g5_decision' });
      await t.settleRuns(intent);
      const overdue = (await t.f.scope.escalations.listForIntent(intent.id)).filter(
        (e) => e.trigger === 'time',
      );
      expect(overdue).toHaveLength(1);
      expect(overdue[0]).toMatchObject({
        packet: { gate: 'G5', subject_kind: 'g5_input' },
        producer_ids: [t.f.users.a],
      });

      await approveG5('b');
      await t.settleRuns(intent);
      expect(await reload(intent)).toMatchObject({ status: 'in_gate', current_gate: 'G6' });
      expect(await g5(intent)).toEqual([['approve', null, 'HITL']]);
      expect((await t.f.scope.escalations.getById(overdue[0]!.id))?.status).toBe('closed');
    });
  });
});
