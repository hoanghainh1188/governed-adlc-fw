// X06 PR 1 on a live PostgreSQL (design/ADR-M108 §2.5–§2.7; D-05 §6.1 version 1.71; D-02 FR-44):
// the code index in the platform's record, with in-memory stores and the real Tree-sitter parser.
// - Migration 0051: `kind` (`docs` by default, `code`), one ready row per commit, model and kind;
//   the kind is fixed (SDA26) and checked.
// - `buildCodeIndex`: builds and records a `code` row and its use; a second run reuses it; the
//   document index of the same commit is another row.
// - Retention: a code version is deleted from the code store, never from the document store, by
//   the rules of the documents (179 days kept, 181 deleted), with `knowledge.purged` and `kind`;
//   a worker without a code store never marks a code version; an archived project loses both
//   schemas.
import crypto from 'node:crypto';

import { TreeSitterExtractor } from '@sdlc/adapter-code-treesitter';
import {
  CODE_INDEX_FORMAT,
  EvidenceError,
  type CodeIndexInput,
  type CodeIndexStore,
  type EvidenceRetentionStore,
  type KnowledgeStore,
} from '@sdlc/contracts';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';

import { archiveProject } from '../../../packages/core/src/admin/projects.js';
import { DbError } from '../../../packages/core/src/db/errors.js';
import type { TenantScope } from '../../../packages/core/src/db/tenant-scope.js';
import { buildCodeIndex } from '../../../packages/core/src/knowledge/code-indexer.js';
import {
  runRetentionPass,
  type RetentionSettings,
} from '../../../packages/core/src/retention/pass.js';
import { seedRun, type SeededRun } from '../cost-seed.js';
import pg from 'pg';

import { createTestDatabase, describeDb, tamper, urlFor, type TestDatabase } from './helpers.js';

const DAY = 86_400_000;
const SHA = 'd'.repeat(40);
const LIMITS = {
  max_files: 10,
  max_file_bytes: 10_000,
  max_total_bytes: 20_000,
  max_symbols: 100,
  parse_timeout_ms: 2_000,
};
const SOURCES: Record<string, string> = {
  'src/order.ts': "import { load } from './repo';\nexport class Order { get() { return load(); } }",
  'src/repo.ts': 'export function load() { return 1; }',
};

/** The lifecycle of a store in memory: which versions exist, which were deleted and dropped. */
class MemoryLifecycle {
  readonly versions = new Map<string, { projectId: string; createdAt: Date }>();
  readonly deleted: string[] = [];
  readonly dropped: string[] = [];

  deleteIndexVersion(_projectId: string, indexId: string) {
    this.deleted.push(indexId);
    this.versions.delete(indexId);
    return Promise.resolve({ chunks: 0 });
  }
  listIndexVersions(projectId: string) {
    return Promise.resolve(
      [...this.versions.entries()]
        .filter(([, v]) => v.projectId === projectId)
        .map(([id, v]) => ({ id, createdAt: v.createdAt })),
    );
  }
  deleteOrphanChunks() {
    return Promise.resolve(0);
  }
  dropProject(projectId: string) {
    this.dropped.push(projectId);
    return Promise.resolve();
  }
  close() {
    return Promise.resolve();
  }
}

class MemoryCodeStore extends MemoryLifecycle implements CodeIndexStore {
  ensureProject() {
    return Promise.resolve();
  }
  putIndexVersion(input: CodeIndexInput) {
    this.versions.set(input.indexId, { projectId: input.projectId, createdAt: new Date() });
    return Promise.resolve();
  }
}

class MemoryDocsStore extends MemoryLifecycle implements KnowledgeStore {
  ensureProject() {
    return Promise.resolve();
  }
  missingChunks() {
    return Promise.resolve([]);
  }
  putChunks() {
    return Promise.resolve();
  }
  putIndexVersion() {
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

describeDb('X06 PR 1: the code index on PostgreSQL', () => {
  let t: TestDatabase;
  let code: MemoryCodeStore;
  let docs: MemoryDocsStore;
  let tenants = 0;
  const extractor = new TreeSitterExtractor();

  beforeAll(async () => {
    t = await createTestDatabase();
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  });
  afterEach(async () => {
    await tamper(
      t.name,
      `UPDATE intents SET status = 'draft', current_gate = NULL, gate_entered_at = NULL`,
      [],
    );
  });

  const T0 = new Date();
  const at = (days: number) => new Date(T0.getTime() + days * DAY);

  const pass = (now: Date, options: { withCode?: boolean; mode?: 'purge' | 'report' } = {}) =>
    runRetentionPass(
      {
        db: t.app,
        store: noEvidence,
        logger: { log: () => undefined },
        now: () => now,
        settings: { ...SETTINGS, mode: options.mode ?? 'purge' },
        knowledge: { store: docs, ...(options.withCode === false ? {} : { codeStore: code }) },
      },
      null,
    );

  async function world(): Promise<SeededRun & { admin: string }> {
    code = new MemoryCodeStore();
    docs = new MemoryDocsStore();
    const seeded = await seedRun(t.app, {
      slug: `code-tenant-${String(++tenants)}`,
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
    buildCodeIndex(
      w.scope,
      {
        gitHost: {
          listPaths: () => Promise.resolve(Object.keys(SOURCES)),
          getFileAtCommit: (_ref, path) => Promise.resolve(SOURCES[path]!),
        },
        store: code,
        extractor,
      },
      {
        ref: { owner: 'org', name: 'pilot-order-inventory' },
        projectId: w.projectId,
        baseSha: SHA,
        runId: w.runId,
        intentId: w.intentId,
        limits: LIMITS,
        now: new Date(),
      },
    );

  const purgedEvents = async (scope: TenantScope, projectId: string) =>
    (await scope.audit.listForEntity(projectId)).filter((e) => e.action === 'knowledge.purged');

  it('builds a code row with its use, reuses it, and keeps the document row apart', async () => {
    const w = await world();
    const first = await index(w);
    expect(first).toMatchObject({ reused: false, files: 2, skipped: 0 });
    const row = await w.scope.knowledgeIndexes.findReady(
      w.projectId,
      SHA,
      CODE_INDEX_FORMAT,
      'code',
    );
    expect(row).toMatchObject({ id: first.indexId, kind: 'code', documents: 2, purged_at: null });
    expect(
      await w.scope.knowledgeIndexes.findReady(w.projectId, SHA, CODE_INDEX_FORMAT),
    ).toBeUndefined();
    expect(await index(w)).toEqual({ ...first, reused: true, skipped: 0 });
    expect(await w.scope.knowledgeIndexes.intentsOf(first.indexId)).toEqual([w.intentId]);
    // A document index of the same commit and the same model name is another row.
    const docsRow = await w.scope.knowledgeIndexes.create({
      id: crypto.randomUUID(),
      projectId: w.projectId,
      baseSha: SHA,
      model: CODE_INDEX_FORMAT,
      documents: 1,
      chunks: 1,
      bytes: 1,
    });
    expect(docsRow.kind).toBe('docs');
    // Purged here, so the later retention tests of this database do not see it.
    expect(await w.scope.knowledgeIndexes.markPurged(docsRow.id, new Date())).toBe(true);
    // A second ready code row of the same commit: refused.
    await expect(
      w.scope.knowledgeIndexes.create({
        id: crypto.randomUUID(),
        projectId: w.projectId,
        baseSha: SHA,
        model: CODE_INDEX_FORMAT,
        kind: 'code',
        documents: 1,
        chunks: 1,
        bytes: 1,
      }),
    ).rejects.toBeInstanceOf(DbError);
  });

  it('deletes a code version at day 181 from the code store only, with kind in knowledge.purged', async () => {
    const w = await world();
    const built = await index(w);
    await finish(w.intentId, T0);
    expect((await pass(at(179))).knowledgeDue).toBe(0);
    expect(await pass(at(181), { mode: 'report' })).toMatchObject({
      knowledgeDue: 1,
      knowledgePurged: 0,
    });
    expect(code.versions.has(built.indexId)).toBe(true);
    expect(await pass(at(181))).toMatchObject({ knowledgeDue: 1, knowledgePurged: 1 });
    expect(code.deleted).toEqual([built.indexId]);
    expect(docs.deleted).toEqual([]);
    expect((await purgedEvents(w.scope, w.projectId)).map((e) => e.payload)).toEqual([
      {
        index_id: built.indexId,
        documents: 2,
        chunks: built.symbols,
        cause: 'retention',
        kind: 'code',
      },
    ]);
  });

  it('never marks a code version when the worker has no code store', async () => {
    const w = await world();
    const built = await index(w);
    await finish(w.intentId, T0);
    const result = await pass(at(400), { withCode: false });
    expect(result.knowledgePurged).toBe(0);
    expect(result.failed).toBeGreaterThanOrEqual(1);
    const row = await w.scope.knowledgeIndexes.findReady(
      w.projectId,
      SHA,
      CODE_INDEX_FORMAT,
      'code',
    );
    expect(row?.id).toBe(built.indexId);
    expect(await purgedEvents(w.scope, w.projectId)).toEqual([]);
  });

  it('an archived project loses its code versions, then both schemas', async () => {
    const w = await world();
    const built = await index(w);
    await finish(w.intentId, new Date());
    await archiveProject(w.scope, { type: 'human', userId: w.admin }, 'shop');
    const archivedAt = new Date(
      (await w.scope.audit.listForEntity(w.projectId)).find((e) => e.action === 'project.archived')!
        .occurred_at,
    );
    const day = (n: number) => new Date(archivedAt.getTime() + n * DAY);
    await pass(day(0));
    expect((await pass(day(8))).knowledgePurged).toBe(1);
    expect(code.deleted).toEqual([built.indexId]);
    expect(code.dropped).toContain(w.projectId);
    expect(docs.dropped).toContain(w.projectId);
  });

  it('the kind is checked and fixed (SDA26)', async () => {
    const w = await world();
    const built = await index(w);
    await expect(
      t.appRaw
        .updateTable('knowledge_indexes')
        .set({ kind: 'docs' } as never)
        .where('id', '=', built.indexId)
        .execute(),
    ).rejects.toThrow();
    // The trigger, as the table's owner (no grant in the way, triggers on).
    const owner = new pg.Client({ connectionString: urlFor(t.name) });
    await owner.connect();
    try {
      await expect(
        owner.query(`UPDATE knowledge_indexes SET kind = 'docs' WHERE id = $1`, [built.indexId]),
      ).rejects.toMatchObject({ code: 'SDA26' });
    } finally {
      await owner.end();
    }
    await expect(
      w.scope.knowledgeIndexes.create({
        id: crypto.randomUUID(),
        projectId: w.projectId,
        baseSha: 'e'.repeat(40),
        model: CODE_INDEX_FORMAT,
        kind: 'other' as never,
        documents: 1,
        chunks: 1,
        bytes: 1,
      }),
    ).rejects.toThrow();
  });
});
