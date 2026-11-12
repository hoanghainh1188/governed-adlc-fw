// The administration of the stub API (U09, design/ADR-M73 §2.4b): fictional and in memory. Reads
// answer like the API's presenters; writes need a GitHub session, the CSRF layers and a passkey
// step-up bound to the area, the change, the path and the body, as the API's `AdminStepUp` does.
// They apply the rules the screens depend on: no self-grant, no conflicting roles (Person A and
// Person B), the last tenant admin stays, an existing slug, address or account is taken, the
// configuration's version. Nothing here is real data.
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const NOW = () => new Date().toISOString();
const ME = uuid(1);

const refusal = (status, code, extra = {}) => ({
  status,
  body: { error: { code, message: code, ...extra } },
});

function initial() {
  return {
    projects: [
      project(901, 'pilot', 'Pilot', 'harryforge/pilot-order-inventory'),
      project(902, 'shop', 'Shop demo', 'harryforge/shop-demo'),
    ],
    users: [
      user(1, 'Demo Person B', 'person-b@example.invalid'),
      user(2, 'Ann Example', 'ann@example.invalid'),
      user(3, 'Bob Example', 'bob@example.invalid'),
    ],
    roles: [
      role(701, 1, 'pilot', 'person_b'),
      role(702, 1, 'shop', 'person_a'),
      role(703, 2, 'pilot', 'person_a'),
    ],
    identities: [identity(801, 1, '1001', 'demo-person')],
    admins: [
      { id: uuid(601), user_id: ME, role: 'tenant_admin', revoked_at: null, created_at: NOW() },
    ],
    configs: new Map([['shop', { version: 1, yaml: 'oversight:\n  matrix: {}\n' }]]),
  };
}

function project(n, slug, name, repo) {
  return {
    id: uuid(n),
    slug,
    name,
    git_provider: 'github',
    repo_full_name: repo,
    repo_path: '',
    default_branch: 'main',
    status: 'active',
    created_at: NOW(),
  };
}

function user(n, name, email) {
  return { id: uuid(n), display_name: name, email, status: 'active', created_at: NOW() };
}

function role(n, userN, slug, code) {
  const p = slug === 'pilot' ? 901 : 902;
  return {
    id: uuid(n),
    user_id: uuid(userN),
    project: { id: uuid(p), slug },
    role: code,
    revoked_at: null,
    created_at: NOW(),
  };
}

function identity(n, userN, id, login) {
  return {
    id: uuid(n),
    user_id: uuid(userN),
    provider: 'github',
    external_id: id,
    external_login: login,
    unlinked_at: null,
    created_at: NOW(),
  };
}

let state = initial();
let next = 1000;
const newId = () => uuid((next += 1));

const isAdmin = (id) => state.admins.some((a) => a.user_id === id && a.revoked_at === null);
const presentUser = (u) => ({ ...u, tenant_admin: isAdmin(u.id) });
const CONFLICTS = [
  ['person_a', 'person_b'],
  ['person_b', 'second_approver'],
];

function presentConfig(slug) {
  const p = state.projects.find((x) => x.slug === slug);
  const c = state.configs.get(slug) ?? { version: 0, yaml: '' };
  return {
    project: { id: p.id, slug },
    version: c.version,
    config_yaml: c.yaml,
    config_hash: 'a'.repeat(64),
    override_sha256: c.version === 0 ? null : 'b'.repeat(64),
    updated_by: c.version === 0 ? null : ME,
    updated_at: c.version === 0 ? null : NOW(),
    warnings: c.warning ? [{ key: 'config.warning', path: 'access', message: c.warning }] : [],
  };
}

const P = '/v1/admin/projects';
const U = '/v1/admin/users';
const T = '/v1/admin/tenant-admins';
const SLUG = '([a-z0-9][a-z0-9-]{0,62})';
const ID = '([0-9a-f-]{36})';

export function isAdminPath(pathname) {
  return pathname.startsWith('/v1/admin/');
}

/** A read of the administration screens; `undefined` when the path is not one. */
export function adminRead(url) {
  const p = url.pathname;
  if (p === P) return { body: { items: state.projects } };
  if (p === U) return { body: { items: state.users.map(presentUser) } };
  if (p === T) return { body: { items: state.admins } };
  let m = new RegExp(`^${P}/${SLUG}$`).exec(p);
  if (m) {
    const found = state.projects.find((x) => x.slug === m[1]);
    return found ? { body: found } : refusal(404, 'project_not_found');
  }
  m = new RegExp(`^${P}/${SLUG}/roles$`).exec(p);
  if (m) {
    const all = url.searchParams.get('include_revoked') === 'true';
    const items = state.roles.filter((r) => r.project.slug === m[1] && (all || !r.revoked_at));
    return { body: { items } };
  }
  m = new RegExp(`^${P}/${SLUG}/config$`).exec(p);
  if (m) return { body: presentConfig(m[1]) };
  m = new RegExp(`^${U}/${ID}$`).exec(p);
  if (m) {
    const found = state.users.find((u) => u.id === m[1]);
    return found ? { body: presentUser(found) } : refusal(404, 'user_not_found');
  }
  m = new RegExp(`^${U}/${ID}/identities$`).exec(p);
  if (m) {
    const all = url.searchParams.get('include_unlinked') === 'true';
    const items = state.identities.filter((i) => i.user_id === m[1] && (all || !i.unlinked_at));
    return { body: { items } };
  }
  return undefined;
}

/** The area and change of an admin write (QUESTIONS #685), or `undefined`. */
function changeOf(method, p) {
  const routes = [
    ['POST', `^${P}$`, 'admin.project', 'create'],
    ['PATCH', `^${P}/${SLUG}$`, 'admin.project', 'update'],
    ['POST', `^${P}/${SLUG}/roles$`, 'admin.project', 'role_grant'],
    ['DELETE', `^${P}/${SLUG}/roles/${ID}$`, 'admin.project', 'role_revoke'],
    ['PUT', `^${P}/${SLUG}/config$`, 'admin.project', 'config'],
    ['POST', `^${U}$`, 'admin.user', 'create'],
    ['PATCH', `^${U}/${ID}$`, 'admin.user', 'update'],
    ['POST', `^${U}/${ID}/disable$`, 'admin.user', 'disable'],
    ['POST', `^${U}/${ID}/enable$`, 'admin.user', 'enable'],
    ['POST', `^${U}/${ID}/identities$`, 'admin.user', 'identity_link'],
    ['DELETE', `^${U}/${ID}/identities/${ID}$`, 'admin.user', 'identity_unlink'],
    ['DELETE', `^${U}/${ID}/sessions$`, 'admin.user', 'sessions_end'],
    ['POST', `^${T}$`, 'admin.tenant_admin', 'grant'],
    ['DELETE', `^${T}/${ID}$`, 'admin.tenant_admin', 'revoke'],
  ];
  for (const [m, pattern, action, decision] of routes) {
    const match = new RegExp(pattern).exec(p);
    if (m === method && match) return { action, decision, args: match.slice(1) };
  }
  return undefined;
}

/**
 * An admin write. `holds(action, request)` checks the step-up of the body against the request
 * the API hashes: the body without `step_up`, plus `decision` and `target` (the path).
 */
export async function adminWrite(method, url, body, holds) {
  const change = changeOf(method, url.pathname);
  if (!change) return refusal(405, 'method_not_allowed');
  const { step_up: stepUp, ...rest } = body;
  const ok = await holds(stepUp, change.action, {
    ...rest,
    decision: change.decision,
    target: url.pathname,
  });
  if (!ok) return refusal(403, 'step_up_refused');
  return apply(change, rest);
}

function apply({ action, decision, args }, b) {
  const key = `${action} ${decision}`;
  if (key === 'admin.project create') {
    if (state.projects.some((x) => x.slug === b.slug)) return refusal(409, 'already_exists');
    const created = { ...project(0, b.slug, b.name, b.repo_full_name), id: newId() };
    created.repo_path = b.repo_path ?? '';
    created.default_branch = b.default_branch ?? 'main';
    state.projects.push(created);
    return { status: 201, body: created };
  }
  if (key === 'admin.project update') {
    const p = state.projects.find((x) => x.slug === args[0]);
    Object.assign(p, b);
    return { status: 200, body: p };
  }
  if (key === 'admin.project role_grant') {
    if (b.user_id === ME) return refusal(403, 'self_action');
    const held = state.roles.filter(
      (r) => r.user_id === b.user_id && r.project.slug === args[0] && !r.revoked_at,
    );
    if (held.some((r) => r.role === b.role)) return refusal(409, 'already_exists');
    for (const r of held) {
      if (CONFLICTS.some((c) => c.includes(r.role) && c.includes(b.role))) {
        return refusal(409, 'conflicting_role', { reason: r.role });
      }
    }
    const index = state.users.findIndex((u) => u.id === b.user_id) + 1;
    const created = { ...role(0, index, args[0], b.role), id: newId(), user_id: b.user_id };
    state.roles.push(created);
    return { status: 201, body: created };
  }
  if (key === 'admin.project role_revoke') {
    const r = state.roles.find((x) => x.id === args[1] && !x.revoked_at);
    if (!r) return refusal(404, 'role_binding_not_found');
    if (r.user_id === ME) return refusal(403, 'self_action');
    r.revoked_at = NOW();
    return { status: 200, body: r };
  }
  if (key === 'admin.project config') {
    const stored = state.configs.get(args[0]) ?? { version: 0, yaml: '' };
    if (b.expected_version !== stored.version) return refusal(409, 'config_version_conflict');
    if (/^unknown_section:/m.test(b.config_yaml)) {
      return refusal(422, 'config_rejected', {
        details: [
          {
            path: 'body.config_yaml.unknown_section',
            issue: 'config.schema.unknown_key',
            message: 'unknown_section is not a configuration key.',
          },
        ],
      });
    }
    const warning = /conflicting_roles: \[\]/.test(b.config_yaml)
      ? 'access.conflicting_roles is empty: one person may hold Person A and Person B.'
      : undefined;
    state.configs.set(args[0], { version: stored.version + 1, yaml: b.config_yaml, warning });
    return { status: 200, body: presentConfig(args[0]) };
  }
  return userChange(key, args, b);
}

function userChange(key, args, b) {
  const u = state.users.find((x) => x.id === args[0]);
  if (key === 'admin.user create') {
    if (state.users.some((x) => x.email === b.email)) return refusal(409, 'already_exists');
    const created = { ...user(0, b.display_name, b.email), id: newId() };
    state.users.push(created);
    return { status: 201, body: presentUser(created) };
  }
  if (key === 'admin.tenant_admin grant') {
    if (b.user_id === ME) return refusal(403, 'self_action');
    if (isAdmin(b.user_id)) return refusal(409, 'already_exists');
    const created = {
      id: newId(),
      user_id: b.user_id,
      role: 'tenant_admin',
      revoked_at: null,
      created_at: NOW(),
    };
    state.admins.push(created);
    return { status: 201, body: created };
  }
  if (key === 'admin.tenant_admin revoke') {
    const a = state.admins.find((x) => x.id === args[0] && !x.revoked_at);
    if (!a) return refusal(404, 'not_found');
    if (a.user_id === ME) return refusal(403, 'self_action');
    if (state.admins.filter((x) => !x.revoked_at).length === 1) {
      return refusal(409, 'last_tenant_admin');
    }
    a.revoked_at = NOW();
    return { status: 200, body: a };
  }
  if (!u) return refusal(404, 'user_not_found');
  if (key === 'admin.user update') {
    Object.assign(u, b);
    return { status: 200, body: presentUser(u) };
  }
  if (key === 'admin.user disable' || key === 'admin.user enable') {
    if (u.id === ME) return refusal(403, 'self_action');
    u.status = key === 'admin.user disable' ? 'disabled' : 'active';
    return { status: 200, body: presentUser(u) };
  }
  if (key === 'admin.user identity_link') {
    if (state.identities.some((i) => i.external_id === b.external_id && !i.unlinked_at)) {
      return refusal(409, 'already_exists');
    }
    const n = Number(String(next + 1).slice(-3));
    const created = {
      ...identity(n, 0, b.external_id, b.external_login),
      id: newId(),
      user_id: u.id,
    };
    state.identities.push(created);
    return { status: 201, body: created };
  }
  if (key === 'admin.user identity_unlink') {
    const i = state.identities.find((x) => x.id === args[1] && !x.unlinked_at);
    if (!i) return refusal(404, 'identity_not_found');
    i.unlinked_at = NOW();
    return { status: 200, body: i };
  }
  if (key === 'admin.user sessions_end') return { status: 200, body: { ended: 2 } };
  return refusal(405, 'method_not_allowed');
}

/** Back to the first state: each test starts from the same tenant. */
export function resetAdmin() {
  state = initial();
}
