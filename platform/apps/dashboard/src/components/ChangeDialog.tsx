// The dialog of one administration change (task U09, design/ADR-M73 §2.4b): its fields, what it
// will change, and one button that asks for the passkey and sends the change. A refusal is shown
// in the API's own words (`adminErrorText`); the dialog stays open so the person can read it. The
// page has no rule set: it only checks the shape of a field before the passkey prompt.
import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';

import { t } from '../i18n.js';
import { adminErrorText } from '../model/admin-text.js';

export interface ChangeDialogProps {
  readonly id: string;
  readonly title: string;
  /** What the change does, in one or two sentences (catalog text). */
  readonly summary?: string;
  readonly children?: ComponentChildren;
  /** The confirm button's label; by default "Confirm with passkey". */
  readonly confirmLabel?: string;
  readonly danger?: boolean;
  /**
   * Checks the fields and sends the change; returns the catalog key of a wrong field (nothing is
   * sent then), or nothing when the change was made.
   */
  onConfirm(this: void): Promise<string | void>;
  readonly onClose: () => void;
}

export function ChangeDialog({
  id,
  title,
  summary,
  children,
  confirmLabel,
  danger = false,
  onConfirm,
  onClose,
}: ChangeDialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const wrong = await onConfirm();
      if (typeof wrong === 'string') setError(t(wrong));
    } catch (err: unknown) {
      setError(adminErrorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`}>
      <div class="modal-card modal-card-scroll">
        <h3 id={`${id}-title`}>{title}</h3>
        {summary !== undefined && <p class="change-summary">{summary}</p>}
        {children}
        <p class="field-hint">{t('dashboard.admin.passkey_hint')}</p>
        {error !== null && (
          <p class="notice notice-error" role="alert">
            {error}
          </p>
        )}
        <div class="modal-buttons">
          <button type="button" class="button button-quiet" onClick={onClose} disabled={busy}>
            {t('dashboard.admin.cancel')}
          </button>
          <button
            type="button"
            class={`button ${danger ? 'button-danger' : 'button-primary'}`}
            onClick={() => void confirm()}
            disabled={busy}
            aria-busy={busy}
          >
            {confirmLabel ?? t('dashboard.admin.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}

/** A labelled text field of a dialog. */
export function TextField({
  id,
  label,
  value,
  onInput,
  hint,
  type = 'text',
  maxLength = 200,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly onInput: (value: string) => void;
  readonly hint?: string;
  readonly type?: 'text' | 'email';
  readonly maxLength?: number;
}) {
  return (
    <div class="field">
      <label for={id}>{label}</label>
      <input
        id={id}
        type="text"
        inputMode={type === 'email' ? 'email' : 'text'}
        value={value}
        maxLength={maxLength}
        autoComplete="off"
        spellcheck={false}
        aria-describedby={hint === undefined ? undefined : `${id}-hint`}
        onInput={(e) => onInput(e.currentTarget.value)}
      />
      {hint !== undefined && (
        <span id={`${id}-hint`} class="field-hint">
          {hint}
        </span>
      )}
    </div>
  );
}
