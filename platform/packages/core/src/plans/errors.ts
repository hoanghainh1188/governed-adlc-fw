// Refusals of plan submission (task B09, design/ADR-M40 §2.3). Like `SpecError`, they carry a
// stable `code`; the API and the CLI render codes through the message catalog (`plan.error.<code>`
// and, for a refused file, `plan.refusal.<refusal>`).
import type { GitHostErrorCode } from '@sdlc/contracts';
import { t, type MessageKey } from '@sdlc/messages';

import type { PlanRefusal } from './rules.js';

export type PlanErrorCode =
  /** The plan file cannot be read or is not a valid plan (`refusal`). */
  | 'plan_invalid'
  /** The commit is not a 40-hex commit SHA. */
  | 'invalid_commit'
  /** The intent is not in a state that takes a plan (draft, or waiting at G1–G4). */
  | 'submit_not_allowed'
  /** The file at the given commit differs from the file at the head of the default branch. */
  | 'not_on_default_branch'
  /** The project's repository name is not `owner/name`. */
  | 'repository_invalid'
  /** The Git host could not be read (`gitHostCode`); nothing was submitted. */
  | 'git_host_unavailable'
  /** Uploaded plans are not allowed for the intent's risk tier (U10, #559, ADR-M113). */
  | 'uploaded_plan_not_allowed'
  /** The evidence store could not store the uploaded plan; nothing was submitted. */
  | 'plan_store_unavailable';

export class PlanError extends Error {
  override readonly name = 'PlanError';

  constructor(
    readonly code: PlanErrorCode,
    message: string,
    readonly refusal?: PlanRefusal,
    readonly gitHostCode?: GitHostErrorCode,
    /**
     * The field of a refused file, when known (`tasks[2].summary`, QUESTIONS #210): the file's
     * fixed keys and task positions only, never its text.
     */
    readonly field?: string,
  ) {
    super(message);
  }
}

/** Catalog keys of the refusals (NFR-08). Parameters: `path`, `refusal` (a sentence). */
export const PLAN_ERROR_MESSAGES = {
  plan_invalid: 'plan.error.plan_invalid',
  invalid_commit: 'plan.error.invalid_commit',
  submit_not_allowed: 'plan.error.submit_not_allowed',
  not_on_default_branch: 'plan.error.not_on_default_branch',
  repository_invalid: 'plan.error.repository_invalid',
  git_host_unavailable: 'plan.error.git_host_unavailable',
  uploaded_plan_not_allowed: 'plan.error.uploaded_plan_not_allowed',
  plan_store_unavailable: 'plan.error.plan_store_unavailable',
} as const satisfies Record<PlanErrorCode, MessageKey>;

/** Catalog keys of the reasons a plan file is refused. */
export const PLAN_REFUSAL_MESSAGES = {
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
} as const satisfies Record<PlanRefusal, MessageKey>;

export function planErrorMessage(error: PlanError, locale?: string): string {
  const refusal = error.refusal ? t(PLAN_REFUSAL_MESSAGES[error.refusal], {}, locale) : '-';
  return t(PLAN_ERROR_MESSAGES[error.code], { refusal }, locale);
}
