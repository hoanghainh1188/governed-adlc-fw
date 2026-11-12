// The agent register (task U09 PR 3, design/ADR-M31, ADR-M37 §2.8, ADR-M73 §2.4b, MVP1-UI-SCOPE
// §3.4 W12): every agent of the tenant, its version, status and recertification, and a form to
// register a new one. A new agent waits for its activation approvals on its own screen. The
// instruction file is hashed in the browser (SHA-256), like `adlc admin agent register
// --instructions-file`; the file is never sent. Every change asks for a passkey.
import type { AdminUserView, AgentView, Me } from '@sdlc/api-schemas';
import { useState } from 'preact/hooks';

import { registerAgent } from '../api/admin-writes.js';
import { readAdminUsers, readAgents } from '../api/reads.js';
import { useApi } from '../api/use-api.js';
import { ChangeDialog, TextField } from '../components/ChangeDialog.js';
import { Empty, Show, Txt } from '../components/common.js';
import { t } from '../i18n.js';
import { checkAgent } from '../model/admin.js';
import { adminAgentHref, href } from '../router.js';
import { session } from '../session.js';
import { ChangesNote } from './Admin.js';
import { confirmAdminChange } from './admin-step-up.js';
import { AgentFields, useAgentForm } from './AgentFields.js';

export function AdminAgents({ me }: { readonly me: Me }) {
  const { result } = useApi(async (signal) => {
    const [agents, users] = await Promise.all([
      readAgents({ signal }),
      me.tenant_admin === true ? readAdminUsers({ signal }) : Promise.resolve(null),
    ]);
    return { agents: agents.items, users: users?.items ?? null };
  }, []);
  const [adding, setAdding] = useState(false);
  return (
    <section class="screen" aria-labelledby="admin-agents-title">
      <p class="crumbs">
        <a href={href('admin')}>{t('dashboard.admin.title')}</a>
      </p>
      <div class="screen-head">
        <div>
          <p class="eyebrow">{t('dashboard.admin.agents.eyebrow')}</p>
          <h1 id="admin-agents-title">{t('dashboard.admin.agents.title')}</h1>
        </div>
        {session.actions() && (
          <button type="button" class="button button-primary" onClick={() => setAdding(true)}>
            {t('dashboard.admin.agent.register')}
          </button>
        )}
      </div>
      <p class="lede">{t('dashboard.admin.agents.lede')}</p>
      <ChangesNote />
      <Show loaded={result}>
        {({ agents, users }) => (
          <>
            {agents.length === 0 ? (
              <Empty messageKey="dashboard.admin.agents_empty" />
            ) : (
              <AgentTable items={agents} />
            )}
            {adding && (
              <RegisterAgent
                users={users}
                onClose={() => setAdding(false)}
                onDone={(agent) => {
                  setAdding(false);
                  window.location.assign(adminAgentHref(agent.key));
                }}
              />
            )}
          </>
        )}
      </Show>
    </section>
  );
}

function AgentTable({ items }: { readonly items: readonly AgentView[] }) {
  return (
    <div class="table-wrap">
      <table class="admin-table">
        <caption class="visually-hidden">{t('dashboard.admin.agents.title')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('dashboard.admin.col.agent')}</th>
            <th scope="col">{t('dashboard.admin.col.model')}</th>
            <th scope="col">{t('dashboard.admin.col.status')}</th>
            <th scope="col">{t('dashboard.admin.col.recertification')}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((a) => (
            <tr key={a.id}>
              <th scope="row">
                <a href={adminAgentHref(a.key)} class="code">
                  {a.key}
                </a>
                <span class="sub">
                  {t('dashboard.admin.agent.version', { version: a.version })}
                </span>
              </th>
              <td class="code">
                <Txt value={a.model_ref} />
              </td>
              <td>
                <AgentStatus status={a.status} />
              </td>
              <td>
                {a.overdue ? (
                  <span class="chip chip-alert">{t('dashboard.admin.agent.overdue')}</span>
                ) : (
                  <Txt value={a.recertification_due_on} />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** An agent's status as a chip: green when it may run, amber while it waits, red when stopped. */
export function AgentStatus({ status }: { readonly status: string }) {
  const tone =
    status === 'active'
      ? 'admin-status-active'
      : status === 'suspended' || status === 'quarantined'
        ? 'chip-alert'
        : status === 'retired'
          ? 'admin-status-other'
          : 'chip-warn';
  return (
    <span class={`chip ${tone}`}>
      <Txt value={status} />
    </span>
  );
}

function RegisterAgent({
  users,
  onClose,
  onDone,
}: {
  readonly users: readonly AdminUserView[] | null;
  readonly onClose: () => void;
  readonly onDone: (agent: AgentView) => void;
}) {
  const active = users?.filter((u) => u.status === 'active') ?? null;
  const [key, setKey] = useState('');
  const [owner, setOwner] = useState(active?.[0]?.id ?? '');
  const form = useAgentForm(null);
  return (
    <ChangeDialog
      id="register-agent"
      title={t('dashboard.admin.agent.register')}
      summary={t('dashboard.admin.agent.register_summary')}
      onClose={onClose}
      onConfirm={async () => {
        const checked = checkAgent({ ...form.values, key, owner });
        if ('error' in checked) return checked.error;
        onDone(await registerAgent(checked.body, confirmAdminChange));
      }}
    >
      <TextField
        id="agent-key"
        label={t('dashboard.admin.field.agent_key')}
        value={key}
        onInput={setKey}
        hint={t('dashboard.admin.hint.agent_key')}
        maxLength={64}
      />
      {active === null ? (
        <TextField
          id="agent-owner"
          label={t('dashboard.admin.field.owner_id')}
          value={owner}
          onInput={setOwner}
          maxLength={36}
        />
      ) : (
        <div class="field">
          <label for="agent-owner">{t('dashboard.admin.field.owner')}</label>
          <select id="agent-owner" value={owner} onChange={(e) => setOwner(e.currentTarget.value)}>
            {active.map((u) => (
              <option key={u.id} value={u.id}>
                {u.display_name}
              </option>
            ))}
          </select>
        </div>
      )}
      <AgentFields form={form} withAdapter />
    </ChangeDialog>
  );
}
