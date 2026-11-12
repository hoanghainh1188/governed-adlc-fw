// One agent of the register (task U09 PR 3, design/ADR-M31, ADR-M37 §2.8, ADR-M86, ADR-M73 §2.4b):
// what it may do, its activation and retirement rounds with the approvals still missing, its
// latest evaluation, and the changes: a new version (new approvals), an approval, suspend or
// quarantine (QUESTIONS #681: a passkey too), a new owner, a recertification. The approvers of a
// round are different people, and the producer never approves: the API decides and the page shows
// its words. The platform never stops an agent by itself (R136): a person decides here.
import type { AdminUserView, AgentDetailView, AgentRoundView, Me } from '@sdlc/api-schemas';
import { useState } from 'preact/hooks';

import {
  approveAgent,
  changeAgentOwner,
  quarantineAgent,
  recertifyAgent,
  suspendAgent,
  updateAgent,
} from '../api/admin-writes.js';
import { readAdminUsers, readAgent } from '../api/reads.js';
import { useApi } from '../api/use-api.js';
import { ChangeDialog, TextField } from '../components/ChangeDialog.js';
import { Show, Txt, When } from '../components/common.js';
import { t } from '../i18n.js';
import {
  AGENT_STATUS_REASONS,
  agentChanges,
  APPROVER_CAPACITIES,
  checkApproval,
  UUID,
} from '../model/admin.js';
import { href } from '../router.js';
import { session } from '../session.js';
import { ChangesNote } from './Admin.js';
import { confirmAdminChange } from './admin-step-up.js';
import { AgentStatus } from './AdminAgents.js';
import { AgentFields, useAgentForm } from './AgentFields.js';

type Dialog = 'update' | 'approve' | 'suspend' | 'quarantine' | 'owner' | 'recertify' | null;

interface Loaded {
  readonly agent: AgentDetailView;
  readonly users: readonly AdminUserView[] | null;
}

export function AdminAgent({ agentKey, me }: { readonly agentKey: string; readonly me: Me }) {
  const { result, reload } = useApi(
    async (signal): Promise<Loaded> => {
      const [agent, users] = await Promise.all([
        readAgent(agentKey, { signal }),
        me.tenant_admin === true ? readAdminUsers({ signal }) : Promise.resolve(null),
      ]);
      return { agent, users: users?.items ?? null };
    },
    [agentKey],
  );
  const [dialog, setDialog] = useState<Dialog>(null);
  const [notice, setNotice] = useState<string | null>(null);
  return (
    <section class="screen" aria-labelledby="admin-agent-title">
      <p class="crumbs">
        <a href={href('admin/agents')}>{t('dashboard.admin.agents.title')}</a>
      </p>
      <ChangesNote />
      {notice !== null && (
        <p class="notice notice-success" role="status">
          {notice}
        </p>
      )}
      <Show loaded={result}>
        {(data) => {
          const name = (id: string) => data.users?.find((u) => u.id === id)?.display_name ?? id;
          const done = (text?: string) => {
            setDialog(null);
            setNotice(text ?? null);
            reload();
          };
          return (
            <>
              <div class="screen-head">
                <div>
                  <p class="eyebrow">{t('dashboard.admin.agents.eyebrow')}</p>
                  <h1 id="admin-agent-title" class="code">
                    {data.agent.key}
                  </h1>
                </div>
                <AgentStatus status={data.agent.status} />
              </div>
              <Actions status={data.agent.status} onDialog={setDialog} />
              <Facts agent={data.agent} owner={name(data.agent.owner_id)} />
              <Rounds rounds={data.agent.rounds} name={name} />
              {dialog !== null && (
                <AgentDialog
                  dialog={dialog}
                  data={data}
                  onClose={() => setDialog(null)}
                  onDone={done}
                />
              )}
            </>
          );
        }}
      </Show>
    </section>
  );
}

function Actions({
  status,
  onDialog,
}: {
  readonly status: string;
  readonly onDialog: (d: Dialog) => void;
}) {
  if (!session.actions() || status === 'retired') return null;
  const stopped = status === 'suspended' || status === 'quarantined';
  const button = (d: Exclude<Dialog, null>, label: string, danger = false) => (
    <button
      type="button"
      class={`button ${danger ? 'button-danger' : 'button-quiet'}`}
      onClick={() => onDialog(d)}
    >
      {label}
    </button>
  );
  return (
    <div class="row-actions admin-actions">
      {button('approve', t('dashboard.admin.agent.approve'))}
      {button('update', t('dashboard.admin.agent.update'))}
      {button('owner', t('dashboard.admin.agent.owner'))}
      {status === 'active' && button('recertify', t('dashboard.admin.agent.recertify'))}
      {!stopped && button('suspend', t('dashboard.admin.agent.suspend'), true)}
      {status !== 'quarantined' &&
        button('quarantine', t('dashboard.admin.agent.quarantine'), true)}
    </div>
  );
}

function Facts({ agent, owner }: { readonly agent: AgentDetailView; readonly owner: string }) {
  const evaluation = agent.evaluation ?? null;
  return (
    <section class="admin-section" aria-labelledby="agent-facts">
      <h2 id="agent-facts">{t('dashboard.admin.agent.details')}</h2>
      <dl class="admin-facts">
        <dt>{t('dashboard.admin.field.agent_version')}</dt>
        <dd class="code">{agent.version}</dd>
        <dt>{t('dashboard.admin.field.owner')}</dt>
        <dd>
          <Txt value={owner} />
        </dd>
        <dt>{t('dashboard.admin.field.model')}</dt>
        <dd class="code">
          <Txt value={agent.model_ref} />
        </dd>
        <dt>{t('dashboard.admin.field.instructions')}</dt>
        <dd class="code">
          <Txt value={agent.instructions_ref} />
          <span class="sub hash-value">{agent.instructions_sha256}</span>
        </dd>
        {agent.root_instructions_ref ? (
          <>
            <dt>{t('dashboard.admin.field.root_instructions')}</dt>
            <dd class="code">
              <Txt value={agent.root_instructions_ref} />
            </dd>
          </>
        ) : null}
        <dt>{t('dashboard.admin.field.tools')}</dt>
        <dd class="code">
          {agent.allowed_tools.length === 0 ? '—' : agent.allowed_tools.join(', ')}
        </dd>
        <dt>{t('dashboard.admin.field.autonomy')}</dt>
        <dd class="code">{agent.max_autonomy}</dd>
        <dt>{t('dashboard.admin.field.environments')}</dt>
        <dd class="code">{agent.approved_environments.join(', ')}</dd>
        <dt>{t('dashboard.admin.field.adapter')}</dt>
        <dd class="code">
          <Txt value={agent.adapter} />
        </dd>
        <dt>{t('dashboard.admin.col.recertification')}</dt>
        <dd>
          {agent.overdue ? (
            <span class="chip chip-alert">{t('dashboard.admin.agent.overdue')}</span>
          ) : (
            <Txt value={agent.recertification_due_on} />
          )}
        </dd>
        <dt>{t('dashboard.admin.agent.evaluation')}</dt>
        <dd>
          {evaluation === null ? (
            '—'
          ) : (
            <>
              <span class="code">
                <Txt value={evaluation.code} />
              </span>{' '}
              <span class={`chip ${evaluation.qualifies ? 'admin-status-active' : 'chip-warn'}`}>
                <Txt value={evaluation.result ?? evaluation.mode} />
              </span>
            </>
          )}
        </dd>
      </dl>
    </section>
  );
}

function Rounds({
  rounds,
  name,
}: {
  readonly rounds: readonly AgentRoundView[];
  readonly name: (id: string) => string;
}) {
  return (
    <section class="admin-section" aria-labelledby="agent-rounds">
      <h2 id="agent-rounds">{t('dashboard.admin.agent.rounds')}</h2>
      <p class="muted">{t('dashboard.admin.agent.rounds_hint')}</p>
      <div class="admin-rounds">
        {rounds.map((round) => (
          <article key={round.purpose} class="admin-round" aria-label={round.purpose}>
            <h3 class="code">{round.purpose}</h3>
            <p>
              {round.completed
                ? t('dashboard.admin.agent.round_done')
                : t('dashboard.admin.agent.round_missing', {
                    missing: round.missing.join(', ') || '—',
                  })}
            </p>
            {round.approvals.length > 0 && (
              <ul class="admin-list">
                {round.approvals.map((a) => (
                  <li key={a.id}>
                    <span class="code">{a.capacity}</span>
                    <Txt value={name(a.approver_id)} />
                    <span class="muted">
                      <When iso={a.created_at} />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}

function AgentDialog({
  dialog,
  data,
  onClose,
  onDone,
}: {
  readonly dialog: Exclude<Dialog, null>;
  readonly data: Loaded;
  readonly onClose: () => void;
  readonly onDone: (notice?: string) => void;
}) {
  const key = data.agent.key;
  if (dialog === 'update') return <UpdateAgent data={data} onClose={onClose} onDone={onDone} />;
  if (dialog === 'approve') return <Approve data={data} onClose={onClose} onDone={onDone} />;
  if (dialog === 'owner') return <Owner data={data} onClose={onClose} onDone={onDone} />;
  if (dialog === 'recertify') return <Recertify agentKey={key} onClose={onClose} onDone={onDone} />;
  return <Stop agentKey={key} to={dialog} onClose={onClose} onDone={onDone} />;
}

interface DialogProps {
  readonly data: Loaded;
  readonly onClose: () => void;
  readonly onDone: (notice?: string) => void;
}

function UpdateAgent({ data, onClose, onDone }: DialogProps) {
  const form = useAgentForm(data.agent);
  return (
    <ChangeDialog
      id="update-agent"
      title={t('dashboard.admin.agent.update')}
      summary={t('dashboard.admin.agent.update_summary')}
      onClose={onClose}
      onConfirm={async () => {
        const changed = agentChanges(data.agent, form.values);
        if (changed === null) return 'dashboard.admin.error.no_change';
        if ('error' in changed) return changed.error;
        await updateAgent(data.agent.key, changed.body, confirmAdminChange);
        onDone();
      }}
    >
      <AgentFields form={form} />
    </ChangeDialog>
  );
}

function Approve({ data, onClose, onDone }: DialogProps) {
  const open = data.agent.rounds.filter((r) => !r.completed).map((r) => r.purpose);
  const [purpose, setPurpose] = useState(open[0] ?? 'activate');
  const [capacity, setCapacity] = useState<string>(APPROVER_CAPACITIES[0]);
  const [evaluation, setEvaluation] = useState('');
  return (
    <ChangeDialog
      id="approve-agent"
      title={t('dashboard.admin.agent.approve')}
      summary={t('dashboard.admin.agent.approve_summary', { key: data.agent.key })}
      onClose={onClose}
      onConfirm={async () => {
        const checked = checkApproval({ purpose, capacity, evaluation });
        if ('error' in checked) return checked.error;
        const round = await approveAgent(data.agent.key, checked.body, confirmAdminChange);
        onDone(
          round.completed
            ? t('dashboard.admin.agent.round_done')
            : t('dashboard.admin.agent.round_missing', { missing: round.missing.join(', ') }),
        );
      }}
    >
      <div class="field">
        <label for="approve-purpose">{t('dashboard.admin.field.purpose')}</label>
        <select
          id="approve-purpose"
          value={purpose}
          onChange={(e) => setPurpose(e.currentTarget.value)}
        >
          {['activate', 'retire'].map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </div>
      <div class="field">
        <label for="approve-capacity">{t('dashboard.admin.field.capacity')}</label>
        <select
          id="approve-capacity"
          value={capacity}
          onChange={(e) => setCapacity(e.currentTarget.value)}
        >
          {APPROVER_CAPACITIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>
      <TextField
        id="approve-evaluation"
        label={t('dashboard.admin.field.evaluation')}
        value={evaluation}
        onInput={setEvaluation}
        hint={t('dashboard.admin.hint.evaluation')}
        maxLength={20}
      />
    </ChangeDialog>
  );
}

function Owner({ data, onClose, onDone }: DialogProps) {
  const active = data.users?.filter((u) => u.status === 'active') ?? null;
  const [owner, setOwner] = useState(active?.[0]?.id ?? '');
  return (
    <ChangeDialog
      id="agent-owner"
      title={t('dashboard.admin.agent.owner')}
      onClose={onClose}
      onConfirm={async () => {
        if (!UUID.test(owner)) return 'dashboard.admin.error.owner';
        await changeAgentOwner(data.agent.key, owner, confirmAdminChange);
        onDone();
      }}
    >
      {active === null ? (
        <TextField
          id="new-owner"
          label={t('dashboard.admin.field.owner_id')}
          value={owner}
          onInput={setOwner}
          maxLength={36}
        />
      ) : (
        <div class="field">
          <label for="new-owner">{t('dashboard.admin.field.owner')}</label>
          <select id="new-owner" value={owner} onChange={(e) => setOwner(e.currentTarget.value)}>
            {active.map((u) => (
              <option key={u.id} value={u.id}>
                {u.display_name}
              </option>
            ))}
          </select>
        </div>
      )}
    </ChangeDialog>
  );
}

function Recertify({
  agentKey,
  onClose,
  onDone,
}: {
  readonly agentKey: string;
  readonly onClose: () => void;
  readonly onDone: (notice?: string) => void;
}) {
  const [evaluation, setEvaluation] = useState('');
  return (
    <ChangeDialog
      id="recertify-agent"
      title={t('dashboard.admin.agent.recertify')}
      summary={t('dashboard.admin.agent.recertify_summary')}
      onClose={onClose}
      onConfirm={async () => {
        const code = evaluation.trim();
        if (code !== '' && !/^EVAL-[0-9]{4}-[0-9]{4,9}$/.test(code)) {
          return 'dashboard.admin.error.evaluation';
        }
        await recertifyAgent(
          agentKey,
          code === '' ? {} : { evaluation_code: code },
          confirmAdminChange,
        );
        onDone(t('dashboard.admin.agent.recertified'));
      }}
    >
      <TextField
        id="recertify-evaluation"
        label={t('dashboard.admin.field.evaluation')}
        value={evaluation}
        onInput={setEvaluation}
        hint={t('dashboard.admin.hint.evaluation')}
        maxLength={20}
      />
    </ChangeDialog>
  );
}

function Stop({
  agentKey,
  to,
  onClose,
  onDone,
}: {
  readonly agentKey: string;
  readonly to: 'suspend' | 'quarantine';
  readonly onClose: () => void;
  readonly onDone: (notice?: string) => void;
}) {
  const [reason, setReason] = useState<string>(AGENT_STATUS_REASONS[0]);
  const suspend = to === 'suspend';
  return (
    <ChangeDialog
      id="stop-agent"
      title={suspend ? t('dashboard.admin.agent.suspend') : t('dashboard.admin.agent.quarantine')}
      summary={
        suspend
          ? t('dashboard.admin.agent.suspend_summary', { key: agentKey })
          : t('dashboard.admin.agent.quarantine_summary', { key: agentKey })
      }
      danger
      onClose={onClose}
      onConfirm={async () => {
        await (suspend ? suspendAgent : quarantineAgent)(agentKey, reason, confirmAdminChange);
        onDone();
      }}
    >
      <div class="field">
        <label for="stop-reason">{t('dashboard.admin.field.reason')}</label>
        <select id="stop-reason" value={reason} onChange={(e) => setReason(e.currentTarget.value)}>
          {AGENT_STATUS_REASONS.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </div>
    </ChangeDialog>
  );
}
