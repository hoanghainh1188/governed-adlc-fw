// D-08 X07 AC1–AC3 (design/ADR-M90, QUESTIONS #556, #557): at the end of every run the runner
// records one context snapshot: the run's base commit, plan and spec versions, the SHA-256 of each
// repository file the agent opened, counts, and the `knowledge_read` hashes of its tools. The
// snapshot is an evidence item; the run event holds its SHA-256 and counts. Never a path or a text.
import crypto from 'node:crypto';

import type { EvidenceStore } from '@sdlc/contracts';
import { describe, expect, it } from 'vitest';

import {
  buildContextSnapshot,
  documentsOf,
  recordContextSnapshot,
  specAtStart,
} from '../../apps/runner/src/index.js';
import { checkRunEvent } from '../../packages/core/src/run-events/index.js';
import { contract } from '../run-contract/helpers.js';
import { RUN_ID } from './helpers';

type TenantScope = Parameters<typeof recordContextSnapshot>[0];
type SpecRef = Parameters<typeof specAtStart>[0][number];

const sha = (text: string) => crypto.createHash('sha256').update(text).digest('hex');
const INDEX = '66666666-6666-4666-8666-666666666666';
const SECRET_PATH = 'apps/api/src/secret-client-module.ts';
const STARTED = new Date('2026-10-24T10:00:00Z');

const spec = (version: number, at: string) =>
  ({
    version,
    path: `docs/specs/v${version}.md`,
    commit_sha: String(version).repeat(40),
    content_sha256: sha(`spec ${version}`),
    created_at: new Date(at),
  }) as unknown as SpecRef;

const knowledgeRead = (tool: string, documents: number) => ({
  event_type: 'knowledge_read',
  payload: { tool_key: tool, index_id: INDEX, list_sha256: sha(tool), documents, chunks: 7 },
});

const AGENT_STARTED = { event_type: 'agent_started', payload: { max_iterations: 30 } };

function world(
  earlier: { event_type: string; payload: Record<string, unknown> }[] = [AGENT_STARTED],
) {
  const stored = contract({ run_id: RUN_ID });
  const events = [...earlier];
  const items: Record<string, unknown>[] = [];
  const scope = {
    runs: {
      getById: () => Promise.resolve({ id: RUN_ID, started_at: STARTED, created_at: STARTED }),
    },
    runContracts: { getByRunId: () => Promise.resolve({ contract_json: stored }) },
    specRefs: {
      list: () =>
        Promise.resolve([
          spec(1, '2026-10-20T00:00:00Z'),
          spec(2, '2026-10-23T00:00:00Z'),
          spec(3, '2026-10-24T11:00:00Z'), // linked after the run started
        ]),
    },
    runEvents: {
      list: () => Promise.resolve([...events]),
      append: (_run: string, event_type: string, payload: Record<string, unknown>) => {
        // The real append accepts only the declared, coded fields.
        events.push({ event_type, payload: checkRunEvent(event_type, payload) });
        return Promise.resolve();
      },
    },
    evidenceItems: {
      record: (item: Record<string, unknown>) => {
        items.push(item);
        return Promise.resolve();
      },
    },
    transaction: (work: (tx: unknown) => Promise<unknown>) => work(scope),
  } as unknown as TenantScope;
  const puts: { path: string; content: string }[] = [];
  const evidence: EvidenceStore = {
    put: (_tenant, path, content) => {
      puts.push({ path, content: content.toString('utf8') });
      return Promise.resolve({
        uri: `s3://sdlc-evidence/diffs/${path}`,
        sha256: sha(content.toString('utf8')),
        sizeBytes: content.length,
      });
    },
    get: () => Promise.reject(new Error('unused')),
  };
  return { scope, evidence, events, items, puts, stored };
}

describe('buildContextSnapshot', () => {
  const input = {
    runId: RUN_ID,
    intentId: '22222222-2222-4222-8222-222222222222',
    baseSha: 'b'.repeat(40),
    plan: { planId: '55555555-5555-4555-8555-555555555555', planSha256: sha('plan') },
    spec: { version: 2, commitSha: 'c'.repeat(40), contentSha256: sha('spec') },
    reads: { paths: ['b.ts', 'a.ts'], outside: 1, unattributed: 4 },
    documents: [
      { tool_key: 'z-docs', index_id: INDEX, list_sha256: sha('z'), documents: 2, chunks: 3 },
      { tool_key: 'a-docs', index_id: INDEX, list_sha256: sha('a'), documents: 1, chunks: 1 },
    ],
  };

  it('is canonical JSON with sorted keys, hashed paths and sorted lists (AC1)', () => {
    const snapshot = buildContextSnapshot(input);
    const text = snapshot.content.toString('utf8');
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual([...Object.keys(parsed)].sort());
    expect(parsed.files).toEqual({
      outside: 1,
      path_sha256: [sha('a.ts'), sha('b.ts')].sort(),
      source: 'agent_log',
      unattributed_calls: 4,
    });
    expect((parsed.documents as { tool_key: string }[]).map((d) => d.tool_key)).toEqual([
      'a-docs',
      'z-docs',
    ]);
    expect(parsed).toMatchObject({ schema_version: 1, base_sha: input.baseSha, run_id: RUN_ID });
    expect(snapshot.sha256).toBe(sha(text));
    expect(snapshot).toMatchObject({
      files: 2,
      filesOutside: 1,
      unattributedCalls: 4,
      documents: 3,
    });
    // The order the agent opened files in never changes the hash.
    const again = buildContextSnapshot({
      ...input,
      reads: { ...input.reads, paths: ['a.ts', 'b.ts'] },
    });
    expect(again.sha256).toBe(snapshot.sha256);
  });

  it('never holds a path in clear (AC3)', () => {
    const text = buildContextSnapshot({
      ...input,
      reads: { paths: [SECRET_PATH], outside: 0, unattributed: 0 },
    }).content.toString('utf8');
    expect(text).not.toContain('secret-client-module');
    expect(text).toContain(sha(SECRET_PATH));
  });

  it('without the agent log the file list is unavailable; the versions are still recorded', () => {
    const snapshot = buildContextSnapshot({ ...input, reads: undefined, spec: null });
    const parsed = JSON.parse(snapshot.content.toString('utf8')) as Record<string, unknown>;
    expect(snapshot.source).toBe('unavailable');
    expect(parsed).toMatchObject({ spec: null, files: { source: 'unavailable', path_sha256: [] } });
  });
});

describe('documentsOf and specAtStart', () => {
  it('takes the latest knowledge_read per tool and ignores malformed payloads', () => {
    const rows = [
      knowledgeRead('docs', 1),
      knowledgeRead('docs', 4),
      { event_type: 'knowledge_read', payload: { tool_key: 'bad' } },
      { event_type: 'tool_used', payload: {} },
    ] as unknown as Parameters<typeof documentsOf>[0];
    expect(documentsOf(rows)).toEqual([
      { tool_key: 'docs', index_id: INDEX, list_sha256: sha('docs'), documents: 4, chunks: 7 },
    ]);
  });

  it('the spec version is the newest one linked before the run started', () => {
    expect(
      specAtStart([spec(1, '2026-10-20T00:00:00Z'), spec(2, '2026-10-25T00:00:00Z')], STARTED)
        ?.version,
    ).toBe(1);
    expect(specAtStart([spec(1, '2026-10-25T00:00:00Z')], STARTED)).toBeUndefined();
  });
});

describe('recording context_snapshot (AC1, AC3)', () => {
  it('one event per run with the hash and counts; the snapshot is the evidence item', async () => {
    const w = world([AGENT_STARTED, knowledgeRead('project-docs', 3)]);
    const reads = { paths: [SECRET_PATH, 'README.md'], outside: 1, unattributed: 2 };
    await recordContextSnapshot(w.scope, w.evidence, RUN_ID, reads);
    await recordContextSnapshot(w.scope, w.evidence, RUN_ID, reads); // a retried release
    expect(w.puts).toHaveLength(1);
    expect(w.puts[0]!.path).toBe(`${String(w.stored.intent_id)}/${RUN_ID}.context-snapshot.json`);
    const content = w.puts[0]!.content;
    expect(JSON.parse(content)).toMatchObject({
      spec: { version: 2 },
      plan: { plan_id: w.stored.plan_id, plan_sha256: w.stored.plan_sha256 },
      base_sha: w.stored.base_sha,
      documents: [{ tool_key: 'project-docs', documents: 3 }],
    });
    const snapshots = w.events.filter((e) => e.event_type === 'context_snapshot');
    expect(snapshots).toEqual([
      {
        event_type: 'context_snapshot',
        payload: {
          snapshot_sha256: sha(content),
          source: 'agent_log',
          files: 2,
          files_outside: 1,
          unattributed_calls: 2,
          document_tools: 1,
          documents: 3,
        },
      },
    ]);
    expect(JSON.stringify(w.events)).not.toContain('secret-client-module');
    expect(w.items).toEqual([
      expect.objectContaining({ kind: 'context_snapshot', runId: RUN_ID, sha256: sha(content) }),
    ]);
  });

  it('after a restart (no log) and without an evidence store, the event is still written', async () => {
    const w = world();
    await recordContextSnapshot(w.scope, undefined, RUN_ID, undefined);
    expect(w.events.slice(1)).toEqual([
      {
        event_type: 'context_snapshot',
        payload: expect.objectContaining({
          source: 'unavailable',
          files: 0,
          document_tools: 0,
        }) as unknown,
      },
    ]);
    expect(w.items).toEqual([]);
  });

  it('a run whose agent never started (provisioning failed, still queued) gets none', async () => {
    const w = world([]);
    await recordContextSnapshot(w.scope, w.evidence, RUN_ID, undefined);
    expect(w.events).toEqual([]);
    expect(w.puts).toEqual([]);
  });

  it('X13 PR 2: a run with memory_read gets schema 2 with the version and hash it read', async () => {
    const set = sha('set');
    const w = world([
      AGENT_STARTED,
      {
        event_type: 'memory_read',
        payload: {
          reason: 'read',
          version: 3,
          set_sha256: set,
          files: 2,
          chars: 90,
          truncated: 'yes',
        },
      },
    ]);
    await recordContextSnapshot(w.scope, w.evidence, RUN_ID, undefined);
    const parsed = JSON.parse(w.puts[0]!.content) as Record<string, unknown>;
    expect(parsed.schema_version).toBe(2);
    expect(parsed.memory).toEqual({
      files: 2,
      reason: 'read',
      set_sha256: set,
      truncated: true,
      version: 3,
    });
    expect(Object.keys(parsed)).toEqual([...Object.keys(parsed)].sort());
  });

  it('X13 PR 2: a run without memory_read keeps schema 1, without a memory key', async () => {
    const w = world();
    await recordContextSnapshot(w.scope, w.evidence, RUN_ID, undefined);
    const parsed = JSON.parse(w.puts[0]!.content) as Record<string, unknown>;
    expect(parsed.schema_version).toBe(1);
    expect(parsed).not.toHaveProperty('memory');
  });
});
