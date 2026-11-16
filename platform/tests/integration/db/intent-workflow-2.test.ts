// D-08 B07 session 2 on a live PostgreSQL, without Temporal (design/ADR-M30 §2.4b, §2.9):
// - AC2: HOTL gates pass when the policy conditions hold; a person may block a passed gate within
//   its block window (QUESTIONS #88); no pass again on an input a person sent back (D1); after a
//   return, approvals recorded at later gates no longer count (D2);
// - AC3: approval binding: expiry, input and scope mismatch void an approval; a scoped approval is
//   refused at G1–G3 (D3); dual approval (FR-16) from the project configuration;
// - AC4: a gate that waits past `oversight.hitl_gate_deadline` raises one escalation per clock
//   start (QUESTIONS #90, D4), closed when the gate is decided; `waited_seconds` (FR-12).
import { loadProjectConfig } from '@sdlc/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CommandError } from '../../../packages/core/src/commands/errors.js';
import {
  decideGate,
  type CommandDecision,
} from '../../../packages/core/src/commands/gate-command.js';
import type { Intent } from '../../../packages/core/src/db/schema.js';
import { advanceEscalation } from '../../../packages/core/src/escalation/advance.js';
import { raiseEscalation } from '../../../packages/core/src/escalation/raise.js';
import type { GateReasonCode } from '../../../packages/contracts/src/index.js';
import { hotlBlockWindowOpenUntil } from '../../../packages/core/src/workflow/hotl.js';
import { approveBreakGlass } from '../../../packages/core/src/break-glass/index.js';
import { stepIntent } from '../../../packages/core/src/workflow/step.js';
import {
  createWorkflowFixture,
  PLAN_HASH,
  SPEC_HASH,
  type Person,
  type WorkflowFixture,
} from '../workflow/fixture.js';
import { createTestDatabase, describeDb, type TestDatabase } from './helpers.js';

// Monday 08:00 in Ho Chi Minh City (the default calendar), one hour before the working day.
const T0 = new Date('2026-09-28T01:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** 4 working hours from T0: 09:00–13:00 local = 06:00 UTC (default `hotl_block_window`). */
const WINDOW_END = new Date('2026-09-28T06:00:00.000Z');
/** 1 working day from T0: 09:00–18:00 local = 11:00 UTC (default `hitl_gate_deadline`). */
const GATE_DEADLINE = new Date('2026-09-28T11:00:00.000Z');

interface Harness {
  readonly f: WorkflowFixture;
  setClock(at: Date): void;
  step(intent: Intent): ReturnType<typeof stepIntent>;
  settle(intent: Intent): ReturnType<typeof stepIntent>;
  reload(intent: Intent): Promise<Intent>;
  decide(
    intent: Intent,
    gate: string,
    decision: CommandDecision,
    /** A fixture person, or a platform user ID. */
    who: string,
    extra?: { reasonCode?: GateReasonCode; scope?: Record<string, unknown> },
  ): ReturnType<typeof decideGate>;
  decisions(intent: Intent, gate: 'G1' | 'G2' | 'G3'): Promise<[string, string | null][]>;
  newPlan(intent: Intent, sha: string, changeFlags?: readonly 'migration'[]): Promise<void>;
  newSpec(intent: Intent, sha: string): Promise<void>;
}

async function harness(db: TestDatabase): Promise<Harness> {
  let clock = T0;
  const f = await createWorkflowFixture(db, () => clock);
  f.h.stub.now = T0;
  const step = (intent: Intent) => stepIntent(f.scope, { registry: f.registry }, intent.id);
  return {
    f,
    setClock(at) {
      clock = at;
      f.h.stub.now = at;
    },
    step,
    async settle(intent) {
      for (let i = 0; i < 12; i += 1) {
        const result = await step(intent);
        if (result.outcome !== 'moved') return result;
      }
      throw new Error('the step never settled');
    },
    reload: async (intent) => (await f.scope.intents.getById(intent.id))!,
    decide: (intent, gate, decision, who, extra = {}) =>
      decideGate(f.registry, f.scope, {
        intent,
        gate,
        decision,
        actorId: who in f.users ? f.users[who as Person] : who,
        reasonCode: extra.reasonCode ?? (decision === 'approve' ? null : 'tests_insufficient'),
        ...(extra.scope ? { scope: extra.scope } : {}),
        source: 'cli',
      }),
    async decisions(intent, gate) {
      return (await f.scope.gateDecisions.listForIntent(intent.id, gate)).map((d) => [
        d.decision,
        d.reason_code,
      ]);
    },
    async newPlan(intent, sha, changeFlags = []) {
      await f.registry.submitPlan(f.scope, intent.id, {
        plannedFiles: ['apps/api/src/orders/**'],
        planSha256: sha,
        changeFlags,
        actorType: 'human',
        actorId: f.users.a,
      });
    },
    async newSpec(intent, sha) {
      await f.registry.linkSpec(f.scope, intent.id, {
        path: 'docs/specs/t07.md',
        commitSha: 'e'.repeat(40),
        contentSha256: sha,
        structure: 'manual_heading',
        acceptanceCriteria: 1,
        actorType: 'human',
        actorId: f.users.a,
      });
    },
  };
}

/** Brings a new intent to G2 (G1 approved by Person A). */
async function atG2(t: Harness, riskTier: 'low' | 'medium' | 'high') {
  const intent = await t.f.newIntent({ riskTier });
  await t.settle(intent);
  await t.decide(intent, 'G1', 'approve', 'a');
  await t.settle(intent);
  return intent;
}

describeDb('B07 session 2: HOTL, binding and overdue gates on PostgreSQL', () => {
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

  describe('AC2: HOTL gates (QUESTIONS #88, option A)', () => {
    it('Low risk: G2 and G3 pass at once when their conditions hold, and tell the people', async () => {
      t.setClock(T0);
      const intent = await atG2(t, 'low');
      expect(await t.reload(intent)).toMatchObject({ current_gate: 'G2' });
      // The spec is missing: no HOTL pass without its input.
      expect(await t.settle(intent)).toMatchObject({ reason: 'input_missing' });

      await t.f.addInputs(intent);
      const result = await t.settle(intent);
      // G4 belongs to C06; the workflow wakes when the last block window closes.
      expect(result).toEqual({
        outcome: 'waiting',
        reason: 'hotl_block_window',
        wakeInMs: WINDOW_END.getTime() - T0.getTime(),
      });
      expect(await t.reload(intent)).toMatchObject({ status: 'in_gate', current_gate: 'G4' });

      const g2 = await t.f.scope.gateDecisions.listForIntent(intent.id, 'G2');
      expect(g2).toEqual([
        expect.objectContaining({
          decision: 'pass',
          actor_type: 'system',
          oversight_mode: 'HOTL',
          input_sha256: SPEC_HASH,
          waited_seconds: 0,
          source: 'workflow',
        }),
      ]);
      expect(await t.decisions(intent, 'G3')).toEqual([['pass', null]]);

      const notices = await t.f.scope.intentNotices.listForIntent(intent.id);
      expect(
        notices.slice(-2).map((n) => [n.kind, n.gate, n.previous_gate, n.audience_roles]),
      ).toEqual([
        ['hotl_passed', 'G3', 'G2', ['person_a', 'person_b']],
        ['hotl_passed', 'G4', 'G3', ['person_b']],
      ]);
      // C06 must not start a run before the window closes (QUESTIONS #88).
      expect(await hotlBlockWindowOpenUntil(t.f.scope, t.f.registry, intent.id)).toEqual(
        WINDOW_END,
      );

      // The status comment names the end of the block window.
      await t.f.poll();
      const posted = t.f.posted(intent).filter((b) => b.includes('passed **G3** (HOTL)'));
      expect(posted).toHaveLength(1);
      expect(posted[0]).toContain('until **2026-09-28 06:00 UTC**');
      expect(posted[0]).toContain('`/request-changes G3 <reason>`');
    });

    it('a request for changes within the window takes the intent back; no pass again on the same input (D1)', async () => {
      t.setClock(T0);
      const intent = await atG2(t, 'low');
      await t.f.addInputs(intent);
      await t.settle(intent);
      expect(await t.reload(intent)).toMatchObject({ current_gate: 'G4' });

      // A passed gate cannot be approved again, and only its role may block it.
      await expect(t.decide(intent, 'G3', 'approve', 'b')).rejects.toMatchObject({
        code: 'gate_not_current',
      });
      await expect(t.decide(intent, 'G3', 'request_changes', 'a')).rejects.toMatchObject({
        reason: 'role_missing',
      });

      t.setClock(new Date(T0.getTime() + HOUR));
      await t.decide(intent, 'G3', 'request_changes', 'b');
      expect(await t.step(intent)).toEqual({ outcome: 'moved' });
      expect(await t.reload(intent)).toMatchObject({ status: 'in_gate', current_gate: 'G3' });
      const returned = (await t.f.scope.intentNotices.listForIntent(intent.id)).at(-1)!;
      expect([returned.kind, returned.gate, returned.previous_gate]).toEqual([
        'returned',
        'G3',
        'G4',
      ]);

      // D1: the same plan is not passed again; the gate waits for a new plan or a person.
      expect(await t.settle(intent)).toMatchObject({ outcome: 'waiting', reason: 'decision' });
      expect(await t.decisions(intent, 'G3')).toEqual([
        ['pass', null],
        ['request_changes', 'tests_insufficient'],
      ]);

      // A new plan version passes again.
      await t.newPlan(intent, '7'.repeat(64));
      expect(await t.settle(intent)).toMatchObject({ reason: 'hotl_block_window' });
      expect(await t.reload(intent)).toMatchObject({ current_gate: 'G4' });
    });

    it('an explicit approval of a sent-back input passes at once and opens no block window', async () => {
      t.setClock(T0);
      const intent = await atG2(t, 'low');
      await t.f.addInputs(intent);
      await t.settle(intent);
      await t.decide(intent, 'G3', 'request_changes', 'b');
      await t.settle(intent);
      expect(await t.reload(intent)).toMatchObject({ current_gate: 'G3' });

      // Past the G2 window: no pass is blockable any more once G3 is approved by a person.
      t.setClock(new Date(WINDOW_END.getTime() + HOUR));
      await t.decide(intent, 'G3', 'approve', 'b');
      expect(await t.settle(intent)).toEqual({ outcome: 'waiting', reason: 'later_gate' });
      expect(await t.reload(intent)).toMatchObject({ current_gate: 'G4' });
      expect(await hotlBlockWindowOpenUntil(t.f.scope, t.f.registry, intent.id)).toBeNull();
      await expect(t.decide(intent, 'G3', 'request_changes', 'b')).rejects.toMatchObject({
        code: 'gate_not_current',
      });
    });

    it('a rejection within the window ends the intent; after the window a block is refused', async () => {
      t.setClock(T0);
      const rejected = await atG2(t, 'low');
      await t.f.addInputs(rejected);
      await t.settle(rejected);
      await t.decide(rejected, 'G2', 'reject', 'a', { reasonCode: 'spec_unclear' });
      expect(await t.settle(rejected)).toEqual({ outcome: 'finished', status: 'rejected' });
      expect(await t.reload(rejected)).toMatchObject({ status: 'rejected', current_gate: 'G2' });

      const late = await atG2(t, 'low');
      await t.f.addInputs(late);
      await t.settle(late);
      t.setClock(WINDOW_END);
      expect(await hotlBlockWindowOpenUntil(t.f.scope, t.f.registry, late.id)).toBeNull();
      await expect(t.decide(late, 'G2', 'reject', 'a')).rejects.toBeInstanceOf(CommandError);
      await expect(t.decide(late, 'G2', 'reject', 'a')).rejects.toMatchObject({
        code: 'gate_not_current',
      });
      expect(await t.settle(late)).toEqual({ outcome: 'waiting', reason: 'later_gate' });
    });

    it('after a return, approvals recorded at the later gates no longer count (D2)', async () => {
      t.setClock(T0);
      const intent = await atG2(t, 'low');
      await t.f.addInputs(intent, { changeFlags: ['migration'] });
      // G2 passes (HOTL); G3 is forced HITL by the migration flag (FR-15): it waits for Person B.
      expect(await t.settle(intent)).toMatchObject({ reason: 'decision' });
      expect(await t.reload(intent)).toMatchObject({ current_gate: 'G3' });
      await t.decide(intent, 'G3', 'approve', 'b');
      await t.settle(intent);
      expect(await t.reload(intent)).toMatchObject({ current_gate: 'G4' });

      // Person A sends G2 back within its window; a new spec passes G2 again.
      await t.decide(intent, 'G2', 'request_changes', 'a', { reasonCode: 'spec_unclear' });
      await t.settle(intent);
      expect(await t.reload(intent)).toMatchObject({ current_gate: 'G2' });
      await t.newSpec(intent, '9'.repeat(64));
      expect(await t.settle(intent)).toMatchObject({ outcome: 'waiting', reason: 'decision' });

      // Back at G3 with the same plan: Person B's earlier approval was before this entry.
      expect(await t.reload(intent)).toMatchObject({ current_gate: 'G3' });
      expect(await t.decisions(intent, 'G3')).toEqual([['approve', null]]);
      // It is still recorded for the same input, so Person B must wait for a new plan (ADR-M30 §2.4).
      await t.newPlan(intent, '8'.repeat(64), ['migration']);
      await t.decide(intent, 'G3', 'approve', 'b');
      // At G4, woken when the second G2 pass's block window closes.
      expect(await t.settle(intent)).toMatchObject({
        outcome: 'waiting',
        reason: 'hotl_block_window',
      });
      expect(await t.reload(intent)).toMatchObject({ current_gate: 'G4' });
    });

    it('Medium risk is HITL: the platform never passes G2 (no gate passes by silence)', async () => {
      t.setClock(T0);
      const intent = await atG2(t, 'medium');
      await t.f.addInputs(intent);
      expect(await t.settle(intent)).toMatchObject({ reason: 'decision' });
      expect(await t.decisions(intent, 'G2')).toEqual([]);
    });
  });

  describe('AC3: approval binding (FR-17)', () => {
    it('an expired approval is voided and the gate waits', async () => {
      t.setClock(T0);
      const intent = await t.f.newIntent();
      await t.settle(intent);
      await t.decide(intent, 'G1', 'approve', 'a');
      // `approval_expiry` is 7 days; the workflow looks again only after that.
      t.setClock(new Date(T0.getTime() + 7 * DAY));
      expect(await t.settle(intent)).toMatchObject({ outcome: 'waiting', reason: 'decision' });
      expect(await t.decisions(intent, 'G1')).toEqual([
        ['approve', null],
        ['void', 'expired'],
      ]);
      await t.decide(intent, 'G1', 'approve', 'a');
      await t.settle(intent);
      expect(await t.reload(intent)).toMatchObject({ current_gate: 'G2' });
    });

    it('a scoped approval is refused at G1–G3 (D3); one recorded anyway is voided (scope_mismatch)', async () => {
      t.setClock(T0);
      const intent = await t.f.newIntent();
      await t.settle(intent);
      await expect(
        t.decide(intent, 'G1', 'approve', 'a', { scope: { environment: 'staging' } }),
      ).rejects.toMatchObject({ code: 'scope_not_allowed' });
      expect(await t.decisions(intent, 'G1')).toEqual([]);

      // The safeguard: an approval written past the command handler still never counts.
      const current = await t.reload(intent);
      const { intentInputSha256 } =
        await import('../../../packages/core/src/commands/gate-input.js');
      await t.f.registry.decide(t.f.scope, {
        intentId: intent.id,
        gate: 'G1',
        decision: 'approve',
        actor: { type: 'human', id: t.f.users.a },
        producers: [],
        inputSha256: intentInputSha256(current),
        scope: { environment: 'staging' },
        source: 'cli',
      });
      expect(await t.settle(intent)).toMatchObject({ reason: 'decision' });
      expect(await t.decisions(intent, 'G1')).toEqual([
        ['approve', null],
        ['void', 'scope_mismatch'],
      ]);
    });

    it('records waited_seconds on decisions at the current gate (FR-12)', async () => {
      t.setClock(T0);
      const intent = await t.f.newIntent();
      await t.settle(intent);
      t.setClock(new Date(T0.getTime() + 90_000));
      const decision = await t.decide(intent, 'G1', 'request_changes', 'a');
      expect(decision.waited_seconds).toBe(90);
    });
  });

  describe('AC4: overdue gates (QUESTIONS #90, D4)', () => {
    it('raises one escalation at the deadline and closes it when the gate is decided', async () => {
      t.setClock(T0);
      const intent = await t.f.newIntent();
      expect(await t.settle(intent)).toEqual({
        outcome: 'waiting',
        reason: 'decision',
        wakeInMs: GATE_DEADLINE.getTime() - T0.getTime(),
      });
      expect(await t.f.scope.escalations.listForIntent(intent.id)).toEqual([]);

      t.setClock(GATE_DEADLINE);
      expect(await t.settle(intent)).toEqual({ outcome: 'waiting', reason: 'decision' });
      expect(await t.settle(intent)).toEqual({ outcome: 'waiting', reason: 'decision' });
      const [overdue, ...more] = await t.f.scope.escalations.listForIntent(intent.id);
      expect(more).toEqual([]);
      expect(overdue).toMatchObject({
        trigger: 'time',
        route: 'intent', // G1: Person A holds the gate's role
        severity: 'medium',
        response_level: 'notify',
        status: 'open',
        owner_id: t.f.users.a,
        packet: { subject_kind: 'intent', gate: 'G1' },
      });

      t.setClock(new Date(GATE_DEADLINE.getTime() + HOUR));
      const approval = await t.decide(intent, 'G1', 'approve', 'a');
      expect(approval.waited_seconds).toBe((GATE_DEADLINE.getTime() + HOUR - T0.getTime()) / 1000);
      await t.step(intent);
      expect(await t.reload(intent)).toMatchObject({ current_gate: 'G2' });
      expect((await t.f.scope.escalations.getById(overdue!.id))?.status).toBe('closed');
    });

    it('routes to technical when Person A holds none of the gate roles (G3), with the plan as subject', async () => {
      t.setClock(T0);
      const intent = await atG2(t, 'medium');
      await t.f.addInputs(intent);
      await t.decide(intent, 'G2', 'approve', 'a');
      await t.settle(intent);
      expect(await t.reload(intent)).toMatchObject({ current_gate: 'G3' });
      t.setClock(new Date(T0.getTime() + 3 * DAY));
      await t.settle(intent);
      const overdue = (await t.f.scope.escalations.listForIntent(intent.id)).at(-1)!;
      expect(overdue).toMatchObject({
        route: 'technical',
        owner_id: t.f.users.b,
        packet: { gate: 'G3', subject_kind: 'plan', subject_sha256: PLAN_HASH },
      });
    });

    it('a missing input also runs the clock; a request for changes restarts it (one escalation per start)', async () => {
      t.setClock(T0);
      const intent = await atG2(t, 'medium');
      t.setClock(GATE_DEADLINE);
      expect(await t.settle(intent)).toEqual({ outcome: 'waiting', reason: 'input_missing' });
      const first = (await t.f.scope.escalations.listForIntent(intent.id)).at(-1)!;
      expect(first.packet).toMatchObject({ gate: 'G2', subject_kind: 'intent' });

      await t.f.addInputs(intent);
      const requestedAt = new Date(GATE_DEADLINE.getTime() + HOUR); // Monday 12:00 UTC, after hours
      t.setClock(requestedAt);
      await t.decide(intent, 'G2', 'request_changes', 'a', { reasonCode: 'spec_unclear' });
      // The gate was decided: the escalation closes, the clock starts again from the request.
      const restarted = await t.settle(intent);
      expect((await t.f.scope.escalations.getById(first.id))?.status).toBe('closed');
      // Next working day: 09:00–18:00 local on Tuesday = 11:00 UTC.
      const nextDeadline = new Date('2026-09-29T11:00:00.000Z');
      expect(restarted).toEqual({
        outcome: 'waiting',
        reason: 'decision',
        wakeInMs: nextDeadline.getTime() - requestedAt.getTime(),
      });
      t.setClock(nextDeadline);
      await t.settle(intent);
      await t.settle(intent);
      const overdue = (await t.f.scope.escalations.listForIntent(intent.id)).filter(
        (e) => e.trigger === 'time',
      );
      expect(overdue.map((e) => [e.status, e.packet.subject_kind])).toEqual([
        ['closed', 'intent'],
        ['open', 'spec'],
      ]);
    });

    it('its own freeze never blocks the advance; another escalation still freezes', async () => {
      t.setClock(T0);
      const intent = await t.f.newIntent();
      await t.settle(intent);
      t.setClock(GATE_DEADLINE);
      await t.settle(intent);
      const overdue = (await t.f.scope.escalations.listForIntent(intent.id)).at(-1)!;
      // Nobody acknowledges within its window: a missed notify escalation freezes (QUESTIONS #76).
      const later = new Date(GATE_DEADLINE.getTime() + 3 * DAY);
      t.setClock(later);
      await advanceEscalation(t.f.scope, overdue.id, later);
      expect((await t.f.scope.escalations.getById(overdue.id))?.ack_missed_at).not.toBeNull();

      const other = await raiseEscalation(
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
        { now: () => later },
      );
      await t.decide(intent, 'G1', 'approve', 'a');
      expect(await t.settle(intent)).toEqual({ outcome: 'waiting', reason: 'frozen' });
      expect((await t.f.scope.escalations.getById(overdue.id))?.status).toBe('closed');

      const { closeEscalation } = await import('../../../packages/core/src/escalation/decide.js');
      await closeEscalation(t.f.scope, { escalationId: other.id, closedBy: { type: 'system' } });
      await t.settle(intent);
      expect(await t.reload(intent)).toMatchObject({ current_gate: 'G2' });
    });
  });
});

describeDb('B07 session 2: dual approval from the configuration (FR-16)', () => {
  let db: TestDatabase;
  let t: Harness;
  let second: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    t = await harness(db);
    // A project that asks for Person B and a second approver at G3 (Medium).
    const configYaml = [
      'oversight:',
      '  matrix:',
      '    G3:',
      '      medium: { mode: HITL, roles: [person_b, second_approver], approvals: 2 }',
      '',
    ].join('\n');
    const loaded = loadProjectConfig(configYaml);
    if (!loaded.ok) throw new Error('bad test config');
    await t.f.scope.projectConfigs.save(t.f.target.projectId, {
      configYaml,
      configHash: loaded.configHash,
      updatedBy: null,
      expectedVersion: 0,
    });
    second = (await t.f.scope.users.create({ display_name: 's', email: 's@example.com' })).id;
    await t.f.scope.roleBindings.grant({
      user_id: second,
      project_id: t.f.target.projectId,
      role: 'second_approver',
    });
  }, 60_000);

  afterAll(async () => {
    await t?.f.close();
    await db?.drop();
  });

  it('one approval waits; the same person twice is refused; a second person moves the gate', async () => {
    const intent = await atG2(t, 'medium');
    await t.f.addInputs(intent);
    await t.decide(intent, 'G2', 'approve', 'a');
    await t.settle(intent);
    expect(await t.reload(intent)).toMatchObject({ current_gate: 'G3' });

    await t.decide(intent, 'G3', 'approve', 'b');
    expect(await t.settle(intent)).toMatchObject({ reason: 'decision' });
    await expect(t.decide(intent, 'G3', 'approve', 'b')).rejects.toMatchObject({
      reason: 'already_approved',
    });
    expect(await t.reload(intent)).toMatchObject({ current_gate: 'G3' });

    await t.decide(intent, 'G3', 'approve', second);
    expect(await t.settle(intent)).toEqual({ outcome: 'waiting', reason: 'later_gate' });
    const g3 = await t.f.scope.gateDecisions.listForIntent(intent.id, 'G3');
    expect(new Set(g3.map((d) => d.approver_role))).toEqual(
      new Set(['person_b', 'second_approver']),
    );
  });

  describe('H08 (ADR-M111 §2.2): break-glass `hotl_window_skip`', () => {
    it('an active grant ends the G2 and G3 windows; after its expiry they hold again', async () => {
      t.setClock(T0);
      const intent = await atG2(t, 'low');
      await t.f.addInputs(intent);
      await t.settle(intent);
      expect(await hotlBlockWindowOpenUntil(t.f.scope, t.f.registry, intent.id)).toEqual(
        WINDOW_END,
      );
      await t.f.scope.breakGlass.request({
        project_id: intent.project_id,
        intent_id: intent.id,
        operator_id: t.f.users.a,
        scopes: ['hotl_window_skip'],
        duration_seconds: 3600,
        reason_url: 'https://github.com/acme/shop/issues/1#issuecomment-21',
        lapses_at: new Date(T0.getTime() + 1_800_000),
      });
      await approveBreakGlass(t.f.scope, { intentRef: intent.code, actorId: t.f.users.b, now: T0 });
      expect(await hotlBlockWindowOpenUntil(t.f.scope, t.f.registry, intent.id, T0)).toBeNull();
      expect(await t.settle(intent)).not.toMatchObject({ reason: 'hotl_block_window' });
      const later = new Date(T0.getTime() + 2 * 3_600_000);
      expect(await hotlBlockWindowOpenUntil(t.f.scope, t.f.registry, intent.id, later)).toEqual(
        WINDOW_END,
      );
    });
  });
});
