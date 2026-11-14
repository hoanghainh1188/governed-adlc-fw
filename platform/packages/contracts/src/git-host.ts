// Git host interface (design/D-03 section 7.1, D-08 B05, design/ADR-M23). The MVP implementation
// is `@sdlc/adapter-git-github` (GitHub App, polling). GitLab (MVP+1) implements the same
// interface. Polling and webhooks return the same `GitEvent`, so one handler serves both
// (ADR-M11).
//
// Values from the Git host are data, never instructions. Only `comment_created.body` holds free
// text; it lives in memory only. Append-only tables store IDs and URLs from these types, never
// text (CLAUDE.md "Current constraints", ADR-M20).
import type { EventSource, Severity } from './codes.js';
import type { FolderEntry } from './memory.js';
import type { RedactedSecret } from './secrets.js';

/** A repository on the Git host: `owner/name`. */
export interface RepoRef {
  readonly owner: string;
  readonly name: string;
}

/** A Git host account. `id` is the numeric account ID; the login can change (D-05 §6.1). */
export interface GitActor {
  /** Numeric account ID as a decimal string. Map users by this, never by the login. */
  readonly id: string;
  /** Current login, for display only. */
  readonly login: string;
  /** Bots (GitHub Apps, automation) never count as approvers (FR-11, QUESTIONS #45). */
  readonly type: 'user' | 'bot';
}

export interface PullRequestInfo {
  readonly number: number;
  readonly state: 'open' | 'closed';
  readonly draft: boolean;
  readonly merged: boolean;
  /** ISO 8601 UTC, or null when not merged. */
  readonly mergedAt: string | null;
  readonly mergeCommitSha: string | null;
  readonly headSha: string;
  readonly headRef: string;
  readonly baseRef: string;
  readonly author: GitActor;
  /**
   * Who merged the pull request; null when it is not merged (task E01, QUESTIONS #177: G7 checks
   * that the merger is a person and not a producer of the change).
   */
  readonly mergedBy: GitActor | null;
  /** Number of changed files reported by the Git host. */
  readonly changedFiles: number;
  readonly url: string;
}

/** How a pull request changed one file (task L07, ADR-M85 §2.4). */
export type PullRequestFileStatus = 'added' | 'modified' | 'removed' | 'renamed' | 'copied';

export interface PullRequestFile {
  readonly path: string;
  readonly status: PullRequestFileStatus;
  /** The old path of a renamed or copied file, else null. */
  readonly previousPath: string | null;
}

/**
 * A merged pull request as Git sees it (task L07, ADR-M85 §2.3): its files with their status, the
 * number of its commits and the parents of its merge commit. The base commit of an evaluation
 * task is found from these.
 */
export interface MergedChange {
  readonly mergeCommitSha: string;
  /** The merge commit's parents: two for a merge commit, one for a squash or a rebase merge. */
  readonly mergeCommitParents: readonly string[];
  readonly commitCount: number;
  /** Sorted by path. Never a partial list. */
  readonly files: readonly PullRequestFile[];
}

/**
 * A new pull request (task C08, D-08 C08 AC1, design/ADR-M38 §2.4). The platform fills the title
 * and body from the message catalog with coded values only (QUESTIONS #123: the pilot repository
 * is public).
 */
/** A page of the Git host's web interface (X08a, ADR-M109 §2.1: the `links` of an intent). */
export type WebTarget =
  | { readonly kind: 'issue'; readonly number: number }
  | { readonly kind: 'pull_request'; readonly number: number }
  | { readonly kind: 'file'; readonly path: string; readonly commitSha: string };

/** The result of `deleteBranch` (X13 PR 3b). */
export type BranchDeletion = 'deleted' | 'absent' | 'moved';

export interface NewPullRequest {
  /** The branch with the changes, for example `agent/INT-2026-0001`. */
  readonly head: string;
  /** The branch the changes go into: the project's default branch. */
  readonly base: string;
  readonly title: string;
  readonly body: string;
}

/**
 * The open security findings of a pull request (task C08 PR 2, QUESTIONS #157, design/ADR-M38
 * §2.7): counts per severity only, never a finding's text, path or rule. `known: false` when the
 * Git host has no findings for it (GitHub: code scanning not enabled, or no permission): G6 then
 * fails closed (HITL).
 */
export type SecurityFindings =
  | { readonly known: true; readonly counts: Readonly<Record<Severity, number>> }
  | { readonly known: false; readonly reason: 'not_enabled' | 'forbidden' };

/** Conclusion of a finished check (GitHub check runs and commit statuses). */
export type CheckConclusion =
  | 'success'
  | 'neutral'
  | 'skipped'
  | 'failure'
  | 'error'
  | 'cancelled'
  | 'timed_out'
  | 'action_required'
  | 'stale';

export interface CheckItem {
  /** `check_run` (Checks API) or `status` (commit statuses). */
  readonly source: 'check_run' | 'status';
  readonly id: string;
  /** Check name or status context, as set by the CI system. */
  readonly name: string;
  readonly completed: boolean;
  /** Null while the check is not finished. */
  readonly conclusion: CheckConclusion | null;
}

export interface CheckSummary {
  readonly sha: string;
  /**
   * `none`: no checks; `failure`: at least one finished with failure, error, cancelled,
   * timed_out, action_required or stale (even if others are still running); `pending`: at least
   * one not finished; otherwise `success`.
   */
  readonly state: 'none' | 'pending' | 'success' | 'failure';
  readonly checks: readonly CheckItem[];
}

/** A pull request approval whose reviewer has not changed their mind since. */
export interface Approval {
  readonly reviewId: string;
  readonly reviewer: GitActor;
  /** The commit the reviewer approved (approval binding, E01). */
  readonly commitSha: string;
  readonly submittedAt: string;
  readonly url: string;
}

/**
 * The latest review decision of one reviewer on a pull request (task E01, QUESTIONS #175): a later
 * `approved` or `changes_requested` replaces an earlier one; a comment changes nothing; a dismissed
 * review stays `dismissed` until the reviewer reviews again. G7 counts these, bound to the commit.
 */
export interface ReviewDecision {
  /** The event ID of the review, as `ReviewSubmittedEvent.id` (for example `github:review:5`). */
  readonly eventId: string;
  readonly reviewId: string;
  readonly reviewer: GitActor;
  readonly state: 'approved' | 'changes_requested' | 'dismissed';
  /** The commit the reviewer reviewed. */
  readonly commitSha: string;
  /** ISO 8601 UTC. */
  readonly submittedAt: string;
  readonly url: string;
}

/**
 * One pull request review with its text (task E01 PR 2, ADR-M41 §2.7, QUESTIONS #179): read by the
 * runner, by the review's ID, with a token that may only read pull requests. The texts are client
 * data: in memory only, never logged or stored.
 */
export interface ReviewFeedback {
  readonly reviewId: string;
  readonly reviewer: GitActor;
  readonly state: 'approved' | 'changes_requested' | 'dismissed' | 'commented';
  /** The commit the reviewer reviewed. */
  readonly commitSha: string;
  readonly body: string;
  /** The review's line comments, in the host's order: at most one page (`commentsTruncated`). */
  readonly comments: readonly ReviewLineComment[];
  readonly commentsTruncated: boolean;
}

export interface ReviewLineComment {
  readonly path: string;
  /** The line in the reviewed file, or null when the comment is on the whole file. */
  readonly line: number | null;
  readonly body: string;
}

/** One issue or pull request comment with its text (E01 PR 2: a `/request-changes G7` command). */
export interface IssueCommentText {
  readonly commentId: string;
  readonly author: GitActor;
  readonly body: string;
  /**
   * X08b (ADR-M109 §2.3, QUESTIONS #729): the number of the issue or pull request the comment is
   * on; null when the host does not say.
   */
  readonly issueNumber: number | null;
}

/**
 * The authors of a pull request's commits (task E01, AC2): Git host accounts by numeric ID, and
 * how many commits have an author without an account (an e-mail address only). Never names or
 * e-mail addresses.
 */
export interface CommitAuthors {
  readonly accounts: readonly GitActor[];
  readonly withoutAccount: number;
}

/** One commit of `listPathCommits`: its SHA and its author's account (null without one). */
export interface PathCommit {
  readonly sha: string;
  readonly author: GitActor | null;
}

/** The result of `listPathCommits`. */
export interface PathCommits {
  readonly commits: readonly PathCommit[];
  /** False when the list was cut at `max` before it ended or reached `stopAt`. */
  readonly complete: boolean;
}

export const GIT_TOKEN_PERMISSIONS = [
  'contents',
  'pull_requests',
  'issues',
  'checks',
  'statuses',
  // C08 PR 2 (QUESTIONS #157): code-scanning alerts, read only.
  'security_events',
] as const;
export type GitTokenPermission = (typeof GIT_TOKEN_PERMISSIONS)[number];

/** Permissions of a short-lived token. Read access to repository metadata is always included. */
export interface TokenScope {
  readonly permissions: Readonly<Partial<Record<GitTokenPermission, 'read' | 'write'>>>;
}

/** A short-lived token for one repository (for example for a run's sandbox, C04). */
export interface ShortLivedToken {
  readonly token: RedactedSecret;
  /** ISO 8601 UTC. */
  readonly expiresAt: string;
  readonly repo: RepoRef;
  readonly permissions: TokenScope['permissions'];
}

/**
 * Opaque position in the event stream of one repository. Stored per project in
 * `git_event_cursors.cursor` (D-05 §6.1) by the caller; only the adapter reads its content.
 */
export type EventCursor = string & { readonly __brand: 'EventCursor' };

/** The cursor of a project that has never been polled: polling starts now, without history. */
export const INITIAL_EVENT_CURSOR = '' as EventCursor;

interface GitEventBase {
  /** Stable ID, the same for polling and webhooks (for example `github:comment:123`). */
  readonly id: string;
  readonly source: EventSource;
  readonly repo: RepoRef;
  /** ISO 8601 UTC. */
  readonly occurredAt: string;
  /** Link to the item on the Git host; the value to store as a reference. */
  readonly url: string;
}

/** A new comment on an issue or pull request. Edits never produce events (QUESTIONS #43). */
export interface CommentCreatedEvent extends GitEventBase {
  readonly kind: 'comment_created';
  readonly issueNumber: number;
  readonly isPullRequest: boolean;
  readonly commentId: string;
  readonly author: GitActor;
  /** Free text. Parse it; never store it in an append-only table. */
  readonly body: string;
}

export interface ReviewSubmittedEvent extends GitEventBase {
  readonly kind: 'review_submitted';
  readonly prNumber: number;
  readonly reviewId: string;
  readonly reviewer: GitActor;
  readonly state: 'approved' | 'changes_requested' | 'commented' | 'dismissed';
  readonly commitSha: string;
}

export interface CheckCompletedEvent extends GitEventBase {
  readonly kind: 'check_completed';
  readonly sha: string;
  /** Open pull requests whose head is `sha` (polling); may be empty for webhooks. */
  readonly prNumbers: readonly number[];
  readonly checkSource: CheckItem['source'];
  readonly checkId: string;
  readonly name: string;
  readonly conclusion: CheckConclusion;
}

/**
 * A pull request was closed, merged or not (task E01, D-03 §7.1: the merge event). A trigger only:
 * G7 reads the pull request again (`getPullRequest`) before it decides.
 */
export interface PullRequestClosedEvent extends GitEventBase {
  readonly kind: 'pull_request_closed';
  readonly prNumber: number;
  readonly merged: boolean;
  readonly headSha: string;
}

/**
 * Something that happened on the Git host. Events are triggers: gates read the current state
 * (`getReviews`, `getCheckStatus`, `getPullRequest`) before they decide.
 */
export type GitEvent =
  CommentCreatedEvent | ReviewSubmittedEvent | CheckCompletedEvent | PullRequestClosedEvent;

/** The Git host adapter (design/D-03 section 7.1). */
export interface GitHostAdapter {
  createIssueComment(ref: RepoRef, issue: number, body: string): Promise<void>;
  getPullRequest(ref: RepoRef, pr: number): Promise<PullRequestInfo>;
  /** Changed paths; for renamed files both the old and the new path. Sorted, unique. */
  getChangedFiles(ref: RepoRef, pr: number): Promise<string[]>;
  getCheckStatus(ref: RepoRef, sha: string): Promise<CheckSummary>;
  getApprovals(ref: RepoRef, pr: number): Promise<Approval[]>;
  /**
   * The latest review decision of each reviewer (task E01): approvals, requests for changes and
   * dismissed reviews. Never a partial list.
   */
  getReviews(ref: RepoRef, pr: number): Promise<ReviewDecision[]>;
  /** The accounts that authored the pull request's commits (task E01). Never a partial list. */
  getCommitAuthors(ref: RepoRef, pr: number): Promise<CommitAuthors>;
  /**
   * A merged pull request's files with their status, its commit count and the parents of its
   * merge commit (task L07). A pull request that is not merged fails (`invalid_input`, field `pr`).
   */
  getMergedChange(ref: RepoRef, pr: number): Promise<MergedChange>;
  /** The parents of a commit, first parent first (task L07). */
  getCommitParents(ref: RepoRef, sha: string): Promise<string[]>;
  /**
   * The paths changed from `base` to `head` (task L07), with both paths of a renamed file, sorted
   * and unique, as `getChangedFiles`. Never a partial list.
   */
  compareChangedFiles(ref: RepoRef, base: string, head: string): Promise<string[]>;
  /** The file content as UTF-8 text, exactly as stored (no line-ending changes). */
  getFileAtCommit(ref: RepoRef, path: string, sha: string): Promise<string>;
  /** The commit a branch points to now (40 hex characters). G4 reads the run's base (C06). */
  getBranchHead(ref: RepoRef, branch: string): Promise<string>;
  /**
   * Every path of the commit's tree that is not a directory (files, symbolic links, submodules),
   * sorted (task C07, QUESTIONS #126: G4 refuses agent instruction files the register does not
   * pin). Never a partial list: a tree the host lists only in part fails with `tree_truncated`.
   */
  listPaths(ref: RepoRef, sha: string): Promise<string[]>;
  /**
   * The entries directly in one folder of a commit's tree, sorted by name, with their kind and Git
   * object ID (task X13, ADR-M74 0.2: the memory set). `folder` is a path of plain segments
   * without a leading or trailing `/`. A missing folder, or a path that is not a folder, gives
   * an empty list. Never a partial list (`tree_truncated`).
   */
  listFolder(ref: RepoRef, sha: string, folder: string): Promise<FolderEntry[]>;
  /**
   * The commits that changed `path` (a file or a folder) reachable from `head`, newest first
   * (task X13, ADR-M74 0.2: the producers of a memory change). Stops before `stopAt` when it is
   * one of them. `complete` is false when more than `max` commits (1–100) would be listed: the
   * caller fails closed.
   */
  listPathCommits(
    ref: RepoRef,
    head: string,
    path: string,
    options: { readonly stopAt?: string | undefined; readonly max: number },
  ): Promise<PathCommits>;
  issueShortLivedToken(ref: RepoRef, scope: TokenScope): Promise<ShortLivedToken>;
  /**
   * Revokes a token of `issueShortLivedToken` at once (task C11, ADR-M42 §2.4). Needs only the
   * token itself: the runner revokes the clone and push tokens right after their use. A token that
   * is already revoked or expired counts as revoked.
   */
  revokeShortLivedToken(token: RedactedSecret): Promise<void>;
  /**
   * Opens a pull request (task C08, ADR-M38 §2.4). Never a draft. The adapter uses a token that
   * may write pull requests for this call only; its own token stays read-only.
   */
  openPullRequest(ref: RepoRef, input: NewPullRequest): Promise<PullRequestInfo>;
  /**
   * The open pull request from `head` (a branch of the same repository) into `base`, or null
   * (task C08: find before opening, so a repeated call never opens a second one).
   */
  findOpenPullRequest(ref: RepoRef, head: string, base: string): Promise<PullRequestInfo | null>;
  /**
   * Deletes a memory branch (`MEMORY_BRANCH`; task X13 PR 3b, ADR-M74 §2.5 step 5) when it still
   * points to `expectedHead`: `deleted`; `absent` when there is no such branch; `moved` (nothing
   * deleted) when someone else changed it. Any other branch name is `invalid_input`: the platform
   * never deletes another branch. Uses a token that may write contents for this call only.
   */
  deleteBranch(ref: RepoRef, branch: string, expectedHead: string): Promise<BranchDeletion>;
  /**
   * The web address of an issue, a pull request or a file at a commit (X08a, ADR-M109 §2.1). A
   * pure function of its input and the adapter's configuration: no call to the Git host. Throws
   * `invalid_input` for a number, path or commit it cannot name.
   */
  webUrl(ref: RepoRef, target: WebTarget): string;
  /**
   * X08b (QUESTIONS #729): the comment ID named by a web address of a comment of this repository
   * (an issue's or a pull request's), or null for any other address. A pure function.
   */
  commentIdOf(ref: RepoRef, url: string): string | null;
  /**
   * The open security findings of a pull request (task C08 PR 2): counts per severity, or
   * unknown. Uses a token of its own that may read code-scanning alerts.
   */
  getSecurityFindings(ref: RepoRef, pr: number): Promise<SecurityFindings>;
  /**
   * One review and its line comments, read with `token` (task E01 PR 2, ADR-M41 §2.7): a token of
   * `issueShortLivedToken` with `pull_requests: read`, so the runner needs no App key. Never logged.
   */
  getReviewFeedback(
    token: RedactedSecret,
    ref: RepoRef,
    pr: number,
    reviewId: string,
  ): Promise<ReviewFeedback>;
  /**
   * One comment of an issue or a pull request, read with `token` (task E01 PR 2): `issues: read`
   * for a comment on an issue, `pull_requests: read` for one on a pull request. Never logged.
   */
  getIssueComment(
    token: RedactedSecret,
    ref: RepoRef,
    commentId: string,
  ): Promise<IssueCommentText>;
  /** MVP: polling. Pass `INITIAL_EVENT_CURSOR` for a project that has never been polled. */
  listEventsSince(
    ref: RepoRef,
    cursor: EventCursor,
  ): Promise<{ events: GitEvent[]; next: EventCursor }>;
  /**
   * O06 PR 2c (ADR-M106 §2.4): a cursor never newer than any of `cursors`, for one read of a
   * repository that several projects poll. Pure: no call to the Git host. A read from it may return
   * an event again to a project that handled it; the caller is idempotent by event ID. `''`
   * (never polled) is left out; with no other cursor the result is `INITIAL_EVENT_CURSOR`.
   */
  oldestEventCursor(cursors: readonly EventCursor[]): EventCursor;
  /** Enabled later (ADR-M11). Throws `GitHostError` when the signature is wrong. */
  verifyWebhook(headers: Record<string, string>, rawBody: Buffer): GitEvent;
}

/** Why a Git host call failed. Codes only; the texts are in the message catalog (NFR-08). */
export const GIT_HOST_ERROR_CODES = [
  'invalid_input',
  'secret_invalid',
  'auth_failed',
  'app_not_installed',
  'forbidden',
  'not_found',
  'rejected',
  'rate_limited',
  'server_error',
  'network_error',
  'timeout',
  'invalid_response',
  'invalid_cursor',
  'body_too_large',
  'file_too_large',
  'file_not_utf8',
  'not_a_file',
  'too_many_files',
  'tree_truncated',
  'webhook_disabled',
  'webhook_bad_signature',
  'unsupported_event',
] as const;
export type GitHostErrorCode = (typeof GIT_HOST_ERROR_CODES)[number];

/** Safe values only: HTTP status codes, repository names, limits, times. Never text from the host. */
export type GitHostErrorParams = Readonly<Record<string, string | number>>;

export class GitHostError extends Error {
  override readonly name = 'GitHostError';

  constructor(
    readonly code: GitHostErrorCode,
    readonly params: GitHostErrorParams = {},
  ) {
    super(`git_host.${code}`);
  }
}

export type GitHostLogEvent =
  | 'git_host.key_loaded'
  | 'git_host.token_issued'
  | 'git_host.request_retry'
  | 'git_host.rate_limited'
  | 'git_host.rate_limit_low'
  | 'git_host.poll_truncated';

/** Structured log hook. Fields hold safe values only: never tokens, keys or comment text. */
export interface GitHostLogger {
  log(
    level: 'info' | 'warn' | 'error',
    event: GitHostLogEvent,
    fields: Readonly<Record<string, string | number | boolean>>,
  ): void;
}
