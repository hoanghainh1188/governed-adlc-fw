// The administration changes of the dashboard (task U09, design/ADR-M73 §2.4b, QUESTIONS #685,
// #686), always with a passkey step-up. They load with the administration screens, in a chunk of
// their own. A static test checks that these are the only admin writes and that each is a route
// of the API with its method.
import {
  adminConfigSchema,
  adminIdentitySchema,
  adminProjectSchema,
  adminRoleSchema,
  adminTenantRoleSchema,
  adminUserSchema,
  agentRecertifiedSchema,
  agentRoundSchema,
  agentSchema,
  aiRecordSchema,
  endedSessionsSchema,
  evidenceHoldChangeSchema,
  passkeySchema,
  type AdminConfigView,
  type AdminIdentityView,
  type AdminProjectView,
  type AdminRoleView,
  type AdminTenantRoleView,
  type AdminUserView,
  type AgentRoundView,
  type AgentView,
  type AiRecordView,
  type PasskeyView,
} from '@sdlc/api-schemas';

import type {
  AdminAction,
  IdentityInput,
  ProjectInput,
  ProjectRole,
  UserInput,
} from '../model/admin.js';
import { apiPath, segment, send } from './client.js';

// U09 (ADR-M73 §2.4b, QUESTIONS #685): the administration changes. Each one carries a passkey
// answer bound to its area, its change (`decision`), the path it writes to (`target`) and its
// body; `target` is the same path as the `send` below it (a static test compares them).

/** The passkey answer of one change, for the request the API will hash. */
export type StepUpAnswer = { readonly challenge_id: string; readonly response: unknown };
export type ConfirmChange = (
  action: AdminAction,
  request: Readonly<Record<string, unknown>>,
) => Promise<StepUpAnswer>;

async function signed(
  confirm: ConfirmChange,
  action: AdminAction,
  decision: string,
  target: string,
  body: Readonly<Record<string, unknown>> = {},
): Promise<Record<string, unknown>> {
  return { ...body, step_up: await confirm(action, { ...body, decision, target }) };
}

export async function createProject(
  body: ProjectInput,
  confirm: ConfirmChange,
): Promise<AdminProjectView> {
  const target = '/v1/admin/projects';
  const signedBody = await signed(confirm, 'admin.project', 'create', target, { ...body });
  const answer = await send(apiPath('/v1/admin/projects'), 'POST', adminProjectSchema, signedBody);
  return answer!;
}

export async function updateProject(
  slug: string,
  body: Readonly<Record<string, string>>,
  confirm: ConfirmChange,
): Promise<AdminProjectView> {
  const target = `/v1/admin/projects/${segment(slug)}`;
  const signedBody = await signed(confirm, 'admin.project', 'update', target, body);
  const answer = await send(
    apiPath(`/v1/admin/projects/${segment(slug)}`),
    'PATCH',
    adminProjectSchema,
    signedBody,
  );
  return answer!;
}

export async function grantRole(
  slug: string,
  body: { readonly user_id: string; readonly role: ProjectRole },
  confirm: ConfirmChange,
): Promise<AdminRoleView> {
  const target = `/v1/admin/projects/${segment(slug)}/roles`;
  const signedBody = await signed(confirm, 'admin.project', 'role_grant', target, { ...body });
  const answer = await send(
    apiPath(`/v1/admin/projects/${segment(slug)}/roles`),
    'POST',
    adminRoleSchema,
    signedBody,
  );
  return answer!;
}

export async function revokeRole(
  slug: string,
  id: string,
  confirm: ConfirmChange,
): Promise<AdminRoleView> {
  const target = `/v1/admin/projects/${segment(slug)}/roles/${segment(id)}`;
  const signedBody = await signed(confirm, 'admin.project', 'role_revoke', target);
  const answer = await send(
    apiPath(`/v1/admin/projects/${segment(slug)}/roles/${segment(id)}`),
    'DELETE',
    adminRoleSchema,
    signedBody,
  );
  return answer!;
}

/** Stores a new configuration; `expected_version` is the version the page showed (409 if newer). */
export async function saveConfig(
  slug: string,
  body: { readonly expected_version: number; readonly config_yaml: string },
  confirm: ConfirmChange,
): Promise<AdminConfigView> {
  const target = `/v1/admin/projects/${segment(slug)}/config`;
  const signedBody = await signed(confirm, 'admin.project', 'config', target, { ...body });
  const answer = await send(
    apiPath(`/v1/admin/projects/${segment(slug)}/config`),
    'PUT',
    adminConfigSchema,
    signedBody,
  );
  return answer!;
}

export async function createUser(body: UserInput, confirm: ConfirmChange): Promise<AdminUserView> {
  const target = '/v1/admin/users';
  const signedBody = await signed(confirm, 'admin.user', 'create', target, { ...body });
  const answer = await send(apiPath('/v1/admin/users'), 'POST', adminUserSchema, signedBody);
  return answer!;
}

export async function updateUser(
  id: string,
  body: Readonly<Record<string, string>>,
  confirm: ConfirmChange,
): Promise<AdminUserView> {
  const target = `/v1/admin/users/${segment(id)}`;
  const signedBody = await signed(confirm, 'admin.user', 'update', target, body);
  const answer = await send(
    apiPath(`/v1/admin/users/${segment(id)}`),
    'PATCH',
    adminUserSchema,
    signedBody,
  );
  return answer!;
}

/** Disables a person: their sessions end and their tokens stop working. */
export async function disableUser(id: string, confirm: ConfirmChange): Promise<AdminUserView> {
  const target = `/v1/admin/users/${segment(id)}/disable`;
  const signedBody = await signed(confirm, 'admin.user', 'disable', target);
  const answer = await send(
    apiPath(`/v1/admin/users/${segment(id)}/disable`),
    'POST',
    adminUserSchema,
    signedBody,
  );
  return answer!;
}

export async function enableUser(id: string, confirm: ConfirmChange): Promise<AdminUserView> {
  const target = `/v1/admin/users/${segment(id)}/enable`;
  const signedBody = await signed(confirm, 'admin.user', 'enable', target);
  const answer = await send(
    apiPath(`/v1/admin/users/${segment(id)}/enable`),
    'POST',
    adminUserSchema,
    signedBody,
  );
  return answer!;
}

/** Links a GitHub account by its numeric account ID (R037). */
export async function linkIdentity(
  id: string,
  body: IdentityInput,
  confirm: ConfirmChange,
): Promise<AdminIdentityView> {
  const target = `/v1/admin/users/${segment(id)}/identities`;
  const signedBody = await signed(confirm, 'admin.user', 'identity_link', target, { ...body });
  const answer = await send(
    apiPath(`/v1/admin/users/${segment(id)}/identities`),
    'POST',
    adminIdentitySchema,
    signedBody,
  );
  return answer!;
}

export async function unlinkIdentity(
  id: string,
  identity: string,
  confirm: ConfirmChange,
): Promise<AdminIdentityView> {
  const target = `/v1/admin/users/${segment(id)}/identities/${segment(identity)}`;
  const signedBody = await signed(confirm, 'admin.user', 'identity_unlink', target);
  const answer = await send(
    apiPath(`/v1/admin/users/${segment(id)}/identities/${segment(identity)}`),
    'DELETE',
    adminIdentitySchema,
    signedBody,
  );
  return answer!;
}

/** Signs a person out of the dashboard everywhere (their sessions end). */
export async function endUserSessions(id: string, confirm: ConfirmChange): Promise<number> {
  const target = `/v1/admin/users/${segment(id)}/sessions`;
  const signedBody = await signed(confirm, 'admin.user', 'sessions_end', target);
  const answer = await send(
    apiPath(`/v1/admin/users/${segment(id)}/sessions`),
    'DELETE',
    endedSessionsSchema,
    signedBody,
  );
  return answer!.ended;
}

export async function grantTenantAdmin(
  userId: string,
  confirm: ConfirmChange,
): Promise<AdminTenantRoleView> {
  const target = '/v1/admin/tenant-admins';
  const signedBody = await signed(confirm, 'admin.tenant_admin', 'grant', target, {
    user_id: userId,
  });
  const answer = await send(
    apiPath('/v1/admin/tenant-admins'),
    'POST',
    adminTenantRoleSchema,
    signedBody,
  );
  return answer!;
}

export async function revokeTenantAdmin(
  id: string,
  confirm: ConfirmChange,
): Promise<AdminTenantRoleView> {
  const target = `/v1/admin/tenant-admins/${segment(id)}`;
  const signedBody = await signed(confirm, 'admin.tenant_admin', 'revoke', target);
  const answer = await send(
    apiPath(`/v1/admin/tenant-admins/${segment(id)}`),
    'DELETE',
    adminTenantRoleSchema,
    signedBody,
  );
  return answer!;
}

// U09 PR 3: project archive, the AI record, evidence holds, a person's passkey, the agent register.

/** Archives a project (final): its open intents must be finished first. */
export async function archiveProject(
  slug: string,
  confirm: ConfirmChange,
): Promise<AdminProjectView> {
  const target = `/v1/admin/projects/${segment(slug)}/archive`;
  const signedBody = await signed(confirm, 'admin.project', 'archive', target);
  const answer = await send(
    apiPath(`/v1/admin/projects/${segment(slug)}/archive`),
    'POST',
    adminProjectSchema,
    signedBody,
  );
  return answer!;
}

/** A new version of the project AI record (`expected_version`: the version read; 0 creates it). */
export async function saveAiRecord(
  slug: string,
  body: Readonly<Record<string, unknown>>,
  confirm: ConfirmChange,
): Promise<AiRecordView> {
  const target = `/v1/projects/${segment(slug)}/ai-record`;
  const signedBody = await signed(confirm, 'admin.ai_record', 'save', target, body);
  const answer = await send(
    apiPath(`/v1/projects/${segment(slug)}/ai-record`),
    'PUT',
    aiRecordSchema,
    signedBody,
  );
  return answer!;
}

/** Holds an intent's evidence from the purge, with an optional `https://` link. */
export async function holdEvidence(
  intent: string,
  body: Readonly<Record<string, string>>,
  confirm: ConfirmChange,
): Promise<void> {
  const target = `/v1/intents/${segment(intent)}/evidence-hold`;
  const signedBody = await signed(confirm, 'admin.evidence_hold', 'hold', target, body);
  await send(
    apiPath(`/v1/intents/${segment(intent)}/evidence-hold`),
    'PUT',
    evidenceHoldChangeSchema,
    signedBody,
  );
}

export async function releaseEvidence(intent: string, confirm: ConfirmChange): Promise<void> {
  const target = `/v1/intents/${segment(intent)}/evidence-hold`;
  const signedBody = await signed(confirm, 'admin.evidence_hold', 'release', target);
  await send(
    apiPath(`/v1/intents/${segment(intent)}/evidence-hold`),
    'DELETE',
    evidenceHoldChangeSchema,
    signedBody,
  );
}

/** A tenant admin removes a person's passkey (a lost device). */
export async function revokeUserPasskey(
  user: string,
  id: string,
  confirm: ConfirmChange,
): Promise<PasskeyView> {
  const target = `/v1/admin/users/${segment(user)}/passkeys/${segment(id)}`;
  const signedBody = await signed(confirm, 'admin.passkey', 'revoke', target);
  const answer = await send(
    apiPath(`/v1/admin/users/${segment(user)}/passkeys/${segment(id)}`),
    'DELETE',
    passkeySchema,
    signedBody,
  );
  return answer!;
}

export async function registerAgent(
  body: Readonly<Record<string, unknown>>,
  confirm: ConfirmChange,
): Promise<AgentView> {
  const target = '/v1/admin/agents';
  const signedBody = await signed(confirm, 'admin.agent', 'register', target, body);
  const answer = await send(apiPath('/v1/admin/agents'), 'POST', agentSchema, signedBody);
  return answer!;
}

export async function updateAgent(
  key: string,
  body: Readonly<Record<string, unknown>>,
  confirm: ConfirmChange,
): Promise<AgentView> {
  const target = `/v1/admin/agents/${segment(key)}`;
  const signedBody = await signed(confirm, 'admin.agent', 'update', target, body);
  const answer = await send(
    apiPath(`/v1/admin/agents/${segment(key)}`),
    'PATCH',
    agentSchema,
    signedBody,
  );
  return answer!;
}

/** One approval of an activation or a retirement; the last one changes the status. */
export async function approveAgent(
  key: string,
  body: Readonly<Record<string, string>>,
  confirm: ConfirmChange,
): Promise<AgentRoundView> {
  const target = `/v1/admin/agents/${segment(key)}/approvals`;
  const signedBody = await signed(confirm, 'admin.agent', 'approve', target, body);
  const answer = await send(
    apiPath(`/v1/admin/agents/${segment(key)}/approvals`),
    'POST',
    agentRoundSchema,
    signedBody,
  );
  return answer!;
}

/** Containment: suspend an agent, with a reason code (QUESTIONS #681: a passkey too). */
export async function suspendAgent(
  key: string,
  reason: string,
  confirm: ConfirmChange,
): Promise<AgentView> {
  const target = `/v1/admin/agents/${segment(key)}/suspend`;
  const signedBody = await signed(confirm, 'admin.agent', 'suspend', target, {
    reason_code: reason,
  });
  const answer = await send(
    apiPath(`/v1/admin/agents/${segment(key)}/suspend`),
    'POST',
    agentSchema,
    signedBody,
  );
  return answer!;
}

export async function quarantineAgent(
  key: string,
  reason: string,
  confirm: ConfirmChange,
): Promise<AgentView> {
  const target = `/v1/admin/agents/${segment(key)}/quarantine`;
  const signedBody = await signed(confirm, 'admin.agent', 'quarantine', target, {
    reason_code: reason,
  });
  const answer = await send(
    apiPath(`/v1/admin/agents/${segment(key)}/quarantine`),
    'POST',
    agentSchema,
    signedBody,
  );
  return answer!;
}

export async function changeAgentOwner(
  key: string,
  owner: string,
  confirm: ConfirmChange,
): Promise<AgentView> {
  const target = `/v1/admin/agents/${segment(key)}/owner`;
  const signedBody = await signed(confirm, 'admin.agent', 'owner', target, { owner_id: owner });
  const answer = await send(
    apiPath(`/v1/admin/agents/${segment(key)}/owner`),
    'PUT',
    agentSchema,
    signedBody,
  );
  return answer!;
}

/** Records a recertification; an evaluation code when the project's mode asks for one. */
export async function recertifyAgent(
  key: string,
  body: Readonly<Record<string, string>>,
  confirm: ConfirmChange,
): Promise<AgentView> {
  const target = `/v1/admin/agents/${segment(key)}/recertify`;
  const signedBody = await signed(confirm, 'admin.agent', 'recertify', target, body);
  const answer = await send(
    apiPath(`/v1/admin/agents/${segment(key)}/recertify`),
    'POST',
    agentRecertifiedSchema,
    signedBody,
  );
  return answer!;
}
