// Who may do what with break-glass, and the GitHub comment checks (task H08 PR 2, ADR-M111 §2.1,
// §2.4). The roles follow handbook Ch.6 §6.9 and rule M21; they are not configurable.
import {
  GitHostError,
  type GitHostAdapter,
  type ProjectRole,
  type RedactedSecret,
} from '@sdlc/contracts';

import { projectAccess } from '../commands/access.js';
import type { Intent, Project } from '../db/schema.js';
import type { TenantScope } from '../db/tenant-scope.js';
import { INTENT_CODE_PATTERN } from '../registry/intent-code.js';
import { projectRepoRef } from '../workflow/g4-proposal.js';
import { BreakGlassError } from './errors.js';

/** Request, and record the review (ADR-M111 §2.4). */
export const BREAK_GLASS_REQUEST_ROLES: readonly ProjectRole[] = ['person_a', 'person_b'];
/** Approve or refuse: leadership (`governance`) or Person B. */
export const BREAK_GLASS_APPROVE_ROLES: readonly ProjectRole[] = ['governance', 'person_b'];
/** Revoke, besides the operator and the approver of the grant. */
export const BREAK_GLASS_REVOKE_ROLES: readonly ProjectRole[] = ['governance', 'person_b'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface BreakGlassGitHost {
  readonly gitHost: Pick<
    GitHostAdapter,
    'commentIdOf' | 'issueShortLivedToken' | 'getIssueComment' | 'revokeShortLivedToken'
  >;
}

/** The active roles of an active user on the project; none for a disabled or unknown user. */
export async function rolesOn(
  scope: TenantScope,
  projectId: string,
  userId: string,
): Promise<ProjectRole[]> {
  const user = UUID.test(userId) ? await scope.users.getById(userId) : undefined;
  if (!user || user.status !== 'active') return [];
  return (await scope.roleBindings.listForUser(userId))
    .filter((binding) => binding.project_id === projectId)
    .map((binding) => binding.role);
}

export function holdsAny(roles: readonly ProjectRole[], allowed: readonly ProjectRole[]): boolean {
  return roles.some((role) => allowed.includes(role));
}

/** The intent by code or ID, and its project, when the caller may read it; else `intent_not_found`. */
export async function readableIntent(
  scope: TenantScope,
  ref: string,
  userId: string | null,
): Promise<{ intent: Intent; project: Project }> {
  const intent = INTENT_CODE_PATTERN.test(ref.toUpperCase())
    ? await scope.intents.getByCode(ref.toUpperCase())
    : UUID.test(ref)
      ? await scope.intents.getById(ref)
      : undefined;
  const project = intent ? await scope.projects.getById(intent.project_id) : undefined;
  // The operator on the server (`null`) reads every intent of the tenant.
  const readable =
    project !== undefined &&
    (userId === null || (await projectAccess(scope, project.id, userId)).canRead);
  if (!intent || !project || !readable) {
    throw new BreakGlassError('intent_not_found', 'intent not found');
  }
  return { intent, project };
}

/**
 * Checks that `url` names an existing comment on the intent's issue or pull request in the
 * project's repository (as lessons do, QUESTIONS #729). The words stay in the comment.
 */
export async function checkIntentComment(
  deps: BreakGlassGitHost | undefined,
  project: Project,
  intent: Intent,
  url: string,
): Promise<void> {
  if (!deps) throw new BreakGlassError('git_host_unavailable', 'no Git host in this process');
  const ref = projectRepoRef(project);
  const commentId = ref ? deps.gitHost.commentIdOf(ref, url) : null;
  if (!ref || commentId === null) {
    throw new BreakGlassError('comment_invalid', 'not a comment of the project repository');
  }
  let token: RedactedSecret | undefined;
  let issueNumber: number | null;
  try {
    token = (
      await deps.gitHost.issueShortLivedToken(ref, {
        permissions: { issues: 'read', pull_requests: 'read' },
      })
    ).token;
    issueNumber = (await deps.gitHost.getIssueComment(token, ref, commentId)).issueNumber;
  } catch (error) {
    if (error instanceof GitHostError && error.code === 'not_found') {
      throw new BreakGlassError('comment_not_found', 'no such comment');
    }
    if (error instanceof GitHostError) {
      throw new BreakGlassError('git_host_error', 'git host unavailable', error.code);
    }
    throw error;
  } finally {
    if (token) await deps.gitHost.revokeShortLivedToken(token).catch(() => undefined);
  }
  if (issueNumber === null || ![intent.issue_number, intent.pr_number].includes(issueNumber)) {
    throw new BreakGlassError('comment_not_on_intent', 'the comment is not on the intent');
  }
}
