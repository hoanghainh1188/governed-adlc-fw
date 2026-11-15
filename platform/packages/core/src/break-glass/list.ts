// Reading break-glass grants (task H08 PR 3a, ADR-M111 §2.9): `adlc break-glass list` (a person:
// the projects they may read) and `adlc ops break-glass list` (the operator: every project).
import { projectAccess } from '../commands/access.js';
import type { BreakGlassGrant, Escalation, Intent, Project } from '../db/schema.js';
import type { TenantScope } from '../db/tenant-scope.js';
import { BreakGlassError } from './errors.js';

export interface BreakGlassListQuery {
  readonly projectSlug?: string;
  /** Only `requested` and `active` grants. */
  readonly open?: boolean;
  /** The person asking; null for an operator on the server. */
  readonly actorId: string | null;
}

export interface BreakGlassListed {
  readonly grant: BreakGlassGrant;
  readonly intent: Intent | undefined;
  readonly project: Project | undefined;
  /** The stand-in incident, once approved. */
  readonly escalation: Escalation | undefined;
}

/** The grants of the projects the caller may read, newest first (at most 500). */
export async function listBreakGlass(
  scope: TenantScope,
  query: BreakGlassListQuery,
): Promise<BreakGlassListed[]> {
  const projects = new Map<string, Project>();
  for (const project of await scope.projects.list()) {
    if (query.projectSlug !== undefined && project.slug !== query.projectSlug) continue;
    if (query.actorId === null || (await projectAccess(scope, project.id, query.actorId)).canRead) {
      projects.set(project.id, project);
    }
  }
  if (query.projectSlug !== undefined && projects.size === 0) {
    throw new BreakGlassError('project_not_found', 'project not found');
  }
  const grants = await scope.breakGlass.listForProjects([...projects.keys()], query.open === true);
  const intents = new Map<string, Intent | undefined>();
  const out: BreakGlassListed[] = [];
  for (const grant of grants) {
    if (!intents.has(grant.intent_id)) {
      intents.set(grant.intent_id, await scope.intents.getById(grant.intent_id));
    }
    out.push({
      grant,
      intent: intents.get(grant.intent_id),
      project: projects.get(grant.project_id),
      escalation: grant.escalation_id
        ? await scope.escalations.getById(grant.escalation_id)
        : undefined,
    });
  }
  return out;
}
