// D-08 E08 on a live PostgreSQL (design/ADR-M53; D-05 §6.6, §10.1; D-02 FR-44): the Langfuse step
// of the retention pass with a fake clock and an in-memory Langfuse that deletes asynchronously,
// like Langfuse 4.47.0 (a request is accepted at once; the traces go when its worker runs).
// - AC3 retention: an intent's traces are requested for deletion after `evidence_retention_days`
//   (179 kept, 181 requested), selected by the intent's own run tags; confirmed on a later pass
//   when gone (`langfuse.purge_requested`, then `langfuse.purged`); asked again while still found.
// - AC3 archive: after the grace period; `project.purged` waits for the Langfuse purge and records
//   `langfuse: purged`; with the credential missing it never completes.
// - Safety: `report` mode deletes nothing; open and held intents never; a trace whose tags do not
//   match its intent (another tenant, a renamed slug) stops the whole intent; the per-intent
//   guard; another tenant's traces are never asked for; Langfuse unreachable → nothing recorded.
// - The table: a confirmed purge never changes; no delete (trigger SDA17, grants).
import crypto from 'node:crypto';

import {
  EvidenceError,
  LlmTraceError,
  type EvidenceRetentionStore,
  type LlmTraceRef,
  type LlmTraceStore,
} from '@sdlc/contracts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { archiveProject } from '../../../packages/core/src/admin/projects.js';
import { DbError } from '../../../packages/core/src/db/errors.js';
import type { TenantScope } from '../../../packages/core/src/db/tenant-scope.js';
import {
  MAX_TRACES_PER_INTENT,
  type LangfusePurgeDeps,
  type LangfusePurgeState,
} from '../../../packages/core/src/retention/langfuse-pass.js';
import { holdEvidence } from '../../../packages/core/src/retention/holds.js';
import {
  runRetentionPass,
  type RetentionPassResult,
  type RetentionSettings,
} from '../../../packages/core/src/retention/pass.js';
import { seedOtherProject, seedRun, type SeededRun } from '../cost-seed.js';
import { createTestDatabase, describeDb, tamper, type TestDatabase } from './helpers.js';

const DAY = 86_400_000;
const T0 = new Date('2026-01-05T00:00:00.000Z');
const at = (days: number) => new Date(T0.getTime() + days * DAY);

/** Langfuse as the worker sees it: tags per trace, deletes that complete when `settle` runs. */
class FakeLangfuse implements LlmTraceStore {
  readonly traces = new Map<string, readonly string[]>();
  readonly pending = new Set<string>();
  readonly queries: (readonly string[])[] = [];
  readonly deleted: string[] = [];
  compactions = 0;
  down = false;
  project = 'sdlc-platform';
  failDelete = false;
  failFind = false;

  projectId(): Promise<string> {
    if (this.down) return Promise.reject(new LlmTraceError('unavailable'));
    return Promise.resolve(this.project);
  }

  add(tags: readonly string[]): string {
    const id = crypto.randomBytes(16).toString('hex');
    this.traces.set(id, tags);
    return id;
  }

  /** Langfuse's worker ran: every requested trace is gone. */
  settle(): void {
    for (const id of this.pending) this.traces.delete(id);
    this.pending.clear();
  }

  findTraces(input: { tags: readonly string[]; max: number }): Promise<readonly LlmTraceRef[]> {
    if (this.down || this.failFind) return Promise.reject(new LlmTraceError('unavailable'));
    this.queries.push(input.tags);
    const found = [...this.traces]
      .filter(([, tags]) => tags.some((tag) => input.tags.includes(tag)))
      .map(([traceId, tags]) => ({ traceId, tags }));
    if (found.length > input.max) return Promise.reject(new LlmTraceError('too_many'));
    return Promise.resolve(found);
  }

  deleteTraces(ids: readonly string[]): Promise<void> {
    if (this.down || this.failDelete) return Promise.reject(new LlmTraceError('unavailable'));
    for (const id of ids) {
      this.pending.add(id);
      this.deleted.push(id);
    }
    return Promise.resolve();
  }

  compactDeleted(): Promise<{ durationMs: number }> {
    this.compactions += 1;
    return Promise.resolve({ durationMs: 3 });
  }
}

/** No raw files in these tests (tests/retention/langfuse-rules.test.ts covers the sweep). */
const emptyRaw: EvidenceRetentionStore = {
  listKeys: () => Promise.resolve({ keys: [], next: null }),
  deleteAllVersions: () => Promise.reject(new EvidenceError('forbidden')),
  setLegalHold: () => Promise.reject(new EvidenceError('forbidden')),
  extendLock: () => Promise.reject(new EvidenceError('forbidden')),
};
/** The evidence store: these intents have no evidence files. */
const noEvidence: EvidenceRetentionStore = { ...emptyRaw };

const SETTINGS: RetentionSettings = {
  mode: 'purge',
  bucket: 'evidence',
  batch: 200,
  guardPercent: 100,
  guardFloor: 1000,
  archiveGraceDays: 7,
  orphanGraceHours: 24,
};

const labels = (s: { slug: string; project: string; code: string; run: string }) => [
  `tenant:${s.slug}`,
  `project:${s.project}`,
  `intent_id:${s.code}`,
  `run_id:${s.run}`,
  'gate:G4',
  'agent:coder',
  'data_class:internal',
];

describeDb('E08: the Langfuse purge on PostgreSQL', () => {
  let t: TestDatabase;
  let langfuse: FakeLangfuse;
  let state: LangfusePurgeState;
  let logs: { level: string; event: string; fields: Record<string, unknown> }[];
  let tenants = 0;

  beforeAll(async () => {
    t = await createTestDatabase();
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  });
  // One database for every test: earlier tests' intents would be due in later passes. Open intents
  // are never purged, so each test leaves its intents open (`draft`).
  afterEach(async () => {
    await tamper(
      t.name,
      `UPDATE intents SET status = 'draft', current_gate = NULL, gate_entered_at = NULL`,
      [],
    );
  });
  beforeEach(() => {
    langfuse = new FakeLangfuse();
    state = { maskOwed: false, maskedOn: null };
    logs = [];
  });

  const on = (
    guard: Partial<{ guardPercent: number; guardFloor: number }> = {},
  ): LangfusePurgeDeps => ({
    status: 'on',
    store: langfuse,
    rawStore: emptyRaw,
    rawPrefix: 'events/otel/',
    settings: {
      batch: 50,
      rawMaxAgeHours: 24,
      rawBatch: 100,
      projectId: 'sdlc-platform',
      guardPercent: 100,
      guardFloor: 1000,
      ...guard,
    },
    state,
  });

  const pass = (
    now: Date,
    settings: Partial<RetentionSettings> = {},
    deps: LangfusePurgeDeps = on(),
  ): Promise<RetentionPassResult> =>
    runRetentionPass(
      {
        db: t.app,
        store: noEvidence,
        logger: { log: (level, event, fields = {}) => logs.push({ level, event, fields }) },
        now: () => now,
        settings: { ...SETTINGS, ...settings },
        langfuse: deps,
      },
      null,
    );

  /** A tenant with a finished intent (one run) ended at `endedAt`, and its tenant admin. */
  async function world(endedAt: Date, status = 'done'): Promise<SeededRun & { admin: string }> {
    const seeded = await seedRun(t.app, {
      slug: `lf-tenant-${String(++tenants)}`,
      models: ['stub-model'],
      now: T0,
    });
    await seeded.scope.tenantRoles.grant({ user_id: seeded.personA, role: 'tenant_admin' });
    await finish(seeded.intentId, endedAt, status);
    return { ...seeded, admin: seeded.personA };
  }

  async function finish(intentId: string, endedAt: Date, status = 'done') {
    await tamper(
      t.name,
      `UPDATE intents SET status = $1, current_gate = NULL, gate_entered_at = NULL, updated_at = $2
       WHERE id = $3`,
      [status, endedAt, intentId],
    );
  }

  /** One more intent with one run in another project of the same tenant. */
  async function otherProject(w: SeededRun, endedAt: Date) {
    const other = await seedOtherProject(w, { slug: 'warehouse', models: ['stub-model'], now: T0 });
    await finish(other.intentId, endedAt);
    return { ...other, code: other.intentCode };
  }

  const tracesOf = (w: SeededRun, n = 1, over: Partial<{ slug: string; project: string }> = {}) =>
    Array.from({ length: n }, () =>
      langfuse.add(
        labels({
          slug: over.slug ?? w.slug,
          project: over.project ?? 'shop',
          code: w.intentCode,
          run: w.runId,
        }),
      ),
    );

  const audit = async (scope: TenantScope, entityId: string, action: string) =>
    (await scope.audit.listForEntity(entityId)).filter((e) => e.action === action);

  describe('AC3: retention of a finished intent', () => {
    it('keeps the traces at day 179; at day 181 requests, then confirms on a later pass', async () => {
      const w = await world(T0);
      const own = tracesOf(w, 2);

      expect((await pass(at(179))).langfuseDue).toBe(0);
      expect(langfuse.deleted).toEqual([]);

      const first = await pass(at(181));
      expect(first).toMatchObject({ langfuseDue: 1, langfuseRequested: 1, langfuseConfirmed: 0 });
      // Selected by the intent's own run tag only.
      expect(langfuse.queries).toEqual([[`run_id:${w.runId}`]]);
      expect(new Set(langfuse.deleted)).toEqual(new Set(own));
      expect(
        (await audit(w.scope, w.intentId, 'langfuse.purge_requested')).map((e) => e.payload),
      ).toEqual([{ traces: 2, attempt: 1, cause: 'retention' }]);
      expect(await w.scope.langfusePurges.get(w.intentId)).toMatchObject({
        traces: 2,
        attempts: 1,
        confirmedAt: null,
      });
      expect(state.maskOwed).toBe(false);

      langfuse.settle();
      const second = await pass(at(181.1));
      expect(second).toMatchObject({ langfuseRequested: 0, langfuseConfirmed: 1 });
      expect((await audit(w.scope, w.intentId, 'langfuse.purged')).map((e) => e.payload)).toEqual([
        { traces: 2, attempts: 1, cause: 'retention' },
      ]);
      expect((await w.scope.langfusePurges.get(w.intentId))?.confirmedAt).not.toBeNull();
      // Deleted rows leave ClickHouse's disk the same day.
      expect(langfuse.compactions).toBe(1);
      expect(second.langfuseCompacted).toBe(1);

      // Confirmed: never asked about again.
      const queries = langfuse.queries.length;
      expect((await pass(at(182))).langfuseDue).toBe(0);
      expect(langfuse.queries).toHaveLength(queries);
    });

    it('asks again while Langfuse still shows the traces (its worker down), and logs it', async () => {
      const w = await world(T0);
      tracesOf(w);
      await pass(at(181));
      await pass(at(181.1));
      expect(await w.scope.langfusePurges.get(w.intentId)).toMatchObject({ attempts: 2 });
      expect(logs.map((l) => l.event)).toContain('retention.langfuse_purge_pending');
      expect(
        (await audit(w.scope, w.intentId, 'langfuse.purge_requested')).map(
          (e) => (e.payload as { attempt: number }).attempt,
        ),
      ).toEqual([1, 2]);
    });

    it('report mode counts and deletes nothing', async () => {
      const w = await world(T0);
      tracesOf(w);
      const result = await pass(at(181), { mode: 'report' });
      expect(result.langfuseDue).toBe(1);
      expect(langfuse.deleted).toEqual([]);
      expect(langfuse.queries).toEqual([]);
      expect(await w.scope.langfusePurges.get(w.intentId)).toBeUndefined();
    });

    it('confirms an intent without traces at once, without a delete', async () => {
      const w = await world(T0);
      await pass(at(181));
      expect(langfuse.deleted).toEqual([]);
      expect((await audit(w.scope, w.intentId, 'langfuse.purged')).map((e) => e.payload)).toEqual([
        { traces: 0, attempts: 0, cause: 'retention' },
      ]);
      expect(langfuse.compactions).toBe(0);
    });

    it('never touches open or held intents', async () => {
      const open = await world(T0, 'in_gate');
      tracesOf(open);
      const held = await world(T0);
      tracesOf(held);
      await holdEvidence(held.scope, { userId: held.admin }, held.intentCode, null);
      const result = await pass(at(400));
      expect(result.langfuseDue).toBe(0);
      expect(langfuse.deleted).toEqual([]);
    });
  });

  describe('safety', () => {
    it('a renamed slug or another tenant’s tag on a trace: nothing of the intent is deleted', async () => {
      for (const over of [{ slug: 'old-tenant-slug' }, { project: 'old-project-slug' }]) {
        langfuse = new FakeLangfuse();
        const w = await world(T0);
        tracesOf(w);
        tracesOf(w, 1, over);
        const result = await pass(at(181));
        // The first world's intent is still due (and mismatched) in the second round.
        expect(result.langfuseRequested).toBe(0);
        expect(result.langfuseMismatched).toBeGreaterThanOrEqual(1);
        expect(langfuse.deleted).toEqual([]);
        expect(await w.scope.langfusePurges.get(w.intentId)).toBeUndefined();
        expect(
          logs.find(
            (l) =>
              l.event === 'retention.langfuse_tag_mismatch' && l.fields.intent_id === w.intentId,
          )?.fields,
        ).toEqual({
          tenant_id: w.scope.tenantId,
          intent_id: w.intentId,
          traces: 2,
          mismatched: 1,
        });
      }
    });

    it('the per-intent guard: more traces than the limit, nothing is deleted', async () => {
      const w = await world(T0);
      tracesOf(w, MAX_TRACES_PER_INTENT + 1);
      const result = await pass(at(181));
      expect(result).toMatchObject({ langfuseGuardTripped: 1, langfuseRequested: 0 });
      expect(langfuse.deleted).toEqual([]);
    });

    it('never asks for or deletes another tenant’s traces', async () => {
      const a = await world(T0);
      const b = await world(at(100));
      tracesOf(a);
      const bTraces = tracesOf(b);
      await pass(at(181));
      expect(langfuse.queries.flat()).toEqual([`run_id:${a.runId}`]);
      for (const id of bTraces) expect(langfuse.deleted).not.toContain(id);
    });

    it('only the archived project’s intents when another project of the tenant stays', async () => {
      const w = await world(new Date(Date.now() - DAY));
      tracesOf(w);
      const other = await otherProject(w, new Date(Date.now() - DAY));
      const otherTrace = langfuse.add(
        labels({ slug: w.slug, project: 'warehouse', code: other.code, run: other.runId }),
      );
      await archiveProject(w.scope, { type: 'human', userId: w.admin }, 'shop');
      const archivedAt = new Date(
        (await audit(w.scope, w.projectId, 'project.archived'))[0]!.occurred_at,
      );
      const day = (n: number) => new Date(archivedAt.getTime() + n * DAY);
      await pass(day(0));
      await pass(day(8));
      expect(langfuse.deleted).toHaveLength(1);
      expect(langfuse.deleted).not.toContain(otherTrace);
    });

    it('Langfuse down at the start of the pass: no Langfuse step at all', async () => {
      const w = await world(T0);
      tracesOf(w);
      langfuse.down = true;
      await pass(at(181));
      expect(logs.map((l) => l.event)).toContain('retention.langfuse_unavailable');
      expect(langfuse.queries).toEqual([]);
      expect(await w.scope.langfusePurges.get(w.intentId)).toBeUndefined();
      langfuse.down = false;
      expect((await pass(at(181.1))).langfuseRequested).toBe(1);
    });

    it('a selection that fails mid-pass: counted, nothing recorded, retried on the next pass', async () => {
      const w = await world(T0);
      tracesOf(w);
      langfuse.failFind = true;
      const result = await pass(at(181));
      expect(result.failed).toBeGreaterThanOrEqual(1);
      expect(logs.find((l) => l.event === 'retention.langfuse_failed')?.fields).toMatchObject({
        error: 'langfuse_unavailable',
      });
      expect(await w.scope.langfusePurges.get(w.intentId)).toBeUndefined();
      langfuse.failFind = false;
      expect((await pass(at(181.1))).langfuseRequested).toBe(1);
    });

    it('review of E08: a key of another Langfuse project never confirms anything', async () => {
      const w = await world(T0);
      langfuse.project = 'another-project';
      const result = await pass(at(181));
      expect(result).toMatchObject({ langfuseDue: 0, langfuseConfirmed: 0 });
      expect(logs.map((l) => l.event)).toContain('retention.langfuse_project_mismatch');
      expect(await w.scope.langfusePurges.get(w.intentId)).toBeUndefined();
      expect(await audit(w.scope, w.intentId, 'langfuse.purged')).toEqual([]);
    });

    it('review of E08: the request and its audit are recorded before the delete is sent', async () => {
      const w = await world(T0);
      tracesOf(w);
      langfuse.failDelete = true;
      const result = await pass(at(181));
      expect(result.failed).toBeGreaterThanOrEqual(1);
      // Recorded as asked: the next pass finds the traces and asks again; never a silent confirm.
      expect(await w.scope.langfusePurges.get(w.intentId)).toMatchObject({
        traces: 1,
        attempts: 1,
      });
      expect(await audit(w.scope, w.intentId, 'langfuse.purge_requested')).toHaveLength(1);
      langfuse.failDelete = false;
      await pass(at(181.1));
      expect(await w.scope.langfusePurges.get(w.intentId)).toMatchObject({ attempts: 2 });
      langfuse.settle();
      await pass(at(181.2));
      expect((await audit(w.scope, w.intentId, 'langfuse.purged')).map((e) => e.payload)).toEqual([
        { traces: 1, attempts: 2, cause: 'retention' },
      ]);
    });

    it('review of E08: the tenant guard stops retention purges when too many intents are due', async () => {
      const w = await world(T0);
      tracesOf(w);
      const other = await seedOtherProject(w, {
        slug: 'warehouse',
        models: ['stub-model'],
        now: T0,
      });
      await finish(other.intentId, T0);
      const result = await pass(at(181), {}, on({ guardPercent: 1, guardFloor: 0 }));
      expect(result).toMatchObject({ langfuseGuardTripped: 1, langfuseDue: 0 });
      expect(langfuse.queries).toEqual([]);
      expect(logs.map((l) => l.event)).toContain('retention.langfuse_tenant_guard_tripped');
    });

    it('review of E08: an intent that fails the tag check is set aside; the others go on', async () => {
      const w = await world(T0);
      tracesOf(w, 1, { slug: 'old-slug' });
      const other = await seedOtherProject(w, {
        slug: 'warehouse',
        models: ['stub-model'],
        now: T0,
      });
      await finish(other.intentId, at(1));
      const otherTrace = langfuse.add(
        labels({ slug: w.slug, project: 'warehouse', code: other.intentCode, run: other.runId }),
      );
      await pass(at(181));
      expect(langfuse.deleted).toEqual([otherTrace]);
      const queries = langfuse.queries.length;
      await pass(at(181.1));
      // Set aside: not asked about again in this process for a while.
      expect(langfuse.queries.slice(queries).flat()).not.toContain(`run_id:${w.runId}`);
    });
  });

  describe('AC3: an archived project', () => {
    async function archived() {
      const w = await world(new Date(Date.now() - DAY));
      tracesOf(w);
      await archiveProject(w.scope, { type: 'human', userId: w.admin }, 'shop');
      const archivedAt = new Date(
        (await audit(w.scope, w.projectId, 'project.archived'))[0]!.occurred_at,
      );
      return { w, day: (n: number) => new Date(archivedAt.getTime() + n * DAY) };
    }

    it('purges after the grace period; project.purged waits for the confirmation: purged', async () => {
      const { w, day } = await archived();
      await pass(day(0)); // schedules the archive purge
      await pass(day(6));
      expect(langfuse.deleted).toEqual([]);

      await pass(day(8));
      expect(langfuse.deleted).toHaveLength(1);
      expect(
        (await audit(w.scope, w.intentId, 'langfuse.purge_requested')).map(
          (e) => (e.payload as { cause: string }).cause,
        ),
      ).toEqual(['archive']);
      // Not confirmed yet: the project is not complete.
      expect(await audit(w.scope, w.projectId, 'project.purged')).toHaveLength(0);

      langfuse.settle();
      await pass(day(8.1));
      const purged = await audit(w.scope, w.projectId, 'project.purged');
      expect(purged.map((e) => e.payload)).toEqual([
        { intents: 1, purged: 0, held: 0, langfuse: 'purged' },
      ]);
    });

    it('waits while the worker has no Langfuse credential (unavailable)', async () => {
      const { w, day } = await archived();
      await pass(day(0), {}, { status: 'unavailable' });
      await pass(day(8), {}, { status: 'unavailable' });
      expect(await audit(w.scope, w.projectId, 'project.purged')).toHaveLength(0);
      expect(logs.map((l) => l.event)).toContain('retention.project_purge_waits_langfuse');
      expect(langfuse.queries).toEqual([]);
    });

    it('records not_deployed when Langfuse is off', async () => {
      const { w, day } = await archived();
      await pass(day(0), {}, { status: 'not_deployed' });
      await pass(day(8), {}, { status: 'not_deployed' });
      expect((await audit(w.scope, w.projectId, 'project.purged')).map((e) => e.payload)).toEqual([
        { intents: 1, purged: 0, held: 0, langfuse: 'not_deployed' },
      ]);
    });
  });

  describe('triggers and grants (migration 0024)', () => {
    it('a confirmed purge never changes; attempts only grow; no delete', async () => {
      const w = await world(T0);
      tracesOf(w);
      await pass(at(181));
      await expect(
        t
          .appAs(w.scope.tenantId)
          .updateTable('langfuse_purges')
          .set({ attempts: 0 })
          .where('intent_id', '=', w.intentId)
          .execute(),
      ).rejects.toThrow();
      langfuse.settle();
      await pass(at(181.1));
      for (const change of [{ traces: 9 }, { confirmed_at: at(300) }, { attempts: 5 }]) {
        await expect(
          t
            .appAs(w.scope.tenantId)
            .updateTable('langfuse_purges')
            .set(change)
            .where('intent_id', '=', w.intentId)
            .execute(),
        ).rejects.toThrow();
      }
      await expect(
        t
          .appAs(w.scope.tenantId)
          .deleteFrom('langfuse_purges')
          .where('intent_id', '=', w.intentId)
          .execute(),
      ).rejects.toThrow();
      await expect(
        w.scope.langfusePurges.recordRequest({
          intentId: w.intentId,
          cause: 'retention',
          traces: 1,
          at: at(400),
        }),
      ).rejects.toBeInstanceOf(DbError);
    });
  });
});
