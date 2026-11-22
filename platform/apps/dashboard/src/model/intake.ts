// The words of a refused U08 action (create an intent, link its spec, submit a plan, build an
// Evidence Pack; design/ADR-M73 §2.1). The API's code and reason pick a catalog key, the same
// sentences the API and the CLI use (`spec.error.*`, `plan.error.*`, `api.error.*`); the reason is
// never shown as a template. Keys are written out so a test finds every one. No catalog or API
// import here, so a test runs it without a browser; `intake-text.ts` renders the text.

export type IntakeAction = 'create' | 'spec' | 'plan' | 'pack';

/** The reasons of a refused spec link (core `SpecErrorCode`), with their catalog keys. */
export const SPEC_ERROR_KEYS: Readonly<Record<string, string>> = {
  invalid_path: 'spec.error.invalid_path',
  link_not_allowed: 'spec.error.link_not_allowed',
  not_on_default_branch: 'spec.error.not_on_default_branch',
  repository_invalid: 'spec.error.repository_invalid',
  git_host_unavailable: 'spec.error.git_host_unavailable',
};

/** The reasons of a refused plan submission (core `PlanErrorCode`), with their catalog keys. */
export const PLAN_ERROR_KEYS: Readonly<Record<string, string>> = {
  invalid_commit: 'plan.error.invalid_commit',
  submit_not_allowed: 'plan.error.submit_not_allowed',
  not_on_default_branch: 'plan.error.not_on_default_branch',
  repository_invalid: 'plan.error.repository_invalid',
  git_host_unavailable: 'plan.error.git_host_unavailable',
  uploaded_plan_not_allowed: 'plan.error.uploaded_plan_not_allowed',
  plan_store_unavailable: 'plan.error.plan_store_unavailable',
};

/** Why a plan file was refused (core `PlanRefusal`), inside `plan.error.plan_invalid`. */
export const PLAN_REFUSAL_KEYS: Readonly<Record<string, string>> = {
  missing: 'plan.refusal.missing',
  not_a_file: 'plan.refusal.not_a_file',
  too_large: 'plan.refusal.too_large',
  not_utf8: 'plan.refusal.not_utf8',
  yaml_invalid: 'plan.refusal.yaml_invalid',
  schema_invalid: 'plan.refusal.schema_invalid',
  intent_mismatch: 'plan.refusal.intent_mismatch',
  platform_field: 'plan.refusal.platform_field',
  unknown_tool: 'plan.refusal.unknown_tool',
  invalid_pattern: 'plan.refusal.invalid_pattern',
  pattern_too_broad: 'plan.refusal.pattern_too_broad',
  protected_path: 'plan.refusal.protected_path',
  too_many_paths: 'plan.refusal.too_many_paths',
};

/** A role refusal (`forbidden`), by action: it names the role list that decides. */
export const FORBIDDEN_KEYS: Readonly<Record<IntakeAction, string>> = {
  create: 'dashboard.intake.error.forbidden_create',
  spec: 'dashboard.intake.error.forbidden_spec',
  plan: 'dashboard.intake.error.forbidden_plan',
  pack: 'dashboard.intake.error.forbidden_pack',
};

/** API codes whose own catalog sentence fits every U08 action. */
export const API_ERROR_KEYS: Readonly<Record<string, string>> = {
  intent_not_found: 'api.error.intent_not_found',
  project_not_found: 'api.error.project_not_found',
  ai_record_missing: 'api.error.ai_record_missing',
  evidence_pack_sealed: 'api.error.evidence_pack_sealed',
  evidence_hash_mismatch: 'api.error.evidence_hash_mismatch',
  evidence_missing: 'api.error.evidence_missing',
  evidence_too_large: 'api.error.evidence_too_large',
  evidence_unavailable: 'api.error.evidence_unavailable',
};

/** The catalog key and parameters of a refusal, or null when `actionErrorText` covers it. */
export interface IntakeErrorKey {
  readonly key: string;
  readonly params?: Readonly<Record<string, string>>;
  /** A nested key whose text fills the `refusal` parameter (a plan file's refusal). */
  readonly refusalKey?: string;
}

const CODE = /^[a-z][a-z0-9_]{0,63}$/;

export function intakeErrorKey(
  error: { readonly code: string; readonly reason?: string },
  action: IntakeAction,
): IntakeErrorKey | null {
  const reason = error.reason ?? '';
  if (error.code === 'forbidden') return { key: FORBIDDEN_KEYS[action] };
  if (
    action === 'spec' &&
    error.code.startsWith('spec_') &&
    Object.hasOwn(SPEC_ERROR_KEYS, reason)
  ) {
    return { key: SPEC_ERROR_KEYS[reason]! };
  }
  // An unreadable spec gives its cause as the reason (`missing`, `too_large`, …).
  if (action === 'spec' && error.code === 'spec_invalid') {
    return {
      key: 'spec.error.spec_unreadable',
      params: { cause: CODE.test(reason) ? reason : '-' },
    };
  }
  if (action === 'spec' && error.code === 'git_host_unavailable') {
    return { key: SPEC_ERROR_KEYS.git_host_unavailable! };
  }
  if (action === 'plan' && Object.hasOwn(PLAN_REFUSAL_KEYS, reason)) {
    return { key: 'plan.error.plan_invalid', refusalKey: PLAN_REFUSAL_KEYS[reason]! };
  }
  if (action === 'plan' && Object.hasOwn(PLAN_ERROR_KEYS, reason)) {
    return { key: PLAN_ERROR_KEYS[reason]! };
  }
  if (action === 'plan' && error.code === 'git_host_unavailable') {
    return { key: PLAN_ERROR_KEYS.git_host_unavailable! };
  }
  if (Object.hasOwn(API_ERROR_KEYS, error.code)) return { key: API_ERROR_KEYS[error.code]! };
  return null;
}

/** The CLI command that saves an L1 run's proposal (ADR-M64: never a browser download). */
export function proposalCommand(intent: string, runId: string): string {
  return `adlc evidence proposal ${intent} --run ${runId} --output <file>`;
}

const SHA = /^[0-9a-f]{40}$/;

/** A commit field as the API takes it: empty is none, else 40 lower-case hex characters. */
export function commitField(value: string): { readonly ok: boolean; readonly sha?: string } {
  const trimmed = value.trim().toLowerCase();
  if (trimmed === '') return { ok: true };
  return SHA.test(trimmed) ? { ok: true, sha: trimmed } : { ok: false };
}
