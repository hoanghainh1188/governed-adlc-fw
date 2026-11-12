// C06 (ADR-M33 §2.3, §2.4): the G4 input hash and the effective autonomy, without a database.
// Behaviour on PostgreSQL: tests/integration/db/gate-g4.test.ts.
import { createSimplePolicyEngine } from '@sdlc/adapter-policy-simple';
import { loadProjectConfig } from '@sdlc/config';
import { describe, expect, it } from 'vitest';

import { MIGRATIONS } from '../../packages/core/src/db/migrations/index.js';
import {
  runProposalSha256,
  type RunProposal,
} from '../../packages/core/src/workflow/g4-proposal.js';
import { effectiveAutonomy } from '../../packages/core/src/workflow/g4.js';

const PROPOSAL: RunProposal = {
  intentId: '00000000-0000-4000-8000-000000000001',
  planId: '00000000-0000-4000-8000-000000000002',
  planSha256: '6'.repeat(64),
  specSha256: '5'.repeat(64),
  agentId: '00000000-0000-4000-8000-000000000003',
  agentKey: 'coder-openhands',
  agentVersion: '1.0.0',
  instructionsSha256: 'c'.repeat(64),
  modelRef: 'gpt-oss-20b',
  autonomyLevel: 'L2',
  allowedTools: ['file_editor', 'terminal'],
  toolGrants: [],
  allowedModels: ['gpt-oss-20b'],
  maxBudgetUsd: '2',
  maxIterations: 30,
  maxDurationMin: 60,
  baseSha: '1'.repeat(40),
  dataClass: 'internal',
  repoPath: '',
  rootInstructionsSha256: null,
};

function policy(yaml = '') {
  const loaded = loadProjectConfig(yaml);
  if (!loaded.ok) throw new Error('config refused');
  return createSimplePolicyEngine({ config: loaded.config });
}

describe('the G4 input hash (FR-17: a changed term voids an approval)', () => {
  it('is stable for the same proposal', () => {
    expect(runProposalSha256(PROPOSAL)).toBe(runProposalSha256({ ...PROPOSAL }));
    expect(runProposalSha256(PROPOSAL)).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ['baseSha', '2'.repeat(40)],
    ['agentVersion', '1.0.1'],
    ['instructionsSha256', 'd'.repeat(64)],
    ['modelRef', 'claude-haiku-4-5-20251001'],
    ['autonomyLevel', 'L1'],
    ['allowedTools', ['file_editor']],
    ['allowedModels', ['gpt-oss-20b', 'claude-haiku-4-5-20251001']],
    ['maxBudgetUsd', '3'],
    ['maxIterations', 31],
    ['maxDurationMin', 61],
    ['planSha256', '7'.repeat(64)],
    ['specSha256', '8'.repeat(64)],
    ['dataClass', 'client_restricted'],
  ] as const)('changes with %s', (field, value) => {
    expect(runProposalSha256({ ...PROPOSAL, [field]: value })).not.toBe(
      runProposalSha256(PROPOSAL),
    );
  });

  it('does not depend on the agent key (the agent ID is hashed)', () => {
    expect(runProposalSha256({ ...PROPOSAL, agentKey: 'other' })).toBe(runProposalSha256(PROPOSAL));
  });
});

describe('effective autonomy (QUESTIONS #22)', () => {
  const intent = { max_autonomy: 'L2', risk_tier: 'medium', data_class: 'internal' } as const;

  it('is the stored value when the configuration allows as much', () => {
    expect(effectiveAutonomy(intent, policy())).toBe('L2');
  });

  it('follows a tightened configuration', () => {
    const tight = policy(
      'autonomy:\n  max_by_risk: { low: L2, medium: L1, high: L1, critical: L0 }\n',
    );
    expect(effectiveAutonomy(intent, tight)).toBe('L1');
  });

  it('keeps a stored value that is stricter than the configuration', () => {
    expect(effectiveAutonomy({ ...intent, max_autonomy: 'L1' }, policy())).toBe('L1');
  });

  it('is L0 for a data class no model may see', () => {
    expect(effectiveAutonomy({ ...intent, data_class: 'prohibited' }, policy())).toBe('L0');
  });
});

describe('migration 0011 (D-05 1.15)', () => {
  const up = MIGRATIONS['0011-gate-g4']!.statements.up.join(';\n');

  it('adds the three G4 reason codes before `other`', () => {
    for (const code of ['agent_not_runnable', 'instructions_mismatch', 'autonomy_not_allowed']) {
      expect(up).toContain(`ALTER TYPE gate_reason_code ADD VALUE '${code}' BEFORE 'other'`);
    }
  });

  it('links a notice to an agent of the same tenant', () => {
    expect(up).toMatch(/FOREIGN KEY \(tenant_id, agent_id\)\s+REFERENCES agents \(tenant_id, id\)/);
  });

  it('frees the issue and pull request of a blocked intent', () => {
    expect(up.match(/status NOT IN \('done', 'rejected', 'cancelled', 'blocked'\)/g)).toHaveLength(
      2,
    );
  });
});
