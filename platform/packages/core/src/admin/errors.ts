// Refusals of the admin services (task B13, ADR-M37). Like `CommandError`, they carry a stable
// `code`; the API and the CLI render codes through the message catalog (NFR-08).
import type { ConfigIssue } from '@sdlc/config';

export type AdminErrorCode =
  /** The actor is not a tenant admin (or, for a project's roles and configuration, its admin). */
  | 'forbidden'
  /** Unknown project, or a project the actor cannot see. */
  | 'project_not_found'
  /** Unknown user in the tenant. */
  | 'user_not_found'
  /** No linked identity with this ID for the user. */
  | 'identity_not_found'
  /** No token with this ID for the user (B13 PR 2). */
  | 'token_not_found'
  /** No active role binding with this ID on the project, or no active tenant role with this ID. */
  | 'role_binding_not_found'
  /** The project is archived: no new roles or configuration. */
  | 'project_archived'
  /**
   * The project has open intents: they are finished first (E05, QUESTIONS #237), so the purge of
   * an archived project never meets an intent that could still change.
   */
  | 'project_has_open_intents'
  /**
   * O06 (ADR-M106 §2.4): the project's folder equals, contains or is inside the folder of another
   * active project on the same repository (an empty folder is the whole repository).
   */
  | 'repo_path_overlap'
  /** The user is disabled: no new roles, tokens or identities. */
  | 'user_not_active'
  /** A person tried to grant a role to themselves, or to disable themselves (QUESTIONS #151). */
  | 'self_action'
  /** The grant would give one person both roles of a pair in `access.conflicting_roles`. */
  | 'conflicting_role'
  /** The change would leave the tenant without an active tenant admin. */
  | 'last_tenant_admin'
  /** A unique value is taken: project slug, e-mail address, linked account, active role. */
  | 'already_exists'
  /** A value has the wrong shape; `field` says which. */
  | 'invalid_value'
  /** The configuration breaks the schema or a mandatory rule; `issues` says where. */
  | 'config_rejected'
  /** The configuration changed since `expected_version` was read. */
  | 'config_version_conflict';

export class AdminError extends Error {
  override readonly name = 'AdminError';

  constructor(
    readonly code: AdminErrorCode,
    message: string,
    readonly extra: {
      /** The request field at fault (`invalid_value`), for example `email`. */
      readonly field?: string;
      /** A refusal detail code, for example the conflicting role. */
      readonly reason?: string;
      /** Catalog-keyed configuration issues (`config_rejected`). */
      readonly issues?: readonly ConfigIssue[];
    } = {},
  ) {
    super(message);
  }
}
