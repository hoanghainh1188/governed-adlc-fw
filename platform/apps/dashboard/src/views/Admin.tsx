// Administration (task U09, design/ADR-M73 §2.4b, MVP1-UI-SCOPE §3.4 W10): the tenant's projects
// and people, and its tenant admins. A tenant admin sees and changes all of them; a person with
// the project role `admin` sees their projects only (from `/v1/me`). Every change asks for a
// passkey; the API decides who may make it and refuses a self-grant (M21). API tokens stay in the
// CLI (QUESTIONS #684).
import type { AdminProjectView, AdminUserView, Me } from '@sdlc/api-schemas';
import { useState } from 'preact/hooks';

import { readAdminProjects, readAdminUsers } from '../api/reads.js';
import { useApi } from '../api/use-api.js';
import { createProject, createUser } from '../api/admin-writes.js';
import { ChangeDialog, TextField } from '../components/ChangeDialog.js';
import { Empty, Show, Txt } from '../components/common.js';
import { t } from '../i18n.js';
import { checkProject, checkUser } from '../model/admin.js';
import { adminProjectHref, adminUserHref } from '../router.js';
import { session } from '../session.js';
import { confirmAdminChange } from './admin-step-up.js';
import { TenantAdmins } from './AdminTenantAdmins.js';

export function Admin({ me }: { readonly me: Me }) {
  const tenantAdmin = me.tenant_admin === true;
  return (
    <section class="screen" aria-labelledby="admin-title">
      <div class="screen-head">
        <div>
          <p class="eyebrow">{t('dashboard.admin.eyebrow')}</p>
          <h1 id="admin-title">{t('dashboard.admin.title')}</h1>
        </div>
      </div>
      <p class="lede">{t('dashboard.admin.lede')}</p>
      <ChangesNote />
      {tenantAdmin ? (
        <>
          <Projects />
          <People />
          <TenantAdmins />
        </>
      ) : (
        <OwnProjects me={me} />
      )}
    </section>
  );
}

/** Whether this tab may change anything: a GitHub session with actions on. */
export function ChangesNote() {
  return session.actions() ? null : (
    <p class="notice" role="note">
      {t('dashboard.admin.read_only')}
    </p>
  );
}

function Projects() {
  const { result, reload } = useApi((signal) => readAdminProjects({ signal }), []);
  const [adding, setAdding] = useState(false);
  return (
    <section class="admin-section" aria-labelledby="admin-projects">
      <div class="section-head">
        <h2 id="admin-projects">{t('dashboard.admin.projects')}</h2>
        {session.actions() && (
          <button type="button" class="button button-primary" onClick={() => setAdding(true)}>
            {t('dashboard.admin.project.new')}
          </button>
        )}
      </div>
      <Show loaded={result}>
        {(list) =>
          list.items.length === 0 ? (
            <Empty messageKey="dashboard.admin.projects_empty" />
          ) : (
            <ProjectTable items={list.items} />
          )
        }
      </Show>
      {adding && (
        <NewProject
          onClose={() => setAdding(false)}
          onDone={(project) => {
            setAdding(false);
            reload();
            window.location.assign(adminProjectHref(project.slug));
          }}
        />
      )}
    </section>
  );
}

function ProjectTable({ items }: { readonly items: readonly AdminProjectView[] }) {
  return (
    <div class="table-wrap">
      <table class="admin-table">
        <caption class="visually-hidden">{t('dashboard.admin.projects')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('dashboard.admin.col.project')}</th>
            <th scope="col">{t('dashboard.admin.col.repository')}</th>
            <th scope="col">{t('dashboard.admin.col.status')}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((p) => (
            <tr key={p.id}>
              <th scope="row">
                <a href={adminProjectHref(p.slug)}>
                  <span class="code">{p.slug}</span>
                </a>
                <span class="sub">
                  <Txt value={p.name} />
                </span>
              </th>
              <td class="code">
                <Txt
                  value={p.repo_path ? `${p.repo_full_name}/${p.repo_path}` : p.repo_full_name}
                />
              </td>
              <td>
                <span class={`chip admin-status-${p.status === 'active' ? 'active' : 'other'}`}>
                  <Txt value={p.status} />
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function NewProject({
  onClose,
  onDone,
}: {
  readonly onClose: () => void;
  readonly onDone: (project: AdminProjectView) => void;
}) {
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [repo, setRepo] = useState('');
  const [folder, setFolder] = useState('');
  const [branch, setBranch] = useState('');
  return (
    <ChangeDialog
      id="new-project"
      title={t('dashboard.admin.project.new')}
      onClose={onClose}
      onConfirm={async () => {
        const checked = checkProject({ slug, name, repo, folder, branch });
        if ('error' in checked) return checked.error;
        onDone(await createProject(checked.body, confirmAdminChange));
      }}
    >
      <TextField
        id="project-slug"
        label={t('dashboard.admin.field.slug')}
        value={slug}
        onInput={setSlug}
        hint={t('dashboard.admin.hint.slug')}
        maxLength={63}
      />
      <TextField
        id="project-name"
        label={t('dashboard.admin.field.name')}
        value={name}
        onInput={setName}
      />
      <TextField
        id="project-repo"
        label={t('dashboard.admin.field.repo')}
        value={repo}
        onInput={setRepo}
        hint={t('dashboard.admin.hint.repo')}
        maxLength={140}
      />
      <TextField
        id="project-folder"
        label={t('dashboard.admin.field.folder')}
        value={folder}
        onInput={setFolder}
        hint={t('dashboard.admin.hint.folder')}
      />
      <TextField
        id="project-branch"
        label={t('dashboard.admin.field.branch')}
        value={branch}
        onInput={setBranch}
        hint={t('dashboard.admin.hint.branch')}
        maxLength={100}
      />
    </ChangeDialog>
  );
}

function People() {
  const { result, reload } = useApi((signal) => readAdminUsers({ signal }), []);
  const [adding, setAdding] = useState(false);
  return (
    <section class="admin-section" aria-labelledby="admin-people">
      <div class="section-head">
        <h2 id="admin-people">{t('dashboard.admin.people')}</h2>
        {session.actions() && (
          <button type="button" class="button button-primary" onClick={() => setAdding(true)}>
            {t('dashboard.admin.person.new')}
          </button>
        )}
      </div>
      <Show loaded={result}>
        {(list) =>
          list.items.length === 0 ? (
            <Empty messageKey="dashboard.admin.people_empty" />
          ) : (
            <PeopleTable items={list.items} />
          )
        }
      </Show>
      {adding && (
        <NewPerson
          onClose={() => setAdding(false)}
          onDone={(user) => {
            setAdding(false);
            reload();
            window.location.assign(adminUserHref(user.id));
          }}
        />
      )}
    </section>
  );
}

function PeopleTable({ items }: { readonly items: readonly AdminUserView[] }) {
  return (
    <div class="table-wrap">
      <table class="admin-table">
        <caption class="visually-hidden">{t('dashboard.admin.people')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('dashboard.admin.col.person')}</th>
            <th scope="col">{t('dashboard.admin.col.email')}</th>
            <th scope="col">{t('dashboard.admin.col.status')}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((u) => (
            <tr key={u.id}>
              <th scope="row">
                <a href={adminUserHref(u.id)}>
                  <Txt value={u.display_name} />
                </a>
                {u.tenant_admin && (
                  <span class="chip admin-chip">{t('dashboard.admin.tenant_admin_tag')}</span>
                )}
              </th>
              <td class="code">
                <Txt value={u.email} />
              </td>
              <td>
                <span class={`chip admin-status-${u.status === 'active' ? 'active' : 'other'}`}>
                  <Txt value={u.status} />
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function NewPerson({
  onClose,
  onDone,
}: {
  readonly onClose: () => void;
  readonly onDone: (user: AdminUserView) => void;
}) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  return (
    <ChangeDialog
      id="new-person"
      title={t('dashboard.admin.person.new')}
      summary={t('dashboard.admin.person.new_summary')}
      onClose={onClose}
      onConfirm={async () => {
        const checked = checkUser({ email, name });
        if ('error' in checked) return checked.error;
        onDone(await createUser(checked.body, confirmAdminChange));
      }}
    >
      <TextField
        id="person-name"
        label={t('dashboard.admin.field.display_name')}
        value={name}
        onInput={setName}
      />
      <TextField
        id="person-email"
        type="email"
        label={t('dashboard.admin.field.email')}
        value={email}
        onInput={setEmail}
        maxLength={320}
      />
    </ChangeDialog>
  );
}

/** A project admin who is not a tenant admin: their projects, by their `admin` role. */
function OwnProjects({ me }: { readonly me: Me }) {
  const slugs = [
    ...new Set(
      me.roles
        .filter((r) => r.role === 'admin')
        .map((r) => r.project.slug)
        .filter((slug): slug is string => slug !== null),
    ),
  ];
  return (
    <section class="admin-section" aria-labelledby="admin-own">
      <h2 id="admin-own">{t('dashboard.admin.projects')}</h2>
      {slugs.length === 0 ? (
        <Empty messageKey="dashboard.admin.projects_empty" />
      ) : (
        <ul class="admin-links">
          {slugs.map((slug) => (
            <li key={slug}>
              <a href={adminProjectHref(slug)} class="code">
                {slug}
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
