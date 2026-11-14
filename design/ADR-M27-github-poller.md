# ADR-M27. GitHub poller and comment commands

| Item | Value |
|---|---|
| Status | **Accepted** (Harry, 2026-10-16; built by task B06) |
| Date | 2026-09-27 |
| Decided by | Harry (plan approved 2026-09-27: D1 = A, D2, D3, D4 = A, with conditions) |
| Related | D-02 FR-10, FR-11, FR-17, FR-21, FR-22 and the "Receiving GitHub events" note; D-03 sections 5.1, 6.2, 6.3, 7.1, 12 (ADR-M11); D-05 sections 6.1, 6.1b (version 1.8), 6.3; D-08 tasks B06, B07, B11, B13, E01; ADR-M09, ADR-M18, ADR-M19, ADR-M20, ADR-M21, ADR-M23, ADR-M26; QUESTIONS #43, #45, #64, #68 |

## 1. Context

Task B06 reads GitHub events by polling (ADR-M11) and turns comment commands into gate decisions (FR-21). B05 built the adapter: `listEventsSince` returns the new events and the next cursor, and the caller stores the cursor (ADR-M23 §2.3). B03 built the shared gate command handler `decideGate` (ADR-M26 §2.4).

These points were open:

- how the worker schedules the polls, survives restarts and runs one poll per project at a time;
- how a crash between handling the events and saving the cursor is kept from applying an event twice;
- the command grammar, and where the `<reason>` text goes, because append-only tables hold no free text;
- how a comment is linked to an intent, and how the commenter is checked;
- how replies are posted, and in which language;
- how the worker is deployed.

## 2. Decision

### 2.1. A plain loop in the worker, no Temporal (D1)

- The worker runs a loop (`PollerLoop`, `platform/apps/worker/src/poller-loop.ts`).
  - Every tick (`SDLC_WORKER_TICK_MS`, default 1 s), it reads the pollable projects (`SystemScope.listPollableProjects()`) and starts the polls that are due.
  - Before every poll it reads the project's `github.poll_interval_seconds` (default 30) from the project configuration. A configuration change applies without a restart.
  - A project never has two polls running at once in one process. At most `SDLC_WORKER_MAX_CONCURRENT_POLLS` polls run at once (default 4); the projects that have waited longest go first, so none is starved.
  - After a `rate_limited` error, the project waits until GitHub's reset time (`retry_at`).
  - A project whose configuration cannot be read is skipped and tried again after 60 s. This is a technical retry delay, not a handbook rule.
- All state is in PostgreSQL: the cursor (`git_event_cursors`) and the receipts (`git_event_receipts`). After a restart, every project is polled once right away and continues from its stored cursor.
- `listPollableProjects()` crosses tenants, so it is a named system-scope method (ADR-M09 §2.4). It returns `tenantId`, `projectId` and the repository name of the active GitHub projects of active tenants, nothing else (tested). Everything after it runs in `forTenant(tenantId)`.
- Not chosen: one Temporal Schedule per project. It would write about 2,900 workflow runs per project per day into Temporal's history on a small server, and the interval would have to be synced with the configuration. B07 can still signal workflows from the loop.

### 2.2. One transaction, receipts, compare-and-set (D2)

`pollProject` (`@sdlc/core`, `git-events/poll-project.ts`) does one poll:

1. It reads the cursor and calls `listEventsSince`, outside any transaction.
2. In **one transaction**:
   - it moves the cursor first, with compare-and-set (`gitEventCursors.saveIfUnchanged`). When another poller moved it, the whole transaction rolls back (`cursor_moved`). The updated row stays locked until the commit, so a second poller waits and then fails the check.
   - it handles every event with `handleGitEvent` (`core/src/commands/git-event-handler.ts`). This is the one handler for polling now and webhooks later (ADR-M11).
3. After the commit, it posts the pending replies (§2.4).

- A crash before the commit applies nothing, and the next poll reads the same events again.
- The handler is also idempotent by `event.id`. Each command comment gets one receipt (`git_event_receipts`, D-05 §6.1b, migration 0006, unique per event). An event that already has a receipt is skipped, for example an item returned again in the overlap window, or the same comment through a webhook later.
- Each command runs inside a savepoint (`TenantScope.savepoint`). An expected refusal rolls back only that command:
  - `CommandError`;
  - `RegistryError`;
  - any `DbError` (a constraint, privilege or trigger refused a statement) or `TenantGuardError`. These are deterministic: a retry would fail the same way and block every later event of the project, so the command is answered `failed` instead.
  The refusal is then recorded as a receipt with a reply.
- Any other error (a programming error in the handler, or a lost connection, which `DbError` never wraps) rolls back the whole batch. The failed event is then counted **in its own small transaction** (`gitEventReceipts.recordFailure`), so the count survives the rollback and a worker restart:
  - the receipt gets the outcome `failing` and `event_attempts` = the number of failed attempts; it holds no decision and no reply;
  - below the limit, the poll stops with the error and the next tick retries the whole batch; a later success or refusal gives the `failing` receipt its result;
  - at `SDLC_WORKER_MAX_EVENT_ATTEMPTS` failed attempts (default 3; a technical setting, not a handbook rule), the receipt becomes final: `failed_internal`, never a gate decision (a CHECK enforces it), and the catalog reply `failed` once. `worker.event_failed` is logged at error level with IDs, the attempt count and the error class name only. The batch then runs again without that event, so the other events are applied and the cursor moves past it;
  - when the count itself cannot be written (for example the database is gone), nothing is counted and the error stops the poll.
- Only command comments get a receipt. Other comments, reviews and checks only move the cursor: reviews and checks are read by later gates (E01, C08).

### 2.3. Command grammar and reason codes (D3)

```text
/approve G<n>
/reject G<n> [<reason_code>] <reason>
/request-changes G<n> [<reason_code>] <reason>
```

- Only the **first non-empty line** of a **newly created** comment counts. Edits are never events (QUESTIONS #43). Text quoted or written further down is never read as a command.
- The gate is `G1`–`G8`, in either case.
  - `/approve` takes nothing after the gate: `/approve G3 if the tests pass` is refused.
  - Gates other than G1–G3 are refused by `decideGate` (`gate_not_supported`); E01 and E03 add G7 and G8.
- `/reject` and `/request-changes` need a reason. The reason is the rest of the first line and the lines below.
  - An optional first word may be a code from `GATE_REASON_CODES` (`spec_unclear`, `spec-unclear`, any case).
  - A code other than `other` is a reason by itself: `/reject G3 spec_unclear` is accepted.
  - `other` is never a reason by itself: `/reject G3 other` without text is refused (`syntax_reason_missing`).
  - Without a code, the platform records `other`, and a sentence is required.
- **The reason text stays in the comment on GitHub.** The decision stores `reason_code` and `reason_ref` = the comment's `https://` URL (ADR-M20). The parser returns codes only. Receipts and logs never hold text from GitHub.
- Other slash words (`/label`, later `/ack`, `/decide`, `/kill`) are not ours and are ignored. B11 and C11 add their verbs to the same parser.

### 2.4. Linking, permissions, replies

- **Link to an intent.** A comment on an issue matches `intents.issue_number`; a comment on a pull request matches `intents.pr_number`.
  - The match is limited to the polled project and to open intents (not `done`, `rejected` or `cancelled`).
  - Version 0.4 (X08b, ADR-M109 §2.3): one command, `/lesson`, may also match a finished intent (`done`, `rejected`, `cancelled`, `blocked`) whose lesson window (`learning.lesson_window_days` after `closed_at`) is open, or the intent at G8. Gate and escalation commands keep matching open intents only.
  - 0 matches → reply `intent_not_linked`. More than 1 match → reply `intent_ambiguous` (QUESTIONS #68).
- **Actor.**
  - An actor with `type: 'bot'` is ignored without a reply. This includes the platform's own replies, so replies never loop (QUESTIONS #45).
  - Other actors are mapped through `user_identities` by the **numeric** account ID, never by the login.
  - An unknown account, a disabled user or an account linked only in another tenant → reply `user_not_linked`.
- **Permission and separation of duties.** `decideGate` runs with `source = github_comment` and `event_source = polling`. It applies the same checks as the API:
  - no role on the project → `intent_not_found`;
  - the input binding;
  - `Registry.decide` → policy `canApprove`: roles from the configuration, producers never approve, dual approval needs two different people.
- **Replies** (AC4) go only to commands that were refused or could not be read.
  - **A successful command gets no reply.** The gate status comment of B07 (FR-22) confirms it.
  - The receipt stores a reply code and code parameters (gate, refusal reason). The text is rendered from the message catalog when the reply is posted (`comment.reply.*`, NFR-08).
  - Syntax replies show the syntax and the list of valid reason codes.
  - Refusal texts come from `gate.reason.*`. These keys were `api.reason.*` before B06. The API uses the same keys, so both give the same sentence; a test checks that the API texts are unchanged.
- **Delivery.** Replies are posted after the commit, in event order, at least once, by the poller that won the cursor race (the other one posts nothing).
  - A crash after the POST and before the update posts that reply again: a harmless duplicate.
  - The delivery update is conditional: a reply that is already delivered or abandoned stays so. A failed update is logged (`reply.bookkeeping_failed`) and never stops the other replies.
  - A failed post is retried on the next polls. After `SDLC_WORKER_MAX_REPLY_ATTEMPTS` failures (default 5), the reply is given up and logged.
  - After a `rate_limited` answer, the other replies wait.

### 2.5. Deployment (D4)

- Compose service `sdlc-worker` in the profile `platform`.
  - Image `sdlc-worker:<version>`, built from `platform/apps/worker/Dockerfile`, user `node`.
  - Read-only root file system, `cap_drop: [ALL]`, `no-new-privileges`, no published port.
  - Its health check reads a heartbeat file that the loop writes every tick.
- The worker logs in to OpenBao with the AppRole `worker` and keeps the client open. The GitHub adapter reads the App key again every 10 minutes (ADR-M23 §2.2).
  - The database password is read once from `kv/worker/database` (field `password`).
  - `pnpm openbao:bootstrap worker-credentials` stores it and delivers the AppRole files. The same helper as `api-credentials` is used, so there is still only one `--cap-add` line.
- Settings `SDLC_WORKER_*`:

  | Setting | Default |
  |---|---|
  | `DB_HOST`, `DB_PORT`, `DB_NAME` | `postgres`, `5432`, `platform` |
  | `DB_SECRET_PATH` | `worker/database` |
  | `GITHUB_API_URL` | `https://api.github.com` |
  | `TICK_MS` | `1000` |
  | `MAX_CONCURRENT_POLLS` | `4` |
  | `MAX_REPLY_ATTEMPTS` | `5` |
  | `MAX_EVENT_ATTEMPTS` | `3` |
  | `HEARTBEAT_FILE` | `/tmp/sdlc-worker.heartbeat` |

  These are technical settings, not handbook rules.
- Dev mode `SDLC_WORKER_DEV_MODE=1` with `SDLC_WORKER_DEV_DB_URL` (`pnpm worker:start`) is refused when `NODE_ENV=production`.
  - The GitHub App key still comes only from OpenBao: production code never reads the key from a file or an environment variable (ADR-M23 §2.2).
  - OpenBao has no host port (A11), so on a development machine the worker runs in Compose (`pnpm compose:platform`).
- Logs are JSON lines with event codes and IDs, never comment text, tokens or keys. A08 replaces the logger.

### 2.6. Where the rules live

| Rule | Source |
|---|---|
| Who may decide each gate, oversight mode, dual approval, producers never approve | Config `oversight.*` through the policy engine (unchanged) |
| Approval expiry, working calendar | Config `oversight.approval_expiry`, `escalation.calendar` |
| Polling interval | Config `github.poll_interval_seconds` (default 30, D-02 §6.3) |
| Reason codes | `GATE_REASON_CODES` (ADR-M20), not configuration |
| Only new comments are events; numeric IDs; bots never decide | QUESTIONS #43, #45 (code) |
| Tick, concurrency, reply attempts | Worker settings (technical) |

### 2.7. Tests

- `pnpm test`:
  - the grammar (table of cases);
  - reply rendering and catalog keys;
  - the loop with a fake clock (interval per project from config, no overlap, config change, rate-limit reset, invalid configuration);
  - worker settings;
  - static Compose and bootstrap checks;
  - the API refusal texts unchanged.
- `pnpm test:db` (`git-poller.test.ts`), with the in-process GitHub stub:
  - AC1: a crash before the commit, a reply failure after the commit, a replayed event, two concurrent pollers, reply give-up, a poison event retried N times across restarts and then given up with one reply while the other events are applied;
  - AC2: the three commands;
  - AC3: numeric IDs, bots, roles, a disabled user, another tenant;
  - AC4: the replies;
  - no comment text in any table;
  - the receipt privileges and trigger;
  - `listPollableProjects` returns IDs only.
- Optional live test `platform/tests/integration/github/poller-live.test.ts`, with the test App and a throw-away database. It is **never run in CI**, and the owner runs it in a terminal. The App posts `/approve G9`; the poller records `ignored_bot`, no decision and no reply.
  - The test App is a bot, so the live test only proves that bots are ignored. **The reply path is covered by the stub tests** (`git-poller.test.ts`: every reply code, posted after the commit, once).
  - A live check with a human GitHub account (a person comments `/approve G9` and gets the reply) is a manual step for later, when a second test account exists.

## 3. Risks

- **GitHub API rate limits grow with the number of polled projects.**
  - Each installation has 5,000 requests per hour. One project with 5 open pull requests at 30 s costs about 1,400 requests per hour (ADR-M23 §2.3). About three such projects on one installation reach the limit.
  - Mitigations:
    - most list calls are answered 304 (ETag), which GitHub does not count;
    - `github.poll_interval_seconds` can be raised per project;
    - after `rate_limited`, the project waits for the reset;
    - `git_host.rate_limit_low` is logged below 200 remaining.
  - Before more projects share one installation: measure, then raise the interval or move to webhooks (ADR-M11) once public infrastructure exists.
- `intents.issue_number` is not unique per project. Two open intents on one issue give `intent_ambiguous`, and nothing is decided (QUESTIONS #68).
- Replies are at least once, so a rare duplicate reply is possible. A successful command gets no reply until B07.
- One worker instance is the MVP. The compare-and-set makes a second instance safe, but not efficient: its polls roll back. Two instances flushing the same project at the same moment can post a reply twice (at least once).
- An event that fails with a programming error delays the project's other commands for up to `SDLC_WORKER_MAX_EVENT_ATTEMPTS` polls (default 3, about 1.5 minutes at 30 s), then it is given up (`failed_internal`, `worker.event_failed`). A person must write the command again after the fix.

## 4. Consequences

- D-05 version 1.8: §6.1b `git_event_receipts`; `SDA06`.
- ADR-M09 0.6: `listPollableProjects()` in the system scope; `TenantScope.savepoint`.
- Catalog: `api.reason.*` renamed to `gate.reason.*`, with the same texts; new `comment.reply.*` and `worker.*` keys.
- B07 reuses the loop to signal workflows and posts the gate status comment (FR-22). B11 adds `/ack` and `/decide`; C11 adds `/kill`; E01 adds G7 through reviews.
- Runbook T11: §5b.1 (test App key in the development OpenBao) and §5f (worker credentials). Handbook Ch.19: usage of the comment commands.

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-09-27 | Claude (task B06) | First version |
| 0.2 | 2026-09-27 | Claude (task B06, review of PR #94) | §2.2: failed attempts counted per event outside the batch, `failed_internal` after `SDLC_WORKER_MAX_EVENT_ATTEMPTS`; §2.3: exact rule for a reason code alone; §2.7: live test scope, human-account check later; §3 updated |
| 0.3 | 2026-10-16 | Harry | Accepted (the design is built and merged; open items stay follow-ups) |
| 0.4 | 2026-11-14 | Claude Code (task X08b PR 1), approved by Harry | §2.4: `/lesson` may match a finished intent inside its lesson window (ADR-M109 §2.3, QUESTIONS #708) |
