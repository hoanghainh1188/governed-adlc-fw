// D-08 C10 on a live PostgreSQL (handbook Ch.20, design/ADR-M31).
// AC1: the `agents` table, the lifecycle (register, activate, suspend, quarantine, retire), every
//      change audited with keys, codes and hashes only; the operator CLI `adlc admin agent …`.
// AC2: runs refer to a registered agent (runs.test.ts covers the foreign key); the check before a
//      run refuses agents that are not active.
// AC3: the instructions hash is stored and checked before each run.
// AC4: an overdue recertification is a warning (months from project configuration), not a block.
import crypto from 'node:crypto';

import { loadProjectConfig } from '@sdlc/config';
import { t } from '@sdlc/messages';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EXIT, processContext, runCli, type CliContext } from '../../../apps/cli/src/index.js';
import {
  AgentRegisterError,
  changeAgentOwner,
  changeAgentStatus,
  checkAgentForRun,
  instructionsPath,
  instructionsSha256,
  recertifyAgent,
  registerAgent,
  updateAgent,
  type AgentRunCheck,
  type RegisterAgent,
} from '../../../packages/core/src/agents/index.js';
import { parseTenantId } from '../../../packages/core/src/db/tenant-id.js';
import type { TenantScope } from '../../../packages/core/src/db/tenant-scope.js';
import { LATER_WALL_CLOCK, withWallClock } from '../wall-clock.js';
import { createTestDatabase, describeDb, urlFor, type TestDatabase } from './helpers.js';

const SHA = (c: string) => c.repeat(64);
const MODEL = 'claude-haiku-4-5-20251001';
const NOW = new Date('2026-09-27T08:00:00.000Z');

interface Seeded {
  readonly slug: string;
  readonly scope: TenantScope;
  readonly projectId: string;
  readonly owner: string;
  readonly other: string;
  readonly disabled: string;
}

describeDb('C10: the agent register on PostgreSQL', () => {
  let t0: TestDatabase;
  let count = 0;

  beforeAll(async () => {
    t0 = await createTestDatabase();
  }, 60_000);
  afterAll(async () => {
    await t0?.drop();
  });

  async function seed(configYaml?: string): Promise<Seeded> {
    const slug = `tenant-${String(++count)}`;
    const tenant = await t0.app.system.createTenant({ slug, name: slug });
    const scope = t0.app.forTenant(parseTenantId(tenant.id));
    const project = await scope.projects.create({
      slug: 'shop',
      name: 'Shop',
      git_provider: 'github',
      repo_full_name: 'org/pilot-order-inventory',
    });
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
    const owner = (await scope.users.create({ display_name: 'a', email: 'owner@example.com' })).id;
    const other = (await scope.users.create({ display_name: 'b', email: 'other@example.com' })).id;
    const disabled = (
      await scope.users.create({ display_name: 'c', email: 'gone@example.com', status: 'disabled' })
    ).id;
    return { slug, scope, projectId: project.id, owner, other, disabled };
  }

  const base = (s: Seeded, extra: Partial<RegisterAgent> = {}): RegisterAgent => ({
    agentKey: 'coder-openhands',
    version: '1.0.0',
    ownerId: s.owner,
    modelRef: MODEL,
    instructionsRef: 'AGENTS.md@v5',
    instructionsSha256: SHA('c'),
    allowedTools: ['terminal', 'file_editor'],
    maxAutonomy: 'L2',
    approvedEnvironments: ['sandbox'],
    now: NOW,
    ...extra,
  });

  async function codeOf(work: Promise<unknown>): Promise<string> {
    try {
      await work;
    } catch (error) {
      if (error instanceof AgentRegisterError) return error.code;
      const code = (error as { code?: unknown }).code;
      return typeof code === 'string' ? code : String(error);
    }
    return 'resolved';
  }

  async function auditOf(s: Seeded) {
    return (
      await sql<{ action: string; payload: Record<string, unknown>; actor_type: string }>`
        SELECT action, payload, actor_type FROM audit_log
        WHERE tenant_id = ${s.scope.tenantId} AND action LIKE 'agent.%' ORDER BY seq`.execute(
        t0.owner,
      )
    ).rows;
  }

  async function active(s: Seeded, extra: Partial<RegisterAgent> = {}) {
    const agent = await registerAgent(s.scope, base(s, extra));
    return changeAgentStatus(s.scope, agent.agent_key, { to: 'active', now: NOW });
  }

  describe('AC1: register and lifecycle', () => {
    it('registers a proposed agent, sorted tools, and audits it with keys and hashes only', async () => {
      const s = await seed();
      const agent = await registerAgent(s.scope, base(s));
      expect(agent).toMatchObject({
        agent_key: 'coder-openhands',
        status: 'proposed',
        model_ref: MODEL,
        allowed_tools: ['file_editor', 'terminal'],
        approved_environments: ['sandbox'],
        last_recertified_at: null,
        adapter: 'openhands',
      });
      expect(await auditOf(s)).toEqual([
        {
          action: 'agent.registered',
          actor_type: 'system',
          payload: {
            agent_key: 'coder-openhands',
            version: '1.0.0',
            instructions_sha256: SHA('c'),
            adapter: 'openhands',
          },
        },
      ]);
    });

    // X03 (ADR-M68 §7, QUESTIONS #526): every agent names its adapter; OpenHands by default.
    it('registers an agent with another adapter and refuses an unknown one', async () => {
      const s = await seed();
      const agent = await registerAgent(
        s.scope,
        base(s, { agentKey: 'coder-oc', adapter: 'opencode' }),
      );
      expect(agent.adapter).toBe('opencode');
      expect((await auditOf(s)).at(-1)?.payload).toMatchObject({ adapter: 'opencode' });
      expect(
        await codeOf(registerAgent(s.scope, base(s, { agentKey: 'coder-x', adapter: 'aider' }))),
      ).toBe('invalid_input');
    });

    it('another adapter is a new version, only while proposed or suspended', async () => {
      const s = await seed();
      await active(s);
      const key = 'coder-openhands';
      expect(
        await codeOf(updateAgent(s.scope, key, { version: '1.1.0', adapter: 'opencode' })),
      ).toBe('config_change_not_allowed');
      await changeAgentStatus(s.scope, key, { to: 'suspended', reason: 'quality' });
      expect(
        await codeOf(updateAgent(s.scope, key, { version: '1.0.0', adapter: 'opencode' })),
      ).toBe('version_unchanged');
      const updated = await updateAgent(s.scope, key, { version: '2.0.0', adapter: 'opencode' });
      expect(updated).toMatchObject({ version: '2.0.0', adapter: 'opencode' });
      expect((await auditOf(s)).at(-1)).toMatchObject({
        action: 'agent.updated',
        payload: { agent_key: key, version: '2.0.0', adapter: 'opencode' },
      });
    });

    it('refuses a taken key, also of a retired agent (the identity is never reused)', async () => {
      const s = await seed();
      await registerAgent(s.scope, base(s));
      expect(await codeOf(registerAgent(s.scope, base(s)))).toBe('agent_exists');
      await changeAgentStatus(s.scope, 'coder-openhands', { to: 'retired', reason: 'replaced' });
      expect(await codeOf(registerAgent(s.scope, base(s)))).toBe('agent_exists');
    });

    it('refuses an inactive owner, bad formats and autonomy above L2', async () => {
      const s = await seed();
      expect(await codeOf(registerAgent(s.scope, base(s, { ownerId: s.disabled })))).toBe(
        'owner_not_active',
      );
      for (const extra of [
        { agentKey: 'Coder' },
        { modelRef: 'claude-haiku' },
        { instructionsRef: '../AGENTS.md@v1' },
        { instructionsSha256: 'abc' },
        { maxAutonomy: 'L3' },
        { approvedEnvironments: ['laptop'] },
      ]) {
        expect(await codeOf(registerAgent(s.scope, base(s, extra))), JSON.stringify(extra)).toBe(
          'invalid_input',
        );
      }
    });

    it('activation needs a pinned model, and certifies the agent on first activation', async () => {
      const s = await seed();
      await registerAgent(s.scope, base(s, { modelRef: null }));
      expect(
        await codeOf(changeAgentStatus(s.scope, 'coder-openhands', { to: 'active', now: NOW })),
      ).toBe('model_not_pinned');
      await updateAgent(s.scope, 'coder-openhands', { version: '1.0.1', modelRef: MODEL });
      const activeAgent = await changeAgentStatus(s.scope, 'coder-openhands', {
        to: 'active',
        now: NOW,
      });
      expect(activeAgent).toMatchObject({ status: 'active', last_recertified_at: '2026-09-27' });
      expect((await auditOf(s)).map((e) => e.action)).toEqual([
        'agent.registered',
        'agent.updated',
        'agent.status_changed',
        'agent.recertified',
      ]);
    });

    it('follows handbook Ch.20: quarantine → suspended → active; retired is final', async () => {
      const s = await seed();
      await active(s);
      const key = 'coder-openhands';
      expect(await codeOf(changeAgentStatus(s.scope, key, { to: 'quarantined' }))).toBe(
        'reason_required',
      );
      expect(
        await codeOf(changeAgentStatus(s.scope, key, { to: 'suspended', reason: 'bad' })),
      ).toBe('invalid_input');
      await changeAgentStatus(s.scope, key, { to: 'quarantined', reason: 'security' });
      expect(await codeOf(changeAgentStatus(s.scope, key, { to: 'active' }))).toBe(
        'status_move_not_allowed',
      );
      await changeAgentStatus(s.scope, key, { to: 'suspended', reason: 'security' });
      await changeAgentStatus(s.scope, key, { to: 'active' });
      await changeAgentStatus(s.scope, key, { to: 'retired', reason: 'replaced' });
      expect(await codeOf(changeAgentStatus(s.scope, key, { to: 'active' }))).toBe('agent_retired');
      expect(await codeOf(recertifyAgent(s.scope, key))).toBe('agent_retired');
      const moves = (await auditOf(s))
        .filter((e) => e.action === 'agent.status_changed')
        .map((e) => e.payload);
      expect(moves).toEqual([
        { agent_key: key, from: 'proposed', to: 'active' },
        { agent_key: key, from: 'active', to: 'quarantined', reason_code: 'security' },
        { agent_key: key, from: 'quarantined', to: 'suspended', reason_code: 'security' },
        { agent_key: key, from: 'suspended', to: 'active' },
        { agent_key: key, from: 'active', to: 'retired', reason_code: 'replaced' },
      ]);
    });

    it('changes the configuration only while proposed or suspended, with a new version', async () => {
      const s = await seed();
      await active(s);
      const key = 'coder-openhands';
      expect(
        await codeOf(updateAgent(s.scope, key, { version: '1.1.0', modelRef: 'gpt-oss-20b' })),
      ).toBe('config_change_not_allowed');
      await changeAgentStatus(s.scope, key, { to: 'suspended', reason: 'quality' });
      expect(await codeOf(updateAgent(s.scope, key, { version: '1.0.0', allowedTools: [] }))).toBe(
        'version_unchanged',
      );
      const updated = await updateAgent(s.scope, key, {
        version: '1.1.0',
        modelRef: 'gpt-oss-20b',
        instructionsSha256: SHA('d'),
      });
      expect(updated).toMatchObject({
        version: '1.1.0',
        model_ref: 'gpt-oss-20b',
        instructions_sha256: SHA('d'),
        allowed_tools: ['file_editor', 'terminal'],
        status: 'suspended',
      });
      expect((await auditOf(s)).at(-1)).toMatchObject({
        action: 'agent.updated',
        payload: {
          agent_key: key,
          version: '1.1.0',
          instructions_sha256: SHA('d'),
          adapter: 'openhands',
        },
      });
    });

    it('changes the owner in any status but retired, audited without the owner', async () => {
      const s = await seed();
      await active(s);
      expect(await codeOf(changeAgentOwner(s.scope, 'coder-openhands', s.disabled))).toBe(
        'owner_not_active',
      );
      const changed = await changeAgentOwner(s.scope, 'coder-openhands', s.other);
      expect(changed.owner_id).toBe(s.other);
      expect((await auditOf(s)).at(-1)).toEqual({
        action: 'agent.owner_changed',
        actor_type: 'system',
        payload: { agent_key: 'coder-openhands' },
      });
    });

    it('recertifies on a past or present day, never before the last one', async () => {
      const s = await seed();
      await active(s);
      const key = 'coder-openhands';
      expect(await codeOf(recertifyAgent(s.scope, key, { day: '2026-09-28', now: NOW }))).toBe(
        'recertification_date_invalid',
      );
      expect(await codeOf(recertifyAgent(s.scope, key, { day: '2026-09-01', now: NOW }))).toBe(
        'recertification_date_invalid',
      );
      const later = new Date('2026-12-01T00:00:00.000Z');
      expect((await recertifyAgent(s.scope, key, { now: later })).last_recertified_at).toBe(
        '2026-12-01',
      );
    });

    it('the database enforces the rules too (trigger SDA09, grants)', async () => {
      const s = await seed();
      const agent = await active(s);
      const where = sql`WHERE tenant_id = ${s.scope.tenantId} AND id = ${agent.id}`;
      const run = (statement: ReturnType<typeof sql>) => codeOf(statement.execute(t0.appRaw));
      expect(await run(sql`UPDATE agents SET status = 'proposed' ${where}`)).toBe('SDA09');
      expect(
        await run(sql`UPDATE agents SET model_ref = 'gpt-oss-20b', version = '9' ${where}`),
      ).toBe('SDA09');
      expect(await run(sql`UPDATE agents SET last_recertified_at = '2020-01-01' ${where}`)).toBe(
        'SDA09',
      );
      expect(await run(sql`UPDATE agents SET agent_key = 'other' ${where}`)).toBe('42501');
      expect(await run(sql`DELETE FROM agents ${where}`)).toBe('42501');
      await sql`UPDATE agents SET status = 'suspended' ${where}`.execute(t0.appRaw);
      expect(await run(sql`UPDATE agents SET model_ref = 'gpt-oss-20b' ${where}`)).toBe('SDA09');
      // X03: the adapter is configuration too (migration 0037), and only a known code.
      expect(await run(sql`UPDATE agents SET adapter = 'opencode' ${where}`)).toBe('SDA09');
      expect(await run(sql`UPDATE agents SET adapter = 'aider', version = '3' ${where}`)).toBe(
        '23514',
      );
      expect(await run(sql`UPDATE agents SET status = 'active', version = '2' ${where}`)).toBe(
        'SDA09',
      );
      await sql`UPDATE agents SET status = 'retired' ${where}`.execute(t0.appRaw);
      expect(await run(sql`UPDATE agents SET owner_id = ${s.other} ${where}`)).toBe('SDA09');
      // An active agent without a pinned model cannot exist.
      expect(
        await run(sql`INSERT INTO agents (tenant_id, agent_key, version, status, owner_id,
            instructions_ref, instructions_sha256, max_autonomy)
          VALUES (${s.scope.tenantId}, 'raw', '1', 'active', ${s.owner}, 'AGENTS.md@v1',
            ${SHA('c')}, 'L2')`),
      ).toBe('23514');
      // The same formats as the core rules: a model name with its version, a clean path.
      const insert = (key: string, model: string, instructions: string) =>
        run(sql`INSERT INTO agents (tenant_id, agent_key, version, owner_id, model_ref,
            instructions_ref, instructions_sha256, max_autonomy)
          VALUES (${s.scope.tenantId}, ${key}, '1', ${s.owner}, ${model}, ${instructions},
            ${SHA('c')}, 'L2')`);
      expect(await insert('raw-a', 'claude-haiku', 'AGENTS.md@v1')).toBe('23514');
      expect(await insert('raw-b', 'claude-latest-4', 'AGENTS.md@v1')).toBe('23514');
      for (const [key, ref] of [
        ['raw-c', 'docs/../AGENTS.md@v1'],
        ['raw-d', 'docs/./AGENTS.md@v1'],
        ['raw-e', 'docs//AGENTS.md@v1'],
      ] as const) {
        expect(await insert(key, MODEL, ref), ref).toBe('23514');
      }
      expect(await insert('raw-ok', MODEL, 'docs/agents/coder.md@v1')).toBe('resolved');
    });

    it('two registrations of the same key at once: one wins, the other gets agent_exists', async () => {
      const s = await seed();
      const results = await Promise.allSettled([
        registerAgent(s.scope, base(s)),
        registerAgent(s.scope, base(s)),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((r) => r.status === 'rejected');
      expect((rejected?.reason as AgentRegisterError).code).toBe('agent_exists');
    });

    it('a tenant never sees another tenant’s agents', async () => {
      const a = await seed();
      const b = await seed();
      const agent = await registerAgent(a.scope, base(a));
      expect(await b.scope.agents.getById(agent.id)).toBeUndefined();
      expect(await b.scope.agents.getByKey('coder-openhands')).toBeUndefined();
      expect(await b.scope.agents.list()).toEqual([]);
      // Owner from another tenant: the composite foreign key refuses it (D-05 D2).
      expect(await codeOf(registerAgent(b.scope, base(b, { ownerId: a.owner })))).toBe(
        'owner_not_active',
      );
    });
  });

  describe('AC2–AC4: the check before a run', () => {
    const check = (s: Seeded, agentId: string, extra: Partial<AgentRunCheck> = {}) =>
      checkAgentForRun(s.scope, {
        agentId,
        projectId: s.projectId,
        autonomyLevel: 'L2',
        allowedModels: ['gpt-oss-20b', MODEL],
        instructionsSha256: SHA('c'),
        now: NOW,
        ...extra,
      });

    it('returns what the Run Contract and the adapter need', async () => {
      const s = await seed();
      const agent = await active(s);
      const checked = await check(s, agent.id);
      expect(checked).toEqual({
        agent: {
          id: agent.id,
          key: 'coder-openhands',
          version: '1.0.0',
          instructionsSha256: SHA('c'),
          rootInstructionsSha256: null,
          tools: ['file_editor', 'terminal'],
          adapter: 'openhands',
          modelRef: MODEL,
          ownerId: s.owner,
        },
        warnings: [],
        recertificationDueOn: '2026-12-27',
      });
      expect(instructionsPath(agent)).toBe('AGENTS.md');
    });

    it('AC2: refuses an unknown agent, another tenant’s agent and every status but active', async () => {
      const s = await seed();
      const other = await seed();
      expect(await codeOf(check(s, crypto.randomUUID()))).toBe('agent_not_found');
      const foreign = await active(other);
      expect(await codeOf(check(s, foreign.id))).toBe('agent_not_found');
      const proposed = await registerAgent(s.scope, base(s, { agentKey: 'coder-proposed' }));
      expect(await codeOf(check(s, proposed.id))).toBe('agent_not_active');
      for (const [key, to, reason] of [
        ['coder-suspended', 'suspended', 'quality'],
        ['coder-quarantined', 'quarantined', 'security'],
        ['coder-retired', 'retired', 'unused'],
      ] as const) {
        const agent = await active(s, { agentKey: key });
        await changeAgentStatus(s.scope, key, { to, reason });
        expect(await codeOf(check(s, agent.id)), to).toBe('agent_not_active');
      }
    });

    it('refuses autonomy above the agent, a missing sandbox approval and a model not allowed', async () => {
      const s = await seed();
      const l1 = await active(s, { agentKey: 'coder-l1', maxAutonomy: 'L1' });
      expect(await codeOf(check(s, l1.id))).toBe('autonomy_above_agent');
      expect((await check(s, l1.id, { autonomyLevel: 'L1' })).agent.id).toBe(l1.id);
      const staging = await active(s, {
        agentKey: 'coder-staging',
        approvedEnvironments: ['staging'],
      });
      expect(await codeOf(check(s, staging.id))).toBe('environment_not_approved');
      const agent = await active(s);
      expect(await codeOf(check(s, agent.id, { allowedModels: ['gpt-oss-20b'] }))).toBe(
        'model_not_allowed',
      );
    });

    it('AC3: refuses instructions that differ until the agent gets a new version', async () => {
      const s = await seed();
      const agent = await active(s);
      const edited = instructionsSha256('# AGENTS\nEdited in the repository.\n');
      expect(await codeOf(check(s, agent.id, { instructionsSha256: edited }))).toBe(
        'instructions_mismatch',
      );
      await changeAgentStatus(s.scope, agent.agent_key, { to: 'suspended', reason: 'other' });
      await updateAgent(s.scope, agent.agent_key, {
        version: '1.0.1',
        instructionsRef: 'AGENTS.md@v6',
        instructionsSha256: edited,
      });
      await changeAgentStatus(s.scope, agent.agent_key, { to: 'active' });
      expect(await codeOf(check(s, agent.id))).toBe('instructions_mismatch');
      expect((await check(s, agent.id, { instructionsSha256: edited })).agent.version).toBe(
        '1.0.1',
      );
    });

    it('AC4: warns, never blocks, when the recertification is older than the configured months', async () => {
      const s = await seed();
      const agent = await active(s);
      const dueDay = new Date('2026-12-27T12:00:00.000Z');
      expect((await check(s, agent.id, { now: dueDay })).warnings).toEqual([]);
      const dayAfter = new Date('2026-12-28T00:00:00.000Z');
      expect(await check(s, agent.id, { now: dayAfter })).toMatchObject({
        warnings: ['recertification_overdue'],
        recertificationDueOn: '2026-12-27',
      });
      await recertifyAgent(s.scope, agent.agent_key, { now: dayAfter });
      expect((await check(s, agent.id, { now: dayAfter })).warnings).toEqual([]);
    });

    it('AC4: the months come from the project configuration', async () => {
      const s = await seed('agents:\n  recertification_months: 1\n');
      const agent = await active(s);
      const later = new Date('2026-10-28T00:00:00.000Z');
      expect(await check(s, agent.id, { now: later })).toMatchObject({
        warnings: ['recertification_overdue'],
        recertificationDueOn: '2026-10-27',
      });
    });
  });

  describe('AC1: adlc ops agent (operator CLI)', () => {
    async function cli(argv: string[]) {
      const out: string[] = [];
      const err: string[] = [];
      const ctx: CliContext = {
        env: { SDLC_DB_URL: urlFor(t0.name, 'platform_app') },
        stdout: (line) => out.push(line),
        stderr: (line) => err.push(line),
        connect: processContext().connect,
      };
      const code = await runCli(argv, ctx);
      return { code, out: out.join('\n'), err: err.join('\n') };
    }

    // B13 (QUESTIONS #153, ADR-M37 §2.8): registering and activating go through the API; the
    // operator keeps show, list, suspend and quarantine (`adlc ops agent …`).
    // The CLI rightly reads the real clock for `overdue`: the agent is activated on the real day,
    // so the test passes whatever the date (with NOW it broke 3 months after 2026-09-27).
    it.each([
      ['the real date', null],
      ['2027-06-01', LATER_WALL_CLOCK],
    ] as const)('lists, shows and suspends on the server, wall clock %s', async (_, wallClock) =>
      withWallClock(wallClock, async () => {
        const s = await seed();
        const agent = await registerAgent(s.scope, base(s));
        await changeAgentStatus(s.scope, agent.agent_key, { to: 'active', now: new Date() });

        const listed = await cli(['ops', 'agent', 'list', '--tenant', s.slug, '--json']);
        const [row] = JSON.parse(listed.out) as Record<string, unknown>[];
        expect(row).toMatchObject({ key: 'coder-openhands', status: 'active', overdue: false });
        expect((await cli(['ops', 'agent', 'list', '--tenant', s.slug, '--overdue'])).out).toBe(
          t('cli.admin.agent.none'),
        );

        const shown = await cli([
          'ops',
          'agent',
          'show',
          '--tenant',
          s.slug,
          '--key',
          'coder-openhands',
        ]);
        expect(shown.code).toBe(EXIT.ok);
        expect(shown.out).toContain(MODEL);
        expect(shown.out).not.toMatch(/\{[a-z_]+\}/);

        const noReason = await cli([
          'ops',
          'agent',
          'suspend',
          '--tenant',
          s.slug,
          '--key',
          'coder-openhands',
        ]);
        expect(noReason).toMatchObject({ code: EXIT.usage, err: t('cli.admin.agent.usage') });
        const suspended = await cli([
          'ops',
          'agent',
          'suspend',
          '--tenant',
          s.slug,
          '--key',
          'coder-openhands',
          '--reason',
          'incident',
        ]);
        expect(suspended.code).toBe(EXIT.ok);
        expect((await s.scope.agents.getByKey('coder-openhands'))?.status).toBe('suspended');
      }),
    );

    it('renders refusals from the catalog and lists overdue agents', async () => {
      const s = await seed();
      const refused = await cli([
        'ops',
        'agent',
        'suspend',
        '--tenant',
        s.slug,
        '--key',
        'nobody',
        '--reason',
        'incident',
      ]);
      expect(refused).toMatchObject({
        code: EXIT.failed,
        err: t('agent_register.error.agent_not_found', { key: 'nobody', field: '-' }),
      });
      // Certified on its first activation in January: overdue by the real clock since April.
      const agent = await registerAgent(s.scope, base(s));
      await changeAgentStatus(s.scope, agent.agent_key, {
        to: 'active',
        now: new Date('2026-01-05T00:00:00.000Z'),
      });
      const overdue = await cli(['ops', 'agent', 'list', '--tenant', s.slug, '--overdue']);
      expect(overdue.out).toContain('coder-openhands');
      expect(overdue.out).toContain(t('cli.admin.agent.overdue_flag'));
      const [row] = JSON.parse(
        (await cli(['ops', 'agent', 'list', '--tenant', s.slug, '--json'])).out,
      ) as Record<string, unknown>[];
      expect(row).toMatchObject({
        overdue: true,
        last_recertified_at: '2026-01-05',
        recertification_due_on: '2026-04-05',
      });
      const unknownProject = await cli([
        'ops',
        'agent',
        'list',
        '--tenant',
        s.slug,
        '--project',
        'nope',
      ]);
      expect(unknownProject).toMatchObject({
        code: EXIT.usage,
        err: t('cli.admin.agent.project_not_found', { slug: 'nope' }),
      });
    });

    it('keeps the audit chain intact (adlc ops audit verify)', async () => {
      const s = await seed();
      await active(s);
      await changeAgentStatus(s.scope, 'coder-openhands', { to: 'retired', reason: 'unused' });
      const verified = await cli(['ops', 'audit', 'verify', '--tenant', s.slug]);
      expect(verified.code, verified.err).toBe(EXIT.ok);
      // No e-mail address or model name in any agent audit payload.
      for (const event of await auditOf(s)) {
        expect(JSON.stringify(event.payload)).not.toMatch(/@|claude|gpt/);
      }
    });
  });
});
