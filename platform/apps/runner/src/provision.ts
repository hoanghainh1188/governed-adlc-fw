// The runner's provisioning flow for one run (D-08 C04, ADR-M25 §2.8). Order:
//
// 1. verify the Run Contract (ADR-M22): refused contracts are recorded by `verifyRunContract`;
// 2. hold the run in this process and reserve its labelled workspace volume, so a crash after the
//    claim always leaves an object the clean-up can find (ADR-M25 §2.8);
// 3. claim the run `queued → provisioning` with one conditional update (QUESTIONS #35);
// 4. unwrap the GitHub token the worker handed over (QUESTIONS #44);
// 5. check that the contract's egress list can be enforced;
// 6. clone at `base_sha`, create `agent/INT-…`, pack the workspace          → `workspace_prepared`;
//    the GitHub token is revoked as soon as the clone ended (C11)           → `token_revoked`;
//    a run killed meanwhile (`stopping`) stops here, before any sandbox;
// 7. create the sandbox (network, services, register tools and their MCP gateway (X04, ADR-M69
//    §2.4) → `tool_started` each, container, archive)                      → `sandbox_created`;
// 8. wait for the sandbox health check, then `provisioning → running`       → `sandbox_ready`.
//
// A failure after the claim removes everything created (the reserved volume included), records
// `provisioning_failed` (and `sandbox_removed` when a sandbox was created), and ends the run as
// `failed` with the reason as `stop_reason` (`stopped_killed` / `killed` when it was killed,
// C11); the clone on the runner's disk is removed then. A run
// that starts keeps its clone until the caller releases it: the proposal of an L1 run (C06 2b)
// and the diff of every run (C07, ADR-M34 §2.2) are computed there. The token lives only in
// memory, and in git's environment for the clone.
import fs from 'node:fs';
import path from 'node:path';

import {
  KNOWLEDGE_DATABASE,
  knowledgeSchema,
  codeIndexSchema,
  CODE_INDEX_FORMAT,
  sandboxImageFor,
  type AgentAdapterCode,
  type AgentFileReads,
  type EvidenceStore,
  type ProjectConfig,
  type RedactedSecret,
  type RunContract,
  type RunContractRejectReason,
  type RunContractVerifier,
  type SecretUnwrapper,
  type ToolGrant,
} from '@sdlc/contracts';
import {
  loadEffectiveConfig,
  parseTenantId,
  verifyRunContract,
  type PlatformDatabase,
  type TenantScope,
} from '@sdlc/core';

import type { DockerClient } from './docker/client.js';
import { RunnerError } from './errors.js';
import type { HeldRuns } from './held.js';
import {
  createSandbox,
  ProvisioningError,
  releaseWorkspace,
  reserveWorkspace,
  teardownSandbox,
  type ProvisioningFailure,
  type Sandbox,
  type TeardownReason,
} from './sandbox/lifecycle.js';
import { planEgress } from './sandbox/network.js';
import type { RunnerSettings } from './settings.js';
import type { RunNames } from './names.js';
import { startTools, toolGrantsEnforceable, type ToolRuntime } from './tools/provision.js';
import { recordContextSnapshot } from './snapshot/context.js';
import { recordKnowledgeRead } from './tools/knowledge-read.js';
import { recordToolUse } from './tools/record.js';
import type { ToolLimits } from './tools/spec.js';
import {
  isRefusedWrapToken,
  recordWrapTokenReused,
  revokeAfterUse,
  type GitTokenRevoker,
} from './tokens.js';
import type { FeedbackReader } from './agent/feedback.js';
import { CloneError, cloneForRun } from './workspace/git.js';
import { packDirectory } from './workspace/tar.js';

export interface RunnerDeps {
  readonly db: PlatformDatabase;
  readonly docker: DockerClient;
  readonly settings: RunnerSettings;
  readonly verifier: RunContractVerifier;
  readonly unwrapper: SecretUnwrapper;
  /**
   * Runs this process holds (ADR-M25 §2.8): a second provisioning of a held run is refused before
   * Docker, and the sweep skips held runs. One runner process per instance label: the clean-up at
   * start removes every object of the instance.
   */
  readonly held: HeldRuns;
  /** Default: `new Date()`. */
  readonly now?: () => Date;
  /**
   * Revokes the clone token right after the clone (C11, ADR-M42 §2.4). Without it the token
   * expires by itself (development, tests).
   */
  readonly tokenRevoker?: GitTokenRevoker;
  /**
   * E01 PR 2: reads the feedback of a request for changes with the run's own feedback token (the
   * token-only GitHub adapter, like `tokenRevoker`). Without it such a run fails.
   */
  readonly feedbackReader?: FeedbackReader;
  /**
   * X03: the codes of the agent adapters this runner has. A contract that names another adapter
   * fails before the clone (`adapter_unavailable`). Undefined: not checked (provisioning tests).
   */
  readonly agentAdapters?: readonly AgentAdapterCode[];
  /** X04 PR 3b: where the `knowledge_read` lists go (the runner's diff evidence store). */
  readonly knowledgeEvidence?: EvidenceStore;
}

export interface ProvisionRequest {
  /** `{ contract, signature }` from the worker (ADR-M22). */
  readonly envelope: unknown;
  /** Single-use OpenBao wrapping token around `{ token }` (QUESTIONS #44). */
  readonly wrappedGitToken: RedactedSecret;
  /**
   * X04 PR 3b: by tool key, the single-use wrapping token around a `read_documents` tool's
   * `{ db_username, db_password, llm_key }` and the index version it reads.
   */
  readonly toolSecrets?: ReadonlyMap<
    string,
    { readonly wrapped: RedactedSecret; readonly indexId: string }
  >;
}

export type ProvisionResult =
  | {
      readonly ok: true;
      readonly contract: RunContract;
      readonly sandbox: Sandbox;
      /**
       * The runner's own clone of the run (`<workDir>/run-…` with `repo` and `home`), kept until
       * the run ends to compute its changes outside the sandbox: the L1 proposal (C06 session 2b,
       * ADR-M33 §2.9) and the diff of every run (C07, ADR-M34 §2.2). The caller removes it.
       */
      readonly cloneDir: string;
    }
  | {
      readonly ok: false;
      readonly reason: RunContractRejectReason | ProvisioningFailure;
      readonly runId?: string;
    };

const HEALTH_POLL_MS = 500;

function clock(deps: RunnerDeps): Date {
  return deps.now ? deps.now() : new Date();
}

function failureOf(error: unknown): ProvisioningFailure {
  if (error instanceof ProvisioningError) return error.reason;
  if (error instanceof CloneError) return error.reason;
  if (error instanceof RunnerError) {
    if (error.key === 'runner.workspace.too_large') return 'workspace_too_large';
    if (error.key === 'runner.workspace.special_file') return 'workspace_invalid';
    if (error.key === 'runner.workspace.path_escape') return 'workspace_invalid';
  }
  return 'docker_error';
}

export async function provisionRun(
  deps: RunnerDeps,
  request: ProvisionRequest,
): Promise<ProvisionResult> {
  const verified = await verifyRunContract(deps.db, request.envelope, {
    verifier: deps.verifier,
    // X04 (ADR-M69 §2.6): grants this runner can turn into the gateway's configuration, with only
    // the backing services it was configured with (X04 PR 3b).
    toolGrantsEnforceable: (grants) => toolGrantsEnforceable(grants, deps.settings.toolServices),
    ...(deps.now ? { now: deps.now } : {}),
  });
  if (!verified.ok) {
    return {
      ok: false,
      reason: verified.reason,
      ...(verified.runId ? { runId: verified.runId } : {}),
    };
  }
  const { contract } = verified;
  const runId = contract.run_id;
  const scope = deps.db.forTenant(parseTenantId(contract.tenant_id));
  if (!deps.held.hold(runId)) {
    return { ok: false, reason: 'run_not_startable', runId };
  }
  let reserved: 'created' | 'existed';
  try {
    reserved = await reserveWorkspace(deps.docker, deps.settings, runId, contract.tenant_id);
  } catch {
    // Nothing is claimed yet: the run stays `queued` for another attempt.
    deps.held.release(runId);
    return { ok: false, reason: 'docker_error', runId };
  }
  if (!(await scope.runs.claimForProvisioning(runId, clock(deps)))) {
    if (reserved === 'created') await releaseWorkspace(deps.docker, runId).catch(() => undefined);
    deps.held.release(runId);
    return { ok: false, reason: 'run_not_startable', runId };
  }

  const workDir = fs.mkdtempSync(path.join(ensureDir(deps.settings.workDir), 'run-'));
  // The clone stays for the run's changes (C06 2b, C07); the token was only in git's environment.
  let kept = false;
  let sandboxCreated = false;
  try {
    const token = await unwrapToken(deps.unwrapper, request.wrappedGitToken, () =>
      // The contract is valid, so the wrapping token should be too: someone else opened it.
      recordWrapTokenReused(scope, runId, 'clone'),
    );
    let repoDir: string;
    let image: string;
    let tools: ToolSetup | undefined;
    let cloneStarted: number;
    try {
      if (!planEgress(contract.egress_allowlist, deps.settings.egressServices).ok) {
        throw new ProvisioningError('egress_not_enforceable');
      }
      if (deps.agentAdapters && !deps.agentAdapters.includes(contract.agent_adapter)) {
        throw new ProvisioningError('adapter_unavailable');
      }
      image = await projectImage(scope, contract.project_id, contract.agent_adapter);
      tools = await toolSetup(scope, contract, deps, request);
      cloneStarted = Date.now();
      repoDir = await cloneForRun(deps.settings.git, {
        repo: contract.repo,
        baseSha: contract.base_sha,
        branch: contract.branch,
        token,
        dir: workDir,
      });
    } finally {
      // The run needs GitHub only for the clone (C11): the token ends here, whatever happened.
      await revokeAfterUse(deps.tokenRevoker, scope, runId, token, 'clone');
    }
    // Killed during the clone (C11): stop before a sandbox exists.
    if ((await scope.runs.getById(runId))?.status === 'stopping') {
      throw new ProvisioningError('run_stopped');
    }
    const workspaceTar = packDirectory(repoDir, deps.settings.workspaceMaxBytes);
    await scope.runEvents.append(runId, 'workspace_prepared', {
      base_sha: contract.base_sha,
      duration_ms: Date.now() - cloneStarted,
    });

    const startStarted = Date.now();
    sandboxCreated = true;
    const sandbox = await createSandbox(deps.docker, deps.settings, {
      runId: runId,
      tenantId: contract.tenant_id,
      image,
      adapter: contract.agent_adapter,
      egressAllowlist: contract.egress_allowlist,
      workspaceTar,
      workspaceReserved: true,
      ...(tools === undefined ? {} : { startTools: startToolsOf(deps, scope, runId, tools) }),
    });
    await scope.runEvents.append(runId, 'sandbox_created', {
      image_sha256: sandbox.imageSha256,
    });
    await waitUntilHealthy(deps, sandbox.containerId);
    const now = clock(deps);
    if (
      !(await scope.runs.transition(runId, {
        from: ['provisioning'],
        to: 'running',
        now,
        startedAt: now,
      }))
    ) {
      // Stopped meanwhile (kill switch, C11): do not keep the sandbox.
      throw new ProvisioningError('run_stopped');
    }
    await scope.runEvents.append(runId, 'sandbox_ready', {
      duration_ms: Date.now() - startStarted,
    });
    kept = true;
    return { ok: true, contract, sandbox, cloneDir: workDir };
  } catch (error) {
    const reason = failureOf(error);
    try {
      await failRun(deps, scope, runId, reason, sandboxCreated);
    } finally {
      deps.held.release(runId);
    }
    return { ok: false, reason, runId };
  } finally {
    if (!kept) fs.rmSync(workDir, { recursive: true, force: true });
  }
}

/**
 * Removes the sandbox of a run and records `sandbox_removed` (D-08 C04 AC5). For the end of a run
 * (C05), a kill (C11) or a failure. The run status is the caller's: this only cleans up.
 */
export async function releaseSandbox(
  deps: RunnerDeps,
  tenantId: string,
  runId: string,
  reason: TeardownReason,
  reads?: AgentFileReads,
): Promise<void> {
  const scope = deps.db.forTenant(parseTenantId(tenantId));
  // X04 (ADR-M69 §2.7): the tool counts are read from the gateway before it is removed. A failure
  // to record them never keeps the sandbox.
  await recordToolUse(deps.docker, scope, runId).catch(() => undefined);
  // X04 PR 3b (ADR-M89 §2.5): what the `read_documents` tools returned, from their own logs.
  await recordKnowledgeRead(deps.docker, scope, deps.knowledgeEvidence, runId).catch(
    () => undefined,
  );
  // X07 (ADR-M90): what the agent read, after `knowledge_read` (the snapshot lists its hashes).
  await recordContextSnapshot(scope, deps.knowledgeEvidence, runId, reads).catch(() => undefined);
  const result = await teardownSandbox(deps.docker, runId);
  await scope.runEvents.append(runId, 'sandbox_removed', {
    reason,
    duration_ms: result.durationMs,
  });
  deps.held.release(runId);
}

async function failRun(
  deps: RunnerDeps,
  scope: TenantScope,
  runId: string,
  reason: ProvisioningFailure,
  sandboxCreated: boolean,
): Promise<void> {
  await scope.runEvents.append(runId, 'provisioning_failed', { reason });
  // The reserved workspace volume exists from before the claim, so there is always something to
  // remove. A clean-up error must not keep the run out of `failed`: the sweep retries the objects.
  await (
    sandboxCreated
      ? releaseSandbox(deps, scope.tenantId, runId, 'provisioning_failed')
      : teardownSandbox(deps.docker, runId)
  ).catch(() => undefined);
  const now = clock(deps);
  // Killed meanwhile (C11): one update ends the run killed, never `failed` (migration 0020).
  await scope.runs.end(runId, {
    from: ['provisioning'],
    to: 'failed',
    now,
    stopReason: reason,
    finishedAt: now,
  });
}

async function unwrapToken(
  unwrapper: SecretUnwrapper,
  wrapped: RedactedSecret,
  onRefused: () => Promise<void>,
): Promise<RedactedSecret> {
  try {
    const fields = await unwrapper.unwrap(wrapped);
    const token = fields.token;
    if (!token) throw new ProvisioningError('token_unavailable');
    return token;
  } catch (error) {
    if (isRefusedWrapToken(error)) await onRefused();
    // Unknown, expired or already used: maybe someone else unwrapped it (ADR-M25 §2.11).
    throw new ProvisioningError('token_unavailable');
  }
}

/** What the runner needs to start the register tools of a run (X04, ADR-M69 §2.4). */
interface ToolSetup {
  readonly grants: readonly ToolGrant[];
  readonly images: ReadonlyMap<string, string>;
  readonly gatewayImage: string;
  readonly limits: ToolLimits;
  /** X04 PR 3b: the files of each tool with backing services, by tool key. */
  readonly runtime: ReadonlyMap<string, ToolRuntime>;
}

/**
 * The tool images and the gateway of a contract with grants, or undefined without grants. Each
 * image is the register's name with the grant's digest, and the register must still hold the
 * granted version (`tool_unavailable` otherwise: the contract and the register disagree).
 */
async function toolSetup(
  scope: TenantScope,
  contract: RunContract,
  deps: RunnerDeps,
  request: ProvisionRequest,
): Promise<ToolSetup | undefined> {
  const grants = contract.tool_grants ?? [];
  if (grants.length === 0) return undefined;
  let config: ProjectConfig;
  try {
    config = (await loadEffectiveConfig(scope.projectConfigs, contract.project_id)).config;
  } catch {
    throw new ProvisioningError('config_unavailable');
  }
  const gatewayImage = config.tools.gateway.image;
  if (gatewayImage === null) throw new ProvisioningError('tool_unavailable');
  const images = new Map<string, string>();
  for (const grant of grants) {
    const tool = await scope.tools.getByKey(grant.tool_key);
    // A tool suspended, quarantined or retired after G4 never starts (ADR-M69 §2.9).
    if (
      tool?.status !== 'active' ||
      tool.version !== grant.tool_version ||
      tool.image_digest !== grant.image_digest ||
      tool.image_ref === null
    ) {
      throw new ProvisioningError('tool_unavailable');
    }
    images.set(grant.tool_key, `${tool.image_ref}@${grant.image_digest}`);
  }
  const runtime = new Map<string, ToolRuntime>();
  for (const grant of grants) {
    if (grant.backing_services.length === 0) continue;
    const tool = await scope.tools.getByKey(grant.tool_key);
    runtime.set(
      grant.tool_key,
      await toolRuntime(deps, scope, contract, grant, tool?.model_ref ?? null, request),
    );
  }
  const limits = config.tools.container_limits;
  return {
    grants,
    images,
    runtime,
    gatewayImage,
    limits: {
      memoryBytes: limits.memory_mb * 1024 * 1024,
      nanoCpus: limits.cpu_millis * 1_000_000,
      pids: limits.pids,
    },
  };
}

const INDEX_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The settings and credential of a `read_documents` tool (X04 PR 3b, ADR-M89): its index version
 * of the run, the project's schema, the model, the services on its service network, and the
 * unwrapped login and key. A wrapping token that OpenBao refuses was opened by someone else: the
 * run event `wrap_token_reused` (the `security` route, ADR-M42 §2.5), and the tool is unavailable.
 */
async function toolRuntime(
  deps: RunnerDeps,
  scope: TenantScope,
  contract: RunContract,
  grant: ToolGrant,
  model: string | null,
  request: ProvisionRequest,
): Promise<ToolRuntime> {
  if (grant.permissions.includes('read_code')) {
    return codeToolRuntime(deps, scope, contract, grant, request);
  }
  const handoff = request.toolSecrets?.get(grant.tool_key);
  const database = deps.settings.toolServices.find((s) => s.alias === 'knowledge-db');
  const gateway = deps.settings.toolServices.find((s) => s.alias === 'litellm');
  if (
    handoff === undefined ||
    !INDEX_ID.test(handoff.indexId) ||
    model === null ||
    !grant.permissions.includes('read_documents') ||
    database === undefined ||
    gateway === undefined
  ) {
    throw new ProvisioningError('tool_unavailable');
  }
  // The index must be the one this run's preparation recorded, in the run's own project.
  const index = await scope.knowledgeIndexes.usedByRun(
    handoff.indexId,
    contract.run_id,
    contract.project_id,
  );
  if (index?.model !== model) throw new ProvisioningError('tool_unavailable');
  let fields: Readonly<Record<string, RedactedSecret>>;
  try {
    fields = await deps.unwrapper.unwrap(handoff.wrapped);
  } catch (error) {
    if (isRefusedWrapToken(error)) {
      await recordWrapTokenReused(scope, contract.run_id, 'tool_secrets');
    }
    throw new ProvisioningError('tool_unavailable');
  }
  const { db_username, db_password, llm_key } = fields;
  if (!db_username || !db_password || !llm_key) throw new ProvisioningError('tool_unavailable');
  return {
    config: {
      schema_version: 1,
      index_id: handoff.indexId,
      schema: knowledgeSchema(contract.project_id),
      model,
      database: { host: database.alias, port: database.port, name: KNOWLEDGE_DATABASE },
      model_gateway_url: `http://${gateway.alias}:${String(gateway.port)}`,
    },
    credentials: { db_username, db_password, llm_key },
  };
}

/**
 * The settings and credential of a `read_code` tool (X06 PR 2, ADR-M108 §2.8): its code index
 * version of the run, the project's code schema and the database; the unwrapped login only (the
 * code tool calls no model). The same checks as a `read_documents` tool.
 */
async function codeToolRuntime(
  deps: RunnerDeps,
  scope: TenantScope,
  contract: RunContract,
  grant: ToolGrant,
  request: ProvisionRequest,
): Promise<ToolRuntime> {
  const handoff = request.toolSecrets?.get(grant.tool_key);
  const database = deps.settings.toolServices.find((s) => s.alias === 'knowledge-db');
  if (
    handoff === undefined ||
    !INDEX_ID.test(handoff.indexId) ||
    grant.permissions.includes('read_documents') ||
    database === undefined
  ) {
    throw new ProvisioningError('tool_unavailable');
  }
  const index = await scope.knowledgeIndexes.usedByRun(
    handoff.indexId,
    contract.run_id,
    contract.project_id,
  );
  if (index?.kind !== 'code' || index.model !== CODE_INDEX_FORMAT) {
    throw new ProvisioningError('tool_unavailable');
  }
  let fields: Readonly<Record<string, RedactedSecret>>;
  try {
    fields = await deps.unwrapper.unwrap(handoff.wrapped);
  } catch (error) {
    if (isRefusedWrapToken(error)) {
      await recordWrapTokenReused(scope, contract.run_id, 'tool_secrets');
    }
    throw new ProvisioningError('tool_unavailable');
  }
  const { db_username, db_password } = fields;
  if (!db_username || !db_password) throw new ProvisioningError('tool_unavailable');
  return {
    config: {
      schema_version: 1,
      index_id: handoff.indexId,
      schema: codeIndexSchema(contract.project_id),
      database: { host: database.alias, port: database.port, name: KNOWLEDGE_DATABASE },
    },
    credentials: { db_username, db_password },
  };
}

/** The hook `createSandbox` calls once the run network exists; records `tool_started`. */
function startToolsOf(
  deps: RunnerDeps,
  scope: TenantScope,
  runId: string,
  setup: ToolSetup,
): (names: RunNames, labels: Readonly<Record<string, string>>) => Promise<string> {
  return async (names, labels) => {
    const started = await startTools(deps.docker, {
      run: names,
      labels,
      grants: setup.grants,
      images: setup.images,
      gatewayImage: setup.gatewayImage,
      limits: setup.limits,
      readyTimeoutMs: deps.settings.readyTimeoutMs,
      services: deps.settings.toolServices,
      runtime: setup.runtime,
    });
    for (const grant of started.started) {
      await scope.runEvents.append(runId, 'tool_started', {
        tool_key: grant.tool_key,
        tool_version: grant.tool_version,
        image_sha256: grant.image_digest.slice('sha256:'.length),
      });
    }
    return started.key;
  };
}

/** The project's image for the adapter (X03, QUESTIONS #522, #528). */
async function projectImage(
  scope: TenantScope,
  projectId: string,
  adapter: AgentAdapterCode,
): Promise<string> {
  let sandbox: ProjectConfig['sandbox'];
  try {
    sandbox = (await loadEffectiveConfig(scope.projectConfigs, projectId)).config.sandbox;
  } catch {
    throw new ProvisioningError('config_unavailable');
  }
  const image = sandboxImageFor(sandbox, adapter);
  if (image === undefined) throw new ProvisioningError('image_not_configured');
  return image;
}

/** Waits for the image's health check (image contract, ADR-M25 §2.3). */
export async function waitUntilHealthy(
  deps: Pick<RunnerDeps, 'docker' | 'settings'>,
  containerId: string,
): Promise<void> {
  const deadline = Date.now() + deps.settings.readyTimeoutMs;
  for (;;) {
    const info = await deps.docker.containerInspect(containerId);
    const health = info?.State.Health?.Status;
    if (!info?.State.Running) throw new ProvisioningError('sandbox_unhealthy');
    if (health === undefined) throw new ProvisioningError('image_has_no_healthcheck');
    if (health === 'healthy') return;
    if (health === 'unhealthy') throw new ProvisioningError('sandbox_unhealthy');
    if (Date.now() >= deadline) throw new ProvisioningError('sandbox_not_ready');
    await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_MS));
  }
}

function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
