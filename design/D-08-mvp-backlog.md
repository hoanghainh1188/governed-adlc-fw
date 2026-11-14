# D-08. Platform backlog

| Item | Value |
|---|---|
| Version | 1.71 |
| Date | 2026-10-29 |
| Status | **Approved** (Harry, 2026-09-24) — version 1.0, aligned with the handbook (tag `design-v1.0`) |
| Readers | Tech lead, developers, Claude Code |
| Related documents | D-02 (FR/NFR), D-03 (architecture), D-05 (data), D-07 (tokens), D-09 (sample repo) |
| Attachment | [D-08-backlog.csv](D-08-backlog.csv) (for creating GitHub issues with `scripts/create-issues.py`) |

> Generated from a single data source. Edit the data, then regenerate this file and the CSV together.

---

## 1. Purpose

- Split the platform's work into **small tasks, each fitting one Claude Code session**, release after release (v0.1.0 is the baseline; QUESTIONS #360).
- Each task has: dependencies, related requirements (FR/NFR), code area, **acceptance criteria**.
- Serves as the list for GitHub issues and assignments.

## 2. Conventions

| Field | Meaning |
|---|---|
| ID | `A` = M-A, `B` = M-B, `R` = M-0 (sample repo), `C` = M-C, `E` = M-D (`E` avoids confusion with document codes `D-xx`), `U` = user interface (MVP+1, started early), `S` = spec tools and `K` = document knowledge (before the trial M-E), `V` = the trial M-E (validation by the community) and its usability round UX, `X` = extensions (agents, tools, knowledge, Git hosts), `L` = models, `O` = operations on a server, `H` = hardening (security and data) |
| Size | **S** ≈ 1 session · **M** ≈ 1–2 sessions · **L** ≈ split into 2–3 sessions. [Proposal] Relative estimate, not person-hours |
| Depends on | Tasks that must be finished first |
| Acceptance criteria | Conditions for the PR to be approved. Claude Code writes tests for them |

[Proposal] No dates or assignees here. Assignment and deadlines are decided by Harry.

---

## 3. Overview


| Milestone | Content | Tasks | Sizes |
|---|---|---|---|
| M-A | Foundation: infrastructure, security, audit | 11 | S×7 · M×4 |
| M-B | Intent + G1–G3 | 13 | S×4 · M×8 · L×1 |
| M-0 | Sample pilot repo (separate repo, right before M-C) | 4 | S×1 · M×2 · L×1 |
| M-C | Run + G4–G6 | 12 | S×3 · M×8 · L×1 |
| M-D | G7–G8 + evidence + cost | 8 | S×5 · M×3 |
| Pre-M-E | Before the trial M-E: spec tools and document knowledge (QUESTIONS #285) | 4 | S×2 · M×2 |
| M-E | The trial, run by the community (QUESTIONS #340) | 3 | S×1 · M×2 |
| UX | Friendlier for users and deployers: v0.1.1, v0.2.0, then v0.3.0 with the agent measures and `sdlc help`; V17 in v0.8.0 (QUESTIONS #355, #364, #420, #424) | 15 | S×3 · M×10 · L×2 |
| DEV | Rules as checks for contributors and Claude Code: a rules register, hooks, lint and tests (QUESTIONS #479) | 1 | M×1 |
| EVAL | Evaluation for managers: they plan evaluations, get reports and recommendations to improve agents, prompts and models; on the server and on developer machines. After v0.3.0, before EXT (QUESTIONS #450) | 7 | S×2 · M×4 · L×1 |
| EXT | Other Git hosts first, then other agents, tools for agents, document knowledge: v0.6.0, X12 in v0.7.0 (QUESTIONS #361, #420, #424; v0.5.0 has the X09 spike) | 9 | S×5 · M×2 · L×2 |
| Models | Self-hosted models: L01 PR 1 and L03 in v0.6.0; then L01 PR 2 and the L03b measurement (QUESTIONS #362, #424) | 3 | S×2 · M×1 |
| Server | A team on a server: v0.7.0 with O01, O02, H04, H05, V15; v0.8.0 with H02, H03, V16; O03 in v0.10.0; O04, O05 in v0.11.0; toward v1.0 (QUESTIONS #363) | 19 | S×5 · M×14 |
| Later | Not scheduled yet (was "MVP+1"; U01–U03 were started early there and are done; U07 and U08 are done in v0.8.0) | 18 | S×4 · M×8 · L×6 |
| **Total** | | **127** | |

### Order and dependencies between milestones

```mermaid
flowchart LR
    MA["M-A Foundation"] --> MB["M-B Intent + G1–G3"]
    MB --> MC["M-C Run + G4–G6"]
    M0["M-0 Sample repo"] --> MC
    MC --> MD["M-D G7–G8 + evidence"]
    MD --> MP["Pre-M-E S01, S02, K01, C13<br/>spec tools, WeKnora spike (K02 deferred), L1 proposal"]
    MP --> ME["M-E Trial by the community (V01–V03, release v0.1.0)"]
    ME --> UX["UX V04–V13, U05, U06, L02: friendlier (v0.1.1, v0.2.0, v0.3.0), V17 (v0.8.0)"]
    UX --> EV["EVAL L04–L10: evaluations, reports, recommendations for managers"]
    EV --> EXT["EXT X09 (v0.5.0), X01–X04, X14, X07, X11 (v0.6.0), X12 (v0.7.0)"]
    EXT --> MO["Models L01 PR 1, L03 (v0.6.0), then L01 PR 2, L03b"]
    MO --> SV["Server O01, O02, H04, H05, V15 (v0.7.0), H02, H03, V16 (v0.8.0), O03 (v0.10.0), O04, O05 (v0.11.0), then A10 (v1.0)"]
    ME --> MF["M-F Adjustment (from trial data)"]
    MD --> MU["U01–U03 read-only dashboard, done; U07, U08 decisions in the dashboard (v0.8.0) (Later)"]
```

- M-0 lives in a **separate repo** (`pilot-order-inventory`). Done at the end of M-B, before C09.
- C01 (OpenHands PoC) can start early, right after A02, to reduce risk.

### Critical path (longest chain) [Proposal]

`A01 → A02 → A06 → A07 → B02 → C02 → C04 → C05 → C06 → C07 → C08 → E01 → E02 → E03 → E07 → V01 → V03 → U05 → U06 → U07 → U09`

- Computed from dependencies and task size (S=1, M=2, L=3). To finish sooner: prioritise tasks on this path and run the others in parallel.

---

## 4. Tasks


### M-A — Foundation: infrastructure, security, audit

#### A01. Initialise the TypeScript monorepo

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| S | — | NFR-05, NFR-07 | package.json, pnpm-workspace.yaml, tsconfig*, platform/apps/*, platform/packages/*, lint config |

**Acceptance criteria**

- [ ] AC1: `pnpm install`, `pnpm build`, `pnpm lint`, `pnpm test` pass on the empty repo
- [ ] AC2: Structure apps/ (api, worker, runner, cli) and packages/ (core, contracts, adapters/*, config) as in D-03 section 11
- [ ] AC3: Lint fails when `packages/core` imports `packages/adapters/*` directly

#### A02. Docker Compose: core + observability infrastructure

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| M | A01 | NFR-01 | platform/deploy/docker-compose.yml, platform/deploy/*.env.example, README |

**Acceptance criteria**

- [ ] AC1: Profile `core`: postgres (separate DBs for platform, temporal, litellm), temporal + temporal-ui, litellm + valkey, seaweedfs (S3 API), openbao
- [ ] AC2: Profile `observability`: langfuse web/worker + clickhouse (+ langfuse DB); Langfuse shares seaweedfs and valkey
- [ ] AC3: Every container has a healthcheck; `docker compose --profile core up` becomes healthy
- [ ] AC4: No real secrets in the repo; only `.env.example` files

> Note: Temporal uses PostgreSQL; no Elasticsearch (D-03 10.1)

#### A03. OpenBao bootstrap script

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| M | A02 | NFR-03 | platform/deploy/openbao/* |

**Acceptance criteria**

- [ ] AC1: Initialise with Shamir 3-of-2; print the key shares **once** to the screen, never to a file
- [ ] AC2: Enable KV v2, Transit with Ed25519 key `run-contract`, AppRoles for api / worker / runner / cost-controller
- [ ] AC3: Policies: each AppRole reads only its own secrets (test: runner cannot read the LiteLLM master key)
- [ ] AC4: Re-running the script does not break existing configuration

> Note: Per D-03 sections 8.1, 8.2, 10.2

#### A04. Secrets package: OpenBao client

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| S | A03 | NFR-03 | platform/packages/secrets/* |

**Acceptance criteria**

- [ ] AC1: AppRole login, automatic token renewal, KV read, Transit sign and verify
- [ ] AC2: Integration test against OpenBao in Compose
- [ ] AC3: Never log secret values

#### A05. Config package: project configuration

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| S | A01 | FR-14, NFR-08 | platform/packages/config/* |

**Acceptance criteria**

- [ ] AC1: Read YAML config for: the gate × risk oversight matrix, SLA table, forced-HITL (G3) and dual-approval (G7) change flags, retry counts, default budgets, loop threshold, `evidence_retention_days` (default 180), policy rules
- [ ] AC2: Validate the schema; reject configs that loosen mandatory rules (G1, G7, production G8 must stay HITL); clear error messages from the message catalog
- [ ] AC3: Compute a stable `config_hash` (SHA-256) for the same content

#### A06. Database: migration tool + tenant tables

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| M | A02 | NFR-02, FR-19 | platform/packages/core/db/*, migrations |

**Acceptance criteria**

- [ ] AC1: Choose the ORM / migration tool; record the decision in `design/ADR-M09.md` (requirement: raw SQL supported)
- [ ] AC2: Migrations for: tenants, projects, project_configs, project_ai_records, users, user_identities, role_bindings (2+N roles), api_tokens, git_event_cursors (D-05)
- [ ] AC3: The data access layer **requires** a tenant
- [ ] AC4: Cross-tenant test: tenant A cannot read tenant B data

#### A07. Append-only audit log + hash chain

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| M | A06 | FR-41 | platform/packages/core/audit/*, migrations, platform/apps/cli (verify command) |

**Acceptance criteria**

- [ ] AC1: Triggers block UPDATE/DELETE; the application DB user has no update/delete privilege
- [ ] AC2: Per-tenant hash chain: JCS (RFC 8785) + SHA-256; per-tenant advisory lock
- [ ] AC3: Two concurrent writers never corrupt `seq` / `prev_hash` (test)
- [ ] AC4: `sdlc audit verify` detects a modified record (test by editing directly as an admin user)

> Note: Per D-05 section 7

#### A08. Structured logging + OpenTelemetry

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| S | A01, A02 | NFR-06 | platform/packages/core/observability/*, LiteLLM config |

**Acceptance criteria**

- [ ] AC1: JSON logs include `tenant_id`, `intent_id`, `run_id` when available
- [ ] AC2: OpenTelemetry traces for api and worker
- [ ] AC3: LiteLLM sends traces to Langfuse when the observability profile is on

#### A09. CI for the platform repo

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| S | A01 | NFR-07 | .github/workflows/* |

**Acceptance criteria**

- [ ] AC1: Lint, type check and unit tests on every PR
- [ ] AC2: Integration test job running the Compose core profile
- [ ] AC3: Gitleaks, Semgrep, Trivy run and block critical findings

#### A11. Stop publishing the OpenBao port on the host

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| S | A04 | — | platform/deploy/docker-compose.yml, platform/deploy/.env.example, platform/deploy/README.md, platform/tests/integration/*, design/ADR-M19 |

**Acceptance criteria**

- [ ] AC1: The openbao service publishes no port on the host (QUESTIONS #27, option A); OPENBAO_HOST_PORT removed
- [ ] AC2: The live tests (compose-up, openbao bootstrap, secrets-client) reach OpenBao through a container on the Compose network
- [ ] AC3: The "KNOWN GAP" live test becomes: an AppRole login from the host is not possible (no listener on the host)
- [ ] AC4: A static test fails if any compose file publishes 8200 or 8210 again
- [ ] AC5: ADR-M19 §2.5 and the deploy README describe the real behaviour; runbook T11 shows `docker compose exec` for admin work

> Note: Small. Must be merged before A10 (TLS on the same listener)

#### A12. Close the unauthenticated SeaweedFS filer and volume access

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| S | A02 | NFR-03 | platform/deploy/docker-compose.yml, platform/deploy/seaweedfs/*, platform/tests/integration/*, handbook/03-templates/T11-openbao-runbook.md |

**Acceptance criteria**

- [ ] AC1: No process other than SeaweedFS itself can read, write or delete evidence through the filer API (port 8888), the volume servers or the master without authentication (for example filer and volume JWT signing in `security.toml`, or ports bound to the container only); the S3 API with the per-process identities keeps working
- [ ] AC2: Live test on the pinned SeaweedFS: from another container on the `sdlc` network, a filer GET, an HTTP DELETE and a direct volume read of an evidence object are refused, and a locked version (E05 object lock, legal hold) cannot be deleted by any path except the purge identity's S3 bypass
- [ ] AC3: Admin work (`weed shell`) runs only inside the seaweedfs container (`docker compose exec`); runbook T11 updated; no secret is printed
- [ ] AC4: A static test fails if a compose change makes the filer, volume or master ports reachable without authentication again

> Note: Found by E05 (QUESTIONS #239, ADR-M51 gap 5): today every container on the `sdlc` network (api, worker, runner, LiteLLM, Langfuse, Temporal) can read or delete all evidence through the filer at seaweedfs:8888 with no authentication, bypassing object lock and legal hold; sandboxes are not on that network. Must be done before the trial M-E, before any real client data, so E07 depends on it


### M-B — Intent + G1–G3

#### B01. Policy engine: autonomy, oversight, approvers

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| M | A05 | FR-03, FR-11, FR-14, FR-15, FR-16 | platform/packages/contracts (interface), platform/packages/adapters/policy-simple/* |

**Acceptance criteria**

- [ ] AC1: `maxAutonomy`: critical→L0, high→L1, medium/low→L2 (configurable, never above L2 in the MVP); `client_restricted` only allows self-hosted models
- [ ] AC2: `oversightMode`: resolves HITL/HOTL/AUDIT from the matrix; forced HITL at G3 for flagged changes; G7 always HITL with 2 approvals when flagged or Critical; G8 production always HITL
- [ ] AC3: `canApprove`: approver must hold the gate's role; producers (commit authors, run starter) and agents never count; dual approval needs two different people
- [ ] AC4: `checkScope` (changed files vs plan patterns) and `isForbidden` (handbook Ch.4 §4.7 actions)
- [ ] AC5: Unit tests for every rule, including the matrix edge cases

#### B02. Registry: intents, spec_refs, plans, gate_decisions

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| M | A06, A07, B01 | FR-01, FR-03, FR-10, FR-17 | platform/packages/core/registry/*, migrations |

**Acceptance criteria**

- [ ] AC1: Create intents with code `INT-YYYY-NNNN`, unique per tenant, status `draft`
- [ ] AC2: `max_autonomy` computed by policy at creation; `plans.change_flags` stored
- [ ] AC3: `gate_decisions` append-only, with `oversight_mode`, `approver_role`, bound `input_sha256`, `scope`, `expires_at`; `void` decisions for invalid approvals
- [ ] AC4: Every change is written to the audit log

#### B03. API app (NestJS) + authentication

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| M | A04, A06 | FR-20, NFR-08 | platform/apps/api/* |

**Acceptance criteria**

- [ ] AC1: Authentication with personal API tokens (stored as hashes) issued by an admin
- [ ] AC2: Tenant resolved from the token; every request carries the tenant
- [ ] AC3: Endpoints: intents (create, show, list), gates (approve, reject, request_changes)
- [ ] AC4: Error messages come from the message catalog (English by default)

#### B04. CLI `sdlc`

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| S | B03 | FR-20, NFR-08 | platform/apps/cli/* |

**Acceptance criteria**

- [ ] AC1: `sdlc login`, `sdlc intent create|show|list`, `sdlc gate approve|reject <G> <INT>`
- [ ] AC2: Human-readable output from the message catalog; `--json` mode
- [ ] AC3: Command tests against a mocked API
- [ ] AC4: `sdlc escalation list|show|ack|decide` against the B11 API endpoints (QUESTIONS #77, ADR-M28 §2.7)
- [ ] AC5: `sdlc ai-record show|set` against `GET` / `PUT /v1/projects/:project/ai-record` (B12, QUESTIONS #103, ADR-M32 §2.4)

> Note: The escalation commands need the B11 API (B11 PR 2); the AI record commands need the B12 API

#### B05. GitHub adapter (part 1): App, events, comments

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| M | A04 | — | platform/packages/adapters/git-github/* |

**Acceptance criteria**

- [ ] AC1: GitHub App authentication with the private key from OpenBao; short-lived installation tokens
- [ ] AC2: Read new events (comments, reviews, CI status) by **polling** the GitHub API, with a `since` cursor stored in the DB; webhook signature check kept ready for later
- [ ] AC3: Comment on issues/PRs; read a file at a commit
- [ ] AC4: Implements the `GitHostAdapter` interface exactly (D-03 section 7.1)

#### B06. Event receiver (polling) + comment commands

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| M | B03, B05 | FR-21 | platform/apps/worker (poller), platform/packages/core/commands/* |

**Acceptance criteria**

- [ ] AC1: The poller runs on a schedule (configurable, default 30 seconds) per project; no event processed twice
- [ ] AC2: Accepts `/approve G3`, `/reject G3 <reason>`, `/request-changes G3 <reason>`
- [ ] AC3: Maps the GitHub account (numeric ID) → platform user; checks roles
- [ ] AC4: Bad syntax or missing permission → a reply comment with the reason

> Note: Webhooks are enabled once public infrastructure exists (ADR-M11). One command handler for both polling and webhooks

#### B07. Temporal worker + workflow G1–G3

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| L | B02, B06, B11 | FR-10, FR-12, FR-14, FR-17, FR-22 | platform/apps/worker/* |

**Acceptance criteria**

- [ ] AC1: Workflow follows the D-03 state machine: Draft → G1 → G2 → G3
- [ ] AC2: Oversight resolved per gate (B01); HOTL gates pass only when conditions hold and notify the owner; no gate passes by silence
- [ ] AC3: Approvals bound to version, scope and expiry; re-checked before moving on; mismatch or expiry → `void` and re-evaluate
- [ ] AC4: Overdue gates raise escalations (B11); waiting time recorded
- [ ] AC5: Worker restart mid-way → the workflow continues in the right state (test)

> Note: Can be split into 2 sessions: workflow skeleton, then oversight and binding

#### B08. Spec linking + hash check

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| S | B05, B07 | FR-02 | platform/packages/core/registry/spec* |

**Acceptance criteria**

- [ ] AC1: Link a spec by path + commit; fetch content from GitHub; store SHA-256
- [ ] AC2: Before G3 and before running the agent: re-check the hash; different → back to G2 (scenario N4)

#### B09. Plan submission + G3 approval

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| S | B07 | — | platform/packages/core/registry/plan*, CLI |

**Acceptance criteria**

- [ ] AC1: The plan is a file `.sdlc/plans/INT-....yaml` in the repo (files / path patterns, summary)
- [ ] AC2: The platform reads it, hashes it, stores `plans`; the tech lead approves G3
- [ ] AC3: Plan changed after approval → G3 must be approved again

> Note: Two PRs (ADR-M40, QUESTIONS #165–#169): PR 1 = plan file schema, submission (API, `sdlc plan`, config `access.plan_submit_roles`, rule M24), the re-check at G3 and G4 (a changed file holds the gate until a person submits it again), the submitter never approves G3, the run's tools from the plan; PR 2 (after C08) = the runner reads the plan file at the plan's commit for the agent's prompt and checks its hash

#### B11. Escalation module

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| M | B02, B05 | FR-18 | platform/packages/core/escalation/*, platform/apps/worker (clock loop), platform/apps/api, comment commands |

**Acceptance criteria**

- [ ] AC1: `escalations` table (D-05); create from triggers with severity, response level and decision packet
- [ ] AC2: Routing: owner by type (intent → Person A; technical/security → Person B; policy → governance) and a backup owner
- [ ] AC3: Acknowledge and resolve clocks from the SLA table, stored in the database and advanced by the worker loop (QUESTIONS #73, ADR-M28); no ack → remind → backup → governance
- [ ] AC4: While open: only safe-list actions continue; everything else frozen; authority never passes back to the producer
- [ ] AC5: Acknowledge and decide via the API or `/ack`, `/decide` comments (CLI in B04); decisions bound to version, scope, expiry; every step audited

> Note: Two PRs: PR 1 = table, config, routing, clocks, freeze; PR 2 = comment commands, API, notices. Supersedes ADR-M14 in part: B07 adds no second timer

#### B12. Project AI record + G1 check

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| S | A06, B03 | FR-19 | platform/packages/core/ai-record/*, platform/apps/cli |

**Acceptance criteria**

- [ ] AC1: CLI to create and update the project AI record (versioned, audited)
- [ ] AC2: G1 fails when the record is missing or the intent's data class is not allowed; unknown consent → only `client_restricted` handling
- [ ] AC3: `prod_logs_allowed` exposed to policy for operations tasks

> Note: Codes only, version history, write roles in config (QUESTIONS #103–#106, ADR-M32). AC1: API endpoints and the operator command `sdlc admin ai-record`; the user CLI over the API comes with B04 (AC5)

#### B13. Admin onboarding: projects, users, identities, roles, config

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| M | B03, B12 | FR-11, FR-19 | platform/apps/api (admin), platform/apps/cli (sdlc admin …), platform/packages/core (admin services), design/ADR (next free number) |

**Acceptance criteria**

- [ ] AC1: Decide the tenant-admin model (QUESTIONS from B03, D3: A = new tenant-level role table, B = project `admin` counts as tenant admin); record it in an ADR and D-05
- [ ] AC2: Admin API endpoints and `sdlc admin project|user|identity|role|config`, all through TenantScope; every change audited (IDs, codes, hashes only); roles revoked through revoked_at
- [ ] AC3: GitHub identities in user_identities are linked by the numeric GitHub account ID, never by login (QUESTIONS #45)
- [ ] AC4: Project config upload: validated and hashed by @sdlc/config (mandatory rules; warnings recorded in the config.changed audit event)
- [ ] AC5: Token issuing moves behind the API; `sdlc audit verify` moves behind the API once a tenant admin exists (update CLAUDE.md)
- [ ] AC6: Integration tests: cross-tenant isolation, wrong role refused, audit chain intact
- [ ] AC7: Admin API endpoints for the agent register (C10 has operator commands only, ADR-M31 §2.2), enforcing handbook Ch.20: who approves an agent for use (§20.7) and a change (§20.11), and that Person B or leadership may suspend or quarantine at any time (§20.9)
- [ ] AC8: Before any real project stores a configuration (QUESTIONS #95): a stored configuration whose hash differs only because platform defaults changed is recomputed, saved as a new configuration version with `config.changed` (actor `system`), and used; only a change of the stored YAML itself is refused

> Note: Follows B03 (decision D1). Needed before E07: a real tenant must be set up without direct database access

#### B10. Integration tests G1–G3

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| M | B08, B09, B11, B12 | FR-01…03, FR-10…19 | platform/tests/integration/* |

**Acceptance criteria**

- [ ] AC1: Happy path: create intent → G1 → G2 → G3 (Low risk: G2/G3 HOTL pass; Medium: HITL)
- [ ] AC2: N4: spec edited after G2 → back to G2; approval expired → `void` and re-evaluation
- [ ] AC3: N5: a producer's approval is ignored; wrong role cannot approve
- [ ] AC4: N7: escalation not acknowledged → backup → governance; work stays frozen
- [ ] AC5: N8: Low-risk plan flagged `migration` → G3 is HITL
- [ ] AC6: Missing AI record → G1 fails


### M-0 — Sample pilot repo (separate repo, right before M-C)

#### R01. Sample repo: Vue + NestJS + PostgreSQL skeleton

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| M | — | D-09 | repo pilot-order-inventory |

**Acceptance criteria**

- [ ] AC1: Structure per D-09 section 5; `docker compose up` works
- [ ] AC2: Sample tests for web and api

> Note: Separate repo, not part of the platform monorepo

#### R02. Sample repo: baseline features F1–F6

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| L | R01 | D-09 | repo pilot-order-inventory |

**Acceptance criteria**

- [ ] AC1: F1–F6 per D-09 section 4; fake data
- [ ] AC2: Tests for the stock deduction logic when creating an order

#### R03. Sample repo: CI, security scans, branch protection

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| S | R01 | D-09 | repo pilot-order-inventory/.github/* |

**Acceptance criteria**

- [ ] AC1: CI: lint, type check, tests, build; Gitleaks, Semgrep, Trivy
- [ ] AC2: Branch protection on `main`, CODEOWNERS, PR template per T2

#### R04. Sample repo: specs T01–T10 + AGENTS.md

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| M | R02 | D-09 | repo pilot-order-inventory/docs/specs/*, AGENTS.md |

**Acceptance criteria**

- [ ] AC1: 10 bilingual Japanese–English specs with acceptance criteria
- [ ] AC2: AGENTS.md: build/test commands, conventions; format checked against OpenHands

> Note: PM/BrSE writes the specs; AI may draft them


### M-C — Run + G4–G6

#### C01. PoC: control the OpenHands Agent Server from Node.js

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| S | A02 | — | platform/spikes/openhands/*, design/ADR-M10.md |

**Acceptance criteria**

- [ ] AC1: Run the Agent Server in a container; call REST from Node.js: start, status, stop, fetch logs
- [ ] AC2: Model points at LiteLLM with a virtual key
- [ ] AC3: Record the usable API, the pinned version and limitations in ADR-M10

> Note: Spike: the code may be thrown away; the result is the ADR

#### C02. Run Contract: schema, signing, verification

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| M | A04, B02 | — | platform/packages/contracts/run-contract*, migrations (runs, run_contracts, run_events) |

**Acceptance criteria**

- [ ] AC1: Schema per D-03 section 8; signed via OpenBao Transit
- [ ] AC2: The runner rejects: expired, bad signature, not in the DB
- [ ] AC3: `run_events` is append-only

#### C03. LiteLLM adapter + Cost Controller (part 1)

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| M | A04, A06 | FR-50, FR-51 | platform/packages/adapters/model-litellm/*, platform/packages/core/cost/*, migration cost_records |

**Acceptance criteria**

- [ ] AC1: LiteLLM gets provider keys from OpenBao through an OpenBao Agent sidecar (AppRole `litellm`, read-only kv/litellm/providers/*) rendered to tmpfs; no provider key in .env, the repo or an image on the server; rotation = re-render + restart (QUESTIONS #1)
- [ ] AC2: Create a virtual key per run: cost cap, model list, labels tenant/project/intent/run/gate/agent/data_class
- [ ] AC3: Revoke the key when the run ends
- [ ] AC4: Job syncing spend from LiteLLM → `cost_records` (no duplicates)
- [ ] AC5: Test: over budget → the request is blocked

> Note: LiteLLM requires a database (D-07)

#### C04. Runner: provision and clean up sandboxes

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| L | C02, B05 | FR-30, FR-33 | platform/apps/runner/* |

**Acceptance criteria**

- [ ] AC1: One container per run on its own internal network; sandbox egress to LiteLLM and the package proxy only; GitHub is reached by the runner, never by the sandbox (QUESTIONS #52, ADR-M25)
- [ ] AC2: Clone with a short-lived GitHub token; create branch `agent/INT-...`
- [ ] AC3: Limit concurrent runs (default 1–2, configurable); extra runs wait in a queue
- [ ] AC4: The sandbox has no real model-provider key and no OpenBao access (test)
- [ ] AC5: Remove the container and worktree on success or failure

#### C05. OpenHands adapter

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| M | C01, C04, C03 | FR-31, FR-32 | platform/packages/adapters/agent-openhands/* |

**Acceptance criteria**

- [ ] AC1: Implement `AgentAdapter` (D-03 section 7.2) based on the C01 result
- [ ] AC2: Pass spec, plan and AGENTS.md to the agent
- [ ] AC3: Iteration and time caps; exceeded → stop, record `stop_reason`
- [ ] AC4: Collect changed files, logs and the last commit

#### C06. Automatic gate G4

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| M | C05, C10, B07 | FR-36 | platform/apps/worker (G4), platform/apps/runner (Temporal activity) |

**Acceptance criteria**

- [ ] AC1: Checks: agent registered and active, pinned model, instructions hash matches; autonomy within max; contract valid; key capped; sandbox correct; AI record allows the data class
- [ ] AC2: Critical → `blocked`, the agent does not run (T10)
- [ ] AC3: High (L1) → the agent only submits a proposal, pushes no code; stored as evidence `proposal`, the run ends `succeeded_proposal_only` (T09); G4 is HITL for High
- [ ] AC4: Worker → runner handoff (QUESTIONS #53, #55; ADR-M25 §2.7): Temporal task queue `sdlc-runner`, one long-running activity per run with heartbeats; the runner worker's activity slots = `SDLC_RUNNER_MAX_SANDBOXES`, so extra runs wait in Temporal; a contract that expires while waiting → run `cancelled` (`contract_expired`) and a new attempt; a lost heartbeat → the workflow ends the run (test with a worker restart)

> Note: Moved from C04 session 3 (QUESTIONS #55): the runner process, slot pool, restart clean-up and sweep exist; C06 adds the Temporal side. Agent check: call `checkAgentForRun` (C10, ADR-M31 §2.6) with the SHA-256 of the agent's instructions file read at `base_sha` outside the sandbox, and pass its `modelRef` to the adapter (QUESTIONS #79); on the warning `recertification_overdue`, append the audit event `agent.recertification_overdue` and post a notice to the owner on the intent's issue (ADR-M31 §2.7). HOTL block window (B07, QUESTIONS #88, ADR-M30 §2.4b): never start a run while `hotlBlockWindowOpenUntil` (core) returns a time; the workflow wakes the intent when the last window closes

#### C07. Gate G5: file scope + budget

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| M | C06, C03, B11 | FR-13, FR-52 | platform/apps/worker (G5), platform/packages/core/cost/* |

**Acceptance criteria**

- [ ] AC1: Files changed outside the plan → stop, back to G3 (N1)
- [ ] AC2: Spend at 80% → warning comment; at 100% → stop and raise an escalation (N3)
- [ ] AC3: Owner decision `resume` with more budget → the run continues (bound, not expired)

> Note: Sandbox outputs are untrusted (ADR-M29 §2.5): recompute the changed files and `head_sha` from the pushed branch outside the sandbox before G5 relies on them; C06 session 2b built the pieces (`exportWorkspace`, `mirrorWorkspace`, `computeProposal` in the runner, ADR-M33 §2.9). A cost cap and an iteration cap both end as `stopped_budget`; tell them apart by `stop_reason` (`max_iterations`); both need a human decision to resume (QUESTIONS #21, #82). Decide whether uncommitted edits of a stopped run are kept as evidence

#### C08. Open PR + gate G6 (CI)

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| M | C07, B05 | — | platform/packages/adapters/git-github (PR, checks), platform/apps/worker (G6) |

**Acceptance criteria**

- [ ] AC1: Open a PR from the agent branch, filling template T2 (intent_id, run_id, AI-written parts)
- [ ] AC2: Read CI status by polling (checks API); fail → rerun the agent within the retry limit; no retries left → back to G3 (N2)
- [ ] AC3: An agent push to `main` is blocked by branch protection (N6)

> Note: The runner, not the sandbox, pushes `agent/INT-...` (QUESTIONS #52, ADR-M25): update the D-03 §4 flow and diagram D11 (and the D-02 §5 flow) in this task. Sandbox outputs are untrusted (ADR-M29 §2.5): the changed files and `head_sha` are recomputed from the pushed branch outside the sandbox (reuse the runner's `exportWorkspace` and hardened git of C06, ADR-M33 §2.9). G5 (C07 PR 2, ADR-M34 §2.8–§2.9, QUESTIONS #134): a run after a G5 `resume` starts from the head of the default branch today; once the runner pushes `agent/INT-...`, the next run of the intent continues from that branch. Wait for the G5 HOTL block window before G6 acts (G5 is a passable gate)

#### C09. Integration tests G4–G6 on the sample repo

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| M | C08, R04, B10, C11 | — | platform/tests/integration/* |

**Acceptance criteria**

- [ ] AC1: T01 runs from G1 to G6 successfully
- [ ] AC2: N1, N2, N3, N6 are blocked correctly
- [ ] AC3: T09 only produces a proposal; T10 is refused
- [ ] AC4: Kill switch and loop detection work on a live run
- [ ] AC5: Unregistered or suspended agent cannot run

#### C10. Agent register

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| S | A06 | FR-36 | platform/packages/core/agents/*, migration agents, platform/apps/cli |

**Acceptance criteria**

- [ ] AC1: `agents` table (D-05); CLI to register, activate, suspend, quarantine, retire
- [ ] AC2: Runs refer to a registered agent; runs blocked for non-active agents
- [ ] AC3: Instructions hash stored and checked before each run
- [ ] AC4: Warning to the owner when the last recertification is older than 3 months

#### C11. Kill switch and loop detection

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| M | C04, C05, C03, B11 | FR-34, FR-35 | platform/apps/runner/*, platform/apps/cli, platform/apps/worker |

**Acceptance criteria**

- [ ] AC1: `sdlc run kill <run>` and a comment command; allowed for Person A, Person B, governance
- [ ] AC2: Stops the sandbox, revokes the GitHub token and the LiteLLM virtual key; run ends `stopped_killed`; opens an escalation; under 5 minutes end to end (test)
- [ ] AC3: Loop detection: more than 3 identical consecutive tool calls, or no progress in the window → `stopped_stalled`

#### C12. Scheduled spend sync

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| S | C03, C06 | FR-51, FR-52, FR-53 | platform/apps/worker (schedule), platform/packages/core/cost/* |

**Acceptance criteria**

- [ ] AC1: The worker calls `CostController.syncSpend` on a schedule (settings `SDLC_WORKER_COST_SYNC_*`: interval, look-back window) and once more shortly after each run ends, as ADR-M24 §2.5 says; nothing is double-counted (`ON CONFLICT (tenant_id, source_ref) DO NOTHING`)
- [ ] AC2: Calls LiteLLM writes to its spend log after a run ended are recorded; a run in progress shows its spend in `sdlc cost report` within one interval
- [ ] AC3: A failed or partial sync is logged with its reason counts and retried on the next pass; it never stops the worker or a run
- [ ] AC4: Tests: `pnpm test` (schedule, window, settings), `pnpm test:db` (late spend log rows recorded once, a running run's spend appears), `pnpm test:litellm` if the gateway path changes

> Note: Found by E04 (QUESTIONS #197, ADR-M45 §2.5): `syncSpend` runs only once, when a run ends (`endRunKey`), so late spend logs are lost and running runs show no cost. Needed for D-02 §10 item 6 (every model call has a cost), so E07 depends on it. Changes the worker: one runner/worker session at a time. E03 (ADR-M49 §4): a cost record synced while an intent waits at G8 changes its pack's release hash and voids its G8 approvals; keep late syncs of a run short after it ends, or exclude records synced after the merge from the release hash (decide in C12)


### M-D — G7–G8 + evidence + cost

#### E01. Gate G7: review + merge

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| M | C08 | FR-11, FR-16, FR-17 | platform/apps/worker (G7), PR review poller |

**Acceptance criteria**

- [ ] AC1: G7 passes when the PR has valid approvals under branch protection, bound to the reviewed commit
- [ ] AC2: Producers and agents never count as approvers (FR-11)
- [ ] AC3: Dual approval (Person B + second approver) for flagged change types or Critical risk (N9)
- [ ] AC4: `request changes` → back to running the agent
- [ ] AC5: A person merges the PR (MVP: a human, not the platform); the platform records the merge event

> Note: Change flags (B09, ADR-M40 §2.2, QUESTIONS #166): read them from the plan G3 approved or passed (`plans.change_flags` of the plan whose hash G3 passed), never from a later plan; they are declared in the plan file and approved with it at G3

#### E02. Evidence Builder + Markdown export

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| M | E01 | FR-40, FR-42, FR-43 | platform/packages/core/evidence/*, platform/packages/adapters/evidence-s3/* |

**Acceptance criteria**

- [ ] AC1: Collects: spec + hash, plan, diff, CI/test/scan results, the 8 gate decisions with oversight modes, escalations, cost summary
- [ ] AC2: Includes the client AI disclosure note (`disclosure_note`) in the project's disclosure format
- [ ] AC3: Stored in SeaweedFS under a tenant prefix; manifest with a hash per item
- [ ] AC4: Exports one readable Markdown file (English by default, via the message catalog)

> Note: Builds on C06 session 2b (ADR-M33 §2.9): `EvidenceStore` (`@sdlc/contracts`), `S3EvidenceStore` and the table `evidence_items` exist; L1 proposals are at `s3://evidence/proposals/…`. Re-check the SHA-256 of every item when the pack is built (the runner's identity can delete under `proposals/`; versioning keeps the content). Packs need their own write identity and prefix; decide object lock with E05 (ADR-M33 §2.9 gap 1)

#### E03. Gate G8: release approval, close the intent

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| S | E02 | FR-43 | platform/apps/worker (G8) |

**Acceptance criteria**

- [ ] AC1: Person B approves G8 via CLI or comment (plus business/security owner for Critical); bound to the artifact digest
- [ ] AC2: G8 fails without the disclosure note
- [ ] AC3: Seal the Evidence Pack (`sealed_at`), close the intent, record metrics

> Note: Builds on E02 (ADR-M48, QUESTIONS #215, #217): call `buildEvidencePack` (core) with actor `system` and seal ONE version (`evidence_packs.sealed_at`; at most one sealed version per intent; no build after that; add the UPDATE grant on `sealed_at`); bind the G8 approval to that version's `content_sha256`. FR-43: the manifest's `disclosure`; decide whether G8 needs a person to confirm the client note when `client_text_required` is true (`client_format`). Open (ADR-M48 §2.2): how the worker builds the pack at G8 (its own SeaweedFS identity, or another way); the api process holds `api-evidence` today. Done in E03 (ADR-M49): G8 approvals are bound to `release_sha256` (the pack without the G8 parts); the worker builds the release pack with its own identity `worker-evidence`. MVP+1 (QUESTIONS #220, #222): a per-project `release.environment` and the non-production HOTL path at G8 (every G8 is production in the MVP); an explicit PM/BrSE confirmation of the client's own disclosure note

#### E04. Cost report

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| S | C03 | FR-53 | platform/apps/cli, platform/packages/core/cost/* |

**Acceptance criteria**

- [ ] AC1: `sdlc cost report` by tenant / project / intent / time range
- [ ] AC2: Shows tokens in/out, cached tokens, cost, wasted tokens (failed runs)

#### E05. Retention jobs + audit anchoring

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| S | E02, A07 | FR-44 | platform/apps/worker (schedules) |

**Acceptance criteria**

- [ ] AC1: Delete Evidence Pack files older than `evidence_retention_days` (default 180); skip held evidence (`evidence_holds`, QUESTIONS #235; `evidence_packs.retention_hold` is not used)
- [ ] AC2: Audit log, gate decisions and escalations kept at least 2 years (no deletion path in the MVP)
- [ ] AC3: Project archive → purge its evidence files and stored client material unless on hold; keep hashes; audit `project.purged`
- [ ] AC4: Daily: write each tenant's latest audit hash to SeaweedFS

> Note: Two PRs (ADR-M51, QUESTIONS #235–#239): PR 1 = object lock on the bucket `evidence` (GOVERNANCE, 180 days, the existing bucket; checked live on SeaweedFS 4.48), the purge identity `worker-purge`, the worker's `RetentionLoop` (`report` by default, the 180-day code minimum, the guard, a re-check under the intent lock, every version deleted, `purged_at` and `evidence.purged` in one transaction), holds (`sdlc admin evidence hold|release`, config `access.evidence_hold_roles`, rule M32), rule M31 (180 ≤ days ≤ 3650), the lock moved for longer retention, the orphan sweep under `packs/`, an archive refused with open intents and purged after `SDLC_WORKER_RETENTION_ARCHIVE_GRACE_DAYS` (7), `sdlc ops retention report` (AC1–AC3); PR 2 = the daily audit anchor in a COMPLIANCE bucket `audit-anchors` with its own identity and the mismatch check (AC4). Not in E05: deleting a project's Langfuse traces (manual runbook step, QUESTIONS #238, task E08); the unauthenticated SeaweedFS filer API that bypasses the lock (gap 5, QUESTIONS #239, task A12 before M-E); an un-archive command (open item, ADR-M51 §2.6)

#### E06. Gate waiting-time metrics

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| S | B07 | FR-12 | platform/apps/cli |

**Acceptance criteria**

- [ ] AC1: `sdlc metrics gates`: average / maximum waiting time per gate, per project

#### E08. Purge a project's data from Langfuse

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| S | E05 | FR-44 | platform/apps/worker (retention), platform/deploy (Langfuse key in OpenBao), handbook/03-templates/T11-openbao-runbook.md |

**Acceptance criteria**

- [ ] AC1: Spike on the pinned Langfuse v4 (`events_only`): how to delete a project's traces and observations by their `tenant:` and `project:` labels; record the result in an ADR (the legacy traces API answers 404 in this mode)
- [ ] AC2: The Langfuse project key lives in OpenBao, readable only by the process that purges (today only the otel-collector holds it, in `.env`)
- [ ] AC3: When E05 purges an archived project, its Langfuse data is deleted too; `project.purged` records `langfuse: purged` instead of `manual`; Langfuse data past `evidence_retention_days` is deleted the same way
- [ ] AC4: Live test in `pnpm test:observability`: a project's traces are gone after the purge, another project's traces stay

> Note: Found by E05 (QUESTIONS #238): LiteLLM's traces in Langfuse carry prompts and responses (client data, ADR-M35); OSS self-hosted Langfuse has no automatic retention. Until E08, `project.purged` says `langfuse: manual` and runbook T11 lists the manual steps

#### E07. v0.1 definition-of-done check

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| M | E03, E04, E05, C09, B13, C12, A12 | D-02 section 10 | platform/tests/integration/*, README |

**Acceptance criteria**

- [ ] AC1: One intent goes through G1 → G8 on the sample repo
- [ ] AC2: All criteria in D-02 section 10 (including 5b–5d) are met
- [ ] AC3: README explains a fresh deployment with Docker Compose
- [ ] AC4: QUESTIONS #81 is resolved: one real run with an API model has passed before M-F (the trial M-E runs with the local Ollama model, Harry 2026-10-06)

> Note: The web UI scope (Harry, 2026-10-04: after the trial M-E, from its data) is superseded by V11 (QUESTIONS #358): the plan is written before the trial data and revised with it


### Pre-M-E — Before the trial M-E: spec tools and document knowledge (QUESTIONS #285)

#### S01. Read the structure of BMAD / Spec Kit specs; G2 needs acceptance criteria

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| M | B08 | FR-02, D-02 §6.2 G2, NFR-08 | platform/packages/core (specs, workflow G2), migrations (if needed), platform/apps/cli (spec), platform/tests/*, handbook Ch.19 §19.8c, design/ADR-M61 |

**Acceptance criteria**

- [ ] AC1: Recognise the structure of a spec by its `source_tool`: `spec-kit` and `bmad` (the formats of pinned versions, named in ADR-M61) and `manual` (a heading for acceptance criteria, also the bilingual `受入基準 / Acceptance criteria` of D-09 §8); an unknown structure falls back to the `manual` rule
- [ ] AC2: When a spec is linked and when the step re-reads it at the head (B08), count its acceptance criteria; store counts and codes only, never the text (a new column of `spec_refs` is a migration with a D-05 update)
- [ ] AC3: G2 passes, HOTL or HITL, only when the linked spec has at least one acceptance criterion; otherwise a system `fail spec_unclear` once per spec version and a notice, and the intent waits at G2 (D-02 §6.2: "Acceptance criteria present")
- [ ] AC4: `sdlc spec link` and `sdlc spec list` show the tool and the count; labels from the message catalog
- [ ] AC5: Tests: fixtures of each pinned tool's output, the pilot's specs T01–T10 (all pass), a spec without criteria (G2 waits), a spec whose criteria were removed at the head (back to G2)

> Note: QUESTIONS #285 (Harry, 2026-10-08): before the trial M-E. QUESTIONS #290–#294, ADR-M61. A full conversion into the platform's own spec format stays MVP+1

#### S02. `sdlc plan draft`: a plan file draft from Spec Kit tasks or BMAD stories

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| M | S01, B09 | FR-20, NFR-08 | platform/apps/cli (plan draft), platform/packages/core (plan schema reuse), platform/tests/cli/*, handbook Ch.19 §19.8c |

**Acceptance criteria**

- [ ] AC1: `sdlc plan draft <INT> --from <path> --tool spec-kit|bmad [--output <file>]` reads the tool's task list (Spec Kit `tasks.md`, BMAD story files) from the local working tree and writes `.sdlc/plans/<INT>.yaml` in schema version 1 (template T13): one task per item, with its summary and dependencies
- [ ] AC2: The draft never guesses what a person must decide: `allowed_paths`, `tools` and `change_flags` stay marked for the person to fill, so the draft fails submission until they are filled; it never submits, commits or pushes (QUESTIONS #167)
- [ ] AC3: The draft passes `parsePlanFile` once the marked fields are filled; refused input (platform fields, `**`, `.github/`, `.sdlc/`, agent instruction files) is reported with the same codes as submission
- [ ] AC4: Tests with fixtures of the pinned tools' output (S01's versions); handbook Ch.19 usage

> Note: QUESTIONS #285 (Harry, 2026-10-08): before the trial M-E, lighter plan writing (`design/POSITIONING.md` §6.1). QUESTIONS #295–#299; ADR-M62 only if a new decision is needed

#### K01. Spike: WeKnora on the pilot's documents (go / no-go)

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| S | A02 | D-01 §5.8b, NFR-01, NFR-04 | platform/spikes/weknora/* (thrown away), design/ADR-M59 |

**Acceptance criteria**

- [ ] AC1: Run a pinned WeKnora version self-hosted in a throw-away Compose project (never the dev stack), with its own agent, sandbox and memory features off; it calls models only through LiteLLM
- [ ] AC2: Load the pilot's fictional Japanese–English documents (D-09 specs T01–T10, README, AGENTS.md); ask at least 20 questions in Japanese and English and measure retrieval quality (the right passage in the top 5) and answer time
- [ ] AC3: Record resource use (RAM, CPU, disk), the licence and supply chain (images, dependencies, NFR-04), workspace isolation per tenant, and the MCP tools it offers with the ones an agent may use
- [ ] AC4: ADR-M59: the numbers, a go / no-go for K02 and, for go, the integration constraints (egress, tokens, data classes, what is recorded)

> Note: QUESTIONS #285 (Harry, 2026-10-08): before the trial M-E. No client data. QUESTIONS #300–#304, ADR-M59

#### C13. Take an L1 proposal forward: download the patch, end the intent with a G4 rejection

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| S | C06, E02 | FR-03, FR-10, FR-11, D-09 T09 | platform/apps/api (evidence), platform/apps/cli (evidence proposal), platform/packages/core (commands, workflow run-lifecycle, audit), platform/tests/*, handbook Ch.13 §13.10.4, Ch.19 §19.8c, design/ADR-M64 |

**Acceptance criteria**

- [ ] AC1: `GET /v1/intents/:intent/runs/:run/proposal` and `sdlc evidence proposal <INT> [--run <id>] --output <file> [--force]`: the roles in `access.evidence_read_roles` and tenant admins (404 / 403 as the other evidence reads); the api reads the patch with `api-evidence`, checks its SHA-256 and size against `evidence_items` first (fail closed, `evidence.check_failed`), audits every read (`evidence.proposal_read`: run, hash, size); the CLI checks the hash again and writes mode 600, never to standard output
- [ ] AC2: A `reject` at G4 is accepted while the intent is `paused` at G4 after an L1 proposal (`proposal_review`), from a holder of G4's role (the run's `triggered_by` included: a rejection is not an approval); the workflow ends the intent `rejected` with the gate decision, the audit event and the status comment; every other paused case keeps its escalation path, and `approve` / `request_changes` stay refused there
- [ ] AC3: Tests: `pnpm test` (CLI, the gate rule, the audit action), `pnpm test:db` (download, a tampered patch refused, roles, tenants, the rejection ends the intent, other paused cases refused), `pnpm test:openbao` (the read on real SeaweedFS), `test:pilot` T09 to `rejected`
- [ ] AC4: Handbook Ch.13 §13.10.4 and Ch.19 §19.8c, USER-GUIDE step 5: the patch download and the end of the intent replace "ask the platform operator"

> Note: Found in the review of the user commands (Harry, 2026-10-09): T09 of the trial M-E stopped at `proposal_review` with no way to get the patch or end the intent. QUESTIONS #335–#337, ADR-M64. Withdrawing an intent at any gate stays for M-F


### M-E — The trial, run by the community (QUESTIONS #340)

#### V01. The trial M-E by the community: a trial guide, a report template, `sdlc trial report`

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| M | E07, C13, U03 | D-02 §2, §13.3, NFR-08 | TRIAL.md, .github/ISSUE_TEMPLATE/trial-report.yml, README, design/M-E-TRIAL-PLAN.md, design/D-02 §13.3, platform/apps/cli (trial report), platform/tests/cli/*, handbook Ch.19 §19.8c, design/ADR-M65 |

**Acceptance criteria**

- [ ] AC1: `TRIAL.md`: how anyone runs the trial on their own machine: a fresh deployment (README), a fork of the sample repo, their own GitHub App, a model (the local Ollama `gpt-oss:20b` or an API model through LiteLLM), two GitHub accounts for Person A and Person B (QUESTIONS #341), T01 to G8, then T09 (proposal) and T10 (blocked), and how to send the report; the hardware and the time it takes
- [ ] AC2: An issue template `trial-report.yml` (label `trial`): the JSON of `sdlc trial report`, the manual log of `design/M-E-TRIAL-PLAN.md` §7.2, the model used, problems found; it says never to paste tokens, keys or client data
- [ ] AC3: `sdlc trial report [--project <slug>] [--from] [--to] [--json]` builds the report from the existing read endpoints only (gate metrics, cost report, intents, escalations); no new endpoint; counts, codes and model names only: projects renamed `project-1`, `project-2`…, never an intent code, title, person, e-mail, repository or URL
- [ ] AC4: Tests: `pnpm test` (the report from a mocked API; a test that no slug, code, e-mail, login or free text from the fixtures appears in the output); handbook Ch.19 usage; ADR-M65 records the report format and its anonymisation
- [ ] AC5: M-E is done when enough reports arrived (for example from 3 teams) and `design/M-E-REPORT.md` summarises them (QUESTIONS #340)

> Note: QUESTIONS #340 (Harry, 2026-10-09): the trial M-E is run by the community, not by the project team; M-F adjusts from their reports. Two PRs: PR 1 = the decision and the documents (TRIAL.md, the issue template, M-E-TRIAL-PLAN 2.0, D-02 1.8); PR 2 = `sdlc trial report` (ADR-M65). Then release v0.1.0. A10 PR 3 (the company server) and E07 AC4 (#45, the API-model run) no longer block M-E: A10 PR 3 is for an operator who deploys on a server, and a tester who uses an API model gives the run of #45

#### V02. `pnpm trial:up`: the whole trial set-up on a developer machine in one command

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| M | V01 | NFR-01, NFR-03, NFR-08 | package.json, platform/deploy/trial/*, platform/tests/integration/deploy/*, platform/tests/deploy/*, TRIAL.md, platform/deploy/README.md |

**Acceptance criteria**

- [ ] AC1: `pnpm trial:up` runs the steps of "Fresh deployment" (platform/deploy/README.md) on a developer machine, from an empty checkout to a project ready for T01: settings file, OpenBao (init, unseal, configure) with **throw-away keys**, every credentials command, migrations, start, the tenant, Person A and Person B with their GitHub IDs, the project, the sandbox image, the agent, the trial configuration (M-E-TRIAL-PLAN §6) and the AI record; the inputs (fork, App ID and key file, model, the two GitHub accounts) come from one settings file outside the repo
- [ ] AC2: Refuses to run where it may hurt: an existing `platform/deploy/.env` or `sdlc_*` volumes (never overwrites or removes them), `NODE_ENV=production`, a machine without Docker or with too little memory (a clear message from the catalog)
- [ ] AC3: Throw-away keys never reach a file, a log or the terminal: the key shares and the root token live in the process memory only and are dropped after `configure`; the script prints that this stack is for the trial only and can never hold client data; the personal API tokens of Person A and Person B are written only to their own credentials files (mode 600)
- [ ] AC4: `pnpm trial:down` stops the stack; `pnpm trial:down --wipe` removes only the volumes of the trial's own Compose project, after a confirmation
- [ ] AC5: Tests: a static test that the script follows the README steps (like `fresh-deploy-readme.test.ts`), a live test on a throw-away Compose project to the first intent at G1 (CI job `fresh-deploy`, weekly and on demand); `TRIAL.md` §3.2 uses it

> Note: QUESTIONS #342 (Harry, 2026-10-09): before v0.1.0, to lower the cost of the first try. Reuses the steps of `pnpm test:fresh-deploy` (platform/tests/integration/deploy/fresh-deploy.test.ts). Never for a server: the operator follows the README there (A10)

#### V03. Create the GitHub App from a manifest

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| S | V01 | NFR-03, NFR-08 | platform/deploy/github-app/*, platform/deploy/README.md (Create the GitHub App), TRIAL.md, platform/tests/deploy/* |

**Acceptance criteria**

- [ ] AC1: A GitHub App manifest in the repository with exactly the permissions of the README's list (Contents, Issues, Pull requests read and write; Code scanning alerts, Checks, Commit statuses, Metadata read), webhook off, installable on the owner's account only
- [ ] AC2: A small local page or command that sends the manifest to GitHub (the manifest flow) and saves the returned App ID and private key to a file outside the repository, mode 600; the key is never printed
- [ ] AC3: A static test fails when the manifest and the README's permission list differ
- [ ] AC4: README "Create the GitHub App" and TRIAL.md §3.2 use it; the manual steps stay as the fallback

> Note: QUESTIONS #342 (Harry, 2026-10-09): before v0.1.0. GitHub's manifest flow: https://docs.github.com/apps/sharing-github-apps/registering-a-github-app-from-a-manifest


### UX — Friendlier for users and deployers: v0.1.1, v0.2.0, then v0.3.0 with the agent measures and `sdlc help`; V17 in v0.8.0 (QUESTIONS #355, #364, #420, #424)

#### V04. Publish the platform's images to GHCR for each release

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| M | V01 | NFR-01, NFR-04 | .github/workflows/*, platform/deploy/docker-compose.yml, platform/deploy/README.md, TRIAL.md, design/ADR-M66 |

**Acceptance criteria**

- [ ] AC1: A release workflow builds the images of `sdlc-api`, `sdlc-worker`, `sdlc-runner`, the otel-collector and the `node24` sandbox image, scans them (Trivy), and pushes them to GHCR, tagged with the release and pinned by digest
- [ ] AC2: The images are signed and carry an SBOM and provenance (decided in ADR-M66); the README says how to verify them
- [ ] AC3: Compose uses the published images by digest for a release checkout and builds locally otherwise; a static test checks the digests
- [ ] AC4: TRIAL.md and the README's fresh deployment skip the local builds when the images are published

> Note: QUESTIONS #342 (Harry, 2026-10-09): after v0.1.0, while the first reports come in; moved to the milestone UX with v0.2.0 (QUESTIONS #355). ADR-M66 records the registry, signing (for example cosign keyless) and the supply-chain checks. AC3 changed by V15 (ADR-M94): from the release after v0.6.0 the digests are a release asset

#### V05. Install the `sdlc` command with one command (npm package `agentic-sdlc-cli`)

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| M | V01 | FR-20, NFR-08 | platform/apps/cli (bundle, package.json), platform/apps/cli/src (version flag), .github/workflows/* (publish on a release tag), platform/USER-GUIDE.md, TRIAL.md, platform/tests/cli/* |

**Acceptance criteria**

- [ ] AC1: `npm install -g agentic-sdlc-cli` gives the `sdlc` command (Node.js 24), and this task adds `sdlc --version` (prints `PLATFORM_VERSION`): the CLI and the workspace packages it uses bundled into the published package; no repository checkout, pnpm or build on the user's machine
- [ ] AC2: Published only from a release tag by a workflow, with npm provenance (trusted publishing, no long-lived npm token in the repository); the package version equals the release (`PLATFORM_VERSION`, root `package.json`)
- [ ] AC3: The published package holds no test fixture, source map with absolute paths, `.env` or other secret; a CI step packs it (`npm pack --dry-run`) and installs the tarball in a clean folder, then runs `sdlc --version` and `sdlc` with no arguments (the usage text); `sdlc help` comes with V10
- [ ] AC4: USER-GUIDE §2 and TRIAL.md use it; `pnpm sdlc` from a checkout stays for developers; the operator commands (`sdlc ops …`) keep needing the server

> Note: QUESTIONS #357 (Harry, 2026-10-10): npm under a new name (`@sdlc` may be taken; `agentic-sdlc-cli` is free on 2026-10-10). Harry owns the npm account and sets up trusted publishing; the first publish is a public action: ask him first

#### V06. `sdlc next <INT>`: where an intent is and what to do now

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| S | V01 | FR-20, FR-22, NFR-08 | platform/apps/cli (next), platform/packages/messages, platform/tests/cli/*, handbook Ch.19 §19.8c, platform/USER-GUIDE.md |

**Acceptance criteria**

- [ ] AC1: `sdlc next <INT> [--json]` reads only `GET /v1/intents/:intent` (no new endpoint) and prints the gate, its oversight mode, who it waits for (`waiting_for`), why it waits (`waiting_reason`, `waiting_cause`) and the next action for the person who runs it, as a command or comment to type (for example `/approve G3` on the issue, or `sdlc plan submit INT-…`)
- [ ] AC2: The advice follows the caller's roles (`/v1/me`): an action the person may not take is shown as "waits for <role>", never offered; a producer is never told to approve
- [ ] AC3: Every text from the catalog; one advice per waiting reason and gate (a test covers every `IntentWaitReason`)
- [ ] AC4: Tests against a mocked API: each gate and reason, each role, a finished intent

> Note: QUESTIONS #355 (Harry, 2026-10-10): users do not know the next step. Reuses U01/U02 fields (`waiting_for`, `waiting_reason`); the dashboard may show the same advice later (V11)

#### V07. `doctor`: check a deployment and a login, and say what to fix

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| M | V02 | NFR-01, NFR-06, NFR-08 | platform/deploy/doctor/* (operator), platform/apps/cli (sdlc doctor), package.json, platform/packages/messages, platform/tests/*, platform/deploy/README.md (Troubleshooting), TRIAL.md |

**Acceptance criteria**

- [ ] AC1: `pnpm doctor` (operator, on the machine of the stack): Docker and Compose versions, memory and disk, the env file and its mode, each service healthy, OpenBao initialised and sealed or unsealed, the TLS certificate's end date, migrations applied, each process's credentials delivered, the GitHub App reachable with the README's permissions on the project repositories, the sandbox image pinned; one line per check (ok, warning, failed) and, for each problem, the exact command or README section that fixes it
- [ ] AC2: `sdlc doctor` (a person): the API reachable over TLS, the login valid and not near its end, the person's roles per project, the CLI's version against the API's
- [ ] AC3: Read only: it changes nothing, prints no secret (never a token, key share, password or key), and works on a stopped or sealed stack (it says so instead of failing)
- [ ] AC4: Tests: each check with a fake host (pure functions), a static test that every README troubleshooting case has a check or says why not

> Note: QUESTIONS #355 (Harry, 2026-10-10): deployers lack a single place that tells what is wrong

#### V08. The trial stack survives a reboot

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| M | V02 | NFR-03, NFR-08 | platform/deploy/trial/*, platform/deploy/openbao/bootstrap.sh (trial only), platform/tests/trial/*, platform/tests/integration/deploy/trial-up.test.ts, TRIAL.md, CLAUDE.md, handbook/03-templates/T11-openbao-runbook.md, design/QUESTIONS.md |

**Acceptance criteria**

- [ ] AC1: `pnpm trial:up` asks the person for a passphrase (hidden prompt, twice) and keeps the trial's throw-away OpenBao key shares encrypted with it (age, scrypt) in a file next to the trial's env file, mode 600; never the root token (revoked as today)
- [ ] AC2: `pnpm trial:start` starts the trial stack again after a reboot or `trial:down`: asks the passphrase, unseals OpenBao, starts the rest; a wrong passphrase unseals nothing and says so
- [ ] AC3: Only for the trial's own Compose project (`sdlc-trial…`): the key file and `trial:start` refuse any other env file, `NODE_ENV=production`, or a stack that is not a trial stack; the server keeps the key-holder rules (runbook T11); `trial:down --wipe` removes the key file
- [ ] AC4: Tests: encrypt and decrypt, a wrong passphrase, the refusals; the live test stops and starts the stack again and finds the intent it created
- [ ] AC5: CLAUDE.md, TRIAL.md and runbook T11 describe the passphrase file and its limits; the server keeps the key-holder rules

> Note: QUESTIONS #356 (Harry, 2026-10-10): revisits #345 for the trial stack only, whose data is fictional; the details go into the V08 plan for Harry's approval

#### V09. Team access from other machines (TLS reverse proxy)

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| L | V07 | NFR-01, NFR-03 | platform/deploy/docker-compose.yml (profile access), platform/deploy/access/*, platform/deploy/README.md, design/D-03 §9, §10, design/ADR-M67, platform/tests/deploy/*, platform/tests/integration/* |

**Acceptance criteria**

- [ ] AC1: A Compose profile `access`: a pinned reverse proxy (for example Caddy, Apache-2.0) publishes the API and the dashboard on one LAN port over TLS, with a certificate from the company CA or a throw-away CA on a test machine; nothing else is published; the API and the dashboard keep listening on 127.0.0.1 inside
- [ ] AC2: Security headers, request size limits and a rate limit per client; the token only in the `Authorization` header; the CSP of the dashboard unchanged; plain HTTP refused or redirected
- [ ] AC3: The CLI and the dashboard work through it (`NODE_EXTRA_CA_CERTS` for a company CA); `pnpm doctor` checks it
- [ ] AC4: D-03 §9 and §10 and platform/deploy/README.md updated and ADR-M67 written in the same task (design change: today the README says "Access from other machines: not supported yet" and D-03 §9, dashboard row, says "exposing it to other machines (TLS, reverse proxy) is out of scope"); live test: from another container, only the proxy answers, TLS is verified, plain HTTP is refused

> Note: QUESTIONS #355 (Harry, 2026-10-10): needed before a team uses the platform on a server. Design change first: the D-03 update and ADR-M67 go in the task's first PR for Harry's approval

#### V10. A friendlier CLI: `sdlc help`, hints, clearer errors

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| M | V06 | FR-20, NFR-08 | platform/apps/cli (help, output), platform/packages/messages, platform/tests/cli/*, platform/USER-GUIDE.md |

**Acceptance criteria**

- [ ] AC1: `sdlc help [topic|command]`: short guides from the catalog (getting started, roles and the two-person rule, the gates and what each needs, the comment commands, troubleshooting) and every command with its options and one example; `sdlc <command> --help` works for every command
- [ ] AC2: After a command that moves an intent, one line with the likely next step (the advice of `sdlc next`); an error names the cause and the command that fixes it (for example `sdlc login`)
- [ ] AC3: Tables and colours only on a terminal (`NO_COLOR` and `--json` give plain output); nothing changes in `--json` output
- [ ] AC4: Tests: every command has a help text (a test fails on a command without one), hints and errors per case, `NO_COLOR`

> Note: QUESTIONS #355 (Harry, 2026-10-10). English only: translations into Vietnamese and Japanese are not planned now (QUESTIONS #357)

#### V11. Plan the dashboard's actions (design only)

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| S | V06 | D-02 §4.2, NFR-08 | design/MVP1-UI-SCOPE.md, design/QUESTIONS.md |

**Acceptance criteria**

- [ ] AC1: `design/MVP1-UI-SCOPE.md` version 1.0 proposes which actions the dashboard adds (for example approve or reject a gate, create an intent and link its spec, submit a plan, acknowledge and decide an escalation, kill a run), who may use each, and what stays on GitHub (the G7 review and the merge)
- [ ] AC2: The security design for writes from a browser: sign-in and session (not the personal token in memory only), CSRF protection, re-authentication before an approval, the two-person rule shown and enforced by the same API checks, the audit actor
- [ ] AC3: The design changes D-02 §4.2 ("actions in a web UI stay Later") and ADR-M54 only after Harry approves it; then the implementation tasks are added to the backlog
- [ ] AC4: No code in this task
- [ ] AC5: Revised once `design/M-E-REPORT.md` exists (the trial data: who needs which screen, read-only or actions, sign-in)

> Note: QUESTIONS #355 (Harry, 2026-10-10): the dashboard should have a plan for the other actions; read-only stays until the plan is approved. QUESTIONS #358 (Harry, 2026-10-10): V11 starts now, before the trial data, and supersedes the E07 note

#### U05. Dashboard sign-in with GitHub and server-side sessions

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| M | U01, V03 | FR-11, NFR-02, NFR-03 | platform/apps/api (auth, web sessions), platform/packages/core (sessions, audit actions), migrations, platform/deploy/github-app/*, platform/deploy/openbao/bootstrap/*, platform/apps/dashboard (sign-in), platform/tests/*, handbook Ch.19, runbook T11 |

**Acceptance criteria**

- [ ] AC1: GitHub OAuth through the platform's GitHub App (ADR-M73 §2.2): a random `state` and PKCE kept server-side with the tenant and bound to the browser by the pre-login cookie `__Host-sdlc_oauth` (`SameSite=Lax`, about 10 minutes; the callback needs both), the code exchanged by the api, the person's numeric GitHub account ID read, the GitHub user token dropped at once and never stored or logged
- [ ] AC2: The user is found by (tenant, `github`, numeric ID) among linked identities and must be active; any other case is refused with one message
- [ ] AC3: The App keeps its client secret in OpenBao (`kv/api/github-oauth`, readable by the `api` AppRole only) and lists the callback URLs; `pnpm github-app:create` and the README updated (a change of V03); an existing App gets a new client secret entered by the owner in a terminal
- [ ] AC4: Table `web_sessions` (D-05; hashes only, tenant guard), cookie `__Host-sdlc_session` (`HttpOnly`, `Secure`, `SameSite=Strict`), idle and absolute timeouts from settings; a new session ID at every sign-in (no fixation); revoked at sign-out, user disable, identity unlink and by a tenant admin; sign out everywhere; audit `web_session.started|ended` (IDs and codes only)
- [ ] AC5: The api guard accepts a bearer token or a session cookie, never both; `GET` reads work with the session; the personal-token sign-in of ADR-M54 stays for read-only use
- [ ] AC6: Tests: `pnpm test` (OAuth with a fake GitHub: wrong state, missing or foreign pre-login cookie, reused code, unlinked or disabled user), the sign-in checked in Safari, Chrome and Firefox on `http://localhost` (a Safari refusal is written as a known limit, never fixed by weaker cookies), `pnpm test:db` (sessions, tenant isolation, revocation), `pnpm test:dashboard` (sign-in and sign-out)

> Note: ADR-M73, MVP1-UI-SCOPE 1.2 §5.1–§5.2 (QUESTIONS #375, #380). Works on `localhost`; other machines need V09 (no dependency, #380)

#### U06. Dashboard writes: CSRF, origin check, passkey step-up

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| M | U05 | FR-11, FR-17, NFR-03 | platform/apps/api (auth, passkeys), platform/packages/core (passkeys, audit actions), migrations, platform/apps/dashboard, platform/tests/*, handbook Ch.19 |

**Acceptance criteria**

- [ ] AC1: Every write with a session cookie needs all three CSRF layers (ADR-M73 §2.3): `SameSite=Strict`, the session's CSRF token in `X-SDLC-CSRF`, and `Origin` equal to `SDLC_API_PUBLIC_ORIGIN` (`Sec-Fetch-Site: same-origin` when sent); JSON bodies only; bearer requests unchanged
- [ ] AC2: Actions are off by default (`SDLC_API_DASHBOARD_ACTIONS=off`); the api refuses to start with actions on and a missing public origin, or a plain `http://` origin on a host other than `localhost`
- [ ] AC3: Passkeys (WebAuthn, the library chosen in ADR-M73): registration needs a GitHub sign-in in the last 5 minutes; table `webauthn_credentials` (D-05; no free text); list and remove one's own passkeys, a tenant admin may remove them; audit `passkey.registered|revoked`
- [ ] AC4: Step-up per decision: a random challenge made by the api and stored with its bound action (session, action, subject, gate, decision, `expected_input_sha256`), about 2 minutes, used once in the decision's transaction; a request that differs from the stored action is refused; never for a kill or an acknowledgement
- [ ] AC5: Tests: a request from another origin, without the CSRF token, with a reused or foreign assertion, or with a session of another tenant is refused; the CSP of ADR-M54 unchanged (static test)

> Note: ADR-M73, MVP1-UI-SCOPE 1.2 §5.3–§5.4, §5.8–§5.9 (QUESTIONS #376, #377)

#### V12. Release process: SemVer, a tag-driven release workflow, upgrade notes

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| S | V01 | NFR-07, NFR-08 | .github/workflows/* (release), platform/tools/release/*, RELEASING.md, CHANGELOG.md, CONTRIBUTING.md, SECURITY.md, platform/tests/workspace/* |

**Acceptance criteria**

- [ ] AC1: A written versioning policy (SemVer; before v1.0 a minor release may break, with its "Upgrade notes"; support = the latest release only; security advisories through GitHub Security Advisories, SECURITY.md)
- [ ] AC2: A release workflow on a pushed tag `vX.Y.Z`: refuses a tag that differs from the root `package.json` and `PLATFORM_VERSION`, creates the GitHub Release from the CHANGELOG section, and starts the image (V04) and npm (V05) jobs when they exist; the tag is always made by a person
- [ ] AC3: Every CHANGELOG release section has "Upgrade notes" (migrations, credentials commands to run again, changed settings), checked by a test
- [ ] AC4: Small releases: a v0.1.x when something useful lands without an upgrade step (for example the CLI on npm and `sdlc next`); v0.2.0 when the milestone UX is done or an upgrade step is needed

> Note: QUESTIONS #364 (Harry, 2026-10-10). Releases, tags and npm publishes are public actions: ask Harry first. The upgrade test between two releases is O02 (Server). AC2 as built (QUESTIONS #370, #390): the images are built before the tag, so `release.yml` on the tag runs the release gate `release-check.mjs`, verifies the images' signatures and attestations (never builds them) and creates the GitHub Release; npm stays its own tag workflow `npm-publish.yml` with the same gate (its trusted-publisher identity); `pnpm release:lock` prepares the lock file pull request. AC3: from 0.1.1 on (0.1.0, the first release, is exempt). RELEASING.md. AC2 changed by V15 (ADR-M94, QUESTIONS #591): from the release after v0.6.0 the tag workflow builds the images

#### L02. Evaluation harness: agents, models and prompts measured on a fixed task set (data for the GPU decision)

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| L | C05 | D-07 §3, §4, §5, NFR-01 | platform/tests/integration/agent/* (or platform/eval/*), package.json, design/ADR-M78, design/D-07 (results), docs of the harness |

**Acceptance criteria**

- [ ] AC1: `pnpm eval` (developer machines, never in CI) runs a fixed task set on the sample repository: T01–T08 shapes plus a few seeded bug fixes, each with **hidden acceptance tests** the agent never sees (fail-to-pass for the new behaviour, pass-to-pass for what must not break)
- [ ] AC2: One configuration = agent × model × instructions version (the agent register already pins the model and the hash of the instructions); each task runs **N times** (default 5) per configuration, because model output varies
- [ ] AC3: Per configuration and task, numbers only: resolve rate (hidden tests pass), **pass@k and pass^k** (at least one / all of k runs), CI on the first try, scope breaches (G5), stops (loop, caps), new static-analysis findings, diff size, time, model calls, tokens, cost (internal cost for self-hosted), cost per resolved task
- [ ] AC4: A comparison report with **confidence intervals** (bootstrap) and a paired test between two configurations on the same tasks (McNemar for pass/fail); one factor changes at a time; a quality-against-cost (Pareto) chart; scores also sent to Langfuse (datasets and scores) when the profile `observability` is on
- [ ] AC5: Optional, measured before use: an LLM judge with a fixed rubric for what tests cannot check (readability, fit with `AGENTS.md`), checked against a human-scored sample (agreement reported); never the only signal
- [ ] AC6: Runs with local models on Ollama (small and medium sizes) and, when a key exists, one API model; never a `:cloud` model; the report holds numbers only, never prompts, task text or code
- [ ] AC7: Pairwise comparison: Person B (or another reviewer) picks the better of two configurations' results for the same task, blind to which is which; the choices give a ranking (Elo or Bradley-Terry) next to the automatic scores
- [ ] AC8: The task set grows: new tasks are added on a schedule and results are reported per task-set version, so a model cannot do well only because it has seen the tasks before
- [ ] AC9: Before building the harness, a short spike compares existing open-source evaluation frameworks (for example Inspect, promptfoo, the SWE-bench harness, Langfuse experiments) for licence, maintenance and fit; reuse one if it fits, record the choice in ADR-M78
- [ ] AC10: ADR-M78 records the task set, the scoring, the statistics and how a new task or configuration is added; a short result table for leadership (which model size reaches which quality, the memory and speed), input for L01, L03 and X01

> Note: QUESTIONS #362 (Harry, 2026-10-10): many clients are `client_restricted`, so a self-hosted model is a condition to sell; the company has no GPU yet. QUESTIONS #422 (Harry, 2026-10-12): the benchmark becomes an evaluation harness for agents, models and prompts. Runs on a developer machine, in parallel with the milestone UX; split into PRs (spike and harness with the task set, then statistics, the pairwise ranking and the report). QUESTIONS #423 (Harry, 2026-10-12): follow established practice (SWE-bench-style hidden tests, pass^k, error bars, judged pairs, fresh tasks) and reuse a framework where it fits. QUESTIONS #445 (Harry, 2026-10-13): AC7 keeps the runs' diffs on the developer's machine only (`<out>/diffs/`, purgeable), never in a result or report. QUESTIONS #446: AC4's Langfuse scores come later, after a check of the API in `events_only` mode; the report is JSON, Markdown and an SVG chart. QUESTIONS #447 (Harry, 2026-10-13): AC10's first result table is in D-07 §9 from 53 of 80 runs (the evaluation was stopped); a measurement of a 30B-class model needs a larger machine (L01, L03)

#### V13. Agent efficiency report from real runs: `sdlc metrics agents`

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| M | E04, E06 | FR-12, FR-53, D-07 §5 | platform/packages/core (metrics), platform/apps/api (metrics endpoint), platform/apps/cli (metrics agents), platform/packages/api-schemas, platform/tests/*, handbook Ch.19 §19.8c |

**Acceptance criteria**

- [ ] AC1: `GET /v1/metrics/agents` and `sdlc metrics agents [--project] [--agent] [--model] [--from] [--to] [--json]`: per agent version and the model of the run's contract (QUESTIONS #432), from data the platform already records (runs, run events, gate decisions, `intent.closed`, cost records); no new table
- [ ] AC2: Measures: runs and how they ended (succeeded, proposal only, failed, each stop reason), CI on the first try at G6, the share of intents merged without a request for changes at G7, G5 scope breaches, retries, lead time, tokens and cost per run, **cost per merged intent**, wasted cost (ended runs that did not count), cache share of input tokens
- [ ] AC3: Access (QUESTIONS #430): a role in both `access.cost_read_roles` and `access.metrics_read_roles` (never `viewer`), tenant admins always; no new config key; range half-open UTC, default the last 30 days; sums in SQL; money as decimal strings; numbers and codes only, never a person or a text
- [ ] AC4: Tests: `pnpm test` (the CLI, the rules), `pnpm test:db` (each measure on seeded runs, tenants, roles); handbook Ch.19 usage; the dashboard may show it later

> Note: QUESTIONS #422 (Harry, 2026-10-12): measure whether agents and models are worth it in real work, next to the evaluation harness (L02). The `sdlc trial report` (V01) may include its numbers later. QUESTIONS #430–#433, ADR-M79 (V13 plan, 2026-10-12): intent-level measures count under the run that was merged; the human-effort baseline moved to V14

#### V17. `sdlc admin project apply`: a project and its team from one file

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| M | B13, C10, V10 | FR-11, NFR-08 | platform/apps/cli (admin), platform/packages/api-schemas (the file schema), platform/packages/messages, platform/tests/cli/*, handbook Ch.19 §19.8d, platform/deploy/README.md (steps 9–12) |

**Acceptance criteria**

- [ ] AC1: `sdlc admin project apply --file project.yaml [--dry-run]`: one file holds the project (slug, name, repository), the team (email, name, GitHub login, roles), the agent to register and the project configuration that differs from the defaults; no secret in the file; the schema lives in `@sdlc/api-schemas`
- [ ] AC2: The CLI looks up the numeric GitHub ID of each login and shows login and ID for the operator to confirm; users are still matched by numeric ID only (R037)
- [ ] AC3: Before the first write it checks the whole file and the role bindings already in the database: Person A and Person B are never the same person (M21), and every role exists; a refused file writes nothing (QUESTIONS #617)
- [ ] AC4: It calls the same API endpoints as the manual commands, one call per change, so the audit log is the same; it creates what is missing, shows a difference for what has changed, passes the configuration version itself; `--dry-run` writes nothing; a second run with the same file changes nothing
- [ ] AC5: It never approves the agent and never writes the project AI record (those stay with the agent's owner, Person B and Person A); it issues no token; at the end it prints, per person, the commands that are still theirs
- [ ] AC6: Tests: a new project, a second run, a changed file, M21 within the file and against existing bindings, an unknown GitHub login, `--dry-run`; messages through the catalog; handbook Ch.19 §19.8d and deploy README steps 9–12 updated in the same task

> Note: QUESTIONS #617 and #618 (Harry, 2026-10-28). Comes before V16. Bugs from trial reports come first (R123). Done: `sdlc admin project apply` (schema `projectFileSchema` in `@sdlc/api-schemas`; handbook Ch.19 §19.8d)

#### H01. Threat model for agent runs and attack tests

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| M | C05, C11 | FR-33, FR-50, NFR-03 | design/ADR (next free number), platform/tests/integration/* (attack fixtures), platform/apps/runner, platform/packages/adapters/agent-openhands, handbook T11 (if a procedure changes) |

**Acceptance criteria**

- [ ] AC1: A threat model of an agent run against the OWASP Top 10 for Agentic Applications (D-03 §9): what an attacker controls (spec, plan, review comment, repository content, package registry, model output) and which control stops each step; gaps listed with a severity
- [ ] AC2: Attack tests on the stub model and the real sandbox: prompt injection in the spec, the plan text and the review feedback (the nonce blocks hold); a repository whose files try to read the sandbox's environment, reach the internet, OpenBao, the Docker socket or another run's network; a package that is not on the proxy; an agent that edits its own instruction files or `.sdlc/`
- [ ] AC3: Each test asserts the platform's answer (refused, stopped, escalated) and that no secret, token or key appears in a run event, a log or the evidence
- [ ] AC4: Every gap found becomes a fix in this task or a new backlog task with a severity; QUESTIONS for the ones that need a decision

> Note: Found in the plan review after V13 (Harry, 2026-10-13, QUESTIONS #440): the repository is public and the community trial runs on people's own repositories. Before the first trial report from a real repository Done: ADR-M80 (PRs 1–3); the gaps it found are H02 (G-1, G-5), H04 (G-10), H05 (G-9), H06 (G-6) and H07 (G-7), QUESTIONS #455 and #456


### DEV — Rules as checks for contributors and Claude Code: a rules register, hooks, lint and tests (QUESTIONS #479)

#### W01. Rules as checks: a rules register, hooks, lint and tests, a shorter CLAUDE.md

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| M | A01, A09 | NFR-05, NFR-07 | design/RULES.md, design/ADR-M84, .claude/settings.json and its hook script, eslint.config.mjs, platform/tools/eslint-rules/*, platform/tests/workspace/*, CLAUDE.md and nested CLAUDE.md files, design/QUESTIONS.md |

**Acceptance criteria**

- [ ] AC1: PR 1: `design/RULES.md` lists every rule of the root CLAUDE.md with its ID, the check that enforces it (lint, test, database, runtime, CI, hook or none), its coverage and a proposal; rules that look outdated or are worded wrongly go to QUESTIONS; duplicate rules are merged
- [ ] AC2: PR 2: a Claude Code `PreToolUse` hook in `.claude/settings.json` refuses the commands CLAUDE.md forbids for Claude (volume prune, `compose down -v`, tags and releases, `npm publish`, force-push and rebase, the OpenBao commands that print a secret, `weed shell s3.config.show`); the hook script has unit tests and prints a catalog-free English refusal (developer tooling, not a user-facing message)
- [ ] AC3: PR 3: lint rules and tests for the important rules that have no check today (at least: no `console.*` outside the logger, no Temporal schedules in the worker, audit writes only through `TenantScope.audit.append`, no edit of a merged migration, one test for every append-only table, the generated D-08 equals the script's output); each closes a row of the register
- [ ] AC4: PR 4: rules that apply to one folder move to a nested CLAUDE.md in that folder; the root CLAUDE.md keeps the hard rules and a pointer to the register; a test checks that every rule ID of the register is found in exactly one CLAUDE.md or marked as enforced by a check

> Note: QUESTIONS #479 (2026-10-20): the root CLAUDE.md has about 190 rules in 131 bullets and is read by every session; about half have a mechanical check. ADR-M84 records the approach. Four PRs, each in its own session


### EVAL — Evaluation for managers: they plan evaluations, get reports and recommendations to improve agents, prompts and models; on the server and on developer machines. After v0.3.0, before EXT (QUESTIONS #450)

#### L04. Evaluations on the server, one engine for the server and developer machines

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| L | L02, V13, C06 | D-07 §3–§5, FR-31, FR-50, NFR-01, NFR-02 | platform/eval/*, platform/apps/worker (evaluation loop), platform/apps/runner (queue), platform/packages/core (evaluations), migrations, design/D-05, design/ADR (next free number), platform/tests/* |

**Acceptance criteria**

- [ ] AC1: One evaluation engine (tasks, scoring container, statistics, report: ADR-M78) used in two places: `pnpm eval` on a developer machine (also on a trial stack) and evaluations on the server; the same task set and configuration give comparable numbers, and every report says where it ran and on what hardware
- [ ] AC2: On the server, runs go through the deployed runner and LiteLLM (API and self-hosted models, the seven labels, a capped virtual key per run), on their own queue: they never take a slot of a real run (`SDLC_RUNNER_MAX_SANDBOXES` counts real runs first) and stop when their own budget is used up
- [ ] AC3: Results in the database per tenant, codes and numbers only (as the run results of ADR-M78), append-only; the scoring container keeps its limits (no network, no capability, non-root)
- [ ] AC4: Data classes (D-07 §4): a `client_restricted` project evaluates with self-hosted models only; `prohibited` never
- [ ] AC5: Tests: `pnpm test`, `pnpm test:db` (results, tenants, budget stop, the queue never blocks a real run), a live run on the stub model

> Note: QUESTIONS #450 (Harry, 2026-10-13): managers plan evaluations themselves and get reports and recommendations; the evaluation also stays possible on a developer machine

#### L05. Evaluation plans that managers make themselves

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| M | L04 | FR-20, NFR-08 | platform/apps/api (evaluations), platform/apps/cli (sdlc eval …), platform/apps/dashboard, platform/packages/config (access.eval_roles), platform/packages/core, platform/tests/*, handbook Ch.19 |

**Acceptance criteria**

- [ ] AC1: A person with a role in project config `access.eval_roles` (default Person A, Person B, governance, admin; never `viewer`, a mandatory rule) makes an evaluation plan: the configurations (agent versions and models from the agent register and the gateway, and **prompt variants**: another instructions file to try before it changes `AGENTS.md`), the task set, the number of runs, a budget
- [ ] AC2: When it runs: once, on a schedule (for example weekly), or when a new model or agent version appears
- [ ] AC3: **Dashboard first** (QUESTIONS #465): a manager makes, starts and follows a plan in the dashboard (a write only through the fixed paths of `src/api/writes.ts` with the CSRF layers of ADR-M73); the API and `sdlc eval plan|run|list|show` give the same actions; every plan and run audited (IDs, codes, hashes only)
- [ ] AC4: Tests: roles, budgets, schedules, tenants, refusals

> Note: QUESTIONS #450, #465 (dashboard first)

#### L06. Evaluation reports and recommendations for managers

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| M | L05 | FR-53, NFR-08 | platform/packages/core (recommendations), platform/apps/api, platform/apps/cli, platform/apps/dashboard, platform/packages/messages, platform/tests/*, handbook Ch.19 |

**Acceptance criteria**

- [ ] AC1: **Dashboard first** (QUESTIONS #465): the report of an evaluation (ADR-M78 §2.5) is a page of the dashboard, read-only, written for a manager (plain words, numbers with their intervals); the CLI gives the same data, with the real-run numbers of V13 for the same agents and models next to it; a notice when an evaluation ends
- [ ] AC2: **Recommendations by rules**, each with the numbers and intervals it rests on, never a claim the data does not show: for example a cheaper model that resolves as well (no difference by the report's test), a low CI-on-the-first-try rate (add the checks to the instructions), unstable results (pass@k far above pass^k), runs stopped at a cap, scope breaches
- [ ] AC3: A recommendation is a proposal only: a change of model or prompt still goes through the agent register (a new version, approvals, 2+N)
- [ ] AC4: Recommendations written by a model come later, and only after they were checked against people's judgement (as the LLM judge, QUESTIONS #438)
- [ ] AC5: Tests: each rule on synthetic results (fires, does not fire, the numbers quoted), texts from the catalog

> Note: QUESTIONS #450, #465 (dashboard first)

#### L07. A project's own task set from its merged intents

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| M | L02, E01 | FR-40, D-07 §4 | platform/eval/*, platform/packages/core, platform/packages/contracts, platform/packages/adapters/git-github, platform/packages/config (evaluation.test_globs, evaluation.commands), platform/apps/api, platform/apps/cli, platform/apps/worker, platform/apps/runner, platform/packages/messages, platform/tests/*, design/ADR-M85, design/D-05 §6.8, handbook Ch.19 |

**Acceptance criteria**

- [ ] AC1: Make evaluation tasks from a project's merged intents, as SWE-bench does: the spec, the base commit, and the tests the pull request added as hidden tests; a person reviews each task before it enters the set
- [ ] AC2: The task set is private to the project and tenant and follows its data class and retention (FR-44); never copied to another tenant
- [ ] AC3: The task check of ADR-M78 (`--check`) runs on every new task
- [ ] AC4: Tests: a task made from a fixture intent, refused when the pull request added no test

> Note: QUESTIONS #450: evaluations on a project's own code, not only the sample repository. Design (ADR-M85, QUESTIONS #485–#487): a task is a card `.sdlc/eval-tasks/<id>.yaml` on the project's default branch, written by `sdlc eval task draft` on the person's machine and merged by a person; the platform stores its path, commit and SHA-256 only; the check runs on the server in the runner; a reviewer has a role in `access.eval_roles` and is never a producer of the intent; four PRs

#### L08. Design: evaluations in the agent register's approvals

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| S | L06, C10 | FR-11, FR-36 | design/ADR (next free number), design/ADR-M31, handbook Ch.20, design/QUESTIONS.md |

**Acceptance criteria**

- [ ] AC1: A design for a new agent version (model, instructions) to reach a threshold on the project's task set before Person B and the owner approve it, and for the 3-month recertification (FR-36) to use evaluation numbers
- [ ] AC2: No code in this task; implementation tasks follow Harry's approval

> Note: QUESTIONS #450. Design: ADR-M86 (QUESTIONS #496–#500): an evaluation counts for an agent version by its fingerprint (model, instructions SHA-256, tools SHA-256); thresholds in project configuration `agents.evaluation` (default mode `warn`); built by L09 and L10

#### L09. Evaluations in the agent register's approvals

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| M | L08, L07, B13 | FR-11, FR-36 | platform/packages/core (agents, evaluation, db/migrations), platform/packages/config (agents.evaluation), platform/apps/api, platform/apps/cli, platform/packages/messages, platform/tests/*, design/D-05 §6.1 and §6.9, design/ADR-M86, handbook Ch.20 §20.5b |

**Acceptance criteria**

- [ ] AC1: The fingerprint of ADR-M86 §2.1: `evaluation_configurations` gains `source` and `tools_sha256`; plan configurations may name `proposed` and `suspended` agents, never `quarantined` or `retired`; real runs still need an `active` agent
- [ ] AC2: Project configuration `agents.evaluation` (`mode` `off`/`warn`/`required`, default `warn`; `min_tasks`, `min_resolve_rate`, `approval_max_age_days`, `recertification_max_age_days`) with its mandatory rules
- [ ] AC3: An `activate` approval takes `evaluation_code` (`--evaluation`); the platform checks every condition of ADR-M86 §2.3 (finished, fingerprint, whole task set, enough tasks, resolve rate, no scope breach, not worse than the baseline for a change, fresh, latest); one evaluation per round; `agent_approvals` gains `evaluation_id` and `evaluation_result`; `warn` accepts with a warning, `required` refuses with the codes of §2.8
- [ ] AC4: `sdlc admin agent show` and `GET /v1/admin/agents/:key` show the latest evaluation of the current fingerprint and whether it qualifies; audit IDs and codes only
- [ ] AC5: Tests: each condition (passes, fails, its code and numbers), both modes, the baseline of a change, a different evaluation in one round, tenants, texts from the catalog

> Note: ADR-M86 §2.1–§2.5, §2.7–§2.8; QUESTIONS #496–#500

#### L10. Evaluations in the agent recertification

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| S | L09 | FR-36 | platform/packages/core (agents), platform/apps/api, platform/apps/cli, platform/packages/messages, platform/tests/*, design/ADR-M86, handbook Ch.20 §20.5b |

**Acceptance criteria**

- [ ] AC1: `recertify` takes `evaluation_code`; the evaluation qualifies for the active version (ADR-M86 §2.3) within `recertification_max_age_days`
- [ ] AC2: Aging: compared with the evaluation of the last activation on the shared tasks with the one test of ADR-M83; a significant drop refuses (`evaluation_quality_dropped`, a warning in `warn` mode); fewer shared tasks than `min_tasks` skip the comparison and say so; the platform never suspends by itself
- [ ] AC3: FR-36 unchanged: an overdue agent still runs, with the warning; `sdlc admin agent list --overdue` shows the latest qualifying evaluation; `agent.recertified` gains the evaluation ID and the result code
- [ ] AC4: Tests: fresh and old evaluations, a drop and no drop, too few shared tasks, both modes

> Note: ADR-M86 §2.6; QUESTIONS #499


### EXT — Other Git hosts first, then other agents, tools for agents, document knowledge: v0.6.0, X12 in v0.7.0 (QUESTIONS #361, #420, #424; v0.5.0 has the X09 spike)

#### X09. Spike: other Git hosts (GitLab, Backlog Git, Bitbucket)

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| S | B05 | NFR-05 | platform/spikes/git-hosts/* (thrown away), design/ADR-M70 |

**Acceptance criteria**

- [ ] AC1: Check each host's API against the 19 methods of `GitHostAdapter`: a short-lived token for one repository, polling of comments, reviews, merges and CI results, opening a pull request, reviews bound to a commit, who merged, CI checks, security findings, branch protection
- [ ] AC2: For each host: what works, what is missing for G6 and G7, and a workaround or a refusal
- [ ] AC3: ADR-M70: a ranking and the effort of each adapter

> Note: QUESTIONS #361 (Harry, 2026-10-10): clients use GitLab, Backlog Git and Bitbucket besides GitHub; adapters wait for a real project (X10)

#### X01. Spike: a second, open-source coding agent (Aider or OpenCode)

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| S | C05 | NFR-04, NFR-05, D-02 §4.2 | platform/spikes/agent2/* (thrown away), design/ADR-M68 |

**Acceptance criteria**

- [ ] AC1: Run Aider and OpenCode (pinned) in the node24 sandbox: the model only through LiteLLM with the run's virtual key, no other egress, no Git push; iteration and time caps, a stop on request, and counts for loop detection (`events`, `identicalCalls`)
- [ ] AC2: Compare them on two pilot tasks with the same model: result, time, tokens, how they report progress and stop
- [ ] AC3: Licences and supply chain (NFR-04): images, dependencies, Trivy
- [ ] AC4: ADR-M68: the choice, the `AgentAdapter` mapping (start, status, stop, commitWork, collectOutputs), what the agent register needs (an adapter column), the gaps

> Note: QUESTIONS #361 (Harry, 2026-10-10): an open-source agent first, to prove the interface is vendor-neutral; Claude Code later (licence and gateway to check first)

#### X02. Design: a tool register and MCP tools for agents

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| S | C04 | NFR-03, NFR-05, FR-33 | design/ADR-M69, design/D-03 §9, design/D-05, design/QUESTIONS.md |

**Acceptance criteria**

- [ ] AC1: ADR-M69: a tool register like the agent register (owner, version pinned by image digest, permissions, allowed data classes, approval by Person B or governance, statuses, never deleted)
- [ ] AC2: How a tool runs: a service on the run's own network through `docker/guard.ts` (like LiteLLM), or stdio inside the sandbox; a run gets a tool only when the plan, the agent register and the Run Contract all allow it; a short-lived, read-only credential handed over as a single-use wrapping token
- [ ] AC3: What is recorded: a run event per tool use with IDs, hashes and counts only, never queries or text; the kill switch revokes tool credentials too
- [ ] AC4: D-03 §9 and D-05 changes proposed in the same PR, for Harry's approval

> Note: QUESTIONS #361 (Harry, 2026-10-10): direction 2 (tools for agents); the first tool is X04

#### X03. A second agent adapter and the agent register's adapter column

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| L | X01 | NFR-05, FR-31, FR-32, FR-35, FR-36 | platform/packages/adapters/agent-<name>/*, platform/packages/contracts, platform/packages/core (agents), migrations, platform/apps/runner, platform/sandbox-images/*, platform/tests/*, design/D-05, design/ADR-M31, handbook Ch.20 |

**Acceptance criteria**

- [ ] AC1: The adapter chosen in ADR-M68 implements `AgentAdapter`; the runner drives it with the same caps, stops, kill switch and loop detection as OpenHands
- [ ] AC2: `agents.adapter` (migration, D-05, ADR-M31): every agent names its adapter; a project picks the agent by `run.agent_key` as today
- [ ] AC3: The pilot suite (`pnpm test:pilot`) and `pnpm test:agent` pass with the new adapter on the stub model; the sandbox egress and hardening tests unchanged
- [ ] AC4: Handbook Ch.20: registering an agent with another adapter

> Note: QUESTIONS #361. Multi-agent (several agents in one intent) stays after X03. The adapter is OpenCode (QUESTIONS #521, repository owner 2026-10-22), with the conditions of ADR-M68 §5–§6: one image per adapter in `sandbox.images.<adapter>` (#522); the adapter enforces the caps and checks its configuration on every status call (#523; the authenticating proxy before real client work); the binary pinned by sha512 integrity and a licence check of its dependency tree (#524)

#### X14. Spike: an open-source MCP gateway in front of a run's tools

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| S | X02 | NFR-03, NFR-04, NFR-05, D-01 §5.6 | platform/spikes/mcp-gateway/* (thrown away), design/ADR-M87, design/ADR-M69 |

**Acceptance criteria**

- [ ] AC1: Compare at least three self-hosted open-source MCP gateways (pinned versions): licence, maintenance, image size and vulnerabilities (Trivy), and whether one instance per run fits inside the run's networks of ADR-M69 §2.4
- [ ] AC2: Call-level policy: allow or refuse a call by tool name and argument rules, a per-run key, a call cap; refusals as codes; no query or answer in its logs (R031)
- [ ] AC3: What it records and how the runner reads counts from it (in place of, or next to, the agent's event stream; ADR-M69 §2.7); its memory and CPU per run
- [ ] AC4: ADR-M87: use a gateway from the first tool (X04), later, or not at all, with the changes to ADR-M69; never a gateway of our own (D-01 §5.6)

> Note: QUESTIONS #520 (repository owner, 2026-10-22): research the gateway before X04

#### X04. The tool register and the first tool: search the project's documents

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| L | X02, X14 | FR-33, FR-44, NFR-03 | platform/packages/core (tools, retention), migrations, platform/deploy (profile knowledge), platform/apps/runner, platform/apps/worker (retention), platform/tests/*, handbook Ch.19, Ch.20, runbook T11 |

**Acceptance criteria**

- [ ] AC1: The tool register of ADR-M69 and one read-only tool: search the project's Markdown documents in its repository (bge-m3 embeddings and a plain vector search, as K01 measured; no WeKnora), through MCP
- [ ] AC2: The index is built from the run's `base_sha`, so a run reads the documents of its own commit; one index per project and tenant
- [ ] AC3: The embedding model follows the data class rules (D-07 §4): `client_restricted` only with a self-hosted model, `prohibited` never
- [ ] AC4: Retention (FR-44, ADR-M51): the index holds client content, so the retention loop deletes it by the evidence rules and when a project is archived (unless held); `knowledge.purged` audited
- [ ] AC5: One run event `knowledge_read` per run and tool (the distinct document IDs of the index, never paths, with content hashes and counts; never queries or text), reported by the tool from outside the sandbox (QUESTIONS #533); the egress probe from a sandbox; another project's index refused

> Note: QUESTIONS #361 (Harry, 2026-10-10). Supersedes K02. ADR-M59 §5 lists the limits learned from K01. QUESTIONS #519: confirmed 2026-10-22, the OpenHands Agent Server 1.48.0 takes a per-run MCP server over HTTP with a header key (`mcp_config`). QUESTIONS #520, #529: one agentgateway per run (ADR-M87, ADR-M69 accepted). QUESTIONS #534: the index in a pgvector container of its own (profile `knowledge`), never the platform's PostgreSQL. QUESTIONS #535: the tool's credential from the OpenBao database secrets engine (a per-run read-only role on the project's index). Three PRs: the register, the contract and G4; the runner, the gateway and the adapter; the tool, the index and retention

#### X07. A context snapshot for every run

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| M | X04 | FR-40, FR-41 | platform/apps/runner, platform/packages/core (run events, evidence), platform/tests/*, handbook Ch.15 §15.10.2 |

**Acceptance criteria**

- [ ] AC1: For every run, a record of what the agent read: repository files (paths hashed, never paths in clear in append-only tables), documents found by tools (IDs, content hashes), the plan and spec versions; counts and hashes only
- [ ] AC2: The Evidence Pack lists the snapshot's hash and counts per run
- [ ] AC3: Never text, prompts or code in run events, logs or tables
- [ ] AC4: Tests: a stub-model run reads files and searches documents; the snapshot appears in the pack

> Note: QUESTIONS #361 (Harry, 2026-10-10): D-02 §4.2 "full context snapshots"

#### X11. Context condensing for agent runs

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| M | C05 | FR-31, FR-32, FR-35, D-07 §7 | platform/packages/adapters/agent-openhands, platform/packages/config, platform/apps/runner, platform/tests/*, design/ADR-M29, handbook Ch.13 |

**Acceptance criteria**

- [ ] AC1: Check the condenser options of the pinned OpenHands Agent Server (1.48.0): which condensers exist, how they are set per conversation, what events they add to the log; record the result in ADR-M29
- [ ] AC2: Project config `run.context_condensing` (off or summarize; maximum events, events kept at the start), validated by @sdlc/config with a mandatory rule (never on when the model's context size is unknown); the default is decided from the AC4 numbers
- [ ] AC3: Summarizer calls go through LiteLLM with the run's virtual key and the seven labels, count against the run budget, and use a model in `allowed_models`; summaries are client data: never in run events, logs, Temporal or any table (counts only: condensations, events dropped)
- [ ] AC4: Loop detection, the caps, the kill switch and the budget stop behave the same with condensing on (`identicalCalls` and `events` still counted correctly); `pnpm test:agent` with a stub model that runs past its context; numbers (tokens, time, result) from `pnpm test:agent-real` with and without condensing

> Note: QUESTIONS #395 (Harry, 2026-10-12): the platform sets no condenser today; small local models (`num_ctx` 32768) need it first (L02)

#### X12. Design: agent memory across runs

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| S | X07 | FR-11, FR-33, FR-40, FR-44 | design/ADR-M74, design/D-03, design/D-05, design/QUESTIONS.md |

**Acceptance criteria**

- [ ] AC1: ADR-M74 designs memory as Markdown files in the project's repository (for example `.sdlc/memory/*.md`), proposed by an agent and merged by a person (QUESTIONS #395, option A), and records why a platform store was not chosen (retention and purge, FR-44; tenants; data classes; prompt injection that persists across runs)
- [ ] AC2: A memory change goes in its own pull request, never with the code change, and never blocks a release; who approves it (never its producer, FR-11) and how an entry is removed
- [ ] AC3: How a run gets memory: read at the run's `base_sha`, capped, in its own nonce block, framed as data
- [ ] AC4: How memory fits the instruction-file rules: it is not `AGENTS.md` (an agent version change, QUESTIONS #94) and never triggers `instructions_unpinned` by mistake; what G5 does when a run changes a memory file
- [ ] AC5: What is recorded: run events with counts and hashes only (X07), never memory text; no code in this task; D-03 and D-05 changes proposed for Harry's approval

> Note: QUESTIONS #395 (Harry, 2026-10-12). Relates to X08 (lessons at G8)


### Models — Self-hosted models: L01 PR 1 and L03 in v0.6.0; then L01 PR 2 and the L03b measurement (QUESTIONS #362, #424)

#### L01. A self-hosted model service (vLLM) on an optional GPU host

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| M | L02 | D-07 §3, §4, NFR-01 | platform/deploy (profiles models-local, models-remote; gpu-host, gpu-link), platform/deploy/litellm/config.ctmpl, design/D-03 §10.1, design/D-07, design/ADR-M71, handbook T11 |

**Acceptance criteria**

- [ ] AC1: A Compose profile `models-local` with vLLM pinned (Apache-2.0), a health check and a limit of concurrent requests, on the server or a separate GPU host
- [ ] AC2: A LiteLLM entry `provider_type: self_hosted` with an internal cost per token above 0 (budgets keep working)
- [ ] AC3: D-03 §10.1 and D-07 changed and ADR-M71 written first (today: "API models only, no GPU"); runbook T11 and the deploy README
- [ ] AC4: A `client_restricted` project runs an agent end to end with the self-hosted model (stub or real)

> Note: QUESTIONS #362 (Harry, 2026-10-10): milestone Models after EXT; earlier when the company has a GPU. QUESTIONS #546 (Harry, 2026-10-24): two PRs; PR 1 the GPU in the platform server (internal network `models`, no port; AC1 for the server, AC2–AC4); PR 2 a separate GPU host with mutual TLS through a pinned nginx link (vLLM's `--api-key` leaves `/invocations` open; LiteLLM cannot present a client certificate). QUESTIONS #547–#550: ADR-M71. QUESTIONS #666–#669 (Harry, 2026-11-11, PR 2 plan): mutual TLS ended by nginx on both sides (a gateway on the GPU host instead of vLLM's own TLS), the profile `models-remote`, `gpu-link/tls.sh`, the live test `pnpm test:vllm-link`; ADR-M71 1.1

#### L03. GPU sizing note for leadership

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| S | L02 | D-07 | design/ (a short note) |

**Acceptance criteria**

- [ ] AC1: From the L02 numbers: which model size meets the quality bar, the GPU memory and count it needs, buy or rent (with the legal question of rented hardware for `client_restricted` data), the cost per month

> Note: QUESTIONS #362

#### L03b. Measure a 30B-class model on a rented GPU

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| S | L01, L03 | D-07 §9 | platform/eval (provider vllm, configs/gpu.yaml, gpu/), design/L03b-gpu-measurement-runbook.md, design/D-07 §9, design/L03-gpu-sizing-note.md |

**Acceptance criteria**

- [ ] AC1: `pnpm eval` runs a configuration whose model is served by the `vllm` service of the profile `models-local` (provider `vllm`), with unit tests
- [ ] AC2: A runbook the owner follows: what to rent, set-up, commands, expected cost, how to delete the machine
- [ ] AC3: After the owner's run: a results table in D-07 §9 (resolved, pass^5 and scope breaches against the bar of the L03 note, real GPU memory, tokens per second with 4 requests, time per run) for `Qwen3-Coder-30B-A3B-Instruct` (FP8) and `gpt-oss-20b`; L03 note 1.0 with a real cost per token
- [ ] AC4: The internal cost in `litellm/config.ctmpl` changes in a separate small task after the design docs (R092)

> Note: QUESTIONS #566, #567 (Harry, 2026-10-24): the harness gets a `vllm` provider; only the model service runs on the rented machine; fictional sample repository only, never client data; the owner runs it (R035)


### Server — A team on a server: v0.7.0 with O01, O02, H04, H05, V15; v0.8.0 with H02, H03, V16; O03 in v0.10.0; O04, O05 in v0.11.0; toward v1.0 (QUESTIONS #363)

#### A10. Resource measurement + backup / restore drill + internal CA / TLS

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| M | A03, A07, A11 | — | platform/deploy/backup/*, platform/deploy/openbao/tls.sh, handbook/03-templates/T11-openbao-runbook.md |

**Acceptance criteria**

- [ ] AC1: Internal CA + TLS on OpenBao 8200 (QUESTIONS #20): script creates the CA (5 years) and the server certificate (1 year); the CA key is kept offline; renewal steps and a 30-day reminder in T11; clients verify the CA
- [ ] AC2: Backup script: OpenBao snapshot (Raft), PostgreSQL dump, to storage off the server
- [ ] AC3: Restore drill succeeds on a test machine; OpenBao unsealed with 2 shares
- [ ] AC4: Record RAM/CPU/disk usage for the core and observability profiles
- [ ] AC5: Runbook T11 written in full

> Note: Three PRs (ADR-M63, QUESTIONS #325–#327): PR 1 = TLS on 8200 everywhere (AC1; a throw-away CA on development machines and in CI, `pnpm openbao:tls`, renewal without unsealing); PR 2 = backup and restore scripts, encrypted with age to a target folder, and a live restore drill with throw-away keys (AC2, AC3); PR 3 = with the infrastructure operator and the three key holders on the internal server (the company CA, AC4, AC5). Done together with the infrastructure operator. Also before the real server: the runner in its own VM or rootless Docker (ADR-M25 §2.5); done: ClickHouse's `langfuse` user has no access management, a loopback-only `sdlc_admin` makes `sdlc_purge` (ADR-M63 §6, QUESTIONS #330) Condition for the company server (Harry, 2026-10-13, QUESTIONS #455): the first real agent run needs the runner in its own VM or on rootless Docker until H07 exists; PR 3's checklist says so

#### V15. Release on the tag: one workflow builds the images, the lock file is a release asset

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| M | V04, V12, O02 | NFR-04, NFR-07 | .github/workflows/release.yml, .github/workflows/release-images.yml, .github/workflows/release-images-scan.yml, .github/workflows/npm-publish.yml, .github/workflows/ci.yml, platform/tools/release/*, platform/deploy/scripts/images.sh, platform/deploy/.gitignore, platform/deploy/README.md, RELEASING.md, CLAUDE.md, design/RULES.md, CHANGELOG.md, platform/tests/workspace/release.test.ts, platform/tests/deploy/release-images.test.ts, design/ADR-M94 |

**Acceptance criteria**

- [ ] AC1: The owner's steps are three: merge the version pull request, push the tag `vX.Y.Z` on its merge commit, approve the environment `npm`; no lock file pull request, no `pnpm release:lock`, no run of `release-images` on `main` (QUESTIONS #591)
- [ ] AC2: `release.yml` on the tag runs the release gate (no lock file check), checks that the commit is on `main`, calls `release-images.yml` with `push: true`, verifies every image with the signer `release-images.yml@refs/tags/vX.Y.Z`, creates the GitHub Release as a draft with the asset `images.lock`, publishes it, checks that it is immutable, then starts `npm-publish.yml` with `workflow_dispatch` on the tag (QUESTIONS #591, #594)
- [ ] AC3: `release-images.yml` pushes nothing until all six images on both architectures are built and scanned; a version pull request runs its build-and-scan stage (`release-images-scan.yml`, read only) from `ci.yml` (QUESTIONS #593)
- [ ] AC4: `npm-publish.yml` keeps its name and the environment `npm`, starts only by `workflow_dispatch`, and refuses a ref that is not a tag `vX.Y.Z` with a published GitHub Release; it checks the gate and the images with the Release's `images.lock` before the environment (QUESTIONS #594)
- [ ] AC5: A release checkout reads its lock file from `SDLC_IMAGES_LOCK` or downloads it once from the GitHub Release into the ignored `platform/deploy/.images/vX.Y.Z.lock`, refuses a file that is not complete, and stops with a clear error when the download fails; tags v0.6.0 and before work as before; the tracked `images.lock` and `lock.mjs` are removed (QUESTIONS #592)
- [ ] AC6: Tests: the workflows (jobs, permissions, triggers, the signer, the order of scan and push), `images.sh` (download, complete file, override, failure, older tags), the release gate; `RELEASING.md` 2.0, the deploy README, CLAUDE.md "Releases" and R089, `design/RULES.md` updated in the same PR (QUESTIONS #595)

> Note: QUESTIONS #591–#595 (Harry, 2026-10-26), ADR-M94. Changes V04 AC3 (the digests of a release checkout come from its Release, not from the tagged commit) and V12 AC2 (the tag workflow builds the images). The first release made this way checks that the environment `npm` and npm trusted publishing accept the dispatched run (ADR-M94 §2.3); a tag, a release, an image push and an npm publish stay the owner's actions (R040)

#### V16. `pnpm server:setup`: a guided fresh deployment on a server (steps 2–7)

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| M | V02, V08 | NFR-01, NFR-03 | platform/deploy/server-setup/* (new), platform/deploy/trial/src (the steps move to a shared module), platform/deploy/openbao/bootstrap.sh, platform/tools/claude-hooks/guard-bash.mjs, platform/deploy/README.md, handbook T11, design/ADR (next free number), design/RULES.md, platform/tests/deploy/*, platform/tests/integration/* (`test:fresh-deploy`) |

**Acceptance criteria**

- [ ] AC1: `pnpm server:setup --settings <file outside the repo>` runs deploy README "Fresh deployment" steps 2–7 in their order; the step code is shared with `trial:up` and `test:fresh-deploy`, so the three keep one sequence (R081); the Bash hook refuses the command for Claude (R035)
- [ ] AC2: Key custody as runbook T11 §3.2: when the three key holders have PGP keys, `init` encrypts each share with its holder's key (`-pgp-keys`) and the command never sees a share in clear (the default); without them it shows the shares one at a time and, after each holder confirms the copy, clears the screen and the scrollback; it refuses to run when its output is not a terminal; no share and no token is ever written to a file (QUESTIONS #616)
- [ ] AC3: The root token, made from two shares at a hidden prompt, is used only for `configure`, which revokes it; steps 4 and 5 use one admin token (role `platform-admin`) in one pass; no token goes into an environment variable, a command line or a log; when the command stops after it made the root token and before `configure`, it revokes the root token, and the next start says where the last one stopped (QUESTIONS #616)
- [ ] AC4: Step 4 reads each shared secret from a file named in the settings or at a hidden prompt; the LiteLLM master and salt keys are made inside the container; the database URLs are built from `.env` by the command; the optional parts (`observability`, `knowledge`, dashboard sign-in, dashboard actions) are a list in the settings and get their credentials commands and `.env` keys
- [ ] AC5: It can start again after a failure: each step checks the state (initialised, sealed, pending migrations, delivered credentials) and skips what is done; a failure names the step and the README section; it ends with `doctor`; messages go through the catalog
- [ ] AC6: Tests: the step order against the README, the refusal without a terminal, the root-token revocation on a stop, a second start after each step; `pnpm test:fresh-deploy` runs through the command with throw-away keys; the deploy README, runbook T11 and an ADR updated in the same task

> Note: QUESTIONS #616 and #618 (Harry, 2026-10-28). Must be done before A10 PR 3 (the company server's first real run). Still by hand: the company CA certificate (T11 §3c), the GitHub App, the key holders' presence. Bugs from trial reports come first (R123). Done: `pnpm server:setup` (ADR-M98; the shared steps in `platform/deploy/steps`; runbook T11 §3.2)

#### V18. One command to set up the runner host

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| M | O01, H07 | NFR-01, NFR-03 | platform/deploy/scripts (runner-host-setup.sh, a shared rootless-engine.sh, test-rootless-docker.sh), platform/tools/claude-hooks/guard-bash.mjs, platform/deploy/README.md ("The runner on its own Docker Engine"), handbook T11, design/ADR-M107, design/RULES.md, platform/tests/deploy/*, .github/workflows/ci.yml |

**Acceptance criteria**

- [ ] AC1: `sudo platform/deploy/scripts/runner-host-setup.sh --user <user> --mode same-server|vm` runs deploy README "The runner on its own Docker Engine" step 1 (subordinate IDs, the AppArmor profile for `rootlesskit` only, cgroup v2 delegation, linger, `dockerd-rootless-setuptool.sh install`, the check of `docker info`), the AuthZ plugin install of H07, on the same server the dummy interface of step 2, and the runner host's `.env` of step 5
- [ ] AC2: Safe to run again: each step checks the state first and says what is already done; `--dry-run` changes nothing; it fills only empty `.env` keys and refuses a key that already holds another value; it never sets `kernel.apparmor_restrict_unprivileged_userns=0`, never touches the machine's rootful Engine and refuses an Engine that holds the platform's data
- [ ] AC3: It checks Docker's packages and names the missing ones; it installs no package; WireGuard on a VM stays the infrastructure operator's job (QUESTIONS #672)
- [ ] AC4: The CI script `test-rootless-docker.sh` uses the same step code, so the jobs `runner-rootless` and `runner-split` test it; the Claude Code hook refuses the command
- [ ] AC5: Tests: the steps with a simulated host (first run, second run, a conflicting `.env` value, `--dry-run`, the AppArmor case), the README in step with the script; the deploy README, runbook T11 and ADR-M107 updated in the same task

> Note: QUESTIONS #671–#673 (Harry, 2026-11-11). After H07 (#496) is merged: it adds the AuthZ plugin install. PR 3 of the three (V20, V19, V18)

#### V19. `pnpm server:setup` runs steps 8–13

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| M | V16, V17 | NFR-01, NFR-03 | platform/deploy/server-setup/*, platform/deploy/steps/*, platform/apps/cli (`adlc ops … --db-url-stdin`), platform/packages/messages, platform/deploy/README.md (steps 8–14), handbook T11 §3.2, handbook Ch.19 §19.8d, design/ADR-M98, platform/tests/deploy/*, platform/tests/integration/deploy/* (`test:fresh-deploy`) |

**Acceptance criteria**

- [ ] AC1: With `tenant`, `admin`, `project_file` (the V17 file) and `sandbox_image` in the settings, the command goes on after step 7: the tenant and its first admin (`adlc ops bootstrap`), the project, team, agent and configuration (`adlc admin project apply`), the sandbox image by digest in the configuration, and the project AI record from the settings' `ai_record`, written with `adlc ops ai-record set` on behalf of Person A (QUESTIONS #671)
- [ ] AC2: The bootstrap token is shown once in the owner's terminal, with the screen and scroll-back cleared after the copy, then given to `adlc login --token-stdin`; the database URL reaches `adlc ops` on standard input (`--db-url-stdin`, new); no token or URL in a file, an argument, an environment variable or a log (R035, R143)
- [ ] AC3: It never approves the agent, never issues a team member's token and never creates or approves an intent: at the end it prints, per person, the commands that stay theirs (the agent owner's and Person B's approvals, step 14 for Person A)
- [ ] AC4: Each step checks the state and skips what is done (a second run changes nothing); the progress file records the step names
- [ ] AC5: Tests: the steps with a simulated platform (first run, second run, a stop in the middle), the README in step; `pnpm test:fresh-deploy` runs steps 2–13 through the command; the deploy README, runbook T11, handbook Ch.19 §19.8d and ADR-M98 updated in the same task

> Note: QUESTIONS #671, #673 (Harry, 2026-11-11). PR 2 of the three (V20, V19, V18)

#### V20. Team access and the runner link in the `server:setup` settings

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| M | V16, V09, O01 | NFR-01, NFR-03 | platform/deploy/server-setup/*, platform/deploy/steps/*, platform/packages/messages, platform/deploy/README.md ("Fresh deployment", "Team access", "The runner on its own Docker Engine"), handbook T11 §3.2, §3d, design/ADR-M98, platform/tests/deploy/* |

**Acceptance criteria**

- [ ] AC1: An `access` section (host name, bind address, port, the CLI's addresses, the TLS folder, the company CA's folder) writes the `SDLC_ACCESS_*` keys and `SDLC_API_TRUSTED_PROXY`, imports the certificate with `access:tls import`, starts the profile `access` in step 7, and derives the public origin of the dashboard sign-in; a different `dashboard.public_origin` is refused
- [ ] AC2: A `runner_link` section writes `SDLC_RUNNER_SOURCE_CIDR` before step 3, so the first `configure` accepts the runner host and the key holders meet once; after step 7 it writes `SDLC_RUNNER_LINK_ADDR` and `SDLC_RUNNER_DOCKER_HOST`, starts the profile `runner-link` instead of `sandbox`, and delivers `runner-credentials` to the runner host's Engine
- [ ] AC3: No secret in the settings or the `.env` keys it writes; a value already in `.env` that differs from the settings is refused, never overwritten; each step checks the state and skips what is done
- [ ] AC4: Tests: the settings (valid, refused), the `.env` keys, the order (the CIDR before `configure`, the profiles of step 7), a second run; the deploy README, runbook T11 and ADR-M98 updated in the same task

> Note: QUESTIONS #673 (Harry, 2026-11-11). PR 1 of the three (V20, V19, V18); the runner host itself comes with V18

#### H02. Dependencies an agent adds: licence, known vulnerabilities, name checks

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| M | C07, C08 | FR-33, NFR-04 | platform/packages/core (workflow G5/G6), platform/apps/runner (diff), platform/deploy/verdaccio, design/ADR (next free number), platform/tests/* |

**Acceptance criteria**

- [ ] AC1: Detect a run's new or changed dependencies from the stored diff (npm lock and manifest files first), outside the sandbox
- [ ] AC2: Check each one: an allowed licence (project config), known vulnerabilities, a name close to a popular package (typosquatting), a package published very recently; counts and codes in a run event, never package text
- [ ] AC3: A finding makes G6 HITL (or a `security` escalation for a critical one), also when the project's own CI has no scan
- [ ] AC4: The package proxy (Verdaccio) no longer shares its cache between tenants, or has none, decided with these checks (ADR-M80 gap G-5, Low); install scripts of new packages are shown as a finding (G-1, Medium)
- [ ] AC5: Tests on fixtures of lock files; handbook Ch.14 usage

> Note: QUESTIONS #440: G6 relies on the project's CI today; a project without a dependency scan lets anything through. ADR-M80 (H01): gap G-1, Medium (the proxy allows every npmjs package and runs install scripts in the sandbox, contained), and G-5, Low

#### H03. Design: deleting a client's data on request

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| S | E05, E08 | FR-44 | design/ (a new ADR), design/D-05 §10, design/QUESTIONS.md |

**Acceptance criteria**

- [ ] AC1: A design for a client's request to delete its data (for example under Japan's APPI or a contract): what is deleted (evidence files, Langfuse traces, personal data in `users`), what stays (hashes, codes and IDs in append-only tables, kept at least 2 years) and how the audit log records the deletion
- [ ] AC2: How it fits the append-only rule and the hash chain: no row of an append-only table is changed or deleted
- [ ] AC3: No code in this task; the implementation tasks follow Harry's approval

> Note: QUESTIONS #440: D-05 §10 says this needs its own design; there was no task. Done: ADR-M97, QUESTIONS #611–#615 (H03 design). The implementation: H03a, H03b, H03c

#### H03a. Client data deletion 1: tenant states and the anonymization of people

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| S | H03 | FR-44 | platform/packages/core (db, migrations), platform/tests/* |

**Acceptance criteria**

- [ ] AC1: A migration adds the tenant states `pending_deletion` and `purged` (ADR-M97 §2)
- [ ] AC2: `anonymizeUser()` replaces a person's personal data in `users`, `user_identities` and `project_configs` in one transaction (`deleted-<id>@redacted.invalid`); foreign keys stay valid
- [ ] AC3: Tests: the rows of `gate_decisions` and `audit_log` and the hash chain are unchanged after the anonymization; no append-only table gets an UPDATE or DELETE path

> Note: ADR-M97 §3 item 1 (QUESTIONS #611–#615)

#### H03b. Client data deletion 2: the worker's purge of files, traces and indexes

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| M | H03a | FR-44 | platform/apps/worker, platform/packages/core (retention), platform/packages/adapters (evidence-s3, traces-langfuse), platform/tests/* |

**Acceptance criteria**

- [ ] AC1: `RetentionLoop` gains `runClientPurgePass()`: after the 14-day grace period it deletes the tenant's evidence files, Langfuse traces and knowledge schemas, then anonymizes the people (H03a)
- [ ] AC2: An active hold (`evidence_holds`) or an open intent stops the purge of what it holds; the purge checks that S3 and Langfuse hold nothing more before it records the end
- [ ] AC3: The last audit event is `client_data.deleted` (IDs and counts only), the daily anchor is updated and the tenant becomes `purged`

> Note: ADR-M97 §2 phases 1–4, §3 item 2

#### H03c. Client data deletion 3: the request, the approval and the status commands

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| S | H03b | FR-44, NFR-08 | platform/apps/cli, platform/apps/api (admin), platform/packages/messages, platform/tests/*, handbook Ch.19 |

**Acceptance criteria**

- [ ] AC1: A tenant admin asks and cancels: `sdlc client request-data-deletion`, `sdlc client cancel-data-deletion`
- [ ] AC2: A platform operator approves and follows: `pnpm adlc ops client-data-deletion approve|list|status`; the requester never approves (two-person rule)
- [ ] AC3: An audit event for each step of the request; every text from the message catalog

> Note: ADR-M97 §2 (two-person rule, 14-day grace period), §3 item 3

#### H04. A secret scan of a run's diff before G5

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| S | C07 | FR-33, NFR-03 | platform/apps/runner (changes step), platform/packages/core (workflow G5), platform/packages/config, platform/tests/*, handbook Ch.14 |

**Acceptance criteria**

- [ ] AC1: The runner scans the stored diff (added lines only) for secret patterns (keys, tokens, private keys) outside the sandbox, with the rules of the repository's Gitleaks configuration or a built-in set; the run event holds a count and rule codes, never a match or a path
- [ ] AC2: A finding holds the run at G5 with a `security` escalation (like `instructions_unpinned`); a person decides; the pull request is never opened with the secret in it
- [ ] AC3: Tests with fake secrets in a fixture diff (none in a harmless diff); the canary search of `pnpm test:attack` still passes

> Note: ADR-M80 gap G-10, **Medium**: the agent may carry a secret it found in the repository into the diff; today G6 relies on the project's own CI scan

#### H05. A size bound for a change a person must review

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| S | C07, E01 | FR-12, NFR-03 | platform/packages/config, platform/packages/core (workflow G5/G7), platform/apps/runner, handbook Ch.15, platform/tests/* |

**Acceptance criteria**

- [ ] AC1: Config `run.review_limits` (changed files, changed lines; values and behaviour as Harry decides in QUESTIONS #456); the runner counts them from the diff it computes outside the sandbox
- [ ] AC2: A change over the limit holds the run at G5 with a visible reason code and a person decides (split the plan, or allow with a reason); counts only in run events
- [ ] AC3: Tests: a diff at the limit and over it; a generated-file allowance if decided

> Note: ADR-M80 gap G-9, **Medium**: a very large or generated diff defeats review at G7. Limits decided in QUESTIONS #456 (40 files, 1500 lines, per-project, held at G5 not blocked)

#### H07. A Docker authorization plugin that checks the body of container requests

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| M | A10, C04 | NFR-03 | platform/deploy (the plugin and its policy), platform/apps/runner (docker/guard.ts rules shared as data), design/ADR-M25 §2.5, handbook T11, platform/tests/integration/* |

**Acceptance criteria**

- [ ] AC1: A Docker authorization plugin (for example OPA) on the runner's Engine applies the same rules as `docker/guard.ts` to the body of `containers/create` and `networks/create`: no privileged container, host namespace, device, capability, bind mount or extra network
- [ ] AC2: One source for the rules (a data file read by the guard and by the policy), and a test that sends the same requests through both and fails when they differ
- [ ] AC3: A test that a request the guard would refuse is refused by the plugin when the guard is bypassed (a direct call to the socket proxy)
- [ ] AC4: Runbook T11: install, update and what to do when the plugin refuses a legitimate run

> Note: ADR-M80 gap G-7, **High** for the company server, Medium for a trial: the socket proxy limits endpoints, not the body (ADR-M25 §2.5). Mitigations 1 and 2 (a separate VM, rootless Docker) are A10 PR 3; see QUESTIONS #455

#### O01. The runner in its own VM or with rootless Docker

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| M | C04 | NFR-03 | platform/deploy/*, platform/apps/runner, platform/deploy/README.md, design/ADR-M25, platform/tests/* |

**Acceptance criteria**

- [ ] AC1: The runner, which controls Docker, runs isolated from the other services: a separate VM, or rootless Docker (ADR-M25 §2.5)
- [ ] AC2: The socket proxy allowlist and the sandbox hardening unchanged; the live runner tests pass in that set-up
- [ ] AC3: The deploy README: how to set it up on the server

> Note: QUESTIONS #363 (Harry, 2026-10-10): milestone Server, toward v1.0

#### O02. A tested upgrade between two releases

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| M | V12 | NFR-01, NFR-07 | platform/tests/integration/deploy/*, platform/deploy/README.md (Upgrade), CHANGELOG.md, .github/workflows/* |

**Acceptance criteria**

- [ ] AC1: A live test: deploy the previous release, create an intent and move it to a gate, upgrade to the new release (images, migrations, credentials commands of the upgrade notes), and the intent goes on; the audit chain verifies
- [ ] AC2: The deploy README's "Upgrade" section follows the test; a static test keeps them in step

> Note: QUESTIONS #363, #364

#### O03. Operational alerts

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| M | V07 | NFR-06 | platform/deploy/*, platform/apps/worker, platform/deploy/README.md, handbook T11 |

**Acceptance criteria**

- [ ] AC1: Alerts when a service stops being healthy, OpenBao is sealed, the disk or the backup target fills up, a backup did not run, or a TLS certificate nears its end; delivered to the operator (for example e-mail or a chat webhook, configured), never with a secret
- [ ] AC2: Built on `doctor` (V07) and the existing health checks; works with the profile `observability` off

> Note: QUESTIONS #363

#### O04. Data that only grows: run events, sessions, challenges, partitions

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| M | E05, U06 | FR-44, NFR-01 | platform/packages/core (retention), platform/apps/worker (retention loop), migrations, design/D-05 §10, platform/tests/* |

**Acceptance criteria**

- [ ] AC1: `run_events` older than the retention in D-05 §10 (1 year) are summarised into counts per run, then removed, with a grant of their own and an audit event; or D-05 is changed to keep them, with a reason
- [ ] AC2: Ended `web_sessions` and used or expired `passkey_challenges` are removed after a fixed time by the retention loop (D-05 §6.1 says a later task does it)
- [ ] AC3: A measured decision on monthly partitions for the append-only tables (D-05 §12): when the tables reach a size, and how the hash chain and the triggers stay intact
- [ ] AC4: Tests: `pnpm test:db` for each removal, the audit event, tenants

> Note: QUESTIONS #440

#### O05. Key rotation: the Run Contract signing key and the processes' secret IDs

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| M | C02, A10 | NFR-03 | platform/deploy/openbao/*, platform/packages/secrets, platform/apps/worker, handbook T11, design/ADR-M22, platform/tests/* |

**Acceptance criteria**

- [ ] AC1: Rotate the Transit key `run-contract` on a schedule; contracts signed before keep verifying until they expire (ADR-M22 §2.4); a test with a rotation between issue and start
- [ ] AC2: Renew the AppRole secret IDs before their 90 days end without a manual step on the server, or warn in `doctor` and the alerts (O03) well before
- [ ] AC3: Runbook T11: rotation, revocation of a leaked key, and how to check that nothing still uses the old one

> Note: QUESTIONS #440: D-03 §8 says rotation and revocation come later; there was no task


### Later — Not scheduled yet (was "MVP+1"; U01–U03 were started early there and are done; U07 and U08 are done in v0.8.0)

#### U01. Read-only web dashboard

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| M | B11, B13, E02, E04, E06 | D-02 §4.2, NFR-08 | platform/apps/dashboard (or inside platform/apps/api), platform/apps/api (static files only), platform/tests/*, design/ADR-M54 |

**Acceptance criteria**

- [ ] AC1: Read-only: the dashboard uses only existing GET endpoints of the API; no new write path, no form that changes state; a static test fails if it calls anything but GET
- [ ] AC2: Sign-in with an existing personal API token (`sdlc_pat_…`); the same access rules as the API (404 without a role, 403 with another role); the token is never put in a URL, a log or long-lived browser storage; sign-out forgets it
- [ ] AC3: Served on the same origin as `sdlc-api` (127.0.0.1 in Compose); a strict Content-Security-Policy (no inline script, no third-party origin; every asset served by the platform); no new host port
- [ ] AC4: Screens: intents and gates (current gate, who it waits for, waiting time, links to the issue and pull request); open escalations (severity, route, owner role, acknowledge and resolve due times); cost report and gate waiting times per project (E04, E06); an intent's evidence packs and, for tenant admins, the audit check (E02, A07)
- [ ] AC5: Every label and message through the message catalog (NFR-08); server text shown as text, never as HTML; keyboard use and colour contrast checked
- [ ] AC6: Tests: unit tests of the data mapping; API tests that the dashboard needs no new endpoint; an end-to-end smoke test (Playwright) against a test API; screenshots at 375, 768, 1440 px

> Note: QUESTIONS #255 (Harry, 2026-10-07): in parallel with the trial M-E, which does not wait for it. ADR-M54 records the framework and the token handling (for example in memory only). Decisions stay in comments, reviews and the CLI; actions in a web UI and the full MVP+1 interface scope come from the trial data after M-E (E07 note)

#### U02. The workflow's waiting reason in the API; one oversight resolution for notices

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| S | U01 | FR-22, NFR-08 | platform/packages/core (workflow, intents), platform/apps/api (intent presenter), platform/apps/dashboard, migrations (if needed), platform/tests/* |

**Acceptance criteria**

- [ ] AC1: The intent body (`GET /v1/intents` and `GET /v1/intents/:intent`) gains `waiting_reason`: a code for why the intent waits at its current gate (for example a G4 check that failed and its cause, `plan_resubmit_needed`, `spec_unavailable`, `git_host_unavailable`, `evidence_unavailable`, frozen by an escalation, a HOTL block window), or null when it does not wait or the reason is unknown
- [ ] AC2: The reason is read from what the intent workflow recorded in the step's transaction (an existing record, or a new column the step writes under the intent lock and clears when the intent moves); the API never evaluates the gate's checks a second time
- [ ] AC3: Codes only, each with a catalog label (NFR-08); no free text, no client data; a new column, if any, is a migration with a D-05 update
- [ ] AC4: QUESTIONS #264: `plan-check.ts` and `spec-check.ts` resolve their notice audiences with the shared `resolveGateOversight`; a test shows that after a return from G5 the `plan_changed` notice names G3's HITL approvers. Gate decisions do not change
- [ ] AC5: The dashboard shows the reason next to `waiting_for` on the intents board and the intent detail
- [ ] AC6: Tests: `pnpm test:db` for each recorded reason and its clearing; `pnpm test:workflow` unchanged; the presenter checked against the shared zod schemas

> Note: QUESTIONS #265 (Harry, 2026-10-07), ADR-M54 §4: U01's `waiting_for` names who decides, not what holds the intent. The CLI's `sdlc intent show` may print the reason too. Uses QUESTIONS #265–#269; ADR only if the plan needs a new decision (next free number)

#### U03. One CLI command creates an intent and links its spec

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| S | B04, B08 | FR-20, FR-02, NFR-08 | platform/apps/cli (intent create), platform/tests/cli/*, handbook Ch.19 §19.8c |

**Acceptance criteria**

- [ ] AC1: `sdlc intent create … --spec <path> [--spec-commit <sha>] [--spec-tool <tool>]` creates the intent, then links the spec with the existing API calls (`POST /v1/intents`, then `POST /v1/intents/:intent/specs`); no new endpoint, no change of rules or access checks
- [ ] AC2: When the spec link is refused (for example `spec_not_on_default_branch` or no role in `access.spec_link_roles`), the intent stays created: the output names its code and the refusal, and says to run `sdlc spec link <INT>` again; exit code 1
- [ ] AC3: `--json` returns both results (the intent and the spec, or the refusal code); every label from the message catalog (NFR-08)
- [ ] AC4: Tests against a mocked API: both calls succeed; the link is refused; the create is refused (no link attempted)

> Note: Option B2 of `design/POSITIONING.md` §6.1 (Harry, 2026-10-07): fewer steps for a Low-risk task, after the trial M-E. The plan cannot join this command: its file `.sdlc/plans/<INT>.yaml` is named after the intent code, so it is written and merged after the intent exists. Uses QUESTIONS numbers only if needed (next free block)

#### K02. Agents search the project's documents through WeKnora (MCP)

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| L | K01, C04, C05 | D-01 §5.8b, FR-31, FR-33 | platform/deploy (profile `knowledge`), platform/apps/runner (egress, MCP config), platform/packages/adapters/agent-openhands, platform/packages/core (run events), platform/tests/*, design/D-03 §9, design/ADR-M60 |

**Acceptance criteria**

- [ ] AC1: WeKnora runs in a Compose profile `knowledge`, pinned; one workspace per project; its own model calls go through LiteLLM with the seven labels
- [ ] AC2: A run reaches WeKnora only as a new sandbox egress service in `docker/guard.ts` (like LiteLLM and the package proxy), with a per-run read-only credential handed over as a single-use wrapping token; no long-lived key in the sandbox; only the project's workspace
- [ ] AC3: The agent gets only search and read tools over MCP; the data class rules apply (`client_restricted`: only when WeKnora and its model are self-hosted; `prohibited`: never)
- [ ] AC4: A run event records which documents the agent read: IDs and hashes, never text (context snapshot)
- [ ] AC5: D-03 §9 and §10 updated (sandbox egress); tests: the egress probe from a sandbox, a stub-model run that searches, another project's workspace refused

> Note: QUESTIONS #285 (Harry, 2026-10-08): only if ADR-M59 (K01) says go. **Deferred** (QUESTIONS #300, Harry 2026-10-08): K01 found WeKnora no better than a plain bge-m3 + cosine search on the pilot, slow LLM summaries, and a document reader image with 202 critical vulnerabilities and an AGPL-3.0 library; revisit at M-F when a project has Office or PDF documents outside its repository, with the limits of ADR-M59 §5. QUESTIONS #305–#309, ADR-M60. Code index and full context snapshots stay Later. **Superseded by X04** (QUESTIONS #361): document search without WeKnora; WeKnora is looked at again only for documents outside the repository (X05)

#### U07. Dashboard wave 1: kill a run, gate decisions, escalations

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| M | U06 | FR-10, FR-11, FR-16, FR-17, FR-18, FR-34 | platform/apps/dashboard, platform/apps/api (intents, runs, escalations), platform/packages/core (commands, gate input hash), migrations (source `web`), platform/packages/messages, platform/tests/*, handbook Ch.19, USER-GUIDE |

**Acceptance criteria**

- [ ] AC1: The dashboard calls only the existing endpoints: `POST /v1/runs/:run/kill`, `POST /v1/intents/:intent/gates/:gate/decisions`, `POST /v1/escalations/:code/ack|decisions`; no new business endpoint; the same core handlers decide
- [ ] AC2: A confirmation step shows what the decision is bound to and the current gate input hash (a new read-only field of the intent's `GET` answer, resolved by the workflow's own function); the decision sends `expected_input_sha256` and the API answers 409 when the input changed (optional for the CLI)
- [ ] AC3: Source code `web` in `gate_decisions.source` and the kill source (D-05 migration); the actor is the person's user ID; no session or passkey ID in an append-only table
- [ ] AC4: G7 is a link to the pull request only (no approve, no request changes); refusals are shown with their catalog code (producer, missing role, same person twice, frozen); the page has no rule set of its own
- [ ] AC5: Playwright: the producer, a wrong role and the same person twice are refused through the page (N5); screenshots at 375, 768, 1440 px, light and dark; `pnpm test:db` for the 409 and the source

> Note: ADR-M73, MVP1-UI-SCOPE 1.2 §3.2, §5.5–§5.7 (QUESTIONS #377, #378). U06 built the mechanism (ADR-M73 §2.3b, §2.4b, QUESTIONS #410–#414): mark the decision, kill and acknowledgement routes `@SessionAction('actions')` (they refuse sessions until then); in the gate and escalation decisions call `PasskeysService.verifyStepUp` on the body's `step_up`, then core `consumeStepUp` inside the decision's transaction with the binding (`stepUpRequestSha256` of the body without `step_up`); the page asks `POST /v1/auth/step-up` with the same body. QUESTIONS #424 (Harry, 2026-10-12): deferred from v0.3.0 until people in the trial or a team ask for decisions in the dashboard; the comments and the CLI already decide every gate. Done 2026-10-29: PR #462, then the tests, the refusal texts, the escalation step-up fix and the handbook in the U07 finish PR

#### U08. Dashboard wave 2: create an intent with its spec, submit a plan, evidence packs

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| M | U07 | FR-01, FR-02, FR-20, FR-40 | platform/apps/dashboard, platform/packages/messages, platform/tests/*, handbook Ch.19 |

**Acceptance criteria**

- [ ] AC1: Create an intent and link its spec with the two calls of U03; a refused link keeps the intent and says so
- [ ] AC2: Submit the plan file; build an evidence pack; the L1 proposal download stays in the CLI (the page shows the `sdlc evidence proposal` command)
- [ ] AC3: Refusals from the catalog; no step-up (ADR-M73); Playwright tests per action and role

> Note: MVP1-UI-SCOPE 1.2 §3.3. Ordered again from `design/M-E-REPORT.md` (§9). Done 2026-10-29: create an intent in PR #462; its spec link, the plan submission, the Evidence Pack build, the proposal command, the refusal texts and the tests in the U08 PR (ADR-M73 1.6)

#### U09. Dashboard wave 3: administration

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| L | U07 | FR-11, FR-19 | platform/apps/dashboard, platform/packages/messages, platform/tests/*, handbook Ch.19 |

**Acceptance criteria**

- [ ] AC1: Projects, users, GitHub identities (numeric ID), project roles and tenant admins; a self-grant and Person A = Person B refused (M21)
- [ ] AC2: Project configuration upload with the difference to the stored version before saving; the agent register and its approvals; the AI record; evidence holds; project archive
- [ ] AC3: Step-up for every admin change; API tokens stay in the CLI; Playwright tests per action and role

> Note: MVP1-UI-SCOPE 1.2 §3.4. Ordered again from `design/M-E-REPORT.md` (§9). Done 2026-11-12 in three PRs: the step-up for every admin route (PR #513), the pages for projects, configuration, people and tenant admins (PR #514), then the agent register, the AI record, evidence holds, project archive, a person's passkeys and handbook Ch.19 (ADR-M73 1.7–1.9, ADR-M54 0.8; QUESTIONS #681–#686)

#### V14. Human-effort baseline for the agent report

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| S | V13 | FR-53 | platform/packages/core (intents), migrations, platform/apps/api, platform/apps/cli, platform/tests/*, design/D-05 |

**Acceptance criteria**

- [ ] AC1: A person with a write role may record an estimate of the human effort for an intent (hours, a number; codes and numbers only, no text); empty by default
- [ ] AC2: `sdlc metrics agents` shows the time compared with the estimate when one exists; D-05 and a migration in the same task

> Note: QUESTIONS #431 (Harry, 2026-10-12): split out of V13 AC4 so that V13 stays read-only with no migration. Done 2026-11-12 in one PR: `intents.human_effort_hours` (migration 0050, D-05 1.70), `adlc intent estimate`, and the column "Lead / estimate" of `adlc metrics agents`: the merged intents' lead time against the estimate (ADR-M79 0.4 §2.6, QUESTIONS #691–#693)

#### H06. An optional stronger sandbox runtime (gVisor or Kata)

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| M | C04, A10 | NFR-03 | platform/apps/runner (docker/guard.ts, settings), platform/deploy, design/ADR-M25, platform/tests/integration/runner/* |

**Acceptance criteria**

- [ ] AC1: Config `sandbox.runtime` (default the Engine's own); with `runsc` or `kata` the runner passes the runtime through the guard allowlist and refuses it when the Engine does not list it
- [ ] AC2: `pnpm test:runner` and `pnpm test:attack` pass on the stronger runtime; the cost in start time and memory is measured and written down
- [ ] AC3: Handbook and deploy README: when to use it (shared host, untrusted repositories)

> Note: ADR-M80 gap G-6, **Medium**: the sandbox shares the host's kernel; a kernel bug is an escape. Until then the runner runs in its own VM (A10)

#### X05. Documents outside the repository (Office, PDF, Confluence, Drive, Backlog)

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| L | X04 | FR-33, FR-44 | platform/deploy (profile knowledge), platform/packages/core (tools), platform/tests/*, design/ADR (next free) |

**Acceptance criteria**

- [ ] AC1: Read requirement documents that live outside the repository (Office and PDF files; Confluence, Google Drive or Backlog wiki), with WeKnora's document reader or another, by the limits of ADR-M59 §5
- [ ] AC2: Same rules as X04: per project and tenant, data classes, retention and purge, `knowledge_read`

> Note: QUESTIONS #361: when a real project has such documents (Japanese projects: 要件定義書, 設計書). Re-run the K01 spike on them first

#### X06. A code index for agents (Tree-sitter or SCIP and pgvector)

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| L | X04 | NFR-05 | platform/packages/core (tools), platform/deploy, platform/tests/*, design/ADR (next free) |

**Acceptance criteria**

- [ ] AC1: A read-only tool that finds symbols and related files in the project's code at the run's `base_sha`
- [ ] AC2: Shares the tool register, the index lifecycle and retention of X04

> Note: QUESTIONS #361: D-01 §5.8b code context

#### X08. Knowledge for people and the G8 learning loop (design first)

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| S | X07 | FR-40, FR-42 | design/ (a new design document), design/QUESTIONS.md |

**Acceptance criteria**

- [ ] AC1: A design for people to find past intents, decisions and evidence (search, links), and for lessons recorded at G8 ("Release / Learning") that propose changes to `AGENTS.md` or the handbook
- [ ] AC2: No code in this task; implementation tasks follow Harry's approval

> Note: QUESTIONS #361. Design done in ADR-M109 (accepted with X08a PR 1, QUESTIONS #706–#710, #721–#725); X08a and X08b build it

#### X08a. Intent search and links for people

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| M | X08 | FR-40, FR-42, NFR-08 | platform/packages/core (intents, migration), platform/apps/api, platform/apps/cli, platform/apps/dashboard, platform/tests/*, handbook Ch.19 |

**Acceptance criteria**

- [ ] AC1: `GET /v1/intents` filters `gate`, `risk_tier`, `created_from`/`created_to`, `closed_from`/`closed_to` (`intents.closed_at`, QUESTIONS #722), `sealed` and `q` (2–200 characters), always inside the tenant and the projects the caller may read (ADR-M109 §2.1)
- [ ] AC2: `q`: PostgreSQL full-text search with the `simple` configuration on a generated column `intents.search_tsv` (title and description) with a GIN index measured on 10,000 intents; an intent code or `#<number>` matches its column; bound parameters only; `q` never in logs or spans; a client data deletion turns the title and description into the tombstone (QUESTIONS #725)
- [ ] AC3: `adlc intent list` options and a dashboard search box with the filters in the URL; every text from the catalog
- [ ] AC4: The intent body gains a `links` object (issue, pull request, spec, plan, Evidence Pack) built from stored codes, the addresses from `GitHostAdapter.webUrl` (QUESTIONS #723); handbook Ch.19 usage
- [ ] AC5: Tests as ADR-M109 §5 (X08a)

> Note: Two pull requests (QUESTIONS #724): PR 1 the database, the API, the CLI and the links; PR 2 the dashboard. ADR-M109 accepted with PR 1

#### X08b. Lessons at G8 and the learning loop

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| M | X08, X08a | FR-11, FR-21, FR-40 | platform/packages/core (lessons, migration, poller command), platform/apps/api, platform/apps/cli, platform/apps/dashboard, platform/packages/config, platform/packages/messages, platform/tests/*, design/ADR-M27, handbook Ch.19, Ch.20 |

**Acceptance criteria**

- [ ] AC1: The comment command `/lesson <category> <target>` with the words below the first line, and `adlc lesson add` / the API with a comment URL (checked: the intent's issue or pull request, and it exists, QUESTIONS #729); the platform stores codes, IDs and the link only, in the append-only tables `intent_lessons` and `intent_lesson_outcomes` (D-05 §6.12)
- [ ] AC2: Person A, Person B of the project or a tenant admin; never a bot or an agent; from G8 until `learning.lesson_window_days` (default 14) after the intent closes; G8 never waits for a lesson; the `released` notice invites people to record one
- [ ] AC3: Outcomes `applied` (with a link) and `dropped` (a code); `adlc intent create --from-lesson`; `adlc lesson issue` prints a filled-in new-issue link for the handbook with codes and the link only (QUESTIONS #727)
- [ ] AC4: The filter `has_lessons` of `GET /v1/intents` and `adlc intent list --has-lessons`, and `links.lessons` and `links.follow_ups` of the intent body (moved from X08a, QUESTIONS #721)
- [ ] AC5: `adlc lessons list` and `adlc metrics lessons` for the monthly learning step; the dashboard's read-only list on a project (recording from the dashboard later, QUESTIONS #728); handbook Ch.19 and Ch.20 usage, a note for the handbook's authors (Ch.15, Ch.16, T14 stay theirs)
- [ ] AC6: Tests as ADR-M109 §5 (X08b)

> Note: Three pull requests (QUESTIONS #726): PR 1 the tables, the setting and `/lesson`; PR 2 the API and the CLI; PR 3 the dashboard. Starts after X08a (ADR-M109 accepted, QUESTIONS #710); updates ADR-M27 §2.4 (one command may match a finished intent)

#### X10. An adapter for a second Git host

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| L | X09 | NFR-05 | platform/packages/adapters/git-<host>/*, platform/tests/*, platform/deploy/README.md |

**Acceptance criteria**

- [ ] AC1: The host ranked first in ADR-M70 implements `GitHostAdapter`; the gate tests pass on its stub
- [ ] AC2: One task per host when a real project needs it

> Note: QUESTIONS #361

#### X13. Agent memory

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| L | X12 | FR-11, FR-33, FR-44 | as ADR-M74 decides; platform/apps/runner, platform/packages/adapters/agent-openhands, platform/tests/*, handbook Ch.13, Ch.20 |

**Acceptance criteria**

- [ ] AC1: Built as ADR-M74 decides; handbook Ch.13 and Ch.20 usage
- [ ] AC2: Tests for every rule of X12: approval by a person who is not the producer, removal, caps, the data framing against injection, retention, another project's memory refused

> Note: QUESTIONS #395 (Harry, 2026-10-12)

#### O06. Real repositories: very large trees, monorepos, repositories without CI or AGENTS.md

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| M | C08 | NFR-05 | platform/packages/adapters/git-github, platform/packages/core (G4, G6), handbook Ch.13, Ch.14 |

**Acceptance criteria**

- [ ] AC1: G4 refuses a tree the Git host lists only in part (`tree_truncated`): a way to run on very large repositories (a recursive listing in pages, or a check of only the instruction paths)
- [ ] AC2: Monorepos: one project per package, or several projects on one repository, with their own plans and checks
- [ ] AC3: Clear refusals and onboarding steps for a repository without CI or without `AGENTS.md`

> Note: QUESTIONS #440: the trial on a real internal tool (M-F) may meet these first

#### O07. Load test: many intents and tenants at once

| Size | Depends on | Requirements | Code area |
|---|---|---|---|
| M | O03 | NFR-01 | platform/tests/load/*, platform/deploy/README.md |

**Acceptance criteria**

- [ ] AC1: A repeatable load test with stub models: many intents and tenants at once through the poller, the workflow, the runner queue and the database; GitHub API rate limits measured
- [ ] AC2: The numbers and the limits written in the deploy README (how many intents, runs and tenants one server takes)

> Note: QUESTIONS #440

---

## 5. Handing tasks to Claude Code

### 5.1. Rules for each session [Proposal]

1. **One session = one task** (L tasks are split into 2–3 sessions).
2. Claude Code **reads the task and related docs**, then **proposes a plan**: files to change, tests to add. A human approves the plan before coding.
3. Only change files in the approved plan. Need more → stop and ask.
4. Run lint + tests. Open a PR using template T2, with the task ID (e.g. `A07`).
5. If a design doc is **missing or contradictory** → do not guess. Add the question to `design/QUESTIONS.md` and stop.
6. New technical decisions (library choice…) → write a short ADR in `design/`.

### 5.2. Session opening prompt

```text
Task: A07 — Append-only audit log + hash chain
Read: design/D-08 (task A07), design/D-05 section 7, CLAUDE.md.
Step 1: propose a plan (files to create/change, tests to write, risks). Do not code yet.
Step 2: after I approve, code + tests matching acceptance criteria AC1–AC4.
Step 3: run lint + tests, summarise the results, open a PR with the T2 template.
If a doc is missing or contradictory: add the question to design/QUESTIONS.md and stop.
```

### 5.3. Creating GitHub issues from the CSV

- `D-08-backlog.csv` columns: `id, milestone, title, size, depends_on, requirements, area, acceptance_criteria, note`.
- Use `scripts/create-issues.py` (see `platform/GETTING-STARTED.md`): creates milestones, labels and issues; supports `--dry-run`; never creates duplicates.

---

## 6. Risks

| Risk | Mitigation |
|---|---|
| A task is bigger than one session; Claude Code leaves it half done | Split as noted. Re-assess sizes after M-A |
| The OpenHands Agent Server does not behave as expected | Do C01 early. If it fails → reconsider the agent (the interface allows replacing it) |
| Gaps in the design docs | `design/QUESTIONS.md` + review after every milestone |
| Size estimates are wrong | Record actual time per task; adjust for the next milestone |

---

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-09-24 | Claude (draft) | First version: 40 tasks, 5 milestones |
| 0.2 | 2026-09-24 | Claude (draft) | After review: SeaweedFS, Valkey, GitHub polling, G7 rule, M-D tasks renamed `E01…E07` |
| 1.0 | 2026-09-24 | Claude, approved by Harry | Handbook alignment: B01 oversight/approvers, B07 binding, new B11 escalation, B12 AI record, C10 agent register, C11 kill switch; E01 dual approval; E02/E03 disclosure; E05 retention; tests N7–N9 |
| 1.1 | 2026-09-25 | Claude, approved by Harry | C03: provider keys via an OpenBao Agent sidecar (QUESTIONS #1). A10: internal CA and TLS on OpenBao 8200, size S → M (QUESTIONS #20) |
| 1.2 | 2026-09-25 | Claude, approved by Harry | New task A11: stop publishing the OpenBao port on the host (QUESTIONS #27); A10 now depends on A11 |
| 1.3 | 2026-09-27 | Claude (task C04), approved by Harry | C04 AC1: sandbox egress to LiteLLM and the package proxy only, GitHub through the runner; C08 note: the runner pushes, update the D-03 §4 flow and D11 (QUESTIONS #52, #59, ADR-M25) |
| 1.4 | 2026-09-27 | Claude, approved by Harry | New task B13 (admin onboarding, B03 decision D1); E07 depends on B13 |
| 1.5 | 2026-09-27 | Claude (task C04), approved by Harry | C06 AC4: the `sdlc-runner` task queue and heartbeat activity move from C04 to C06; size S → M (QUESTIONS #55, ADR-M25 §2.7) |
| 1.6 | 2026-09-27 | Claude (task B11), approved by Harry | B11 AC3: clocks in the database, advanced by the worker (QUESTIONS #73, ADR-M28); B11 AC5 and B04 AC4: the escalation CLI moves to B04 (QUESTIONS #77) |
| 1.7 | 2026-09-27 | Claude (task C05), approved by Harry | C07 and C08 notes: sandbox outputs are untrusted, changed files and `head_sha` recomputed from the pushed branch outside the sandbox (ADR-M29 §2.5); C07: iteration cap vs cost cap by `stop_reason`, uncommitted edits of a stopped run (QUESTIONS #82) |
| 1.8 | 2026-09-27 | Claude (task C10), approved by Harry | E07 AC4: QUESTIONS #81 (a real run with an API model before M-E); B13 AC7: admin endpoints for the agent register with the Ch.20 approval rules; B13 AC8: stored configurations after a change of platform defaults (QUESTIONS #95); C06 note: the agent check and the recertification notice (ADR-M31) |
| 1.9 | 2026-09-27 | Claude (task B07, session 2), approved by Harry | C06 note: no run before the last HOTL block window closes (`hotlBlockWindowOpenUntil`; QUESTIONS #88, ADR-M30 §2.4b) |
| 1.10 | 2026-09-27 | Claude (task B12), approved by Harry | B04 AC5: `sdlc ai-record show|set` over the B12 API; B12 note: codes only, version history, write roles, API + operator command (QUESTIONS #103–#106, ADR-M32) |
| 1.11 | 2026-09-27 | Claude (task C06, session 2b), approved by Harry | C07, C08 notes: reuse the runner's workspace export and hardened git; E02 note: builds on `EvidenceStore` and `evidence_items`, re-checks hashes, own identity for packs; E05 note: object lock (per-bucket lock vs per-project retention and `retention_hold`) (ADR-M33 §2.9) |
| 1.12 | 2026-09-30 | Claude (task A08), approved by Harry | E05 note: project archive and retention also purge the project's Langfuse data (prompts and responses are client data; ADR-M35) |
| 1.13 | 2026-10-03 | Claude (task C07, PR 2), approved by Harry | C08 note: after a G5 `resume` the next run continues from the pushed `agent/INT-...` branch; wait for the G5 block window (QUESTIONS #134, ADR-M34 §2.9) |
| 1.14 | 2026-10-03 | Claude (task B09, PR 1), approved by Harry | B09 note: two PRs; E01 note: the change flags of the plan G3 approved (ADR-M40, QUESTIONS #165–#169) |
| 1.15 | 2026-10-04 | Claude, approved by Harry | New task C12: the scheduled spend sync of ADR-M24 §2.5, which was never built (QUESTIONS #197, ADR-M45); E07 depends on C12; E07 note: plan the MVP+1 user interface after M-E |
| 1.16 | 2026-10-04 | Claude (task E02), approved by Harry | E03 note: seal one version of the pack, the disclosure check, how the worker builds the pack (open); E05 note: purge the pack files of every version, keep the rows, sweep unreferenced files (ADR-M48, QUESTIONS #215–#217) |
| 1.17 | 2026-10-04 | Claude (task E03), approved by Harry | E03 note: done (release hash, `worker-evidence`), MVP+1 `release.environment` and the PM/BrSE disclosure confirmation; C12 note: late cost records void G8 approvals; E05 note: the worker identity, pack versions at G8 (ADR-M49, QUESTIONS #220–#222) |
| 1.18 | 2026-10-04 | Claude, approved by Harry | New tasks A12 (close the unauthenticated SeaweedFS filer and volume access, QUESTIONS #239; E07 depends on it) and E08 (purge the Langfuse data of a project, QUESTIONS #238), both found by E05 |
| 1.19 | 2026-10-04 | Claude (task E05, PR 1), approved by Harry | E05 AC1: holds per intent (`evidence_holds`); E05 note: two PRs, the lock, the purge, holds, archive grace, what is not in E05 (ADR-M51, QUESTIONS #235–#239) |
| 1.20 | 2026-10-06 | Claude, approved by Harry | A10 note: the runner VM or rootless Docker, ClickHouse access management (ADR-M25 §2.5, ADR-M53) |
| 1.21 | 2026-10-06 | Claude, approved by Harry | E07 AC4: the API-model run is needed before M-F, not before M-E; the trial M-E runs with the local Ollama model (QUESTIONS #81) |
| 1.22 | 2026-10-07 | Claude, approved by Harry | New milestone MVP+1 (started early) with task U01, a read-only web dashboard, in parallel with the trial M-E (QUESTIONS #255) |
| 1.23 | 2026-10-07 | Claude, approved by Harry | New task U02: the workflow's waiting reason in the API and one oversight resolution for the plan and spec notices (QUESTIONS #264, #265) |
| 1.24 | 2026-10-07 | Claude, approved by Harry | New task U03: one CLI command creates an intent and links its spec (`design/POSITIONING.md` §6.1, option B2) |
| 1.25 | 2026-10-08 | Claude, approved by Harry | New milestone Pre-M-E with tasks S01, S02 (BMAD / Spec Kit structure, plan drafts) and K01, K02 (WeKnora), before the trial M-E (QUESTIONS #285) |
| 1.29 | 2026-10-09 | Claude, approved by Harry | New task C13 in Pre-M-E: take an L1 proposal forward (download, G4 rejection; ADR-M64, QUESTIONS #335–#337) |
| 1.30 | 2026-10-09 | Claude, approved by Harry | New milestone M-E with task V01: the trial is run by the community (TRIAL.md, a report issue template, `sdlc trial report`; QUESTIONS #340, #341, ADR-M65) |
| 1.31 | 2026-10-09 | Claude, approved by Harry | M-E tasks V02 (`pnpm trial:up`), V03 (the GitHub App from a manifest), both before v0.1.0, and V04 (images on GHCR, after v0.1.0) (QUESTIONS #342) |
| 1.32 | 2026-10-10 | Claude, approved by Harry | New milestone UX (v0.2.0): V04 moved there, new tasks V05 (CLI on npm), V06 (`sdlc next`), V07 (`doctor`), V08 (the trial stack survives a reboot), V09 (team access, TLS reverse proxy), V10 (a friendlier CLI, `sdlc help`), V11 (plan the dashboard's actions) (QUESTIONS #355–#357) |
| 1.33 | 2026-10-10 | Claude, approved by Harry | Review of the milestone UX: V05 adds `sdlc --version` and its smoke test runs `sdlc` without arguments (`sdlc help` comes with V10); V08 also updates CLAUDE.md and runbook T11; V09 names both sources of "not supported"; V11 starts now, before the trial data, and supersedes the E07 note (QUESTIONS #358) |
| 1.34 | 2026-10-10 | Claude, approved by Harry | "MVP" retired: the platform backlog, v0.1.0 is the baseline (QUESTIONS #360); milestone UX gains V12 (release process) and L02 (model benchmark, early); new milestones EXT (X01–X04, X07, X09; QUESTIONS #361), Models (L01, L03; #362), Server (A10 moved there, O01–O03; #363), Later (was MVP+1: U01–U03 done, K02 superseded by X04, X05, X06, X08, X10); a public ROADMAP.md generated with D-08 |
| 1.35 | 2026-10-10 | Claude (task V11), approved by Harry | V11 done (`design/MVP1-UI-SCOPE.md` 1.2, ADR-M73): new tasks U05–U07 in UX (GitHub sign-in and sessions, CSRF and passkey step-up, wave 1: kill, gate decisions, escalations) and U08–U09 in Later (waves 2 and 3); U05 includes the V03 change (the App keeps its client secret); no dependency on V09 (QUESTIONS #375–#380) |
| 1.36 | 2026-10-10 | Claude (task V12), approved by Harry | V12 note: AC2 as built (the tag verifies the images built before it; npm stays its own workflow with the same gate; `pnpm release:lock`), AC3 from 0.1.1 on (QUESTIONS #390) |
| 1.37 | 2026-10-12 | Claude, approved by Harry | New tasks X11 (context condensing for agent runs) and X12 (design: agent memory across runs) in EXT, X13 (agent memory) in Later (QUESTIONS #395) |
| 1.38 | 2026-10-12 | Claude, approved by Harry | Release v0.2.0 after V08, without waiting for U06 and U07; the rest of the milestone UX (U07, V10, L02) goes into v0.3.0 and EXT moves to v0.4.0 (QUESTIONS #420) |
| 1.39 | 2026-10-12 | Claude (task U06, PR 1), approved by Harry | U07 note: how to wire the step-up and the session routes that U06 built (ADR-M73 §2.3b, §2.4b, QUESTIONS #410–#414). Numbered 1.38 at first, like the row above; renumbered in 1.40 |
| 1.40 | 2026-10-12 | Claude (docs review for v0.2.0), approved by Harry | The header shows the latest version; the second 1.38 row renumbered 1.39; ROADMAP.md marks each released task with its release (v0.1.0, v0.1.1, v0.2.0). No task changed |
| 1.41 | 2026-10-12 | Claude, approved by Harry | L02 becomes an evaluation harness for agents, models and prompts (hidden tests, N runs, pass^k, confidence intervals, ADR-M78), size L; new task V13, the agent efficiency report from real runs (QUESTIONS #422) |
| 1.42 | 2026-10-12 | Claude, approved by Harry | L02: a blind pairwise ranking by a reviewer, a growing task set reported per version, and a spike that reuses an existing evaluation framework where it fits (QUESTIONS #423) |
| 1.43 | 2026-10-12 | Claude, approved by Harry | Plan review after v0.2.1 (QUESTIONS #424): U07 moves to Later until trial users ask for it; v0.3.0 = V13, L02, V10; X09 first in EXT and L01 early in v0.4.0 |
| 1.44 | 2026-10-12 | Claude (task V13), approved by Harry | V13: access rule and model attribution (QUESTIONS #430–#433); its human-effort baseline (AC4) split out as V14 in Later |
| 1.45 | 2026-10-13 | Claude, approved by Harry | Plan review after V13 (QUESTIONS #440): new tasks H01 (threat model and attack tests, UX), H02 (dependencies an agent adds), H03 (design: client data deletion), O04 (data that only grows), O05 (key rotation) in Server; O06 (real repositories), O07 (load test) in Later; more items in "Also later"; prefix `H` |
| 1.46 | 2026-10-13 | Claude (task L02, PR 3), approved by Harry | L02 note: kept diffs for blind pairs (QUESTIONS #445); Langfuse scores later (QUESTIONS #446) |
| 1.47 | 2026-10-13 | Claude, approved by Harry | New milestone EVAL after v0.3.0, before EXT (QUESTIONS #450): L04 (evaluations on the server, one engine with developer machines), L05 (evaluation plans by managers), L06 (reports and recommendations), L07 (a project's task set from its merged intents), L08 (design: evaluations in the agent register's approvals) |
| 1.49 | 2026-10-13 | Claude (task H01, PR 3), approved by Harry (QUESTIONS #455, #456 answered) | H01 done: its gaps become H04 (secret scan of the diff, Medium), H05 (diff size bound, Medium), H06 (stronger sandbox runtime, Later), H07 (Docker authorization plugin, High) and two criteria of H02; QUESTIONS #455, #456 |
| 1.50 | 2026-10-16 | Claude, approved by Harry | Release v0.4.0 with L04 and L05 (the first part of EVAL); EXT and Models move to v0.5.0; L06–L08 finish EVAL first |
| 1.51 | 2026-10-20 | Claude (task W01, PR 1), approved by the repository owner | New milestone DEV with task W01: rules as checks (a rules register, hooks, lint and tests, a shorter CLAUDE.md; QUESTIONS #479, ADR-M84) |
| 1.52 | 2026-10-20 | Claude (task L07, PR 1), approved by the repository owner | L07 note and code areas: task cards in the project's repository, the check on the server, the reviewer rule (ADR-M85, QUESTIONS #485–#487) |
| 1.53 | 2026-10-20 | Claude (task L08), approved by the repository owner | L08 design (ADR-M86, QUESTIONS #496–#500); new tasks L09 (evaluations in the agent approvals) and L10 (evaluations in the recertification) |
| 1.54 | 2026-10-21 | Claude, approved by the repository owner | Release v0.5.0 with L06–L10 (EVAL complete), W01 and the X09 spike; EXT and Models move to v0.6.0 |
| 1.55 | 2026-10-22 | Claude (task X02), approved by the repository owner | New task X14: spike of an open-source MCP gateway before X04 (QUESTIONS #520, ADR-M87); X04 depends on X14 and starts by checking MCP in OpenHands (QUESTIONS #519) |
| 1.56 | 2026-10-22 | Claude (docs), approved by the repository owner | X03 note: OpenCode and the conditions of ADR-M68 (QUESTIONS #521–#524) |
| 1.57 | 2026-10-24 | Claude, approved by the repository owner | Release v0.6.0 with X01–X04, X07, X11, X14 (EXT except X12), L01 PR 1 and L03; X12, L01 PR 2 and the L03b measurement come next |
| 1.58 | 2026-10-26 | Claude, approved by Harry | New change task V15: the release on the tag (QUESTIONS #591–#595, ADR-M94); it changes V04 AC3 and V12 AC2 |
| 1.59 | 2026-10-26 | Claude, approved by the repository owner | Release v0.7.0 with X12, O01, O02, H04, H05 and V15 |
| 1.60 | 2026-10-28 | Claude, approved by Harry | New tasks V16 (`pnpm server:setup`, milestone Server) and V17 (`sdlc admin project apply`, milestone UX); V17 first, V16 before A10 PR 3 (QUESTIONS #616–#618) |
| 1.60 | 2026-10-27 | Claude Code (task H02), approved by Harry | H02 done: agent dependency checks (licence, install scripts, typosquatting; ADR-M96, QUESTIONS #606–#608) |
| 1.61 | 2026-10-27 | Claude Code (task H03), approved by Harry | H03 design done: deleting a client's data on request (ADR-M97, QUESTIONS #611–#615) |
| 1.62 | 2026-10-28 | Claude Code (task V17), approved by Harry | V17 done: `sdlc admin project apply`, a project and its team from one file (QUESTIONS #617) |
| 1.63 | 2026-10-29 | Claude Code (task U07), approved by Harry | U07 done (PR #462 and the U07 finish PR); U08 in part: create an intent (PR #462) |
| 1.64 | 2026-10-29 | Claude Code (task V16), approved by Harry | V16 done: `pnpm server:setup`, a guided fresh deployment on a server (ADR-M98, QUESTIONS #616) |
| 1.65 | 2026-10-29 | Claude Code (task U08), approved by Harry | U08 done: create an intent with its spec, submit a plan, build an Evidence Pack in the dashboard |
| 1.66 | 2026-10-29 | Claude, approved by Harry | New tasks H03a, H03b, H03c: the implementation of client data deletion, as ADR-M97 §3 splits it |
| 1.67 | 2026-10-29 | Claude, approved by Harry | Release v0.8.0 with H02, H03, U07, U08, V16 and V17 |
| 1.68 | 2026-10-30 | Claude, approved by Harry | Release v0.10.0 with O03 |
| 1.69 | 2026-10-31 | Claude, approved by Harry | Release v0.11.0 with O04 and O05 |
| 1.70 | 2026-11-11 | Claude, approved by Harry | New tasks V18 (the runner host set-up), V19 (`server:setup` steps 8–13) and V20 (team access and the runner link in the settings), milestone Server; order V20, V19, V18 (QUESTIONS #671–#673) |
| 1.71 | 2026-11-12 | Claude Code (task U09), approved by Harry | U09 done: the dashboard's administration in three PRs (QUESTIONS #681–#686) |
| 1.72 | 2026-11-12 | Claude Code (task V14), approved by Harry | V14 done: the human-effort baseline of the agent report in one PR (QUESTIONS #691–#693) |
| 1.48 | 2026-10-13 | Claude (task L02, PR 4), approved by Harry | L02 note: the first result table is in D-07 §9; the evaluation was stopped at 53 of 80 runs (QUESTIONS #447) |
| 1.28 | 2026-10-09 | Claude (task A10), approved by Harry | A10 note: ClickHouse access management done (`sdlc_admin`, ADR-M63 §6, QUESTIONS #330) |
| 1.27 | 2026-10-09 | Claude (task A10, PR 1), approved by Harry | A10 note: three PRs (TLS everywhere, backups and the drill, the server with the operator; ADR-M63, QUESTIONS #325–#327); code area `openbao/tls.sh` |
| 1.26 | 2026-10-08 | Claude, approved by Harry | K02 deferred to MVP+1, revisited at M-F (QUESTIONS #300, ADR-M59); S01, S02, K01 done |
| 0.3 | 2026-09-24 | Claude | Translated into English. User-facing messages via a message catalog (NFR-08). E02 adapter name fixed to `evidence-s3` (matches D-03). A06 includes `git_event_cursors` |
