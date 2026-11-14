// Routes live in the URL hash, so the api serves one page and a link can be shared: filters and
// the active screen are in the URL (never the token). Pure: no DOM.

export type Route =
  | { readonly name: 'intents'; readonly query: URLSearchParams }
  | { readonly name: 'intent'; readonly code: string; readonly query: URLSearchParams }
  | { readonly name: 'escalations'; readonly query: URLSearchParams }
  | { readonly name: 'numbers'; readonly query: URLSearchParams }
  | { readonly name: 'audit'; readonly query: URLSearchParams }
  | { readonly name: 'passkeys'; readonly query: URLSearchParams }
  // X08b PR 3 (ADR-M109 §2.5): the lessons of a project, read only.
  | { readonly name: 'lessons'; readonly query: URLSearchParams }
  // L05 (ADR-M82 §2.7): evaluation plans of a project, one plan, its form, one evaluation.
  | { readonly name: 'evaluations'; readonly query: URLSearchParams }
  | { readonly name: 'eval-plan'; readonly id: string; readonly query: URLSearchParams }
  | { readonly name: 'eval-plan-new'; readonly query: URLSearchParams }
  | { readonly name: 'eval-plan-edit'; readonly id: string; readonly query: URLSearchParams }
  | { readonly name: 'evaluation'; readonly code: string; readonly query: URLSearchParams }
  // U09 (ADR-M73 §2.4b): administration: the overview, one project, its configuration, one person.
  | { readonly name: 'admin'; readonly query: URLSearchParams }
  | { readonly name: 'admin-project'; readonly slug: string; readonly query: URLSearchParams }
  | { readonly name: 'admin-config'; readonly slug: string; readonly query: URLSearchParams }
  | { readonly name: 'admin-user'; readonly id: string; readonly query: URLSearchParams }
  // U09 PR 3: the agent register, one agent, the evidence holds of one intent.
  | { readonly name: 'admin-agents'; readonly query: URLSearchParams }
  | { readonly name: 'admin-agent'; readonly key: string; readonly query: URLSearchParams }
  | { readonly name: 'admin-hold'; readonly code: string; readonly query: URLSearchParams };

const INTENT_CODE = /^INT-[0-9]{4}-[0-9]{4,}$/;
const EVAL_CODE = /^EVAL-[0-9]{4}-[0-9]{4,9}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROJECT_SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const AGENT_KEY = /^[a-z][a-z0-9-]{0,62}[a-z0-9]$/;

export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#/, '');
  const [pathPart = '', search = ''] = raw.split('?', 2);
  const query = new URLSearchParams(search);
  const parts = pathPart.split('/').filter((p) => p !== '');
  if (parts[0] === 'intents' && parts[1] !== undefined && INTENT_CODE.test(parts[1])) {
    return { name: 'intent', code: parts[1], query };
  }
  if (parts[0] === 'escalations') return { name: 'escalations', query };
  if (parts[0] === 'numbers') return { name: 'numbers', query };
  if (parts[0] === 'audit') return { name: 'audit', query };
  if (parts[0] === 'passkeys') return { name: 'passkeys', query };
  if (parts[0] === 'lessons') return { name: 'lessons', query };
  if (parts[0] === 'admin') {
    const slug = parts[2];
    if (parts[1] === 'projects' && slug !== undefined && PROJECT_SLUG.test(slug)) {
      return parts[3] === 'config'
        ? { name: 'admin-config', slug, query }
        : { name: 'admin-project', slug, query };
    }
    if (parts[1] === 'users' && parts[2] !== undefined && UUID.test(parts[2])) {
      return { name: 'admin-user', id: parts[2], query };
    }
    if (parts[1] === 'agents') {
      return parts[2] !== undefined && AGENT_KEY.test(parts[2])
        ? { name: 'admin-agent', key: parts[2], query }
        : { name: 'admin-agents', query };
    }
    if (parts[1] === 'holds' && parts[2] !== undefined && INTENT_CODE.test(parts[2])) {
      return { name: 'admin-hold', code: parts[2], query };
    }
    return { name: 'admin', query };
  }
  if (parts[0] === 'evaluations') {
    if (parts[1] === 'plans' && parts[2] === 'new') return { name: 'eval-plan-new', query };
    if (parts[1] === 'plans' && parts[2] !== undefined && UUID.test(parts[2])) {
      return parts[3] === 'edit'
        ? { name: 'eval-plan-edit', id: parts[2], query }
        : { name: 'eval-plan', id: parts[2], query };
    }
    if (parts[1] !== undefined && EVAL_CODE.test(parts[1])) {
      return { name: 'evaluation', code: parts[1], query };
    }
    return { name: 'evaluations', query };
  }
  return { name: 'intents', query };
}

/** The route of one intent; the board when the code is not an intent code. */
export function intentHref(code: string): string {
  return INTENT_CODE.test(code) ? `#/intents/${code}` : '#/intents';
}

export function href(
  path: string,
  query: Readonly<Record<string, string | undefined>> = {},
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value) params.set(key, value);
  const search = params.toString();
  return `#/${path}${search ? `?${search}` : ''}`;
}

/** L05: the route of one plan, its form, or one evaluation; the list for anything else. */
export function planHref(id: string, edit = false): string {
  return UUID.test(id) ? `#/evaluations/plans/${id}${edit ? '/edit' : ''}` : '#/evaluations';
}

export function evaluationHref(code: string): string {
  return EVAL_CODE.test(code) ? `#/evaluations/${code}` : '#/evaluations';
}

/** U09: the route of one project, its configuration, or one person; the overview otherwise. */
export function adminProjectHref(slug: string, config = false): string {
  return PROJECT_SLUG.test(slug) ? `#/admin/projects/${slug}${config ? '/config' : ''}` : '#/admin';
}

export function adminUserHref(id: string): string {
  return UUID.test(id) ? `#/admin/users/${id}` : '#/admin';
}

/** U09 PR 3: the route of one agent, or of the evidence holds of one intent. */
export function adminAgentHref(key: string): string {
  return AGENT_KEY.test(key) ? `#/admin/agents/${key}` : '#/admin/agents';
}

export function adminHoldHref(code: string): string {
  return INTENT_CODE.test(code) ? `#/admin/holds/${code}` : '#/admin';
}
