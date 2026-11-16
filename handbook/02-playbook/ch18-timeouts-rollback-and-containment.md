# Chapter 18. Timeouts, rollback and containment

> Readers: **developers, Person A, Person B**, operators · Reading time: about 15 minutes
> Status: **Draft 0.3**, awaiting Harry's comments. §18.8b, §18.8c, §18.8d and §18.8e (platform usage) are owned by Claude Code.

---

## 18.1. Purpose

- Stop runaway agents early.
- When something goes wrong, **take the agent's power away first**, then recover safely.
- Never make things worse by rolling back blindly.

## 18.2. Scope

Agent runs (P3), releases (P5) and production operations (P6). Escalation and "nobody answers" rules are in Chapter 6; this chapter covers what happens to the **system**.

---

## 18.3. Three kinds of limit

| Limit | Applies to | When reached |
|---|---|---|
| **Run limits** | One agent run: iterations, retries, tool calls, delegation depth, parallel agents, cost, time, "no progress" window, repeated identical actions | Stop the run; keep its state; classify as stalled or over budget; Person A decides (G5) |
| **Approval timeouts** | Human gates and escalations | Chapter 6 §6.5: reminder → backup → leadership; the agent stays frozen |
| **Critical timeout** | A situation that must be resolved within a fixed time (for example an incident, a canary breaching thresholds, an unanswered Critical escalation) | The recovery sequence in 18.4 |

Default run limits are set per project (Chapter 8 §8.9, task plan T13). A run that repeats itself **without making progress** is stopped even if it is under budget.

---

## 18.4. Recovery sequence after a critical timeout

```text
1. Freeze the agent and block new actions
2. Revoke its temporary credentials (always, if security may be involved)
3. Preserve evidence
4. Identify the last known good version
5. Check the rollback is safe (pre-checks)
6. Roll back, or contain
7. Verify: artifact, runtime, business
8. Recovered → the agent stays paused until a person reviews
   Failed    → contain and open an incident
```

**The agent loses the power to act first; an independent controller or a person decides on rollback.**

### Preserve evidence before changing anything

Keep: the current and target versions, the agent's actions and tool calls, policy decisions, alerts, configuration, traffic state, credential events. **Never delete logs or overwrite an artifact under investigation.** Rollback restores service; it must not hide the cause.

### Last known good version

Do not roll back to "the previous version" by habit. Choose the last version that:
- passed its required tests;
- ran stably for a minimum time;
- has a verified identity (commit, digest);
- is compatible with the current data schema and dependencies;
- has a tested rollback path;
- was not itself marked faulty.

If no such version exists → **contain** instead of guessing.

### Pre-checks

- The target version exists and matches its digest.
- The environment is the right one.
- No incompatible database migration is in the way.
- The target's dependencies and configuration are still available.
- There is capacity to run it.
- Rolling back will not lose or corrupt valid new data.
- No person has locked the system for an incident.

---

## 18.5. Kinds of rollback

| Kind | Example |
|---|---|
| Code rollback | Redeploy the previous build |
| Configuration rollback | Restore the previous config |
| Traffic rollback | Move traffic back from the canary / new version |
| Schema rollback | Only with a tested backward migration |
| Data restore | From backup — a human decision |
| Compensating action | Undo an external effect with a new action (for example a correcting entry) |
| Forward fix | Fix forward when going back is unsafe |
| Containment | Stop traffic, isolate the workload, keep a safe state |

**Not everything can be rolled back.** One-way migrations and external side effects need a forward fix, reconciliation or compensation, planned **before** release (Chapter 12, ADR rollback strategy).

---

## 18.6. Never roll back automatically when

- no version is confirmed as safe;
- the data schema changed incompatibly;
- data corruption is suspected;
- a compromise or supply-chain attack is suspected;
- rollback could lose valid new data;
- the previous version has also been withdrawn;
- the system has external effects that cannot be undone.

In these cases the automatic actions are only: **pause, revoke, isolate, preserve evidence**. A person (incident commander) decides the recovery.

---

## 18.7. Verifying the recovery

Recovery counts as successful only when all three layers pass, over a **stabilisation window** (a few minutes or a minimum number of requests):

| Layer | Check |
|---|---|
| Artifact | The right version, digest and configuration are running |
| Runtime | Healthy; no crash loop; error rate and latency stable |
| Business | Transactions, data, queues and business rules are correct |

If recovery fails: stay frozen → isolate the faulty workload → remove execution rights → hand over to the incident commander → preserve evidence → manual recovery or forward fix. **Do not keep trying different versions automatically**; each attempt widens the damage and makes investigation harder.

---

## 18.8. Before the platform

Until the platform automates this, each project with a production system keeps a **short recovery runbook** (one page):
- how to stop any running agent and revoke its tokens;
- how to find the last known good version;
- the rollback command(s) and who may run them;
- who is incident commander by severity;
- the client's contact for incidents.

Reviewed at Sprint 0 (Chapter 10 §10.7) and after every incident. Every project with a production system must have one (decision: Harry, 2026-09-24).

---

## 18.8b. Using the platform: escalations, `/ack` and `/decide`

> **Platform usage section, owned by Claude Code** (CLAUDE.md "Documentation rules"). Written with task B11, 2026-09-27, and kept in line with the platform code (`design/ADR-M28-escalations.md`). The rest of this chapter is Draft 0.2 and is written outside Claude Code.

The platform raises an escalation when a run or a gate needs a decision from a person with independent authority (Chapter 6 §6.4). For example, it raises one when a run breaks its budget or its file scope at G5, when a gate is overdue, or when a run is stopped. Each escalation has a code such as `ESC-2026-0001`.

**What happens when an escalation is raised.**

- The platform posts a notice on the intent's GitHub issue. The notice mentions the people who must act, and it states the deadlines in UTC.
- Who receives it first depends on the kind of problem:

  | Route | Owner | Backup |
  |---|---|---|
  | Intent or business scope | Person A | Person B |
  | Code, tests, architecture | Person B | Second approver |
  | Security, data, permissions | Person B | Second approver |
  | Policy or autonomy | Governance | none |

- The producer of the change is never chosen: authority never passes back to them.
- A Critical escalation also tells governance at once. High tells governance, Person A and Person B. Medium tells Person A and Person B. Low tells Person A.
- **The work is frozen** while the escalation is open, if its response level is Pause, Contain or Incident. At Observe and Notify, the work is frozen once the acknowledge deadline is missed.
  - Frozen means that only safe actions continue: read-only work, tests in the sandbox, unpublished drafts, collecting metrics (project setting `escalation.safe_actions`).
  - Stopping a run and revoking its credentials are always possible.
- **An overdue gate** (Chapter 19 §19.8b) raises a Medium escalation at level Notify by default (project setting `oversight.gate_overdue`). The platform closes it itself when the gate is decided.
- **Two clocks run** (Chapter 6 §6.4 SLA): acknowledge, and resolve.
  - If nobody acknowledges, the platform reminds the escalation owner at 75 % of the acknowledge time.
  - Then it moves the escalation to the backup owner, then to governance, with a new acknowledge time at each step.
  - If nobody decides by the resolve deadline, governance takes over. For Critical, the incident process is due (Chapter 6 §6.7).
  - No answer never means "go ahead".

**Commands.** Write the command on the **first line of a new comment** on the intent's issue. You can leave out the escalation code when the intent has only one escalation that is not decided yet.

| Command | Does |
|---|---|
| `/ack ESC-2026-0001` | Acknowledges the escalation: "I have it". The acknowledge clock stops; the resolve clock keeps running. Nothing may follow the code on that line |
| `/decide ESC-2026-0001 resume` | Decides to continue as before. It never raises the budget |
| `/decide ESC-2026-0001 modify` | Decides that the plan or the work must change first |
| `/decide ESC-2026-0001 roll-back` | Decides to roll back |
| `/decide ESC-2026-0001 terminate` | Decides to stop this work |
| `/decide ESC-2026-0001 escalate` | Hands the escalation to governance (not possible for governance itself) |

- After the decision you may add a reason code and a sentence, for example `/decide ESC-2026-0001 resume budget_exceeded The estimate was too low`.
- The sentence stays in your comment. The platform stores only codes and a link to the comment, because escalations are kept for at least 2 years (Chapter 3 §3.9.3).
- The CLI does the same through the API (log in first, Chapter 19 §19.8c):

  | Command | Does |
  |---|---|
  | `adlc escalation list [--intent INT-…] [--status open\|acknowledged\|resolved\|closed]` | Lists the escalations of the intents you can read |
  | `adlc escalation show ESC-2026-0001` | Shows one escalation: clocks, owners, decision |
  | `adlc escalation ack ESC-2026-0001` | Same as `/ack` |
  | `adlc escalation decide ESC-2026-0001 <resume\|modify\|roll-back\|terminate\|escalate> [--reason-code <code>] [--reason-ref <https://…>]` | Same as `/decide` |
  | `… decide … resume --actions run_start,budget_increase --budget-increase-usd 2.5` | Names the actions the decision allows; a budget increase only this way (comments never raise a budget) |

  The API behind it: `GET /v1/escalations[/<code>]`, `POST /v1/escalations/<code>/ack`, `POST /v1/escalations/<code>/decisions`.

**Who may act.**

- The escalation owner may act at any time.
- The backup owner may act once the escalation has reached the backup step.
- Governance may act at any time.
- A producer of the change never acts, and neither do bots.
- Your GitHub account must be linked to your platform user (by its numeric account ID, as for gate commands, §19.8b).

**What a decision allows** (Chapter 6 §6.6).

- A decision is bound to the version that was reviewed, to the actions it allows, and to an expiry (project setting `oversight.approval_expiry`, 7 days by default).
  - `resume` allows the run to continue or start again, and the next gate.
  - **More budget** is allowed only when the decision names it with an amount, through the API or the CLI (`budget_increase` in `actions`, with `budget_increase_usd`). The amount is recorded in the decision and in the audit log. A comment never raises a budget.
  - `modify` allows moving through the gates again.
  - `roll-back` and `terminate` allow no protected action.
- Just before acting, the platform checks the decision again. If the decision has expired, or the plan or input changed, the decision is voided and the escalation waits for a new decision.
- The platform closes the escalation after it has acted on the decision.

**After a failed or killed run** (task B09 PR 2, QUESTIONS #211). A run that failed (the agent reported an error, the runner was lost, the platform could not check its changes or read its plan file), or that someone stopped with the kill switch (§18.8d), pauses the intent at G4 with a technical escalation to Person B. The decisions do this:

| Decision | What happens |
|---|---|
| `resume` | The intent goes back to G4; a new run starts after G4 is decided again. Choose it when the cause is gone (for example the runner is back). If the run answered a review's request for changes and that review was withdrawn, the intent goes back to G7 when the pull request still shows the same commit |
| `modify` or `roll-back` | The intent goes back to **G3**. G3 is now HITL at every risk tier, and the earlier G3 approval no longer counts. Change the plan and submit it again (`adlc plan submit`), or approve the same plan again. Choose it when the cause is in the plan, for example when the platform could not read the submitted plan file (`plan_unavailable`) |
| `terminate` | The intent is closed (`cancelled`) |

The issue gets a status comment for each of these (`run_resumed`, `run_returned`, `terminated`).

**A G5 breach: resume with more budget** (Chapter 13 §13.10.5). When a run stopped at its cost limit, Person A can let the next run spend more. Names in `actions` replace the defaults, so name **both** actions:

```http
POST /v1/escalations/ESC-2026-0001/decisions
Content-Type: application/json

{
  "decision": "resume",
  "actions": ["run_start", "budget_increase"],
  "budget_increase_usd": "2.5",
  "reason_code": "budget_exceeded"
}
```

- The CLI does the same: `adlc escalation decide ESC-2026-0001 resume --actions run_start,budget_increase --budget-increase-usd 2.5`.
- The intent budget grows by the amount, and the run budget of the intent's next runs becomes the stopped run's limit plus the amount. Both only go up. The run's real limit is still the smallest of the run budget, what is left of the intent budget and what is left of the tenant's month.
- The intent goes back to G4; the new run starts after G4. A G4 that needs Person A's approval (High risk) shows the new limit in its proposal.
- A decision with `budget_increase` but without `run_start` allows no new run: the intent keeps waiting. Decide again with both actions.

**Answers.** A successful command gets no reply. A command that the platform cannot read or refuses gets a reply that says why. Nothing is recorded in that case.

## 18.8c. Using the platform: logs and traces of a run

> **Platform usage section, owned by Claude Code** (CLAUDE.md "Documentation rules"). Written with task A08, 2026-09-30 (`design/ADR-M35-observability.md`).

Before you change anything after a timeout or a stopped run (§18.4), find what the platform recorded. You need two things: the run's ID (`run_id`, a UUID) and the intent code.

**Logs.** Every platform process (`sdlc-api`, `sdlc-worker`, `sdlc-runner`) writes one JSON line per event. Read them with `docker compose -f platform/deploy/docker-compose.yml --env-file platform/deploy/.env logs <service>`.

- Each line has `time`, `level` and `event` (a code such as `runner.run_ended`).
- Lines about a tenant, an intent or a run also carry `tenant_id`, `intent_id` and `run_id`. Filter on them, for example with `grep '"run_id":"<run_id>"'`.
- A line never holds a token, a key, comment text or client data: only codes, IDs and counts. A field that looks like one of these is dropped, and the line counts it in `dropped_fields`.

**Traces** (optional: Compose profile `observability`, which needs more memory).

- Start the profiles together, for example `platform/deploy/scripts/up.sh core models platform observability`. Then the api, the worker and LiteLLM send traces to Langfuse through the OpenTelemetry Collector. Without the profile, nothing is traced.
- Every model call is one trace in Langfuse, tagged with the seven labels: `tenant:`, `project:`, `intent_id:`, `run_id:`, `gate:`, `agent:`, `data_class:`. In Langfuse, filter the traces by the tag `run_id:<run_id>` to see every model call of a run, with its tokens and cost.
- A log line written inside a traced request or activity also carries `trace_id`: search for it in Langfuse to see the whole request.
- **Langfuse holds the prompts and the model's answers.** They are client data: treat Langfuse like the repository of the client project (Chapter 3). Only people who may see the project's code may have a Langfuse account.

## 18.8d. Using the platform: the kill switch

> **Platform usage section, owned by Claude Code** (CLAUDE.md "Documentation rules"). Written with task C11, 2026-10-03 (`design/ADR-M42-kill-switch.md`).

Use the kill switch when an agent run must stop **now**: it does something it should not, it loops, it spends too fast, or you are not sure. It is step 2 "Contain" of an incident (Chapter 6 §6.7). Stopping a run is never wrong: a person reviews it afterwards.

**How to stop a run.** Any of these:

| Where | Command |
|---|---|
| On the intent's GitHub issue or pull request | A new comment whose first line is `/kill`. You may add the reason after it: `/kill it rewrites the payment module`. The reason stays on GitHub |
| In a terminal | `adlc run kill <INT-…>` (the intent's current run) or `adlc run kill <run ID>`. `adlc run list <INT-…>` shows the runs and their IDs |
| On the server, when nobody with a role can act or the API is down | The operator runs `pnpm adlc ops run kill --tenant <slug> --run <run ID>` (recorded as the system) |

**Who may.** Person A, Person B and governance on the project (project setting `access.kill_roles`; a project may add roles, never remove these three; the viewer never). The person who started the run may stop it too. Your GitHub account must be linked to your platform user (§19.8b): a comment from an account that is not linked stops nothing.

**What happens.**

1. The platform records the kill at once. A run that has not started yet never starts. The run you stopped shows `stopping`, then `stopped_killed`.
2. Within about a second the runner interrupts the agent, then removes the sandbox. The run's model key is revoked. The run's GitHub tokens are already gone: the runner revokes each one right after it used it.
3. The platform keeps what the agent changed as evidence (the run's diff), when it can do so within about a minute. It never delays the stop for it.
4. An **escalation** is raised at once (route technical, severity `high`, level `contain` by default: project setting `run.kill_escalation`). The intent is frozen until a person decides. Person B receives it first; the escalation clocks and the backup chain of §18.8b apply.
5. The issue gets a status comment `run_killed`.

**Afterwards.** Review the run with the escalation (§18.8b): the run's events, its diff, the logs and traces of §18.8c. Then decide:

- `/decide resume` (or `adlc escalation decide … resume`): the intent goes back to G4, and a new run starts after G4 is decided again;
- `/decide modify` or `/decide roll-back`: the intent goes back to G3, HITL (§18.8b, after a failed run);
- `/decide terminate`: the intent is closed (`cancelled`).

**Good to know.**

- Stopping twice is harmless: the second time nothing changes.
- A run that already ended cannot be stopped (`run_not_active`). To stop a push or a pull request at G6, raise or decide an escalation: its freeze stops the push.
- The target is under 5 minutes from your command to everything removed (D-02 FR-34). The platform's own test measures about one second. If the runner itself is down, the run ends after at most 2 minutes, and the sandbox is removed when the runner starts again.

**Loop detection: the platform stops a stuck run by itself** (D-02 FR-35, `design/ADR-M42-kill-switch.md` §2.7). You do not need to watch for these two cases:

| The run's stop reason | What the platform saw | Project setting |
|---|---|---|
| `loop_detected` | The agent made the same tool call (same tool, same arguments) more than 3 times in a row | `run.loop_detection.identical_tool_calls_max` (default 3; never more than 3, rule M10) |
| `no_progress` | The agent's log got no new entry of any kind for the whole window | `run.loop_detection.no_progress_window_minutes` (default 15; never more than 30, rule M27; under 5 gives a warning) |
| `agent_stuck` | OpenHands' own stuck detector stopped the agent (it also counts repeats, with a fixed limit). Agents with the adapter `opencode` never give this reason | none |

The runner interrupts the agent, the run ends `stopped_stalled`, and its diff is checked as for any run. Gate G5 then fails the run (`run_cap_reached`) and raises an escalation to Person A (route intent, level `pause` at least): the intent is frozen until a person decides (§18.8b). If the run was also over its budget in the same moment, the budget wins and the stop reason is `max_budget`.

**Is a `no_progress` stop real?** A command that prints nothing until it ends looks like no progress: the agent sees its output only at the end. To tell the two apart:

1. `adlc run list <INT-…>` shows the stop reason. The run event `loop_detected` gives `idle_minutes`: how long the log was silent.
2. Open the run's last steps in the traces (§18.8c, filter by the run ID):
   - **A false stop:** the agent's last step was a long command that was still working, for example `pnpm install` on a cold package cache, a full test suite or a build. The last model call ended normally and asked for that command.
   - **A real stall:** the last model call never ended or failed again and again, or the agent was waiting with nothing running. The same happens when the model gateway or the package proxy was down: check §18.8c and the platform's health first.
3. For a false stop: decide the escalation with `resume` (a new run after G4). If the same long command will run again, raise the window first. If it was a real stall, find the cause before you resume, or decide `terminate`.

**A run that ends `agent_config_changed`** (agents with the adapter `opencode` only; Chapter 20 §20.5b). The agent changed OpenCode's configuration, its tool list or its list of sessions during the run, for example to raise its own iteration limit. The runner stopped the run, and the run ends `failed`. As for any failed run, the intent is paused at G4 with a technical escalation to Person B (§18.8b). Treat it as a possible attempt to get around the platform's controls:

1. `adlc run list <INT-…>` shows the stop reason. When the run has no event `agent_started`, the stop came before the agent's first step: the repository changed settings the run needs, for example with its own `opencode.json`.
2. Read the run's last steps in the traces (§18.8c, filter by the run ID): which command changed the configuration, and why.
3. If the task or the repository led the agent there (for example a file that tells the agent to change its settings), fix that first. Then decide `resume`, or `modify` to go back to G3.
4. If the cause is not clear, decide `terminate`, and ask the agent owner and Person B to consider suspending or quarantining the agent (Chapter 20 §20.9).

**Raising the window.** It is a project setting, changed by a tenant admin or the project admin (§19.8d):

1. `adlc admin config show --project <slug>` shows the configuration and its version.
2. In the YAML, set for example:

   ```yaml
   run:
     loop_detection:
       no_progress_window_minutes: 25
   ```

3. `adlc admin config set --project <slug> --file <config.yaml> --expected-version <version>`.

The new window applies to runs that start after the change; a run already working keeps the window it started with. The platform refuses more than 30 minutes (rule M27): a run silent for longer is not making progress you can review. Prefer making the long command shorter or louder (for example a warm package cache, or tests split by package) to a longer window.

---

## 18.8e. Using the platform: break-glass

> **Platform usage section, owned by Claude Code** (CLAUDE.md "Documentation rules"). Written with task H08 PR 3a, 2026-11-15 (`design/ADR-M111-break-glass.md`). The policy is Chapter 6 §6.9.

Use break-glass when a **production P0 incident** needs one intent to move faster than the normal rules allow. A grant is short, for one intent, for named scopes, and a second person approves it. It removes only waiting that is not a safety control:

| Scope | What it changes while the grant is active |
|---|---|
| `runner_priority` | The intent's queued runs get the next free runner first. No running run is stopped |
| `budget` | One increase of the intent's run budget, by the amount in the request (at most `break_glass.max_budget_increase_usd`) |
| `hotl_window_skip` | Ends the HOTL objection windows of G2 and G3 at once, so a run may start. A HITL gate still waits for a person |

**What break-glass never changes.** G1, G4, G6, G7 and G8 work as always: a person still merges at G7, the checks of G6 still run, and the policy check of G4, the tool list and the autonomy level stay the same. A frozen intent stays frozen; a kill stays a kill. Agents and bots can never request, approve or revoke a grant. To merge or deploy outside the platform, follow your production break-glass process; the platform records only what it does.

**Who a scope serves.** The grant is not transferable. `runner_priority` puts a run first when you (the operator) allowed it at G4, or when the platform started it by itself; a run that another person allowed waits in the normal queue. `budget` raises the intent's budget once, at the approval; ending the grant never lowers it. `hotl_window_skip` is for the intent: the G2 and G3 windows close while the grant is active.

**The steps.**

1. **Write the reason** as a comment on the intent's GitHub issue or pull request: the incident, what you need and why. The words stay there; the platform keeps only the comment's link.
2. **Request** (Person A or Person B of the project):

   ```text
   adlc break-glass request INT-2026-0042 --scope runner_priority,budget --hours 2 \
     --reason https://github.com/acme/shop/issues/42#issuecomment-123 --budget-increase 20
   ```

   `--hours` is 1 to `break_glass.max_hours` (default 4, never more than 8). One request at a time per intent. A request nobody approves within `break_glass.request_ttl_minutes` (default 30) lapses.
3. **Approve or refuse** (governance or Person B of the project; never the person who requested it, and never a person who produced the intent's change): `adlc break-glass approve INT-2026-0042` or `adlc break-glass refuse INT-2026-0042`.
4. On approval the grant is active until its expiry, and the platform opens a **Critical escalation** as the incident (route `policy`, so governance receives it; codes table §6.3: 15 minutes to acknowledge). It does not freeze the intent. `adlc break-glass list --open` shows the incident code and the expiry.
5. **The grant ends** at its expiry by itself (the worker checks every minute; the grant has no effect after its expiry even before that). **Revoke** it earlier as soon as it is not needed: `adlc break-glass revoke INT-2026-0042`. The operator, the approver, Person B or governance may revoke, at once and alone. When the API is down, the server operator runs `pnpm adlc ops break-glass revoke --tenant <slug> --intent <INT-…>` (recorded as the system).
6. **Review** within `break_glass.review_due_hours` (default 48) after the grant ended: hold the blameless review of Chapter 6 §6.7 step 5, write it as a comment on the intent's issue or pull request, then record its link (Person A or Person B): `adlc break-glass review INT-2026-0042 --comment <comment URL>`. This closes the incident escalation. **G8 waits** for it: an intent whose grant is active, or ended without its review, is not released even after its G8 approval (`adlc next` shows `break_glass_review`). When the review is late, the platform comments on the intent's issue for Person A, Person B and governance (`break_glass.review_overdue` in the audit log).

**What the platform keeps.** Codes, IDs, times and the two comment links. The audit log records `break_glass.requested`, `approved`, `refused`, `revoked`, `expired`, `lapsed`, `reviewed` and `review_overdue` with codes and IDs only.

**Settings** (project configuration, `break_glass`): `enabled`, `allowed_scopes`, `max_hours`, `request_ttl_minutes`, `max_budget_increase_usd`, `review_due_hours`. A project that keeps break-glass on must allow at least one scope (rule M37).

| Refusal (`reason`) | Meaning |
|---|---|
| `same_person` | The requester tried to approve. Ask a second person |
| `producer` | The approver produced the intent's change. Ask governance or another Person B |
| `scope_invalid`, `duration_invalid`, `budget_invalid` | The scopes, hours or amount are outside the project's settings |
| `comment_invalid`, `comment_not_found`, `comment_not_on_intent` | The link is not an existing comment on the intent's issue or pull request |
| `already_open`, `no_grant`, `lapsed`, `nothing_to_review` | The grant is not in the state the step needs |

---

## 18.9. Drills and metrics

Drill **once per release cycle** for systems with High or Critical risk (decision: Harry, 2026-09-24). Scenarios:
- timeout before deployment; timeout while moving traffic;
- the controller failing in the middle of a rollback;
- missing target version; invalid signature or digest;
- incompatible database migration;
- a health check that falsely reports success;
- rollback that succeeds technically but breaks a business rule;
- two rollbacks at the same time on the same environment.

Track:
- time from timeout to freeze; time to complete rollback;
- rollback success rate; wrong-version rollbacks; repeated rollbacks;
- share of cases that needed manual recovery; data loss and downtime.

---

## 18.10. Roles and approval points

| What | Who |
|---|---|
| Stopping an agent or a run | Person A, Person B, leadership, or the platform automatically |
| Automatic rollback | Only where pre-approved, tested and allowed by 18.6 |
| Any other rollback, data restore, forward fix | Incident commander (Person B; leadership for Critical) |
| Resuming a frozen agent | Person B, after review (Chapter 6 §6.6) |

---

## 18.11. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Rollback destroys new data | Pre-checks; no automatic rollback in the 18.6 cases |
| Evidence lost during recovery | Preserve evidence first; never overwrite artifacts under investigation |
| Endless automatic retries | Retry limits; stop and hand to a person |
| Nobody knows how to roll back | Recovery runbook per project; drills |

---

## 18.12. References

**Related documents**
- Handbook: Chapters 3, 4, 6, 8, 12, 13, 15, 16; templates T13, T14.
- `design/D-03` (run limits, runner).

---

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.0 | 2026-09-24 | — | Skeleton |
| 0.1 | 2026-09-24 | Claude (draft) | First content |
| 0.2 | 2026-09-24 | Claude (draft) | Recovery runbook per project; drills each release cycle for High+ systems (Harry) |
| 0.3 | 2026-09-27 | Claude (task B11) | §18.8b platform usage: escalations, `/ack`, `/decide`, freeze, clocks (ADR-M28) |
| 0.4 | 2026-09-27 | Claude (task B07, session 2) | §18.8b: the escalation of an overdue gate, closed by the platform (ADR-M30 §2.9) |
| 0.5 | 2026-09-30 | Claude (task A08) | §18.8c platform usage: logs and traces of a run (ADR-M35) |
| 0.6 | 2026-10-03 | Claude (task B04) | §18.8b: the `sdlc escalation` commands (ADR-M36) |
| 0.7 | 2026-10-03 | Claude (task C07, PR 2) | §18.8b: resume a G5 breach with more budget (the request body, `run_start` and `budget_increase`; ADR-M34 §2.9) |
| 0.8 | 2026-10-03 | Claude (task C11, PR 1) | §18.8d platform usage: the kill switch (`/kill`, `sdlc run kill`, `sdlc ops run kill`, who, what happens, afterwards; ADR-M42) |
| 0.9 | 2026-10-04 | Claude (task C11, PR 2) | §18.8d: loop detection (`loop_detected`, `no_progress`), telling a false `no_progress` from a real stall, raising the window (rule M27; ADR-M42 §2.7) |
| 0.10 | 2026-10-04 | Claude (task B09, PR 2) | §18.8b: the decisions after a failed run (`modify` / `roll-back` → G3 HITL for every cause); §18.8d: the same after a kill (QUESTIONS #211) |
| 0.11 | 2026-10-22 | Claude (task X03, PR 3) | §18.8d: `agent_stuck` comes from OpenHands only; a run that ends `agent_config_changed` (adapter `opencode`) and what Person B checks (ADR-M88) |
| 0.12 | 2026-11-15 | Claude (task H08, PR 3a) | §18.8e platform usage: break-glass (`adlc break-glass`, `adlc ops break-glass`, who, the scopes, what never changes, the review; ADR-M111) |
| 0.13 | 2026-11-16 | Claude (task H08, PR 3b) | §18.8e: who a scope serves, the grant ends by itself, G8 waits for the review, the overdue comment (ADR-M111 0.4) |
