// D-08 C06 session 2a on a live PostgreSQL, without Temporal (design/ADR-M33 §2.6–§2.7):
// - a decided G4 moves the intent to `running` and asks for a run (`run_prepare`); `startRun`
//   prepares one; a second call never issues a second run (`run_exists`);
// - a freeze that comes while the contract is signed cancels the run before any secret;
// - the run's end moves the intent: to G5 (`succeeded`, a cap), `paused` + a technical escalation
//   (`failed`, a lost runner, contracts that kept expiring), `paused` (`stopped_killed`), back to
//   G4 (a refused start); the key is revoked by run, at once for a lost runner;
// - a paused intent goes back to G4 once a person decides `resume` on the run's escalation;
// - QUESTIONS #211 (B09 PR 2): `modify` or `roll_back` on the escalation of a failed run, whatever
//   its stop reason, takes the intent back to G3, HITL, G3 approvals voided (`run_returned`); an
//   expired decision is voided, not acted on;
// - session 2b: an L1 (High risk) intent runs; its proposal-only end pauses the intent at G4
//   (`proposal_ready`, no escalation) and it waits for a person (`proposal_review`).
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

import { DbError } from '../../../packages/core/src/db/errors.js';
import { CostError } from '../../../packages/core/src/cost/errors.js';
import type { Intent } from '../../../packages/core/src/db/schema.js';
import {
  acknowledgeEscalation,
  decideEscalation,
} from '../../../packages/core/src/escalation/decide.js';
import {
  abandonRun,
  finishRun,
  startRun,
} from '../../../packages/core/src/workflow/run-lifecycle.js';
import { returnedFromG5 } from '../../../packages/core/src/workflow/g5-scope.js';
import { approve, atG4, BASE_1, harness, MODEL, notices, T0, type Harness } from '../g4-harness.js';
import { createTestDatabase, describeDb, type TestDatabase } from './helpers.js';

const MINUTE = 60_000;

describeDb('C06 session 2: the run after G4 on PostgreSQL', () => {
  let db: TestDatabase;
  let t: Harness;

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
    t.calls.wrapped.length = 0;
    t.calls.refuseKey = undefined;
    await t.setConfig(`run:\n  agent_key: ${t.agent.key}\n`);
  });

  const reload = (intent: Intent) => t.reload(intent);
  /** The escalation actions on the test clock (the registry's). */
  const clockDeps = { now: () => t.f.registry.now() };
  const runs = (intent: Intent) => t.f.scope.runs.listForIntent(intent.id);

  /** A Medium intent at `running` with no run yet. */
  async function running(): Promise<Intent> {
    const intent = await atG4(t, 'medium');
    expect(await t.settleRuns(intent)).toEqual({ outcome: 'run_prepare' });
    expect(await reload(intent)).toMatchObject({ status: 'running', current_gate: 'G4' });
    return intent;
  }

  /** What the runner does to a run (the test plays the runner). */
  async function runnerEnds(
    runId: string,
    to: 'succeeded' | 'succeeded_proposal_only' | 'failed' | 'stopped_killed' | 'stopped_budget',
    failedReason = 'agent_error',
  ) {
    const now = new Date();
    await t.f.scope.runs.claimForProvisioning(runId, now);
    await t.f.scope.runs.transition(runId, { from: ['provisioning'], to: 'running', now });
    await t.f.scope.runs.transition(runId, {
      from: ['running'],
      to,
      now,
      ...(to === 'succeeded' || to === 'succeeded_proposal_only'
        ? {}
        : {
            stopReason:
              to === 'failed'
                ? failedReason
                : to === 'stopped_killed'
                  ? 'killed'
                  : 'max_iterations',
          }),
      finishedAt: now,
    });
  }

  it('G4 decided → running → one run; a second start is refused (run_exists)', async () => {
    const intent = await running();
    expect(await notices(t, intent)).toContain('run_started');

    const first = await startRun(t.f.scope, t.runDeps, intent.id);
    expect(first.ok).toBe(true);
    expect(await startRun(t.f.scope, t.runDeps, intent.id)).toEqual({
      ok: false,
      reason: 'run_exists',
    });
    expect((await runs(intent)).map((r) => r.status)).toEqual(['queued']);
    expect(t.calls.keys).toHaveLength(1);
    // The run is under way: the step waits.
    expect(await t.settleRuns(intent)).toEqual({ outcome: 'waiting', reason: 'run_in_progress' });
    expect(await reload(intent)).toMatchObject({ status: 'running' });
  });

  it('a succeeded run: the key is revoked by run and the intent waits at G5', async () => {
    const intent = await running();
    const started = await startRun(t.f.scope, t.runDeps, intent.id);
    if (!started.ok) throw new Error('not started');
    await runnerEnds(started.run.runId, 'succeeded');
    expect(await t.settleRuns(intent)).toEqual({
      outcome: 'run_ended',
      runId: started.run.runId,
    });
    await finishRun(t.f.scope, t.runDeps, intent.id, started.run.runId);
    expect(t.calls.revoked).toEqual([started.run.runId]);
    expect(await reload(intent)).toMatchObject({ status: 'in_gate', current_gate: 'G5' });
    expect(await notices(t, intent)).toContain('run_finished');
    // Finishing again changes nothing.
    await finishRun(t.f.scope, t.runDeps, intent.id, started.run.runId);
    expect(await reload(intent)).toMatchObject({ status: 'in_gate', current_gate: 'G5' });
  });

  it('a stop at a cap goes to G5 too (C07 decides; QUESTIONS #21, #82)', async () => {
    const intent = await running();
    const started = await startRun(t.f.scope, t.runDeps, intent.id);
    if (!started.ok) throw new Error('not started');
    await runnerEnds(started.run.runId, 'stopped_budget');
    await finishRun(t.f.scope, t.runDeps, intent.id, started.run.runId);
    expect(await reload(intent)).toMatchObject({ status: 'in_gate', current_gate: 'G5' });
  });

  it('a lost runner: the key is revoked at once, the run fails, the intent is paused and escalated; resume after a decision', async () => {
    const intent = await running();
    const started = await startRun(t.f.scope, t.runDeps, intent.id);
    if (!started.ok) throw new Error('not started');
    const runId = started.run.runId;
    await t.f.scope.runs.claimForProvisioning(runId, new Date());

    await abandonRun(t.f.scope, t.runDeps, runId);
    expect(t.calls.revoked).toEqual([runId]);
    expect((await t.f.scope.runs.getById(runId))!).toMatchObject({
      status: 'failed',
      stop_reason: 'runner_lost',
    });
    const events = await t.f.scope.runEvents.list(runId);
    expect(events.map((e) => [e.event_type, e.payload])).toContainEqual([
      'run_abandoned',
      { previous_status: 'provisioning' },
    ]);

    expect(await t.settleRuns(intent)).toEqual({ outcome: 'run_ended', runId });
    await finishRun(t.f.scope, t.runDeps, intent.id, runId);
    expect(await reload(intent)).toMatchObject({ status: 'paused', current_gate: 'G4' });
    const [escalation] = await t.f.scope.escalations.listForIntent(intent.id);
    expect(escalation).toMatchObject({
      run_id: runId,
      route: 'technical',
      response_level: 'pause',
      severity: 'high',
      trigger: 'unusual_behaviour',
    });
    expect(await t.settleRuns(intent)).toEqual({ outcome: 'waiting', reason: 'run_review' });

    // Person B (technical route) acknowledges and decides `resume` for this run's contract.
    await acknowledgeEscalation(
      t.f.scope,
      { escalationId: escalation!.id, actorId: t.f.users.b },
      clockDeps,
    );
    await decideEscalation(
      t.f.scope,
      {
        escalationId: escalation!.id,
        actorId: t.f.users.b,
        decision: 'resume',
      },
      clockDeps,
    );
    // Back at G4, decided again by POLICY, and running with a new round.
    expect(await t.settleRuns(intent)).toEqual({ outcome: 'run_prepare' });
    expect(await notices(t, intent)).toContain('run_resumed');
    expect((await t.f.scope.escalations.getById(escalation!.id))?.status).toBe('closed');
    // The old failed run belongs to the earlier round: it is never finished again.
    const again = await startRun(t.f.scope, t.runDeps, intent.id);
    expect(again.ok).toBe(true);
  });

  /** A run that failed with `stopReason`, finished: the intent is paused at G4 and escalated. */
  async function failedRun(stopReason: string): Promise<{ intent: Intent; escalationId: string }> {
    const intent = await running();
    const started = await startRun(t.f.scope, t.runDeps, intent.id);
    if (!started.ok) throw new Error('not started');
    const runId = started.run.runId;
    if (stopReason === 'runner_lost') {
      await t.f.scope.runs.claimForProvisioning(runId, new Date());
      await abandonRun(t.f.scope, t.runDeps, runId);
    } else {
      await runnerEnds(runId, 'failed', stopReason);
    }
    expect((await t.f.scope.runs.getById(runId))?.stop_reason).toBe(stopReason);
    expect(await t.settleRuns(intent)).toEqual({ outcome: 'run_ended', runId });
    await finishRun(t.f.scope, t.runDeps, intent.id, runId);
    expect(await reload(intent)).toMatchObject({ status: 'paused', current_gate: 'G4' });
    const escalation = (await t.f.scope.escalations.listForIntent(intent.id)).at(-1)!;
    expect(escalation).toMatchObject({ run_id: runId, route: 'technical' });
    await acknowledgeEscalation(
      t.f.scope,
      { escalationId: escalation.id, actorId: t.f.users.b },
      clockDeps,
    );
    return { intent, escalationId: escalation.id };
  }

  const decideRun = (escalationId: string, decision: 'modify' | 'roll_back' | 'resume') =>
    decideEscalation(
      t.f.scope,
      { escalationId, actorId: t.f.users.b, decision },
      { now: () => T0 },
    );

  /** Back at G3, HITL from then on, the G3 approval in force voided, the escalation closed. */
  async function expectReturnedToG3(intent: Intent, escalationId: string) {
    expect(await reload(intent)).toMatchObject({ status: 'in_gate', current_gate: 'G3' });
    expect(await notices(t, intent)).toContain('run_returned');
    expect(await notices(t, intent)).not.toContain('g7_returned');
    expect(await returnedFromG5(t.f.scope, intent.id)).toBe(true);
    const g3 = await t.f.scope.gateDecisions.listForIntent(intent.id, 'G3');
    expect(g3.at(-1)).toMatchObject({ decision: 'void', reason_code: 'input_mismatch' });
    expect((await t.f.scope.escalations.getById(escalationId))?.status).toBe('closed');
  }

  it('#211: task_unavailable → modify → G3 HITL; the plan submitted again and approved → G4', async () => {
    const { intent, escalationId } = await failedRun('agent_task_unavailable');
    await decideRun(escalationId, 'modify');
    await t.settleRuns(intent);
    await expectReturnedToG3(intent, escalationId);
    // A person submits the plan again; Person B approves it at G3; G4 decides again by POLICY.
    await t.f.registry.submitPlan(t.f.scope, intent.id, {
      plannedFiles: ['apps/api/src/orders/**'],
      planSha256: 'e'.repeat(64),
      actorType: 'human',
      actorId: t.f.users.a,
    });
    expect(await t.settleRuns(intent)).toMatchObject({ outcome: 'waiting' });
    expect(await reload(intent)).toMatchObject({ current_gate: 'G3' });
    await approve(t, intent, 'G3', 'b');
    expect(await t.settleRuns(intent)).toEqual({ outcome: 'run_prepare' });
    expect(await reload(intent)).toMatchObject({ status: 'running', current_gate: 'G4' });
  });

  it('#211: task_unavailable → resume → G4 (a new run)', async () => {
    const { intent, escalationId } = await failedRun('agent_task_unavailable');
    await decideRun(escalationId, 'resume');
    expect(await t.settleRuns(intent)).toEqual({ outcome: 'run_prepare' });
    expect(await notices(t, intent)).toContain('run_resumed');
    expect(await notices(t, intent)).not.toContain('run_returned');
  });

  it('#211: the rule is general: runner_lost → roll_back → G3 HITL', async () => {
    const { intent, escalationId } = await failedRun('runner_lost');
    await decideRun(escalationId, 'roll_back');
    await t.settleRuns(intent);
    await expectReturnedToG3(intent, escalationId);
  });

  it('#211: an expired modify decision is voided, not acted on; the intent stays paused', async () => {
    const { intent, escalationId } = await failedRun('agent_changes_unavailable');
    await decideRun(escalationId, 'modify');
    t.setClock(new Date(T0.getTime() + 365 * 24 * 60 * MINUTE));
    expect(await t.settleRuns(intent)).toEqual({ outcome: 'waiting', reason: 'run_review' });
    expect(await reload(intent)).toMatchObject({ status: 'paused', current_gate: 'G4' });
    expect(await t.f.scope.escalations.getById(escalationId)).toMatchObject({
      status: 'acknowledged',
      decision: null,
    });
    const voided = await t.f.scope.audit.listForEntity(escalationId, [
      'escalation.decision_voided',
    ]);
    expect(voided.map((e) => (e.payload as { reason: string }).reason)).toEqual(['expired']);
    expect(await notices(t, intent)).not.toContain('run_returned');
  });

  it('a killed run pauses the intent; finishRun raises no escalation (the kill raised one, C11)', async () => {
    const intent = await running();
    const started = await startRun(t.f.scope, t.runDeps, intent.id);
    if (!started.ok) throw new Error('not started');
    await runnerEnds(started.run.runId, 'stopped_killed');
    await finishRun(t.f.scope, t.runDeps, intent.id, started.run.runId);
    expect(await reload(intent)).toMatchObject({ status: 'paused', current_gate: 'G4' });
    expect(await t.f.scope.escalations.listForIntent(intent.id)).toEqual([]);
    expect(await t.settleRuns(intent)).toEqual({ outcome: 'waiting', reason: 'run_review' });
  });

  it('contracts that expire before a runner takes them: new attempts, then an escalation', async () => {
    const intent = await running();
    let clock = T0.getTime();
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const started = await startRun(t.f.scope, t.runDeps, intent.id);
      expect(started.ok).toBe(true);
      clock += 16 * MINUTE;
      t.setClock(new Date(clock));
      const next = await t.settleRuns(intent);
      if (attempt < 3) expect(next).toEqual({ outcome: 'run_prepare' });
      else expect(next).toMatchObject({ outcome: 'run_ended' });
    }
    expect((await runs(intent)).map((r) => [r.status, r.stop_reason])).toEqual([
      ['cancelled', 'contract_expired'],
      ['cancelled', 'contract_expired'],
      ['cancelled', 'contract_expired'],
    ]);
    const last = (await runs(intent)).at(-1)!;
    await finishRun(t.f.scope, t.runDeps, intent.id, last.id);
    expect(await reload(intent)).toMatchObject({ status: 'paused' });
    expect(await t.f.scope.escalations.listForIntent(intent.id)).toHaveLength(1);
  });

  it('a used-up budget: the run is cancelled and the intent goes back to G4', async () => {
    const intent = await running();
    t.calls.refuseKey = new CostError('intent_budget_exhausted', 'used up');
    expect(await startRun(t.f.scope, t.runDeps, intent.id)).toEqual({
      ok: false,
      reason: 'budget_exceeded',
    });
    expect(await reload(intent)).toMatchObject({ status: 'in_gate', current_gate: 'G4' });
    expect(await notices(t, intent)).toContain('run_not_started');
  });

  it('a block of G4 while the contract is signed cancels the run before any secret', async () => {
    const intent = await running();
    const deps = {
      ...t.runDeps,
      signer: {
        sign: async (payload: Uint8Array) => {
          // An escalation freezes the intent while the contract is being signed.
          const { raiseEscalation } =
            await import('../../../packages/core/src/escalation/raise.js');
          await raiseEscalation(
            t.f.scope,
            {
              intentId: intent.id,
              trigger: 'uncertainty',
              route: 'technical',
              severity: 'high',
              responseLevel: 'pause',
              packet: { subject_kind: 'intent', subject_sha256: 'a'.repeat(64) },
              producers: [],
              raisedBy: { type: 'system' },
            },
            { now: () => T0 },
          );
          return t.runDeps.signer.sign(payload);
        },
      },
    };
    expect(await startRun(t.f.scope, deps, intent.id)).toEqual({
      ok: false,
      reason: 'not_decided',
    });
    expect((await runs(intent)).map((r) => [r.status, r.stop_reason])).toEqual([
      ['cancelled', 'not_decided'],
    ]);
    expect(t.calls.keys).toEqual([]);
    expect(t.calls.wrapped).toEqual([]);
  });

  it('session 2b: an L1 (High risk) run ends with a proposal; the intent is paused for Person A', async () => {
    const intent = await atG4(t, 'high');
    await t.settleRuns(intent);
    await t.decide(await reload(intent), 'approve', 'a');
    expect(await t.settleRuns(intent)).toEqual({ outcome: 'run_prepare' });
    expect(await reload(intent)).toMatchObject({ status: 'running', current_gate: 'G4' });
    const started = await startRun(t.f.scope, t.runDeps, intent.id);
    if (!started.ok) throw new Error('not started');
    const contract = await t.f.scope.runContracts.getByRunId(started.run.runId);
    expect((contract?.contract_json as { autonomy_level: string }).autonomy_level).toBe('L1');

    await runnerEnds(started.run.runId, 'succeeded_proposal_only');
    expect(await t.settleRuns(intent)).toEqual({
      outcome: 'run_ended',
      runId: started.run.runId,
    });
    await finishRun(t.f.scope, t.runDeps, intent.id, started.run.runId);
    expect(t.calls.revoked).toEqual([started.run.runId]);
    expect(await reload(intent)).toMatchObject({ status: 'paused', current_gate: 'G4' });
    expect(await notices(t, intent)).toContain('proposal_ready');
    // Not a failure: no escalation, and no new run starts by itself.
    expect(await t.f.scope.escalations.listForIntent(intent.id)).toEqual([]);
    expect(await t.settleRuns(intent)).toEqual({ outcome: 'waiting', reason: 'proposal_review' });
    expect(await reload(intent)).toMatchObject({ status: 'paused', current_gate: 'G4' });
    expect(await runs(intent)).toHaveLength(1);
  });
  it('session 2b: evidence items are written once, one row per URI, with coded values only', async () => {
    const intent = await running();
    const started = await startRun(t.f.scope, t.runDeps, intent.id);
    if (!started.ok) throw new Error('not started');
    const uri = `s3://evidence/proposals/${t.f.scope.tenantId}/${intent.id}/${started.run.runId}.patch`;
    const item = {
      intentId: intent.id,
      runId: started.run.runId,
      kind: 'proposal' as const,
      storageUri: uri,
      sha256: 'a'.repeat(64),
      sizeBytes: 42,
    };
    const row = await t.f.scope.evidenceItems.record(item);
    expect(row).toMatchObject({ kind: 'proposal', storage_uri: uri, purged_at: null });
    expect((await t.f.scope.evidenceItems.listForIntent(intent.id)).map((r) => r.id)).toEqual([
      row.id,
    ]);
    // The same URI never gets a second row (evidence is never overwritten).
    await expect(t.f.scope.evidenceItems.record(item)).rejects.toBeInstanceOf(DbError);
    // Bad values are refused before the database.
    for (const bad of [
      { storageUri: 's3://evidence/proposals/../x.patch' },
      { storageUri: 'https://evidence/x.patch' },
      { sha256: 'A'.repeat(64) },
      { sizeBytes: -1 },
      { kind: 'secret' as 'proposal' },
    ]) {
      await expect(t.f.scope.evidenceItems.record({ ...item, ...bad })).rejects.toBeInstanceOf(
        DbError,
      );
    }
    // The database refuses them too, and the application role cannot change or delete a row.
    await expect(
      sql`INSERT INTO evidence_items (tenant_id, intent_id, kind, storage_uri, sha256, size_bytes)
          VALUES (${t.f.scope.tenantId}, ${intent.id}, 'proposal', 's3://evidence/a/./b', ${'b'.repeat(64)}, 1)`.execute(
        db.appAs(t.f.scope.tenantId),
      ),
    ).rejects.toMatchObject({ code: '23514' });
    for (const statement of [
      sql`UPDATE evidence_items SET sha256 = ${'c'.repeat(64)} WHERE id = ${row.id}`,
      sql`DELETE FROM evidence_items WHERE id = ${row.id}`,
    ]) {
      await expect(statement.execute(db.appAs(t.f.scope.tenantId))).rejects.toMatchObject({
        code: '42501',
      });
    }
  });
});
