// Refusals of the agent memory commands (task X13, ADR-M74 §2.3, §2.7). Codes only; the API and
// the CLI render them through the message catalog (`memory.error.<code>`, NFR-08).
import { t, type MessageKey } from '@sdlc/messages';

export const MEMORY_ERROR_CODES = [
  /** The project does not exist or the caller holds no role on it. */
  'project_not_found',
  /** The caller's role may not do this (approve: Person A or B; revoke: also governance). */
  'forbidden',
  /** This process has no Git host (dev mode without OpenBao). */
  'git_host_unavailable',
  /** The Git host could not be read; `cause` holds its error code. */
  'git_host_error',
  /** The project's repository name is not `owner/name`. */
  'repository_invalid',
  /** `--commit` holds another memory set than the head of the default branch. */
  'not_head',
  /** The caller authored a commit that changed the memory since the last version (FR-11). */
  'producer',
  /** More commits changed the memory since the last version than the platform checks. */
  'too_many_commits',
  /** The caller has no linked Git host account, so authorship cannot be checked. */
  'no_git_identity',
  /** No such version of the project. */
  'version_not_found',
  /** The version is revoked already; a revocation is never undone. */
  'already_revoked',
  /** Someone recorded a version or a revocation at the same time; try again. */
  'conflict',
] as const;
export type MemoryErrorCode = (typeof MEMORY_ERROR_CODES)[number];

export class MemoryError extends Error {
  override readonly name = 'MemoryError';

  constructor(
    readonly code: MemoryErrorCode,
    message: string,
    /** A Git host error code (`git_host_error`). */
    readonly gitCode?: string,
  ) {
    super(message);
  }
}

/** Catalog keys of the refusals. Parameter: `cause` (`git_host_error`). */
export const MEMORY_ERROR_MESSAGES = {
  project_not_found: 'memory.error.project_not_found',
  forbidden: 'memory.error.forbidden',
  git_host_unavailable: 'memory.error.git_host_unavailable',
  git_host_error: 'memory.error.git_host_error',
  repository_invalid: 'memory.error.repository_invalid',
  not_head: 'memory.error.not_head',
  producer: 'memory.error.producer',
  too_many_commits: 'memory.error.too_many_commits',
  no_git_identity: 'memory.error.no_git_identity',
  version_not_found: 'memory.error.version_not_found',
  already_revoked: 'memory.error.already_revoked',
  conflict: 'memory.error.conflict',
} as const satisfies Record<MemoryErrorCode, MessageKey>;

export function memoryErrorMessage(error: MemoryError, locale?: string): string {
  return t(MEMORY_ERROR_MESSAGES[error.code], { cause: error.gitCode ?? '-' }, locale);
}
