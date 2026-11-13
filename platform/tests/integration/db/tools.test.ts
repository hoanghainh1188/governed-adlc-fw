// D-08 X04 AC1 on a live PostgreSQL (design/ADR-M69 §2.2–§2.3, D-05 §6.1): the `tools` table and its
// trigger, the append-only `tool_approvals`, plans that list register tools, and the check G4 runs
// before each run (`checkToolsForRun`): the refusals in order and the grants of the Run Contract.
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { toolCallRulesJson } from '../../../packages/contracts/src/tools.js';
import { parseTenantId } from '../../../packages/core/src/db/tenant-id.js';
import type { TenantScope } from '../../../packages/core/src/db/tenant-scope.js';
import {
  callRulesSha256,
  checkToolsForRun,
  type ToolRunCheck,
} from '../../../packages/core/src/tools/check.js';
import { ToolRegisterError } from '../../../packages/core/src/tools/errors.js';
import { toolsForFingerprint } from '../../../packages/core/src/tools/fingerprint.js';
import {
  changeToolStatus,
  recertifyTool,
  registerTool,
  updateTool,
  type RegisterTool,
} from '../../../packages/core/src/tools/register.js';
import { createTestDatabase, describeDb, type TestDatabase } from './helpers.js';

const DIGEST = `sha256:${'d'.repeat(64)}`;
const NOW = new Date('2026-10-22T08:00:00.000Z');

describeDb('X04: the tool register on PostgreSQL', () => {
  let t0: TestDatabase;
  let scope: TenantScope;
  let owner: string;

  beforeAll(async () => {
    t0 = await createTestDatabase();
    const tenant = await t0.app.system.createTenant({ slug: 'acme', name: 'Acme' });
    scope = t0.app.forTenant(parseTenantId(tenant.id));
    owner = (await scope.users.create({ display_name: 'o', email: 'o@example.com' })).id;
  }, 60_000);
  afterAll(async () => {
    await t0?.drop();
  });

  const base = (key: string, extra: Partial<RegisterTool> = {}): RegisterTool => ({
    toolKey: key,
    version: '1.0.0',
    ownerId: owner,
    transport: 'http',
    imageRef: 'ghcr.io/example/project-docs',
    imageDigest: DIGEST,
    permissions: ['read_documents'],
    allowedDataClasses: ['internal', 'client_confidential'],
    backingServices: ['knowledge-db:5432'],
    now: NOW,
    ...extra,
  });

  async function active(key: string, extra: Partial<RegisterTool> = {}) {
    await registerTool(scope, base(key, extra));
    return changeToolStatus(scope, key, { to: 'active', now: NOW });
  }

  async function codeOf(work: Promise<unknown>): Promise<string> {
    try {
      await work;
    } catch (error) {
      if (error instanceof ToolRegisterError) return error.code;
      const code = (error as { code?: unknown }).code;
      return typeof code === 'string' ? code : String(error);
    }
    return 'resolved';
  }

  describe('the table and its trigger (D-05 §6.1)', () => {
    it('an active tool is certified on its first activation', async () => {
      const tool = await active('t-active');
      expect(tool).toMatchObject({ status: 'active', last_recertified_at: '2026-10-22' });
      expect(tool.allowed_data_classes).toEqual(['client_confidential', 'internal']);
    });

    it('refuses a configuration change of an active tool, also straight in SQL (SDA25)', async () => {
      await active('t-frozen');
      expect(
        await codeOf(updateTool(scope, 't-frozen', { version: '2.0.0', imageDigest: DIGEST })),
      ).toBe('config_change_not_allowed');
      const update = sql`UPDATE tools SET image_digest = ${`sha256:${'e'.repeat(64)}`},
        version = '2.0.0' WHERE tool_key = 't-frozen' AND tenant_id = ${scope.tenantId}`;
      await expect(update.execute(t0.appRaw)).rejects.toMatchObject({ code: 'SDA25' });
    });

    it('refuses what the CHECKs refuse: prohibited data, stdio with an image, active without a digest', async () => {
      const insert = (values: string) =>
        sql
          .raw(
            `INSERT INTO tools (tenant_id, tool_key, version, owner_id, transport, image_ref,
               image_digest, permissions, allowed_data_classes, status, last_recertified_at)
             VALUES ('${scope.tenantId}', 'raw-x', '1', '${owner}', ${values})`,
          )
          .execute(t0.owner);
      await expect(
        insert(`'http', 'img', NULL, '{read_documents}', '{prohibited}', 'proposed', NULL`),
      ).rejects.toThrow();
      await expect(
        insert(`'stdio', 'img', NULL, '{read_documents}', '{internal}', 'proposed', NULL`),
      ).rejects.toThrow();
      await expect(
        insert(`'http', 'img', NULL, '{read_documents}', '{internal}', 'active', '2026-10-22'`),
      ).rejects.toThrow();
      await expect(
        insert(`'http', 'img', NULL, '{write_documents}', '{internal}', 'proposed', NULL`),
      ).rejects.toThrow();
      // X06 (migration 0052): `read_code` is in the catalogue, never with `read_documents`.
      await expect(
        insert(`'http', 'img', NULL, '{read_code,read_documents}', '{internal}', 'proposed', NULL`),
      ).rejects.toThrow();
      await insert(`'http', 'img', NULL, '{read_code}', '{internal}', 'proposed', NULL`);
    });

    it('X06: registers a read_code tool without a model, and refuses both index permissions', async () => {
      const tool = await registerTool(scope, { ...base('t-code'), permissions: ['read_code'] });
      expect(tool.permissions).toEqual(['read_code']);
      await expect(
        registerTool(scope, { ...base('t-both'), permissions: ['read_code', 'read_documents'] }),
      ).rejects.toThrow();
    });

    it('refuses a backing service port above 65535 in SQL too, and takes 65535', async () => {
      const tool = await registerTool(scope, base('t-port'));
      const set = (service: string, version: string) =>
        sql`UPDATE tools SET backing_services = ARRAY[${service}]::text[], version = ${version}
            WHERE id = ${tool.id}`.execute(t0.appRaw);
      await expect(set('db:70000', '1.0.1')).rejects.toThrow(/check constraint/);
      await expect(set('db:65535', '1.0.2')).resolves.toBeDefined();
    });

    it('tool_approvals is append-only', async () => {
      const tool = await scope.tools.getByKey('t-active');
      await scope.toolApprovals.record({
        tool_id: tool!.id,
        tool_version: tool!.version,
        purpose: 'activate',
        capacity: 'owner',
        approver_id: owner,
        round_at: tool!.updated_at,
      });
      await expect(
        sql`UPDATE tool_approvals SET capacity = 'person_b'`.execute(t0.appRaw),
      ).rejects.toThrow();
      await expect(sql`DELETE FROM tool_approvals`.execute(t0.appRaw)).rejects.toThrow();
    });

    it('recertification dates never go back', async () => {
      await active('t-recert');
      expect(await codeOf(recertifyTool(scope, 't-recert', { day: '2026-10-01', now: NOW }))).toBe(
        'recertification_date_invalid',
      );
    });
  });

  describe('plans list register tools (ADR-M69 §2.1)', () => {
    it('plans.allowed_tools accepts tool:<key> next to the built-in tools, nothing else', async () => {
      const def = await sql<{ def: string }>`
        SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'plans_allowed_tools_check'`.execute(t0.owner);
      expect(def.rows[0]?.def).toContain('tool:[a-z][a-z0-9-]{1,62}');
      expect(def.rows[0]?.def).toContain('file_editor');
    });
  });

  describe('checkToolsForRun (ADR-M69 §2.3)', () => {
    const input = (extra: Partial<ToolRunCheck> = {}): ToolRunCheck => ({
      planTools: ['file_editor', 'tool:g4-docs'],
      agentTools: ['file_editor', 'tool:g4-docs'],
      adapter: 'openhands',
      transports: ['http'],
      dataClass: 'internal',
      allowedModels: ['bge-m3-1'],
      maxCallsPerRun: 100,
      recertificationMonths: 3,
      now: NOW,
      ...extra,
    });

    it('gives one grant per register tool, with the call rules hash and the cap', async () => {
      await active('g4-docs', { modelRef: 'bge-m3-1' });
      const checked = await checkToolsForRun(scope, input());
      expect(checked.grants).toEqual([
        {
          tool_key: 'g4-docs',
          tool_version: '1.0.0',
          transport: 'http',
          image_digest: DIGEST,
          permissions: ['read_documents'],
          call_rules_sha256: callRulesSha256(['read_documents']),
          backing_services: ['knowledge-db:5432'],
          max_calls: 100,
        },
      ]);
      expect(callRulesSha256(['read_documents'])).toMatch(/^[0-9a-f]{64}$/);
      expect(toolCallRulesJson(['read_documents'])).toContain('search_project_docs');
      expect(checked.overdue).toEqual([]);
      expect((await checkToolsForRun(scope, input({ planTools: ['file_editor'] }))).grants).toEqual(
        [],
      );
    });

    it.each<[string, () => ToolRunCheck]>([
      ['tool_not_found', () => input({ planTools: ['tool:nothing-here'] })],
      ['tool_not_allowed_for_agent', () => input({ agentTools: ['file_editor'] })],
      ['tool_data_class_not_allowed', () => input({ dataClass: 'client_restricted' })],
      ['tool_data_class_not_allowed', () => input({ allowedModels: ['another-model-1'] })],
      ['tool_transport_not_supported', () => input({ transports: [] })],
      // X04 PR 2: OpenHands gives a run http tools; OpenCode none yet.
      [
        'tool_transport_not_supported',
        () => ({ ...input(), adapter: 'opencode' as const, transports: undefined }),
      ],
    ])('refuses %s', async (code, make) => {
      expect(await codeOf(checkToolsForRun(scope, make()))).toBe(code);
    });

    it('refuses a tool that is not active', async () => {
      await registerTool(scope, base('g4-proposed'));
      expect(
        await codeOf(
          checkToolsForRun(
            scope,
            input({ planTools: ['tool:g4-proposed'], agentTools: ['tool:g4-proposed'] }),
          ),
        ),
      ).toBe('tool_not_active');
    });

    it('warns, never refuses, when the recertification is overdue', async () => {
      const later = new Date('2027-03-01T00:00:00.000Z');
      const checked = await checkToolsForRun(scope, input({ now: later }));
      expect(checked.overdue.map((o) => o.key)).toEqual(['g4-docs']);
    });

    it('the evaluation fingerprint names each register tool by version and digest', async () => {
      expect(await toolsForFingerprint(scope, ['file_editor', 'tool:g4-docs'])).toEqual([
        'file_editor',
        `tool:g4-docs@1.0.0@${DIGEST}`,
      ]);
      expect(await toolsForFingerprint(scope, ['file_editor', 'terminal'])).toEqual([
        'file_editor',
        'terminal',
      ]);
    });
  });
});
