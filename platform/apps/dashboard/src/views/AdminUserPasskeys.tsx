// A person's passkeys, for a tenant admin (task U09 PR 3, design/ADR-M73 §2.4b, QUESTIONS #414):
// when they were added and last used, and a removal for a lost device (`passkey.revoked`,
// `reason` `admin`). The platform keeps only the public part of a key. The removal asks for the
// admin's own passkey.
import type { AdminUserView, PasskeyView } from '@sdlc/api-schemas';
import { useState } from 'preact/hooks';

import { revokeUserPasskey } from '../api/admin-writes.js';
import { readUserPasskeys } from '../api/reads.js';
import { useApi } from '../api/use-api.js';
import { ChangeDialog } from '../components/ChangeDialog.js';
import { Empty, Show, When } from '../components/common.js';
import { t } from '../i18n.js';
import { session } from '../session.js';
import { confirmAdminChange } from './admin-step-up.js';

export function UserPasskeys({ user }: { readonly user: AdminUserView }) {
  const { result, reload } = useApi((signal) => readUserPasskeys(user.id, { signal }), [user.id]);
  const [removing, setRemoving] = useState<PasskeyView | null>(null);
  return (
    <section class="admin-section" aria-labelledby="user-passkeys">
      <h2 id="user-passkeys">{t('dashboard.admin.passkeys')}</h2>
      <Show loaded={result}>
        {(list) => {
          const active = list.items.filter((p) => p.revoked_at === null);
          return active.length === 0 ? (
            <Empty messageKey="dashboard.admin.passkeys_empty" />
          ) : (
            <ul class="admin-list">
              {active.map((p) => (
                <li key={p.id}>
                  <span>
                    {t('dashboard.admin.passkey.added')} <When iso={p.created_at} />
                  </span>
                  <span class="muted">
                    {t('dashboard.admin.passkey.last_used')} <When iso={p.last_used_at} />
                  </span>
                  {session.actions() && (
                    <button
                      type="button"
                      class="button button-quiet button-small"
                      onClick={() => setRemoving(p)}
                    >
                      {t('dashboard.admin.passkey.remove')}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          );
        }}
      </Show>
      {removing !== null && (
        <ChangeDialog
          id="remove-user-passkey"
          title={t('dashboard.admin.passkey.remove')}
          summary={t('dashboard.admin.passkey.remove_summary', { name: user.display_name })}
          danger
          onClose={() => setRemoving(null)}
          onConfirm={async () => {
            await revokeUserPasskey(user.id, removing.id, confirmAdminChange);
            setRemoving(null);
            reload();
          }}
        />
      )}
    </section>
  );
}
