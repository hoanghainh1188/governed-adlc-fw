// Shapes of the values an admin enters (task B13, ADR-M37 §2.3). The API checks them with zod too;
// these checks are the ones that hold for every caller (API and operator commands).
import { isRepoPath } from '@sdlc/contracts';

import { AdminError } from './errors.js';

/** Project slugs: the same shape the API accepts in paths (ADR-M26). */
export const PROJECT_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** `owner/name` on GitHub: owner as a GitHub login, name as a repository name. */
export const REPO_FULL_NAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
/** A branch name without `..`, spaces or control characters (`git check-ref-format`, simplified). */
export const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Numeric Git host account ID (QUESTIONS #45): never a login. */
export const EXTERNAL_ID_PATTERN = /^[1-9][0-9]{0,19}$/;
/** A GitHub login: shown only, never used to match an account. */
export const EXTERNAL_LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
export const MAX_NAME_LENGTH = 200;
export const MAX_EMAIL_LENGTH = 320;

export function checkName(field: string, value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_NAME_LENGTH || /\p{Cc}/u.test(trimmed)) {
    throw invalid(field);
  }
  return trimmed;
}

export function checkEmail(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(trimmed)) throw invalid('email');
  return trimmed;
}

export function checkPattern(field: string, value: string, pattern: RegExp): string {
  if (!pattern.test(value)) throw invalid(field);
  return value;
}

/** A project's folder in its repository (O06, ADR-M106 §2.4): '' or plain segments. */
export function checkRepoPath(value: string): string {
  if (!isRepoPath(value)) throw invalid('repo_path');
  return value;
}

export function checkBranch(value: string): string {
  if (
    !BRANCH_PATTERN.test(value) ||
    value.includes('..') ||
    value.includes('//') ||
    value.endsWith('/') ||
    value.endsWith('.') ||
    value.endsWith('.lock')
  ) {
    throw invalid('default_branch');
  }
  return value;
}

function invalid(field: string): AdminError {
  return new AdminError('invalid_value', `${field} has the wrong shape`, { field });
}
