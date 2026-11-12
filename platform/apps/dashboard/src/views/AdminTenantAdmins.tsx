// The tenant admins (task U09, design/ADR-M37 §2.1, ADR-M73 §2.4b): who they are, make another
// person one, or remove one. Nobody grants the role to themselves, and the last active tenant
// admin is never removed: the API refuses both and the page shows its words (M21, R088).
import type { AdminTenantRoleView, AdminUserView } from '@sdlc/api-schemas';
import { useState } from 'preact/hooks';

import { readAdminUsers, readTenantAdmins } from '../api/reads.js';
import { useApi } from '../api/use-api.js';
import { grantTenantAdmin, revokeTenantAdmin } from '../api/admin-writes.js';
import { ChangeDialog } from '../components/ChangeDialog.js';
import { Empty, Show, Txt, When } from '../components/common.js';
import { t } from '../i18n.js';
import { UUID } from '../model/admin.js';
import { adminUserHref } from '../router.js';
import { session } from '../session.js';
import { confirmAdminChange } from './admin-step-up.js';

interface Loaded {
  readonly admins: readonly AdminTenantRoleView[];
  readonly users: readonly AdminUserView[];
}

export function TenantAdmins() {
  const { result, reload } = useApi(async (signal): Promise<Loaded> => {
    const [admins, users] = await Promise.all([
      readTenantAdmins({ signal }),
      readAdminUsers({ signal }),
    ]);
    return { admins: admins.items, users: users.items };
  }, []);
  const [granting, setGranting] = useState(false);
  const [removing, setRemoving] = useState<AdminTenantRoleView | null>(null);
  return (
    <section class="admin-section" aria-labelledby="admin-tenant-admins">
      <div class="section-head">
        <h2 id="admin-tenant-admins">{t('dashboard.admin.tenant_admins')}</h2>
        {session.actions() && (
          <button type="button" class="button button-quiet" onClick={() => setGranting(true)}>
            {t('dashboard.admin.tenant_admin.grant')}
          </button>
        )}
      </div>
      <Show loaded={result}>
        {(data) => {
          const active = data.admins.filter((a) => a.revoked_at === null);
          const name = (id: string) => data.users.find((u) => u.id === id)?.display_name ?? id;
          return (
            <>
              {active.length === 0 ? (
                <Empty messageKey="dashboard.admin.tenant_admins_empty" />
              ) : (
                <ul class="admin-list">
                  {active.map((a) => (
                    <li key={a.id}>
                      <a href={adminUserHref(a.user_id)}>
                        <Txt value={name(a.user_id)} />
                      </a>
                      <span class="muted">
                        {t('dashboard.admin.since')} <When iso={a.created_at} />
                      </span>
                      {session.actions() && (
                        <button
                          type="button"
                          class="button button-quiet button-small"
                          onClick={() => setRemoving(a)}
                        >
                          {t('dashboard.admin.tenant_admin.revoke')}
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {granting && (
                <GrantDialog
                  users={data.users.filter(
                    (u) => u.status === 'active' && !active.some((a) => a.user_id === u.id),
                  )}
                  onClose={() => setGranting(false)}
                  onDone={() => {
                    setGranting(false);
                    reload();
                  }}
                />
              )}
              {removing !== null && (
                <ChangeDialog
                  id="revoke-tenant-admin"
                  title={t('dashboard.admin.tenant_admin.revoke')}
                  summary={t('dashboard.admin.tenant_admin.revoke_summary', {
                    name: name(removing.user_id),
                  })}
                  danger
                  onClose={() => setRemoving(null)}
                  onConfirm={async () => {
                    await revokeTenantAdmin(removing.id, confirmAdminChange);
                    setRemoving(null);
                    reload();
                  }}
                />
              )}
            </>
          );
        }}
      </Show>
    </section>
  );
}

function GrantDialog({
  users,
  onClose,
  onDone,
}: {
  readonly users: readonly AdminUserView[];
  readonly onClose: () => void;
  readonly onDone: () => void;
}) {
  const [user, setUser] = useState(users[0]?.id ?? '');
  return (
    <ChangeDialog
      id="grant-tenant-admin"
      title={t('dashboard.admin.tenant_admin.grant')}
      summary={t('dashboard.admin.tenant_admin.grant_summary')}
      onClose={onClose}
      onConfirm={async () => {
        if (!UUID.test(user)) return 'dashboard.admin.error.user';
        await grantTenantAdmin(user, confirmAdminChange);
        onDone();
      }}
    >
      <div class="field">
        <label for="tenant-admin-user">{t('dashboard.admin.field.person')}</label>
        <select
          id="tenant-admin-user"
          value={user}
          onChange={(e) => setUser(e.currentTarget.value)}
        >
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.display_name}
            </option>
          ))}
        </select>
      </div>
    </ChangeDialog>
  );
}
