// One intent (U01 AC4): where it stands, who decides its gate, its decisions, runs, open
// escalations and evidence packs. Downloads read the pack files through the API (GET). U08: submit
// the plan, build a pack, and the CLI command for an L1 run's proposal (`IntakeActions`).
import type { EvidencePackView, IntentDetail as Detail } from '@sdlc/api-schemas';
import { cleanText } from '@sdlc/api-schemas';
import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';

import { ApiError } from '../api/client.js';
import { killRun } from '../api/writes.js';
import {
  readIntent,
  readOpenEscalations,
  readPackFile,
  readPacks,
  readRuns,
} from '../api/reads.js';
import { useApi } from '../api/use-api.js';
import { DecisionModal } from '../components/DecisionModal.js';
import { BuildPack, ProposalCommand, SubmitPlan } from '../components/IntakeActions.js';
import {
  codeClass,
  Due,
  Label,
  Duration,
  Empty,
  ErrorMessage,
  GateTrack,
  Show,
  Txt,
  When,
} from '../components/common.js';
import { t } from '../i18n.js';
import { modeMeaning, roleName } from '../labels.js';
import { actionErrorText } from '../model/decisions.js';
import { escalationRows } from '../model/escalations.js';
import { holdOf } from '../model/hold.js';
import { intentLinks } from '../model/intents.js';
import { roundUsd } from '../model/numbers.js';
import { secondsSince } from '../model/time.js';
import { adminHoldHref, href } from '../router.js';
import { session } from '../session.js';

export function IntentDetail({ code }: { readonly code: string }) {
  const { result, reload } = useApi(
    async (signal) => {
      const [intent, runs, escalations] = await Promise.all([
        readIntent(code, { signal }),
        readRuns(code, { signal }),
        readOpenEscalations(code, { signal }),
      ]);
      // Evidence needs its own role (`access.evidence_read_roles`): a refusal hides the section.
      const packs = await readPacks(code, { signal }).catch((error: unknown) => {
        if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
          return null;
        }
        throw error;
      });
      return { intent, runs, escalations, packs };
    },
    [code],
  );

  // U08: the message of a plan submitted or a pack built, kept above the data loaded again.
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => setNotice(null), [code]);
  const done = (message: string) => {
    setNotice(message);
    reload();
  };

  const handleKillRun = (runId: string) => {
    if (!window.confirm(t('dashboard.action.kill_confirm'))) return;
    void killRun(runId)
      .then(() => {
        reload();
      })
      .catch((err: unknown) => {
        alert(actionErrorText(err));
      });
  };

  return (
    <section class="screen" aria-labelledby="intent-title">
      <p class="crumbs">
        <a href={href('intents')}>{t('dashboard.nav.intents')}</a> /{' '}
        <span class="mono">{code}</span>
      </p>
      {notice !== null && (
        <p class="notice notice-success" role="status">
          {notice}
        </p>
      )}
      <Show loaded={result}>
        {({ intent, runs, escalations, packs }, at) => (
          <>
            <Head intent={intent} at={at} reload={reload} />
            <div class="detail-grid">
              <div class="detail-stack">
                <DecidedBy intent={intent} at={at} reload={reload} />
                <HeldBy intent={intent} at={at} />
              </div>
              <Facts intent={intent} />
            </div>
            <section aria-labelledby="esc-title" class="panel">
              <h2 id="esc-title">{t('dashboard.detail.escalations')}</h2>
              {escalations.items.length === 0 ? (
                <Empty messageKey="dashboard.detail.no_escalations" />
              ) : (
                <ul class="plain-list">
                  {escalationRows(escalations.items, at).map((row) => (
                    <li
                      key={row.escalation.id}
                      class={`esc-line ${codeClass('sev', row.escalation.severity)}`}
                    >
                      <span class="mono">
                        <Txt value={row.escalation.code} />
                      </span>
                      <span class="chip">
                        <Txt value={row.escalation.severity} />
                      </span>
                      <span>{roleName(row.escalation.step_role)}</span>
                      <Due iso={row.due} now={at} />
                      {row.escalation.freezes_intent && (
                        <span class="chip chip-warn">{t('dashboard.board.frozen')}</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <SpecAndPlan intent={intent} onDone={done} />
            <Decisions intent={intent} />
            <section aria-labelledby="runs-title" class="panel">
              <h2 id="runs-title">{t('dashboard.detail.runs')}</h2>
              {runs.items.length === 0 ? (
                <Empty messageKey="dashboard.detail.no_runs" />
              ) : (
                <div class="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">{t('dashboard.col.attempt')}</th>
                        <th scope="col">{t('dashboard.col.status')}</th>
                        <th scope="col">{t('dashboard.col.stop_reason')}</th>
                        <th scope="col">{t('dashboard.col.iterations')}</th>
                        <th scope="col">{t('dashboard.col.started')}</th>
                        <th scope="col">{t('dashboard.col.finished')}</th>
                        {session.actions() && <th scope="col">{t('dashboard.action.kill_run')}</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {runs.items.map((run) => (
                        <tr key={run.id}>
                          <th scope="row" class="num">
                            {run.attempt}
                          </th>
                          <td>
                            <span class="chip">
                              <Txt value={run.status} />
                            </span>
                          </td>
                          <td class="mono">
                            <Txt value={run.stop_reason} />
                          </td>
                          <td class="num">{run.iterations}</td>
                          <td>
                            <When iso={run.started_at} />
                          </td>
                          <td>
                            <When iso={run.finished_at} />
                          </td>
                          {session.actions() && (
                            <td>
                              {run.status === 'provisioning' || run.status === 'running' ? (
                                <button
                                  type="button"
                                  class="button button-danger button-small"
                                  onClick={() => handleKillRun(run.id)}
                                >
                                  {t('dashboard.action.kill_run')}
                                </button>
                              ) : (
                                '-'
                              )}
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <LatestProposal intent={intent.code} runs={runs.items} />
            </section>
            {packs !== null && <Packs code={intent.code} packs={packs.packs} onDone={done} />}
          </>
        )}
      </Show>
    </section>
  );
}

function Head({ intent, at, reload }: { intent: Detail; at: Date; reload: () => void }) {
  const links = intentLinks(intent);
  return (
    <header class="detail-head">
      <div>
        <h1 id="intent-title">
          <span class="mono detail-code">
            <Txt value={intent.code} />
          </span>
          <Txt value={intent.title} />
        </h1>
        <GateTrack intent={intent} />
      </div>
      <div class="toolbar">
        {links.issue && (
          <a
            class="button button-quiet"
            href={links.issue}
            target="_blank"
            rel="noopener noreferrer"
          >
            {t('dashboard.link.issue', { number: intent.issue_number ?? '' })}
          </a>
        )}
        {links.pullRequest && (
          <a
            class="button button-quiet"
            href={links.pullRequest}
            target="_blank"
            rel="noopener noreferrer"
          >
            {t('dashboard.link.pull_request', { number: intent.pr_number ?? '' })}
          </a>
        )}
        <button type="button" class="button button-quiet" onClick={reload}>
          {t('dashboard.refresh')}
        </button>
        <span class="asof">
          {t('dashboard.as_of')} <time dateTime={at.toISOString()}>{at.toLocaleTimeString()}</time>
        </span>
      </div>
    </header>
  );
}

/** `waiting_for` (QUESTIONS #261): who decides the current gate, as the workflow resolves it. */
function DecidedBy({ intent, at, reload }: { intent: Detail; at: Date; reload: () => void }) {
  const w = intent.waiting_for;
  const [activeDecision, setActiveDecision] = useState<
    'approve' | 'reject' | 'request_changes' | null
  >(null);
  const links = intentLinks(intent);
  const canAct = session.actions();

  return (
    <section class="panel panel-focus" aria-labelledby="decided-title">
      <h2 id="decided-title">{t('dashboard.detail.decided_by')}</h2>
      {w === null ? (
        <p class="muted">
          {t('dashboard.detail.decided_by_none', { status: cleanText(intent.status) })}
        </p>
      ) : (
        <>
          <p class="big-gate">
            <span class="mono">
              <Txt value={w.gate} />
            </span>
            <span class={`chip ${codeClass('mode', w.mode)}`}>
              <Txt value={w.mode} />
            </span>
          </p>
          <p>{modeMeaning(w.mode)}</p>
          {w.roles.length > 0 && (
            <p>
              {t(w.mode === 'HITL' ? 'dashboard.detail.approvers' : 'dashboard.detail.told', {
                roles: w.roles.map(roleName).join(', '),
                count: w.approvals_needed,
              })}
            </p>
          )}
          <p class="waited">
            {t('dashboard.detail.waited')}{' '}
            <Duration seconds={secondsSince(intent.gate_entered_at, at)} />
          </p>
          <p class="hint">{t('dashboard.detail.decided_by_hint')}</p>

          {w.gate === 'G7' ? (
            links.pullRequest ? (
              <p class="gate-actions">
                <a
                  class="button button-primary"
                  href={links.pullRequest}
                  target="_blank"
                  rel="noreferrer"
                >
                  {t('dashboard.action.g7_pr_notice')} #{intent.pr_number} ↗
                </a>
              </p>
            ) : null
          ) : (
            canAct && (
              <div class="gate-actions">
                <button
                  type="button"
                  class="button button-primary"
                  onClick={() => setActiveDecision('approve')}
                >
                  {t('dashboard.action.approve')}
                </button>
                <button
                  type="button"
                  class="button button-quiet"
                  onClick={() => setActiveDecision('request_changes')}
                >
                  {t('dashboard.action.request_changes')}
                </button>
                <button
                  type="button"
                  class="button button-danger"
                  onClick={() => setActiveDecision('reject')}
                >
                  {t('dashboard.action.reject')}
                </button>
              </div>
            )
          )}

          {activeDecision && (
            <DecisionModal
              intent={intent}
              gate={w.gate}
              mode={w.mode}
              decision={activeDecision}
              onClose={() => setActiveDecision(null)}
              onSuccess={() => {
                setActiveDecision(null);
                reload();
              }}
            />
          )}
        </>
      )}
    </section>
  );
}

/** U02 (ADR-M54 §2.4b): what holds the intent, as the workflow's step recorded it. */
function HeldBy({ intent, at }: { intent: Detail; at: Date }) {
  const hold = holdOf(intent);
  return (
    <section class={`panel ${hold ? 'panel-hold' : 'panel-quiet'}`} aria-labelledby="held-title">
      <h2 id="held-title">{t('dashboard.detail.held_by')}</h2>
      {hold === null ? (
        <p class="muted">{t('dashboard.detail.held_none')}</p>
      ) : (
        <>
          <p class="hold-reason">
            <Label value={hold.reason} />
            {hold.cause && (
              <>
                {': '}
                <Label value={hold.cause} />
              </>
            )}
          </p>
          <p>
            {t('dashboard.detail.held_since')} <Duration seconds={secondsSince(hold.since, at)} />
            {hold.until && Date.parse(hold.until) > at.getTime() && (
              <>
                {' · '}
                {t('dashboard.detail.held_until')} <When iso={hold.until} />
              </>
            )}
          </p>
        </>
      )}
    </section>
  );
}

function Facts({ intent }: { intent: Detail }) {
  const rows: [string, ComponentChildren][] = [
    [t('dashboard.col.project'), <Txt value={intent.project.slug} />],
    [t('dashboard.col.status'), <Txt value={intent.status} />],
    [t('dashboard.col.risk'), <Txt value={intent.risk_tier} />],
    [t('dashboard.col.data_class'), <Txt value={intent.data_class} />],
    [t('dashboard.col.autonomy'), <Txt value={intent.max_autonomy} />],
    [t('dashboard.col.budget'), `$${cleanText(roundUsd(intent.budget_usd))}`],
    [t('dashboard.col.created'), <When iso={intent.created_at} />],
    [
      t('dashboard.col.plan_flags'),
      intent.plan === null || intent.plan.change_flags.length === 0
        ? '—'
        : intent.plan.change_flags.map((f) => cleanText(f)).join(', '),
    ],
  ];
  return (
    <section class="panel" aria-labelledby="facts-title">
      <h2 id="facts-title">{t('dashboard.detail.facts')}</h2>
      <dl class="facts">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {intent.description !== '' && (
        <p class="description">
          <Txt value={intent.description} />
        </p>
      )}
    </section>
  );
}

function Decisions({ intent }: { intent: Detail }) {
  return (
    <section aria-labelledby="decisions-title" class="panel">
      <h2 id="decisions-title">{t('dashboard.detail.decisions')}</h2>
      {intent.decisions.length === 0 ? (
        <Empty messageKey="dashboard.detail.no_decisions" />
      ) : (
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">{t('dashboard.col.when')}</th>
                <th scope="col">{t('dashboard.col.gate')}</th>
                <th scope="col">{t('dashboard.col.decision')}</th>
                <th scope="col">{t('dashboard.col.mode')}</th>
                <th scope="col">{t('dashboard.col.role')}</th>
                <th scope="col">{t('dashboard.col.reason')}</th>
              </tr>
            </thead>
            <tbody>
              {[...intent.decisions].reverse().map((d) => (
                <tr key={d.id}>
                  <td>
                    <When iso={d.created_at} />
                  </td>
                  <th scope="row" class="mono">
                    <Txt value={d.gate} />
                  </th>
                  <td>
                    <span class={`chip ${codeClass('decision', d.decision)}`}>
                      <Txt value={d.decision} />
                    </span>
                  </td>
                  <td class="mono">
                    <Txt value={d.oversight_mode} />
                  </td>
                  <td>
                    {d.actor_type === 'system'
                      ? t('dashboard.actor.system')
                      : roleName(d.approver_role)}
                  </td>
                  <td>
                    {d.reason_ref !== null && /^https:\/\//.test(d.reason_ref) ? (
                      <a href={d.reason_ref} target="_blank" rel="noopener noreferrer">
                        <Txt value={d.reason_code ?? t('dashboard.detail.reason_link')} />
                      </a>
                    ) : (
                      <span class="mono">
                        <Txt value={d.reason_code} />
                      </span>
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

/** An L1 run left a proposal: the page shows the CLI command that saves it (ADR-M64). */
function LatestProposal({
  intent,
  runs,
}: {
  intent: string;
  runs: readonly { readonly id: string; readonly status: string }[];
}) {
  const run = runs.filter((r) => r.status === 'succeeded_proposal_only').at(-1);
  return run === undefined ? null : <ProposalCommand intent={intent} runId={run.id} />;
}

function Packs({
  code,
  packs,
  onDone,
}: {
  code: string;
  packs: readonly EvidencePackView[];
  onDone: (message: string) => void;
}) {
  const [error, setError] = useState<ApiError | null>(null);
  const download = async (version: number, file: 'manifest' | 'markdown') => {
    setError(null);
    try {
      const { file: body } = await readPackFile(code, version, file);
      const blob = new Blob([body.content], { type: body.media_type });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${code}-v${body.version}-${body.name}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught : new ApiError(0, 'unexpected'));
    }
  };
  return (
    <section aria-labelledby="packs-title" class="panel">
      <h2 id="packs-title">{t('dashboard.detail.packs')}</h2>
      {session.actions() && <BuildPack intent={code} onDone={onDone} />}
      <p class="muted">
        <a href={adminHoldHref(code)}>{t('dashboard.detail.evidence_hold')}</a>
      </p>
      {error && <ErrorMessage error={error} />}
      {packs.length === 0 ? (
        <Empty messageKey="dashboard.detail.no_packs" />
      ) : (
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">{t('dashboard.col.version')}</th>
                <th scope="col">{t('dashboard.col.built')}</th>
                <th scope="col">{t('dashboard.col.items')}</th>
                <th scope="col">{t('dashboard.col.sealed')}</th>
                <th scope="col">{t('dashboard.col.files')}</th>
              </tr>
            </thead>
            <tbody>
              {[...packs].reverse().map((pack) => (
                <tr key={pack.id}>
                  <th scope="row" class="num">
                    v{pack.version}
                  </th>
                  <td>
                    <When iso={pack.built_at} />
                  </td>
                  <td class="num">{pack.item_count}</td>
                  <td>
                    {pack.sealed_at ? <When iso={pack.sealed_at} /> : <span class="muted">—</span>}
                  </td>
                  <td>
                    {pack.purged_at !== null ? (
                      <span class="muted">{t('dashboard.detail.purged')}</span>
                    ) : (
                      <span class="button-row">
                        <button
                          type="button"
                          class="button button-quiet"
                          onClick={() => void download(pack.version, 'markdown')}
                        >
                          {t('dashboard.detail.download_markdown')}
                        </button>
                        <button
                          type="button"
                          class="button button-quiet"
                          onClick={() => void download(pack.version, 'manifest')}
                        >
                          {t('dashboard.detail.download_manifest')}
                        </button>
                      </span>
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

function SpecAndPlan({ intent, onDone }: { intent: Detail; onDone: (message: string) => void }) {
  const spec = intent.spec;
  const plan = intent.plan;

  return (
    <section class="panel" aria-labelledby="spec-plan-title">
      <h2 id="spec-plan-title">{t('dashboard.detail.spec_and_plan')}</h2>
      <div class="field-row">
        <div class="panel panel-quiet">
          <h3>{t('dashboard.detail.spec_title')}</h3>
          {spec === null ? (
            <p class="muted">{t('dashboard.detail.no_spec')}</p>
          ) : (
            <dl class="facts">
              <div>
                <dt>{t('dashboard.detail.file_path')}</dt>
                <dd class="mono">{cleanText(spec.path)}</dd>
              </div>
              <div>
                <dt>{t('dashboard.detail.acceptance_criteria')}</dt>
                <dd>
                  <span class="chip chip-success">
                    {spec.acceptance_criteria !== null ? `${spec.acceptance_criteria}` : '—'}
                  </span>
                </dd>
              </div>
              <div>
                <dt>{t('dashboard.detail.structure')}</dt>
                <dd class="mono">{spec.structure ? cleanText(spec.structure) : '—'}</dd>
              </div>
              <div>
                <dt>{t('dashboard.detail.content_hash')}</dt>
                <dd class="mono hash-value">{cleanText(spec.content_sha256)}</dd>
              </div>
              <div>
                <dt>{t('dashboard.detail.commit_sha')}</dt>
                <dd class="mono small-value">{cleanText(spec.commit_sha)}</dd>
              </div>
            </dl>
          )}
        </div>

        <div class="panel panel-quiet">
          <h3>{t('dashboard.detail.plan_title')}</h3>
          {plan === null ? (
            <p class="muted">{t('dashboard.detail.no_plan')}</p>
          ) : (
            <dl class="facts">
              <div>
                <dt>{t('dashboard.detail.plan_version')}</dt>
                <dd class="mono">v{plan.version}</dd>
              </div>
              <div>
                <dt>{t('dashboard.action.plan_hash')}</dt>
                <dd class="mono hash-value">{cleanText(plan.plan_sha256)}</dd>
              </div>
              <div>
                <dt>{t('dashboard.detail.change_flags')}</dt>
                <dd>
                  {plan.change_flags.length === 0 ? (
                    '—'
                  ) : (
                    <div class="chip-row">
                      {plan.change_flags.map((flag) => (
                        <span key={flag} class="chip chip-warn">
                          {cleanText(flag)}
                        </span>
                      ))}
                    </div>
                  )}
                </dd>
              </div>
            </dl>
          )}
          {session.actions() && <SubmitPlan intent={intent.code} onDone={onDone} />}
        </div>
      </div>
    </section>
  );
}
