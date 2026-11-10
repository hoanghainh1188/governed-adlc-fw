// D-08 H03b on a live PostgreSQL: client purge after grace, hold blocks completion, terminal
// `client_data.deleted` + tenant `purged` (ADR-M97 §2; D-08 H03b AC1–AC3).
import { EvidenceError, type EvidenceKeyPage, type EvidenceRetentionStore } from '@sdlc/contracts';
import { createSimplePolicyEngine } from '@sdlc/adapter-policy-simple';
import { loadProjectConfig } from '@sdlc/config';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

import { parseTenantId } from '../../../packages/core/src/db/tenant-id.js';
import type { TenantScope } from '../../../packages/core/src/db/tenant-scope.js';
import type { RegistryDeps } from '../../../packages/core/src/registry/effective-config.js';
import {
  runClientPurgePass,
  type ClientPurgeSettings,
} from '../../../packages/core/src/retention/client-purge-pass.js';
import { addDays } from '../../../packages/core/src/retention/rules.js';
import { createTestDatabase, describeDb, tamper, type TestDatabase } from './helpers.js';

const T0 = new Date('2026-01-01T00:00:00.000Z');
const DAY_MS = 86_400_000;
const SHA = (s: string) =>
  Buffer.from(s.padEnd(32, '0')).toString('hex').slice(0, 64).padEnd(64, 'a');

const registryDeps: RegistryDeps = {
  policyFactory: (config) => createSimplePolicyEngine({ config }),
  now: () => T0,
};

class FakeStore implements EvidenceRetentionStore {
  readonly files = new Map<string, { versions: number; legalHold: boolean }>();
  readonly calls: string[] = [];

  write(uri: string, versions = 1): void {
    this.files.set(uri, { versions, legalHold: false });
  }

  deleteAllVersions(uri: string, options: { readonly bypassLock: boolean }): Promise<number> {
    this.calls.push(`delete:${options.bypassLock ? 'bypass' : 'plain'}:${uri}`);
    const file = this.files.get(uri);
    if (!file) return Promise.resolve(0);
    if (file.legalHold) return Promise.reject(new EvidenceError('forbidden'));
    this.files.delete(uri);
    return Promise.resolve(file.versions);
  }

  setLegalHold(uri: string, on: boolean): Promise<number> {
    const file = this.files.get(uri);
    if (!file) return Promise.resolve(0);
    file.legalHold = on;
    return Promise.resolve(file.versions);
  }

  extendLock(): Promise<number> {
    return Promise.resolve(0);
  }

  listKeys(): Promise<EvidenceKeyPage> {
    return Promise.resolve({ keys: [], next: null });
  }
}

const SETTINGS: ClientPurgeSettings = {
  mode: 'purge',
  bucket: 'evidence',
  batch: 200,
  graceDays: 14,
};

interface World {
  readonly scope: TenantScope;
  readonly tenantId: string;
  readonly projectId: string;
  readonly userId: string;
}

describeDb('H03b: client purge pass on PostgreSQL', () => {
  let t: TestDatabase;
  let store: FakeStore;
  let logs: { level: string; event: string; fields: Record<string, unknown> }[];
  let n = 0;

  beforeAll(async () => {
    t = await createTestDatabase();
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  });
  beforeEach(() => {
    store = new FakeStore();
    logs = [];
  });

  async function world(): Promise<World> {
    const slug = `h03b-${++n}`;
    const tenant = await t.app.system.createTenant({ slug, name: slug });
    const scope = t.app.forTenant(parseTenantId(tenant.id));
    const project = await scope.projects.create({
      slug: 'shop',
      name: 'Shop',
      git_provider: 'github',
      repo_full_name: `${slug}/shop`,
    });
    const user = await scope.users.create({
      display_name: 'Alice Example',
      email: `alice-${n}@example.com`,
    });
    const loaded = loadProjectConfig('');
    if (!loaded.ok) throw new Error('default configuration must load');
    await scope.projectConfigs.save(project.id, {
      configYaml: '',
      configHash: loaded.configHash,
      updatedBy: user.id,
      expectedVersion: 0,
      cause: 'upload',
    });
    return { scope, tenantId: tenant.id, projectId: project.id, userId: user.id };
  }

  async function approve(scope: TenantScope, at: Date, operatorId: string): Promise<void> {
    await scope.audit.append({
      action: 'client_data.deletion_approved',
      actorType: 'human',
      actorId: operatorId,
      entityId: scope.tenantId,
      payload: { operator_id: operatorId, confirmed_scope: 'all_projects' },
      occurredAt: at,
    });
  }

  async function pending(w: World, approvedAt: Date): Promise<void> {
    await sql`UPDATE tenants SET status = ${'pending_deletion'} WHERE id = ${w.tenantId}`.execute(
      t.appRaw,
    );
    await approve(w.scope, approvedAt, w.userId);
  }

  async function finishedIntent(w: World, status: 'done' | 'running', at: Date) {
    const created = await w.scope.intents.create(
      {
        projectId: w.projectId,
        title: 'Cancel an order',
        createdBy: w.userId,
        riskTier: 'medium',
        dataClass: 'internal',
      },
      registryDeps,
    );
    if (status === 'done') {
      await tamper(
        t.name,
        `UPDATE intents SET status = 'done', current_gate = NULL, gate_entered_at = NULL,
         updated_at = $1 WHERE id = $2`,
        [at, created.id],
      );
    }
    return created;
  }

  async function diffItem(w: World, intentId: string, at: Date) {
    const uri = `s3://evidence/diffs/${w.tenantId}/${intentId}/${crypto.randomUUID()}.patch`;
    const row = await w.scope.evidenceItems.record({
      intentId,
      runId: null,
      kind: 'diff',
      storageUri: uri,
      sha256: SHA(uri),
      sizeBytes: 10,
    });
    await tamper(t.name, 'UPDATE evidence_items SET created_at = $1 WHERE id = $2', [at, row.id]);
    store.write(uri, 2);
    return { id: row.id, uri };
  }

  const pass = (now: Date, settings: Partial<ClientPurgeSettings> = {}) =>
    runClientPurgePass({
      db: t.app,
      store,
      logger: { log: (level, event, fields = {}) => logs.push({ level, event, fields }) },
      now: () => now,
      settings: { ...SETTINGS, ...settings },
    });

  it('AC1: after grace, purges evidence with bypass, anonymizes, and sets purged', async () => {
    const w = await world();
    await pending(w, T0);
    const intent = await finishedIntent(w, 'done', T0);
    const item = await diffItem(w, intent.id, T0);
    const token = await w.scope.apiTokens.create({
      user_id: w.userId,
      token_hash: SHA(`token-${w.tenantId}`),
      name: 'cli',
      expires_at: new Date(Date.now() + 30 * DAY_MS),
    });

    const early = await pass(addDays(T0, 13));
    expect(early.tenantsDue).toBe(0);
    expect(store.files.has(item.uri)).toBe(true);

    const result = await pass(addDays(T0, 14));
    expect(result.tenantsDue).toBe(1);
    expect(result.tenantsPurged).toBe(1);
    expect(result.evidencePurged).toBe(1);
    expect(store.files.has(item.uri)).toBe(false);
    expect(store.calls.some((c) => c.startsWith('delete:bypass:'))).toBe(true);

    const tenant = await t.app.system.getTenant(parseTenantId(w.tenantId));
    expect(tenant?.status).toBe('purged');
    const user = await w.scope.users.getById(w.userId);
    expect(user?.email).toBe(`deleted-${w.userId}@redacted.invalid`);
    const revoked = await w.scope.apiTokens.getById(token.id);
    expect(revoked?.revoked_at).not.toBeNull();

    const deleted = await w.scope.audit.listForEntity(w.tenantId, ['client_data.deleted']);
    expect(deleted).toHaveLength(1);
    expect(deleted[0]?.payload).toMatchObject({
      evidence_files_purged: 1,
      users_anonymized: 1,
    });
    const started = await w.scope.audit.listForEntity(w.tenantId, ['client_data.deletion_started']);
    expect(started).toHaveLength(1);
  });

  it('AC2: an active hold blocks completion and records purge_blocked_by_hold', async () => {
    const w = await world();
    await pending(w, T0);
    const held = await finishedIntent(w, 'done', T0);
    const open = await finishedIntent(w, 'running', T0);
    const heldItem = await diffItem(w, held.id, T0);
    const openItem = await diffItem(w, open.id, T0);
    await w.scope.evidenceHolds.create({
      intentId: held.id,
      heldBy: w.userId,
      reasonRef: 'https://example.test/hold',
    });

    const result = await pass(addDays(T0, 14));
    expect(result.tenantsBlocked).toBe(1);
    expect(result.tenantsPurged).toBe(0);
    expect(store.files.has(heldItem.uri)).toBe(true);
    expect(store.files.has(openItem.uri)).toBe(true);

    const blocked = await w.scope.audit.listForEntity(w.tenantId, [
      'client_data.purge_blocked_by_hold',
    ]);
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.payload).toMatchObject({ open_intents: 1, active_holds: 1 });
    const blockedTenant = await t.app.system.getTenant(parseTenantId(w.tenantId));
    expect(blockedTenant?.status).toBe('pending_deletion');
    expect(await w.scope.audit.listForEntity(w.tenantId, ['client_data.deleted'])).toEqual([]);
  });

  it('AC3: client_data.deleted is the last client_data event before purged', async () => {
    const w = await world();
    await pending(w, T0);
    const intent = await finishedIntent(w, 'done', T0);
    await diffItem(w, intent.id, T0);

    await pass(addDays(T0, 14));
    const events = await w.scope.audit.listForEntity(w.tenantId, [
      'client_data.deletion_approved',
      'client_data.deletion_started',
      'client_data.purge_blocked_by_hold',
      'client_data.deleted',
    ]);
    expect(events.map((e) => e.action)).toEqual([
      'client_data.deletion_approved',
      'client_data.deletion_started',
      'client_data.deleted',
    ]);
    expect((await t.app.system.getTenant(parseTenantId(w.tenantId)))?.status).toBe('purged');
  });
});
