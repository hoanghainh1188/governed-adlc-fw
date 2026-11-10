// Vocabularies stored as PostgreSQL enums and CHECK constraints (design/D-05 section 5).
// Canonical codes (data classes, 2+N roles, …) come from `@sdlc/contracts`; this file lists only
// the values that exist in the database layer alone. Only the enums used by existing tables exist
// yet (A06; `actor_type` from A07; the registry enums from B02; `run_status` from C02; the
// escalation enums from B11; `agent_status` from C10); later tasks add theirs with their
// tables.
// Changing a list needs a migration: design/ADR-M09-database-tooling.md section 2.5.
import {
  ACTOR_TYPES,
  AGENT_STATUSES,
  TOOL_STATUSES,
  AUTONOMY_LEVELS,
  CHANGE_FLAGS,
  DATA_CLASSES,
  EVENT_SOURCES,
  GATE_CHECK_MODES,
  GATE_CODES,
  GATE_DECISIONS,
  GATE_REASON_CODES,
  INTENT_STATUSES,
  PROJECT_ROLES,
  ESCALATION_ROUTES,
  ESCALATION_STATUSES,
  ESCALATION_STEPS,
  ESCALATION_TRIGGERS,
  RESPONSE_LEVELS,
  RISK_TIERS,
  RUN_STATUSES,
  SEVERITIES,
} from '@sdlc/contracts';

/** Tenant-level roles (task B13, QUESTIONS #150, ADR-M37). Project roles are in `@sdlc/contracts`. */
export const TENANT_ROLES = ['tenant_admin'] as const;
export type TenantRole = (typeof TENANT_ROLES)[number];

/** Statuses of an evaluation and of its runs (task L04, migration 0029; stored as text + CHECK). */
export const EVALUATION_STATUSES = [
  'queued',
  'running',
  'completed',
  'stopped_budget',
  'cancelled',
  'failed',
] as const;
export type EvaluationStatus = (typeof EVALUATION_STATUSES)[number];
export const EVALUATION_FINAL_STATUSES: readonly EvaluationStatus[] = [
  'completed',
  'stopped_budget',
  'cancelled',
  'failed',
];

export const EVALUATION_RUN_STATUSES = [
  'queued',
  'running',
  'preempted',
  'scored',
  'failed',
  'cancelled',
] as const;
export type EvaluationRunStatus = (typeof EVALUATION_RUN_STATUSES)[number];
export const EVALUATION_RUN_FINAL_STATUSES: readonly EvaluationRunStatus[] = [
  'scored',
  'failed',
  'cancelled',
];

export const GIT_PROVIDERS = ['github', 'gitlab'] as const;
export type GitProvider = (typeof GIT_PROVIDERS)[number];

/** PostgreSQL enum type name → allowed values. Checked against the live schema by the tests. */
export const DB_ENUMS = {
  data_class: DATA_CLASSES,
  project_role: PROJECT_ROLES,
  git_provider: GIT_PROVIDERS,
  actor_type: ACTOR_TYPES,
  gate_code: GATE_CODES,
  risk_tier: RISK_TIERS,
  autonomy_level: AUTONOMY_LEVELS,
  change_flag: CHANGE_FLAGS,
  intent_status: INTENT_STATUSES,
  gate_decision: GATE_DECISIONS,
  gate_check_mode: GATE_CHECK_MODES,
  gate_reason_code: GATE_REASON_CODES,
  event_source: EVENT_SOURCES,
  run_status: RUN_STATUSES,
  escalation_trigger: ESCALATION_TRIGGERS,
  severity: SEVERITIES,
  response_level: RESPONSE_LEVELS,
  escalation_status: ESCALATION_STATUSES,
  escalation_route: ESCALATION_ROUTES,
  escalation_step: ESCALATION_STEPS,
  agent_status: AGENT_STATUSES,
  tenant_role: TENANT_ROLES,
  // X04 (migration 0038, ADR-M69 §2.2).
  tool_status: TOOL_STATUSES,
} as const;

// Text columns with a CHECK constraint (D-05 section 6.1).
export const TENANT_STATUSES = ['active', 'suspended', 'pending_deletion', 'purged'] as const;
export type TenantStatus = (typeof TENANT_STATUSES)[number];

export const PROJECT_STATUSES = ['active', 'archived'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const USER_STATUSES = ['active', 'disabled'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

// Project AI record (handbook Chapter 2 section 2.5, template T7): the codes live in
// `@sdlc/contracts` since B12, because the policy engine reads them (ADR-M32).
export {
  AI_ALLOWED_VALUES,
  DISCLOSURE_FORMATS,
  PROD_LOGS_ALLOWED_VALUES,
  type AiAllowed,
  type DisclosureFormat,
  type ProdLogsAllowed,
} from '@sdlc/contracts';

// Registry (D-05 sections 6.2 and 6.3, B02).
export const SPEC_SOURCE_TOOLS = ['spec-kit', 'bmad', 'manual'] as const;
export type SpecSourceTool = (typeof SPEC_SOURCE_TOOLS)[number];

/** Which rule found a spec's acceptance criteria (S01, ADR-M61; `spec_refs.structure`). */
export const SPEC_STRUCTURES = [
  'spec_kit',
  'bmad_story',
  'bmad_epics',
  'manual_heading',
  'none',
] as const;
export type SpecStructureCode = (typeof SPEC_STRUCTURES)[number];

/** The largest acceptance criteria count stored (the database CHECK; a spec is ≤ 256 KiB). */
export const ACCEPTANCE_CRITERIA_MAX = 10_000;

/** Where a gate decision came from (D-05 `gate_decisions.source`). */
export const GATE_DECISION_SOURCES = [
  'cli',
  'github_comment',
  'github_review',
  'workflow',
  'web',
] as const;
export type GateDecisionSource = (typeof GATE_DECISION_SOURCES)[number];

// Agent register (D-05 section 6.1, handbook Ch.20, task C10, ADR-M31).
/** Environments an agent may be approved for (handbook template T6). Runs are `sandbox`. */
export const AGENT_ENVIRONMENTS = ['sandbox', 'staging', 'production'] as const;
export type AgentEnvironment = (typeof AGENT_ENVIRONMENTS)[number];

/** Evaluation plans (L05, ADR-M82, migration 0031). */
export const EVALUATION_PLAN_STATUSES = ['active', 'paused', 'archived'] as const;
export type EvaluationPlanStatus = (typeof EVALUATION_PLAN_STATUSES)[number];
export const EVALUATION_PLAN_TRIGGERS = ['once', 'schedule', 'on_change'] as const;
export type EvaluationPlanTrigger = (typeof EVALUATION_PLAN_TRIGGERS)[number];
/** L07 (ADR-M85 §2.10, migration 0035): a numbered task set, or the project's approved tasks. */
export const TASK_SET_KINDS = ['folder', 'project'] as const;
export type TaskSetKind = (typeof TASK_SET_KINDS)[number];
/** L07 (ADR-M85 §2.7): the states of a project's evaluation task; `gone` is final. */
export const EVALUATION_TASK_STATUSES = [
  'registered',
  'checking',
  'checked',
  'check_failed',
  'approved',
  'rejected',
  'gone',
] as const;
export type EvaluationTaskStatus = (typeof EVALUATION_TASK_STATUSES)[number];
/** L07: a review decision on a task, bound to the card's SHA-256. */
export const EVALUATION_TASK_DECISIONS = ['approved', 'rejected'] as const;
export type EvaluationTaskDecision = (typeof EVALUATION_TASK_DECISIONS)[number];
/** L07: why a reviewer rejected a task (codes only; the words stay on GitHub). */
export const EVALUATION_TASK_REJECT_REASONS = [
  'not_representative',
  'tests_weak',
  'too_large',
  'needs_environment',
  'other',
] as const;
export type EvaluationTaskRejectReason = (typeof EVALUATION_TASK_REJECT_REASONS)[number];
