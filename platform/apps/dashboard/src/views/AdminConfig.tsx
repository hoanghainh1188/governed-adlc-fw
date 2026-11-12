// A project's configuration (task U09, design/ADR-M37 §2.4, ADR-M73 §2.4b, MVP1-UI-SCOPE §3.4 W11,
// QUESTIONS #683): the stored YAML and its version, then a file the person chooses, the line
// difference to the stored version, and a save with a passkey. The API checks the file again and
// refuses it with each problem in its words (`config_rejected`), or answers 409 when someone saved
// a newer version in between (`config_version_conflict`). The file is read in the browser only.
import type { AdminConfigView } from '@sdlc/api-schemas';
import { cleanText } from '@sdlc/api-schemas';
import { useState } from 'preact/hooks';

import { readProjectConfig } from '../api/reads.js';
import { useApi } from '../api/use-api.js';
import { saveConfig } from '../api/admin-writes.js';
import { ChangeDialog } from '../components/ChangeDialog.js';
import { Show, Txt, When } from '../components/common.js';
import { t } from '../i18n.js';
import { diffCounts, lineDiff, type DiffLine } from '../model/admin.js';
import { adminProjectHref } from '../router.js';
import { session } from '../session.js';
import { ChangesNote } from './Admin.js';
import { confirmAdminChange } from './admin-step-up.js';

/** How a screen reader names each line of the difference. */
const MARK_KEYS = {
  same: 'dashboard.admin.config.mark.same',
  removed: 'dashboard.admin.config.mark.removed',
  added: 'dashboard.admin.config.mark.added',
} as const;

/** The API's limit for a stored configuration (`MAX_CONFIG_YAML_BYTES`). */
const MAX_BYTES = 32 * 1024;

interface Chosen {
  readonly name: string;
  readonly text: string;
}

export function AdminConfig({ slug }: { readonly slug: string }) {
  const { result, reload } = useApi((signal) => readProjectConfig(slug, { signal }), [slug]);
  const [saved, setSaved] = useState<AdminConfigView | null>(null);
  return (
    <section class="screen" aria-labelledby="admin-config-title">
      <p class="crumbs">
        <a href={adminProjectHref(slug)} class="code">
          {slug}
        </a>
      </p>
      <div class="screen-head">
        <div>
          <p class="eyebrow">{t('dashboard.admin.config.eyebrow')}</p>
          <h1 id="admin-config-title">{t('dashboard.admin.config.title')}</h1>
        </div>
      </div>
      <p class="lede">{t('dashboard.admin.config.lede')}</p>
      <ChangesNote />
      {saved !== null && <SavedNotice view={saved} />}
      <Show loaded={result}>
        {(stored) => (
          <>
            <Stored view={stored} />
            {session.actions() && (
              <Upload
                stored={stored}
                onSaved={(view) => {
                  setSaved(view);
                  reload();
                }}
              />
            )}
          </>
        )}
      </Show>
    </section>
  );
}

function Stored({ view }: { readonly view: AdminConfigView }) {
  return (
    <section class="admin-section" aria-labelledby="config-stored">
      <h2 id="config-stored">{t('dashboard.admin.config.stored')}</h2>
      <p>
        {view.version === 0
          ? t('dashboard.admin.config.defaults')
          : t('dashboard.admin.config.version', { version: view.version })}{' '}
        {view.updated_at !== null && (
          <span class="muted">
            <When iso={view.updated_at} />
          </span>
        )}
      </p>
      {view.config_yaml !== '' && (
        <div
          class="config-yaml"
          tabIndex={0}
          role="region"
          aria-label={t('dashboard.admin.config.stored')}
        >
          {/* One element per line: server text is cleaned of control characters, line breaks too. */}
          {view.config_yaml
            .replace(/\r\n/g, '\n')
            .replace(/\n$/, '')
            .split('\n')
            .map((line, i) => (
              <div key={i} class="config-line">
                <Txt value={line === '' ? ' ' : line} />
              </div>
            ))}
        </div>
      )}
    </section>
  );
}

function Upload({
  stored,
  onSaved,
}: {
  readonly stored: AdminConfigView;
  readonly onSaved: (view: AdminConfigView) => void;
}) {
  const [chosen, setChosen] = useState<Chosen | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const choose = async (file: File | undefined) => {
    setChosen(null);
    setFileError(null);
    if (file === undefined) return;
    if (file.size > MAX_BYTES) {
      setFileError(t('dashboard.admin.config.too_large'));
      return;
    }
    try {
      setChosen({ name: file.name, text: await file.text() });
    } catch {
      setFileError(t('dashboard.admin.config.unreadable'));
    }
  };

  const diff = chosen === null ? null : lineDiff(stored.config_yaml, chosen.text);
  const same = chosen !== null && chosen.text === stored.config_yaml;
  return (
    <section class="admin-section" aria-labelledby="config-upload">
      <h2 id="config-upload">{t('dashboard.admin.config.upload')}</h2>
      <div class="field">
        <label for="config-file">{t('dashboard.admin.config.file')}</label>
        <input
          id="config-file"
          type="file"
          accept=".yaml,.yml,text/yaml"
          onChange={(e) => void choose(e.currentTarget.files?.[0])}
        />
        <span class="field-hint">{t('dashboard.admin.config.file_hint')}</span>
      </div>
      {fileError !== null && (
        <p class="notice notice-error" role="alert">
          {fileError}
        </p>
      )}
      {chosen !== null && (
        <>
          <h3>{t('dashboard.admin.config.difference', { file: cleanText(chosen.name) })}</h3>
          {same ? (
            <p class="notice">{t('dashboard.admin.config.same')}</p>
          ) : diff === null ? (
            <p class="notice">{t('dashboard.admin.config.diff_too_large')}</p>
          ) : (
            <Difference diff={diff} />
          )}
          <button
            type="button"
            class="button button-primary"
            disabled={same}
            onClick={() => setConfirming(true)}
          >
            {t('dashboard.admin.config.save')}
          </button>
        </>
      )}
      {confirming && chosen !== null && (
        <ChangeDialog
          id="save-config"
          title={t('dashboard.admin.config.save')}
          summary={t('dashboard.admin.config.save_summary', {
            version: stored.version,
            next: stored.version + 1,
          })}
          onClose={() => setConfirming(false)}
          onConfirm={async () => {
            const view = await saveConfig(
              stored.project.slug,
              { expected_version: stored.version, config_yaml: chosen.text },
              confirmAdminChange,
            );
            setConfirming(false);
            setChosen(null);
            onSaved(view);
          }}
        />
      )}
    </section>
  );
}

function Difference({ diff }: { readonly diff: readonly DiffLine[] }) {
  const counts = diffCounts(diff);
  return (
    <>
      <p class="muted" role="status">
        {t('dashboard.admin.config.counts', counts)}
      </p>
      <div
        class="config-diff"
        tabIndex={0}
        role="region"
        aria-label={t('dashboard.admin.config.diff_label')}
      >
        {diff.map((line, i) => (
          <div key={i} class={`diff-line diff-${line.kind}`}>
            <span class="diff-mark" aria-label={t(MARK_KEYS[line.kind])}>
              {line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '}
            </span>
            <span class="diff-text">
              <Txt value={line.text === '' ? ' ' : line.text} />
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

function SavedNotice({ view }: { readonly view: AdminConfigView }) {
  return (
    <div class="notice notice-success" role="status">
      <p>{t('dashboard.admin.config.saved', { version: view.version })}</p>
      {view.warnings.length > 0 && (
        <ul>
          {view.warnings.map((w, i) => (
            <li key={i}>
              <Txt value={w.message} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
