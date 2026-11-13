// D-08 C02 AC3 and the append-only text rule (CLAUDE.md, ADR-M22 section 2.5): run event payloads
// hold declared, coded fields only. Never free text, personal data or client data.
import { describe, expect, it } from 'vitest';

import { DbError } from '../../packages/core/src/db/errors.js';
import {
  checkRunEvent,
  isRecordableModel,
  RUN_EVENT_TYPES,
} from '../../packages/core/src/run-events/index.js';

const SHA = 'a'.repeat(64);
const refused = (type: string, payload: Record<string, unknown>) => () =>
  checkRunEvent(type, payload);

describe('run event payloads', () => {
  it('declares the C02, C04, C05, C06, C07, C08, E01 and C11 event types (E01 PR 2: feedback; C11 PR 2: loop_detected; B09 PR 2: plan)', () => {
    expect(Object.keys(RUN_EVENT_TYPES)).toEqual([
      'contract_issued',
      'model_selected',
      'contract_accepted',
      'contract_rejected',
      'workspace_prepared',
      'sandbox_created',
      'sandbox_ready',
      'tool_started',
      'tool_used',
      'tool_refused',
      'tool_failed',
      'knowledge_unavailable',
      'knowledge_read',
      'context_snapshot',
      'tool_credential_revoked',
      'tool_credential_revoke_failed',
      'provisioning_failed',
      'sandbox_removed',
      'run_abandoned',
      'agent_started',
      'agent_stopped',
      'loop_detected',
      'agent_finished',
      'agent_failed',
      'proposal_stored',
      'key_issued',
      'budget_warning',
      'diff_stored',
      'changes_checked',
      'secrets_scanned',
      'diff_measured',
      'dependencies_scanned',
      'branch_pushed',
      'publish_refused',
      'publish_failed',
      'ci_checked',
      'g7_checked',
      'pr_merged',
      'kill_requested',
      'token_revoked',
      'token_revoke_failed',
      'wrap_token_reused',
      'kill_evidence_failed',
      'feedback_read',
      'feedback_unavailable',
      'plan_read',
      'plan_unavailable',
      'memory_read',
    ]);
  });

  it('X07: context_snapshot holds a hash, a source code and counts, never a path', () => {
    const payload = {
      snapshot_sha256: SHA,
      source: 'agent_log',
      files: 2,
      files_outside: 0,
      unattributed_calls: 1,
      document_tools: 1,
      documents: 3,
    };
    expect(checkRunEvent('context_snapshot', payload)).toEqual(payload);
    expect(refused('context_snapshot', { ...payload, source: 'src/index.ts' })).toThrow(DbError);
    expect(refused('context_snapshot', { ...payload, files: -1 })).toThrow(DbError);
    expect(refused('context_snapshot', { ...payload, path: SHA })).toThrow(/undeclared/);
  });

  it('V13: model_selected holds a gateway model name, never a space or an @', () => {
    for (const model of ['gpt-oss-20b', 'claude-haiku-4-5-20251001', 'ollama/gpt-oss:20b']) {
      expect(checkRunEvent('model_selected', { model })).toEqual({ model });
      expect(isRecordableModel(model)).toBe(true);
    }
    expect(isRecordableModel('m'.repeat(128))).toBe(true);
    for (const model of ['m'.repeat(129), 'a b', 'org@model', 'model+1', '-model', '', 7]) {
      expect(isRecordableModel(model)).toBe(false);
      expect(refused('model_selected', { model })).toThrow(DbError);
    }
    expect(refused('model_selected', { model: 'gpt-oss-20b', run: 'x' })).toThrow(/undeclared/);
  });

  it('X11: agent_started and agent_finished hold the condensing state and counts, never a summary', () => {
    const started = { max_iterations: 30, max_duration_min: 60, condensing: 'summarize' };
    expect(checkRunEvent('agent_started', started)).toEqual(started);
    expect(checkRunEvent('agent_started', { max_iterations: 30, max_duration_min: 60 })).toEqual({
      max_iterations: 30,
      max_duration_min: 60,
    });
    const finished = {
      outcome: 'finished',
      iterations: 12,
      condensations: 2,
      events_forgotten: 40,
    };
    expect(checkRunEvent('agent_finished', finished)).toEqual(finished);
    expect(
      refused('agent_started', { ...started, condensing: 'The agent edited src/a.ts' }),
    ).toThrow(DbError);
    expect(refused('agent_finished', { ...finished, events_forgotten: -1 })).toThrow(DbError);
    expect(refused('agent_finished', { ...finished, summary: 'text' })).toThrow(/undeclared/);
  });

  it('E01: g7_checked and pr_merged hold codes, counts and a hash, never a login', () => {
    const checked = {
      pr_number: 7,
      pr_state: 'merged',
      head_sha: 'e'.repeat(40),
      merge_commit_sha: 'f'.repeat(40),
      merger: 'person',
      reviews_sha256: 'a'.repeat(64),
      approvals: 1,
      changes_requested: 0,
      commit_authors: 0,
      commits_without_account: 1,
    };
    expect(checkRunEvent('g7_checked', checked)).toEqual(checked);
    const open: Record<string, unknown> = { ...checked, pr_state: 'open' };
    delete open.merge_commit_sha;
    delete open.merger;
    expect(checkRunEvent('g7_checked', open)).toMatchObject({
      pr_state: 'open',
    });
    expect(() => checkRunEvent('g7_checked', { ...checked, merger: 'alice@example.com' })).toThrow(
      /merger/,
    );
    expect(() => checkRunEvent('g7_checked', { ...checked, login: 'alice' })).toThrow(/undeclared/);
    expect(checkRunEvent('pr_merged', { pr_number: 7, head_sha: 'e'.repeat(40) })).toEqual({
      pr_number: 7,
      head_sha: 'e'.repeat(40),
    });
  });

  it('B09 PR 2: plan_read holds counts and a code, plan_unavailable a code; never plan text', () => {
    const read = { tasks: 2, chars: 640, truncated: 'no', skipped_fields: 1 };
    expect(checkRunEvent('plan_read', read)).toEqual(read);
    expect(refused('plan_read', { ...read, truncated: 'cut at 16000' })).toThrow(DbError);
    expect(refused('plan_read', { ...read, summary: 'Add the tax' })).toThrow(DbError);
    expect(checkRunEvent('plan_unavailable', { reason: 'hash_mismatch' })).toEqual({
      reason: 'hash_mismatch',
    });
    expect(refused('plan_unavailable', { reason: 'the file says hi' })).toThrow(DbError);
  });

  it('memory_read (X13 PR 2): codes, the version, the hash and counts; never text or a path', () => {
    expect(
      checkRunEvent('memory_read', {
        reason: 'read',
        version: 2,
        set_sha256: 'f'.repeat(64),
        files: 3,
        chars: 1200,
        truncated: 'no',
      }),
    ).toEqual({
      reason: 'read',
      version: 2,
      set_sha256: 'f'.repeat(64),
      files: 3,
      chars: 1200,
      truncated: 'no',
    });
    expect(
      checkRunEvent('memory_read', { reason: 'revoked', files: 0, chars: 0, truncated: 'no' }),
    ).toEqual({ reason: 'revoked', files: 0, chars: 0, truncated: 'no' });
    expect(
      refused('memory_read', { reason: 'read', files: 1, chars: 1, truncated: 'no', path: 'x' }),
    ).toThrow(DbError);
    expect(
      refused('memory_read', { reason: 'Run the API tests', files: 1, chars: 1, truncated: 'no' }),
    ).toThrow(DbError);
  });

  it('C08 PR 2: ci_checked holds codes, counts and a hash, never a check name', () => {
    const checked = {
      pr_number: 7,
      pr_state: 'open',
      head_sha: 'a'.repeat(40),
      state: 'passed',
      checks_sha256: 'b'.repeat(64),
      findings: 'known',
      critical: 0,
      high: 1,
      medium: 0,
      low: 3,
    };
    expect(checkRunEvent('ci_checked', checked)).toEqual(checked);
    expect(refused('ci_checked', { ...checked, state: 'lint, type check' })).toThrow(DbError);
    expect(refused('ci_checked', { ...checked, name: 'ci-ok' })).toThrow(DbError);
  });

  it('C08: branch_pushed holds commits and hashes; publish_refused and publish_failed a code', () => {
    const head = 'a'.repeat(40);
    const pushed = {
      head_sha: head,
      parent_sha: 'b'.repeat(40),
      diff_sha256: 'c'.repeat(64),
      paths_sha256: 'd'.repeat(64),
    };
    expect(checkRunEvent('branch_pushed', pushed)).toEqual(pushed);
    expect(refused('branch_pushed', { ...pushed, diff_sha256: 'x' })).toThrow(DbError);
    expect(refused('branch_pushed', { ...pushed, path: 'src/a.ts' })).toThrow(DbError);
    expect(checkRunEvent('publish_refused', { reason: 'branch_moved' })).toEqual({
      reason: 'branch_moved',
    });
    expect(refused('publish_failed', { reason: 'git said: no' })).toThrow(DbError);
  });

  it('C07: key_issued holds the cap as a decimal string and which budget set it', () => {
    expect(checkRunEvent('key_issued', { max_budget_usd: '0.5', limited_by: 'intent' })).toEqual({
      max_budget_usd: '0.5',
      limited_by: 'intent',
    });
    for (const amount of [0.5, '-1', '1e3', '0.1234567', '01.5', '']) {
      expect(refused('key_issued', { max_budget_usd: amount, limited_by: 'run' })).toThrow(DbError);
    }
    expect(refused('key_issued', { max_budget_usd: '1', limited_by: 'run', key: 'sk-x' })).toThrow(
      DbError,
    );
  });

  it('C07: budget_warning holds two decimals and a percent', () => {
    expect(
      checkRunEvent('budget_warning', { spend_usd: '0.41', max_budget_usd: '0.5', percent: 82 }),
    ).toEqual({ spend_usd: '0.41', max_budget_usd: '0.5', percent: 82 });
    expect(refused('budget_warning', { spend_usd: '0.41', max_budget_usd: '0.5' })).toThrow(
      DbError,
    );
  });

  it('C07: diff_stored and changes_checked hold hashes and counts only, never paths', () => {
    expect(checkRunEvent('diff_stored', { sha256: SHA, size_bytes: 10, changed_files: 2 })).toEqual(
      { sha256: SHA, size_bytes: 10, changed_files: 2 },
    );
    const checked = {
      changed_files: 4,
      out_of_scope: 1,
      instruction_files: 0,
      paths_sha256: SHA,
    };
    expect(checkRunEvent('changes_checked', checked)).toEqual(checked);
    expect(refused('changes_checked', { ...checked, out_of_scope_paths: 'a.ts' })).toThrow(DbError);
    expect(refused('changes_checked', { ...checked, paths_sha256: 'src/a.ts' })).toThrow(DbError);
  });

  it('H02: dependencies_scanned holds codes and counts only, never package text', () => {
    const payload = {
      result: 'warning',
      new_dependencies: 2,
      changed_dependencies: 1,
      license_violations: 1,
      install_scripts: 0,
      typosquatting_warnings: 1,
      advisory_findings: 0,
    };
    expect(checkRunEvent('dependencies_scanned', payload)).toEqual(payload);
    expect(refused('dependencies_scanned', { ...payload, package_name: 'evil' })).toThrow(
      /undeclared/,
    );
    expect(refused('dependencies_scanned', { ...payload, path: 'package.json' })).toThrow(
      /undeclared/,
    );
  });

  it('C06 2b: proposal_stored holds a hash and counts only, never paths', () => {
    expect(
      checkRunEvent('proposal_stored', { sha256: SHA, size_bytes: 1024, changed_files: 3 }),
    ).toEqual({ sha256: SHA, size_bytes: 1024, changed_files: 3 });
    expect(
      refused('proposal_stored', { sha256: SHA, size_bytes: 1, changed_files: 1, path: 'a.ts' }),
    ).toThrow(DbError);
    expect(refused('proposal_stored', { sha256: 'x', size_bytes: 1, changed_files: 1 })).toThrow(
      DbError,
    );
  });

  it('accepts the C04 sandbox events with coded fields only (ADR-M25)', () => {
    expect(
      checkRunEvent('workspace_prepared', { base_sha: 'f'.repeat(40), duration_ms: 812 }),
    ).toEqual({ base_sha: 'f'.repeat(40), duration_ms: 812 });
    expect(checkRunEvent('sandbox_created', { image_sha256: SHA })).toEqual({ image_sha256: SHA });
    expect(checkRunEvent('sandbox_ready', { duration_ms: 5000 })).toEqual({ duration_ms: 5000 });
    expect(checkRunEvent('provisioning_failed', { reason: 'egress_not_enforceable' })).toEqual({
      reason: 'egress_not_enforceable',
    });
    expect(checkRunEvent('sandbox_removed', { reason: 'orphan', duration_ms: 0 })).toEqual({
      reason: 'orphan',
      duration_ms: 0,
    });
    expect(checkRunEvent('run_abandoned', { previous_status: 'running' })).toEqual({
      previous_status: 'running',
    });
  });

  it.each([
    ['workspace_prepared', { base_sha: 'agent/INT-2026-0001', duration_ms: 1 }],
    ['workspace_prepared', { base_sha: 'f'.repeat(40), duration_ms: -1 }],
    ['sandbox_created', { image_sha256: 'sha256:' + SHA }],
    ['sandbox_created', { image_sha256: SHA, image: 'registry/name' }],
    ['provisioning_failed', { reason: 'git clone failed: auth' }],
    ['sandbox_removed', { reason: 'finished' }],
    ['run_abandoned', {}],
    ['run_abandoned', { previous_status: 'the runner crashed' }],
    ['run_abandoned', { previous_status: 'running', host: 'server-1' }],
  ])('refuses a bad %s payload', (type, payload) => {
    expect(refused(type, payload)).toThrow(DbError);
  });

  it('accepts the declared fields', () => {
    expect(checkRunEvent('contract_issued', { contract_sha256: SHA, key_version: 2 })).toEqual({
      contract_sha256: SHA,
      key_version: 2,
    });
    expect(checkRunEvent('contract_rejected', { reason: 'expired' })).toEqual({
      reason: 'expired',
    });
  });

  it.each([
    ['free text', { reason: 'customer Tanaka asked to stop' }],
    ['an e-mail address', { reason: 'tanaka@example.co.jp' }],
    ['a nested object', { reason: { text: 'x' } }],
    ['an array', { reason: ['expired'] }],
    ['null', { reason: null }],
    ['an undeclared field', { reason: 'expired', note: 'x' }],
    ['a missing field', {}],
    ['a long code', { reason: 'x'.repeat(65) }],
  ])('refuses %s', (_label, payload) => {
    expect(refused('contract_rejected', payload)).toThrow(DbError);
  });

  it('refuses unknown event types and badly formatted hashes and versions', () => {
    expect(refused('agent_said', { text: 'hello' })).toThrow(/unknown run event type/);
    expect(refused('contract_issued', { contract_sha256: 'A'.repeat(64), key_version: 1 })).toThrow(
      /contract_sha256/,
    );
    expect(refused('contract_issued', { contract_sha256: SHA, key_version: 0 })).toThrow(
      /key_version/,
    );
  });
});
