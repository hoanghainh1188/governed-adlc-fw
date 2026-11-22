// Plans of an intent (design/D-05 section 6.2). One row per version; rows never change. Reading
// the plan file from the repository: `plans/` (B09, ADR-M40). `change_flags` drive forced HITL at
// G3 and dual approval at G7 through the policy engine.
import { AGENT_TOOLS, CHANGE_FLAGS, isRegisterToolCode, type ChangeFlag } from '@sdlc/contracts';
import { sql, type Kysely } from 'kysely';

import { RegistryError } from '../../registry/errors.js';
import { DbError } from '../errors.js';
import type { Database, Plan } from '../schema.js';
import { AuditLogRepository } from './audit-log.js';
import { TenantRepository } from './base.js';
import { lockIntent } from './locks.js';
import type { RegistryActor } from './registry-actor.js';

export interface SubmitPlan extends RegistryActor {
  /** Files or path patterns expected to change (G5 compares them with the real changes). */
  readonly plannedFiles: readonly string[];
  readonly summary?: string;
  readonly planSha256: string;
  readonly changeFlags?: readonly ChangeFlag[];
  /**
   * B09 (ADR-M40): a plan read from its file in the repository. All three come together, from a
   * person (`actorType: 'human'`, `submittedBy` = `actorId`), and the plan has no summary.
   */
  readonly file?: {
    readonly commitSha: string;
    readonly allowedTools: readonly string[];
  };
  /**
   * U10 (ADR-M113, #559): a Low-risk (or configured Medium-risk) plan uploaded directly to
   * SeaweedFS without merging a PR to the default branch before G3. Mutually exclusive with `file`.
   */
  readonly uploaded?: {
    readonly storageUri: string;
    readonly allowedTools: readonly string[];
  };
}

const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const MAX_PLANNED_FILES = 1000;

const SCALAR_COLUMNS = [
  'id',
  'tenant_id',
  'intent_id',
  'version',
  'planned_files',
  'summary',
  'plan_sha256',
  'proposed_by_type',
  'commit_sha',
  'allowed_tools',
  'submitted_by',
  'plan_source',
  'storage_uri',
  'created_at',
] as const;
// `pg` does not parse arrays of custom enum types; read them as text[].
const changeFlags = sql<ChangeFlag[]>`change_flags::text[]`.as('change_flags');

export class PlanRepository extends TenantRepository {
  /**
   * Stores a new plan version (latest + 1). In the same transaction, appends `plan.submitted` with
   * the version and plan hash (never the file list or the summary).
   */
  async submit(intentId: string, input: SubmitPlan): Promise<Plan> {
    const files: readonly unknown[] = input.plannedFiles;
    if (
      !Array.isArray(input.plannedFiles) ||
      files.length === 0 ||
      files.length > MAX_PLANNED_FILES ||
      files.some(
        (f) => typeof f !== 'string' || f.length === 0 || f.length > 1024 || f.includes('\0'),
      )
    ) {
      throw invalid(`plannedFiles must hold 1 to ${String(MAX_PLANNED_FILES)} paths or patterns`);
    }
    if (!SHA256.test(input.planSha256)) throw invalid('planSha256 must be a SHA-256 digest');
    const flags = [...new Set(input.changeFlags ?? [])];
    if (flags.some((flag) => !CHANGE_FLAGS.includes(flag))) throw invalid('unknown change flag');
    const file = input.file;
    const uploaded = input.uploaded;
    if (file && uploaded) throw invalid('file and uploaded plan sources are mutually exclusive');
    const sourced = file ?? uploaded;
    if (sourced) {
      const tools: readonly unknown[] = sourced.allowedTools;
      if (file && !COMMIT_SHA.test(file.commitSha)) {
        throw invalid('commitSha must be a 40-hex commit SHA');
      }
      if (
        uploaded &&
        (typeof uploaded.storageUri !== 'string' ||
          uploaded.storageUri.length === 0 ||
          uploaded.storageUri.length > 512)
      ) {
        throw invalid('storageUri must be a non-empty string up to 512 characters');
      }
      if (
        tools.length === 0 ||
        tools.some(
          (tool) =>
            typeof tool !== 'string' ||
            (!(AGENT_TOOLS as readonly unknown[]).includes(tool) && !isRegisterToolCode(tool)),
        ) ||
        new Set(tools).size !== tools.length ||
        tools.filter((tool) => typeof tool === 'string' && isRegisterToolCode(tool)).length > 10
      ) {
        throw invalid('allowedTools must hold unique agent or register tools');
      }
      if (input.actorType !== 'human' || input.actorId === null || (input.summary ?? '') !== '') {
        throw invalid('a plan file is submitted by a person and has no summary');
      }
    }
    return this.run(
      this.transactional(async (db) => {
        await lockIntent(db, intentId);
        const intent = await db
          .selectFrom('intents')
          .select('id')
          .where('tenant_id', '=', this.tenantId)
          .where('id', '=', intentId)
          .executeTakeFirst();
        if (!intent) throw new RegistryError('intent_not_found', `intent ${intentId} not found`);
        const last = await db
          .selectFrom('plans')
          .select(sql<number | null>`max(version)`.as('version'))
          .where('tenant_id', '=', this.tenantId)
          .where('intent_id', '=', intentId)
          .executeTakeFirst();
        const plan = await db
          .insertInto('plans')
          .values({
            tenant_id: this.tenantId,
            intent_id: intentId,
            version: (last?.version ?? 0) + 1,
            planned_files: [...input.plannedFiles],
            summary: input.summary ?? '',
            plan_sha256: input.planSha256,
            proposed_by_type: input.actorType,
            change_flags: flags,
            commit_sha: file?.commitSha ?? null,
            allowed_tools: sourced ? [...sourced.allowedTools] : null,
            submitted_by: sourced ? input.actorId : null,
            plan_source: uploaded ? 'uploaded' : 'repo',
            storage_uri: uploaded?.storageUri ?? null,
          })
          .returning([...SCALAR_COLUMNS, changeFlags])
          .executeTakeFirstOrThrow();
        await new AuditLogRepository(db, this.tenantId).append({
          action: 'plan.submitted',
          actorType: input.actorType,
          actorId: input.actorId,
          entityId: intentId,
          payload: {
            plan_id: plan.id,
            version: plan.version,
            plan_sha256: plan.plan_sha256,
            ...(plan.commit_sha === null ? {} : { commit_sha: plan.commit_sha }),
            ...(plan.plan_source === 'uploaded' ? { plan_source: plan.plan_source } : {}),
          },
        });
        return plan;
      }),
    );
  }

  latest(intentId: string): Promise<Plan | undefined> {
    return this.run(latestPlan(this.db, this.tenantId, intentId));
  }

  list(intentId: string): Promise<Plan[]> {
    return this.run(
      this.db
        .selectFrom('plans')
        .select([...SCALAR_COLUMNS, changeFlags])
        .where('tenant_id', '=', this.tenantId)
        .where('intent_id', '=', intentId)
        .orderBy('version')
        .execute(),
    );
  }
}

/** The latest plan of an intent, on any connection (used inside gate decision transactions). */
export function latestPlan(
  db: Kysely<Database>,
  tenantId: string,
  intentId: string,
): Promise<Plan | undefined> {
  return db
    .selectFrom('plans')
    .select([...SCALAR_COLUMNS, changeFlags])
    .where('tenant_id', '=', tenantId)
    .where('intent_id', '=', intentId)
    .orderBy('version', 'desc')
    .limit(1)
    .executeTakeFirst();
}

function invalid(message: string): DbError {
  return new DbError('invalid_value', message);
}
