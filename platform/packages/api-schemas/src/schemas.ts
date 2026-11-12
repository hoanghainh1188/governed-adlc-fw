// Response schemas of the API (ADR-M26 §2.8, ADR-M28 §2.7, ADR-M32 §2.4). API output is external
// data: the CLI keeps only the fields below and refuses a body that does not match. The test
// platform/tests/cli/api-schemas.test.ts checks them against the API's own presenters.
import { z } from 'zod';

const id = z.string().max(64);
const code = z.string().max(64);
const time = z.string().max(40);
const ref = z.string().max(512);
const codes = z.record(z.string(), z.unknown());

export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: code,
    message: z.string().max(2000),
    reason: code.optional(),
    reason_message: z.string().max(2000).optional(),
    details: z
      .array(
        z.object({
          path: z.string().max(200),
          issue: z.string().max(200),
          message: z.string().max(2000).optional(),
        }),
      )
      .max(100)
      .optional(),
  }),
});
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

export const meSchema = z.object({
  user: z.object({ id, display_name: z.string().max(200), email: z.string().max(320) }),
  tenant_id: id,
  // U05: null for a dashboard session; `auth` says which credential the request used.
  token_id: id.nullable(),
  auth: z.enum(['token', 'session']).optional(),
  tenant_admin: z.boolean().optional(),
  // V07 (QUESTIONS #401): the API's release version; missing from APIs before it (`adlc doctor`).
  platform_version: z.string().max(64).optional(),
  roles: z
    .array(z.object({ project: z.object({ id, slug: code.nullable() }), role: code }))
    .max(10_000),
});
export type Me = z.infer<typeof meSchema>;

/** `DELETE /v1/me/sessions`, `DELETE /v1/admin/users/:user/sessions` (U05). */
export const endedSessionsSchema = z.object({ ended: z.number().int().min(0).max(1_000_000) });
export type EndedSessions = z.infer<typeof endedSessionsSchema>;

/**
 * `GET /v1/auth/config` (U05): is dashboard sign-in with GitHub on? U06: are actions on
 * (`SDLC_API_DASHBOARD_ACTIONS`)? Absent from an older API: off.
 */
export const authConfigSchema = z.object({
  github: z.boolean(),
  actions: z.boolean().optional().default(false),
});
export type AuthConfig = z.infer<typeof authConfigSchema>;

export const intentSchema = z.object({
  id,
  code,
  project: z.object({ id, slug: code, repo_full_name: z.string().max(200) }),
  title: z.string().max(1000),
  description: z.string().max(20_000),
  risk_tier: code,
  data_class: code,
  max_autonomy: code,
  budget_usd: code,
  status: code,
  current_gate: code.nullable(),
  gate_entered_at: time.nullable(),
  /** U02 (ADR-M54 §2.4b): why the workflow holds the intent, as its step recorded it. */
  // Optional: an older API (before U02) does not send them.
  waiting_reason: code.nullable().optional(),
  waiting_cause: code.nullable().optional(),
  waiting_since: time.nullable().optional(),
  waiting_until: time.nullable().optional(),
  /** V14: a person's estimate of the human effort in hours (decimal string); null when none. */
  human_effort_hours: z
    .string()
    .regex(/^[0-9]{1,5}(\.[0-9]{1,2})?$/)
    .nullable()
    .optional(),
  issue_number: z.number().int().nullable(),
  pr_number: z.number().int().nullable(),
  created_by: id,
  created_at: time,
  updated_at: time,
});
export type IntentView = z.infer<typeof intentSchema>;

export const decisionSchema = z.object({
  id,
  gate: code,
  decision: code,
  oversight_mode: code,
  approver_role: code.nullable(),
  actor_type: code,
  decided_by: id.nullable(),
  reason_code: code.nullable(),
  reason_ref: ref.nullable(),
  input_sha256: code,
  scope: codes.nullable(),
  expires_at: time.nullable(),
  config_hash: code,
  source: code,
  voids_decision_id: id.nullable(),
  created_at: time,
});
export type DecisionView = z.infer<typeof decisionSchema>;

const specRefSchema = z.object({
  version: z.number().int(),
  path: z.string().max(1024),
  commit_sha: code,
  content_sha256: code,
  /** S01 (ADR-M61): the tool, the structure rule and the acceptance criteria count. */
  source_tool: code.nullable(),
  structure: code.nullable(),
  acceptance_criteria: z.number().int().min(0).nullable(),
});

export const intentDetailSchema = intentSchema.extend({
  /** U07: the current gate input hash the confirmation step shows. */
  gate_input_sha256: code.nullable().optional(),
  /** U01 (QUESTIONS #261): who the current gate waits for, as the workflow resolves it. */
  waiting_for: z
    .object({
      gate: code,
      mode: code,
      roles: z.array(code).max(20),
      approvals_needed: z.number().int(),
    })
    .nullable(),
  spec: specRefSchema.nullable(),
  plan: z
    .object({
      version: z.number().int(),
      plan_sha256: code,
      change_flags: z.array(code).max(50),
    })
    .nullable(),
  decisions: z.array(decisionSchema).max(10_000),
});
export type IntentDetail = z.infer<typeof intentDetailSchema>;

/** `POST /v1/intents/:intent/specs` (B08, ADR-M39 §2.2). */
export const linkedSpecSchema = specRefSchema.extend({ intent: code });
export type LinkedSpecView = z.infer<typeof linkedSpecSchema>;

const planVersionSchema = z.object({
  version: z.number().int(),
  commit_sha: code.nullable(),
  plan_sha256: code,
  planned_files: z.array(z.string().max(1024)).max(1000),
  allowed_tools: z.array(code).max(10).nullable(),
  change_flags: z.array(code).max(50),
  created_at: time,
});
export type PlanVersionView = z.infer<typeof planVersionSchema>;

/** `POST /v1/intents/:intent/plans` (B09, ADR-M40 §2.3). */
export const submittedPlanSchema = planVersionSchema.extend({ intent: code });
export type SubmittedPlanView = z.infer<typeof submittedPlanSchema>;

/** `GET /v1/intents/:intent/plans` (B09). */
export const planListSchema = z.object({
  intent: code,
  items: z.array(planVersionSchema).max(10_000),
});

/** A run of an intent (C11, ADR-M42 §2.6): IDs, codes, counts and times. */
const runSchema = z.object({
  id,
  attempt: z.number().int(),
  status: code,
  stop_reason: code.nullable(),
  agent_version: code,
  iterations: z.number().int(),
  killed_by: id.nullable(),
  created_at: time,
  started_at: time.nullable(),
  finished_at: time.nullable(),
});
export type RunView = z.infer<typeof runSchema>;

/** `GET /v1/intents/:intent/runs` (C11). */
export const runListSchema = z.object({
  intent: code,
  items: z.array(runSchema).max(10_000),
});

/** `POST /v1/runs/:run/kill` (C11). */
export const killResultSchema = z.object({
  run: id,
  intent: code,
  status: code,
  already: z.boolean(),
  escalation: id.nullable(),
});

/** Token sums: strings of digits (task E04, ADR-M45 §2.4). */
const tokenSum = z.string().regex(/^[0-9]{1,20}$/);
/** Money: a decimal string with 6 decimals, never a JSON number (D-05 D6). */
const usd6 = z.string().regex(/^[0-9]{1,15}\.[0-9]{6}$/);

const costAmountsSchema = z.object({
  calls: z.number().int().min(0),
  input_tokens: tokenSum,
  output_tokens: tokenSum,
  cached_input_tokens: tokenSum,
  cost_usd: usd6,
  wasted_tokens: tokenSum,
  wasted_cost_usd: usd6,
});
export type CostAmountsView = z.infer<typeof costAmountsSchema>;

/** `GET /v1/cost/report` (E04, ADR-M45 §2.4). */
export const costReportSchema = z.object({
  report: z.object({
    scope: z.object({
      kind: z.enum(['tenant', 'project', 'intent']),
      project: code.optional(),
      intent: code.optional(),
    }),
    from: time,
    to: time,
    group_by: z.enum(['project', 'intent', 'model', 'status']),
    totals: costAmountsSchema,
    rows: z.array(costAmountsSchema.extend({ key: z.string().max(128).nullable() })).max(500),
    truncated: z.boolean(),
    freshness: z.object({
      latest_call_at: time.nullable(),
      last_recorded_at: time.nullable(),
      runs_in_progress: z.number().int().min(0),
    }),
  }),
});
export type CostReportView = z.infer<typeof costReportSchema>['report'];

/** Whole seconds, or null when there is nothing to measure (task E06, ADR-M47). */
const seconds = z.number().int().min(0);
const waitStatsSchema = z.object({
  count: z.number().int().min(0),
  avg_seconds: seconds.nullable(),
  max_seconds: seconds.nullable(),
  p50_seconds: seconds.nullable(),
  p90_seconds: seconds.nullable(),
});
export type WaitStatsView = z.infer<typeof waitStatsSchema>;

/** `GET /v1/metrics/gates` (E06, ADR-M47). */
export const gateMetricsSchema = z.object({
  metrics: z.object({
    scope: z.object({ kind: z.enum(['tenant', 'project']), project: code.optional() }),
    from: time,
    to: time,
    as_of: time,
    clock: z.literal('wall_clock'),
    filters: z.object({
      gate: code.nullable(),
      mode: code.nullable(),
      risk: code.nullable(),
    }),
    rows: z
      .array(
        z.object({
          project: code,
          gate: z.enum(['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8']),
          first_round: waitStatsSchema,
          after_changes: waitStatsSchema,
          auto_passed: z.number().int().min(0),
          open: z.object({ count: z.number().int().min(0), oldest_seconds: seconds.nullable() }),
        }),
      )
      .max(500),
    truncated: z.boolean(),
  }),
});
export type GateMetricsView = z.infer<typeof gateMetricsSchema>['metrics'];

const count = z.number().int().min(0);

/** `GET /v1/metrics/agents` (V13, ADR-M79). Counts, seconds and amounts only. */
export const agentMetricsSchema = z.object({
  metrics: z.object({
    scope: z.object({ kind: z.enum(['tenant', 'project']), project: code.optional() }),
    from: time,
    to: time,
    filters: z.object({ agent: code.nullable(), model: code.nullable() }),
    rows: z
      .array(
        z.object({
          project: code,
          agent: code,
          agent_version: code,
          model: code,
          runs: z.object({
            total: count,
            in_progress: count,
            by_status: z.record(code, count),
            by_stop_reason: z.record(code, count),
            retries: count,
          }),
          ci: z.object({ first_try_total: count, first_try_passed: count }),
          merged: z.object({
            intents: count,
            without_changes_requested: count,
            lead_time: z.object({
              count,
              avg_seconds: seconds.nullable(),
              max_seconds: seconds.nullable(),
            }),
            /** V14 (ADR-M79 §2.6): lead time compared with the human-effort estimate. */
            human_effort: z
              .object({
                count,
                estimate_hours_sum: z
                  .string()
                  .regex(/^[0-9]{1,15}(\.[0-9]{1,2})?$/)
                  .nullable(),
                lead_time_seconds_sum: seconds.nullable(),
                lead_to_estimate_percent: z.number().min(0).nullable(),
              })
              .optional(),
          }),
          scope_breaches: count,
          tokens: z.object({
            input: tokenSum,
            output: tokenSum,
            cached_input: tokenSum,
            cache_share_percent: z.number().min(0).max(100).nullable(),
          }),
          cost: z.object({
            total_usd: usd6,
            wasted_usd: usd6,
            per_run_usd: usd6.nullable(),
            per_merged_intent_usd: usd6.nullable(),
          }),
        }),
      )
      .max(500),
    unattributed_cost_usd: usd6,
    truncated: z.boolean(),
  }),
});
export type AgentMetricsView = z.infer<typeof agentMetricsSchema>['metrics'];

/** `GET /v1/intents/:intent/specs` (B08). */
export const specListSchema = z.object({
  intent: code,
  items: z.array(specRefSchema).max(10_000),
});

export const intentPageSchema = z.object({
  items: z.array(intentSchema).max(1000),
  next_cursor: z.string().max(200).nullable(),
});

export const escalationSchema = z.object({
  id,
  code,
  intent: z.object({ id, code }),
  run_id: id.nullable(),
  trigger: code,
  route: code,
  severity: code,
  response_level: code,
  status: code,
  freezes_intent: z.boolean(),
  current_step: code,
  owner_id: id.nullable(),
  backup_owner_id: id.nullable(),
  /** U01 (QUESTIONS #263): the route's roles in the configuration in force. */
  owner_role: code.nullable(),
  backup_role: code.nullable(),
  step_role: code.nullable(),
  packet: codes,
  ack_due_at: time.nullable(),
  step_due_at: time.nullable(),
  resolve_due_at: time.nullable(),
  acknowledged_by: id.nullable(),
  acknowledged_at: time.nullable(),
  decision: codes.nullable(),
  decided_by: id.nullable(),
  decided_at: time.nullable(),
  closed_at: time.nullable(),
  created_at: time,
});
export type EscalationView = z.infer<typeof escalationSchema>;

export const escalationListSchema = z.object({ items: z.array(escalationSchema).max(1000) });

export const aiRecordSchema = z.object({
  project: z.object({ id, slug: code }),
  version: z.number().int(),
  ai_allowed: code,
  allowed_data_classes: z.array(code).max(20),
  prod_logs_allowed: code,
  disclosure_format: code,
  confirmed_at: z.string().max(10).nullable(),
  consent: code,
  record_ref: ref.nullable(),
  record_sha256: code,
  updated_by: id,
  created_at: time,
});
export type AiRecordView = z.infer<typeof aiRecordSchema>;

// Admin endpoints (task B13, ADR-M37 §2.6).
export const adminProjectSchema = z.object({
  id,
  slug: code,
  name: z.string().max(200),
  git_provider: code,
  repo_full_name: z.string().max(200),
  // O06 (ADR-M106 §2.4); absent from an older server.
  repo_path: z.string().max(200).optional(),
  default_branch: z.string().max(100),
  status: code,
  created_at: time,
});
export type AdminProjectView = z.infer<typeof adminProjectSchema>;
export const adminProjectListSchema = z.object({ items: z.array(adminProjectSchema).max(10_000) });

export const adminUserSchema = z.object({
  id,
  display_name: z.string().max(200),
  email: z.string().max(320),
  status: code,
  tenant_admin: z.boolean(),
  created_at: time,
});
export type AdminUserView = z.infer<typeof adminUserSchema>;
export const adminUserListSchema = z.object({ items: z.array(adminUserSchema).max(100_000) });

export const adminIdentitySchema = z.object({
  id,
  user_id: id,
  provider: code,
  external_id: code,
  external_login: code,
  unlinked_at: time.nullable(),
  created_at: time,
});
export type AdminIdentityView = z.infer<typeof adminIdentitySchema>;
export const adminIdentityListSchema = z.object({ items: z.array(adminIdentitySchema).max(1000) });

export const adminRoleSchema = z.object({
  id,
  user_id: id,
  project: z.object({ id, slug: code }),
  role: code,
  revoked_at: time.nullable(),
  created_at: time,
});
export type AdminRoleView = z.infer<typeof adminRoleSchema>;
export const adminRoleListSchema = z.object({ items: z.array(adminRoleSchema).max(100_000) });

export const adminTenantRoleSchema = z.object({
  id,
  user_id: id,
  role: code,
  revoked_at: time.nullable(),
  created_at: time,
});
export type AdminTenantRoleView = z.infer<typeof adminTenantRoleSchema>;
export const adminTenantRoleListSchema = z.object({
  items: z.array(adminTenantRoleSchema).max(10_000),
});

const configIssueSchema = z.object({
  key: z.string().max(200),
  path: z.string().max(200),
  message: z.string().max(2000),
});

export const adminConfigSchema = z.object({
  project: z.object({ id, slug: code }),
  version: z.number().int().min(0),
  config_yaml: z.string().max(64 * 1024),
  config_hash: z.string().max(64),
  override_sha256: z.string().max(64).nullable(),
  updated_by: id.nullable(),
  updated_at: time.nullable(),
  warnings: z.array(configIssueSchema).max(1000),
});
export type AdminConfigView = z.infer<typeof adminConfigSchema>;

// Personal API tokens and the audit check (task B13 PR 2, ADR-M37 §2.8). A token record never
// holds the token; only the answer to an issue does, once.
export const tokenSchema = z.object({
  id,
  user_id: id,
  name: code,
  expires_at: time,
  revoked_at: time.nullable(),
  last_used_at: time.nullable(),
  created_at: time,
});
export type TokenView = z.infer<typeof tokenSchema>;
export const tokenListSchema = z.object({ items: z.array(tokenSchema).max(10_000) });

export const issuedTokenSchema = tokenSchema.extend({
  token: z.string().regex(/^sdlc_pat_[A-Za-z0-9_-]{43}$/),
  for_other_user: z.boolean(),
});
export type IssuedTokenView = z.infer<typeof issuedTokenSchema>;

export const chainSchema = z.object({
  tenant_id: id,
  ok: z.boolean(),
  checked: z.number().int().min(0),
  last_seq: z.number().int().min(0),
  broken: z
    .object({
      seq: z.number().int(),
      reason: z.enum(['seq_gap', 'prev_hash_mismatch', 'hash_mismatch', 'unknown_hash_version']),
    })
    .nullable(),
});

// The agent register (task B13 AC7, ADR-M37 §2.8).
export const agentSchema = z.object({
  id,
  key: code,
  version: code,
  status: code,
  owner_id: id,
  model_ref: z.string().max(128).nullable(),
  instructions_ref: z.string().max(300),
  instructions_sha256: code,
  allowed_tools: z.array(code).max(32),
  max_autonomy: code,
  approved_environments: z.array(code).max(3),
  /** X03: absent from a server before X03 (every agent was OpenHands). */
  adapter: code.optional(),
  /** O06: the repository root's file, pinned too; absent from an older server. */
  root_instructions_ref: z.string().max(300).nullable().optional(),
  root_instructions_sha256: code.nullable().optional(),
  last_recertified_at: z.string().max(10).nullable(),
  recertification_due_on: z.string().max(10).nullable(),
  overdue: z.boolean(),
  updated_at: time,
});
export type AgentView = z.infer<typeof agentSchema>;

/** The check of an evaluation in the agent register (L09, ADR-M86 §2.5, §2.8). */
export const agentEvaluationSchema = z.object({
  mode: code,
  code: z.string().max(32).nullable(),
  result: code.nullable(),
  qualifies: z.boolean(),
  params: z.record(z.string().max(32), z.string().max(64)),
  // L10: the comparison of a recertification with the last activation.
  aging: z
    .object({
      status: code,
      reason: code.nullable(),
      params: z.record(z.string().max(32), z.string().max(64)),
    })
    .optional(),
});
export type AgentEvaluationView = z.infer<typeof agentEvaluationSchema>;
/** The list; with `?overdue=true` (L10) each item has its latest evaluation. */
export const agentListSchema = z.object({
  items: z
    .array(agentSchema.extend({ evaluation: agentEvaluationSchema.nullable().optional() }))
    .max(10_000),
});
/** The answer of `recertify` (L10): the agent and the check of its evaluation. */
export const agentRecertifiedSchema = agentSchema.extend({
  evaluation: agentEvaluationSchema.nullable().optional(),
});

export const agentRoundSchema = z.object({
  agent: agentSchema,
  purpose: code,
  required: z.array(code).max(4),
  missing: z.array(code).max(4),
  approvals: z
    .array(
      z.object({
        id,
        agent_version: code,
        purpose: code,
        capacity: code,
        approver_id: id,
        evaluation_id: id.nullable().optional(),
        evaluation_result: code.nullable().optional(),
        created_at: time,
      }),
    )
    .max(4),
  completed: z.boolean(),
  evaluation: agentEvaluationSchema.nullable().optional(),
});
export type AgentRoundView = z.infer<typeof agentRoundSchema>;
export const agentDetailSchema = agentSchema.extend({
  rounds: z.array(agentRoundSchema).max(2),
  evaluation: agentEvaluationSchema.nullable().optional(),
});
export type AgentDetailView = z.infer<typeof agentDetailSchema>;

// The tool register (task X04, ADR-M69 §2.2).
export const toolSchema = z.object({
  id,
  key: code,
  code: z.string().max(80),
  version: code,
  status: code,
  owner_id: id,
  transport: code,
  image_ref: z.string().max(255).nullable(),
  image_digest: z.string().max(80).nullable(),
  permissions: z.array(code).max(10),
  allowed_data_classes: z.array(code).max(5),
  backing_services: z.array(code).max(10),
  model_ref: z.string().max(128).nullable(),
  last_recertified_at: z.string().max(10).nullable(),
  recertification_due_on: z.string().max(10).nullable(),
  overdue: z.boolean(),
  updated_at: time,
});
export type ToolView = z.infer<typeof toolSchema>;
export const toolListSchema = z.object({ items: z.array(toolSchema).max(10_000) });
export const toolRoundSchema = z.object({
  tool: toolSchema,
  purpose: code,
  sets: z.array(z.array(code).max(4)).max(4),
  approvers: z.array(code).max(4),
  missing: z.array(z.array(code).max(4)).max(4),
  approvals: z
    .array(
      z.object({
        id,
        tool_version: code,
        purpose: code,
        capacity: code,
        approver_id: id,
        created_at: time,
      }),
    )
    .max(4),
  completed: z.boolean().optional(),
});
export type ToolRoundView = z.infer<typeof toolRoundSchema>;
export const toolDetailSchema = toolSchema.extend({ rounds: z.array(toolRoundSchema).max(2) });

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const packFileSchema = z.object({ uri: ref, sha256, size_bytes: z.number().int().min(0) });

/** An Evidence Pack version (E02, ADR-M48 §2.6). */
export const evidencePackSchema = z.object({
  intent: code,
  id,
  version: z.number().int().min(1),
  content_sha256: sha256,
  release_sha256: sha256.nullable(),
  manifest: packFileSchema,
  markdown: packFileSchema,
  locale: code,
  disclosure_format: z.enum(['client_format', 'standard_note']),
  item_count: z.number().int().min(0),
  built_by: id.nullable(),
  built_at: time,
  sealed_at: time.nullable(),
  retention_hold: z.boolean(),
  purged_at: time.nullable(),
});
export type EvidencePackView = z.infer<typeof evidencePackSchema>;

/** `POST /v1/intents/:intent/evidence-packs` (E02). */
export const evidenceBuildSchema = z.object({ pack: evidencePackSchema, created: z.boolean() });
export type EvidenceBuildView = z.infer<typeof evidenceBuildSchema>;
/** `GET /v1/intents/:intent/evidence-packs/:version` (E02). */
export const evidenceShowSchema = z.object({ pack: evidencePackSchema });
/** `GET /v1/intents/:intent/evidence-packs` (E02). */
export const evidenceListSchema = z.object({
  intent: code,
  packs: z.array(evidencePackSchema).max(100_000),
});
/** `GET /v1/intents/:intent/evidence-packs/:version/manifest|markdown` (E02). */
export const evidenceFileSchema = z.object({
  file: z.object({
    intent_id: id,
    version: z.number().int().min(1),
    name: z.enum(['manifest.json', 'pack.md']),
    media_type: z.enum(['application/json', 'text/markdown']),
    sha256,
    size_bytes: z.number().int().min(0),
    // A pack file is at most a few MB: refuse anything larger.
    content: z.string().max(64 * 1024 * 1024),
  }),
});

/** C13: PROPOSAL_MAX_BYTES of `@sdlc/contracts` (32 MiB) in base64; a test keeps them equal. */
export const PROPOSAL_BASE64_MAX = Math.ceil((32 * 1024 * 1024) / 3) * 4;

/**
 * `GET /v1/intents/:intent/runs/:run/proposal` (C13, ADR-M64 §2.1): an L1 run's patch, in base64
 * (a patch is bytes), with the SHA-256 the platform checked; the CLI checks it again.
 */
export const proposalSchema = z.object({
  proposal: z.object({
    intent: code,
    run_id: id,
    media_type: z.literal('text/x-diff'),
    sha256,
    size_bytes: z.number().int().min(0),
    // At most PROPOSAL_MAX_BYTES (`@sdlc/contracts`, 32 MiB) in base64.
    content_base64: z
      .string()
      .max(PROPOSAL_BASE64_MAX)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/),
  }),
});

/** An evidence hold (E05, ADR-M51, QUESTIONS #235): IDs, times and the optional link. */
export const evidenceHoldSchema = z.object({
  id,
  held_by: id,
  reason_ref: ref.nullable(),
  created_at: time,
  released_at: time.nullable(),
  released_by: id.nullable(),
});
export type EvidenceHoldView = z.infer<typeof evidenceHoldSchema>;
/** `PUT` and `DELETE /v1/intents/:intent/evidence-hold` (E05). */
export const evidenceHoldChangeSchema = z.object({ hold: evidenceHoldSchema });
/** `GET /v1/intents/:intent/evidence-hold` (E05). */
export const evidenceHoldListSchema = z.object({
  intent: code,
  active: evidenceHoldSchema.nullable(),
  history: z.array(evidenceHoldSchema).max(10_000),
});

/**
 * `GET|POST|DELETE /v1/client/data-deletion` (H03c, ADR-M97 §2.4): tenant admin request, cancel
 * and status. Codes and IDs only; never a ticket URL or free-text reason.
 */
export const clientDataDeletionSchema = z.object({
  tenant_id: id,
  tenant_slug: code,
  tenant_status: code,
  phase: code,
  requested_by: id.nullable(),
  requested_at: time.nullable(),
  grace_period_days: z.number().int().min(0).max(365).nullable(),
  legal_basis: code.nullable(),
  operator_id: id.nullable(),
  approved_at: time.nullable(),
  cancelled_by: id.nullable(),
  cancelled_at: time.nullable(),
});
export type ClientDataDeletionView = z.infer<typeof clientDataDeletionSchema>;

/**
 * `GET /v1/auth/session` (U06, ADR-M73 §2.3): the session's CSRF token, kept in memory and sent in
 * `X-SDLC-CSRF` with every write; when the person signed in; are actions on.
 */
export const webSessionSchema = z.object({
  csrf_token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  signed_in_at: z.string().max(40),
  actions: z.boolean(),
});
export type WebSessionView = z.infer<typeof webSessionSchema>;

const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** One passkey (U06): IDs, the authenticator model and times; never the key. */
export const passkeySchema = z.object({
  id: z.string().regex(UUID_TEXT),
  aaguid: z.string().regex(UUID_TEXT).nullable(),
  created_at: z.string().max(40),
  last_used_at: z.string().max(40).nullable(),
  revoked_at: z.string().max(40).nullable(),
});
export type PasskeyView = z.infer<typeof passkeySchema>;

/** `GET /v1/me/passkeys`, `GET /v1/admin/users/:user/passkeys` (U06). */
export const passkeyListSchema = z.object({ items: z.array(passkeySchema).max(1000) });

/**
 * `POST /v1/me/passkeys/registration-options` (U06): the challenge's ID and the WebAuthn options,
 * handed as they are to the browser's passkey library (it checks their shape).
 */
export const passkeyRegistrationOptionsSchema = z.object({
  challenge_id: z.string().regex(UUID_TEXT),
  options: z
    .object({
      challenge: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
      rp: z.object({ name: z.string().max(200), id: z.string().max(253).optional() }),
      user: z.object({
        id: z.string().max(200),
        name: z.string().max(320),
        displayName: z.string().max(200),
      }),
      pubKeyCredParams: z
        .array(z.object({ type: z.literal('public-key'), alg: z.number() }))
        .max(10),
    })
    .passthrough(),
  expires_in_seconds: z.number().int().min(1).max(600),
});
export type PasskeyRegistrationOptions = z.infer<typeof passkeyRegistrationOptionsSchema>;

/**
 * `POST /v1/auth/step-up` (U06; used by L05's plan actions): the challenge's ID and the WebAuthn
 * request options, handed as they are to the browser's passkey library.
 */
export const stepUpOptionsSchema = z.object({
  challenge_id: z.string().regex(UUID_TEXT),
  options: z
    .object({
      challenge: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
      allowCredentials: z
        .array(z.object({ id: z.string().max(1366), type: z.literal('public-key') }).passthrough())
        .max(10)
        .optional(),
    })
    .passthrough(),
  expires_in_seconds: z.number().int().min(1).max(600),
});
export type StepUpOptions = z.infer<typeof stepUpOptionsSchema>;

// Evaluation plans and evaluations (task L05, ADR-M82 §2.7). Codes, IDs, amounts, hashes.
const decimal = z.string().regex(/^[0-9]{1,15}(\.[0-9]{1,6})?$/);
const sha = z.string().regex(/^[0-9a-f]{40,64}$/);

export const evalPlanConfigurationSchema = z.object({
  id: code,
  agent_key: code.nullable(),
  model: z.string().max(128).nullable(),
  provider_type: code.nullable(),
  max_iterations: z.number().int(),
  max_duration_min: z.number().int(),
  prompt: z.object({ path: z.string().max(512), commit: sha, sha256: sha }).nullable(),
});

export const evalPlanVersionSchema = z.object({
  version: z.number().int(),
  data_class: code,
  task_set_kind: code,
  task_set_version: z.number().int().nullable(),
  task_ids: z.array(code).max(64).nullable(),
  runs_per_task: z.number().int(),
  budget_per_run_usd: decimal,
  monthly_cap_usd: decimal,
  trigger: code,
  schedule: z
    .object({ every: code, hour: z.number().int(), weekday: z.number().int().nullable() })
    .nullable(),
  configurations: z.array(evalPlanConfigurationSchema).max(16),
  changed_by: id.nullable(),
  created_at: time,
});

export const evaluationSchema = z.object({
  id,
  code,
  project_id: id,
  plan_id: id.nullable(),
  plan_version: z.number().int().nullable(),
  config_name: code.nullable(),
  data_class: code,
  task_set_kind: code,
  task_set_version: z.number().int().nullable(),
  task_set_commit: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .nullable(),
  task_ids: z.array(code).max(64),
  configuration_ids: z.array(code).max(16),
  runs_per_task: z.number().int(),
  budget_usd: decimal,
  status: code,
  stop_reason: code.nullable(),
  started_by: id.nullable(),
  created_at: time,
  finished_at: time.nullable(),
  runs: z
    .object({
      queued: z.number().int(),
      running: z.number().int(),
      preempted: z.number().int(),
      scored: z.number().int(),
      failed: z.number().int(),
      cancelled: z.number().int(),
    })
    .optional(),
  spent_usd: decimal.optional(),
});
export type EvaluationView = z.infer<typeof evaluationSchema>;
export const evaluationListSchema = z.object({
  evaluations: z.array(evaluationSchema).max(200),
});

// The report of an evaluation (task L06, ADR-M83 §2.2, §2.3). Numbers and codes only.
const share = z.number().min(0).max(1);
const interval = z.object({ estimate: share, low: share, high: share });

export const evaluationReportSchema = z.object({
  evaluation: evaluationSchema,
  final: z.boolean(),
  results: count,
  thresholds: z.object({
    alpha: share,
    min_paired_tasks: count,
    low_ci_first_try_rate: share,
    unstable_gap: share,
    stopped_at_cap_share: share,
  }),
  configurations: z
    .array(
      z.object({
        configuration: code,
        model: z.string().max(128),
        tasks: count,
        runs: count,
        k: count,
        resolved: interval,
        pass_at_1: share,
        pass_at_k: share,
        pass_hat_k: share,
        ci_first_try: share,
        scope_breaches: count,
        stopped: count,
        stopped_at_cap: count,
        median_seconds: count,
        total_cost_usd: usd6,
        cost_per_run_usd: usd6,
        cost_per_resolved_usd: usd6.nullable(),
      }),
    )
    .max(16),
  comparisons: z
    .array(
      z.object({
        a: code,
        b: code,
        pairs: count,
        paired_tasks: count,
        only_a: count,
        only_b: count,
        p_value: share,
        better: code.nullable(),
      }),
    )
    .max(120),
  recommendations: z
    .array(
      z.object({
        rule: code,
        configuration: code,
        other: code.nullable(),
        numbers: z.record(code, z.string().max(128)),
      }),
    )
    .max(200),
  real_runs: z
    .discriminatedUnion('available', [
      agentMetricsSchema.shape.metrics.extend({ available: z.literal(true) }),
      z.object({ available: z.literal(false), reason: code }),
    ])
    .nullable(),
});
export type EvaluationReportView = z.infer<typeof evaluationReportSchema>;

/** `GET /v1/evaluations/recent` (L06, QUESTIONS #482): evaluations that ended in the last 7 days. */
export const recentEvaluationsSchema = z.object({
  since: time,
  evaluations: z.array(evaluationSchema.extend({ project: code })).max(50),
});
export type RecentEvaluationsView = z.infer<typeof recentEvaluationsSchema>;

export const evalPlanSummarySchema = z.object({
  id,
  project: z.object({ id, slug: code }),
  code,
  version: z.number().int(),
  status: code,
  pause_reason: code.nullable(),
  paused_until: time.nullable(),
  next_run_at: time.nullable(),
  run_requested_at: time.nullable(),
  last_refusal: code.nullable(),
  last_refusal_at: time.nullable(),
  created_by: id.nullable(),
  created_at: time,
  updated_at: time,
});
export type EvalPlanSummaryView = z.infer<typeof evalPlanSummarySchema>;
export const evalPlanListSchema = z.object({
  /** QUESTIONS #477: the caller may change and run the project's plans (for the UI only). */
  can_change: z.boolean(),
  plans: z.array(evalPlanSummarySchema).max(1000),
});

export const evalPlanSchema = evalPlanSummarySchema.extend({
  can_change: z.boolean(),
  current: evalPlanVersionSchema,
  versions: z
    .array(z.object({ version: z.number().int(), changed_by: id.nullable(), created_at: time }))
    .max(10_000),
  evaluations: z.array(evaluationSchema).max(200),
});
export type EvalPlanView = z.infer<typeof evalPlanSchema>;

// L07 (ADR-M85): a project's own evaluation tasks. A task card's fields (the draft; the CLI writes
// the YAML) and a registered task: codes, commits, paths of the card and hashes.
const repoPath = z.string().max(200);
export const evalTaskCardSchema = z.object({
  id: code,
  intent: code,
  base_commit: sha,
  merge_commit: sha,
  spec: z.object({ path: repoPath, commit: sha, sha256: sha }),
  hidden_tests: z.array(repoPath).max(20),
  planned_files: z.array(repoPath).max(20),
  fail_to_pass: z.array(repoPath).max(20),
  pass_to_pass: z.array(repoPath).max(20),
  ci: z.array(repoPath).max(20),
});
export type EvalTaskCardView = z.infer<typeof evalTaskCardSchema>;
export const evalTaskDraftSchema = z.object({ card: evalTaskCardSchema });

export const evalTaskSchema = z.object({
  id,
  task: code,
  intent: code,
  card_path: repoPath,
  card_commit: sha,
  card_sha256: sha,
  base_commit: sha,
  merge_commit: sha,
  status: code,
  check_code: code.nullable(),
  created_at: time,
  updated_at: time,
});
export type EvalTaskView = z.infer<typeof evalTaskSchema>;
export const evalTaskListSchema = z.object({ tasks: z.array(evalTaskSchema).max(10_000) });
export const evalTaskRegisteredSchema = z.object({
  outcome: z.enum(['created', 'changed', 'unchanged']),
  task: evalTaskSchema,
});
export const evalTaskReviewedSchema = z.object({ task: evalTaskSchema });
