// The agent register (design/D-05 section 6.1, D-08 C10, design/ADR-M31). Codes only. Rows are
// never deleted; the checks and the audit events live in `agents/` (core), which calls this.
import type { AgentAdapterCode, AgentStatus, AutonomyLevel } from '@sdlc/contracts';

import type { Agent } from '../schema.js';
import { isUuid } from '../tenant-id.js';
import type { AgentEnvironment } from '../vocabulary.js';
import { TenantRepository } from './base.js';

export interface NewAgent {
  readonly agentKey: string;
  readonly version: string;
  readonly ownerId: string;
  readonly modelRef: string | null;
  readonly instructionsRef: string;
  readonly instructionsSha256: string;
  readonly allowedTools: readonly string[];
  readonly maxAutonomy: AutonomyLevel;
  readonly approvedEnvironments: readonly AgentEnvironment[];
  /** X03: default `openhands` (the column default). */
  readonly adapter?: AgentAdapterCode;
  /** O06 (ADR-M31 §2.5 0.6): the repository root's file, pinned too. Absent: none. */
  readonly rootInstructions?: RootInstructions | null;
}

/** The second pinned file of an agent (O06): `ref` as `instructions_ref`, and its SHA-256. */
export interface RootInstructions {
  readonly ref: string;
  readonly sha256: string;
}

/** Columns a change may set. Left out: unchanged. The trigger decides what is allowed. */
export interface AgentUpdate {
  readonly version?: string;
  readonly status?: AgentStatus;
  readonly ownerId?: string;
  readonly modelRef?: string | null;
  readonly instructionsRef?: string;
  readonly instructionsSha256?: string;
  readonly allowedTools?: readonly string[];
  readonly maxAutonomy?: AutonomyLevel;
  readonly approvedEnvironments?: readonly AgentEnvironment[];
  readonly adapter?: AgentAdapterCode;
  /** O06: null removes the second pinned file. */
  readonly rootInstructions?: RootInstructions | null;
  /** `YYYY-MM-DD`. */
  readonly lastRecertifiedAt?: string;
}

export interface AgentQuery {
  readonly statuses?: readonly AgentStatus[];
}

export class AgentRepository extends TenantRepository {
  create(input: NewAgent): Promise<Agent> {
    return this.run(
      this.db
        .insertInto('agents')
        .values({
          tenant_id: this.tenantId,
          agent_key: input.agentKey,
          version: input.version,
          owner_id: input.ownerId,
          model_ref: input.modelRef,
          instructions_ref: input.instructionsRef,
          instructions_sha256: input.instructionsSha256,
          allowed_tools: [...input.allowedTools],
          max_autonomy: input.maxAutonomy,
          approved_environments: [...input.approvedEnvironments],
          ...(input.adapter === undefined ? {} : { adapter: input.adapter }),
          ...rootColumns(input.rootInstructions),
        })
        .returningAll()
        .executeTakeFirstOrThrow(),
    );
  }

  getById(id: string): Promise<Agent | undefined> {
    if (!isUuid(id)) return Promise.resolve(undefined);
    return this.run(
      this.db
        .selectFrom('agents')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', id)
        .executeTakeFirst(),
    );
  }

  getByKey(agentKey: string): Promise<Agent | undefined> {
    return this.run(
      this.db
        .selectFrom('agents')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('agent_key', '=', agentKey)
        .executeTakeFirst(),
    );
  }

  /** Locks the row until the transaction ends, so two changes never interleave. */
  lockByKey(agentKey: string): Promise<Agent | undefined> {
    return this.run(
      this.db
        .selectFrom('agents')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('agent_key', '=', agentKey)
        .forUpdate()
        .executeTakeFirst(),
    );
  }

  list(query: AgentQuery = {}): Promise<Agent[]> {
    let select = this.db.selectFrom('agents').selectAll().where('tenant_id', '=', this.tenantId);
    if (query.statuses !== undefined) {
      if (query.statuses.length === 0) return Promise.resolve([]);
      select = select.where('status', 'in', [...query.statuses]);
    }
    return this.run(select.orderBy('agent_key').execute());
  }

  update(id: string, update: AgentUpdate, at: Date): Promise<Agent> {
    const set = {
      ...(update.version === undefined ? {} : { version: update.version }),
      ...(update.status === undefined ? {} : { status: update.status }),
      ...(update.ownerId === undefined ? {} : { owner_id: update.ownerId }),
      ...(update.modelRef === undefined ? {} : { model_ref: update.modelRef }),
      ...(update.instructionsRef === undefined ? {} : { instructions_ref: update.instructionsRef }),
      ...(update.instructionsSha256 === undefined
        ? {}
        : { instructions_sha256: update.instructionsSha256 }),
      ...(update.allowedTools === undefined ? {} : { allowed_tools: [...update.allowedTools] }),
      ...(update.maxAutonomy === undefined ? {} : { max_autonomy: update.maxAutonomy }),
      ...(update.approvedEnvironments === undefined
        ? {}
        : { approved_environments: [...update.approvedEnvironments] }),
      ...(update.adapter === undefined ? {} : { adapter: update.adapter }),
      ...rootColumns(update.rootInstructions),
      ...(update.lastRecertifiedAt === undefined
        ? {}
        : { last_recertified_at: update.lastRecertifiedAt }),
    };
    return this.run(
      this.db
        .updateTable('agents')
        .set({ ...set, updated_at: at })
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow(),
    );
  }
}

/** The two columns of the second pinned file; nothing when `root` is undefined (unchanged). */
function rootColumns(root: RootInstructions | null | undefined): {
  root_instructions_ref?: string | null;
  root_instructions_sha256?: string | null;
} {
  if (root === undefined) return {};
  return {
    root_instructions_ref: root?.ref ?? null,
    root_instructions_sha256: root?.sha256 ?? null,
  };
}
