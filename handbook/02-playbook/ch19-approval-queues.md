# Chapter 19. Approval queues and avoiding review bottlenecks

> Readers: **Person A, Person B, PM / BrSE** · Reading time: about 10 minutes
> Status: **Draft 0.1**, awaiting Harry's comments.

---

## 19.1. Purpose

- Keep human approvals **meaningful** without letting them stop all work.
- When agents produce more, the bottleneck moves to review. This chapter keeps that queue short.

## 19.2. Scope

All HITL gates and escalations (codes table §4; Chapter 6).

---

## 19.3. Principles

1. **Only block what needs blocking.** Low-risk, reversible work does not wait for a person (HOTL or AUDIT).
2. **Waiting must not stop independent work.** While an approval is pending, the agent continues with work that does not depend on it.
3. **An approval is not a blank cheque.** It is bound to the exact version, scope, environment and expiry.
4. **The queue is measured like any other system.**

---

## 19.4. Blocking and deferred approvals

| Type | Used for | What the agent does while waiting |
|---|---|---|
| **Blocking** | Deleting data, production deploys, merging security changes, payments, access changes, hard-to-reverse migrations | Stops **before** the protected action |
| **Deferred** | Low-risk or reversible steps: extra tests, documentation, sandbox improvements, draft pull requests | The step is "parked"; independent work continues |

Example:

```text
                     ┌─ waiting for approval ─→ deploy
agent plan ──────────┤
                     ├─ run independent tests
                     ├─ update documentation
                     └─ prepare the rollback plan
```

Only the protected action is locked. Evidence, tests and the rollback plan are ready when the reviewer answers.

---

## 19.5. Keeping the queue short

| Practice | How |
|---|---|
| **Route to the right person** | Decide the approver **before** the request is created: by change type, repository, risk tier, ownership, availability and conflicts of interest. Finding a reviewer must not become a new bottleneck |
| **One decision packet, not raw logs** | Goal, scope, diff or action summary, risk, test and security results, expected effect, rollback plan, and **what changed since the last review** (Chapter 4 §4.5) |
| **Batch similar low-risk requests** | Group similar items into one decision, to reduce context switching |
| **Deadlines and backups** | Every HITL request has a deadline, a backup reviewer and an escalation path (Chapter 6 §6.5) |
| **Share Person B's load** | A backup Person B per project; rotation for HOTL monitoring (Chapter 5) |
| **Fix the cause of rejections** | Many rejections usually mean unclear specs or plans, not bad reviewers |

**No answer never means yes.** Our rule stays: items on the pre-approved safe list may continue; everything else stays frozen until a person decides (Chapter 6 §6.5).

---

## 19.6. Checking an approval is still valid

Just before the protected action runs, check that it matches what was approved:

| Bound to | Example |
|---|---|
| Version or hash of the proposal | Plan v3, spec hash |
| Exact commit or artifact | Commit `abc123`, image digest |
| Environment | Staging, production |
| Scope | Services, files, data affected |
| Expiry | Valid until a given time |

If anything differs → **cancel and ask again**. Three rules always hold:
1. No valid approval → no protected action.
2. A pending approval does not block independent work.
3. What runs is exactly what was approved, or it needs a new approval.

---

## 19.7. Metrics

| Metric | Meaning | Warning |
|---|---|---|
| Approval waiting time (median, 95th percentile) | How fast reviewers respond | Median first review above 2 hours (Chapter 8 §8.7) |
| Queue depth | Requests waiting | Growing week after week |
| Timeout rate | Requests not handled within SLA | Any, for High and Critical |
| Escalation rate | Requests passed to the next level | Rising |
| Rejection rate | Quality of proposals and specs | Rising |
| Rework rounds before approval | Clarity of what is asked | Rising |

---

## 19.8. Before the platform

- Use GitHub review requests and CODEOWNERS for routing; labels for risk tier.
- Person A writes the decision packet in the PR description (template T2).
- The weekly report (T8) lists items waiting longer than their deadline.

---

## 19.8b. Using the platform: gate commands in comments

> **Platform usage section, owned by Claude Code** (CLAUDE.md "Documentation rules"). Written with task B06, 2026-09-27, updated with task B07 (the gate workflow and status comments; session 2: HOTL gates, block windows, gate deadlines) and task B12 (the project AI record before G1), and kept in line with the platform code (`design/ADR-M27-github-poller.md`, `design/ADR-M30-intent-workflow.md`, `design/ADR-M32-project-ai-record.md`). The rest of this chapter is Draft 0.1 and is written outside Claude Code.

You can decide a gate by writing a comment on the GitHub issue or pull request of the intent. The platform reads new comments about every 30 seconds (project setting `github.poll_interval_seconds`). The CLI does the same through the API: `adlc gate approve|reject|request-changes <gate> <intent>` (§19.8c).

**Commands.** Write the command on the **first line of a new comment**:

| Command | Records |
|---|---|
| `/approve G3` | An approval of G3. Nothing may follow the gate on that line |
| `/reject G3 <reason>` | A rejection. The reason is required |
| `/request-changes G3 <reason>` | A request for changes. The reason is required |

- Gates G1, G2 and G3 can be decided by comment; G4 and G5 when they wait for a person (Chapter 13 §13.10); G6 when CI passed and it waits for Person B, or within its block window (Chapter 14 §14.10.2); G7 by `/reject G7` and `/request-changes G7` only (approve with a pull request review, Chapter 15 §15.10.1); G8, the release, when it waits for Person B (Chapter 15 §15.10.3).
- The reason may start with a reason code: `spec_unclear`, `tests_insufficient`, `security_finding`, `out_of_scope`, `policy_denied`, `budget_exceeded`, `ci_failed`, `ai_record_missing`, `data_class_not_allowed`, `expired`, `input_mismatch`, `scope_mismatch`, `other`. A code other than `other` may stand alone: `/reject G2 spec_unclear` is accepted. `other` alone is not a reason: `/reject G2 other` without text is refused. Without a code, the platform records `other`, and you must write a sentence. Example: `/reject G2 spec_unclear AC2 does not say which warehouse`.
- The reason text stays in your comment. The platform stores only the reason code and a link to the comment, because its records are kept for years and can never be edited. Write the reason so that it can stay on GitHub, and do not put personal or client data in it.
- Only new comments count. **Editing a comment never changes a decision.** To change your mind, write a new comment.
- Text on later lines, quoted text (`> /approve G3`) and commands inside code blocks are not read.
- `/kill` stops the intent's agent run with the kill switch: Chapter 18 §18.8d.
- `/lesson <category> <target>` records a lesson (below, "Recording a lesson").

**Recording a lesson.** When an intent reaches G8, or after it closed, write what it taught you as a comment on its issue (or pull request):

```text
/lesson rework agents_md
The agent kept the old export format because AGENTS.md did not name the new one.
```

- The first line names the **category** (`gate`, `rework`, `agent_assumption`, `instructions`, `process`, `tooling`, `other`) and the **target**, what should change (`agents_md`, `memory`, `handbook`, `config`, or `none` to record only). Nothing else goes on that line.
- The lesson in words goes on the lines below; it is required. The words stay in your comment, where you can edit or delete them. The platform keeps only the two codes and a link to the comment, and it replies when the lesson is recorded.
- Person A or Person B of the project, or a tenant admin, may record a lesson, also the person who did the work. A bot never can.
- From the moment the intent enters G8 until 14 days after it closed (the project setting `learning.lesson_window_days`, Chapter 20). The release never waits for a lesson; the notice that closes the intent reminds you.
- A lesson changes nothing by itself. A person applies it through its own change (a new intent for `AGENTS.md`, a memory pull request, a configuration change, a handbook issue), which goes through its own gates.

**Who may decide.**

- Your GitHub account must be linked to your platform user. The link uses the numeric account ID, so renaming your GitHub login does not break it. Ask a tenant admin to link it.
- You need the gate's role on the project, for example Person A for G1 and Person B for G3 (codes table §4). The producer of a change never approves it at G7 or G8 ([Chapter 15 §15.10.1](ch15-p5-release.md#producers)).
- Bots and automation accounts never decide.
- The intent must be linked to the issue or pull request. One issue (or pull request) has at most one open intent; the platform refuses a second one until the first is closed.
- **You can decide only the gate the intent is waiting at.** The last status comment shows it. A command for another gate gets a reply, and nothing is recorded. One exception: a gate the platform passed on HOTL can still be rejected or sent back during its block window (below).

**Answers.**

- **A successful command gets no reply of its own.** The platform posts a **status comment** on the issue when the intent's status changes (FR-22). It confirms your decision: it names who decided and mentions the people who act next.

  | Status comment | When |
  |---|---|
  | Submitted, waits at G1 | The intent was created, and the project AI record allows its data class |
  | Cannot enter G1 yet (reason code) | The project has no AI record (`ai_record_missing`), or the record does not allow the intent's data class (`data_class_not_allowed`). See "The project AI record" below |
  | G*n* approved, waits at the next gate | The gate had the approvals it needs, bound to the current spec or plan |
  | Rejected at G*n* (reason code) | Someone rejected the gate; the intent is closed (at G7: back to G3, Chapter 15 §15.10.1) |
  | Changes requested at G*n* (reason code) | Someone asked for changes; at G1–G4 and G8 the intent stays at the gate; at G5, G6 and G7 a new run starts after G4 (Chapters 13–15) |
  | The platform passed G*n* (HOTL), waits at the next gate | The gate's conditions hold at Low risk; the comment shows until when you can block it |
  | Back at G*n* | Someone requested changes at a passed gate during its block window; the intent went back |

- The status comment comes a little later than your command: the platform moves the intent, then posts on the next poll (about 30 seconds).
- **A request for changes** at G1–G4 or G8 keeps the intent at the gate (at G5–G7 it starts a new run after G4, Chapters 13–15). Approvals written before it no longer count. Update the gate's input (a new spec version for G2, a new plan for G3), then approve again; an approval of an older spec or plan no longer counts either.
- **No gate passes by silence.** At a HITL gate the intent waits until a person with the gate's role approves. HOTL gates pass only when their conditions hold, and you can still block them (below). While an escalation freezes the intent, it does not move on, even with the approvals; it continues once the escalation is decided (Chapter 18 §18.8b).
- A command that the platform cannot read or refuses gets a reply that says why and shows the syntax. Nothing is recorded in that case: fix the command and write a new comment.
- If the platform itself fails while handling your command, it tries again on the next polls. After a few failed attempts it gives up and replies that it could not record the command. Nothing is recorded; write the command again later, and tell the platform operator.

<a id="block-window"></a>**HOTL gates (Low risk: G2 and G3 by default).** The project setting `oversight.matrix` says which gates are HOTL at which risk tier. This section describes G2 and G3; G5 (Low to High) and G6 (Medium, and AUDIT at Low) also pass by themselves with a block window, and a block there starts a new run after G4 (Chapter 13 §13.10.5, Chapter 14 §14.10.2).

- The platform **passes** the gate by itself when its conditions hold:
  - G2: a spec with at least one acceptance criterion is linked ([§19.8c](#g2-acceptance-criteria));
  - G3: a plan with at least one planned file is submitted, and no change flag forces HITL (for example `migration`; Chapter 12).
- It posts a status comment that mentions the people of the gate (G2: Person A; G3: Person B) and says **until when you can block it**. This is the **block window**: 4 working hours by default (project setting `oversight.hotl_block_window`, counted on the project's working calendar).
- **To block a passed gate**, write within the window `/request-changes G2 <reason>` or `/reject G2 <reason>`, even though the intent already waits at a later gate. You need the gate's role.
  - A request for changes takes the intent **back** to that gate. Approvals given at the later gates no longer count; they must be given again when the intent gets there.
  - A rejection closes the intent.
  - After the window, the gate can no longer be blocked. `/approve` of a passed gate is always refused: there is nothing to approve.
- After a request for changes, the platform does **not** pass the gate again with the same spec or plan. Link a new spec or submit a new plan, or approve the gate yourself with `/approve G2`.
- `/approve` at a HOTL gate always passes it at once, and then there is no block window: a person decided.
- **No agent run starts while a block window is open** (task C06): a person may still take the intent back.

**Deadlines of the gates (FR-12).**

- Every gate that waits for a person's decision has a deadline, at any of G1–G8: 1 working day by default (project setting `oversight.hitl_gate_deadline`). The clock starts when the intent enters the gate, and starts again at each request for changes. It also runs while the gate waits for its spec or plan.
- When the deadline passes, the platform raises **one escalation** (Chapter 18 §18.8b): Medium, level Notify by default (project setting `oversight.gate_overdue`). It goes to Person A when Person A holds the gate's role (route `intent`, for example G1, G2 below High risk, G4 at High risk), otherwise to Person B (route `technical`, for example G3, G6, G7, G8).
- When the gate is decided (approved, rejected, changes requested, passed), the platform closes that escalation itself. You do not need to `/ack` or `/decide` it.
- The platform records how long each gate waited for the person who decided (`waited_seconds`). The report: `adlc metrics gates` ([§19.8c](#gate-metrics)).

**Scopes.** An approval of G1, G2 or G3 has no scope. The API refuses an approval that sends one (`scope_not_allowed`).

<a id="ai-record"></a>**The project AI record (before G1).** An intent enters G1 only when the project's AI record allows the intent's data class (Chapter 2 §2.5, D-02 FR-19).

- The platform keeps the record as codes: AI use allowed (`no`, `yes`, `yes_with_conditions`), the allowed data classes, AI on production logs and data (`no`, `yes_masked`), the disclosure format (`client_format`, `standard_note`), the date the client confirmed in writing, and a link (`https://`) to the human record of template T7 (for example `docs/project/ai-record.md`). The client contact, the allowed tools and locations and any special conditions stay in that human record, never in the platform.
- Until the client has answered in writing (no confirmation date), client data is handled only as `client_restricted`: the record cannot allow `client_confidential`, and an intent with that data class waits. `prohibited` is never allowed. When AI use is `no`, no client data class is allowed. The platform never changes an intent's data class: get the written answer, or create the intent again with the right class.
- When the check fails, the intent stays a draft and the platform posts one status comment with the reason code, mentioning the people who may write the record. When the record is fixed, the intent enters G1 by itself within a few minutes.
- Who may write the record: Person A and PM / BrSE by default (project setting `access.ai_record_write_roles`; the viewer role never may). Every change is a new version; the platform keeps every version and records who made it.
- How to write it:
  - through the API: `GET` and `PUT /v1/projects/<project>/ai-record` with your API token. `PUT` needs `expected_version` (the version you read; `0` for the first version). The CLI does the same: `adlc ai-record show|set` (§19.8c).
  - the platform operator, on the server, for a new project: `adlc ops ai-record set --tenant <slug> --project <slug> --on-behalf-of <email> --expected-version <n> --ai-allowed <…> --classes <a,b | none> --prod-logs <…> --disclosure <…> [--confirmed-at YYYY-MM-DD] [--record-ref https://…]` and `adlc ops ai-record show --tenant <slug> --project <slug>`. The person named with `--on-behalf-of` must hold a write role on the project: they are accountable for the content.

---

## 19.8c. Using the platform: the `adlc` command

> **Platform usage section, owned by Claude Code** (CLAUDE.md "Documentation rules"). Written with task B04, 2026-10-03, and kept in line with the platform code (`design/ADR-M36-cli-api-client.md`).

The `adlc` command does through the API what the comment commands do on GitHub, and more: create and read intents, decide gates, act on escalations, keep the project AI record.

**Install it.** `npm install -g @hoanghainh/governed-adlc` (Node.js 24; from release v0.9.0 on), at the version of your platform; `adlc --version` prints it. Up to v0.8.0 the package was `agentic-sdlc-cli` and the command `sdlc`; v0.9.x installed both names, and from v0.10.0 only `adlc` exists. `adlc` still uses the login that `sdlc` saved. From a checkout of the repository, `pnpm adlc …` works too ([USER-GUIDE §2](../../platform/USER-GUIDE.md#install-the-adlc-command)).

**Log in once.**

1. Get your first API token (`sdlc_pat_…`) from a tenant admin (it lasts at most 7 days) or, for the first person of a tenant, from the platform operator. Keep it in your password manager. After you log in, create your own API token (`adlc token create`), log in again with it, and revoke the first one.
2. Run `adlc login --api-url https://<platform address>` and paste the API token at the prompt. The prompt does not show what you type.
   - The platform checks the API token first. Only a valid API token is saved.
   - The address must use `https://`. `http://` works only for a platform on your own machine (`http://127.0.0.1:8090`).
   - From another machine, use the team address of the platform's TLS proxy, for example `https://sdlc.example.internal:8443` (team access, task V09: `platform/deploy/README.md` "Team access (operator)"). Use the host name, not an IP address, unless the operator lists the address in the certificate.
   - If your company uses its own certificate authority, add it with the standard Node setting `NODE_EXTRA_CA_CERTS=<file>` (the `ca.pem` the operator gives you). The command never runs with certificate checks turned off. When `adlc doctor` says the machine does not know the CA, this is the fix.
3. `adlc whoami` shows who you are and your roles per project.
4. `adlc doctor` checks your login and the API, and says what to fix (task V07): certificate checks on, the saved login file private, the API reachable over TLS and ready, your API token accepted and not near its end (a warning at 14 days or less), your roles per project, and the CLI's version against the API's. It reads only (`GET /health/live`, `/health/ready`, `/v1/me`, `/v1/me/tokens`), changes nothing and never prints your API token. One line per check (ok, warning, failed, skipped) and, for each problem, the fix; `--json` gives the same. Exit 1 when a check failed. When the API is down or you are not logged in, it says so. A problem on the server: the operator runs `pnpm doctor` there.

- The API token is saved in `~/.config/adlc/credentials.json` (or under `$XDG_CONFIG_HOME`), readable only by you. A login saved by `sdlc` before v0.9.0 (`~/.config/sdlc/`) is read until `adlc` saves its own; `adlc logout` deletes both. It is stored as plain text, so protect your account and your disk. If the file can be read by others, the command stops until you fix it (`chmod 600`) and log in again.
- **Never put the API token on the command line**, in a script, in a chat or in a ticket. There is no `--token` option. To pipe an API token in (for example from a password manager), use `--token-stdin`.
- `adlc logout` revokes the API token on the server, then deletes the saved login on your machine. If the server cannot be reached, it still deletes the login and says the API token is still valid: revoke it later with `adlc token revoke` from another login.
- Your own API tokens: `adlc token create --name <name> [--days <n>]` (the new API token is shown once), `adlc token list`, `adlc token revoke --id <ID>`. Use one API token per machine.
- In CI only, set `SDLC_API_URL` and `SDLC_API_TOKEN` (as CI secrets) instead of logging in. Do not use them on your own machine: environment variables can leak into process lists and logs.

**Commands.** Add `--json` to any command for machine-readable output.

| Command | Does |
|---|---|
| `adlc intent create --project <slug> --title <text> --risk <tier> --data-class <class> [--description <text> \| --description-file <file>] [--budget <USD>] [--issue <number>] [--spec <path/to/spec.md> [--spec-commit <SHA>] [--spec-tool spec-kit\|bmad\|manual]]` | Creates an intent; you become its intent owner (Person A). With `--spec`, also links its spec, as `adlc spec link` does (task U03). When the link is refused, the intent stays: the command names it, exits 1 and says how to link again |
| `adlc intent list [--project <slug>] [--status <status>] [--gate <G1–G8>] [--risk <tier>] [--created-from <YYYY-MM-DD>] [--created-to <YYYY-MM-DD>] [--closed-from <YYYY-MM-DD>] [--closed-to <YYYY-MM-DD>] [--sealed yes\|no] [--has-lessons yes\|no] [--search <text>] [--limit <n>] [--cursor <c>]` | Lists the intents you can read, newest first, with filters (below, "Finding past intents") |
| `adlc intent show <INT-…>` | Shows an intent with its spec, plan and gate decisions, its **links** (the issue, the pull request, the spec and the plan file at their commits, the sealed Evidence Pack), and **what holds it** when the platform holds it ("Held: …", the cause, until when) and the human-effort estimate |
| `adlc intent estimate <INT-…> --hours <n>` | Records your estimate of the hours the work would take **without an agent** (0.25 to 10000, at most two decimals). Only Person A (a role in `access.intent_create_roles`) or a tenant admin, and only while the intent is open. The agent report compares it with the lead time ([below](#agent-metrics)) |
| `adlc next <INT>` | What you do next for this intent (task V06): the gate, who it waits for, why it is held (the reason the workflow recorded), and one advice for you: the command or comment to type, or the roles it waits for. It reads only the intent and your roles (`GET /v1/intents/:intent`, `GET /v1/me`) and changes nothing. A producer of the change (the intent's creator at G7 and G8, the person who approved G4 at G5, G7 and G8) is never told to approve; at G3 it reminds you that the person who submitted the plan cannot approve it. For an escalation it points to `adlc escalation list --intent <INT>`. For actions outside a gate (link a spec, submit a plan, the AI record) it uses the default access roles and says so |
| `adlc help [topic\|command]`, `adlc <command> --help` | Short guides (getting started, roles and the two-person rule, the gates, the comment commands, troubleshooting) and every command with its options and one example (task V10). After `intent create`, `gate approve\|reject\|request-changes`, `spec link`, `plan submit`, `escalation decide` and `run kill`, the CLI prints one line with the next step (the advice of `adlc next`; never with `--json`). After a failure it prints what to do (for example `adlc login`, `adlc doctor`, `adlc whoami`). No colours |
| `adlc doctor` | Checks your login and the API, and what to fix (task V07; step 4 above). Read only |
| `adlc gate approve <gate> <INT-…>` | Approves the gate the intent waits at |
| `adlc gate reject <gate> <INT-…> --reason-code <code> [--reason-ref <https://…>]` | Rejects the gate |
| `adlc gate request-changes <gate> <INT-…> --reason-code <code> [--reason-ref <https://…>]` | Requests changes |
| `adlc escalation list\|show\|ack\|decide …` | Chapter 18 §18.8b |
| `adlc run list <INT-…>` / `adlc run kill <run ID\|INT-…>` | Lists the intent's agent runs / stops a run with the kill switch: Chapter 18 §18.8d |
| `adlc spec link <INT-…> --path <path/to/spec.md> [--commit <SHA>] [--tool spec-kit\|bmad\|manual]` | Links the intent's spec (below) |
| `adlc spec list <INT-…>` | Lists the linked spec versions: path, commit and SHA-256 |
| `adlc plan submit <INT-…> [--commit <SHA>]` | Submits the intent's plan file (below) |
| `adlc plan list <INT-…>` / `adlc plan show <INT-…>` | Lists the submitted plan versions / shows the latest one with its path patterns, tools and change flags |
| `adlc plan draft <INT-…> --from <file> --tool spec-kit\|bmad [--output <file>] [--force]` | Writes a plan file draft on your machine from a Spec Kit `tasks.md` or a BMAD story file (below). Sends nothing |
| `adlc ai-record show --project <slug>` | Shows the project AI record |
| `adlc ai-record set --project <slug> --expected-version <n> …` | Saves a new version (same options as the operator command above, without `--tenant` and `--on-behalf-of`: you are the accountable person) |
| `adlc cost report [--project <slug> \| --intent <INT-…>] [--from <time>] [--to <time>] [--by project\|intent\|model\|status]` | Shows tokens and cost (below) |
| `adlc metrics gates [--project <slug>] [--gate G1..G8] [--mode HITL\|HOTL\|AUDIT\|POLICY] [--risk low\|medium\|high\|critical] [--from <time>] [--to <time>]` | Shows how long gates waited for people (below) |
| `adlc metrics agents [--project <slug>] [--agent <key>] [--model <name>] [--from <time>] [--to <time>]` | Shows whether agents and models are worth it, from real runs (below) |
| `adlc trial report [--project <slug>] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--max-intents <n>] [--json]` | The community trial's report (`TRIAL.md` §6): gate waits, runs, decisions, escalations, tokens and cost of the intents created in the range, **anonymous** (projects become `project-1`…, intents `intent-1`…; never a code, title, person, repository or link). Default range: the last 90 days. Built from the reads above with the same access rules; nothing is printed when the report fails its safety check (`design/ADR-M65-trial-report.md`) |
| `adlc evidence build <INT-…>` | Builds a new version of the intent's Evidence Pack, or returns the latest one when nothing changed: Chapter 15 §15.10.2 |
| `adlc evidence list <INT-…>` / `adlc evidence show <INT-…> [--version <n>]` | Lists the pack's versions / shows one (default: the latest), with its release SHA-256 (what a G8 approval is bound to) |
| `adlc gate approve G8 <INT-…>` / `adlc gate reject G8 <INT-…> --reason-code <code>` | Approves or rejects the release at G8 (Person B; at Critical risk also the second approver). The platform seals the pack and closes the intent: Chapter 15 §15.10.3 |
| `adlc evidence export <INT-…> [--version <n>] [--manifest] [--output <file>]` | Prints or saves the readable pack (`pack.md`), or the manifest with `--manifest`, after checking its SHA-256; `--output` never overwrites a file |
| `adlc evidence proposal <INT-…> [--run <run ID>] --output <file> [--force]` | Saves the patch of a High-risk (L1) run after checking its SHA-256 (client code: mode 600, never printed; every download audited). Then end the intent with `adlc gate reject G4`: Chapter 13 §13.10.4 |
| `adlc lesson add <INT-…> --category <code> --target <code> --comment <https://…>` | Records a lesson that points to an existing comment on the intent's issue or pull request (below, "Lessons from the command line") |
| `adlc lesson apply <lesson ID> --link <https://…>` / `adlc lesson drop <lesson ID> --reason <code>` | Records what became of a lesson: applied by a change, or dropped with a reason |
| `adlc lessons list [--project <slug>] [--open] [--since YYYY-MM-DD]` | Lists the lessons of the projects you can read, newest first, for the monthly learning step |
| `adlc lesson issue <lesson ID> [--repo <owner/name>]` | Prints a filled-in GitHub "new issue" link for the handbook's authors |
| `adlc metrics lessons [--project <slug>] [--since YYYY-MM-DD]` | Counts the lessons: open, applied, dropped, per category and target, and the median days to an outcome |
| `adlc client request-data-deletion [--basis <code>]` | Tenant admins: asks to delete this tenant's client data (codes only; default basis `contract_offboarding`). The tenant stays active until an operator approves (§19.8d) |
| `adlc client cancel-data-deletion` | Tenant admins: cancels an open request, or an approved deletion still in the grace period |
| `adlc client status` | Shows the deletion phase for this tenant (`none`, `requested`, `approved`, …) |

**Finding past intents.** `adlc intent list` searches only the intents of the projects you have a role on, in your own tenant.

- `--search <text>` (2 to 200 characters) looks for the words of the title and the description. Words are matched as they are written: `order` does not find `orders`, so try both. Put a phrase in quotes (`"monthly export"`), or join words with `or` (`csv or export`).
- An intent code (`--search INT-2026-0042`) finds that intent. `--search '#42'` finds the intent of issue or pull request 42.
- Vietnamese and English words are found one by one. Japanese text is split only at spaces and punctuation, so search for the whole run of characters as it is written.
- `--gate G3` lists the open intents at G3. `--risk high` filters by risk tier. `--created-from`, `--created-to`, `--closed-from` and `--closed-to` take UTC days (both ends included); "closed" means the day the intent became done, rejected, cancelled or blocked. `--sealed yes` lists intents with a sealed Evidence Pack (G8 passed), `--sealed no` the others.
- Filters combine: `adlc intent list --risk high --closed-from 2026-11-01 --search export`.
- `--has-lessons yes` lists the intents with at least one lesson, whatever its state; `--has-lessons no` the others.
- The platform never records what you searched for. After a client's data is deleted, its intents keep their codes and dates, and their titles read `Redacted intent <code>`.

- Gate decisions take **codes only**: a reason code (§19.8b) and, if you want, `--reason-ref` with an `https://` link to a comment that explains it. The platform never stores your words, because its records are kept for years.
- The rules are the same as for comments (§19.8b): you need the gate's role, you can decide only the gate the intent waits at, and a producer never approves.

<a id="lessons-cli"></a>**Lessons from the command line.** A lesson is a comment on the intent's issue or pull request (§19.8b, "Recording a lesson"). The same people, in the same window, can also use `adlc`:

- `adlc lesson add INT-2026-0042 --category agent_assumption --target agents_md --comment <link>` records a lesson for a comment you already wrote. Copy the comment's link from its date in the comment header. The platform checks that the comment is on this intent's issue or pull request and that it exists; it keeps the codes and the link, never the words.
- `adlc lesson apply <lesson ID> --link <https://…>` records the change that applied the lesson: a merged pull request, an intent or an issue. `adlc lesson drop <lesson ID> --reason duplicate|not_valid|record_only|other` records why nothing will change. The latest of these is the lesson's state; a lesson with neither is `open`.
- `adlc intent create --from-lesson <lesson ID> --title <text> --risk <tier> --data-class <class>` creates the intent that applies the lesson (for example a change to `AGENTS.md`), in the lesson's project unless you give `--project`. The lesson becomes `applied`, and `adlc intent show` of the first intent lists the new one as a follow-up. The new intent goes through its own gates.
- `adlc lesson issue <lesson ID>` prints a link to a new GitHub issue in the framework's repository, with the label `handbook`: the codes, the intent code and the comment link are filled in. Open it, write what should change and why, and submit it; then `adlc lesson apply <lesson ID> --link <issue link>`.
- `adlc lessons list --open` and `adlc metrics lessons` are for the monthly learning step (Chapter 16): they show what is still open and how long lessons wait for an outcome.

<a id="spec-link"></a>**Linking a spec (G2 input).** G2 checks the intent's spec. Link it with `adlc spec link` (task B08, `design/ADR-M39-spec-linking.md`):

- Who: Person A and PM / BrSE by default (project setting `access.spec_link_roles`; the viewer role never may).
- When: while the intent is a draft or waits at G1, G2, G3 or G4.
- What: a Markdown file (`.md` or `.markdown`) in the repository, at most 256 KiB, UTF-8 text. The platform reads it from GitHub and keeps only its SHA-256, never the content.
- **The spec is the file on the default branch** (`main`): the agent run starts from there. Leave out `--commit`, or give a commit that holds the same content as the default branch; otherwise the platform refuses (`spec_not_on_default_branch`).
- **If someone edits the spec on the default branch after G2**, the platform notices it at the next step: it links the new version, takes the intent back to G2 and posts a comment (`spec_changed`). Approvals of the old spec no longer count. At Low risk G2 is HOTL, so the platform may pass the new spec again, with its block window; at other tiers a person approves it again.
- If the file is removed, renamed or cannot be read, the intent goes back to G2 and waits (`spec_unavailable`) until you restore it or link another spec.
- If GitHub cannot be reached, the intent waits; it never passes a gate without the check.
- <a id="g2-acceptance-criteria"></a>**G2 needs acceptance criteria** (task S01, `design/ADR-M61-spec-structure.md`). This is the one description of the G2 condition; other documents link here. When the platform reads the spec, it counts its acceptance criteria and shows the count (`adlc spec link`, `adlc spec list`). It keeps the count, never the text. G2 passes only when a spec is linked and has at least one criterion, at every risk tier and in every oversight mode: the platform's HOTL pass at Low risk needs it too. Otherwise the platform records `fail spec_unclear`, posts a comment, and the intent waits at G2 (`spec_unclear`); nobody can approve G2 until the spec has criteria. Person A may still reject G2 or request changes.
- Name the tool with `--tool` so the platform reads the right structure:

  | `--tool` | Where the platform finds the criteria | One criterion |
  |---|---|---|
  | `spec-kit` (Spec Kit 1.1.2) | each `**Acceptance Scenarios**:` block | each top-level list item of the block; in the template, a numbered item `1. **Given** … **When** … **Then** …` (one item, however many lines). Requirements `FR-xxx` and success criteria `SC-xxx` do not count |
  | `bmad` (BMAD Method 6.12.1) | a story file's `## Acceptance Criteria`, or an epics file's `**Acceptance Criteria:**` blocks | each top-level list item; in an epics file, each `**Given**` group (a block without one: each list item) |
  | `manual`, or no `--tool` | a heading with "Acceptance criteria" or 受入基準, for example `## 受入基準 / Acceptance criteria` | each top-level list item under it |

  If the tool's structure is not found, the platform tries the other structures. Template text that was never filled in (`[initial state]`, `{{precondition}}`) and text that is not a list item do not count.
- A spec linked before this rule existed has no count: link it again (`adlc spec link` with the same path) and the platform counts it.

<a id="plan-file"></a>**Submitting a plan (G3 input).** G3 checks the intent's task plan (template T13). Submit it with `adlc plan submit` (task B09, `design/ADR-M40-plan-submission.md`):

- Where: the file `.sdlc/plans/<intent code>.yaml`, for example `.sdlc/plans/INT-2026-0007.yaml`, **merged into the default branch** first. The platform reads it from GitHub and keeps its SHA-256, path patterns, tools and change flags; summaries and other text stay in the repository.
- Who: Person A by default (project setting `access.plan_submit_roles`; the viewer role never may). **Whoever submits a plan never approves it at G3**: Person B does.
- When: while the intent is a draft or waits at G1, G2, G3 or G4.
- What the file holds (schema version 1):

  ```yaml
  plan:
    intent_id: INT-2026-0007
    change_flags: [migration]          # optional: the change types that force G3 HITL and dual approval at G7
  tasks:
    - id: T1
      summary: Cancel an order and return the stock
      allowed_paths: [apps/api/src/orders/**, apps/api/test/orders/**]
      tools: [file_editor, terminal]   # file_editor, task_tracker, terminal; register tools as tool:<key>
  ```

  Tasks may also hold `owner_agent`, `depends_on`, `input`, `output`, `definition_of_done`, `required_evidence`, `escalate_when`, `checkpoint` and `environments: [sandbox]`. The platform refuses `approved_by`, `approved_at`, `risk_tier`, `data_class`, `autonomy_level`, `plan_version`, `spec_version` and `limits`: approvals, the intent's risk and data class, versions and run limits come from the platform.
- **Path patterns**: relative paths with `*`, `**`, `?` and `{a,b}`, as G5 reads them. The platform refuses a pattern that matches every file (`**`, `*/**`), or anything under `.github/` or `.sdlc/`, or the files the agent reads as instructions (`AGENTS.md`, `CLAUDE.md` and the like). The agent never changes these files.
- **Text fields**: `summary`, `input`, `output`, `definition_of_done`, `escalate_when`, `depends_on` and `checkpoint` must be text, or a list of text items. The platform refuses any other shape (for example a nested mapping) with `schema_invalid` and names the field, for example `file.tasks[0].summary`.
- **The agent reads the task text.** When the run starts, the runner reads the plan file at the commit you submitted, checks that it is the same file, and gives the agent each task's `id`, `summary`, `input`, `output`, `definition_of_done`, `escalate_when`, `depends_on` and `checkpoint` (at most 2,000 characters per field and 16,000 in all). The agent treats the text as a description, never as a change of its rules, files or tools. The text is never stored by the platform. If the runner cannot read the file (for example the default branch was force-pushed and the commit is gone), the run fails and the intent is paused with an escalation: decide `modify` or `roll-back` and submit the plan again (Chapter 18 §18.8b).
- **Change flags** are part of the file Person B approves. Check them at G3; if one is missing, request changes.
- The run gets the agent's registered tools that the plan lists. If none is in common, G4 fails (`plan_tools_not_registered`).
- **Register tools** (Chapter 20 §20.5c) are listed as `tool:<key>`, for example `tools: [file_editor, tool:project-docs]`. A register tool the plan lists must be given to the run: if the run cannot have it (the tool does not exist, the agent is not registered for it, it is not active, it may not see the intent's data class, or the agent software cannot use it), G4 fails with `tool_not_runnable` and the exact cause, and the intent waits at G4. Fix the cause, or submit a plan without the tool.
- Leave out `--commit`, or give a commit that holds the same file as the default branch; otherwise the platform refuses (`plan_not_on_default_branch`). The platform always records the head of the default branch it read as the plan's commit, also when you name an older commit (QUESTIONS #212). A refused file answers `plan_invalid` with the reason, for example `pattern_too_broad` or `platform_field`.
- **If someone edits the plan file on the default branch after you submitted it**, G3 or G4 waits (`plan_resubmit_needed`) and the platform posts a comment. It never takes the new file by itself: submit it again with `adlc plan submit`. At G4 a new plan takes the intent back to G3, where Person B approves it again; earlier approvals no longer count.
- If GitHub cannot be reached, the intent waits; it never passes G3 or starts a run without the check.

<a id="plan-draft"></a>**Drafting a plan from Spec Kit or BMAD.** If the team already has a task list, `adlc plan draft` writes the plan file for you to complete (task S02, `design/ADR-M62-plan-draft.md`). It runs on your machine only: it calls no API, runs no Git command and never submits, commits or pushes.

- Sources (the pinned versions): a Spec Kit `tasks.md` (`--tool spec-kit`) or a BMAD **story** file (`--tool bmad`). A BMAD epics file is refused: one intent is one story, so draft from the story file. The file must be UTF-8 text of at most 256 KiB.
- What it writes:
  - Spec Kit: one task per line such as `- [ ] T012 [P] [US1] Create the model in src/models/order.ts`, with the description as `summary`, `depends_on` only from an explicit "(depends on T010, T011)", and the phase's `**Checkpoint**:` on its last task. With more than 20 lines it writes one task per phase instead (a plan holds at most 20 tasks) and says so; split it again if you want.
  - BMAD: one task per top-level item of `## Tasks / Subtasks`, with its subtasks as `definition_of_done`.
- **What you decide.** Each task's `allowed_paths` and `tools`, and the plan's `change_flags`, are written as `null` under a comment `PERSON MUST FILL` or `PERSON MUST DECIDE`. The platform refuses the file (`schema_invalid`) until you fill them. Write `change_flags: []` when no flag applies. Paths that a Spec Kit task names are listed in comments as suggestions only: check them before you copy them.
- A task list that still holds template text (`[Entity1]`, `Task 1 (AC: #)`) is refused: fill it first.
- Where: `.sdlc/plans/<INT-…>.yaml` at the root of your repository (the nearest folder with `.git`, also when you run the command in a sub-folder), or the file you name with `--output`. An existing file is replaced only with `--force`.
- Then: check every task, fill the marked fields, commit the file to the default branch and run `adlc plan submit <INT-…>`. You are the producer of the plan, as if you had written it by hand.


<a id="cost-report"></a>**Reading the cost report.** `adlc cost report` shows what the model calls cost (task E04, `design/ADR-M45-cost-report.md`, D-02 FR-53):

- Who: the whole tenant (no `--project`, no `--intent`): tenant admins only. One project or one intent: a tenant admin, or a role in the project setting `access.cost_read_roles` (by default Person A, Person B, PM / BrSE, governance and admin). The viewer role never may.
- When: times are UTC, written `YYYY-MM-DD` (00:00 that day) or `YYYY-MM-DDThh:mm:ssZ`. `--from` is included and `--to` is excluded: `--from 2026-10-01 --to 2026-11-01` is all of October. Without them, the report covers the current month until now. At most 366 days. A range that is empty (`--to` not after `--from`) or longer than 366 days is refused: the API answers 400 `invalid_request` with the reason `range_empty` or `range_too_long`, and the command exits with code 2. So does a time in another format, or `--project` together with `--intent`.
- The table has one row per project (whole tenant), per intent (one project) or per model (one intent); `--by` chooses another grouping, also `status` (the run's status). Each row and the total show the calls, tokens in, tokens out, cached tokens, cost, wasted tokens and wasted cost. Amounts are USD with 6 decimals. At most 500 rows are shown, largest cost first; the total always covers everything.
- **Wasted** = tokens and cost of runs that ended failed, cancelled or stopped (budget, scope, time, stalled, killed). Runs that succeeded, and L1 runs that produced a proposal, are not wasted. Runs sent back later by G6 or G7 are not counted as wasted yet.
- **The numbers are as fresh as the last copy from the model gateway.** The platform copies spend every few minutes (5 by default) and again when a run ends, so a run still in progress shows its cost so far. Calls of the last few minutes may not be shown yet. Every report ends with the time of the latest recorded call, the time of the last copy, and the number of runs still in progress.

<a id="gate-metrics"></a>**Reading the gate waiting times.** `adlc metrics gates` shows how long the gates waited for a person's decision (task E06, `design/ADR-M47-gate-metrics.md`, D-02 FR-12). Use it to see whether the gates slow the team down.

- Who: the whole tenant (no `--project`): tenant admins only. One project: a tenant admin, or a role in the project setting `access.metrics_read_roles` (by default Person A, Person B, the second approver, PM / BrSE, governance and admin). The viewer role never may.
- When: the same time formats as the cost report. `--from` is included, `--to` is excluded. Without them, the last 30 days until now. At most 366 days; a bad range is refused with 400 and exit code 2. The range selects the decisions by the time they were recorded.
- What one row shows, per project and gate:
  - **first round**: the decisions people made (approve, reject, request changes) with no request for changes before them at the same gate in the same visit. This is the time the gate waited for a person.
  - **after changes**: the decisions after a request for changes at the same gate. The time still counts from the moment the intent entered the gate, so it includes the time the producer spent on the changes.
  - For each: the number of decisions, the average, the median, the 90th percentile (P90) and the maximum.
  - **Passed by the platform**: HOTL and AUDIT passes at G1–G3, G7 and G8. They are counted, never mixed into the times.
  - **At the gate now** and **Oldest**: the intents waiting at the gate now, and the longest wait. Every gate is shown; at G4 to G6 an intent may wait for a run or for CI, not for a person. The range and `--mode` do not apply to them.
- **Wall-clock time**, not working hours: a gate entered on Friday evening and approved on Monday morning waited the whole weekend.
- Decisions the platform makes by itself (G4 policy checks, G5 and G6) never count. A block of a passed gate never counts. Each approval of a dual approval counts.
- The report never shows who decided: it is about the gates, not about people.
- `--gate`, `--mode` (the oversight mode of the decision) and `--risk` (the intent's risk tier) narrow the rows. At most 500 rows are shown.

<a id="agent-metrics"></a>**Reading the agent report.** `adlc metrics agents` shows how agents and models did in real work, per project, agent version and model (task V13, `design/ADR-M79-agent-metrics.md`, D-02 FR-53, D-07 §5). It reads runs, gate decisions and cost records the platform already holds. It answers "is this agent worth its cost?". For a controlled comparison of agents and models on fixed tasks, see the evaluation harness (task L02, not built yet).

- Who: a tenant admin for the whole tenant (no `--project`). For one project: a tenant admin, or a role that is in **both** `access.cost_read_roles` and `access.metrics_read_roles` (by default Person A, Person B, PM / BrSE, governance and admin; not the second approver, not the viewer). A role in only one list gets 403; no role on the project gets 404.
- When: the same time formats and limits as the gate times. The report counts the runs created in the range (`--from` included, `--to` excluded); without them, the last 30 days. At most 366 days.
- Run measures: runs by how they ended and by stop reason, retries (an attempt after the first), and runs still in progress. The "ended well" share leaves out runs in progress. A run's model is the one the platform chose for it at G4 (the run event `model_selected`). For runs from before that event, it is the model with the most cost in the run's cost records; a run without either shows the model `unknown`.
- Quality measures: CI on the first try (the first CI result of an intent, counted under the run that made it), scope breaches at G5, and the intents merged with and without a request for changes at G7. These count under the run that was merged. Lead time is the wall-clock time from the creation of the intent to its close.
- Cost measures: input and output tokens, the cached share of input tokens, total cost, wasted cost (runs that failed, were cancelled or stopped), cost per run and **cost per merged intent** (the whole cost of the intent, divided by the intents merged). Calls that belong to no run are shown apart and are not in any row. Money is a decimal string; a measure without data is empty, never 0.
- Human-effort baseline (task V14): Person A can record an estimate of the hours an intent would take without an agent, with `adlc intent estimate <INT-…> --hours <n>`, while the intent is open. The column **Lead / estimate** shows the lead time of the merged intents that have an estimate as a percentage of their estimated hours, and in brackets how many intents had one. For example, `50.0% (2)`: two merged intents took half of the time estimated for them. The lead time is calendar time, not working hours, so read the number as a signal, not a measure of effort. An intent without an estimate is left out; `-` means no merged intent had one. A finished intent keeps its estimate; an estimate cannot be removed.
- It never shows a person. With `--json`, the amounts stay strings and the counts are numbers.

**Evaluation plans** (task L05). An evaluation runs agents, models and prompt variants on a fixed task set with hidden tests, through the platform's own runner, and records numbers and codes per run. A person with a role in the project's `access.eval_roles` (never `viewer`) makes and runs plans; anybody with a role on the project reads them:

| Command | What it does |
|---|---|
| `adlc eval plan list --project <slug>` | The project's plans: status, next run, a run that waits, the last refusal |
| `adlc eval plan show <plan-id>` | One plan: what it runs, when, its budgets, its versions and evaluations |
| `adlc eval plan create --project <slug> --file <plan.json>` | A new plan from a JSON file (at most 64 KB) |
| `adlc eval plan change <plan-id> --file <plan.json> --expected-version <n>` | A new version; refused when someone changed it since you read it |
| `adlc eval plan archive <plan-id>` | Ends the plan for good |
| `adlc eval run <plan-id>` | Run now: the platform starts the evaluation within a minute |
| `adlc eval list --project <slug>` / `--plan <plan-id>`, `adlc eval show <EVAL-…>` | Evaluations: status, runs by status, spend |
| `adlc eval report <EVAL-…>` | The report of one evaluation: each configuration's resolved rate with its 95% interval, pass@k and pass^k, CI on the first try, cost per resolved run; the comparisons on the same tasks; the recommendations; for people with a role in both `access.cost_read_roles` and `access.metrics_read_roles`, the real runs of the same models in the last 30 days |

The plan file holds codes, numbers and amounts only: `code`, `data_class`, `task_set_version`, `task_ids` (empty: every task), `runs_per_task`, `budget_per_run_usd`, `monthly_cap_usd`, `trigger` (`once`, `schedule`, `on_change`), `schedule` (`every` `daily` or `weekly`, `hour` in UTC, `weekday` 1–7) and `configurations`. A configuration names an agent of the register (`agent_key`) or a model (`model`, `provider_type`) run by the project's default agent, its caps (`max_iterations`, `max_duration_min`), and optionally `prompt_path`: **a file on the project's default branch** to try instead of `AGENTS.md`. The platform keeps that file's path, commit and SHA-256, never its text, and reads it again when a run starts. The agent of the register may be `proposed`, `active` or `suspended`, never `quarantined` or `retired`: test a new version before it is approved (Chapter 20 §20.5b). In the runs, the agent gets its own tools from the register (a model: the tools of the project's default agent). Budgets: each run has `budget_per_run_usd`; the plan spends at most `monthly_cap_usd` per UTC month (then its schedule pauses until next month); the tenant's monthly budget applies too. Amounts change only by a new version, never below what the plan spent this month. When the platform cannot start a run (a model the gateway no longer lists, a missing task, the cap used up), the plan shows the reason as its last refusal.

<a id="project-tasks"></a>**A project's own task set** (task L07, `design/ADR-M85-project-task-sets.md`). Task set 1 holds sample tasks on the sample repository. A project can also measure agents on **its own code**. A task comes from a merged intent: the commit before the change, the intent's spec, and the test files its pull request added or changed. The agent never sees those tests (they are the "hidden tests"). The reference solution is the rest of the pull request's change.

| Command | What it does |
|---|---|
| `adlc eval task draft <INT-…> --project <slug> --task <id>` | Writes the task card `.sdlc/eval-tasks/<id>.yaml` on your machine (never over a file without `--force`). It says when the test commands are missing: write them in the card |
| `adlc eval task register <id> --project <slug>` | After a person merged the card through a normal pull request: the platform reads it from the default branch and stores its path, commit and SHA-256 |
| `adlc eval task list --project <slug>` | The project's tasks: status, the code of a failed check, the card's SHA-256 |
| `adlc eval task approve <task-uuid> --card <sha256>` | Approves a task whose check passed |
| `adlc eval task reject <task-uuid> --card <sha256> --reason <code>` | Rejects it: `not_representative`, `tests_weak`, `too_large`, `needs_environment` or `other` |

- **The check.** The server checks every registered task before anybody reviews it, with no agent and no cost. It installs the repository with `pnpm install --frozen-lockfile` (other package managers are not supported yet), with no network for the tests. The hidden tests must **fail** on the commit before the change and **pass** with the reference solution. A failed check has a code: `passes_without_change`, `solution_fails`, `install_failed`, `card_changed`, `spec_changed`, `hidden_test_missing`, or `check_lost` (the server could not finish it three times). Tests that need a browser or a database fail the check.
- **The review.** A person with a role in `access.eval_roles` approves or rejects the task. That person never worked on the intent: not its creator, not the person who started its runs or submitted its plan, not an author of its commits. The approval is bound to the card's SHA-256: a changed card is checked and reviewed again (register it again).
- **A removed card** makes its task `gone`: it never runs again; its past results stay.
- **Running it.** In a plan file, write `"task_set_kind": "project"` and `"task_set_version": null` (in the dashboard, write `project` in the task set field). `task_ids` may name some approved tasks; empty means every approved task. When the evaluation starts, the platform reads the cards on the default branch. A card that changed since its approval is left out. The evaluation records that commit with the task IDs: this is the version of the set, and the report shows both. Each run starts at its own task's commit.
- **Data class.** The plan's data class is never below the data class of an intent its tasks came from (`data_class_below_tasks`). `client_restricted` data goes to self-hosted models only. A plan with no approved task to run is refused (`task_set_empty`).
- `adlc ops eval start` runs the numbered task sets only. A project's own task set runs through a plan.

<a id="exit-codes"></a>**When a command fails.** The message says why. The exit code tells scripts what happened (this is the one list; other documents link here):

| Exit code | Meaning |
|---|---|
| 0 | Done |
| 1 | The platform refused (no role, not found, conflict, rule broken, too many requests) |
| 2 | Wrong command or options, not logged in, unsafe saved login, or a request the API refuses as malformed (HTTP 400, for example a bad time range) |
| 3 | The platform could not be reached, failed (HTTP 5xx) or answered something unexpected |
| 4 | Your API token is missing, expired or revoked: get a new one and run `adlc login` |

## 19.8d. Using the platform: setting up a team (admins)

> **Platform usage section, owned by Claude Code** (CLAUDE.md "Documentation rules"). Written with task B13, 2026-10-03, and kept in line with the platform code (`design/ADR-M37-admin-onboarding.md`).

Before anyone can approve a gate, an admin sets up the project and the team: the project, the people, their GitHub accounts and their roles. The commands in the order of a first set-up, with the sandbox image, the agent, the configuration and the AI record: `platform/deploy/README.md`, Fresh deployment steps 9–13. The dashboard's **Admin** screen does the same changes, each confirmed with your passkey (§19.8e, task U09); API tokens stay in the CLI.

**Who is an admin.**

- A **tenant admin** manages the whole tenant: projects, people, GitHub accounts, roles, project configuration, and other tenant admins. The first person of a tenant becomes tenant admin when the platform operator creates the tenant on the server.
- A person with the project role **`admin`** manages the roles and the configuration of that project only.
- Being an admin does not let you approve anything. Gate approvals still need the gate's role (§19.8b).

**The rules the platform enforces.**

- **Nobody gives a role to themselves**, and nobody disables themselves. Ask another admin. A team with only one admin asks the platform operator, who does it on the server (`adlc ops role grant`).
- <a id="conflicting-roles"></a>**Person A and Person B are never the same person on a project.** Some other pairs of roles are kept apart too; the project configuration lists them (`access.conflicting_roles`). The defaults are two pairs: Person A and Person B (rule M21: a project can never remove it), and Person B and the second approver. A project may add or remove the other pairs. A role that would break a pair is refused.
- **The tenant always keeps one tenant admin.** The last one cannot be removed or disabled: make someone else a tenant admin first.
- A role is never deleted: it is revoked, and the history stays. A GitHub account is unlinked, not deleted.
- A GitHub account is linked by its **numeric account ID**, never by its login, because a login can change. Find the ID with `gh api users/<login> --jq .id`.
- Every change is recorded in the audit log with IDs and codes only: never a name, an e-mail address or a login.

**Set up a new project, step by step** (all commands take `--json`):

1. Create the project: `adlc admin project create --slug <slug> --name <name> --repo <owner/name> [--folder <path>] [--default-branch <branch>]`.
   - `--folder` is for a monorepo: the project is one folder of the repository, for example `packages/web` (Chapter 13 §13.10.2a). Several projects can share one repository when their folders do not overlap; a project without a folder has the repository alone. The platform refuses an overlap (`repo_path_overlap`). The repository and the folder change only while the project has no open intent.
2. Add each person: `adlc admin user create --email <email> --name <name>`.
3. Link each person's GitHub account: `adlc admin identity link --user <email> --github-id <numeric ID> --github-login <login>`. Without it, the person's `/approve` comments are refused.
4. Give the roles: `adlc admin role grant --project <slug> --user <email> --role <role>`, for example `person_a`, `person_b`, `second_approver`, `pm_brse`, `governance`, `admin` or `viewer` (Chapter 5).
5. If the project needs settings other than the defaults, upload its configuration: `adlc admin config show --project <slug>` shows the version in force (0 = the defaults), then `adlc admin config set --project <slug> --file <config.yaml> --expected-version <version>`.
   - The platform refuses a configuration that loosens a mandatory rule, and says which line and which rule.
   - It accepts other loosening (for example HOTL instead of HITL at G2 for Medium risk), shows a warning for each, and records the warnings in the audit log.
6. Ask the PM / BrSE or Person A to save the project AI record (`adlc ai-record set`, §19.8b). Intents wait before G1 until it exists.

<a id="project-file"></a>**Set up a project from one file** (task V17). Steps 1–5 above can also come from one YAML file: `adlc admin project apply --file project.yaml [--dry-run] [--yes]`. Keep the file outside the application repository. It holds no secret: the platform refuses a file with an unknown key. A commented example: [`platform/deploy/project.example.yaml`](../../platform/deploy/project.example.yaml).

```yaml
format: 1
project:
  slug: pilot
  name: Pilot
  repository: owner/name
  folder: packages/web            # optional: one folder of a monorepo
  default_branch: main            # optional
team:
  - email: ana@example.com
    name: Ana
    github_login: ana-gh
    roles: [person_a]
  - email: bao@example.com
    name: Bao
    github_login: bao-gh
    roles: [person_b]
agent:                            # optional: the agent to register (Chapter 20 §20.5b)
  key: coder
  version: 1.0.0
  owner: ana@example.com          # a person of the team
  model: <gateway model with version>
  instructions: AGENTS.md@<label>
  instructions_file: AGENTS.md    # hashed by the CLI; relative to this file
  tools: [file_editor, terminal]
  max_autonomy: L2
  environments: [sandbox]
config:                           # optional: the settings that differ from the defaults
  run:
    agent_key: coder
```

What the command does, in this order:

1. It checks the whole file: every role exists, each person appears once, the configuration is valid.
2. It looks up the numeric GitHub account ID of each login and shows login and ID. Check each ID: the platform matches people by this ID only, never by the login. An unknown login or a bot account refuses the file. A person already linked to another GitHub ID is refused too: unlink the old account first.
3. It checks separation of duties against the file **and** the roles people already hold on the project: Person A and Person B are never the same person (rule M21), and neither are the other pairs of `access.conflicting_roles`.
4. It shows each change: what it creates, and what has changed from the old value to the new one. With `--dry-run` it stops here. Otherwise you type `yes` (or pass `--yes` in a script).
5. It makes each change with the same API call as the manual command above, so the audit log is the same. It passes the configuration version itself.

A refused file writes nothing. Running the same file again changes nothing. If a change fails part-way, fix the cause and run the same file again: the command skips what is done.

On a new server, `pnpm server:setup` can run this command for the operator, with the file named in its settings (`project_file`) and the sandbox image added as `sandbox.image` (task V19; `platform/deploy/README.md`, "Fresh deployment"). It shows the GitHub IDs the same way and changes nothing until the operator confirms them. It also creates the tenant and its first admin, and can write the project AI record on behalf of Person A from its settings. Everything in the list below stays with people there too.

What the command never does, because it belongs to a person:

- It never revokes a role. A role the file does not list is shown and kept; revoke it with `adlc admin role revoke`.
- It never changes a registered agent. A difference is shown; an agent change needs `adlc admin agent update` with a new version and new approvals.
- It never approves the agent, never writes the project AI record and never issues a token.
- It never gives you a role: nobody gives a role to themselves. Ask another admin.

At the end it prints, per person, the commands that are still theirs: first tokens (`adlc admin token issue`), the agent approvals of the owner and Person B, and the project AI record by Person A. For GitHub Enterprise Server, set `SDLC_GITHUB_API_URL` (for example `https://github.example.com/api/v3`).

**Other admin commands.**

| Command | Does |
|---|---|
| `adlc admin project list`, `show`, `update`, `archive` | An archived project takes no new roles or configuration. An archive is refused while the project has open intents (`project_has_open_intents`): finish or cancel them first. About 7 days after the archive the platform deletes the project's evidence files, except held ones (below). There is no un-archive command |
| `adlc admin evidence hold <INT-…> [--ref <https link>]`, `release <INT-…>`, `show <INT-…>` | Puts an intent's evidence on hold: the platform keeps its evidence files until the hold is released, also past the retention and after an archive. For a dispute, an incident or a client request. Tenant admins, or the roles in `access.evidence_hold_roles` (by default governance and admin; never viewer). Write the reason where it can be edited and give its link with `--ref`: the platform keeps no text |
| `adlc admin user list`, `show`, `update`, `disable`, `enable --user <id or email>` | A disabled person's tokens stop working at once |
| `adlc admin user sign-out --user <id or email>` | Ends every dashboard session of the person, in every browser (§19.8e) |
| `adlc admin passkey list --user <id or email> [--all]`, `revoke --user <id or email> --id <passkey-id>` | A person's dashboard passkeys; remove one, for example after a device was lost (§19.8e). `--all` also shows removed ones. People add passkeys in the dashboard only |
| `adlc admin identity list --user <id or email> [--all]`, `unlink --user <id or email> --id <identity ID>` | `--all` also shows unlinked accounts |
| `adlc admin role list --project <slug> [--all]`, `revoke --project <slug> --id <role ID>` | `--all` also shows revoked roles |
| `adlc admin tenant-admin grant --user <id or email>`, `list [--all]`, `revoke --id <ID>` | Tenant admins only |
| `adlc admin token issue --user <id or email> --name <name> [--days <1-7>]` | A first API token for a new person, shown once. It lasts at most 7 days: the person creates their own API token and revokes this one |
| `adlc admin token list\|revoke --user <id or email> …` | Anyone's API tokens, for example after a laptop was lost |
| `adlc admin agent …` | The agent register, Chapter 20 §20.5b |
| `adlc audit verify` | Checks your tenant's audit log (exit code 1 when a record was changed) |

**Operator commands on the server.** The platform operator keeps a few commands that work straight on the database, for the first person of a tenant and for when the API is down: `adlc ops bootstrap`, `adlc ops token …`, `adlc ops audit verify`, `adlc ops tenant-admin …`, `adlc ops role grant|revoke` (for a team with only one admin), `adlc ops ai-record …`, `adlc ops agent show|list|suspend|quarantine`, and `adlc ops retention report --tenant <slug>` (counts only: per project, the evidence files stored, due for deletion, held, purged; runbook T11 §5j). `adlc ops eval start --tenant <slug> --project <slug> --config <file> --budget <USD> [--n <runs>]` queues an evaluation: the platform runs agent configurations on a fixed task set through the deployed runner and keeps numbers and codes per tenant (deployment README "Evaluations on the server"; it prints the evaluation code and the counts only, and is recorded in the audit log as done by the platform; reading the results by command comes with a later task). **Client data deletion** (two-person rule): after a tenant admin runs `adlc client request-data-deletion`, the operator runs `adlc ops client-data-deletion approve --tenant <slug> --operator <user-uuid>` where `--operator` is a user in that tenant who is **not** the requester; then `list` and `status --tenant <slug>` follow the request. The tenant becomes `pending_deletion` and the worker purges after `SDLC_CLIENT_DELETION_GRACE_DAYS` (default 14); the tenant admin may still `adlc client cancel-data-deletion` during that grace period. They are recorded in the audit log as done by the platform.

**The daily audit anchor.** Once a day the platform copies the latest hash of your tenant's audit log to storage that nobody can change or delete for two years, and checks the earlier copies against the log. `adlc audit verify` finds a changed record; the daily check also finds a log that was rewritten as a whole. A difference appears in your audit log as `audit.anchor_mismatch`, and the operator follows runbook T11 §5k.

**How long evidence is kept.** Evidence files (the agent's changes, the Evidence Packs) are kept `retention.evidence_retention_days` after the intent ends: 180 days by default, never less, at most 3650 (mandatory rule M31). The intent's records in the platform (decisions, hashes, the audit log) are never deleted. The platform starts deleting only when the operator turns it on (runbook T11 §5j).

- When the platform is upgraded and its default settings change, it checks every stored project configuration when it starts. A configuration nobody changed is saved again with the new defaults, and the audit log shows it as a change by the platform. A configuration that was changed outside the platform, or that the new defaults make invalid, is not used: the project stops until an admin saves a configuration again.

## 19.8e. Using the platform: the dashboard

> **Platform usage section, owned by Claude Code** (CLAUDE.md "Documentation rules"). Written with task U01, 2026-10-07, and kept in line with the platform code (`design/ADR-M54-read-only-dashboard.md`).

The dashboard shows in one page what the CLI shows one command at a time. With a GitHub sign-in and actions on, you can also decide a gate, stop a run, and acknowledge and decide an escalation there (task U07, below), create an intent with its spec, submit its plan, build an Evidence Pack (task U08), act on evaluation plans, and administer projects, people, agents, AI records and evidence holds (task U09). Comments, reviews and the CLI still work as before (§19.8b, §19.8c). **G7 is never decided in the dashboard**: it is the review and the merge on GitHub.

**Open it.** With team access (task V09), open the team address the operator gives you, for example `https://sdlc.example.internal:8443/dashboard/`, from your own machine; your browser must trust the company's certificate authority. Without it, open `http://127.0.0.1:8090/dashboard/` on the machine that runs the platform (the API's own address; no other port); with GitHub sign-in on there, open `http://localhost:8090/dashboard/` instead: the sign-in works on `localhost`, not on `127.0.0.1`. With team access, the GitHub sign-in works on the team address only. Then sign in one of two ways.

**Sign in with GitHub** (when the operator turned it on: runbook T11 §5n; task U05).

1. Type your tenant's name (for example `acme`) and choose **Sign in with GitHub**.
2. GitHub asks you to confirm the platform's App the first time. Then you are back on the dashboard, signed in.
3. Only an active user whose GitHub account is linked by a tenant admin gets in (`adlc admin identity link`). Every other case shows the same message: **Sign-in with GitHub was refused**. Check the tenant's name, then ask a tenant admin.
4. The platform reads only your GitHub account number and gives up GitHub's access at once: it never acts on GitHub as you.
5. The session ends after **30 minutes without use**, and after **8 hours** at most. A reload keeps it. **Sign out** ends it in this browser; **Sign out everywhere** ends every session you have, in every browser. A tenant admin can sign a person out everywhere: `adlc admin user sign-out --user <id or email>`. Disabling a user or unlinking their GitHub account ends their sessions too.
6. On `http://localhost`, **Safari cannot sign in with GitHub**: WebKit, Safari's engine, keeps no `Secure` cookie there, so the sign-in is refused (tested 2026-10-12). Use Chrome or Firefox on the platform machine; Safari works on the HTTPS team address (team access, task V09). The personal token works in Safari too.

**Sign in with your API token** (always possible).

1. Paste your API token (`sdlc_pat_…`, the one you use for the CLI; create one with `adlc token create`) and choose **Sign in**.
2. The API token stays in the memory of that browser tab only. A reload, closing the tab or **Sign out** forgets it. The dashboard never puts it in the address, in browser storage or in a cookie. **Sign out** does not revoke the API token: `adlc token revoke` does.

With the API token the dashboard only reads: it changes nothing but your own sign-out. The actions below need a GitHub sign-in, actions on, and for decisions a passkey.

**Passkeys** (task U06, when the operator turned actions on: `SDLC_API_DASHBOARD_ACTIONS=on`). A passkey is a key that your device keeps and unlocks with your fingerprint, face or PIN. The dashboard asks for it before each gate or escalation decision you make there, so a stolen session alone cannot decide.

1. Sign in **with GitHub** (the personal token has no passkey screen). The menu then shows **Passkeys**.
2. Within **5 minutes** of signing in, open **Passkeys** and choose **Add a passkey**. Your browser asks your device; confirm with your fingerprint, face or PIN. After 5 minutes the platform refuses: sign out, sign in with GitHub again, and add it at once.
3. Add one on each device you use; at most 10. The list shows when each was added and last used, and the authenticator's model number when the device reports one. The platform keeps only the public part of the key, never a name or a secret.
4. **Remove** a passkey you no longer use (a lost or replaced device): choose **Remove**, then **Remove this passkey**. A tenant admin can list and remove a person's passkeys: `adlc admin passkey list --user <id or email> [--all]`, `adlc admin passkey revoke --user <id or email> --id <passkey-id>`.
5. A passkey belongs to the address you made it on: one made on `http://localhost:8090` does not work on the team address, and the other way round. Add one where you work.
6. Each change the page sends carries a security token of your session and comes from the dashboard's own address; the platform refuses anything else. If a change fails with "did not come from the dashboard page", reload the page.
7. Without a passkey you can still read in the dashboard and decide with the CLI or a comment on GitHub.

**Decisions and actions** (task U07, ADR-M73). They need a GitHub sign-in and actions on. The page sends the same requests as the CLI, and the platform applies the same rules: the dashboard has no rules of its own.

| Action | Where | Confirmed with | Same as |
|---|---|---|---|
| **Approve**, **Reject**, **Request changes** a gate (G1–G6, G8) | An intent, under **Who decides this gate** | Your passkey | `adlc gate approve\|reject\|request-changes` |
| Open the pull request (G7) | An intent at G7 | (review and merge on GitHub) | the GitHub review |
| **Kill run** | An intent, in the runs table, while a run is provisioning or running | A question in the browser | `adlc run kill` |
| **Acknowledge** an escalation | **Escalations** | Nothing more | `adlc escalation ack` |
| **Decide** an escalation | **Escalations** | Your passkey | `adlc escalation decide` |
| Create an intent (**New intent**), and link its spec | **Intents and gates** | Nothing more | `adlc intent create --spec` |
| **Submit plan** | An intent, under **Execution Plan (G3)** | Nothing more | `adlc plan submit` |
| **Build Evidence Pack** | An intent, under **Evidence Packs** | Nothing more | `adlc evidence build` |
| Save the proposal of a High-risk (L1) run | An intent: the page shows the command | (the CLI only) | `adlc evidence proposal` |

1. Before a gate decision, the page shows what you decide on: the hash of the gate's input (the spec, the plan or the diff) and, when there is one, the spec and plan hashes. The decision is bound to that input. If the input changed while you were reading, the platform refuses with "The input to this gate changed while you were reviewing": reload the page and look again.
2. A refused decision shows the same sentence as a refused comment command: for example "You produced this change, so you cannot approve it (separation of duties)", "You do not hold a role that may decide this gate", or "You already approved this: dual approval needs two different people".
3. A reject or a request for changes asks for a reason code. Write the explanation where it can be edited or deleted (a GitHub comment) and give its link as the reason link.
4. A decision made in the dashboard is recorded with the source `web` and your user ID, the same as a decision from the CLI. The platform never records your session or passkey there.
5. A new intent created in the dashboard is a draft, the same as one from `adlc intent create`. To link its spec at once, fill **Spec path in the repository** (a Markdown file on the default branch), and optionally a commit and the spec tool. The page then makes the two calls of `adlc intent create --spec`. If the platform refuses the spec, **the intent stays**: the page says why (for example "The spec cannot be read (cause: missing)") and shows the command to link it again, `adlc spec link`.
6. **Submit plan** sends the plan file `.sdlc/plans/<INT-…>.yaml` as it is on the default branch (§19.8c). With a commit, the file at that commit must be the same as the head. Whoever submits a plan never approves it at G3. A refused file shows why, in the same words as the CLI.
7. **Build Evidence Pack** makes a new version when the recorded data changed; otherwise the page says "Nothing changed since version N" and makes none.
8. The proposal of a High-risk (L1) run is never downloaded in the browser: the page shows the command, for example `adlc evidence proposal INT-2026-0010 --run <run ID> --output <file>`. The CLI checks the file's SHA-256 and writes it with mode 600.
9. Who may do each action comes from the project's roles, the same as for the CLI (by default only Person A creates intents, links specs and submits plans; Person A, Person B, PM / BrSE, governance and admin build packs; never a viewer). A refusal says which role list decides, for example `access.plan_submit_roles`.

**Administration** (task U09, ADR-M73). Open **Admin**. It needs a GitHub sign-in and actions on to change anything; with an API token it only reads. **Every change asks for your passkey**, including the fast ones (suspend an agent, disable a person): the CLI with your token stays the quickest way to contain a problem. The platform applies the same rules as the CLI and shows its refusals in the same words.

| Action | Where | Who (the platform decides) | Same as |
|---|---|---|---|
| Create a project, change its details, **Archive** it (refused while it has an open intent) | **Admin**, then a project | Tenant admins | `adlc admin project create\|update\|archive` |
| **Give a role**, **Revoke** a role | A project, under **Project roles** | Tenant admins, the project's `admin` | `adlc admin role grant\|revoke` |
| Upload a project configuration | A project, **Configuration** | Tenant admins, the project's `admin` | `adlc admin config set` |
| **Add a person**, change their name or address, **Disable**, **Enable**, **Sign out everywhere** | **Admin**, then a person | Tenant admins | `adlc admin user create\|update\|disable\|enable\|sign-out` |
| **Link a GitHub account** (by its numeric ID), **Unlink** | A person, under **GitHub accounts** | Tenant admins | `adlc admin identity link\|unlink` |
| **Remove** a person's passkey (a lost device) | A person, under **Passkeys** | Tenant admins | `adlc admin passkey revoke` |
| **Make a tenant admin**, **Remove** one | **Admin**, under **Tenant admins** | Tenant admins | `adlc admin tenant-admin grant\|revoke` |
| **Register an agent**, **New version**, **Approve**, **Suspend**, **Quarantine**, **Change owner**, **Recertify** | **Admin**, **Agents** | The approvers of Chapter 20 (owner, Person A, Person B, governance); tenant admins register | `adlc admin agent …` |
| Create or change the project **AI record** | A project, under **AI record** | `access.ai_record_write_roles` (by default Person A and PM / BrSE) | `adlc ai-record set` |
| **Hold the evidence** of an intent, **Release** it | An intent, **Evidence hold** (or **Admin**, by the intent's code) | Tenant admins, `access.evidence_hold_roles` | `adlc admin evidence hold\|release` |

1. Nobody gives a role to themselves or disables themselves, a person never holds two roles that conflict on a project (for example Person A and Person B), and the last tenant admin is never removed. The page shows the platform's sentence, for example "Nobody grants a role to themselves or disables themselves".
2. A GitHub account is linked by its **numeric account ID**, never by the login alone: `https://api.github.com/users/<login>` shows it as `id`. The page refuses a login in the ID field before it asks for your passkey.
3. **Configuration:** the page shows the stored YAML and its version. Choose a file: the page reads it in your browser and shows the **line difference** to the stored version (removed lines with −, added lines with +). Nothing is sent until you choose **Save this version** and confirm with your passkey. If someone saved a newer version in between, the platform refuses: reload and look again. A file the platform refuses shows each problem in its words.
4. **Agents:** to register an agent or make a new version, choose its instruction file: the page computes the file's SHA-256 in your browser and sends only the hash, like `--instructions-file` in the CLI. A new version runs only after its activation approvals. Each approval of a round comes from a different person in a different capacity; a second approval by the same person is refused. The platform never suspends or quarantines an agent by itself: a person decides (Chapter 20 §20.9).
5. **AI record** and **evidence holds** hold codes, dates and one `https://` link only: write the words where they can be edited or deleted (the human record of template T7, a ticket) and give the link.
6. API tokens are never shown or created in the browser: use `adlc token create` or `adlc admin token issue`.

Never publish the API's port 8090 to other machines. People on other machines use team access, the operator's TLS proxy on one LAN port (`platform/deploy/README.md`, "Team access").

**What you see.** The same access rules as the CLI apply: you see the projects you have a role on, and a section your role cannot read says so.

| Screen | What it shows | Same as |
|---|---|---|
| **Intents and gates** | The open intents, one row per gate, the longest wait first. Each card shows how long the intent has waited at its gate, the links to its issue and pull request, and two marks: **past deadline** (an overdue escalation) and **frozen** (an escalation freezes the intent). **Finished** lists the closed intents. **Search intents** (X08a) finds past work: words, an intent code or `#number`, and the filters gate, risk, Evidence Pack sealed or not, created and closed days. The matches show as one list, open and finished alike; the search is part of the address, so you can share it. **Clear the search** goes back to the board | `adlc intent list` with `--search` and the filters ("Finding past intents" above) |
| **An intent** | Where it stands on G1–G8; **who decides this gate** (the oversight mode, the approver roles and how many approvals, as the workflow resolves it); its decisions, runs, open escalations and Evidence Packs, with the pack files to download | `adlc intent show`, `adlc run list`, `adlc evidence list\|export` |
| **Escalations** | Open and acknowledged escalations, the nearest deadline first: severity, route, the role that holds the current step, the acknowledge or resolve clock | `adlc escalation list` |
| **Cost and gate times** | Per project (or the whole tenant, for tenant admins): how long each gate waits for people (average, 90th percentile, longest, waiting now), and the model cost by intent, model or run status, with the wasted part | `adlc metrics gates`, `adlc cost report` |
| **Audit check** | Tenant admins only: checks the tenant's audit chain, on request | `adlc audit verify` |
| **Passkeys** | With a GitHub sign-in and actions on: your passkeys; add and remove them | `adlc admin passkey list` (tenant admins, for a person) |
| **Admin** | Projects, their roles, configuration and AI record; people, their GitHub accounts and passkeys; tenant admins; the agent register; evidence holds. What you see follows your roles | `adlc admin …`, `adlc ai-record show` |

**"Who decides this gate" and "what holds it".** "Who decides this gate" names the people (or the platform) that decide the gate. **What holds it** shows why the platform keeps the intent where it is, as the workflow recorded it the last time it looked: a failed G4 check and which one, a plan to submit again, a spec that cannot be read, a frozen intent, CI still running, a HOTL block window and when it closes. The board shows it on the card as **held**. A plain wait for a person's decision is not a hold. The same reason is printed by `adlc intent show`.

**Evaluations** (task L05). Pick a project to see its evaluation plans and latest evaluations. With a role in `access.eval_roles`, a GitHub sign-in and actions on, you create a plan (the same fields as the plan file of §19.8c; a prompt variant is a path on the default branch, never text), change it (a new version), archive it (asked twice), and press **Run now**. Run now is always confirmed with your passkey; so is a plan that runs on a schedule or on a change, or a higher budget. One evaluation's screen shows its runs by status, what it spent of its budget, and its **report** (task L06), read-only and the same as `adlc eval report`. Each rate comes with its 95% interval: a wide interval means few tasks. Two configurations are called different only when McNemar's test and the intervals both show it; otherwise the report says "no difference found on N tasks", which is not the same as "as good as". The recommendations come from fixed rules and quote the numbers they rest on. They are proposals only: a change of model or prompt still goes through the agent register, as a new version with its approvals. The Evaluations page also lists the evaluations that ended in the last 7 days in your projects (with a role in `access.eval_roles`); `adlc next` without an intent prints the same list.

**Times.** Waiting times are wall-clock time, not working hours. A deadline in the next hour shows in amber, a missed one in red.

## 19.9. Roles and approval points

| What | Who |
|---|---|
| Routing rules per project | Person A proposes; Person B agrees; recorded in the project AI record |
| Backup reviewer | Named by leadership per project |
| Safe list of actions that may continue while waiting | Leadership (Chapter 6 §6.5) |

---

## 19.10. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Reviewers approve quickly to clear the queue | Decision packet; approval time and rejection rate watched; Person B's load shared |
| Stale approvals used for changed work | Binding to version, scope, environment, expiry; re-check before acting |
| Everything classified as "needs approval" | Oversight by risk tier; review the classification monthly |

---

## 19.11. References

**Related documents**
- Handbook: codes table §4; Chapters 4, 5, 6, 8, 17; templates T2, T8.

---

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.0 | 2026-09-24 | — | Skeleton |
| 0.1 | 2026-09-24 | Claude (draft) | First content |
| 0.2 | 2026-09-27 | Claude (task B07, session 2) | §19.8b platform usage: HOTL gates and the block window, gate deadlines and their escalation, no scope at G1–G3 (ADR-M30 §2.4b, §2.9) |
| 0.3 | 2026-10-03 | Claude (task B04) | §19.8c platform usage: the `sdlc` command (login, intents, gates, AI record, exit codes); §19.8b points to it (ADR-M36) |
| 0.4 | 2026-10-03 | Claude (task B13, PR 1) | §19.8d platform usage: setting up a team (tenant admins, projects, people, GitHub accounts, roles, configuration; ADR-M37) |
| 0.5 | 2026-10-03 | Claude (task B13, PR 2) | §19.8c: `sdlc logout` revokes the token; `sdlc token`; first token from a tenant admin. §19.8d: tokens of other people, the agent register, `sdlc audit verify`, the operator commands `sdlc ops` (ADR-M37 §2.8) |
| 0.6 | 2026-10-03 | Claude (task B08) | §19.8c: `sdlc spec link|list`; the spec is the file on the default branch and is checked again at G2–G4 (ADR-M39) |
| 0.7 | 2026-10-03 | Claude (task C08, PR 2) | §19.8: which gates can be decided by comment, G6 included (ADR-M38 §2.7) |
| 0.8 | 2026-10-03 | Claude (task B09, PR 1) | §19.8c: `sdlc plan submit|list|show`; the plan file, its rules, who submits, the re-check at G3–G4 (ADR-M40) |
| 0.9 | 2026-10-03 | Claude (task C11, PR 1) | §19.8b, §19.8c: `/kill` and `sdlc run list|kill` point to Chapter 18 §18.8d (ADR-M42) |
| 0.10 | 2026-10-04 | Claude (task E04) | §19.8c: `sdlc cost report`: who, the range, the grouping, wasted tokens, freshness (ADR-M45) |
| 0.11 | 2026-10-04 | Claude (task E06) | §19.8c: `sdlc metrics gates`: who, the range, first round and after changes, platform passes, intents at the gate now, wall-clock time (ADR-M47) |
| 0.12 | 2026-10-04 | Claude (task E02) | §19.8c: `sdlc evidence build\|list\|show\|export` (ADR-M48) |
| 0.13 | 2026-10-04 | Claude (task B09, PR 2) | §19.8c: plan text fields must be text (`schema_invalid` with the field); the agent reads the task text from the submitted plan file; the recorded commit is the head read (QUESTIONS #169, #210, #212) |
| 0.14 | 2026-10-04 | Claude (task E03) | §19.8b: G7 and G8 by comment; §19.8c: `sdlc gate approve\|reject G8`, the release SHA-256 in `sdlc evidence show` (ADR-M49) |
| 0.15 | 2026-10-04 | Claude (task C12) | §19.8c: freshness: spend is copied every few minutes and when a run ends (ADR-M24 §2.5) |
| 0.16 | 2026-10-04 | Claude (task E05, PR 1) | §19.8d: archive refused with open intents and evidence deleted after a grace period, `sdlc admin evidence hold\|release\|show`, `sdlc ops retention report`, how long evidence is kept (ADR-M51) |
| 0.17 | 2026-10-04 | Claude (task E05, PR 2) | §19.8d: the daily audit anchor and `audit.anchor_mismatch` (ADR-M51 §2.9) |
| 0.18 | 2026-10-07 | Claude (task U01) | §19.8e: the read-only dashboard (ADR-M54) |
| 0.19 | 2026-10-07 | Claude (task U02) | §19.8c, §19.8e: what holds an intent (`sdlc intent show`, the dashboard; ADR-M54 §2.4b) |
| 0.20 | 2026-10-08 | Claude (task S01) | §19.8c: G2 needs acceptance criteria; the spec structures by tool (ADR-M61) |
| 0.21 | 2026-10-08 | Claude (task S02) | §19.8c: `sdlc plan draft` from a Spec Kit `tasks.md` or a BMAD story file (ADR-M62) |
| 0.22 | 2026-10-08 | Claude (docs fix PR A) | §19.8b: a HOTL G2 also needs an acceptance criterion; §19.8d: `sdlc admin identity list --user <id or email>` |
| 0.23 | 2026-10-09 | Claude (docs review PR C) | One source per topic: §19.8c holds the G2 condition (acceptance criteria) and the CLI exit codes (exit code 2 also for an HTTP 400); §19.8d the conflicting roles and their defaults; §19.8b links to them and to Ch.15 for producers; the overdue escalation at every gate that waits for a person (route `intent` or `technical`); the gate times report is `sdlc metrics gates` |
| 0.28 | 2026-10-09 | Claude (task C13) | §19.8c: `sdlc evidence proposal` |
| 0.29 | 2026-10-09 | Claude (task V01, PR 2) | §19.8c: `sdlc trial report`, the anonymous report of the community trial (ADR-M65) |
| 0.27 | 2026-10-09 | Claude (task U03) | §19.8c: `sdlc intent create --spec` creates the intent and links its spec in one command |
| 0.31 | 2026-10-10 | Claude (task V06) | §19.8c: `sdlc next <INT>` |
| 0.32 | 2026-10-12 | Claude (task V07, PR 1) | §19.8c: `sdlc doctor`, the check of your login and the API |
| 0.33 | 2026-10-12 | Claude (task U05) | §19.8e: sign in to the dashboard with GitHub, the session, sign out, sign out everywhere, `sdlc admin user sign-out` (ADR-M73 §2.2) |
| 0.30 | 2026-10-10 | Claude (task V05) | §19.8c: install the `sdlc` command from npm (`agentic-sdlc-cli`), `sdlc --version` |
| 0.34 | 2026-10-12 | Claude (task V09, PR 2) | §19.8c, §19.8e: the team address through the TLS proxy, `NODE_EXTRA_CA_CERTS` with the operator's `ca.pem`, the dashboard and the GitHub sign-in on the team address, Safari there |
| 0.36 | 2026-10-12 | Claude (docs review for v0.2.0) | §19.8d: `sdlc admin user sign-out` and `sdlc admin passkey list\|revoke` in the admin table; §19.8e: never publish port 8090, other machines use team access |
| 0.35 | 2026-10-12 | Claude (task U06, PR 2) | §19.8e: passkeys in the dashboard (add within 5 minutes of a GitHub sign-in, remove, `sdlc admin passkey`), the session's security token on each change; decisions still to come (ADR-M73 §2.3, §2.4) |
| 0.37 | 2026-10-12 | Claude (task V13) | §19.8c: `sdlc metrics agents`: who (a role in both the cost and the metrics lists), the range, the run, quality and cost measures, the model of a run (ADR-M79) |
| 0.38 | 2026-10-13 | Claude (task V13) | §19.8c: a run's model comes from the run event `model_selected`, with the cost records as the fallback for older runs (QUESTIONS #434) |
| 0.39 | 2026-10-13 | Claude (task V10) | §19.8c: `sdlc help`, `--help`, the next-step line and what to do after a failure |
| 0.40 | 2026-10-14 | Claude (task L04) | §19.8d: the operator command `sdlc ops eval start` (ADR-M81) |
| 0.41 | 2026-10-15 | Claude (task L05) | §19.8c: `sdlc eval plan|run|list|show`, the plan file, budgets and refusals; §19.8e: the dashboard's evaluation screens and its only business actions, confirmed with a passkey (ADR-M82) |
| 0.42 | 2026-10-16 | Claude (task L06) | §19.8c: `sdlc eval report`; §19.8e: the evaluation report in the dashboard and the list of evaluations that ended in the last 7 days (ADR-M83) |
| 0.43 | 2026-10-20 | Claude (task L07) | §19.8c: a project's own task set: `sdlc eval task draft\|register\|list\|approve\|reject`, the check on the server, the review, plans on the task set `project` (ADR-M85) |
| 0.44 | 2026-10-20 | Claude (task L09, PR 1) | §19.8c: a plan configuration may name a `proposed` or `suspended` agent of the register; the agent gets its own tools in the runs (ADR-M86 §2.2, QUESTIONS #501) |
| 0.45 | 2026-10-22 | Claude (task X04, PR 1) | §19.8c: the plan lists register tools as `tool:<key>`; G4 fails with `tool_not_runnable` when the run cannot have one (ADR-M69 §2.1, §2.3) |
| 0.46 | 2026-10-28 | Claude (task V17) | §19.8d: set up a project from one file, `sdlc admin project apply` (QUESTIONS #617) |
| 0.47 | 2026-10-29 | Claude (task U07) | §19.8e: decide a gate, kill a run, acknowledge and decide an escalation, and create an intent in the dashboard; the passkey before each decision; refusals in the words of the comment replies (ADR-M73) |
| 0.48 | 2026-10-29 | Claude (task U08) | §19.8e: create an intent and link its spec, submit the plan, build an Evidence Pack in the dashboard; a refused link keeps the intent; the L1 proposal command (ADR-M73) |
| 0.49 | 2026-10-29 | Claude (docs, newcomer review) | §19.8d: a link to the commented example `platform/deploy/project.example.yaml` |
| 0.50 | 2026-10-30 | Claude (v0.10.0, ADR-M100) | §19.8c: the old command `sdlc` is removed in v0.10.0; `adlc` still reads its login |
| 0.52 | 2026-11-12 | Claude (task O06, PR 2a) | §19.8d: a project can be one folder of a monorepo (`--folder`, `folder:` in the project file, `repo_path_overlap`; ADR-M106 §2.4) |
| 0.53 | 2026-11-12 | Claude (task U09) | §19.8d, §19.8e: the dashboard's **Admin** screen: projects, roles, configuration with its line difference, people and GitHub accounts, passkeys, tenant admins, the agent register, the AI record and evidence holds, each change with a passkey (ADR-M73 1.9) |
| 0.55 | 2026-11-14 | Claude Code (task X08b, PR 1 and PR 2) | §19.8b: `/lesson`; §19.8c: `adlc lesson add\|apply\|drop\|issue`, `adlc lessons list`, `adlc metrics lessons`, `--from-lesson`, `--has-lessons` (ADR-M109 0.4) |
| 0.54 | 2026-11-12 | Claude Code (task V14) | §19.8c: `adlc intent estimate` and the column "Lead / estimate" of the agent report (ADR-M79 §2.6) |
| 0.51 | 2026-11-12 | Claude (task V19) | §19.8d: `pnpm server:setup` can run `adlc admin project apply` with the file of its settings; what stays with people is the same |
| 0.26 | 2026-10-09 | Claude (docs review E2) | §19.8d points to the set-up order of the deployment guide |
| 0.25 | 2026-10-09 | Claude (docs review fixes) | §19.8b: what reject and request-changes do at G5–G7; the HOTL gates with a block window besides G2 and G3 |
| 0.24 | 2026-10-09 | Claude (docs review PR C2) | §19.8c: what counts as one acceptance criterion for Spec Kit and BMAD (each top-level list item; ROLLOUT-GUIDE said "every Given / When / Then item"); anchors for linking a spec, the plan file, plan drafts, the cost report, the gate times, the block window and the AI record |
