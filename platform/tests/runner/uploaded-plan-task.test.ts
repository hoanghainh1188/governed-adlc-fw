// Unit tests for U10 PR 2 (#559, ADR-M113): runner `loadAgentTask` reading an uploaded Low-risk
// plan from `EvidenceStore`, verifying its SHA-256 against the Run Contract, and failing closed
// when the store is missing or the hash mismatches.
import { createHash } from 'node:crypto';

import { EvidenceError, type EvidenceStore, type RunContract } from '@sdlc/contracts';
import { describe, expect, it } from 'vitest';

import { AgentRunError } from '../../apps/runner/src/agent/errors.js';
import { loadAgentTask } from '../../apps/runner/src/agent/task.js';
import type { Plan, SpecRef } from '../../packages/core/src/db/schema.js';

type TaskScope = Parameters<typeof loadAgentTask>[0];

const PLAN_YAML = `plan:
  intent_id: INT-2026-0042
tasks:
  - id: T1
    summary: Fix tax rounding in order total
    owner_agent: coder
    depends_on: []
    input: spec AC1
    output: code and tests
    allowed_paths: [src/orders/tax.ts]
    tools: [file_editor, terminal]
    environments: [sandbox]
    definition_of_done: [Unit tests pass]
    required_evidence: [unit_tests]
    escalate_when: [a change outside allowed_paths is needed]
    checkpoint: after each passing test run
`;

const PLAN_BYTES = Buffer.from(PLAN_YAML, 'utf8');
const PLAN_SHA256 = createHash('sha256').update(PLAN_BYTES).digest('hex');
const STORAGE_URI = `s3://evidence/plans/tenant-1/intent-1/${PLAN_SHA256}.yaml`;

function stubScopeAndContract(): {
  scope: TaskScope;
  contract: RunContract;
  events: { type: string; payload: Record<string, unknown> }[];
} {
  const events: { type: string; payload: Record<string, unknown> }[] = [];
  const plan: Plan = {
    id: 'plan-1',
    tenant_id: 'tenant-1',
    intent_id: 'intent-1',
    version: 1,
    planned_files: ['src/orders/tax.ts'],
    summary: '',
    plan_sha256: PLAN_SHA256,
    proposed_by_type: 'human',
    change_flags: [],
    commit_sha: null,
    allowed_tools: ['file_editor', 'terminal'],
    submitted_by: 'user-a',
    plan_source: 'uploaded',
    storage_uri: STORAGE_URI,
    created_at: new Date('2026-11-22T00:00:00Z'),
  };
  const spec: SpecRef = {
    id: 'spec-1',
    tenant_id: 'tenant-1',
    intent_id: 'intent-1',
    version: 1,
    path: 'docs/specs/INT-2026-0042.md',
    commit_sha: 'a'.repeat(40),
    content_sha256: 'b'.repeat(64),
    source_tool: 'spec-kit',
    structure: 'spec_kit',
    acceptance_criteria: 1,
    created_at: new Date('2026-11-22T00:00:00Z'),
  };
  const scope = {
    plans: { list: () => Promise.resolve([plan]) },
    runs: { listForIntent: () => Promise.resolve([]) },
    specRefs: { latest: () => Promise.resolve(spec) },
    intents: { getById: () => Promise.resolve({ id: 'intent-1', code: 'INT-2026-0042' }) },
    gateDecisions: { listForIntent: () => Promise.resolve([]) },
    runEvents: {
      append: (_runId: string, type: string, payload: Record<string, unknown>) => {
        events.push({ type, payload });
        return Promise.resolve();
      },
    },
  } as unknown as TaskScope;
  const contract = {
    run_id: 'run-1',
    intent_id: 'intent-1',
    plan_id: 'plan-1',
    plan_sha256: PLAN_SHA256,
    planned_files: ['src/orders/tax.ts'],
  } as unknown as RunContract;
  return { scope, contract, events };
}

describe('U10 PR 2: runner loadAgentTask with uploaded plan (#559)', () => {
  it('reads uploaded plan from EvidenceStore, verifies SHA-256 and records plan_read', async () => {
    const { scope, contract, events } = stubScopeAndContract();
    const store: Pick<EvidenceStore, 'get'> = {
      get: (uri) =>
        uri === STORAGE_URI
          ? Promise.resolve(PLAN_BYTES)
          : Promise.reject(new EvidenceError('not_found')),
    };

    const task = await loadAgentTask(scope, contract, {}, undefined, store);

    expect(task.plan.taskText?.tasks).toBe(1);
    expect(task.plan.taskText?.text).toContain('Fix tax rounding in order total');
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('plan_read');
    expect(events[0]?.payload.tasks).toBe(1);
  });

  it('fails closed with hash_mismatch when uploaded plan bytes are tampered', async () => {
    const { scope, contract, events } = stubScopeAndContract();
    const store: Pick<EvidenceStore, 'get'> = {
      get: () => Promise.resolve(Buffer.from(`${PLAN_YAML}\n# tampered`, 'utf8')),
    };

    await expect(loadAgentTask(scope, contract, {}, undefined, store)).rejects.toThrow(
      AgentRunError,
    );
    expect(events).toContainEqual({
      type: 'plan_unavailable',
      payload: { reason: 'hash_mismatch' },
    });
  });

  it('fails closed with missing when planStore is not configured', async () => {
    const { scope, contract, events } = stubScopeAndContract();

    await expect(loadAgentTask(scope, contract, {}, undefined, undefined)).rejects.toThrow(
      AgentRunError,
    );
    expect(events).toContainEqual({
      type: 'plan_unavailable',
      payload: { reason: 'missing' },
    });
  });
});
