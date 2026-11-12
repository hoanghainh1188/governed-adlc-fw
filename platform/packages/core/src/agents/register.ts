// Changing the agent register (task C10, D-08 C10 AC1, handbook Ch.20, design/ADR-M31).
//
// The functions take an optional `actor` (B13): the person who acts through the API, or the
// operator on the server (`system`, the default). Who may do what (handbook Ch.20 §20.7, §20.9,
// §20.11) is checked by the callers: the API through `approvals.ts`, the operator only for the
// safety moves (`adlc ops agent suspend|quarantine`, ADR-M37 §2.8).
//
// Every change and its audit event are one transaction. Audit payloads hold keys, versions,
// status codes and hashes only: never the model name or the owner.
import { isAgentInstructionPath, type AgentAdapterCode, type AgentStatus } from '@sdlc/contracts';

import { auditActor, SYSTEM_ACTOR, type AdminActor } from '../admin/actor.js';
import { DbError } from '../db/errors.js';
import type { Agent } from '../db/schema.js';
import type { TenantScope } from '../db/tenant-scope.js';
import type { AgentUpdate, RootInstructions } from '../db/repositories/agents.js';
import { AgentRegisterError } from './errors.js';
import {
  AGENT_CHANGEABLE_STATUSES,
  AGENT_STATUS_MOVES,
  checkAdapter,
  checkAgentKey,
  checkEnvironments,
  checkMaxAutonomy,
  checkModelRef,
  checkSha256,
  checkTools,
  checkVersion,
  isAgentStatusReason,
  isCalendarDay,
  parseInstructionsRef,
  utcDay,
} from './rules.js';

export interface RegisterAgent {
  readonly agentKey: string;
  readonly version: string;
  readonly ownerId: string;
  /** LiteLLM gateway model name with its version; may be left empty while `proposed`. */
  readonly modelRef?: string | null;
  readonly instructionsRef: string;
  readonly instructionsSha256: string;
  readonly allowedTools: readonly string[];
  readonly maxAutonomy: string;
  readonly approvedEnvironments: readonly string[];
  /** X03 (ADR-M68 §7): the adapter that drives the agent. Default `openhands`. */
  readonly adapter?: string;
  /** O06 (ADR-M31 §2.5 0.6): the repository root's instruction file, pinned too. */
  readonly rootInstructions?: RootInstructions | null;
  readonly now?: Date; /** Who acts (B13). Default: the operator (`system`). */
  readonly actor?: AdminActor;
}

/** A new version of the configuration (Ch.20 §20.9). Left out: unchanged. */
export interface UpdateAgent {
  readonly version: string;
  readonly modelRef?: string | null;
  readonly instructionsRef?: string;
  readonly instructionsSha256?: string;
  readonly allowedTools?: readonly string[];
  readonly maxAutonomy?: string;
  readonly approvedEnvironments?: readonly string[];
  /** X03: another adapter is a new version too (Ch.20 §20.9). */
  readonly adapter?: string;
  /** O06: set, or null to remove; a change is a new version too. */
  readonly rootInstructions?: RootInstructions | null;
  readonly now?: Date; /** Who acts (B13). Default: the operator (`system`). */
  readonly actor?: AdminActor;
}

export interface ChangeAgentStatus {
  readonly to: AgentStatus;
  /** Required for `suspended`, `quarantined` and `retired`. */
  readonly reason?: string;
  readonly now?: Date; /** Who acts (B13). Default: the operator (`system`). */
  readonly actor?: AdminActor;
}

const NEEDS_REASON: readonly AgentStatus[] = ['suspended', 'quarantined', 'retired'];

async function activeOwner(scope: TenantScope, ownerId: string): Promise<string> {
  const owner = await scope.users.getById(ownerId);
  if (owner?.status !== 'active') {
    throw new AgentRegisterError('owner_not_active', 'the owner must be an active user');
  }
  return owner.id;
}

async function lockAgent(scope: TenantScope, agentKey: string): Promise<Agent> {
  const agent = await scope.agents.lockByKey(agentKey);
  if (!agent) throw new AgentRegisterError('agent_not_found', `no agent ${agentKey}`);
  if (agent.status === 'retired') {
    throw new AgentRegisterError('agent_retired', `agent ${agentKey} is retired`);
  }
  return agent;
}

/** Registers a new agent with status `proposed` (Ch.20 §20.5) and appends `agent.registered`. */
export async function registerAgent(scope: TenantScope, input: RegisterAgent): Promise<Agent> {
  checkAgentKey(input.agentKey);
  checkVersion(input.version);
  const modelRef = input.modelRef ?? null;
  if (modelRef !== null) checkModelRef(modelRef);
  parseInstructionsRef(input.instructionsRef);
  checkSha256(input.instructionsSha256);
  const allowedTools = checkTools(input.allowedTools);
  const maxAutonomy = checkMaxAutonomy(input.maxAutonomy);
  const approvedEnvironments = checkEnvironments(input.approvedEnvironments);
  const adapter: AgentAdapterCode = checkAdapter(input.adapter ?? 'openhands');
  const rootInstructions = checkedRoot(input.rootInstructions ?? null);
  return scope.transaction(async (tx) => {
    const ownerId = await activeOwner(tx, input.ownerId);
    if (await tx.agents.getByKey(input.agentKey)) {
      throw new AgentRegisterError('agent_exists', `agent key ${input.agentKey} is taken`);
    }
    const agent = await tx.agents
      .create({
        agentKey: input.agentKey,
        version: input.version,
        ownerId,
        modelRef,
        instructionsRef: input.instructionsRef,
        instructionsSha256: input.instructionsSha256,
        allowedTools,
        maxAutonomy,
        approvedEnvironments,
        adapter,
        rootInstructions,
      })
      .catch((error: unknown) => {
        // Two registrations of the same key at once: the unique index decides (ADR-M31 §2.1).
        if (error instanceof DbError && error.code === 'conflict') {
          throw new AgentRegisterError('agent_exists', `agent key ${input.agentKey} is taken`);
        }
        throw error;
      });
    await tx.audit.append({
      action: 'agent.registered',
      ...auditActor(input.actor ?? SYSTEM_ACTOR),
      entityId: agent.id,
      payload: {
        agent_key: agent.agent_key,
        version: agent.version,
        instructions_sha256: agent.instructions_sha256,
        adapter: agent.adapter,
        ...(agent.root_instructions_sha256 === null
          ? {}
          : { root_instructions_sha256: agent.root_instructions_sha256 }),
      },
    });
    return agent;
  });
}

/**
 * A new version of an agent's configuration: model, instructions, tools, autonomy or
 * environments. Only while `proposed` or `suspended`, and only with a new version label
 * (Ch.20 §20.9: change request → evaluation → approval → new version). Appends `agent.updated`.
 */
export async function updateAgent(
  scope: TenantScope,
  agentKey: string,
  input: UpdateAgent,
): Promise<Agent> {
  checkVersion(input.version);
  const update: AgentUpdate = {
    version: input.version,
    ...(input.modelRef === undefined ? {} : { modelRef: checkedModel(input.modelRef) }),
    ...(input.instructionsRef === undefined
      ? {}
      : { instructionsRef: checkedInstructionsRef(input.instructionsRef) }),
    ...(input.instructionsSha256 === undefined
      ? {}
      : { instructionsSha256: checkedSha256(input.instructionsSha256) }),
    ...(input.allowedTools === undefined ? {} : { allowedTools: checkTools(input.allowedTools) }),
    ...(input.maxAutonomy === undefined
      ? {}
      : { maxAutonomy: checkMaxAutonomy(input.maxAutonomy) }),
    ...(input.approvedEnvironments === undefined
      ? {}
      : { approvedEnvironments: checkEnvironments(input.approvedEnvironments) }),
    ...(input.adapter === undefined ? {} : { adapter: checkAdapter(input.adapter) }),
    ...(input.rootInstructions === undefined
      ? {}
      : { rootInstructions: checkedRoot(input.rootInstructions) }),
  };
  return scope.transaction(async (tx) => {
    const agent = await lockAgent(tx, agentKey);
    if (!AGENT_CHANGEABLE_STATUSES.includes(agent.status)) {
      throw new AgentRegisterError(
        'config_change_not_allowed',
        `agent ${agentKey} is ${agent.status}: suspend it before changing it`,
      );
    }
    if (agent.version === input.version) {
      throw new AgentRegisterError('version_unchanged', `agent ${agentKey} needs a new version`);
    }
    const updated = await tx.agents.update(agent.id, update, input.now ?? new Date());
    await tx.audit.append({
      action: 'agent.updated',
      ...auditActor(input.actor ?? SYSTEM_ACTOR),
      entityId: updated.id,
      payload: {
        agent_key: updated.agent_key,
        version: updated.version,
        instructions_sha256: updated.instructions_sha256,
        adapter: updated.adapter,
        ...(updated.root_instructions_sha256 === null
          ? {}
          : { root_instructions_sha256: updated.root_instructions_sha256 }),
      },
    });
    return updated;
  });
}

/**
 * Moves an agent to another status (Ch.20 §20.7–§20.10) and appends `agent.status_changed`.
 * Activation needs a pinned model; a first activation also counts as the first certification
 * (ADR-M31 §2.6) and appends `agent.recertified`.
 */
export async function changeAgentStatus(
  scope: TenantScope,
  agentKey: string,
  input: ChangeAgentStatus,
): Promise<Agent> {
  if (input.reason === undefined && NEEDS_REASON.includes(input.to)) {
    throw new AgentRegisterError('reason_required', `moving to ${input.to} needs a reason code`);
  }
  if (input.reason !== undefined && !isAgentStatusReason(input.reason)) {
    throw new AgentRegisterError('invalid_input', 'the reason code is not valid', 'reason_code');
  }
  const reason = input.reason;
  const now = input.now ?? new Date();
  return scope.transaction(async (tx) => {
    const agent = await lockAgent(tx, agentKey);
    if (!AGENT_STATUS_MOVES[agent.status].includes(input.to)) {
      throw new AgentRegisterError(
        'status_move_not_allowed',
        `agent ${agentKey}: ${agent.status} cannot become ${input.to}`,
      );
    }
    const certify = input.to === 'active' && agent.last_recertified_at === null;
    if (input.to === 'active' && agent.model_ref === null) {
      throw new AgentRegisterError('model_not_pinned', `agent ${agentKey} has no pinned model`);
    }
    const updated = await tx.agents.update(
      agent.id,
      { status: input.to, ...(certify ? { lastRecertifiedAt: utcDay(now) } : {}) },
      now,
    );
    await tx.audit.append({
      action: 'agent.status_changed',
      ...auditActor(input.actor ?? SYSTEM_ACTOR),
      entityId: updated.id,
      payload: {
        agent_key: updated.agent_key,
        from: agent.status,
        to: updated.status,
        ...(reason === undefined ? {} : { reason_code: reason }),
      },
    });
    if (certify) await appendRecertified(tx, updated, input.actor ?? SYSTEM_ACTOR);
    return updated;
  });
}

/** Gives an agent a new owner, for example when the owner leaves (Ch.20 §20.8). */
export async function changeAgentOwner(
  scope: TenantScope,
  agentKey: string,
  ownerId: string,
  now: Date = new Date(),
  actor: AdminActor = SYSTEM_ACTOR,
): Promise<Agent> {
  return scope.transaction(async (tx) => {
    const agent = await lockAgent(tx, agentKey);
    const owner = await activeOwner(tx, ownerId);
    if (owner === agent.owner_id) return agent;
    const updated = await tx.agents.update(agent.id, { ownerId: owner }, now);
    await tx.audit.append({
      action: 'agent.owner_changed',
      ...auditActor(actor),
      entityId: updated.id,
      payload: { agent_key: updated.agent_key },
    });
    return updated;
  });
}

/**
 * Records a recertification (Ch.20 §20.8) on `day` (`YYYY-MM-DD`, default today in UTC). The day
 * may not be in the future or before the last recertification. Appends `agent.recertified`.
 */
export async function recertifyAgent(
  scope: TenantScope,
  agentKey: string,
  input: {
    readonly day?: string;
    readonly now?: Date;
    readonly actor?: AdminActor;
    /** L10 (ADR-M86 §2.6): the evaluation the recertification named and its result code. */
    readonly evaluation?: { readonly id: string | null; readonly result: string };
  } = {},
): Promise<Agent> {
  const now = input.now ?? new Date();
  const day = input.day ?? utcDay(now);
  if (!isCalendarDay(day) || day > utcDay(now)) {
    throw new AgentRegisterError('recertification_date_invalid', `day ${day} is not valid`);
  }
  return scope.transaction(async (tx) => {
    const agent = await lockAgent(tx, agentKey);
    if (agent.last_recertified_at !== null && day < agent.last_recertified_at) {
      throw new AgentRegisterError(
        'recertification_date_invalid',
        `day ${day} is before the last recertification`,
      );
    }
    const updated = await tx.agents.update(agent.id, { lastRecertifiedAt: day }, now);
    await appendRecertified(tx, updated, input.actor ?? SYSTEM_ACTOR, input.evaluation);
    return updated;
  });
}

async function appendRecertified(
  scope: TenantScope,
  agent: Agent,
  actor: AdminActor,
  evaluation?: { readonly id: string | null; readonly result: string },
): Promise<void> {
  await scope.audit.append({
    action: 'agent.recertified',
    ...auditActor(actor),
    entityId: agent.id,
    payload: {
      agent_key: agent.agent_key,
      // IDs and codes only (ADR-M86 §2.7): never the fingerprint.
      ...(evaluation?.id ? { evaluation_id: evaluation.id } : {}),
      ...(evaluation ? { evaluation_result: evaluation.result } : {}),
    },
  });
}

function checkedModel(value: string | null): string | null {
  if (value !== null) checkModelRef(value);
  return value;
}

/**
 * The second pinned file (O06, ADR-M31 §2.5 0.6): a file the agent reads at the repository root
 * (`AGENTS.md`, `CLAUDE.md`, … one segment), with its SHA-256.
 */
function checkedRoot(root: RootInstructions | null): RootInstructions | null {
  if (root === null) return null;
  const { path } = parseInstructionsRef(root.ref);
  if (path.includes('/') || !isAgentInstructionPath(path)) {
    throw new AgentRegisterError(
      'invalid_input',
      'not a root instructions file',
      'root_instructions_ref',
    );
  }
  return { ref: root.ref, sha256: checkedSha256(root.sha256) };
}

function checkedInstructionsRef(value: string): string {
  parseInstructionsRef(value);
  return value;
}

function checkedSha256(value: string): string {
  checkSha256(value);
  return value;
}
