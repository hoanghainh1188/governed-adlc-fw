// D-08 X04 PR 3a on a live PostgreSQL (design/ADR-M89 §2.2–§2.4; D-05 §6.1; D-02 FR-44): the
// platform's record of the index of project documents, with an in-memory `KnowledgeStore`.
// - The indexer: a first run builds and records the index and its use; a second run of the same
//   commit reuses it (a new use, `last_used_at` moves); a purged index is built again.
// - Retention: a version is deleted when every intent that used it is finished and not held and
//   its last use is older than the retention (179 days kept, 181 deleted), with `knowledge.purged`;
//   `report` mode deletes nothing; an open or held intent keeps it; another project's index is not
//   touched; an archived project loses every version after the grace period, then its schema.
// - The tables: only the use and purge dates change, a purge never moves (SDA26); uses are
//   append-only; no DELETE (grants); a purged index allows a new ready one of the same commit.
import crypto from 'node:crypto';

import {
  EvidenceError,
  type EvidenceRetentionStore,
  type KnowledgeIndexInput,
  type KnowledgeStore,
} from '@sdlc/contracts';
import { Redacted } from '@sdlc/secrets';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';

import { archiveProject } from '../../../packages/core/src/admin/projects.js';
import { DbError } from '../../../packages/core/src/db/errors.js';
import type { TenantScope } from '../../../packages/core/src/db/tenant-scope.js';
import { buildProjectIndex } from '../../../packages/core/src/knowledge/indexer.js';
import { holdEvidence } from '../../../packages/core/src/retention/holds.js';
import {
  runRetentionPass,
  type RetentionPassResult,
  type RetentionSettings,
} from '../../../packages/core/src/retention/pass.js';
import { seedOtherProject, seedRun, type SeededRun } from '../cost-seed.js';
import { createTestDatabase, describeDb, tamper, type TestDatabase } from './helpers.js';

const DAY = 86_400_000;
const SHA = 'c'.repeat(40);
const LIMITS = {
  max_files: 10,
  max_file_bytes: 10_000,
  max_total_bytes: 20_000,
  max_chunks: 50,
  chunk_chars: 200,
  embed_batch: 8,
};

/** `knowledge-db` in memory: versions per project, chunks shared by the project's versions. */
class MemoryKnowledgeStore implements KnowledgeStore {
  readonly versions = new Map<string, KnowledgeIndexInput>();
  readonly created = new Map<string, Date>();
  readonly chunks = new Map<string, Set<string>>();
  readonly dropped: string[] = [];
  /** The next `times` deletes of this version fail (knowledge-db down). */
  failDelete: { id: string; times: number } | null = null;
  /** Orphan chunk sweeps: project → cut-off. */
  readonly orphanSweeps: { projectId: string; before: Date }[] = [];

  ensureProject(input: { projectId: string }): Promise<void> {
    if (!this.chunks.has(input.projectId)) this.chunks.set(input.projectId, new Set());
    return Promise.resolve();
  }
  missingChunks(projectId: string, _model: string, keys: readonly string[]) {
    const have = this.chunks.get(projectId) ?? new Set();
    return Promise.resolve(keys.filter((k) => !have.has(k)));
  }
  putChunks(input: { projectId: string; chunks: readonly { sha256: string }[] }): Promise<void> {
    for (const c of input.chunks) this.chunks.get(input.projectId)!.add(c.sha256);
    return Promise.resolve();
  }
  putIndexVersion(input: KnowledgeIndexInput): Promise<void> {
    this.versions.set(input.indexId, input);
    this.created.set(input.indexId, new Date());
    return Promise.resolve();
  }
  listIndexVersions(projectId: string) {
    return Promise.resolve(
      [...this.versions.values()]
        .filter((v) => v.projectId === projectId)
        .map((v) => ({ id: v.indexId, createdAt: this.created.get(v.indexId)! })),
    );
  }
  deleteOrphanChunks(projectId: string, before: Date): Promise<number> {
    this.orphanSweeps.push({ projectId, before });
    return Promise.resolve(0);
  }
  deleteIndexVersion(projectId: string, indexId: string): Promise<{ chunks: number }> {
    if (this.failDelete?.id === indexId && this.failDelete.times > 0) {
      this.failDelete.times -= 1;
      return Promise.reject(new Error('knowledge-db down'));
    }
    const version = this.versions.get(indexId);
    this.versions.delete(indexId);
    if (!version) return Promise.resolve({ chunks: 0 });
    const kept = new Set(
      [...this.versions.values()]
        .filter((v) => v.projectId === projectId)
        .flatMap((v) => v.documents.flatMap((d) => d.chunks)),
    );
    let removed = 0;
    for (const key of new Set(version.documents.flatMap((d) => d.chunks))) {
      if (!kept.has(key) && this.chunks.get(projectId)?.delete(key)) removed += 1;
    }
    return Promise.resolve({ chunks: removed });
  }
  dropProject(projectId: string): Promise<void> {
    this.dropped.push(projectId);
    this.chunks.delete(projectId);
    return Promise.resolve();
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

const noEvidence: EvidenceRetentionStore = {
  listKeys: () => Promise.resolve({ keys: [], next: null }),
  deleteAllVersions: () => Promise.reject(new EvidenceError('forbidden')),
  setLegalHold: () => Promise.reject(new EvidenceError('forbidden')),
  extendLock: () => Promise.reject(new EvidenceError('forbidden')),
};

const SETTINGS: RetentionSettings = {
  mode: 'purge',
  bucket: 'evidence',
  batch: 200,
  guardPercent: 100,
  guardFloor: 1000,
  archiveGraceDays: 7,
  orphanGraceHours: 24,
};

const DOCS: Record<string, string> = {
  'README.md': '# Shop\n\nOrders and stock.',
  'docs/a.md': '# A\n\nalpha\n\n## B\n\nbeta',
};

describeDb('X04 PR 3a: the document index on PostgreSQL', () => {
  let t: TestDatabase;
  let store: MemoryKnowledgeStore;
  let tenants = 0;
  const logs: { level: string; event: string }[] = [];

  beforeAll(async () => {
    t = await createTestDatabase();
    store = new MemoryKnowledgeStore();
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  });
  // One database for every test: open intents are never purged, so each test leaves them open.
  afterEach(async () => {
    await tamper(
      t.name,
      `UPDATE intents SET status = 'draft', current_gate = NULL, gate_entered_at = NULL`,
      [],
    );
  });

  // The rows' dates come from the database clock, so the pass's clock starts at the real time.
  const T0 = new Date();
  const at = (days: number) => new Date(T0.getTime() + days * DAY);

  const pass = (
    now: Date,
    settings: Partial<RetentionSettings> = {},
  ): Promise<RetentionPassResult> =>
    runRetentionPass(
      {
        db: t.app,
        store: noEvidence,
        logger: { log: (level, event) => logs.push({ level, event }) },
        now: () => now,
        settings: { ...SETTINGS, ...settings },
        knowledge: { store },
      },
      null,
    );

  async function world(): Promise<SeededRun & { admin: string }> {
    const seeded = await seedRun(t.app, {
      slug: `kn-tenant-${String(++tenants)}`,
      models: ['stub-model'],
      now: T0,
    });
    await seeded.scope.tenantRoles.grant({ user_id: seeded.personA, role: 'tenant_admin' });
    return { ...seeded, admin: seeded.personA };
  }

  const finish = (intentId: string, endedAt: Date) =>
    tamper(
      t.name,
      `UPDATE intents SET status = 'done', current_gate = NULL, gate_entered_at = NULL,
       updated_at = $1 WHERE id = $2`,
      [endedAt, intentId],
    );

  const index = (w: { scope: TenantScope; projectId: string; runId: string; intentId: string }) =>
    buildProjectIndex(
      w.scope,
      {
        gitHost: {
          listPaths: () => Promise.resolve(Object.keys(DOCS)),
          getFileAtCommit: (_ref, path) => Promise.resolve(DOCS[path]!),
        },
        store,
        embedder: { embed: (_k, _m, inputs) => Promise.resolve(inputs.map(() => [1, 0])) },
      },
      {
        ref: { owner: 'org', name: 'pilot-order-inventory' },
        projectId: w.projectId,
        baseSha: SHA,
        model: 'bge-m3',
        key: new Redacted('sk-run'),
        runId: w.runId,
        intentId: w.intentId,
        limits: LIMITS,
        now: new Date(),
      },
    );

  const purgedEvents = async (scope: TenantScope, projectId: string) =>
    (await scope.audit.listForEntity(projectId)).filter((e) => e.action === 'knowledge.purged');

  it('builds once, reuses it for the same commit, and records every use', async () => {
    const w = await world();
    const first = await index(w);
    expect(first).toMatchObject({ reused: false, documents: 2, chunks: 3 });
    const row = await w.scope.knowledgeIndexes.findReady(w.projectId, SHA, 'bge-m3');
    expect(row).toMatchObject({ id: first.indexId, documents: 2, chunks: 3, purged_at: null });
    const again = await index(w);
    expect(again).toEqual({ ...first, reused: true });
    expect(await w.scope.knowledgeIndexes.intentsOf(first.indexId)).toEqual([w.intentId]);
    expect(store.versions.has(first.indexId)).toBe(true);
  });

  it("X04 PR 3b: the runner's check — only this run's use, in this run's project; the run's uses by model", async () => {
    const w = await world();
    const built = await index(w);
    const other = crypto.randomUUID();
    expect(
      await w.scope.knowledgeIndexes.usedByRun(built.indexId, w.runId, w.projectId),
    ).toMatchObject({ id: built.indexId, model: 'bge-m3' });
    // Another run, another project, an unknown index: refused (the tool never gets it).
    expect(await w.scope.knowledgeIndexes.usedByRun(built.indexId, other, w.projectId)).toBe(
      undefined,
    );
    expect(await w.scope.knowledgeIndexes.usedByRun(built.indexId, w.runId, other)).toBe(undefined);
    expect(await w.scope.knowledgeIndexes.usedByRun(other, w.runId, w.projectId)).toBe(undefined);
    expect(await w.scope.knowledgeIndexes.usesOfRun(w.runId)).toEqual([
      { indexId: built.indexId, model: 'bge-m3' },
    ]);
    // Migration 0040: the evidence kind of the list a tool returned (IDs and hashes only).
    await w.scope.evidenceItems.record({
      intentId: w.intentId,
      runId: w.runId,
      kind: 'knowledge_read',
      storageUri: `s3://sdlc-evidence/diffs/${w.intentId}/${w.runId}.knowledge-project-docs.json`,
      sha256: 'e'.repeat(64),
      sizeBytes: 2,
    });
    expect((await w.scope.evidenceItems.listForIntent(w.intentId)).map((i) => i.kind)).toContain(
      'knowledge_read',
    );
    // Migration 0040: a tool's own model key has the label `agent` = `tool:<key>` (QUESTIONS #541).
    expect(
      await w.scope.costRecords.insertIfNew({
        projectId: w.projectId,
        intentId: w.intentId,
        runId: w.runId,
        gate: 'G4',
        agent: 'tool:project-docs',
        model: 'bge-m3',
        providerType: 'self_hosted',
        inputTokens: 8,
        outputTokens: 0,
        cachedInputTokens: 0,
        costUsd: '0',
        sourceRef: `x04b-${w.runId}`,
        occurredAt: new Date(),
      }),
    ).toBe(true);
  });

  it('keeps a version at day 179, deletes it at day 181 with knowledge.purged; report mode counts only', async () => {
    const w = await world();
    const built = await index(w);
    await finish(w.intentId, T0);

    expect((await pass(at(179))).knowledgeDue).toBe(0);
    expect(await pass(at(181), { mode: 'report' })).toMatchObject({
      knowledgeDue: 1,
      knowledgePurged: 0,
    });
    expect(store.versions.has(built.indexId)).toBe(true);

    expect(await pass(at(181))).toMatchObject({ knowledgeDue: 1, knowledgePurged: 1 });
    expect(store.versions.has(built.indexId)).toBe(false);
    expect((await purgedEvents(w.scope, w.projectId)).map((e) => e.payload)).toEqual([
      { index_id: built.indexId, documents: 2, chunks: 3, cause: 'retention', kind: 'docs' },
    ]);
    expect(await w.scope.knowledgeIndexes.findReady(w.projectId, SHA, 'bge-m3')).toBeUndefined();
    // Purged once: a later pass does nothing.
    expect(await pass(at(182))).toMatchObject({ knowledgeDue: 0, knowledgePurged: 0 });
    // A new run of the same commit builds a new index (one ready row per commit).
    const rebuilt = await index({ ...w, runId: w.runId });
    expect(rebuilt.reused).toBe(false);
    expect(rebuilt.indexId).not.toBe(built.indexId);
  });

  it('never deletes a version an open or held intent used, nor another project’s', async () => {
    const w = await world();
    const built = await index(w);
    const other = await seedOtherProject(w, { slug: 'warehouse', models: ['stub-model'], now: T0 });
    const otherBuilt = await index({ ...w, ...other });
    // The intent of `w` is open: kept.
    expect((await pass(at(400))).knowledgePurged).toBe(0);
    // Finished but held: kept.
    await finish(w.intentId, T0);
    await holdEvidence(w.scope, { userId: w.admin }, w.intentCode, null);
    expect((await pass(at(400))).knowledgePurged).toBe(0);
    expect(store.versions.has(built.indexId)).toBe(true);
    // The other project's intent finished, not held: only its version goes.
    await finish(other.intentId, T0);
    await pass(at(400));
    expect(store.versions.has(built.indexId)).toBe(true);
    expect(store.versions.has(otherBuilt.indexId)).toBe(false);
  });

  it('deletes every version of an archived project after the grace period, then its schema', async () => {
    const w = await world();
    const built = await index(w);
    await finish(w.intentId, new Date());
    await archiveProject(w.scope, { type: 'human', userId: w.admin }, 'shop');
    const archivedAt = new Date(
      (await w.scope.audit.listForEntity(w.projectId)).find((e) => e.action === 'project.archived')!
        .occurred_at,
    );
    const day = (n: number) => new Date(archivedAt.getTime() + n * DAY);
    await pass(day(0)); // schedules the purge
    expect((await pass(day(6))).knowledgePurged).toBe(0);
    expect((await pass(day(8))).knowledgePurged).toBe(1);
    expect(store.versions.has(built.indexId)).toBe(false);
    expect(store.dropped).toContain(w.projectId);
    expect((await purgedEvents(w.scope, w.projectId)).map((e) => e.payload)).toEqual([
      { index_id: built.indexId, documents: 2, chunks: 3, cause: 'archive', kind: 'docs' },
    ]);
  });

  it('marks first, then deletes; a delete that fails is swept on a later pass', async () => {
    const w = await world();
    const built = await index(w);
    await finish(w.intentId, T0);
    // The delete after the mark fails, and so does the sweep's retry in the same pass.
    store.failDelete = { id: built.indexId, times: 2 };
    const first = await pass(at(181));
    expect(first).toMatchObject({ knowledgePurged: 0 });
    expect(first.failed).toBeGreaterThanOrEqual(1);
    // The row is purged (no run reuses it) although the store still has the version.
    expect(await w.scope.knowledgeIndexes.findReady(w.projectId, SHA, 'bge-m3')).toBeUndefined();
    expect(store.versions.has(built.indexId)).toBe(true);
    expect((await purgedEvents(w.scope, w.projectId)).map((e) => e.payload)).toEqual([
      { index_id: built.indexId, documents: 2, chunks: 3, cause: 'retention', kind: 'docs' },
    ]);
    // The next pass sweeps it (older than the grace).
    const second = await pass(at(182));
    expect(second.knowledgeSwept).toBeGreaterThanOrEqual(1);
    expect(store.versions.has(built.indexId)).toBe(false);
    expect(store.orphanSweeps.at(-1)).toMatchObject({ projectId: w.projectId });
    expect(store.orphanSweeps.at(-1)!.before.getTime()).toBe(at(182).getTime() - 3_600_000);
  });

  it('sweeps a version a failed build left without a row, only after the grace', async () => {
    const w = await world();
    const orphan = crypto.randomUUID();
    await store.ensureProject({ projectId: w.projectId });
    await store.putIndexVersion({
      tenantId: w.scope.tenantId,
      projectId: w.projectId,
      indexId: orphan,
      baseSha: 'd'.repeat(40),
      model: 'bge-m3',
      documents: [],
    });
    await pass(new Date(Date.now() + 30 * 60_000));
    expect(store.versions.has(orphan)).toBe(true);
    await pass(new Date(Date.now() + 2 * 3_600_000));
    expect(store.versions.has(orphan)).toBe(false);
    // `report` mode never sweeps.
    const again = crypto.randomUUID();
    await store.putIndexVersion({
      tenantId: w.scope.tenantId,
      projectId: w.projectId,
      indexId: again,
      baseSha: 'e'.repeat(40),
      model: 'bge-m3',
      documents: [],
    });
    expect((await pass(at(400), { mode: 'report' })).knowledgeSwept).toBe(0);
    expect(store.versions.has(again)).toBe(true);
  });

  it('an index no run recorded a use of waits a day, also in an archived project', async () => {
    const w = await world();
    const id = crypto.randomUUID();
    await w.scope.knowledgeIndexes.create({
      id,
      projectId: w.projectId,
      baseSha: 'f'.repeat(40),
      model: 'bge-m3',
      documents: 0,
      chunks: 0,
      bytes: 0,
    });
    await finish(w.intentId, new Date());
    await archiveProject(w.scope, { type: 'human', userId: w.admin }, 'shop');
    const archivedAt = new Date(
      (await w.scope.audit.listForEntity(w.projectId)).find((e) => e.action === 'project.archived')!
        .occurred_at,
    );
    await pass(archivedAt); // schedules the purge
    // With no grace: one hour after the index's creation it is kept, two days after it goes.
    expect(
      (await pass(new Date(Date.now() + 3_600_000), { archiveGraceDays: 0 })).knowledgePurged,
    ).toBe(0);
    expect(
      (await pass(new Date(Date.now() + 2 * 86_400_000), { archiveGraceDays: 0 })).knowledgePurged,
    ).toBe(1);
  });

  it('the tables: fixed columns, one purge, append-only uses, no DELETE', async () => {
    const w = await world();
    const built = await index(w);
    for (const change of [{ documents: 9 }, { model: 'x' }, { last_used_at: at(-30) }]) {
      await expect(
        t.appRaw
          .updateTable('knowledge_indexes')
          .set(change as never)
          .where('id', '=', built.indexId)
          .execute(),
      ).rejects.toThrow();
    }
    expect(await w.scope.knowledgeIndexes.markPurged(built.indexId, new Date())).toBe(true);
    expect(await w.scope.knowledgeIndexes.markPurged(built.indexId, new Date())).toBe(false);
    await expect(
      t.appRaw
        .updateTable('knowledge_indexes')
        .set({ purged_at: at(1) })
        .where('id', '=', built.indexId)
        .execute(),
    ).rejects.toThrow();
    // A purged index takes no new use.
    expect(
      await w.scope.knowledgeIndexes.recordUse({
        indexId: built.indexId,
        runId: w.runId,
        intentId: w.intentId,
        at: new Date(),
      }),
    ).toBe(false);
    await expect(
      t.appRaw
        .updateTable('knowledge_index_uses')
        .set({ run_id: crypto.randomUUID() } as never)
        .execute(),
    ).rejects.toThrow();
    await expect(t.appRaw.deleteFrom('knowledge_index_uses').execute()).rejects.toThrow();
    await expect(t.appRaw.deleteFrom('knowledge_indexes').execute()).rejects.toThrow();
    // Two ready indexes of one commit: refused.
    const ready = await index(w);
    await expect(
      w.scope.knowledgeIndexes.create({
        id: crypto.randomUUID(),
        projectId: w.projectId,
        baseSha: SHA,
        model: 'bge-m3',
        documents: 1,
        chunks: 1,
        bytes: 1,
      }),
    ).rejects.toBeInstanceOf(DbError);
    expect(ready.reused).toBe(false);
  });
});
