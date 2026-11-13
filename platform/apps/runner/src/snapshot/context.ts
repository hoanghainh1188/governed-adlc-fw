// The context snapshot of a run (task X07, design/ADR-M90, QUESTIONS #556, #557): what the agent
// read, recorded at the end of every run whose agent started (also after a kill, a failure or a
// restart's clean-up), right after `knowledge_read`, before the sandbox is removed.
//
//   the run's base commit, plan and spec versions
//   + the SHA-256 of each repository path the agent opened (from its log, `AgentFileReads`)
//   + the `knowledge_read` hashes and counts of its tools
//   → the evidence item `context_snapshot` (canonical JSON, with the run's diff credential)
//   → the run event `context_snapshot` with its SHA-256 and the counts, once per run
//
// Hashes and counts only: never a path, a query or a text (R030, R031). When the agent's log could
// not be read (a kill, a failure before the end, a restart), the file list is `unavailable`; the
// snapshot still records the versions and the documents.
import crypto from 'node:crypto';

import { validateRunContract, type AgentFileReads, type EvidenceStore } from '@sdlc/contracts';
import type { RunEventRow, SpecRef, TenantScope } from '@sdlc/core';

export const SNAPSHOT_SCHEMA_VERSION = 1;
/**
 * X13 PR 2 (ADR-M74 §2.8): schema 1 plus `memory`, for a run with a `memory_read` event. Every
 * other snapshot stays schema 1, byte for byte.
 */
export const SNAPSHOT_SCHEMA_MEMORY = 2;

/** What `memory_read` recorded: which approved version the agent read, or why none. */
export interface SnapshotMemory {
  readonly reason: string;
  readonly version: number | null;
  readonly set_sha256: string | null;
  readonly files: number;
  readonly truncated: boolean;
}

export type FileListSource = 'agent_log' | 'unavailable';

export interface SnapshotDocuments {
  readonly tool_key: string;
  readonly index_id: string;
  readonly list_sha256: string;
  readonly documents: number;
  readonly chunks: number;
}

export interface SnapshotInput {
  readonly runId: string;
  readonly intentId: string;
  readonly baseSha: string;
  readonly plan: { readonly planId: string; readonly planSha256: string };
  readonly spec: {
    readonly version: number;
    readonly commitSha: string;
    readonly contentSha256: string;
  } | null;
  readonly reads: AgentFileReads | undefined;
  readonly documents: readonly SnapshotDocuments[];
  /** X13: the run's `memory_read`, when it has one. */
  readonly memory?: SnapshotMemory | undefined;
}

export interface ContextSnapshot {
  /** The canonical JSON (RFC 8785) of the snapshot. */
  readonly content: Buffer;
  readonly sha256: string;
  readonly source: FileListSource;
  readonly files: number;
  readonly filesOutside: number;
  readonly unattributedCalls: number;
  readonly documents: number;
}

const sha256 = (value: string | Buffer): string =>
  crypto.createHash('sha256').update(value).digest('hex');

/**
 * Builds the snapshot. Every object below lists its keys in code-unit order and holds only ASCII
 * strings and safe integers, so `JSON.stringify` gives exactly the RFC 8785 canonical form.
 */
export function buildContextSnapshot(input: SnapshotInput): ContextSnapshot {
  const source: FileListSource = input.reads === undefined ? 'unavailable' : 'agent_log';
  const pathHashes = [...new Set((input.reads?.paths ?? []).map((p) => sha256(p)))].sort();
  const documents = [...input.documents]
    .sort((a, b) => (a.tool_key < b.tool_key ? -1 : a.tool_key > b.tool_key ? 1 : 0))
    .map((d) => ({
      chunks: d.chunks,
      documents: d.documents,
      index_id: d.index_id,
      list_sha256: d.list_sha256,
      tool_key: d.tool_key,
    }));
  const snapshot = {
    base_sha: input.baseSha,
    documents,
    files: {
      outside: input.reads?.outside ?? 0,
      path_sha256: pathHashes,
      source,
      unattributed_calls: input.reads?.unattributed ?? 0,
    },
    intent_id: input.intentId,
    ...(input.memory === undefined
      ? {}
      : {
          memory: {
            files: input.memory.files,
            reason: input.memory.reason,
            set_sha256: input.memory.set_sha256,
            truncated: input.memory.truncated,
            version: input.memory.version,
          },
        }),
    plan: { plan_id: input.plan.planId, plan_sha256: input.plan.planSha256 },
    run_id: input.runId,
    schema_version: input.memory === undefined ? SNAPSHOT_SCHEMA_VERSION : SNAPSHOT_SCHEMA_MEMORY,
    spec:
      input.spec === null
        ? null
        : {
            commit_sha: input.spec.commitSha,
            content_sha256: input.spec.contentSha256,
            version: input.spec.version,
          },
  };
  const content = Buffer.from(JSON.stringify(snapshot), 'utf8');
  return {
    content,
    sha256: sha256(content),
    source,
    files: pathHashes.length,
    filesOutside: snapshot.files.outside,
    unattributedCalls: snapshot.files.unattributed_calls,
    documents: documents.reduce((sum, d) => sum + d.documents, 0),
  };
}

/** The `knowledge_read` events of the run, as the snapshot lists them (latest per tool). */
export function documentsOf(events: readonly RunEventRow[]): SnapshotDocuments[] {
  const byTool = new Map<string, SnapshotDocuments>();
  for (const event of events) {
    if (event.event_type !== 'knowledge_read') continue;
    const p = event.payload;
    if (
      typeof p.tool_key !== 'string' ||
      typeof p.index_id !== 'string' ||
      typeof p.list_sha256 !== 'string' ||
      typeof p.documents !== 'number' ||
      typeof p.chunks !== 'number'
    ) {
      continue;
    }
    byTool.set(p.tool_key, {
      tool_key: p.tool_key,
      index_id: p.index_id,
      list_sha256: p.list_sha256,
      documents: p.documents,
      chunks: p.chunks,
    });
  }
  return [...byTool.values()];
}

/** The run's `memory_read` (the first one), as the snapshot lists it; undefined without one. */
export function memoryOf(events: readonly RunEventRow[]): SnapshotMemory | undefined {
  const event = events.find((e) => e.event_type === 'memory_read');
  if (!event) return undefined;
  const p = event.payload;
  if (typeof p.reason !== 'string' || typeof p.files !== 'number') return undefined;
  return {
    reason: p.reason,
    version: typeof p.version === 'number' ? p.version : null,
    set_sha256: typeof p.set_sha256 === 'string' ? p.set_sha256 : null,
    files: p.files,
    truncated: p.truncated === 'yes',
  };
}

/** The intent's spec version the run started with: the newest one linked before its start. */
export function specAtStart(specs: readonly SpecRef[], startedAt: Date): SpecRef | undefined {
  return specs
    .filter((spec) => spec.created_at.getTime() <= startedAt.getTime())
    .reduce<SpecRef | undefined>(
      (best, spec) => (!best || spec.version > best.version ? spec : best),
      undefined,
    );
}

/**
 * Records `context_snapshot` for a run whose agent started (`agent_started`) and that has none
 * yet. `reads` is what the agent's log showed (undefined when the runner could not read it).
 * Without an evidence store the event is still written; the file is then not kept.
 */
export async function recordContextSnapshot(
  scope: TenantScope,
  evidence: EvidenceStore | undefined,
  runId: string,
  reads: AgentFileReads | undefined,
): Promise<void> {
  const run = await scope.runs.getById(runId);
  const stored = await scope.runContracts.getByRunId(runId);
  if (!run || !stored) return;
  const checked = validateRunContract(stored.contract_json);
  if (!checked.ok) return;
  const { contract } = checked;
  const events = await scope.runEvents.list(runId);
  // Only a run whose agent started read anything; one snapshot per run (a release is retried).
  if (!events.some((event) => event.event_type === 'agent_started')) return;
  if (events.some((event) => event.event_type === 'context_snapshot')) return;
  const spec = specAtStart(
    await scope.specRefs.list(contract.intent_id),
    run.started_at ?? run.created_at,
  );
  const documents = documentsOf(events);
  const snapshot = buildContextSnapshot({
    runId,
    intentId: contract.intent_id,
    baseSha: contract.base_sha,
    plan: { planId: contract.plan_id, planSha256: contract.plan_sha256 },
    spec: spec
      ? { version: spec.version, commitSha: spec.commit_sha, contentSha256: spec.content_sha256 }
      : null,
    reads,
    documents,
    memory: memoryOf(events),
  });
  let item:
    { readonly uri: string; readonly sha256: string; readonly sizeBytes: number } | undefined;
  try {
    item = await evidence?.put(
      contract.tenant_id,
      `${contract.intent_id}/${runId}.context-snapshot.json`,
      snapshot.content,
      'application/json',
    );
  } catch {
    // Taken by an earlier attempt, or the store is down: the event still holds the hash.
    item = undefined;
  }
  await scope.transaction(async (tx) => {
    if (item !== undefined) {
      await tx.evidenceItems.record({
        intentId: contract.intent_id,
        runId,
        kind: 'context_snapshot',
        storageUri: item.uri,
        sha256: item.sha256,
        sizeBytes: item.sizeBytes,
      });
    }
    await tx.runEvents.append(runId, 'context_snapshot', {
      snapshot_sha256: snapshot.sha256,
      source: snapshot.source,
      files: snapshot.files,
      files_outside: snapshot.filesOutside,
      unattributed_calls: snapshot.unattributedCalls,
      document_tools: documents.length,
      documents: snapshot.documents,
    });
  });
}
