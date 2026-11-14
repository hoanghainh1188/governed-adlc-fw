// The API reads of the dashboard: GET endpoints that already exist for the CLI (ADR-M54 §2.1).
import {
  adminConfigSchema,
  adminIdentityListSchema,
  adminProjectListSchema,
  adminProjectSchema,
  adminRoleListSchema,
  adminTenantRoleListSchema,
  adminUserListSchema,
  adminUserSchema,
  agentDetailSchema,
  agentListSchema,
  aiRecordSchema,
  authConfigSchema,
  chainSchema,
  costReportSchema,
  escalationListSchema,
  evalPlanListSchema,
  evalPlanSchema,
  evaluationListSchema,
  evaluationReportSchema,
  evaluationSchema,
  evidenceFileSchema,
  evidenceHoldListSchema,
  evidenceListSchema,
  gateMetricsSchema,
  intentDetailSchema,
  intentPageSchema,
  meSchema,
  passkeyListSchema,
  recentEvaluationsSchema,
  runListSchema,
  webSessionSchema,
  type EscalationView,
  type IntentView,
} from '@sdlc/api-schemas';

import type { IntentSearch } from '../model/search.js';
import { apiPath, getJson, getPublicJson, segment } from './client.js';

type Signal = { readonly signal?: AbortSignal };

/** At most this many intents on the board (10 pages of the API's maximum, 100). */
export const MAX_BOARD_INTENTS = 1000;

export const readMe = (token?: string, o: Signal = {}) =>
  getJson(apiPath('/v1/me'), meSchema, { ...o, ...(token ? { token } : {}) });

/** U05: is this browser signed in with GitHub? (`GET /v1/me` with the session cookie only.) */
export const readMeWithCookie = (o: Signal = {}) =>
  getJson(apiPath('/v1/me'), meSchema, { ...o, cookie: true });

/** U06: the GitHub session's CSRF token and whether actions are on (`GET /v1/auth/session`). */
export const readWebSession = (o: Signal = {}) =>
  getJson(apiPath('/v1/auth/session'), webSessionSchema, { ...o, cookie: true });

/** U06: the person's own passkeys (active and removed). */
export const readPasskeys = (o: Signal = {}) =>
  getJson(apiPath('/v1/me/passkeys'), passkeyListSchema, o);

/** U05: is GitHub sign-in on? A public read, no credential. */
export const readAuthConfig = (o: Signal = {}) =>
  getPublicJson(apiPath('/v1/auth/config'), authConfigSchema, o);

/** The tenant slug format (`TENANT_SLUG_PATTERN` of the platform). */
export const TENANT_SLUG = /^[a-z][a-z0-9-]{1,62}$/;

/**
 * U05: where the browser goes to sign in with GitHub. A top-level navigation (a `GET` the API
 * answers with a redirect to GitHub), never a `fetch`.
 */
export const gitHubSignInUrl = (tenant: string): string =>
  apiPath('/v1/auth/github/start', { tenant });

/**
 * Every intent the person can read, page by page; `truncated` past the cap. X08a: with the
 * board's search filters (checked by `model/search.ts`), only the matching intents.
 */
export async function readIntents(
  project: string | undefined,
  o: Signal = {},
  search: IntentSearch = {},
): Promise<{ items: IntentView[]; truncated: boolean }> {
  const items: IntentView[] = [];
  let cursor: string | undefined;
  do {
    const page = await getJson(
      apiPath('/v1/intents', { project, ...search, limit: 100, cursor }),
      intentPageSchema,
      o,
    );
    items.push(...page.items);
    cursor = page.next_cursor ?? undefined;
  } while (cursor !== undefined && items.length < MAX_BOARD_INTENTS);
  return { items, truncated: cursor !== undefined };
}

export const readIntent = (code: string, o: Signal = {}) =>
  getJson(apiPath(`/v1/intents/${segment(code)}`), intentDetailSchema, o);

export const readRuns = (code: string, o: Signal = {}) =>
  getJson(apiPath(`/v1/intents/${segment(code)}/runs`), runListSchema, o);

export const readPacks = (code: string, o: Signal = {}) =>
  getJson(apiPath(`/v1/intents/${segment(code)}/evidence-packs`), evidenceListSchema, o);

export const readPackFile = (
  code: string,
  version: number,
  file: 'manifest' | 'markdown',
  o: Signal = {},
) =>
  getJson(
    apiPath(`/v1/intents/${segment(code)}/evidence-packs/${segment(version)}/${file}`),
    evidenceFileSchema,
    o,
  );

/** Open and acknowledged escalations (the API filters one status at a time, at most 100 each). */
export async function readOpenEscalations(
  intent: string | undefined,
  o: Signal = {},
): Promise<{ items: EscalationView[]; truncated: boolean }> {
  const pages = await Promise.all(
    (['open', 'acknowledged'] as const).map((status) =>
      getJson(apiPath('/v1/escalations', { status, intent, limit: 100 }), escalationListSchema, o),
    ),
  );
  return {
    items: pages.flatMap((p) => p.items),
    truncated: pages.some((p) => p.items.length >= 100),
  };
}

export const readCost = (
  query: { project?: string; by?: string; from?: string; to?: string },
  o: Signal = {},
) => getJson(apiPath('/v1/cost/report', query), costReportSchema, o);

export const readGateMetrics = (
  query: { project?: string; from?: string; to?: string },
  o: Signal = {},
) => getJson(apiPath('/v1/metrics/gates', query), gateMetricsSchema, o);

export const readAuditCheck = (o: Signal = {}) =>
  getJson(apiPath('/v1/admin/audit/verify'), chainSchema, o);

/** L05: the evaluation plans of a project, and whether the person may change them. */
export const readEvalPlans = (project: string, o: Signal = {}) =>
  getJson(apiPath(`/v1/projects/${segment(project)}/eval-plans`), evalPlanListSchema, o);

/** L05: one plan with its current version, its versions and its latest evaluations. */
export const readEvalPlan = (id: string, o: Signal = {}) =>
  getJson(apiPath(`/v1/eval-plans/${segment(id)}`), evalPlanSchema, o);

/** L05: the evaluations of a project (newest first). */
export const readEvaluations = (project: string, o: Signal = {}) =>
  getJson(apiPath('/v1/evaluations', { project, limit: 20 }), evaluationListSchema, o);

/** L05: one evaluation with its runs by status and its spend. */
export const readEvaluation = (code: string, o: Signal = {}) =>
  getJson(apiPath(`/v1/evaluations/${segment(code)}`), evaluationSchema, o);

/** L06 (ADR-M83 §2.2): the report of one evaluation, with its recommendations by rules. */
export const readEvaluationReport = (code: string, o: Signal = {}) =>
  getJson(apiPath(`/v1/evaluations/${segment(code)}/report`), evaluationReportSchema, o);

/** L06 (QUESTIONS #482): the evaluations that ended in the last 7 days, in the person's projects. */
export const readRecentEvaluations = (o: Signal = {}) =>
  getJson(apiPath('/v1/evaluations/recent'), recentEvaluationsSchema, o);

// U09 (ADR-M73 §2.4b, MVP1-UI-SCOPE §3.4): the reads of the administration screens, the GET
// endpoints of `adlc admin`. The API decides who may read: tenant admins, and for a project's
// details, roles and configuration anyone with a role on it.

export const readAdminProjects = (o: Signal = {}) =>
  getJson(apiPath('/v1/admin/projects'), adminProjectListSchema, o);

export const readAdminProject = (slug: string, o: Signal = {}) =>
  getJson(apiPath(`/v1/admin/projects/${segment(slug)}`), adminProjectSchema, o);

/** The roles of a project; `history` adds the revoked ones. */
export const readProjectRoles = (slug: string, history: boolean, o: Signal = {}) =>
  getJson(
    apiPath(`/v1/admin/projects/${segment(slug)}/roles`, {
      include_revoked: history ? 'true' : undefined,
    }),
    adminRoleListSchema,
    o,
  );

export const readProjectConfig = (slug: string, o: Signal = {}) =>
  getJson(apiPath(`/v1/admin/projects/${segment(slug)}/config`), adminConfigSchema, o);

export const readAdminUsers = (o: Signal = {}) =>
  getJson(apiPath('/v1/admin/users'), adminUserListSchema, o);

export const readAdminUser = (id: string, o: Signal = {}) =>
  getJson(apiPath(`/v1/admin/users/${segment(id)}`), adminUserSchema, o);

/** A person's GitHub accounts; `history` adds the unlinked ones. */
export const readIdentities = (id: string, history: boolean, o: Signal = {}) =>
  getJson(
    apiPath(`/v1/admin/users/${segment(id)}/identities`, {
      include_unlinked: history ? 'true' : undefined,
    }),
    adminIdentityListSchema,
    o,
  );

export const readTenantAdmins = (o: Signal = {}) =>
  getJson(apiPath('/v1/admin/tenant-admins'), adminTenantRoleListSchema, o);

// U09 PR 3: the agent register, the AI record, evidence holds, a person's passkeys.

export const readAgents = (o: Signal = {}) =>
  getJson(apiPath('/v1/admin/agents'), agentListSchema, o);

/** One agent with its activation and retirement rounds and its latest evaluation. */
export const readAgent = (key: string, o: Signal = {}) =>
  getJson(apiPath(`/v1/admin/agents/${segment(key)}`), agentDetailSchema, o);

/** The project AI record; 404 `ai_record_not_found` when the project has none yet. */
export const readAiRecord = (slug: string, o: Signal = {}) =>
  getJson(apiPath(`/v1/projects/${segment(slug)}/ai-record`), aiRecordSchema, o);

export const readEvidenceHolds = (intent: string, o: Signal = {}) =>
  getJson(apiPath(`/v1/intents/${segment(intent)}/evidence-hold`), evidenceHoldListSchema, o);

/** A person's passkeys, for a tenant admin. */
export const readUserPasskeys = (id: string, o: Signal = {}) =>
  getJson(apiPath(`/v1/admin/users/${segment(id)}/passkeys`), passkeyListSchema, o);
