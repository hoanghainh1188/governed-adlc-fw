// Response bodies of the admin endpoints (snake_case). Presenters pick fields explicitly, so a new
// column never leaks into the API by accident (ADR-M26). Never the stored token hash.
import { formatIssue, type ConfigIssue } from '@sdlc/config';
import type {
  ApiToken,
  ChainState,
  IssuedTokenView,
  Project,
  ProjectConfigView,
  RoleBinding,
  TenantRoleBinding,
  User,
  UserIdentity,
} from '@sdlc/core';

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

export function presentProject(project: Project): Record<string, unknown> {
  return {
    id: project.id,
    slug: project.slug,
    name: project.name,
    git_provider: project.git_provider,
    repo_full_name: project.repo_full_name,
    repo_path: project.repo_path,
    default_branch: project.default_branch,
    status: project.status,
    created_at: project.created_at.toISOString(),
  };
}

export function presentUser(user: User, tenantAdmin: boolean): Record<string, unknown> {
  return {
    id: user.id,
    display_name: user.display_name,
    email: user.email,
    status: user.status,
    tenant_admin: tenantAdmin,
    created_at: user.created_at.toISOString(),
  };
}

export function presentIdentity(identity: UserIdentity): Record<string, unknown> {
  return {
    id: identity.id,
    user_id: identity.user_id,
    provider: identity.provider,
    external_id: identity.external_id,
    external_login: identity.external_login,
    unlinked_at: iso(identity.unlinked_at),
    created_at: identity.created_at.toISOString(),
  };
}

export function presentRoleBinding(
  binding: RoleBinding,
  project: Pick<Project, 'id' | 'slug'>,
): Record<string, unknown> {
  return {
    id: binding.id,
    user_id: binding.user_id,
    project: { id: project.id, slug: project.slug },
    role: binding.role,
    revoked_at: iso(binding.revoked_at),
    created_at: binding.created_at.toISOString(),
  };
}

export function presentTenantRole(binding: TenantRoleBinding): Record<string, unknown> {
  return {
    id: binding.id,
    user_id: binding.user_id,
    role: binding.role,
    revoked_at: iso(binding.revoked_at),
    created_at: binding.created_at.toISOString(),
  };
}

/** A configuration issue with its catalog text (never free text from the request). */
export function presentIssue(issue: ConfigIssue, locale: string): Record<string, unknown> {
  return { key: issue.key, path: issue.path, message: formatIssue(issue, locale) };
}

export function presentConfig(view: ProjectConfigView, locale: string): Record<string, unknown> {
  return {
    project: view.project,
    version: view.version,
    config_yaml: view.configYaml,
    config_hash: view.configHash,
    override_sha256: view.overrideSha256,
    updated_by: view.updatedBy,
    updated_at: iso(view.updatedAt),
    warnings: view.warnings.map((warning) => presentIssue(warning, locale)),
  };
}

/** A token's record: never the token or its hash. */
export function presentToken(token: ApiToken): Record<string, unknown> {
  return {
    id: token.id,
    user_id: token.user_id,
    name: token.name,
    expires_at: token.expires_at.toISOString(),
    revoked_at: iso(token.revoked_at),
    last_used_at: iso(token.last_used_at),
    created_at: token.created_at.toISOString(),
  };
}

/** A new token: the only response that holds the raw token (shown once, never stored). */
export function presentIssuedToken(issued: IssuedTokenView): Record<string, unknown> {
  return {
    ...presentToken(issued.record),
    token: issued.token,
    for_other_user: issued.forOtherUser,
  };
}

export function presentChain(tenantId: string, state: ChainState): Record<string, unknown> {
  return {
    tenant_id: tenantId,
    ok: state.broken === undefined,
    checked: state.checked,
    last_seq: state.lastSeq,
    broken: state.broken ? { seq: state.broken.seq, reason: state.broken.reason } : null,
  };
}
