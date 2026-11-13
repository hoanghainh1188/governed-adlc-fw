// Approving, revoking and listing a project's agent memory sets (task X13 PR 1, ADR-M74 §2.3,
// §2.4, §2.7, QUESTIONS #571, #572, #575, #715). The API calls these for `adlc memory`.
//
// - Approve: one person with the Person A or Person B role on the project, who did not author a
//   commit that changed `.sdlc/memory/` since the last approved version (FR-11). Authors are
//   compared by numeric account ID (R037). The set approved is the one at the head of the default
//   branch; a given commit must hold the same set (`not_head`). The same set as the latest version
//   that is not revoked records nothing (`recorded: false`).
// - Revoke: Person A, Person B or governance, producers included: revoking only removes what
//   agents see. Never undone.
// - Refusals of an approval are audited (`memory.approval_refused`) in their own transaction.
//
// Never stored: memory text, paths, commit authors. Only hashes, counts, versions and codes.
import {
  GitHostError,
  MEMORY_DIR,
  type GitHostAdapter,
  type MemoryRevocationReason,
  type ProjectRole,
  type RepoRef,
} from '@sdlc/contracts';

import { DbError } from '../db/errors.js';
import type { MemoryVersionRow } from '../db/repositories/memory-versions.js';
import type { Project } from '../db/schema.js';
import type { TenantScope } from '../db/tenant-scope.js';
import { projectRepoRef } from '../workflow/g4-proposal.js';
import { MemoryError, type MemoryErrorCode } from './errors.js';
import { readMemorySet, type MemorySetFacts } from './set.js';

/** Roles that may approve a memory set (ADR-M74 §2.4, QUESTIONS #572). Never `viewer`. */
export const MEMORY_APPROVE_ROLES: readonly ProjectRole[] = ['person_a', 'person_b'];
/** Roles that may revoke a memory version (ADR-M74 §2.7, QUESTIONS #575). */
export const MEMORY_REVOKE_ROLES: readonly ProjectRole[] = ['person_a', 'person_b', 'governance'];
/** Most commits that changed the memory which an approval checks (ADR-M74 §2.3). */
export const MAX_MEMORY_COMMITS = 100;

/** The Git host calls an approval needs. */
export interface MemoryGitHost {
  readonly gitHost: Pick<GitHostAdapter, 'getBranchHead' | 'listFolder' | 'listPathCommits'>;
}

export interface MemoryProjectAccess {
  readonly project: Project;
  readonly roles: readonly ProjectRole[];
}

/** The project by slug and the caller's roles on it; no role → `project_not_found`. */
export async function memoryProject(
  scope: TenantScope,
  projectSlug: string,
  userId: string,
): Promise<MemoryProjectAccess> {
  const project = await scope.projects.getBySlug(projectSlug);
  const roles = project
    ? (await scope.roleBindings.listForUser(userId))
        .filter((binding) => binding.project_id === project.id)
        .map((binding) => binding.role)
    : [];
  if (!project || roles.length === 0) {
    throw new MemoryError('project_not_found', `project ${projectSlug} not found`);
  }
  return { project, roles };
}

function holdsOne(roles: readonly ProjectRole[], allowed: readonly ProjectRole[]): boolean {
  return roles.some((role) => allowed.includes(role));
}

/** The project's memory versions, newest first. Any role on the project may list them. */
export async function listMemoryVersions(
  scope: TenantScope,
  input: { readonly projectSlug: string; readonly actorId: string },
): Promise<{ project: Project; versions: MemoryVersionRow[] }> {
  const { project } = await memoryProject(scope, input.projectSlug, input.actorId);
  return { project, versions: await scope.memoryVersions.list(project.id) };
}

export interface ApproveMemoryInput {
  readonly projectSlug: string;
  /** A commit that holds the same set as the head of the default branch; default the head. */
  readonly commitSha?: string | null;
  readonly actorId: string;
}

export interface ApproveMemoryResult {
  readonly project: Project;
  readonly version: MemoryVersionRow;
  /** False when the set is the latest version already (nothing recorded). */
  readonly recorded: boolean;
  readonly files: number;
  /** Commits since the last version whose author has no Git host account (counted, as at G7). */
  readonly commitsWithoutAccount: number;
}

/** Approves the memory set at the head of the project's default branch (ADR-M74 §2.3). */
export async function approveMemory(
  scope: TenantScope,
  deps: MemoryGitHost,
  input: ApproveMemoryInput,
): Promise<ApproveMemoryResult> {
  const { project, roles } = await memoryProject(scope, input.projectSlug, input.actorId);
  const user = await scope.users.getById(input.actorId);
  if (user?.status !== 'active' || !holdsOne(roles, MEMORY_APPROVE_ROLES)) {
    throw new MemoryError('forbidden', 'the caller may not approve memory');
  }
  const refuse = (cause: MemoryErrorCode & ('producer' | 'too_many_commits' | 'no_git_identity')) =>
    refuseApproval(scope, project, input.actorId, cause);
  // Every account the person ever linked: an unlinked one still authored its commits.
  const accounts = new Set(
    (await scope.userIdentities.listForUser(input.actorId, { includeUnlinked: true }))
      .filter((identity) => identity.provider === project.git_provider)
      .map((identity) => identity.external_id),
  );
  if (accounts.size === 0) return refuse('no_git_identity');
  const ref = projectRepoRef(project);
  if (!ref) throw new MemoryError('repository_invalid', 'repository name invalid');

  const latest = await scope.memoryVersions.latest(project.id);
  const { head, set } = await readHead(deps, ref, project.default_branch, input.commitSha ?? null);
  if (latest && latest.revoked_at === null && latest.set_sha256 === set.setSha256) {
    return {
      project,
      version: latest,
      recorded: false,
      files: set.files,
      commitsWithoutAccount: 0,
    };
  }
  const changes = await gitRead(() =>
    deps.gitHost.listPathCommits(ref, head, MEMORY_DIR, {
      stopAt: latest?.commit_sha,
      max: MAX_MEMORY_COMMITS,
    }),
  );
  if (!changes.complete) return refuse('too_many_commits');
  if (changes.commits.some((c) => c.author !== null && accounts.has(c.author.id))) {
    return refuse('producer');
  }
  // The newest commit that changed the memory holds the set; with none since the last version,
  // that version's commit does (the same set, approved again after a revocation).
  const commitSha = changes.commits[0]?.sha ?? latest?.commit_sha ?? head;
  const version = await recordCliVersion(scope, input, project.id, latest, {
    setSha256: set.setSha256,
    commitSha,
  });
  return {
    project,
    version: { ...version, revoked_at: null, revoked_by: null, revocation_reason: null },
    recorded: true,
    files: set.files,
    commitsWithoutAccount: changes.commits.filter((c) => c.author === null).length,
  };
}

/** Records the next version in one transaction, after the role and the latest version again. */
async function recordCliVersion(
  scope: TenantScope,
  input: ApproveMemoryInput,
  projectId: string,
  latest: MemoryVersionRow | undefined,
  set: { readonly setSha256: string; readonly commitSha: string },
) {
  return scope
    .transaction(async (tx) => {
      // The role may have been withdrawn while the Git host was read.
      const again = await memoryProject(tx, input.projectSlug, input.actorId);
      if (!holdsOne(again.roles, MEMORY_APPROVE_ROLES)) {
        throw new MemoryError('forbidden', 'the caller may not approve memory');
      }
      const newest = await tx.memoryVersions.latest(projectId);
      if (newest?.version !== latest?.version) {
        throw new MemoryError('conflict', 'a memory version was recorded meanwhile');
      }
      const row = await tx.memoryVersions.record({
        project_id: projectId,
        version: (latest?.version ?? 0) + 1,
        set_sha256: set.setSha256,
        commit_sha: set.commitSha,
        source: 'cli',
        approved_by: input.actorId,
      });
      await tx.audit.append({
        action: 'memory.approved',
        actorType: 'human',
        actorId: input.actorId,
        entityId: projectId,
        payload: { version: row.version, set_sha256: row.set_sha256, source: 'cli' },
      });
      return row;
    })
    .catch(conflictToMemoryError);
}

/** The head of the default branch and its memory set; a given commit must hold the same set. */
async function readHead(
  deps: MemoryGitHost,
  ref: RepoRef,
  branch: string,
  commit: string | null,
): Promise<{ head: string; set: MemorySetFacts }> {
  return gitRead(async () => {
    const head = await deps.gitHost.getBranchHead(ref, branch);
    const set = await readMemorySet(deps.gitHost, ref, head);
    if (commit !== null && commit !== head) {
      const atCommit = await readMemorySet(deps.gitHost, ref, commit);
      if (atCommit.setSha256 !== set.setSha256) {
        throw new MemoryError('not_head', 'the commit holds another memory set than the head');
      }
    }
    return { head, set };
  });
}

/** Runs Git host reads; a Git host error becomes `git_host_error` with its code. */
async function gitRead<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof GitHostError) {
      throw new MemoryError('git_host_error', 'git host unavailable', error.code);
    }
    throw error;
  }
}

/** Audits a refused approval in its own transaction, then throws the refusal. */
async function refuseApproval(
  scope: TenantScope,
  project: Project,
  actorId: string,
  cause: 'producer' | 'too_many_commits' | 'no_git_identity',
): Promise<never> {
  await scope.transaction((tx) =>
    tx.audit.append({
      action: 'memory.approval_refused',
      actorType: 'human',
      actorId,
      entityId: project.id,
      payload: { cause, source: 'cli' },
    }),
  );
  throw new MemoryError(cause, `memory approval refused: ${cause}`);
}

export interface RevokeMemoryInput {
  readonly projectSlug: string;
  readonly version: number;
  readonly reason: MemoryRevocationReason;
  readonly actorId: string;
}

/** Revokes a memory version at once: runs never read that set again (ADR-M74 §2.7). */
export async function revokeMemory(
  scope: TenantScope,
  input: RevokeMemoryInput,
): Promise<{ project: Project; version: MemoryVersionRow }> {
  return scope.transaction(async (tx) => {
    const { project, roles } = await memoryProject(tx, input.projectSlug, input.actorId);
    const user = await tx.users.getById(input.actorId);
    if (user?.status !== 'active' || !holdsOne(roles, MEMORY_REVOKE_ROLES)) {
      throw new MemoryError('forbidden', 'the caller may not revoke memory');
    }
    const version = await tx.memoryVersions.get(project.id, input.version);
    if (!version) throw new MemoryError('version_not_found', 'no such memory version');
    if (version.revoked_at !== null) throw new MemoryError('already_revoked', 'revoked already');
    const revocation = await tx.memoryVersions
      .revoke({
        project_id: project.id,
        version: input.version,
        revoked_by: input.actorId,
        reason: input.reason,
      })
      .catch((error: unknown) => {
        throw error instanceof DbError && error.code === 'conflict'
          ? new MemoryError('already_revoked', 'revoked already')
          : error;
      });
    await tx.audit.append({
      action: 'memory.revoked',
      actorType: 'human',
      actorId: input.actorId,
      entityId: project.id,
      payload: { version: input.version, reason: input.reason },
    });
    return {
      project,
      version: {
        ...version,
        revoked_at: revocation.created_at,
        revoked_by: revocation.revoked_by,
        revocation_reason: revocation.reason,
      },
    };
  });
}

function conflictToMemoryError(error: unknown): never {
  if (error instanceof DbError && error.code === 'conflict') {
    throw new MemoryError('conflict', 'a memory version was recorded meanwhile');
  }
  throw error;
}
