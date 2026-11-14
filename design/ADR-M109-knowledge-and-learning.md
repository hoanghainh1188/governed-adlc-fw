# ADR-M109. Knowledge for people and the G8 learning loop

| Item | Value |
|---|---|
| Status | **Accepted** with the merge of X08a PR 1 (Harry, 2026-11-14); 0.1 proposed by X08 (the plan approved by Harry on 2026-11-13 with the recommended answers to QUESTIONS #706–#710); 0.2 adds the details of QUESTIONS #721–#725 |
| Date | 2026-11-13; 0.2 on 2026-11-14 |
| Decided by | Harry (to accept); X08a and X08b build it |
| Related | D-08 X08, X08a, X08b, X07, X12, X13; D-02 FR-11, FR-21, FR-40, FR-42, FR-44; D-05 §6.2, §6.12 (proposed), §10; codes table §4 row G8 ("Release / Learning"); handbook Ch.10 §10.7 (Close: retrospective), Ch.15 §15.6 (post-release note), Ch.16 §16.11 (monthly learning step), T14 §7 (lessons); ADR-M20 (codes and links only), ADR-M27 (comment commands), ADR-M48 (Evidence Pack), ADR-M49 (G8), ADR-M54 (dashboard), ADR-M74 (agent memory), ADR-M97 (client data deletion); QUESTIONS #361, #395, #706–#710 |

## 1. Context

The platform keeps a full record of each intent: the gate decisions, the runs, the evidence pack and the audit log. People still cannot use that record well:

- **Finding past work is hard.** `GET /v1/intents` filters only by `project` and `status`. A person who asks "did we already change the order export?" or "which High-risk intents waited longest at G3 last month?" must read the list page by page, or search GitHub.
- **G8 records no lessons.** The codes table names G8 "Release / Learning". Handbook Ch.15 §15.6 asks for a post-release note with lessons (template T14 §7), and Ch.16 §16.11 asks for a monthly learning step. The platform does not help with either. Lessons stay in documents that nobody links to the intent, and Ch.16 lists "lessons are never applied" as a risk.

Two rules limit the design:

- Append-only tables never hold free text or client data (CLAUDE.md R030, ADR-M20). A lesson is free text. Its words must stay where they can be edited or deleted (GitHub), and the platform keeps codes and a link.
- The platform never writes `AGENTS.md`, memory or the handbook by itself. An agent's instructions change only through a reviewed change (QUESTIONS #94, ADR-M31 §2.5); memory changes only through a pull request a person who is not the producer merges (ADR-M74); the handbook is written by its authors (CLAUDE.md R094).

QUESTIONS #706–#710 (Harry, 2026-11-13, the X08 plan) chose the answers below.

## 2. Decision

### 2.1. Finding past intents (QUESTIONS #706)

**Filters.** `GET /v1/intents` gains these optional query parameters. Every one is a code, a date or a short search text. Every query stays inside the caller's tenant (`forTenant`) and the projects the caller may read:

| Parameter | Values | Meaning |
|---|---|---|
| `gate` | `G1`–`G8` | Open intents whose `current_gate` is this gate |
| `risk_tier` | `low`, `medium`, `high`, `critical` | The intent's risk tier |
| `created_from`, `created_to` | `YYYY-MM-DD` | The creation date, both ends included, in UTC |
| `closed_from`, `closed_to` | `YYYY-MM-DD` | The date the intent became `done`, `rejected`, `cancelled` or `blocked` |
| `sealed` | `true`, `false` | Has a sealed Evidence Pack (G8 passed) |
| `has_lessons` | `true`, `false` | Has at least one lesson (§2.3) |
| `q` | 2–200 characters | A search of the intent's code, title and description (below) |

- The existing `project`, `status`, `limit` and `cursor` keep their meaning. A filter that is not in the list is refused (`strictObject`), as today.
- The page order stays the same (newest first). With `q`, the order is the same; the platform does not rank by relevance, so the cursor stays simple and the result is easy to explain.

**The text search.**

- PostgreSQL full-text search on `title` and `description`, with the `simple` text search configuration. `simple` does not stem words, so it treats English, Vietnamese and Japanese text the same way (no language guess). A `q` that looks like an intent code (`INT-2026-0042`) or an issue or pull request number (`#42`) matches that column instead.
- A generated column `intents.search_tsv` (`tsvector`, `GENERATED ALWAYS AS (to_tsvector('simple', title || ' ' || description)) STORED`) with a GIN index on (`tenant_id`, `search_tsv`) through the `btree_gin` extension, or a plain GIN index plus the tenant filter if the extension is not wanted (X08a decides with a measurement on 10,000 intents; QUESTIONS #706).
- The query is built with `websearch_to_tsquery('simple', $q)` and a bound parameter: never string concatenation.
- **No new store and no new copy of the text.** The search reads only the two columns that already exist. When a client's data is deleted (ADR-M97), the title and description are cleared or pseudonymized in place, and the generated column follows by itself: nothing to purge separately. This is why the search does not cover Evidence Pack files, plan files, specs or review text: they live in the evidence store or on GitHub, and a copy in a search index would be one more place to purge.
- Logs and spans never hold `q` (ADR-M35: no query strings). The audit log does not record searches: reading is not an audited action today, and a search text may contain client words.

**As built (0.2, X08a PR 1, QUESTIONS #721–#725).**

- `has_lessons`, `links.lessons` and `links.follow_ups` come with X08b, with the lesson tables (QUESTIONS #721).
- `closed_from` and `closed_to` read the new column `intents.closed_at`: a trigger sets it from the move's `updated_at` when the status becomes final and clears it if the status leaves a final state; the app never writes it (QUESTIONS #722). A finished intent from before the migration gets its `updated_at`.
- `gate` returns only intents that are not finished. `sealed` is `true` or `false` in the query (`--sealed yes|no` in the CLI).
- The `links` object holds the stored codes and numbers (the issue and pull request number, the spec's path and commit, the plan file's path and commit when the plan was read from a file, the Evidence Pack's API path and whether a pack is sealed). Each address comes from `GitHostAdapter.webUrl`, a pure method of the adapter (D-03 1.57, QUESTIONS #723); without an adapter the address is null.
- **The index, measured** on 10,000 intents of one project (a developer machine, PostgreSQL of `test-db.sh`): a rare word (1 % of the rows) takes about 1.4 ms in the database and 12 ms through `GET /v1/intents`; a common word (25 %) 8 ms through the API. At this size the planner reads the project's rows by the existing index on (`tenant_id`, `project_id`, `status`) and checks the vector; it needs no GIN scan. A plain GIN index on `search_tsv` stays for larger tenants; `btree_gin` is not needed (no extension).
- `simple` does not stem: `order` does not match `orders`. Japanese text is split only at spaces and punctuation, so a Japanese word matches only as a whole run between them (the handbook says so). A search by meaning stays out of scope (below).
- A client data deletion (ADR-M97 1.1, QUESTIONS #725) turns the title into `Redacted intent <code>` and the description into an empty text; the search vector follows by itself. The trigger `intents_scrub_only` (SDA31) allows no other change of the two columns.
- Two pull requests (QUESTIONS #724): PR 1 the database, the API, the CLI and the links; PR 2 the dashboard.

**Not chosen for X08a.** A search by meaning (embeddings through the X04 knowledge index) needs a model call per query, a data class rule for the embedding model and a second index to purge. GitHub search alone cannot filter by gate, risk tier or sealed state. Both can come later as their own task.

**Where people use it.**

- CLI: `adlc intent list` gains `--gate`, `--risk`, `--created-from`, `--created-to`, `--closed-from`, `--closed-to`, `--sealed`, `--has-lessons` and `--search <text>`. Every message from the catalog (NFR-08).
- Dashboard: the intents board (ADR-M54) gains a search box and the same filters. The filters live in the URL (`#/intents?q=…&gate=G3`), so a search can be shared.
- **Links from one intent.** `GET /v1/intents/:intent` already returns the issue, the pull request and the gate. It gains a `links` object with the URLs a person needs to follow the work: the issue, the pull request, the linked spec at its version, the submitted plan file at its commit, the latest Evidence Pack (`GET /v1/intents/:intent/evidence`), the lessons (§2.3), and the follow-up intents (§2.5). Every URL is built from stored codes and numbers; nothing new is stored.

### 2.2. What a lesson is

A **lesson** is something a person learned from one intent that should change how later work is done. Its words are a GitHub comment on the intent's issue. The platform records:

| Field | Values |
|---|---|
| `category` | `gate` (a gate check or a gate's oversight mode), `rework` (why the change came back), `agent_assumption` (what the agent assumed wrongly), `instructions` (what `AGENTS.md` or memory missed), `process` (the handbook process), `tooling` (a tool, a CI job, a sandbox image), `other` |
| `target` | `agents_md`, `memory`, `handbook`, `config` (the project configuration), `none` (record only) |
| `comment_url` | The `https://` URL of the GitHub comment that holds the text (ADR-M20 `reason_ref` rule) |
| `recorded_by` | The person (numeric GitHub account ID matched to a user, ADR-M27) |
| `state` | `open` until it is applied or dropped (§2.5) |

### 2.3. Recording a lesson (QUESTIONS #707, #708)

**The command.** A new comment command, parsed by the same parser as the gate commands (ADR-M27 §2.3):

```text
/lesson <category> <target>
<the lesson in words, on the following lines>
```

- Only the first non-empty line of a newly created comment counts, as for every command. Both codes are required; a missing or unknown code is refused with a reply that lists the codes (catalog keys). The words below the first line are required (`syntax_lesson_text_missing`); the platform never reads or stores them, it only checks that the comment has more than the first line.
- The text stays in the comment, where the author can edit or delete it. The platform stores the comment URL. If the comment is later deleted, the lesson keeps its codes and a link that no longer opens; `adlc lessons list` shows that (§2.5).
- The CLI and the API can record a lesson that points to an existing comment: `adlc lesson add <INT-…> --category … --target … --comment <url>` (`POST /v1/intents/:intent/lessons`). The URL must be a comment on the intent's issue or pull request in the project's repository (the adapter checks it, as for `reason_ref`). The dashboard does the same with a passkey step-up (ADR-M73), like the other writes.

**Who.** Person A or Person B of the intent's project (the roles of the gate matrix), or a tenant admin. Bots never record lessons. An agent has no path to record one. A producer may record a lesson: a lesson is not an approval, and the person who did the work often knows the most. FR-11 applies when the lesson becomes a change (§2.5).

**When.** From the moment the intent enters G8 until **14 days after it is closed** (the observation window of T14 §7). The window is a project setting `learning.lesson_window_days` (1–90, default 14) in `@sdlc/config`.

- This widens the comment link of ADR-M27 §2.4 for this one command: a `/lesson` comment may match a finished intent (`done`, `rejected`, `cancelled`, `blocked`) whose window is open. Gate commands keep matching only open intents. If two intents match (a reopened issue), the reply is `intent_ambiguous`, as today.
- After the window, the command is refused with `lesson_window_closed`. A later lesson goes on a new intent, or in the monthly review as a handbook issue.

**Never blocks a release.** G8 never waits for a lesson. The notice `released` (ADR-M49 §2.1 step 5) gains a line that invites Person A and Person B to record lessons, with the command and the window's end date. Lessons recorded after the seal are not part of the sealed Evidence Pack; a later pack version (for example after a hold) lists the lesson codes and links.

### 2.4. Storage

A new append-only table `intent_lessons` and an append-only table `intent_lesson_outcomes` (D-05 §6.12, proposed). Codes, IDs and links only, never text. The state of a lesson is its latest outcome; a lesson with no outcome is `open`.

- Audit actions: `lesson.recorded` (category, target, the comment's numeric ID), `lesson.applied` and `lesson.dropped` (the outcome, the link), `lesson.refused` (a code: `bot`, `user_not_linked`, `not_allowed`, `window_closed`, `syntax`).
- Client data deletion (ADR-M97): the rows stay (codes and links, like `gate_decisions.reason_ref`); the comments are on the client's GitHub, outside the platform's purge, as for gate reasons today. The deletion runbook names them.
- Retention: kept like the audit log (≥ 2 years). Archiving a project keeps them.

### 2.5. From a lesson to a change (QUESTIONS #709)

The platform never changes `AGENTS.md`, memory, the configuration or the handbook from a lesson. It links each lesson to the change that applies it, made through the path that already exists:

| Target | How a person applies it | The platform's part |
|---|---|---|
| `agents_md` | A new intent that changes the instruction file, through G1–G8; after the merge, the agent register records the new agent version (ADR-M31 §2.5) | `adlc intent create --from-lesson <lesson-id>` pre-fills the project and links the new intent to the lesson |
| `memory` | A memory pull request (ADR-M74), approved by a person who is not its producer | `--from-lesson` as above when memory changes go through an intent; or the outcome link to the memory pull request |
| `config` | `adlc admin project apply` or the dashboard Admin screen | The outcome link to the audit event or the pull request of the configuration file |
| `handbook` | A GitHub issue in the framework's repository with the label `handbook`, for the handbook's authors | `adlc lesson issue <lesson-id>` opens the issue with the codes and the comment link only (never the comment text; the person adds words) |
| `none` | Nothing to change | The lesson is closed as `dropped` with reason `record_only` at the monthly review |

- **Outcomes.** `adlc lesson apply <lesson-id> --link <url>` (a merged pull request, an intent, an issue) or `adlc lesson drop <lesson-id> --reason <code>` (`duplicate`, `not_valid`, `record_only`, `other`). Only Person A or Person B of the project or a tenant admin; never a bot or an agent.
- **FR-11.** A lesson never approves anything. The intent or pull request that applies it follows its own gates, so its producer never approves it, whoever recorded the lesson.
- **The monthly learning step** (handbook Ch.16 §16.11). `adlc lessons list [--project …] [--open] [--since YYYY-MM-DD] [--json]` lists lessons with their codes, intent, age, comment link and outcome; the dashboard shows the same list on a project. `adlc metrics lessons` counts lessons per category and target, how many were applied, and the median days from recording to outcome. The handbook's authors decide how the monthly step uses the list; the platform only provides it.

### 2.6. Relation to agent memory (X12, X13)

- Memory (ADR-M74) is what an **agent** proposes and a person approves; a lesson is what a **person** records. A lesson with target `memory` is one way to start a memory change; it never writes memory by itself.
- Lessons are never given to an agent's prompt. The text stays on GitHub; only memory and `AGENTS.md`, approved by people, reach a run.

## 3. Alternatives considered

- **Search by meaning (embeddings) now.** Rejected for X08a: a model call per search, a data class rule for the embedding model, a second index to purge. It may come later on the X04 index.
- **GitHub search only.** Rejected: no filter by gate, risk tier, sealed state or lessons, and the intent's own record (gates, packs) is not on GitHub.
- **Search in Evidence Pack files.** Rejected: the files are in the evidence store and are purged after retention; an index of them would be a copy to purge and would hold client code.
- **Lesson text in a platform table.** Rejected: append-only tables never hold free text (R030), and an editable table would need its own deletion path for client data.
- **Lessons as files in the repository (`.sdlc/lessons/`).** Rejected: a pull request per lesson is heavy for a short note, and a lesson about a gate or the handbook is not about the client's repository.
- **G8 waits for a lesson.** Rejected (QUESTIONS #708): a release must not wait for a note; the notice and the monthly list remind people instead.
- **The platform opens the follow-up change.** Rejected (QUESTIONS #709): the platform never writes instructions, memory or the handbook; a person starts the change, and its gates apply.

## 4. Consequences

- **X08a** (search, M): migration with `intents.search_tsv` and its index, the new filters, `adlc intent list` options, the dashboard search box, the `links` object; handbook Ch.19 (CLI) and the dashboard usage section.
- **X08b** (lessons, M): migration with `intent_lessons` and `intent_lesson_outcomes` (append-only triggers and grants, listed in `platform/tests/db/append-only.test.ts`), the `/lesson` command, the API and CLI commands, the `released` notice line, `adlc lessons list`, `adlc metrics lessons`, the dashboard list; handbook Ch.19 and Ch.20 usage sections. The policy chapters (Ch.15, Ch.16) and template T14 stay with the handbook's authors: X08b gives them a short note of what the platform now offers.
- The comment link of ADR-M27 §2.4 changes for one command: X08b updates ADR-M27 with a version line.
- New tests (§5). No change to G1–G8 decisions, the Run Contract or the runner.

## 5. Tests for the implementation tasks

**X08a**

- Every filter alone and combined; a filter outside the list → 400; another tenant's intents never returned (database test with two tenants); a project the caller may not read never returned.
- `q`: words in title and description match; Vietnamese and Japanese text match by token; `INT-…` and `#42` match the columns; the query is a bound parameter (a test with quotes and `&|!` characters); pagination with `q` keeps the order.
- After a client data deletion, the deleted words no longer match.
- No `q` in logs or spans (a logger test).
- CLI options and every message from the catalog; the dashboard keeps the filters in the URL.

**X08b**

- `/lesson` grammar: valid codes, unknown codes, missing text, extra words on the first line, a quoted command below the first line ignored.
- Who: Person A, Person B and tenant admin accepted; another project's person, an unknown account, a disabled user and a bot refused; no agent path.
- When: refused before G8; accepted at G8 and after close inside the window; refused after it (`lesson_window_closed`); the window setting's limits.
- G8 never waits for a lesson; the `released` notice has the invitation line.
- Tables append-only (UPDATE and DELETE refused by trigger and grant); no text column; the comment URL is `https://` on the project's repository.
- Outcomes: apply and drop by allowed people only; the state is the latest outcome; `--from-lesson` links the new intent; `adlc lesson issue` sends codes and the link only.
- `adlc lessons list` and `adlc metrics lessons` numbers on fixtures; tenant isolation.

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-11-13 | Claude Code (task X08) | First version, proposed |
| 0.2 | 2026-11-14 | Claude Code (task X08a PR 1), accepted by Harry with the merge | Accepted; §2.1 "As built": `has_lessons` and the lesson links move to X08b, `intents.closed_at`, `GitHostAdapter.webUrl`, the index measurement, `simple` without stemming, the tombstone on client data deletion (QUESTIONS #721–#725) |
