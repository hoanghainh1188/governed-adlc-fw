// One project's administration (task U09, design/ADR-M37 §2.2–§2.3, ADR-M73 §2.4b, MVP1-UI-SCOPE
// §3.4 W10, W11): its details, its roles and a link to its configuration. Tenant admins change the
// details; a tenant admin or the project's `admin` grants and revokes roles. The API refuses a
// self-grant and a role that conflicts with one the person holds (Person A = Person B, M21); the
// page shows its words and has no rule set of its own.
import type { AdminProjectView, AdminRoleView, AdminUserView, Me } from '@sdlc/api-schemas';
import { useState } from 'preact/hooks';

import { readAdminProject, readAdminUsers, readProjectRoles } from '../api/reads.js';
import { useApi } from '../api/use-api.js';
import { grantRole, revokeRole, updateProject } from '../api/admin-writes.js';
import { ChangeDialog, TextField } from '../components/ChangeDialog.js';
import { Empty, Show, Txt, When } from '../components/common.js';
import { t } from '../i18n.js';
import { checkRole, PROJECT_ROLES, projectChanges } from '../model/admin.js';
import { adminProjectHref, adminUserHref, href } from '../router.js';
import { session } from '../session.js';
import { ChangesNote } from './Admin.js';
import { confirmAdminChange } from './admin-step-up.js';

interface Loaded {
  readonly project: AdminProjectView;
  readonly roles: readonly AdminRoleView[];
  /** The tenant's people, for a tenant admin; `null` for a project admin (the API refuses). */
  readonly users: readonly AdminUserView[] | null;
}

export function AdminProject({ slug, me }: { readonly slug: string; readonly me: Me }) {
  const [history, setHistory] = useState(false);
  const { result, reload } = useApi(
    async (signal): Promise<Loaded> => {
      const [project, roles] = await Promise.all([
        readAdminProject(slug, { signal }),
        readProjectRoles(slug, history, { signal }),
      ]);
      const users = me.tenant_admin === true ? (await readAdminUsers({ signal })).items : null;
      return { project, roles: roles.items, users };
    },
    [slug, history],
  );
  return (
    <section class="screen" aria-labelledby="admin-project-title">
      <p class="crumbs">
        <a href={href('admin')}>{t('dashboard.admin.title')}</a>
      </p>
      <Show loaded={result}>
        {(data) => (
          <>
            <div class="screen-head">
              <div>
                <p class="eyebrow">{t('dashboard.admin.project.eyebrow')}</p>
                <h1 id="admin-project-title" class="code">
                  {data.project.slug}
                </h1>
              </div>
              <a class="button button-quiet" href={adminProjectHref(slug, true)}>
                {t('dashboard.admin.config.open')}
              </a>
            </div>
            <ChangesNote />
            <Details project={data.project} canEdit={me.tenant_admin === true} onDone={reload} />
            <Roles
              slug={slug}
              data={data}
              history={history}
              onHistory={setHistory}
              onDone={reload}
            />
          </>
        )}
      </Show>
    </section>
  );
}

function Details({
  project,
  canEdit,
  onDone,
}: {
  readonly project: AdminProjectView;
  readonly canEdit: boolean;
  readonly onDone: () => void;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <section class="admin-section" aria-labelledby="project-details">
      <div class="section-head">
        <h2 id="project-details">{t('dashboard.admin.project.details')}</h2>
        {canEdit && session.actions() && project.status === 'active' && (
          <button type="button" class="button button-quiet" onClick={() => setEditing(true)}>
            {t('dashboard.admin.project.edit')}
          </button>
        )}
      </div>
      <dl class="admin-facts">
        <dt>{t('dashboard.admin.field.name')}</dt>
        <dd>
          <Txt value={project.name} />
        </dd>
        <dt>{t('dashboard.admin.field.repo')}</dt>
        <dd class="code">
          <Txt value={project.repo_full_name} />
        </dd>
        <dt>{t('dashboard.admin.field.folder')}</dt>
        <dd class="code">
          {project.repo_path ? <Txt value={project.repo_path} /> : t('dashboard.admin.whole_repo')}
        </dd>
        <dt>{t('dashboard.admin.field.branch')}</dt>
        <dd class="code">
          <Txt value={project.default_branch} />
        </dd>
        <dt>{t('dashboard.admin.col.status')}</dt>
        <dd>
          <Txt value={project.status} />
        </dd>
      </dl>
      {editing && (
        <EditProject
          project={project}
          onClose={() => setEditing(false)}
          onDone={() => {
            setEditing(false);
            onDone();
          }}
        />
      )}
    </section>
  );
}

function EditProject({
  project,
  onClose,
  onDone,
}: {
  readonly project: AdminProjectView;
  readonly onClose: () => void;
  readonly onDone: () => void;
}) {
  const [name, setName] = useState(project.name);
  const [repo, setRepo] = useState(project.repo_full_name);
  const [folder, setFolder] = useState(project.repo_path ?? '');
  const [branch, setBranch] = useState(project.default_branch);
  return (
    <ChangeDialog
      id="edit-project"
      title={t('dashboard.admin.project.edit')}
      summary={t('dashboard.admin.project.edit_summary')}
      onClose={onClose}
      onConfirm={async () => {
        const changed = projectChanges(project, { name, repo, folder, branch });
        if (changed === null) return 'dashboard.admin.error.no_change';
        if ('error' in changed) return changed.error;
        await updateProject(project.slug, changed.body, confirmAdminChange);
        onDone();
      }}
    >
      <TextField
        id="edit-name"
        label={t('dashboard.admin.field.name')}
        value={name}
        onInput={setName}
      />
      <TextField
        id="edit-repo"
        label={t('dashboard.admin.field.repo')}
        value={repo}
        onInput={setRepo}
        maxLength={140}
      />
      <TextField
        id="edit-folder"
        label={t('dashboard.admin.field.folder')}
        value={folder}
        onInput={setFolder}
        hint={t('dashboard.admin.hint.folder')}
      />
      <TextField
        id="edit-branch"
        label={t('dashboard.admin.field.branch')}
        value={branch}
        onInput={setBranch}
        maxLength={100}
      />
    </ChangeDialog>
  );
}

function Roles({
  slug,
  data,
  history,
  onHistory,
  onDone,
}: {
  readonly slug: string;
  readonly data: Loaded;
  readonly history: boolean;
  readonly onHistory: (value: boolean) => void;
  readonly onDone: () => void;
}) {
  const [granting, setGranting] = useState(false);
  const [revoking, setRevoking] = useState<AdminRoleView | null>(null);
  const name = (id: string) => data.users?.find((u) => u.id === id)?.display_name ?? id;
  const active = data.project.status === 'active';
  return (
    <section class="admin-section" aria-labelledby="project-roles">
      <div class="section-head">
        <h2 id="project-roles">{t('dashboard.admin.roles')}</h2>
        {session.actions() && active && (
          <button type="button" class="button button-primary" onClick={() => setGranting(true)}>
            {t('dashboard.admin.role.grant')}
          </button>
        )}
      </div>
      <label class="choice">
        <input
          type="checkbox"
          checked={history}
          onChange={(e) => onHistory(e.currentTarget.checked)}
        />
        {t('dashboard.admin.show_revoked')}
      </label>
      {data.roles.length === 0 ? (
        <Empty messageKey="dashboard.admin.roles_empty" />
      ) : (
        <div class="table-wrap">
          <table class="admin-table">
            <caption class="visually-hidden">{t('dashboard.admin.roles')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('dashboard.admin.col.person')}</th>
                <th scope="col">{t('dashboard.admin.col.role')}</th>
                <th scope="col">{t('dashboard.admin.col.since')}</th>
                <th scope="col">
                  <span class="visually-hidden">{t('dashboard.admin.col.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.roles.map((r) => (
                <tr key={r.id} class={r.revoked_at === null ? undefined : 'admin-row-revoked'}>
                  <th scope="row">
                    <a href={adminUserHref(r.user_id)}>
                      <Txt value={name(r.user_id)} />
                    </a>
                  </th>
                  <td class="code">{r.role}</td>
                  <td>
                    <When iso={r.created_at} />
                    {r.revoked_at !== null && (
                      <span class="sub">
                        {t('dashboard.admin.revoked_at')} <When iso={r.revoked_at} />
                      </span>
                    )}
                  </td>
                  <td class="row-actions-cell">
                    {session.actions() && r.revoked_at === null && (
                      <button
                        type="button"
                        class="button button-quiet button-small"
                        onClick={() => setRevoking(r)}
                      >
                        {t('dashboard.admin.role.revoke')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {granting && (
        <GrantRole
          slug={slug}
          users={data.users}
          onClose={() => setGranting(false)}
          onDone={() => {
            setGranting(false);
            onDone();
          }}
        />
      )}
      {revoking !== null && (
        <ChangeDialog
          id="revoke-role"
          title={t('dashboard.admin.role.revoke')}
          summary={t('dashboard.admin.role.revoke_summary', {
            name: name(revoking.user_id),
            role: revoking.role,
          })}
          danger
          onClose={() => setRevoking(null)}
          onConfirm={async () => {
            await revokeRole(slug, revoking.id, confirmAdminChange);
            setRevoking(null);
            onDone();
          }}
        />
      )}
    </section>
  );
}

function GrantRole({
  slug,
  users,
  onClose,
  onDone,
}: {
  readonly slug: string;
  readonly users: readonly AdminUserView[] | null;
  readonly onClose: () => void;
  readonly onDone: () => void;
}) {
  const active = users?.filter((u) => u.status === 'active') ?? null;
  const [user, setUser] = useState(active?.[0]?.id ?? '');
  const [role, setRole] = useState<string>(PROJECT_ROLES[0]);
  return (
    <ChangeDialog
      id="grant-role"
      title={t('dashboard.admin.role.grant')}
      summary={t('dashboard.admin.role.grant_summary', { project: slug })}
      onClose={onClose}
      onConfirm={async () => {
        const checked = checkRole({ user, role });
        if ('error' in checked) return checked.error;
        await grantRole(slug, checked.body, confirmAdminChange);
        onDone();
      }}
    >
      {active === null ? (
        <TextField
          id="role-user"
          label={t('dashboard.admin.field.person_id')}
          value={user}
          onInput={setUser}
          hint={t('dashboard.admin.hint.person_id')}
          maxLength={36}
        />
      ) : (
        <div class="field">
          <label for="role-user">{t('dashboard.admin.field.person')}</label>
          <select id="role-user" value={user} onChange={(e) => setUser(e.currentTarget.value)}>
            {active.map((u) => (
              <option key={u.id} value={u.id}>
                {u.display_name}
              </option>
            ))}
          </select>
        </div>
      )}
      <div class="field">
        <label for="role-role">{t('dashboard.admin.field.role')}</label>
        <select id="role-role" value={role} onChange={(e) => setRole(e.currentTarget.value)}>
          {PROJECT_ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </div>
    </ChangeDialog>
  );
}
