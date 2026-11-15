// Refusals of break-glass (task H08 PR 2, design/ADR-M111). Codes only; the API and the CLI render
// them through the message catalog (`break_glass.error.<code>`, NFR-08).
import { t, type MessageKey } from '@sdlc/messages';

export const BREAK_GLASS_ERROR_CODES = [
  /** The intent does not exist or the caller may not read it. */
  'intent_not_found',
  /** The project does not exist or the caller holds no role on it. */
  'project_not_found',
  /** The intent is finished: nothing to break glass for. */
  'intent_not_open',
  /** `break_glass.enabled` is false for the project. */
  'disabled',
  /** The caller's roles do not allow this action (ADR-M111 §2.4). */
  'forbidden',
  /** The approver requested the grant (rule M21: two different people). */
  'same_person',
  /** The approver produced the intent's change (ADR-M41). */
  'producer',
  /** A scope is not allowed by the project, unknown, missing or named twice. */
  'scope_invalid',
  /** The duration is not a whole number of hours between 1 and `break_glass.max_hours`. */
  'duration_invalid',
  /** The budget amount is missing, not allowed without the `budget` scope, or over the cap. */
  'budget_invalid',
  /** The intent already has a requested or active grant. */
  'already_open',
  /** No requested grant to approve or refuse, or no active grant to revoke. */
  'no_grant',
  /** The request lapsed before the decision. */
  'lapsed',
  /** No grant of the intent ended without a review. */
  'nothing_to_review',
  /** This process has no Git host (dev mode without OpenBao). */
  'git_host_unavailable',
  /** The Git host could not be read; `cause` holds its error code. */
  'git_host_error',
  /** The address is not a comment of the project's repository. */
  'comment_invalid',
  /** The comment does not exist (or the platform may not read it). */
  'comment_not_found',
  /** The comment is on another issue or pull request than the intent's. */
  'comment_not_on_intent',
] as const;
export type BreakGlassErrorCode = (typeof BREAK_GLASS_ERROR_CODES)[number];

export class BreakGlassError extends Error {
  override readonly name = 'BreakGlassError';

  constructor(
    readonly code: BreakGlassErrorCode,
    message: string,
    /** A Git host error code (`git_host_error`). */
    readonly gitCode?: string,
  ) {
    super(message);
  }
}

export const BREAK_GLASS_ERROR_MESSAGES = {
  intent_not_found: 'break_glass.error.intent_not_found',
  project_not_found: 'break_glass.error.project_not_found',
  intent_not_open: 'break_glass.error.intent_not_open',
  disabled: 'break_glass.error.disabled',
  forbidden: 'break_glass.error.forbidden',
  same_person: 'break_glass.error.same_person',
  producer: 'break_glass.error.producer',
  scope_invalid: 'break_glass.error.scope_invalid',
  duration_invalid: 'break_glass.error.duration_invalid',
  budget_invalid: 'break_glass.error.budget_invalid',
  already_open: 'break_glass.error.already_open',
  no_grant: 'break_glass.error.no_grant',
  lapsed: 'break_glass.error.lapsed',
  nothing_to_review: 'break_glass.error.nothing_to_review',
  git_host_unavailable: 'break_glass.error.git_host_unavailable',
  git_host_error: 'break_glass.error.git_host_error',
  comment_invalid: 'break_glass.error.comment_invalid',
  comment_not_found: 'break_glass.error.comment_not_found',
  comment_not_on_intent: 'break_glass.error.comment_not_on_intent',
} as const satisfies Record<BreakGlassErrorCode, MessageKey>;

export function breakGlassErrorMessage(error: BreakGlassError, locale?: string): string {
  return t(BREAK_GLASS_ERROR_MESSAGES[error.code], { cause: error.gitCode ?? '-' }, locale);
}
