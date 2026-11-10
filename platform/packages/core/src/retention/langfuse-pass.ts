// The Langfuse part of the retention pass (task E08, design/ADR-M53; D-05 §10.1; D-02 FR-44).
// LiteLLM's traces in Langfuse hold the prompts and responses of model calls (client data,
// ADR-M35). An intent's traces are deleted when its evidence may be purged, by the same rules
// (`retention/rules.ts`): an archived project after its grace period, or the project's retention
// with the 180-day code minimum; never open or held intents.
//
// Per tenant (`langfuseTenantPass`), for each project:
// 1. Select finished intents without a confirmed Langfuse purge (the first filter), decide again
//    with the rules (the second), and in `purge` mode decide a third time under the intent lock.
// 2. Find the intent's traces by its run tags (`run_id:<uuid>`, our own run IDs), never by slugs.
// 3. Check every trace's tags: exactly one `tenant:`, `project:`, `intent_id:` and `run_id:` tag,
//    and they are this tenant's slug, this project's slug, this intent's code and one of its runs.
//    One trace that does not match: nothing of the intent is deleted (logged, counted).
// 4. More than `MAX_TRACES_PER_INTENT` traces: nothing is deleted (the per-intent guard).
// 5. Ask Langfuse to delete (`langfuse.purge_requested`). Langfuse deletes asynchronously; a later
//    pass that finds none confirms (`langfuse.purged`). Found again: asked again.
//
// After every tenant (`langfuseFinish`), once per pass:
// - The raw OTLP files Langfuse keeps in SeaweedFS (`langfuse/events/otel/…`) are swept by age,
//   for every tenant: one file holds a whole OTLP batch of several tenants, so they cannot be
//   deleted per project (ADR-M53 §2.4). Langfuse's ingestion replay of older files is given up.
// - ClickHouse keeps deleted rows on disk until a merge: after a pass that confirmed purges with
//   traces, at most once per UTC day, `APPLY DELETED MASK` removes them (`compactDeleted`).
//
// Codes, IDs and counts only in logs and audit events: never a trace ID, a tag or text.
import {
  EvidenceError,
  LlmTraceError,
  type EvidenceRetentionStore,
  type LlmTraceRef,
  type LlmTraceStore,
} from '@sdlc/contracts';

import type { LangfuseCandidate } from '../db/repositories/langfuse-purges.js';
import type { TenantScope } from '../db/tenant-scope.js';
import { loadEffectiveConfig } from '../registry/effective-config.js';
import type { RetentionCounts, RetentionPassDeps } from './pass.js';
import { archiveDueFor } from './archive.js';
import { guardTrips, purgeDecision, retentionCutoff, type PurgeCause } from './rules.js';

/** More traces than this for one intent: nothing is deleted (the per-intent guard, ADR-M53 §2.5). */
export const MAX_TRACES_PER_INTENT = 5000;
/** Run tags per Langfuse selection. */
export const RUN_TAGS_PER_QUERY = 50;
/** Pages of raw files the sweep reads per pass, at most. */
export const RAW_PAGES_PER_PASS = 20;
/** An intent that tripped the tag check or the guard is left alone this long (per process). */
export const SET_ASIDE_HOURS = 24;
const RAW_PAGE = 1000;
const HOUR_MS = 3_600_000;

export interface LangfusePurgeSettings {
  /** Intents per project and pass, at most. */
  readonly batch: number;
  /** Raw OTLP files older than this are swept (at least 1 hour; default 24). */
  readonly rawMaxAgeHours: number;
  /** Raw files deleted per pass, at most. */
  readonly rawBatch: number;
  /** The Langfuse project the collector writes to (`LANGFUSE_INIT_PROJECT_ID`). */
  readonly projectId: string;
  /** The purge guard of the evidence (ADR-M51 §2.4), applied to the intents due for retention. */
  readonly guardPercent: number;
  readonly guardFloor: number;
}

/** Owned by the caller (the loop) across passes. */
export interface LangfusePurgeState {
  /** A confirmed purge with traces since the last `compactDeleted`. */
  maskOwed: boolean;
  /** The UTC date (`YYYY-MM-DD`) of the last `compactDeleted`. */
  maskedOn: string | null;
  /** Set by `langfuseStart` for the current pass: the key's project is the expected one. */
  verified?: boolean;
  /** Intent ID → until when it is set aside (tag mismatch, guard). */
  setAside?: Map<string, number>;
}

/**
 * - `not_deployed`: the worker's Langfuse purge is off (`SDLC_WORKER_LANGFUSE_URL=off`):
 *   `project.purged` records `langfuse: not_deployed`.
 * - `unavailable`: Langfuse is configured but its credential is missing: nothing is purged in
 *   Langfuse, and archived projects wait (`project.purged` is not written).
 * - `on`: the purge runs.
 */
export type LangfusePurgeDeps =
  | { readonly status: 'not_deployed' }
  | { readonly status: 'unavailable' }
  | {
      readonly status: 'on';
      readonly store: LlmTraceStore;
      /** The S3 store of the bucket `langfuse`, limited to `rawPrefix`. */
      readonly rawStore: EvidenceRetentionStore;
      /** `events/otel/`. */
      readonly rawPrefix: string;
      readonly settings: LangfusePurgeSettings;
      readonly state: LangfusePurgeState;
    };

type OnDeps = Extract<LangfusePurgeDeps, { status: 'on' }>;

/** A code for logs, never an error message. */
function errorCode(error: unknown): string {
  if (error instanceof LlmTraceError) return `langfuse_${error.code}`;
  if (error instanceof EvidenceError) return `evidence_${error.code}`;
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return error instanceof Error ? error.name : 'unexpected';
}

/** The labels a trace of this intent must carry (ADR-M24 §2.2): one of each, these values. */
export interface ExpectedTraceLabels {
  readonly tenant: string;
  readonly project: string;
  readonly intentCode: string;
  /** Every run ID of the intent. */
  readonly runIds: ReadonlySet<string>;
}

const valuesOf = (tags: readonly string[], label: string): string[] =>
  tags.filter((tag) => tag.startsWith(`${label}:`)).map((tag) => tag.slice(label.length + 1));

/**
 * Whether the trace belongs to this intent: exactly one tag of each of the four labels, with
 * this tenant's slug, this project's slug, this intent's code and one of its run IDs. A trace of
 * another tenant, project or intent, a renamed slug, or a trace without labels never matches.
 */
export function traceBelongs(trace: LlmTraceRef, expected: ExpectedTraceLabels): boolean {
  const one = (label: string): string | undefined => {
    const values = valuesOf(trace.tags, label);
    return values.length === 1 ? values[0] : undefined;
  };
  const run = one('run_id');
  return (
    one('tenant') === expected.tenant &&
    one('project') === expected.project &&
    one('intent_id') === expected.intentCode &&
    run !== undefined &&
    expected.runIds.has(run)
  );
}

/**
 * Before the tenants, once per pass: the key must belong to the Langfuse project the collector
 * writes to. A key of another project would find no trace and "confirm" every purge for ever
 * (review of E08). Not verified: no Langfuse step and no raw sweep this pass.
 */
export async function langfuseStart(deps: RetentionPassDeps): Promise<void> {
  const langfuse = deps.langfuse;
  if (langfuse?.status !== 'on') return;
  langfuse.state.verified = false;
  try {
    const projectId = await langfuse.store.projectId();
    if (projectId === langfuse.settings.projectId) {
      langfuse.state.verified = true;
      return;
    }
    deps.logger.log('error', 'retention.langfuse_project_mismatch', {});
  } catch (error) {
    deps.logger.log('error', 'retention.langfuse_unavailable', { error: errorCode(error) });
  }
}

/**
 * The Langfuse step of one tenant. Counts in `report` mode; requests in `purge` mode.
 * `evidenceGuardTripped`: the evidence guard of this tenant tripped this pass; then only archive
 * purges run here too.
 */
export async function langfuseTenantPass(
  deps: RetentionPassDeps,
  scope: TenantScope,
  tenantSlug: string,
  counts: RetentionCounts,
  evidenceGuardTripped = false,
): Promise<void> {
  const langfuse = deps.langfuse;
  if (langfuse?.status !== 'on' || langfuse.state.verified !== true) return;
  const now = deps.now();
  const setAside = (langfuse.state.setAside ??= new Map<string, number>());
  for (const [id, until] of setAside) if (until <= now.getTime()) setAside.delete(id);
  const plans: ProjectPlan[] = [];
  for (const project of await scope.retention.listProjects()) {
    try {
      plans.push(await projectPlan(deps, langfuse, scope, project, now));
    } catch (error) {
      counts.failed += 1;
      deps.logger.log('error', 'retention.langfuse_project_failed', {
        tenant_id: scope.tenantId,
        project_id: project.id,
        error: errorCode(error),
      });
    }
  }
  // The guard: every intent due for retention counts, not only this pass's batch.
  const dueForRetention = plans.reduce((sum, plan) => sum + plan.retentionDue, 0);
  let retentionAllowed = !evidenceGuardTripped;
  if (
    retentionAllowed &&
    dueForRetention > 0 &&
    guardTrips(dueForRetention, await scope.langfusePurges.finishedCount(), {
      percent: langfuse.settings.guardPercent,
      floor: langfuse.settings.guardFloor,
    })
  ) {
    retentionAllowed = false;
    counts.langfuseGuardTripped += 1;
    deps.logger.log('warn', 'retention.langfuse_tenant_guard_tripped', {
      tenant_id: scope.tenantId,
      candidates: dueForRetention,
    });
  }
  for (const plan of plans) {
    for (const candidate of plan.candidates) {
      const decision = purgeDecision({
        now,
        intentStatus: candidate.intentStatus,
        intentUpdatedAt: candidate.intentUpdatedAt,
        createdAt: candidate.intentUpdatedAt,
        held: false,
        retentionDays: plan.retentionDays,
        archivePurgeDue: plan.archiveDue,
      });
      if (!decision.purge || (decision.cause === 'retention' && !retentionAllowed)) continue;
      counts.langfuseDue += 1;
      if (deps.settings.mode !== 'purge') continue;
      await purgeIntent(
        deps,
        langfuse,
        scope,
        tenantSlug,
        plan.project,
        candidate,
        counts,
        retentionAllowed,
      );
    }
  }
}

/**
 * Langfuse step for a tenant in client-data deletion (H03b): every finished, not-held intent is
 * due now (no retention age, no archive status). Uses cause `client_deletion`.
 */
export async function langfuseClientDeletionTenantPass(
  deps: RetentionPassDeps,
  scope: TenantScope,
  tenantSlug: string,
  counts: RetentionCounts,
): Promise<void> {
  const langfuse = deps.langfuse;
  if (langfuse?.status !== 'on' || langfuse.state.verified !== true) return;
  const now = deps.now();
  const setAside = (langfuse.state.setAside ??= new Map<string, number>());
  for (const [id, until] of setAside) if (until <= now.getTime()) setAside.delete(id);
  for (const project of await scope.retention.listProjects()) {
    try {
      const candidates = await scope.langfusePurges.candidates({
        projectId: project.id,
        cutoff: now,
        limit: langfuse.settings.batch,
        excludeIds: [...(langfuse.state.setAside?.keys() ?? [])],
      });
      for (const candidate of candidates) {
        counts.langfuseDue += 1;
        if (deps.settings.mode !== 'purge') continue;
        await purgeIntent(
          deps,
          langfuse,
          scope,
          tenantSlug,
          project,
          candidate,
          counts,
          true,
          true,
        );
      }
    } catch (error) {
      counts.failed += 1;
      deps.logger.log('error', 'retention.langfuse_project_failed', {
        tenant_id: scope.tenantId,
        project_id: project.id,
        error: errorCode(error),
      });
    }
  }
}

interface ProjectPlan {
  readonly project: { readonly id: string; readonly slug: string };
  readonly retentionDays: number | null;
  readonly archiveDue: boolean;
  readonly candidates: readonly LangfuseCandidate[];
  /** Intents due for retention (not archive), without the batch limit. */
  readonly retentionDue: number;
}

/** The project's retention days, or null when its configuration cannot be loaded (fail closed). */
async function retentionDaysOf(scope: TenantScope, projectId: string): Promise<number | null> {
  try {
    return (await loadEffectiveConfig(scope.projectConfigs, projectId)).config.retention
      .evidence_retention_days;
  } catch {
    return null;
  }
}

async function projectPlan(
  deps: RetentionPassDeps,
  langfuse: OnDeps,
  scope: TenantScope,
  project: { readonly id: string; readonly slug: string; readonly status: string },
  now: Date,
): Promise<ProjectPlan> {
  const retentionDays = await retentionDaysOf(scope, project.id);
  // Report mode here: the evidence step schedules the archive purge (`project.purge_scheduled`).
  const reportDeps = { ...deps, settings: { ...deps.settings, mode: 'report' as const } };
  const archiveDue =
    project.status === 'archived' &&
    (await archiveDueFor(reportDeps, scope, project.id, now, emptyArchiveCounts()));
  if (!archiveDue && retentionDays === null) {
    return { project, retentionDays, archiveDue, candidates: [], retentionDue: 0 };
  }
  const selection = {
    projectId: project.id,
    cutoff: archiveDue ? now : retentionCutoff(now, retentionDays!),
  };
  const candidates = await scope.langfusePurges.candidates({
    ...selection,
    limit: langfuse.settings.batch,
    excludeIds: [...(langfuse.state.setAside?.keys() ?? [])],
  });
  const retentionDue = archiveDue ? 0 : await scope.langfusePurges.countCandidates(selection);
  return { project, retentionDays, archiveDue, candidates, retentionDue };
}

/** `archiveDueFor` in report mode schedules nothing and counts nothing. */
const emptyArchiveCounts = () => ({ archivesScheduled: 0 }) as RetentionCounts;

type Outcome =
  | { readonly kind: 'none' }
  | { readonly kind: 'set_aside' }
  | { readonly kind: 'confirmed'; readonly hadTraces: boolean }
  | { readonly kind: 'requested'; readonly traceIds: readonly string[]; readonly attempt: number };

/**
 * Decides again under the intent lock, selects and checks the traces, then records the request
 * (row and audit) or the confirmation in that transaction. The delete itself is sent after the
 * commit, so a recorded request never misses its audit event; a failed delete is asked again on
 * the next pass (review of E08).
 */
async function purgeIntent(
  deps: RetentionPassDeps,
  langfuse: OnDeps,
  scope: TenantScope,
  tenantSlug: string,
  project: { readonly id: string; readonly slug: string },
  candidate: LangfuseCandidate,
  counts: RetentionCounts,
  retentionAllowed: boolean,
  clientDeletion = false,
): Promise<void> {
  const log = (level: 'info' | 'warn' | 'error', event: string, fields = {}) =>
    deps.logger.log(level, event, {
      tenant_id: scope.tenantId,
      intent_id: candidate.intentId,
      ...fields,
    });
  const setAside = () =>
    langfuse.state.setAside?.set(
      candidate.intentId,
      deps.now().getTime() + SET_ASIDE_HOURS * HOUR_MS,
    );
  let outcome: Outcome;
  try {
    outcome = await scope.transaction(async (tx): Promise<Outcome> => {
      const intent = await tx.intents.lockAndGet(candidate.intentId);
      if (!intent || intent.project_id !== project.id) return { kind: 'none' };
      // Decided again, now, under the intent lock, from fresh facts: a hold set meanwhile, a
      // changed project status or configuration wins over the selection.
      const now = deps.now();
      const fresh = await tx.projects.getById(project.id);
      const reportDeps = { ...deps, settings: { ...deps.settings, mode: 'report' as const } };
      const archiveDue =
        !clientDeletion &&
        fresh?.status === 'archived' &&
        (await archiveDueFor(reportDeps, tx, project.id, now, emptyArchiveCounts()));
      const decision = purgeDecision({
        now,
        intentStatus: intent.status,
        intentUpdatedAt: new Date(intent.updated_at),
        createdAt: new Date(intent.updated_at),
        held: await tx.retention.isHeld(intent.id),
        retentionDays: clientDeletion ? 180 : await retentionDaysOf(tx, project.id),
        archivePurgeDue: archiveDue,
        clientDeletionDue: clientDeletion,
      });
      if (!decision.purge || (decision.cause === 'retention' && !retentionAllowed)) {
        return { kind: 'none' };
      }
      const cause: PurgeCause = decision.cause;
      const runIds = new Set((await tx.runs.listForIntent(intent.id)).map((run) => run.id));
      let traces: readonly LlmTraceRef[];
      try {
        traces = await findIntentTraces(langfuse.store, runIds);
      } catch (error) {
        if (error instanceof LlmTraceError && error.code === 'too_many') {
          counts.langfuseGuardTripped += 1;
          log('warn', 'retention.langfuse_guard_tripped', { max: MAX_TRACES_PER_INTENT });
          return { kind: 'set_aside' };
        }
        throw error;
      }
      const expected = {
        tenant: tenantSlug,
        project: project.slug,
        intentCode: intent.code,
        runIds,
      };
      const mismatched = traces.filter((trace) => !traceBelongs(trace, expected)).length;
      if (mismatched > 0) {
        counts.langfuseMismatched += mismatched;
        log('warn', 'retention.langfuse_tag_mismatch', { traces: traces.length, mismatched });
        return { kind: 'set_aside' };
      }
      const existing = await tx.langfusePurges.get(intent.id);
      const recordedCause = existing?.cause ?? cause;
      if (traces.length === 0) {
        if (!(await tx.langfusePurges.confirm({ intentId: intent.id, cause, at: now }))) {
          return { kind: 'none' };
        }
        await tx.audit.append({
          action: 'langfuse.purged',
          actorType: 'system',
          actorId: null,
          entityId: intent.id,
          payload: {
            traces: existing?.traces ?? 0,
            attempts: existing?.attempts ?? 0,
            cause: recordedCause,
          },
        });
        return { kind: 'confirmed', hadTraces: (existing?.traces ?? 0) > 0 };
      }
      const attempt = await tx.langfusePurges.recordRequest({
        intentId: intent.id,
        cause: recordedCause,
        traces: traces.length,
        at: now,
      });
      await tx.audit.append({
        action: 'langfuse.purge_requested',
        actorType: 'system',
        actorId: null,
        entityId: intent.id,
        payload: { traces: traces.length, attempt, cause: recordedCause },
      });
      return { kind: 'requested', traceIds: traces.map((trace) => trace.traceId), attempt };
    });
  } catch (error) {
    // Not set aside: a Langfuse outage is caught by `langfuseStart`, so this is transient.
    counts.failed += 1;
    log('error', 'retention.langfuse_failed', { error: errorCode(error) });
    return;
  }
  switch (outcome.kind) {
    case 'none':
      return;
    case 'set_aside':
      setAside();
      return;
    case 'confirmed':
      counts.langfuseConfirmed += 1;
      if (outcome.hadTraces) langfuse.state.maskOwed = true;
      return;
    case 'requested':
      try {
        await langfuse.store.deleteTraces(outcome.traceIds);
        counts.langfuseRequested += 1;
        // Still found after an earlier request: Langfuse has not deleted yet (its worker down?).
        if (outcome.attempt > 1) {
          log('warn', 'retention.langfuse_purge_pending', { attempt: outcome.attempt });
        }
      } catch (error) {
        // Recorded and audited as asked; the next pass finds the traces and asks again.
        counts.failed += 1;
        log('error', 'retention.langfuse_failed', { error: errorCode(error) });
      }
      return;
  }
}

/** Every trace of the intent's runs, by run tag, in chunks; at most `MAX_TRACES_PER_INTENT`. */
async function findIntentTraces(
  store: LlmTraceStore,
  runIds: ReadonlySet<string>,
): Promise<readonly LlmTraceRef[]> {
  const tags = [...runIds].sort().map((id) => `run_id:${id}`);
  const found = new Map<string, LlmTraceRef>();
  for (let start = 0; start < tags.length; start += RUN_TAGS_PER_QUERY) {
    const chunk = tags.slice(start, start + RUN_TAGS_PER_QUERY);
    for (const trace of await store.findTraces({ tags: chunk, max: MAX_TRACES_PER_INTENT })) {
      found.set(trace.traceId, trace);
    }
    if (found.size > MAX_TRACES_PER_INTENT) throw new LlmTraceError('too_many');
  }
  return [...found.values()];
}

/** The UTC date of `time`, `YYYY-MM-DD`. */
const utcDate = (time: Date): string => time.toISOString().slice(0, 10);

/**
 * Once per pass, after every tenant: the raw file sweep, then the ClickHouse compaction. Both only
 * when `langfuseStart` verified Langfuse this pass: a Langfuse that cannot be reached may not have
 * ingested its raw files yet.
 */
export async function langfuseFinish(
  deps: RetentionPassDeps,
  counts: RetentionCounts,
): Promise<void> {
  const langfuse = deps.langfuse;
  if (langfuse?.status !== 'on' || langfuse.state.verified !== true) return;
  try {
    await sweepRawFiles(deps, langfuse, counts);
  } catch (error) {
    counts.failed += 1;
    deps.logger.log('error', 'retention.langfuse_raw_failed', { error: errorCode(error) });
  }
  const today = utcDate(deps.now());
  if (
    deps.settings.mode !== 'purge' ||
    !langfuse.state.maskOwed ||
    langfuse.state.maskedOn === today
  ) {
    return;
  }
  try {
    const { durationMs } = await langfuse.store.compactDeleted();
    langfuse.state.maskOwed = false;
    langfuse.state.maskedOn = today;
    counts.langfuseCompacted += 1;
    deps.logger.log('info', 'retention.langfuse_compacted', { duration_ms: durationMs });
  } catch (error) {
    counts.failed += 1;
    deps.logger.log('error', 'retention.langfuse_compact_failed', { error: errorCode(error) });
  }
}

/**
 * Raw OTLP files older than the maximum age, oldest key first, at most `rawBatch` deletions per
 * pass. The keys hold the time of their batch (`<langfuse project>/<yyyy/mm/dd/hh/mm>/<uuid>`),
 * so the oldest come first and every pass starts again from the beginning of the prefix.
 */
async function sweepRawFiles(
  deps: RetentionPassDeps,
  langfuse: OnDeps,
  counts: RetentionCounts,
): Promise<void> {
  const cutoff = deps.now().getTime() - langfuse.settings.rawMaxAgeHours * HOUR_MS;
  let after: string | null = null;
  let swept = 0;
  for (let page = 0; page < RAW_PAGES_PER_PASS; page++) {
    const result = await langfuse.rawStore.listKeys(langfuse.rawPrefix, after, RAW_PAGE);
    for (const key of result.keys) {
      if (key.lastModified.getTime() > cutoff) continue;
      counts.langfuseRawFound += 1;
      if (deps.settings.mode !== 'purge' || swept >= langfuse.settings.rawBatch) continue;
      await langfuse.rawStore.deleteAllVersions(key.uri, { bypassLock: false });
      swept += 1;
      counts.langfuseRawSwept += 1;
    }
    if (
      result.next === null ||
      (deps.settings.mode === 'purge' && swept >= langfuse.settings.rawBatch)
    ) {
      return;
    }
    after = result.next;
  }
}
