// Request schemas of the admin endpoints (task B13, ADR-M37 §2.6). Shapes only; the core admin
// services check the values again, so the operator commands follow the same rules.
import { AGENT_KEY_PATTERN, PROJECT_ROLES, TOOL_KEY_PATTERN } from '@sdlc/contracts';
import {
  API_TOKEN_MAX_LIFETIME_DAYS,
  API_TOKEN_NAME_PATTERN,
  EXTERNAL_ID_PATTERN,
  EXTERNAL_LOGIN_PATTERN,
  MAX_CONFIG_YAML_BYTES,
  MAX_EMAIL_LENGTH,
  MAX_NAME_LENGTH,
  PROJECT_SLUG_PATTERN,
} from '@sdlc/core';
import { z } from 'zod';

export const projectSlugSchema = z.string().regex(PROJECT_SLUG_PATTERN);
export const idSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

const name = z.string().min(1).max(MAX_NAME_LENGTH);
const email = z.string().min(3).max(MAX_EMAIL_LENGTH);
const repoFullName = z.string().min(3).max(140);
const branch = z.string().min(1).max(100);
// O06 (ADR-M106 §2.4): the core checks the shape (`checkRepoPath`).
const repoPath = z.string().max(200);

export const createProjectSchema = z.strictObject({
  slug: projectSlugSchema,
  name,
  repo_full_name: repoFullName,
  repo_path: repoPath.optional(),
  default_branch: branch.optional(),
  git_provider: z.enum(['github']).optional(),
});

export const updateProjectSchema = z.strictObject({
  name: name.optional(),
  repo_full_name: repoFullName.optional(),
  repo_path: repoPath.optional(),
  default_branch: branch.optional(),
});

export const createUserSchema = z.strictObject({ email, display_name: name });

export const updateUserSchema = z.strictObject({
  email: email.optional(),
  display_name: name.optional(),
});

/** The account is identified by its numeric ID, given as a string (QUESTIONS #45). */
export const linkIdentitySchema = z.strictObject({
  provider: z.enum(['github']).optional(),
  external_id: z.string().regex(EXTERNAL_ID_PATTERN),
  external_login: z.string().regex(EXTERNAL_LOGIN_PATTERN),
});

export const grantRoleSchema = z.strictObject({
  user_id: idSchema,
  role: z.enum(PROJECT_ROLES),
});

export const grantTenantAdminSchema = z.strictObject({ user_id: idSchema });

export const saveConfigSchema = z.strictObject({
  /** The version read; 0 when the project has no stored configuration. */
  expected_version: z.number().int().min(0),
  config_yaml: z.string().max(MAX_CONFIG_YAML_BYTES),
});

/** `?include_revoked=true` (roles, tenant admins) or `?include_unlinked=true` (identities). */
/** A change with no body; a session's `step_up` is taken out before (U09). */
export const emptyBodySchema = z.strictObject({});

export const historyQuerySchema = z.strictObject({
  include_revoked: z.enum(['true', 'false']).optional(),
  include_unlinked: z.enum(['true', 'false']).optional(),
});

/** A new personal token (B13 AC5): a short name code and an optional lifetime in days. */
export const issueTokenSchema = z.strictObject({
  name: z.string().regex(API_TOKEN_NAME_PATTERN),
  days: z.number().int().min(1).max(API_TOKEN_MAX_LIFETIME_DAYS).optional(),
});

// The agent register (B13 AC7). The core rules (`agents/rules.ts`) check the formats again.
export const agentKeySchema = z.string().regex(AGENT_KEY_PATTERN);
const tools = z.array(z.string().max(64)).max(32);
const environments = z.array(z.enum(['sandbox', 'staging', 'production'])).max(3);
const autonomy = z.enum(['L0', 'L1', 'L2']);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

export const registerAgentSchema = z
  .strictObject({
    key: agentKeySchema,
    version: z.string().max(64),
    owner_id: idSchema,
    model_ref: z.string().max(128).nullable().optional(),
    instructions_ref: z.string().max(300),
    instructions_sha256: sha256,
    allowed_tools: tools.default([]),
    max_autonomy: autonomy,
    approved_environments: environments.default(['sandbox']),
    // X03 (ADR-M68 §7): the register checks the code (`checkAdapter`).
    adapter: z.string().max(32).optional(),
    // O06 (ADR-M31 §2.5 0.6): the repository root's file, pinned too; both or neither.
    root_instructions_ref: z.string().max(300).optional(),
    root_instructions_sha256: sha256.optional(),
  })
  .refine(bothOrNeither, { path: ['root_instructions_sha256'] });

/**
 * The second pinned file: a ref with its hash, or neither. In an update, a `null` ref removes it
 * (and takes no hash).
 */
function bothOrNeither(input: {
  root_instructions_ref?: string | null | undefined;
  root_instructions_sha256?: string | undefined;
}): boolean {
  const ref = input.root_instructions_ref;
  const hash = input.root_instructions_sha256;
  return typeof ref === 'string' ? hash !== undefined : hash === undefined;
}

export const updateAgentSchema = z
  .strictObject({
    version: z.string().max(64),
    model_ref: z.string().max(128).nullable().optional(),
    instructions_ref: z.string().max(300).optional(),
    instructions_sha256: sha256.optional(),
    allowed_tools: tools.optional(),
    max_autonomy: autonomy.optional(),
    approved_environments: environments.optional(),
    adapter: z.string().max(32).optional(),
    root_instructions_ref: z.string().max(300).nullable().optional(),
    root_instructions_sha256: sha256.optional(),
  })
  .refine(bothOrNeither, { path: ['root_instructions_sha256'] });

// The tool register (X04, ADR-M69 §2.2). The core rules (`tools/rules.ts`) check the formats again.
export const toolKeySchema = z.string().regex(TOOL_KEY_PATTERN);
const toolCodes = z.array(z.string().max(80)).max(10);

export const registerToolSchema = z.strictObject({
  key: toolKeySchema,
  version: z.string().max(64),
  owner_id: idSchema,
  transport: z.enum(['http', 'stdio']),
  image_ref: z.string().max(255).nullable().optional(),
  image_digest: z.string().max(80).nullable().optional(),
  permissions: toolCodes.min(1),
  allowed_data_classes: toolCodes,
  backing_services: toolCodes.default([]),
  model_ref: z.string().max(128).nullable().optional(),
});

export const updateToolSchema = z.strictObject({
  version: z.string().max(64),
  transport: z.enum(['http', 'stdio']).optional(),
  image_ref: z.string().max(255).nullable().optional(),
  image_digest: z.string().max(80).nullable().optional(),
  permissions: toolCodes.min(1).optional(),
  allowed_data_classes: toolCodes.optional(),
  backing_services: toolCodes.optional(),
  model_ref: z.string().max(128).nullable().optional(),
});

export const approveToolSchema = z.strictObject({
  purpose: z.enum(['activate', 'retire']),
  as: z.enum(['owner', 'person_a', 'person_b', 'governance']),
  reason_code: z.string().max(64).optional(),
});

/** `GET /v1/admin/agents?overdue=true` (L10): only overdue agents, with their latest evaluation. */
export const listAgentsSchema = z.strictObject({ overdue: z.enum(['true', 'false']).optional() });

export const approveAgentSchema = z.strictObject({
  purpose: z.enum(['activate', 'retire']),
  as: z.enum(['owner', 'person_a', 'person_b', 'governance']),
  reason_code: z.string().max(64).optional(),
  // L09 (ADR-M86 §2.5): the evaluation an activation rests on.
  evaluation_code: z
    .string()
    .regex(/^EVAL-[0-9]{4}-[0-9]{4,9}$/)
    .optional(),
});

export const stopAgentSchema = z.strictObject({ reason_code: z.string().max(64) });
export const changeOwnerSchema = z.strictObject({ owner_id: idSchema });
export const recertifySchema = z.strictObject({
  day: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  // L10 (ADR-M86 §2.6): the evaluation a recertification rests on.
  evaluation_code: z
    .string()
    .regex(/^EVAL-[0-9]{4}-[0-9]{4,9}$/)
    .optional(),
});
