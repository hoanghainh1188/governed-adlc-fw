// The project AI record (task U09 PR 3, design/ADR-M32, ADR-M73 §2.4b, MVP1-UI-SCOPE §3.4 W13; D-02
// FR-19): what the client allowed, as codes, a date and one link. An intent enters G1 only when
// the record allows its data class. Who writes it: `access.ai_record_write_roles` (M19; by default
// Person A and PM / BrSE); the API decides. A new version asks for a passkey.
import type { AiRecordView } from '@sdlc/api-schemas';
import { useState } from 'preact/hooks';

import { saveAiRecord } from '../api/admin-writes.js';
import { ApiError } from '../api/client.js';
import { readAiRecord } from '../api/reads.js';
import { useApi } from '../api/use-api.js';
import { ChangeDialog, TextField } from '../components/ChangeDialog.js';
import { Txt, When } from '../components/common.js';
import { t } from '../i18n.js';
import {
  AI_ALLOWED,
  checkAiRecord,
  DATA_CLASSES,
  DISCLOSURE_FORMATS,
  PROD_LOGS_ALLOWED,
} from '../model/admin.js';
import { session } from '../session.js';
import { confirmAdminChange } from './admin-step-up.js';

/** The record, `null` when the project has none yet, or `'unreadable'` for the person. */
type Record_ = AiRecordView | null | 'unreadable';

export function AdminAiRecord({ slug }: { readonly slug: string }) {
  const { result, reload } = useApi(
    async (signal): Promise<Record_> => {
      try {
        return await readAiRecord(slug, { signal });
      } catch (error) {
        if (error instanceof ApiError && error.code === 'ai_record_not_found') return null;
        if (error instanceof ApiError && (error.status === 404 || error.status === 403)) {
          return 'unreadable';
        }
        throw error;
      }
    },
    [slug],
  );
  const [editing, setEditing] = useState(false);
  const record = result.state === 'ok' ? result.data : undefined;
  return (
    <section class="admin-section" aria-labelledby="project-ai-record">
      <div class="section-head">
        <h2 id="project-ai-record">{t('dashboard.admin.ai.title')}</h2>
        {session.actions() && record !== undefined && record !== 'unreadable' && (
          <button type="button" class="button button-quiet" onClick={() => setEditing(true)}>
            {record === null ? t('dashboard.admin.ai.create') : t('dashboard.admin.ai.edit')}
          </button>
        )}
      </div>
      {result.state === 'loading' && <p class="notice">{t('dashboard.state.loading')}</p>}
      {record === 'unreadable' && <p class="notice">{t('dashboard.admin.ai.unreadable')}</p>}
      {record === null && <p class="notice">{t('dashboard.admin.ai.none')}</p>}
      {record !== undefined && record !== null && record !== 'unreadable' && (
        <RecordFacts record={record} />
      )}
      {editing && record !== undefined && record !== 'unreadable' && (
        <EditRecord
          slug={slug}
          record={record}
          onClose={() => setEditing(false)}
          onDone={() => {
            setEditing(false);
            reload();
          }}
        />
      )}
    </section>
  );
}

function RecordFacts({ record }: { readonly record: AiRecordView }) {
  return (
    <dl class="admin-facts">
      <dt>{t('dashboard.admin.ai.version')}</dt>
      <dd>
        {record.version} <span class="muted">{t('dashboard.admin.since')}</span>{' '}
        <When iso={record.created_at} />
      </dd>
      <dt>{t('dashboard.admin.ai.ai_allowed')}</dt>
      <dd class="code">{record.ai_allowed}</dd>
      <dt>{t('dashboard.admin.ai.classes')}</dt>
      <dd class="code">
        {record.allowed_data_classes.length === 0 ? '—' : record.allowed_data_classes.join(', ')}
      </dd>
      <dt>{t('dashboard.admin.ai.prod_logs')}</dt>
      <dd class="code">{record.prod_logs_allowed}</dd>
      <dt>{t('dashboard.admin.ai.disclosure')}</dt>
      <dd class="code">{record.disclosure_format}</dd>
      <dt>{t('dashboard.admin.ai.consent')}</dt>
      <dd class="code">
        {record.consent} <Txt value={record.confirmed_at} />
      </dd>
      <dt>{t('dashboard.admin.field.link')}</dt>
      <dd class="code">
        <Txt value={record.record_ref} />
      </dd>
    </dl>
  );
}

function Choice({
  id,
  label,
  values,
  value,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly values: readonly string[];
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  return (
    <div class="field">
      <label for={id}>{label}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.currentTarget.value)}>
        {values.map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
      </select>
    </div>
  );
}

function EditRecord({
  slug,
  record,
  onClose,
  onDone,
}: {
  readonly slug: string;
  readonly record: AiRecordView | null;
  readonly onClose: () => void;
  readonly onDone: () => void;
}) {
  const [aiAllowed, setAiAllowed] = useState(record?.ai_allowed ?? 'yes');
  const [classes, setClasses] = useState<readonly string[]>(record?.allowed_data_classes ?? []);
  const [prodLogs, setProdLogs] = useState(record?.prod_logs_allowed ?? 'no');
  const [disclosure, setDisclosure] = useState(record?.disclosure_format ?? 'standard_note');
  const [confirmedAt, setConfirmedAt] = useState(record?.confirmed_at ?? '');
  const [recordRef, setRecordRef] = useState(record?.record_ref ?? '');
  return (
    <ChangeDialog
      id="edit-ai-record"
      title={record === null ? t('dashboard.admin.ai.create') : t('dashboard.admin.ai.edit')}
      summary={t('dashboard.admin.ai.edit_summary')}
      onClose={onClose}
      onConfirm={async () => {
        const checked = checkAiRecord(record?.version ?? 0, {
          aiAllowed,
          classes,
          prodLogs,
          disclosure,
          confirmedAt,
          recordRef,
        });
        if ('error' in checked) return checked.error;
        await saveAiRecord(slug, checked.body, confirmAdminChange);
        onDone();
      }}
    >
      <Choice
        id="ai-allowed"
        label={t('dashboard.admin.ai.ai_allowed')}
        values={AI_ALLOWED}
        value={aiAllowed}
        onChange={setAiAllowed}
      />
      <fieldset class="modal-fieldset">
        <legend>{t('dashboard.admin.ai.classes')}</legend>
        {DATA_CLASSES.map((c) => (
          <label key={c} class="choice">
            <input
              type="checkbox"
              checked={classes.includes(c)}
              onChange={(e) =>
                setClasses(
                  e.currentTarget.checked ? [...classes, c] : classes.filter((x) => x !== c),
                )
              }
            />
            <span class="code">{c}</span>
          </label>
        ))}
      </fieldset>
      <Choice
        id="ai-prod-logs"
        label={t('dashboard.admin.ai.prod_logs')}
        values={PROD_LOGS_ALLOWED}
        value={prodLogs}
        onChange={setProdLogs}
      />
      <Choice
        id="ai-disclosure"
        label={t('dashboard.admin.ai.disclosure')}
        values={DISCLOSURE_FORMATS}
        value={disclosure}
        onChange={setDisclosure}
      />
      <TextField
        id="ai-confirmed"
        label={t('dashboard.admin.ai.confirmed_at')}
        value={confirmedAt}
        onInput={setConfirmedAt}
        hint={t('dashboard.admin.hint.date')}
        maxLength={10}
      />
      <TextField
        id="ai-ref"
        label={t('dashboard.admin.field.link')}
        value={recordRef}
        onInput={setRecordRef}
        hint={t('dashboard.admin.hint.ai_link')}
        maxLength={512}
      />
    </ChangeDialog>
  );
}
