// Posting the gate status comments (D-02 FR-22, D-08 B07, design/ADR-M30 §2.5). The intent
// workflow records one notice per status change (`intent_notices`); the poller posts it after its
// replies and escalation notices, on the intent's issue.
//
// - The comment confirms a successful comment command (ADR-M27 §2.4): it names the decision and the
//   people who decided. It mentions the holders of the roles that act next (HOTL: the people told).
//   Logins are read when the comment is posted and never stored.
// - Delivery follows the reply rules of ADR-M27 §2.4: at least once, after the commit, retried on
//   the next polls, given up after `maxAttempts`. A notice of an intent with no issue is given up
//   at once (logged): there is nowhere to post it.
import type { GateCode, RepoRef } from '@sdlc/contracts';
import { GitHostError } from '@sdlc/contracts';
import { t, type MessageKey } from '@sdlc/messages';

import { isCommandGate } from '../commands/gate-input.js';
import type { GateDecisionRow, Intent, IntentNotice } from '../db/schema.js';
import type { TenantScope } from '../db/tenant-scope.js';
import { loadEffectiveConfig } from '../registry/effective-config.js';
import { decisionRecordedAt } from '../workflow/gate-history.js';
import { blockWindowEnd } from '../workflow/hotl.js';
import { mentionsFor, type NoticeDeps } from './escalation-notices.js';

export type IntentNoticeLogEvent =
  | 'status_notice.posted'
  | 'status_notice.failed'
  | 'status_notice.abandoned'
  | 'status_notice.no_issue'
  | 'status_notice.bookkeeping_failed';

export interface IntentNoticeDeps extends Omit<NoticeDeps, 'log'> {
  readonly log: (
    level: 'info' | 'warn' | 'error',
    event: IntentNoticeLogEvent,
    fields: Readonly<Record<string, string | number | boolean>>,
  ) => void;
}

/** GitHub logins: letters, digits and single hyphens, at most 39 characters. */
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

const GATE_NAME_KEYS: Readonly<Record<GateCode, MessageKey>> = {
  G1: 'gate.name.g1',
  G2: 'gate.name.g2',
  G3: 'gate.name.g3',
  G4: 'gate.name.g4',
  G5: 'gate.name.g5',
  G6: 'gate.name.g6',
  G7: 'gate.name.g7',
  G8: 'gate.name.g8',
};

/** Catalog key of a notice (tested: every kind has one). */
export function intentNoticeKey(notice: Pick<IntentNotice, 'kind' | 'gate'>): MessageKey {
  switch (notice.kind) {
    case 'submitted':
      return 'intent.status.submitted';
    case 'rejected':
      return 'intent.status.rejected';
    case 'changes_requested':
      return 'intent.status.changes_requested';
    case 'hotl_passed':
      return 'intent.status.hotl_passed';
    case 'returned':
      return 'intent.status.returned';
    case 'ai_record_refused':
      return 'intent.status.ai_record_refused';
    case 'g4_refused':
      return 'intent.status.g4_refused';
    case 'blocked':
      return 'intent.status.blocked';
    case 'run_proposed':
      return 'intent.status.run_proposed';
    case 'agent_recertification_due':
      return 'intent.status.agent_recertification_due';
    case 'run_started':
      return 'intent.status.run_started';
    case 'run_finished':
      return 'intent.status.run_finished';
    case 'run_failed':
      return 'intent.status.run_failed';
    case 'run_not_started':
      return 'intent.status.run_not_started';
    case 'run_resumed':
      return 'intent.status.run_resumed';
    case 'proposal_ready':
      return 'intent.status.proposal_ready';
    case 'budget_warning':
      return 'intent.status.budget_warning';
    case 'scope_returned':
      return 'intent.status.scope_returned';
    case 'g5_breach':
      return 'intent.status.g5_breach';
    case 'g5_returned':
      return 'intent.status.g5_returned';
    case 'terminated':
      if (notice.gate === 'G8') return 'intent.status.g8_terminated';
      if (notice.gate === 'G7') return 'intent.status.g7_terminated';
      if (notice.gate === 'G6') return 'intent.status.g6_terminated';
      // C11: `terminate` on the escalation of a failed or killed run (paused at G4).
      return notice.gate === 'G4' ? 'intent.status.run_terminated' : 'intent.status.terminated';
    case 'spec_changed':
      return 'intent.status.spec_changed';
    case 'spec_unavailable':
      return 'intent.status.spec_unavailable';
    case 'spec_unclear':
      return 'intent.status.spec_unclear';
    case 'plan_changed':
      return 'intent.status.plan_changed';
    case 'plan_resubmit_needed':
      return 'intent.status.plan_resubmit_needed';
    case 'pr_opened':
      return 'intent.status.pr_opened';
    case 'g6_publish_stopped':
      return 'intent.status.g6_publish_stopped';
    case 'g6_returned':
      return 'intent.status.g6_returned';
    case 'ci_retry':
      return 'intent.status.ci_retry';
    case 'ci_returned':
      return 'intent.status.ci_returned';
    case 'g6_decision':
      return 'intent.status.g6_decision';
    case 'g6_escalated':
      return 'intent.status.g6_escalated';
    case 'g6_resumed':
      return 'intent.status.g6_resumed';
    case 'g7_review_needed':
      return 'intent.status.g7_review_needed';
    case 'g7_changes_requested':
      return 'intent.status.g7_changes_requested';
    case 'g7_merge_ready':
      return 'intent.status.g7_merge_ready';
    case 'g7_escalated':
      return 'intent.status.g7_escalated';
    case 'g7_returned':
      return 'intent.status.g7_returned';
    case 'g7_resumed':
      return 'intent.status.g7_resumed';
    case 'merged':
      return 'intent.status.merged';
    case 'run_killed':
      return 'intent.status.run_killed';
    case 'run_returned':
      return 'intent.status.run_returned';
    case 'g8_review_needed':
      return 'intent.status.g8_review_needed';
    case 'g8_changes_requested':
      return 'intent.status.g8_changes_requested';
    case 'g8_refused':
      return 'intent.status.g8_refused';
    case 'g8_escalated':
      return 'intent.status.g8_escalated';
    case 'g8_resumed':
      return 'intent.status.g8_resumed';
    case 'released':
      return 'intent.status.released';
    default:
      return notice.gate !== null && isCommandGate(notice.gate)
        ? 'intent.status.advanced'
        : 'intent.status.advanced_platform';
  }
}

export interface IntentNoticeView {
  readonly code: string;
  readonly deciders: readonly string[];
  readonly mentions: readonly string[];
  readonly reasonCode: string | null;
  /** HOTL pass: when its block window closes (UTC). */
  readonly windowEnd?: Date | null;
  /** C06: the agent key (run proposal, recertification warning). */
  readonly agentKey?: string | null;
  /** C06: the base commit of the run proposal, short form. */
  readonly baseSha?: string | null;
  /** C07: the budget warning's share of the run's cap, from the run event `budget_warning`. */
  readonly percent?: number | null;
  /**
   * E03 (ADR-M49 §2.6, QUESTIONS #222): the project's disclosure format is `client_format`; the
   * link to the human AI record, where the client's note is written.
   */
  readonly clientRecordRef?: string | null;
  /** X08b (ADR-M109 §2.3): `released` invites lessons for this many days after the close. */
  readonly lessonWindowDays?: number | null;
}

/** `YYYY-MM-DD HH:MM UTC`: the same text whatever the reader's locale. */
export function formatUtcMinute(at: Date): string {
  return `${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** The Markdown body of one status comment. A hidden marker names the intent and the notice. */
export function renderIntentNotice(
  notice: Pick<IntentNotice, 'id' | 'kind' | 'gate' | 'previous_gate'>,
  view: IntentNoticeView,
  locale?: string,
): string {
  const nobody = t('intent.status.nobody', {}, locale);
  const gate = notice.gate ?? '—';
  const body = t(
    intentNoticeKey(notice),
    {
      code: view.code,
      gate,
      gate_name: notice.gate === null ? '—' : t(GATE_NAME_KEYS[notice.gate], {}, locale),
      previous_gate: notice.previous_gate ?? '—',
      deciders: view.deciders.length > 0 ? view.deciders.join(', ') : nobody,
      mentions:
        view.mentions.length > 0
          ? view.mentions.join(' ')
          : t('escalation.notice.nobody', {}, locale),
      reason: view.reasonCode ?? 'other',
      window_end: view.windowEnd ? formatUtcMinute(view.windowEnd) : '—',
      lesson_days: view.lessonWindowDays ?? '—',
      agent: view.agentKey ?? '—',
      base_sha: view.baseSha ?? '—',
      percent: view.percent ?? '—',
      client_note:
        view.clientRecordRef === undefined || view.clientRecordRef === null
          ? ''
          : t('intent.status.g8_client_note', { record_ref: view.clientRecordRef }, locale),
    },
    locale,
  );
  const footer = t('intent.status.footer', {}, locale);
  return `${body}\n\n${footer}\n\n<!-- sdlc-status ${view.code} ${notice.kind} ${gate} ${notice.id} -->`;
}

/** `@login` of a user's GitHub identities, when the user is active. */
async function loginsOf(scope: TenantScope, userId: string | null): Promise<string[]> {
  if (userId === null) return [];
  const user = await scope.users.getById(userId);
  if (user?.status !== 'active') return [];
  return (await scope.userIdentities.listForUser(userId))
    .filter((i) => i.provider === 'github' && GITHUB_LOGIN.test(i.external_login))
    .map((i) => `@${i.external_login}`)
    .sort();
}

async function viewOf(
  scope: TenantScope,
  intent: Intent,
  notice: IntentNotice,
): Promise<IntentNoticeView> {
  const decision: GateDecisionRow | undefined =
    notice.decision_id === null ? undefined : await scope.gateDecisions.getById(notice.decision_id);
  let windowEnd: Date | null = null;
  if (notice.kind === 'hotl_passed' && decision) {
    const { config } = await loadEffectiveConfig(scope.projectConfigs, intent.project_id);
    const passAt = await decisionRecordedAt(scope, intent.id, decision.id);
    windowEnd = passAt === null ? null : blockWindowEnd(passAt, config);
  }
  const agent = notice.agent_id === null ? undefined : await scope.agents.getById(notice.agent_id);
  const proposal = notice.kind === 'run_proposed' ? await lastProposal(scope, intent.id) : null;
  const percent =
    notice.kind === 'budget_warning' ? await lastWarningPercent(scope, intent.id) : null;
  const clientRecordRef =
    notice.kind === 'g8_review_needed' ? await clientNoteRef(scope, intent) : null;
  const lessonWindowDays =
    notice.kind === 'released'
      ? (await loadEffectiveConfig(scope.projectConfigs, intent.project_id)).config.learning
          .lesson_window_days
      : null;
  const mentions = await mentionsFor(scope, intent.project_id, notice.audience_roles, []);
  // The recertification warning goes to the agent's owner (ADR-M31 §2.7), read now.
  if (agent) mentions.push(...(await loginsOf(scope, agent.owner_id)));
  return {
    code: intent.code,
    deciders: decision ? await loginsOf(scope, decision.decided_by) : [],
    mentions: [...new Set(mentions)].sort(),
    reasonCode: decision?.reason_code ?? null,
    windowEnd,
    agentKey: agent?.agent_key ?? (proposal ? await agentKeyOf(scope, proposal.agentId) : null),
    baseSha: proposal ? proposal.baseSha.slice(0, 12) : null,
    percent,
    lessonWindowDays,
    clientRecordRef,
  };
}

/**
 * E03 (QUESTIONS #222): when the latest pack uses the client's own disclosure format, the link to
 * the human AI record; Person B's G8 approval confirms that the client's note is ready.
 */
async function clientNoteRef(scope: TenantScope, intent: Intent): Promise<string | null> {
  const pack = await scope.evidencePacks.latest(intent.id);
  if (pack?.disclosure_format !== 'client_format') return null;
  const record = await scope.projectAiRecords.get(intent.project_id);
  return record?.record_ref ?? t('evidence.md.none', {});
}

/** The percent of the last `budget_warning` of the intent's last run (C07), or null. */
async function lastWarningPercent(scope: TenantScope, intentId: string): Promise<number | null> {
  const run = (await scope.runs.listForIntent(intentId)).at(-1);
  if (!run) return null;
  const payload = (await scope.runEvents.list(run.id))
    .filter((e) => e.event_type === 'budget_warning')
    .at(-1)?.payload;
  return typeof payload?.percent === 'number' ? payload.percent : null;
}

/** The last run proposal of the intent (`run.proposed`): IDs and hashes only. */
async function lastProposal(
  scope: TenantScope,
  intentId: string,
): Promise<{ readonly baseSha: string; readonly agentId: string } | null> {
  const payload = (await scope.audit.listForEntity(intentId, ['run.proposed'])).at(-1)?.payload as
    { base_sha?: unknown; agent_id?: unknown } | undefined;
  return typeof payload?.base_sha === 'string' && typeof payload.agent_id === 'string'
    ? { baseSha: payload.base_sha, agentId: payload.agent_id }
    : null;
}

async function agentKeyOf(scope: TenantScope, agentId: string): Promise<string | null> {
  return (await scope.agents.getById(agentId))?.agent_key ?? null;
}

/** Posts the pending status comments of a project, oldest first. */
export async function flushIntentNotices(
  deps: IntentNoticeDeps,
  scope: TenantScope,
  projectId: string,
  ref: RepoRef,
): Promise<{ posted: number; failed: number }> {
  const pending = await scope.intentNotices.pendingForProject(projectId, deps.limit);
  let posted = 0;
  let failed = 0;
  for (const notice of pending) {
    const intent = await scope.intents.getById(notice.intent_id);
    const attempts = notice.attempts + 1;
    const fields = {
      tenant_id: scope.tenantId,
      project_id: projectId,
      intent_id: notice.intent_id,
      kind: notice.kind,
    };
    if (!intent || intent.issue_number === null) {
      await bookkeeping(deps, scope, notice.id, { attempts, abandonAt: deps.now() }, fields);
      deps.log('warn', 'status_notice.no_issue', fields);
      continue;
    }
    let error: unknown;
    try {
      const body = renderIntentNotice(notice, await viewOf(scope, intent, notice));
      await deps.gitHost.createIssueComment(ref, intent.issue_number, body);
    } catch (caught) {
      error = caught ?? new Error('unknown');
    }
    if (error === undefined) {
      await bookkeeping(deps, scope, notice.id, { attempts, postedAt: deps.now() }, fields);
      posted += 1;
      deps.log('info', 'status_notice.posted', fields);
      continue;
    }
    const abandon = attempts >= deps.maxAttempts;
    await bookkeeping(
      deps,
      scope,
      notice.id,
      abandon ? { attempts, abandonAt: deps.now() } : { attempts },
      fields,
    );
    const code = error instanceof GitHostError ? error.code : 'unexpected';
    failed += 1;
    deps.log(
      abandon ? 'error' : 'warn',
      abandon ? 'status_notice.abandoned' : 'status_notice.failed',
      {
        ...fields,
        attempts,
        error: code,
      },
    );
    // The Git host asks us to wait: the other notices would fail the same way.
    if (code === 'rate_limited') break;
  }
  return { posted, failed };
}

/** Bookkeeping never stops the other notices: a failure only means a notice may be posted again. */
async function bookkeeping(
  deps: IntentNoticeDeps,
  scope: TenantScope,
  id: string,
  result: { readonly attempts: number; readonly postedAt?: Date; readonly abandonAt?: Date },
  fields: Readonly<Record<string, string>>,
): Promise<void> {
  try {
    await scope.intentNotices.markDelivery(id, result);
  } catch {
    deps.log('error', 'status_notice.bookkeeping_failed', fields);
  }
}
