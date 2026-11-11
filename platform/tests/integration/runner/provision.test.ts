// D-08 C04 AC1, AC2, AC4, AC5 end to end on a real Docker Engine and PostgreSQL (ADR-M25 §2.8):
// the worker issues and signs the Run Contract and wraps the GitHub token (QUESTIONS #44); the
// runner verifies, claims, unwraps, clones `base_sha` onto `agent/INT-…` from a local Git host,
// starts the sandbox from the project image (config `sandbox.image`, pinned by digest) and waits
// for its health check. From inside, the sandbox sees the branch and no Git credential, reaches
// LiteLLM and nothing else. Then the runner removes everything.
// C06 session 2b: an L1 run keeps the runner's clone; the proposal is read out of the real sandbox
// with Docker's archive endpoint and computed with hardened git (ADR-M33 §2.9).
// C07: every run keeps its clone; an L2 run's changes are stored as a diff and checked against the
// plan and the agent instruction paths (ADR-M34 §2.2–§2.4).
// C11 (D-08 C11 AC2, D-02 FR-34, §10 item 5d, ADR-M42): the clone token is revoked right after the
// clone; the kill switch stops a running run and everything is gone in under 5 minutes (measured).
//
// `pnpm test:runner` (SDLC_RUNNER_TEST=1, throw-away PostgreSQL from test-db.sh; CI job `compose`).
// OpenBao is the in-process stub (Transit and response wrapping); `pnpm test:openbao` checks
// wrapping and the new policies on a real OpenBao.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSimplePolicyEngine } from '@sdlc/adapter-policy-simple';
import { loadProjectConfig } from '@sdlc/config';
import { OpenBaoClient, Redacted } from '@sdlc/secrets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AgentAdapter, AgentRunStatus, EvidenceStore, StoredEvidence } from '@sdlc/contracts';

import {
  DockerClient,
  driveAgent,
  HeldRuns,
  LABELS,
  provisionRun,
  reconcileOnStart,
  releaseSandbox,
  runLabels,
  runnerSettingsFromEnv,
  storeChanges,
  storeProposal,
  type RunnerDeps,
} from '../../../apps/runner/src/index.js';
import { parseTenantId } from '../../../packages/core/src/db/tenant-id.js';
import { requestRunKill } from '../../../packages/core/src/kill/index.js';
import { Registry } from '../../../packages/core/src/registry/registry.js';
import { issueRunContract } from '../../../packages/core/src/run-contract/index.js';
import { StubGitHost } from '../../runner/stub-git.js';
import { credentialFiles, StubOpenBao } from '../../secrets/stub-openbao.js';
import { seedAgent } from '../agent-seed.js';
import { createTestDatabase, type TestDatabase } from '../db/helpers.js';
import {
  BUSYBOX,
  buildFixtureImage,
  createInternalNetwork,
  docker,
  dockerSocket,
  liveEnabled,
  quietly,
  startStub,
  waitForProbes,
  type FixtureImage,
} from './live-helpers';

const TOKEN = `ghs_c04Live${crypto.randomBytes(12).toString('hex')}`;
const suffix = crypto.randomBytes(4).toString('hex');
const instance = `c04-flow-${suffix}`;
const platformNet = `sdlc-c04-flow-platform-${suffix}`;
const litellm = `sdlc-c04-flow-litellm-${suffix}`;
/** C11: stands in for the runner's own container, which joins the run's network. */
const self = `sdlc-c04-flow-self-${suffix}`;

describe.skipIf(!liveEnabled || !process.env.SDLC_TEST_DATABASE_URL)(
  'C04 live: provisioning flow end to end',
  () => {
    let t: TestDatabase;
    let bao: StubOpenBao;
    let files: ReturnType<typeof credentialFiles>;
    let worker: OpenBaoClient;
    let runner: OpenBaoClient;
    let git: StubGitHost;
    let fixture: FixtureImage | undefined;
    let workDir: string;
    let deps: RunnerDeps;

    beforeAll(async () => {
      t = await createTestDatabase();
      bao = await StubOpenBao.start();
      files = credentialFiles();
      const options = {
        address: bao.address,
        allowPlaintext: true,
        roleIdFile: files.roleIdFile,
        secretIdFile: files.secretIdFile,
      };
      worker = new OpenBaoClient(options);
      runner = new OpenBaoClient(options);
      git = await StubGitHost.start(TOKEN);
      docker('pull', '-q', BUSYBOX);
      fixture = await buildFixtureImage(suffix);
      createInternalNetwork(platformNet);
      startStub(litellm, platformNet, 4000);
      startStub(self, platformNet, 8080);
      workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-runner-live-'));
      const runnerKey = runner.transit();
      deps = {
        db: t.app as unknown as RunnerDeps['db'],
        docker: new DockerClient({ socketPath: dockerSocket(), timeoutMs: 120_000 }),
        settings: runnerSettingsFromEnv({
          SDLC_RUNNER_DOCKER_SOCKET: dockerSocket(),
          SDLC_RUNNER_INSTANCE: instance,
          SDLC_RUNNER_SANDBOX_MEMORY_MB: '256',
          SDLC_RUNNER_EGRESS_SERVICES: `litellm=${litellm}:4000`,
          SDLC_RUNNER_GIT_BASE_URL: git.origin,
          SDLC_RUNNER_GIT_ALLOW_PLAINTEXT: '1',
          SDLC_RUNNER_WORK_DIR: workDir,
          SDLC_RUNNER_READY_TIMEOUT_SECONDS: '120',
        }),
        verifier: {
          verify: (payload, signature) => runnerKey.verifyLocally(payload, signature),
          publicKey: (version) => runnerKey.publicKey(version),
        },
        unwrapper: runner.wrapping(),
        held: new HeldRuns(),
      };
    }, 300_000);

    afterAll(async () => {
      quietly('rm', '-f', '-v', litellm);
      quietly('rm', '-f', '-v', self);
      quietly('network', 'rm', platformNet);
      fixture?.cleanup();
      await worker?.close();
      await runner?.close();
      await bao?.stop();
      await git?.stop();
      if (files) fs.rmSync(files.dir, { recursive: true, force: true });
      if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
      await t?.drop();
    }, 120_000);

    /** Worker side: tenant, project with its sandbox image, intent, plan, signed contract. */
    async function prepareRun(slug: string, autonomyLevel: 'L1' | 'L2' = 'L2') {
      const repo = `org/pilot-${slug}`;
      const { first: baseSha } = git.createRepo(repo, {
        'README.md': 'pilot\n',
        'probe-targets': 'litellm litellm 4000\ngithub api.github.com 443\n',
      });

      // Worker side: tenant, project with its sandbox image, intent, plan, signed contract.
      const tenant = await t.app.system.createTenant({ slug, name: slug });
      const scope = t.app.forTenant(parseTenantId(tenant.id));
      const project = await scope.projects.create({
        slug: 'shop',
        name: 'Shop',
        git_provider: 'github',
        repo_full_name: repo,
      });
      const configYaml = `sandbox:\n  image: ${fixture!.image}\n`;
      const loaded = loadProjectConfig(configYaml);
      if (!loaded.ok) throw new Error('fixture image reference refused by the configuration');
      await scope.projectConfigs.save(project.id, {
        configYaml,
        configHash: loaded.configHash,
        updatedBy: null,
        expectedVersion: 0,
      });
      const personA = (await scope.users.create({ display_name: 'a', email: 'a@example.com' })).id;
      const personB = (await scope.users.create({ display_name: 'b', email: 'b@example.com' })).id;
      const registry = new Registry({
        policyFactory: (config) => createSimplePolicyEngine({ config }),
      });
      const intent = await registry.createIntent(scope, {
        projectId: project.id,
        title: 'Add Japanese labels',
        createdBy: personA,
        riskTier: 'low',
        dataClass: 'internal',
      });
      const plan = await registry.submitPlan(scope, intent.id, {
        plannedFiles: ['README.md'],
        planSha256: 'b'.repeat(64),
        actorType: 'human',
        actorId: personA,
      });
      // C11: the driver reads the task (spec and plan) before it starts the agent.
      await registry.linkSpec(scope, intent.id, {
        path: 'docs/specs/t01.md',
        commitSha: baseSha,
        contentSha256: 'd'.repeat(64),
        structure: 'manual_heading',
        acceptanceCriteria: 1,
        actorType: 'human',
        actorId: personA,
      });
      const agent = await seedAgent(scope, personA);
      const { envelope } = await issueRunContract(
        scope,
        {
          intentId: intent.id,
          planId: plan.id,
          baseSha,
          agent: {
            id: agent.id,
            version: '1.0.0',
            instructionsSha256: 'c'.repeat(64),
            tools: ['editor'],
            adapter: 'openhands',
          },
          planTools: ['editor'],
          autonomyLevel,
          maxBudgetUsd: '1',
          maxIterations: 10,
          maxDurationMin: 10,
          allowedModels: ['stub'],
          egressAllowlist: ['litellm:4000'],
          triggeredBy: personB,
        },
        { signer: worker.transit() },
      );
      const wrapped = await worker
        .wrapping()
        .wrap({ token: new Redacted(TOKEN) }, { ttlSeconds: 900 });

      return { tenant, scope, envelope, wrapped };
    }

    it('verifies, clones, starts a healthy sandbox with the branch and no credential, then cleans up', async () => {
      const { tenant, scope, envelope, wrapped } = await prepareRun('live');

      // Runner side.
      const result = await provisionRun(deps, { envelope, wrappedGitToken: wrapped });
      if (!result.ok) throw new Error(`provisioning failed: ${result.reason}`);
      const runId = envelope.contract.run_id;
      expect(await scope.runs.getById(runId)).toMatchObject({ status: 'running' });

      const probes = Object.fromEntries(
        await waitForProbes(deps.docker, result.sandbox.containerId),
      );
      expect(probes).toMatchObject({
        litellm: 'open',
        github: 'blocked',
        branch: envelope.contract.branch, // AC2
        git_auth: 'absent', // no credential in the workspace (AC4)
        readme: 'pilot',
        workspace: 'writable',
        rootfs: 'readonly',
        uid: '10001',
        canary: 'absent',
        secret_env: 'absent',
        default_route: 'none',
      });
      const info = await deps.docker.containerInspect(result.sandbox.containerId);
      expect(JSON.stringify(info)).not.toContain(TOKEN);
      expect(info?.State.Health?.Status).toBe('healthy');
      // The runner keeps its own clone for the run's changes (C07), without the token.
      expect(fs.readdirSync(workDir)).toEqual([path.basename(result.cloneDir)]);
      const gitConfig = path.join(result.cloneDir, 'repo', '.git', 'config');
      expect(fs.readFileSync(gitConfig, 'utf8')).not.toContain(TOKEN);
      fs.rmSync(result.cloneDir, { recursive: true, force: true });

      // AC5: release removes everything and records it.
      await releaseSandbox(deps, tenant.id, runId, 'finished');
      const labels = { [LABELS.instance]: instance };
      expect(await deps.docker.containerList(labels)).toEqual([]);
      expect(await deps.docker.networkList(labels)).toEqual([]);
      expect(await deps.docker.volumeList(labels)).toEqual([]);
      expect((await scope.runEvents.list(runId)).map((e) => e.event_type)).toEqual([
        'contract_issued',
        'contract_accepted',
        'workspace_prepared',
        'sandbox_created',
        'sandbox_ready',
        'sandbox_removed',
      ]);
    }, 300_000);

    it('C06 2b: an L1 run keeps the clone; the proposal comes from the real sandbox archive', async () => {
      const { tenant, scope, envelope, wrapped } = await prepareRun('proposal', 'L1');
      const result = await provisionRun(deps, { envelope, wrappedGitToken: wrapped });
      if (!result.ok) throw new Error(`provisioning failed: ${result.reason}`);
      const runId = envelope.contract.run_id;
      const cloneDir = result.cloneDir;
      try {
        // What the agent leaves: an edit, a new file, a link out of the workspace, a deletion,
        // and a change to its own `.git` (never read).
        docker(
          'exec',
          '-u',
          '10001',
          result.sandbox.containerId,
          'sh',
          '-c',
          'echo changed >> /workspace/README.md && echo new > /workspace/new.txt && ' +
            'ln -s /etc/passwd /workspace/link && rm /workspace/probe-targets && ' +
            'echo evil > /workspace/.git/hooks/post-checkout',
        );
        const puts: { tenantId: string; path: string; content: Buffer }[] = [];
        const evidence: EvidenceStore = {
          put: (tenantId, p, content): Promise<StoredEvidence> => {
            puts.push({ tenantId, path: p, content });
            return Promise.resolve({
              uri: `s3://evidence/proposals/${tenantId}/${p}`,
              sha256: crypto.createHash('sha256').update(content).digest('hex'),
              sizeBytes: content.length,
            });
          },
          get: () => Promise.reject(new Error('not used')),
        };
        const stored = await storeProposal({ ...deps, evidence }, envelope.contract, cloneDir);
        expect(puts).toHaveLength(1);
        const changed = [...puts[0]!.content.toString().matchAll(/^diff --git a\/(\S+) /gm)].map(
          (m) => m[1],
        );
        // `.write-test` is left by the fixture's own probe that the workspace is writable.
        expect(changed.sort()).toEqual([
          '.write-test',
          'README.md',
          'link',
          'new.txt',
          'probe-targets',
        ]);
        expect(stored.changedFiles).toBe(5);
        expect(puts[0]!.path).toBe(`${envelope.contract.intent_id}/${runId}.patch`);
        const patch = puts[0]!.content.toString();
        expect(patch).toContain('+changed');
        expect(patch).toContain('new file mode 100644');
        expect(patch).toContain('new file mode 120000'); // the link, as a link
        expect(patch).toContain('deleted file mode');
        expect(patch).not.toContain('.git/hooks');
        expect(patch).not.toContain(TOKEN);
        const [item] = await scope.evidenceItems.listForIntent(envelope.contract.intent_id);
        expect(item).toMatchObject({ kind: 'proposal', run_id: runId, sha256: stored.sha256 });
        const events = await scope.runEvents.list(runId);
        expect(events.at(-1)).toMatchObject({
          event_type: 'proposal_stored',
          payload: { sha256: stored.sha256, size_bytes: stored.sizeBytes, changed_files: 5 },
        });
      } finally {
        await releaseSandbox(deps, tenant.id, runId, 'finished');
        fs.rmSync(cloneDir, { recursive: true, force: true });
      }
    }, 300_000);

    it('C07: the changes of an L2 run come from the real sandbox, stored as a diff and checked', async () => {
      const { tenant, scope, envelope, wrapped } = await prepareRun('changes');
      const result = await provisionRun(deps, { envelope, wrappedGitToken: wrapped });
      if (!result.ok) throw new Error(`provisioning failed: ${result.reason}`);
      const runId = envelope.contract.run_id;
      try {
        // The plan allows README.md only. The agent edits it, commits nothing, adds a file and an
        // agent instruction file (QUESTIONS #126).
        docker(
          'exec',
          '-u',
          '10001',
          result.sandbox.containerId,
          'sh',
          '-c',
          'echo changed >> /workspace/README.md && echo new > /workspace/new.txt && ' +
            'echo "do more" > /workspace/AGENTS.md',
        );
        const puts: { path: string; content: Buffer }[] = [];
        const evidence: EvidenceStore = {
          put: (tenantId, p, content): Promise<StoredEvidence> => {
            puts.push({ path: p, content });
            return Promise.resolve({
              uri: `s3://evidence/diffs/${tenantId}/${p}`,
              sha256: crypto.createHash('sha256').update(content).digest('hex'),
              sizeBytes: content.length,
            });
          },
          get: () => Promise.reject(new Error('not used')),
        };
        const loaded = loadProjectConfig('');
        if (!loaded.ok) throw new Error('default configuration refused');
        const policy = createSimplePolicyEngine({ config: loaded.config });
        const checked = await storeChanges(
          { ...deps, evidence, policy },
          envelope.contract,
          result.cloneDir,
        );
        // `.write-test` is left by the fixture's own probe that the workspace is writable.
        expect(checked).toMatchObject({ changedFiles: 4, outOfScope: 3, instructionFiles: 1 });
        expect(puts.map((p) => p.path)).toEqual([`${envelope.contract.intent_id}/${runId}.patch`]);
        expect(puts[0]!.content.toString()).toContain('+changed');
        expect(puts[0]!.content.toString()).not.toContain(TOKEN);
        const [item] = await scope.evidenceItems.listForIntent(envelope.contract.intent_id);
        expect(item).toMatchObject({ kind: 'diff', run_id: runId, sha256: checked.diffSha256 });
        const events = (await scope.runEvents.list(runId)).slice(-5);
        expect(events.map((e) => [e.event_type, e.payload])).toEqual([
          [
            'diff_stored',
            { sha256: checked.diffSha256, size_bytes: puts[0]!.content.length, changed_files: 4 },
          ],
          [
            'changes_checked',
            {
              changed_files: 4,
              out_of_scope: 3,
              instruction_files: 1,
              paths_sha256: checked.pathsSha256,
            },
          ],
          // H04: the added lines were scanned (the runner's Gitleaks, built-in rules).
          ['secrets_scanned', expect.objectContaining({ result: 'clean', findings: 0 })],
          // H05: the size a person reviews, counts only.
          ['diff_measured', expect.objectContaining({ result: 'measured', review_files: 4 })],
          // H02: the added and changed dependencies were scanned.
          [
            'dependencies_scanned',
            expect.objectContaining({ result: 'clean', new_dependencies: 0 }),
          ],
        ]);
        expect(JSON.stringify(events)).not.toMatch(/new\.txt|AGENTS|README/);
      } finally {
        await releaseSandbox(deps, tenant.id, runId, 'finished');
        fs.rmSync(result.cloneDir, { recursive: true, force: true });
      }
    }, 300_000);

    it('C11 AC2: the kill switch stops a running run; sandbox, network, volume, key and tokens gone in under 5 minutes', async () => {
      const { tenant, scope, envelope, wrapped } = await prepareRun('kill');
      const runId = envelope.contract.run_id;
      const revokedTokens: string[] = [];
      const tokenRevoker = {
        revokeShortLivedToken: (token: { reveal(): string }) => {
          revokedTokens.push(token.reveal());
          return Promise.resolve();
        },
      };
      const result = await provisionRun(
        { ...deps, tokenRevoker },
        { envelope, wrappedGitToken: wrapped },
      );
      if (!result.ok) throw new Error(`provisioning failed: ${result.reason}`);
      // The clone token ends with the clone (ADR-M42 §2.4): none is left for a kill to revoke.
      expect(revokedTokens).toEqual([TOKEN]);
      expect(
        (await scope.runEvents.list(runId)).map((e) => [e.event_type, e.payload]),
      ).toContainEqual(['token_revoked', { token: 'clone' }]);

      // An agent that works until it is stopped (the real Agent Server: `pnpm test:agent`).
      let stopped = false;
      let started = false;
      const agent: AgentAdapter = {
        startRun: (input) => {
          started = true;
          return Promise.resolve({
            runId,
            conversationId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
            endpoint: input.endpoint,
            workingDir: input.workingDir,
          });
        },
        getStatus: (): Promise<AgentRunStatus> =>
          Promise.resolve({
            state: stopped ? 'stopped' : 'running',
            iterations: 3,
            events: 3,
            identicalCalls: 0,
          }),
        stop: () => {
          stopped = true;
          return Promise.resolve();
        },
        commitWork: () => Promise.reject(new Error('never at a kill')),
        collectOutputs: () => Promise.reject(new Error('never at a kill')),
      };
      // The worker revokes the virtual key when the workflow gets the kill signal.
      let keyRevoked = false;
      const puts: Buffer[] = [];
      const evidence: EvidenceStore = {
        put: (tenantId, p, content): Promise<StoredEvidence> => {
          puts.push(content);
          return Promise.resolve({
            uri: `s3://evidence/diffs/${tenantId}/${p}`,
            sha256: crypto.createHash('sha256').update(content).digest('hex'),
            sizeBytes: content.length,
          });
        },
        get: () => Promise.reject(new Error('not used')),
      };
      const loaded = loadProjectConfig('');
      if (!loaded.ok) throw new Error('default configuration refused');
      const policy = createSimplePolicyEngine({ config: loaded.config });
      const settings = {
        ...deps.settings,
        agent: { ...deps.settings.agent, selfContainer: self },
      };
      const driving = driveAgent(
        {
          db: deps.db,
          docker: deps.docker,
          settings,
          adapter: agent,
          keyRevoked: () => Promise.resolve(keyRevoked),
          changes: async (contract) => {
            const checked = await storeChanges(
              { ...deps, evidence, policy },
              contract,
              result.cloneDir,
            );
            return { changedFiles: checked.changedFiles };
          },
        },
        {
          contract: envelope.contract,
          sandbox: result.sandbox,
          model: 'stub',
          virtualKey: new Redacted('sk-virtual-c11-live'),
        },
      );
      try {
        const deadline = Date.now() + 60_000;
        let early: unknown;
        void driving.then((r) => {
          early = r;
        });
        while (!started && early === undefined && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        expect(early).toBeUndefined();
        expect(started).toBe(true);
        // The agent writes something before the kill: the diff is the evidence for the review.
        docker(
          'exec',
          '-u',
          '10001',
          result.sandbox.containerId,
          'sh',
          '-c',
          'echo suspicious >> /workspace/README.md',
        );

        // The kill, as the operator command records it (actor system).
        const killedAt = Date.now();
        const kill = await requestRunKill(
          scope,
          {},
          { runId, actor: { type: 'system' }, source: 'ops' },
        );
        expect(kill.status).toBe('stopping');
        keyRevoked = true;
        const ended = await driving;
        const stoppedAt = Date.now();
        await releaseSandbox(deps, tenant.id, runId, 'killed');
        const elapsedMs = Date.now() - killedAt;
        // The number the ADR reports (ADR-M42 §4).
        process.stdout.write(
          `C11 kill switch: run stopped after ${String(stoppedAt - killedAt)} ms, everything ` +
            `removed after ${String(elapsedMs)} ms\n`,
        );
        expect(elapsedMs).toBeLessThan(5 * 60_000);

        expect(ended).toMatchObject({ outcome: 'killed', status: 'stopped_killed' });
        expect(stopped).toBe(true);
        expect(await scope.runs.getById(runId)).toMatchObject({
          status: 'stopped_killed',
          stop_reason: 'killed',
        });
        const labels = { [LABELS.instance]: instance };
        expect(await deps.docker.containerList(labels)).toEqual([]);
        expect(await deps.docker.networkList(labels)).toEqual([]);
        expect(await deps.docker.volumeList(labels)).toEqual([]);
        const events = (await scope.runEvents.list(runId)).map((e) => e.event_type);
        expect(events).toEqual(
          expect.arrayContaining([
            'kill_requested',
            'agent_stopped',
            'agent_finished',
            'diff_stored',
            'sandbox_removed',
          ]),
        );
        // The killed run's diff was stored after the key was refused (QUESTIONS #183).
        expect(puts).toHaveLength(1);
        expect(puts[0]!.toString()).toContain('+suspicious');
        expect(events).not.toContain('kill_evidence_failed');
        expect(JSON.stringify(await scope.runEvents.list(runId))).not.toContain(TOKEN);
      } finally {
        stopped = true;
        await driving.catch(() => undefined);
        await releaseSandbox(deps, tenant.id, runId, 'killed').catch(() => undefined);
        fs.rmSync(result.cloneDir, { recursive: true, force: true });
      }
    }, 300_000);

    it('cleans up after a runner restart: sandbox, network, volume gone; run failed (AC5)', async () => {
      const { tenant, scope, envelope, wrapped } = await prepareRun('restart');
      const result = await provisionRun(deps, { envelope, wrappedGitToken: wrapped });
      if (!result.ok) throw new Error(`provisioning failed: ${result.reason}`);
      const runId = envelope.contract.run_id;
      // Another runner deployment on the same host: its objects must survive.
      const foreign = `sdlc-ws-${crypto.randomUUID()}`;
      const foreignLabels = runLabels(`${instance}-other`, crypto.randomUUID(), tenant.id);
      docker(
        'volume',
        'create',
        ...Object.entries(foreignLabels).flatMap(([k, v]) => ['--label', `${k}=${v}`]),
        foreign,
      );
      try {
        // The old process is gone: a new one starts with nothing in memory.
        const restarted = await reconcileOnStart({
          db: deps.db,
          docker: deps.docker,
          settings: deps.settings,
        });
        expect(restarted).toEqual({ runs: 1, failedRuns: 1, errors: 0 });
        const labels = { [LABELS.instance]: instance };
        expect(await deps.docker.containerList(labels)).toEqual([]);
        expect(await deps.docker.networkList(labels)).toEqual([]);
        expect(await deps.docker.volumeList(labels)).toEqual([]);
        expect(await scope.runs.getById(runId)).toMatchObject({
          status: 'failed',
          stop_reason: 'runner_restarted',
        });
        expect((await scope.runEvents.list(runId)).map((e) => e.event_type).slice(-2)).toEqual([
          'run_abandoned',
          'sandbox_removed',
        ]);
        expect(docker('volume', 'ls', '-q', '--filter', `name=${foreign}`)).toBe(foreign);
      } finally {
        quietly('volume', 'rm', foreign);
        deps.held.release(runId);
      }
    }, 300_000);
  },
);
