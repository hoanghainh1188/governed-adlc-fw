// The document-index part of the retention pass (task X04 PR 3a, design/ADR-M89 §2.4; D-02
// FR-44). An index version in `knowledge-db` holds client content (document paths and texts). It
// is deleted by the rules of the evidence (`retention/rules.ts`), with its last use as the row's
// date:
//
// - every intent that used it is finished and not held, and the later of the intents' ends and
//   the index's `last_used_at` is older than the project's retention (never under 180 days); or
// - the project is archived and its grace period is over (`archiveDueFor`): every version whose
//   intents are finished and not held. When none is left, the project's schema and read role go.
//
// Each version is decided again under the row's lock and the intents' locks, marked `purged_at`
// and `knowledge.purged` appended, in one transaction; only then is it deleted from the store, so
// a run never reuses a version whose data is gone. A run that reuses the index moves
// `last_used_at` under the same row lock (`recordUse`), so a version in use is never deleted.
//
// The sweep (`purge` mode) then deletes from the store what no ready row covers and is older than
// `SWEEP_GRACE_MS`: a version whose delete failed after its row was marked, a version a failed
// build left without a row, and chunks no version uses (a build that stopped half way). An
// archived project past its grace with no ready version loses its schema and read role.
// In `report` mode the pass only counts. Codes, IDs and counts only in logs.
//
// X06 (ADR-M108 §2.7): the code index (`kind` `code`) follows the same rules; a code version is
// deleted from the code store, the sweep runs on both stores, and an archived project loses both
// schemas.
import type { IndexStoreLifecycle, KnowledgeIndexKind, KnowledgeStore } from '@sdlc/contracts';

import type { KnowledgeIndex } from '../db/schema.js';
import type { TenantScope } from '../db/tenant-scope.js';
import { loadEffectiveConfig } from '../registry/effective-config.js';
import { archiveDueFor } from './archive.js';
import type { RetentionCounts, RetentionPassDeps } from './pass.js';
import { purgeDecision, type PurgeCause } from './rules.js';

export interface KnowledgePurgeDeps {
  readonly store: KnowledgeStore;
  /** X06: the code index store. Absent: a code index is never purged (it cannot be deleted). */
  readonly codeStore?: IndexStoreLifecycle;
}

/** The store that holds index versions of `kind`, if this worker has it. */
export function storeForKind(
  knowledge: KnowledgePurgeDeps,
  kind: KnowledgeIndexKind,
): IndexStoreLifecycle | undefined {
  return kind === 'code' ? knowledge.codeStore : knowledge.store;
}

/** Every store of this worker (the sweep, a project's schemas). */
export function allStores(knowledge: KnowledgePurgeDeps): IndexStoreLifecycle[] {
  return knowledge.codeStore ? [knowledge.store, knowledge.codeStore] : [knowledge.store];
}

/** Store data younger than this is never swept: a build in progress (the run preparation has 5 minutes). */
export const SWEEP_GRACE_MS = 3_600_000;
/** An index no run recorded a use of is decided only after this long, also for an archive. */
export const UNUSED_INDEX_MIN_AGE_MS = 86_400_000;

interface ProjectFacts {
  readonly id: string;
  readonly retentionDays: number | null;
  readonly archiveDue: boolean;
}

/** A code for logs, never an error message. */
function errorCode(error: unknown): string {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return error instanceof Error ? error.name : 'unexpected';
}

/**
 * Whether every intent that used the index lets it go now, and why (the first intent decides
 * `retention` or `archive`). Read through `scope`: inside the purge transaction, with the intent
 * locks, so a hold set meanwhile is seen.
 */
async function indexDecision(
  scope: TenantScope,
  index: KnowledgeIndex,
  project: ProjectFacts,
  now: Date,
  lock: boolean,
): Promise<PurgeCause | null> {
  const intents = await scope.knowledgeIndexes.intentsOf(index.id);
  let cause: PurgeCause | null = null;
  for (const intentId of intents.sort()) {
    const intent = lock
      ? await scope.intents.lockAndGet(intentId)
      : await scope.intents.getById(intentId);
    if (!intent) return null;
    const decision = purgeDecision({
      now,
      intentStatus: intent.status,
      intentUpdatedAt: new Date(intent.updated_at),
      createdAt: new Date(index.last_used_at),
      held: (await scope.evidenceHolds.active(intent.id)) !== undefined,
      retentionDays: project.retentionDays,
      archivePurgeDue: project.archiveDue,
    });
    if (!decision.purge) return null;
    cause ??= decision.cause;
  }
  // An index no run recorded a use of (its run failed in between): by its last use alone, and
  // never while a run may be about to record its use.
  if (intents.length === 0) {
    if (now.getTime() - new Date(index.last_used_at).getTime() < UNUSED_INDEX_MIN_AGE_MS) {
      return null;
    }
    const decision = purgeDecision({
      now,
      intentStatus: 'done',
      intentUpdatedAt: new Date(index.last_used_at),
      createdAt: new Date(index.last_used_at),
      held: false,
      retentionDays: project.retentionDays,
      archivePurgeDue: project.archiveDue,
    });
    cause = decision.purge ? decision.cause : null;
  }
  return cause;
}

async function purgeIndex(
  deps: RetentionPassDeps,
  knowledge: KnowledgePurgeDeps,
  scope: TenantScope,
  project: ProjectFacts,
  indexId: string,
): Promise<boolean> {
  let store: IndexStoreLifecycle | undefined;
  const marked = await scope.transaction(async (tx) => {
    const now = deps.now();
    const index = await tx.knowledgeIndexes.lockReady(indexId);
    if (!index) return false;
    store = storeForKind(knowledge, index.kind);
    // Never mark a version this worker cannot delete: its data would stay with no ready row.
    if (!store) return false;
    const cause = await indexDecision(tx, index, project, now, true);
    if (cause === null) return false;
    if (!(await tx.knowledgeIndexes.markPurged(index.id, now))) return false;
    await tx.audit.append({
      action: 'knowledge.purged',
      actorType: 'system',
      actorId: null,
      entityId: project.id,
      payload: {
        index_id: index.id,
        documents: index.documents,
        chunks: index.chunks,
        cause,
        kind: index.kind,
      },
      occurredAt: now,
    });
    return true;
  });
  // After the commit: a failure here leaves the version to the sweep of a later pass.
  if (marked && store) await store.deleteIndexVersion(project.id, indexId);
  return marked;
}

/** Deletes store data no ready row covers, older than the grace (see the header). */
async function sweepStore(
  deps: RetentionPassDeps,
  knowledge: KnowledgePurgeDeps,
  scope: TenantScope,
  project: ProjectFacts,
  counts: RetentionCounts,
): Promise<void> {
  const before = new Date(deps.now().getTime() - SWEEP_GRACE_MS);
  let readyInStores = 0;
  for (const store of allStores(knowledge)) {
    const versions = await store.listIndexVersions(project.id);
    const ready = await scope.knowledgeIndexes.readyIds(
      project.id,
      versions.map((v) => v.id),
    );
    readyInStores += ready.size;
    for (const version of versions) {
      if (ready.has(version.id) || version.createdAt >= before) continue;
      await store.deleteIndexVersion(project.id, version.id);
      counts.knowledgeSwept += 1;
    }
    counts.knowledgeSwept += await store.deleteOrphanChunks(project.id, before);
  }
  if (project.archiveDue && readyInStores === 0) {
    const left = await scope.knowledgeIndexes.listReady(project.id, 1);
    if (left.length === 0) {
      for (const store of allStores(knowledge)) await store.dropProject(project.id);
    }
  }
}

async function projectFacts(
  deps: RetentionPassDeps,
  scope: TenantScope,
  project: { readonly id: string; readonly status: string },
  counts: RetentionCounts,
): Promise<ProjectFacts> {
  let retentionDays: number | null = null;
  try {
    const { config } = await loadEffectiveConfig(scope.projectConfigs, project.id);
    retentionDays = config.retention.evidence_retention_days;
  } catch {
    // Fail closed, as the evidence: no retention purge while the configuration cannot load.
  }
  const archiveDue =
    project.status === 'archived' &&
    (await archiveDueFor(deps, scope, project.id, deps.now(), counts));
  return { id: project.id, retentionDays, archiveDue };
}

async function projectPass(
  deps: RetentionPassDeps,
  knowledge: KnowledgePurgeDeps,
  scope: TenantScope,
  project: ProjectFacts,
  counts: RetentionCounts,
): Promise<void> {
  if (!project.archiveDue && project.retentionDays === null) return;
  for (const index of await scope.knowledgeIndexes.listReady(project.id, deps.settings.batch)) {
    try {
      if ((await indexDecision(scope, index, project, deps.now(), false)) === null) continue;
      if (!storeForKind(knowledge, index.kind)) {
        // X06: due, but this worker has no store of its kind: never marked, and said so.
        counts.failed += 1;
        deps.logger.log('error', 'retention.knowledge_store_absent', {
          tenant_id: scope.tenantId,
          project_id: project.id,
          index_id: index.id,
          kind: index.kind,
        });
        continue;
      }
      counts.knowledgeDue += 1;
      if (deps.settings.mode !== 'purge') continue;
      if (await purgeIndex(deps, knowledge, scope, project, index.id)) {
        counts.knowledgePurged += 1;
      }
    } catch (error) {
      counts.failed += 1;
      deps.logger.log('error', 'retention.knowledge_failed', {
        tenant_id: scope.tenantId,
        project_id: project.id,
        index_id: index.id,
        error: errorCode(error),
      });
    }
  }
}

/** The document-index step of one tenant. Absent `knowledge-db`: nothing to delete. */
export async function knowledgeTenantPass(
  deps: RetentionPassDeps,
  scope: TenantScope,
  counts: RetentionCounts,
): Promise<void> {
  const knowledge = deps.knowledge;
  if (!knowledge) return;
  for (const project of await scope.retention.listProjects()) {
    try {
      const facts = await projectFacts(deps, scope, project, counts);
      await projectPass(deps, knowledge, scope, facts, counts);
      if (deps.settings.mode === 'purge') await sweepStore(deps, knowledge, scope, facts, counts);
    } catch (error) {
      counts.failed += 1;
      deps.logger.log('error', 'retention.knowledge_failed', {
        tenant_id: scope.tenantId,
        project_id: project.id,
        error: errorCode(error),
      });
    }
  }
}
