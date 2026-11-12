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
  // PR 3: the agent register, the AI record, evidence holds.
  'agent_refused',
  'agent_not_found',
  'ai_record_invalid',
  'ai_record_version_conflict',
  'evidence_hold_exists',
  'evidence_hold_not_found',
  'intent_not_found',
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

// U09 PR 3: the agent register (ADR-M31, ADR-M37 §2.8), the AI record (ADR-M32), evidence holds
// (ADR-M51). The values are `@sdlc/contracts` and core's; a test compares them.

export const AGENT_KEY = /^[a-z][a-z0-9-]{0,62}[a-z0-9]$/;
export const INTENT_CODE = /^INT-[0-9]{4}-[0-9]{4,9}$/;
export const AGENT_AUTONOMY = ['L0', 'L1', 'L2'] as const;
export const AGENT_ENVIRONMENTS = ['sandbox', 'staging', 'production'] as const;
export const AGENT_ADAPTERS = ['openhands', 'opencode'] as const;
/** Who approves an activation or a retirement, in which capacity (ADR-M37 §2.8). */
export const APPROVER_CAPACITIES = ['owner', 'person_a', 'person_b', 'governance'] as const;
/** Why an agent is suspended or quarantined (core `AGENT_STATUS_REASONS`). */
export const AGENT_STATUS_REASONS = [
  'incident',
  'quality',
  'security',
  'no_owner',
  'replaced',
  'unused',
  'provider_end_of_support',
  'other',
] as const;
export const AI_ALLOWED = ['no', 'yes', 'yes_with_conditions'] as const;
export const PROD_LOGS_ALLOWED = ['no', 'yes_masked'] as const;
export const DISCLOSURE_FORMATS = ['client_format', 'standard_note'] as const;
export const DATA_CLASSES = [
  'public',
  'internal',
  'client_confidential',
  'client_restricted',
  'prohibited',
] as const;
const EVAL_CODE = /^EVAL-[0-9]{4}-[0-9]{4,9}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const HTTPS = /^https:\/\/\S+$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A comma or space list of codes: `a, b c` → `['a', 'b', 'c']`. */
export function codeList(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).filter((c) => c !== ''))];
}

export interface AgentForm {
  readonly key: string;
  readonly version: string;
  readonly owner: string;
  readonly model: string;
  readonly instructionsRef: string;
  /** The SHA-256 of the chosen instruction file, computed in the browser; '' when none. */
  readonly instructionsSha256: string;
  readonly tools: string;
  readonly autonomy: string;
  readonly environments: readonly string[];
  readonly adapter: string;
}

/** A new agent (`POST /v1/admin/agents`): the same fields as `adlc admin agent register`. */
export function checkAgent(form: AgentForm): Checked<Readonly<Record<string, unknown>>> {
  if (!AGENT_KEY.test(form.key.trim())) return { error: 'dashboard.admin.error.agent_key' };
  if (form.version.trim() === '') return { error: 'dashboard.admin.error.version' };
  if (!UUID.test(form.owner)) return { error: 'dashboard.admin.error.owner' };
  if (form.instructionsRef.trim() === '') return { error: 'dashboard.admin.error.instructions' };
  if (!SHA256.test(form.instructionsSha256))
    return { error: 'dashboard.admin.error.instructions_file' };
  const autonomy = AGENT_AUTONOMY.find((a) => a === form.autonomy);
  if (autonomy === undefined) return { error: 'dashboard.admin.error.autonomy' };
  if (form.environments.length === 0) return { error: 'dashboard.admin.error.environments' };
  const model = form.model.trim();
  return {
    body: {
      key: form.key.trim(),
      version: form.version.trim(),
      owner_id: form.owner,
      ...(model === '' ? {} : { model_ref: model }),
      instructions_ref: form.instructionsRef.trim(),
      instructions_sha256: form.instructionsSha256,
      allowed_tools: codeList(form.tools),
      max_autonomy: autonomy,
      approved_environments: [...form.environments],
      ...(form.adapter === '' ? {} : { adapter: form.adapter }),
    },
  };
}

/**
 * A new version of an agent (`PATCH`): the version and the fields that changed. A new instruction
 * file needs its ref too. Returns `null` when only the version would change.
 */
export function agentChanges(
  before: {
    readonly model_ref: string | null;
    readonly instructions_ref: string;
    readonly allowed_tools: readonly string[];
    readonly max_autonomy: string;
    readonly approved_environments: readonly string[];
  },
  form: Omit<AgentForm, 'key' | 'owner' | 'adapter'>,
): Checked<Readonly<Record<string, unknown>>> | null {
  if (form.version.trim() === '') return { error: 'dashboard.admin.error.version' };
  if (form.instructionsRef.trim() === '') return { error: 'dashboard.admin.error.instructions' };
  if (form.environments.length === 0) return { error: 'dashboard.admin.error.environments' };
  const body: Record<string, unknown> = {};
  const model = form.model.trim();
  if (model !== (before.model_ref ?? '')) body.model_ref = model === '' ? null : model;
  const ref = form.instructionsRef.trim();
  if (ref !== before.instructions_ref || form.instructionsSha256 !== '') {
    if (!SHA256.test(form.instructionsSha256))
      return { error: 'dashboard.admin.error.instructions_file' };
    body.instructions_ref = ref;
    body.instructions_sha256 = form.instructionsSha256;
  }
  const tools = codeList(form.tools);
  if (tools.join(',') !== before.allowed_tools.join(',')) body.allowed_tools = tools;
  if (form.autonomy !== before.max_autonomy) body.max_autonomy = form.autonomy;
  if (
    [...form.environments].sort().join(',') !== [...before.approved_environments].sort().join(',')
  ) {
    body.approved_environments = [...form.environments];
  }
  if (Object.keys(body).length === 0) return null;
  return { body: { version: form.version.trim(), ...body } };
}

/** An approval of an activation or a retirement, with an optional evaluation code (ADR-M86). */
export function checkApproval(form: {
  readonly purpose: string;
  readonly capacity: string;
  readonly evaluation: string;
}): Checked<Readonly<Record<string, string>>> {
  const capacity = APPROVER_CAPACITIES.find((c) => c === form.capacity);
  if (form.purpose !== 'activate' && form.purpose !== 'retire') {
    return { error: 'dashboard.admin.error.purpose' };
  }
  if (capacity === undefined) return { error: 'dashboard.admin.error.capacity' };
  const evaluation = form.evaluation.trim();
  if (evaluation !== '' && !EVAL_CODE.test(evaluation)) {
    return { error: 'dashboard.admin.error.evaluation' };
  }
  return {
    body: {
      purpose: form.purpose,
      as: capacity,
      ...(evaluation === '' ? {} : { evaluation_code: evaluation }),
    },
  };
}

export interface AiRecordForm {
  readonly aiAllowed: string;
  readonly classes: readonly string[];
  readonly prodLogs: string;
  readonly disclosure: string;
  readonly confirmedAt: string;
  readonly recordRef: string;
}

/** A new version of the project AI record: codes, a date and one `https://` link, no text. */
export function checkAiRecord(
  expectedVersion: number,
  form: AiRecordForm,
): Checked<Readonly<Record<string, unknown>>> {
  const aiAllowed = AI_ALLOWED.find((v) => v === form.aiAllowed);
  const prodLogs = PROD_LOGS_ALLOWED.find((v) => v === form.prodLogs);
  const disclosure = DISCLOSURE_FORMATS.find((v) => v === form.disclosure);
  if (aiAllowed === undefined || prodLogs === undefined || disclosure === undefined) {
    return { error: 'dashboard.admin.error.ai_record' };
  }
  const confirmed = form.confirmedAt.trim();
  if (confirmed !== '' && !DAY.test(confirmed)) return { error: 'dashboard.admin.error.date' };
  const ref = form.recordRef.trim();
  if (ref !== '' && !HTTPS.test(ref)) return { error: 'dashboard.admin.error.link' };
  return {
    body: {
      expected_version: expectedVersion,
      ai_allowed: aiAllowed,
      allowed_data_classes: DATA_CLASSES.filter((c) => form.classes.includes(c)),
      prod_logs_allowed: prodLogs,
      disclosure_format: disclosure,
      confirmed_at: confirmed === '' ? null : confirmed,
      record_ref: ref === '' ? null : ref,
    },
  };
}

/** A hold's optional link: `https://` only, never text (ADR-M51). */
export function checkHoldLink(link: string): Checked<Readonly<Record<string, string>>> {
  const ref = link.trim();
  if (ref === '') return { body: {} };
  return HTTPS.test(ref) && ref.length <= 512
    ? { body: { reason_ref: ref } }
    : { error: 'dashboard.admin.error.link' };
}
