// The evidence holds of one intent (task U09 PR 3, design/ADR-M51, ADR-M73 §2.4b, MVP1-UI-SCOPE
// §3.4 W13): a hold keeps the intent's evidence files from the purge until a person releases it.
// Who may hold: tenant admins and `access.evidence_hold_roles` (never a viewer, M32); the API
// decides. A hold takes an optional `https://` link, never text. Every change asks for a passkey.
import type { EvidenceHoldView } from '@sdlc/api-schemas';
import { useState } from 'preact/hooks';

import { holdEvidence, releaseEvidence } from '../api/admin-writes.js';
import { readEvidenceHolds } from '../api/reads.js';
import { useApi } from '../api/use-api.js';
import { ChangeDialog, TextField } from '../components/ChangeDialog.js';
import { Empty, Show, Txt, When } from '../components/common.js';
import { t } from '../i18n.js';
import { checkHoldLink } from '../model/admin.js';
import { intentHref } from '../router.js';
import { session } from '../session.js';
import { ChangesNote } from './Admin.js';
import { confirmAdminChange } from './admin-step-up.js';

export function AdminHold({ code }: { readonly code: string }) {
  const { result, reload } = useApi((signal) => readEvidenceHolds(code, { signal }), [code]);
  const [dialog, setDialog] = useState<'hold' | 'release' | null>(null);
  const done = () => {
    setDialog(null);
    reload();
  };
  return (
    <section class="screen" aria-labelledby="admin-hold-title">
      <p class="crumbs">
        <a href={intentHref(code)} class="code">
          {code}
        </a>
      </p>
      <div class="screen-head">
        <div>
          <p class="eyebrow">{t('dashboard.admin.hold.eyebrow')}</p>
          <h1 id="admin-hold-title">{t('dashboard.admin.hold.title')}</h1>
        </div>
      </div>
      <p class="lede">{t('dashboard.admin.hold.lede')}</p>
      <ChangesNote />
      <Show loaded={result}>
        {(view) => (
          <>
            <section class="admin-section" aria-labelledby="hold-now">
              <div class="section-head">
                <h2 id="hold-now">{t('dashboard.admin.hold.now')}</h2>
                {session.actions() &&
                  (view.active === null ? (
                    <button
                      type="button"
                      class="button button-primary"
                      onClick={() => setDialog('hold')}
                    >
                      {t('dashboard.admin.hold.hold')}
                    </button>
                  ) : (
                    <button
                      type="button"
                      class="button button-danger"
                      onClick={() => setDialog('release')}
                    >
                      {t('dashboard.admin.hold.release')}
                    </button>
                  ))}
              </div>
              {view.active === null ? (
                <p class="notice">{t('dashboard.admin.hold.none')}</p>
              ) : (
                <HoldFacts hold={view.active} />
              )}
            </section>
            <section class="admin-section" aria-labelledby="hold-history">
              <h2 id="hold-history">{t('dashboard.admin.hold.history')}</h2>
              {view.history.length === 0 ? (
                <Empty messageKey="dashboard.admin.hold.history_empty" />
              ) : (
                <ul class="admin-list">
                  {view.history.map((h) => (
                    <li key={h.id}>
                      <When iso={h.created_at} />
                      <span class="muted">
                        {h.released_at === null
                          ? t('dashboard.admin.hold.active')
                          : t('dashboard.admin.hold.released')}
                      </span>
                      {h.released_at !== null && <When iso={h.released_at} />}
                    </li>
                  ))}
                </ul>
              )}
            </section>
            {dialog === 'hold' && (
              <HoldDialog code={code} onClose={() => setDialog(null)} onDone={done} />
            )}
            {dialog === 'release' && (
              <ChangeDialog
                id="release-hold"
                title={t('dashboard.admin.hold.release')}
                summary={t('dashboard.admin.hold.release_summary', { intent: code })}
                danger
                onClose={() => setDialog(null)}
                onConfirm={async () => {
                  await releaseEvidence(code, confirmAdminChange);
                  done();
                }}
              />
            )}
          </>
        )}
      </Show>
    </section>
  );
}

function HoldFacts({ hold }: { readonly hold: EvidenceHoldView }) {
  return (
    <dl class="admin-facts">
      <dt>{t('dashboard.admin.col.since')}</dt>
      <dd>
        <When iso={hold.created_at} />
      </dd>
      <dt>{t('dashboard.admin.hold.held_by')}</dt>
      <dd class="code">{hold.held_by}</dd>
      <dt>{t('dashboard.admin.field.link')}</dt>
      <dd class="code">
        <Txt value={hold.reason_ref} />
      </dd>
    </dl>
  );
}

function HoldDialog({
  code,
  onClose,
  onDone,
}: {
  readonly code: string;
  readonly onClose: () => void;
  readonly onDone: () => void;
}) {
  const [link, setLink] = useState('');
  return (
    <ChangeDialog
      id="hold-evidence"
      title={t('dashboard.admin.hold.hold')}
      summary={t('dashboard.admin.hold.hold_summary', { intent: code })}
      onClose={onClose}
      onConfirm={async () => {
        const checked = checkHoldLink(link);
        if ('error' in checked) return checked.error;
        await holdEvidence(code, checked.body, confirmAdminChange);
        onDone();
      }}
    >
      <TextField
        id="hold-link"
        label={t('dashboard.admin.field.link')}
        value={link}
        onInput={setLink}
        hint={t('dashboard.admin.hint.link')}
        maxLength={512}
      />
    </ChangeDialog>
  );
}
