// Projects (task B13 AC2, ADR-M37 §2.3). Tenant admins create, change and archive projects. The
// slug and the Git host never change. Archiving only sets the status: purging the project's
// evidence and client data is E05 (FR-44). O06 (ADR-M106 §2.4): a project may be one folder of a
// repository (`repo_path`); the folders of the active projects of one repository never overlap
// (trigger of migration 0049, `repo_path_overlap`), and a folder changes only while the project
// has no open intent.
import { DbError } from '../db/errors.js';
import type { ProjectUpdate } from '../db/repositories/projects.js';
import type { Project } from '../db/schema.js';
import type { TenantScope } from '../db/tenant-scope.js';
import { assertTenantAdmin, auditActor, type AdminActor } from './actor.js';
import { AdminError } from './errors.js';
import {
  checkBranch,
  checkName,
  checkPattern,
  checkRepoPath,
  PROJECT_SLUG_PATTERN,
  REPO_FULL_NAME_PATTERN,
} from './validation.js';

/** Git hosts a project can use now. GitLab comes with its adapter (D-02 §4.2, MVP+1). */
export const SUPPORTED_GIT_PROVIDERS = ['github'] as const;

export interface NewProject {
  readonly slug: string;
  readonly name: string;
  readonly repoFullName: string;
  /** O06: the project's folder in the repository; '' or absent = the whole repository. */
  readonly repoPath?: string;
  readonly defaultBranch?: string;
  readonly gitProvider?: (typeof SUPPORTED_GIT_PROVIDERS)[number];
}

export async function createProject(
  scope: TenantScope,
  actor: AdminActor,
  input: NewProject,
): Promise<Project> {
  const values = {
    slug: checkPattern('slug', input.slug, PROJECT_SLUG_PATTERN),
    name: checkName('name', input.name),
    repo_full_name: checkPattern('repo_full_name', input.repoFullName, REPO_FULL_NAME_PATTERN),
    repo_path: checkRepoPath(input.repoPath ?? ''),
    default_branch: checkBranch(input.defaultBranch ?? 'main'),
    git_provider: input.gitProvider ?? 'github',
  };
  if (!(SUPPORTED_GIT_PROVIDERS as readonly string[]).includes(values.git_provider)) {
    throw new AdminError('invalid_value', 'unsupported Git host', { field: 'git_provider' });
  }
  return scope.transaction(async (tx) => {
    await assertTenantAdmin(tx, actor);
    const project = await tx.projects.create(values).catch(alreadyExists);
    await tx.audit.append({
      action: 'project.created',
      ...auditActor(actor),
      entityId: project.id,
      payload: { git_provider: project.git_provider },
    });
    return project;
  });
}

export interface ProjectChanges {
  readonly name?: string;
  readonly repoFullName?: string;
  readonly repoPath?: string;
  readonly defaultBranch?: string;
}

export async function updateProject(
  scope: TenantScope,
  actor: AdminActor,
  slug: string,
  changes: ProjectChanges,
): Promise<Project> {
  const update: { -readonly [K in keyof ProjectUpdate]: ProjectUpdate[K] } = {};
  if (changes.name !== undefined) update.name = checkName('name', changes.name);
  if (changes.repoFullName !== undefined) {
    update.repo_full_name = checkPattern(
      'repo_full_name',
      changes.repoFullName,
      REPO_FULL_NAME_PATTERN,
    );
  }
  if (changes.repoPath !== undefined) update.repo_path = checkRepoPath(changes.repoPath);
  if (changes.defaultBranch !== undefined) {
    update.default_branch = checkBranch(changes.defaultBranch);
  }
  if (Object.keys(update).length === 0) {
    throw new AdminError('invalid_value', 'nothing to change', { field: 'body' });
  }
  return scope.transaction(async (tx) => {
    await assertTenantAdmin(tx, actor);
    const project = await activeProject(tx, slug);
    // O06 (ADR-M106 §2.4): a run's folder and pinned files come from the project; a change of the
    // repository or the folder waits until no intent is open.
    const moves =
      (update.repo_path !== undefined && update.repo_path !== project.repo_path) ||
      (update.repo_full_name !== undefined && update.repo_full_name !== project.repo_full_name);
    if (moves && (await tx.intents.hasOpenInProject(project.id))) {
      throw new AdminError('project_has_open_intents', `project ${slug} has open intents`);
    }
    const updated = await tx.projects.update(project.id, update).catch(alreadyExists);
    if (!updated) throw new AdminError('project_not_found', `project ${slug} not found`);
    await tx.audit.append({
      action: 'project.updated',
      ...auditActor(actor),
      entityId: updated.id,
      payload: {},
    });
    return updated;
  });
}

/**
 * Archives an active project. Idempotent refusal: an archived project gives `project_archived`.
 * A project with open intents is refused (`project_has_open_intents`, E05). The retention loop
 * purges its evidence files after the archive grace period (FR-44, ADR-M51); there is no
 * un-archive in the MVP.
 */
export async function archiveProject(
  scope: TenantScope,
  actor: AdminActor,
  slug: string,
): Promise<Project> {
  return scope.transaction(async (tx) => {
    await assertTenantAdmin(tx, actor);
    const project = await activeProject(tx, slug);
    // E05 (QUESTIONS #237): an archive purges the project's evidence after the grace period;
    // its intents are finished (done, rejected, cancelled, blocked) first.
    if (await tx.intents.hasOpenInProject(project.id)) {
      throw new AdminError('project_has_open_intents', `project ${slug} has open intents`);
    }
    const archived = await tx.projects.setStatus(project.id, 'archived');
    if (!archived) throw new AdminError('project_not_found', `project ${slug} not found`);
    await tx.audit.append({
      action: 'project.archived',
      ...auditActor(actor),
      entityId: archived.id,
      payload: {},
    });
    return archived;
  });
}

export async function listProjects(scope: TenantScope, actor: AdminActor): Promise<Project[]> {
  await assertTenantAdmin(scope, actor);
  return scope.projects.list();
}

export async function showProject(
  scope: TenantScope,
  actor: AdminActor,
  slug: string,
): Promise<Project> {
  await assertTenantAdmin(scope, actor);
  const project = await scope.projects.getBySlug(slug);
  if (!project) throw new AdminError('project_not_found', `project ${slug} not found`);
  return project;
}

/** The project by slug; `project_archived` when it is archived. */
export async function activeProject(scope: TenantScope, slug: string): Promise<Project> {
  const project = await scope.projects.getBySlug(slug);
  if (!project) throw new AdminError('project_not_found', `project ${slug} not found`);
  if (project.status !== 'active') throw new AdminError('project_archived', 'project archived');
  return project;
}

/** Maps a unique violation to `already_exists`, an overlapping folder to `repo_path_overlap`. */
export function alreadyExists(error: unknown): never {
  if (error instanceof DbError && error.code === 'conflict') {
    const sqlState = (error.cause as { code?: unknown } | undefined)?.code;
    throw sqlState === 'SDA28'
      ? new AdminError('repo_path_overlap', 'the folder overlaps another project of the repository')
      : new AdminError('already_exists', 'the value is already taken');
  }
  throw error;
}
