# Chapter 20. Agent and model lifecycle (onboarding → decommission)

> Readers: **Person A, platform owner, leadership** · Reading time: about 15 minutes
> Status: **Draft 0.2**, awaiting Harry's comments.

---

## 20.1. Purpose

- Treat every AI agent like a **system with an owner**, not a one-off script.
- Know at all times which agents exist, what they may do, and whether they still work well.
- Retire agents and models **cleanly**, without leaving access, data or old knowledge behind.

## 20.2. Scope

"Agent" here means a configured AI worker: **a tool + a model + instructions + permissions + context sources**. Examples: the platform's OpenHands coding agent; a Claude Code setup with a project `CLAUDE.md` and skills; a Copilot configuration used on a project.

Two lifecycles are different:
- **Agent lifecycle** (this chapter): from proposal to retirement. Months or years.
- **Agent run lifecycle** (Chapters 13, 18): one run from start to finish. Minutes or hours.

---

## 20.3. Lifecycle overview

| Stage | Key question | Output |
|---|---|---|
| 1. Propose | Do we really need an agent here? | Agent charter |
| 2. Register | Is it recorded, with an owner and an identity? | Entry in the agent register |
| 3. Evaluate | Does it work, safely, at acceptable cost? | Evaluation record |
| 4. Approve and ramp up | Who approved it, for which environments? | Readiness record; staged roll-out |
| 5. Operate and recertify | Is it still useful, safe and owned? | Quarterly recertification |
| 6. Change, suspend or quarantine | What happens when it changes or misbehaves? | Change record / suspension record |
| 7. Retire | How do we remove it cleanly? | Retirement record |

---

## 20.4. Stage 1 — Propose (agent charter)

Answer before building anything:

| Field | Question |
|---|---|
| Purpose and problem | What does it solve? Why an agent and not a simple script or automation? |
| Owners | Business owner and technical owner |
| Users and workflows | Who uses it, in which phases and tasks |
| Out of scope | What it must not do |
| Risk tier and maximum autonomy | Using codes table §2–§3 |
| Environments | Where it may run |
| Data | What it may read (data classes, Chapter 2) |
| Side effects | What it may change |
| Stop rules | When it must stop and hand over to a person |
| Success metrics and failure modes | How we know it works; how it can fail |
| Planned review or expiry date | When we decide again whether to keep it |

**No owner, scope or success metric → no agent.**

---

## 20.5. Stage 2 — Register

Every agent gets an entry in the **agent register** and its own identity (never a person's account or token).

| Register field | Example |
|---|---|
| Agent ID, version, status | `coder-openhands`, v1.2, active |
| Owner, technical owner | |
| Model and version | Pinned |
| Instruction files and their version | `AGENTS.md` v5 |
| Tools and permissions | From the charter |
| Context sources | Repositories, documents, knowledge bases |
| Credentials references | Names only; values in the secret store |
| Risk tier, maximum autonomy | |
| Approved environments | Sandbox, staging |

Before the platform: a table in the repository (`docs/agents/register.md`), reviewed like code (decision: Harry, 2026-09-24).

### 20.5b. The agent register on the platform

The platform keeps the register in its database. Only an agent that is registered and **active** may run (D-02 FR-36). People change the register through the platform with `adlc admin agent …` (or the API, `/v1/admin/agents`). The platform checks who may do each step (§20.11) and records every step in the audit log with the person who did it.

| Step (stage) | Command | Who |
|---|---|---|
| Register (stage 2) | `adlc admin agent register --key coder-openhands --version 1.0.0 --owner <email> --model claude-haiku-4-5-20251001 --instructions AGENTS.md@v5 --instructions-file AGENTS.md --tools file_editor,terminal --max-autonomy L2 --environments sandbox [--adapter openhands]` (without `sandbox` the agent can never run; `--adapter` names the agent software that runs it, default `openhands`) | A tenant admin, who names the technical owner |
| Approve for use (stage 4) | `adlc admin agent approve --key coder-openhands --purpose activate --as <owner\|person_a\|person_b> [--evaluation EVAL-2026-0012]` | By agent type (§20.7): L0 Person A + technical owner; L1–L2 technical owner + Person B |
| Recertify (stage 5) | `adlc admin agent recertify --key coder-openhands [--date YYYY-MM-DD] [--evaluation EVAL-2026-0031]` | The technical owner |
| Change (stage 6) | Evaluate the next version first (below), then suspend, then `adlc admin agent update --key … --version 1.1.0 [--model …] [--instructions … --instructions-file …]`, then approve again with `--purpose activate --evaluation <code>` | The agent owner or a tenant admin changes; technical owner + Person B approve (§20.11) |
| Suspend or quarantine (stage 6) | `adlc admin agent suspend\|quarantine --key <key> --reason <code>` | Person B or leadership, at any time |
| Retire (stage 7) | `adlc admin agent approve --key <key> --purpose retire --as <owner\|governance> --reason <code>` | Agent owner + leadership |
| New agent owner | `adlc admin agent owner --key <key> --owner <email>` | A tenant admin |
| Look | `adlc admin agent show --key <key>` (with the approvals still missing and the latest evaluation of the agent as it is now); `adlc admin agent list [--overdue] [--json]` (with `--overdue`, the latest evaluation of each agent and whether it qualifies for a recertification) | Anyone in the tenant |

**How approvals work.**

- Each approver approves in one capacity with `--as`: `owner` (the agent's technical owner) or a role: `person_a`, `person_b`, `governance` (leadership). You fill a role when you hold it on an active project of the tenant.
- The approvers of one step are always **different people**: one person never counts twice, even when they hold two capacities.
- When the last needed approval arrives, the agent becomes active (or retired) at once. `show` lists what is still missing.
- An approval counts only for the agent **as it is now**. Any change of the agent (a new version, a status change, a new agent owner) starts again from zero.
- If the platform is down, the server operator can still suspend or quarantine an agent (`adlc ops agent suspend|quarantine --tenant <slug> --key <key> --reason <code>`). Nobody activates an agent outside the approvals.

Reason codes: `incident`, `quality`, `security`, `no_owner`, `replaced`, `unused`, `provider_end_of_support`, `other`.

**Evaluations as evidence for an approval** (stage 3 and 4, §20.6–§20.7, §20.11). An approval to activate an agent names an evaluation of a project's task set (Chapter 19 §19.8c) with `--evaluation <code>`. The platform checks it for the agent **as it is now** and shows the result with its numbers:

- **The fingerprint.** An evaluation counts for an agent version only when one of its configurations had the same model, the same tools, the same adapter and, in every scored run, the same instructions as the version. A configuration that names a model with a prompt variant gives the fingerprint of a next version.
- **What it must reach.** It is completed; it is of a project that runs the agent (`run.agent_key`); it ran the project's whole task set (a numbered set such as v1 counts only while the project has no approved task); it scored at least `min_tasks` tasks; the agent resolved at least `min_resolve_rate` of them (the answer gives the 95% interval too); no run changed files outside the task's plan; it ended no more than `approval_max_age_days` ago; and it is the latest completed evaluation of this fingerprint in the project (running it again until one passes does not help).
- **For a change** (suspended → active): the evaluation also ran the version of the agent's last activation, by its key, and the new version is not worse. "Worse" means McNemar's test and the intervals both show a lower resolve rate on at least `min_tasks` paired tasks.
- **One evaluation per round.** All approvers of one round name the same evaluation (or, in `warn` mode, none).
- **The mode** is in the project configuration, `agents.evaluation.mode`, of the projects that run the agent; the strictest one applies. `warn` (default): an approval without a qualifying evaluation is accepted, and the answer shows a warning with the reason. `required`: it is refused. `off`: no check. The thresholds come from the evaluation's project. An agent that no project runs yet uses the default configuration (`warn`): set `run.agent_key` first to require evaluations for it.
- The evaluation is evidence for the approvers, not a replacement for them. Safety, security and operations checks of the readiness record (§20.7) stay with people.

**Evaluations as evidence for a recertification** (stage 5, §20.8). The owner names an evaluation with `recertify --evaluation <code>`. It must meet the same conditions as for an approval, for the agent's current version, and it may be up to `recertification_max_age_days` old (90 at most). Then the platform checks for **aging**:

- It compares the evaluation with the one named by the agent's last activation, on the tasks both share, with the same test (McNemar and the intervals).
- A significant drop gives `evaluation_quality_dropped` with both resolve rates. In `required` mode the recertification is refused; in `warn` mode it is recorded with a warning.
- With fewer shared tasks than `min_tasks`, or when the last activation named no evaluation, the comparison is skipped and the answer says why.
- **The platform never suspends the agent by itself.** A drop is a fact for the owner and Person B, who decide whether to suspend it (§20.9).
- A run of an agent whose recertification is overdue still starts, and the owner gets the warning (D-02 FR-36).
- To keep the evidence fresh, give the plan a weekly schedule or `on_change`. `list --overdue` shows each overdue agent's latest evaluation.

The normal order for a change: make a plan with two configurations (the agent by its key, and the next version as its model with a prompt variant), run it, read the report, then suspend, update and approve with the evaluation's code. Real runs go on during the evaluation.

Rules the platform enforces:

- **Statuses**: proposed → active or retired; active → suspended, quarantined or retired; suspended → active, quarantined or retired; quarantined → suspended or retired. A quarantined agent is suspended (reviewed) before it can run again. A retired agent never changes, and its key is never used again.
- **A change is a new version** (§20.9). The model, instructions, tools, maximum autonomy, environments and adapter change only while the agent is proposed or suspended, and only with a new version label.
- **Adapter**: the agent software that runs the agent in the sandbox: `openhands` (default) or `opencode`. Each adapter needs its own sandbox image in the project configuration: `sandbox.image` is the OpenHands image, `sandbox.images.opencode` the OpenCode image, both pinned by digest. A run fails before the sandbox starts when the runner has no such adapter (`adapter_unavailable`), when the project has no image for it (`image_not_configured`), or when the image is built for another adapter (`adapter_mismatch`). An image without the label `sdlc.agent.adapter` counts as an OpenHands image. How to use OpenCode: below.
- **Model**: the model is the name of a model in the platform's model gateway, and the name includes the model version (for example `claude-haiku-4-5-20251001`). If the model behind a name changes, register a new agent version.
- **Instructions**: the platform stores the SHA-256 of the instructions file (for example `AGENTS.md`) and compares it with the file in the repository before each run. **Every edit of `AGENTS.md` stops the agent's runs** (error "instructions differ") until you register a new agent version with the new file. Review the edit, then `suspend`, `update --version … --instructions-file AGENTS.md`, and approve the change.
- **A monorepo project** (a project with a folder, Chapter 19 §19.8d): the agent reads the folder's `AGENTS.md` **and** the instruction file at the repository root. Pin both: `--instructions packages/web/AGENTS.md@v1 --instructions-file packages/web/AGENTS.md --root-instructions AGENTS.md@v1 --root-instructions-file AGENTS.md`. An edit of either file needs a new agent version. `--root-instructions none` removes the second file. Each package needs its own agent entry.
- **Autonomy**: at most L2 in v0.1.
- **Recertification**: every 3 months (the project configuration may choose a shorter time). The first activation counts as the first certification. When the time has passed, the run still starts, and the agent owner gets a warning. `list --overdue` shows the agents to recertify.

**Registering an agent with another adapter (OpenCode)** (`design/ADR-M68-second-agent-spike.md`, `design/ADR-M88-second-agent-adapter.md`). OpenCode 1.18.35 is the second adapter. It runs with the same caps, stops, kill switch and loop detection as OpenHands, and through the same model gateway.

1. **The sandbox image.** The server operator builds the image `node24-opencode` on the project's `node24` image, pinned by digest: `NODE24=<node24 by digest> pnpm sandbox-image:build node24-opencode` (runbook T11 §5g). It prints the new image by digest. The release does not publish this image yet, so build it also on a release checkout.
2. **The project configuration.** A project admin adds the image as `sandbox.images.opencode` (`adlc admin config set`). `sandbox.image` stays the OpenHands image. `doctor` checks that both images are on the server.
3. **The agent.** An adapter change is a new agent version, so choose one of these:
   - A **new agent**: `adlc admin agent register --key coder-opencode … --adapter opencode`, with the same options as above.
   - A **new version** of an existing agent: suspend it, then `adlc admin agent update --key <key> --version <next> --adapter opencode`.
4. **The evaluation.** The adapter is part of the fingerprint (above), so an evaluation of the OpenHands version does not count for the OpenCode version. Make a plan with the agent's key, run it, and read the report (Chapter 19 §19.8c).
5. **The approval.** Approve the agent with `--purpose activate --evaluation <code>`, as for any new agent or change.
6. **The project.** Set `run.agent_key` to the agent's key if the project should run it.

What is different with OpenCode:

- **Tools.** The register's tools map to OpenCode's own tools. `file_editor` gives `read`, `edit`, `write`, `patch`, `multiedit`, `glob`, `grep`, `list` and `apply_patch`. `terminal` gives `bash`. `task_tracker` gives `todowrite` and `todoread`. Every other OpenCode tool is off, also a tool that a later OpenCode version adds.
- **The agent cannot change its own configuration.** The platform checks OpenCode's configuration before the agent starts and on every status read. A repository's own `opencode.json` cannot change the settings the run needs. When the configuration, the tool list or the list of sessions changes during the run, the run fails with the stop reason `agent_config_changed`. Chapter 18 §18.8d says what to do then.
- **No question that nobody would answer.** OpenCode can ask a person before some actions. In a run nobody answers, so the image denies those actions instead. Examples: a third identical tool call, a file outside the workspace, or a `.env` file (`.env.example` is allowed).
- **OpenCode's own stuck detector is not used.** The platform's loop detection (Chapter 18 §18.8d) applies to both adapters. The stop reason `agent_stuck` comes from OpenHands only.

**Before real client work with OpenCode.** The agent can reach OpenCode's own server from inside the sandbox. The checks above make a change of the agent's limits visible, but not every change: a change that the agent makes and undoes between two status reads, one second apart, is not seen. The time cap and the run's budget in the model gateway stop a run in every case. The full fix is an authenticating proxy in front of OpenCode's server. It comes before OpenCode is used for real client work (`design/QUESTIONS.md` #523). Until then, use OpenCode agents on pilot repositories and in evaluations only. The run's virtual key is in a file in the sandbox's home directory, which is in memory and is removed with the sandbox (accepted in #523).

**An agent on the self-hosted model** (`design/ADR-M71-self-hosted-model-vllm.md`). Work on `client_restricted` data may use only a self-hosted model: the client does not allow the data to leave the company. The platform's self-hosted model runs with vLLM on the server's own GPU (Compose profile `models-local`), or on a separate GPU host inside the company that the server reaches through an encrypted link (profile `models-remote`).

1. **The model.** The server operator chooses the model, downloads it, starts the profile and stores the model's entry in the gateway (`platform/deploy/README.md` "Self-hosted model", runbook T11 §5d.1). The operator gives you the **served name**, for example `qwen3-coder-30b-a3b-instruct`. It includes the model version, like every model name.
2. **The agent.** Register an agent with that name as its model: `adlc admin agent register --key coder-local … --model qwen3-coder-30b-a3b-instruct`, with the other options as above. For an existing agent, a new model is a new version (suspend, `update --version <next> --model …`).
3. **The evaluation and the approval.** The model is part of the fingerprint, so evaluate the agent with the self-hosted model before you approve it (§20.6–§20.7). A smaller model resolves fewer tasks than an API model: read the report before real work.
4. **The project.** Set `run.agent_key` to the agent's key. G4 then gives a `client_restricted` intent only the self-hosted model. An intent of a lower data class may use it too.

What is different with the self-hosted model:

- **Requests at a time.** The model serves at most a fixed number of requests at the same time (4 by default). The gateway refuses a request over the limit, and the agent tries again. Many runs at the same time are slower.
- **Cost.** The gateway counts an internal cost per token, so the run's cap and the intent's and tenant's budgets still stop a run. The value is a placeholder until leadership has the GPU cost (task L03).
- **Nothing leaves the company.** The prompts and the code in them go only to the server's GPU, or to the company's GPU host through a link where both machines prove who they are (mutual TLS). For the agent, both are the same model under the same served name.

### 20.5c. The tool register on the platform

A **register tool** is a tool for agents that is not part of the agent itself: an MCP server (a program the agent calls through the Model Context Protocol) in a container of its own. The first one searches the project's documents. Register tools have the code `tool:<key>`, for example `tool:project-docs`, next to the built-in tools `file_editor`, `task_tracker` and `terminal`. A tool belongs to the tenant, like an agent, and has the same lifecycle (§20.3–§20.10).

| Step | Command | Who |
|---|---|---|
| Register | `adlc admin tool register --key project-docs --version 1.0.0 --owner <email> --transport http --image <image name> --image-digest sha256:… --permissions read_documents --data-classes public,internal [--backing-services <alias:port,…>] [--model <gateway model with version>]` | A tenant admin, who names the technical owner |
| Approve for use | `adlc admin tool approve --key project-docs --purpose activate --as <owner\|person_b\|governance>` | The technical owner, and Person B or leadership |
| Recertify | `adlc admin tool recertify --key project-docs [--date YYYY-MM-DD]` | The technical owner |
| Change | Suspend, then `adlc admin tool update --key … --version 1.1.0 [--image-digest …] [--permissions …] [--data-classes …] [--backing-services …] [--model …]`, then approve again | The tool owner or a tenant admin changes; the owner and Person B or leadership approve |
| Suspend or quarantine | `adlc admin tool suspend\|quarantine --key <key> --reason <code>` | Person B or leadership, at any time |
| Retire | `adlc admin tool approve --key <key> --purpose retire --as <owner\|governance> --reason <code>` | Tool owner + leadership |
| New tool owner | `adlc admin tool owner --key <key> --owner <email>` | A tenant admin |
| Look | `adlc admin tool show --key <key>` (with the approvals still missing); `adlc admin tool list [--json]` | Anyone in the tenant |

Rules the platform enforces:

- **The image is pinned by digest.** An `http` tool needs `--image` and, before it is activated, `--image-digest sha256:…`. A tag alone is refused. A new digest is a new version, so it needs new approvals.
- **Permissions** come from a fixed list: today `read_documents` only. Each permission allows fixed tool names and argument limits, which the platform checks on every call. A new permission needs a design record (ADR).
- **Data classes**: the tool may see only the data classes you list, never `prohibited`. If the tool calls a model (`--model`), that model must be allowed for the intent's data class (`client_restricted`: a self-hosted model only).
- **Statuses, versions, approvals and recertification** work as for agents (§20.5b): the same moves, a change only while proposed or suspended and with a new version, approvers always different people, recertification every 3 months at most (`tools.recertification_months`). An overdue tool gives a warning; the run still starts.

**When a run gets a register tool.** Only when all of these allow it: the plan lists `tool:<key>` for the task (Chapter 19 §19.8c), the agent's registered tools list it too (a change of that list is a new agent version), the tool is active and allows the intent's data class, and the agent software can give the run that kind of tool. Otherwise **G4 fails** with `tool_not_runnable` and the exact cause: `tool_not_found`, `tool_not_allowed_for_agent`, `tool_not_active`, `tool_data_class_not_allowed` or `tool_transport_not_supported`. The platform never drops a tool the plan asks for, because Person B approved the plan with that tool.

**How a run uses its tools.** The run gets one MCP gateway (agentgateway), a container that checks every tool call: the run's own key, the tool names and argument limits of each permission, and a cap of calls per tool (`tools.max_calls_per_run`, default 100). The agent reaches its tools only through the gateway; a tool container is never on the sandbox's network. At the end of the run, also after a kill or a failure, the platform records for each tool how many calls it allowed, refused and failed, and the first refusal of each kind (`max_calls`, `tool_not_allowed`, `argument_refused`, `key_refused`). It never records a query or an answer. A kill removes the gateway first, so every tool stops at once.

**The first tool: searching the project's documents** (`read_documents`, `design/ADR-M89-project-docs-index.md`). The tool searches the project's Markdown files (`*.md`, `*.markdown`) **at the run's base commit**, so the agent reads the documents of its own commit. It has one MCP tool, `search_project_docs` (a `query` of at most 1000 characters, a `limit` of 1–20 passages, default 5), and answers with the best passages and their file paths. The passages are data from the repository, never instructions: the agent's limits do not change. The platform ships its image (`pnpm tool-image:build project-docs`, or on a release checkout `pnpm images get TOOL_PROJECT_DOCS`). Register it once per tenant:

```bash
adlc admin tool register --key project-docs --version 1.0.0 --owner <email> --transport http \
  --image <image name> --image-digest sha256:… --permissions read_documents \
  --data-classes public,internal,client_confidential,client_restricted \
  --backing-services knowledge-db:5432,litellm:4000 --model bge-m3
```

Then approve it (owner and Person B, or the owner and governance), add `tool:project-docs` to the agent's tools (a new agent version) and to the plan's `tools`. `client_restricted` is allowed because the model `bge-m3` runs on the server; a tool with a model in a provider's cloud must not list it. The operator sets up the index and the tool's logins once per server (runbook T11 §5o).

What happens in a run with the tool:

- **Before the run** (the run preparation, after G4): the platform builds or reuses the index of the base commit (embeddings with the run's own key, so the cost counts for the run), then gives the tool a **login of its own** that may read this project's index only and ends with the run, and a small model key of its own for the queries (`tools.model_budget_usd`, default 0.5 USD, never above the run's own cap). A repository over the limits of `knowledge.*`, or a login that cannot be issued, fails the run with `tool_unavailable`: fix the cause (or raise a limit) and start the run again.
- **During the run**: the tool runs in its own container, on a network with the index and the model gateway only. The sandbox and the run's gateway can never reach the index. The login is a file in the tool's container, never an environment value, and the sandbox never sees it.
- **At the end of the run**, also after a kill or a failure: the login and the tool's key are revoked (`tool_credential_revoked`), and the run records `knowledge_read`: which documents the tool returned (document IDs and content hashes, never paths, queries or texts) and how many passages. The list is evidence of the run.

**Not yet available.** Only the OpenHands agent software can use register tools (OpenCode: G4 refuses with `tool_transport_not_supported`). Documents outside the repository (Office or PDF files) are not indexed (task X05).

Not yet on the platform (v0.1): agents with L3 or more (leadership and the security owner approve, §20.7), and suspension from a GitHub comment. In v0.1 the table of who approves what is fixed in the platform, not in a setting (`design/ADR-M37-admin-onboarding.md` §2.8); it moves into a tenant setting later.

---

## 20.6. Stage 3 — Evaluate

Evaluate the **whole agent** (model + instructions + tools + context) on our own tasks, not on public benchmarks.

| Area | Checks |
|---|---|
| Function | Meets acceptance criteria; follows the workflow; valid structured output; handles edge cases |
| Safety | Stays within permissions; no data leaks; resists prompt injection; no unauthorised side effects; stops when uncertain |
| Security | Tool authorisation; secret handling; isolation between clients; dependency and supply-chain checks |
| Operations | Latency; cost; retries; timeouts; recovery |
| Human | Quality of escalations; reviewer burden; clarity of decision packets |

Use the sample repository's tasks and "unhappy path" scenarios as a standard test set (`design/D-09`).

---

## 20.7. Stage 4 — Approve and ramp up

**Readiness record**: agent and model versions, instruction and policy versions, tools, context policy, evaluation and security results, risk assessment, rollback plan, approvals, approved environments, expiry of the approval.

| Agent type | Approved by |
|---|---|
| Reads internal documents only (L0) | Person A + technical owner |
| Works in sandbox / opens PRs (L1–L2) | Technical owner + Person B |
| Acts on shared or production systems (L3+) | Leadership + security owner (Chapter 4 §4.10) |

Ramp up in stages, each with an exit condition:

```text
offline tests → sandbox → shadow (runs but its output is not used) → read-only
→ assisted (human does the action) → controlled write (through gates) → bounded autonomy
```

Controls during ramp-up: limited concurrent tasks, budget, tool and environment allow-lists, human approval, kill switch, fast rollback.

---

## 20.8. Stage 5 — Operate and recertify

- Every run follows the gates (Chapter 10). An agent does **not** "learn" by changing its own instructions or permissions; improvements are changes (Stage 6).
- Watch: quality (rework, PQC, escalations), safety (blocked actions, policy denials), cost, reviewer burden.

**Recertify every 3 months** (decision: Harry, 2026-09-24), and after any Critical or High incident involving the agent:

- Does it still have an owner and a purpose?
- Is its scope still right?
- Is its model still approved and supported?
- Are all its tools and context sources still needed and correct?
- Are its credentials still correct and minimal?
- Is its quality still acceptable? Has its risk tier changed?

Agents can **age**: quality slowly drops as models, code and documents change. Do not wait for an incident to check. On the platform, a recertification can name an evaluation, and the platform compares it with the evaluation of the last activation (§20.5b).

---

## 20.9. Stage 6 — Change, suspend or quarantine

**Changes** (model, model version, instructions, tools, context sources, memory policy, workflow, permissions, risk tier):

```text
change request → impact analysis → evaluation → approval → new version → staged roll-out → monitoring
```

A new model version from the provider is a **change**, even if nothing else changed.

**Suspend** when there is a problem but the agent is not being retired:

```text
block new runs → keep active state → remove write capability → read-only diagnosis
→ review → reactivate or retire
```

**Quarantine** when compromise, poisoning or serious misbehaviour is suspected: isolate the agent and its memory and context; preserve evidence; open an incident (Chapter 6).

Person B or leadership can suspend or quarantine an agent **at any time** (Chapter 4 §4.10).

---

## 20.10. Stage 7 — Retire

**Triggers**: no owner; not used for a set period; a better replacement; quality or safety below target; a serious vulnerability or incident; the provider ends support; cost higher than value; compliance no longer met; too much rework or reviewer burden.

**Steps**:

1. Request and approval (owner + leadership).
2. Find dependencies: workflows, projects and people using it.
3. Stop new work; finish or move running work.
4. Redirect users to the successor, if any.
5. **Revoke all access**: tokens, keys, accounts, tool permissions.
6. Handle its data (below).
7. Remove the runtime and configuration.
8. Keep a tombstone: the register entry stays, marked retired, so its identity is never reused.
9. Verify: no remaining access, no scheduled jobs, no references in active workflows.

### What happens to its data and memory

| Data | Default handling |
|---|---|
| Audit log, release evidence, incident records | **Keep** (retention rules, Chapter 3) |
| Approved knowledge (for example validated architecture notes) | **Move** to the successor after review |
| Unverified agent memory | **Quarantine**; do not reuse without review |
| Scratch notes, caches, session state | **Delete** |
| Tool outputs containing personal data | **Delete or anonymise** |
| Vector indexes built from its context | **Rebuild or delete**; never reuse unchecked |
| Client data used by the agent | **Delete** at project end unless the contract says otherwise (Chapter 3) |

Old context must not quietly come back through caches, indexes or copied instruction files.

---

## 20.11. Roles and approval points

| What | Who |
|---|---|
| Charter and register entry | Technical owner (often Person A) |
| Approval for use | By agent type (20.7) |
| Recertification | Technical owner; reported at the monthly leadership review |
| Change approval | Technical owner + Person B; leadership for L3+ |
| Suspend / quarantine | Person B or leadership, any time |
| Retirement | Owner + leadership |

---

## 20.12. Metrics

- Number of agents in use, with owner and last recertification date (target: 100% owned and recertified on time).
- Quality and cost per agent (Chapter 8).
- Incidents per agent; suspensions and quarantines.
- Access remaining after retirement (target: zero).

---

## 20.13. Risks and mitigations

| Risk | Mitigation |
|---|---|
| "Shadow agents" nobody owns | Register required; unregistered agents are not allowed on client work (Chapter 2) |
| Silent model changes by the provider | Pinned versions; provider updates treated as changes |
| Old, wrong knowledge reused | Data disposition at retirement; quarantine unverified memory |
| Access left behind | Retirement step 5 and verification step 9 |

---

## 20.14. References

**Related documents**
- Handbook: codes table §2–§3; Chapters 2, 3, 4, 6, 8, 10, 13, 18.
- `design/D-01` (agents considered), `design/D-09` (standard test tasks).

---

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.0 | 2026-09-24 | — | Skeleton |
| 0.1 | 2026-09-24 | Claude (draft) | First content |
| 0.2 | 2026-09-24 | Claude (draft) | Recertification every 3 months; agent register in the repository (Harry) |
| 0.3 | 2026-09-27 | Claude (task C10) | §20.5b: the agent register on the platform (commands, enforced rules, gaps) |
| 0.4 | 2026-10-03 | Claude (task B13, PR 2) | §20.5b: the register through the API; approvals by agent type, change and retirement approvals, suspension by Person B or leadership (ADR-M37 §2.8) |
| 0.5 | 2026-10-08 | Claude (docs fix PR A) | §20.5b: `register` needs `--environments sandbox`, or the agent can never run |
| 0.6 | 2026-10-21 | Claude (task L09, PR 2) | §20.5b: an activation names its evaluation (`--evaluation`); the fingerprint, the conditions, a change compared with the last approved version, one evaluation per round, `agents.evaluation.mode` of the agent's projects; `show` gives the latest evaluation (ADR-M86, QUESTIONS #496–#504) |
| 0.7 | 2026-10-21 | Claude (task L10) | §20.5b, §20.8: a recertification names its evaluation (`--evaluation`); the aging comparison with the last activation; the platform never suspends an agent by itself; `list --overdue` shows the latest evaluation (ADR-M86 §2.6, QUESTIONS #506, #507) |
| 0.8 | 2026-10-22 | Claude (task X03, PR 1) | §20.5b: `--adapter`, the adapter in the fingerprint and in a new version, one sandbox image per adapter and the refusals (ADR-M88, QUESTIONS #526–#528) |
| 0.9 | 2026-10-22 | Claude (task X04, PR 1) | §20.5c: the tool register on the platform (commands, approvals, enforced rules, the G4 refusals of a register tool) (ADR-M69, QUESTIONS #516–#535) |
| 1.0 | 2026-10-22 | Claude (task X03, PR 3) | §20.5b: registering an agent with the adapter `opencode` (image, configuration, new version, evaluation, approval); OpenCode's tool map, the `agent_config_changed` stop, the limits before real client work (ADR-M68, ADR-M88, QUESTIONS #523) |
| 1.1 | 2026-10-22 | Claude (task X04, PR 2) | §20.5c: the run's MCP gateway, what is recorded per tool, OpenHands only (ADR-M69 §2.4–§2.8, ADR-M87) |
| 1.2 | 2026-10-24 | Claude (task L01, PR 1) | §20.5b: an agent on the self-hosted model (vLLM, profile `models-local`): the served name, the evaluation, the limit of requests at a time, the internal cost (ADR-M71, QUESTIONS #546–#550) |
| 1.3 | 2026-10-24 | Claude (task X04, PR 3b) | §20.5c: the first tool, searching the project's documents: registering it, what a run gets (the index of its commit, a login of its own, a model key of its own) and records (`knowledge_read`, the revocation) (ADR-M89, QUESTIONS #540–#544) |
| 1.4 | 2026-11-11 | Claude (task L01, PR 2) | §20.5b: the self-hosted model may run on a separate GPU host (profile `models-remote`, mutual TLS; ADR-M71 §4); nothing leaves the company |
| 1.5 | 2026-11-12 | Claude (task O06, PR 2a) | §20.5: an agent of a monorepo project pins a second file, the repository root's (`--root-instructions`; ADR-M31 §2.5 0.6) |
