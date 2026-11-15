// D-08 E05 PR 1 on a live PostgreSQL (design/ADR-M51; D-05 §6.6, §10.1; D-02 FR-44): one
// retention pass with a fake clock and an in-memory store that behaves like the locked bucket
// (GOVERNANCE lock of 180 days from the write, legal holds, versions).
// - AC1: evidence files of a finished intent are purged after `evidence_retention_days` (179 kept,
//   181 purged), every version deleted, the row kept with `purged_at`, `evidence.purged` audited;
//   `report` mode deletes nothing; open and held intents are never purged; a configuration that
//   cannot be loaded purges nothing; the guard; the lock moved for longer retention.
// - AC2: the audit log, gate decisions and escalations have no deletion path (migrations test,
//   trigger checks here for the new tables).
// - AC3: an archive with open intents is refused; after the grace period (6 days kept, 8 days
//   purged) the evidence of an archived project is purged with the lock bypass, held intents kept,
//   `project.purged` once with `langfuse: not_deployed` (no Langfuse purge; E08,
//   langfuse-purge.test.ts).
// - Holds: who (rule M32), the legal hold set and taken off in the store, released once.
// - Tenants: a pass never touches another tenant's files; a URI outside the tenant is refused.
// - The orphan sweep under `packs/`.
import crypto from 'node:crypto';

import { createSimplePolicyEngine } from '@sdlc/adapter-policy-simple';
import { loadProjectConfig } from '@sdlc/config';
import { EvidenceError, type EvidenceKeyPage, type EvidenceRetentionStore } from '@sdlc/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { archiveProject } from '../../../packages/core/src/admin/projects.js';
import { AdminError } from '../../../packages/core/src/admin/errors.js';
import { CommandError } from '../../../packages/core/src/commands/errors.js';
import { DbError } from '../../../packages/core/src/db/errors.js';
import type { Intent } from '../../../packages/core/src/db/schema.js';
import { parseTenantId } from '../../../packages/core/src/db/tenant-id.js';
import type { TenantScope } from '../../../packages/core/src/db/tenant-scope.js';
import type { RegistryDeps } from '../../../packages/core/src/registry/effective-config.js';
import {
  holdEvidence,
  releaseEvidenceHold,
  showEvidenceHolds,
} from '../../../packages/core/src/retention/holds.js';
import { EvidenceHoldError } from '../../../packages/core/src/retention/errors.js';
import {
  runRetentionPass,
  type RetentionPassResult,
  type RetentionSettings,
} from '../../../packages/core/src/retention/pass.js';
import { retentionReport } from '../../../packages/core/src/retention/report.js';
import { createTestDatabase, describeDb, tamper, type TestDatabase } from './helpers.js';

const DAY = 86_400_000;
const T0 = new Date('2026-01-05T00:00:00.000Z');
const at = (days: number) => new Date(T0.getTime() + days * DAY);
const SHA = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

const registryDeps: RegistryDeps = {
  policyFactory: (config) => createSimplePolicyEngine({ config }),
  now: () => T0,
};

interface StoredFile {
  versions: number;
  /** The lock of the newest version (the bucket's 180 days from the write, or moved). */
  lockUntil: Date;
  legalHold: boolean;
  lastModified: Date;
}

/** The bucket `evidence` as the purge identity sees it (checked live on SeaweedFS 4.48). */
class LockedStore implements EvidenceRetentionStore {
  readonly files = new Map<string, StoredFile>();
  readonly calls: string[] = [];
  now: Date = T0;

  write(uri: string, writtenAt: Date, versions = 1): void {
    this.files.set(uri, {
      versions,
      lockUntil: new Date(writtenAt.getTime() + 180 * DAY),
      legalHold: false,
      lastModified: writtenAt,
    });
  }

  deleteAllVersions(uri: string, options: { readonly bypassLock: boolean }): Promise<number> {
    this.calls.push(`delete:${options.bypassLock ? 'bypass' : 'plain'}:${uri}`);
    const file = this.files.get(uri);
    if (!file) return Promise.resolve(0);
    if (file.legalHold) return Promise.reject(new EvidenceError('forbidden'));
    if (!options.bypassLock && file.lockUntil > this.now) {
      return Promise.reject(new EvidenceError('forbidden'));
    }
    this.files.delete(uri);
    return Promise.resolve(file.versions);
  }

  setLegalHold(uri: string, on: boolean): Promise<number> {
    this.calls.push(`hold:${on ? 'on' : 'off'}:${uri}`);
    const file = this.files.get(uri);
    if (!file) return Promise.resolve(0);
    file.legalHold = on;
    return Promise.resolve(file.versions);
  }

  extendLock(uri: string, until: Date): Promise<number> {
    this.calls.push(`lock:${uri}`);
    const file = this.files.get(uri);
    if (!file || file.lockUntil >= until) return Promise.resolve(0);
    file.lockUntil = until;
    return Promise.resolve(file.versions);
  }

  listKeys(prefix: string, after: string | null, limit: number): Promise<EvidenceKeyPage> {
    const keys = [...this.files.entries()]
      .map(([uri, file]) => ({ uri, lastModified: file.lastModified }))
      .filter((k) => k.uri.startsWith(`s3://evidence/${prefix}`))
      .filter((k) => after === null || k.uri.slice('s3://evidence/'.length) > after)
      .sort((a, b) => a.uri.localeCompare(b.uri));
    const page = keys.slice(0, limit);
    const last = page.at(-1)?.uri.slice('s3://evidence/'.length) ?? null;
    return Promise.resolve({ keys: page, next: keys.length > limit ? last : null });
  }
}

const SETTINGS: RetentionSettings = {
  mode: 'purge',
  bucket: 'evidence',
  batch: 200,
  guardPercent: 100,
  guardFloor: 1000,
  archiveGraceDays: 7,
  orphanGraceHours: 24,
};

interface World {
  readonly scope: TenantScope;
  readonly tenantId: string;
  readonly projectId: string;
  readonly projectSlug: string;
  readonly admin: string;
  readonly governance: string;
  readonly personA: string;
  readonly viewer: string;
}

describeDb('E05 PR 1: evidence retention on PostgreSQL', () => {
  let t: TestDatabase;
  let store: LockedStore;
  let logs: { level: string; event: string; fields: Record<string, unknown> }[];
  let suspects: Set<string>;
  let tenants = 0;

  beforeAll(async () => {
    t = await createTestDatabase();
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  });
  beforeEach(() => {
    store = new LockedStore();
    logs = [];
    suspects = new Set();
  });

  const pass = (
    now: Date,
    settings: Partial<RetentionSettings> = {},
    cursor: string | null = null,
  ): Promise<RetentionPassResult> => {
    store.now = now;
    return runRetentionPass(
      {
        db: t.app,
        store,
        logger: { log: (level, event, fields = {}) => logs.push({ level, event, fields }) },
        now: () => now,
        settings: { ...SETTINGS, ...settings },
        orphanSuspects: suspects,
      },
      cursor,
    );
  };

  async function world(configYaml?: string): Promise<World> {
    const slug = `tenant-${String(++tenants)}`;
    const tenant = await t.app.system.createTenant({ slug, name: slug });
    const scope = t.app.forTenant(parseTenantId(tenant.id));
    const project = await scope.projects.create({
      slug: 'shop',
      name: 'Shop',
      git_provider: 'github',
      repo_full_name: 'org/shop',
    });
    const user = async (name: string) =>
      (await scope.users.create({ display_name: name, email: `${name}@example.com` })).id;
    const admin = await user('admin');
    const governance = await user('gov');
    const personA = await user('a');
    const viewer = await user('viewer');
    await scope.tenantRoles.grant({ user_id: admin, role: 'tenant_admin' });
    for (const [id, role] of [
      [governance, 'governance'],
      [personA, 'person_a'],
      [viewer, 'viewer'],
    ] as const) {
      await scope.roleBindings.grant({ user_id: id, project_id: project.id, role });
    }
    if (configYaml !== undefined) {
      const loaded = loadProjectConfig(configYaml);
      if (!loaded.ok) throw new Error('bad test config');
      await scope.projectConfigs.save(project.id, {
        configYaml,
        configHash: loaded.configHash,
        updatedBy: null,
        expectedVersion: 0,
      });
    }
    return {
      scope,
      tenantId: tenant.id,
      projectId: project.id,
      projectSlug: 'shop',
      admin,
      governance,
      personA,
      viewer,
    };
  }

  /** An intent of the world's project, set to `status` with its end at `endedAt`. */
  async function intent(w: World, status: string, endedAt: Date): Promise<Intent> {
    const created = await w.scope.intents.create(
      {
        projectId: w.projectId,
        title: 'Cancel an order',
        createdBy: w.personA,
        riskTier: 'medium',
        dataClass: 'internal',
      },
      registryDeps,
    );
    await tamper(
      t.name,
      `UPDATE intents SET status = $1, current_gate = NULL, gate_entered_at = NULL, updated_at = $2
       WHERE id = $3`,
      [status, endedAt, created.id],
    );
    return { ...created, status: status as Intent['status'], updated_at: endedAt };
  }

  /** An evidence item written to the store and recorded, created at `createdAt`. */
  async function item(w: World, of: Intent, createdAt: Date, tenantInUri = w.tenantId) {
    const uri = `s3://evidence/diffs/${tenantInUri}/${of.id}/${crypto.randomUUID()}.patch`;
    const row = await w.scope.evidenceItems.record({
      intentId: of.id,
      runId: null,
      kind: 'diff',
      storageUri: uri,
      sha256: SHA(uri),
      sizeBytes: 10,
    });
    await tamper(t.name, 'UPDATE evidence_items SET created_at = $1 WHERE id = $2', [
      createdAt,
      row.id,
    ]);
    store.write(uri, createdAt, 2);
    return { id: row.id, uri };
  }

  /** A pack version (two files) written and recorded, created at `createdAt`. */
  async function pack(w: World, of: Intent, createdAt: Date, version = 1) {
    const id = crypto.randomUUID();
    const base = `s3://evidence/packs/${w.tenantId}/${of.id}/${id}`;
    const file = (name: string) => ({
      uri: `${base}/${name}`,
      sha256: SHA(base + name),
      sizeBytes: 5,
    });
    await w.scope.evidencePacks.record({
      id,
      intentId: of.id,
      version,
      contentSha256: SHA(`${id}c`),
      releaseSha256: SHA(`${id}r`),
      manifest: file('manifest.json'),
      markdown: file('pack.md'),
      locale: 'en',
      disclosureFormat: 'standard_note',
      itemCount: 1,
      builtBy: null,
    });
    await tamper(t.name, 'UPDATE evidence_packs SET created_at = $1 WHERE id = $2', [
      createdAt,
      id,
    ]);
    store.write(`${base}/manifest.json`, createdAt);
    store.write(`${base}/pack.md`, createdAt);
    return { id, uris: [`${base}/manifest.json`, `${base}/pack.md`] };
  }

  const purgedAt = async (table: 'evidence_items' | 'evidence_packs', id: string) =>
    (
      await t.owner
        .selectFrom(table)
        .select('purged_at')
        .where('id', '=', id)
        .executeTakeFirstOrThrow()
    ).purged_at;

  const auditOf = (w: World, entityId: string) => w.scope.audit.listForEntity(entityId);

  describe('AC1: retention of a finished intent', () => {
    it('keeps the files at day 179 and purges every version at day 181; rows and hashes stay', async () => {
      const w = await world();
      const done = await intent(w, 'done', T0);
      const diff = await item(w, done, T0);
      const p = await pack(w, done, T0);

      await pass(at(179));
      expect(store.files.has(diff.uri)).toBe(true);
      expect(await purgedAt('evidence_items', diff.id)).toBeNull();

      const due = await pass(at(181));
      expect(due.purged).toBeGreaterThanOrEqual(2);
      expect(store.files.has(diff.uri)).toBe(false);
      for (const uri of p.uris) expect(store.files.has(uri)).toBe(false);
      // Never the bypass for retention: the bucket's lock is over.
      expect(store.calls.filter((c) => c.startsWith('delete:bypass'))).toEqual([]);
      expect(await purgedAt('evidence_items', diff.id)).not.toBeNull();
      expect(await purgedAt('evidence_packs', p.id)).not.toBeNull();
      const events = (await auditOf(w, done.id)).filter((e) => e.action === 'evidence.purged');
      expect(events.map((e) => e.payload)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            item_id: diff.id,
            kind: 'diff',
            versions: 2,
            cause: 'retention',
          }),
          expect.objectContaining({ pack_id: p.id, kind: 'pack', versions: 2, cause: 'retention' }),
        ]),
      );
      // Done once: the next pass adds no event.
      await pass(at(182));
      expect(
        (await auditOf(w, done.id)).filter((e) => e.action === 'evidence.purged'),
      ).toHaveLength(2);
    });

    it('report mode counts and deletes nothing', async () => {
      const w = await world();
      const done = await intent(w, 'rejected', T0);
      const diff = await item(w, done, T0);
      const result = await pass(at(200), { mode: 'report' });
      expect(result.eligible).toBeGreaterThanOrEqual(1);
      expect(result.purged).toBe(0);
      expect(store.calls.filter((c) => c.startsWith('delete:'))).toEqual([]);
      expect(store.files.has(diff.uri)).toBe(true);
      expect(await purgedAt('evidence_items', diff.id)).toBeNull();
      const report = await retentionReport(w.scope, {
        now: at(200),
        archiveGraceDays: 7,
        limit: 100,
      });
      expect(report).toEqual([
        expect.objectContaining({ projectSlug: 'shop', retentionDays: 180, stored: 1, due: 1 }),
      ]);
    });

    it('never purges an open intent', async () => {
      const w = await world();
      const open = await intent(w, 'paused', T0);
      const diff = await item(w, open, T0);
      await pass(at(2000));
      expect(store.files.has(diff.uri)).toBe(true);
      expect(await purgedAt('evidence_items', diff.id)).toBeNull();
    });

    it('follows a longer project retention and moves the lock forward before it ends', async () => {
      const w = await world('retention:\n  evidence_retention_days: 365\n');
      const open = await intent(w, 'paused', T0);
      const diff = await item(w, open, T0);
      await pass(at(170));
      expect(store.files.get(diff.uri)?.lockUntil).toEqual(at(170 + 365));
      // Recorded: the next pass moves nothing.
      store.calls.length = 0;
      await pass(at(171));
      expect(store.calls).not.toContain(`lock:${diff.uri}`);
      // Finished at day 10: purged after 365 days, not after 180.
      await tamper(t.name, `UPDATE intents SET status = 'done', updated_at = $1 WHERE id = $2`, [
        at(10),
        open.id,
      ]);
      await pass(at(300));
      expect(store.files.has(diff.uri)).toBe(true);
      // Due at day 375, but the lock was moved to day 535: the plain delete is refused, the row
      // stays unpurged and the next passes try again.
      await pass(at(380));
      expect(store.files.has(diff.uri)).toBe(true);
      expect(await purgedAt('evidence_items', diff.id)).toBeNull();
      expect(
        logs.some(
          (l) => l.event === 'retention.purge_failed' && l.fields.error === 'evidence_forbidden',
        ),
      ).toBe(true);
      await pass(at(536));
      expect(store.files.has(diff.uri)).toBe(false);
    });

    it('purges nothing for a project whose configuration cannot be loaded (fail closed)', async () => {
      const w = await world('retention:\n  evidence_retention_days: 200\n');
      const done = await intent(w, 'done', T0);
      const diff = await item(w, done, T0);
      await tamper(
        t.name,
        `UPDATE project_configs SET config_yaml = 'retention: [' WHERE project_id = $1`,
        [w.projectId],
      );
      await pass(at(400));
      expect(store.files.has(diff.uri)).toBe(true);
      expect(logs.some((l) => l.event === 'retention.config_unavailable')).toBe(true);
    });

    it('stops at the guard instead of purging a large share of a tenant', async () => {
      const w = await world();
      const done = await intent(w, 'done', T0);
      for (let i = 0; i < 5; i += 1) await item(w, done, T0);
      const result = await pass(at(181), { guardPercent: 20, guardFloor: 2 });
      expect(result.guardTripped).toBeGreaterThanOrEqual(1);
      expect(
        (await auditOf(w, done.id)).filter((e) => e.action === 'evidence.purged'),
      ).toHaveLength(0);
      expect(logs.some((l) => l.event === 'retention.guard_tripped')).toBe(true);
    });
  });

  describe('holds', () => {
    it('keeps held evidence with a legal hold, and purges it once the hold is released', async () => {
      const w = await world();
      const done = await intent(w, 'cancelled', T0);
      const diff = await item(w, done, T0);
      const hold = await holdEvidence(
        w.scope,
        { userId: w.governance },
        done.code,
        'https://example.com/case/1',
      );
      expect(hold.reason_ref).toBe('https://example.com/case/1');
      await expect(
        holdEvidence(w.scope, { userId: w.admin }, done.code, null),
      ).rejects.toMatchObject({
        code: 'evidence_hold_exists',
      });

      const held = await pass(at(400));
      expect(held.holdsApplied).toBeGreaterThanOrEqual(1);
      expect(store.files.has(diff.uri)).toBe(true);
      expect(store.files.get(diff.uri)?.legalHold).toBe(true);

      await releaseEvidenceHold(w.scope, { userId: w.admin }, done.code);
      const released = await pass(at(401));
      expect(released.holdsReleased).toBeGreaterThanOrEqual(1);
      expect(store.files.has(diff.uri)).toBe(false);
      const actions = (await auditOf(w, done.id)).map((e) => e.action);
      expect(actions).toEqual(
        expect.arrayContaining(['evidence.hold_set', 'evidence.hold_released', 'evidence.purged']),
      );
      const view = await showEvidenceHolds(w.scope, { userId: w.governance }, done.code);
      expect(view.active).toBeNull();
      expect(view.history).toHaveLength(1);
    });

    it('sets the legal hold on files added after the first apply', async () => {
      const w = await world();
      const done = await intent(w, 'done', T0);
      await holdEvidence(w.scope, { userId: w.governance }, done.code, null);
      await pass(at(1));
      const later = await item(w, done, new Date());
      await pass(at(2));
      expect(store.files.get(later.uri)?.legalHold).toBe(true);
    });

    it('only tenant admins and access.evidence_hold_roles hold (rule M32); others are refused', async () => {
      const w = await world();
      const done = await intent(w, 'done', T0);
      await expect(
        holdEvidence(w.scope, { userId: w.viewer }, done.code, null),
      ).rejects.toBeInstanceOf(CommandError);
      await expect(
        holdEvidence(w.scope, { userId: w.personA }, done.code, null),
      ).rejects.toMatchObject({
        code: 'forbidden',
      });
      const other = await world();
      await expect(
        holdEvidence(w.scope, { userId: other.admin }, done.code, null),
      ).rejects.toMatchObject({
        code: 'intent_not_found',
      });
      await expect(
        releaseEvidenceHold(w.scope, { userId: w.admin }, done.code),
      ).rejects.toBeInstanceOf(EvidenceHoldError);
      // Never free text: only an https:// link.
      await expect(
        holdEvidence(w.scope, { userId: w.admin }, done.code, 'the client disputes the invoice'),
      ).rejects.toBeInstanceOf(DbError);
    });
  });

  describe('AC3: archived projects', () => {
    it('refuses to archive a project with open intents', async () => {
      const w = await world();
      await intent(w, 'running', T0);
      await expect(
        archiveProject(w.scope, { type: 'human', userId: w.admin }, 'shop'),
      ).rejects.toEqual(expect.objectContaining({ code: 'project_has_open_intents' }));
      await expect(
        archiveProject(w.scope, { type: 'human', userId: w.admin }, 'shop'),
      ).rejects.toBeInstanceOf(AdminError);
    });

    it('purges after the grace period with the lock bypass, keeps held intents, writes project.purged once', async () => {
      const w = await world();
      // Young evidence (a day old at the archive): only the archive purge removes it, with the
      // bypass of the bucket's 180-day lock.
      const yesterday = new Date(Date.now() - DAY);
      const done = await intent(w, 'done', yesterday);
      const heldIntent = await intent(w, 'rejected', yesterday);
      const diff = await item(w, done, yesterday);
      const p = await pack(w, done, yesterday);
      const kept = await item(w, heldIntent, yesterday);
      await holdEvidence(w.scope, { userId: w.governance }, heldIntent.code, null);
      await archiveProject(w.scope, { type: 'human', userId: w.admin }, 'shop');
      const archivedAt = (await auditOf(w, w.projectId)).find(
        (e) => e.action === 'project.archived',
      )!.occurred_at;
      const day = (n: number) => new Date(new Date(archivedAt).getTime() + n * DAY);

      // The first `purge` pass after the archive schedules the purge (once, audited).
      await pass(day(0));
      const scheduled = (await auditOf(w, w.projectId)).filter(
        (e) => e.action === 'project.purge_scheduled',
      );
      expect(scheduled.map((e) => e.payload)).toEqual([{ grace_days: 7 }]);
      await pass(day(6));
      expect(store.files.has(diff.uri)).toBe(true);

      await pass(day(8));
      expect(store.files.has(diff.uri)).toBe(false);
      for (const uri of p.uris) expect(store.files.has(uri)).toBe(false);
      expect(store.calls).toContain(`delete:bypass:${diff.uri}`);
      expect(store.files.has(kept.uri)).toBe(true);
      const projectEvents = (await auditOf(w, w.projectId)).filter(
        (e) => e.action === 'project.purged',
      );
      expect(projectEvents).toHaveLength(1);
      expect(projectEvents[0]!.payload).toEqual({
        intents: 2,
        purged: 2,
        held: 1,
        // E08 (ADR-M53): the pass has no Langfuse purge here.
        langfuse: 'not_deployed',
      });
      const causes = (await auditOf(w, done.id))
        .filter((e) => e.action === 'evidence.purged')
        .map((e) => (e.payload as { cause: string }).cause);
      expect(causes).toEqual(['archive', 'archive']);

      await pass(day(9));
      expect(
        (await auditOf(w, w.projectId)).filter((e) => e.action === 'project.purged'),
      ).toHaveLength(1);
    });
  });

  it('gives a project archived before the purge was turned on the whole grace period from the first purge pass', async () => {
    const w = await world();
    const yesterday = new Date(Date.now() - DAY);
    const done = await intent(w, 'done', yesterday);
    const diff = await item(w, done, yesterday);
    await archiveProject(w.scope, { type: 'human', userId: w.admin }, 'shop');
    const archivedAt = (await auditOf(w, w.projectId)).find(
      (e) => e.action === 'project.archived',
    )!.occurred_at;
    const day = (n: number) => new Date(new Date(archivedAt).getTime() + n * DAY);
    // Report mode for 30 days: nothing scheduled, nothing deleted.
    await pass(day(30), { mode: 'report' });
    expect(
      (await auditOf(w, w.projectId)).filter((e) => e.action === 'project.purge_scheduled'),
    ).toHaveLength(0);
    // The first purge pass schedules; the grace runs from there.
    await pass(day(31));
    await pass(day(37));
    expect(store.files.has(diff.uri)).toBe(true);
    await pass(day(39));
    expect(store.files.has(diff.uri)).toBe(false);
  });

  describe('tenants', () => {
    it('never touches another tenant: a URI outside the tenant folder is refused', async () => {
      const a = await world();
      const b = await world();
      const doneA = await intent(a, 'done', T0);
      const doneB = await intent(b, 'done', at(100));
      const own = await item(a, doneA, T0);
      const foreign = await item(a, doneA, T0, b.tenantId);
      const bFile = await item(b, doneB, at(100));
      await pass(at(181));
      expect(store.files.has(own.uri)).toBe(false);
      expect(store.files.has(foreign.uri)).toBe(true);
      expect(store.files.has(bFile.uri)).toBe(true);
      expect(logs.some((l) => l.event === 'retention.uri_unexpected')).toBe(true);
    });
  });

  describe('the orphan sweep', () => {
    it('deletes pack files without a row older than the grace, and nothing else', async () => {
      const w = await world();
      const done = await intent(w, 'paused', T0);
      const p = await pack(w, done, at(1));
      const orphanId = crypto.randomUUID();
      const orphan = `s3://evidence/packs/${w.tenantId}/${done.id}/${orphanId}/manifest.json`;
      const young = `s3://evidence/packs/${w.tenantId}/${done.id}/${crypto.randomUUID()}/pack.md`;
      store.write(orphan, at(1));
      store.write(young, at(2));

      const report = await pass(at(2), { mode: 'report' });
      expect(report.orphansFound).toBe(1);
      expect(store.files.has(orphan)).toBe(true);

      // Seen without a row once (the report above): counted, then deleted on the next visit.
      const swept = await pass(at(2));
      expect(swept.orphansSwept).toBe(1);
      expect(store.files.has(orphan)).toBe(false);
      expect(store.files.has(young)).toBe(true);
      for (const uri of p.uris) expect(store.files.has(uri)).toBe(true);
      const events = (await auditOf(w, done.id)).filter(
        (e) => e.action === 'evidence.orphan_swept',
      );
      expect(events.map((e) => e.payload)).toEqual([{ pack_id: orphanId, files: 1, versions: 1 }]);
    });
  });

  describe('triggers and grants (migration 0023)', () => {
    it('sets purged_at once, moves the lock only forward, never deletes rows', async () => {
      const w = await world();
      const done = await intent(w, 'done', T0);
      const diff = await item(w, done, T0);
      await t
        .appAs(w.tenantId)
        .updateTable('evidence_items')
        .set({ lock_extended_until: at(400) })
        .where('id', '=', diff.id)
        .execute();
      await expect(
        t
          .appAs(w.tenantId)
          .updateTable('evidence_items')
          .set({ lock_extended_until: at(300) })
          .where('id', '=', diff.id)
          .execute(),
      ).rejects.toThrow();
      await t
        .appAs(w.tenantId)
        .updateTable('evidence_items')
        .set({ purged_at: at(500) })
        .where('id', '=', diff.id)
        .execute();
      await expect(
        t
          .appAs(w.tenantId)
          .updateTable('evidence_items')
          .set({ purged_at: at(600) })
          .where('id', '=', diff.id)
          .execute(),
      ).rejects.toThrow();
      await expect(
        t.appAs(w.tenantId).deleteFrom('evidence_items').where('id', '=', diff.id).execute(),
      ).rejects.toThrow();
    });

    it('releases a hold once and never deletes it', async () => {
      const w = await world();
      const done = await intent(w, 'done', T0);
      const hold = await holdEvidence(w.scope, { userId: w.governance }, done.code, null);
      await releaseEvidenceHold(w.scope, { userId: w.governance }, done.code);
      await expect(
        t
          .appAs(w.tenantId)
          .updateTable('evidence_holds')
          .set({ released_at: at(9), released_by: w.admin })
          .where('id', '=', hold.id)
          .execute(),
      ).rejects.toThrow();
      await expect(
        t.appAs(w.tenantId).deleteFrom('evidence_holds').where('id', '=', hold.id).execute(),
      ).rejects.toThrow();
    });
  });
});
