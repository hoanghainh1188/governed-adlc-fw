// D-08 C13 on a live PostgreSQL (design/ADR-M64, QUESTIONS #335–#337): an L1 (High risk) run
// stored its proposal and the intent is paused at G4 (`proposal_review`).
// - A person with a role in `access.evidence_read_roles` reads the patch: checked against its row
//   first (a changed, missing or oversized file is refused and audited `evidence.check_failed`);
//   every read is audited `evidence.proposal_read` (run, hash, size; never the content).
// - Person A ends the intent with a G4 rejection: the next step moves it to `rejected` with the
//   decision and the status notice. Only that decision, only in that paused case.
import crypto from 'node:crypto';

import { PROPOSAL_MAX_BYTES } from '@sdlc/contracts';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

import { CommandError } from '../../../packages/core/src/commands/errors.js';
import { decideGate } from '../../../packages/core/src/commands/gate-command.js';
import type { Intent } from '../../../packages/core/src/db/schema.js';
import { EvidencePackError } from '../../../packages/core/src/evidence/errors.js';
import { readProposal } from '../../../packages/core/src/evidence/proposal.js';
import { finishRun, startRun } from '../../../packages/core/src/workflow/run-lifecycle.js';
import { atG4, BASE_1, harness, MODEL, notices, T0, type Harness } from '../g4-harness.js';
import { createTestDatabase, describeDb, type TestDatabase } from './helpers.js';
import { MemoryEvidenceStore, sha256 } from './memory-evidence-store.js';

/** A patch with bytes that are not UTF-8 (a Shift_JIS file), as the runner stores it. */
const PATCH = Buffer.concat([
  Buffer.from('diff --git a/docs/x.md b/docs/x.md\n+', 'utf8'),
  Buffer.from([0x93, 0xfa, 0x96, 0x7b]),
  Buffer.from('\n', 'utf8'),
]);
const MAX = 1024 * 1024;

describeDb('C13: taking an L1 proposal forward on PostgreSQL', () => {
  let db: TestDatabase;
  let t: Harness;
  let store: MemoryEvidenceStore;

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
    store = new MemoryEvidenceStore();
    await t.setConfig(`run:\n  agent_key: ${t.agent.key}\n`);
  });

  const reload = (intent: Intent) => t.reload(intent);
  const deps = () => ({ store, now: () => t.f.registry.now(), maxItemBytes: MAX });
  const asPerson = (who: 'a' | 'b' | 'gov') => ({ type: 'human' as const, userId: t.f.users[who] });

  /** A High intent whose L1 run stored `content` as its proposal; paused at G4. */
  async function proposalReady(
    content: Buffer = PATCH,
  ): Promise<{ intent: Intent; runId: string; uri: string }> {
    const intent = await atG4(t, 'high');
    await t.settleRuns(intent);
    await t.decide(await reload(intent), 'approve', 'a');
    expect(await t.settleRuns(intent)).toEqual({ outcome: 'run_prepare' });
    const started = await startRun(t.f.scope, t.runDeps, intent.id);
    if (!started.ok) throw new Error('not started');
    const runId = started.run.runId;
    const now = new Date();
    await t.f.scope.runs.claimForProvisioning(runId, now);
    await t.f.scope.runs.transition(runId, { from: ['provisioning'], to: 'running', now });
    // What the runner stores (ADR-M33 §2.9): the file, then its row.
    const path = `proposals/${t.f.scope.tenantId}/${intent.id}/${runId}.patch`;
    store.objects.set(path, Buffer.from(content));
    const uri = `s3://evidence/${path}`;
    await t.f.scope.evidenceItems.record({
      intentId: intent.id,
      runId,
      kind: 'proposal',
      storageUri: uri,
      sha256: sha256(content),
      sizeBytes: content.length,
    });
    await t.f.scope.runs.transition(runId, {
      from: ['running'],
      to: 'succeeded_proposal_only',
      now,
      finishedAt: now,
    });
    expect(await t.settleRuns(intent)).toEqual({ outcome: 'run_ended', runId });
    await finishRun(t.f.scope, t.runDeps, intent.id, runId);
    expect(await t.settleRuns(intent)).toEqual({ outcome: 'waiting', reason: 'proposal_review' });
    return { intent: await reload(intent), runId, uri };
  }

  const auditOf = async (action: string) =>
    (
      await sql<{ actor_id: string | null; payload: Record<string, unknown> }>`
        SELECT actor_id, payload FROM audit_log
        WHERE tenant_id = ${t.f.scope.tenantId} AND action = ${action} ORDER BY seq`.execute(
        db.appAs(t.f.scope.tenantId),
      )
    ).rows;

  it('a reader gets the exact bytes, checked, and the read is audited without the content', async () => {
    const { intent, runId } = await proposalReady();
    const before = (await auditOf('evidence.proposal_read')).length;
    const latest = await readProposal(t.f.scope, asPerson('b'), intent.code, undefined, deps());
    expect(latest.content.equals(PATCH)).toBe(true);
    expect(latest.item.run_id).toBe(runId);
    expect(latest.intentCode).toBe(intent.code);
    const byRun = await readProposal(t.f.scope, asPerson('a'), intent.id, runId, deps());
    expect(byRun.content.equals(PATCH)).toBe(true);
    const reads = (await auditOf('evidence.proposal_read')).slice(before);
    expect(reads).toHaveLength(2);
    expect(reads[0]).toEqual({
      actor_id: t.f.users.b,
      payload: {
        intent_id: intent.id,
        run_id: runId,
        sha256: sha256(PATCH),
        size_bytes: PATCH.length,
      },
    });
    expect(JSON.stringify(reads)).not.toContain('diff --git');
  });

  it('a changed, missing or oversized file is refused, and the change is audited', async () => {
    const { intent, uri } = await proposalReady();
    const key = uri.slice('s3://evidence/'.length);
    const before = (await auditOf('evidence.check_failed')).length;
    const reads = (await auditOf('evidence.proposal_read')).length;

    const changed = Buffer.from(PATCH);
    changed[0] = 0x65; // same size, one byte changed
    store.objects.set(key, changed);
    await expect(
      readProposal(t.f.scope, asPerson('a'), intent.code, undefined, deps()),
    ).rejects.toMatchObject({ code: 'evidence_hash_mismatch' });
    store.objects.set(key, Buffer.concat([PATCH, Buffer.from('more')]));
    await expect(
      readProposal(t.f.scope, asPerson('a'), intent.code, undefined, deps()),
    ).rejects.toMatchObject({ code: 'evidence_hash_mismatch' });
    store.objects.delete(key);
    await expect(
      readProposal(t.f.scope, asPerson('a'), intent.code, undefined, deps()),
    ).rejects.toMatchObject({ code: 'evidence_missing' });
    const failed = (await auditOf('evidence.check_failed')).slice(before);
    expect(failed.map((r) => r.payload.reason)).toEqual([
      'hash_mismatch',
      'size_mismatch',
      'missing',
    ]);
    expect(failed.every((r) => r.payload.kind === 'proposal')).toBe(true);

    store.objects.set(key, Buffer.from(PATCH));
    await expect(
      readProposal(t.f.scope, asPerson('a'), intent.code, undefined, {
        ...deps(),
        maxItemBytes: PATCH.length - 1,
      }),
    ).rejects.toMatchObject({ code: 'evidence_too_large' });
    // Nothing was read successfully, so no read was audited.
    expect(await auditOf('evidence.proposal_read')).toHaveLength(reads);
  });

  it('a proposal over PROPOSAL_MAX_BYTES is refused before it is read, whatever the item cap', async () => {
    const { intent, runId, uri } = await proposalReady();
    const big = PROPOSAL_MAX_BYTES + 1;
    // Another run of the intent with a row that says the patch is too large (never read).
    const second = `${uri.slice(0, -'.patch'.length)}-big.patch`;
    await t.f.scope.evidenceItems.record({
      intentId: intent.id,
      runId,
      kind: 'proposal',
      storageUri: second,
      sha256: 'c'.repeat(64),
      sizeBytes: big,
    });
    await expect(
      readProposal(t.f.scope, asPerson('a'), intent.code, runId, {
        ...deps(),
        maxItemBytes: 256 * 1024 * 1024,
      }),
    ).rejects.toMatchObject({ code: 'evidence_too_large' });
  });

  it('no proposal, another run, a purged file; roles and tenants as the other evidence reads', async () => {
    const { intent, runId } = await proposalReady();
    await expect(
      readProposal(t.f.scope, asPerson('a'), intent.code, crypto.randomUUID(), deps()),
    ).rejects.toMatchObject({ code: 'proposal_not_found' });
    const other = await t.f.newIntent({ riskTier: 'medium' });
    await expect(
      readProposal(t.f.scope, asPerson('a'), other.code, undefined, deps()),
    ).rejects.toBeInstanceOf(EvidencePackError);

    // A person with no role on the project learns nothing; a role outside the list is refused.
    const outsider = await t.f.scope.users.create({
      email: 'out@example.test',
      display_name: 'Out',
    });
    await expect(
      readProposal(t.f.scope, { type: 'human', userId: outsider.id }, intent.code, runId, deps()),
    ).rejects.toMatchObject({ code: 'intent_not_found' });
    const viewer = await t.f.scope.users.create({
      email: 'view@example.test',
      display_name: 'View',
    });
    await t.f.scope.roleBindings.grant({
      user_id: viewer.id,
      project_id: t.f.target.projectId,
      role: 'viewer',
    });
    await expect(
      readProposal(t.f.scope, { type: 'human', userId: viewer.id }, intent.code, runId, deps()),
    ).rejects.toMatchObject({ code: 'forbidden' });

    // Purged by retention (E05): the row and the hash stay, the file is gone.
    const [item] = (await t.f.scope.evidenceItems.listForIntent(intent.id)).filter(
      (i) => i.kind === 'proposal',
    );
    await sql`UPDATE evidence_items SET purged_at = now() WHERE id = ${item!.id}`.execute(
      db.appAs(t.f.scope.tenantId),
    );
    await expect(
      readProposal(t.f.scope, asPerson('a'), intent.code, runId, deps()),
    ).rejects.toMatchObject({ code: 'proposal_purged' });
  });

  it('Person A ends the intent with a G4 rejection: rejected, with the decision and the notice', async () => {
    const { intent } = await proposalReady();
    const decision = await decideGate(t.f.registry, t.f.scope, {
      intent,
      gate: 'G4',
      decision: 'reject',
      actorId: t.f.users.a,
      reasonCode: 'other',
      reasonRef: 'https://github.com/example/repo/pull/7',
      source: 'cli',
    });
    expect(decision).toMatchObject({ gate: 'G4', decision: 'reject', decided_by: t.f.users.a });
    expect(await t.settleRuns(intent)).toMatchObject({ outcome: 'finished' });
    expect(await reload(intent)).toMatchObject({
      status: 'rejected',
      current_gate: 'G4',
      waiting_reason: null,
    });
    expect((await notices(t, intent)).at(-1)).toBe('rejected');
  });

  it('only a rejection, only after a proposal: other decisions and other paused cases are refused', async () => {
    const { intent } = await proposalReady();
    for (const decision of ['approve', 'request_changes'] as const) {
      await expect(
        decideGate(t.f.registry, t.f.scope, {
          intent,
          gate: 'G4',
          decision,
          actorId: t.f.users.a,
          ...(decision === 'request_changes' ? { reasonCode: 'other' as const } : {}),
          source: 'cli',
        }),
      ).rejects.toMatchObject({ code: 'gate_not_current' });
    }
    // Another gate is never decided here.
    await expect(
      decideGate(t.f.registry, t.f.scope, {
        intent,
        gate: 'G3',
        decision: 'reject',
        actorId: t.f.users.b,
        reasonCode: 'other',
        source: 'cli',
      }),
    ).rejects.toBeInstanceOf(CommandError);
    // A role that does not decide G4 at High risk is refused.
    await expect(
      decideGate(t.f.registry, t.f.scope, {
        intent,
        gate: 'G4',
        decision: 'reject',
        actorId: t.f.users.gov,
        reasonCode: 'other',
        source: 'cli',
      }),
    ).rejects.toThrow();
    expect(await reload(intent)).toMatchObject({ status: 'paused', current_gate: 'G4' });

    // A paused intent after a failed run keeps its escalation path.
    const failed = await atG4(t, 'medium');
    await t.settleRuns(failed);
    const started = await startRun(t.f.scope, t.runDeps, failed.id);
    if (!started.ok) throw new Error('not started');
    const now = new Date();
    await t.f.scope.runs.claimForProvisioning(started.run.runId, now);
    await t.f.scope.runs.transition(started.run.runId, {
      from: ['provisioning'],
      to: 'running',
      now,
    });
    await t.f.scope.runs.transition(started.run.runId, {
      from: ['running'],
      to: 'failed',
      now,
      stopReason: 'agent_error',
      finishedAt: now,
    });
    await t.settleRuns(failed);
    await finishRun(t.f.scope, t.runDeps, failed.id, started.run.runId);
    expect(await reload(failed)).toMatchObject({ status: 'paused', current_gate: 'G4' });
    await expect(
      decideGate(t.f.registry, t.f.scope, {
        intent: await reload(failed),
        gate: 'G4',
        decision: 'reject',
        actorId: t.f.users.a,
        reasonCode: 'other',
        source: 'cli',
      }),
    ).rejects.toMatchObject({ code: 'gate_not_current' });
  });
});
