// D-08 B12 on a live PostgreSQL (design/ADR-M32): AC1 the project AI record (versions, history,
// audit, fixed rules in the database, write roles, the API), AC2 the G1 check at the submit
// (FR-19). The pure rules are in tests/ai-record; AC3 in tests/policy/production-data.test.ts.
import { t, type MessageKey } from '@sdlc/messages';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp, type ApiDeps } from '../../../apps/api/src/app.js';
import type { IntentWorkflowRef } from '../../../packages/contracts/src/intent-workflow.js';
import { issueApiToken } from '../../../packages/core/src/admin/tokens.js';
import { saveAiRecord } from '../../../packages/core/src/ai-record/service.js';
import type { SaveProjectAiRecord } from '../../../packages/core/src/db/repositories/project-ai-records.js';
import type { Intent } from '../../../packages/core/src/db/schema.js';
import { parseTenantId } from '../../../packages/core/src/db/tenant-id.js';
import { stepIntent } from '../../../packages/core/src/workflow/step.js';
import { tokenIssuedAt } from '../token-clock.js';
import { createWorkflowFixture, type WorkflowFixture } from '../workflow/fixture.js';
import { createTestDatabase, describeDb, type TestDatabase } from './helpers.js';

const T0 = new Date('2026-09-28T01:00:00.000Z');
const REF = 'https://docs.example.test/project/ai-record';

type Save = Omit<SaveProjectAiRecord, 'updatedBy' | 'expectedVersion' | 'actorType'>;
const RESTRICTED_ONLY: Save = {
  aiAllowed: 'yes',
  allowedDataClasses: ['internal', 'client_restricted'],
  prodLogsAllowed: 'no',
  disclosureFormat: 'standard_note',
  confirmedAt: null,
  recordRef: null,
};
const CONFIRMED: Save = {
  aiAllowed: 'yes_with_conditions',
  allowedDataClasses: ['public', 'internal', 'client_confidential', 'client_restricted'],
  prodLogsAllowed: 'yes_masked',
  disclosureFormat: 'client_format',
  confirmedAt: '2026-09-24',
  recordRef: REF,
};

describeDb('B12: the project AI record on PostgreSQL', () => {
  let db: TestDatabase;
  let f: WorkflowFixture;
  let pm: string;
  let viewer: string;
  let projectId: string;
  let bare: string;
  const step = (intent: Intent) => stepIntent(f.scope, { registry: f.registry }, intent.id);
  const reload = async (intent: Intent) => (await f.scope.intents.getById(intent.id))!;

  /** A project with the 2+N people of the fixture and no AI record. */
  async function projectWithoutRecord(slug: string): Promise<string> {
    const project = await f.scope.projects.create({
      slug,
      name: slug,
      git_provider: 'github',
      repo_full_name: `acme/${slug}`,
    });
    for (const [user, role] of [
      [f.users.a, 'person_a'],
      [f.users.b, 'person_b'],
      [pm, 'pm_brse'],
      [viewer, 'viewer'],
    ] as const) {
      await f.scope.roleBindings.grant({ user_id: user, project_id: project.id, role });
    }
    return project.id;
  }

  async function save(project: string, content: Save, by = pm) {
    const current = await f.scope.projectAiRecords.get(project);
    return saveAiRecord(f.scope, project, {
      ...content,
      updatedBy: by,
      expectedVersion: current?.version ?? 0,
      actorType: 'human',
      today: '2026-09-28',
    });
  }

  beforeAll(async () => {
    db = await createTestDatabase();
    f = await createWorkflowFixture(db, () => T0);
    f.h.stub.now = T0;
    pm = (await f.scope.users.create({ display_name: 'pm', email: 'pm@example.com' })).id;
    viewer = (await f.scope.users.create({ display_name: 'v', email: 'v@example.com' })).id;
    projectId = f.target.projectId;
    await f.scope.roleBindings.grant({ user_id: pm, project_id: projectId, role: 'pm_brse' });
    await f.scope.roleBindings.grant({ user_id: viewer, project_id: projectId, role: 'viewer' });
    bare = await projectWithoutRecord('bare');
  }, 60_000);

  afterAll(async () => {
    await f?.close();
    await db?.drop();
  });

  describe('AC1: versions, history and audit', () => {
    it('every save is the next version, kept in the append-only history', async () => {
      const project = await projectWithoutRecord('history');
      const v1 = await save(project, RESTRICTED_ONLY);
      const v2 = await save(project, CONFIRMED, f.users.a);
      expect([v1.version, v2.version]).toEqual([1, 2]);
      expect(v1.record_sha256).not.toBe(v2.record_sha256);

      const versions = await f.scope.projectAiRecords.versions(project);
      expect(
        versions.map((v) => [v.version, v.allowed_data_classes, v.confirmed_at, v.updated_by]),
      ).toEqual([
        [1, ['internal', 'client_restricted'], null, pm],
        [
          2,
          ['public', 'internal', 'client_confidential', 'client_restricted'],
          '2026-09-24',
          f.users.a,
        ],
      ]);
      expect(versions.map((v) => v.record_sha256)).toEqual([v1.record_sha256, v2.record_sha256]);

      // The audit events hold codes, the version and the hash; never the link.
      const events = (
        await sql<{ payload: Record<string, unknown>; actor_type: string; actor_id: string }>`
          SELECT payload, actor_type, actor_id FROM audit_log
          WHERE entity_id = ${project} AND action = 'ai_record.changed' ORDER BY seq`.execute(
          db.owner,
        )
      ).rows;
      expect(events).toEqual([
        {
          actor_type: 'human',
          actor_id: pm,
          payload: {
            version: 1,
            record_sha256: v1.record_sha256,
            ai_allowed: 'yes',
            prod_logs_allowed: 'no',
            disclosure_format: 'standard_note',
            consent: 'unknown',
            updated_by: pm,
          },
        },
        {
          actor_type: 'human',
          actor_id: f.users.a,
          payload: {
            version: 2,
            record_sha256: v2.record_sha256,
            ai_allowed: 'yes_with_conditions',
            prod_logs_allowed: 'yes_masked',
            disclosure_format: 'client_format',
            consent: 'confirmed',
            updated_by: f.users.a,
          },
        },
      ]);
      expect(JSON.stringify(events)).not.toContain('https:');
      expect((await f.scope.audit.verify()).broken).toBeUndefined();
    });

    it('refuses a stale version (compare-and-set)', async () => {
      const project = await projectWithoutRecord('stale');
      await save(project, RESTRICTED_ONLY);
      await expect(
        saveAiRecord(f.scope, project, {
          ...RESTRICTED_ONLY,
          updatedBy: pm,
          expectedVersion: 0,
          actorType: 'human',
        }),
      ).rejects.toMatchObject({ name: 'AiRecordError', code: 'version_conflict' });
    });

    it('the history can never be changed or deleted', async () => {
      for (const statement of [
        sql`UPDATE project_ai_record_versions SET ai_allowed = 'no'`,
        sql`DELETE FROM project_ai_record_versions`,
        sql`TRUNCATE project_ai_record_versions`,
      ]) {
        await expect(statement.execute(db.appAs(f.target.tenantId))).rejects.toThrow();
        await expect(statement.execute(db.owner)).rejects.toMatchObject({ code: 'SDA01' });
      }
    });

    it('the database repeats the fixed rules of handbook Chapter 2', async () => {
      const current = (await f.scope.projectAiRecords.get(projectId))!;
      const update = (set: ReturnType<typeof sql>) =>
        sql`UPDATE project_ai_records SET ${set}, version = version + 1
            WHERE project_id = ${projectId}`.execute(db.appAs(f.target.tenantId));
      for (const set of [
        sql`allowed_data_classes = '{prohibited}'`,
        sql`ai_allowed = 'no', allowed_data_classes = '{client_restricted}'`,
        sql`allowed_data_classes = '{client_confidential}', confirmed_at = NULL`,
        sql`confirmed_at = '2026-09-01', record_ref = NULL`,
        sql`record_ref = 'Mr. Tanaka'`,
      ]) {
        await expect(update(set)).rejects.toMatchObject({ code: '23514' });
      }
      // A change must be the next version: the history cannot be skipped.
      await expect(
        sql`UPDATE project_ai_records SET version = version + 2 WHERE project_id = ${projectId}`.execute(
          db.appAs(f.target.tenantId),
        ),
      ).rejects.toMatchObject({ code: '23514' });
      expect((await f.scope.projectAiRecords.get(projectId))!.version).toBe(current.version);
    });

    it('only the write roles save (config access.ai_record_write_roles, M19)', async () => {
      const project = await projectWithoutRecord('roles');
      for (const who of [viewer, f.users.b, f.users.gov]) {
        await expect(save(project, RESTRICTED_ONLY, who)).rejects.toMatchObject({
          code: 'not_a_writer',
        });
      }
      expect(await f.scope.projectAiRecords.get(project)).toBeUndefined();
      await expect(save(project, RESTRICTED_ONLY, pm)).resolves.toMatchObject({ version: 1 });
      await expect(save(project, CONFIRMED, f.users.a)).resolves.toMatchObject({ version: 2 });
    });

    it('another tenant never sees the record or its versions', async () => {
      const other = await db.app.system.createTenant({ slug: 'other', name: 'Other' });
      const scope = db.app.forTenant(parseTenantId(other.id));
      expect(await scope.projectAiRecords.get(projectId)).toBeUndefined();
      expect(await scope.projectAiRecords.versions(projectId)).toEqual([]);
    });
  });

  describe('AC1: the API (GET and PUT /v1/projects/:project/ai-record)', () => {
    let app: Awaited<ReturnType<typeof createApp>>;
    const woken: IntentWorkflowRef[] = [];
    const tokens: Record<string, string> = {};

    beforeAll(async () => {
      await projectWithoutRecord('api');
      for (const [key, id] of Object.entries({ pm, viewer, a: f.users.a, b: f.users.b })) {
        tokens[key] = (
          await issueApiToken(f.scope, { userId: id, name: key, now: tokenIssuedAt() })
        ).token;
      }
      const outsider = await f.scope.users.create({ display_name: 'o', email: 'o@example.com' });
      tokens.outsider = (
        await issueApiToken(f.scope, { userId: outsider.id, name: 'o', now: tokenIssuedAt() })
      ).token;
      app = await createApp({
        db: db.app as unknown as ApiDeps['db'],
        settings: { rateLimitPerMinute: 1000, authFailuresPerMinute: 1000 },
        now: () => T0,
        intentSignals: {
          wake: (ref) => {
            woken.push(ref);
            return Promise.resolve();
          },
          kill: () => Promise.resolve(),
        },
      });
    });

    afterAll(async () => {
      await app?.close();
    });

    const inject = async (method: 'GET' | 'PUT', who: string, body?: unknown) => {
      const reply = await app
        .getHttpAdapter()
        .getInstance()
        .inject({
          method,
          url: '/v1/projects/api/ai-record',
          headers: { authorization: `Bearer ${tokens[who]!}` },
          ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
        });
      return { status: reply.statusCode, body: reply.json<Record<string, unknown>>() };
    };
    const put = (who: string, change: Record<string, unknown> = {}) =>
      inject('PUT', who, {
        expected_version: 0,
        ai_allowed: 'yes',
        allowed_data_classes: ['internal', 'client_restricted'],
        prod_logs_allowed: 'no',
        disclosure_format: 'standard_note',
        ...change,
      });
    const expectError = (
      reply: { status: number; body: Record<string, unknown> },
      status: number,
      code: string,
    ) => {
      expect(reply.status, JSON.stringify(reply.body)).toBe(status);
      const error = reply.body.error as Record<string, unknown>;
      expect(error.code).toBe(code);
      expect(error.message).toBe(t(`api.error.${code}` as MessageKey));
      return error;
    };

    it('no record yet → 404 ai_record_not_found; no role → 404 project_not_found', async () => {
      expectError(await inject('GET', 'b'), 404, 'ai_record_not_found');
      expectError(await inject('GET', 'outsider'), 404, 'project_not_found');
      expectError(await put('outsider'), 404, 'project_not_found');
    });

    it('a read role cannot write (403); the rules refuse with a reason (422)', async () => {
      expectError(await put('viewer'), 403, 'forbidden');
      expectError(await put('b'), 403, 'forbidden');
      const refused = expectError(
        await put('pm', { allowed_data_classes: ['prohibited'] }),
        422,
        'ai_record_invalid',
      );
      expect(refused.reason).toBe('prohibited_class');
      expect(
        expectError(
          await put('pm', { allowed_data_classes: ['client_confidential'] }),
          422,
          'ai_record_invalid',
        ).reason,
      ).toBe('unconfirmed_confidential');
      expectError(await put('pm', { confirmed_by: 'Mr. Tanaka' }), 400, 'invalid_request');
      expectError(await put('pm', { record_ref: 'Mr. Tanaka' }), 400, 'invalid_request');
    });

    it('PM / BrSE creates, Person A updates; a stale version → 409; drafts are woken', async () => {
      const draft = await f.registry.createIntent(f.scope, {
        projectId: (await f.scope.projects.getBySlug('api'))!.id,
        title: 'Waits for the record',
        createdBy: f.users.a,
        riskTier: 'low',
        dataClass: 'internal',
      });
      woken.length = 0;
      const created = await put('pm');
      expect(created.status, JSON.stringify(created.body)).toBe(200);
      expect(created.body).toMatchObject({
        version: 1,
        consent: 'unknown',
        allowed_data_classes: ['internal', 'client_restricted'],
        record_ref: null,
        updated_by: pm,
      });
      expect(woken).toEqual([{ tenantId: f.target.tenantId, intentId: draft.id }]);

      const updated = await put('a', {
        expected_version: 1,
        allowed_data_classes: ['client_confidential'],
        confirmed_at: '2026-09-24',
        record_ref: REF,
      });
      expect(updated.status, JSON.stringify(updated.body)).toBe(200);
      expect(updated.body).toMatchObject({ version: 2, consent: 'confirmed', record_ref: REF });
      expectError(await put('pm', { expected_version: 1 }), 409, 'ai_record_version_conflict');
      expect((await inject('GET', 'viewer')).body).toMatchObject({ version: 2 });
      expectError(
        await put('pm', { expected_version: 2, confirmed_at: '2026-09-29', record_ref: REF }),
        422,
        'ai_record_invalid',
      );
    });
  });

  describe('AC2: the G1 check at the submit (FR-19)', () => {
    const newIntent = (project: string, dataClass: Intent['data_class']) =>
      f.registry.createIntent(f.scope, {
        projectId: project,
        title: 'An intent',
        createdBy: f.users.a,
        riskTier: 'low',
        dataClass,
      });
    const g1Decisions = async (intent: Intent) =>
      (await f.scope.gateDecisions.listForIntent(intent.id, 'G1')).map((d) => [
        d.decision,
        d.actor_type,
        d.reason_code,
      ]);

    it('no record → the intent stays draft; one fail and one notice, even when woken again', async () => {
      const intent = await newIntent(bare, 'internal');
      expect(await step(intent)).toEqual({ outcome: 'waiting', reason: 'ai_record' });
      expect(await step(intent)).toEqual({ outcome: 'waiting', reason: 'ai_record' });
      expect(await reload(intent)).toMatchObject({ status: 'draft', current_gate: null });
      expect(await g1Decisions(intent)).toEqual([['fail', 'system', 'ai_record_missing']]);
      const notices = await f.scope.intentNotices.listForIntent(intent.id);
      expect(notices.map((n) => [n.kind, n.status, n.gate, n.audience_roles])).toEqual([
        ['ai_record_refused', 'draft', 'G1', ['person_a', 'pm_brse']],
      ]);
    });

    it('a class the record does not allow → data_class_not_allowed; fixing the record submits it', async () => {
      const project = await projectWithoutRecord('classes');
      await save(project, { ...RESTRICTED_ONLY, allowedDataClasses: ['public'] });
      const intent = await newIntent(project, 'internal');
      expect(await step(intent)).toEqual({ outcome: 'waiting', reason: 'ai_record' });
      expect(await g1Decisions(intent)).toEqual([['fail', 'system', 'data_class_not_allowed']]);

      // A new record version is a new cause: one more refusal while it still does not allow it.
      await save(project, {
        ...RESTRICTED_ONLY,
        allowedDataClasses: ['public', 'client_restricted'],
      });
      expect(await step(intent)).toEqual({ outcome: 'waiting', reason: 'ai_record' });
      expect(await g1Decisions(intent)).toHaveLength(2);

      await save(project, RESTRICTED_ONLY);
      expect(await step(intent)).toEqual({ outcome: 'moved' });
      expect(await reload(intent)).toMatchObject({ status: 'in_gate', current_gate: 'G1' });
      // The refusals before the submit never count at G1: Person A still decides.
      // (Session 2 of B07 adds the wake at the gate deadline, `wakeInMs`.)
      expect(await step(intent)).toMatchObject({ outcome: 'waiting', reason: 'decision' });
    });

    it('unknown consent: client data only as client_restricted (Ch.2 Rule 3)', async () => {
      const project = await projectWithoutRecord('consent');
      await save(project, RESTRICTED_ONLY);
      const confidential = await newIntent(project, 'client_confidential');
      expect(await step(confidential)).toEqual({ outcome: 'waiting', reason: 'ai_record' });
      expect(await g1Decisions(confidential)).toEqual([
        ['fail', 'system', 'data_class_not_allowed'],
      ]);
      const restricted = await newIntent(project, 'client_restricted');
      expect(await step(restricted)).toEqual({ outcome: 'moved' });

      // The written answer arrives: client_confidential is allowed from now on.
      await save(project, CONFIRMED, f.users.a);
      expect(await step(confidential)).toEqual({ outcome: 'moved' });
      expect(await reload(confidential)).toMatchObject({ current_gate: 'G1' });
    });

    it('prohibited never enters G1, whatever the record says', async () => {
      const intent = await newIntent(projectId, 'prohibited');
      expect(await step(intent)).toEqual({ outcome: 'waiting', reason: 'ai_record' });
      expect(await g1Decisions(intent)).toEqual([['fail', 'system', 'data_class_not_allowed']]);
    });

    it('the refusal is posted on the issue, mentioning the record writers', async () => {
      const current = (await f.scope.projectAiRecords.get(projectId))!;
      await saveAiRecord(f.scope, projectId, {
        ...RESTRICTED_ONLY,
        allowedDataClasses: ['public'],
        updatedBy: pm,
        expectedVersion: current.version,
        actorType: 'human',
      });
      const intent = await f.newIntent();
      expect(await step(intent)).toEqual({ outcome: 'waiting', reason: 'ai_record' });
      await f.poll();
      const [body] = f.posted(intent);
      expect(body).toContain(`**${intent.code}** cannot enter **G1**`);
      expect(body).toContain('`data_class_not_allowed`');
      expect(body).toContain('@alice');
      expect(body).not.toMatch(/\{[a-z_]+\}/);
      // Restore the fixture's record for any later test.
      await saveAiRecord(f.scope, projectId, {
        ...RESTRICTED_ONLY,
        updatedBy: pm,
        expectedVersion: current.version + 1,
        actorType: 'human',
      });
    });
  });
});
