// The agent check before each run (D-02 FR-36, D-08 C10 AC2–AC4, design/ADR-M31 §2.5). Gate G4
// (C06) calls `checkAgentForRun` before it issues a Run Contract (QUESTIONS #32), and passes the
// returned agent to `issueRunContract` and the returned model to the agent adapter (QUESTIONS #79).
//
// Refusals throw `AgentRegisterError`. An overdue recertification is a warning, not a refusal
// (FR-36): C06 writes the audit event `agent.recertification_overdue` and a notice to the owner.
import { defaultProjectConfig } from '@sdlc/config';
import { AUTONOMY_LEVELS, type AutonomyLevel } from '@sdlc/contracts';

import type { TenantScope } from '../db/tenant-scope.js';
import { loadEffectiveConfig } from '../registry/effective-config.js';
import type { RunContractAgent } from '../run-contract/issue.js';
import { AgentRegisterError } from './errors.js';
import { parseInstructionsRef, recertificationStatus, RUN_ENVIRONMENT } from './rules.js';

export interface AgentRunCheck {
  readonly agentId: string;
  /** The project of the run: its configuration gives the recertification age. */
  readonly projectId: string;
  /** The autonomy level the run gets (the intent's maximum at most; `issueRunContract` checks that). */
  readonly autonomyLevel: AutonomyLevel;
  /** From `PolicyEngine.allowedModels` for the intent's data class: the contract's list. */
  readonly allowedModels: readonly string[];
  /**
   * SHA-256 of the instructions file at the run's base commit, computed by the caller with
   * `instructionsSha256` (the path is `instructionsPath(agent)`), from outside the sandbox.
   */
  readonly instructionsSha256: string;
  /**
   * O06 (ADR-M31 §2.5 0.6): the SHA-256 of the agent's second pinned file at the base commit, or
   * null when it is missing there. Ignored when the agent pins no second file.
   */
  readonly rootInstructionsSha256?: string | null;
  readonly now?: Date;
}

export type AgentRunWarning = 'recertification_overdue';

export interface CheckedAgent {
  /** What `issueRunContract` needs, plus the model the adapter uses. */
  readonly agent: RunContractAgent & {
    readonly key: string;
    /** The pinned gateway model name: the run's model (QUESTIONS #79). */
    readonly modelRef: string;
    /** Who gets the recertification notice. */
    readonly ownerId: string;
  };
  readonly warnings: readonly AgentRunWarning[];
  /** Last day the certification holds; null when never certified. */
  readonly recertificationDueOn: string | null;
}

/** The path of an agent's instructions file in the repository (`AGENTS.md` for `AGENTS.md@v5`). */
export function instructionsPath(agent: { readonly instructions_ref: string }): string {
  return parseInstructionsRef(agent.instructions_ref).path;
}

/** The path of an agent's second pinned file (O06), or null when it pins none. */
export function rootInstructionsPath(agent: {
  readonly root_instructions_ref: string | null;
}): string | null {
  return agent.root_instructions_ref === null
    ? null
    : parseInstructionsRef(agent.root_instructions_ref).path;
}

/**
 * Checks that the agent may run (FR-36): registered in the tenant and `active`, approved for the
 * sandbox, autonomy within its `max_autonomy`, a pinned model that the run allows, and the
 * registered instructions hash. Returns the agent for the Run Contract and any warnings.
 */
export async function checkAgentForRun(
  scope: TenantScope,
  input: AgentRunCheck,
): Promise<CheckedAgent> {
  const agent = await scope.agents.getById(input.agentId);
  if (!agent) throw new AgentRegisterError('agent_not_found', `no agent ${input.agentId}`);
  const key = agent.agent_key;
  if (agent.status !== 'active') {
    throw new AgentRegisterError('agent_not_active', `agent ${key} is ${agent.status}`);
  }
  if (AUTONOMY_LEVELS.indexOf(input.autonomyLevel) > AUTONOMY_LEVELS.indexOf(agent.max_autonomy)) {
    throw new AgentRegisterError(
      'autonomy_above_agent',
      `autonomy ${input.autonomyLevel} is above agent ${key}'s maximum ${agent.max_autonomy}`,
    );
  }
  if (!agent.approved_environments.includes(RUN_ENVIRONMENT)) {
    throw new AgentRegisterError(
      'environment_not_approved',
      `agent ${key} is not approved for ${RUN_ENVIRONMENT}`,
    );
  }
  const modelRef = agent.model_ref;
  if (modelRef === null) {
    throw new AgentRegisterError('model_not_pinned', `agent ${key} has no pinned model`);
  }
  if (!input.allowedModels.includes(modelRef)) {
    throw new AgentRegisterError('model_not_allowed', `agent ${key}'s model is not allowed`);
  }
  if (
    input.instructionsSha256 !== agent.instructions_sha256 ||
    (agent.root_instructions_sha256 !== null &&
      input.rootInstructionsSha256 !== agent.root_instructions_sha256)
  ) {
    throw new AgentRegisterError(
      'instructions_mismatch',
      `the instructions of agent ${key} differ from version ${agent.version}`,
    );
  }
  const { config } = await loadEffectiveConfig(scope.projectConfigs, input.projectId);
  const recert = recertificationStatus(
    agent.last_recertified_at,
    config.agents.recertification_months,
    input.now ?? new Date(),
  );
  return {
    agent: {
      id: agent.id,
      key,
      version: agent.version,
      instructionsSha256: agent.instructions_sha256,
      rootInstructionsSha256: agent.root_instructions_sha256,
      tools: [...agent.allowed_tools],
      adapter: agent.adapter,
      modelRef,
      ownerId: agent.owner_id,
    },
    warnings: recert.overdue ? ['recertification_overdue'] : [],
    recertificationDueOn: recert.dueOn,
  };
}

/**
 * The recertification age in months: from the project's configuration, or the configuration
 * default when no project is given (a tenant-wide list of agents).
 */
export async function recertificationMonths(
  scope: TenantScope,
  projectId: string | null,
): Promise<number> {
  if (projectId === null) return defaultProjectConfig().agents.recertification_months;
  const { config } = await loadEffectiveConfig(scope.projectConfigs, projectId);
  return config.agents.recertification_months;
}
