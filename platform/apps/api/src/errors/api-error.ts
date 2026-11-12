// Every error the API returns has a stable code, an HTTP status and a message from the catalog
// (D-08 B03 AC4, NFR-08). Nothing else reaches the client: no stack trace, no SQL, no library text.
import type { ConfigIssue } from '@sdlc/config';
import {
  AGENT_REGISTER_ERROR_MESSAGES,
  AdminError,
  AgentRegisterError,
  AiRecordError,
  CommandError,
  EvaluationError,
  KillError,
  PasskeyError,
  PLAN_ERROR_MESSAGES,
  PLAN_REFUSAL_MESSAGES,
  PlanError,
  SPEC_ERROR_MESSAGES,
  SpecError,
  DbError,
  EscalationError,
  EvidenceHoldError,
  EvidencePackError,
  RegistryError,
  TenantGuardError,
  TOOL_REGISTER_ERROR_MESSAGES,
  ToolRegisterError,
  type AdminErrorCode,
  type CommandErrorCode,
  type KillErrorCode,
  type PasskeyErrorCode,
  type DbErrorCode,
  type EscalationErrorCode,
  type EvaluationErrorCode,
  type EvidencePackErrorCode,
  type RegistryErrorCode,
} from '@sdlc/core';
import { t, type MessageKey } from '@sdlc/messages';

/** Codes of the error envelope. Each has the catalog key `api.error.<code>` (tested). */
export const API_ERROR_CODES = [
  'unauthorized',
  'session_ended',
  'credentials_ambiguous',
  'session_write_not_allowed',
  'dashboard_actions_off',
  'csrf_refused',
  'recent_signin_required',
  'too_many_passkeys',
  'too_many_challenges',
  'challenge_refused',
  'passkey_not_found',
  'passkey_refused',
  'step_up_refused',
  'rate_limited',
  'invalid_request',
  'not_found',
  'intent_not_found',
  'project_not_found',
  'forbidden',
  'approval_refused',
  'decision_not_allowed',
  'gate_not_supported',
  'gate_input_missing',
  'gate_input_conflict',
  'gate_not_current',
  'scope_not_allowed',
  'plan_refused',
  'g7_use_pr_review',
  'g7_feedback_on_git_host',
  'spec_unclear',
  'review_reason_required',
  'project_not_active',
  'config_invalid',
  'issue_already_linked',
  'escalation_not_found',
  'escalation_not_open',
  'escalation_already_acknowledged',
  'escalation_decision_not_allowed',
  'ai_record_not_found',
  'ai_record_invalid',
  'ai_record_version_conflict',
  'spec_invalid',
  'spec_not_on_default_branch',
  'spec_link_not_allowed',
  'plan_invalid',
  'plan_not_on_default_branch',
  'plan_submit_not_allowed',
  'git_host_unavailable',
  'evaluation_refused',
  'evaluation_conflict',
  'run_not_found',
  'run_not_active',
  'no_active_run',
  'ai_record_missing',
  'evidence_pack_sealed',
  'evidence_pack_not_found',
  'evidence_pack_purged',
  'proposal_not_found',
  'proposal_purged',
  'evidence_hash_mismatch',
  'evidence_missing',
  'evidence_too_large',
  'evidence_unavailable',
  'user_not_found',
  'identity_not_found',
  'token_not_found',
  'agent_not_found',
  'agent_refused',
  'tool_not_found',
  'tool_refused',
  'role_binding_not_found',
  'project_archived',
  'project_has_open_intents',
  'repo_path_overlap',
  'evidence_hold_exists',
  'evidence_hold_not_found',
  'user_not_active',
  'self_action',
  'conflicting_role',
  'last_tenant_admin',
  'already_exists',
  'config_rejected',
  'config_version_conflict',
  'conflict',
  'not_ready',
  'internal',
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

const ERROR_MESSAGE_KEYS: Readonly<Record<ApiErrorCode, MessageKey>> = {
  unauthorized: 'api.error.unauthorized',
  session_ended: 'api.error.session_ended',
  credentials_ambiguous: 'api.error.credentials_ambiguous',
  session_write_not_allowed: 'api.error.session_write_not_allowed',
  dashboard_actions_off: 'api.error.dashboard_actions_off',
  csrf_refused: 'api.error.csrf_refused',
  recent_signin_required: 'api.error.recent_signin_required',
  too_many_passkeys: 'api.error.too_many_passkeys',
  too_many_challenges: 'api.error.too_many_challenges',
  challenge_refused: 'api.error.challenge_refused',
  passkey_not_found: 'api.error.passkey_not_found',
  passkey_refused: 'api.error.passkey_refused',
  step_up_refused: 'api.error.step_up_refused',
  rate_limited: 'api.error.rate_limited',
  invalid_request: 'api.error.invalid_request',
  not_found: 'api.error.not_found',
  intent_not_found: 'api.error.intent_not_found',
  project_not_found: 'api.error.project_not_found',
  forbidden: 'api.error.forbidden',
  approval_refused: 'api.error.approval_refused',
  decision_not_allowed: 'api.error.decision_not_allowed',
  gate_not_supported: 'api.error.gate_not_supported',
  gate_input_missing: 'api.error.gate_input_missing',
  gate_input_conflict: 'api.error.gate_input_conflict',
  gate_not_current: 'api.error.gate_not_current',
  scope_not_allowed: 'api.error.scope_not_allowed',
  plan_refused: 'api.error.plan_refused',
  g7_use_pr_review: 'api.error.g7_use_pr_review',
  g7_feedback_on_git_host: 'api.error.g7_feedback_on_git_host',
  spec_unclear: 'api.error.spec_unclear',
  review_reason_required: 'api.error.review_reason_required',
  project_not_active: 'api.error.project_not_active',
  config_invalid: 'api.error.config_invalid',
  issue_already_linked: 'api.error.issue_already_linked',
  escalation_not_found: 'api.error.escalation_not_found',
  escalation_not_open: 'api.error.escalation_not_open',
  escalation_already_acknowledged: 'api.error.escalation_already_acknowledged',
  escalation_decision_not_allowed: 'api.error.escalation_decision_not_allowed',
  ai_record_not_found: 'api.error.ai_record_not_found',
  ai_record_invalid: 'api.error.ai_record_invalid',
  ai_record_version_conflict: 'api.error.ai_record_version_conflict',
  spec_invalid: 'api.error.spec_invalid',
  spec_not_on_default_branch: 'api.error.spec_not_on_default_branch',
  spec_link_not_allowed: 'api.error.spec_link_not_allowed',
  plan_invalid: 'api.error.plan_invalid',
  plan_not_on_default_branch: 'api.error.plan_not_on_default_branch',
  plan_submit_not_allowed: 'api.error.plan_submit_not_allowed',
  git_host_unavailable: 'api.error.git_host_unavailable',
  evaluation_refused: 'api.error.evaluation_refused',
  evaluation_conflict: 'api.error.evaluation_conflict',
  run_not_found: 'api.error.run_not_found',
  run_not_active: 'api.error.run_not_active',
  no_active_run: 'api.error.no_active_run',
  ai_record_missing: 'api.error.ai_record_missing',
  evidence_pack_sealed: 'api.error.evidence_pack_sealed',
  evidence_pack_not_found: 'api.error.evidence_pack_not_found',
  evidence_pack_purged: 'api.error.evidence_pack_purged',
  proposal_not_found: 'api.error.proposal_not_found',
  proposal_purged: 'api.error.proposal_purged',
  evidence_hash_mismatch: 'api.error.evidence_hash_mismatch',
  evidence_missing: 'api.error.evidence_missing',
  evidence_too_large: 'api.error.evidence_too_large',
  evidence_unavailable: 'api.error.evidence_unavailable',
  user_not_found: 'api.error.user_not_found',
  identity_not_found: 'api.error.identity_not_found',
  token_not_found: 'api.error.token_not_found',
  agent_not_found: 'api.error.agent_not_found',
  agent_refused: 'api.error.agent_refused',
  tool_not_found: 'api.error.tool_not_found',
  tool_refused: 'api.error.tool_refused',
  role_binding_not_found: 'api.error.role_binding_not_found',
  project_archived: 'api.error.project_archived',
  project_has_open_intents: 'api.error.project_has_open_intents',
  repo_path_overlap: 'api.error.repo_path_overlap',
  evidence_hold_exists: 'api.error.evidence_hold_exists',
  evidence_hold_not_found: 'api.error.evidence_hold_not_found',
  user_not_active: 'api.error.user_not_active',
  self_action: 'api.error.self_action',
  conflicting_role: 'api.error.conflicting_role',
  last_tenant_admin: 'api.error.last_tenant_admin',
  already_exists: 'api.error.already_exists',
  config_rejected: 'api.error.config_rejected',
  config_version_conflict: 'api.error.config_version_conflict',
  conflict: 'api.error.conflict',
  not_ready: 'api.error.not_ready',
  internal: 'api.error.internal',
};

export function errorMessageKey(code: ApiErrorCode): MessageKey {
  return ERROR_MESSAGE_KEYS[code];
}

/**
 * One problem in a request: where (`body.title`) and what (a zod issue code, or a configuration
 * message key). Never free text from the request: `message` is catalog text only (B13).
 */
export interface ErrorDetail {
  readonly path: string;
  readonly issue: string;
  readonly message?: string;
}

export class ApiError extends Error {
  override readonly name = 'ApiError';

  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    /** A refusal reason code from the registry or policy engine, for example `role_missing`. */
    readonly reason?: string,
    readonly details?: readonly ErrorDetail[],
    /** Configuration issues (B13 `config_rejected`); the filter renders them in the locale. */
    readonly configIssues?: readonly ConfigIssue[],
    /** Catalog text of `reason`, when it is not a gate refusal reason (B13 agent register). */
    readonly reasonText?: (locale: string) => string,
  ) {
    super(code);
  }
}

const REGISTRY: Readonly<Record<RegistryErrorCode, [number, ApiErrorCode]>> = {
  intent_not_found: [404, 'intent_not_found'],
  project_not_active: [409, 'project_not_active'],
  config_invalid: [409, 'config_invalid'],
  config_hash_mismatch: [409, 'config_invalid'],
  config_defaults_drift: [409, 'config_invalid'],
  decision_not_allowed: [422, 'decision_not_allowed'],
  approval_refused: [403, 'approval_refused'],
  issue_already_linked: [409, 'issue_already_linked'],
};

const COMMAND: Readonly<Record<CommandErrorCode, [number, ApiErrorCode]>> = {
  gate_not_supported: [422, 'gate_not_supported'],
  gate_input_missing: [409, 'gate_input_missing'],
  gate_input_conflict: [409, 'gate_input_conflict'],
  gate_not_current: [409, 'gate_not_current'],
  scope_not_allowed: [422, 'scope_not_allowed'],
  plan_refused: [409, 'plan_refused'],
  g7_use_pr_review: [422, 'g7_use_pr_review'],
  g7_feedback_on_git_host: [422, 'g7_feedback_on_git_host'],
  spec_unclear: [422, 'spec_unclear'],
  review_reason_required: [422, 'review_reason_required'],
  intent_not_found: [404, 'intent_not_found'],
  project_not_found: [404, 'project_not_found'],
  forbidden: [403, 'forbidden'],
};

/** Escalation refusals (B11). `frozen` and packet errors never come from these endpoints. */
const ESCALATION: Readonly<Record<EscalationErrorCode, [number, ApiErrorCode]>> = {
  not_found: [404, 'escalation_not_found'],
  forbidden: [403, 'forbidden'],
  not_open: [409, 'escalation_not_open'],
  already_acknowledged: [409, 'escalation_already_acknowledged'],
  decision_not_allowed: [422, 'escalation_decision_not_allowed'],
  intent_not_open: [409, 'escalation_not_open'],
  invalid_packet: [400, 'invalid_request'],
  response_level_too_low: [422, 'escalation_decision_not_allowed'],
  frozen: [409, 'conflict'],
};

/** Admin refusals (B13, ADR-M37 §2.6). */
const ADMIN: Readonly<Record<AdminErrorCode, [number, ApiErrorCode]>> = {
  forbidden: [403, 'forbidden'],
  project_not_found: [404, 'project_not_found'],
  user_not_found: [404, 'user_not_found'],
  identity_not_found: [404, 'identity_not_found'],
  token_not_found: [404, 'token_not_found'],
  role_binding_not_found: [404, 'role_binding_not_found'],
  project_archived: [409, 'project_archived'],
  project_has_open_intents: [409, 'project_has_open_intents'],
  repo_path_overlap: [409, 'repo_path_overlap'],
  user_not_active: [409, 'user_not_active'],
  self_action: [403, 'self_action'],
  conflicting_role: [409, 'conflicting_role'],
  last_tenant_admin: [409, 'last_tenant_admin'],
  already_exists: [409, 'already_exists'],
  invalid_value: [400, 'invalid_request'],
  config_rejected: [422, 'config_rejected'],
  config_version_conflict: [409, 'config_version_conflict'],
};

const DB: Partial<Readonly<Record<DbErrorCode, [number, ApiErrorCode]>>> = {
  invalid_value: [400, 'invalid_request'],
  conflict: [409, 'conflict'],
  reference_not_found: [400, 'invalid_request'],
};

/**
 * An agent register refusal (B13 AC7): the code is the `reason`, its text names the agent.
 * `not_permitted` and `not_an_approver` are 403; an unknown agent is 404; a bad value 400.
 */
export function agentApiError(error: AgentRegisterError, agentKey: string): ApiError {
  const text = (locale: string) =>
    t(
      AGENT_REGISTER_ERROR_MESSAGES[error.code],
      { ...error.params, key: agentKey, field: error.field ?? '-' },
      locale,
    );
  if (error.code === 'agent_not_found') return new ApiError(404, 'agent_not_found');
  if (error.code === 'invalid_input') {
    const details = [{ path: `body.${error.field ?? 'body'}`, issue: 'invalid' }];
    return new ApiError(400, 'invalid_request', undefined, details);
  }
  const forbidden = error.code === 'not_permitted' || error.code === 'not_an_approver';
  return new ApiError(
    forbidden ? 403 : 409,
    forbidden ? 'forbidden' : 'agent_refused',
    error.code,
    undefined,
    undefined,
    text,
  );
}

/**
 * A tool register refusal (X04, ADR-M69 §2.2): the code is the `reason`, its text names the tool.
 * `not_permitted` and `not_an_approver` are 403; an unknown tool is 404; a bad value 400.
 */
export function toolApiError(error: ToolRegisterError, toolKey: string): ApiError {
  const text = (locale: string) =>
    t(
      TOOL_REGISTER_ERROR_MESSAGES[error.code],
      { key: toolKey, field: error.field ?? '-' },
      locale,
    );
  if (error.code === 'tool_not_found') return new ApiError(404, 'tool_not_found');
  if (error.code === 'invalid_input') {
    const details = [{ path: `body.${error.field ?? 'body'}`, issue: 'invalid' }];
    return new ApiError(400, 'invalid_request', undefined, details);
  }
  const forbidden = error.code === 'not_permitted' || error.code === 'not_an_approver';
  return new ApiError(
    forbidden ? 403 : 409,
    forbidden ? 'forbidden' : 'tool_refused',
    error.code,
    undefined,
    undefined,
    text,
  );
}

/** Spec refusals (B08, ADR-M39 §2.2). The reason is the spec error code, or the unreadable cause. */
const SPEC: Readonly<Record<SpecError['code'], [number, ApiErrorCode]>> = {
  invalid_path: [422, 'spec_invalid'],
  spec_unreadable: [422, 'spec_invalid'],
  not_on_default_branch: [409, 'spec_not_on_default_branch'],
  link_not_allowed: [409, 'spec_link_not_allowed'],
  repository_invalid: [409, 'spec_link_not_allowed'],
  git_host_unavailable: [503, 'git_host_unavailable'],
};

export function specApiError(error: SpecError): ApiError {
  const [status, code] = SPEC[error.code];
  const text = (locale: string) =>
    t(SPEC_ERROR_MESSAGES[error.code], { cause: error.cause_ ?? '-' }, locale);
  return new ApiError(status, code, error.cause_ ?? error.code, undefined, undefined, text);
}

/** Plan refusals (B09, ADR-M40 §2.3). The reason is the refusal (why the file was refused) or the code. */
const PLAN: Readonly<Record<PlanError['code'], [number, ApiErrorCode]>> = {
  plan_invalid: [422, 'plan_invalid'],
  invalid_commit: [422, 'plan_invalid'],
  not_on_default_branch: [409, 'plan_not_on_default_branch'],
  submit_not_allowed: [409, 'plan_submit_not_allowed'],
  repository_invalid: [409, 'plan_submit_not_allowed'],
  git_host_unavailable: [503, 'git_host_unavailable'],
};

export function planApiError(error: PlanError): ApiError {
  const [status, code] = PLAN[error.code];
  const text = (locale: string) => {
    const refusal = error.refusal ? t(PLAN_REFUSAL_MESSAGES[error.refusal], {}, locale) : '-';
    return t(PLAN_ERROR_MESSAGES[error.code], { refusal }, locale);
  };
  // QUESTIONS #210: the field of a text field that is not text, as a detail (a key path only).
  const details =
    error.field === undefined ? undefined : [{ path: `file.${error.field}`, issue: 'not_text' }];
  return new ApiError(status, code, error.refusal ?? error.code, details, undefined, text);
}

/** Kill switch refusals (C11, ADR-M42 §2.6). */
const KILL: Readonly<Record<KillErrorCode, [number, ApiErrorCode]>> = {
  run_not_found: [404, 'run_not_found'],
  forbidden: [403, 'forbidden'],
  run_not_active: [409, 'run_not_active'],
  no_active_run: [409, 'no_active_run'],
};

/**
 * Evidence Pack refusals (E02, ADR-M48 §2.6). A stored file that fails its re-check is a 409:
 * the platform refuses to build or serve a pack it cannot prove.
 */
const EVIDENCE: Readonly<Record<EvidencePackErrorCode, [number, ApiErrorCode]>> = {
  ai_record_missing: [409, 'ai_record_missing'],
  pack_sealed: [409, 'evidence_pack_sealed'],
  pack_not_found: [404, 'evidence_pack_not_found'],
  pack_purged: [410, 'evidence_pack_purged'],
  proposal_not_found: [404, 'proposal_not_found'],
  proposal_purged: [410, 'proposal_purged'],
  evidence_hash_mismatch: [409, 'evidence_hash_mismatch'],
  evidence_missing: [409, 'evidence_missing'],
  evidence_too_large: [409, 'evidence_too_large'],
  evidence_unavailable: [503, 'evidence_unavailable'],
  pack_conflict: [409, 'conflict'],
};

/** Passkey and step-up refusals (U06, ADR-M73 §2.4). */
const PASSKEY: Readonly<Record<PasskeyErrorCode, [number, ApiErrorCode]>> = {
  recent_signin_required: [403, 'recent_signin_required'],
  too_many_passkeys: [409, 'too_many_passkeys'],
  too_many_challenges: [429, 'too_many_challenges'],
  challenge_refused: [409, 'challenge_refused'],
  passkey_not_found: [404, 'passkey_not_found'],
  step_up_refused: [403, 'step_up_refused'],
  invalid_value: [400, 'invalid_request'],
};

/** Maps any thrown value to an `ApiError`. Unknown errors become `internal` (500). */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof CommandError) return new ApiError(...COMMAND[error.code]);
  if (error instanceof KillError) return new ApiError(...KILL[error.code]);
  if (error instanceof PasskeyError) {
    const [status, code] = PASSKEY[error.code];
    const details =
      error.field === undefined ? undefined : [{ path: `body.${error.field}`, issue: 'invalid' }];
    return new ApiError(status, code, undefined, details);
  }
  if (error instanceof EvidencePackError) return new ApiError(...EVIDENCE[error.code]);
  if (error instanceof EvidenceHoldError) {
    return new ApiError(error.code === 'evidence_hold_exists' ? 409 : 404, error.code);
  }
  if (error instanceof SpecError) return specApiError(error);
  if (error instanceof PlanError) return planApiError(error);
  if (error instanceof AgentRegisterError) return agentApiError(error, '-');
  if (error instanceof ToolRegisterError) return toolApiError(error, '-');
  if (error instanceof AdminError) {
    const [status, code] = ADMIN[error.code];
    const details =
      error.extra.field === undefined
        ? undefined
        : [{ path: `body.${error.extra.field}`, issue: 'invalid' }];
    return new ApiError(status, code, error.extra.reason, details, error.extra.issues);
  }
  if (error instanceof EscalationError) return new ApiError(...ESCALATION[error.code]);
  if (error instanceof EvaluationError) return evaluationApiError(error);
  if (error instanceof AiRecordError) {
    if (error.code === 'version_conflict') return new ApiError(409, 'ai_record_version_conflict');
    if (error.code === 'not_a_writer') return new ApiError(403, 'forbidden');
    const details =
      error.field === undefined ? undefined : [{ path: `body.${error.field}`, issue: 'invalid' }];
    return new ApiError(422, 'ai_record_invalid', error.code, details);
  }
  if (error instanceof RegistryError) {
    const [status, code] = REGISTRY[error.code];
    // A person without the gate's role is refused like any other missing permission.
    const refusedStatus = error.reason === 'role_missing' ? 403 : status;
    return new ApiError(refusedStatus, code, error.reason);
  }
  if (error instanceof DbError) {
    const mapped = DB[error.code];
    if (mapped) return new ApiError(...mapped);
  }
  if (error instanceof TenantGuardError) return new ApiError(500, 'internal');
  return new ApiError(500, 'internal');
}

/**
 * Evaluation plans (L05, ADR-M82): the refusal code is the `reason`, with its catalog text
 * (`evaluation.error.<code>`). Not found → 404; another person's change or an open evaluation →
 * 409; anything else the plan or its configurations do not allow → 422.
 */
const EVALUATION_STATUS: Readonly<Partial<Record<EvaluationErrorCode, [number, ApiErrorCode]>>> = {
  project_not_found: [404, 'project_not_found'],
  plan_not_found: [404, 'not_found'],
  forbidden: [403, 'forbidden'],
  git_host_unavailable: [503, 'git_host_unavailable'],
  plan_code_taken: [409, 'evaluation_conflict'],
  plan_changed: [409, 'evaluation_conflict'],
  plan_archived: [409, 'evaluation_conflict'],
  plan_paused: [409, 'evaluation_conflict'],
  evaluation_open: [409, 'evaluation_conflict'],
  monthly_cap_used: [409, 'evaluation_conflict'],
  // L07 (ADR-M85): tasks.
  intent_not_found: [404, 'not_found'],
  card_not_found: [404, 'not_found'],
  producer_cannot_review: [403, 'forbidden'],
  task_id_taken: [409, 'evaluation_conflict'],
  task_gone: [409, 'evaluation_conflict'],
  task_changed: [409, 'evaluation_conflict'],
  task_not_checked: [409, 'evaluation_conflict'],
  task_set_empty: [409, 'evaluation_conflict'],
};

/** The catalog text of each evaluation refusal (`evaluation.error.<code>`). */
const EVALUATION_MESSAGES: Readonly<Record<EvaluationErrorCode, MessageKey>> = {
  project_not_found: 'evaluation.error.project_not_found',
  project_not_active: 'evaluation.error.project_not_active',
  data_class_prohibited: 'evaluation.error.data_class_prohibited',
  ai_record_missing: 'evaluation.error.ai_record_missing',
  data_class_not_allowed: 'evaluation.error.data_class_not_allowed',
  model_not_allowed: 'evaluation.error.model_not_allowed',
  self_hosted_only: 'evaluation.error.self_hosted_only',
  invalid_input: 'evaluation.error.invalid_input',
  forbidden: 'evaluation.error.forbidden',
  plan_not_found: 'evaluation.error.plan_not_found',
  plan_code_taken: 'evaluation.error.plan_code_taken',
  plan_archived: 'evaluation.error.plan_archived',
  plan_paused: 'evaluation.error.plan_paused',
  plan_changed: 'evaluation.error.plan_changed',
  evaluation_open: 'evaluation.error.evaluation_open',
  monthly_cap_used: 'evaluation.error.monthly_cap_used',
  cap_below_spent: 'evaluation.error.cap_below_spent',
  task_set_not_found: 'evaluation.error.task_set_not_found',
  task_not_found: 'evaluation.error.task_not_found',
  agent_not_found: 'evaluation.error.agent_not_found',
  agent_not_active: 'evaluation.error.agent_not_active',
  agent_no_model: 'evaluation.error.agent_no_model',
  prompt_not_found: 'evaluation.error.prompt_not_found',
  git_host_unavailable: 'evaluation.error.git_host_unavailable',
  intent_not_found: 'evaluation.error.intent_not_found',
  intent_not_merged: 'evaluation.error.intent_not_merged',
  spec_missing: 'evaluation.error.spec_missing',
  no_tests: 'evaluation.error.no_tests',
  no_planned_files: 'evaluation.error.no_planned_files',
  base_unclear: 'evaluation.error.base_unclear',
  too_many_files: 'evaluation.error.too_many_files',
  card_not_found: 'evaluation.error.card_not_found',
  card_invalid: 'evaluation.error.card_invalid',
  task_id_taken: 'evaluation.error.task_id_taken',
  task_gone: 'evaluation.error.task_gone',
  task_changed: 'evaluation.error.task_changed',
  task_not_checked: 'evaluation.error.task_not_checked',
  producer_cannot_review: 'evaluation.error.producer_cannot_review',
  task_set_empty: 'evaluation.error.task_set_empty',
  data_class_below_tasks: 'evaluation.error.data_class_below_tasks',
};

function evaluationApiError(error: EvaluationError): ApiError {
  const [status, code] = EVALUATION_STATUS[error.code] ?? [422, 'evaluation_refused'];
  return new ApiError(status, code, error.code, undefined, undefined, (locale) =>
    t(EVALUATION_MESSAGES[error.code], {}, locale),
  );
}
