// D-08 C02 on a live PostgreSQL. AC1: a contract per D-03 section 8, signed through the OpenBao
// Transit client (@sdlc/secrets against the in-process OpenBao stub; the live OpenBao check is in
// tests/integration/openbao/run-contract-signing.test.ts) and stored with its run in one
// transaction. AC2: the runner refuses expired, badly signed, unknown and changed contracts, and
// accepts contracts signed with an older key version. AC3: run_events is append-only and holds
// coded payloads only. Also: final run statuses never change (ADR-M22).
import crypto from 'node:crypto';
import fs from 'node:fs';

import { createSimplePolicyEngine } from '@sdlc/adapter-policy-simple';
import { loadProjectConfig } from '@sdlc/config';
import type { RunContract, RunContractVerifier } from '@sdlc/contracts';
import { OpenBaoClient, type TransitKey } from '@sdlc/secrets';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseTenantId } from '../../../packages/core/src/db/tenant-id.js';
import type { TenantScope } from '../../../packages/core/src/db/tenant-scope.js';
import { Registry } from '../../../packages/core/src/registry/registry.js';
import {
  issueRunContract,
  runContractBytes,
  runContractSha256,
  RunContractError,
  verifyRunContract,
  type IssueRunContract,
} from '../../../packages/core/src/run-contract/index.js';
import { credentialFiles, StubOpenBao } from '../../secrets/stub-openbao.js';
import { seedAgent } from '../agent-seed.js';
import { createTestDatabase, describeDb, tamper, type TestDatabase } from './helpers.js';

const NOW = new Date('2026-09-26T08:00:00.000Z');
const MINUTE = 60_000;
const SHA = (c: string) => c.repeat(64);

const registry = new Registry({
  policyFactory: (config) => createSimplePolicyEngine({ config }),
  now: () => NOW,
});

interface Seeded {
  readonly scope: TenantScope;
  readonly intentId: string;
  readonly planId: string;
  readonly personA: string;
  readonly personB: string;
  readonly agentId: string;
}

describeDb('C02: Run Contracts on PostgreSQL', () => {
  let t: TestDatabase;
  let stub: StubOpenBao;
  let files: ReturnType<typeof credentialFiles>;
  let worker: OpenBaoClient;
  let runner: OpenBaoClient;
  let signingKey: TransitKey;
  let verifier: RunContractVerifier;
  let tenantCount = 0;

  beforeAll(async () => {
    t = await createTestDatabase();
    stub = await StubOpenBao.start();
    files = credentialFiles();
    const options = {
      address: stub.address,
      allowPlaintext: true,
      roleIdFile: files.roleIdFile,
      secretIdFile: files.secretIdFile,
    };
    worker = new OpenBaoClient(options);
    runner = new OpenBaoClient(options);
    signingKey = worker.transit();
    const runnerKey = runner.transit();
    verifier = {
      verify: (payload, signature) => runnerKey.verifyLocally(payload, signature),
      publicKey: (version) => runnerKey.publicKey(version),
    };
  }, 60_000);

  afterAll(async () => {
    await worker?.close();
    await runner?.close();
    await stub?.stop();
    if (files) fs.rmSync(files.dir, { recursive: true, force: true });
    await t?.drop();
  });

  /** A new Transit key version in the stub, like `transit/keys/run-contract/rotate`. */
  function rotateKey(): void {
    const pair = crypto.generateKeyPairSync('ed25519');
    const der = pair.publicKey.export({ format: 'der', type: 'spki' });
    stub.keys.push({ privateKey: pair.privateKey, publicRaw: der.subarray(der.length - 32) });
  }

  async function seed(
    options: { configYaml?: string; riskTier?: 'low' | 'high' } = {},
  ): Promise<Seeded> {
    const slug = `tenant-${String(++tenantCount)}`;
    const tenant = await t.app.system.createTenant({ slug, name: slug });
    const scope = t.app.forTenant(parseTenantId(tenant.id));
    const project = await scope.projects.create({
      slug: 'shop',
      name: 'Shop',
      git_provider: 'github',
      repo_full_name: 'org/pilot-order-inventory',
    });
    const personA = (await scope.users.create({ display_name: 'a', email: 'a@example.com' })).id;
    const personB = (await scope.users.create({ display_name: 'b', email: 'b@example.com' })).id;
    if (options.configYaml !== undefined) {
      const loaded = loadProjectConfig(options.configYaml);
      if (!loaded.ok) throw new Error('bad test config');
      await scope.projectConfigs.save(project.id, {
        configYaml: options.configYaml,
        configHash: loaded.configHash,
        updatedBy: null,
        expectedVersion: 0,
      });
    }
    const intent = await registry.createIntent(scope, {
      projectId: project.id,
      title: 'Add Japanese labels',
      createdBy: personA,
      riskTier: options.riskTier ?? 'low',
      dataClass: 'internal',
    });
    const plan = await registry.submitPlan(scope, intent.id, {
      plannedFiles: ['apps/web/src/products/**'],
      planSha256: SHA('b'),
      actorType: 'human',
      actorId: personA,
    });
    const agent = await seedAgent(scope, personA, {
      version: '1.4.0',
      tools: ['shell:test', 'git', 'editor', 'browser'],
    });
    return { scope, intentId: intent.id, planId: plan.id, personA, personB, agentId: agent.id };
  }

  const input = (s: Seeded, extra: Partial<IssueRunContract> = {}): IssueRunContract => ({
    intentId: s.intentId,
    planId: s.planId,
    baseSha: 'a'.repeat(40),
    agent: {
      id: s.agentId,
      version: '1.4.0',
      instructionsSha256: SHA('c'),
      tools: ['shell:test', 'git', 'editor', 'browser'],
      adapter: 'openhands',
    },
    planTools: ['editor', 'git', 'deploy'],
    autonomyLevel: 'L2',
    maxBudgetUsd: '2',
    maxIterations: 40,
    maxDurationMin: 60,
    allowedModels: ['anthropic/claude-haiku-4-5-20251001'],
    egressAllowlist: ['litellm:4000', 'github.com', 'api.github.com'],
    triggeredBy: s.personB,
    ...extra,
  });

  const issue = (s: Seeded, extra: Partial<IssueRunContract> = {}, now = NOW) =>
    issueRunContract(s.scope, input(s, extra), { signer: signingKey, now: () => now });

  const verifyAt = (envelope: unknown, now: Date) =>
    verifyRunContract(t.app, envelope, { verifier, now: () => now });

  const auditActions = async (s: Seeded) =>
    (
      await sql<{ action: string }>`SELECT action FROM audit_log
        WHERE tenant_id = ${s.scope.tenantId} ORDER BY seq`.execute(t.owner)
    ).rows.map((r) => r.action);

  async function codeOf(promise: Promise<unknown>): Promise<string> {
    try {
      await promise;
    } catch (error) {
      if (error instanceof RunContractError) return error.code;
      throw error;
    }
    return 'resolved';
  }

  describe('issuing (AC1)', () => {
    it('signs the canonical contract through Transit and stores it with its run', async () => {
      const s = await seed();
      const issued = await issue(s);
      const { contract, signature } = issued.envelope;

      expect(contract).toMatchObject({
        schema_version: 3,
        tool_grants: [],
        agent_adapter: 'openhands',
        tenant_id: s.scope.tenantId,
        intent_id: s.intentId,
        repo: 'org/pilot-order-inventory',
        branch: expect.stringMatching(/^agent\/INT-2026-0001$/) as string,
        plan_id: s.planId,
        plan_sha256: SHA('b'),
        planned_files: ['apps/web/src/products/**'],
        allowed_tools: ['editor', 'git'],
        egress_allowlist: ['api.github.com', 'github.com', 'litellm:4000'],
        loop_threshold: 3, // config run.loop_detection.identical_tool_calls_max
        issued_at: '2026-09-26T08:00:00.000Z',
        expires_at: '2026-09-26T08:15:00.000Z', // config run.contract_validity_minutes
      });
      expect(signature).toMatch(/^vault:v1:/);
      expect(issued.keyVersion).toBe(1);
      expect(await signingKey.verify(runContractBytes(contract), signature)).toBe(true);

      expect(issued.run).toMatchObject({
        id: contract.run_id,
        status: 'queued',
        attempt: 1,
        branch: contract.branch,
        triggered_by: s.personB,
      });
      const row = (await s.scope.runContracts.getByRunId(contract.run_id))!;
      expect(row).toMatchObject({
        contract_sha256: runContractSha256(contract),
        signature,
        key_version: 1,
        revoked_at: null,
      });
      expect(row.expires_at.toISOString()).toBe(contract.expires_at);
      // jsonb round trip keeps the signed bytes.
      expect(runContractSha256(row.contract_json as unknown as RunContract)).toBe(
        row.contract_sha256,
      );
      const events = await s.scope.runEvents.list(contract.run_id);
      expect(events.map((e) => [e.event_type, e.payload])).toEqual([
        ['contract_issued', { contract_sha256: row.contract_sha256, key_version: 1 }],
      ]);
      expect((await auditActions(s)).at(-1)).toBe('run.contract_issued');
      expect((await s.scope.audit.verify()).broken).toBeUndefined();
    });

    it('numbers attempts per intent', async () => {
      const s = await seed();
      await issue(s);
      const second = await issue(s);
      expect(second.run.attempt).toBe(2);
      expect((await s.scope.runs.listForIntent(s.intentId)).map((r) => r.attempt)).toEqual([1, 2]);
    });

    it('refuses a plan that is no longer the latest, autonomy above the intent, and an unknown intent', async () => {
      const s = await seed();
      await registry.submitPlan(s.scope, s.intentId, {
        plannedFiles: ['apps/api/**'],
        planSha256: SHA('d'),
        actorType: 'human',
        actorId: s.personA,
      });
      expect(await codeOf(issue(s))).toBe('plan_not_latest');

      const high = await seed({ riskTier: 'high' }); // max autonomy L1 (FR-03)
      expect(await codeOf(issue(high))).toBe('autonomy_above_intent');
      expect(await codeOf(issue(high, { autonomyLevel: 'L1' }))).toBe('resolved');

      expect(await codeOf(issue(s, { intentId: crypto.randomUUID() }))).toBe('intent_not_found');
      expect(await codeOf(issue(high, { autonomyLevel: 'L1', maxBudgetUsd: '1.2345678' }))).toBe(
        'invalid_input',
      );
    });

    it('writes the run, contract, event and audit event together or not at all', async () => {
      const s = await seed();
      const { envelope } = await issue(s);
      const contract = { ...envelope.contract, run_id: crypto.randomUUID() };
      // A signature whose version does not match key_version breaks a CHECK after `runs` is written.
      await expect(
        s.scope.runContracts.store({
          contract,
          contractSha256: runContractSha256(contract),
          signature: envelope.signature,
          keyVersion: 2,
          triggeredBy: null,
        }),
      ).rejects.toMatchObject({ code: 'invalid_value' });
      expect(await s.scope.runs.getById(contract.run_id)).toBeUndefined();
      expect(await s.scope.runEvents.list(contract.run_id)).toEqual([]);
    });
  });

  describe('verifying (AC2)', () => {
    it('accepts a valid contract once and records contract_accepted', async () => {
      const s = await seed();
      const { envelope } = await issue(s);
      const result = await verifyAt(envelope, new Date(NOW.getTime() + MINUTE));
      expect(result).toMatchObject({ ok: true, run: { status: 'queued' } });
      const events = await s.scope.runEvents.list(envelope.contract.run_id);
      expect(events.map((e) => e.event_type)).toEqual(['contract_issued', 'contract_accepted']);
    });

    it('refuses an expired contract with no tolerance, and records the rejection', async () => {
      const s = await seed({ configYaml: 'run:\n  contract_clock_skew_seconds: 30\n' });
      const { envelope } = await issue(s);
      const expiry = new Date(envelope.contract.expires_at);
      expect(await verifyAt(envelope, new Date(expiry.getTime() - 1))).toMatchObject({ ok: true });
      expect(await verifyAt(envelope, expiry)).toEqual({
        ok: false,
        reason: 'expired',
        runId: envelope.contract.run_id,
      });
      const events = await s.scope.runEvents.list(envelope.contract.run_id);
      expect(events.at(-1)).toMatchObject({
        event_type: 'contract_rejected',
        payload: { reason: 'expired' },
      });
      expect((await auditActions(s)).at(-1)).toBe('run.contract_rejected');
    });

    it('refuses a contract issued in the future, tolerating only the configured clock skew', async () => {
      const strict = await seed();
      const early = (await issue(strict)).envelope;
      expect(await verifyAt(early, new Date(NOW.getTime() - 1))).toMatchObject({
        ok: false,
        reason: 'not_yet_valid',
      });

      const tolerant = await seed({ configYaml: 'run:\n  contract_clock_skew_seconds: 5\n' });
      const skewed = (await issue(tolerant)).envelope;
      expect(await verifyAt(skewed, new Date(NOW.getTime() - 6000))).toMatchObject({
        ok: false,
        reason: 'not_yet_valid',
      });
      expect(await verifyAt(skewed, new Date(NOW.getTime() - 5000))).toMatchObject({ ok: true });
    });

    it('refuses a badly signed contract without writing anything', async () => {
      const s = await seed();
      const { envelope } = await issue(s);
      const changed = { ...envelope, contract: { ...envelope.contract, max_iterations: 400 } };
      expect(await verifyAt(changed, NOW)).toEqual({ ok: false, reason: 'bad_signature' });
      const events = await s.scope.runEvents.list(envelope.contract.run_id);
      expect(events.map((e) => e.event_type)).toEqual(['contract_issued']);
    });

    it('refuses a correctly signed contract that is not in the database', async () => {
      const s = await seed();
      const { envelope } = await issue(s);
      const contract = { ...envelope.contract, run_id: crypto.randomUUID() };
      const { signature } = await signingKey.sign(runContractBytes(contract));
      expect(await verifyAt({ contract, signature }, NOW)).toEqual({
        ok: false,
        reason: 'unknown_contract',
      });
    });

    it('refuses a correctly signed contract that differs from the stored one', async () => {
      const s = await seed();
      const { envelope } = await issue(s);
      const contract = { ...envelope.contract, max_budget_usd: '200' };
      const { signature } = await signingKey.sign(runContractBytes(contract));
      expect(await verifyAt({ contract, signature }, NOW)).toMatchObject({
        ok: false,
        reason: 'mismatch',
      });
    });

    it('refuses a revoked contract and a run that already left queued', async () => {
      const s = await seed();
      const revoked = (await issue(s)).envelope;
      await tamper(t.name, 'UPDATE run_contracts SET revoked_at = now() WHERE run_id = $1', [
        revoked.contract.run_id,
      ]);
      expect(await verifyAt(revoked, NOW)).toMatchObject({ ok: false, reason: 'revoked' });

      const started = (await issue(s)).envelope;
      await sql`UPDATE runs SET status = 'provisioning' WHERE tenant_id = ${s.scope.tenantId}
        AND id = ${started.contract.run_id}`.execute(t.appRaw);
      expect(await verifyAt(started, NOW)).toMatchObject({
        ok: false,
        reason: 'run_not_startable',
      });
    });

    it('O06: a project folder gives schema 4; only OpenHands may run it (folder_not_enforceable)', async () => {
      const s = await seed();
      const intent = (await s.scope.intents.getById(s.intentId))!;
      await s.scope.projects.update(intent.project_id, { repo_path: 'apps/web' });
      const root = SHA('e');
      const folder = (
        await issue(s, { agent: { ...input(s).agent, rootInstructionsSha256: root } })
      ).envelope;
      expect(folder.contract).toMatchObject({
        schema_version: 4,
        repo_path: 'apps/web',
        root_instructions_sha256: root,
      });
      expect(await verifyAt(folder, NOW)).toMatchObject({ ok: true });

      const opencode = (await issue(s, { agent: { ...input(s).agent, adapter: 'opencode' } }))
        .envelope;
      expect(opencode.contract).toMatchObject({
        schema_version: 4,
        root_instructions_sha256: null,
      });
      expect(await verifyAt(opencode, NOW)).toMatchObject({
        ok: false,
        reason: 'folder_not_enforceable',
      });
    });

    it('O06: without a folder or a second file the contract stays schema 3', async () => {
      const s = await seed();
      const { envelope } = await issue(s);
      expect(envelope.contract.schema_version).toBe(3);
      expect(envelope.contract).not.toHaveProperty('repo_path');
    });

    it('still accepts a contract signed with an older key version after a rotation', async () => {
      const s = await seed();
      const before = (await issue(s)).envelope;
      rotateKey();
      const after = await issue(s);
      expect(after.keyVersion).toBe(stub.keys.length);
      expect(after.envelope.signature).toMatch(new RegExp(`^vault:v${String(stub.keys.length)}:`));
      expect(await verifyAt(before, NOW)).toMatchObject({ ok: true });
      expect(await verifyAt(after.envelope, NOW)).toMatchObject({ ok: true });
      // A v1 signature relabelled as the new version does not verify.
      const relabelled = before.signature.replace(
        /^vault:v1:/,
        `vault:v${String(after.keyVersion)}:`,
      );
      expect(await verifyAt({ ...before, signature: relabelled }, NOW)).toMatchObject({
        ok: false,
        reason: 'bad_signature',
      });
    });
  });

  describe('run_events is append-only and coded (AC3)', () => {
    async function runOf(s: Seeded): Promise<string> {
      return (await issue(s)).run.id;
    }

    it('refuses UPDATE, DELETE and TRUNCATE for platform_app and for the owner', async () => {
      const s = await seed();
      const runId = await runOf(s);
      const statements = [
        sql`UPDATE run_events SET event_type = 'x' WHERE run_id = ${runId}`,
        sql`DELETE FROM run_events WHERE run_id = ${runId}`,
        sql`TRUNCATE run_events`,
      ];
      for (const statement of statements) {
        await expect(statement.execute(t.appRaw)).rejects.toMatchObject({ code: '42501' });
        await expect(statement.execute(t.owner)).rejects.toMatchObject({ code: 'SDA01' });
      }
      expect((await s.scope.runEvents.list(runId)).length).toBe(1);
    });

    it.each([
      ['free text', { reason: 'customer Tanaka asked to stop the run' }],
      ['an e-mail address', { reason: 'tanaka@example.co.jp' }],
      ['a nested object', { detail: { reason: 'expired' } }],
      ['an array', { files: ['a.ts'] }],
      ['a fraction', { percent: 80.5 }],
      ['null', { reason: null }],
      ['a bad key', { 'Reason Text': 'x' }],
      ['a long value', { reason: 'x'.repeat(129) }],
    ])('the database refuses a payload with %s, even with raw SQL', async (_label, payload) => {
      const s = await seed();
      const runId = await runOf(s);
      await expect(
        sql`INSERT INTO run_events (tenant_id, run_id, event_type, payload)
          VALUES (${s.scope.tenantId}, ${runId}, 'contract_rejected', ${JSON.stringify(payload)})`.execute(
          t.appRaw,
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('the database accepts coded values: codes, hashes, integers, booleans', async () => {
      const s = await seed();
      const runId = await runOf(s);
      const payload = { reason: 'stopped_budget', sha: SHA('e'), percent: 80, warned: true };
      await sql`INSERT INTO run_events (tenant_id, run_id, event_type, payload)
        VALUES (${s.scope.tenantId}, ${runId}, 'budget_warning', ${JSON.stringify(payload)})`.execute(
        t.appRaw,
      );
    });

    it('the repository refuses free text and e-mail addresses before writing', async () => {
      const s = await seed();
      const runId = await runOf(s);
      for (const reason of ['customer asked', 'tanaka@example.co.jp']) {
        await expect(
          s.scope.runEvents.append(runId, 'contract_rejected', { reason }),
        ).rejects.toMatchObject({ code: 'invalid_value' });
      }
    });
  });

  describe('runs and run_contracts', () => {
    it('platform_app may update run state only; a final status never changes (SDA05)', async () => {
      const s = await seed();
      const { run } = await issue(s);
      const where = sql`WHERE tenant_id = ${s.scope.tenantId} AND id = ${run.id}`;
      await expect(
        sql`UPDATE runs SET agent_id = ${crypto.randomUUID()} ${where}`.execute(t.appRaw),
      ).rejects.toMatchObject({ code: '42501' });
      await sql`UPDATE runs SET status = 'failed', stop_reason = 'ci_failed' ${where}`.execute(
        t.appRaw,
      );
      await expect(
        sql`UPDATE runs SET status = 'running' ${where}`.execute(t.appRaw),
      ).rejects.toMatchObject({ code: 'SDA05' });
      await expect(
        sql`UPDATE runs SET iterations = 1 ${where}`.execute(t.owner),
      ).rejects.toMatchObject({
        code: 'SDA05',
      });
    });

    it('stop_reason is a code, not free text', async () => {
      const s = await seed();
      const { run } = await issue(s);
      await expect(
        sql`UPDATE runs SET stop_reason = 'the agent looped' WHERE tenant_id = ${s.scope.tenantId}
          AND id = ${run.id}`.execute(t.appRaw),
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('platform_app cannot change a stored contract', async () => {
      const s = await seed();
      const { run } = await issue(s);
      await expect(
        sql`UPDATE run_contracts SET key_version = 9 WHERE tenant_id = ${s.scope.tenantId}
          AND run_id = ${run.id}`.execute(t.appRaw),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        sql`UPDATE run_contracts SET revoked_at = now() WHERE tenant_id = ${s.scope.tenantId}
          AND run_id = ${run.id}`.execute(t.appRaw),
      ).rejects.toMatchObject({ code: '42501' });
    });

    it('refuses a run that references another tenant (composite foreign keys, D-05 D2)', async () => {
      const a = await seed();
      const b = await seed();
      await expect(
        sql`INSERT INTO runs (id, tenant_id, intent_id, plan_id, attempt, agent_id, agent_version,
            branch, base_sha)
          VALUES (${crypto.randomUUID()}, ${b.scope.tenantId}, ${a.intentId}, ${a.planId}, 1,
            ${crypto.randomUUID()}, '1.0', 'agent/INT-2026-0001', ${'a'.repeat(40)})`.execute(
          t.appRaw,
        ),
      ).rejects.toMatchObject({ code: '23503' });
    });

    it('refuses a run of an agent that is not registered in the tenant (C10, QUESTIONS #32)', async () => {
      const a = await seed();
      const b = await seed();
      for (const agentId of [crypto.randomUUID(), b.agentId]) {
        await expect(
          sql`INSERT INTO runs (id, tenant_id, intent_id, plan_id, attempt, agent_id, agent_version,
              branch, base_sha)
            VALUES (${crypto.randomUUID()}, ${a.scope.tenantId}, ${a.intentId}, ${a.planId}, 1,
              ${agentId}, '1.0', 'agent/INT-2026-0001', ${'a'.repeat(40)})`.execute(t.appRaw),
        ).rejects.toMatchObject({ code: '23503', constraint: 'runs_agent_fkey' });
      }
      await expect(issue(a, { agent: { ...input(a).agent, id: b.agentId } })).rejects.toMatchObject(
        {
          code: 'reference_not_found',
        },
      );
    });

    it('a tenant never sees another tenant’s runs', async () => {
      const a = await seed();
      const b = await seed();
      const { run } = await issue(a);
      expect(await b.scope.runs.getById(run.id)).toBeUndefined();
      expect(await b.scope.runContracts.getByRunId(run.id)).toBeUndefined();
      expect(await b.scope.runEvents.list(run.id)).toEqual([]);
    });
  });
  describe('claiming a run for provisioning (C04, QUESTIONS #35)', () => {
    const LATER = new Date(NOW.getTime() + MINUTE);

    it('two concurrent claims of the same run: exactly one succeeds', async () => {
      const s = await seed();
      const { run } = await issue(s);
      const results = await Promise.all(
        Array.from({ length: 5 }, () => s.scope.runs.claimForProvisioning(run.id, LATER)),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
      const stored = await s.scope.runs.getById(run.id);
      expect(stored).toMatchObject({ status: 'provisioning' });
      expect(stored?.updated_at.toISOString()).toBe(LATER.toISOString());
    });

    it('refuses a claim after the run left queued, an unknown run and another tenant', async () => {
      const s = await seed();
      const other = await seed();
      const { run } = await issue(s);
      expect(await other.scope.runs.claimForProvisioning(run.id, LATER)).toBe(false);
      expect(await s.scope.runs.claimForProvisioning(crypto.randomUUID(), LATER)).toBe(false);
      expect(await s.scope.runs.claimForProvisioning('not-a-uuid', LATER)).toBe(false);
      expect(await s.scope.runs.claimForProvisioning(run.id, LATER)).toBe(true);
      expect(await s.scope.runs.claimForProvisioning(run.id, LATER)).toBe(false);
      expect(await s.scope.runs.getById(run.id)).toMatchObject({ status: 'provisioning' });
    });

    it('stores the C04 sandbox events with coded payloads', async () => {
      const s = await seed();
      const { run } = await issue(s);
      await s.scope.runEvents.append(run.id, 'sandbox_created', { image_sha256: SHA('d') });
      await s.scope.runEvents.append(run.id, 'sandbox_removed', {
        reason: 'finished',
        duration_ms: 120,
      });
      expect((await s.scope.runEvents.list(run.id)).map((e) => e.event_type)).toEqual([
        'contract_issued',
        'sandbox_created',
        'sandbox_removed',
      ]);
    });
  });
});
