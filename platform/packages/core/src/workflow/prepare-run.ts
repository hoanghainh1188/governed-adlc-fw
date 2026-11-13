// Preparing a run after G4 (task C06, D-08 C06 AC1, D-02 FR-31, FR-33, FR-36, FR-50, D-03
// sections 8 and 8.2, design/ADR-M33 §2.5, QUESTIONS #44, #79, #112).
//
// The worker calls `prepareRun` just before it hands the run to the runner (session 2: the
// Temporal task queue `sdlc-runner`). In order:
// 1. read the G4 facts again (base commit, instructions file, allowed models) and, under the
//    intent lock, run the G4 checks again: the proposal must still be ready and still be the one
//    G4 passed or Person A approved (FR-17: an approval is re-checked just before the action);
// 2. issue and sign the Run Contract (`issueRunContract`, ADR-M22) from that proposal;
// 3. an overdue recertification is a warning, not a block (FR-36): the audit event
//    `agent.recertification_overdue` with the run and one notice that mentions the agent's owner
//    (ADR-M31 §2.7);
// 4. issue the run's LiteLLM virtual key, capped by the Cost Controller at the smallest of the run,
//    intent and tenant remainders (ADR-M24); a used-up budget cancels the run (`budget_exceeded`);
// 5. issue the run's single-repository GitHub token (read: the runner clones; C08 pushes with its
//    own token) and hand both secrets over as single-use OpenBao wrapping tokens that live as long
//    as the contract is valid (QUESTIONS #44, #112). Only the wrapping tokens and IDs travel on:
//    no secret, no client data in the Temporal history (ADR-M30 §2.1).
// 6. (E01 PR 2, ADR-M41 §2.7, QUESTIONS #179) when the run answers a request for changes at G7,
//    re-check its source before any secret (`g7-feedback.ts`): the review must still be its
//    reviewer's latest decision on the pushed commit, and the decider still linked. Otherwise the
//    run ends `failed` (`agent_feedback_unavailable`) before its key, token or sandbox exist, and
//    the intent is paused with a `technical` escalation like any failed run (Harry, E01 PR 2
//    plan). When it holds, a third token that may only read pull requests (or issues, for a
//    command on the intent's issue) is wrapped for the runner, which reads the text with it.
// 7. (X04 PR 3a, 3b; ADR-M89) for a `read_documents` tool: the index of the project's documents at
//    the base commit, then the tool's database login and model key, wrapped for the runner
//    (`tools/credentials.ts`). A failure ends the run `failed` (`tool_unavailable`, run event
//    `knowledge_unavailable`) and revokes what was issued. X06 (ADR-M108): the same for a
//    `read_code` tool, with the code index and a login of the code read role (no model key).
// 8. (X13 PR 2, ADR-M74 §2.6) for a project whose `memory.mode` is not `off`: the memory set at the
//    base commit and whether a person approved it (`memoryForRun`), in the contract (schema 5).
//    G4 never fails for memory; the runner reads the set from its clone only when the hash holds.
// If anything fails after the contract, the key is revoked and the run is cancelled
// (`prepare_failed`), so no run waits in `queued` with a live key.
import {
  GitHostError,
  KnowledgeError,
  type AgentAdapterCode,
  type KnowledgeErrorCode,
  type GitHostAdapter,
  type MemoryMode,
  type RunContractMemory,
  type RedactedSecret,
  type RunContractSigner,
  type RunDatabaseCredentials,
  type SecretWrapper,
} from '@sdlc/contracts';

import { CostError } from '../cost/errors.js';
import type { CostController } from '../cost/controller.js';
import type { TenantScope } from '../db/tenant-scope.js';
import type { Registry } from '../registry/registry.js';
import { issueRunContract } from '../run-contract/issue.js';
import { buildCodeIndex, type CodeIndexDeps } from '../knowledge/code-indexer.js';
import { buildProjectIndex, type KnowledgeDeps } from '../knowledge/indexer.js';
import { memoryForRun } from '../memory/run.js';
import { loadEffectiveConfig } from '../registry/effective-config.js';
import { isRecordableModel } from '../run-events/types.js';
import { gatherG4Facts, projectRepoRef, type G4Deps, type RunProposal } from './g4-proposal.js';
import { evaluateG4, g4Decided } from './g4.js';
import {
  feedbackSourceFor,
  reviewStillHolds,
  type FeedbackLookup,
  type FeedbackSource,
  type FeedbackUnavailable,
} from './g7-feedback.js';
import { isFinalRun, roundRuns } from './run-round.js';
import {
  endRunCredentials,
  issueToolSecrets,
  smallerUsd,
  type PreparedToolSecrets,
} from '../tools/credentials.js';

export interface PrepareRunDeps {
  readonly registry: Registry;
  readonly g4: G4Deps;
  readonly signer: RunContractSigner;
  readonly costController: Pick<CostController, 'issueRunKey' | 'issueToolKey' | 'endRun'> &
    Pick<CostController, 'endRunKey'>;
  readonly gitHost: Pick<GitHostAdapter, 'issueShortLivedToken' | 'getReviews'>;
  readonly wrapper: SecretWrapper;
  /** Services the sandbox may reach, as `alias:port` (deployment settings, ADR-M25 §2.2). */
  readonly egressAllowlist: readonly string[];
  /**
   * X04 PR 3a (ADR-M89 §2.3): the index of the project's documents for a `read_documents` tool.
   * Without it a run with such a tool fails (`tool_unavailable`).
   */
  readonly knowledge?: KnowledgeDeps;
  /**
   * X06 PR 2 (ADR-M108 §2.6): the code index for a `read_code` tool. Without it a run with such a
   * tool fails (`tool_unavailable`).
   */
  readonly code?: CodeIndexDeps;
  /**
   * X04 PR 3b (QUESTIONS #535, #540): OpenBao's database engine, for the database login of a
   * `read_documents` tool. Without it a run with such a tool fails (`tool_unavailable`).
   */
  readonly databaseCredentials?: RunDatabaseCredentials;
  /**
   * X13 PR 2 (ADR-M74 §2.6): the Git host's folder listing for the run's memory. Without it a
   * project with memory on cannot prepare a run (the step fails and is tried again).
   */
  readonly memory?: { readonly gitHost: Pick<GitHostAdapter, 'listFolder'> };
}

export type PrepareRunRefusal =
  /** The intent is not at G4 (moved, rejected, blocked) or unknown. */
  | 'not_at_g4'
  /** A G4 check does not pass any more, or the intent must wait (block window, freeze). */
  | 'not_ready'
  /** The proposal changed since G4 passed or was approved: G4 decides again. */
  | 'not_decided'
  /** The Cost Controller refused the run's key: the intent or tenant budget is used up. */
  | 'budget_exceeded'
  /**
   * A run of this round is already under way (session 2, ADR-M33 §2.6): a retried or concurrent
   * call never issues a second run, contract, token or key.
   */
  | 'run_exists'
  /**
   * E01 PR 2: the request for changes the run answers no longer holds (a review dismissed or
   * replaced, the decider unlinked) or cannot be checked. The run ended `failed` before any secret
   * was issued; the workflow finishes it like a failed run (paused, escalation).
   */
  | 'feedback_unavailable'
  /**
   * X04 PR 3a (ADR-M89 §2.3): the index of the project's documents for a `read_documents` tool
   * could not be built. The run ended `failed` (`tool_unavailable`, run event
   * `knowledge_unavailable`) and its key was revoked; the workflow finishes it like a failed run.
   */
  | 'tool_unavailable';

export interface PreparedRun {
  readonly runId: string;
  readonly attempt: number;
  /** The agent's pinned gateway model: the model the runner asks for (QUESTIONS #79). */
  readonly modelRef: string;
  readonly agentKey: string;
  /** Gateway key ID (not the key): the caller revokes it when the run ends (`endRun`). */
  readonly keyId: string;
  readonly keyIssuedAt: Date;
  /** Single-use wrapping token around `{ token }`, the run's GitHub token. */
  readonly wrappedGitToken: RedactedSecret;
  /** Single-use wrapping token around `{ key }`, the run's LiteLLM virtual key. */
  readonly wrappedVirtualKey: RedactedSecret;
  /**
   * E01 PR 2: single-use wrapping token around `{ token }`, a token that may only read pull
   * requests (or issues), when the run answers a request for changes at G7.
   */
  readonly wrappedFeedbackToken?: RedactedSecret;
  /**
   * X04 PR 3b: by tool key, the single-use wrapping token around a `read_documents` tool's
   * `{ db_username, db_password, llm_key }` and the index version it reads. Empty without one.
   */
  readonly toolSecrets: ReadonlyMap<string, PreparedToolSecrets>;
  readonly warnings: readonly 'recertification_overdue'[];
}

export type PrepareRunResult =
  | { readonly ok: true; readonly run: PreparedRun }
  | { readonly ok: false; readonly reason: PrepareRunRefusal };

/** Wrapping tokens live as long as the contract is valid (ADR-M25 §2.11). */
const SECONDS_PER_MINUTE = 60;

interface Checked {
  readonly inputSha256: string;
  readonly proposal: RunProposal;
  readonly triggeredBy: string | null;
  readonly agent: {
    readonly id: string;
    readonly key: string;
    readonly tools: readonly string[];
    readonly adapter: AgentAdapterCode;
  };
  readonly ownerWarning: boolean;
  /** X04: register tools whose recertification is overdue (a warning, not a refusal). */
  readonly overdueTools: readonly { readonly id: string; readonly key: string }[];
  readonly validityMinutes: number;
  /** X13: the project's `memory.mode` when G4 passed. */
  readonly memoryMode: MemoryMode;
}

export async function prepareRun(
  scope: TenantScope,
  deps: PrepareRunDeps,
  intentId: string,
): Promise<PrepareRunResult> {
  const peek = await scope.intents.getById(intentId);
  if (!peek || !isAtG4(peek)) return { ok: false, reason: 'not_at_g4' };
  const facts = await gatherG4Facts(scope, deps.g4, peek);
  const feedback = await checkFeedback(scope, deps.gitHost, peek);

  const checked = await scope.transaction(async (tx): Promise<Checked | PrepareRunRefusal> => {
    const intent = await tx.intents.lockAndGet(intentId);
    if (!intent || !isAtG4(intent)) return 'not_at_g4';
    if ((await roundRuns(tx, intent)).some((r) => !isFinalRun(r.status))) return 'run_exists';
    const policy = await deps.registry.policyFor(tx, intent.project_id);
    const ready = await evaluateG4(tx, deps.registry, policy, intent, facts);
    if (ready.kind !== 'ready') return 'not_ready';
    const decided = await g4Decided(tx, deps.registry, policy, intent, ready.inputSha256);
    if (!decided.decided) return 'not_decided';
    return {
      inputSha256: ready.inputSha256,
      proposal: ready.proposal,
      triggeredBy: decided.approverId,
      agent: ready.agent.agent,
      ownerWarning: ready.agent.warnings.includes('recertification_overdue'),
      overdueTools: ready.tools.overdue,
      validityMinutes: policy.config.run.contract_validity_minutes,
      memoryMode: policy.config.memory.mode,
    };
  });
  if (typeof checked === 'string') return { ok: false, reason: checked };
  const { proposal } = checked;
  const memory = await runMemory(
    scope,
    deps,
    peek.project_id,
    proposal.baseSha,
    checked.memoryMode,
  );

  const issued = await issueRunContract(
    scope,
    {
      intentId,
      planId: proposal.planId,
      baseSha: proposal.baseSha,
      agent: {
        id: proposal.agentId,
        version: proposal.agentVersion,
        instructionsSha256: proposal.instructionsSha256,
        tools: checked.agent.tools,
        adapter: checked.agent.adapter,
      },
      // B09: the proposal's tools are already the agent's tools that the plan lists.
      planTools: proposal.allowedTools,
      toolGrants: proposal.toolGrants,
      autonomyLevel: proposal.autonomyLevel,
      maxBudgetUsd: proposal.maxBudgetUsd,
      maxIterations: proposal.maxIterations,
      maxDurationMin: proposal.maxDurationMin,
      allowedModels: proposal.allowedModels,
      egressAllowlist: deps.egressAllowlist,
      triggeredBy: checked.triggeredBy,
      ...(memory === undefined ? {} : { memory }),
    },
    { signer: deps.signer, now: () => deps.registry.now() },
  );
  const runId = issued.run.id;
  // The contract was signed outside the lock. Before any secret is issued, check again under the
  // lock that this proposal is still the decided one (code review of session 1): a block, a freeze
  // or a new proposal in between cancels the run.
  const still = await scope.transaction(async (tx) => {
    const intent = await tx.intents.lockAndGet(intentId);
    if (!intent || !isAtG4(intent)) return false;
    const policy = await deps.registry.policyFor(tx, intent.project_id);
    const again = await evaluateG4(tx, deps.registry, policy, intent, facts);
    if (again.kind !== 'ready' || again.inputSha256 !== checked.inputSha256) return false;
    return (await g4Decided(tx, deps.registry, policy, intent, again.inputSha256)).decided;
  });
  if (!still) {
    await cancel(scope, deps.registry, runId, 'not_decided');
    return { ok: false, reason: 'not_decided' };
  }
  if (feedback.kind === 'unavailable') {
    await failForFeedback(scope, deps.registry, runId, feedback.reason);
    return { ok: false, reason: 'feedback_unavailable' };
  }
  if (checked.ownerWarning) await warnOwner(scope, deps.registry, intentId, checked.agent, runId);
  if (checked.overdueTools.length > 0) {
    await warnToolsOverdue(scope, deps.registry, checked.overdueTools, runId);
  }

  let key;
  const keyIssuedAt = deps.registry.now();
  try {
    key = await deps.costController.issueRunKey({
      tenantId: scope.tenantId,
      runId,
      gate: 'G4',
      agent: checked.agent.key,
    });
  } catch (error) {
    if (
      error instanceof CostError &&
      (error.code === 'intent_budget_exhausted' || error.code === 'tenant_budget_exhausted')
    ) {
      await cancel(scope, deps.registry, runId, 'budget_exceeded');
      return { ok: false, reason: 'budget_exceeded' };
    }
    await cancel(scope, deps.registry, runId, 'prepare_failed');
    throw error;
  }

  // X04 PR 3a (ADR-M89 §2.3): the index of the documents, built with the run's own key before any
  // other secret is issued. A failure ends the run `failed`; the key is revoked. Any other error:
  // the key is revoked and the run cancelled, as below.
  let indexed: Awaited<ReturnType<typeof indexForTools>>;
  try {
    indexed = await indexForTools(scope, deps, peek, proposal, runId, key.key.key);
  } catch (error) {
    await deps.costController.endRun({ keyId: key.key.keyId, syncFrom: keyIssuedAt });
    await cancel(scope, deps.registry, runId, 'prepare_failed');
    throw error;
  }
  if (typeof indexed === 'string') {
    await deps.costController.endRun({ keyId: key.key.keyId, syncFrom: keyIssuedAt });
    await failForKnowledge(scope, deps.registry, runId, indexed);
    return { ok: false, reason: 'tool_unavailable' };
  }
  const startWindowSeconds = checked.validityMinutes * SECONDS_PER_MINUTE;
  let toolSecrets: ReadonlyMap<string, PreparedToolSecrets>;
  try {
    toolSecrets = await issueToolSecrets(
      scope,
      {
        databaseCredentials: deps.databaseCredentials,
        wrapper: deps.wrapper,
        costController: deps.costController,
      },
      {
        runId,
        projectId: peek.project_id,
        grants: proposal.toolGrants,
        indexIds: indexed.indexIds,
        models: indexed.models,
        ttlSeconds: proposal.maxDurationMin * SECONDS_PER_MINUTE + startWindowSeconds,
        wrapTtlSeconds: startWindowSeconds,
        toolBudgetUsd: smallerUsd(indexed.toolBudgetUsd, key.maxBudgetUsd),
      },
    );
  } catch {
    // The run's key, the tools' keys and logins: everything issued so far, found by the run.
    await endRunCredentials(scope, deps, runId, keyIssuedAt);
    await failForKnowledge(scope, deps.registry, runId, 'credentials_unavailable');
    return { ok: false, reason: 'tool_unavailable' };
  }

  try {
    // V13 (QUESTIONS #434): the model the run calls, so reports group runs by the model used. A
    // name outside the event format is not recorded; the report then reads the cost records.
    if (isRecordableModel(proposal.modelRef)) {
      await scope.runEvents.append(runId, 'model_selected', { model: proposal.modelRef });
    }
    // C07 (ADR-M34 §2.6): the key's cap and which budget set it (run, intent or tenant), so G5 and
    // the runner's spend check can be traced. The key and its ID never go into run events.
    await scope.runEvents.append(runId, 'key_issued', {
      max_budget_usd: key.maxBudgetUsd,
      limited_by: key.limitedBy,
    });
    const project = await scope.projects.getById(peek.project_id);
    const ref = project ? projectRepoRef(project) : undefined;
    if (!ref) throw new GitHostError('invalid_input', { field: 'repo' });
    const token = await deps.gitHost.issueShortLivedToken(ref, {
      permissions: { contents: 'read' },
    });
    const ttlSeconds = checked.validityMinutes * SECONDS_PER_MINUTE;
    const wrappedGitToken = await deps.wrapper.wrap({ token: token.token }, { ttlSeconds });
    const wrappedVirtualKey = await deps.wrapper.wrap({ key: key.key.key }, { ttlSeconds });
    const wrappedFeedbackToken =
      feedback.kind === 'source'
        ? await wrapFeedbackToken(deps, ref, feedback.source, ttlSeconds)
        : undefined;
    return {
      ok: true,
      run: {
        runId,
        attempt: issued.run.attempt,
        modelRef: proposal.modelRef,
        agentKey: checked.agent.key,
        keyId: key.key.keyId,
        keyIssuedAt,
        wrappedGitToken,
        wrappedVirtualKey,
        ...(wrappedFeedbackToken ? { wrappedFeedbackToken } : {}),
        toolSecrets,
        warnings: checked.ownerWarning ? ['recertification_overdue'] : [],
      },
    };
  } catch (error) {
    await deps.costController.endRun({ keyId: key.key.keyId, syncFrom: keyIssuedAt });
    if (toolSecrets.size > 0) await endRunCredentials(scope, deps, runId, keyIssuedAt);
    await cancel(scope, deps.registry, runId, 'prepare_failed');
    throw error;
  }
}

function isAtG4(intent: { readonly status: string; readonly current_gate: string | null }) {
  return (
    intent.current_gate === 'G4' && (intent.status === 'in_gate' || intent.status === 'running')
  );
}

/** FR-36: the run is not blocked; the owner is told, and the audit log records it with the run. */
/** X04: an overdue tool gives a warning in the audit log; it does not block the run (ADR-M69). */
async function warnToolsOverdue(
  scope: TenantScope,
  registry: Registry,
  tools: Checked['overdueTools'],
  runId: string,
): Promise<void> {
  await scope.transaction(async (tx) => {
    for (const tool of tools) {
      await tx.audit.append({
        action: 'tool.recertification_overdue',
        actorType: 'system',
        actorId: null,
        entityId: tool.id,
        occurredAt: registry.now(),
        payload: { tool_key: tool.key, run_id: runId },
      });
    }
  });
}

async function warnOwner(
  scope: TenantScope,
  registry: Registry,
  intentId: string,
  agent: Checked['agent'],
  runId: string,
): Promise<void> {
  await scope.transaction(async (tx) => {
    const intent = await tx.intents.lockAndGet(intentId);
    if (!intent) return;
    await tx.audit.append({
      action: 'agent.recertification_overdue',
      actorType: 'system',
      actorId: null,
      entityId: agent.id,
      occurredAt: registry.now(),
      payload: { agent_key: agent.key, run_id: runId },
    });
    await tx.intentNotices.record({
      intentId,
      kind: 'agent_recertification_due',
      status: intent.status,
      gate: intent.current_gate,
      previousGate: null,
      decisionId: null,
      audienceRoles: [],
      agentId: agent.id,
    });
  });
}

/** Ends a run that never started; `stopReason` is a code. */
async function cancel(scope: TenantScope, registry: Registry, runId: string, stopReason: string) {
  const now = registry.now();
  await scope.runs.transition(runId, {
    from: ['queued'],
    to: 'cancelled',
    now,
    stopReason,
    finishedAt: now,
  });
}

/**
 * The request for changes the run answers, re-checked on the Git host for a review (before the
 * intent lock: no HTTP call under it). A Git host that cannot be read fails closed.
 */
async function checkFeedback(
  scope: TenantScope,
  gitHost: PrepareRunDeps['gitHost'],
  intent: Parameters<typeof feedbackSourceFor>[1],
): Promise<FeedbackLookup> {
  const lookup = await feedbackSourceFor(scope, intent);
  if (lookup.kind !== 'source' || lookup.source.kind !== 'review') return lookup;
  const project = await scope.projects.getById(intent.project_id);
  const ref = project ? projectRepoRef(project) : undefined;
  if (!ref) return { kind: 'unavailable', reason: 'git_host_unavailable' };
  let reviews;
  try {
    reviews = await gitHost.getReviews(ref, lookup.source.prNumber);
  } catch (error) {
    if (error instanceof GitHostError) {
      return { kind: 'unavailable', reason: 'git_host_unavailable' };
    }
    throw error;
  }
  const withdrawn = reviewStillHolds(lookup.source, reviews);
  return withdrawn === null ? lookup : { kind: 'unavailable', reason: withdrawn };
}

/** Ends a queued run `failed` before any secret exists (E01 PR 2): no key, no token, no sandbox. */
async function failForFeedback(
  scope: TenantScope,
  registry: Registry,
  runId: string,
  reason: FeedbackUnavailable,
): Promise<void> {
  const now = registry.now();
  await scope.transaction(async (tx) => {
    const ended = await tx.runs.transition(runId, {
      from: ['queued'],
      to: 'failed',
      now,
      stopReason: FEEDBACK_UNAVAILABLE,
      finishedAt: now,
    });
    if (ended) await tx.runEvents.append(runId, 'feedback_unavailable', { reason });
  });
}

/** The stop reason of a run whose register tool could not be prepared (X04 PR 3a). */
export const TOOL_UNAVAILABLE = 'tool_unavailable';

/** The index version of each `read_documents` and `read_code` grant, and the model of each `read_documents` grant, by tool key. */
interface IndexedTools {
  readonly indexIds: ReadonlyMap<string, string>;
  readonly models: ReadonlyMap<string, string>;
  /** `tools.model_budget_usd` of the project (decimal USD). */
  readonly toolBudgetUsd: string;
}

/**
 * Builds or reuses the index of the project's documents for each grant with `read_documents`
 * (ADR-M89 §2.3). The model is the tool's `model_ref` and must be one of the contract's allowed
 * models (G4 checked it for the data class). X06: the code index for each grant with `read_code`
 * (ADR-M108 §2.6). Returns the index versions or the error code.
 */
async function indexForTools(
  scope: TenantScope,
  deps: PrepareRunDeps,
  intent: { readonly id: string; readonly project_id: string },
  proposal: RunProposal,
  runId: string,
  key: RedactedSecret,
): Promise<IndexedTools | KnowledgeErrorCode> {
  const docGrants = proposal.toolGrants.filter((g) => g.permissions.includes('read_documents'));
  const codeGrants = proposal.toolGrants.filter((g) => g.permissions.includes('read_code'));
  const indexIds = new Map<string, string>();
  const models = new Map<string, string>();
  if (docGrants.length === 0 && codeGrants.length === 0) {
    return { indexIds, models, toolBudgetUsd: '0' };
  }
  try {
    if (docGrants.length > 0 && !deps.knowledge) throw new KnowledgeError('store_unavailable');
    if (codeGrants.length > 0 && !deps.code) throw new KnowledgeError('store_unavailable');
    const project = await scope.projects.getById(intent.project_id);
    const ref = project ? projectRepoRef(project) : undefined;
    if (!ref) throw new KnowledgeError('file_unreadable');
    const { config } = await loadEffectiveConfig(scope.projectConfigs, intent.project_id);
    for (const grant of docGrants) {
      const tool = await scope.tools.getByKey(grant.tool_key);
      const model = tool?.model_ref ?? null;
      if (model === null || !proposal.allowedModels.includes(model)) {
        throw new KnowledgeError('model_not_allowed');
      }
      const built = await buildProjectIndex(scope, deps.knowledge!, {
        ref,
        projectId: intent.project_id,
        baseSha: proposal.baseSha,
        model,
        key,
        runId,
        intentId: intent.id,
        limits: config.knowledge,
        now: deps.registry.now(),
      });
      indexIds.set(grant.tool_key, built.indexId);
      models.set(grant.tool_key, model);
    }
    // X06 (ADR-M108 §2.6): no model; one index of the commit serves every `read_code` grant.
    if (codeGrants.length > 0) {
      const built = await buildCodeIndex(scope, deps.code!, {
        ref,
        projectId: intent.project_id,
        baseSha: proposal.baseSha,
        runId,
        intentId: intent.id,
        limits: config.code_index,
        now: deps.registry.now(),
      });
      for (const grant of codeGrants) indexIds.set(grant.tool_key, built.indexId);
    }
    return { indexIds, models, toolBudgetUsd: String(config.tools.model_budget_usd) };
  } catch (error) {
    if (error instanceof KnowledgeError) return error.code;
    throw error;
  }
}

async function failForKnowledge(
  scope: TenantScope,
  registry: Registry,
  runId: string,
  reason: KnowledgeErrorCode,
): Promise<void> {
  const now = registry.now();
  await scope.transaction(async (tx) => {
    const ended = await tx.runs.transition(runId, {
      from: ['queued'],
      to: 'failed',
      now,
      stopReason: TOOL_UNAVAILABLE,
      finishedAt: now,
    });
    if (ended) await tx.runEvents.append(runId, 'knowledge_unavailable', { reason });
  });
}

/** The stop reason of a run whose request for changes cannot be read (worker or runner). */
export const FEEDBACK_UNAVAILABLE = 'agent_feedback_unavailable';

/** A token that may only read where the feedback lives, wrapped for the runner (single use). */
async function wrapFeedbackToken(
  deps: PrepareRunDeps,
  ref: NonNullable<ReturnType<typeof projectRepoRef>>,
  source: FeedbackSource,
  ttlSeconds: number,
): Promise<RedactedSecret> {
  const token = await deps.gitHost.issueShortLivedToken(ref, {
    permissions: { [source.permission]: 'read' },
  });
  return deps.wrapper.wrap({ token: token.token }, { ttlSeconds });
}

/** X13: the contract's `memory` for a project with memory on; undefined when it is `off`. */
async function runMemory(
  scope: TenantScope,
  deps: PrepareRunDeps,
  projectId: string,
  baseSha: string,
  mode: MemoryMode,
): Promise<RunContractMemory | undefined> {
  if (mode === 'off') return undefined;
  const project = await scope.projects.getById(projectId);
  const ref = project ? projectRepoRef(project) : undefined;
  if (!deps.memory || !ref) throw new Error('memory: no Git host or repository for the run');
  return memoryForRun(scope, deps.memory.gitHost, { projectId, ref, baseSha, mode });
}
