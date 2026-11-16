// D-08 E03 AC1–AC3 on a live PostgreSQL, without Temporal (design/ADR-M49, QUESTIONS #220–#222;
// D-02 FR-10, FR-11, FR-12, FR-17, FR-40, FR-43). An intent taken through G7 by the G7 world
// (`g7-world.ts`); the release pack is built with an in-memory evidence store, as the worker's
// activity `buildReleasePack` builds it.
// - AC1: Person B approves G8 (and the second approver at Critical risk); the approval is bound to
//   the pack's release hash: a changed pack voids it, a new G8 approval does not; producers never
//   decide (approve, reject, request changes);
// - AC2: no project AI record, so no disclosure note → a system `fail ai_record_missing`, once;
// - AC3: the latest version is sealed once, `evidence.pack_sealed` and `intent.closed` (coded
//   metrics) are recorded, the intent ends `done` (notice `released`);
// - a rejection → `rejected`; a request for changes keeps the intent at G8; the gate deadline
//   raises an escalation; a freeze holds the release; a tampered evidence file → paused with a
//   `security` escalation, `resume` → G8, `terminate` → `cancelled` (#221).
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';

import type { IntentStepResult } from '../../../packages/contracts/src/index.js';
import { decideGate } from '../../../packages/core/src/commands/gate-command.js';
import type { Intent } from '../../../packages/core/src/db/schema.js';
import {
  approveBreakGlass,
  revokeBreakGlass,
} from '../../../packages/core/src/break-glass/index.js';
import { raiseEscalation } from '../../../packages/core/src/escalation/raise.js';
import { currentPackHashes } from '../../../packages/core/src/evidence/build.js';
import { buildReleasePack } from '../../../packages/core/src/workflow/g8.js';
import { stepIntent } from '../../../packages/core/src/workflow/step.js';
import { HOUR, notices, waitingRow } from '../g4-harness.js';
import { CAROL, DAY, g7World } from './g7-world.js';
import { describeDb, tamper } from './helpers.js';
import { MemoryEvidenceStore, sha256 } from './memory-evidence-store.js';

interface Manifest {
  readonly gate_decisions: readonly { readonly gate: string; readonly decision: string }[];
  readonly build: { readonly release_sha256: string };
}

describeDb('E03: gate G8, release, on PostgreSQL', () => {
  const w = g7World();
  let store = new MemoryEvidenceStore();

  const scope = () => w.t.f.scope;
  const builds: string[] = [];

  /** The step as the worker runs it with releases on: `build_pack` runs the pack activity. */
  const settle = async (intent: Intent, releases = true): Promise<IntentStepResult> => {
    for (let i = 0; i < 20; i += 1) {
      const result = await stepIntent(
        scope(),
        {
          registry: w.t.f.registry,
          g4: w.t.g4,
          startRuns: true,
          publish: true,
          g6: w.g6,
          g7: w.g7,
          releases,
        },
        intent.id,
      );
      if (result.outcome === 'moved') continue;
      if (result.outcome !== 'build_pack') return result;
      const outcome = await buildReleasePack(
        scope(),
        {
          registry: w.t.f.registry,
          store,
          maxItemBytes: 1024 * 1024,
          now: () => w.t.f.registry.now(),
        },
        intent.id,
      );
      builds.push(outcome);
      if (outcome === 'unavailable') return result;
    }
    throw new Error('the step never settled');
  };

  /** Stores an evidence file as the runner does and records its row. */
  const storeItem = async (intent: Intent, name: string, text: string) => {
    const run = (await scope().runs.listForIntent(intent.id)).at(-1)!;
    const key = `diffs/${scope().tenantId}/${intent.id}/${name}.patch`;
    const bytes = Buffer.from(text);
    store.objects.set(key, bytes);
    await scope().evidenceItems.record({
      intentId: intent.id,
      runId: run.id,
      kind: 'diff',
      storageUri: `s3://evidence/${key}`,
      sha256: sha256(bytes),
      sizeBytes: bytes.length,
    });
    return key;
  };

  /** An intent through G7: Carol (Person B) approves and merges; its diff stored. */
  const toG8 = async (risk: 'medium' | 'critical' = 'medium'): Promise<Intent> => {
    store = new MemoryEvidenceStore();
    const intent = await w.toG7();
    w.review(CAROL, 'approved');
    await w.step(intent);
    w.merge(CAROL);
    await w.step(intent);
    expect(await w.reload(intent)).toMatchObject({ status: 'in_gate', current_gate: 'G8' });
    await storeItem(intent, 'run', 'diff --git a/a b/a\n+x\n');
    // Critical intents never run an agent (L0): the tier is raised after G7 to test G8's rule M3.
    if (risk === 'critical') {
      await tamper(w.db.name, `UPDATE intents SET risk_tier = 'critical' WHERE id = $1`, [
        intent.id,
      ]);
    }
    return w.reload(intent);
  };

  const decide = async (
    intent: Intent,
    decision: 'approve' | 'reject' | 'request_changes',
    userId: string,
  ) =>
    decideGate(w.t.f.registry, scope(), {
      intent: await w.reload(intent),
      gate: 'G8',
      decision,
      actorId: userId,
      ...(decision === 'approve' ? {} : { reasonCode: 'other' as const }),
      source: 'github_comment',
    });

  const g8 = async (intent: Intent) =>
    (await scope().gateDecisions.listForIntent(intent.id, 'G8')).map((d) => [
      d.decision,
      d.reason_code,
      d.actor_type,
    ]);
  const packs = (intent: Intent) => scope().evidencePacks.listForIntent(intent.id);
  const audit = (intent: Intent, action: 'intent.closed' | 'gate.g8_check_failed') =>
    scope().audit.listForEntity(intent.id, [action]);
  const carol = () => w.users.carol;

  describe('AC1, AC3: Person B approves the release; the pack is sealed; the intent is done', () => {
    it('builds the pack, waits for Person B, seals the version with the approval, closes', async () => {
      const intent = await toG8();
      expect(await settle(intent, false)).toMatchObject({ reason: 'evidence_unavailable' });
      expect(await waitingRow(scope(), intent)).toMatchObject({ reason: 'evidence_unavailable' });
      expect(await settle(intent)).toMatchObject({ outcome: 'waiting', reason: 'g8_decision' });
      expect(await waitingRow(scope(), intent)).toMatchObject({ reason: 'g8_decision' });
      const [v1] = await packs(intent);
      expect(v1).toMatchObject({ version: 1, sealed_at: null, built_by: null });
      expect(v1!.release_sha256).toMatch(/^[0-9a-f]{64}$/);
      // The step's database-only hashes equal the build's (no loop between them).
      expect(await currentPackHashes(scope(), await w.reload(intent))).toEqual({
        contentSha256: v1!.content_sha256,
        releaseSha256: v1!.release_sha256,
      });
      expect(await notices(w.t, intent)).toContain('g8_review_needed');
      // The step again changes nothing (idempotent): no new version, one notice.
      await settle(intent);
      expect(await packs(intent)).toHaveLength(1);
      expect((await notices(w.t, intent)).filter((k) => k === 'g8_review_needed')).toHaveLength(1);

      w.later(2 * HOUR);
      const approval = await decide(intent, 'approve', carol());
      expect(approval).toMatchObject({ approver_role: 'person_b', oversight_mode: 'HITL' });
      expect(approval.waited_seconds).toBeGreaterThanOrEqual(2 * 3600);
      expect(await settle(intent)).toEqual({ outcome: 'finished', status: 'done' });

      const all = await packs(intent);
      const sealed = all.filter((p) => p.sealed_at !== null);
      expect(sealed).toHaveLength(1);
      // The sealed version is the latest, and it lists the G8 approval (FR-40: 8 gates).
      expect(sealed[0]!.version).toBe(all.at(-1)!.version);
      expect(sealed[0]!.release_sha256).toBe(v1!.release_sha256);
      const manifest = JSON.parse(store.text(sealed[0]!.manifest_uri)) as Manifest;
      expect(manifest.gate_decisions.filter((d) => d.gate === 'G8')).toEqual([
        expect.objectContaining({ decision: 'approve' }),
      ]);
      expect(manifest.build.release_sha256).toBe(v1!.release_sha256);

      const closed = await audit(intent, 'intent.closed');
      expect(closed).toHaveLength(1);
      expect(closed[0]!.payload).toMatchObject({
        pack_id: sealed[0]!.id,
        pack_version: sealed[0]!.version,
        release_sha256: v1!.release_sha256,
        runs: 1,
        g7_change_requests: 0,
      });
      const metrics = closed[0]!.payload;
      expect(metrics.cost_usd).toMatch(/^\d+\.\d+$/);
      expect(metrics.input_tokens).toMatch(/^\d+$/);
      // From the intent's creation (database clock) to the release (the test's clock): an integer.
      expect(Number.isSafeInteger(closed[0]!.payload.lead_time_seconds)).toBe(true);
      const sealedEvents = await scope().audit.listForEntity(sealed[0]!.id, [
        'evidence.pack_sealed',
      ]);
      expect(sealedEvents).toHaveLength(1);
      expect(await notices(w.t, intent)).toContain('released');
      expect(await w.reload(intent)).toMatchObject({ status: 'done', current_gate: 'G8' });
      // Sealed once: the repository refuses a second seal; no build after the seal.
      expect(await scope().evidencePacks.seal(sealed[0]!.id, new Date())).toBeUndefined();
      expect(
        await buildReleasePack(
          scope(),
          {
            registry: w.t.f.registry,
            store,
            maxItemBytes: 1024,
            now: () => w.t.f.registry.now(),
          },
          intent.id,
        ),
      ).toBe('skipped');
    });

    it('producers never decide G8: approve, reject and request changes are refused', async () => {
      const intent = await toG8();
      await settle(intent);
      // Person A created the intent and holds Person B here (the G7 world): a producer.
      for (const decision of ['approve', 'reject', 'request_changes'] as const) {
        await expect(decide(intent, decision, w.t.f.users.a)).rejects.toMatchObject({
          code: 'decision_not_allowed',
        });
      }
      // A viewer has no G8 role.
      await expect(decide(intent, 'approve', w.users.viewer)).rejects.toThrow();
      expect(await g8(intent)).toEqual([]);
    });

    it('Critical: Person B and the second approver; a new G8 approval never voids another', async () => {
      const intent = await toG8('critical');
      expect(await settle(intent)).toMatchObject({ reason: 'g8_decision' });
      await decide(intent, 'approve', carol());
      expect(await settle(intent)).toMatchObject({ reason: 'g8_decision' });
      // The pack was built again (it lists the approval), with the same release hash.
      const [v1, v2] = await packs(intent);
      expect(v2!.release_sha256).toBe(v1!.release_sha256);
      expect(v2!.content_sha256).not.toBe(v1!.content_sha256);
      await decide(intent, 'approve', w.users.second);
      expect(await settle(intent)).toEqual({ outcome: 'finished', status: 'done' });
      expect(await g8(intent)).toEqual([
        ['approve', null, 'human'],
        ['approve', null, 'human'],
      ]);
    });

    it('FR-17: a changed pack (new evidence) voids the earlier G8 approval', async () => {
      const intent = await toG8('critical');
      await settle(intent);
      await decide(intent, 'approve', carol());
      await settle(intent);
      await storeItem(intent, 'late', 'diff --git a/b b/b\n+y\n');
      expect(await settle(intent)).toMatchObject({ reason: 'g8_decision' });
      expect(await g8(intent)).toEqual([
        ['approve', null, 'human'],
        ['void', 'input_mismatch', 'system'],
      ]);
      await decide(intent, 'approve', w.users.second);
      // One valid approval left: the release waits for a second one.
      expect(await settle(intent)).toMatchObject({ reason: 'g8_decision' });
      await decide(intent, 'approve', carol());
      expect(await settle(intent)).toEqual({ outcome: 'finished', status: 'done' });
    });
  });

  describe('AC2: no disclosure note without the project AI record', () => {
    it('fails ai_record_missing once and waits; the AI record back → the pack is built', async () => {
      const intent = await toG8();
      const record = await w.db.owner
        .selectFrom('project_ai_records')
        .selectAll()
        .where('project_id', '=', intent.project_id)
        .executeTakeFirstOrThrow();
      await tamper(w.db.name, 'DELETE FROM project_ai_records WHERE project_id = $1', [
        intent.project_id,
      ]);
      expect(await settle(intent)).toMatchObject({ reason: 'ai_record' });
      expect(await settle(intent)).toMatchObject({ reason: 'ai_record' });
      expect(await g8(intent)).toEqual([['fail', 'ai_record_missing', 'system']]);
      expect(await notices(w.t, intent)).toContain('g8_refused');
      expect(await packs(intent)).toEqual([]);
      // No approval is possible without a pack to bind it to.
      await expect(decide(intent, 'approve', carol())).rejects.toMatchObject({
        code: 'gate_input_missing',
      });
      const columns = Object.keys(record);
      await tamper(
        w.db.name,
        `INSERT INTO project_ai_records (${columns.join(', ')}) VALUES (${columns
          .map((_, i) => `$${String(i + 1)}`)
          .join(', ')})`,
        columns.map((c) => (record as Record<string, unknown>)[c]),
      );
      expect(await settle(intent)).toMatchObject({ reason: 'g8_decision' });
      expect(await packs(intent)).toHaveLength(1);
    });
  });

  describe('rejection, request for changes, deadline, freeze', () => {
    it('a rejection by Person B ends the intent; nothing is sealed', async () => {
      const intent = await toG8();
      await settle(intent);
      await decide(intent, 'reject', carol());
      expect(await settle(intent)).toEqual({ outcome: 'finished', status: 'rejected' });
      expect((await packs(intent)).some((p) => p.sealed_at !== null)).toBe(false);
    });

    it('a request for changes keeps the intent at G8; approvals before it no longer count', async () => {
      const intent = await toG8('critical');
      await settle(intent);
      await decide(intent, 'approve', carol());
      await settle(intent);
      await decide(intent, 'request_changes', w.t.f.users.b);
      expect(await settle(intent)).toMatchObject({ reason: 'g8_decision' });
      expect(await notices(w.t, intent)).toContain('g8_changes_requested');
      await decide(intent, 'approve', w.users.second);
      expect(await settle(intent)).toMatchObject({ reason: 'g8_decision' });
      expect(await w.reload(intent)).toMatchObject({ status: 'in_gate', current_gate: 'G8' });
    });

    it('FR-12: the gate deadline raises one overdue escalation, closed by the release', async () => {
      const intent = await toG8();
      await settle(intent);
      w.later(3 * DAY);
      expect(await settle(intent)).toMatchObject({ reason: 'g8_decision' });
      expect(await settle(intent)).toMatchObject({ reason: 'g8_decision' });
      const overdue = (await scope().escalations.listForIntent(intent.id)).filter(
        (e) => e.trigger === 'time' && e.packet.gate === 'G8',
      );
      expect(overdue).toHaveLength(1);
      expect(overdue[0]!.packet.subject_kind).toBe('g8_input');
      await decide(intent, 'approve', carol());
      expect(await settle(intent)).toEqual({ outcome: 'finished', status: 'done' });
      const after = await scope().escalations.getById(overdue[0]!.id);
      expect(after?.status).toBe('closed');
    });

    it('the deadline runs while the worker cannot build the pack (no evidence store)', async () => {
      const intent = await toG8();
      w.later(3 * DAY);
      expect(await settle(intent, false)).toMatchObject({ reason: 'evidence_unavailable' });
      const overdue = (await scope().escalations.listForIntent(intent.id)).filter(
        (e) => e.trigger === 'time' && e.packet.gate === 'G8',
      );
      expect(overdue).toHaveLength(1);
      expect(await packs(intent)).toEqual([]);
    });

    it('a freeze holds the release (`release` is a protected action)', async () => {
      const intent = await toG8();
      await raiseEscalation(
        scope(),
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
        { now: () => w.t.f.registry.now() },
      );
      await settle(intent);
      await decide(intent, 'approve', carol());
      expect(await settle(intent)).toMatchObject({ outcome: 'waiting', reason: 'frozen' });
      expect((await packs(intent)).some((p) => p.sealed_at !== null)).toBe(false);
    });
  });

  describe('QUESTIONS #221: a tampered evidence file stops G8', () => {
    it('paused with a security escalation; resume after the fix → G8; then the release', async () => {
      const intent = await toG8();
      const key = [...store.objects.keys()].find((k) => k.startsWith('diffs/'))!;
      const original = store.objects.get(key)!;
      store.objects.set(key, Buffer.from('changed'));
      expect(await settle(intent)).toMatchObject({ reason: 'g8_review' });
      expect(await w.reload(intent)).toMatchObject({ status: 'paused', current_gate: 'G8' });
      expect((await audit(intent, 'gate.g8_check_failed')).map((e) => e.payload)).toEqual([
        expect.objectContaining({ check: 'evidence_hash_mismatch' }),
      ]);
      const escalation = (await scope().escalations.listForIntent(intent.id)).at(-1)!;
      expect(escalation).toMatchObject({ route: 'security' });
      expect(escalation.packet).toMatchObject({ gate: 'G8', subject_kind: 'g8_input' });
      expect(await notices(w.t, intent)).toContain('g8_escalated');
      // A producer is never an approver of the escalation either (FR-18).
      expect(escalation.producer_ids).toContain(w.t.f.users.a);

      store.objects.set(key, original);
      await w.decideOn(intent, 'resume');
      expect(await settle(intent)).toMatchObject({ reason: 'g8_decision' });
      expect(await notices(w.t, intent)).toContain('g8_resumed');
      await decide(intent, 'approve', carol());
      expect(await settle(intent)).toEqual({ outcome: 'finished', status: 'done' });
    });

    it('terminate → cancelled; nothing is sealed', async () => {
      const intent = await toG8();
      const key = [...store.objects.keys()].find((k) => k.startsWith('diffs/'))!;
      store.objects.delete(key);
      expect(await settle(intent)).toMatchObject({ reason: 'g8_review' });
      expect((await audit(intent, 'gate.g8_check_failed')).map((e) => e.payload)).toEqual([
        expect.objectContaining({ check: 'evidence_missing' }),
      ]);
      await w.decideOn(intent, 'terminate');
      expect(await settle(intent)).toEqual({ outcome: 'finished', status: 'cancelled' });
      expect((await packs(intent)).some((p) => p.sealed_at !== null)).toBe(false);
    });
  });

  describe('H08 (ADR-M111 §2.8): G8 waits for the break-glass review', () => {
    it('no release while a grant is active or unreviewed; the review lets it close', async () => {
      const intent = await toG8();
      const now = w.t.f.registry.now();
      await scope().breakGlass.request({
        project_id: intent.project_id,
        intent_id: intent.id,
        operator_id: w.t.f.users.a,
        scopes: ['runner_priority'],
        duration_seconds: 3600,
        reason_url: 'https://github.com/acme/shop/issues/1#issuecomment-11',
        lapses_at: new Date(now.getTime() + HOUR),
      });
      await approveBreakGlass(scope(), { intentRef: intent.code, actorId: carol(), now });
      await settle(intent);
      await decide(intent, 'approve', carol());
      expect(await settle(intent)).toMatchObject({
        outcome: 'waiting',
        reason: 'break_glass_review',
      });
      const { grant } = await revokeBreakGlass(scope(), {
        intentRef: intent.code,
        actor: { type: 'system' },
        now,
      });
      expect(await settle(intent)).toMatchObject({ reason: 'break_glass_review' });
      expect((await packs(intent)).some((p) => p.sealed_at !== null)).toBe(false);
      await scope().breakGlass.update(grant.id, {
        review_url: 'https://github.com/acme/shop/issues/1#issuecomment-12',
        reviewed_by: w.t.f.users.a,
        reviewed_at: now,
      });
      await settle(intent);
      expect(await notices(w.t, intent)).toContain('released');
    });
  });

  describe('migration 0022', () => {
    it('release_sha256 is fixed once written; platform_app may seal (sealed_at) only', async () => {
      const intent = await toG8();
      await settle(intent);
      const [pack] = await packs(intent);
      await expect(
        sql`UPDATE evidence_packs SET release_sha256 = ${'0'.repeat(64)} WHERE id = ${pack!.id}`.execute(
          w.db.owner,
        ),
      ).rejects.toMatchObject({ code: 'SDA14' });
      await expect(
        sql`UPDATE evidence_packs SET retention_hold = true WHERE id = ${pack!.id}`.execute(
          w.db.appRaw,
        ),
      ).rejects.toThrow(/permission denied/);
    });
  });
});
