// The changes `adlc admin project apply` makes, from the file and the platform's current state
// (task V17 AC3–AC5). Pure: no API call. A `Write` is one call to the same endpoint as the manual
// command; a `Note` is a difference the command shows but never changes (a role the file does not
// list, a changed agent, a role the operator cannot give themselves). The separation-of-duties
// check counts the roles in the file and the roles already held (QUESTIONS #617).
import type { ProjectFilePerson } from '@sdlc/api-schemas';
import {
  ALWAYS_CONFLICTING_ROLES,
  canonicalJson,
  loadProjectConfig,
  readYamlMapping,
} from '@sdlc/config';

import type { CheckedFile, Refusal } from './file.js';
import type { CurrentState } from './state.js';

export interface Diff {
  readonly field: string;
  readonly from: string;
  readonly to: string;
}

export interface GithubAccount {
  readonly id: string;
  readonly login: string;
}

export type Write =
  | { readonly kind: 'project_create'; readonly body: Readonly<Record<string, string>> }
  | {
      readonly kind: 'project_update';
      readonly body: Readonly<Record<string, string>>;
      readonly diffs: readonly Diff[];
    }
  | { readonly kind: 'user_create'; readonly email: string; readonly name: string }
  | {
      readonly kind: 'user_update';
      readonly email: string;
      readonly name: string;
      readonly diffs: readonly Diff[];
    }
  | {
      readonly kind: 'identity_link';
      readonly email: string;
      readonly login: string;
      readonly githubId: string;
    }
  | { readonly kind: 'role_grant'; readonly email: string; readonly role: string }
  | { readonly kind: 'agent_register'; readonly key: string; readonly owner: string }
  | { readonly kind: 'config_set'; readonly expectedVersion: number; readonly yaml: string };

export type Note =
  | { readonly kind: 'role_self'; readonly email: string; readonly role: string }
  | { readonly kind: 'role_extra'; readonly who: string; readonly role: string }
  | { readonly kind: 'agent_differs'; readonly key: string; readonly diffs: readonly Diff[] };

export type PlanResult =
  | { readonly ok: true; readonly writes: readonly Write[]; readonly notes: readonly Note[] }
  | { readonly ok: false; readonly refusals: readonly Refusal[] };

const lower = (value: string): string => value.toLowerCase();

export function planChanges(
  checked: CheckedFile,
  state: CurrentState,
  accounts: ReadonlyMap<string, GithubAccount>,
): PlanResult {
  const refusals = [
    ...checkProjectAndPeople(checked, state, accounts),
    ...checkRoles(checked, state),
  ];
  if (refusals.length > 0) return { ok: false, refusals };
  const { file } = checked;
  const people = file.team.map((person) => personWrites(person, state, accounts));
  const writes: Write[] = [
    ...projectWrites(checked, state),
    ...people.flatMap((p) => p.user),
    ...people.flatMap((p) => p.identity),
    ...people.flatMap((p) => p.roles),
    ...(file.agent && !state.agent
      ? [{ kind: 'agent_register' as const, key: file.agent.key, owner: file.agent.owner }]
      : []),
    ...configWrites(checked, state),
  ];
  const notes: Note[] = [
    ...people.flatMap((p) => p.notes),
    ...extraRoles(checked, state),
    ...agentNotes(checked, state),
  ];
  return { ok: true, writes, notes };
}

function checkProjectAndPeople(
  checked: CheckedFile,
  state: CurrentState,
  accounts: ReadonlyMap<string, GithubAccount>,
): Refusal[] {
  const refusals: Refusal[] = [];
  if (state.project && state.project.status !== 'active') {
    refusals.push({
      key: 'cli.admin.apply.project_not_active',
      params: { project: state.project.slug, status: state.project.status },
    });
  }
  for (const person of checked.file.team) {
    const user = state.users.get(lower(person.email));
    if (!user) continue;
    if (user.status !== 'active') {
      refusals.push({ key: 'cli.admin.apply.user_disabled', params: { email: person.email } });
    }
    const linked = state.identities.get(user.id) ?? [];
    const account = accounts.get(lower(person.email));
    if (account && linked.length > 0 && !linked.some((i) => i.external_id === account.id)) {
      refusals.push({
        key: 'cli.admin.apply.identity_differs',
        params: {
          email: person.email,
          linked: linked.map((i) => i.external_id).join(', '),
          found: account.id,
          login: account.login,
        },
      });
    }
  }
  return refusals;
}

/** The pairs of roles one person never holds together: rule M21 and `access.conflicting_roles`. */
function conflictPairs(checked: CheckedFile, state: CurrentState): readonly (readonly string[])[] {
  const loaded = loadProjectConfig(checked.configYaml ?? state.config?.config_yaml ?? '');
  const pairs = [
    ALWAYS_CONFLICTING_ROLES,
    ...(loaded.ok ? loaded.config.access.conflicting_roles : []),
  ];
  const seen = new Map<string, readonly string[]>();
  for (const pair of pairs) seen.set([...pair].sort().join('+'), pair);
  return [...seen.values()];
}

/** M21: counts the roles of the file and the active bindings already in the database. */
function checkRoles(checked: CheckedFile, state: CurrentState): Refusal[] {
  const pairs = conflictPairs(checked, state);
  const refusals: Refusal[] = [];
  for (const person of checked.file.team) {
    const user = state.users.get(lower(person.email));
    const held = new Set<string>([
      ...person.roles,
      ...state.roles.filter((role) => user && role.user_id === user.id).map((role) => role.role),
    ]);
    for (const pair of pairs) {
      if (pair.every((role) => held.has(role))) {
        refusals.push({
          key: 'cli.admin.apply.conflicting_roles',
          params: {
            email: person.email,
            roles: pair.join(' + '),
            project: checked.file.project.slug,
          },
        });
      }
    }
  }
  return refusals;
}

function projectWrites(checked: CheckedFile, state: CurrentState): Write[] {
  const wanted = checked.file.project;
  const body: Record<string, string> = {
    name: wanted.name,
    repo_full_name: wanted.repository,
    ...(wanted.folder === undefined ? {} : { repo_path: wanted.folder }),
    ...(wanted.default_branch === undefined ? {} : { default_branch: wanted.default_branch }),
  };
  if (!state.project) return [{ kind: 'project_create', body: { slug: wanted.slug, ...body } }];
  const current: Record<string, string> = {
    name: state.project.name,
    repo_full_name: state.project.repo_full_name,
    repo_path: state.project.repo_path ?? '',
    default_branch: state.project.default_branch,
  };
  const diffs = Object.entries(body)
    .filter(([field, value]) => current[field] !== value)
    .map(([field, to]) => ({ field, from: current[field] ?? '-', to }));
  if (diffs.length === 0) return [];
  return [
    {
      kind: 'project_update',
      body: Object.fromEntries(diffs.map((d) => [d.field, d.to])),
      diffs,
    },
  ];
}

interface PersonWrites {
  readonly user: Write[];
  readonly identity: Write[];
  readonly roles: Write[];
  readonly notes: Note[];
}

function personWrites(
  person: ProjectFilePerson,
  state: CurrentState,
  accounts: ReadonlyMap<string, GithubAccount>,
): PersonWrites {
  const user = state.users.get(lower(person.email));
  const account = accounts.get(lower(person.email));
  const result: PersonWrites = { user: [], identity: [], roles: [], notes: [] };
  if (!user) {
    result.user.push({ kind: 'user_create', email: person.email, name: person.name });
  } else if (user.display_name !== person.name) {
    result.user.push({
      kind: 'user_update',
      email: person.email,
      name: person.name,
      diffs: [{ field: 'name', from: user.display_name, to: person.name }],
    });
  }
  const linked = user ? (state.identities.get(user.id) ?? []) : [];
  if (account && linked.length === 0) {
    result.identity.push({
      kind: 'identity_link',
      email: person.email,
      login: account.login,
      githubId: account.id,
    });
  }
  for (const role of person.roles) {
    if (user && state.roles.some((b) => b.user_id === user.id && b.role === role)) continue;
    if (user && user.id === state.me) {
      result.notes.push({ kind: 'role_self', email: person.email, role });
    } else {
      result.roles.push({ kind: 'role_grant', email: person.email, role });
    }
  }
  return result;
}

/** Active bindings the file does not list: shown, never revoked. */
function extraRoles(checked: CheckedFile, state: CurrentState): Note[] {
  const emailOf = new Map([...state.users.values()].map((u) => [u.id, u.email]));
  return state.roles
    .filter((binding) => {
      const email = emailOf.get(binding.user_id);
      const person = checked.file.team.find((p) => email && lower(p.email) === lower(email));
      return !person?.roles.includes(binding.role);
    })
    .map((binding) => ({
      kind: 'role_extra' as const,
      who: emailOf.get(binding.user_id) ?? binding.user_id,
      role: binding.role,
    }));
}

/** A registered agent that differs from the file: shown, never changed (it needs new approvals). */
function agentNotes(checked: CheckedFile, state: CurrentState): Note[] {
  const wanted = checked.file.agent;
  const current = state.agent;
  if (!wanted || !current) return [];
  const ownerEmail =
    [...state.users.values()].find((u) => u.id === current.owner_id)?.email ?? current.owner_id;
  const sorted = (items: readonly string[] | undefined): string | undefined =>
    items === undefined ? undefined : [...items].sort().join(',');
  const pairs: [string, string, string | undefined][] = [
    ['version', current.version, wanted.version],
    ['owner', lower(ownerEmail), lower(wanted.owner)],
    ['model', current.model_ref ?? '-', wanted.model],
    ['instructions', current.instructions_ref, wanted.instructions],
    ['instructions_sha256', current.instructions_sha256, checked.instructionsSha256],
    ['tools', sorted(current.allowed_tools) ?? '', sorted(wanted.tools)],
    ['max_autonomy', current.max_autonomy, wanted.max_autonomy],
    ['environments', sorted(current.approved_environments) ?? '', sorted(wanted.environments)],
    ['adapter', current.adapter ?? '-', wanted.adapter],
  ];
  const diffs = pairs
    .filter(([, from, to]) => to !== undefined && from !== to)
    .map(([field, from, to]) => ({ field, from, to: to ?? '-' }));
  return diffs.length === 0 ? [] : [{ kind: 'agent_differs', key: wanted.key, diffs }];
}

function configWrites(checked: CheckedFile, state: CurrentState): Write[] {
  const yaml = checked.configYaml;
  if (yaml === undefined) return [];
  if (!state.config) return [{ kind: 'config_set', expectedVersion: 0, yaml }];
  const stored = readYamlMapping(state.config.config_yaml);
  const same = stored.ok && canonicalJson(stored.value) === canonicalJson(checked.file.config);
  return same ? [] : [{ kind: 'config_set', expectedVersion: state.config.version, yaml }];
}
