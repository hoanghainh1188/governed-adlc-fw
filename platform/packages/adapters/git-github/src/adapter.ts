// GitHub implementation of `GitHostAdapter` (design/D-03 section 7.1, D-08 B05, ADR-M23).
import type {
  BranchDeletion,
  WebTarget,
  Approval,
  PullRequestFile,
  PullRequestFileStatus,
  CheckItem,
  CheckSummary,
  CommitAuthors,
  EventCursor,
  FolderEntry,
  GitActor,
  GitEvent,
  GitHostAdapter,
  IssueCommentText,
  MergedChange,
  NewPullRequest,
  PathCommits,
  PullRequestInfo,
  RedactedSecret,
  ReviewDecision,
  ReviewFeedback,
  ReviewLineComment,
  SecurityFindings,
  Severity,
  RepoRef,
  ShortLivedToken,
  TokenScope,
} from '@sdlc/contracts';
import { GitHostError, MEMORY_BRANCH } from '@sdlc/contracts';

import { AppAuth, checkScope } from './app-auth.js';
import { oldestCursor } from './cursor.js';
import { GitHubHttp } from './http.js';
import {
  actor,
  arr,
  bool,
  checkNumber,
  checkRepo,
  id,
  int,
  isSha,
  obj,
  optStr,
  repoPath,
  sha,
  str,
  time,
  url,
} from './json.js';
import { checkRunItem, reviewEvent, statusItem } from './mapping.js';
import { resolveOptions, type GitHubAdapterOptions, type ResolvedOptions } from './options.js';
import { listPages } from './pages.js';
import { Poller } from './polling.js';
import { SecretString } from './secret-string.js';
import { listFolderEntries, listPathCommits } from './folder.js';
import { listTreePaths } from './tree.js';
import { verifyWebhookRequest } from './webhook.js';

/** GitHub limits: comment bodies (characters) and files listed for one pull request. */
export const MAX_COMMENT_CHARS = 65_536;
export const MAX_PULL_REQUEST_FILES = 3000;
/** GitHub's limit of a pull request title (characters). */
export const MAX_PULL_REQUEST_TITLE_CHARS = 256;
/** GitHub lists at most 250 commits of a pull request. */
export const MAX_PULL_REQUEST_COMMITS = 250;
/** GitHub's compare API lists at most 300 files, on its first page only. */
export const MAX_COMPARE_FILES = 300;
const FILE_STATUSES: Readonly<Record<string, PullRequestFileStatus>> = {
  added: 'added',
  modified: 'modified',
  changed: 'modified',
  removed: 'removed',
  renamed: 'renamed',
  copied: 'copied',
};
const FAILED: ReadonlySet<string> = new Set([
  'failure',
  'error',
  'cancelled',
  'timed_out',
  'action_required',
  'stale',
]);
const LIST_PAGES = 30;
/**
 * Line comments read with a review's feedback (E01 PR 2): one page. The runner caps the text at
 * `REVIEW_FEEDBACK_MAX_CHARS` anyway, so more comments would only be cut.
 */
export const MAX_REVIEW_FEEDBACK_COMMENTS = 50;
const REVIEW_FEEDBACK_STATES: Readonly<Record<string, ReviewFeedback['state']>> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes_requested',
  COMMENTED: 'commented',
  DISMISSED: 'dismissed',
};
/** Errors that mean "findings unknown" for code scanning (not an outage). */
const UNKNOWN_FINDINGS: ReadonlySet<string> = new Set(['forbidden', 'rejected']);

export class GitHubAdapter implements GitHostAdapter {
  readonly #options: ResolvedOptions;
  readonly #http: GitHubHttp;
  readonly #auth: AppAuth;
  readonly #poller: Poller;

  constructor(options: GitHubAdapterOptions) {
    this.#options = resolveOptions(options);
    this.#http = new GitHubHttp(this.#options);
    this.#auth = new AppAuth(this.#options, this.#http);
    this.#poller = new Poller(this.#options, this.#http);
  }

  async createIssueComment(ref: RepoRef, issue: number, body: string): Promise<void> {
    const base = repoPath(ref);
    checkNumber(issue, 'issue');
    if (typeof body !== 'string' || body.trim() === '') {
      throw new GitHostError('invalid_input', { field: 'body' });
    }
    if (body.length > MAX_COMMENT_CHARS) {
      throw new GitHostError('body_too_large', { max_chars: MAX_COMMENT_CHARS });
    }
    await this.#auth.withRepoAuth(ref, (auth) =>
      this.#http.json('POST', `${base}/issues/${issue}/comments`, { auth, body: { body } }),
    );
  }

  async getPullRequest(ref: RepoRef, pr: number): Promise<PullRequestInfo> {
    const base = repoPath(ref);
    checkNumber(pr, 'pr');
    const res = await this.#auth.withRepoAuth(ref, (auth) =>
      this.#http.json('GET', `${base}/pulls/${pr}`, { auth }),
    );
    return pullRequestInfo(res.body);
  }

  /**
   * Opens a pull request from a branch of the same repository (task C08, ADR-M38 §2.4). The call
   * uses its own token with `pull_requests: write`; the adapter's cached token stays read-only.
   * Never a draft; maintainers of forks cannot push to it (`maintainer_can_modify: false`).
   */
  async openPullRequest(ref: RepoRef, input: NewPullRequest): Promise<PullRequestInfo> {
    const repo = checkRepo(ref);
    const base = repoPath(repo);
    encodeBranch(input?.head);
    encodeBranch(input?.base);
    for (const field of ['title', 'body'] as const) {
      const value = input[field];
      if (typeof value !== 'string' || value.trim() === '') {
        throw new GitHostError('invalid_input', { field });
      }
    }
    if (input.title.length > MAX_PULL_REQUEST_TITLE_CHARS) {
      throw new GitHostError('invalid_input', { field: 'title' });
    }
    if (input.body.length > MAX_COMMENT_CHARS) {
      throw new GitHostError('body_too_large', { max_chars: MAX_COMMENT_CHARS });
    }
    const minted = await this.#auth.mint(repo, { pull_requests: 'write' });
    const res = await this.#http.json('POST', `${base}/pulls`, {
      auth: `Bearer ${minted.token}`,
      body: {
        title: input.title,
        body: input.body,
        head: input.head,
        base: input.base,
        draft: false,
        maintainer_can_modify: false,
      },
    });
    const info = pullRequestInfo(res.body);
    if (info.headRef !== input.head || info.baseRef !== input.base) {
      throw new GitHostError('invalid_response', { field: 'pull.head' });
    }
    return info;
  }

  /**
   * The open pull request from `head` into `base`, or null. GitHub's list holds no file count,
   * so the match is read again by number. More than one match is refused (fail closed).
   */
  async findOpenPullRequest(
    ref: RepoRef,
    head: string,
    baseBranch: string,
  ): Promise<PullRequestInfo | null> {
    const repo = checkRepo(ref);
    const base = repoPath(repo);
    encodeBranch(head);
    encodeBranch(baseBranch);
    const list = await this.#auth.withRepoAuth(repo, (auth) =>
      listPages(this.#http, `${base}/pulls`, {
        auth,
        maxPages: 1,
        query: { state: 'open', head: `${repo.owner}:${head}`, base: baseBranch },
      }),
    );
    const matches = list.items.filter((item) => {
      const p = obj(item, 'pull');
      return str(obj(p.head, 'pull.head').ref, 'pull.head.ref') === head;
    });
    if (list.truncated || matches.length > 1) {
      throw new GitHostError('invalid_response', { field: 'pulls' });
    }
    if (matches.length === 0) return null;
    const info = await this.getPullRequest(
      repo,
      int(obj(matches[0], 'pull').number, 'pull.number'),
    );
    if (info.state !== 'open' || info.headRef !== head || info.baseRef !== baseBranch) return null;
    return info;
  }

  async getChangedFiles(ref: RepoRef, pr: number): Promise<string[]> {
    const base = repoPath(ref);
    const info = await this.getPullRequest(ref, pr);
    // GitHub lists at most 3000 files. A partial list could hide a change outside the plan (G5),
    // so a bigger pull request fails instead.
    if (info.changedFiles > MAX_PULL_REQUEST_FILES) {
      throw new GitHostError('too_many_files', { max_files: MAX_PULL_REQUEST_FILES });
    }
    const list = await this.#auth.withRepoAuth(ref, (auth) =>
      listPages(this.#http, `${base}/pulls/${pr}/files`, { auth, maxPages: LIST_PAGES }),
    );
    if (list.truncated || list.items.length !== info.changedFiles) {
      throw new GitHostError('invalid_response', { field: 'files' });
    }
    const paths = new Set<string>();
    for (const item of list.items) {
      const f = obj(item, 'file');
      paths.add(str(f.filename, 'file.filename'));
      // A rename changes the old path too.
      const previous = optStr(f.previous_filename, 'file.previous_filename');
      if (previous) paths.add(previous);
    }
    return [...paths].sort();
  }

  async getCheckStatus(ref: RepoRef, commitSha: string): Promise<CheckSummary> {
    const base = repoPath(ref);
    if (!isSha(commitSha)) throw new GitHostError('invalid_input', { field: 'sha' });
    return this.#auth.withRepoAuth(ref, async (auth) => {
      const runs = await listPages(this.#http, `${base}/commits/${commitSha}/check-runs`, {
        auth,
        maxPages: LIST_PAGES,
        query: { filter: 'latest' },
        extract: (body) => arr(obj(body, 'check_runs').check_runs, 'check_runs'),
      });
      if (runs.truncated) throw new GitHostError('invalid_response', { field: 'check_runs' });
      const status = await this.#http.json('GET', `${base}/commits/${commitSha}/status`, {
        auth,
        query: { per_page: 100 },
      });
      const checks: CheckItem[] = [
        ...runs.items.map((run) => toCheckItem(checkRunItem(run))),
        ...arr(obj(status.body, 'status').statuses, 'statuses').map((s) =>
          toCheckItem(statusItem(s)),
        ),
      ];
      return { sha: commitSha, state: summaryState(checks), checks };
    });
  }

  async getApprovals(ref: RepoRef, pr: number): Promise<Approval[]> {
    return (await this.getReviews(ref, pr))
      .filter((r) => r.state === 'approved')
      .map((r) => ({
        reviewId: r.reviewId,
        reviewer: r.reviewer,
        commitSha: r.commitSha,
        submittedAt: r.submittedAt,
        url: r.url,
      }));
  }

  /**
   * The latest review decision of each reviewer (task E01). Reviews are sorted by submission time
   * and ID; a comment never changes a decision (GitHub rule). A dismissed review keeps its ID and
   * time with the state `dismissed`, so it replaces the approval it was.
   */
  async getReviews(ref: RepoRef, pr: number): Promise<ReviewDecision[]> {
    const base = repoPath(ref);
    checkNumber(pr, 'pr');
    const list = await this.#auth.withRepoAuth(ref, (auth) =>
      listPages(this.#http, `${base}/pulls/${pr}/reviews`, { auth, maxPages: LIST_PAGES }),
    );
    if (list.truncated) throw new GitHostError('invalid_response', { field: 'reviews' });
    const reviews = list.items
      .map((item) => reviewEvent(checkRepo(ref), pr, item, 'polling'))
      .filter((r) => r !== null)
      .sort(
        (a, b) =>
          a.occurredAt.localeCompare(b.occurredAt) || Number(a.reviewId) - Number(b.reviewId),
      );
    const latest = new Map<string, ReviewDecision>();
    for (const r of reviews) {
      if (r.state === 'commented') continue;
      latest.set(r.reviewer.id, {
        eventId: r.id,
        reviewId: r.reviewId,
        reviewer: r.reviewer,
        state: r.state,
        commitSha: r.commitSha,
        submittedAt: r.occurredAt,
        url: r.url,
      });
    }
    return [...latest.values()];
  }

  /**
   * The accounts that authored the pull request's commits (task E01). GitHub lists at most 250
   * commits for a pull request; a longer list fails (never a partial list).
   */
  async getCommitAuthors(ref: RepoRef, pr: number): Promise<CommitAuthors> {
    const base = repoPath(ref);
    checkNumber(pr, 'pr');
    const list = await this.#auth.withRepoAuth(ref, (auth) =>
      listPages(this.#http, `${base}/pulls/${pr}/commits`, { auth, maxPages: 3 }),
    );
    if (list.truncated || list.items.length >= MAX_PULL_REQUEST_COMMITS) {
      throw new GitHostError('invalid_response', { field: 'commits' });
    }
    const accounts = new Map<string, GitActor>();
    let withoutAccount = 0;
    for (const item of list.items) {
      const commit = obj(item, 'commit');
      if (commit.author === null || commit.author === undefined) {
        withoutAccount += 1;
        continue;
      }
      const author = actor(commit.author, 'commit.author');
      accounts.set(author.id, author);
    }
    return { accounts: [...accounts.values()], withoutAccount };
  }

  /**
   * A merged pull request's files with their status, its commit count and its merge commit's
   * parents (task L07, ADR-M85 §2.3). Never a partial list: a list GitHub cuts short fails.
   */
  async getMergedChange(ref: RepoRef, pr: number): Promise<MergedChange> {
    const base = repoPath(ref);
    checkNumber(pr, 'pr');
    const res = await this.#auth.withRepoAuth(ref, (auth) =>
      this.#http.json('GET', `${base}/pulls/${pr}`, { auth }),
    );
    const info = pullRequestInfo(res.body);
    if (!info.merged || info.mergeCommitSha === null) {
      throw new GitHostError('invalid_input', { field: 'pr' });
    }
    const commitCount = int(obj(res.body, 'pull').commits, 'pull.commits');
    if (commitCount < 1 || commitCount >= MAX_PULL_REQUEST_COMMITS) {
      throw new GitHostError('invalid_response', { field: 'pull.commits' });
    }
    if (info.changedFiles > MAX_PULL_REQUEST_FILES) {
      throw new GitHostError('too_many_files', { max_files: MAX_PULL_REQUEST_FILES });
    }
    const list = await this.#auth.withRepoAuth(ref, (auth) =>
      listPages(this.#http, `${base}/pulls/${pr}/files`, { auth, maxPages: LIST_PAGES }),
    );
    if (list.truncated || list.items.length !== info.changedFiles) {
      throw new GitHostError('invalid_response', { field: 'files' });
    }
    const files = list.items.map((item) => pullRequestFile(item));
    if (new Set(files.map((f) => f.path)).size !== files.length) {
      throw new GitHostError('invalid_response', { field: 'files' });
    }
    return {
      mergeCommitSha: info.mergeCommitSha,
      mergeCommitParents: await this.getCommitParents(ref, info.mergeCommitSha),
      commitCount,
      files: files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    };
  }

  /** The parents of a commit, first parent first (task L07): the Git commits API. */
  async getCommitParents(ref: RepoRef, commitSha: string): Promise<string[]> {
    const base = repoPath(ref);
    if (!isSha(commitSha)) throw new GitHostError('invalid_input', { field: 'sha' });
    const res = await this.#auth.withRepoAuth(ref, (auth) =>
      this.#http.json('GET', `${base}/git/commits/${commitSha}`, { auth }),
    );
    const commit = obj(res.body, 'commit');
    if (sha(commit.sha, 'commit.sha') !== commitSha) {
      throw new GitHostError('invalid_response', { field: 'commit.sha' });
    }
    return arr(commit.parents, 'commit.parents').map((parent) =>
      sha(obj(parent, 'commit.parent').sha, 'commit.parent.sha'),
    );
  }

  /**
   * The paths changed from `base` to `head` (task L07), both paths of a renamed file, sorted and
   * unique. GitHub's compare API lists at most 300 files; a bigger change fails (`too_many_files`)
   * instead of a partial list.
   */
  async compareChangedFiles(ref: RepoRef, baseSha: string, headSha: string): Promise<string[]> {
    const base = repoPath(ref);
    if (!isSha(baseSha)) throw new GitHostError('invalid_input', { field: 'base' });
    if (!isSha(headSha)) throw new GitHostError('invalid_input', { field: 'head' });
    const res = await this.#auth.withRepoAuth(ref, (auth) =>
      this.#http.json('GET', `${base}/compare/${baseSha}...${headSha}`, {
        auth,
        query: { per_page: 1 },
      }),
    );
    const body = obj(res.body, 'compare');
    const files = arr(body.files ?? [], 'compare.files');
    if (files.length >= MAX_COMPARE_FILES) {
      throw new GitHostError('too_many_files', { max_files: MAX_COMPARE_FILES });
    }
    const paths = new Set<string>();
    for (const item of files) {
      const f = pullRequestFile(item);
      paths.add(f.path);
      if (f.previousPath !== null) paths.add(f.previousPath);
    }
    return [...paths].sort();
  }

  async getFileAtCommit(ref: RepoRef, path: string, commitSha: string): Promise<string> {
    const base = repoPath(ref);
    if (!isSha(commitSha)) throw new GitHostError('invalid_input', { field: 'sha' });
    const encoded = encodeFilePath(path);
    const bytes = await this.#auth.withRepoAuth(ref, (auth) =>
      this.#http.raw(
        `${base}/contents/${encoded}`,
        { auth, query: { ref: commitSha } },
        this.#options.maxFileBytes,
      ),
    );
    try {
      // `ignoreBOM` keeps a byte-order mark, so the text hashes like the stored file.
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw new GitHostError('file_not_utf8');
    }
  }

  /**
   * The commit a branch points to now (task C06, G4 base commit; QUESTIONS #109). Reads the Git
   * reference `heads/<branch>`; an annotated or other non-commit object is refused.
   */
  async getBranchHead(ref: RepoRef, branch: string): Promise<string> {
    const base = repoPath(ref);
    const encoded = encodeBranch(branch);
    const res = await this.#auth.withRepoAuth(ref, (auth) =>
      this.#http.json('GET', `${base}/git/ref/heads/${encoded}`, { auth }),
    );
    const object = obj(obj(res.body, 'ref').object, 'ref.object');
    if (str(object.type, 'ref.object.type') !== 'commit') {
      throw new GitHostError('invalid_response', { field: 'ref.object.type' });
    }
    return sha(object.sha, 'ref.object.sha');
  }

  /**
   * Every non-directory path of the commit's tree (task C07, QUESTIONS #126). A tree that GitHub
   * cuts short is listed in parts, up to `maxTreeRequests` calls (task O06, ADR-M106); past that a
   * partial list could hide an agent instruction file, so it fails with `tree_truncated` (fail
   * closed, ADR-M34 §2.4).
   */
  async listPaths(ref: RepoRef, commitSha: string): Promise<string[]> {
    if (!isSha(commitSha)) throw new GitHostError('invalid_input', { field: 'sha' });
    return listTreePaths(
      { http: this.#http, auth: this.#auth, maxRequests: this.#options.maxTreeRequests },
      ref,
      commitSha,
    );
  }

  /** Entries directly in a folder of a commit (task X13, ADR-M74 0.2); [] without the folder. */
  listFolder(ref: RepoRef, commitSha: string, folder: string): Promise<FolderEntry[]> {
    return listFolderEntries({ http: this.#http, auth: this.#auth }, ref, commitSha, folder);
  }

  /** The commits that changed a path, newest first (task X13, ADR-M74 0.2). */
  listPathCommits(
    ref: RepoRef,
    head: string,
    path: string,
    options: { readonly stopAt?: string | undefined; readonly max: number },
  ): Promise<PathCommits> {
    return listPathCommits({ http: this.#http, auth: this.#auth }, ref, head, path, options);
  }

  /**
   * The open code-scanning alerts of a pull request, counted per security severity (task C08 PR 2,
   * QUESTIONS #157; `alertSeverity`): the alert's security severity, or for a rule tagged
   * `security` without one its severity (error → high, warning → medium, note → low). Other alerts
   * (code quality) are not security findings. A token of its own with
   * `security_events: read` for this call. Code scanning not enabled (404) or not allowed (403, or
   * the App lacks the permission) → `known: false`, and G6 fails closed. Never a partial count.
   */
  async getSecurityFindings(ref: RepoRef, pr: number): Promise<SecurityFindings> {
    const repo = checkRepo(ref);
    const base = repoPath(repo);
    checkNumber(pr, 'pr');
    let token: string;
    try {
      token = (await this.#auth.mint(repo, { security_events: 'read' })).token;
    } catch (error) {
      if (error instanceof GitHostError && UNKNOWN_FINDINGS.has(error.code)) {
        return { known: false, reason: 'forbidden' };
      }
      throw error;
    }
    let list;
    try {
      list = await listPages(this.#http, `${base}/code-scanning/alerts`, {
        auth: `Bearer ${token}`,
        maxPages: LIST_PAGES,
        cache: false,
        // GitHub keeps a pull request's analyses under its merge ref (`pull_request` CI runs).
        query: { ref: `refs/pull/${String(pr)}/merge`, state: 'open' },
      });
    } catch (error) {
      if (error instanceof GitHostError && error.code === 'not_found') {
        return { known: false, reason: 'not_enabled' };
      }
      if (error instanceof GitHostError && UNKNOWN_FINDINGS.has(error.code)) {
        return { known: false, reason: 'forbidden' };
      }
      throw error;
    }
    if (list.truncated) throw new GitHostError('invalid_response', { field: 'alerts' });
    const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const item of list.items) {
      const level = alertSeverity(obj(obj(item, 'alert').rule, 'alert.rule'));
      if (level !== null) counts[level] += 1;
    }
    return { known: true, counts };
  }

  async issueShortLivedToken(ref: RepoRef, scope: TokenScope): Promise<ShortLivedToken> {
    const repo = checkRepo(ref);
    const minted = await this.#auth.mint(repo, checkScope(scope));
    return {
      token: new SecretString(minted.token),
      expiresAt: minted.expiresAt,
      repo,
      permissions: minted.permissions,
    };
  }

  /**
   * The web address of an issue, a pull request or a file at a commit (X08a, ADR-M109 §2.1):
   * `https://github.com/<owner>/<repo>/…`, or the GitHub Enterprise Server's own host when the
   * API is not `api.github.com`. No call to GitHub.
   */
  webUrl(ref: RepoRef, target: WebTarget): string {
    const repo = checkRepo(ref);
    const api = this.#options.apiUrl;
    const web = api.hostname === 'api.github.com' ? 'https://github.com' : api.origin;
    const base = `${web}/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
    if (target.kind === 'issue' || target.kind === 'pull_request') {
      if (!Number.isSafeInteger(target.number) || target.number < 1) {
        throw new GitHostError('invalid_input', { field: 'number' });
      }
      return `${base}/${target.kind === 'issue' ? 'issues' : 'pull'}/${String(target.number)}`;
    }
    if (!isSha(target.commitSha)) throw new GitHostError('invalid_input', { field: 'sha' });
    const parts = typeof target.path === 'string' ? target.path.split('/') : [];
    if (parts.length === 0 || parts.some((p) => p === '' || p === '.' || p === '..')) {
      throw new GitHostError('invalid_input', { field: 'path' });
    }
    return `${base}/blob/${target.commitSha}/${parts.map(encodeURIComponent).join('/')}`;
  }

  /**
   * Deletes a memory branch that still points to `expectedHead` (X13 PR 3b, ADR-M74 §2.5 step 5).
   * Reads the branch first: absent → `absent`; another commit → `moved`, nothing deleted. The
   * delete uses a token with `contents: write` for this call only, revoked right after.
   */
  async deleteBranch(ref: RepoRef, branch: string, expectedHead: string): Promise<BranchDeletion> {
    const repo = checkRepo(ref);
    if (typeof branch !== 'string' || !MEMORY_BRANCH.test(branch)) {
      throw new GitHostError('invalid_input', { field: 'branch' });
    }
    if (!isSha(expectedHead)) throw new GitHostError('invalid_input', { field: 'head' });
    let head: string;
    try {
      head = await this.getBranchHead(repo, branch);
    } catch (error) {
      if (error instanceof GitHostError && error.code === 'not_found') return 'absent';
      throw error;
    }
    if (head !== expectedHead) return 'moved';
    const minted = await this.#auth.mint(repo, { contents: 'write' });
    try {
      await this.#http.json('DELETE', `${repoPath(repo)}/git/refs/heads/${encodeBranch(branch)}`, {
        auth: `Bearer ${minted.token}`,
      });
    } catch (error) {
      // Deleted meanwhile: GitHub answers 404, or 422 "Reference does not exist".
      if (error instanceof GitHostError && error.code === 'not_found') return 'absent';
      if (error instanceof GitHostError && error.code === 'rejected') {
        const gone = await this.getBranchHead(repo, branch).then(
          () => false,
          (again: unknown) => again instanceof GitHostError && again.code === 'not_found',
        );
        if (gone) return 'absent';
      }
      throw error;
    } finally {
      await this.revokeShortLivedToken(new SecretString(minted.token)).catch(() => undefined);
    }
    return 'deleted';
  }

  /**
   * Revokes an installation token the platform issued (task C11, ADR-M42 §2.4): GitHub revokes a
   * token only with the token itself (`DELETE /installation/token`). An already revoked or expired
   * token (401) counts as revoked. Needs no App key, so the runner can call it.
   */
  async revokeShortLivedToken(token: RedactedSecret): Promise<void> {
    const value = token?.reveal();
    if (typeof value !== 'string' || value.length === 0) {
      throw new GitHostError('invalid_input', { field: 'token' });
    }
    try {
      await this.#http.json('DELETE', 'installation/token', { auth: `Bearer ${value}` });
    } catch (error) {
      if (error instanceof GitHostError && error.code === 'auth_failed') return;
      throw error;
    }
  }

  /**
   * One review and its line comments (task E01 PR 2, ADR-M41 §2.7), read with the caller's token
   * (`pull_requests: read`): the runner holds no App key. One page of line comments at most. The
   * texts are returned to the caller only; nothing is logged or cached.
   */
  async getReviewFeedback(
    token: RedactedSecret,
    ref: RepoRef,
    pr: number,
    reviewId: string,
  ): Promise<ReviewFeedback> {
    const base = repoPath(ref);
    checkNumber(pr, 'pr');
    const review = checkObjectId(reviewId, 'review_id');
    const auth = bearer(token);
    const res = await this.#http.json('GET', `${base}/pulls/${pr}/reviews/${review}`, { auth });
    const r = obj(res.body, 'review');
    const state = REVIEW_FEEDBACK_STATES[str(r.state, 'review.state').toUpperCase()];
    if (!state || id(r.id, 'review.id') !== review) {
      throw new GitHostError('invalid_response', { field: 'review' });
    }
    const list = await this.#http.json('GET', `${base}/pulls/${pr}/reviews/${review}/comments`, {
      auth,
      query: { per_page: MAX_REVIEW_FEEDBACK_COMMENTS },
    });
    const items = arr(list.body, 'review.comments');
    const comments: ReviewLineComment[] = items
      .slice(0, MAX_REVIEW_FEEDBACK_COMMENTS)
      .map((item) => {
        const c = obj(item, 'review.comment');
        const line = c.line ?? c.original_line;
        return {
          path: str(c.path, 'review.comment.path'),
          line: line === null || line === undefined ? null : int(line, 'review.comment.line'),
          body: optStr(c.body, 'review.comment.body') ?? '',
        };
      });
    return {
      reviewId: review,
      reviewer: actor(r.user, 'review.user'),
      state,
      commitSha: sha(r.commit_id, 'review.commit_id'),
      body: optStr(r.body, 'review.body') ?? '',
      comments,
      commentsTruncated: list.next !== null || items.length > MAX_REVIEW_FEEDBACK_COMMENTS,
    };
  }

  /**
   * One comment of an issue or a pull request (task E01 PR 2: a `/request-changes G7` command),
   * read with the caller's token: `issues: read` or `pull_requests: read`, as GitHub accepts either
   * for this endpoint. Nothing is logged or cached.
   */
  async getIssueComment(
    token: RedactedSecret,
    ref: RepoRef,
    commentId: string,
  ): Promise<IssueCommentText> {
    const base = repoPath(ref);
    const comment = checkObjectId(commentId, 'comment_id');
    const res = await this.#http.json('GET', `${base}/issues/comments/${comment}`, {
      auth: bearer(token),
    });
    const c = obj(res.body, 'comment');
    if (id(c.id, 'comment.id') !== comment) {
      throw new GitHostError('invalid_response', { field: 'comment.id' });
    }
    return {
      commentId: comment,
      author: actor(c.user, 'comment.user'),
      body: optStr(c.body, 'comment.body') ?? '',
    };
  }

  async listEventsSince(
    ref: RepoRef,
    cursor: EventCursor,
  ): Promise<{ events: GitEvent[]; next: EventCursor }> {
    const repo = checkRepo(ref);
    return this.#auth.withRepoAuth(repo, (auth) => this.#poller.poll(repo, cursor, auth));
  }

  oldestEventCursor(cursors: readonly EventCursor[]): EventCursor {
    return oldestCursor(cursors);
  }

  verifyWebhook(headers: Record<string, string>, rawBody: Buffer): GitEvent {
    return verifyWebhookRequest(this.#options.webhookSecret, headers, rawBody);
  }
}

/** A pull request of the REST API (single read or create answer). */
/** One file of a pull request or a comparison (task L07). An unknown status is refused. */
function pullRequestFile(item: unknown): PullRequestFile {
  const f = obj(item, 'file');
  const status = FILE_STATUSES[str(f.status, 'file.status')];
  if (status === undefined) throw new GitHostError('invalid_response', { field: 'file.status' });
  const previousPath = optStr(f.previous_filename, 'file.previous_filename');
  return { path: str(f.filename, 'file.filename'), status, previousPath };
}

function pullRequestInfo(body: unknown): PullRequestInfo {
  const p = obj(body, 'pull');
  const head = obj(p.head, 'pull.head');
  const baseRef = obj(p.base, 'pull.base');
  const state = str(p.state, 'pull.state');
  if (state !== 'open' && state !== 'closed') {
    throw new GitHostError('invalid_response', { field: 'pull.state' });
  }
  const mergedAt = p.merged_at === null ? null : time(p.merged_at, 'pull.merged_at');
  const mergeSha = optStr(p.merge_commit_sha, 'pull.merge_commit_sha');
  return {
    number: int(p.number, 'pull.number'),
    state,
    draft: bool(p.draft ?? false, 'pull.draft'),
    merged: mergedAt !== null,
    mergedAt,
    mergeCommitSha: mergeSha && isSha(mergeSha) ? mergeSha : null,
    headSha: sha(head.sha, 'pull.head.sha'),
    headRef: str(head.ref, 'pull.head.ref'),
    baseRef: str(baseRef.ref, 'pull.base.ref'),
    author: actor(p.user, 'pull.user'),
    mergedBy:
      mergedAt === null || p.merged_by === null || p.merged_by === undefined
        ? null
        : actor(p.merged_by, 'pull.merged_by'),
    changedFiles: int(p.changed_files, 'pull.changed_files'),
    url: url(p.html_url, 'pull.html_url'),
  };
}

const RULE_SEVERITY: Readonly<Record<string, Severity>> = {
  error: 'high',
  warning: 'medium',
  note: 'low',
};

/**
 * The security severity of a code-scanning alert's rule, or null when it is not a security
 * finding. A SARIF tool that marks a rule `security` without a `security-severity` must not hide
 * it (fail closed, code review of C08 PR 2): its rule severity counts. An unknown value is refused.
 */
function alertSeverity(rule: Record<string, unknown>): Severity | null {
  const level = rule.security_severity_level;
  if (level !== null && level !== undefined) {
    if (level !== 'critical' && level !== 'high' && level !== 'medium' && level !== 'low') {
      throw new GitHostError('invalid_response', { field: 'alert.rule.security_severity_level' });
    }
    return level;
  }
  const tags = Array.isArray(rule.tags) ? rule.tags : [];
  if (!tags.includes('security')) return null;
  return RULE_SEVERITY[String(rule.severity)] ?? 'high';
}

function toCheckItem(item: CheckItem): CheckItem {
  const { source, id, name, completed, conclusion } = item;
  return { source, id, name, completed, conclusion };
}

function summaryState(checks: readonly CheckItem[]): CheckSummary['state'] {
  if (checks.length === 0) return 'none';
  if (checks.some((c) => c.conclusion !== null && FAILED.has(c.conclusion))) return 'failure';
  if (checks.some((c) => !c.completed)) return 'pending';
  return 'success';
}

/** A repository file path for the contents API: relative, no `.` or `..` segments. */
/**
 * A branch name, checked before it reaches a URL: Git's reference rules for the characters the
 * platform needs (letters, digits, `.`, `_`, `-`, `/` between parts), at most 255 characters.
 */
function encodeBranch(branch: string): string {
  if (
    typeof branch !== 'string' ||
    branch.length === 0 ||
    branch.length > 255 ||
    !/^[A-Za-z0-9._/-]+$/.test(branch) ||
    branch.endsWith('.lock') ||
    branch.startsWith('-') ||
    branch.split('/').some((s) => s === '' || s.startsWith('.') || s.includes('..'))
  ) {
    throw new GitHostError('invalid_input', { field: 'branch' });
  }
  return branch.split('/').map(encodeURIComponent).join('/');
}

function encodeFilePath(path: string): string {
  if (typeof path !== 'string' || path.length === 0 || path.length > 4096) {
    throw new GitHostError('invalid_input', { field: 'path' });
  }
  const segments = path.split('/');
  if (
    segments.some(
      (s) => s === '' || s === '.' || s === '..' || s.includes('\\') || s.includes('\0'),
    )
  ) {
    throw new GitHostError('invalid_input', { field: 'path' });
  }
  return segments.map(encodeURIComponent).join('/');
}

/** A GitHub object ID given by the caller: a positive decimal number, no leading zero. */
function checkObjectId(value: string, field: string): string {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,18}$/.test(value)) {
    throw new GitHostError('invalid_input', { field });
  }
  return value;
}

/** The `Authorization` value of a caller's token. The value is never logged (`GitHubHttp`). */
function bearer(token: RedactedSecret): string {
  const value = token?.reveal();
  if (typeof value !== 'string' || value.length === 0) {
    throw new GitHostError('invalid_input', { field: 'token' });
  }
  return `Bearer ${value}`;
}
