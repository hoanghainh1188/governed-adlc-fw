# D-03. Platform architecture (v0.1 baseline, updated by later releases)

| Item | Value |
|---|---|
| Version | 1.51 (1.49 approved with X13 PR 1, QUESTIONS #711, with schema 5, QUESTIONS #712; 1.48 and earlier, 1.50 and 1.51 approved) |
| Date | 2026-10-24 |
| Status | **Approved** (Harry, 2026-09-24) — version 1.0, aligned with the handbook (tag `design-v1.0`); 1.1 approved by Harry on 2026-09-25 in the B01 plan (G6 security threshold, policy interface details); 1.2 approved by Harry on 2026-09-25 (QUESTIONS #1, #20); 1.3 approved by Harry on 2026-09-26 in the C02 plan (Run Contract fields, QUESTIONS #33, #34); 1.4 approved by Harry on 2026-09-26 in the B05 plan (worker reads the GitHub App key, Git host interface notes; QUESTIONS #42, #43); 1.5 approved by Harry on 2026-09-26 in the C03 plan (model gateway interface, one source for the LiteLLM master key; ADR-M24); 1.6 approved by Harry on 2026-09-27 in the C04 plan (sandbox egress, runner reaches GitHub, token handoff, sandbox image registry; QUESTIONS #44, #52–#54, #59; ADR-M25); 1.7 approved by Harry on 2026-09-27 in the B11 plan (escalation clocks in the database, not Temporal timers; QUESTIONS #73; ADR-M28); 1.8 approved by Harry on 2026-09-27 in the C05 session 2 plan (agent interface notes; ADR-M29); 1.9 approved by Harry on 2026-09-27 in the B07 session 2 plan (HOTL block window, C06 waits for it, the gate deadline timer; ADR-M30); 1.10 approved by Harry on 2026-09-27 in the B12 plan (project AI record module: codes only, write roles, G1 check at the submit; ADR-M32); 1.11 approved by Harry on 2026-09-27 in the C06 plan (G4 checks and decisions, `getBranchHead`, the worker holds the Cost Controller AppRole; QUESTIONS #108–#112; ADR-M33); 1.12 approved by Harry on 2026-09-27 in the C06 session 2 plan (the run's round after G4, the task queue `sdlc-runner`, a failed or lost run is escalated, `revokeRunKey`; ADR-M33 §2.6–§2.7); 1.13 approved by Harry on 2026-09-27 in the C06 session 2 plan, PR 2b (the L1 proposal as evidence, `EvidenceStore` as built, the runner reads a sandbox's workspace; ADR-M33 §2.9); 1.14 approved by Harry on 2026-09-30 in the A08 plan (OpenTelemetry Collector in the profile `observability`, one OTLP pipeline to Langfuse v4; QUESTIONS #4; ADR-M35); 1.15 approved by Harry on 2026-09-28 in the C07 plan (`listPaths`, the run's changes checked and stored by the runner, the in-run spend check; QUESTIONS #126, #130; ADR-M34); 1.16 approved by Harry on 2026-09-28 in the C07 plan and on 2026-10-03 (decisions A–C) (the G5 step, the G5 escalation and its decisions, the budget warning during the run; QUESTIONS #131–#134; ADR-M34 §2.8–§2.9); 1.17 approved by Harry on 2026-10-03 in the B08 plan (the spec is the file on the default branch, checked again at G2–G4; QUESTIONS #160–#164; ADR-M39); 1.18 approved by Harry on 2026-10-03 in the C08 plan (the push after G5, the pull request, `openPullRequest` and `findOpenPullRequest`, the push token, the runner reads run diffs; QUESTIONS #155, #156; ADR-M38 §2.1–§2.6); 1.19 approved by Harry on 2026-10-03 in the C08 plan (G6 reads CI: checks, retries, the CI timeout, security findings and their fail-closed rule, `getSecurityFindings`; QUESTIONS #157–#159; ADR-M38 §2.7); 1.20 approved by Harry on 2026-10-03 in the B09 plan (the plan is a submitted file on the default branch, checked again at G3–G4, the run's tools from the plan; QUESTIONS #165–#169; ADR-M40); 1.21 approved by Harry on 2026-10-03 in the E01 plan (G7: reviews are the approvals, producers, dual approval, the merge by a person, G7 → G3 on a rejection, `getReviews`, `getCommitAuthors`, the merge event; QUESTIONS #175–#179; ADR-M41); 1.22 approved by Harry on 2026-10-03 in the C11 plan (the kill switch: who, the path through the database and the workflow signal, the escalation at the kill, tokens revoked after use, `revokeShortLivedToken`; QUESTIONS #180–#184; ADR-M42); 1.23 approved by Harry on 2026-10-04 in the E01 PR 2 plan (a request for changes at G7 starts a new run with the reviewer's feedback, read by the runner with its own token; the API and the CLI cannot request changes at G7; `getReviewFeedback`, `getIssueComment`; the way back to G7 after the feedback was gone; QUESTIONS #179, #190, #191; ADR-M41 §2.7); 1.24 approved by Harry on 2026-10-04 in the C11 PR 2 plan (loop detection as built: the adapter's counts, the runner's checks, the order of stops, rule M27; QUESTIONS #184; ADR-M42 §2.7); 1.25 approved by Harry on 2026-10-04 in the E02 plan (the Evidence Builder in the api process, one pack per build, the hash re-check, the api's SeaweedFS identity `api-evidence` and its read of proposals and diffs, `EvidenceStore.get` with `maxBytes`; QUESTIONS #215–#219; ADR-M48); 1.26 approved by Harry on 2026-10-04 in the B09 PR 2 plan (the runner reads the plan file for the agent's prompt; `modify` or `roll_back` on a failed run's escalation → G3; QUESTIONS #169, #210, #211; ADR-M40 §2.7, ADR-M33 §2.7); 1.27 approved by Harry on 2026-10-04 in the E03 plan (G8: the release approval bound to the pack's release hash, the worker builds the release pack with its own SeaweedFS identity `worker-evidence`, the pack sealed once, every G8 is production in the MVP, a failed evidence check stops G8; QUESTIONS #220–#222; ADR-M49); 1.28 approved by Harry on 2026-10-04 in the E05 plan (evidence retention: a GOVERNANCE object lock on the bucket `evidence`, the worker's retention loop and its purge identity `worker-purge`, holds, the archive purge after a grace period; QUESTIONS #235–#239; ADR-M51); 1.29 approved by Harry on 2026-10-04 in the E05 PR 2 plan (the daily audit anchor: a COMPLIANCE bucket `audit-anchors` and the worker's identity `worker-anchor`; ADR-M51 §2.9); 1.30 approved by Harry on 2026-10-04 in the A12 plan (SeaweedFS's master, volume server and filer listen on 127.0.0.1 inside the container only and need JWT keys made at each start; the S3 gateway's gRPC port needs the filer key; QUESTIONS #239, #245, #246; ADR-M52); 1.31 approved by Harry on 2026-10-05 in the E08 plan (the Langfuse purge in the retention loop: the intents' traces deleted by their run tags with a tag check, confirmed on a later pass, the raw OTLP files swept for every tenant, ClickHouse compacted; the worker's own Langfuse key, the ClickHouse user `sdlc_purge` and the SeaweedFS identity `worker-langfuse` in `kv/worker/langfuse`; QUESTIONS #250–#253; ADR-M53); 1.32 approved by Harry on 2026-10-07 in the U01 plan (the read-only dashboard served by the api under `/dashboard/`, 127.0.0.1 only; one oversight resolution for the workflow and the API's `waiting_for`; QUESTIONS #255, #260–#263; ADR-M54); 1.33 approved by Harry on 2026-10-08 (citations of an unpublished earlier draft removed before the repository goes public; meaning unchanged); 1.34 approved by Harry on 2026-10-08 in the S01 plan (G2 needs acceptance criteria: the spec's structure counted with its hash, codes and a count only; QUESTIONS #290–#292; ADR-M61); 1.35 approved by Harry on 2026-10-09 in the A10 plan (§9: TLS on OpenBao 8200 everywhere, a throw-away CA on development machines and in CI; QUESTIONS #325; ADR-M63); 1.36 approved by Harry on 2026-10-09 in the A10 plan (§10: no ClickHouse user manages users over the network; a loopback-only `sdlc_admin` makes `sdlc_purge`; QUESTIONS #330; ADR-M63 §6); 1.37 approved by Harry on 2026-10-09 in the C13 plan (§6: an L1 proposal is downloaded by a person and the intent ends with a G4 rejection; QUESTIONS #335–#337; ADR-M64); 1.38 approved by Harry on 2026-10-10 (wording only: "MVP" retired, v0.1 baseline and Later; meaning unchanged; QUESTIONS #360); 1.39 approved by Harry on 2026-10-10 in the V04 plan (§10: release images pulled from GHCR by digest on a release checkout, built locally otherwise; QUESTIONS #370, #371; ADR-M66); 1.40 approved by Harry on 2026-10-10 in the V11 plan (§5.1, §9, §12: actions in the dashboard; QUESTIONS #375–#380; ADR-M73); 1.41 approved by Harry on 2026-10-12 in the V09 plan (§9, §10, §10.1, §12: team access from other machines through a TLS reverse proxy; QUESTIONS #405–#409; ADR-M67); 1.48 approved by Harry on 2026-10-24 in the L01 plan (§10, §10.1: the optional profile `models-local` with vLLM on the server's GPU; QUESTIONS #546–#550; ADR-M71); 1.52 approved by Harry on 2026-11-11 in the L01 PR 2 plan (§10, §10.1: vLLM on a separate GPU host, the profile `models-remote`; QUESTIONS #666–#669; ADR-M71 1.1); 1.53 approved by Harry on 2026-11-12 (§6 Run Contract `repo_path`, `root_instructions_sha256`: several projects on one repository; QUESTIONS #677, #678; ADR-M106 1.1) |
| Readers | Tech lead / architect, developers, Claude Code |
| Related documents | D-01 (build vs buy), D-02 (v0.1 scope), D-07 (models, tokens), D-09 (sample repo) |

---

## 1. Purpose

- Describe the parts of the v0.1 platform, what each part does and how they talk to each other.
- Fix the **interfaces**, so that later we can replace GitHub → GitLab, OpenHands → another agent, simple rules → OPA/Cedar without changing the core.
- Serve as input for D-05 (data model) and D-08 (backlog).

## 2. Scope

- **v0.1** architecture only (D-02 section 4.1).
- The full architecture (8 planes, Signed Run Contract with KMS, multi-agent…) is outside v0.1. v0.1 **goes in the same direction**, in a lighter form.

---

## 3. Architecture principles

| # | Principle | Source |
|---|---|---|
| AP1 | The platform is an **orchestration + policy + evidence layer** around existing tools. We do not rebuild Git, CI or registries | [Doc] Draft 5.1.2 |
| AP2 | **Separate control from execution.** The agent runs in the execution part and cannot grant itself permissions | [Doc] Draft 4.4–4.6 |
| AP3 | **Evidence and audit are kept separately** and are append-only | [Doc] Draft 4.2.3 |
| AP4 | Everything external goes through an **interface (adapter)** | [Doc] + D-02 NFR-05 |
| AP5 | **Gates, budgets and rules are configuration**, not hard-coded | [Proposal] For tuning in M-F |
| AP6 | **Multi-tenant at the data layer** from day one | D-02 NFR-02 |
| AP7 | **Modular monolith** for v0.1: few processes, clear module boundaries. Split into services when needed | [Proposal] See ADR-M01 |

---

## 4. Overview diagram

```mermaid
flowchart TB
    subgraph USER["Users"]
        CLI["CLI: sdlc"]
        GHUI["GitHub: issue / PR<br/>/approve G3 ..."]
    end

    subgraph CP["Control plane (TypeScript, built by us)"]
        API["API app (NestJS)<br/>REST for the CLI"]
        WK["Workflow worker (Temporal)<br/>Gate Orchestrator G1–G8"]
        subgraph MOD["Core modules (shared)"]
            REG["Intent / Spec Registry"]
            GATE["Gate Engine + Policy"]
            COST["Cost Controller"]
            EVD["Evidence Builder"]
            AUD["Audit Log"]
        end
    end

    subgraph EP["Execution plane"]
        RUN["Runner (TypeScript)<br/>provisions sandboxes, tracks runs"]
        subgraph SB["Sandbox (Docker, one container per run)"]
            OH["OpenHands Agent Server<br/>+ git worktree"]
        end
    end

    subgraph INFRA["Self-hosted infrastructure (reused)"]
        PG[("PostgreSQL")]
        TMP["Temporal"]
        LL["LiteLLM Proxy"]
        LF["Langfuse"]
        S3[("SeaweedFS")]
        VK["Valkey"]
        VAULT["OpenBao<br/>secrets + Run Contract signing"]
    end

    subgraph EXT["External"]
        GH["GitHub<br/>repo, PR, Actions CI"]
        LLM["Models via API"]
    end

    CLI --> API
    GHUI -. "comment /approve" .-> GH
    WK -- "event polling (v0.1)" --> GH
    API --> MOD
    WK --> MOD
    API <--> TMP
    WK <--> TMP
    WK -- "Run Contract" --> RUN
    RUN --> SB
    OH -- "per-run virtual key" --> LL
    LL --> LLM
    LL --> LF
    LL --> VK
    RUN -- "clone; push agent/* after G5" --> GH
    WK -- "open PR (G6)" --> GH
    MOD --> PG
    EVD --> S3
    COST <--> LL
    WK -- "sign contract (Transit)" --> VAULT
    RUN -- "verify, fetch short-lived secrets" --> VAULT
```

SVG version: [d11-mvp-architecture.svg](../diagrams/svg/d11-mvp-architecture.svg)

- Note (version 1.6, QUESTIONS #52; diagram updated in version 1.18, task C08): the **runner**, not the agent in the sandbox, clones the repository and pushes `agent/*`, after G5 passed the run; the worker opens the pull request. The sandbox reaches only LiteLLM and the package proxy (section 9).

---

## 5. Components and responsibilities

### 5.1. Processes

| Process | Technology | Responsibilities |
|---|---|---|
| **api** | NestJS | REST API for the CLI. Authenticates users. Sends signals to workflows. (Later: receives GitHub webhooks.) Version 1.32 (U01, ADR-M54): also serves the read-only dashboard's built files under `/dashboard/` on its own origin (`SDLC_API_DASHBOARD_DIR`); the dashboard reads the API with `GET` only |
| **worker** | Temporal worker (TS SDK) | Runs the G1–G8 workflow of each intent. Calls core modules. Waits for approvals; runs escalation timers. **Poller**: regularly asks GitHub for new comments, reviews and CI status |
| **runner** | Node.js + Docker API | Receives the Run Contract. Creates the sandbox, worktree and virtual key. Calls the OpenHands Agent Server. Reports results |
| **cli** | Node.js | The `sdlc` command for users |
| **dashboard** (version 1.32) | Preact, static files | Read-only web pages over the API (U01, ADR-M54): intents and gates, open escalations, cost and gate waiting times, evidence packs and the audit check. No process of its own: the api serves it. Version 1.40 (ADR-M73): actions through the same API endpoints, in waves (U07–U09), after GitHub sign-in with a server-side session and a passkey before each decision; merging and every G7 decision stay on GitHub |

### 5.2. Core modules (shared by api and worker)

| Module | Responsibilities | Data (see D-05) |
|---|---|---|
| Intent / Spec Registry | Create intents, link specs (path + commit + hash), plans | `intents`, `spec_refs`, `plans` |
| Gate Engine | Evaluate gate conditions; **resolve the oversight mode** from the gate × risk matrix and change flags; check approver roles, separation of duties and dual approval; bind approvals to version, scope and expiry; record decisions | `gate_decisions` |
| Escalation | Create escalations from triggers; route to owner / backup / governance; run acknowledge and resolve clocks (Temporal timers); freeze work on no answer; record decisions | `escalations` |
| Agent Register | Register agents; check status, pinned model and instructions hash before a run; recertification warnings | `agents` |
| Project AI Record | Store client consent and allowed data classes (codes only; the human record is linked); checked at the submit (Draft → G1: the intent waits in `draft` with a G1 `fail` until the record allows its data class) and at G4. Written by the roles in config `access.ai_record_write_roles` (ADR-M32) | `project_ai_records`, `project_ai_record_versions` |
| Policy | Autonomy (L0–L4), oversight matrix, model routing, file scope, forbidden actions. v0.1: rules in code behind an interface | YAML config |
| Cost Controller | Create a LiteLLM virtual key per run, set caps, read spend, warn at 80% / stop at 100% | `cost_records` |
| Evidence Builder | Collect diff, CI, tests, scans, gate decisions → JSON + Markdown pack. Version 1.25 (E02, ADR-M48): runs in the **api** process on request (E03 calls it at G8); every build is a new version, never changed (the same content returns the existing version); every stored file is read back and its hash checked first, fail closed; the pack holds codes, IDs, hashes, counts and references only (no diff, spec, plan or review text), the approvers' names in the Markdown only, and the client AI disclosure note in the project's format. Version 1.27 (E03, ADR-M49): the **worker** builds the release pack at G8 with the same code (actor `system`, its own identity `worker-evidence`), and G8 seals one version. Version 1.28 (E05, ADR-M51): the worker's **retention loop** purges the files of finished intents past `evidence_retention_days` (≥ 180) and of archived projects after a grace period, keeps the rows and hashes, skips held intents (legal hold in the store), and sweeps pack files without a row; `report` mode by default. Version 1.31 (E08, ADR-M53): the same pass deletes the due intents' model-call traces in Langfuse (selected by the intents' run tags, every trace's tags checked, confirmed on a later pass), sweeps Langfuse's raw OTLP files older than a day for every tenant, and removes deleted rows from ClickHouse's disk; an archived project is complete only when Langfuse is | `evidence_items`, `evidence_packs`, `evidence_holds`, `langfuse_purges` + SeaweedFS, Langfuse |
| Audit Log | Append-only events, hash chain, integrity check. Version 1.29 (E05 PR 2, ADR-M51 §2.9): the worker writes each tenant's latest hash once a day to the COMPLIANCE bucket `audit-anchors` and checks the earlier anchors against the chain (D-05 §7.4) | `audit_log` + SeaweedFS (`audit-anchors`) |
| Tenancy / Auth | Tenants, projects, users, roles, GitHub account mapping, API tokens | `tenants`, `projects`, `users`, `user_identities`, `role_bindings`, `api_tokens` |

### 5.3. Reused components

| Component | Role | Notes |
|---|---|---|
| Temporal | Runs long workflows, waits for humans, resumes after failures | Self-hosted |
| PostgreSQL | Platform data. May share a server with Temporal, LiteLLM and Langfuse, but **with separate databases** | |
| LiteLLM Proxy | Single entry point to models. Virtual keys, budgets | See D-07 |
| Langfuse | LLM traces, tokens; since version 1.14 also the traces of the api and the worker (one OTLP pipeline, QUESTIONS #4) | See D-07. Langfuse v4 accepts traces over OpenTelemetry only |
| OpenTelemetry Collector | Receives OTLP from the api, the worker and LiteLLM (`langfuse_otel`) without credentials and forwards it to Langfuse; the only holder of the Langfuse project key | Profile `observability`, no host port, never reachable from a sandbox (ADR-M35) |
| Valkey | Rate limiting and cache for LiteLLM and Langfuse | BSD; replaces Redis for licence reasons (review R2) |
| SeaweedFS | Stores Evidence Packs and run logs. Also used by Langfuse | S3 API, Apache 2.0. Replaces MinIO (no longer maintained, review R1) |
| **OpenBao** (Vault-compatible) | Stores secrets. Signs Run Contracts with the Transit engine; the key never leaves OpenBao | See section 8.1 |
| OpenHands Agent Server | Agent that writes code in the sandbox | See section 7.2 |
| GitHub + Actions | Repo, PRs, CI, branch protection | Through a GitHub App |

---

## 6. G1–G8 workflow (state machine)

```mermaid
stateDiagram-v2
    [*] --> Draft
    Draft --> G1: submit (AI record checked)
    G1 --> G2: approve (HITL, Person A)
    G2 --> G3: approve / HOTL pass
    G3 --> G4: approve plan / HOTL pass
    G3 --> G2: spec changed at head of default branch
    G4 --> G2: spec changed at head of default branch
    G4 --> G3: new plan submitted
    G4 --> Running: agent registered + autonomy + contract OK
    G4 --> Blocked: Critical / bad config
    Running --> G5: run finished / cost sync
    Running --> Stopped: kill switch / loop / timeout
    Running --> ProposalReady: L1 run finished (proposal stored, paused at G4)
    ProposalReady --> Rejected: Person A rejects G4 after taking the proposal forward
    G5 --> G3: changes outside plan
    G5 --> Escalated: instruction files / cost cap / iteration or time cap / stalled
    Escalated --> Running: decision = resume (bound, not expired)
    Escalated --> G4: resume after a G5 breach, a failed or a killed run (new run after G4)
    Escalated --> G3: modify / roll back after a G5 breach or a failed run (G3 HITL)
    Escalated --> Cancelled: terminate after a G5 breach, a failed or a killed run, a G8 stop
    Escalated --> Frozen: no acknowledgement within SLA
    Frozen --> Escalated: backup / governance acknowledges
    G5 --> G6: pass
    G6 --> G4: CI fail (retries left)
    G6 --> G3: CI fail (no retries left)
    G6 --> Escalated: critical security finding
    G6 --> Escalated: push or pull request refused, CI timeout
    G6 --> G7: pass
    G7 --> G4: request changes (new run from the pushed commit)
    G7 --> G3: reject (G3 HITL)
    G7 --> Escalated: pull request closed or changed, merged before approval
    Escalated --> G7: resume after a G7 stop, or after the G7 feedback was gone (same head)
    G7 --> G8: approved (+ 2nd approver if flagged) + merged by a person
    G8 --> Done: Person B approves the release (+ 2nd at Critical), pack sealed
    G8 --> Escalated: evidence file fails its hash check (security)
    Escalated --> G8: resume after a G8 stop (pack built again)
    G8 --> G8: no AI record (fail, waits) / request changes
    G1 --> Rejected: reject
    G2 --> Rejected: reject
    G3 --> Rejected: reject
    G8 --> Rejected: reject
    Stopped --> Escalated: always reviewed
    Done --> [*]
    Rejected --> [*]
    Blocked --> [*]
    Cancelled --> [*]
```

SVG version: [d12-gate-state-machine.svg](../diagrams/svg/d12-gate-state-machine.svg)

General rules:
- G5 is checked **when the agent finishes a run** and **at every cost sync**.
- L1 tasks (High risk): the agent only submits a proposal → stored as evidence `proposal`, the run ends as `succeeded_proposal_only`, and the intent waits for a human decision.
- Every state change → write `gate_decisions` + `audit_log` + a comment on the issue/PR.
- Spec hash changed after G2 → back to G2 (FR-02). Plan hash changed after G3 → back to G3.
  - Version 1.17 (ADR-M39, QUESTIONS #160–#163): the spec of an intent is the file at its path on the **head of the default branch**, the commit G4 starts the run from. Whenever the intent waits at G2, G3 or G4, the step reads the head and the file before its transaction (G4 uses the same head read for `base_sha`). Changed content → the platform links it as a new spec version; at G3 or G4 the intent goes back to G2 (notice), where the approval binding voids the approvals of the old spec and the matrix decides again (HOTL at Low risk may pass it again). A spec a person links after G2 passed does the same. A file that cannot be read (removed, not Markdown text, larger than 256 KiB) → back to G2, where the intent waits; a Git host that cannot be read → the step waits and never passes. Only the SHA-256 is stored, never the content.
  - Version 1.34 (ADR-M61, QUESTIONS #290–#292, D-02 §6.2): when the platform reads a spec (a person's link, or the check at head), it also counts its acceptance criteria by the rules of its `source_tool` (Spec Kit v1.1.2, BMAD v6.12.1, or a heading such as `## 受入基準 / Acceptance criteria`) and keeps the count and a structure code, never the text. **G2 passes only with at least one criterion**, at every tier and oversight mode; a spec linked before S01 counts as none. Otherwise a system `fail spec_unclear` once per content hash, a notice, and the intent waits at G2 (`spec_unclear`); HOTL never passes it and a person's `approve` is refused.
  - Version 1.20 (ADR-M40, QUESTIONS #165–#168): the plan of an intent is the file `.sdlc/plans/<intent code>.yaml` (template T13) on the head of the default branch, **submitted by a person** with a role in `access.plan_submit_roles`; the platform keeps its SHA-256, path patterns, agent tools and change flags (declared in the file, approved at G3), never its text. The submitter is a producer of the plan and never approves G3 (FR-11). Whenever the intent waits at G3 or G4, the step reads the file at the head the spec check read, before its transaction. A new plan submitted at G4 → back to G3 (notice), the approvals of G3 and G4 voided. The file at head is not the submitted plan (changed, removed, unreadable) → G3 or G4 is **held** (`plan_resubmit_needed`) until a person submits it again: the platform never takes a new plan version by itself (QUESTIONS #167). A held G3 still takes rejections and its overdue escalation; a held G4 starts no run. A Git host that cannot be read → the step waits and never passes.
- **The plan in the agent's prompt** (version 1.26, ADR-M40 §2.7, QUESTIONS #169, #210): for a plan read from a file, the runner reads the file at the plan's commit from its own clone (hardened git, no network, never the sandbox), checks the SHA-256 of its bytes against the contract's `plan_sha256` and its path patterns against `planned_files` (as sets), and gives the agent the tasks' text, cleaned and capped (2,000 characters per field, 16,000 in all), in a block delimited by nonce markers, framed as data. Any failure fails the run (`task_unavailable`, run event `plan_unavailable`), which then goes down the failed-run path. The text is never stored.
- **The run's tools** (version 1.20, ADR-M40 §2.5, QUESTIONS #34, #108): the agent's registered tools that the plan's tasks list; none in common → G4 fails and the intent waits at G4.
- **No gate is ever auto-approved by silence.** HOTL at a human gate passes only when all policy conditions hold, and the notified person can still block within the gate's window.
  - Version 1.9 (ADR-M30 §2.4b, QUESTIONS #88): the platform records the HOTL pass at once and the intent moves on. Within `oversight.hotl_block_window`, a person with the gate's role may reject the passed gate or request changes; a request for changes takes the intent back to that gate, a rejection ends it. An explicit approval opens no window. **C06 does not start a run before the last open window closes** (`hotlBlockWindowOpenUntil`). No HOTL pass again on an input a person sent back.
  - A human gate that waits past `oversight.hitl_gate_deadline` raises one escalation (trigger `time`, level from `oversight.gate_overdue`), closed when the gate is decided (ADR-M30 §2.9). This deadline is the only Temporal timer of the intent workflow.
- **G4** (version 1.11, ADR-M33 §2.4, QUESTIONS #110): the checks run in a fixed order (Critical or L0, block window, freeze, approved spec and plan, AI record, agent register, intent budget). Critical risk or an effective autonomy of L0 → `blocked`, which is final. Any other failed check records a system `fail` once per cause and the intent **waits at G4**; the next wake checks again. A G4 pass or approval is bound to the run proposal (plan, spec, agent and version, instructions, model, autonomy, tools, caps, base commit); a changed proposal voids a G4 approval (FR-17).
- **The run after G4** (version 1.12, ADR-M33 §2.6–§2.7): a decided G4 moves the intent to `running`; the workflow prepares the run, hands it to the runner on the Temporal task queue `sdlc-runner` (one heartbeat activity per run, one attempt), and finishes it. A succeeded run or a stop at a cap or the file scope → G5. A failed or lost run (heartbeat timeout) → `paused` and a `technical` escalation at `pause` or higher (the "Stopped → Escalated" arrow); the key is revoked at once. A contract that expires while its run waits → a new attempt, a few times (config), then the same escalation. A `resume` decision on that escalation takes the intent back to G4. Version 1.26 (QUESTIONS #211): `modify` or `roll_back` takes it back to G3, HITL from then on, the G3 approvals voided, for every stop reason (before, only after the G7 feedback was gone); `terminate` → `cancelled`. An expired or mismatched decision is voided, not acted on.
- **L1 runs** (version 1.13, ADR-M33 §2.9, FR-03, D-09 T09): the agent works in its sandbox, but nothing is committed or pushed. The runner reads the sandbox's `/workspace` (Docker archive, run sandboxes only), treats it as untrusted, streams it, leaves out what the ignore rules of the start commit ignore (for example `node_modules`), computes the proposal in its own clone with hardened git and stores it through `EvidenceStore`. The run ends `succeeded_proposal_only`; the intent is `paused` at G4 and Person A takes the proposal forward. No new run starts by itself.
  - Version 1.37 (ADR-M64, QUESTIONS #335–#337): a person with a role in `access.evidence_read_roles` downloads the patch through the api (`GET /v1/intents/:intent/runs/:run/proposal`, `sdlc evidence proposal`), which checks its SHA-256 against `evidence_items` first and audits every read (`evidence.proposal_read`). Person A then ends the intent with a G4 rejection (`sdlc gate reject G4`, `/reject G4`) and a link to where the work continues; the workflow moves it to `rejected`. Only this paused case takes a G4 rejection; the others keep their escalation.
- **G5** (version 1.16, ADR-M34 §2.8, QUESTIONS #131–#134): the step checks the run's result in a fixed order: agent instruction files, then the file scope, then the caps. It reads the runner's records (the diff, the counts of changed paths) and the run's synced spend, never what the agent reports. The G5 input hash binds the run, its contract, its diff, its changed paths and the intent's spend.
  - Instruction files added or changed → `fail instructions_unpinned`, `paused` at G5, a `security` escalation.
  - Version 1.50 (H04, ADR-M93): a secret in the run's added lines (the runner's Gitleaks scan, outside the sandbox) → `fail secret_in_diff`, `paused` at G5, a `security` escalation; a failed or missing scan → `fail secret_scan_failed`, `paused`, a `technical` escalation. Nothing is pushed before G5 passes.
  - Version 1.51 (H05, ADR-M95): the size of the change a person reviews (the runner's `diff_measured`: changed files and lines, lock and generated files counted apart). Over `run.review_limits` (default 40 files, 1500 lines), or not measured, G5 is HITL at every tier: never a breach, no escalation. Person A allows it with an allowing reason code (`generated_change`, `mechanical_change`, `cannot_split`) or requests changes, which takes the intent back to G3 to split the plan.
  - Files outside the plan → `fail out_of_scope` → back to **G3**, no escalation. G3 is HITL at every tier from then on; the earlier G3 approval is voided; the plan the run went outside of is never approved again.
  - The cost cap (the runner's stop, or a synced spend at `budget.stop_percent`) → `fail budget_exceeded`; the iteration cap, the time cap or a stall → `fail run_cap_reached`. Both: `paused` at G5, an `intent` escalation at `run.g5_breach_escalation` (`pause` or higher, rule M22).
  - Otherwise HOTL: a system `pass` → G6 (the block window applies; a request for changes within it starts a new run after G4). HITL (configuration): a person approves; the run's producer never does.
  - The escalation's decision: `resume` → back to G4 (a new run from the latest commit of the default branch), with a budget increase only when the decision names it with an amount (API); `modify` or `roll_back` → back to G3, HITL, the same plan allowed; `terminate` → `cancelled`. A changed G5 input voids the decision, closes the escalation and evaluates G5 again.
  - The budget warning at `budget.warn_percent` is posted during the run: the runner records the run event and the intent's notice in one transaction.
- **G6, the push and the pull request** (version 1.18, ADR-M38 §2.1–§2.6, QUESTIONS #52, #134, #155, #156): when G5 passed a run, G6 waits until the G5 block window closes and checks the freeze (`push`, `open_pr`). Then:
  - the worker issues a single-repository token with `contents: write` for this push only and hands it to the runner as a single-use wrapping token (10 minutes);
  - the runner reads the run's stored diff back (the diff G5 checked; its SHA-256 and the hash of its changed paths must match), builds one commit in a private index on the run's base commit (author `sdlc-agent`, dates of the run's end, so a repeated push makes the same commit) and pushes it to `agent/INT-…` with an explicit refspec and no force. The branch must be absent, at the base commit, or already at the commit. `runs.head_sha` is that commit, recomputed outside the sandbox (ADR-M29 §2.5);
  - the worker finds the open pull request from the branch, or opens it (template T2, filled from codes only), checks that it shows the pushed commit, and links it to the intent (`intents.pr_number`). The intent then waits for CI (C08 PR 2).
  - The runner's refusal (`empty_diff`, `diff_mismatch`, `branch_moved`…) or three failed attempts (a lost runner counts) → `paused` at G6 and a `technical` escalation at `run.failed_run_escalation`; `resume` → G4 (a new run), `modify` or `roll_back` → G3 (HITL), `terminate` → `cancelled`.
  - Once a run of the intent was pushed, the next run starts from the pushed commit, so its changes go on top of the pull request (QUESTIONS #134).
- **G6 reads CI** (version 1.19, ADR-M38 §2.7, QUESTIONS #157–#159): once the pull request is linked, the step reads the pull request, the checks of its head and its open security findings before the intent lock, records them as the run event `ci_checked` (codes, counts, hashes) and decides from the database. The checks it waits for are `verification.required_checks` (empty: every check); success, neutral and skipped pass; failure, error and timed out fail; everything else, a missing check or no check is pending.
  - The pull request closed, merged or showing another commit → `paused`, `technical` escalation.
  - CI failed → `fail ci_failed`: back to **G4** for a new run from the pushed commit while `run.g6_ci_retries` lasts (the agent is told CI failed); then back to **G3**, HITL from then on (N2, FR-13).
  - CI pending past `verification.ci_timeout_minutes` → `paused`, `technical` escalation, no retry used.
  - CI passed: a critical finding → `paused`, `security` escalation; otherwise the matrix with the findings (§6.1): AUDIT and HOTL a system `pass` → G7 (block window); HITL Person B approves. Findings the Git host cannot report → HITL.
- **G7, review and merge** (version 1.21, ADR-M41, QUESTIONS #175–#179): before the intent lock the step reads the pull request (state, head, merge commit, who merged it), the latest review decision of each reviewer and the accounts that authored its commits; it records the reading as the run event `g7_checked` (codes, counts, a hash; never a login or a review text).
  - **Reviews are the approvals** (#175): an `approved` GitHub review of the commit the platform pushed is an approval, a `changes_requested` review a request for changes. Each review is recorded once, with a receipt; a refused one gets one reply with catalog codes only (#176). `/approve G7` by a command is refused; `/reject G7` and `/request-changes G7` are accepted. A dismissed or replaced review voids its approval (FR-17).
  - **Producers** never count (FR-11, §6.2): the intent's creator, the person who allowed each run, the plan submitters, and the platform users who authored a commit of the pull request. **Dual approval** (FR-16): the flags of the plan G3 approved, or Critical risk.
  - **The merge** (#177): G7 passes when a person who is not a producer merged the pushed commit after enough valid approvals; then `in_gate G8`. The platform never merges. A merge before the approvals, of another commit, or by a bot or a producer → a system `fail merged_before_approval`, `paused`, `security` escalation; a pull request closed without a merge or showing another commit → `paused`, `technical` escalation. `resume` → back to G7 (after an early merge, late approvals of the merged commit count); `modify` or `roll_back` → G3, HITL; `terminate` → `cancelled`.
  - **A rejection** → back to G3, HITL from then on, G3 approvals voided (#178). **A request for changes** → G4, a new run from the pushed commit with the reviewer's feedback (#179; version 1.23, E01 PR 2):
    - the request is a review's or a `/request-changes G7` comment's, found by its receipt's ID, never "the latest changes_requested review"; the API and the CLI cannot request changes at G7 (#190);
    - `prepareRun` checks the request again (a review dismissed or replaced, the decider unlinked → the run fails before any secret; paused, `technical` escalation, whose `resume` goes back to G7 when the pull request still shows the pushed commit, otherwise to G4; `modify` / `roll_back` → G3 HITL; QUESTIONS #191) and wraps a third token that may only read pull requests (or issues, for a comment on the intent's issue);
    - the runner reads that one review or comment with it, checks the author, caps the text at 8,000 characters, revokes the token, and gives the text to the agent in a block delimited by nonce markers, as untrusted data. The text is never in Temporal, logs or tables (ADR-M41 §2.7).
  - The gate deadline applies until the merge (FR-12).
- **G8, the release** (version 1.27, ADR-M49, QUESTIONS #220–#222): after the merge the intent waits at G8.
  - **The release pack.** The step recomputes the pack's hashes from the database (no file read). When the latest version is not current, the workflow calls the worker activity `buildReleasePack` (15 minutes, one attempt, idempotent), which reads every stored evidence file back and checks it (ADR-M48 §2.3), then steps again. The worker uses its own SeaweedFS identity `worker-evidence` (the same rights as `api-evidence`); without it the intent waits (`evidence_unavailable`).
  - **The binding** (FR-17). Every pack stores `release_sha256`: its content hash without the G8 parts (G8 decisions, escalations raised at G8). The G8 input binds the merged run, the pull request, the pushed head, the merge commit and that release hash. Any change of the evidence before G8 (an item, an escalation, CI, cost, the AI record's disclosure facts) voids earlier G8 approvals; a new G8 approval makes a new pack version with the same release hash and voids none.
  - **Who** (FR-11): Person B, and the second approver at Critical risk (rule M3). The producers of the merged change (the creator, the people who allowed its runs, the plan submitters) never decide G8. Every G8 is production in v0.1, so always HITL (QUESTIONS #220).
  - **The disclosure note** (FR-43): no project AI record, so no note → a system `fail ai_record_missing` once, and the intent waits. For the client's own format, Person B's approval confirms that the client's note is ready (QUESTIONS #222).
  - **The release.** Approvals complete → the G8 overdue escalation is closed, the pack built again, every HOTL block window must be closed and `release` must not be frozen; then the latest version is sealed (once), `evidence.pack_sealed` and `intent.closed` (coded metrics) are recorded, and the intent ends `done`. A rejection → `rejected`; a request for changes keeps the intent at G8 (the change is merged: a fix needs a new intent). The gate deadline applies (FR-12).
  - **A failed evidence check** (a stored file changed or missing) → `paused` at G8, a `security` escalation (QUESTIONS #221); `resume` → back to G8 (the pack is built again), `terminate` → `cancelled`.
- Retry counts, thresholds, the oversight matrix and SLAs **come from per-project configuration**.

### 6.1. Resolving the oversight mode

```text
mode = matrix[gate][risk_tier]                     # project config (handbook codes table §4)
if gate == G3 and plan.change_flags ∩ FORCED_HITL_G3: mode = HITL
if gate == G6 and findings at or above g6_security_findings.min_severity > 0:
                                                   mode = HITL   # default threshold: high
if gate == G6 and findings unknown (code scanning off or not allowed): mode = HITL   # version 1.19
if gate == G5 and limit breached:                   mode = matrix[G5][risk_tier].on_breach (if set)
if gate == G7: mode = HITL; approvals_needed = 2 if plan.change_flags ∩ DUAL_APPROVAL_G7 or risk == critical else 1
if gate == G8 and environment == production:        mode = HITL   # version 1.27: every G8 is production in v0.1 (QUESTIONS #220)
```

The resolved mode is stored in the gate decision. Changing the matrix is a configuration change (new `config_hash`, audit event).

- Version 1.32 (U01, ADR-M54 §2.4, QUESTIONS #261): the workflow's steps resolve the oversight of the gate an intent waits at through one function (`resolveGateOversight`, core), and the API's `waiting_for` calls the same function with the same facts, so the dashboard never shows another resolution than the one the workflow acts on.

- G6 security findings (design/QUESTIONS.md #19): findings at or above `oversight.g6_security_findings.min_severity` (default `high`) make G6 HITL. A **critical** finding always makes G6 HITL; this is a mandatory rule (M6) that configuration cannot loosen. Findings below the threshold are recorded as evidence, and G6 keeps the matrix mode. The escalation for a critical finding stays in the workflow (state machine above).
- The G7 and production G8 HITL lines are guaranteed by the mandatory rules M2 and M3, so the engine reads them from the matrix like every other cell.

### 6.2. Who may approve

`canApprove(gate, actor, intent, change)`:
- the actor holds the gate's role in `role_bindings` (G1: `person_a`; G2: `person_a`, or `person_b` for High+; G3, G6 High+, G7, G8: `person_b`; second approval: `second_approver`);
- the actor is **not the producer** of the change (commit authors, the person who started the run for that change); agents never approve;
- for dual approval, the two approvals come from two different people.

### 6.3. Approval binding and expiry

Every approval stores `input_sha256` (the reviewed version), `scope` (environment, resources, allowed actions) and `expires_at`. Just before the protected action, the worker recomputes the hash and checks scope and time. Any mismatch or expiry → a `void` decision and the gate is evaluated again.

### 6.4. Escalation

```text
trigger (G5 breach, critical finding, disagreement, stopped run, gate overdue…)
→ create escalation (severity, response level, packet, owner, backup)
→ start timers: acknowledge (SLA), resolve (SLA)
→ no ack: remind → backup owner → governance; work stays frozen
→ decision (resume / modify / roll back / terminate) bound to version, scope, expiry
```

- Timers are Temporal timers inside the intent workflow; they survive restarts.
  - Version 1.9: the only timer of the intent workflow is the gate deadline that raises the escalation (ADR-M30 §2.9); from the raise on, the escalation's clocks are the database's.
  - **Changed in version 1.7 (ADR-M28, QUESTIONS #73):** the escalation clocks are stored in the `escalations` row and advanced by a loop in the worker (`next_check_at`, row lock, idempotent), not by Temporal timers. They survive restarts the same way. The intent workflow (B07) must not add a second timer for the same clock; it raises escalations, asks the freeze check before it acts and waits for the resolution.
- Actions on the pre-approved **safe list** (read-only, sandbox tests, drafts) may continue while waiting; everything else is frozen.
- Approval authority never passes back to the producer.
- SLA defaults: Critical 15 min / 1 h; High 1 h / same working day; Medium 1 working day / 3 working days; Low 3 working days / next planned work.

### 6.5. Kill switch

`sdlc run kill <run>` (or a comment command) → the runner stops the sandbox, revokes the GitHub token and the LiteLLM virtual key, writes `stopped_killed`, and opens an escalation for review. Target: under 5 minutes end to end. Loop detection (more than 3 identical consecutive tool calls, or no progress within the window) stops the run as `stopped_stalled`.

Version 1.22 (task C11, ADR-M42, QUESTIONS #180–#183):

- **Who:** the roles in config `access.kill_roles` (Person A, Person B and governance always, never `viewer`: rule M25), through `sdlc run kill <run ID|INT-…>`, `POST /v1/runs/:run/kill` or `/kill` on the intent's issue. The producer of the run may kill it: killing is containment, never an approval. The operator command `sdlc ops run kill` kills as the system ("the platform" of FR-34).
- **The database is the source of truth.** One transaction under the intent lock: a `queued` run ends `stopped_killed` at once; a run a runner holds goes to `stopping` with `killed_by`; the run event, the audit event, the status notice and the escalation (route `technical`, config `run.kill_escalation`, at least `pause`: rule M26) are recorded with it. A second kill changes nothing; a run that ended otherwise is refused.
- **Two signals carry it to the runner:** the runner reads the run's status on every poll of the agent and stops a `stopping` run (interrupt, then kill), ends it `stopped_killed` and removes the sandbox; the workflow's `kill` signal cancels the run's activity, so a run that waits in Temporal for a runner slot never starts. The worker's reconcile loop sends the signal again for a kill recorded without one. A lost runner: the heartbeat timeout ends the run `stopped_killed` (`abandonRun`).
- **Credentials:** the worker revokes the virtual key at the kill signal and again when the run ends. GitHub revokes an installation token only with the token itself, and only the runner holds the run's tokens: the runner revokes the clone token right after the clone and the push token right after the push, whatever the outcome, so a kill finds none left (§7.1 `revokeShortLivedToken`). A single-use wrapping token that someone else opened sends the run's escalation to the `security` route.
- **Evidence:** after the run is `stopped_killed`, the runner kills every process of the sandbox (a new Docker endpoint for run sandboxes only, in the runner's allowlist and the socket proxy's), waits until the gateway refuses the run's key, then stores the run's diff as evidence, best-effort and bounded (QUESTIONS #183); a failure is only recorded.
- **No lost kill:** every writer that ends a run does it with one conditional update that ends a `stopping` run `stopped_killed` instead.
- The intent is then paused at G4; the escalation's `resume` starts a new run after G4, `terminate` closes the intent (`cancelled`).
- Measured end to end in `pnpm test:runner` (real Docker): well under 5 minutes (FR-34, D-02 §10 item 5d).

Version 1.24 (task C11 PR 2, ADR-M42 §2.7, QUESTIONS #184), loop detection as built:

- **Identical tool calls:** the same tool and the same SHA-256 of the RFC 8785 canonical arguments, volatile fields left out. More than the contract's `loop_threshold` in a row (config `run.loop_detection.identical_tool_calls_max`, rule M10: ≤ 3) → `stopped_stalled` / `loop_detected`.
- **No progress:** no new agent event of any kind for `run.loop_detection.no_progress_window_minutes`, read from the effective configuration when the run starts (rule M27: ≤ 30; a warning under 5) → `stopped_stalled` / `no_progress`.
- The runner stops the agent as at the time cap (interrupt, then kill) and records `loop_detected` with counts only. When several stops are due in one poll: the kill, the cancel, the agent's own end, the time cap, the budget, then the loop checks. The run goes to G5 (`run_cap_reached`, paused with an `intent` escalation); its key is revoked when it ends.

---

## 7. Interfaces (adapters)

Written in TypeScript. This is the **contract** Claude Code implements. Names may change while coding, but responsibilities must stay the same.

### 7.1. Git host

```ts
interface GitHostAdapter {
  createIssueComment(ref: RepoRef, issue: number, body: string): Promise<void>;
  getPullRequest(ref: RepoRef, pr: number): Promise<PullRequestInfo>;
  getChangedFiles(ref: RepoRef, pr: number): Promise<string[]>;
  getCheckStatus(ref: RepoRef, sha: string): Promise<CheckSummary>;
  getApprovals(ref: RepoRef, pr: number): Promise<Approval[]>;
  getReviews(ref: RepoRef, pr: number): Promise<ReviewDecision[]>;
  getCommitAuthors(ref: RepoRef, pr: number): Promise<CommitAuthors>;
  getMergedChange(ref: RepoRef, pr: number): Promise<MergedChange>;
  getCommitParents(ref: RepoRef, sha: string): Promise<string[]>;
  compareChangedFiles(ref: RepoRef, base: string, head: string): Promise<string[]>;
  getFileAtCommit(ref: RepoRef, path: string, sha: string): Promise<string>;
  getBranchHead(ref: RepoRef, branch: string): Promise<string>;
  listPaths(ref: RepoRef, sha: string): Promise<string[]>;
  listFolder(ref: RepoRef, sha: string, folder: string): Promise<FolderEntry[]>; // version 1.55: the memory set
  listPathCommits(ref: RepoRef, head: string, path: string, options: { stopAt?: string; max: number }): Promise<PathCommits>; // version 1.55: who changed the memory
  issueShortLivedToken(ref: RepoRef, scope: TokenScope): Promise<ShortLivedToken>;
  revokeShortLivedToken(token: RedactedSecret): Promise<void>;
  openPullRequest(ref: RepoRef, input: NewPullRequest): Promise<PullRequestInfo>;
  findOpenPullRequest(ref: RepoRef, head: string, base: string): Promise<PullRequestInfo | null>;
  getSecurityFindings(ref: RepoRef, pr: number): Promise<SecurityFindings>;
  getReviewFeedback(token: RedactedSecret, ref: RepoRef, pr: number, reviewId: string): Promise<ReviewFeedback>;
  getIssueComment(token: RedactedSecret, ref: RepoRef, commentId: string): Promise<IssueCommentText>;
  listEventsSince(ref: RepoRef, cursor: EventCursor): Promise<{ events: GitEvent[]; next: EventCursor }>; // v0.1: polling
  oldestEventCursor(cursors: readonly EventCursor[]): EventCursor; // version 1.54: one read per repository
  verifyWebhook(headers: Record<string, string>, rawBody: Buffer): GitEvent; // enabled later
}
```
v0.1: `GitHubAdapter` through a **GitHub App** (short-lived per-repo tokens), reading events by **polling**. Later: `GitLabAdapter`, webhooks.

- Polling and webhooks return the same `GitEvent` type → one handler for `/approve` commands, reviews and CI.
- The `EventCursor` is stored per project in the database, so events are not processed twice after a restart.
- The exact TypeScript interface is `GitHostAdapter` in `@sdlc/contracts` (`platform/packages/contracts/src/git-host.ts`, task B05, ADR-M23). Same twenty-three methods and parameters as above (version 1.54). Notes:
  - `GitEvent` has four kinds: `comment_created`, `review_submitted`, `check_completed`, and (version 1.21) `pull_request_closed`. Each has a stable `id` (the same for polling and webhooks) and a `url` to store as a reference. Only a comment's `body` is free text; it is never stored in an append-only table.
  - Only **new** comments are events; an edited comment never is (QUESTIONS #43).
  - Actors carry the numeric account ID and `type: user | bot`. Users are mapped by the numeric ID only; bots never count as approvers (QUESTIONS #45).
  - `EventCursor` is opaque; the adapter returns `next` and the caller (B06) stores it. A new project starts from `INITIAL_EVENT_CURSOR` (no history).
  - `oldestEventCursor` (version 1.54, task O06 PR 2c, ADR-M106 §2.4, QUESTIONS #679): a cursor never newer than any of the given ones, with no call to the host. The worker reads a repository once for all the projects of a tenant on it, from this cursor; each project stores the read's `next`. An event may come again to a project that handled it; the handler is idempotent by event ID.
  - `getChangedFiles` returns both paths of a renamed file and fails instead of returning a partial list. `getApprovals` returns each reviewer's latest decision, bound to the reviewed commit.
  - `getBranchHead` (version 1.11, task C06, QUESTIONS #109): the commit a branch points to now. G4 reads the head of the default branch as the run's `base_sha`.
  - `listFolder` and `listPathCommits` (version 1.55, task X13 PR 1, ADR-M74 0.2, QUESTIONS #715): the entries directly in one folder of a commit with their kind (file, executable, symbolic link, submodule, folder) and Git object ID, `[]` when there is no such folder, never a partial list; and the commits that changed a path from a head, newest first, with their author's numeric account ID (null without an account), stopped before a given commit or cut at `max` (1–100) with `complete: false`. `adlc memory approve` uses them to hash the memory set and to find its producers.
  - `listPaths` (version 1.15, task C07, QUESTIONS #126): every path of a commit's tree that is not a directory, sorted. G4 reads it at `base_sha` and refuses a run when an agent instruction file other than the pinned one exists (`instructions_unpinned`, ADR-M34 §2.4). A tree the host lists only in part fails (`tree_truncated`) and G4 refuses the run: very large repositories cannot run an agent for now.
  - `getSecurityFindings` (version 1.19, task C08 PR 2, ADR-M38 §2.7, QUESTIONS #157): the open security findings of a pull request, counted per severity (GitHub: code-scanning alerts with a security severity), or unknown (`not_enabled`, `forbidden`). A token of its own with `security_events: read`; never a finding's text or path.
  - `openPullRequest` and `findOpenPullRequest` (version 1.18, task C08, ADR-M38 §2.4): open the pull request of an agent branch into the default branch, never as a draft, with a token of its own that may write pull requests (the adapter's cached token stays read-only); find an open one first, so a repeated call never opens a second. More than one match fails.
  - `getReviews` and `getCommitAuthors` (version 1.21, task E01, ADR-M41 §2.1, QUESTIONS #175): the latest review decision of each reviewer (`approved`, `changes_requested`, `dismissed`), bound to the reviewed commit, with its event ID; and the accounts that authored a pull request's commits (numeric IDs; commits without an account counted). Never a partial list. `PullRequestInfo.mergedBy` names who merged it. G7 counts the reviews itself.
  - A fourth event kind, `pull_request_closed` (version 1.21, E01): a pull request closed, merged or not (the merge event), from the polled pull request list or the `pull_request` webhook; a trigger only.
  - `getReviewFeedback` and `getIssueComment` (version 1.23, task E01 PR 2, ADR-M41 §2.7, QUESTIONS #179, #190): one review with its line comments (at most 50), or one issue or pull request comment, read by its ID with the caller's token (`pull_requests: read`, or `issues: read` for an issue comment): the runner holds no App key. The texts are client data, returned to the caller only.
  - `revokeShortLivedToken` (version 1.22, task C11, ADR-M42 §2.4, QUESTIONS #182): revokes a token of `issueShortLivedToken` with the token itself (GitHub `DELETE /installation/token`); needs no App key, so the runner calls it right after a clone or a push. A token already revoked or expired counts as revoked.
  - `getMergedChange`, `getCommitParents` and `compareChangedFiles` (version 1.43, task L07, ADR-M85 §2.3–§2.4): a merged pull request's files with their status (`added`, `modified`, `removed`, `renamed`, `copied`), its commit count and its merge commit's parents; the parents of one commit; the paths changed between two commits. They find an evaluation task's base commit and hidden tests. Never a partial list (GitHub's compare lists at most 300 files: a bigger change fails).
  - Later tasks add what they need, with a D-03 update.

### 7.2. Agent

```ts
interface AgentAdapter {
  startRun(contract: RunContract, workspace: WorkspaceInfo): Promise<AgentRunHandle>;
  getStatus(handle: AgentRunHandle): Promise<AgentRunStatus>;
  stop(handle: AgentRunHandle, reason: string): Promise<void>;
  collectOutputs(handle: AgentRunHandle): Promise<AgentOutputs>; // plan, log, changed files
}
```
v0.1: `OpenHandsAdapter`. Version 1.45 (X03, ADR-M68, ADR-M88): a second adapter, `OpenCodeAdapter`. Every agent of the register names its adapter (`agents.adapter`: `openhands`, `opencode`); the Run Contract carries it (`agent_adapter`); the runner drives the run with that adapter and the project's image for it (`sandbox.images.<adapter>`; `sandbox.image` is the OpenHands image), and refuses a run whose adapter it does not have (`adapter_unavailable`), whose project has no image for it (`image_not_configured`), or whose image's label `sdlc.agent.adapter` names another adapter (`adapter_mismatch`).
- [External] The OpenHands SDK offers Python and REST APIs. The agent can run in an ephemeral workspace (Docker/Kubernetes) through the **Agent Server**.
- [Proposal] The platform (TypeScript) calls the **Agent Server over REST**; it does not embed the Python SDK. The Agent Server runs inside the sandbox container.
- [Proposal] OpenHands points its model at **LiteLLM**, using the run's virtual key.
- **PoC needed** at the start of M-C: run the Agent Server in a container, call REST from Node.js, get the log and the list of changed files.
- The exact TypeScript interface is `AgentAdapter` in `@sdlc/contracts` (`platform/packages/contracts/src/agent.ts`, task C05, ADR-M29). Same responsibilities; differences from the sketch above:
  - `startRun` takes the contract, the endpoint (the sandbox URL on the run's network and the per-run session key, held by the runner only), the model access (model name, LiteLLM URL, virtual key) and the task (spec reference, plan). The model must be in `allowed_models` (QUESTIONS #79); the tools must be `file_editor`, `task_tracker` or `terminal`.
  - `getStatus` returns the agent's state (`running`, `finished`, `max_iterations`, `stopped`, `error`, `stuck`) and its step count; the runner decides the run status.
  - `stop` interrupts the agent. New `commitWork`: the runner commits what the agent left, with a fixed author that names the agent (QUESTIONS #80). `collectOutputs` returns the files changed since `base_sha`.
  - Version 1.26 (B09 PR 2, ADR-M40 §2.7): `AgentTask.plan.taskText` (the tasks' text of a plan read from a file, with the task count and whether it was cut); the adapter puts it in its own nonce block after "Approved plan:".
  - Version 1.24 (C11 PR 2, ADR-M42 §2.7): the status also carries two counts for loop detection: `events` (events of any kind in the agent's log) and `identicalCalls` (identical tool calls in a row at the end of the log, compared by tool and the SHA-256 of the canonical arguments). Counts only: the arguments stay in the adapter.
  - The runner joins the run's network to reach the Agent Server, and leaves it at clean-up; it listens on no port. What the sandbox reports (changed files, `head_sha`) is recomputed from the pushed branch outside the sandbox before a gate relies on it (C07, C08).

### 7.3. Policy

```ts
interface PolicyEngine {
  maxAutonomy(input: { riskTier: RiskTier; dataClass: DataClass }): AutonomyLevel; // L0–L4 (v0.1: up to L2)
  oversightMode(input: { gate: GateCode; riskTier: RiskTier; changeFlags: ChangeFlag[]; context: GateContext }): { mode: OversightMode; approvalsNeeded: number };
  allowedModels(input: { dataClass: DataClass; taskKind: TaskKind }): string[];
  checkScope(input: { plannedFiles: string[]; changedFiles: string[] }): ScopeResult;
  canApprove(input: { gate: GateCode; actor: UserId; roles: ProjectRole[]; intent: IntentSummary; producers: UserId[] }): Decision;
  isForbidden(input: { action: AgentAction }): boolean; // handbook Ch.4 §4.7 — never overridable
}
```
v0.1: `SimplePolicyEngine` reading YAML. Later: `OpaPolicyEngine` or `CedarPolicyEngine`.

- The exact TypeScript interface is `PolicyEngine` in `@sdlc/contracts` (`platform/packages/contracts/src/policy.ts`, task B01). Differences from the sketch above, same responsibilities:
  - The engine is created from a `ValidatedProjectConfig`: a configuration that `@sdlc/config` has checked against the mandatory rules M1–M15. The adapter never repeats those checks.
  - `canApprove` receives the actor's role bindings (revoked ones never count), the producers for this gate, and the approvals already recorded. It returns the role the person approves under, or a refusal reason. POLICY and AUDIT cells have no approval step; a listed role may still approve a HOTL gate explicitly. Callers decide who the producers are for each gate; for example the intent creator is a producer at G7 but not at G1 (design/QUESTIONS.md #16).
  - `allowedModels` filters the gateway's model list (given when the engine is created) by the provider types allowed for the data class. `taskKind` is not used in v0.1 (design/QUESTIONS.md #17).
  - `maxAutonomy` returns L0 for a data class that may go to no model (`prohibited`) (design/QUESTIONS.md #18).
  - `isForbidden` uses the two action lists in `@sdlc/contracts` (`FORBIDDEN_AGENT_ACTIONS`, `GRANT_REQUIRED_AGENT_ACTIONS`). They are not configuration.

### 7.4. Model gateway and cost

```ts
interface ModelGateway {
  createRunKey(input: { runId: string; labels: CostLabels; maxBudgetUsd: number; models: string[] }): Promise<VirtualKey>;
  revokeKey(keyId: string): Promise<void>;
  getSpend(keyId: string): Promise<SpendInfo>;
}
```
v0.1: `LiteLLMGateway`.

- The exact TypeScript interface is `ModelGateway` in `@sdlc/contracts` (`platform/packages/contracts/src/model-gateway.ts`, task C03, ADR-M24). Same responsibilities; differences from the sketch above:
  - Money is a decimal string (`maxBudgetUsd: "0.5"`, D-05 D6). `createRunKey` also takes the key lifetime and the tenant's budget group.
  - `ensureTenantBudget` creates or updates the tenant's monthly budget at the gateway (a LiteLLM team; UTC calendar month; FR-51).
  - `listModels()` returns the gateway's models with their provider type (`api`, `self_hosted`): the model list the policy engine filters (QUESTIONS #17).
  - `listSpend(range)` returns the calls of a time range with their labels, for the sync into `cost_records`.
- `revokeRunKey(runId)` (version 1.12, ADR-M33 §2.6): revokes a run's key found by the run (LiteLLM key alias `run-<run_id>`), so the key's ID never travels with the run through the Temporal history.
- The Cost Controller (`@sdlc/core`) caps each key at the smallest of the run budget, what is left of the intent budget and what is left of the tenant's month; it refuses a key when either remainder is zero or less. The gateway's budgets are a backstop (QUESTIONS #14).

### 7.5. Evidence storage

```ts
interface EvidenceStore {
  put(tenantId: string, path: string, content: Buffer, contentType: string): Promise<{ uri: string; sha256: string }>;
  get(uri: string): Promise<Buffer>;
}
```
v0.1: `S3EvidenceStore` (on SeaweedFS).

- The exact TypeScript interface is `EvidenceStore` in `@sdlc/contracts` (`platform/packages/contracts/src/evidence.ts`, task C06 session 2b, ADR-M33 §2.9); the adapter is `@sdlc/adapter-evidence-s3` (`@aws-sdk/client-s3`, pinned exactly). Same two methods; notes:
  - `put` returns the size too (`{ uri, sha256, sizeBytes }`). The key is `<store prefix><tenant>/<path>`; every put sends `If-None-Match: *`, so a taken path is refused (`EvidenceError('exists')`) and evidence is never overwritten. Errors are `EvidenceError` codes (`invalid_input`, `exists`, `forbidden`, `not_found`, `unavailable`), never the service's text.
  - Version 1.25 (E02, ADR-M48 §2.2–§2.3): `get` takes `maxBytes`; a larger file is refused (`EvidenceError('too_large')`) before its body is read. The api's store writes under `packs/` with its own identity `api-evidence`, which may also read `proposals/` and `diffs/` to re-check their SHA-256 when a pack is built (a deliberate widening: read only, those two prefixes, capped per item, one item at a time, never logged or kept). Its write includes delete under `packs/`, like the runner's (versioning, `If-None-Match: *`, hashes in `evidence_packs`).
  - Version 1.28 (E05, ADR-M51): a second interface, `EvidenceRetentionStore` (`deleteAllVersions`, `setLegalHold`, `extendLock`, `listKeys`), implemented by `S3RetentionStore` and used only by the worker's retention loop with the identity `worker-purge` (no read). The bucket `evidence` carries a GOVERNANCE object lock of 180 days (set by `seaweedfs-init`): no writer can delete a locked version; only `worker-purge` may bypass it (an archived project, an orphan pack file), and a legal hold refuses even that. Known gap 5: the SeaweedFS filer API on the Compose network skips the lock (QUESTIONS #239, follow-up task).
  - First user: the runner stores L1 proposals at `s3://evidence/proposals/<tenant>/<intent>/<run>.patch` with its own SeaweedFS identity, which may only write under `evidence/proposals/` (no read, no list). SeaweedFS has no write-only action: this identity can also delete there; the bucket `evidence` is versioned, and E02 re-checks the SHA-256 in `evidence_items` (ADR-M33 §2.9 gaps).

---

## 8. Run Contract (light version for v0.1)

[Doc] An earlier internal draft designs a **Signed Run Contract**: a digitally signed "execution contract" that the control plane issues for each run, stating what the agent may do, on which resources, for how long. The full version uses KMS/HSM and mTLS.

v0.1 builds a light version that **keeps the main idea**:

| Field | Example |
|---|---|
| `run_id`, `intent_id`, `tenant_id`, `project_id` | |
| `repo`, `base_sha`, `branch` | `agent/INT-2026-0001` |
| `repo_path` | Version 1.53 (O06 AC2, ADR-M106 §2.4): the project's folder (`projects.repo_path`), empty for the whole repository. The agent works in `<clone>/<repo_path>`; G5 fails a change outside it. A contract that holds it has the next `schema_version`; the runner refuses a non-empty `repo_path` it cannot enforce |
| `planned_files` | File list from the G3 plan |
| `agent_id`, `agent_version`, `instructions_sha256` | From the agent register. Version 1.53 (O06): also `root_instructions_sha256` (null when the agent pins no root file) |
| `agent_adapter` | From the agent register: `openhands`, `opencode` (version 1.45, X03, QUESTIONS #526) |
| `schema_version` | `1` (ADR-M22); `2` since X03 (version 1.45): the contract carries `agent_adapter`, and a contract of schema 1 is refused. Version 1.44 (X02, ADR-M69 §2.6), 1.46 (X04): `3` for a contract with `tool_grants`; the runner accepts `2` and `3`, and a version 2 contract has no register tools |
| `plan_id`, `plan_sha256` | The plan approved at G3 |
| `allowed_tools` | Agent's registered tools ∩ tools of the plan task (template T13, handbook Ch.13 G4; QUESTIONS #34). Version 1.44 (X02, ADR-M69 §2.1, §2.3): may hold register tools as `tool:<key>`; a register tool the plan asks for and the run cannot have fails G4 (`tool_not_runnable`) instead of being dropped |
| `tool_grants` | Version 1.44 (X02, ADR-M69 §2.6), 1.46 (X04, ADR-M87 §5): one entry per register tool: `tool_key`, `tool_version`, `transport`, `image_digest`, `permissions`, `call_rules_sha256` (SHA-256 of the canonical call rules of the permissions, from `@sdlc/contracts`), `backing_services` (`alias:port`), `max_calls` (the run gateway's cap for the tool). The runner refuses a grant it cannot enforce or turn into the gateway's configuration, and a `call_rules_sha256` that differs from its own catalogue (`tool_not_enforceable`) |
| `memory` | Version 1.49 (X12, ADR-M74 §2.6; approved with X13 PR 1; `schema_version` **5**, QUESTIONS #712: schema 4's fields plus `memory`, issued only when the project's `memory.mode` is not `off`; built by X13 PR 2 as `{ reason, version, set_sha256 }` with `reason` `approved`, `none`, `unapproved`, `revoked` or `tree_truncated`, the version and hash set only with `approved`): `{ version, set_sha256 }` of the approved memory set at `base_sha`, or `null` with a reason code. The runner reads memory only when its clone gives the same `set_sha256`; otherwise the run goes on without memory |
| `autonomy_level` | L2 |
| `max_tokens_usd`, `max_iterations`, `max_duration_min`, `loop_threshold` | Caps |
| `allowed_models` | From policy |
| `egress_allowlist` | Services as `alias:port`: `litellm:4000`, `npm-proxy:4873` (section 9, ADR-M25) |
| `issued_at`, `expires_at` | Short validity |
| `signature` | **Ed25519** signature with the platform key |

- The signed bytes are the RFC 8785 canonical JSON of the contract without the signature; `contract_sha256` is their SHA-256 (ADR-M22).
- Validity (`expires_at − issued_at`) covers issue → sandbox start only: `run.contract_validity_minutes` in the project config (default 15, warning above 60; QUESTIONS #33). The run itself is capped by `max_duration_min`. `run.contract_clock_skew_seconds` (default 0) applies to the "not yet valid" check only; expiry has no tolerance.
- The signing key lives in **OpenBao** (Transit engine). The platform sends the contract content to be signed; **the key never leaves OpenBao**.
- The runner verifies the signature with the public key obtained from OpenBao.
- The runner **rejects** contracts that are expired, wrongly signed, or not in the database. It also rejects contracts that differ from the stored one, are not yet valid, are revoked, or belong to a run that already left `queued`. The signature names its key version, so contracts signed before a key rotation verify until they expire (ADR-M22 §2.4).
- Later: add revocation and scheduled key rotation.

### 8.1. Secret manager: OpenBao or HashiCorp Vault

Harry's decision (2026-09-24): **run a Vault-type secret manager from v0.1**.

Licence note [External]:

| | HashiCorp Vault | OpenBao |
|---|---|---|
| Licence | Business Source License 1.1 (since Aug 2023). Not an OSI open-source licence | MPL 2.0 (open source) |
| Origin | HashiCorp, now owned by IBM | Fork of Vault 1.14.0, under the Linux Foundation |
| Internal use | Allowed | Allowed |
| **Inside a product we sell** | BSL forbids offering the software as a competing product → **needs legal review** | No such restriction |
| v0.1 features needed (KV, Transit, AppRole) | Yes | Yes (Vault-compatible API) |

**Decision (Harry, 2026-09-24): use OpenBao.** Platform code uses the **standard Vault API**, so switching remains possible.

### 8.2. Secrets stored in OpenBao

| Secret | Engine | Who may read it |
|---|---|---|
| Run Contract signing key | Transit (non-exportable) | worker (signs), runner (reads the public key) |
| GitHub App private key | KV | api, worker (polls GitHub, posts gate comments, reads specs, issues the run's single-repository token, issues the push token at G6 and opens the pull request; QUESTIONS #42, #44; version 1.18; version 1.23: issues the feedback token of a run that answers a request for changes at G7). **Not the runner**: it receives the run's token from the worker as an OpenBao response-wrapped token (single use), unwraps it once and keeps it in memory only (ADR-M25) |
| LiteLLM master key | KV (`kv/cost-controller/litellm-master-key`) | Cost Controller; LiteLLM through its OpenBao Agent sidecar (AppRole `litellm`, this one path only). One source for both (ADR-M24). Version 1.11 (ADR-M33 §2.5, QUESTIONS #112): the Cost Controller runs in the **worker** process, which logs in with two AppRoles (`worker` and `cost-controller`) and so can use this key. The worker hands the run's virtual key to the runner as a single-use wrapping token, like the GitHub token |
| SeaweedFS identity `api-evidence` (version 1.25, E02, ADR-M48 §2.2) | KV (`kv/api/evidence`) | api (Evidence Packs: read `evidence/proposals/*`, `evidence/diffs/*`, read and write `evidence/packs/*`). Created and rotated by `openbao:bootstrap api-evidence-credentials`; the `api` AppRole already reads `kv/data/api/*` |
| SeaweedFS identity `worker-evidence` (version 1.27, E03, ADR-M49 §2.2) | KV (`kv/worker/evidence`) | worker (G8's release pack: the same rights as `api-evidence`). Created and rotated by `openbao:bootstrap worker-evidence-credentials`; the `worker` AppRole already reads `kv/data/worker/*` |
| SeaweedFS identity `worker-purge` (version 1.28, E05, ADR-M51 §2.3) | KV (`kv/worker/purge`) | worker (the retention loop: delete every version under `evidence/proposals/*`, `diffs/*`, `packs/*`, bypass the GOVERNANCE lock, legal holds and locks, list the bucket; never read). Created and rotated by `openbao:bootstrap worker-purge-credentials` |
| SeaweedFS identity `worker-anchor` (version 1.29, E05 PR 2, ADR-M51 §2.9) | KV (`kv/worker/anchor`) | worker (the daily audit anchor: `Write`, `Read`, `List`, `GetObjectRetention` on the bucket `audit-anchors` only; under COMPLIANCE its write deletes nothing). Created and rotated by `openbao:bootstrap worker-anchor-credentials` |
| Langfuse purge credentials (version 1.31, E08, ADR-M53 §2.6) | KV (`kv/worker/langfuse`) | worker (the retention loop): its **own** Langfuse project key (made once by an operator in the Langfuse UI; Langfuse OSS keys have no scopes), the password of the ClickHouse user `sdlc_purge` (only `ALTER DELETE` on `events_full` and `events_core`, for `APPLY DELETED MASK`) and the SeaweedFS identity `worker-langfuse` (`List:langfuse`, `Write:langfuse/events/otel/*`, never read). Written by `openbao:bootstrap worker-langfuse-credentials`. The collector keeps its own Langfuse key |
| Model provider API keys | KV | **LiteLLM only**, through an OpenBao Agent sidecar (AppRole `litellm`) that renders them to a tmpfs file LiteLLM reads at start-up. No LiteLLM Enterprise licence (QUESTIONS #1) |
| Database and SeaweedFS passwords | KV | The matching process |

- Each process logs in to OpenBao with **AppRole**, receives a short-lived token and can read only its own secrets.
- The agent sandbox has **no** access to OpenBao.
- OpenBao listener 8200 uses **TLS** with a certificate from the company's internal CA; every client verifies it (QUESTIONS #20).

---

## 9. Security

| Topic | What v0.1 does |
|---|---|
| GitHub permissions | GitHub App with minimal permissions. Short-lived tokens, issued by the worker, for the run's repo only: `contents: read` to clone, and (version 1.18) `contents: write` for one push after G5. Used by the runner only; never given to the sandbox. Opening the pull request needs `pull_requests: write`, minted by the adapter for that call. Branch protection on the default branch refuses any push to it (N6). Version 1.22: the runner revokes the clone and push tokens right after their use (C11, ADR-M42 §2.4). Version 1.23: a run that answers a request for changes at G7 gets a third token, `pull_requests: read` (or `issues: read` for a comment on the intent's issue), revoked by the runner right after it read the feedback (E01 PR 2, ADR-M41 §2.7) |
| Branches | The agent only pushes `agent/*`. `main` has branch protection (D-09 section 6) |
| Model keys | The agent only has a LiteLLM **virtual key**, with a cap, revoked when the run ends |
| Sandbox network | Outbound only to LiteLLM and the package proxy (npm first), on an internal Docker network per run; no route to the internet. GitHub is reached by the runner, never by the sandbox: the runner clones and pushes `agent/*` with the run's short-lived single-repository token. Everything else is blocked (ADR-M25) |
| TLS for internal services | Version 1.41 (ADR-M67): the team access proxy uses the company CA or the same internal CA; a throw-away CA on test and developer machines. OpenBao 8200: internal CA, server certificate 1 year, CA 5 years, CA key offline; clients always verify (no skip-verify). Other internal services may reuse the CA later (QUESTIONS #20). Version 1.35 (A10, ADR-M63, QUESTIONS #325): TLS on 8200 on every machine; development machines and CI use a throw-away CA whose key is deleted at once; the files reach OpenBao and the clients through the volumes `openbao-tls` and `openbao-ca` |
| Secrets | Not in the repo, not in images. Fetched from OpenBao at runtime with short-lived tokens |
| GitHub events | v0.1: polling through the GitHub App (no inbound port). When webhooks are enabled: verify signatures, expose only `/webhooks/github` |
| Approvers | Map GitHub accounts ↔ platform users. Check roles + block self-approval |
| Tenant isolation | Every query filters by `tenant_id`. [Proposal] Add PostgreSQL Row-Level Security in Later |
| Object storage (version 1.30, ADR-M52) | Only the S3 API (8333) of SeaweedFS is reachable on the Compose network, each process with its own identity. The master, volume server and filer (HTTP and gRPC) listen on 127.0.0.1 inside the container only, and need JWT keys that `start.sh` makes at each start and keeps nowhere else; the S3 gateway's gRPC port (18333, which SeaweedFS cannot bind apart) refuses calls without the filer key. Iceberg and Lance are off. Admin work only with `docker compose exec seaweedfs weed shell -master=127.0.0.1:9333` |
| Audit | Append-only, hash chain, `verify` command; kept at least 2 years |
| Kill switch | Stop any run and revoke its credentials within 5 minutes (6.5; version 1.22: the path, who, the escalation, ADR-M42) |
| Agents | Only registered, active agents with a pinned model and a matching instructions hash may run |
| Tools for agents (version 1.44, X02; 1.46, X04; ADR-M69, ADR-M87) | Register tools (`tool:<key>`) are approved by the owner and Person B or governance, pinned by image digest, and given to a run only when the plan, the agent, the register and the signed contract all allow it. MCP over HTTP: **one hardened container per tool and run** (`docker/guard.ts`) and **one MCP gateway per run** (agentgateway, pinned by digest). The sandbox reaches the tools only through the gateway (alias `tools` on the run network); the gateway checks the per-run key (it holds only its hash), the tool names, the argument rules of each permission (fixed in `@sdlc/contracts`) and the cap per tool, with a configuration that the runner generates from the contract. Tool containers are on the tool network with the gateway, and each tool with backing services has a service network of its own; never the internet, OpenBao or Docker. Its read-only, short-lived credential reaches the runner as a single-use wrapping token and the container as a file; the sandbox never holds it. Run events hold counts per tool, read from the gateway's logs, never queries or answers. The kill switch revokes the credentials and removes the gateway first, then the containers |
| Agent memory (version 1.49, X12, ADR-M74; approved with X13 PR 1) | Memory is Markdown in the project repository (`.sdlc/memory/*.md`), never on the platform. A run reads it only when the set at `base_sha` is a version a non-producer person approved and nobody revoked; read by the runner outside the sandbox, capped, in its own nonce block framed as data. A run proposes memory only in its own branch and pull request, opened after the code merge, never in the code change, never blocking G7 or G8. Records: version, hashes and counts only |
| Dashboard (version 1.32, ADR-M54) | Served by the api on 127.0.0.1 only; version 1.41: other machines reach it only through the profile `access` (row "Team access", ADR-M67). `GET` only; a strict Content-Security-Policy (no inline script, no third-party origin); the personal token in memory only (never a URL, storage, cookie or log); server text rendered as text. The api serves only the files it listed at start-up. Version 1.40 (ADR-M73): actions are off by default and only on `localhost` or behind the V09 TLS proxy; GitHub OAuth through the platform's App (the GitHub user token dropped), a server-side session (`__Host-` cookie, `SameSite=Strict`), three CSRF layers (SameSite, a CSRF header, the origin check), a single-use passkey assertion bound to each decision; the CSP unchanged |
| Team access (version 1.41, ADR-M67) | Optional Compose profile `access`: an nginx reverse proxy (`sdlc-access`, pinned by tag and digest) publishes the API and the dashboard on **one LAN port** over TLS (`SDLC_ACCESS_BIND_ADDR`, no default; `SDLC_ACCESS_PORT`, 8443); every other port stays on 127.0.0.1, the api included. A host name is required (`SDLC_ACCESS_HOSTNAME`); the certificate comes from the company CA or the A10 internal CA on the server, a throw-away CA on a test or developer machine; files outside the repository, copied into a volume by a one-shot job. Plain HTTP refused (no port 80, `400` on the TLS port), a wrong `Host` refused; a route allow-list (`/`, `/dashboard/`, `/v1/`, `/health/live`, `/health/ready`); HSTS and other security headers, the api's CSP unchanged; body limit equal to the api's, timeouts, a rate limit and a connection limit per client address. The proxy is on a small network of its own with the api only (`access`), never on `sdlc`; it overwrites `X-Forwarded-For`, and the api trusts it only from the proxy's fixed address there (`SDLC_API_TRUSTED_PROXY`). The token only in the `Authorization` header; the proxy logs no header and no query string. With the profile, `SDLC_API_PUBLIC_ORIGIN` is the proxy's origin. The server still accepts no connection from the internet: the port is for the company LAN |

[Doc] Draft section 4.14 has a full threat model based on the OWASP Top 10 for Agentic Applications (ASI01–ASI10). Version 1.42 (H01, ADR-M80): the threat model of an agent run against ASI01–ASI10, its gaps and its attack tests are in ADR-M80.

---

## 10. Deployment (Docker Compose, one server)

| Container | Notes |
|---|---|
| `postgres` | Several databases: `platform`, `temporal`, `litellm`, `langfuse` |
| `temporal` + `temporal-ui` | |
| `litellm` + `valkey` | Valkey for rate limiting and cache (shared with Langfuse) |
| `langfuse-web`, `langfuse-worker`, `clickhouse` | Following Langfuse's self-hosting guide. Version 1.31 (E08, ADR-M53): ClickHouse's admin user has access management, so the bootstrap makes the user `sdlc_purge`; version 1.36 (A10, ADR-M63 §6): that right moves to the loopback-only user `sdlc_admin` (`clickhouse/sdlc-admin.xml`: user grants and `ALTER DELETE` on the two event tables only, no read), and `langfuse` has none; the worker reaches `langfuse-web` (public API), `clickhouse` (HTTP) and the bucket `langfuse` when `SDLC_WORKER_LANGFUSE_URL` is set (`up.sh` with the profile `observability`) |
| `otel-collector` (profile `observability`) | OpenTelemetry Collector (core distribution, pinned) on a small pinned base image with a health check. Tracing of the platform processes and LiteLLM is off unless `SDLC_OTEL_ENDPOINT` points at it (version 1.14, ADR-M35) |
| `seaweedfs` | S3 API for Evidence Packs and Langfuse. Single node. Version 1.28 (E05): `seaweedfs-init` turns on object lock for the bucket `evidence` (GOVERNANCE, 180 days by default; the existing bucket, checked live). Version 1.29 (E05 PR 2): it also creates the bucket `audit-anchors`, versioned, object lock COMPLIANCE 731 days, for the worker's daily audit anchors (ADR-M51 §2.9) Version 1.30 (A12, ADR-M52): only the S3 API listens on the network; the rest on 127.0.0.1 with keys made at each start (`seaweedfs/start.sh`, fails closed); `seaweedfs-init` runs in the container's network namespace |
| `openbao` | Raft storage. Needs an unseal procedure and key backup (see 10.2) |
| `sdlc-api`, `sdlc-worker`, `sdlc-runner` | Built by us. Version 1.12: the runner is a Temporal worker on the task queue `sdlc-runner`, its activity slots = its sandbox limit, so extra runs wait in Temporal (ADR-M33 §2.6). Version 1.13: the runner writes L1 proposals to SeaweedFS with its own write-only identity from OpenBao (`kv/runner/evidence`); its Docker access adds reading the archive of a run sandbox (ADR-M33 §2.9). Version 1.18: the same identity may read run diffs (`Read:evidence/diffs/*`), which the push applies (ADR-M38 §2.2). Version 1.25: the api builds and serves Evidence Packs with its own SeaweedFS identity `api-evidence` (ADR-M48), and waits for `seaweedfs-init` (the versioned bucket `evidence`). Version 1.27: the worker builds G8's release pack with its own identity `worker-evidence` (ADR-M49) and waits for `seaweedfs-init` too. Three processes (runner, api, worker) can now read client code in the evidence store, each with its own key and the same limits. Version 1.39 (V04, ADR-M66): on a release checkout these images, `otel-collector` and the sandbox image `node24` are pulled from GHCR by digest (`platform/deploy/images.lock`, overlay `docker-compose.images.yml`), built by the release workflow, scanned, signed and attested; everywhere else Compose builds them locally. |
| OpenHands sandbox | **Not declared up front**. The runner creates it per run, from the project's sandbox image pinned by digest (config `sandbox.image`), with its own internal network and workspace volume, and removes all three afterwards (ADR-M25) |
| `npm-proxy`, `docker-socket-proxy`, `registry` (profile `sandbox`) | Package proxy for sandboxes (Verdaccio); the runner's limited access to Docker; a local registry for sandbox images (`registry:2`; GHCR after the GitHub Team upgrade). Added in C04 session 3 (ADR-M25, QUESTIONS #54, #59) |
| `sdlc-access`, `access-tls-init` (profile `access`, version 1.41) | Team access (ADR-M67): nginx (`nginxinc/nginx-unprivileged`, alpine, pinned by tag and digest; not in `images.lock`), runs as a non-root user, read-only, no capability; the only service published on a non-loopback address. Not on the `sdlc` network: a small network `access` (`<project>-access`, `SDLC_ACCESS_NETWORK_SUBNET`, default `172.30.1.0/29`, allocation range `172.30.1.0/30`) joined only by `sdlc-access` and `sdlc-api` (always, so the api's networks do not depend on the profile); the proxy's fixed address there (`SDLC_ACCESS_PROXY_IP`, default `172.30.1.6`). The `sdlc` network does not change: existing stacks need no network step (ADR-M67 §2.6). `access-tls-init` (root, no network) copies the certificate files into the volume `access-tls`; renewal without a restart (SIGHUP) |
| `vllm` (profile `models-local`, version 1.48) | A self-hosted model service (ADR-M71), optional and off by default: vLLM (`vllm/vllm-openai`, pinned by tag and digest; not in `images.lock`) on the server's GPU (`deploy.resources.reservations.devices`). Only on a small **internal** network `models` (`<project>-models`, no route to the internet), which LiteLLM always joins and nothing else does; no host port. The weights are in the volume `vllm-models`, downloaded once by an operator (`vllm-pull`, profile `models-local-pull`) and mounted read-only, with `HF_HUB_OFFLINE=1`. Concurrency `SDLC_VLLM_MAX_NUM_SEQS` (vLLM `--max-num-seqs` and LiteLLM's `max_parallel_requests`). Version 1.52 (L01 PR 2, ADR-M71 §4): or vLLM on a separate GPU host (`gpu-host/docker-compose.yml`) |
| `vllm-link`, `vllm-link-tls-init` (profile `models-remote`, version 1.52) | The link to vLLM on a separate GPU host (ADR-M71 §4): nginx (the image of the profile `access`), on `models` with the alias `vllm` (LiteLLM's entry does not change) and on its own network `models-link` (`<project>-models-link`, the only one with a route out); no host port. It calls the GPU host's gateway with mutual TLS: a client certificate of the link's CA, the GPU host's certificate and name verified; four routes only. Never started with `models-local` (`up.sh`). On the GPU host: `vllm`, `vllm-pull` (the same definitions) and the gateway `vllm-gateway`, which requires the client certificate and its name and publishes one port on `SDLC_GPU_LINK_ADDR` only |

- The runner needs control of Docker to create sandboxes.

### 10.1. Internal server of moderate size

Harry's decision (2026-09-24): **an internal server; no need for a high spec yet**.

[Proposal] To fit the server:
- **Limit concurrent runs**: 1–2 sandboxes (configurable). A third run waits in Temporal.
- **Docker Compose profiles**: `core` (required) and `observability` (Langfuse + ClickHouse, the heaviest part). On a small server, enable `observability` later and use LiteLLM spend data meanwhile. Version 1.41: `access` (one small nginx container, ADR-M67) only when people on other machines use the API or the dashboard. Version 1.48: `models-local` (vLLM, ADR-M71) only on a server with a GPU. Version 1.52: `models-remote` (one small nginx container) when vLLM runs on a separate GPU host.
- **Temporal uses PostgreSQL**; no Elasticsearch.
- **API models only** in v0.1. The internal server needs no GPU. Version 1.48 (L01, ADR-M71): a GPU is optional. With one, the profile `models-local` runs vLLM for self-hosted models (the only models a `client_restricted` intent may use, D-07 §4); without one, the server runs as before. Version 1.52 (L01 PR 2): the GPU may also be in a separate GPU host; the profile `models-remote` links to it with mutual TLS (ADR-M71 §4), and the platform server still needs no GPU.
- **Measure real resource use in M-A** before fixing the server spec. No numbers set in advance.
- If possible, run the runner in a **separate VM** on the same server, to isolate Docker permissions.
- **OpenBao**: needs an unseal procedure after a reboot, and unseal keys backed up somewhere safe, off the server.

### 10.2. Unseal key custody and OpenBao recovery (proposal)

**Why it matters:** data in OpenBao is encrypted. After a reboot, OpenBao is "sealed". The **unseal key** is needed to open it. Losing this key = losing every secret.

#### Splitting the key [Proposal]

- At initialisation, split the unseal key into **3 shares**. Any **2 shares** open it (Shamir 3-of-2).
- **3 people hold the 3 shares**, one each. Nobody holds two.
- Why 3-of-2: in a small company we must be able to unseal when one person is away, but one person alone cannot.

| Share | Holder (by role) | Stored where |
|---|---|---|
| Share 1 | A leadership representative (e.g. director / deputy technical director) | Personal password manager + sealed printed copy in the company safe |
| Share 2 | Tech lead / platform owner | Personal password manager + sealed printed copy in the safe |
| Share 3 | Infrastructure operator (IT / DevOps) | Personal password manager + sealed printed copy in the safe |

- Harry chooses **the actual people** for the three roles. If one person holds two roles, pick someone else for one share.
- Printed copies: one sealed, signed and dated envelope per share. The safe has a log of who opened it and when.
- **Never** store unseal keys on the OpenBao server itself, in the repo, in chat or in email.

#### Root token

- Use the **root token** (highest privilege) only for initialisation and initial configuration.
- Once configured → **revoke the root token** immediately.
- When needed again → generate a new root token using key shares (2 people), revoke after use. Log every occurrence in the operations log.
- Daily work uses admin accounts with limited permissions.

#### Backups

| What | Frequency (proposal) | Where |
|---|---|---|
| OpenBao data snapshot (Raft) | Daily | Storage **off the server**, encrypted |
| OpenBao configuration (policies, AppRoles) | On every change | Internal Git repo, **no secrets** |

- A snapshot still needs the unseal key to be used → keeping the keys and keeping the snapshots are two separate jobs, and both are required.

#### Recovery drills

- **First drill: milestone M-A.** Set up OpenBao on a test machine, restore from a snapshot, unseal with 2 shares.
- Then: **every 3 months**, and whenever a key holder changes.
- When a key holder changes (leaves, changes role) → **rekey** (create a new set of shares) and destroy the old envelopes.

#### After a server reboot

1. The operator announces it in the internal channel.
2. Two key holders enter their shares (remotely over a secure connection, or on site).
3. Check that the platform processes reconnect.
4. Record it in the operations log.

[Proposal] This procedure becomes a **runbook** in the handbook (Part III, T11).

#### Later (not in v0.1)

- **Auto-unseal**: opens automatically at start-up using an HSM or a key-management service. More convenient, but needs extra hardware or a service. Consider it when selling to clients or running several servers.

---

## 11. Code layout in the monorepo

```text
platform/
├── apps/
│   ├── api/          # NestJS
│   ├── worker/       # Temporal worker + G1–G8 workflow
│   ├── runner/       # Provisions sandboxes, calls the agent
│   ├── cli/          # sdlc command
│   └── dashboard/    # read-only web pages, served by the api (version 1.32, ADR-M54)
├── packages/
│   ├── core/         # Core modules: registry, gate, cost, evidence, audit, tenancy
│   ├── contracts/    # Types, Run Contract, schemas
│   ├── adapters/
│   │   ├── git-github/
│   │   ├── agent-openhands/
│   │   ├── agent-opencode/   # version 1.47 (X03, ADR-M88)
│   │   ├── model-litellm/
│   │   ├── evidence-s3/
│   │   └── policy-simple/
│   ├── agent-kit/    # Helpers shared by the agent adapters only (version 1.47, X03, ADR-M88 §2.3)
│   └── config/       # Reads gate, budget and rule config (YAML)
├── deploy/
│   └── docker-compose.yml   # + OpenBao bootstrap and backup scripts
└── tests/
    └── integration/  # Scenarios N1–N6, tasks T01–T10 (D-09)
```

---

## 12. Architecture decisions (short ADRs)

| Code | Decision | Why | Trade-off |
|---|---|---|---|
| ADR-M01 | Modular monolith: 4 processes sharing core modules | Small team, easy to deploy and debug | Module boundaries need discipline |
| ADR-M02 | Temporal for the G1–G8 workflow | Waits days for humans, resumes after failures | One more piece of infrastructure to operate |
| ADR-M03 | Approvals via GitHub comments + CLI, no web UI. **Extended by ADR-M54 and ADR-M73:** a read-only dashboard, then actions in the dashboard through the same handlers | No UI to build; users already know it | Harder to get an overview → use CLI + Temporal UI |
| ADR-M04 | Call OpenHands through the Agent Server REST API | Platform is TypeScript; the OpenHands SDK is Python | Depends on the Agent Server API → pin the version |
| ADR-M05 | Run Contracts signed with Ed25519 via **OpenBao Transit**. Secrets in OpenBao, one AppRole per process | The key never leaves the secret manager. Self-hosted. No licence issue when selling | One more system to operate (unseal, backups) |
| ADR-M06 | Simple YAML policy behind an interface | Fast. A path to OPA/Cedar | Complex rules are hard to express |
| ADR-M07 | G7 relies on PR approvals on GitHub | Reuses existing review | Depends on correct branch protection settings |
| ADR-M08 | One internal server, limited concurrent runs, Compose profiles | Matches the infrastructure decision; saves cost | No failover if the server breaks → regular backups |
| ADR-M11 | GitHub events by polling in v0.1, webhooks later | The internal server does not accept inbound internet connections | Delay of tens of seconds; uses API quota → configurable interval |
| ADR-M13 | Oversight as a data-driven matrix (gate × risk + change flags) in project config | The handbook defines oversight by risk; tuning must not need code changes | Matrix must be validated; wrong config can loosen control → config changes audited and reviewed |
| ADR-M14 | Escalations as part of the Temporal intent workflow (timers, signals). **Partly superseded by ADR-M28:** the clocks live in the database, advanced by the worker | Durable clocks, no extra scheduler | Workflow grows more complex → escalation logic kept in its own module with tests |
| ADR-M15 | Minimal agent register in the platform database | Handbook requires owned, pinned, recertified agents | Recertification workflow deferred to Later |
| ADR-M12 | SeaweedFS instead of MinIO, Valkey instead of Redis | MinIO is no longer maintained; Redis licence does not fit a product we sell | Team learns new tools; S3 API / Redis protocol unchanged, so code is unaffected |
| ADR-M67 | Team access through an nginx TLS reverse proxy on one LAN port (profile `access`) | People on other machines need the CLI and the dashboard; the dashboard's actions need an HTTPS origin; nginx has per-client limits built in | A new way in from the LAN; the firewall is the operator's job; the real client address depends on Docker's port publishing |

ADR-M09 (database/migration tool) and ADR-M10 (OpenHands PoC result) are written during tasks A06 and C01.

---

## 13. Risks

| Risk | Mitigation |
|---|---|
| OpenHands Agent Server changes its API | Pin the version. PoC at the start of M-C. Integration tests |
| Runner has Docker access = broad power | Separate machine/VM. Minimal permissions. Log every action |
| Modular monolith turns into a "big ball of mud" | Lint checks on module dependencies. Architecture review at every milestone |
| Too much infrastructure on one server | Measure in M-A. Limit concurrent runs. Compose profiles |
| Losing the OpenBao unseal key = losing all secrets | Shamir 3-of-2, 3 holders, printed copies in the safe, drills every 3 months (section 10.2) |
| Server reboots when not enough key holders are available | The platform stays down until unsealed. Accepted for v0.1. Auto-unseal later |

## 14. Open questions

- ~~Where to store keys and secrets?~~ → Decided: **OpenBao** from v0.1 (section 8.1).
- ~~Which server?~~ → Decided: internal server, moderate spec (section 10.1).
- Choose **the actual people** for the three key-holder roles (section 10.2). The procedure is proposed.

## 15. References

**Internal**
- design/D-01, D-02, D-07, D-09.

**External** (accessed 2026-09-24)
- OpenHands Software Agent SDK: https://github.com/OpenHands/software-agent-sdk and https://docs.openhands.dev/sdk
- Temporal: https://temporal.io/
- SeaweedFS: https://github.com/seaweedfs/seaweedfs
- Valkey: https://valkey.io/
- OpenBao: https://openbao.org/ and https://github.com/openbao/openbao
- Vault vs OpenBao comparison (WZ-IT, Sept 2026): https://wz-it.com/en/blog/openbao-vs-vault-comparison/
- IBM engineers hatch Linux Foundation HashiCorp Vault fork (TechTarget): https://techtarget.com/searchitoperations/news/366563095/IBM-engineers-hatch-Linux-Foundation-HashiCorp-Vault-fork
- LiteLLM, Langfuse: see D-07.

---

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-09-24 | Claude (draft) | First version |
| 0.2 | 2026-09-24 | Claude (draft) | Vault-type secret manager from the MVP (OpenBao proposed). Moderate internal server: run limits, Compose profiles |
| 0.3 | 2026-09-24 | Claude (draft) | OpenBao confirmed. Unseal key custody, root token, backups, drills (10.2) |
| 0.4 | 2026-09-24 | Claude (draft) | After review: SeaweedFS, Valkey, GitHub polling (ADR-M11, M12), clearer G5 and Level 1, added `api_tokens` |
| 1.0 | 2026-09-24 | Claude, approved by Harry | Handbook alignment: oversight resolution, 2+N approval rules, approval binding and expiry, escalation with SLA timers, kill switch, agent register, AI record; new state machine; ADR-M13…M15 |
| 1.1 | 2026-09-25 | Claude (task B01), approved by Harry | §6.1: G6 security threshold `min_severity` (critical always HITL, rule M6) and G5 `on_breach`; §7.3: notes on the contracts `PolicyEngine` (validated config, `canApprove` inputs, model list, `prohibited` → L0, forbidden-action lists). QUESTIONS.md #16–#19 |
| 1.2 | 2026-09-25 | Claude, approved by Harry | §8.2: provider keys reach LiteLLM through an OpenBao Agent sidecar (tmpfs), no Enterprise licence; §8.2/§9: TLS on OpenBao 8200 with an internal CA (QUESTIONS #1, #20) |
| 1.3 | 2026-09-26 | Claude (task C02), approved by Harry | §8: `schema_version`, `plan_id`, `plan_sha256`, `allowed_tools`; signed form; contract validity and clock skew from config; rejection list; key rotation (ADR-M22, QUESTIONS #33, #34) |
| 1.4 | 2026-09-26 | Claude (task B05), approved by Harry | §7.1: notes on the contracts `GitHostAdapter` (event kinds, new comments only, numeric account IDs and bots, cursor, later additions); §8.2: the worker reads the GitHub App key (ADR-M23, QUESTIONS #42, #43, #45) |
| 1.5 | 2026-09-26 | Claude (task C03), approved by Harry | §7.4: notes on the contracts `ModelGateway` (decimal money, tenant budget group, `listModels`, `listSpend`) and the Cost Controller caps; §8.2: the LiteLLM master key has one source, read by the Cost Controller and the LiteLLM sidecar (ADR-M24) |
| 1.6 | 2026-09-27 | Claude (task C04), approved by Harry | §4: note, the runner clones and pushes (flow and D11 updated in C08); §8: `egress_allowlist` names services; §8.2: the runner no longer reads the GitHub App key, token handed over response-wrapped; §9: sandbox network is LiteLLM and the package proxy only, per-run internal network; §10: sandbox image by digest, profile `sandbox` (QUESTIONS #44, #52–#54, #59; ADR-M25) |
| 1.7 | 2026-09-27 | Claude (task B11), approved by Harry | §6.4 and §12 (ADR-M14): escalation clocks stored in the database and advanced by the worker, not Temporal timers; B07 adds no second timer (QUESTIONS #73, ADR-M28) |
| 1.8 | 2026-09-27 | Claude (task C05, session 2), approved by Harry | §7.2: notes on the contracts `AgentAdapter` (endpoint and session key, model from `allowed_models`, agent states, `commitWork`, outputs recomputed outside the sandbox) (ADR-M29, QUESTIONS #79, #80) |
| 1.9 | 2026-09-27 | Claude (task B07, session 2), approved by Harry | §6 general rules: the HOTL block window, C06 waits for it, overdue human gates; §6.4 the gate deadline is the workflow's only timer (ADR-M30 §2.4b, §2.9; QUESTIONS #88, #90) |
| 1.10 | 2026-09-27 | Claude (task B12), approved by Harry | §5.2 Project AI Record: codes only, version history, write roles, the G1 check at the submit (ADR-M32, QUESTIONS #103–#106) |
| 1.11 | 2026-09-27 | Claude (task C06, session 1), approved by Harry | §6: G4 check order, blocked is final, failed checks wait at G4, G4 bound to the run proposal; §7.1: `getBranchHead` (ten methods); §8.2: the worker holds the Cost Controller AppRole, the virtual key is handed over wrapped (ADR-M33, QUESTIONS #108–#112) |
| 1.12 | 2026-09-27 | Claude (task C06, session 2a), approved by Harry | §6: the run after G4 (round, G5, failed or lost runs escalated, resume); §7.4: `revokeRunKey`; §10: the runner's task queue (ADR-M33 §2.6–§2.7) |
| 1.13 | 2026-09-27 | Claude (task C06, session 2b), approved by Harry | §6: L1 runs end with a proposal stored as evidence; §7.5: `EvidenceStore` as built (size, never overwritten, error codes, the runner's write-only identity); §10: the runner's evidence identity and archive read (ADR-M33 §2.9) |
| 1.14 | 2026-09-30 | Claude (task A08), approved by Harry | §5.3: Langfuse also receives the api and worker traces; new OpenTelemetry Collector; §10: container `otel-collector` in the profile `observability` (QUESTIONS #4, ADR-M35) |
| 1.15 | 2026-10-03 | Claude (task C07, PR 1), approved by Harry | §7.1: `listPaths` (eleven methods), a truncated tree is refused; §6: the runner checks and stores the run's changes, and stops the run at the budget (ADR-M34, QUESTIONS #126, #130) |
| 1.16 | 2026-10-03 | Claude (task C07, PR 2), approved by Harry | §6: the G5 step, its outcomes and the escalation's decisions; state machine and diagram D12: G5 → Escalated causes, Escalated → G4 / G3 / Cancelled (ADR-M34 §2.8–§2.9, QUESTIONS #131–#134) |
| 1.17 | 2026-10-03 | Claude (task B08), approved by Harry | §6: the spec is the file on the default branch, checked again at G2–G4 before the transaction; changed or unreadable → back to G2; state machine and diagram D12: G3 → G2, G4 → G2 (ADR-M39, QUESTIONS #160–#164) |
| 1.18 | 2026-10-03 | Claude (task C08, PR 1), approved by Harry | §4: diagram D11, the runner pushes after G5 and the worker opens the pull request; §6: G6, the push and the pull request, state machine and D12 (push or pull request refused → Escalated); §7.1: `openPullRequest`, `findOpenPullRequest` (thirteen methods); §8.2, §9: the push token; §10: the runner reads run diffs (ADR-M38, QUESTIONS #134, #155, #156) |
| 1.19 | 2026-10-03 | Claude (task C08, PR 2), approved by Harry | §6: G6 reads CI (outcomes, retries, N2, timeout, findings), state machine and D12 (G6 → G4 on a CI failure with retries left; CI timeout → Escalated); §6.1: unknown findings → HITL; §7.1: `getSecurityFindings` (fourteen methods) (ADR-M38 §2.7, QUESTIONS #157–#159) |
| 1.20 | 2026-10-03 | Claude (task B09, PR 1), approved by Harry | §6: the plan is a submitted file on the default branch, checked again at G3–G4 before the transaction; a new plan at G4 → back to G3; a changed file → held until submitted again; the run's tools from the plan; state machine and diagram D12: G4 → G3 (ADR-M40, QUESTIONS #165–#168) |
| 1.21 | 2026-10-03 | Claude (task E01, PR 1), approved by Harry | §6: G7, review and merge (reviews are the approvals, producers, dual approval, the merge by a person, early merge and closed pull request escalated, G7 → G3 on a rejection, G7 → G4 on a request for changes in PR 2); state machine and diagram D12; §7.1: `getReviews`, `getCommitAuthors` (sixteen methods), `mergedBy`, the event `pull_request_closed` (ADR-M41, QUESTIONS #175–#179) |
| 1.22 | 2026-10-03 | Claude (task C11, PR 1), approved by Harry | §6.5: the kill switch as built (who, `stopping`, the runner's poll and the workflow's `kill` signal, the escalation at the kill, `resume` / `terminate`, credentials, the killed run's diff, measured time); §7.1: `revokeShortLivedToken` (seventeen methods); §9: tokens revoked after use; state machine and diagram D12: `resume` and `terminate` after a killed or failed run (ADR-M42, QUESTIONS #180–#183) |
| 1.23 | 2026-10-04 | Claude (task E01, PR 2), approved by Harry | §6 G7: a request for changes → G4, the request found by its receipt, the worker's re-check, the feedback token, the runner's read, never stored; the API and the CLI cannot request changes at G7; §7.1: `getReviewFeedback`, `getIssueComment` (nineteen methods); §8.2, §9: the feedback token; state machine and diagram D12: Escalated → G7 and → G3 after the G7 feedback was gone (ADR-M41 §2.7, QUESTIONS #179, #190, #191) |
| 1.24 | 2026-10-04 | Claude (task C11, PR 2), approved by Harry | §6.5: loop detection as built (identical tool calls, no progress, the order of stops, rule M27); §7.2: `AgentRunStatus` counts `events` and `identicalCalls` (ADR-M42 §2.7, QUESTIONS #184) |
| 1.25 | 2026-10-04 | Claude (task E02), approved by Harry | §5.2: the Evidence Builder as built (api process, one pack per build, hash re-check, contents); §7.5: `get` with `maxBytes`, the api's evidence identity; §8.2: the secret `kv/api/evidence`; §10: the api's identity and `seaweedfs-init` (ADR-M48, QUESTIONS #215–#219) |
| 1.26 | 2026-10-04 | Claude (task B09, PR 2), approved by Harry | §6: the plan in the agent's prompt; the decisions on a failed run's escalation (`modify` / `roll_back` → G3 for every stop reason); state machine and diagram D12: Escalated → G3 after a failed run; §7.2: `AgentTask.plan.taskText` (ADR-M40 §2.7, ADR-M33 §2.7, QUESTIONS #169, #210, #211) |
| 1.28 | 2026-10-04 | Claude (task E05, PR 1), approved by Harry | §5.2: the retention loop; §7.5: `EvidenceRetentionStore`, the object lock, gap 5; §8.2: the secret `kv/worker/purge`; §10: the lock on `evidence` (ADR-M51, QUESTIONS #235–#239) |
| 1.27 | 2026-10-04 | Claude (task E03), approved by Harry | §5.2: the worker builds the release pack; §6: G8 (the release pack, the binding to `release_sha256`, who, the disclosure note, the release, a failed evidence check), state machine and diagram D12 (G8 → Escalated, Escalated → G8 and → Cancelled); §6.1: every G8 is production in the MVP; §8.2: the secret `kv/worker/evidence`; §10: the worker's identity (ADR-M49, QUESTIONS #220–#222) |
| 1.29 | 2026-10-04 | Claude (task E05, PR 2), approved by Harry | §5.2: the daily audit anchor; §8.2: the secret `kv/worker/anchor`; §10: the bucket `audit-anchors` (COMPLIANCE, 731 days) (ADR-M51 §2.9) |
| 1.30 | 2026-10-04 | Claude (task A12), approved by Harry | §9: object storage row (loopback binding, keys made at each start, the S3 gRPC port); §10: `seaweedfs` and `seaweedfs-init` (ADR-M52, QUESTIONS #239, #245, #246) |
| 1.32 | 2026-10-07 | Claude (task U01, PR 1), approved by Harry | §5.1: the api serves the read-only dashboard, new row `dashboard`; §6.1: one oversight resolution for the workflow and `waiting_for`; §9: the dashboard row; §11: `apps/dashboard` (ADR-M54, QUESTIONS #255, #260–#263) |
| 1.31 | 2026-10-05 | Claude (task E08), approved by Harry | §5.2: the Langfuse purge in the retention pass; §8.2: the entry `kv/worker/langfuse`; §10: ClickHouse access management, what the worker reaches (ADR-M53, QUESTIONS #250–#253) |
| 0.5 | 2026-09-24 | Claude | Translated into English. Principles renamed AP1–AP7 (to avoid clashing with phase codes P1–P6). ADRs listed in order. Content unchanged |
| 1.33 | 2026-10-08 | Claude (coordinator), approved by Harry | Sources: citations of an unpublished earlier draft removed before the repository goes public; meaning unchanged |
| 1.34 | 2026-10-08 | Claude (task S01), approved by Harry | §6: G2 needs acceptance criteria, counted with the spec's hash (ADR-M61, QUESTIONS #290–#292) |
| 1.37 | 2026-10-09 | Claude (task C13, PR 1), approved by Harry | §6: the L1 proposal's download and the end of the intent by a G4 rejection; state machine and diagram D12: Running → ProposalReady → Rejected (ADR-M64, QUESTIONS #335–#337) |
| 1.35 | 2026-10-09 | Claude (task A10, PR 1), approved by Harry | §9: TLS on OpenBao 8200 on every machine; the throw-away CA of development machines and CI; the volumes `openbao-tls` and `openbao-ca` (ADR-M63, QUESTIONS #325) |
| 1.36 | 2026-10-09 | Claude (task A10), approved by Harry | §10: ClickHouse's access management moves from `langfuse` to the loopback-only `sdlc_admin` (ADR-M63 §6, QUESTIONS #330) |
| 1.38 | 2026-10-10 | Claude (coordinator), approved by Harry | Wording only: "MVP" retired; v0.1.0 is the "v0.1 baseline", unscheduled work is "Later"; meaning unchanged (QUESTIONS #360) |
| 1.39 | 2026-10-10 | Claude (task V04), approved by Harry | §10: the platform images and the sandbox image `node24` of a release are published on GHCR (amd64, arm64), scanned, signed and attested; a release checkout pulls them by digest, everywhere else they are built locally (ADR-M66, QUESTIONS #370, #371) |
| 1.40 | 2026-10-10 | Claude (task V11), approved by Harry | §5.1, §9: actions in the dashboard (sign-in, session, CSRF, passkey step-up); §12 ADR-M03 note (ADR-M73, QUESTIONS #375–#380) |
| 1.41 | 2026-10-12 | Claude (task V09, PR 1), approved by Harry | §9: team access through a TLS reverse proxy (new row), the dashboard and TLS rows point to it; §10: `sdlc-access`, `access-tls-init`, the network `access` for the proxy and the api, the proxy's fixed address there; §10.1: the profile `access`; §12: ADR-M67 (QUESTIONS #405–#409) |
| 1.42 | 2026-10-13 | Claude (task H01, PR 1) | §9: pointer to the threat model (ADR-M80, QUESTIONS #455–#459 block); no change of meaning |
| 1.43 | 2026-10-20 | Claude (task L07, PR 2), approved by the repository owner (ADR-M85) | §7.1: `getMergedChange`, `getCommitParents`, `compareChangedFiles` (twenty-two methods) for a project's own evaluation tasks (ADR-M85 §2.3–§2.4, QUESTIONS #485) |
| 1.44 | 2026-10-21 | Claude (task X02), approved by the repository owner on 2026-10-22 with ADR-M69 (accepted) | §8: `allowed_tools` may hold `tool:` codes, new field `tool_grants`, `schema_version` 2; §9: new row "Tools for agents" (ADR-M69, QUESTIONS #516–#520) |
| 1.45 | 2026-10-22 | Claude (task X03, PR 1), approved by the repository owner in the X03 plan | §7.2: the second adapter and how the runner chooses the adapter and the image; §8: `agent_adapter`, `schema_version` 2 (the X02 proposal's `tool_grants` moves to 3) (ADR-M68, ADR-M88, QUESTIONS #526, #528) |
| 1.46 | 2026-10-22 | Claude (task X04), approved by the repository owner on 2026-10-22 with ADR-M69 (accepted) | §8: `schema_version` 3 for `tool_grants`, `call_rules_sha256`, `max_calls` as the gateway's cap; §9: "Tools for agents" with one MCP gateway per run and a service network per tool (ADR-M69, ADR-M87 §5, QUESTIONS #529–#532) |
| 1.47 | 2026-10-22 | Claude (task X03, PR 3), approved by the repository owner in the X03 PR 3 plan | §11 code layout: `adapters/agent-opencode` and `agent-kit` (merged in X03 PR 2, ADR-M88 §2.3); no change of meaning |
| 1.48 | 2026-10-24 | Claude (task L01, PR 1), approved by Harry in the L01 plan | §10: the container `vllm` in the optional profile `models-local`, the internal network `models`; §10.1: a GPU is optional, "API models only" kept for a server without one (ADR-M71, QUESTIONS #546–#550) |
| 1.49 | 2026-10-24 | Claude (task X12), **proposed** with ADR-M74 | §8: contract field `memory`, `schema_version` 4; §9: row "Agent memory" (ADR-M74, QUESTIONS #571–#575) |
| 1.50 | 2026-10-24 | Claude (task H04), approved by Harry in the H04 plan | §6 G5: the secret scan of the run's added lines (`secret_in_diff`, `secret_scan_failed`; ADR-M93, QUESTIONS #586–#590) |
| 1.51 | 2026-10-26 | Claude (task H05), approved by Harry in the H05 plan | §6 G5: the review size limits (`run.review_limits`, `review_too_large`, `review_size_unknown`, the split at G3; ADR-M95, QUESTIONS #456, #601–#605) |
| 1.52 | 2026-11-11 | Claude (task L01 PR 2), approved by Harry in the L01 PR 2 plan | §10: the containers `vllm-link`, `vllm-link-tls-init` in the optional profile `models-remote`, the network `models-link`; §10.1: vLLM may run on a separate GPU host, linked with mutual TLS (ADR-M71 1.1 §4, QUESTIONS #666–#669) |
| 1.53 | 2026-11-12 | Claude Code (task O06), approved by Harry (QUESTIONS #677, #678) | §6 Run Contract: `repo_path` and `root_instructions_sha256`; the agent works in the project's folder; G4 checks the two pinned files, G5 fails a change outside the folder; one poll per repository (ADR-M106 1.1 §2.4) |
| 1.54 | 2026-11-12 | Claude Code (task O06 PR 2c), approved by Harry (QUESTIONS #679) | §7.1: `oldestEventCursor` (twenty-three methods): one read of a repository for all the projects of a tenant on it (ADR-M106 1.3 §2.4) |
| 1.55 | 2026-11-13 | Claude Code (task X13 PR 1), approved by Harry in the X13 plan (QUESTIONS #711–#715) | §7.1: `listFolder` and `listPathCommits` (twenty-five methods) for agent memory; §8 `memory` in schema 5 and §9 "Agent memory" approved (ADR-M74 0.2) |
