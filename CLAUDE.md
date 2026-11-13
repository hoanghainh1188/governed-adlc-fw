# CLAUDE.md — Agentic SDLC Framework

> Status: **CODING RESUMED** (Harry, 2026-09-24). Design version 1.0 approved (tag `design-v1.0`).
> Work through `design/D-08-mvp-backlog.md` in dependency order, starting with **A01**. One task per session; open questions go to `design/QUESTIONS.md`.
> Direction: project reference docs → handbook → platform. The platform follows the handbook.
> **The handbook is not yet approved as a whole.** Decision (Harry, 2026-09-24): **code the whole backlog now and accept rework later.**
> - Keep code easy to change where it depends on handbook rules: policy, oversight matrix, roles, SLAs, thresholds belong in **config**, not hard-coded.
> - When an approved handbook change affects the platform: update the design doc first, add a change task to the backlog (`scripts/generate-backlog.py`), then change the code. Never change code silently to follow an unapproved handbook draft.
> Order: M-A → M-B → M-0 (sample repo, separate repo, right before M-C) → M-C → M-D. Task IDs: A, B, R (M-0), C, E (M-D).

## What this repo is
Repository name: `governed-adlc-fw`.
The **Agentic SDLC Framework = Handbook + Platform**, in one repo:
- `handbook/` — the process for humans (policies, 6 phases, 8 gates, roles, templates, runbooks). It defines *what must happen*.
- `platform/` — a self-hosted system that *enforces* the handbook: runs AI coding agents through 8 human/automatic gates (G1–G8),
  records evidence and an append-only audit log, and tracks token cost per tenant/project/intent/run.
- `design/` — approved design docs that connect the two.
Open for everyone (Harry, 2026-10-08): the code is MIT and the documentation CC BY 4.0, and they stay open; any income later comes from services (deployment, training, support), never from closing the code or a paid edition (`design/POSITIONING.md` §7). Multi-tenant from day one.
Handbook and platform must stay consistent: same codes, same names for gates, autonomy levels and roles.

## Read these first
Read the documents a task needs before planning it (they are not loaded automatically, to save tokens; QUESTIONS #426):
- Scope and requirements, v0.1 baseline (FR/NFR, acceptance criteria): `design/D-02-mvp-scope.md`
- Architecture, interfaces, Run Contract, code layout: `design/D-03-mvp-architecture.md`
- Data model, enums, append-only tables, audit hash chain: `design/D-05-data-model.md`
- Backlog (tasks, dependencies, acceptance criteria): `design/D-08-mvp-backlog.md` (read only the task's section)
- Build vs buy decisions (what we reuse, what we build): `design/D-01-build-vs-buy.md`
- Model gateway and token/cost control: `design/D-07-model-and-token-management.md`
- Sample pilot repository: `design/D-09-sample-pilot-repo.md`
- Tests, CI jobs, live tests and the test map by area: `platform/DEVELOPMENT.md`. The design of each area: its ADR (index `design/README.md`).
Always loaded:
- Canonical codes (phases, autonomy L0–L4, oversight modes, gates G1–G8 × risk, 2+N roles): @handbook/00-introduction/05-codes.md

## Language
- Everything in this repo is English: docs, code, identifiers, commit messages, code comments. [R013]
- User-facing messages (CLI output, PR/issue comments, Evidence Pack Markdown) are English by default and **must go through a message catalog** (i18n keys), so Vietnamese and Japanese can be added later (D-02 NFR-08). Never hard-code user-facing strings. The catalog is `@sdlc/messages` (`platform/packages/messages/src/locales/<locale>.json`, ADR-M18). [R014]
- Write plain English for non-native readers: @handbook/00-introduction/06-writing-style.md [R015]
- The handbook must **not** mention the internal reference documents used to design it ("Bản chất…", `Digital_Foundry.pdf`, draft v1.0). State rules directly; cite only external sources and other repo documents. [R016]

## Repo layout
- `platform/apps/` — api (NestJS), worker (Temporal, G1–G8 workflow + GitHub poller), runner (sandbox + OpenHands), cli, dashboard (Preact, served by the api)
- `platform/packages/` — core modules, contracts, adapters (git-github, agent-openhands, agent-opencode, model-litellm, evidence-s3, policy-simple, traces-langfuse), agent-kit (helpers for agent adapters only), config (project configuration, ADR-M18), messages (message catalog), secrets, telemetry, api-schemas, workflow-client
- The platform is a modular monolith: keep module boundaries; core must not import adapters directly (use interfaces).
- `platform/deploy/` — docker-compose, OpenBao bootstrap, TLS, backups, `doctor`, `trial`, `github-app`. `platform/tests/` — unit tests; `platform/tests/integration/` — live and database tests, scenarios N1–N6, tasks T01–T10 (D-09). `platform/DEVELOPMENT.md` — tests and live checks.
- `design/` — approved design docs (D-xx) + `README.md` (index, number history) + `QUESTIONS.md`. `handbook/` — process handbook for humans. `diagrams/` — Mermaid sources + SVG.
- `scripts/` — `create-issues.py` (GitHub issues from the backlog), `generate-backlog.py` (single source for D-08 + CSV). `platform/GETTING-STARTED.md` — human setup guide. `platform/deploy/README.md` — deployment and operations. `RELEASING.md` — releases.
- `_review/` — historical review notes in Vietnamese; not a source of requirements. Ignore unless asked.

## Hard rules (always)
- Use only the canonical codes in the codes table (v1.3): phases P1–P6, gates G1–G8, autonomy **L0–L4**, oversight **HITL / HOTL / AUDIT**, risk tiers, PRI-0…3, Stage A/B/C. Never reintroduce old codes (G0–G12, S0–S9, "Level 0–3"). L0–L4 always has the **source** meaning (L0 Assist … L4 High-impact autonomy), never the draft v1.0 meaning. [R024]
- The design follows the codes table. If a design doc and the codes table disagree, the codes table wins; raise it in `design/QUESTIONS.md`. [R025]
- Every table has `tenant_id`; every query filters by tenant. Tenant data only through `PlatformDatabase.forTenant(tenantId)` / `TenantScope`. [R026]
- Every LLM call goes through the LiteLLM gateway with labels: tenant, project, intent_id, run_id, gate, agent, data_class. [R027]
- Agents never hold real provider keys, never push to the default branch, never deploy to production. **The platform never merges**: a person merges at G7. [R028]
- Separation of duties (2+N): the producer (human or agent) never approves its own output; Person B approves G3, G7, G8. Enforce by capabilities (producer agent has no merge tool). Person A and Person B are never the same person (rule M21). [R029]
- Append-only tables (`audit_log`, `gate_decisions`, `run_events`, `cost_records`, `project_ai_record_versions`, `agent_approvals`, the evaluation tables, and any later one; full list in `platform/tests/db/append-only.test.ts`): never add UPDATE/DELETE paths; DB triggers + grants enforce it. They are kept ≥ 2 years and can never be edited or deleted, so they never hold free text or personal/client data: store codes, IDs, hashes, versions and references (for example a link to a GitHub comment) only. Explanations in words stay where they can be edited or deleted (GitHub). Never add a deletion path for the audit log, gate decisions or escalations (FR-44). Audit uses a per-tenant hash chain (RFC 8785 canonical JSON + SHA-256). [R030]
- **Client data and secrets never go into Temporal** (workflow inputs, signals, activity results: IDs and codes only), **logs, run events, audit events or any table**: no key, key ID, token, prompt, diff, plan text, review or comment text, tool argument, path or command. Only single-use OpenBao wrapping tokens travel through Temporal. [R031]
- Evidence retention: default 180 days (configurable, never below 180). Purge deletes SeaweedFS objects only; keep DB rows + hashes; respect holds (`evidence_holds`); log `evidence.purged`. Open or held intents are never purged. [R032]
- Git host, agent, policy engine and model provider are behind interfaces. Do not hard-code one vendor in core logic. [R033]
- No secrets in the repo. All secrets live in OpenBao (Vault-compatible API); processes use AppRole + short-lived tokens, credential files never environment values. Sandboxes never access OpenBao. Never write key shares, root tokens or secret values to files, logs or test output (only exception: the trial stack's encrypted key file, ADR-M76). [R034]
- **Commands that print or take a secret or token run only in the owner's macOS Terminal app**, never through a chat tool or the desktop app's terminal pane (Claude can read it): `openbao:bootstrap init|unseal|root-token`, credentials commands that the owner runs, `pnpm adlc ops bootstrap|token issue` (also as `adlc …`; the hook still refuses the old name `sdlc`, ADR-M100), `pnpm github-app:create`, the live tests with keys. [R035]
- Run Contracts are signed via OpenBao Transit (Ed25519); the signing key never leaves OpenBao. [R036]
- GitHub events are read by polling (GitHub App + API) in v0.1; webhooks come later. Both must feed the same event handler. Users are matched by numeric GitHub account ID only; bots never decide. [R037]
- Object storage: SeaweedFS (S3 API). Cache/rate limit: Valkey. Never MinIO, Redis or Elasticsearch (license/maintenance reasons). Pin every image to an exact version; images we publish or depend on are used by digest. [R038]
- Never run `docker volume prune` or `docker system prune --volumes` on a machine with a dev stack. Never run anything against the owner's dev stack without being asked. [R039]
- Releases, tags, `push: true` image runs and npm publishes are public actions done by Harry (he merges the version PR; `release-tag.yml` tags it, npm follows). Claude never pushes a tag, creates a release, runs a workflow with `push: true`, publishes to npm or adds an npm token. [R040]
- Target host is a modest internal server: keep concurrent sandboxes configurable (default 1–2); heavy observability stack is an optional Compose profile. [R041]
- Every FR in D-02 gets automated tests matching its acceptance criteria. [R042]

## Rules in other folders
Claude Code reads a folder's `CLAUDE.md` when it opens a file in that folder. Before you change a folder, **or its tests under `platform/tests/`**, read that folder's `CLAUDE.md`. Never break a rule there; the detail is in the linked ADR.
- `platform/packages/core/CLAUDE.md` — workflow and gates, evaluations, evidence, retention, reports, migrations, audit; also for `platform/apps/worker`.
- `platform/apps/runner/CLAUDE.md` — sandbox, agent, model gateway, GitHub tokens; sandbox images.
- `platform/deploy/CLAUDE.md` — OpenBao and TLS, SeaweedFS, backups, `doctor`, `trial`, access proxy, GitHub App; the deployment commands.
- `platform/apps/dashboard/CLAUDE.md` — dashboard, sign-in, sessions and the routes a session may write to.
- `platform/apps/api/CLAUDE.md` — administration and the agent register.
- `platform/apps/cli/CLAUDE.md` — CLI tokens, `adlc plan draft`, the user commands.
- `platform/eval/CLAUDE.md` — the evaluation harness.

## Platform-wide module rules (detail in the linked ADR)
- Secret values are `Redacted`: call `reveal()` only where the value is used, never to log it (ADR-M21). [R077]
- Logging only through the platform logger (codes, flat IDs and counts); spans never hold headers, query strings or SQL parameter values (ADR-M35). Database pools always have error listeners; api and worker import `./telemetry.js` first. The `otel-collector` has no host port, is never a sandbox egress service and is the only holder of the Langfuse project key. [R084]
- Never rename the job `verify-images` or the environment `npm`; the lock file is a release asset, never edited or replaced; a version tag never moves. Images are scanned with Trivy before any push. A package bundled into the CLI must have an allowed licence (`ALLOWED_LICENCES`). A new built image goes into both workflow matrices, the overlay, the lock job and `images.sh` together (ADR-M66, ADR-M94, RELEASING.md). [R089]
- `PLATFORM_VERSION` equals the root `package.json` version. Every CHANGELOG release section from 0.1.1 on has non-empty `### Upgrade notes`. [R090]

## Documentation rules
- Design docs in `design/` are APPROVED. Do not change their meaning silently. If code must differ from a design doc: stop, add the question to `design/QUESTIONS.md`, and wait. Approved changes go in a separate PR with a short ADR. [R091]
- D-08 and its CSV are generated: edit `scripts/generate-backlog.py`, then run it. Never edit the generated files by hand. Then sync the open GitHub issues: `python3 scripts/create-issues.py --repo hoanghainh1188/governed-adlc-fw --update` (try `--dry-run` first). [R092]
- Diagrams D9–D13 mirror Mermaid blocks in design docs: if you change one, update the other. After editing a `.mmd`, run `pnpm diagrams:render` and commit the SVG in the same PR (CI only checks it; `diagrams/README.md`). [R093]
- Handbook split: policies and generic process chapters are written outside Claude Code. **You own** the handbook parts that describe platform behaviour: Ch.13–16 and Ch.18–20 usage sections (CLI, `/approve` commands, config, troubleshooting) and runbooks (e.g. T11 OpenBao). When a task changes user-visible behaviour, update the matching handbook chapter in the same PR. Never edit template T13 or the policy chapters. [R094]
- Keep `CHANGELOG.md` updated for notable changes. [R095]
- A PR with an upgrade step writes it under `[Unreleased]` → `### Upgrade notes` (ADR-M104). [R146]
- **Keep this file short** (QUESTIONS #425): a new task adds at most one line to "Commands" and one line per new never/always rule to the matching folder's `CLAUDE.md` (or "Platform-wide module rules"). Its detail goes in its ADR, the deploy README, the runbook or `platform/DEVELOPMENT.md` (tests: one row there per new `pnpm test:*` script, checked by a test). [R096]
- `design/RULES.md` lists every rule of every `CLAUDE.md`, the file it lives in and the check that enforces it: a new rule gets a row and an ID tag (`[R…]`) in the same PR, and a check (lint, test, hook) comes before text (ADR-M84). [R133]

## Workflow for each task (one task per session, see D-08 section 5)
1. Read the task in D-08 and the related FR / design sections.
2. Propose a plan (files to touch, tests to add, risks). Wait for human approval before coding.
3. Implement on a feature branch named `task/<ID>-<short-name>`. Keep changes inside the approved file list.
4. Tests must cover every acceptance criterion (AC) of the task.
5. Run lint + tests. Open a PR; `.github/pull_request_template.md` (T2, AI disclosure) is filled automatically — complete every section. Put the task ID in the title.
6. If a design doc is missing or contradictory: do not guess. Add the question to `design/QUESTIONS.md` and stop.
7. New technical decisions (library choice, etc.): write a short ADR in `design/`.

## Commands
Run from the repo root. Node.js 24, pnpm 10 (pinned in `package.json` → `packageManager`; `corepack enable` once). Tooling: `design/ADR-M16-monorepo-tooling.md`.
- `pnpm install` — install all workspace packages (dependency install scripts are blocked unless listed in `pnpm.onlyBuiltDependencies`).
- `pnpm build` — compile every package with TypeScript project references (`tsc -b`), then build the dashboard with Vite (`platform/apps/dashboard/dist/web`).
- `pnpm typecheck` — build + type-check the tests in `platform/tests/`.
- `pnpm lint` — ESLint, type-aware, including module boundaries (`core` never imports adapters; adapters import `@sdlc/contracts` only).
- `pnpm format` / `pnpm format:check` — Prettier. Never touches `handbook/`, `design/`, `_review/`, `diagrams/` or Markdown.
- `pnpm test` — Vitest (all `platform/**/*.test.ts` except integration tests). One file: `pnpm test platform/tests/workspace/boundaries.test.ts`.
- `pnpm test:*` — every other suite (database, workflow, Compose, runner, agent, pilot, dashboard, live tests): what it needs and where it runs in `platform/DEVELOPMENT.md` §2–§3. Live tests with a real GitHub App or model are run by the owner only, never in CI.
- `pnpm clean` — remove build output.
- Before a PR: `pnpm build && pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`.
- New package: put it under `platform/apps/`, `platform/packages/` or `platform/packages/adapters/` with the `@sdlc/` scope, and add it to the root `tsconfig.json` references.
- `pnpm diagrams:render [name …]` / `pnpm diagrams:check` — render Mermaid to SVG (needs Docker) / the CI check (`diagrams/README.md`).
- Deployment (Compose, OpenBao, backups, `doctor`, `trial`, `github-app:create`): commands in `platform/deploy/CLAUDE.md`. User CLI (`adlc …`): `platform/apps/cli/CLAUDE.md`. Sandbox images: `platform/apps/runner/CLAUDE.md`. Evaluation harness (`pnpm eval`): `platform/eval/CLAUDE.md`.
- Database (ADR-M09): `pnpm db:migrate` / `pnpm db:status` (`SDLC_DB_MIGRATION_URL`, owner role `platform`; processes connect as `platform_app`).
- Dev mode without Compose: `pnpm api:start`, `pnpm worker:start` (ADR-M26, ADR-M27; refused with `NODE_ENV=production`).
- Operator commands on the server: `pnpm adlc ops bootstrap|token|audit verify|tenant-admin|role|ai-record|agent|run kill|retention report|client-data-deletion|eval start` (`SDLC_DB_URL`, actor `system`; ADR-M26, ADR-M37; deploy README "Fresh deployment" step 8). A token is printed once: owner's terminal only.
- Releases (`RELEASING.md`, ADR-M94, ADR-M104): `pnpm release:prepare X.Y.Z`, `pnpm images mode|get|export|verify`, `pnpm cli:pack-check`. Order: version PR → merge (Harry) → `release-tag.yml` → `release.yml` → `npm-publish.yml`.
- Claude Code hook (W01, ADR-M84 §2.3): `.claude/settings.json` runs `platform/tools/claude-hooks/guard-bash.mjs` before every Bash call and refuses the commands this file forbids for Claude (rule IDs in `design/RULES.md`); never weaken or bypass it. [R132]
- CI: `.github/workflows/ci.yml` (A09; jobs, triggers and path filters in `platform/DEVELOPMENT.md` §2). Actions pinned by commit SHA; thresholds in the workflow `env:`. Short checks share the `scan` job; do not add a job for a check under a minute; every job has `timeout-minutes`.

## Current constraints
- At most 2 sessions at the same time (a docs PR session counts as one). [R121]
- One task per session; each parallel session works in its own git worktree. [R122]
- State (2026-11-13): **v0.14.0 in release** (version PR): U09 (dashboard administration), V14 (human-effort baseline), X06 (code index and `read_code`; seven release images), H06 (optional gVisor or Kata runtime); v0.13.0 (2026-11-12): O06; earlier releases: `CHANGELOG.md`. Waiting: E07 (API-model run, QUESTIONS #81), L03b and L01 AC4 (no GPU run yet), A10 PR 3 (the company server's first real run, with `pnpm server:setup`; the live `test:fresh-deploy` with V19 not run yet), X10 (a real project). Parked: K02. No trial report yet; bugs from trial reports come first. The two-person rule stays (no single-person mode). Plan: `ROADMAP.md`, D-08. [R123]
- Open docs follow-ups: align D-02 §3 and handbook Ch.2 §2.5 on who owns the project AI record (QUESTIONS #103); align template T13 with the plan schema v1 (handbook authors, never in Claude Code). [R124]
- Conflicts with `main` on a branch under review: merge `origin/main` into the branch. Never rebase or force-push it. [R125]
- `design/QUESTIONS.md` and ADR numbers: each session gets its own block when it is queued and uses only numbers from that block (history: `design/README.md` "Number blocks"; update both places). **Next free: QUESTIONS #716–#720; ADR-M110** (X13 used #711–#715 and no ADR). [R126]
- Development uses throw-away OpenBao keys only. The real OpenBao initialisation on the internal server waits until the three key holders are named and the company CA's certificate is issued (QUESTIONS #20, task A10 PR 3; runbook T11 §3c) (remove this line when both are done). [R127]

## Decisions (see design/D-02 section 11)
- Q1 first agent: OpenHands · Q2 first Git host: GitHub (GitLab later, same interface) · Q3 language: TypeScript (Node.js) · Q5 repo language: English
- Secret manager: OpenBao (MPL-2.0, Vault-compatible API) · Host: internal server, modest spec
- G7 self-approval rule: intent creator cannot approve G7 · GitHub events: polling in v0.1 (ADR-M11) · SeaweedFS + Valkey (ADR-M12) · Evidence retention 180 days
- Q4 pilot repo: A → C → B. Step A = sample repo `pilot-order-inventory` (Vue + NestJS + PostgreSQL), spec: `design/D-09-sample-pilot-repo.md`
