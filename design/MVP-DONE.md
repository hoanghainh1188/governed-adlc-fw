# v0.1 baseline: definition of done

| Item | Value |
|---|---|
| Version | 0.9 |
| Date | 2026-11-16 |
| Status | **Draft** (task E07). AC4 prepared, waiting for the API-model run, now before M-F (QUESTIONS #81); 0.8 approved by Harry on 2026-10-10 (wording only: "MVP" retired, v0.1 baseline and Later; meaning unchanged; QUESTIONS #360) |
| Readers | Leadership, tech lead, Claude Code |
| Related documents | D-02 §10 (the criteria), D-08 task E07, D-09 §7 and §10, QUESTIONS #81 |

## 1. Purpose

- Show, for each criterion of the v0.1 definition of done (D-02 §10), **which automated test proves it** and where it runs.
- List what is still open before the trial M-E, and the numbers measured so far.
- A criterion counts as met only when a test proves it. A claim without a test is listed as a gap.

## 2. Criteria and evidence

Where a test runs: **CI** = every pull request that changes its paths, plus the weekly run (`.github/workflows/ci.yml`); **weekly** = the weekly run and manual dispatch only; **owner** = run by the owner in a terminal, never in CI.

| # | Criterion (D-02 §10) | Proven by | Runs | State |
|---|---|---|---|---|
| 1 | One intent goes all the way from G1 to G8 on the sample repo | `platform/tests/integration/pilot/t01-n6.test.ts`: T01 (Low) from G1 to G6 with the real runner, a node24 sandbox, the OpenHands Agent Server and the stub model, on the pilot's shape (`AGENTS.md`, specs, protected `main`); then Person B's review of the pushed commit, Person B's merge on the Git host, G8 with the release pack built by the worker, Person B's release approval, the sealed pack and `done` (`pnpm test:pilot`) | CI (`sandbox-image`) | Met |
| 1 | The same on the real pilot repository | `pilot/pilot-live.test.ts` with `SDLC_PILOT_LIVE_G8=1` (`pnpm test:pilot-live`): the real `harryforge/pilot-order-inventory`, the pilot's real `ci-ok`; the test waits until Person B approves and merges on GitHub, then G8 → `done` | Owner | Prepared; needs the plan file and Person B's account (§4) |
| 2 | The agent never bypasses a human gate | Unit tests of the policy engine (agents never approve, producers refused); `workflow/g1-g3/n4-n5.test.ts` (N5); `db/gate-g7.test.ts` (producer merge, early merge, `/approve G7` refused); `db/gate-g8.test.ts` (producers refused); `pilot/t01-n6.test.ts` (N6: `main` refuses the agent's commit; on the G1 → G8 path: no gate decision by an agent, every HITL decision by a person with the gate's role, no call to a merge endpoint) | CI | Met |
| 3 | The Evidence Pack is complete and readable | `db/evidence-pack.test.ts`, `db/gate-g8.test.ts`; on the G1 → G8 path (`t01-n6`): one sealed version, its manifest lists the spec and its hash, the plan hash, the run, the diff (`verified`), the decisions of G1–G8, the cost and the disclosure note; the Markdown names the intent and every gate, and holds no code or plan text; both files match their stored SHA-256 | CI | Met |
| 4 | `sdlc audit verify` passes | `db/audit-log.test.ts` (a changed record is found); `cli/token-audit.test.ts`; end of the G1 → G8 path: the tenant admin's `sdlc audit verify` → intact, exit 0 (`t01-n6`); the fresh deployment (`fresh-deploy`) | CI, weekly | Met |
| 5 | Over budget and out of file scope are blocked | `pilot/n1-n2-n3.test.ts` (N1 out of scope → G3; N3 warning at 80 %, stop at the cap, escalation); `integration/litellm/litellm-live.test.ts` (run, intent and tenant budgets block at LiteLLM); `db/gate-g5.test.ts` | CI | Met |
| 5b | Separation of duties, forced HITL at G3, dual approval at G7, approval expiry | `workflow/g1-g3/n4-n5.test.ts` (N5; an expired approval is void); `workflow/g1-g3/happy-path.test.ts` (N8: a Low-risk plan flagged `migration` makes G3 HITL); `db/gate-g7.test.ts` ("migration: Person B alone is not enough", N9); `db/gate-g8.test.ts` (Critical: second approver) | CI | Met |
| 5c | An unanswered escalation freezes the work and moves to the backup owner, then governance | `workflow/g1-g3/n7-escalation.test.ts` (N7); `db/escalations.test.ts` | CI | Met |
| 5d | The kill switch stops a run and revokes its credentials within 5 minutes | `pilot/kill-loop.test.ts` (a live run: sandbox, network, volume and key gone; prints `c09:kill_to_clean_up_ms`); `integration/runner/provision.test.ts` (measured on real Docker); `db/kill-switch.test.ts` | CI | Met |
| 6 | Every model call has all labels and a cost | `integration/litellm/litellm-live.test.ts` (the real LiteLLM: seven labels on the key and on every call; spend synced into `cost_records`, nothing twice); `db/cost-sync.test.ts` (C12); on the G1 → G8 path: one cost record per model call, with the run's labels (`t01-n6`); with a real API model: `agent/agent-api.test.ts` (`pnpm test:agent-api`: every LiteLLM spend-log row of the run has the seven labels and a cost above 0, and matches `cost_records`) | CI; owner | Met in CI with the real LiteLLM and a stub model; the API-model check waits for #81 (before M-F) |
| 7 | Everything runs from `docker compose up` following the README | `platform/deploy/README.md`, section "Fresh deployment (operator)"; `integration/deploy/fresh-deploy.test.ts` (`pnpm test:fresh-deploy`) follows it on a throw-away Compose project with every server profile, to the first intent at G1; `platform/tests/deploy/fresh-deploy-readme.test.ts` keeps the README and the code in step | Weekly; CI (static) | Met (development machine with throw-away keys); the server needs A10 |

D-08 E07 AC4 (QUESTIONS #81): **prepared, waiting for the run, now before M-F.** The trial M-E runs with the local model `gpt-oss:20b` (Harry, 2026-10-06; `design/M-E-TRIAL-PLAN.md` D6). `pnpm test:agent-api` runs one real task with `claude-haiku-4-5-20251001` through the development stack's LiteLLM, with the key from OpenBao (runbook T11 §5d), at most USD 1.00. The owner runs it in a terminal once the key exists; a follow-up pull request adds its numbers to §3 and closes issue #45.

## 3. Numbers measured so far

| What | Value | Source |
|---|---|---|
| Real-model run, local `gpt-oss:20b` (Ollama) | 89–110 s, 3 model calls, about 17 900 tokens in and 157 out, internal cost USD 0.0019 | ADR-M10 §3 (C05) |
| Real run with an API model (Claude Haiku 4.5, see §2) | Not run yet | `pnpm test:agent-api` (QUESTIONS #81) |
| G1 → G8 on the pilot's shape (stub model, two HOTL block windows of one minute) | 4 min 10 s for the whole file (set-up, G1 → G8, N6) on a developer machine (Apple M4 Pro, Docker Desktop); the whole `pnpm test:pilot` (4 files) 6 min 51 s | `pnpm test:pilot`, `t01-n6.test.ts` |
| Kill switch, kill to clean-up | about 1 s on real Docker | `pnpm test:runner` (C11) |
| Fresh deployment, empty env file to first intent at G1 | 60 s on a developer machine with the images already built (OpenBao 17 s, secrets and credentials 8 s, `up.sh` with every server profile 25 s, team, agent, configuration, AI record and first intent 5 s). A cold run builds the platform images first: see the CI row | `pnpm test:fresh-deploy` |
| CI minutes added by E07 | See the pull request of E07 (filled in after its CI run) | `sandbox-image` job (pull requests), `fresh-deploy` job (weekly) |

## 4. Open items

| Item | Owner | Blocks |
|---|---|---|
| QUESTIONS #81: one real run with an API model (`pnpm test:agent-api`) | Owner (an API key in OpenBao, T11 §5d) | M-F (the trial on a real internal tool); issue #45. Not the trial M-E, which runs with the local model |
| The live G1 → G8 run on the real pilot (`SDLC_PILOT_LIVE_G8=1 pnpm test:pilot-live`): the plan file merged on the pilot, a second GitHub account for Person B, the dev stack running (GETTING-STARTED Steps 13–14) | Owner | Nothing in v0.1; it is the first real G1 → G8 on GitHub |
| A10: TLS on OpenBao (PR 1) and backup and restore (PR 2, `pnpm test:backup`) are built (ADR-M63); the company CA, the first drill and the resource measurement on the server (PR 3) | Infrastructure operator | The real deployment on the internal server |
| Web UI scope (web UI, dashboard; D-02 §4.2), written from the trial data after M-E | Claude, for the owner's approval | Nothing in v0.1 (D-08 E07 note) |

## 5. Kept for later

Decisions taken during v0.1 that left a known item for a later milestone. Each has its source.

| Item | Source | When |
|---|---|---|
| ~~ClickHouse's `langfuse` user has access management (needed to create `sdlc_purge`), so Langfuse itself could create ClickHouse users~~ **Done:** `langfuse` has no access management; the loopback-only user `sdlc_admin` makes `sdlc_purge` | ADR-M53 (E08), ADR-M63 §6 | Done (A10) |
| An un-archive command for projects (today a mistaken archive is undone only during the grace period, by a database change on the server) | ADR-M51 §2.6 (E05) | M-F |
| Whether a retention hold must be released by a different person than the one who set it | ADR-M51 (E05) | M-F |
| Every intent needs a merged pull request with its plan file before G3 (the plan is a file on the protected default branch) | QUESTIONS #230 (C09) | M-F, from the trial's waiting times |
| Redone runs (sent back by G6 or G7) do not count as wasted tokens in the cost report | ADR-M45 §2.3 (E04) | M-F |
| No manual spend-sync command; a gap longer than the catch-up window is only logged (`worker.cost_sync_gap`) | ADR-M24 §3 (C12) | M-F |
| ~~Upgrade the deploy images (LiteLLM, OpenBao, ClickHouse, Langfuse)~~ **Done before M-E:** LiteLLM v1.104.0 (#195: a budget block answers 422 `budget_exceeded`; cached tokens are billed at the input price when a model has no cache price), OpenBao 2.7.1, ClickHouse 26.3.39.7, Langfuse 4.50.0 (#197) | Issue #177 (closed) | Done |
| A per-project `release.environment` and the non-production HOTL path at G8; an explicit PM/BrSE confirmation of the client's own disclosure note | QUESTIONS #220, #222 (E03) | Later |
| The web UI scope (web UI with actions, other users), written from the trial data; candidate list in `design/MVP1-UI-SCOPE.md` 0.1. The read-only dashboard is done: U01, U02 (QUESTIONS #255) | D-02 §4.2, D-08 E07 note | After M-E (U01: in parallel with M-E) |
| Template T13 differs from the plan schema v1 (platform fields, `change_flags`, tool names) | B09 PR 2 (#150) | Handbook authors |
| ~~Who owns the project AI record: D-02 §3 and handbook Ch.2 §2.5 differ~~ **Done:** D-02 1.12 §3 follows the handbook (Person A owns it) | QUESTIONS #103 | Done |

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-10-05 | Claude (task E07) | First version: criteria and evidence, numbers so far, open items. AC4 prepared |
| 0.2 | 2026-10-06 | Claude (coordinator), approved by Harry | §5 Kept for later: items decided during the MVP for A10, M-F, MVP+1 and the handbook |
| 0.3 | 2026-10-06 | Claude (coordinator), approved by Harry | §5: upgrade of the deploy images (issue #177); header version and date fixed |
| 0.4 | 2026-10-06 | Claude (coordinator), approved by Harry | §2, §4: the API-model run (QUESTIONS #81) is needed before M-F; the trial M-E runs with the local model |
| 0.5 | 2026-10-07 | Claude (coordinator), approved by Harry | §5: the read-only dashboard U01 starts in parallel with M-E (QUESTIONS #255) |
| 0.6 | 2026-10-07 | Claude (coordinator), approved by Harry | §5: the interface scope's candidate list (`design/MVP1-UI-SCOPE.md`); U01 and U02 done |
| 0.7 | 2026-10-08 | Claude (coordinator), approved by Harry | §5: the deploy image upgrade (#177) is done before M-E (#195, #197) |
| 0.8 | 2026-10-10 | Claude (coordinator), approved by Harry | Wording only: "MVP" retired; v0.1.0 is the "v0.1 baseline", unscheduled work is "Later"; meaning unchanged (QUESTIONS #360) |
| 0.9 | 2026-11-16 | Claude (coordinator), approved by Harry | §5: who owns the project AI record is aligned (QUESTIONS #103, D-02 1.12) |
