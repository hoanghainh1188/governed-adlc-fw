// The runner process's view of its sandboxes (D-08 C04 AC3, AC5; ADR-M25 §2.7, §2.8).
//
// - Every provisioning waits for a slot of the pool (`SDLC_RUNNER_MAX_SANDBOXES`, FIFO). The slot
//   is held while the sandbox lives and freed by `release`, or at once when provisioning fails.
// - Runs are held (`HeldRuns`) from just before their workspace is reserved until `release`; the
//   sweep never touches a held run.
// - `start` cleans up after the previous process (`reconcileOnStart`) and then sweeps at the
//   configured interval. A sweep error never stops the process.
//
// The Temporal task queue `sdlc-runner` with one heartbeat activity per run (QUESTIONS #53) is
// wired in C06, where the worker side exists (D-08 C06, ADR-M25 §2.7).
import fs from 'node:fs';

import { createSimplePolicyEngine } from '@sdlc/adapter-policy-simple';
import type {
  AgentFileReads,
  EvidenceStore,
  RedactedSecret,
  RunKeySpendReader,
} from '@sdlc/contracts';
import { loadEffectiveConfig, parseTenantId } from '@sdlc/core';

import {
  driveAgent,
  type AgentDriveDeps,
  type AgentRunRequest,
  type AgentRunResult,
} from './agent/drive.js';
import { adapterCodes, adapterFor, type AgentAdapters } from './agent/adapters.js';
import { discardFeedbackToken } from './agent/feedback.js';
import { RunnerError } from './errors.js';
import { HeldRuns } from './held.js';
import { SlotPool, type Slot } from './pool.js';
import {
  provisionRun,
  releaseSandbox,
  type ProvisionRequest,
  type ProvisionResult,
  type RunnerDeps,
} from './provision.js';
import { reconcileOnStart, sweepOrphans, type ReconcileResult } from './reconcile.js';
import type { TeardownReason } from './sandbox/lifecycle.js';
import { storeChanges } from './workspace/changes.js';
import { storeProposal } from './workspace/export.js';
import { memoryFilesReader } from './workspace/memory-files.js';
import { planFileReader } from './workspace/plan-file.js';

export interface RunnerHooks {
  /** Called after each clean-up (start or sweep); `main` writes the heartbeat file here. */
  readonly onCleanUp?: (kind: 'start' | 'sweep', result: ReconcileResult) => void;
  /** Called when a sweep fails as a whole (Docker unreachable); the next sweep tries again. */
  readonly onSweepError?: (error: unknown) => void;
}

export interface RunnerAgentOptions {
  /**
   * The agent adapters by code (X03): a run is driven by the adapter its contract names. Needed for
   * `runAgent`; provisioning refuses a contract whose adapter is missing (`adapter_unavailable`).
   */
  readonly adapters?: AgentAdapters;
  /** Tests only: reach the Agent Server another way than on the run's network. */
  readonly agentUrl?: (runId: string) => string;
  /**
   * Where L1 proposals go (C06 session 2b, ADR-M33 §2.9): the evidence store with the runner's
   * write-only credential. Without it an L1 run that finished fails (`proposal_unavailable`).
   */
  readonly evidence?: EvidenceStore;
  /**
   * Where run diffs go (C07, ADR-M34 §2.2): the same credential, key prefix `diffs/`. Without it
   * a run that would go to G5 fails (`changes_unavailable`).
   */
  readonly diffEvidence?: EvidenceStore;
  /** Reads the spend of a run's key with the key itself (C07, ADR-M34 §2.6). */
  readonly spendReader?: RunKeySpendReader;
  /** True once the gateway refuses a run's key (C11): before a killed run's diff is stored. */
  readonly keyRevoked?: (key: RedactedSecret) => Promise<boolean>;
}

export class Runner {
  readonly held = new HeldRuns();
  readonly pool: SlotPool;
  readonly #deps: RunnerDeps;
  readonly #hooks: RunnerHooks;
  readonly #agent: RunnerAgentOptions;
  readonly #slots = new Map<string, Slot>();
  /** The runner's own clones of the runs, kept until release (C06 session 2b, C07). */
  readonly #clones = new Map<string, string>();
  #timer: NodeJS.Timeout | undefined;
  #sweeping: Promise<void> | undefined;

  constructor(
    deps: Omit<RunnerDeps, 'held'>,
    hooks: RunnerHooks = {},
    agent: RunnerAgentOptions = {},
  ) {
    this.#deps = {
      ...(agent.adapters ? { agentAdapters: adapterCodes(agent.adapters) } : {}),
      // X04 PR 3b: the `knowledge_read` lists go with the run's diffs (same credential).
      ...(agent.diffEvidence ? { knowledgeEvidence: agent.diffEvidence } : {}),
      ...deps,
      held: this.held,
    };
    this.#hooks = hooks;
    this.#agent = agent;
    this.pool = new SlotPool(deps.settings.maxSandboxes, deps.settings.maxEvalSandboxes);
  }

  /** Cleans up after the previous process, then sweeps at the configured interval. */
  async start(): Promise<ReconcileResult> {
    const result = await reconcileOnStart(this.#deps);
    this.#hooks.onCleanUp?.('start', result);
    // The timer keeps the process alive until `stop`.
    this.#timer = setInterval(() => void this.sweep(), this.#deps.settings.sweepIntervalMs);
    return result;
  }

  /** One sweep; overlapping calls share the running one. */
  sweep(): Promise<void> {
    this.#sweeping ??= sweepOrphans(this.#deps, this.held)
      .then((result) => this.#hooks.onCleanUp?.('sweep', result))
      .catch((error: unknown) => this.#hooks.onSweepError?.(error))
      .finally(() => {
        this.#sweeping = undefined;
      });
    return this.#sweeping;
  }

  /** Waits for a free slot, then provisions. The slot stays taken until `release`. */
  async provision(request: ProvisionRequest, signal?: AbortSignal): Promise<ProvisionResult> {
    const slot = await this.pool.acquire(signal);
    let result: ProvisionResult | undefined;
    try {
      result = await provisionRun(this.#deps, request);
    } finally {
      if (result?.ok) {
        this.#slots.set(result.contract.run_id, slot);
        this.#clones.set(result.contract.run_id, result.cloneDir);
      } else {
        slot.release();
      }
    }
    return result;
  }

  /**
   * Runs the agent of a provisioned run to its end (C05, ADR-M29), then removes the sandbox and
   * frees the slot, whatever happened. The run's virtual key is the caller's to revoke
   * (`CostController.endRun`).
   */
  /**
   * E01 PR 2 (review): revokes a run's feedback token that the run will not use (provisioning
   * refused, the run killed or failed before the agent started). Never throws.
   */
  async discardFeedbackToken(
    tenantId: string,
    runId: string,
    wrappedToken: RedactedSecret,
  ): Promise<void> {
    await discardFeedbackToken(this.#deps.db.forTenant(parseTenantId(tenantId)), runId, {
      reader: this.#deps.feedbackReader,
      unwrapper: this.#deps.unwrapper,
      wrappedToken,
    });
  }

  async runAgent(request: AgentRunRequest): Promise<AgentRunResult> {
    const { contract } = request;
    const adapter = adapterFor(this.#agent.adapters, contract.agent_adapter);
    if (!adapter) throw new RunnerError('runner.agent_not_configured');
    let result: AgentRunResult | undefined;
    try {
      result = await driveAgent(
        {
          db: this.#deps.db,
          docker: this.#deps.docker,
          settings: this.#deps.settings,
          adapter,
          ...(this.#deps.now ? { now: this.#deps.now } : {}),
          ...(this.#agent.agentUrl ? { agentUrl: this.#agent.agentUrl } : {}),
          ...this.#proposalFor(contract.run_id),
          ...this.#changesFor(contract.run_id),
          ...(this.#agent.spendReader ? { spendReader: this.#agent.spendReader } : {}),
          ...(this.#agent.keyRevoked ? { keyRevoked: this.#agent.keyRevoked } : {}),
          // E01 PR 2: the feedback of a request for changes, read with the run's own token.
          ...(this.#deps.feedbackReader ? { feedbackReader: this.#deps.feedbackReader } : {}),
          unwrapper: this.#deps.unwrapper,
          ...this.#planFileFor(contract.run_id),
        },
        request,
      );
      return result;
    } finally {
      await this.release(
        contract.tenant_id,
        contract.run_id,
        result?.outcome === 'finished'
          ? 'finished'
          : result?.outcome === 'killed'
            ? 'killed'
            : 'failed',
        result?.reads,
      );
    }
  }

  /** B09 PR 2: the plan file reader of a run whose clone this process kept. */
  #planFileFor(runId: string): Pick<AgentDriveDeps, 'planFile' | 'memoryFiles'> {
    const cloneDir = this.#clones.get(runId);
    if (!cloneDir) return {};
    const timeoutMs = this.#deps.settings.git.timeoutMs;
    return {
      planFile: planFileReader(cloneDir, timeoutMs),
      // X13 PR 2: the memory notes come from the same kept clone.
      memoryFiles: memoryFilesReader(cloneDir, timeoutMs),
    };
  }

  /** The proposal step of an L1 run whose clone this process kept (C06 session 2b). */
  #proposalFor(runId: string): Pick<AgentDriveDeps, 'proposal'> {
    const cloneDir = this.#clones.get(runId);
    const evidence = this.#agent.evidence;
    if (!cloneDir || !evidence) return {};
    const deps = { db: this.#deps.db, docker: this.#deps.docker, settings: this.#deps.settings };
    return {
      proposal: async (contract) => {
        const stored = await storeProposal({ ...deps, evidence }, contract, cloneDir);
        return { changedFiles: stored.changedFiles };
      },
    };
  }

  /**
   * The changes step of a run whose clone this process kept (C07): the diff as evidence, checked
   * with the project's policy engine against the contract's plan.
   */
  #changesFor(runId: string): Pick<AgentDriveDeps, 'changes'> {
    const cloneDir = this.#clones.get(runId);
    const evidence = this.#agent.diffEvidence;
    if (!cloneDir || !evidence) return {};
    const { db, docker, settings } = this.#deps;
    return {
      changes: async (contract) => {
        const scope = db.forTenant(parseTenantId(contract.tenant_id));
        const { config } = await loadEffectiveConfig(scope.projectConfigs, contract.project_id);
        const policy = createSimplePolicyEngine({ config });
        const checked = await storeChanges(
          // X13 PR 3a: the memory configuration decides whether the memory part is split out.
          { db, docker, settings, evidence, policy, memory: config.memory },
          contract,
          cloneDir,
        );
        return { changedFiles: checked.changedFiles };
      },
    };
  }

  /** Removes the sandbox of a run (end of run, kill) and frees its slot. */
  async release(
    tenantId: string,
    runId: string,
    reason: TeardownReason,
    reads?: AgentFileReads,
  ): Promise<void> {
    try {
      // X07: `reads` (the files the agent's log shows) go to the run's context snapshot.
      await releaseSandbox(this.#deps, tenantId, runId, reason, reads);
    } finally {
      // Also after a failed clean-up: the sweep then retries the objects.
      this.held.release(runId);
      this.#slots.get(runId)?.release();
      this.#slots.delete(runId);
      const clone = this.#clones.get(runId);
      if (clone) fs.rmSync(clone, { recursive: true, force: true });
      this.#clones.delete(runId);
    }
  }

  /** Stops the sweep timer and waits for a running sweep. Sandboxes are left for the next start. */
  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#sweeping;
  }
}
