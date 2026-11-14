// Refusals of the lesson commands (task X08b PR 2, ADR-M109 §2.3–§2.5). Codes only; the API and
// the CLI render them through the message catalog (`lesson.error.<code>`, NFR-08).
import { t, type MessageKey } from '@sdlc/messages';

export const LESSON_ERROR_CODES = [
  /** The intent does not exist or the caller may not read it. */
  'intent_not_found',
  /** No such lesson, or the caller may not read it. */
  'lesson_not_found',
  /** The project does not exist or the caller holds no role on it. */
  'project_not_found',
  /** Only Person A, Person B of the project or a tenant admin. */
  'forbidden',
  /** Before G8, or more than `learning.lesson_window_days` after the intent closed. */
  'window_closed',
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
  /** This comment records a lesson already. */
  'duplicate',
  /** An applied lesson names its change: a link or a follow-up intent. */
  'link_missing',
] as const;
export type LessonErrorCode = (typeof LESSON_ERROR_CODES)[number];

export class LessonError extends Error {
  override readonly name = 'LessonError';

  constructor(
    readonly code: LessonErrorCode,
    message: string,
    /** A Git host error code (`git_host_error`). */
    readonly gitCode?: string,
  ) {
    super(message);
  }
}

export const LESSON_ERROR_MESSAGES = {
  intent_not_found: 'lesson.error.intent_not_found',
  lesson_not_found: 'lesson.error.lesson_not_found',
  project_not_found: 'lesson.error.project_not_found',
  forbidden: 'lesson.error.forbidden',
  window_closed: 'lesson.error.window_closed',
  git_host_unavailable: 'lesson.error.git_host_unavailable',
  git_host_error: 'lesson.error.git_host_error',
  comment_invalid: 'lesson.error.comment_invalid',
  comment_not_found: 'lesson.error.comment_not_found',
  comment_not_on_intent: 'lesson.error.comment_not_on_intent',
  duplicate: 'lesson.error.duplicate',
  link_missing: 'lesson.error.link_missing',
} as const satisfies Record<LessonErrorCode, MessageKey>;

export function lessonErrorMessage(error: LessonError, locale?: string): string {
  return t(LESSON_ERROR_MESSAGES[error.code], { cause: error.gitCode ?? '-' }, locale);
}
