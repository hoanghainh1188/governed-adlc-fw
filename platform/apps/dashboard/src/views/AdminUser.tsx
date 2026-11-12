// One person's administration (task U09, design/ADR-M37 §2.3, ADR-M73 §2.4b, MVP1-UI-SCOPE §3.4
// W10): their name and address, disable or enable, sign them out everywhere, and their GitHub
// accounts by numeric account ID (R037). Tenant admins only; every change asks for a passkey.
// Nobody disables themselves (the API refuses, R088). Tokens stay in the CLI (QUESTIONS #684).
import type { AdminIdentityView, AdminUserView } from '@sdlc/api-schemas';
import { useState } from 'preact/hooks';

import { readAdminUser, readIdentities } from '../api/reads.js';
import { useApi } from '../api/use-api.js';
import {
  disableUser,
  enableUser,
  endUserSessions,
  linkIdentity,
  unlinkIdentity,
  updateUser,
} from '../api/admin-writes.js';
import { ChangeDialog, TextField } from '../components/ChangeDialog.js';
import { Empty, Show, Txt, When } from '../components/common.js';
import { t } from '../i18n.js';
import { checkIdentity, checkUser } from '../model/admin.js';
import { href } from '../router.js';
import { session } from '../session.js';
import { ChangesNote } from './Admin.js';
import { UserPasskeys } from './AdminUserPasskeys.js';
import { confirmAdminChange } from './admin-step-up.js';

type Dialog = 'edit' | 'disable' | 'enable' | 'sessions' | 'link' | AdminIdentityView | null;

export function AdminUser({ id }: { readonly id: string }) {
  const [history, setHistory] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { result, reload } = useApi(
    async (signal) => {
      const [user, identities] = await Promise.all([
        readAdminUser(id, { signal }),
        readIdentities(id, history, { signal }),
      ]);
      return { user, identities: identities.items };
    },
    [id, history],
  );
  const done = (text?: string) => {
    setDialog(null);
    setNotice(text ?? null);
    reload();
  };
  return (
    <section class="screen" aria-labelledby="admin-user-title">
      <p class="crumbs">
        <a href={href('admin')}>{t('dashboard.admin.title')}</a>
      </p>
      <ChangesNote />
      {notice !== null && (
        <p class="notice notice-success" role="status">
          {notice}
        </p>
      )}
      <Show loaded={result}>
        {({ user, identities }) => (
          <>
            <div class="screen-head">
              <div>
                <p class="eyebrow">{t('dashboard.admin.person.eyebrow')}</p>
                <h1 id="admin-user-title">
                  <Txt value={user.display_name} />
                </h1>
              </div>
            </div>
            <Facts user={user} onDialog={setDialog} />
            <Identities
              identities={identities}
              history={history}
              onHistory={setHistory}
              onDialog={setDialog}
            />
            <UserPasskeys user={user} />
            {dialog !== null && (
              <UserDialog
                user={user}
                dialog={dialog}
                onClose={() => setDialog(null)}
                onDone={done}
              />
            )}
          </>
        )}
      </Show>
    </section>
  );
}

function Facts({
  user,
  onDialog,
}: {
  readonly user: AdminUserView;
  readonly onDialog: (d: Dialog) => void;
}) {
  const can = session.actions();
  const active = user.status === 'active';
  return (
    <section class="admin-section" aria-labelledby="user-details">
      <div class="section-head">
        <h2 id="user-details">{t('dashboard.admin.person.details')}</h2>
        {can && (
          <div class="row-actions">
            <button type="button" class="button button-quiet" onClick={() => onDialog('edit')}>
              {t('dashboard.admin.person.edit')}
            </button>
            <button type="button" class="button button-quiet" onClick={() => onDialog('sessions')}>
              {t('dashboard.admin.person.sessions')}
            </button>
            <button
              type="button"
              class={`button ${active ? 'button-danger' : 'button-quiet'}`}
              onClick={() => onDialog(active ? 'disable' : 'enable')}
            >
              {active ? t('dashboard.admin.person.disable') : t('dashboard.admin.person.enable')}
            </button>
          </div>
        )}
      </div>
      <dl class="admin-facts">
        <dt>{t('dashboard.admin.field.email')}</dt>
        <dd class="code">
          <Txt value={user.email} />
        </dd>
        <dt>{t('dashboard.admin.col.status')}</dt>
        <dd>
          <Txt value={user.status} />
          {user.tenant_admin && (
            <span class="chip admin-chip">{t('dashboard.admin.tenant_admin_tag')}</span>
          )}
        </dd>
        <dt>{t('dashboard.admin.field.person_id')}</dt>
        <dd class="code">{user.id}</dd>
      </dl>
    </section>
  );
}

function Identities({
  identities,
  history,
  onHistory,
  onDialog,
}: {
  readonly identities: readonly AdminIdentityView[];
  readonly history: boolean;
  readonly onHistory: (value: boolean) => void;
  readonly onDialog: (d: Dialog) => void;
}) {
  const can = session.actions();
  return (
    <section class="admin-section" aria-labelledby="user-identities">
      <div class="section-head">
        <h2 id="user-identities">{t('dashboard.admin.identities')}</h2>
        {can && (
          <button type="button" class="button button-primary" onClick={() => onDialog('link')}>
            {t('dashboard.admin.identity.link')}
          </button>
        )}
      </div>
      <label class="choice">
        <input
          type="checkbox"
          checked={history}
          onChange={(e) => onHistory(e.currentTarget.checked)}
        />
        {t('dashboard.admin.show_unlinked')}
      </label>
      {identities.length === 0 ? (
        <Empty messageKey="dashboard.admin.identities_empty" />
      ) : (
        <div class="table-wrap">
          <table class="admin-table">
            <caption class="visually-hidden">{t('dashboard.admin.identities')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('dashboard.admin.col.account_id')}</th>
                <th scope="col">{t('dashboard.admin.col.login')}</th>
                <th scope="col">{t('dashboard.admin.col.since')}</th>
                <th scope="col">
                  <span class="visually-hidden">{t('dashboard.admin.col.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {identities.map((i) => (
                <tr key={i.id} class={i.unlinked_at === null ? undefined : 'admin-row-revoked'}>
                  <th scope="row" class="code">
                    {i.external_id}
                  </th>
                  <td class="code">
                    <Txt value={i.external_login} />
                  </td>
                  <td>
                    <When iso={i.created_at} />
                    {i.unlinked_at !== null && (
                      <span class="sub">
                        {t('dashboard.admin.unlinked_at')} <When iso={i.unlinked_at} />
                      </span>
                    )}
                  </td>
                  <td class="row-actions-cell">
                    {can && i.unlinked_at === null && (
                      <button
                        type="button"
                        class="button button-quiet button-small"
                        onClick={() => onDialog(i)}
                      >
                        {t('dashboard.admin.identity.unlink')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function UserDialog({
  user,
  dialog,
  onClose,
  onDone,
}: {
  readonly user: AdminUserView;
  readonly dialog: Exclude<Dialog, null>;
  readonly onClose: () => void;
  readonly onDone: (notice?: string) => void;
}) {
  if (dialog === 'edit') return <EditUser user={user} onClose={onClose} onDone={onDone} />;
  if (dialog === 'link') return <LinkIdentity user={user} onClose={onClose} onDone={onDone} />;
  const name = user.display_name;
  if (typeof dialog === 'object') {
    return (
      <ChangeDialog
        id="unlink-identity"
        title={t('dashboard.admin.identity.unlink')}
        summary={t('dashboard.admin.identity.unlink_summary', {
          login: dialog.external_login,
          name,
        })}
        danger
        onClose={onClose}
        onConfirm={async () => {
          await unlinkIdentity(user.id, dialog.id, confirmAdminChange);
          onDone();
        }}
      />
    );
  }
  if (dialog === 'sessions') {
    return (
      <ChangeDialog
        id="end-sessions"
        title={t('dashboard.admin.person.sessions')}
        summary={t('dashboard.admin.person.sessions_summary', { name })}
        danger
        onClose={onClose}
        onConfirm={async () => {
          const ended = await endUserSessions(user.id, confirmAdminChange);
          onDone(t('dashboard.admin.person.sessions_ended', { count: ended }));
        }}
      />
    );
  }
  const disable = dialog === 'disable';
  return (
    <ChangeDialog
      id="user-active"
      title={disable ? t('dashboard.admin.person.disable') : t('dashboard.admin.person.enable')}
      summary={
        disable
          ? t('dashboard.admin.person.disable_summary', { name })
          : t('dashboard.admin.person.enable_summary', { name })
      }
      danger={disable}
      onClose={onClose}
      onConfirm={async () => {
        await (disable ? disableUser : enableUser)(user.id, confirmAdminChange);
        onDone();
      }}
    />
  );
}

function EditUser({
  user,
  onClose,
  onDone,
}: {
  readonly user: AdminUserView;
  readonly onClose: () => void;
  readonly onDone: () => void;
}) {
  const [name, setName] = useState(user.display_name);
  const [email, setEmail] = useState(user.email);
  return (
    <ChangeDialog
      id="edit-person"
      title={t('dashboard.admin.person.edit')}
      onClose={onClose}
      onConfirm={async () => {
        const checked = checkUser({ email, name });
        if ('error' in checked) return checked.error;
        const body: Record<string, string> = {};
        if (checked.body.display_name !== user.display_name) {
          body.display_name = checked.body.display_name;
        }
        if (checked.body.email !== user.email) body.email = checked.body.email;
        if (Object.keys(body).length === 0) return 'dashboard.admin.error.no_change';
        await updateUser(user.id, body, confirmAdminChange);
        onDone();
      }}
    >
      <TextField
        id="edit-person-name"
        label={t('dashboard.admin.field.display_name')}
        value={name}
        onInput={setName}
      />
      <TextField
        id="edit-person-email"
        type="email"
        label={t('dashboard.admin.field.email')}
        value={email}
        onInput={setEmail}
        maxLength={320}
      />
    </ChangeDialog>
  );
}

function LinkIdentity({
  user,
  onClose,
  onDone,
}: {
  readonly user: AdminUserView;
  readonly onClose: () => void;
  readonly onDone: () => void;
}) {
  const [account, setAccount] = useState('');
  const [login, setLogin] = useState('');
  return (
    <ChangeDialog
      id="link-identity"
      title={t('dashboard.admin.identity.link')}
      summary={t('dashboard.admin.identity.link_summary', { name: user.display_name })}
      onClose={onClose}
      onConfirm={async () => {
        const checked = checkIdentity({ id: account, login });
        if ('error' in checked) return checked.error;
        await linkIdentity(user.id, checked.body, confirmAdminChange);
        onDone();
      }}
    >
      <TextField
        id="identity-id"
        label={t('dashboard.admin.field.account_id')}
        value={account}
        onInput={setAccount}
        hint={t('dashboard.admin.hint.account_id')}
        maxLength={20}
      />
      <TextField
        id="identity-login"
        label={t('dashboard.admin.field.login')}
        value={login}
        onInput={setLogin}
        maxLength={39}
      />
    </ChangeDialog>
  );
}
