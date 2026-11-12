// Client-data purge pass (task H03b, design/ADR-M97 §2.4–§2.5; D-02 FR-44).
// Runs in the worker's retention loop under the same advisory lock. For each tenant in
// `pending_deletion` whose grace period (from `client_data.deletion_approved`) is over:
//
// 1. Revoke API tokens, end web sessions, revoke passkeys (once per tenant, with
//    `client_data.deletion_started`).
// 2. Purge finished, not-held evidence (GOVERNANCE bypass), Langfuse traces and knowledge schemas.
// 3. Open intents or active holds: record `client_data.purge_blocked_by_hold` and stop short of
//    completing.
// 4. When nothing purgeable remains: anonymize people, scrub configs, write `client_data.deleted`,
//    refresh the daily audit anchor when a writer is provided, set the tenant to `purged`.
//
// Codes, IDs and counts only in logs and audit events. Append-only tables are never updated or
// deleted.
import { createHash } from 'node:crypto';

import { EvidenceError, type EvidenceRetentionStore } from '@sdlc/contracts';

import type { PlatformDatabase } from '../db/platform-database.js';
import type { RetentionRow } from '../db/repositories/retention.js';
import type { TenantId } from '../db/tenant-id.js';
import type { TenantScope } from '../db/tenant-scope.js';
import type { PlatformLogger } from '../observability/logger.js';
import {
  langfuseClientDeletionTenantPass,
  langfuseStart,
  type LangfusePurgeDeps,
} from './langfuse-pass.js';
import { allStores, storeForKind, type KnowledgePurgeDeps } from './knowledge-pass.js';
import type { RetentionCounts, RetentionMode } from './pass.js';
import { isFinished, purgeDecision } from './rules.js';

/** Default grace after `client_data.deletion_approved` (ADR-M97 §2.4). */
export const DEFAULT_CLIENT_DELETION_GRACE_DAYS = 14;

const DAY_MS = 86_400_000;
const PREFIXES = ['proposals', 'diffs', 'packs'] as const;

export interface ClientPurgeSettings {
  readonly mode: RetentionMode;
  readonly bucket: string;
  readonly batch: number;
  /** Days after `client_data.deletion_approved` before the purge may start. */
  readonly graceDays: number;
}

export interface ClientPurgePassDeps {
  readonly db: PlatformDatabase;
  readonly store: EvidenceRetentionStore;
  readonly logger: PlatformLogger;
  now(): Date;
  readonly settings: ClientPurgeSettings;
  readonly langfuse?: LangfusePurgeDeps;
  readonly knowledge?: KnowledgePurgeDeps;
  /**
   * Writes today's audit anchor for the tenant after `client_data.deleted` (AC3). Absent: the
   * loop's next anchor pass covers it when today's file is not yet written.
   */
  writeAnchor?(tenantId: string): Promise<void>;
}

export interface ClientPurgeCounts {
  tenantsSeen: number;
  tenantsDue: number;
  tenantsStarted: number;
  tenantsBlocked: number;
  tenantsPurged: number;
  evidencePurged: number;
  evidenceRefused: number;
  knowledgeDropped: number;
  usersAnonymized: number;
  failed: number;
}

export type ClientPurgePassResult = ClientPurgeCounts;

const emptyCounts = (): ClientPurgeCounts => ({
  tenantsSeen: 0,
  tenantsDue: 0,
  tenantsStarted: 0,
  tenantsBlocked: 0,
  tenantsPurged: 0,
  evidencePurged: 0,
  evidenceRefused: 0,
  knowledgeDropped: 0,
  usersAnonymized: 0,
  failed: 0,
});

function errorCode(error: unknown): string {
  if (error instanceof EvidenceError) return `evidence_${error.code}`;
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return error instanceof Error ? error.name : 'unexpected';
}

/** Whether the grace period from the approval event is over. */
export function clientDeletionDue(now: Date, approvedAt: Date | null, graceDays: number): boolean {
  if (approvedAt === null || graceDays < 1) return false;
  return now.getTime() >= approvedAt.getTime() + graceDays * DAY_MS;
}

function urisBelong(row: RetentionRow, bucket: string, tenantId: string): boolean {
  return row.uris.every((uri) =>
    PREFIXES.some((prefix) => uri.startsWith(`s3://${bucket}/${prefix}/${tenantId}/`)),
  );
}

function receiptHash(parts: {
  readonly evidence: number;
  readonly langfuse: number;
  readonly knowledge: number;
  readonly users: number;
  readonly audit: number;
}): string {
  const body = [
    `evidence:${parts.evidence}`,
    `langfuse:${parts.langfuse}`,
    `knowledge:${parts.knowledge}`,
    `users:${parts.users}`,
    `audit:${parts.audit}`,
  ].join('|');
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

/** One pass over every `pending_deletion` tenant. Never throws for a single tenant failure. */
export async function runClientPurgePass(
  deps: ClientPurgePassDeps,
): Promise<ClientPurgePassResult> {
  const counts = emptyCounts();
  await langfuseStart({
    db: deps.db,
    store: deps.store,
    logger: deps.logger,
    now: () => deps.now(),
    settings: {
      mode: deps.settings.mode,
      bucket: deps.settings.bucket,
      batch: deps.settings.batch,
      guardPercent: 100,
      guardFloor: 100_000,
      archiveGraceDays: 1,
      orphanGraceHours: 24,
    },
    langfuse: deps.langfuse,
  });
  for (const tenant of await deps.db.system.listTenants()) {
    if (tenant.status !== 'pending_deletion') continue;
    counts.tenantsSeen += 1;
    try {
      await tenantPass(deps, deps.db.forTenant(tenant.id as TenantId), tenant.slug, counts);
    } catch (error) {
      counts.failed += 1;
      deps.logger.log('error', 'client_purge.tenant_failed', {
        tenant_id: tenant.id,
        error: errorCode(error),
      });
    }
  }
  return counts;
}

async function tenantPass(
  deps: ClientPurgePassDeps,
  scope: TenantScope,
  tenantSlug: string,
  counts: ClientPurgeCounts,
): Promise<void> {
  const now = deps.now();
  const approved = await latestApprovedAt(scope);
  if (!clientDeletionDue(now, approved, deps.settings.graceDays)) return;
  counts.tenantsDue += 1;

  if (await sealDeletedTenant(deps, scope, counts)) return;

  const started = await ensureStarted(deps, scope, now, counts);
  if (!started) return;

  const evidenceBefore = counts.evidencePurged;
  const knowledgeBefore = counts.knowledgeDropped;
  const retentionCounts: RetentionCounts = {
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
  };
  // Evidence first, then Langfuse and knowledge (ADR-M97 §2.5 phase 2).
  if (deps.settings.mode === 'purge') {
    await purgeEvidence(deps, scope, counts);
  }
  await langfuseClientDeletionTenantPass(
    {
      db: deps.db,
      store: deps.store,
      logger: deps.logger,
      now: () => deps.now(),
      settings: {
        mode: deps.settings.mode,
        bucket: deps.settings.bucket,
        batch: deps.settings.batch,
        guardPercent: 100,
        guardFloor: 100_000,
        archiveGraceDays: 1,
        orphanGraceHours: 24,
      },
      langfuse: deps.langfuse,
    },
    scope,
    tenantSlug,
    retentionCounts,
  );
  counts.failed += retentionCounts.failed;

  let knowledgeStoreAbsent = 0;
  if (deps.settings.mode === 'purge' && deps.knowledge) {
    knowledgeStoreAbsent = await dropKnowledge(deps, scope, counts);
  }
  const evidenceThisTenant = counts.evidencePurged - evidenceBefore;
  const knowledgeThisTenant = counts.knowledgeDropped - knowledgeBefore;

  const blockers = await scope.retention.clientPurgeBlockers();
  if (blockers.openIntents > 0 || blockers.activeHolds > 0) {
    await recordBlocked(deps, scope, now, blockers, counts);
    return;
  }

  const remaining = await scope.retention.clientPurgeableRemaining();
  const langfuseLeft = await langfuseRemaining(deps, scope);
  if (remaining > 0 || langfuseLeft > 0 || knowledgeStoreAbsent > 0) {
    deps.logger.log('info', 'client_purge.waiting', {
      tenant_id: scope.tenantId,
      evidence_remaining: remaining,
      langfuse_unconfirmed: langfuseLeft,
      knowledge_store_absent: knowledgeStoreAbsent,
    });
    return;
  }

  if (deps.settings.mode !== 'purge') return;
  await completePurge(deps, scope, now, counts, {
    evidence: evidenceThisTenant,
    knowledge: knowledgeThisTenant,
    langfuse: retentionCounts.langfuseConfirmed,
  });
}

async function latestApprovedAt(scope: TenantScope): Promise<Date | null> {
  const events = await scope.audit.listForEntity(scope.tenantId, ['client_data.deletion_approved']);
  const last = events.at(-1);
  return last ? new Date(last.occurred_at) : null;
}

/** If `client_data.deleted` is already written, finish `purged` when still pending (retry). */
async function sealDeletedTenant(
  deps: ClientPurgePassDeps,
  scope: TenantScope,
  counts: ClientPurgeCounts,
): Promise<boolean> {
  const deleted = await scope.audit.listForEntity(scope.tenantId, ['client_data.deleted']);
  if (deleted.length === 0) return false;
  const tenant = await deps.db.system.getTenant(scope.tenantId);
  if (tenant?.status === 'pending_deletion' && deps.settings.mode === 'purge') {
    const updated = await deps.db.system.setTenantStatus(scope.tenantId, 'purged');
    if (updated) counts.tenantsPurged += 1;
  }
  return true;
}

async function ensureStarted(
  deps: ClientPurgePassDeps,
  scope: TenantScope,
  now: Date,
  counts: ClientPurgeCounts,
): Promise<boolean> {
  const existing = await scope.audit.listForEntity(scope.tenantId, [
    'client_data.deletion_started',
    'client_data.deleted',
  ]);
  if (existing.some((e) => e.action === 'client_data.deleted')) return false;
  if (existing.some((e) => e.action === 'client_data.deletion_started')) return true;
  if (deps.settings.mode !== 'purge') return true;

  await scope.apiTokens.revokeAllActive(now);
  await scope.webSessions.endAllOpen('client_purged', now);
  await scope.webauthnCredentials.revokeAllActive(now);
  await scope.audit.append({
    action: 'client_data.deletion_started',
    actorType: 'system',
    actorId: null,
    entityId: scope.tenantId,
    payload: {
      targets: ['s3', 'langfuse', 'knowledge_db', 'users_pii'],
    },
    occurredAt: now,
  });
  counts.tenantsStarted += 1;
  deps.logger.log('info', 'client_purge.started', { tenant_id: scope.tenantId });
  return true;
}

async function recordBlocked(
  deps: ClientPurgePassDeps,
  scope: TenantScope,
  now: Date,
  blockers: { openIntents: number; activeHolds: number },
  counts: ClientPurgeCounts,
): Promise<void> {
  counts.tenantsBlocked += 1;
  const prior = await scope.audit.listForEntity(scope.tenantId, [
    'client_data.purge_blocked_by_hold',
  ]);
  // One event per blocking episode: skip when the latest client_data event is already this.
  const lifecycle = await scope.audit.listForEntity(scope.tenantId, [
    'client_data.deletion_started',
    'client_data.purge_blocked_by_hold',
    'client_data.deleted',
  ]);
  const last = lifecycle.at(-1);
  if (last?.action === 'client_data.purge_blocked_by_hold' && prior.length > 0) {
    deps.logger.log('warn', 'client_purge.blocked', {
      tenant_id: scope.tenantId,
      open_intents: blockers.openIntents,
      active_holds: blockers.activeHolds,
    });
    return;
  }
  if (deps.settings.mode === 'purge') {
    await scope.audit.append({
      action: 'client_data.purge_blocked_by_hold',
      actorType: 'system',
      actorId: null,
      entityId: scope.tenantId,
      payload: {
        open_intents: blockers.openIntents,
        active_holds: blockers.activeHolds,
      },
      occurredAt: now,
    });
  }
  deps.logger.log('warn', 'client_purge.blocked', {
    tenant_id: scope.tenantId,
    open_intents: blockers.openIntents,
    active_holds: blockers.activeHolds,
  });
}

async function purgeEvidence(
  deps: ClientPurgePassDeps,
  scope: TenantScope,
  counts: ClientPurgeCounts,
): Promise<void> {
  for (const project of await scope.retention.listProjects()) {
    const rows = await scope.retention.clientPurgeCandidates(project.id, deps.settings.batch);
    for (const row of rows) {
      await purgeOneEvidence(deps, scope, row, counts);
    }
  }
}

async function purgeOneEvidence(
  deps: ClientPurgePassDeps,
  scope: TenantScope,
  row: RetentionRow,
  counts: ClientPurgeCounts,
): Promise<void> {
  if (!urisBelong(row, deps.settings.bucket, scope.tenantId)) {
    counts.failed += 1;
    deps.logger.log('error', 'client_purge.uri_unexpected', {
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
      const decision = purgeDecision({
        now: deps.now(),
        intentStatus: intent.status,
        intentUpdatedAt: new Date(intent.updated_at),
        createdAt: fresh.createdAt,
        held: await tx.retention.isHeld(intent.id),
        retentionDays: null,
        archivePurgeDue: false,
        clientDeletionDue: true,
      });
      if (!decision.purge) return 'kept' as const;
      let versions = 0;
      for (const uri of fresh.uris) {
        versions += await deps.store.deleteAllVersions(uri, { bypassLock: true });
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
    if (outcome === 'purged') counts.evidencePurged += 1;
  } catch (error) {
    const refused = error instanceof EvidenceError && error.code === 'forbidden';
    if (refused) counts.evidenceRefused += 1;
    else counts.failed += 1;
    deps.logger.log(refused ? 'warn' : 'error', 'client_purge.evidence_failed', {
      tenant_id: scope.tenantId,
      row_kind: row.kind,
      row_id: row.id,
      error: errorCode(error),
    });
  }
}

/**
 * Deletes the index versions of every finished, not-held intent. Returns how many index versions
 * this worker could not delete because it has no store of their kind (X06): the purge then waits.
 */
async function dropKnowledge(
  deps: ClientPurgePassDeps,
  scope: TenantScope,
  counts: ClientPurgeCounts,
): Promise<number> {
  const knowledge = deps.knowledge;
  if (!knowledge) return 0;
  let storeAbsent = 0;
  for (const project of await scope.retention.listProjects()) {
    try {
      const ready = await scope.knowledgeIndexes.listReady(project.id, deps.settings.batch);
      for (const index of ready) {
        const intents = await scope.knowledgeIndexes.intentsOf(index.id);
        let blocked = false;
        for (const intentId of intents) {
          const intent = await scope.intents.getById(intentId);
          if (!intent || !isFinished(intent.status)) {
            blocked = true;
            break;
          }
          if (await scope.retention.isHeld(intent.id)) {
            blocked = true;
            break;
          }
        }
        if (blocked) continue;
        // X06: a code index goes to the code store; never mark what this worker cannot delete.
        const store = storeForKind(knowledge, index.kind);
        if (!store) {
          storeAbsent += 1;
          counts.failed += 1;
          deps.logger.log('error', 'client_purge.knowledge_store_absent', {
            tenant_id: scope.tenantId,
            project_id: project.id,
            index_id: index.id,
            kind: index.kind,
          });
          continue;
        }
        const now = deps.now();
        const marked = await scope.transaction(async (tx) => {
          const locked = await tx.knowledgeIndexes.lockReady(index.id);
          if (!locked) return false;
          if (!(await tx.knowledgeIndexes.markPurged(locked.id, now))) return false;
          await tx.audit.append({
            action: 'knowledge.purged',
            actorType: 'system',
            actorId: null,
            entityId: project.id,
            payload: {
              index_id: locked.id,
              documents: locked.documents,
              chunks: locked.chunks,
              cause: 'client_deletion',
              kind: locked.kind,
            },
            occurredAt: now,
          });
          return true;
        });
        if (marked) {
          await store.deleteIndexVersion(project.id, index.id);
          counts.knowledgeDropped += 1;
        }
      }
      const left = await scope.knowledgeIndexes.listReady(project.id, 1);
      if (left.length === 0) {
        for (const each of allStores(knowledge)) await each.dropProject(project.id);
      }
    } catch (error) {
      counts.failed += 1;
      deps.logger.log('error', 'client_purge.knowledge_failed', {
        tenant_id: scope.tenantId,
        project_id: project.id,
        error: errorCode(error),
      });
    }
  }
  return storeAbsent;
}

/**
 * How many finished, not-held intents still need a Langfuse confirmation. Absent or
 * `not_deployed`: 0 (nothing to wait for). `unavailable`: treat as blocked (1) so we never seal.
 */
async function langfuseRemaining(deps: ClientPurgePassDeps, scope: TenantScope): Promise<number> {
  const langfuse = deps.langfuse;
  if (!langfuse || langfuse.status === 'not_deployed') return 0;
  if (langfuse.status === 'unavailable') return 1;
  let total = 0;
  for (const project of await scope.retention.listProjects()) {
    total += await scope.langfusePurges.unconfirmedCount(project.id);
  }
  return total;
}

async function completePurge(
  deps: ClientPurgePassDeps,
  scope: TenantScope,
  now: Date,
  counts: ClientPurgeCounts,
  local: { evidence: number; knowledge: number; langfuse: number },
): Promise<void> {
  const users = await scope.users.list();
  let usersAnonymized = 0;
  await scope.transaction(async (tx) => {
    for (const user of users) {
      await tx.clientDataDeletion.anonymizeUser(user.id);
      usersAnonymized += 1;
    }
    await tx.clientDataDeletion.scrubProjectConfigs(now);
  });
  counts.usersAnonymized += usersAnonymized;

  const auditRows = await scope.retention.auditRowCount();
  const hash = receiptHash({
    evidence: local.evidence,
    langfuse: local.langfuse,
    knowledge: local.knowledge,
    users: usersAnonymized,
    audit: auditRows + 1,
  });
  await scope.audit.append({
    action: 'client_data.deleted',
    actorType: 'system',
    actorId: null,
    entityId: scope.tenantId,
    payload: {
      evidence_files_purged: local.evidence,
      langfuse_intents_purged: local.langfuse,
      knowledge_indexes_dropped: local.knowledge,
      users_anonymized: usersAnonymized,
      retained_audit_rows: auditRows + 1,
      deletion_receipt_hash: hash,
    },
    occurredAt: now,
  });
  if (deps.writeAnchor) {
    try {
      await deps.writeAnchor(scope.tenantId);
    } catch (error) {
      deps.logger.log('warn', 'client_purge.anchor_failed', {
        tenant_id: scope.tenantId,
        error: errorCode(error),
      });
    }
  }
  const updated = await deps.db.system.setTenantStatus(scope.tenantId, 'purged');
  if (!updated) {
    counts.failed += 1;
    deps.logger.log('error', 'client_purge.status_failed', { tenant_id: scope.tenantId });
    return;
  }
  counts.tenantsPurged += 1;
  deps.logger.log('info', 'client_purge.completed', {
    tenant_id: scope.tenantId,
    evidence_files_purged: local.evidence,
    users_anonymized: usersAnonymized,
  });
}
