# ADR-M112. Git host webhooks, with polling kept as reconciliation

| Item | Value |
|---|---|
| Status | **Proposed** (2026-11-15). Plan approved by Harry on 2026-11-15 (QUESTIONS #746–#750); PR 1 is this ADR; PR 2 and PR 3 build it. Version 0.2 (PR 2): repeated delivery IDs and the last delivery time in the api's memory, not Valkey (QUESTIONS #751); §2.4b records what PR 2 built |
| Date | 2026-11-15 |
| Decided by | Harry (to accept); O08 builds it |
| Related | D-08 O08 (AC1–AC5); D-02 FR-21 and the "Receiving GitHub events" note, NFR-01, NFR-05; D-03 §9, §12 (ADR-M11); ADR-M23 §2.5 (the adapter's webhook check, B05 AC2); ADR-M26 §2.7 (the api's limits, `trustProxy`); ADR-M27 (the poller); ADR-M67 (the access proxy); ADR-M80 (the threat model); ADR-M101 (operational alerts); ADR-M106 (several projects on one repository); ADR-M110 (row-level security); CLAUDE.md R031, R034, R035, R037, R082, R083; QUESTIONS #732, #746–#751 |

## 1. Context

The platform reads GitHub events by polling (ADR-M11, ADR-M27). Each active project is polled every `github.poll_interval_seconds` (default 30). Two costs follow:

- a `/approve` comment reaches the workflow tens of seconds later;
- every project uses API quota every 30 seconds, even when nothing happens.

GitHub can push the same events as **webhooks** (an HTTP POST to a URL for each event). D-02 FR-21 and ADR-M11 chose polling because the internal server accepts no connection from the internet. QUESTIONS #732 (Harry, 2026-11-15) asks for this ADR to choose how deliveries can reach the server, to keep webhooks off by default, and to keep the poller as reconciliation.

What exists today:

- The GitHub adapter checks `X-Hub-Signature-256` (HMAC SHA-256, constant-time compare) before it reads the body, and maps the four event kinds to the same `GitEvent` as polling (`verifyWebhook`, ADR-M23 §2.5). No route calls it.
- `handleGitEvent` (ADR-M27 §2.2) is idempotent for command comments only: one receipt per project and event ID. Reviews, closed pull requests and finished checks are only triggers: the intent is woken, and G6 or G7 reads GitHub again. A repeated trigger does no harm.
- Replies to refused commands and the workflow wake and kill signals are sent by the worker, after the poll's transaction (ADR-M27 §2.4).
- One repository may belong to several projects, in one or several tenants (`pollRepository`, ADR-M106).
- The access proxy (ADR-M67) publishes the API and the dashboard on one **LAN** port, with a certificate from the company CA. GitHub cannot verify that certificate, and the port must never face the internet.
- The GitHub App manifest keeps the webhook inactive; `pnpm github-app:create` drops the webhook secret (R083).
- NFR-01: no dependency on managed services.

## 2. Decision

### 2.1. How deliveries reach the server (QUESTIONS #746)

- **An inbound route to a separate webhook listener.** The `access` profile gets a second nginx listener, used only for webhooks:
  - its own bind address `SDLC_ACCESS_WEBHOOK_BIND_ADDR` and port `SDLC_ACCESS_WEBHOOK_HOST_PORT` (default 8444). The bind address has no default; without it there is no listener, and the profile works as before;
  - one route: `POST = /v1/webhooks/github`. Any other path answers `404`; any other method on that path answers `405`;
  - TLS with the access profile's certificate, the same TLS rules as ADR-M67 §2.2; plain HTTP is refused, never redirected;
  - an allow-list of peer addresses `SDLC_ACCESS_WEBHOOK_ALLOW_CIDRS`, required when the listener is on (normally the address of the company's edge proxy or tunnel). `0.0.0.0/0` is accepted, and `pnpm doctor` warns about it;
  - its own body limit (1 MiB), equal to the api route's limit (§2.4), and its own rate limit (§2.4). The LAN listener keeps its 64 KiB limit (R082).
- **Reaching the listener from the internet is the operator's infrastructure.** GitHub needs a public HTTPS URL with a publicly trusted certificate. The company provides it with its own edge: a reverse proxy in a DMZ (a network zone between the internet and the internal network), or a tunnel the company already runs (an outbound connection from inside the company to a public endpoint). The edge forwards to the listener over TLS. The deploy README describes the shape and the checks; it names no product.
- **The platform builds no relay and depends on no hosted relay.** A relay of our own would be a new internet-facing service to build, harden and operate outside the Compose stack. A hosted relay (for example smee.io or Hookdeck) breaks NFR-01. A company that wants a relay uses its own tunnel; to the platform it is the edge.
- **Never on the LAN port.** The edge must never reach the API or the dashboard. A static test checks that the webhook listener serves only its one route and that the LAN listener has no webhook route.
- **The internal server today:** webhooks stay off, and polling stays every 30 seconds. Nothing changes until an operator turns webhooks on (§2.2).

### 2.2. When webhooks may be turned on

Webhooks are **off by default**. An operator turns them on only when all of these hold:

1. GitHub can reach the listener through the edge over HTTPS with a publicly trusted certificate.
2. The webhook secret is in OpenBao (§2.8) and in the GitHub App settings.
3. The App's webhook is active and subscribes to exactly these events: Issue comment, Pull request, Pull request review, Check run. The App's permissions do not change.
4. The api runs with `SDLC_API_GITHUB_WEBHOOKS=on` (§2.7), and GitHub's `ping` delivery was accepted (the doctor check of §2.9 shows it).
5. Then each project turns them on in its configuration (`github.webhooks.enabled`, §2.6).

The order matters: a project switches to the longer reconciliation interval only after deliveries arrive. Turning webhooks off is the same steps in reverse; the project returns to its normal interval at once.

### 2.3. A delivery wakes the poller; it carries nothing further (QUESTIONS #747)

- **A verified delivery is a wake-up hint for one repository.** The api checks the signature, reads only the event kind and the repository name, and tells the worker. The worker polls that repository at once with the existing `pollRepository` (ADR-M27 §2.2, ADR-M106).
- So deliveries use **the same handler, the same cursor and the same transaction** as the poller (R037):
  - order: GitHub does not promise the order of deliveries; the poll reads events in the cursor's order, so the order of deliveries does not matter;
  - idempotency: an event that the poller already read is not read again; a command comment still has its one receipt;
  - users are matched by numeric account ID, and bots never decide, because nothing in the handler changes;
  - replies and the wake and kill signals stay in the worker, after the commit.
- **No content of the delivery travels further.** The comment text, the review, the pull request and the check are read again from the GitHub API by the poll, as today. The body is used only for the signature check and to read the event kind and the repository name; it is never stored, logged or passed on (R031).
- **No cross-tenant lookup in the api.** The api does not look up projects. The worker matches the repository name against the projects it already polls (`listPollableProjects`), so row-level security (ADR-M110) needs no new exception.
- The decisions that follow keep `event_source = polling`, because the poll read the event. The value `webhook` (D-05 `EVENT_SOURCES`) stays reserved for a later path that handles the payload directly.
- **Cost:** each delivery starts one round of GitHub list calls for that repository. A burst of deliveries for one repository gives one extra poll at most (§2.6).
- **Not chosen:** handling the payload in the api. It would copy the poll's orchestration (receipts, replies, signals) into the api, put the App key in the api for the replies, need a cross-tenant project lookup, and race with the poller on the same receipts.

### 2.4. The route (AC2)

`POST /v1/webhooks/github` in the api:

1. With `SDLC_API_GITHUB_WEBHOOKS` off, the route does not exist (`404`, like any unknown path).
2. The body is read raw, for this route only, up to 1 MiB; a larger body answers `413` and is not read further.
3. The route needs no API token: the signature is the authentication. It is outside the session and token guards (ADR-M73).
4. `X-GitHub-Delivery` must be a UUID and `X-GitHub-Event` must be present, or `400`.
5. The adapter checks `X-Hub-Signature-256` against the secret, in constant time, before anything in the body is read (`verifyWebhook`). A bad or missing signature answers `401`.
6. A verified delivery whose kind the adapter does not map (`unsupported_event`, for example `ping`) is accepted and ignored: `202`.
7. A repeated delivery ID answers `202` and does nothing more (§2.5).
8. Otherwise the api sends the hint (§2.5) and answers `202` at once. GitHub waits at most 10 seconds for an answer; the api never waits for the poll.

- **Rate limit:** per client address, with `trustProxy` limited to the proxy's fixed address as in ADR-M26 §2.7 and ADR-M67 §2.5. Defaults (technical settings): in the proxy 20 requests a second, burst 100; in the api 1,200 a minute (version 0.2: the api's fixed-window limiter, ADR-M26 §2.7). Over the limit `429`; GitHub records a failed delivery, and the poller reads the event later.
- **Logs:** a refused delivery is logged by code only (`webhook.refused` with `reason` = `bad_signature`, `too_large`, `bad_headers`, `rate_limited`, `disabled`), never with a header, the delivery ID or the body. An accepted delivery is logged with the delivery ID and the event kind only (`webhook.accepted`, `webhook.duplicate`, `webhook.ignored`).
- **NFR-05:** the path names the Git host, and the check is the `GitHost` interface's `verifyWebhook`. The hint, the dedupe and the worker's handling are host-neutral; a second host adds its own path and check only.

### 2.4b. As built (PR 2)

- The route is registered on Fastify directly, in its own context: that context parses `application/json` as raw bytes up to 1 MiB, and the token and session guards do not apply to it. Other content types answer `400` (`bad_headers`).
- The delivery ID must be a GUID and the event name lower-case letters and `_`. A refused delivery logs `webhook.refused` with `reason` only: `rate_limited`, `bad_headers`, `too_large`, `bad_signature`, `secret_unavailable`, `hint_failed`, `failed`.
- The rate limit and the header formats are checked in an `onRequest` hook, before the body is read, so a refused request never makes the api buffer 1 MiB. The access proxy's timeouts (PR 3) limit slow bodies.
- The secret is read again at most once at a time; after a failed read, the next one waits 60 seconds, so deliveries never make one OpenBao read each. A signature error answers `401`; a missing secret `503` (`secret_unavailable`); any other error `500` (`failed`).
- A delivery ID is recorded only after its hint left, so a redelivery after a failed hint (`503`) still wakes the poll.
- Settings: `SDLC_API_GITHUB_WEBHOOKS` (`off` / `on`), `SDLC_API_GITHUB_WEBHOOK_SECRET_PATH` (default `api/github-webhook`, under `api/` only), `SDLC_API_WEBHOOK_DEDUPE_SECONDS` (default 259200), `SDLC_API_WEBHOOK_RATE_PER_MINUTE` (default 1200). `on` is refused in development mode (no OpenBao, `api.settings.webhooks_need_openbao`), and a secret that cannot be read stops the start (`api.settings.webhook_secret_missing`).

### 2.5. Repeated deliveries and the hint (QUESTIONS #748, #751)

- **Repeated delivery IDs: the api's memory** (version 0.2, QUESTIONS #751; version 0.1 said Valkey, but no platform process uses Valkey). A bounded map keeps each delivery ID for `SDLC_API_WEBHOOK_DEDUPE_SECONDS` (default 72 hours; GitHub lets a person redeliver deliveries of the past 3 days), at most 10,000 IDs, the oldest first out. Like the rate limiter (ADR-M26 §2.7), this is enough for one api instance.
  - This check saves work only. Correctness comes from the cursor and the receipts: a second hint for the same events starts a poll that finds nothing new. A restart that forgets the IDs costs one extra poll at most.
- **The hint: PostgreSQL `NOTIFY`.** The api runs `SELECT pg_notify('sdlc_git_hint', $1)` with a small JSON payload: the host code and the repository name (`{"host":"github","repository":"owner/name"}`). No ID of a tenant or project, no content.
  - `NOTIFY` needs no table and no grant; the api and the worker already connect to PostgreSQL. The payload is never stored or logged.
  - A hint sent while no worker listens is lost. Reconciliation (§2.6) reads the event later.
- **No table and no migration.** O08 does not wait for ADR-M110's migration 0060 or ADR-M111's migration 0061.
- **Not chosen:** a table of delivery IDs (a migration, and a table that only grows, ADR-M103, for a check the cursor already makes safe); Valkey for the IDs or for publish and subscribe (no platform process has a Valkey client or credential today, QUESTIONS #751).

### 2.6. The worker: an immediate poll, and the poller as reconciliation (AC4, QUESTIONS #749)

- The worker opens **one extra database connection**, outside its pool, and runs `LISTEN sdlc_git_hint`. When the connection drops, it reconnects with a growing delay (1 s, doubling, at most 30 s), and after the reconnect, or after a first connect that failed, it polls every group once (hints may have been lost; version 0.2: every group, which is simpler than reading each configuration first and costs one poll each). The connection uses TCP keep-alive, so a connection that a firewall drops silently still ends.
- A hint makes every pollable project of that repository **due now** (the repository name is compared as the poller compares it). The loop does not wait for the next tick.
  - The usual limits still hold: one poll per project at a time, `SDLC_WORKER_MAX_CONCURRENT_POLLS`, and the wait after a `rate_limited` answer (`retry_at`): a hint never polls a project earlier than GitHub's reset time.
  - After a failed poll without a reset time, a hint waits 30 seconds (`HINT_FAILURE_BACKOFF_MS`), so a stream of deliveries never repeats a failing poll at once (version 0.2).
  - A hint for a project that is being polled sets a flag: one more poll starts when the current one ends. Many hints for one repository give one extra poll, not one per hint.
  - A hint for a repository that no project polls is ignored (for example a renamed repository; reconciliation finds the events under the new name once the project is updated).
- **Reconciliation interval.** A project with `github.webhooks.enabled: true` is polled every `github.webhooks.reconcile_interval_seconds` (default 300) instead of `github.poll_interval_seconds`. The value must not be smaller than `poll_interval_seconds`; the configuration check refuses it.
- **Off again:** with `github.webhooks.enabled: false` (the default), the project is polled every `poll_interval_seconds` again. The worker reads the configuration before each poll, as today (ADR-M27 §2.1), so the change applies without a restart.
- **A webhook outage** (the edge down, the App's webhook turned off, the secret changed on one side only) costs latency, never events: the reconciliation poll reads every missed event from the cursor.
- A log line `worker.reconcile_found_events` (IDs and the count only, ADR-M35; version 0.2: a log line, not a metric) shows each scheduled poll of a project with webhooks on that found events, so a team can see deliveries that did not arrive.

### 2.7. Configuration and switches

| Setting | Where | Default | Kind |
|---|---|---|---|
| `SDLC_API_GITHUB_WEBHOOKS` (`on` / `off`) | api environment | `off` | Deployment switch |
| `SDLC_API_GITHUB_WEBHOOK_SECRET_PATH` | api environment | `api/github-webhook` | Deployment |
| `SDLC_API_WEBHOOK_DEDUPE_SECONDS` | api environment | `259200` (72 hours) | Technical |
| `SDLC_API_WEBHOOK_RATE_PER_MINUTE` | api environment | `1200` | Technical |
| `SDLC_ACCESS_WEBHOOK_BIND_ADDR`, `…_HOST_PORT`, `…_ALLOW_CIDRS`, `…_RATE_PER_SECOND`, `…_RATE_BURST` | `access` profile | none, `8444`, none, `20`, `100` | Deployment |
| `github.webhooks.enabled` | project configuration (ADR-M18) | `false` | Project |
| `github.webhooks.reconcile_interval_seconds` | project configuration | `300` | Project |

- With `SDLC_API_GITHUB_WEBHOOKS=on`, the api does not start when it cannot read the webhook secret (`api.settings.webhook_secret_missing`): a missing secret is found at start, not at the first delivery.
- The two project keys have defaults in the shipped default configuration (`enabled: false`, 300), so a project configuration without them behaves exactly as today, and no new schema version is needed. `reconcile_interval_seconds` is at most 86400; a value below `poll_interval_seconds` is refused (`config.schema.reconcile_interval_too_short`). The default configuration's hash changes (as with every new default).

### 2.8. The webhook secret (QUESTIONS #750)

- The secret lives in OpenBao only (R034): `kv/api/github-webhook`, field `secret`. The api's AppRole policy may read it; no other process may. The api reads it again every 10 minutes, like the App key (ADR-M23 §2.2), so a new value applies without a restart.
- A new command creates it: `pnpm openbao:bootstrap github-webhook-secret`. It generates 32 random bytes, writes them to OpenBao, and prints the value **once**, for the owner to paste into the GitHub App settings. It prints a secret, so it runs only in the owner's macOS Terminal app (R035), and the Claude Code hook refuses it (R132, `guard-bash.mjs`, PR 3).
- The value is never written to a file, `.env`, a log or test output. Tests use a throw-away value created in the test.
- `pnpm github-app:create` and its manifest do not change: the webhook stays inactive at creation, and the command still drops the secret GitHub returns (R083). Turning webhooks on is a manual step in the App settings, written in the deploy README.
- **Rotation:** GitHub keeps one secret per App. To rotate, the owner runs the command again and pastes the new value. Deliveries between the two steps fail their check and are read by reconciliation. The key rotation runbook (ADR-M102) gets this step.

### 2.9. The doctor check

- `pnpm doctor` gets a check `github.webhook`, active only when `SDLC_API_GITHUB_WEBHOOKS=on`:
  - it warns when the access profile's webhook settings are missing or when the allow-list is `0.0.0.0/0`;
  - it warns when no verified delivery (a `ping` included) arrived for `SDLC_DOCTOR_WEBHOOK_SILENCE_HOURS` (default 24). The api keeps the time of the last verified delivery in its memory (version 0.2, QUESTIONS #751; a time only, lost at a restart). A quiet repository can cause this warning; the message says so.
- PR 3 chooses how doctor reads that time. `pnpm alerts` (ADR-M101) sends the result like any other doctor check.

### 2.10. What is never stored, logged or passed on

- The body, the signature header, the secret and any text from GitHub: never in a table, a log, a run event, an audit event, a Temporal input or the hint (R031).
- The hint holds the host code and the repository name only, and lives only for the `NOTIFY`.
- The api's memory holds delivery IDs (with a time limit) and the time of the last verified delivery (version 0.2).
- No audit event per delivery. The gate decisions that a poll records are audited as today.

### 2.11. Where the rules live

| Rule | Source |
|---|---|
| Webhooks off by default; when they may be turned on | This ADR §2.2; deploy README |
| Reconciliation interval | Project configuration `github.webhooks.*` (§2.6) |
| A delivery only wakes the poller; no content travels further | This ADR §2.3; code and tests |
| Signature checked before the body is read; constant-time compare | Adapter (ADR-M23 §2.5); tests |
| The webhook listener serves one route on its own port, never the LAN port | Access profile template; static test |
| The secret only in OpenBao; the command only in the owner's Terminal | R034, R035, R132 |
| Users by numeric ID; bots never decide | ADR-M27 §2.4 (unchanged) |

### 2.12. Tests (AC5)

- `pnpm test`: the route's answers (disabled, too large, bad headers, bad signature, unsupported kind, duplicate, accepted) and their log codes; the interval choice (`enabled` on and off, the minimum); the hint coalescing and the rate-limit wait in the loop with a fake clock; a static test of the access template (one route, own port, own body limit equal to the api's, allow-list required).
- Database tests: `NOTIFY` and `LISTEN` end to end with a stub GitHub; **the time from a delivery to the workflow signal under 3 seconds**; a replayed delivery and a duplicate change nothing; events delivered out of order are applied in the cursor's order; a webhook outage (no hints at all) is covered by the reconciliation poll; a lost listener connection is restored and polls once.
- PR 2 chooses the suite for the database tests and adds a row to `platform/DEVELOPMENT.md` when it adds a `pnpm test:*` script.
- A live test with a real GitHub App and a real edge is run by the owner only, never in CI.

## 3. Consequences

- On a server that GitHub can reach, a command reaches the workflow in about a second or two, and idle projects use much less API quota (one poll every 5 minutes instead of every 30 seconds).
- On the internal server today, nothing changes.
- The platform gets an endpoint that can face the internet. It reads nothing before the signature check, has its own port, an allow-list, body and rate limits, and passes no content on. The threat model (ADR-M80) gets this entry point in PR 3.
- The operator owns the edge (public certificate, DMZ or tunnel). The deploy README lists what it must do and what doctor checks.

## 4. Implementation

### 4.1. Pull requests

| PR | Content |
|---|---|
| PR 1 | This ADR; D-02 FR-21 note (1.11); D-03 §5.1 api row, §9 GitHub events row, §12 ADR-M11 row (1.59); ADR-M27 §2.1 (0.5); QUESTIONS #746–#750; number blocks (docs only) |
| PR 2 | The hint (`@sdlc/core` `git-events/hints.ts`, `PlatformDatabase.notifyGitHint` and `listenGitHints`), configuration keys and their check, the api route (raw body, limits, signature, repeated IDs in memory, `NOTIFY`), the worker's listener, the immediate poll, the flag and the reconciliation interval, the log line; messages; tests of §2.12 (`pnpm test` and `pnpm test:db`, no new script); `design/RULES.md` rows R158, R159 and the rule lines in `platform/apps/api/CLAUDE.md` and `platform/packages/core/CLAUDE.md` |
| PR 3 | The webhook listener in the `access` profile and its static test, the OpenBao policy and `github-webhook-secret` command, the hook rule (R132), the doctor check, deploy README "Webhooks", runbook T11 and the key rotation step, the threat model entry, handbook usage sections (configuration and troubleshooting), CHANGELOG with upgrade notes, the `platform/deploy/CLAUDE.md` rule line |

### 4.2. Changes to other documents (PR 1)

- D-02 FR-21 note: webhooks may be turned on where GitHub can reach a webhook listener; polling stays as reconciliation (this ADR).
- D-03 §12, ADR-M11 row: changed by ADR-M112. §9 and §5.1: the route path and the listener.
- ADR-M27 §2.1: with webhooks on, the interval is the reconciliation interval, and a hint starts a poll at once.

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-11-15 | Claude (task O08, PR 1) | First version, from the plan Harry approved on 2026-11-15 (QUESTIONS #746–#750) |
| 0.2 | 2026-11-15 | Claude Code (task O08, PR 2), approved by Harry (QUESTIONS #751) | §2.5, §2.9, §2.10: repeated delivery IDs and the last delivery time in the api's memory, not Valkey; §2.4b as built; §2.4, §2.7: the api's rate limit per minute, the secret path setting; §2.6: every group polled after a reconnect, a log line instead of a metric; §2.7: defaults in the default configuration, no new schema version |
