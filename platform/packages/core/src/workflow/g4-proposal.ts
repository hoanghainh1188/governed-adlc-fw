// Gate G4, the facts and the run proposal (task C06, D-02 FR-03, FR-36, D-03 sections 6 and 8,
// handbook Ch.13 §13.5 Step 1, design/ADR-M33 §2.2–§2.3, QUESTIONS #108–#110).
//
// Two parts:
// - `gatherG4Facts` reads what G4 needs from outside the database, before the step's transaction
//   (no HTTP call while the intent lock is held): the head of the project's default branch (the
//   run's base commit, QUESTIONS #109), the SHA-256 of the agent's instructions file at that commit
//   (read outside the sandbox, ADR-M31 §2.5), the agent instruction files at that commit other
//   than the pinned one (C07, QUESTIONS #126), and the models the gateway allows for the intent's
//   data class (QUESTIONS #17, #79).
// - The run proposal: the terms a G4 pass or approval is bound to (FR-17). Its hash is the G4
//   input: plan, spec, agent and its version, instructions, model, autonomy, tools, caps, allowed
//   models, base commit and data class. A change of any of them voids a G4 approval.
import { createHash } from 'node:crypto';

import { canonicalJson } from '@sdlc/config';
import {
  GitHostError,
  unpinnedInstructionPathsIn,
  type DataClass,
  type GitHostAdapter,
  type ValidatedProjectConfig,
  type RepoRef,
  type RunContractAutonomy,
  type ToolGrant,
} from '@sdlc/contracts';

import { instructionsPath, rootInstructionsPath } from '../agents/check.js';
import { instructionsSha256 } from '../agents/rules.js';
import type { Intent, Project } from '../db/schema.js';
import type { TenantScope } from '../db/tenant-scope.js';
import { loadEffectiveConfig } from '../registry/effective-config.js';
import { lastPushedHead } from './publish-state.js';

/** What G4 needs from outside the database (the worker wires them in; tests pass fakes). */
export interface G4Deps {
  /** The Git host of the platform's projects (GitHub in the MVP). */
  readonly gitHost: Pick<GitHostAdapter, 'getBranchHead' | 'getFileAtCommit' | 'listPaths'>;
  /**
   * The gateway's models that the data class may use under this configuration: the policy
   * engine's `allowedModels` over `ModelGateway.listModels()` (QUESTIONS #17).
   */
  readonly allowedModels: (
    config: ValidatedProjectConfig,
    dataClass: DataClass,
  ) => Promise<string[]>;
  /**
   * The tenant's monthly budget (decimal string), or null when none is set (code review of C06
   * session 2a). G4 refuses when this month's spend reached it, so a used-up tenant budget fails
   * G4 once instead of starting and cancelling runs again and again.
   */
  readonly tenantMonthlyBudget?: (tenantId: string) => Promise<string | null>;
}

export interface G4Facts {
  /** Head of the project's default branch when G4 was evaluated: the run's base commit. */
  readonly baseSha: string;
  /** O06 (ADR-M106 §2.4): the project's folder in the repository; '' = the whole repository. */
  readonly repoPath: string;
  /** The configured agent's ID and the SHA-256 of its instructions file at `baseSha`. */
  readonly instructions: {
    readonly agentId: string;
    /** Null when the file does not exist at `baseSha` (G4 fails with `instructions_mismatch`). */
    readonly sha256: string | null;
    /**
     * O06 (ADR-M31 §2.5 0.6): the agent's second pinned file at `baseSha`: null when the agent
     * pins none; `sha256: null` when the file does not exist there (`instructions_missing`).
     */
    readonly root: { readonly sha256: string | null } | null;
    /**
     * Agent instruction files at `baseSha` besides the pinned one (C07, QUESTIONS #126):
     * `none`, `found` (with the SHA-256 of their sorted paths: a new file is a new failure; the
     * paths are client data and stay out of the database), or `tree_truncated` (the Git host
     * listed the commit only in part: fail closed, ADR-M34 §2.4).
     */
    readonly unpinned:
      | { readonly kind: 'none' }
      | { readonly kind: 'found'; readonly pathsSha256: string }
      | { readonly kind: 'tree_truncated' };
  } | null;
  readonly allowedModels: readonly string[];
  /** The tenant's monthly budget (USD, decimal string); null: none set or not known. */
  readonly tenantMonthlyBudgetUsd: string | null;
}

const REPO_FULL_NAME = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/;

/** The project's repository, or undefined when the stored name is not `owner/name`. */
export function projectRepoRef(project: Pick<Project, 'repo_full_name'>): RepoRef | undefined {
  const match = REPO_FULL_NAME.exec(project.repo_full_name);
  return match ? { owner: match[1]!, name: match[2]! } : undefined;
}

/**
 * Reads the G4 facts. Throws `GitHostError` when the Git host cannot be read (the step waits and
 * tries again); a missing instructions file is a fact (`sha256: null`), not an error.
 */
export async function gatherG4Facts(
  scope: TenantScope,
  deps: G4Deps,
  intent: Pick<Intent, 'id' | 'project_id' | 'data_class'>,
  /** The head the step already read for the spec check (B08): one head for both. */
  headSha?: string,
): Promise<G4Facts> {
  const project = await scope.projects.getById(intent.project_id);
  const ref = project ? projectRepoRef(project) : undefined;
  if (!project || !ref) throw new GitHostError('invalid_input', { field: 'repo' });
  const { config } = await loadEffectiveConfig(scope.projectConfigs, intent.project_id);
  // QUESTIONS #109: the head of the default branch (B08: the one the spec check read). Once a run
  // of the intent was pushed, the commit it pushed (QUESTIONS #134, C08, ADR-M38 §2.6): the next
  // run continues the pull request.
  const baseSha =
    (await lastPushedHead(scope, intent.id)) ??
    headSha ??
    (await deps.gitHost.getBranchHead(ref, project.default_branch));
  const key = config.run.agent_key;
  const agent = key === null ? undefined : await scope.agents.getByKey(key);
  let instructions: G4Facts['instructions'] = null;
  if (agent) {
    const pinned = instructionsPath(agent);
    const rootPath = rootInstructionsPath(agent);
    instructions = {
      agentId: agent.id,
      sha256: await fileSha256(deps, ref, pinned, baseSha),
      root: rootPath === null ? null : { sha256: await fileSha256(deps, ref, rootPath, baseSha) },
      unpinned: await unpinnedInstructions(
        deps,
        ref,
        baseSha,
        project.repo_path,
        rootPath === null ? [pinned] : [pinned, rootPath],
      ),
    };
  }
  const allowedModels = await deps.allowedModels(config, intent.data_class);
  const tenantMonthlyBudgetUsd = deps.tenantMonthlyBudget
    ? await deps.tenantMonthlyBudget(scope.tenantId)
    : null;
  return {
    baseSha,
    repoPath: project.repo_path,
    instructions,
    allowedModels: [...new Set(allowedModels)].sort(),
    tenantMonthlyBudgetUsd,
  };
}

/**
 * The SHA-256 of a file at `baseSha`, read outside the sandbox (ADR-M31 §2.5); null when the file
 * does not exist there.
 */
async function fileSha256(
  deps: G4Deps,
  ref: RepoRef,
  path: string,
  baseSha: string,
): Promise<string | null> {
  try {
    return instructionsSha256(await deps.gitHost.getFileAtCommit(ref, path, baseSha));
  } catch (error) {
    if (!(error instanceof GitHostError) || !['not_found', 'not_a_file'].includes(error.code)) {
      throw error;
    }
    return null;
  }
}

/**
 * The agent instruction files at `baseSha` other than the pinned ones (QUESTIONS #126): with a
 * folder (O06, ADR-M106 §2.4), only the files the agent reads from that folder and the repository
 * root; files in other folders do not count.
 */
async function unpinnedInstructions(
  deps: G4Deps,
  ref: RepoRef,
  baseSha: string,
  repoPath: string,
  pinnedPaths: readonly string[],
): Promise<NonNullable<G4Facts['instructions']>['unpinned']> {
  let paths: string[];
  try {
    paths = await deps.gitHost.listPaths(ref, baseSha);
  } catch (error) {
    if (error instanceof GitHostError && error.code === 'tree_truncated') {
      return { kind: 'tree_truncated' };
    }
    throw error;
  }
  const found = unpinnedInstructionPathsIn(paths, repoPath, pinnedPaths);
  if (found.length === 0) return { kind: 'none' };
  const pathsSha256 = createHash('sha256').update(canonicalJson([...found].sort()), 'utf8');
  return { kind: 'found', pathsSha256: pathsSha256.digest('hex') };
}

/** The terms of the run that G4 passes or approves (ADR-M33 §2.3). Version 1. */
export interface RunProposal {
  readonly intentId: string;
  readonly planId: string;
  readonly planSha256: string;
  readonly specSha256: string;
  readonly agentId: string;
  readonly agentKey: string;
  readonly agentVersion: string;
  readonly instructionsSha256: string;
  /** The agent's pinned gateway model: the run's model (QUESTIONS #79). */
  readonly modelRef: string;
  readonly autonomyLevel: RunContractAutonomy;
  /** Sorted, unique: the agent's registered tools that the plan lists (B09, QUESTIONS #108). */
  readonly allowedTools: readonly string[];
  /**
   * X04 (ADR-M69 §2.3, §2.6): one grant per register tool of `allowedTools`, sorted by key: the
   * contract's `tool_grants`. Empty when the plan lists no register tool.
   */
  readonly toolGrants: readonly ToolGrant[];
  /** Sorted, unique. */
  readonly allowedModels: readonly string[];
  readonly maxBudgetUsd: string;
  readonly maxIterations: number;
  readonly maxDurationMin: number;
  readonly baseSha: string;
  readonly dataClass: DataClass;
  /** O06: the project's folder ('' = the whole repository). */
  readonly repoPath: string;
  /** O06: the SHA-256 of the agent's second pinned file, or null. */
  readonly rootInstructionsSha256: string | null;
}

/** The G4 input hash: SHA-256 of the canonical JSON of the proposal (the agent key is its ID's). */
export function runProposalSha256(proposal: RunProposal): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        v: 1,
        intent_id: proposal.intentId,
        plan_id: proposal.planId,
        plan_sha256: proposal.planSha256,
        spec_sha256: proposal.specSha256,
        agent_id: proposal.agentId,
        agent_version: proposal.agentVersion,
        instructions_sha256: proposal.instructionsSha256,
        model_ref: proposal.modelRef,
        autonomy_level: proposal.autonomyLevel,
        allowed_tools: [...proposal.allowedTools],
        allowed_models: [...proposal.allowedModels],
        max_budget_usd: proposal.maxBudgetUsd,
        max_iterations: proposal.maxIterations,
        max_duration_min: proposal.maxDurationMin,
        base_sha: proposal.baseSha,
        data_class: proposal.dataClass,
        // X04: only when the run gets register tools, so the hash of every other proposal (and
        // the G4 approvals bound to it) stays the same.
        ...(proposal.toolGrants.length > 0 ? { tool_grants: [...proposal.toolGrants] } : {}),
        // O06: the same way, only for a project with a folder or an agent with a second file.
        ...(proposal.repoPath === '' ? {} : { repo_path: proposal.repoPath }),
        ...(proposal.rootInstructionsSha256 === null
          ? {}
          : { root_instructions_sha256: proposal.rootInstructionsSha256 }),
      }),
      'utf8',
    )
    .digest('hex');
}

/**
 * The input hash of the last run proposal recorded for the intent (`run.proposed`), or null. A G4
 * decision from a person is bound to it (`decideGate`).
 */
export async function latestRunProposalSha256(
  scope: TenantScope,
  intentId: string,
): Promise<string | null> {
  const events = await scope.audit.listForEntity(intentId, ['run.proposed']);
  const payload = events.at(-1)?.payload as { input_sha256?: unknown } | undefined;
  return typeof payload?.input_sha256 === 'string' ? payload.input_sha256 : null;
}

/** Records the proposal (`run.proposed`) unless it is the last one recorded. True when new. */
export async function recordRunProposal(
  scope: TenantScope,
  proposal: RunProposal,
  inputSha256: string,
  at: Date,
): Promise<boolean> {
  if ((await latestRunProposalSha256(scope, proposal.intentId)) === inputSha256) return false;
  await scope.audit.append({
    action: 'run.proposed',
    actorType: 'system',
    actorId: null,
    entityId: proposal.intentId,
    occurredAt: at,
    payload: {
      input_sha256: inputSha256,
      base_sha: proposal.baseSha,
      plan_id: proposal.planId,
      agent_id: proposal.agentId,
      agent_version: proposal.agentVersion,
      instructions_sha256: proposal.instructionsSha256,
      autonomy_level: proposal.autonomyLevel,
    },
  });
  return true;
}
