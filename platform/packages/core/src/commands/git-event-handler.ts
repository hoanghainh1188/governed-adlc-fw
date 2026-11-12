// One handler for Git host events, whether they come from polling (B06) or, later, webhooks
// (ADR-M11, design/ADR-M27 section 2.2). It turns comment commands into gate decisions through
// the same `decideGate` as the API (ADR-M26 section 2.4), so both paths apply the same rules.
//
// - Idempotent by `event.id`: a receipt (`git_event_receipts`) is written in the caller's
//   transaction; an event that already has one is skipped.
// - Only newly created comments are events (QUESTIONS.md #43; the adapter drops edits).
// - Actors are mapped by the numeric account ID, never by the login; bots never decide
//   (QUESTIONS.md #45).
// - No text from the Git host is stored: the receipt and the decision hold codes, IDs and the
//   comment URL (`reason_ref`) only.
import type { CheckCompletedEvent, CommentCreatedEvent, GitEvent } from '@sdlc/contracts';

import { DbError, TenantGuardError } from '../db/errors.js';
import type { Escalation, GitEventReceipt, Intent } from '../db/schema.js';
import type { TenantScope } from '../db/tenant-scope.js';
import type { GitProvider } from '../db/vocabulary.js';
import { acknowledgeEscalation, decideEscalation } from '../escalation/decide.js';
import { EscalationError, type EscalationErrorCode } from '../escalation/errors.js';
import { KillError, type KillErrorCode } from '../kill/errors.js';
import { currentRunOf, requestRunKill } from '../kill/kill-run.js';
import { RegistryError } from '../registry/errors.js';
import type { Registry } from '../registry/registry.js';
import {
  parseCommentCommand,
  type CommentSyntaxProblem,
  type ParsedComment,
} from './comment-command.js';
import { CommandError } from './errors.js';
import { decideGate } from './gate-command.js';

/** What happened to an event. Stored as `git_event_receipts.outcome` for command comments. */
export type GitEventOutcome =
  /** The gate decision was recorded. No reply: B07's status comment confirms it (FR-22). */
  | 'decided'
  /** `/ack`: the escalation was acknowledged (B11). No reply. */
  | 'acknowledged'
  /** `/decide`: the escalation decision was recorded, or it moved to governance (B11). No reply. */
  | 'escalation_decided'
  /** `/kill`: the kill of the intent's current run was recorded (C11). No reply: notice `run_killed`. */
  | 'killed'
  /** The command was understood but refused (permission, gate, input); a reply says why. */
  | 'refused'
  /** The command could not be read; a reply shows the syntax. */
  | 'syntax_error'
  /** The Git host account is not linked to an active platform user. */
  | 'user_not_linked'
  /** No open intent is linked to this issue or pull request. */
  | 'intent_not_linked'
  /** More than one open intent is linked to it (QUESTIONS.md #68). */
  | 'intent_ambiguous'
  /** A bot wrote the command: bots never decide. No reply, so replies never loop. */
  | 'ignored_bot'
  /** The platform could not record the command (a stored value was refused). */
  | 'failed'
  /** Handling failed with an unexpected error; retried on the next polls (receipt only). */
  | 'failing'
  /** Given up after the maximum number of failed attempts; a `failed` reply is posted. */
  | 'failed_internal'
  /** Not stored: the event already has a receipt. */
  | 'duplicate'
  /** Not stored: a comment that is not a command of the platform. */
  | 'not_a_command'
  /** Not stored: reviews, checks and closed pull requests are read by the gates (E01, C08). */
  | 'not_handled';

/** Codes of the reply comments. Each has the catalog key `comment.reply.<code>` (ADR-M27). */
export const COMMENT_REPLY_CODES = [
  'syntax_gate_missing',
  'syntax_gate_invalid',
  'syntax_unexpected_text',
  'syntax_reason_missing',
  'syntax_decision_missing',
  'syntax_decision_invalid',
  'user_not_linked',
  'intent_not_linked',
  'intent_ambiguous',
  'intent_not_found',
  'forbidden',
  'gate_not_supported',
  'gate_input_missing',
  'gate_not_current',
  'plan_refused',
  'spec_unclear',
  'review_reason_required',
  'g7_use_pr_review',
  'approval_refused',
  'decision_not_allowed',
  'project_not_active',
  'config_invalid',
  'escalation_not_found',
  'escalation_ambiguous',
  'escalation_forbidden',
  'escalation_not_open',
  'escalation_already_acknowledged',
  'escalation_decision_not_allowed',
  // C11: `/kill` refusals.
  'kill_forbidden',
  'kill_no_active_run',
  'failed',
] as const;
export type CommentReplyCode = (typeof COMMENT_REPLY_CODES)[number];

export interface GitEventProject {
  readonly id: string;
  readonly provider: GitProvider;
}

export interface GitEventHandlerDeps {
  /** The registry with the apps' policy factory (`createSimplePolicyEngine`). */
  readonly registry: Registry;
  /** Clock of escalation commands (decision expiry, FR-17). Required: no `new Date()` default. */
  readonly now: () => Date;
}

export interface HandledGitEvent {
  readonly outcome: GitEventOutcome;
  /** The receipt written for this event; undefined for outcomes that store none. */
  readonly receipt?: GitEventReceipt;
  /**
   * The intent whose workflow must look again (B07): set when a gate decision or an escalation
   * acknowledgement or decision was recorded. The caller wakes it after the commit.
   */
  readonly intentId?: string;
  /** C11: a kill was recorded; the caller also sends the kill signal after the commit. */
  readonly killed?: boolean;
}

const REASON_REF = /^https:\/\/[^\s]{1,504}$/;

export interface Reply {
  readonly code: CommentReplyCode;
  readonly params: Readonly<Record<string, string>>;
}

const SYNTAX_REPLY: Readonly<Record<CommentSyntaxProblem, CommentReplyCode>> = {
  gate_missing: 'syntax_gate_missing',
  gate_invalid: 'syntax_gate_invalid',
  unexpected_text: 'syntax_unexpected_text',
  reason_missing: 'syntax_reason_missing',
  decision_missing: 'syntax_decision_missing',
  decision_invalid: 'syntax_decision_invalid',
};

/** Reply of an escalation refusal (B11). `frozen` and packet errors cannot come from a command. */
const ESCALATION_REPLY: Readonly<Partial<Record<EscalationErrorCode, CommentReplyCode>>> = {
  not_found: 'escalation_not_found',
  forbidden: 'escalation_forbidden',
  not_open: 'escalation_not_open',
  already_acknowledged: 'escalation_already_acknowledged',
  decision_not_allowed: 'escalation_decision_not_allowed',
};

/** Reply parameters of a command: the gate, or the escalation command word (codes only). */
export function commandReplyParams(command: ParsedComment): Record<string, string> {
  if (command.kind === 'gate_decision') return { gate: command.gate };
  if (command.kind === 'none') return {};
  // `invalid` carries the verb too; a gate verb has no gate param when its gate could not be read.
  return command.verb === 'ack' || command.verb === 'decide' || command.verb === 'kill'
    ? { command: command.verb }
    : {};
}

/**
 * C08 PR 2 (ADR-M38 §2.7): a check finished on a pull request. The event is only a trigger: the
 * intent of that pull request is woken when it waits at G6, and G6 reads the checks again from the
 * Git host (never the event's content). No receipt and no reply.
 */
async function wakeForCheck(
  scope: TenantScope,
  project: GitEventProject,
  event: CheckCompletedEvent,
): Promise<HandledGitEvent> {
  for (const number of event.prNumbers) {
    const [intent] = await scope.intents.findOpenByGitNumber(project.id, {
      kind: 'pull_request',
      number,
    });
    if (intent?.current_gate === 'G6') return { outcome: 'not_handled', intentId: intent.id };
  }
  return { outcome: 'not_handled' };
}

/**
 * E01 (ADR-M41 §2.2): a review was submitted on a pull request, or the pull request was closed
 * (merged or not). The event is only a trigger: the intent of that pull request is woken, and G7
 * reads the pull request and its reviews again from the Git host. Reviews get their receipts from
 * G7, which records them as decisions; the poller stores nothing here.
 */
async function wakeForPullRequest(
  scope: TenantScope,
  project: GitEventProject,
  prNumber: number,
): Promise<HandledGitEvent> {
  const [intent] = await scope.intents.findOpenByGitNumber(project.id, {
    kind: 'pull_request',
    number: prNumber,
  });
  return intent ? { outcome: 'not_handled', intentId: intent.id } : { outcome: 'not_handled' };
}

export interface HandleOptions {
  /**
   * O06 PR 2c (ADR-M106 §2.4): an open intent of another project on the same repository has the
   * comment's issue or pull request too. One linked intent here is then `intent_ambiguous`.
   */
  readonly linkedElsewhere?: boolean;
}

/**
 * Handles one event in the scope's transaction (one is opened when the scope has none). Throws
 * only for errors that should stop the whole poll (for example a lost database connection), so
 * the batch is rolled back and read again.
 */
export function handleGitEvent(
  scope: TenantScope,
  deps: GitEventHandlerDeps,
  project: GitEventProject,
  event: GitEvent,
  options: HandleOptions = {},
): Promise<HandledGitEvent> {
  if (event.kind === 'check_completed') return wakeForCheck(scope, project, event);
  if (event.kind === 'review_submitted' || event.kind === 'pull_request_closed') {
    return wakeForPullRequest(scope, project, event.prNumber);
  }
  if (event.kind !== 'comment_created') return Promise.resolve({ outcome: 'not_handled' });
  const command = parseCommentCommand(event.body);
  if (command.kind === 'none') return Promise.resolve({ outcome: 'not_a_command' });

  return scope.transaction(async (tx) => {
    // A `failing` receipt is an event whose earlier attempts failed: try it again. Any other
    // receipt means the event is done (including `failed_internal`: given up, skipped).
    const existing = await tx.gitEventReceipts.find(project.id, event.id);
    if (existing && existing.outcome !== 'failing') return { outcome: 'duplicate' };
    const record = async (
      outcome: GitEventOutcome,
      extra: { gateDecisionId?: string; escalationId?: string; reply?: Reply } = {},
    ): Promise<HandledGitEvent> => {
      const input = {
        projectId: project.id,
        eventId: event.id,
        outcome,
        issueNumber: event.issueNumber,
        gateDecisionId: extra.gateDecisionId ?? null,
        escalationId: extra.escalationId ?? null,
        ...(extra.reply ? { reply: extra.reply } : {}),
      };
      return {
        outcome,
        receipt: existing
          ? await tx.gitEventReceipts.complete(existing.id, input)
          : await tx.gitEventReceipts.record(input),
      };
    };

    if (event.author.type === 'bot') return record('ignored_bot');
    if (command.kind === 'invalid') {
      return record('syntax_error', { reply: { code: SYNTAX_REPLY[command.problem], params: {} } });
    }
    const gate = commandReplyParams(command);

    const actorId = await linkedUser(tx, project.provider, event);
    if (actorId === undefined) {
      return record('user_not_linked', { reply: { code: 'user_not_linked', params: gate } });
    }
    const intents = await tx.intents.findOpenByGitNumber(project.id, {
      kind: event.isPullRequest ? 'pull_request' : 'issue',
      number: event.issueNumber,
    });
    // O06 PR 2c: an open intent of another project on the same repository has this issue too.
    if (intents.length !== 1 || options.linkedElsewhere === true) {
      const code = intents.length === 0 ? 'intent_not_linked' : 'intent_ambiguous';
      return record(code, { reply: { code, params: gate } });
    }

    if (command.kind === 'kill') {
      return handleKillCommand(tx, deps, intents[0]!, actorId, gate, record);
    }
    if (command.kind !== 'gate_decision') {
      return handleEscalationCommand(
        tx,
        deps,
        intents[0]!,
        command,
        actorId,
        event.url,
        gate,
        record,
      );
    }
    try {
      const decision = await tx.savepoint((sp) =>
        decideGate(deps.registry, sp, {
          intent: intents[0]!,
          gate: command.gate,
          decision: command.decision,
          actorId,
          reasonCode: command.reasonCode,
          reasonRef: REASON_REF.test(event.url) ? event.url : null,
          source: 'github_comment',
          eventSource: event.source,
        }),
      );
      return {
        ...(await record('decided', { gateDecisionId: decision.id })),
        intentId: intents[0]!.id,
      };
    } catch (error) {
      const refusal = refusalReply(error, gate);
      if (refusal === undefined) throw error;
      return record(refusal.code === 'failed' ? 'failed' : 'refused', { reply: refusal });
    }
  });
}

type EscalationCommand = Extract<ParsedComment, { kind: 'escalation_ack' | 'escalation_decision' }>;
type Recorder = (
  outcome: GitEventOutcome,
  extra?: { gateDecisionId?: string; escalationId?: string; reply?: Reply },
) => Promise<HandledGitEvent>;

/** `/ack` and `/decide` (B11, ADR-M28 §2.7): same linking, receipts and refusal handling. */
async function handleEscalationCommand(
  tx: TenantScope,
  deps: GitEventHandlerDeps,
  intent: Intent,
  command: EscalationCommand,
  actorId: string,
  url: string,
  params: Readonly<Record<string, string>>,
  record: Recorder,
): Promise<HandledGitEvent> {
  const found = await findEscalation(tx, intent, command.code);
  if (typeof found === 'string') return record('refused', { reply: { code: found, params } });
  const clock = { now: deps.now };
  try {
    await tx.savepoint((sp) =>
      command.kind === 'escalation_ack'
        ? acknowledgeEscalation(sp, { escalationId: found.id, actorId }, clock)
        : decideEscalation(
            sp,
            {
              escalationId: found.id,
              actorId,
              decision: command.decision,
              reasonCode: command.reasonCode,
              reasonRef: REASON_REF.test(url) ? url : null,
            },
            clock,
          ),
    );
    const outcome = command.kind === 'escalation_ack' ? 'acknowledged' : 'escalation_decided';
    return { ...(await record(outcome, { escalationId: found.id })), intentId: intent.id };
  } catch (error) {
    const reply =
      error instanceof EscalationError
        ? { code: ESCALATION_REPLY[error.code] ?? 'failed', params }
        : refusalReply(error, params);
    if (reply === undefined) throw error;
    return record(reply.code === 'failed' ? 'failed' : 'refused', {
      escalationId: found.id,
      reply,
    });
  }
}

/**
 * `/kill` (C11, ADR-M42 §2.6): stops the intent's current run as the comment's author (config
 * `access.kill_roles`). A refusal gets a reply; a kill is confirmed by the status notice.
 */
async function handleKillCommand(
  tx: TenantScope,
  deps: GitEventHandlerDeps,
  intent: Intent,
  actorId: string,
  params: Readonly<Record<string, string>>,
  record: Recorder,
): Promise<HandledGitEvent> {
  try {
    const result = await tx.savepoint(async (sp) => {
      const run = await currentRunOf(sp, intent.id);
      return requestRunKill(sp, deps.now ? { now: deps.now } : {}, {
        runId: run.id,
        actor: { type: 'human', id: actorId },
        source: 'github_comment',
      });
    });
    const escalation = result.escalationId ? { escalationId: result.escalationId } : {};
    return {
      ...(await record('killed', escalation)),
      intentId: intent.id,
      killed: !result.already,
    };
  } catch (error) {
    const reply =
      error instanceof KillError
        ? { code: KILL_REPLY[error.code], params }
        : refusalReply(error, params);
    if (reply === undefined) throw error;
    return record(reply.code === 'failed' ? 'failed' : 'refused', { reply });
  }
}

/** Reply of a kill refusal (C11). No role on the project: as for an unknown intent. */
const KILL_REPLY: Readonly<Record<KillErrorCode, CommentReplyCode>> = {
  run_not_found: 'intent_not_found',
  forbidden: 'kill_forbidden',
  run_not_active: 'kill_no_active_run',
  no_active_run: 'kill_no_active_run',
};

/**
 * The escalation a command names: by code (it must belong to the intent), or the intent's only
 * unresolved escalation. Returns a reply code when there is none or more than one.
 */
async function findEscalation(
  tx: TenantScope,
  intent: Intent,
  code: string | null,
): Promise<Escalation | 'escalation_not_found' | 'escalation_ambiguous'> {
  if (code !== null) {
    const byCode = await tx.escalations.getByCode(code);
    return byCode?.intent_id === intent.id ? byCode : 'escalation_not_found';
  }
  const open = await tx.escalations.listForIntent(intent.id, {
    statuses: ['open', 'acknowledged'],
  });
  if (open.length === 0) return 'escalation_not_found';
  return open.length === 1 ? open[0]! : 'escalation_ambiguous';
}

/** The active platform user linked to the comment author, by numeric account ID only. */
async function linkedUser(
  scope: TenantScope,
  provider: GitProvider,
  event: CommentCreatedEvent,
): Promise<string | undefined> {
  return userOfAccount(scope, provider, event.author.id);
}

/**
 * The active platform user linked to a Git host account, by its numeric ID (QUESTIONS #45);
 * unlinked identities never match (B13). Shared with the G7 reviews (E01).
 */
export async function userOfAccount(
  scope: TenantScope,
  provider: GitProvider,
  accountId: string,
): Promise<string | undefined> {
  const identity = await scope.userIdentities.findByExternalId(provider, accountId);
  if (!identity) return undefined;
  const user = await scope.users.getById(identity.user_id);
  return user?.status === 'active' ? user.id : undefined;
}

/**
 * The reply for an expected refusal; undefined for errors that must stop the poll. Shared with
 * the G7 reviews (E01): the same codes, never text from the Git host.
 */
export function refusalReply(
  error: unknown,
  gate: Readonly<Record<string, string>>,
): Reply | undefined {
  if (error instanceof CommandError) {
    // `project_not_found` cannot happen here (the project is the polled one); same text as no role.
    // `scope_not_allowed` cannot happen either: a comment never carries a scope, and
    // `g7_feedback_on_git_host` is the API's refusal (E01 PR 2, QUESTIONS #190). `intent_finished`
    // comes only from the effort estimate (V14), never from a comment command.
    const code =
      error.code === 'project_not_found'
        ? 'intent_not_found'
        : error.code === 'scope_not_allowed'
          ? 'decision_not_allowed'
          : error.code === 'g7_feedback_on_git_host' ||
              error.code === 'gate_input_conflict' ||
              error.code === 'intent_finished'
            ? 'failed'
            : error.code;
    return { code, params: gate };
  }
  if (error instanceof RegistryError) {
    // `issue_already_linked` only comes from creating an intent, never from a decision.
    const code =
      error.code === 'config_hash_mismatch' || error.code === 'config_defaults_drift'
        ? 'config_invalid'
        : error.code === 'issue_already_linked'
          ? 'failed'
          : error.code;
    return { code, params: error.reason ? { ...gate, reason: error.reason } : gate };
  }
  // The database refused a statement (constraint, privilege, trigger) or the tenant guard refused a
  // query. Both are deterministic: retrying the poll would fail the same way and block every later
  // event of the project, so the command is answered `failed` instead. Only other errors (for
  // example a lost connection, which `DbError` never wraps) stop the poll and are retried.
  if (error instanceof DbError || error instanceof TenantGuardError) {
    return { code: 'failed', params: gate };
  }
  return undefined;
}
