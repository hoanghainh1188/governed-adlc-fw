// The fields of an agent version (task U09 PR 3, ADR-M31): its version, model, pinned instruction
// file, tools, maximum autonomy (L0–L2), environments and, for a new agent, the adapter. The
// instruction file is hashed here (SHA-256 in the browser, like the CLI) and never sent.
import type { AgentView } from '@sdlc/api-schemas';
import { useState } from 'preact/hooks';

import { TextField } from '../components/ChangeDialog.js';
import { t } from '../i18n.js';
import {
  AGENT_ADAPTERS,
  AGENT_AUTONOMY,
  AGENT_ENVIRONMENTS,
  type AgentForm,
} from '../model/admin.js';

/** The largest instruction file the page hashes (the CLI has no limit; this keeps a tab quick). */
const MAX_FILE_BYTES = 1024 * 1024;

export type AgentValues = Omit<AgentForm, 'key' | 'owner'>;

export interface AgentFormState {
  readonly values: AgentValues;
  readonly set: (change: Partial<AgentValues>) => void;
  readonly fileError: string | null;
  readonly setFileError: (key: string | null) => void;
}

export function useAgentForm(agent: AgentView | null): AgentFormState {
  const [values, setValues] = useState<AgentValues>({
    version: '',
    model: agent?.model_ref ?? '',
    instructionsRef: agent?.instructions_ref ?? '',
    instructionsSha256: '',
    tools: agent?.allowed_tools.join(', ') ?? '',
    autonomy: agent?.max_autonomy ?? 'L1',
    environments: agent?.approved_environments ?? ['sandbox'],
    adapter: agent?.adapter ?? '',
  });
  const [fileError, setFileError] = useState<string | null>(null);
  return {
    values,
    set: (change) => setValues((v) => ({ ...v, ...change })),
    fileError,
    setFileError,
  };
}

async function sha256Hex(file: File): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function AgentFields({
  form,
  withAdapter = false,
}: {
  readonly form: AgentFormState;
  readonly withAdapter?: boolean;
}) {
  const { values, set } = form;
  const hashFile = async (file: File | undefined) => {
    form.setFileError(null);
    set({ instructionsSha256: '' });
    if (file === undefined) return;
    if (file.size > MAX_FILE_BYTES) {
      form.setFileError('dashboard.admin.agent.file_too_large');
      return;
    }
    try {
      set({ instructionsSha256: await sha256Hex(file) });
    } catch {
      form.setFileError('dashboard.admin.config.unreadable');
    }
  };
  const toggle = (env: string, on: boolean) =>
    set({
      environments: on
        ? [...values.environments.filter((e) => e !== env), env]
        : values.environments.filter((e) => e !== env),
    });
  return (
    <>
      <TextField
        id="agent-version"
        label={t('dashboard.admin.field.agent_version')}
        value={values.version}
        onInput={(v) => set({ version: v })}
        hint={t('dashboard.admin.hint.agent_version')}
        maxLength={64}
      />
      <TextField
        id="agent-model"
        label={t('dashboard.admin.field.model')}
        value={values.model}
        onInput={(v) => set({ model: v })}
        hint={t('dashboard.admin.hint.model')}
        maxLength={128}
      />
      <TextField
        id="agent-instructions"
        label={t('dashboard.admin.field.instructions')}
        value={values.instructionsRef}
        onInput={(v) => set({ instructionsRef: v })}
        hint={t('dashboard.admin.hint.instructions')}
        maxLength={300}
      />
      <div class="field">
        <label for="agent-instructions-file">{t('dashboard.admin.field.instructions_file')}</label>
        <input
          id="agent-instructions-file"
          type="file"
          onChange={(e) => void hashFile(e.currentTarget.files?.[0])}
        />
        <span class="field-hint code">
          {values.instructionsSha256 === ''
            ? t('dashboard.admin.hint.instructions_file')
            : t('dashboard.admin.agent.file_hash', { hash: values.instructionsSha256 })}
        </span>
        {form.fileError !== null && (
          <span class="notice-inline" role="alert">
            {t(form.fileError)}
          </span>
        )}
      </div>
      <TextField
        id="agent-tools"
        label={t('dashboard.admin.field.tools')}
        value={values.tools}
        onInput={(v) => set({ tools: v })}
        hint={t('dashboard.admin.hint.tools')}
        maxLength={2000}
      />
      <div class="field">
        <label for="agent-autonomy">{t('dashboard.admin.field.autonomy')}</label>
        <select
          id="agent-autonomy"
          value={values.autonomy}
          onChange={(e) => set({ autonomy: e.currentTarget.value })}
        >
          {AGENT_AUTONOMY.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </div>
      <fieldset class="modal-fieldset">
        <legend>{t('dashboard.admin.field.environments')}</legend>
        {AGENT_ENVIRONMENTS.map((env) => (
          <label key={env} class="choice">
            <input
              type="checkbox"
              checked={values.environments.includes(env)}
              onChange={(e) => toggle(env, e.currentTarget.checked)}
            />
            <span class="code">{env}</span>
          </label>
        ))}
      </fieldset>
      {withAdapter && (
        <div class="field">
          <label for="agent-adapter">{t('dashboard.admin.field.adapter')}</label>
          <select
            id="agent-adapter"
            value={values.adapter}
            onChange={(e) => set({ adapter: e.currentTarget.value })}
          >
            <option value="">{t('dashboard.admin.agent.adapter_default')}</option>
            {AGENT_ADAPTERS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </div>
      )}
    </>
  );
}
