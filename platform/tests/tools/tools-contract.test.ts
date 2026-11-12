// D-08 X04 AC1 (design/ADR-M69 §2.1, §2.6; QUESTIONS #530): register tool codes, the permission
// catalogue and its call rules, and the Run Contract of schema 3 with `tool_grants`.
import { createHash } from 'node:crypto';

import { canonicalJson } from '@sdlc/config';
import { describe, expect, it } from 'vitest';

import {
  ADAPTER_TOOL_TRANSPORTS,
  isRegisterToolCode,
  registerToolCode,
  TOOL_CALL_RULES,
  TOOL_PERMISSIONS,
  toolCallRulesJson,
  toolKeyOf,
  validateRunContract,
  type ToolGrant,
} from '@sdlc/contracts';

import { callRulesSha256 } from '../../packages/core/src/tools/check.js';
import { runProposalSha256 } from '../../packages/core/src/workflow/g4-proposal.js';
import { contract } from '../run-contract/helpers.js';

const GRANT: ToolGrant = {
  tool_key: 'project-docs',
  tool_version: '1.0.0',
  transport: 'http',
  image_digest: `sha256:${'d'.repeat(64)}`,
  permissions: ['read_documents'],
  call_rules_sha256: 'a'.repeat(64),
  backing_services: ['knowledge-db:5432'],
  max_calls: 100,
};

const v3 = (overrides: Record<string, unknown> = {}) =>
  contract({
    schema_version: 3,
    allowed_tools: ['editor', 'tool:project-docs'],
    tool_grants: [GRANT],
    ...overrides,
  });

const fieldOf = (value: unknown): string => {
  const result = validateRunContract(value);
  return result.ok ? 'ok' : result.field;
};

describe('register tool codes (ADR-M69 §2.1)', () => {
  it.each([
    ['tool:project-docs', true],
    ['tool:ab', true],
    ['tool:a', false],
    ['tool:Docs', false],
    ['tool:', false],
    ['project-docs', false],
    ['terminal', false],
  ])('%s → %s', (code, expected) => {
    expect(isRegisterToolCode(code)).toBe(expected);
  });

  it('round-trips a key', () => {
    expect(toolKeyOf(registerToolCode('project-docs'))).toBe('project-docs');
  });

  it('X04 PR 2: OpenHands gives a run http tools through the gateway; OpenCode none yet', () => {
    expect(ADAPTER_TOOL_TRANSPORTS).toEqual({ openhands: ['http'], opencode: [] });
  });
});

describe('the call rules of each permission (QUESTIONS #530)', () => {
  it('has rules for every permission; read_documents allows one search tool only', () => {
    for (const permission of TOOL_PERMISSIONS) {
      expect(TOOL_CALL_RULES[permission].length).toBeGreaterThan(0);
    }
    expect(TOOL_CALL_RULES.read_documents).toEqual([
      {
        tool: 'search_project_docs',
        arguments: {
          limit: { type: 'integer', min: 1, max: 20 },
          query: { type: 'string', max_length: 1000 },
        },
        required: ['query'],
      },
    ]);
  });

  it('gives canonical bytes: sorted keys, sorted and unique permissions', () => {
    const json = toolCallRulesJson(['read_documents', 'read_documents']);
    expect(json).toBe(
      '{"read_documents":[{"arguments":{"limit":{"max":20,"min":1,"type":"integer"},' +
        '"query":{"max_length":1000,"type":"string"}},"required":["query"],' +
        '"tool":"search_project_docs"}]}',
    );
    expect(callRulesSha256(['read_documents'])).toBe(
      createHash('sha256').update(json, 'utf8').digest('hex'),
    );
  });
});

describe('the Run Contract of schema 3 (ADR-M69 §2.6)', () => {
  it('accepts a grant for each register tool, and none', () => {
    expect(fieldOf(v3())).toBe('ok');
    expect(fieldOf(v3({ allowed_tools: ['editor'], tool_grants: [] }))).toBe('ok');
  });

  it('accepts schema 2 without tool_grants, and refuses schema 2 with them', () => {
    expect(fieldOf(contract({ schema_version: 2 }))).toBe('ok');
    expect(fieldOf(contract({ schema_version: 2, tool_grants: [] }))).toBe('tool_grants');
  });

  it('refuses schema 3 without tool_grants', () => {
    expect(fieldOf(contract({ schema_version: 3 }))).toBe('tool_grants');
  });

  it.each<[string, Record<string, unknown>]>([
    ['a register tool without a grant', { tool_grants: [] }],
    ['a grant not in allowed_tools', { allowed_tools: ['editor'] }],
    ['a stdio grant', { tool_grants: [{ ...GRANT, transport: 'stdio' }] }],
    ['a tag, not a digest', { tool_grants: [{ ...GRANT, image_digest: 'latest' }] }],
    ['an unknown permission', { tool_grants: [{ ...GRANT, permissions: ['write_documents'] }] }],
    ['no permission', { tool_grants: [{ ...GRANT, permissions: [] }] }],
    [
      'an internet host as a backing service',
      { tool_grants: [{ ...GRANT, backing_services: ['example.com'] }] },
    ],
    ['a port out of range', { tool_grants: [{ ...GRANT, backing_services: ['db:70000'] }] }],
    ['a cap of 0', { tool_grants: [{ ...GRANT, max_calls: 0 }] }],
    ['a short call rules hash', { tool_grants: [{ ...GRANT, call_rules_sha256: 'a' }] }],
    ['an extra field', { tool_grants: [{ ...GRANT, credential: 'x' }] }],
    ['a missing field', { tool_grants: [{ ...GRANT, max_calls: undefined }] }],
    [
      'two grants out of order',
      {
        allowed_tools: ['editor', 'tool:a-docs', 'tool:project-docs'],
        tool_grants: [GRANT, { ...GRANT, tool_key: 'a-docs' }],
      },
    ],
  ])('refuses %s', (_name, overrides) => {
    const value = JSON.parse(JSON.stringify(v3(overrides))) as unknown;
    expect(fieldOf(value)).toBe('tool_grants');
  });
});

describe('the G4 proposal hash (FR-17)', () => {
  const proposal = {
    intentId: '1',
    planId: '2',
    planSha256: 'a'.repeat(64),
    specSha256: 'b'.repeat(64),
    agentId: '3',
    agentKey: 'coder',
    agentVersion: '1',
    instructionsSha256: 'c'.repeat(64),
    modelRef: 'model-1',
    autonomyLevel: 'L2' as const,
    allowedTools: ['file_editor'],
    toolGrants: [] as ToolGrant[],
    allowedModels: ['model-1'],
    maxBudgetUsd: '2',
    maxIterations: 40,
    maxDurationMin: 60,
    baseSha: 'd'.repeat(40),
    dataClass: 'internal' as const,
    repoPath: '',
    rootInstructionsSha256: null,
  };

  // The hash of a proposal as it was before X04 added `toolGrants` (version 1 of the input).
  const before = createHash('sha256')
    .update(
      canonicalJson({
        v: 1,
        intent_id: '1',
        plan_id: '2',
        plan_sha256: 'a'.repeat(64),
        spec_sha256: 'b'.repeat(64),
        agent_id: '3',
        agent_version: '1',
        instructions_sha256: 'c'.repeat(64),
        model_ref: 'model-1',
        autonomy_level: 'L2',
        allowed_tools: ['file_editor'],
        allowed_models: ['model-1'],
        max_budget_usd: '2',
        max_iterations: 40,
        max_duration_min: 60,
        base_sha: 'd'.repeat(40),
        data_class: 'internal',
      }),
      'utf8',
    )
    .digest('hex');

  it('is the same as before X04 when the run gets no register tool', () => {
    // Approvals of proposals made before X04 stay valid.
    expect(runProposalSha256(proposal)).toBe(before);
  });

  it('changes with the tool grants', () => {
    expect(runProposalSha256({ ...proposal, toolGrants: [GRANT] })).not.toBe(before);
  });

  it('O06: changes with a folder or a second pinned file, never without them', () => {
    expect(runProposalSha256({ ...proposal, repoPath: 'packages/web' })).not.toBe(before);
    expect(runProposalSha256({ ...proposal, rootInstructionsSha256: 'e'.repeat(64) })).not.toBe(
      before,
    );
  });
});
