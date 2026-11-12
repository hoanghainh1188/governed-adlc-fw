// D-08 X04 AC5 (design/ADR-M89 §2.5; QUESTIONS #533, #536, #543): the runner records
// `knowledge_read` once per run and `read_documents` tool, at the end of the run, from the tool's
// own log: the SHA-256 of the sorted list of document ID and content hash, the counts, and the list
// itself as the evidence item `knowledge_read`. Never a query, a path or a text.
import crypto from 'node:crypto';

import {
  CODE_INDEX_FORMAT,
  KNOWLEDGE_READ_LOG_EVENT,
  type EvidenceStore,
  type ToolGrant,
} from '@sdlc/contracts';
import { describe, expect, it } from 'vitest';

import { recordKnowledgeRead, toolObjectNames } from '../../apps/runner/src/index.js';
import type { DockerClient } from '../../apps/runner/src/docker/client.js';
import { contract } from '../run-contract/helpers.js';
import { RUN_ID } from './helpers';

type TenantScope = Parameters<typeof recordKnowledgeRead>[1];

const INDEX = '66666666-6666-4666-8666-666666666666';
const CODE_INDEX = '66666666-6666-4666-8666-666666666666';
const DOC = '44444444-4444-4444-8444-444444444444';
const SHA = 'a'.repeat(64);

const grant = (key: string, permissions: ToolGrant['permissions']) =>
  ({
    tool_key: key,
    tool_version: '1.0.0',
    transport: 'http',
    image_digest: `sha256:${'d'.repeat(64)}`,
    permissions,
    call_rules_sha256: 'a'.repeat(64),
    backing_services: [],
    max_calls: 100,
  }) as ToolGrant;

function world(logs: string | Error, permissions: ToolGrant['permissions'] = ['read_documents']) {
  const stored = contract({
    schema_version: 3,
    run_id: RUN_ID,
    allowed_tools: ['editor', 'tool:project-docs'],
    tool_grants: [grant('project-docs', permissions)],
  });
  const events: { event_type: string; payload: Record<string, unknown> }[] = [];
  const items: Record<string, unknown>[] = [];
  const scope = {
    runContracts: { getByRunId: () => Promise.resolve({ contract_json: stored }) },
    runEvents: {
      list: () => Promise.resolve([...events]),
      append: (_run: string, event_type: string, payload: Record<string, unknown>) => {
        events.push({ event_type, payload });
        return Promise.resolve();
      },
    },
    knowledgeIndexes: {
      usesOfRun: () =>
        Promise.resolve([
          { indexId: INDEX, model: 'bge-m3' },
          { indexId: CODE_INDEX, model: CODE_INDEX_FORMAT },
        ]),
    },
    tools: { getByKey: () => Promise.resolve({ model_ref: 'bge-m3' }) },
    evidenceItems: {
      record: (item: Record<string, unknown>) => {
        items.push(item);
        return Promise.resolve();
      },
    },
    transaction: (work: (tx: unknown) => Promise<unknown>) => work(scope),
  } as unknown as TenantScope;
  const asked: string[] = [];
  const docker = {
    containerInspect: (name: string) => Promise.resolve({ Name: name }),
    containerLogs: (name: string) => {
      asked.push(name);
      return logs instanceof Error ? Promise.reject(logs) : Promise.resolve(logs);
    },
  } as unknown as DockerClient;
  const puts: { path: string; content: string }[] = [];
  const evidence: EvidenceStore = {
    put: (_tenant, path, content) => {
      puts.push({ path, content: content.toString('utf8') });
      return Promise.resolve({
        uri: `s3://sdlc-evidence/diffs/${path}`,
        sha256: crypto.createHash('sha256').update(content).digest('hex'),
        sizeBytes: content.length,
      });
    },
    get: () => Promise.reject(new Error('unused')),
  };
  return { scope, docker, evidence, events, items, puts, asked, stored };
}

const line = JSON.stringify({
  event: KNOWLEDGE_READ_LOG_EVENT,
  documents: [[DOC, SHA]],
  chunks: 2,
});

describe('recording knowledge_read (AC5)', () => {
  it('one event per read_documents tool with the hash of the list; the list is the evidence', async () => {
    const w = world(`${line}\n${line}\n`);
    await recordKnowledgeRead(w.docker, w.scope, w.evidence, RUN_ID);
    await recordKnowledgeRead(w.docker, w.scope, w.evidence, RUN_ID); // a retried release
    const list = JSON.stringify([[DOC, SHA]]);
    expect(w.asked).toEqual([toolObjectNames(RUN_ID).tool('project-docs')]);
    expect(w.puts).toEqual([
      {
        path: `${String(w.stored.intent_id)}/${RUN_ID}.knowledge-project-docs.json`,
        content: list,
      },
    ]);
    expect(w.events).toEqual([
      {
        event_type: 'knowledge_read',
        payload: {
          tool_key: 'project-docs',
          index_id: INDEX,
          list_sha256: crypto.createHash('sha256').update(list).digest('hex'),
          documents: 1,
          chunks: 4,
        },
      },
    ]);
    expect(w.items).toEqual([
      expect.objectContaining({ kind: 'knowledge_read', runId: RUN_ID, sizeBytes: list.length }),
    ]);
  });

  it('X06: a read_code tool records its files against the code index of the run', async () => {
    const w = world(`${line}\n`, ['read_code']);
    await recordKnowledgeRead(w.docker, w.scope, w.evidence, RUN_ID);
    expect(w.events.map((e) => [e.event_type, e.payload.tool_key, e.payload.index_id])).toEqual([
      ['knowledge_read', 'project-docs', CODE_INDEX],
    ]);
  });

  it('without an evidence store the event is still written; a log that cannot be read records nothing', async () => {
    const w = world(line);
    await recordKnowledgeRead(w.docker, w.scope, undefined, RUN_ID);
    expect(w.events.map((e) => e.event_type)).toEqual(['knowledge_read']);
    expect(w.items).toEqual([]);
    const gone = world(new Error('no such container'));
    await recordKnowledgeRead(gone.docker, gone.scope, gone.evidence, RUN_ID);
    expect(gone.events).toEqual([]);
  });
});
