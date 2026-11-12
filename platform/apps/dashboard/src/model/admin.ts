// The administration screens of the dashboard (task U09, design/ADR-M73 §2.1, §2.4b; MVP1-UI-SCOPE
// §3.4): the shapes the page checks before it asks for a passkey, the words of a refusal, and the
// line difference of a project configuration (QUESTIONS #683). The API decides every change: these
// checks only save a passkey prompt for a value the API would refuse anyway. Pure: no DOM, no API.

/** The step-up action codes of the administration areas (QUESTIONS #685). */
export type AdminAction =
  | 'admin.project'
  | 'admin.user'
  | 'admin.tenant_admin'
  | 'admin.agent'
  | 'admin.ai_record'
  | 'admin.evidence_hold'
  | 'admin.passkey';

/** The project roles (codes table §5, `@sdlc/contracts` `PROJECT_ROLES`; a test compares them). */
export const PROJECT_ROLES = [
  'person_a',
  'person_b',
  'second_approver',
  'pm_brse',
  'governance',
  'admin',
  'viewer',
] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];

/** Core's patterns (`admin/validation.ts`); a test compares them. */
export const PROJECT_SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const REPO_FULL_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
export const EXTERNAL_ID = /^[1-9][0-9]{0,19}$/;
export const EXTERNAL_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EMAIL = /^[^\s@]+@[^\s@]+$/;
const MAX_NAME = 200;

/** A checked form: the body to send, or the catalog key of the first wrong field. */
export type Checked<T> = { readonly body: T } | { readonly error: string };

export interface ProjectInput {
  readonly slug: string;
  readonly name: string;
  readonly repo_full_name: string;
  readonly repo_path?: string;
  readonly default_branch?: string;
}

/** A new project: slug, name, `owner/repository`, and an optional folder and branch. */
export function checkProject(form: {
  readonly slug: string;
  readonly name: string;
  readonly repo: string;
  readonly folder: string;
  readonly branch: string;
}): Checked<ProjectInput> {
  const slug = form.slug.trim();
  const name = form.name.trim();
  const repo = form.repo.trim();
  if (!PROJECT_SLUG.test(slug)) return { error: 'dashboard.admin.error.slug' };
  if (name === '' || name.length > MAX_NAME) return { error: 'dashboard.admin.error.name' };
  if (!REPO_FULL_NAME.test(repo)) return { error: 'dashboard.admin.error.repo' };
  const folder = form.folder.trim();
  const branch = form.branch.trim();
  return {
    body: {
      slug,
      name,
      repo_full_name: repo,
      ...(folder === '' ? {} : { repo_path: folder }),
      ...(branch === '' ? {} : { default_branch: branch }),
    },
  };
}

/** The changed fields of a project, or `null` when nothing changed. */
export function projectChanges(
  before: {
    readonly name: string;
    readonly repo_full_name: string;
    readonly repo_path?: string | undefined;
    readonly default_branch: string;
  },
  form: {
    readonly name: string;
    readonly repo: string;
    readonly folder: string;
    readonly branch: string;
  },
): Checked<Readonly<Record<string, string>>> | null {
  const name = form.name.trim();
  const repo = form.repo.trim();
  const folder = form.folder.trim();
  const branch = form.branch.trim();
  if (name === '' || name.length > MAX_NAME) return { error: 'dashboard.admin.error.name' };
  if (!REPO_FULL_NAME.test(repo)) return { error: 'dashboard.admin.error.repo' };
  if (branch === '') return { error: 'dashboard.admin.error.branch' };
  const body: Record<string, string> = {};
  if (name !== before.name) body.name = name;
  if (repo !== before.repo_full_name) body.repo_full_name = repo;
  if (folder !== (before.repo_path ?? '')) body.repo_path = folder;
  if (branch !== before.default_branch) body.default_branch = branch;
  return Object.keys(body).length === 0 ? null : { body };
}

export interface UserInput {
  readonly email: string;
  readonly display_name: string;
}

/** A new person, or a person's new name and address. */
export function checkUser(form: {
  readonly email: string;
  readonly name: string;
}): Checked<UserInput> {
  const email = form.email.trim();
  const name = form.name.trim();
  if (!EMAIL.test(email) || email.length > 320) return { error: 'dashboard.admin.error.email' };
  if (name === '' || name.length > MAX_NAME) return { error: 'dashboard.admin.error.name' };
  return { body: { email, display_name: name } };
}

export interface IdentityInput {
  readonly external_id: string;
  readonly external_login: string;
}

/** A GitHub account: its numeric account ID (never the login alone, R037) and its login. */
export function checkIdentity(form: {
  readonly id: string;
  readonly login: string;
}): Checked<IdentityInput> {
  const id = form.id.trim();
  const login = form.login.trim();
  if (!EXTERNAL_ID.test(id)) return { error: 'dashboard.admin.error.account_id' };
  if (!EXTERNAL_LOGIN.test(login)) return { error: 'dashboard.admin.error.login' };
  return { body: { external_id: id, external_login: login } };
}

/** A role to grant: a person (by ID) and one of the project roles. */
export function checkRole(form: { readonly user: string; readonly role: string }): Checked<{
  readonly user_id: string;
  readonly role: ProjectRole;
}> {
  const user = form.user.trim();
  const role = PROJECT_ROLES.find((r) => r === form.role);
  if (!UUID.test(user)) return { error: 'dashboard.admin.error.user' };
  if (role === undefined) return { error: 'dashboard.admin.error.role' };
  return { body: { user_id: user, role } };
}

/** The API's own sentence of a refused administration change (`api.error.<code>`), by code. */
export const ADMIN_ERROR_CODES = [
  'forbidden',
  'self_action',
  'conflicting_role',
  'last_tenant_admin',
  'already_exists',
  'user_not_active',
  'user_not_found',
  'identity_not_found',
  'role_binding_not_found',
  'project_not_found',
  'project_archived',
  'project_has_open_intents',
  'project_not_active',
  'repo_path_overlap',
  'config_rejected',
  'config_version_conflict',
  'invalid_request',
] as const;

/** The catalog key of a refused administration change, or `null` for the general text. */
export function adminErrorKey(code: string): string | null {
  return (ADMIN_ERROR_CODES as readonly string[]).includes(code) ? `api.error.${code}` : null;
}

/** One line of a difference: kept, removed (only in the stored version) or added (only in the file). */
export interface DiffLine {
  readonly kind: 'same' | 'removed' | 'added';
  readonly text: string;
}

/** Lines of a text; a final line break makes no empty last line. */
function linesOf(text: string): string[] {
  if (text === '') return [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Above this many lines on a side, the difference is not computed (the page says so). */
export const MAX_DIFF_LINES = 4000;
/** At most this many cells in the table of the changed middle part (8 MB). */
const MAX_DIFF_CELLS = 2_000_000;

/**
 * The line difference between the stored configuration and the chosen file (QUESTIONS #683): the
 * longest common subsequence of lines, so every unchanged line shows once. `null` when a side has
 * more than `MAX_DIFF_LINES` lines, or the changed part is too large to compare.
 */
export function lineDiff(before: string, after: string): readonly DiffLine[] | null {
  const a = linesOf(before);
  const b = linesOf(after);
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) return null;
  // Common prefix and suffix first: most uploads change a few lines.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const rows = midA.length + 1;
  const cols = midB.length + 1;
  if (rows * cols > MAX_DIFF_CELLS) return null;
  const lcs = new Uint32Array(rows * cols);
  for (let i = midA.length - 1; i >= 0; i -= 1) {
    for (let j = midB.length - 1; j >= 0; j -= 1) {
      lcs[i * cols + j] =
        midA[i] === midB[j]
          ? lcs[(i + 1) * cols + j + 1]! + 1
          : Math.max(lcs[(i + 1) * cols + j]!, lcs[i * cols + j + 1]!);
    }
  }
  const out: DiffLine[] = a.slice(0, start).map((text) => ({ kind: 'same', text }));
  let i = 0;
  let j = 0;
  while (i < midA.length && j < midB.length) {
    if (midA[i] === midB[j]) {
      out.push({ kind: 'same', text: midA[i]! });
      i += 1;
      j += 1;
    } else if (lcs[(i + 1) * cols + j]! >= lcs[i * cols + j + 1]!) {
      out.push({ kind: 'removed', text: midA[i]! });
      i += 1;
    } else {
      out.push({ kind: 'added', text: midB[j]! });
      j += 1;
    }
  }
  for (; i < midA.length; i += 1) out.push({ kind: 'removed', text: midA[i]! });
  for (; j < midB.length; j += 1) out.push({ kind: 'added', text: midB[j]! });
  for (const text of a.slice(endA)) out.push({ kind: 'same', text });
  return out;
}

/** How many lines a difference removes and adds. */
export function diffCounts(diff: readonly DiffLine[]): {
  readonly removed: number;
  readonly added: number;
} {
  return {
    removed: diff.filter((d) => d.kind === 'removed').length,
    added: diff.filter((d) => d.kind === 'added').length,
  };
}
