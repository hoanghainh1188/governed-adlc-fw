// What a run's `read_documents` tools returned (task X04 PR 3b, design/ADR-M89 §2.5, QUESTIONS
// #533, #536, #543). At the end of the run (also after a kill or a failure, and in the clean-up
// after a restart), before the tool containers are removed, the runner reads each tool's own log
// from outside the sandbox. A `read_documents` tool writes one line per answer
// (`KNOWLEDGE_READ_LOG_EVENT`): the document IDs and content hashes it returned and a chunk count.
//
//   the distinct `[doc_id, content_sha256]` pairs, sorted → the evidence item `knowledge_read`
//   (JSON; for an array of string arrays, RFC 8785 is exactly JSON.stringify)
//   → the run event `knowledge_read` with its SHA-256 and the counts, once per run and tool
//
// Lines that do not parse, or hold anything but IDs and hashes, are ignored: the tool reads client
// documents and its log is not trusted beyond its shape. Never a query, a path or a text.
import crypto from 'node:crypto';

import {
  CODE_INDEX_FORMAT,
  KNOWLEDGE_READ_LOG_EVENT,
  validateRunContract,
  type EvidenceStore,
  type ToolGrant,
} from '@sdlc/contracts';
import type { TenantScope } from '@sdlc/core';

import type { DockerClient } from '../docker/client.js';
import { toolObjectNames } from '../names.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
/** At most this many chunks in one answer: the gateway's `limit` rule caps a call at 20. */
const MAX_CHUNKS_PER_LINE = 100;

export interface KnowledgeRead {
  /** Sorted, distinct `[doc_id, content_sha256]`. */
  readonly documents: readonly (readonly [string, string])[];
  readonly chunks: number;
}

/** The documents and chunks of a tool's log lines (see the header). */
export function knowledgeReadOf(logs: string): KnowledgeRead {
  const pairs = new Map<string, readonly [string, string]>();
  let chunks = 0;
  for (const line of logs.split('\n')) {
    const parsed = parseLine(line);
    if (parsed === undefined) continue;
    for (const pair of parsed.documents) pairs.set(`${pair[0]}:${pair[1]}`, pair);
    chunks += parsed.chunks;
  }
  const documents = [...pairs.values()].sort((a, b) =>
    a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1,
  );
  return { documents, chunks };
}

function parseLine(
  line: string,
): { documents: (readonly [string, string])[]; chunks: number } | undefined {
  const text = line.trim();
  if (!text.startsWith('{')) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  const record = value as { event?: unknown; documents?: unknown; chunks?: unknown };
  if (record.event !== KNOWLEDGE_READ_LOG_EVENT || !Array.isArray(record.documents)) {
    return undefined;
  }
  const chunks = record.chunks;
  if (!Number.isSafeInteger(chunks) || (chunks as number) < 0) return undefined;
  if ((chunks as number) > MAX_CHUNKS_PER_LINE) return undefined;
  const documents: (readonly [string, string])[] = [];
  for (const entry of record.documents as unknown[]) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== 'string' ||
      typeof entry[1] !== 'string' ||
      !UUID.test(entry[0]) ||
      !SHA256.test(entry[1])
    ) {
      return undefined;
    }
    documents.push([entry[0], entry[1]]);
  }
  return { documents, chunks: chunks as number };
}

/**
 * Records `knowledge_read` for each `read_documents` or `read_code` tool of the run that has none yet. A tool
 * whose log cannot be read records nothing (its `tool_used` counts still say how often it was
 * called). Without an evidence store the event is still written; the list is then not kept.
 */
export async function recordKnowledgeRead(
  docker: DockerClient,
  scope: TenantScope,
  evidence: EvidenceStore | undefined,
  runId: string,
): Promise<void> {
  const stored = await scope.runContracts.getByRunId(runId);
  if (!stored) return;
  const checked = validateRunContract(stored.contract_json);
  if (!checked.ok) return;
  const { contract } = checked;
  // X06 PR 2 (ADR-M108 §2.8): a `read_code` tool writes the same lines, with file IDs and hashes.
  const grants = (contract.tool_grants ?? []).filter(
    (g: ToolGrant) =>
      g.permissions.includes('read_documents') || g.permissions.includes('read_code'),
  );
  if (grants.length === 0) return;
  const events = await scope.runEvents.list(runId);
  const uses = await scope.knowledgeIndexes.usesOfRun(runId);
  const names = toolObjectNames(runId);
  for (const grant of grants) {
    const recorded = events.some(
      (event) =>
        event.event_type === 'knowledge_read' &&
        (event.payload as { tool_key?: unknown }).tool_key === grant.tool_key,
    );
    if (recorded) continue;
    const model = grant.permissions.includes('read_code')
      ? CODE_INDEX_FORMAT
      : ((await scope.tools.getByKey(grant.tool_key))?.model_ref ?? null);
    const index = uses.find((use) => use.model === model);
    if (index === undefined) continue;
    let logs: string;
    try {
      if (!(await docker.containerInspect(names.tool(grant.tool_key)))) continue;
      logs = await docker.containerLogs(names.tool(grant.tool_key));
    } catch {
      continue;
    }
    const read = knowledgeReadOf(logs);
    const content = Buffer.from(JSON.stringify(read.documents), 'utf8');
    const listSha256 = crypto.createHash('sha256').update(content).digest('hex');
    let item:
      { readonly uri: string; readonly sha256: string; readonly sizeBytes: number } | undefined;
    try {
      item = await evidence?.put(
        contract.tenant_id,
        `${contract.intent_id}/${runId}.knowledge-${grant.tool_key}.json`,
        content,
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
          kind: 'knowledge_read',
          storageUri: item.uri,
          sha256: item.sha256,
          sizeBytes: item.sizeBytes,
        });
      }
      await tx.runEvents.append(runId, 'knowledge_read', {
        tool_key: grant.tool_key,
        index_id: index.indexId,
        list_sha256: listSha256,
        documents: read.documents.length,
        chunks: read.chunks,
      });
    });
  }
}
