// D-08 A05 AC3: a stable `config_hash` (SHA-256) for the same content (design/D-05 section 6.1:
// RFC 8785 canonical JSON of the effective configuration).
import { createHash } from 'node:crypto';

import { canonicalJson, computeConfigHash, defaultProjectConfig } from '@sdlc/config';
import { describe, expect, it } from 'vitest';

import { loadValid } from './helpers';

/**
 * Pinned hash of the shipped default configuration. It changes only when a default value changes.
 * Update it in the same PR as the default change, after review (C06: `run.agent_key`; session 2: `run.contract_attempts_max`, `run.failed_run_escalation`; C07: `run.g5_breach_escalation`; B08: `access.spec_link_roles`; C08: `verification`; B09: `access.plan_submit_roles`; C11: `access.kill_roles`, `run.kill_escalation`; E04: `access.cost_read_roles`; E06: `access.metrics_read_roles`; E02: `access.evidence_build_roles`, `access.evidence_read_roles`; E05: `access.evidence_hold_roles`; L05: `access.eval_roles`; L06: `evaluation.recommendations`; L07: `evaluation.tasks`; X04: `tools`; X04 PR 2: `tools.gateway.image`; X04 PR 3a: `knowledge`; X04 PR 3b: `tools.model_budget_usd`; X11: `run.context_condensing`; H05: `run.review_limits`; H02: `dependencies`; PR #502: `tools.gateway.image` 1.7.0).
 */
const DEFAULT_CONFIG_HASH = '2e3fde170ff9abdb7f34023a5a77ac20ba5dc4d40da58bd88234a3cff99a2583';

describe('config_hash (AC3)', () => {
  it('is the pinned value for the default configuration', () => {
    expect(loadValid().configHash).toBe(DEFAULT_CONFIG_HASH);
  });

  it('is SHA-256 of the canonical JSON of the effective configuration', () => {
    const { config, configHash } = loadValid();
    const expected = createHash('sha256').update(canonicalJson(config), 'utf8').digest('hex');
    expect(configHash).toBe(expected);
    expect(computeConfigHash(defaultProjectConfig())).toBe(expected);
    expect(configHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not change with comments, whitespace, key order, quoting or flow style', () => {
    const a = loadValid(
      'budget:\n  warn_percent: 70\n  stop_percent: 90\nretention:\n  evidence_retention_days: 365\n',
    );
    const b = loadValid(
      [
        '# Same settings, written differently.',
        'retention: { evidence_retention_days: 365 }   # longer retention',
        '',
        'budget:',
        '    stop_percent: 90',
        "    warn_percent: !!int '70'",
      ].join('\n'),
    );
    expect(b.configHash).toBe(a.configHash);
  });

  it('does not change when an override only repeats default values', () => {
    const repeated = loadValid(
      'oversight:\n  matrix:\n    G1:\n      low: { mode: HITL, roles: [person_a], approvals: 1 }\nretention:\n  evidence_retention_days: 180\n',
    );
    expect(repeated.configHash).toBe(DEFAULT_CONFIG_HASH);
  });

  it.each([
    ['a matrix cell', 'oversight:\n  matrix:\n    G2:\n      low: { mode: HITL }\n'],
    ['a budget threshold', 'budget:\n  warn_percent: 79\n'],
    ['the evidence retention', 'retention:\n  evidence_retention_days: 181\n'],
    ['a holiday', 'escalation:\n  calendar:\n    holidays: [2027-02-08]\n'],
    [
      'the order of a list',
      'escalation:\n  calendar:\n    working_days: [tue, mon, wed, thu, fri]\n',
    ],
  ])('changes when %s changes', (_name, yaml) => {
    expect(loadValid(yaml).configHash).not.toBe(DEFAULT_CONFIG_HASH);
  });
});
