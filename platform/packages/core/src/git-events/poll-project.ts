// One poll of one repository (D-08 B06 AC1, design/ADR-M27 section 2.1; task O06 PR 2c,
// ADR-M106 §2.4). The worker's loop calls it for the active projects of a tenant on one repository,
// on the shortest interval of the group (`github.poll_interval_seconds`).
//
// 1. Read the projects' cursors and ask the Git host once for the events since the oldest one
//    (outside any transaction). Comment commands go to one project of the group (`routeCommands`).
//    Then, for each project:
// 2. In ONE transaction: move the cursor with compare-and-set, then handle every event (gate
//    decisions, receipts). A crash before the commit applies nothing; a second poller that read
//    the same cursor finds it moved and rolls back. The receipts make the handler idempotent by
//    event ID as well (ADR-M23 §2.3: "preferably both").
// 3. After the commit, post the pending replies (at least once: a crash after the POST and before
//    the update posts that reply again on the next poll).
import {
  GitHostError,
  INITIAL_EVENT_CURSOR,
  type EventCursor,
  type GitEvent,
  type GitHostAdapter,
  type IntentWorkflowSignals,
  type RepoRef,
} from '@sdlc/contracts';

import { parseCommentCommand } from '../commands/comment-command.js';
import {
  commandReplyParams,
  handleGitEvent,
  type GitEventOutcome,
  type GitEventHandlerDeps,
} from '../commands/git-event-handler.js';
import type { PollableProject } from '../db/system-scope.js';
import type { TenantId } from '../db/tenant-id.js';
import type { TenantScope } from '../db/tenant-scope.js';
import { flushEscalationNotices, type NoticeLogEvent } from './escalation-notices.js';
import { flushIntentNotices, type IntentNoticeLogEvent } from './intent-notices.js';
import { renderCommentReply } from './replies.js';

export type PollLogEvent =
  | 'poll.completed'
  | 'poll.cursor_moved'
  | 'poll.project_skipped'
  | 'poll.event_handled'
  | 'reply.posted'
  | 'reply.failed'
  | 'reply.abandoned'
  | 'reply.bookkeeping_failed'
  | 'poll.event_attempt_failed'
  | 'worker.event_failed'
  | 'poll.wake_failed'
  | 'poll.kill_signal_failed'
  | NoticeLogEvent
  | IntentNoticeLogEvent;

/** Structured log hook. Fields hold IDs and codes only: never comment text or tokens. */
export interface PollLogger {
  log(
    level: 'info' | 'warn' | 'error',
    event: PollLogEvent,
    fields: Readonly<Record<string, string | number | boolean>>,
  ): void;
}

export interface PollDeps extends Omit<GitEventHandlerDeps, 'now'> {
  readonly db: { forTenant(tenantId: TenantId): TenantScope };
  readonly gitHost: GitHostAdapter;
  /** The poller's clock, also passed to the handler (escalation commands). Default: `new Date()`. */
  readonly now?: () => Date;
  readonly logger?: PollLogger;
  /** A reply is given up after this many failed posts. Default 5. */
  readonly maxReplyAttempts?: number;
  /** Replies posted per poll at most. Default 20. */
  readonly repliesPerPoll?: number;
  /**
   * An event whose handling fails with an unexpected error (not a refusal) is given up after this
   * many failed attempts: `failed_internal`, one `failed` reply, and the cursor moves past it.
   * Default 3. A technical setting, not a handbook rule (ADR-M27 §2.2).
   */
  readonly maxEventAttempts?: number;
  /**
   * Wakes the workflow of an intent after the commit (B07, ADR-M30 §2.3). A failure is logged,
   * never thrown: the worker's reconcile loop wakes every open intent later.
   */
  readonly intentSignals?: IntentWorkflowSignals;
}

export interface PollResult {
  /** `polled`: events handled and cursor stored; `cursor_moved`: another poller was first. */
  readonly status: 'polled' | 'cursor_moved' | 'skipped';
  readonly events: number;
  readonly outcomes: Readonly<Partial<Record<GitEventOutcome, number>>>;
  readonly repliesPosted: number;
  readonly repliesFailed: number;
  /** Escalation notice comments posted and failed in this poll (B11). */
  readonly noticesPosted: number;
  readonly noticesFailed: number;
  /** Gate status comments posted and failed in this poll (B07, FR-22). */
  readonly statusPosted: number;
  readonly statusFailed: number;
}

class CursorMoved extends Error {
  override readonly name = 'CursorMoved';
}

/** The handling of one event failed; the batch rolls back and the attempt is counted outside it. */
class EventFailed extends Error {
  override readonly name = 'EventFailed';

  constructor(
    readonly event: GitEvent,
    override readonly cause: unknown,
  ) {
    super('event failed');
  }
}

const REPO_FULL_NAME = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/;

function repoRef(fullName: string): RepoRef | undefined {
  const match = REPO_FULL_NAME.exec(fullName);
  return match ? { owner: match[1]!, name: match[2]! } : undefined;
}

/**
 * O06 PR 2c (ADR-M106 §2.4): the active projects of one tenant on one repository. The worker
 * polls them together: one read of the Git host, then each project in its own transaction.
 */
export interface PollableRepository {
  readonly tenantId: TenantId;
  readonly repoFullName: string;
  readonly projectIds: readonly string[];
}

export interface RepositoryPollResult {
  /** One result per project of the group, in the group's order. */
  readonly projects: readonly { readonly projectId: string; readonly result: PollResult }[];
}

const SKIPPED: PollResult = {
  status: 'skipped',
  events: 0,
  outcomes: {},
  repliesPosted: 0,
  repliesFailed: 0,
  noticesPosted: 0,
  noticesFailed: 0,
  statusPosted: 0,
  statusFailed: 0,
};

/** One poll of one project: a group of one. */
export async function pollProject(deps: PollDeps, target: PollableProject): Promise<PollResult> {
  const { projects } = await pollRepository(deps, {
    tenantId: target.tenantId,
    repoFullName: target.repoFullName,
    projectIds: [target.projectId],
  });
  return projects[0]?.result ?? SKIPPED;
}

interface Member {
  readonly id: string;
  /** The project's stored cursor; null when never polled. */
  readonly expected: string | null;
}

/**
 * Where the comment commands of a read go (ADR-M106 §2.4). A command belongs to the project with
 * an open intent on its issue or pull request; with none, to the first project of the group, so
 * a reply is posted once. Other events (checks, reviews, closed pull requests, plain comments) go
 * to every project: they only wake that project's own intents.
 */
interface Routes {
  /** Event ID → the one project that handles it. */
  readonly handler: ReadonlyMap<string, string>;
  /** Events linked to open intents of more than one project: `intent_ambiguous`. */
  readonly ambiguous: ReadonlySet<string>;
}

async function routeCommands(
  scope: TenantScope,
  projectIds: readonly string[],
  events: readonly GitEvent[],
): Promise<Routes> {
  const handler = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const event of events) {
    if (event.kind !== 'comment_created') continue;
    if (parseCommentCommand(event.body).kind === 'none') continue;
    const owners: string[] = [];
    for (const projectId of projectIds) {
      const intents = await scope.intents.findOpenByGitNumber(projectId, {
        kind: event.isPullRequest ? 'pull_request' : 'issue',
        number: event.issueNumber,
      });
      if (intents.length > 0) owners.push(projectId);
    }
    handler.set(event.id, owners[0] ?? projectIds[0]!);
    if (owners.length > 1) ambiguous.add(event.id);
  }
  return { handler, ambiguous };
}

/**
 * One poll of a repository (O06 PR 2c, ADR-M106 §2.4): one read of the Git host from the oldest
 * cursor of the group, then each project handles its events in its own transaction, with its own
 * cursor compare-and-set, and stores the read's next cursor. A project whose handling fails keeps
 * its cursor; the others go on, and the first error is thrown at the end.
 */
export async function pollRepository(
  deps: PollDeps,
  group: PollableRepository,
): Promise<RepositoryPollResult> {
  const now = deps.now ?? (() => new Date());
  const log = deps.logger ?? { log: () => undefined };
  const scope = deps.db.forTenant(group.tenantId);
  const projectIds = [...new Set(group.projectIds)].sort();

  const members: Member[] = [];
  let ref: RepoRef | undefined;
  let repoName: string | undefined;
  for (const projectId of projectIds) {
    const project = await scope.projects.getById(projectId);
    const projectRef = project ? repoRef(project.repo_full_name) : undefined;
    if (
      !project ||
      project.status !== 'active' ||
      project.git_provider !== 'github' ||
      !projectRef ||
      // The repository changed since the list was read: the next list puts it in its own group.
      (repoName !== undefined && project.repo_full_name !== repoName)
    ) {
      log.log('warn', 'poll.project_skipped', { tenant_id: group.tenantId, project_id: projectId });
      continue;
    }
    repoName ??= project.repo_full_name;
    ref ??= projectRef;
    const stored = await scope.gitEventCursors.get(project.id);
    members.push({ id: project.id, expected: stored?.cursor ?? null });
  }

  const results = new Map<string, PollResult>();
  if (ref !== undefined && members.length > 0) {
    const cursors = members.map((m) => (m.expected ?? INITIAL_EVENT_CURSOR) as EventCursor);
    const from = cursors.every((c) => c === cursors[0])
      ? cursors[0]!
      : deps.gitHost.oldestEventCursor(cursors);
    const { events, next } = await deps.gitHost.listEventsSince(ref, from);
    const routes =
      members.length > 1
        ? await routeCommands(
            scope,
            members.map((m) => m.id),
            events,
          )
        : undefined;
    let failure: { readonly error: unknown } | undefined;
    for (const member of members) {
      const own = routes
        ? events.filter((e) => (routes.handler.get(e.id) ?? member.id) === member.id)
        : events;
      try {
        results.set(
          member.id,
          await pollMember(deps, scope, member, {
            ref,
            events: own,
            next,
            now,
            ambiguous: routes?.ambiguous ?? new Set(),
            ids: { tenant_id: group.tenantId, project_id: member.id },
          }),
        );
      } catch (error) {
        failure ??= { error };
      }
    }
    if (failure) throw failure.error;
  }
  return {
    projects: group.projectIds.map((projectId) => ({
      projectId,
      result: results.get(projectId) ?? SKIPPED,
    })),
  };
}

interface MemberRead {
  readonly ref: RepoRef;
  readonly events: readonly GitEvent[];
  readonly next: EventCursor;
  readonly now: () => Date;
  readonly ambiguous: ReadonlySet<string>;
  readonly ids: Readonly<Record<string, string>>;
}

/** The events of one project of the read, its cursor, then its replies and notices. */
async function pollMember(
  deps: PollDeps,
  scope: TenantScope,
  member: Member,
  read: MemberRead,
): Promise<PollResult> {
  const log = deps.logger ?? { log: () => undefined };
  const { ref, events, next, now, ids } = read;
  const expected = member.expected;
  const projectId = member.id;

  let outcomes: Partial<Record<GitEventOutcome, number>> = {};
  let woken: readonly string[] = [];
  let killed: readonly string[] = [];
  let status: PollResult['status'] = 'polled';
  let givenUp = 0;
  // Each round either commits the batch, or gives one more event up and runs the batch again
  // without it; so at most one round per event, plus one.
  for (let round = 0; round <= events.length; round += 1) {
    try {
      ({
        counts: outcomes,
        intentIds: woken,
        killIntentIds: killed,
      } = await runBatch(deps, scope, projectId, events, {
        expected,
        next,
        now,
        ids,
        ambiguous: read.ambiguous,
      }));
      break;
    } catch (error) {
      if (error instanceof CursorMoved) {
        status = 'cursor_moved';
        log.log('warn', 'poll.cursor_moved', ids);
        break;
      }
      if (!(error instanceof EventFailed)) throw error;
      const final = await countFailure(deps, scope, projectId, error, ids);
      if (!final) throw error.cause;
      givenUp += 1;
    }
  }
  if (givenUp > 0 && status === 'polled') {
    outcomes = { ...outcomes, failed_internal: givenUp };
  }

  // The workflows see the decisions only after the commit (B07, ADR-M30 §2.3).
  if (status === 'polled') await wakeIntents(deps, scope.tenantId, projectId, woken, killed);

  // The poller that lost the cursor race leaves the replies to the winner, which is flushing them.
  const replies =
    status === 'polled'
      ? await flushReplies(deps, scope, projectId, ref, now)
      : { posted: 0, failed: 0 };
  // Escalation notices (B11, ADR-M28 §2.5): same project, same Git host, same delivery rules.
  const notices =
    status === 'polled'
      ? await flushEscalationNotices(
          {
            gitHost: deps.gitHost,
            maxAttempts: deps.maxReplyAttempts ?? 5,
            limit: deps.repliesPerPoll ?? 20,
            now,
            log: (level, event, fields) => log.log(level, event, fields),
          },
          scope,
          projectId,
          ref,
        )
      : { posted: 0, failed: 0 };
  // Gate status comments (B07, FR-22): after the escalation notices, same delivery rules.
  const status_ =
    status === 'polled'
      ? await flushIntentNotices(
          {
            gitHost: deps.gitHost,
            maxAttempts: deps.maxReplyAttempts ?? 5,
            limit: deps.repliesPerPoll ?? 20,
            now,
            log: (level, event, fields) => log.log(level, event, fields),
          },
          scope,
          projectId,
          ref,
        )
      : { posted: 0, failed: 0 };
  log.log('info', 'poll.completed', {
    ...ids,
    status,
    events: events.length,
    replies_posted: replies.posted,
    replies_failed: replies.failed,
    notices_posted: notices.posted,
    notices_failed: notices.failed,
    status_posted: status_.posted,
    status_failed: status_.failed,
  });
  return {
    status,
    events: status === 'polled' ? events.length : 0,
    outcomes,
    repliesPosted: replies.posted,
    repliesFailed: replies.failed,
    noticesPosted: notices.posted,
    noticesFailed: notices.failed,
    statusPosted: status_.posted,
    statusFailed: status_.failed,
  };
}

async function wakeIntents(
  deps: PollDeps,
  tenantId: TenantId,
  projectId: string,
  intentIds: readonly string[],
  killIntentIds: readonly string[],
): Promise<void> {
  if (!deps.intentSignals) return;
  // C11: the kill signal first, so a run waiting in Temporal is cancelled before the wake.
  for (const intentId of new Set(killIntentIds)) {
    try {
      await deps.intentSignals.kill({ tenantId, intentId });
    } catch {
      deps.logger?.log('warn', 'poll.kill_signal_failed', {
        tenant_id: tenantId,
        project_id: projectId,
        intent_id: intentId,
      });
    }
  }
  for (const intentId of new Set(intentIds)) {
    try {
      await deps.intentSignals.wake({ tenantId, intentId });
    } catch {
      deps.logger?.log('warn', 'poll.wake_failed', {
        tenant_id: tenantId,
        project_id: projectId,
        intent_id: intentId,
      });
    }
  }
}

interface BatchContext {
  readonly expected: string | null;
  readonly next: EventCursor;
  readonly now: () => Date;
  readonly ids: Readonly<Record<string, string>>;
  /** O06 PR 2c: comment events linked to open intents of more than one project. */
  readonly ambiguous: ReadonlySet<string>;
}

/** The cursor compare-and-set and every event, in one transaction. */
function runBatch(
  deps: PollDeps,
  scope: TenantScope,
  projectId: string,
  events: readonly GitEvent[],
  ctx: BatchContext,
): Promise<BatchResult> {
  const log = deps.logger ?? { log: () => undefined };
  return scope.transaction(async (tx) => {
    const counts: Partial<Record<GitEventOutcome, number>> = {};
    const intentIds: string[] = [];
    const killIntentIds: string[] = [];
    // First, so the cursor row stays locked for the whole batch.
    if (!(await tx.gitEventCursors.saveIfUnchanged(projectId, ctx.expected, ctx.next, ctx.now()))) {
      throw new CursorMoved();
    }
    for (const event of events) {
      let outcome: GitEventOutcome;
      let intentId: string | undefined;
      let killed: boolean | undefined;
      try {
        ({ outcome, intentId, killed } = await handleGitEvent(
          tx,
          { registry: deps.registry, now: ctx.now },
          { id: projectId, provider: 'github' },
          event,
          { linkedElsewhere: ctx.ambiguous.has(event.id) },
        ));
      } catch (error) {
        throw new EventFailed(event, error);
      }
      counts[outcome] = (counts[outcome] ?? 0) + 1;
      if (intentId !== undefined) intentIds.push(intentId);
      if (intentId !== undefined && killed === true) killIntentIds.push(intentId);
      if (outcome !== 'not_a_command' && outcome !== 'not_handled') {
        log.log('info', 'poll.event_handled', { ...ctx.ids, event_id: event.id, outcome });
      }
    }
    return { counts, intentIds, killIntentIds };
  });
}

interface BatchResult {
  readonly counts: Partial<Record<GitEventOutcome, number>>;
  /** Intents whose workflow must look again once the batch is committed. */
  readonly intentIds: readonly string[];
  /** C11: intents whose run was killed; they get the kill signal before the wake. */
  readonly killIntentIds: readonly string[];
}

/**
 * Counts a failed attempt of the event in its own transaction (the batch was rolled back). Returns
 * true when the event is now given up. When the count cannot be written (for example the database
 * is gone), the original error stops the poll and nothing is counted.
 */
async function countFailure(
  deps: PollDeps,
  scope: TenantScope,
  projectId: string,
  failure: EventFailed,
  ids: Readonly<Record<string, string>>,
): Promise<boolean> {
  const log = deps.logger ?? { log: () => undefined };
  const { event } = failure;
  // Only command comments are counted; a check event (C08 PR 2) only reads intents, so its error
  // stops the poll and the next poll reads the batch again.
  if (event.kind !== 'comment_created') throw failure.cause;
  const command = parseCommentCommand(event.body);
  const replyParams = commandReplyParams(command);
  let counted: { attempts: number; final: boolean };
  try {
    counted = await scope.gitEventReceipts.recordFailure(
      { projectId, eventId: event.id, issueNumber: event.issueNumber, replyParams },
      deps.maxEventAttempts ?? 3,
    );
  } catch {
    throw failure.cause;
  }
  const fields = {
    ...ids,
    event_id: event.id,
    attempts: counted.attempts,
    error: errorName(failure.cause),
  };
  if (counted.final) log.log('error', 'worker.event_failed', fields);
  else log.log('warn', 'poll.event_attempt_failed', fields);
  return counted.final;
}

/** A code for logs: the error class name, never its message (it may hold data). */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unexpected';
}

/** Posts the pending replies of a project (the outbox), oldest first. */
async function flushReplies(
  deps: PollDeps,
  scope: TenantScope,
  projectId: string,
  ref: RepoRef,
  now: () => Date,
): Promise<{ posted: number; failed: number }> {
  const log = deps.logger ?? { log: () => undefined };
  const maxAttempts = deps.maxReplyAttempts ?? 5;
  const pending = await scope.gitEventReceipts.pendingReplies(projectId, deps.repliesPerPoll ?? 20);
  let posted = 0;
  let failed = 0;
  for (const receipt of pending) {
    const fields = {
      tenant_id: scope.tenantId,
      project_id: projectId,
      event_id: receipt.event_id,
      reply: receipt.reply_code ?? '',
    };
    const attempts = receipt.reply_attempts + 1;
    let error: unknown;
    try {
      await deps.gitHost.createIssueComment(
        ref,
        receipt.issue_number!,
        renderCommentReply(receipt.reply_code!, receipt.reply_params ?? {}, receipt.event_id),
      );
    } catch (caught) {
      error = caught ?? new Error('unknown');
    }
    const abandon = error !== undefined && attempts >= maxAttempts;
    try {
      // Bookkeeping never stops the other replies: a failure here only means this reply may be
      // posted again later (at least once).
      if (error === undefined) {
        await scope.gitEventReceipts.markReplyPosted(receipt.id, attempts, now());
      } else {
        await scope.gitEventReceipts.markReplyFailed(receipt.id, attempts, abandon ? now() : null);
      }
    } catch {
      log.log('error', 'reply.bookkeeping_failed', { ...fields, attempts });
    }
    if (error === undefined) {
      posted += 1;
      log.log('info', 'reply.posted', fields);
      continue;
    }
    const code = error instanceof GitHostError ? error.code : 'unexpected';
    failed += 1;
    log.log(abandon ? 'error' : 'warn', abandon ? 'reply.abandoned' : 'reply.failed', {
      ...fields,
      attempts,
      error: code,
    });
    // The Git host asks us to wait: the other replies would fail the same way.
    if (code === 'rate_limited') break;
  }
  return { posted, failed };
}
