// One pass of the retention loop (task E05, design/ADR-M51; D-05 §10.1; D-02 FR-44). The worker
// calls it under the retention advisory lock (`SystemScope.withRetentionLock`), so one process at
// a time deletes evidence. Every tenant, in this order:
//
// 1. Holds: take the legal hold off the files of released holds, then set it on the files of
//    active holds (protective: also in `report` mode).
// 2. Locks: for projects that keep evidence longer than the bucket's 180-day lock, move the lock
//    of files whose lock ends soon (protective: also in `report` mode).
// 3. The purge: rows whose retention is over, or every finished intent's rows of a project
//    archived longer than the grace period. The guard first; in `report` mode only counts. Each
//    row is decided again under the intent lock, then every version of its files is deleted, the
//    row marked `purged_at` and `evidence.purged` appended, in one transaction.
// 4. An archived project with nothing left to purge gets `project.purged` once.
//
// Then the orphan sweep: pack files under `packs/` without a row, older than the orphan grace.
//
// A failure of one row, project or tenant is logged and counted; the pass goes on and the next
// pass retries. Logs hold IDs, codes and counts only.
import { EvidenceError, type EvidenceRetentionStore } from '@sdlc/contracts';

import type { PlatformDatabase } from '../db/platform-database.js';
import type { RetentionRow } from '../db/repositories/retention.js';
import type { TenantId } from '../db/tenant-id.js';
import type { TenantScope } from '../db/tenant-scope.js';
import type { PlatformLogger } from '../observability/logger.js';
import { loadEffectiveConfig } from '../registry/effective-config.js';
import { archiveDueFor } from './archive.js';
import { knowledgeTenantPass, type KnowledgePurgeDeps } from './knowledge-pass.js';
import {
  langfuseFinish,
  langfuseStart,
  langfuseTenantPass,
  type LangfusePurgeDeps,
} from './langfuse-pass.js';
import {
  addDays,
  BUCKET_LOCK_DAYS,
  guardTrips,
  LOCK_EXTENSION_MARGIN_DAYS,
  lockTarget,
  purgeDecision,
  retentionCutoff,
  type PurgeCause,
} from './rules.js';

export { archiveTimes } from './archive.js';

export type RetentionMode = 'report' | 'purge';

export interface RetentionSettings {
  readonly mode: RetentionMode;
  /** The evidence bucket (`evidence`): every URI must be in it. */
  readonly bucket: string;
  /** Rows selected per project and step, at most. */
  readonly batch: number;
  readonly guardPercent: number;
  readonly guardFloor: number;
  /** Days after `project.archived` before an archived project's evidence is purged. */
  readonly archiveGraceDays: number;
  /** Hours before a pack file without a row is swept. */
  readonly orphanGraceHours: number;
}

export interface RetentionPassDeps {
  readonly db: PlatformDatabase;
  readonly store: EvidenceRetentionStore;
  readonly logger: PlatformLogger;
  now(): Date;
  readonly settings: RetentionSettings;
  /**
   * Pack IDs the orphan sweep found without a row on an earlier visit, owned by the caller (the
   * loop) across passes. A pack file is deleted only when it is found without a row a second time
   * (review of E05 PR 1); without this set the sweep only counts.
   */
  readonly orphanSuspects?: Set<string>;
  /**
   * E08 (ADR-M53): the Langfuse purge. Absent: `not_deployed` (`project.purged` records it).
   */
  readonly langfuse?: LangfusePurgeDeps;
  /** X04 PR 3a (ADR-M89 §2.4): the index of project documents. Absent: `knowledge-db` is off. */
  readonly knowledge?: KnowledgePurgeDeps;
}

export interface RetentionCounts {
  /** Rows eligible for the purge (in `report` mode: what would be purged). */
  eligible: number;
  purged: number;
  /** Files whose versions the store refused to delete (a lock or a legal hold). */
  refused: number;
  failed: number;
  locksExtended: number;
  holdsApplied: number;
  holdsReleased: number;
  guardTripped: number;
  projectsPurged: number;
  /** Archived projects whose purge was scheduled this pass (`project.purge_scheduled`). */
  archivesScheduled: number;
  orphansFound: number;
  orphansSwept: number;
  /** E08: intents whose Langfuse traces may be purged (in `report` mode: what would be). */
  langfuseDue: number;
  /** E08: delete requests sent to Langfuse. */
  langfuseRequested: number;
  /** E08: purges confirmed (the intent's traces are no longer found). */
  langfuseConfirmed: number;
  /** E08: traces whose tags do not match their intent: nothing of that intent is deleted. */
  langfuseMismatched: number;
  /** E08: intents with more traces than the per-intent guard allows. */
  langfuseGuardTripped: number;
  /** E08: raw OTLP files older than the maximum age (in `report` mode: what would be swept). */
  langfuseRawFound: number;
  langfuseRawSwept: number;
  /** E08: ClickHouse compactions (`APPLY DELETED MASK`). */
  langfuseCompacted: number;
  /** X04: document index versions due for deletion (in `report` mode: what would be deleted). */
  knowledgeDue: number;
  /** X04: document index versions deleted from `knowledge-db` (`knowledge.purged`). */
  knowledgePurged: number;
  /** X04: leftover versions and chunks the sweep deleted from `knowledge-db`. */
  knowledgeSwept: number;
}

export interface RetentionPassResult extends RetentionCounts {
  /** Where the next orphan sweep starts (a key), or null to start again from the beginning. */
  readonly orphanCursor: string | null;
}

/** The evidence prefixes the files of a tenant live under. */
const PREFIXES = ['proposals', 'diffs', 'packs'] as const;
const ORPHAN_PAGE = 200;
/** Pack versions the orphan sweep deletes per pass, at most. */
export const ORPHAN_MAX_PER_PASS = 20;
const PACK_FILE =
  /^packs\/([0-9a-f-]{36})\/([0-9a-f-]{36})\/([0-9a-f-]{36})\/(manifest\.json|pack\.md)$/;

const emptyCounts = (): RetentionCounts => ({
  eligible: 0,
  purged: 0,
  refused: 0,
  failed: 0,
  locksExtended: 0,
  holdsApplied: 0,
  holdsReleased: 0,
  guardTripped: 0,
  projectsPurged: 0,
  archivesScheduled: 0,
  orphansFound: 0,
  orphansSwept: 0,
  langfuseDue: 0,
  langfuseRequested: 0,
  langfuseConfirmed: 0,
  langfuseMismatched: 0,
  langfuseGuardTripped: 0,
  langfuseRawFound: 0,
  langfuseRawSwept: 0,
  langfuseCompacted: 0,
  knowledgeDue: 0,
  knowledgePurged: 0,
  knowledgeSwept: 0,
});

/** A code for logs, never an error message. */
function errorCode(error: unknown): string {
  if (error instanceof EvidenceError) return `evidence_${error.code}`;
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return error instanceof Error ? error.name : 'unexpected';
}

/** One retention pass over every tenant, then the orphan sweep from `orphanCursor`. */
export async function runRetentionPass(
  deps: RetentionPassDeps,
  orphanCursor: string | null,
): Promise<RetentionPassResult> {
  const counts = emptyCounts();
  // E08: the Langfuse key must belong to the expected project before any Langfuse step.
  await langfuseStart(deps);
  for (const tenant of await deps.db.system.listTenants()) {
    try {
      await tenantPass(deps, deps.db.forTenant(tenant.id as TenantId), tenant.slug, counts);
    } catch (error) {
      counts.failed += 1;
      deps.logger.log('error', 'retention.tenant_failed', {
        tenant_id: tenant.id,
        error: errorCode(error),
      });
    }
  }
  let next = orphanCursor;
  try {
    next = await sweepOrphans(deps, orphanCursor, counts);
  } catch (error) {
    counts.failed += 1;
    deps.logger.log('error', 'retention.orphans_failed', { error: errorCode(error) });
  }
  await langfuseFinish(deps, counts);
  return { ...counts, orphanCursor: next };
}

interface Candidate {
  readonly row: RetentionRow;
  readonly cause: PurgeCause;
  readonly retentionDays: number | null;
  readonly archiveDue: boolean;
}

interface ProjectPlan {
  readonly id: string;
  readonly archiveDue: boolean;
}

async function tenantPass(
  deps: RetentionPassDeps,
  scope: TenantScope,
  tenantSlug: string,
  counts: RetentionCounts,
): Promise<void> {
  await applyHolds(deps, scope, counts);
  const candidates: Candidate[] = [];
  const archived: ProjectPlan[] = [];
  const retentionDue = { value: 0 };
  for (const project of await scope.retention.listProjects()) {
    try {
      const plan = await projectPass(deps, scope, project, counts);
      candidates.push(...plan.candidates);
      retentionDue.value += plan.retentionDue;
      if (plan.archiveDue) archived.push({ id: project.id, archiveDue: true });
    } catch (error) {
      counts.failed += 1;
      deps.logger.log('error', 'retention.project_failed', {
        tenant_id: scope.tenantId,
        project_id: project.id,
        error: errorCode(error),
      });
    }
  }
  const forRetention = candidates.filter((c) => c.cause === 'retention');
  let selected = candidates;
  let guardTripped = false;
  // The guard counts every row due for retention, not only this pass's batch, so a bug that makes
  // every row due trips it even when the batch is small.
  const dueForRetention = forRetention.length > 0 ? retentionDue.value : 0;
  if (
    dueForRetention > 0 &&
    guardTrips(dueForRetention, await scope.retention.liveCount(), {
      percent: deps.settings.guardPercent,
      floor: deps.settings.guardFloor,
    })
  ) {
    counts.guardTripped += 1;
    guardTripped = true;
    deps.logger.log('warn', 'retention.guard_tripped', {
      tenant_id: scope.tenantId,
      candidates: dueForRetention,
    });
    selected = candidates.filter((c) => c.cause === 'archive');
  }
  counts.eligible += selected.length;
  if (deps.settings.mode === 'purge') {
    for (const candidate of selected) await purgeOne(deps, scope, candidate, counts);
  }
  // E08 (ADR-M53): the intents' Langfuse traces, before an archived project can be complete.
  await langfuseTenantPass(deps, scope, tenantSlug, counts, guardTripped);
  // X04 (ADR-M89 §2.4): the versions of the projects' document indexes, by the same rules.
  await knowledgeTenantPass(deps, scope, counts);
  if (deps.settings.mode === 'purge') {
    for (const project of archived) await completeArchive(deps, scope, project.id, counts);
  }
}

async function projectPass(
  deps: RetentionPassDeps,
  scope: TenantScope,
  project: { readonly id: string; readonly status: string },
  counts: RetentionCounts,
): Promise<{ candidates: Candidate[]; archiveDue: boolean; retentionDue: number }> {
  const now = deps.now();
  let retentionDays: number | null = null;
  try {
    const { config } = await loadEffectiveConfig(scope.projectConfigs, project.id);
    retentionDays = config.retention.evidence_retention_days;
  } catch (error) {
    // Fail closed: no retention purge and no lock move for this project until it loads again.
    deps.logger.log('warn', 'retention.config_unavailable', {
      tenant_id: scope.tenantId,
      project_id: project.id,
      error: errorCode(error),
    });
  }
  let archiveDue = false;
  if (project.status === 'archived') {
    archiveDue = await archiveDueFor(deps, scope, project.id, now, counts);
  } else if (retentionDays !== null) {
    await extendLocks(deps, scope, project.id, retentionDays, counts);
  }
  if (!archiveDue && retentionDays === null) {
    return { candidates: [], archiveDue, retentionDue: 0 };
  }
  const selection = {
    projectId: project.id,
    cutoff: archiveDue ? now : retentionCutoff(now, retentionDays!),
    limit: deps.settings.batch,
  };
  const rows = await scope.retention.purgeCandidates(selection);
  const retentionDue = archiveDue ? 0 : await scope.retention.countPurgeCandidates(selection);
  const candidates: Candidate[] = [];
  for (const row of rows) {
    const decision = purgeDecision({
      now,
      intentStatus: row.intentStatus,
      intentUpdatedAt: row.intentUpdatedAt,
      createdAt: row.createdAt,
      held: false,
      retentionDays,
      archivePurgeDue: archiveDue,
    });
    if (decision.purge) candidates.push({ row, cause: decision.cause, retentionDays, archiveDue });
  }
  return { candidates, archiveDue, retentionDue };
}

/** Every URI must be in the bucket, under one of the evidence prefixes, in this tenant's folder. */
function urisBelong(row: RetentionRow, bucket: string, tenantId: string): boolean {
  return row.uris.every((uri) =>
    PREFIXES.some((prefix) => uri.startsWith(`s3://${bucket}/${prefix}/${tenantId}/`)),
  );
}

async function purgeOne(
  deps: RetentionPassDeps,
  scope: TenantScope,
  candidate: Candidate,
  counts: RetentionCounts,
): Promise<void> {
  const { row } = candidate;
  if (!urisBelong(row, deps.settings.bucket, scope.tenantId)) {
    counts.failed += 1;
    deps.logger.log('error', 'retention.uri_unexpected', {
      tenant_id: scope.tenantId,
      row_kind: row.kind,
      row_id: row.id,
    });
    return;
  }
  try {
    const outcome = await scope.transaction(async (tx) => {
      const intent = await tx.intents.lockAndGet(row.intentId);
      const fresh = await tx.retention.lockRow(row.kind, row.id);
      if (!intent || !fresh) return 'gone' as const;
      // Decided again, now, under the intent lock, from fresh facts: a hold set meanwhile, a
      // changed intent, project status or configuration wins over the selection.
      const now = deps.now();
      const project = await tx.projects.getById(intent.project_id);
      const archiveDue =
        project?.status === 'archived' &&
        (await archiveDueFor(
          { ...deps, settings: { ...deps.settings, mode: 'report' } },
          tx,
          project.id,
          now,
          counts,
        ));
      let retentionDays: number | null;
      try {
        retentionDays = (await loadEffectiveConfig(tx.projectConfigs, intent.project_id)).config
          .retention.evidence_retention_days;
      } catch {
        // Fail closed, as the selection: no retention purge.
        retentionDays = null;
      }
      const decision = purgeDecision({
        now,
        intentStatus: intent.status,
        intentUpdatedAt: new Date(intent.updated_at),
        createdAt: fresh.createdAt,
        held: await tx.retention.isHeld(intent.id),
        retentionDays,
        archivePurgeDue: archiveDue,
      });
      if (!decision.purge) return 'kept' as const;
      let versions = 0;
      for (const uri of fresh.uris) {
        versions += await deps.store.deleteAllVersions(uri, {
          bypassLock: decision.cause === 'archive' || decision.cause === 'client_deletion',
        });
      }
      await tx.retention.markPurged(fresh.kind, fresh.id);
      await tx.audit.append({
        action: 'evidence.purged',
        actorType: 'system',
        actorId: null,
        entityId: intent.id,
        payload: {
          ...(fresh.kind === 'item'
            ? { item_id: fresh.id }
            : {
                pack_id: fresh.id,
                pack_version: fresh.packVersion!,
                markdown_sha256: fresh.markdownSha256!,
              }),
          kind: fresh.evidenceKind,
          sha256: fresh.sha256,
          versions,
          cause: decision.cause,
        },
      });
      return 'purged' as const;
    });
    if (outcome === 'purged') counts.purged += 1;
  } catch (error) {
    const refused = error instanceof EvidenceError && error.code === 'forbidden';
    if (refused) counts.refused += 1;
    else counts.failed += 1;
    deps.logger.log(refused ? 'warn' : 'error', 'retention.purge_failed', {
      tenant_id: scope.tenantId,
      row_kind: row.kind,
      row_id: row.id,
      error: errorCode(error),
    });
  }
}

async function extendLocks(
  deps: RetentionPassDeps,
  scope: TenantScope,
  projectId: string,
  retentionDays: number,
  counts: RetentionCounts,
): Promise<void> {
  const now = deps.now();
  const rows = await scope.retention.lockCandidates({
    projectId,
    now,
    bucketLockDays: BUCKET_LOCK_DAYS,
    marginDays: LOCK_EXTENSION_MARGIN_DAYS,
    retentionDays,
    limit: deps.settings.batch,
  });
  for (const row of rows) {
    const target = lockTarget({ ...row, now, retentionDays });
    if (target === null) continue;
    try {
      for (const uri of row.uris) await deps.store.extendLock(uri, target);
      await scope.retention.markLockExtended(row.kind, row.id, target);
      counts.locksExtended += 1;
    } catch (error) {
      counts.failed += 1;
      deps.logger.log('error', 'retention.lock_failed', {
        tenant_id: scope.tenantId,
        row_kind: row.kind,
        row_id: row.id,
        error: errorCode(error),
      });
    }
  }
}

/** Released holds first (their legal hold comes off), then active holds (it goes on). */
async function applyHolds(
  deps: RetentionPassDeps,
  scope: TenantScope,
  counts: RetentionCounts,
): Promise<void> {
  for (const hold of await scope.evidenceHolds.listReleasePending(deps.settings.batch)) {
    try {
      // A new hold on the same intent keeps its files held: their legal hold stays on.
      if (!(await scope.evidenceHolds.active(hold.intent_id))) {
        for (const row of await scope.retention.filesOfIntent(hold.intent_id, null)) {
          for (const uri of row.uris) await deps.store.setLegalHold(uri, false);
        }
      }
      await scope.evidenceHolds.markReleaseApplied(hold.id, deps.now());
      counts.holdsReleased += 1;
    } catch (error) {
      counts.failed += 1;
      deps.logger.log('error', 'retention.hold_release_failed', {
        tenant_id: scope.tenantId,
        hold_id: hold.id,
        error: errorCode(error),
      });
    }
  }
  for (const hold of await scope.evidenceHolds.listActive(deps.settings.batch)) {
    const startedAt = deps.now();
    try {
      // Files of the last hour before the previous apply again: a row inserted by a transaction
      // that began before that apply has an earlier `created_at` than the apply.
      const since = hold.applied_at ? addDays(new Date(hold.applied_at), -1 / 24) : null;
      for (const row of await scope.retention.filesOfIntent(hold.intent_id, since)) {
        for (const uri of row.uris) await deps.store.setLegalHold(uri, true);
      }
      await scope.evidenceHolds.markApplied(hold.id, startedAt);
      counts.holdsApplied += 1;
    } catch (error) {
      counts.failed += 1;
      deps.logger.log('error', 'retention.hold_apply_failed', {
        tenant_id: scope.tenantId,
        hold_id: hold.id,
        error: errorCode(error),
      });
    }
  }
}

/** `project.purged` once, when an archived project has nothing left to purge. */
async function completeArchive(
  deps: RetentionPassDeps,
  scope: TenantScope,
  projectId: string,
  counts: RetentionCounts,
): Promise<void> {
  try {
    const tally = await scope.retention.projectCounts(projectId);
    if (tally.remaining > 0 || tally.open > 0) return;
    const langfuse = await langfuseOutcome(deps, scope, projectId);
    if (langfuse === 'wait') return;
    await scope.transaction(async (tx) => {
      const done = await tx.audit.listForEntity(projectId, ['project.purged']);
      if (done.length > 0) return;
      await tx.audit.append({
        action: 'project.purged',
        actorType: 'system',
        actorId: null,
        entityId: projectId,
        payload: {
          intents: tally.intents,
          purged: tally.purged,
          held: tally.held,
          // E08 (ADR-M53): every finished, not held intent's traces are confirmed deleted, or the
          // worker's Langfuse purge is off.
          langfuse,
        },
      });
      counts.projectsPurged += 1;
      deps.logger.log('info', 'retention.project_purged', {
        tenant_id: scope.tenantId,
        project_id: projectId,
        purged: tally.purged,
        held: tally.held,
      });
    });
  } catch (error) {
    counts.failed += 1;
    deps.logger.log('error', 'retention.project_purge_failed', {
      tenant_id: scope.tenantId,
      project_id: projectId,
      error: errorCode(error),
    });
  }
}

/**
 * What `project.purged` records about Langfuse, or `wait`: Langfuse is configured but its purge
 * cannot run (no credential), or some finished, not held intent's traces are not confirmed
 * deleted yet. The project is complete only when Langfuse is too (FR-44, ADR-M53 §2.6).
 */
async function langfuseOutcome(
  deps: RetentionPassDeps,
  scope: TenantScope,
  projectId: string,
): Promise<'purged' | 'not_deployed' | 'wait'> {
  const langfuse = deps.langfuse ?? { status: 'not_deployed' as const };
  if (langfuse.status === 'not_deployed') return 'not_deployed';
  if (langfuse.status === 'unavailable') {
    deps.logger.log('warn', 'retention.project_purge_waits_langfuse', {
      tenant_id: scope.tenantId,
      project_id: projectId,
    });
    return 'wait';
  }
  return (await scope.langfusePurges.unconfirmedCount(projectId)) > 0 ? 'wait' : 'purged';
}

/** One page of pack files; files without a row and older than the grace are deleted (`purge`). */
async function sweepOrphans(
  deps: RetentionPassDeps,
  cursor: string | null,
  counts: RetentionCounts,
): Promise<string | null> {
  const page = await deps.store.listKeys('packs/', cursor, ORPHAN_PAGE);
  const files = new Map<string, { tenantId: string; intentId: string; uris: string[] }>();
  const graceEnd = deps.now().getTime() - deps.settings.orphanGraceHours * 3_600_000;
  for (const key of page.keys) {
    const path = key.uri.slice(`s3://${deps.settings.bucket}/`.length);
    const match = PACK_FILE.exec(path);
    // A file younger than the grace may belong to a build in progress.
    if (!match || key.lastModified.getTime() > graceEnd) continue;
    const [, tenantId, intentId, packId] = match;
    const entry = files.get(packId!) ?? { tenantId: tenantId!, intentId: intentId!, uris: [] };
    entry.uris.push(key.uri);
    files.set(packId!, entry);
  }
  const known = await deps.db.system.existingPackIds([...files.keys()]);
  const suspects = deps.orphanSuspects;
  let swept = 0;
  for (const [packId, entry] of files) {
    if (known.has(packId)) {
      suspects?.delete(packId);
      continue;
    }
    counts.orphansFound += 1;
    // Deleted only when found without a row on an earlier visit too, at most a few per pass: a
    // wrong answer of one query never deletes pack files (review of E05 PR 1).
    if (!suspects?.has(packId)) {
      suspects?.add(packId);
      continue;
    }
    if (deps.settings.mode !== 'purge' || swept >= ORPHAN_MAX_PER_PASS) continue;
    swept += 1;
    await sweepOne(deps, packId, entry, counts);
    suspects.delete(packId);
  }
  return page.next;
}

async function sweepOne(
  deps: RetentionPassDeps,
  packId: string,
  entry: { tenantId: string; intentId: string; uris: string[] },
  counts: RetentionCounts,
): Promise<void> {
  try {
    const tenant = await deps.db.system.getTenant(entry.tenantId as TenantId);
    if (!tenant) {
      deps.logger.log('warn', 'retention.orphan_unknown_tenant', { pack_id: packId });
      return;
    }
    const scope = deps.db.forTenant(tenant.id as TenantId);
    if (!(await scope.intents.getById(entry.intentId))) {
      deps.logger.log('warn', 'retention.orphan_unknown_intent', { pack_id: packId });
      return;
    }
    let versions = 0;
    // Younger than the bucket's lock: the purge identity bypasses it (a file nothing refers to).
    for (const uri of entry.uris)
      versions += await deps.store.deleteAllVersions(uri, { bypassLock: true });
    await scope.audit.append({
      action: 'evidence.orphan_swept',
      actorType: 'system',
      actorId: null,
      entityId: entry.intentId,
      payload: { pack_id: packId, files: entry.uris.length, versions },
    });
    counts.orphansSwept += 1;
  } catch (error) {
    counts.failed += 1;
    deps.logger.log('error', 'retention.orphan_failed', {
      pack_id: packId,
      error: errorCode(error),
    });
  }
}
