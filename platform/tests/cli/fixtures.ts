// API response bodies for the CLI tests (B04 AC3), built with the API's own presenters, so the
// mocked API cannot drift from the real one: a presenter change that breaks the CLI's response
// schemas fails these tests.
import { createHash } from 'node:crypto';

import { PLATFORM_VERSION } from '@sdlc/api-schemas';

import type {
  Agent,
  AgentApproval,
  ApiToken,
  Escalation,
  GateDecisionRow,
  Intent,
  Plan,
  Project,
  ProjectAiRecord,
  Run,
  RoleBinding,
  SpecRef,
  TenantRoleBinding,
  User,
  UserIdentity,
  Evaluation,
  EvaluationPlan,
  PlanVersionView,
} from '../../packages/core/src/index.js';

import { presentAgent, presentRound } from '../../apps/api/src/admin/agents.present.js';
import {
  presentChain,
  presentConfig,
  presentIdentity,
  presentIssuedToken,
  presentToken,
  presentProject,
  presentRoleBinding,
  presentTenantRole,
  presentUser,
} from '../../apps/api/src/admin/present.js';
import { presentAiRecord } from '../../apps/api/src/ai-records/present.js';
import {
  presentEvaluation,
  presentPlan as presentEvalPlan,
  presentVersion,
} from '../../apps/api/src/evaluations/present.js';
import { presentPlanList, presentSubmittedPlan } from '../../apps/api/src/plans/present.js';
import { presentCostReport } from '../../apps/api/src/cost/present.js';
import { presentPack, presentProposal } from '../../apps/api/src/evidence/present.js';
import { presentAgentMetrics, presentGateMetrics } from '../../apps/api/src/metrics/present.js';
import { presentKill, presentRunList } from '../../apps/api/src/runs/present.js';
import { presentLinkedSpec, presentSpecList } from '../../apps/api/src/specs/present.js';
import { presentEscalation } from '../../apps/api/src/escalations/present.js';
import {
  presentDecision,
  presentIntent,
  presentPlan,
  presentSpec,
  presentWaitingFor,
} from '../../apps/api/src/intents/present.js';

export const TENANT = '11111111-1111-4111-8111-111111111111';
export const USER = '22222222-2222-4222-8222-222222222222';
export const PROJECT = { id: '33333333-3333-4333-8333-333333333333', slug: 'pilot' };
/** U01 (QUESTIONS #262): the intent body also names the repository. */
const INTENT_PROJECT = { ...PROJECT, repo_full_name: 'harryforge/pilot-order-inventory' };
const INTENT_ID = '44444444-4444-4444-8444-444444444444';
const AT = new Date('2026-10-03T01:02:03.000Z');
const HASH = 'a'.repeat(64);

export function intentRow(overrides: Partial<Intent> = {}): Intent {
  return {
    id: INTENT_ID,
    tenant_id: TENANT,
    code: 'INT-2026-0007',
    project_id: PROJECT.id,
    title: 'Add Japanese labels',
    description: 'T01',
    created_by: USER,
    risk_tier: 'low',
    data_class: 'internal',
    max_autonomy: 'L2',
    budget_usd: '2.500000',
    current_gate: 'G2',
    gate_entered_at: AT,
    run_budget_usd: null,
    waiting_reason: 'decision',
    waiting_cause: null,
    waiting_since: AT,
    waiting_until: null,
    human_effort_hours: null,
    status: 'in_gate',
    issue_number: 12,
    pr_number: null,
    updated_at: AT,
    created_at: AT,
    // X08a (migration 0056).
    search_tsv: '',
    closed_at: null,
    ...overrides,
  };
}

export function intentBody(overrides: Partial<Intent> = {}): Record<string, unknown> {
  return { ...presentIntent(intentRow(overrides), INTENT_PROJECT) };
}

export function decisionRow(overrides: Partial<GateDecisionRow> = {}): GateDecisionRow {
  return {
    id: '55555555-5555-4555-8555-555555555555',
    tenant_id: TENANT,
    intent_id: INTENT_ID,
    gate: 'G2',
    decision: 'approve',
    oversight_mode: 'HITL',
    approver_role: 'person_a',
    actor_type: 'human',
    decided_by: USER,
    reason_code: null,
    reason_ref: null,
    input_sha256: HASH,
    scope: null,
    expires_at: new Date('2026-10-10T01:02:03.000Z'),
    config_hash: HASH,
    source: 'cli',
    event_source: null,
    waited_seconds: 60,
    voids_decision_id: null,
    created_at: AT,
    ...overrides,
  };
}

export function decisionBody(overrides: Partial<GateDecisionRow> = {}): Record<string, unknown> {
  return presentDecision(decisionRow(overrides));
}

export function intentDetailBody(): Record<string, unknown> {
  const spec = {
    version: 1,
    path: 'docs/specs/T01.md',
    commit_sha: 'b'.repeat(40),
    content_sha256: HASH,
    source_tool: 'manual',
    structure: 'manual_heading',
    acceptance_criteria: 3,
  } as SpecRef;
  const plan = { version: 2, plan_sha256: HASH, change_flags: ['migration'] } as unknown as Plan;
  return {
    ...presentIntent(intentRow(), INTENT_PROJECT),
    waiting_for: presentWaitingFor({
      gate: 'G2',
      mode: 'HITL',
      roles: ['person_a'],
      approvalsNeeded: 1,
    }),
    spec: presentSpec(spec),
    plan: presentPlan(plan),
    decisions: [presentDecision(decisionRow())],
  };
}

const SPEC_ROW = {
  version: 2,
  path: 'docs/specs/T07 cancel.md',
  commit_sha: 'd'.repeat(40),
  content_sha256: HASH,
  source_tool: 'spec-kit',
  structure: 'spec_kit',
  acceptance_criteria: 4,
} as SpecRef;

/** B08: `POST /v1/intents/:intent/specs`. */
export function linkedSpecBody(): Record<string, unknown> {
  return presentLinkedSpec('INT-2026-0007', SPEC_ROW);
}

const PLAN_ROW = {
  version: 2,
  commit_sha: 'e'.repeat(40),
  plan_sha256: HASH,
  planned_files: ['apps/api/src/orders/**', 'apps/api/test/orders/**'],
  allowed_tools: ['file_editor', 'terminal'],
  change_flags: ['migration'],
  created_at: new Date('2026-10-03T01:00:00.000Z'),
} as Plan;

/** B09: `POST /v1/intents/:intent/plans`. */
export function submittedPlanBody(): Record<string, unknown> {
  return presentSubmittedPlan('INT-2026-0007', PLAN_ROW);
}

/** B09: `GET /v1/intents/:intent/plans`. */
export function planListBody(empty = false): Record<string, unknown> {
  return presentPlanList(
    'INT-2026-0007',
    empty ? [] : [{ ...PLAN_ROW, version: 1, change_flags: [] }, PLAN_ROW],
  );
}

export const RUN_ID = '77777777-7777-4777-8777-777777777777';

export function runRow(overrides: Partial<Run> = {}): Run {
  return {
    id: RUN_ID,
    tenant_id: TENANT,
    intent_id: INTENT_ID,
    plan_id: '88888888-8888-4888-8888-888888888888',
    attempt: 2,
    agent_id: '99999999-9999-4999-8999-999999999999',
    agent_version: 'v3',
    branch: 'agent/INT-2026-0007',
    base_sha: 'b'.repeat(40),
    head_sha: null,
    status: 'running',
    stop_reason: null,
    triggered_by: USER,
    started_at: AT,
    finished_at: null,
    iterations: 4,
    killed_by: null,
    updated_at: AT,
    created_at: AT,
    ...overrides,
  };
}

/** C11: `GET /v1/intents/:intent/runs`. */
export function runListBody(last: Partial<Run> = {}, empty = false): Record<string, unknown> {
  return presentRunList(
    'INT-2026-0007',
    empty
      ? []
      : [
          runRow({
            id: '77777777-7777-4777-8777-000000000001',
            attempt: 1,
            status: 'stopped_killed',
            stop_reason: 'killed',
            killed_by: USER,
            finished_at: AT,
          }),
          runRow(last),
        ],
  );
}

/** C11: `POST /v1/runs/:run/kill`. */
export function killBody(already = false): Record<string, unknown> {
  return presentKill('INT-2026-0007', {
    runId: RUN_ID,
    intentId: INTENT_ID,
    status: 'stopping',
    already,
    ...(already ? {} : { escalationId: '66666666-6666-4666-8666-666666666666' }),
  });
}

/** B08: `GET /v1/intents/:intent/specs`. */
export function specListBody(empty = false): Record<string, unknown> {
  return presentSpecList('INT-2026-0007', empty ? [] : [{ ...SPEC_ROW, version: 1 }, SPEC_ROW]);
}

export function escalationBody(overrides: Partial<Escalation> = {}): Record<string, unknown> {
  const row: Escalation = {
    id: '66666666-6666-4666-8666-666666666666',
    tenant_id: TENANT,
    code: 'ESC-2026-0003',
    intent_id: INTENT_ID,
    run_id: null,
    trigger: 'time',
    route: 'intent',
    severity: 'medium',
    response_level: 'notify',
    packet: { subject_kind: 'gate', subject_sha256: HASH, gate: 'G2', reason_code: 'other' },
    producer_ids: [],
    owner_id: USER,
    backup_owner_id: null,
    current_step: 'owner',
    status: 'open',
    ack_due_at: AT,
    step_due_at: AT,
    remind_at: null,
    reminded_step: null,
    ack_missed_at: null,
    governance_overdue_at: null,
    resolve_due_at: null,
    resolve_overdue_at: null,
    next_check_at: AT,
    acknowledged_by: null,
    acknowledged_at: null,
    decision: null,
    decided_by: null,
    decided_at: null,
    closed_at: null,
    updated_at: AT,
    created_at: AT,
    ...overrides,
  };
  return presentEscalation(
    row,
    { id: INTENT_ID, code: 'INT-2026-0007' },
    { owner_role: 'person_b', backup_role: 'person_a' },
  );
}

export function aiRecordBody(overrides: Partial<ProjectAiRecord> = {}): Record<string, unknown> {
  const record = {
    tenant_id: TENANT,
    project_id: PROJECT.id,
    version: 3,
    ai_allowed: 'yes',
    allowed_data_classes: ['public', 'internal'],
    prod_logs_allowed: 'no',
    disclosure_format: 'standard_note',
    confirmed_at: null,
    record_ref: null,
    record_sha256: HASH,
    updated_by: USER,
    updated_at: AT,
    created_at: AT,
    ...overrides,
  } as ProjectAiRecord;
  return presentAiRecord(record, PROJECT);
}

export function meBody(): Record<string, unknown> {
  return {
    user: { id: USER, display_name: 'Harry', email: 'harry@example.test' },
    tenant_id: TENANT,
    token_id: '77777777-7777-4777-8777-777777777777',
    tenant_admin: false,
    platform_version: PLATFORM_VERSION,
    roles: [{ project: PROJECT, role: 'person_a' }],
  };
}

// Admin endpoints (B13, ADR-M37).
export const OTHER_USER = '88888888-8888-4888-8888-888888888888';

export function projectBody(overrides: Partial<Project> = {}): Record<string, unknown> {
  return presentProject({
    id: PROJECT.id,
    tenant_id: TENANT,
    slug: PROJECT.slug,
    name: 'Pilot',
    git_provider: 'github',
    repo_full_name: 'harryforge/pilot-order-inventory',
    repo_path: '',
    default_branch: 'main',
    status: 'active',
    created_at: AT,
    ...overrides,
  });
}

export function userBody(
  overrides: Partial<User> = {},
  tenantAdmin = false,
): Record<string, unknown> {
  return presentUser(
    {
      id: OTHER_USER,
      tenant_id: TENANT,
      display_name: 'Bao',
      email: 'bao@example.test',
      status: 'active',
      created_at: AT,
      ...overrides,
    },
    tenantAdmin,
  );
}

export function identityBody(overrides: Partial<UserIdentity> = {}): Record<string, unknown> {
  return presentIdentity({
    id: '99999999-9999-4999-8999-999999999999',
    tenant_id: TENANT,
    user_id: OTHER_USER,
    provider: 'github',
    external_id: '583231',
    external_login: 'octocat',
    unlinked_at: null,
    created_at: AT,
    ...overrides,
  });
}

export function roleBody(overrides: Partial<RoleBinding> = {}): Record<string, unknown> {
  return presentRoleBinding(
    {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      tenant_id: TENANT,
      user_id: OTHER_USER,
      project_id: PROJECT.id,
      role: 'person_b',
      revoked_at: null,
      created_at: AT,
      ...overrides,
    },
    PROJECT,
  );
}

export function tenantRoleBody(
  overrides: Partial<TenantRoleBinding> = {},
): Record<string, unknown> {
  return presentTenantRole({
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    tenant_id: TENANT,
    user_id: OTHER_USER,
    role: 'tenant_admin',
    revoked_at: null,
    created_at: AT,
    ...overrides,
  });
}

export function configBody(version = 1): Record<string, unknown> {
  return presentConfig(
    {
      project: PROJECT,
      version,
      configYaml: version === 0 ? '' : 'budget:\n  warn_percent: 70\n',
      configHash: HASH,
      overrideSha256: version === 0 ? null : 'b'.repeat(64),
      updatedBy: version === 0 ? null : USER,
      updatedAt: version === 0 ? null : AT,
      warnings: [
        {
          key: 'config.warning.mode_loosened',
          path: 'oversight.matrix.G2.medium.mode',
          params: { from: 'HITL', to: 'HOTL' },
        },
      ],
    },
    'en',
  );
}

// Tokens and the audit check (B13 PR 2).
export const TOKEN_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function tokenRow(overrides: Partial<ApiToken> = {}): ApiToken {
  return {
    id: TOKEN_ID,
    tenant_id: TENANT,
    user_id: USER,
    name: 'laptop',
    token_hash: 'f'.repeat(64),
    last_used_at: null,
    expires_at: new Date('2027-01-01T00:00:00.000Z'),
    revoked_at: null,
    created_at: AT,
    ...overrides,
  };
}

export function tokenBody(overrides: Partial<ApiToken> = {}): Record<string, unknown> {
  return presentToken(tokenRow(overrides));
}

/** A new token as the API returns it: the raw token is built at run time (Gitleaks). */
export function issuedTokenBody(
  token: string,
  forOtherUser = false,
  overrides: Partial<ApiToken> = {},
): Record<string, unknown> {
  return presentIssuedToken({ token, record: tokenRow(overrides), forOtherUser });
}

export function chainBody(broken = false): Record<string, unknown> {
  return presentChain(TENANT, {
    checked: 41,
    lastSeq: 41,
    lastHash: 'e'.repeat(64),
    ...(broken ? { broken: { seq: 42, reason: 'hash_mismatch' as const } } : {}),
  });
}

// The agent register (B13 AC7).
export const AGENT_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function agentRow(overrides: Partial<Agent> = {}): Agent {
  return {
    id: AGENT_ID,
    tenant_id: TENANT,
    agent_key: 'coder',
    version: '1.0.0',
    status: 'proposed',
    owner_id: USER,
    model_ref: 'claude-haiku-4-5-20251001',
    instructions_ref: 'AGENTS.md@v1',
    instructions_sha256: HASH,
    allowed_tools: ['file_editor', 'terminal'],
    max_autonomy: 'L2',
    approved_environments: ['sandbox'],
    last_recertified_at: null,
    created_at: AT,
    updated_at: AT,
    adapter: 'openhands',
    root_instructions_ref: null,
    root_instructions_sha256: null,
    ...overrides,
  };
}

export function agentBody(overrides: Partial<Agent> = {}): Record<string, unknown> {
  return presentAgent(agentRow(overrides), 3, AT);
}

export function roundBody(completed = false): Record<string, unknown> {
  const approval: AgentApproval = {
    id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    tenant_id: TENANT,
    agent_id: AGENT_ID,
    agent_version: '1.0.0',
    purpose: 'activate',
    capacity: 'owner',
    approver_id: USER,
    round_at: AT,
    created_at: AT,
    evaluation_id: null,
    evaluation_result: null,
  };
  return presentRound(
    {
      agent: agentRow(completed ? { status: 'active', last_recertified_at: '2026-10-03' } : {}),
      purpose: 'activate',
      required: ['owner', 'person_b'],
      approvals: completed ? [approval, { ...approval, capacity: 'person_b' }] : [approval],
      completed,
    },
    3,
    AT,
  );
}

const COST_A = {
  calls: 3,
  inputTokens: '1200',
  outputTokens: '300',
  cachedInputTokens: '100',
  costUsd: '0.300000',
  wastedTokens: '500',
  wastedCostUsd: '0.100000',
};

/** E04: `GET /v1/cost/report` (ADR-M45 §2.4), from the API's presenter. */
export function costReportBody(
  options: { empty?: boolean; truncated?: boolean } = {},
): Record<string, unknown> {
  const zero = {
    calls: 0,
    inputTokens: '0',
    outputTokens: '0',
    cachedInputTokens: '0',
    costUsd: '0.000000',
    wastedTokens: '0',
    wastedCostUsd: '0.000000',
  };
  return presentCostReport({
    scope: { kind: 'project', project: 'pilot' },
    from: new Date('2026-10-01T00:00:00.000Z'),
    to: new Date('2026-10-04T00:00:00.000Z'),
    groupBy: 'intent',
    totals: options.empty ? zero : COST_A,
    rows: options.empty
      ? []
      : [
          { key: 'INT-2026-0007', ...COST_A, calls: 2 },
          { key: null, ...COST_A, calls: 1, wastedTokens: '0', wastedCostUsd: '0.000000' },
        ],
    truncated: options.truncated ?? false,
    freshness: {
      latestCallAt: options.empty ? null : new Date('2026-10-03T10:00:00.000Z'),
      lastRecordedAt: options.empty ? null : new Date('2026-10-03T10:05:00.000Z'),
      runsInProgress: 1,
    },
  });
}

const NO_WAITS = {
  count: 0,
  avgSeconds: null,
  maxSeconds: null,
  p50Seconds: null,
  p90Seconds: null,
};

/** E06: `GET /v1/metrics/gates` (ADR-M47), from the API's presenter. */
export function gateMetricsBody(
  options: { empty?: boolean; truncated?: boolean; tenant?: boolean } = {},
): Record<string, unknown> {
  return presentGateMetrics({
    scope: options.tenant ? { kind: 'tenant' } : { kind: 'project', project: 'pilot' },
    from: new Date('2026-09-04T00:00:00.000Z'),
    to: new Date('2026-10-04T00:00:00.000Z'),
    asOf: new Date('2026-10-04T09:00:00.000Z'),
    filters: { gate: null, mode: null, riskTier: null },
    rows: options.empty
      ? []
      : [
          {
            project: 'pilot',
            gate: 'G2',
            firstRound: NO_WAITS,
            afterChanges: NO_WAITS,
            autoPassed: 3,
            open: { count: 0, oldestSeconds: null },
          },
          {
            project: 'pilot',
            gate: 'G3',
            firstRound: {
              count: 4,
              avgSeconds: 5400,
              maxSeconds: 93784,
              p50Seconds: 3600,
              p90Seconds: 90000,
            },
            afterChanges: {
              count: 1,
              avgSeconds: 172800,
              maxSeconds: 172800,
              p50Seconds: 172800,
              p90Seconds: 172800,
            },
            autoPassed: 0,
            open: { count: 2, oldestSeconds: 45 },
          },
        ],
    truncated: options.truncated ?? false,
  });
}

/** V13: `GET /v1/metrics/agents` (ADR-M79), from the API's presenter. */
export function agentMetricsBody(
  options: { empty?: boolean; truncated?: boolean; tenant?: boolean } = {},
): Record<string, unknown> {
  const row = (model: string, merged: number) => ({
    project: 'pilot',
    agent: 'coder-openhands',
    agentVersion: '1.4.0',
    model,
    runs: {
      total: 4,
      inProgress: 1,
      byStatus: { succeeded: 2, failed: 1, running: 1 },
      byStopReason: { agent_error: 1 },
      retries: 1,
    },
    ci: { firstTryTotal: 2, firstTryPassed: 1 },
    merged: {
      intents: merged,
      withoutChangesRequested: merged === 0 ? 0 : 1,
      leadTime: {
        count: merged,
        avgSeconds: merged === 0 ? null : 5400,
        maxSeconds: merged === 0 ? null : 7200,
      },
      humanEffort:
        merged === 0
          ? {
              count: 0,
              estimateHoursSum: null,
              leadTimeSecondsSum: null,
              leadToEstimatePercent: null,
            }
          : {
              count: 1,
              estimateHoursSum: '8',
              leadTimeSecondsSum: 7200,
              leadToEstimatePercent: 25,
            },
    },
    scopeBreaches: 1,
    tokens: { input: '1450', output: '310', cachedInput: '100', cacheSharePercent: 6.9 },
    cost: {
      totalUsd: '0.900000',
      wastedUsd: '0.500000',
      perRunUsd: '0.225000',
      perMergedIntentUsd: merged === 0 ? null : '0.900000',
    },
  });
  return presentAgentMetrics({
    scope: options.tenant ? { kind: 'tenant' } : { kind: 'project', project: 'pilot' },
    from: new Date('2026-09-04T00:00:00.000Z'),
    to: new Date('2026-10-04T00:00:00.000Z'),
    filters: { agent: null, model: null },
    rows: options.empty ? [] : [row('model-big', 2), row('unknown', 0)],
    unattributedCostUsd: '1.000000',
    truncated: options.truncated ?? false,
  });
}

/** E02: one Evidence Pack version (ADR-M48 §2.6), from the API's presenter. */
export function evidencePackBody(version = 1, sealed = false): Record<string, unknown> {
  const uri = (name: string) =>
    `s3://evidence/packs/${TENANT}/${INTENT_ID}/00000000-0000-4000-8000-00000000000${String(version)}/${name}`;
  return presentPack('INT-2026-0007', {
    id: `00000000-0000-4000-8000-00000000000${String(version)}`,
    tenant_id: TENANT,
    intent_id: INTENT_ID,
    version,
    content_sha256: 'c'.repeat(64),
    release_sha256: 'c'.repeat(64),
    manifest_uri: uri('manifest.json'),
    manifest_sha256: 'a'.repeat(64),
    manifest_size_bytes: '2048',
    markdown_uri: uri('pack.md'),
    markdown_sha256: 'b'.repeat(64),
    markdown_size_bytes: '4096',
    locale: 'en',
    disclosure_format: 'standard_note',
    item_count: 2,
    built_by: USER,
    sealed_at: sealed ? new Date('2026-10-05T00:00:00.000Z') : null,
    retention_hold: false,
    purged_at: null,
    created_at: new Date('2026-10-04T09:00:00.000Z'),
    lock_extended_until: null,
  });
}

/** E02: a pack file as `GET …/evidence-packs/:version/:file` returns it. */
/** C13: `GET /v1/intents/:intent/runs/:run/proposal`; bytes that are not UTF-8 included. */
export function proposalBody(content: Buffer, sha256?: string): Record<string, unknown> {
  return presentProposal(
    'INT-2026-0007',
    RUN_ID,
    sha256 ?? createHash('sha256').update(content).digest('hex'),
    content,
  );
}

export function evidenceFileBody(content: string, sha256?: string): Record<string, unknown> {
  return {
    file: {
      intent_id: INTENT_ID,
      version: 1,
      name: 'pack.md',
      media_type: 'text/markdown',
      sha256: sha256 ?? createHash('sha256').update(content, 'utf8').digest('hex'),
      size_bytes: Buffer.byteLength(content),
      content,
    },
  };
}

// L05: an evaluation plan with its current version, and an evaluation of it.
const PLAN_ID = '88888888-8888-4888-8888-888888888888';

export function evalPlanBody(): Record<string, unknown> {
  const plan = {
    id: PLAN_ID,
    tenant_id: TENANT,
    project_id: PROJECT.id,
    code: 'weekly-models',
    current_version: 2,
    status: 'active',
    pause_reason: null,
    paused_until: null,
    next_run_at: AT,
    seen_sha256: null,
    run_requested_at: AT,
    run_requested_by: USER,
    last_refusal: 'model_not_allowed',
    last_refusal_at: AT,
    created_by: USER,
    updated_at: AT,
    created_at: AT,
  } as EvaluationPlan;
  const version = {
    version: 2,
    dataClass: 'internal',
    taskSetVersion: 1,
    taskIds: ['feat-tax'],
    runsPerTask: 2,
    budgetPerRunUsd: '2.5',
    monthlyCapUsd: '10',
    trigger: 'schedule',
    schedule: { every: 'weekly', hour: 6, weekday: 1 },
    configurations: [
      {
        id: 'oss-short',
        agent_key: null,
        model: 'gpt-oss-20b',
        provider_type: 'self_hosted',
        max_iterations: 30,
        max_duration_min: 20,
        prompt: { path: 'eval/prompts/short.md', commit: 'c'.repeat(40), sha256: HASH },
      },
    ],
    changedBy: USER,
    createdAt: AT,
  } as PlanVersionView;
  return {
    ...presentEvalPlan(plan, PROJECT),
    can_change: true,
    current: presentVersion(version),
    versions: [{ version: 2, changed_by: USER, created_at: AT.toISOString() }],
    evaluations: [evaluationBody()],
  };
}

export function evaluationBody(extra = false): Record<string, unknown> {
  const evaluation = {
    id: '99999999-9999-4999-8999-999999999999',
    tenant_id: TENANT,
    project_id: PROJECT.id,
    code: 'EVAL-2026-0001',
    data_class: 'internal',
    task_set_version: 1,
    config_name: null,
    task_ids: ['feat-tax'],
    configuration_ids: ['oss-short'],
    runs_per_task: 2,
    budget_usd: '2.500000',
    status: 'running',
    stop_reason: null,
    started_by: USER,
    finished_at: null,
    updated_at: AT,
    created_at: AT,
    base_sha: 'a'.repeat(40),
    plan_id: PLAN_ID,
    plan_version: 2,
    task_set_kind: 'folder',
    task_set_commit: null,
  } as Evaluation;
  return presentEvaluation(
    evaluation,
    extra
      ? {
          counts: { queued: 1, running: 1, preempted: 0, scored: 0, failed: 0, cancelled: 0 },
          spentUsd: '0.42',
        }
      : undefined,
  );
}
