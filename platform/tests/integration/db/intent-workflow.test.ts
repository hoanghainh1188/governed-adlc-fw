// D-08 B07 (session 1) on a live PostgreSQL, without Temporal: one step of the intent workflow
// (`stepIntent`), the gate status comments (FR-22), the wake signals of the poller, and the
// reconcile listing (design/ADR-M30). The Temporal side is in integration/workflow.
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { IntentWorkflowRef } from '../../../packages/contracts/src/intent-workflow.js';
import type { Intent } from '../../../packages/core/src/db/schema.js';
import { parseTenantId } from '../../../packages/core/src/db/tenant-id.js';
import { closeEscalation } from '../../../packages/core/src/escalation/decide.js';
import { raiseEscalation } from '../../../packages/core/src/escalation/raise.js';
import { decideGate } from '../../../packages/core/src/commands/gate-command.js';
import { stepIntent, WorkflowError } from '../../../packages/core/src/workflow/step.js';
import { t } from '../../../packages/messages/src/index.js';
import { createWorkflowFixture, SPEC_HASH, type WorkflowFixture } from '../workflow/fixture.js';
import { createTestDatabase, describeDb, type TestDatabase } from './helpers.js';

const T0 = new Date('2026-09-28T01:00:00.000Z'); // Monday, inside working hours

describeDb('B07: the intent workflow step on PostgreSQL', () => {
  let db: TestDatabase;
  let f: WorkflowFixture;
  const step = (intent: Intent) => stepIntent(f.scope, { registry: f.registry }, intent.id);
  const reload = async (intent: Intent) => (await f.scope.intents.getById(intent.id))!;
  const notices = (intent: Intent) => f.scope.intentNotices.listForIntent(intent.id);

  /** Steps until the workflow would wait or end; returns what it would do then. */
  async function settle(intent: Intent) {
    for (let i = 0; i < 10; i += 1) {
      const result = await step(intent);
      if (result.outcome !== 'moved') return result;
    }
    throw new Error('the step never settled');
  }

  beforeAll(async () => {
    db = await createTestDatabase();
    f = await createWorkflowFixture(db, () => T0);
    f.h.stub.now = T0;
  }, 60_000);

  afterAll(async () => {
    await f?.close();
    await db?.drop();
  });

  describe('AC1: Draft → G1 → G2 → G3 on people’s decisions (D-03 section 6)', () => {
    it('moves one gate per approval and waits for input and decisions', async () => {
      const intent = await f.newIntent();
      expect(intent.status).toBe('draft');

      // Creating the intent is the submit (QUESTIONS #89): draft → G1.
      expect(await step(intent)).toEqual({ outcome: 'moved' });
      expect(await reload(intent)).toMatchObject({ status: 'in_gate', current_gate: 'G1' });
      expect((await reload(intent)).gate_entered_at).toEqual(T0);
      expect(await step(intent)).toMatchObject({ outcome: 'waiting', reason: 'decision' });

      // No gate passes by silence: nothing moves without a person's approval.
      expect(await settle(intent)).toMatchObject({ outcome: 'waiting', reason: 'decision' });

      const woken: IntentWorkflowRef[] = [];
      const signals = {
        wake: (ref: IntentWorkflowRef) => {
          woken.push(ref);
          return Promise.resolve();
        },
        kill: () => Promise.resolve(),
      };
      f.comment(intent, '/approve G1', 'a');
      await f.poll(signals);
      // The poller wakes the workflow after its commit (ADR-M30 §2.3).
      expect(woken).toEqual([{ tenantId: f.target.tenantId, intentId: intent.id }]);

      expect(await settle(intent)).toMatchObject({ outcome: 'waiting', reason: 'input_missing' });
      expect(await reload(intent)).toMatchObject({ status: 'in_gate', current_gate: 'G2' });

      await f.addInputs(intent);
      expect(await settle(intent)).toMatchObject({ outcome: 'waiting', reason: 'decision' });
      f.comment(intent, '/approve G2', 'a');
      await f.poll();
      expect(await settle(intent)).toMatchObject({ outcome: 'waiting', reason: 'decision' });
      expect(await reload(intent)).toMatchObject({ current_gate: 'G3' });

      f.comment(intent, '/approve G3', 'b');
      await f.poll();
      // G4 belongs to C06: the intent waits there.
      expect(await settle(intent)).toEqual({ outcome: 'waiting', reason: 'later_gate' });
      expect(await reload(intent)).toMatchObject({ status: 'in_gate', current_gate: 'G4' });

      // Every move is audited, in order, with the system as actor.
      const moves = (
        await sql<{ payload: Record<string, unknown>; actor_type: string }>`
          SELECT payload, actor_type FROM audit_log
          WHERE entity_id = ${intent.id} AND action = 'intent.state_changed' ORDER BY seq`.execute(
          db.owner,
        )
      ).rows;
      expect(moves.map((m) => m.payload.current_gate)).toEqual(['G1', 'G2', 'G3', 'G4']);
      expect(new Set(moves.map((m) => m.actor_type))).toEqual(new Set(['system']));

      // FR-22: one status notice per status change, codes only.
      expect(
        (await notices(intent)).map((n) => [n.kind, n.gate, n.previous_gate, n.audience_roles]),
      ).toEqual([
        ['submitted', 'G1', null, ['person_a']],
        ['advanced', 'G2', 'G1', ['person_a']],
        ['advanced', 'G3', 'G2', ['person_b']],
        ['advanced', 'G4', 'G3', []],
      ]);
    });

    it('posts the status comments on the issue: they confirm successful commands (FR-22)', async () => {
      const intent = await f.newIntent();
      await settle(intent);
      f.comment(intent, '/approve G1', 'a');
      await f.poll(); // records the approval; posts the "submitted" comment
      await settle(intent);
      const result = await f.poll(); // posts the "advanced" comment
      expect(result.statusPosted).toBe(1);
      const posted = f.posted(intent);
      expect(posted).toEqual([
        expect.stringContaining(
          t('intent.status.submitted', {
            code: intent.code,
            gate_name: t('gate.name.g1'),
            mentions: '@alice',
          }),
        ),
        expect.stringContaining(
          t('intent.status.advanced', {
            code: intent.code,
            previous_gate: 'G1',
            deciders: '@alice',
            gate: 'G2',
            gate_name: t('gate.name.g2'),
            mentions: '@alice',
          }),
        ),
      ]);
      // A successful command gets no reply of its own; the status comment is the confirmation.
      expect(posted.filter((body) => body.includes('comment.reply'))).toEqual([]);
      expect((await notices(intent)).every((n) => n.posted_at !== null)).toBe(true);
    });

    it('a rejection ends the intent; the workflow is finished', async () => {
      const intent = await f.newIntent();
      await settle(intent);
      f.comment(intent, '/reject G1 spec_unclear', 'a');
      await f.poll();
      expect(await settle(intent)).toEqual({ outcome: 'finished', status: 'rejected' });
      expect(await reload(intent)).toMatchObject({ status: 'rejected', current_gate: 'G1' });
      const [, rejected] = await notices(intent);
      expect(rejected).toMatchObject({ kind: 'rejected', status: 'rejected', gate: 'G1' });
      await f.poll();
      expect(f.posted(intent).at(-1)).toContain('`spec_unclear`');
      // A rejected intent frees its issue for a new intent (QUESTIONS #68).
      await expect(
        f.registry.createIntent(f.scope, {
          projectId: f.target.projectId,
          title: 'Again',
          createdBy: f.users.a,
          riskTier: 'low',
          dataClass: 'internal',
          issueNumber: intent.issue_number,
        }),
      ).resolves.toMatchObject({ status: 'draft' });
    });

    it('a request for changes keeps the gate; approvals before it do not count', async () => {
      const intent = await f.newIntent();
      await settle(intent);
      f.comment(intent, '/approve G1', 'a');
      await f.poll();
      await settle(intent);
      await f.addInputs(intent);
      // Person A approves G2 and then asks for changes, before the workflow looks.
      f.comment(intent, '/approve G2', 'a');
      f.comment(intent, '/request-changes G2 tests_insufficient', 'a');
      await f.poll();
      expect(await settle(intent)).toMatchObject({ outcome: 'waiting', reason: 'decision' });
      expect(await reload(intent)).toMatchObject({ current_gate: 'G2' });
      // Announced once, however often the workflow looks.
      await settle(intent);
      expect((await notices(intent)).filter((n) => n.kind === 'changes_requested')).toHaveLength(1);

      // A new spec version voids the old approval (FR-17); a fresh approval moves the gate.
      await f.registry.linkSpec(f.scope, intent.id, {
        path: 'docs/specs/t07.md',
        commitSha: 'd'.repeat(40),
        contentSha256: '7'.repeat(64),
        structure: 'manual_heading',
        acceptanceCriteria: 1,
        actorType: 'human',
        actorId: f.users.a,
      });
      await settle(intent);
      const voids = (await f.scope.gateDecisions.listForIntent(intent.id, 'G2')).filter(
        (d) => d.decision === 'void',
      );
      expect(voids).toEqual([expect.objectContaining({ reason_code: 'input_mismatch' })]);
      f.comment(intent, '/approve G2', 'a');
      await f.poll();
      await settle(intent);
      expect(await reload(intent)).toMatchObject({ current_gate: 'G3' });
    });
  });

  describe('AC3 (basic): approvals bound to the input are re-checked before the move', () => {
    it('an approval of an older spec is voided and the gate waits', async () => {
      const intent = await f.newIntent();
      await settle(intent);
      f.comment(intent, '/approve G1', 'a');
      await f.poll();
      await settle(intent);
      await f.addInputs(intent);
      f.comment(intent, '/approve G2', 'a');
      await f.poll();
      // The spec changes after the approval and before the workflow moves on (FR-02, FR-17).
      await f.registry.linkSpec(f.scope, intent.id, {
        path: 'docs/specs/t07.md',
        commitSha: 'e'.repeat(40),
        contentSha256: '8'.repeat(64),
        structure: 'manual_heading',
        acceptanceCriteria: 1,
        actorType: 'human',
        actorId: f.users.a,
      });
      expect(await settle(intent)).toMatchObject({ outcome: 'waiting', reason: 'decision' });
      const g2 = await f.scope.gateDecisions.listForIntent(intent.id, 'G2');
      expect(g2.map((d) => [d.decision, d.input_sha256])).toEqual([
        ['approve', SPEC_HASH],
        ['void', SPEC_HASH],
      ]);
    });
  });

  describe('freeze (ADR-M28 §2.4): gate_advance waits while an escalation freezes the intent', () => {
    it('waits frozen, then moves once the escalation is closed', async () => {
      const intent = await f.newIntent();
      await settle(intent);
      f.comment(intent, '/approve G1', 'a');
      await f.poll();
      const escalation = await raiseEscalation(
        f.scope,
        {
          intentId: intent.id,
          trigger: 'uncertainty',
          route: 'intent',
          severity: 'high',
          responseLevel: 'pause',
          packet: { subject_kind: 'intent', subject_sha256: '9'.repeat(64), gate: 'G1' },
          producers: [],
          raisedBy: { type: 'system' },
        },
        { now: () => T0 },
      );
      expect(await settle(intent)).toEqual({ outcome: 'waiting', reason: 'frozen' });
      expect(await reload(intent)).toMatchObject({ current_gate: 'G1' });
      await closeEscalation(
        f.scope,
        { escalationId: escalation.id, closedBy: { type: 'system' } },
        { now: () => T0 },
      );
      await settle(intent);
      expect(await reload(intent)).toMatchObject({ current_gate: 'G2' });
    });
  });

  describe('AC5 (database side): a repeated or concurrent step never moves twice', () => {
    it('two steps at once make one move and one notice', async () => {
      const intent = await f.newIntent();
      await Promise.all([step(intent), step(intent), step(intent)]);
      expect(await reload(intent)).toMatchObject({ current_gate: 'G1' });
      expect(await notices(intent)).toHaveLength(1);
    });

    it('a compare-and-set from a stale state changes nothing', async () => {
      const intent = await f.newIntent();
      await settle(intent);
      const moved = await f.scope.intents.moveState(intent.id, {
        from: { status: 'draft', currentGate: null },
        to: { status: 'in_gate', currentGate: 'G1' },
        at: T0,
      });
      expect(moved).toBeUndefined();
    });

    it('an unknown intent fails without retry value (WorkflowError)', async () => {
      await expect(
        stepIntent(f.scope, { registry: f.registry }, '00000000-0000-4000-8000-000000000000'),
      ).rejects.toBeInstanceOf(WorkflowError);
    });
  });

  describe('decisions count only at the current gate (gate_not_current)', () => {
    it('refuses a comment for another gate, with a reply', async () => {
      const intent = await f.newIntent();
      await settle(intent);
      f.comment(intent, '/approve G2', 'a');
      await f.poll();
      expect(f.posted(intent)).toContainEqual(
        expect.stringContaining(t('comment.reply.gate_not_current', { gate: 'G2' })),
      );
      expect(await f.scope.gateDecisions.listForIntent(intent.id)).toEqual([]);
    });
    it('checks the gate on the locked intent, not on a stale copy (review of B07)', async () => {
      const intent = await f.newIntent();
      await settle(intent);
      const stale = await reload(intent); // at G1
      f.comment(intent, '/approve G1', 'a');
      await f.poll();
      await settle(intent); // the workflow moved it to G2
      await expect(
        decideGate(f.registry, f.scope, {
          intent: stale,
          gate: 'G1',
          decision: 'approve',
          actorId: f.users.a,
          source: 'cli',
        }),
      ).rejects.toMatchObject({ code: 'gate_not_current' });
    });
  });

  describe('wake signals and the reconcile listing (ADR-M30 §2.3)', () => {
    it('a failed wake never fails the poll', async () => {
      const intent = await f.newIntent();
      await settle(intent);
      f.comment(intent, '/approve G1', 'a');
      const result = await f.poll({
        wake: () => Promise.reject(new Error('down')),
        kill: () => Promise.resolve(),
      });
      expect(result.status).toBe('polled');
      expect(result.outcomes.decided).toBe(1);
    });

    it('lists open intents of active tenants, IDs only, in keyset pages', async () => {
      const all = [];
      let after: { tenantId: string; intentId: string } | undefined;
      for (;;) {
        const page = await db.app.system.listOpenIntents(2, after);
        all.push(...page);
        if (page.length < 2) break;
        after = page.at(-1);
      }
      for (const row of all) expect(Object.keys(row).sort()).toEqual(['intentId', 'tenantId']);
      const open = await f.scope.intents.listForProject(f.target.projectId);
      const expected = open.filter((i) => !['done', 'rejected', 'cancelled'].includes(i.status));
      expect(all.map((r) => r.intentId).sort()).toEqual(expected.map((i) => i.id).sort());
      expect(new Set(all.map((r) => r.tenantId))).toEqual(
        new Set([parseTenantId(f.target.tenantId)]),
      );
    });
  });

  describe('storage rules', () => {
    it('platform_app cannot delete or rewrite a delivered status notice', async () => {
      const [notice] = (
        await sql<{ id: string }>`SELECT id FROM intent_notices
        WHERE posted_at IS NOT NULL LIMIT 1`.execute(db.owner)
      ).rows;
      await expect(
        sql`UPDATE intent_notices SET attempts = 0 WHERE id = ${notice!.id}`.execute(
          db.appAs(f.target.tenantId),
        ),
      ).rejects.toThrow();
      await expect(
        sql`DELETE FROM intent_notices WHERE id = ${notice!.id}`.execute(
          db.appAs(f.target.tenantId),
        ),
      ).rejects.toThrow();
    });
  });
});
