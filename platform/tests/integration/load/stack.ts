// The stack of the load test (task O07, D-08 O07 AC1, NFR-01; QUESTIONS #717–#720).
//
// Real: the PostgreSQL schema and its data access layer (a throw-away database of `test-db.sh`),
// the Temporal server of the Compose file (a throw-away project, own ports), the worker's intent
// workflow and its activities (`startIntentWorker`, `createIntentActivities`), and the poller
// (`pollProject` with the real GitHub adapter) reading comment commands from a GitHub API stub.
// Fake (QUESTIONS #717): the runner. A Temporal worker on the queue `sdlc-runner` answers
// `executeRun` and `publishRun` after a fixed time and records what the real runner records (the
// checked changes, the pushed head), without a sandbox or a model. The model gateway, OpenBao and
// the G4–G8 reads of the Git host are fakes too; every fake Git host call is counted, so the report
// can add them to the poller's calls.
//
// One tenant = one project = one GitHub API stub (one App installation). The people of each
// tenant decide G1–G3 and G8 with comment commands; CI passes, Person B reviews and merges the
// pull request in the fakes as soon as the intent waits for it.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { bundleWorkflowCode, NativeConnection, Worker } from '@temporalio/worker';

import {
  createIntentActivities,
  type IntentActivityDeps,
} from '../../../apps/worker/src/activities/intent-activities.js';
import { startIntentWorker, type IntentWorkerHandle } from '../../../apps/worker/src/temporal.js';
import type { PullRequestInfo, ReviewDecision } from '../../../packages/contracts/src/git-host.js';
import type { IntentWorkflowRef } from '../../../packages/contracts/src/intent-workflow.js';
import {
  RUNNER_TASK_QUEUE,
  type ExecuteRunInput,
  type ExecuteRunResult,
  type PublishRunInput,
  type PublishRunResult,
} from '../../../packages/contracts/src/run-activity.js';
import { loadProjectConfig } from '../../../packages/config/src/index.js';
import type { Intent } from '../../../packages/core/src/db/schema.js';
import type { G4Deps } from '../../../packages/core/src/workflow/g4-proposal.js';
import type { PublishDeps } from '../../../packages/core/src/workflow/publish.js';
import {
  connectTemporal,
  TemporalIntentSignals,
  type TemporalClient,
} from '../../../packages/workflow-client/src/index.js';
import { deployDir } from '../../deploy/compose';
import { seedAgent } from '../agent-seed.js';
import { createTestDatabase, type TestDatabase } from '../db/helpers.js';
import { MemoryEvidenceStore } from '../db/memory-evidence-store.js';
import { AGENTS_MD, fakeRunDeps, MODEL, Secret, sha256, type RunCalls } from '../g4-harness.js';
import { isolateEnv } from '../throwaway-compose';
import { createWorkflowFixture, PEOPLE, type WorkflowFixture } from '../workflow/fixture.js';

const WORKFLOWS = path.resolve(__dirname, '../../../apps/worker/dist/workflows/index.js');
/** Added to the Compose host ports, so a developer's running stack is never touched. */
const PORT_OFFSET = 39000;
const HEAD = 'e'.repeat(40);
const BASE = '1'.repeat(40);

/** What the load test runs (environment variables `SDLC_LOAD_*`, QUESTIONS #719). */
export interface LoadSettings {
  readonly tenants: number;
  readonly intentsPerTenant: number;
  /** Activity slots of the fake runner, like `SDLC_RUNNER_MAX_SANDBOXES`. */
  readonly runnerSlots: number;
  /** How long the fake runner takes for one run, in milliseconds. */
  readonly runMs: number;
  /** How often the test polls each project's GitHub stub, in milliseconds. */
  readonly pollMs: number;
  /** The whole test gives up after this many milliseconds. */
  readonly timeoutMs: number;
}

function positive(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`${name} must be a positive integer`);
  return value;
}

export function loadSettings(): LoadSettings {
  return {
    tenants: positive('SDLC_LOAD_TENANTS', 20),
    intentsPerTenant: positive('SDLC_LOAD_INTENTS', 25),
    runnerSlots: positive('SDLC_LOAD_RUNNER_SLOTS', 2),
    runMs: positive('SDLC_LOAD_RUN_MS', 1000),
    pollMs: positive('SDLC_LOAD_POLL_MS', 2000),
    timeoutMs: positive('SDLC_LOAD_TIMEOUT_MINUTES', 60) * 60_000,
  };
}

/**
 * The project configuration: the shortest HOTL block window (one minute), so G5 → G6 and G6 → G7
 * wait one minute of real time each, like the pilot (C09).
 */
function projectConfig(agentKey: string): string {
  return [
    'oversight:',
    '  hotl_block_window: { value: 1, unit: minutes }',
    'run:',
    `  agent_key: ${agentKey}`,
    '',
  ].join('\n');
}

/** Counts of the fake Git host calls (the G4–G8 reads that do not go through the poller). */
export type FakeCalls = Record<string, number>;

/** One tenant: its fixture (project, people, GitHub stub, poller) and its pull requests. */
export class LoadTenant {
  readonly prs = new Map<number, { merged: boolean; intentId: string }>();
  readonly fakeCalls: FakeCalls = {};

  constructor(readonly f: WorkflowFixture) {}

  count(name: string): void {
    this.fakeCalls[name] = (this.fakeCalls[name] ?? 0) + 1;
  }

  pr(number: number): PullRequestInfo {
    const merged = this.prs.get(number)?.merged ?? false;
    return {
      number,
      state: merged ? 'closed' : 'open',
      draft: false,
      merged,
      mergedAt: merged ? new Date().toISOString() : null,
      mergeCommitSha: merged ? 'a'.repeat(40) : null,
      headSha: HEAD,
      headRef: 'agent/INT-x',
      baseRef: 'main',
      author: { id: '1', login: 'sdlc[bot]', type: 'bot' },
      mergedBy: merged ? { id: String(PEOPLE.b.gh), login: PEOPLE.b.login, type: 'user' } : null,
      changedFiles: 1,
      url: `https://github.com/acme/shop/pull/${String(number)}`,
    };
  }

  /** Person B's review of the pushed commit, on every pull request (E01). */
  review(number: number): ReviewDecision {
    return {
      eventId: `github:review:${String(number)}`,
      reviewId: String(number),
      reviewer: { id: String(PEOPLE.b.gh), login: PEOPLE.b.login, type: 'user' },
      state: 'approved',
      commitSha: HEAD,
      submittedAt: new Date(Date.now() - 1000).toISOString(),
      url: `https://github.com/acme/shop/pull/${String(number)}#pullrequestreview-${String(number)}`,
    };
  }

  ref(intent: Pick<Intent, 'id'>): IntentWorkflowRef {
    return { tenantId: this.f.target.tenantId, intentId: intent.id };
  }
}

export class LoadStack {
  db!: TestDatabase;
  temporal!: TemporalClient;
  signals!: TemporalIntentSignals;
  readonly tenants: LoadTenant[] = [];
  readonly evidence = new MemoryEvidenceStore();
  /** Runs the fake runner executed and pushed, and its busiest moment. */
  readonly runner = { executed: 0, pushed: 0, active: 0, maxActive: 0 };
  readonly #tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-load-'));
  readonly #envFile = path.join(this.#tmp, 'load.env');
  readonly #project = `sdlcload${process.pid}`;
  readonly #intentWorkers: IntentWorkerHandle[] = [];
  #runnerWorker: Worker | undefined;
  #runnerRunning: Promise<void> | undefined;
  #runnerConnection: NativeConnection | undefined;
  #byTenant = new Map<string, LoadTenant>();

  constructor(readonly settings: LoadSettings) {}

  /** The Temporal container's name (for `docker stats`). */
  get temporalContainer(): string {
    return `${this.#project}-temporal-1`;
  }

  #compose(...args: string[]) {
    return spawnSync(
      'docker',
      [
        'compose',
        '-f',
        path.join(deployDir, 'docker-compose.yml'),
        '--env-file',
        this.#envFile,
        ...args,
      ],
      { encoding: 'utf8' },
    );
  }

  async start(): Promise<void> {
    const init = spawnSync(path.join(deployDir, 'scripts/init-env.sh'), [this.#envFile], {
      encoding: 'utf8',
    });
    if (init.status !== 0) throw new Error(`init-env failed: ${init.stderr}`);
    const subnet = `172.30.${200 + (process.pid % 25)}.0/24`;
    fs.writeFileSync(
      this.#envFile,
      isolateEnv(fs.readFileSync(this.#envFile, 'utf8'), {
        project: this.#project,
        subnet,
        gateway: subnet.replace(/0\/24$/, '1'),
        portOffset: PORT_OFFSET,
      }),
      { mode: 0o600 },
    );
    for (const args of [
      ['--profile', 'core', 'up', '-d', '--wait', 'temporal'],
      ['--profile', 'core', 'run', '--rm', 'temporal-namespace'],
    ]) {
      const result = this.#compose(...args);
      if (result.status !== 0) throw new Error(`compose ${args.join(' ')}: ${result.stderr}`);
    }
    this.db = await createTestDatabase();
    const address = `127.0.0.1:${String(7233 + PORT_OFFSET)}`;
    this.temporal = await connectTemporal({ address, namespace: 'default' });
    this.signals = new TemporalIntentSignals(this.temporal.client);
    for (let i = 0; i < this.settings.tenants; i += 1) await this.#addTenant(i);
    const { code } = await bundleWorkflowCode({ workflowsPath: WORKFLOWS });
    const bundlePath = path.join(this.#tmp, 'bundle.js');
    fs.writeFileSync(bundlePath, code);
    this.#intentWorkers.push(
      await startIntentWorker({
        settings: { address, namespace: 'default' },
        workflowBundlePath: bundlePath,
        activities: createIntentActivities(this.#activityDeps()),
      }),
    );
    this.#runnerConnection = await NativeConnection.connect({ address });
    this.#runnerWorker = await Worker.create({
      connection: this.#runnerConnection,
      namespace: 'default',
      taskQueue: RUNNER_TASK_QUEUE,
      activities: {
        executeRun: (input: ExecuteRunInput) => this.#executeRun(input),
        publishRun: (input: PublishRunInput) => this.#publishRun(input),
      },
      maxConcurrentActivityTaskExecutions: this.settings.runnerSlots,
    });
    this.#runnerRunning = this.#runnerWorker.run();
  }

  async stop(): Promise<void> {
    this.#runnerWorker?.shutdown();
    await this.#runnerRunning?.catch(() => undefined);
    await this.#runnerConnection?.close();
    for (const worker of this.#intentWorkers) await worker.shutdown().catch(() => undefined);
    await this.temporal?.close();
    for (const tenant of this.tenants) await tenant.f.close();
    await this.db?.drop();
    this.#compose('--profile', 'core', 'down', '-v', '--remove-orphans');
    fs.rmSync(this.#tmp, { recursive: true, force: true });
  }

  async #addTenant(index: number): Promise<void> {
    const f = await createWorkflowFixture(this.db, () => new Date(), {
      tenantSlug: `load-${String(index)}`,
    });
    f.h.stub.now = new Date();
    const agent = await seedAgent(f.scope, f.users.a, {
      model: MODEL,
      instructionsSha256: sha256(AGENTS_MD),
      tools: ['file_editor', 'terminal'],
    });
    const yaml = projectConfig(agent.key);
    const loaded = loadProjectConfig(yaml);
    if (!loaded.ok) throw new Error('load test configuration refused');
    await f.scope.projectConfigs.save(f.target.projectId, {
      configYaml: yaml,
      configHash: loaded.configHash,
      updatedBy: null,
      expectedVersion: 0,
    });
    const tenant = new LoadTenant(f);
    this.tenants.push(tenant);
    this.#byTenant.set(f.target.tenantId, tenant);
  }

  /** The tenant of a run (the fake runner gets IDs only, like the real one). */
  async #tenantOfRun(runId: string): Promise<LoadTenant> {
    for (const tenant of this.tenants) {
      if (await tenant.f.scope.runs.getById(runId)) return tenant;
    }
    throw new Error('run of no tenant');
  }

  /** The G4–G8 dependencies: one set for every tenant, each call routed by the tenant. */
  #activityDeps(): IntentActivityDeps {
    const tenantOf = (ref: { readonly owner: string; readonly name: string }, n: number) => {
      // Every tenant's repository is `acme/shop`: the pull request number tells them apart.
      void ref;
      const tenant = this.tenants.find((t) => t.prs.has(n));
      if (!tenant) throw new Error('pull request of no tenant');
      return tenant;
    };
    const anyTenant = this.tenants[0]!;
    const g4: G4Deps = {
      gitHost: {
        getBranchHead: () => {
          anyTenant.count('getBranchHead');
          return Promise.resolve(BASE);
        },
        getFileAtCommit: () => {
          anyTenant.count('getFileAtCommit');
          return Promise.resolve(AGENTS_MD);
        },
        listPaths: () => {
          anyTenant.count('listPaths');
          return Promise.resolve(['AGENTS.md', 'src/main.ts']);
        },
      },
      allowedModels: () => Promise.resolve([MODEL]),
      tenantMonthlyBudget: () => Promise.resolve(null),
    };
    const calls: RunCalls = { keys: [], revoked: [], wrapped: [], refuseKey: undefined };
    const runs = fakeRunDeps(anyTenant.f, g4, calls);
    const publish: PublishDeps = {
      registry: anyTenant.f.registry,
      gitHost: {
        issueShortLivedToken: (repo, scope) =>
          Promise.resolve({
            token: new Secret('ghs_push_token'),
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            repo,
            permissions: scope.permissions,
          }),
        findOpenPullRequest: () => Promise.resolve(null),
        openPullRequest: () => {
          throw new Error('replaced per tenant');
        },
      },
      wrapper: { wrap: () => Promise.resolve(new Secret('push-wrap')) },
    };
    return {
      db: this.db.app as unknown as IntentActivityDeps['db'],
      registry: anyTenant.f.registry as unknown as IntentActivityDeps['registry'],
      g4,
      runs: runs as unknown as IntentActivityDeps['runs'],
      publish: {
        ...publish,
        gitHost: {
          ...publish.gitHost,
          // The body names the run (`<!-- sdlc:intent=… run=… -->`): its tenant opens it.
          openPullRequest: (_ref: unknown, input: { readonly body: string }) =>
            this.#openPullRequest(input.body),
        },
      } as unknown as IntentActivityDeps['publish'],
      g6: {
        gitHost: {
          getPullRequest: (r: { owner: string; name: string }, n: number) => {
            const tenant = tenantOf(r, n);
            tenant.count('getPullRequest');
            return Promise.resolve(tenant.pr(n));
          },
          getCheckStatus: (_r: unknown, sha: string) => {
            anyTenant.count('getCheckStatus');
            return Promise.resolve({
              sha,
              state: 'success',
              checks: [
                {
                  source: 'check_run',
                  id: '1',
                  name: 'ci-ok',
                  completed: true,
                  conclusion: 'success',
                },
              ],
            });
          },
          getSecurityFindings: () => {
            anyTenant.count('getSecurityFindings');
            return Promise.resolve({
              known: true,
              counts: { critical: 0, high: 0, medium: 0, low: 0 },
            });
          },
        },
      } as unknown as IntentActivityDeps['g6'],
      g7: {
        gitHost: {
          getPullRequest: (r: { owner: string; name: string }, n: number) => {
            const tenant = tenantOf(r, n);
            tenant.count('getPullRequest');
            return Promise.resolve(tenant.pr(n));
          },
          getReviews: (r: { owner: string; name: string }, n: number) => {
            const tenant = tenantOf(r, n);
            tenant.count('getReviews');
            return Promise.resolve([tenant.review(n)]);
          },
          getCommitAuthors: (r: { owner: string; name: string }, n: number) => {
            tenantOf(r, n).count('getCommitAuthors');
            return Promise.resolve({ accounts: [], withoutAccount: 1 });
          },
        },
      },
      releases: { store: this.evidence, maxItemBytes: 1024 * 1024 },
    };
  }

  /** The pushed runs by ID, with their tenant and intent. */
  readonly #pushed = new Map<string, { tenant: LoadTenant; intentId: string }>();
  /** Pull request numbers, unique across the tenants (every repository is `acme/shop`). */
  #prCounter = 100;

  #openPullRequest(body: string): Promise<PullRequestInfo> {
    const runId = / run=([0-9a-f-]{36}) -->/.exec(body)?.[1];
    const pushed = runId === undefined ? undefined : this.#pushed.get(runId);
    if (!pushed) return Promise.reject(new Error('a pull request of no pushed run'));
    this.#prCounter += 1;
    const number = this.#prCounter;
    pushed.tenant.prs.set(number, { merged: false, intentId: pushed.intentId });
    pushed.tenant.count('openPullRequest');
    return Promise.resolve(pushed.tenant.pr(number));
  }

  /** The fake runner's run: claims it, waits `runMs`, ends it in scope (what C07 records). */
  async #executeRun(input: ExecuteRunInput): Promise<ExecuteRunResult> {
    const tenant = this.#byTenant.get(input.tenantId) ?? (await this.#tenantOfRun(input.runId));
    const scope = tenant.f.scope;
    this.runner.active += 1;
    this.runner.maxActive = Math.max(this.runner.maxActive, this.runner.active);
    try {
      const now = new Date();
      await scope.runs.claimForProvisioning(input.runId, now);
      await scope.runs.transition(input.runId, { from: ['provisioning'], to: 'running', now });
      await new Promise((resolve) => setTimeout(resolve, this.settings.runMs));
      await scope.transaction(async (tx) => {
        await tx.runEvents.append(input.runId, 'diff_stored', {
          sha256: 'd'.repeat(64),
          size_bytes: 64,
          changed_files: 1,
        });
        await tx.runEvents.append(input.runId, 'changes_checked', {
          changed_files: 1,
          out_of_scope: 0,
          instruction_files: 0,
          paths_sha256: 'a'.repeat(64),
        });
        await tx.runEvents.append(input.runId, 'secrets_scanned', {
          result: 'clean',
          findings: 0,
          rules: 'built_in',
        });
        await tx.runEvents.append(input.runId, 'diff_measured', {
          result: 'measured',
          review_files: 1,
          review_lines: 2,
          generated_files: 0,
          generated_lines: 0,
          binary_files: 0,
        });
      });
      await scope.runs.transition(input.runId, {
        from: ['running'],
        to: 'succeeded',
        now: new Date(),
        finishedAt: new Date(),
      });
      this.runner.executed += 1;
      return { outcome: 'ended', status: 'succeeded', stopReason: null };
    } finally {
      this.runner.active -= 1;
    }
  }

  /** The fake runner's push: records `branch_pushed` and the head, as `publishRun` does. */
  async #publishRun(input: PublishRunInput): Promise<PublishRunResult> {
    const tenant = this.#byTenant.get(input.tenantId) ?? (await this.#tenantOfRun(input.runId));
    const scope = tenant.f.scope;
    const run = await scope.runs.getById(input.runId);
    if (!run) throw new Error('unknown run');
    await scope.transaction(async (tx) => {
      await tx.runEvents.append(input.runId, 'branch_pushed', {
        head_sha: HEAD,
        parent_sha: run.base_sha,
        diff_sha256: 'd'.repeat(64),
        paths_sha256: 'a'.repeat(64),
      });
      await tx.runs.recordPushedHead(input.runId, HEAD, new Date());
    });
    this.#pushed.set(input.runId, { tenant, intentId: run.intent_id });
    this.runner.pushed += 1;
    return { outcome: 'pushed' };
  }
}
