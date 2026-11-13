# Developing the platform: tests and live checks

This document is for developers and Claude Code sessions that change the platform. It says:

- which test suite proves what, what each suite needs, and where it runs (CI job, weekly, or never in CI);
- which live tests only the owner runs, in a terminal;
- the shared test helpers and the rules for writing tests;
- for each area of the platform, its design record and its test files.

Rules that a change must never break stay in [`CLAUDE.md`](../CLAUDE.md). The design of each area is in its ADR in [`design/`](../design/README.md). Deployment steps are in [`deploy/README.md`](deploy/README.md), the set-up of a development machine in [`GETTING-STARTED.md`](GETTING-STARTED.md), and the OpenBao and credentials steps in runbook [T11](../handbook/03-templates/T11-openbao-runbook.md).

A test file named below without a folder is under `platform/tests/` (unit tests) or `platform/tests/integration/` (live and database tests). `pnpm test <file>` runs one unit test file.

---

## 1. Before a pull request

```bash
pnpm build && pnpm typecheck && pnpm lint && pnpm format:check && pnpm test
```

Then run the suites of section 2 that cover the code you changed (section 5 lists them per area).

---

## 2. Test suites

| Command | What it runs | Needs | Where it runs |
|---|---|---|---|
| `pnpm test` | Vitest: every `platform/**/*.test.ts` except integration tests. Unit tests, static checks of Compose files, workflows and documents | Nothing; run `pnpm build` first for the dashboard build checks | CI job `checks`, every pull request |
| `pnpm test:integration` | Vitest for `platform/tests/integration/**` against a running `core` profile | `pnpm compose:core` running | CI job `compose` |
| `pnpm test:compose` | Live Compose test on a throw-away project (ports +20000, cleaned up); includes the SeaweedFS access test | Docker | Developer machine |
| `pnpm test:db` | Database integration tests on a throw-away PostgreSQL container, or `SDLC_TEST_DATABASE_URL` (a superuser URL). `SDLC_TEST_DB_DIR=<folder or file>` limits it | Docker | CI job `db`, every pull request except documentation-only ones |
| `pnpm test:knowledge` | The pgvector adapter of the index of project documents (X04 PR 3a) on a throw-away `knowledge-db` container (the Compose image by digest and its init script); X04 PR 3b: a throw-away OpenBao in dev mode next to it, for a tool's per-run login (issued, own project only, revoked); X06: the code index store (`code-store.test.ts`) | Docker | CI job `db` |
| `pnpm test:workflow` | The intent workflow on the Temporal time-skipping test server plus a throw-away PostgreSQL | Docker | CI job `db` |
| `pnpm test:workflow-compose` | Smoke test on the real Compose Temporal (sticky queues, workers stopped and started), own throw-away project (ports +25000) and a throw-away platform PostgreSQL | Docker | CI job `compose` |
| `pnpm test:openbao` | OpenBao bootstrap (A03), the OpenBao client (A04), TLS (A10), the SeaweedFS identities `api-evidence`, `worker-evidence`, `worker-purge`, `worker-anchor` on real SeaweedFS and OpenBao | Docker | CI job `compose` |
| `pnpm test:seaweedfs` | SeaweedFS internal access refused from another container (A12) | Docker | CI job `compose` |
| `pnpm test:backup` | The whole backup and restore drill on throw-away keys (A10) | Docker, `age` | CI job `compose` |
| `pnpm test:litellm` | LiteLLM with keys from OpenBao (profile `models`) and the Cost Controller, stub model; L01: a second stub in place of vLLM on the network `models` (a `client_restricted` intent, the `self_hosted` cost and budget) | Docker | CI job `compose` |
| `pnpm test:api` | The `sdlc-api` container with OpenBao | Docker | CI job `compose` |
| `pnpm test:access` | Team access through the TLS proxy (V09), ports +36000; the api-port check runs on Linux only | Docker | CI job `compose` |
| `pnpm test:vllm-link` | vLLM on a separate GPU host (L01 PR 2): the GPU host's project with a stub in place of vLLM and the platform's `vllm-link`, mutual TLS with a throw-away CA, port +37000; refusals of a wrong client or server certificate | Docker, OpenSSL 3 | CI job `compose` |
| `pnpm test:runner` | Runner on the local Docker Engine and a throw-away PostgreSQL: egress and hardening probed inside fixture sandboxes (the limits and capabilities as the kernel applies them), provisioning, clean-up, clean-up after a restart, the kill measurement | Docker | CI jobs `compose`, `runner-rootless` (a rootless Engine, ADR-M91) and `sandbox-runsc` (the sandboxes under gVisor, H06; adds `runtime-cost.test.ts`, the start time and memory against `runc`) |
| `pnpm test:runner-compose` | The `sdlc-runner` container in the profile `sandbox` (throw-away OpenBao keys) | Docker | CI job `compose` |
| `pnpm test:runner-split` | The runner on its own Docker Engine (O01, ADR-M91): the platform on the machine's Engine with the link overlay, the runner host's project on a rootless Engine; OpenBao login from the link address, `runner-credentials` to the runner's Engine, egress through the relays, no platform volume or network on the runner's Engine, `doctor` `runner.engine` (throw-away OpenBao keys) | Linux, Docker, a rootless Engine (`SDLC_RUNNER_SPLIT_DOCKER_HOST`) and a link address on this machine (`SDLC_RUNNER_SPLIT_LINK_ADDR`); sudo for both, so CI only | CI job `runner-rootless` |
| `pnpm test:observability` | One model call → a Langfuse trace with the seven labels; a platform span through the collector; no host port; the Langfuse purge (E08 AC4). Ports +27000, stub model | Docker | Developer machine |
| `pnpm test:sandbox-image` | The `node24` and `node24-opencode` sandbox images, hardened, with the real Verdaccio. `SDLC_SANDBOX_IMAGE` and `SDLC_SANDBOX_IMAGE_OPENCODE` use built images | Docker, internet | CI job `sandbox-image` |
| `pnpm test:agent` | The real OpenHands Agent Server in a `node24` sandbox with a scripted stub model as LiteLLM, and a throw-away PostgreSQL. `SDLC_SANDBOX_IMAGE` uses a built image. `SDLC_AGENT_ADAPTER=opencode` runs the same tests with OpenCode in `node24-opencode` (then `SDLC_SANDBOX_IMAGE` names that image; also for `test:pilot`) | Docker | CI job `sandbox-image` (both adapters) |
| `pnpm test:eval-server` | L04 PR 4c (ADR-M81 §2.3–§2.8): `executeEvaluation` of the runner on the stub model against a real Docker Engine, the sandbox image, the real OpenHands Agent Server and Verdaccio, on task `feat-tax` (its title carries `[stub:edit]`): the measures are the stub's (one file outside the plan, one line, the hidden tests fail), scoring the same patches with `LocalExecutor` gives the same score, the run stays `running` for the worker, the tables, audit events, cost records, returned value and process output hold no canary (clone token, virtual key, task text), nothing is left in Docker | Docker; internet once (as `test:eval-score`); a throw-away PostgreSQL; `SDLC_SANDBOX_IMAGE` (name@sha256:…) skips the image build. No secret. Developer machines and the owner's checks; do not run it while a long `pnpm eval` uses Docker. Claude may run it |
| `pnpm test:eval-score` | L04 (ADR-M81 §2.5, QUESTIONS #463): the runner's scoring of an evaluation run against a real Docker Engine, the sandbox image and Verdaccio, on task set v1: the reference solution resolves `feat-tax`, the base does not, and both scores equal `LocalExecutor`'s (the developer machine's scoring); the step that runs the diff and the hidden tests has no network (the proxy, the internet and DNS all fail); a lockfile that cannot be installed fails with `install_failed`; no Docker object is left | Docker; internet once (the sample repository at its pinned commit, npm packages through Verdaccio, cached in the volume `sdlc-eval-npm-cache`); the sandbox image (`SDLC_SANDBOX_IMAGE` name@sha256:… skips the build). No secret. Developer machines and the owner's checks; do not run it while a long `pnpm eval` uses Docker. Claude may run it |
| `pnpm test:attack` | H01 (ADR-M80): attacks from inside the real `node24` sandbox with a stub model that obeys every injection (`[stub:attack=<name>]`): environment and files, internet, OpenBao and platform services, Docker, another run, packages, the box's limits, instruction files, a hostile `finish`; each also searches records and logs for canary secrets. Not while a long `pnpm eval` uses Docker | Docker, internet | CI jobs `sandbox-image` and `sandbox-runsc` (under gVisor, H06) |
| `pnpm test:pilot` | G1–G8 on the sample repository's shape with the real runner (section 4.3) | Docker | CI job `sandbox-image`, weekly and on demand only |
| `pnpm test:dashboard` | Playwright against the stub API (section 4.4) | Chromium (`pnpm exec playwright install chromium`, once) | CI job `sandbox-image` when the dashboard, `api-schemas`, the api's static route or `platform/tests/e2e/` change; weekly; on demand |
| `pnpm test:fresh-deploy` | Follows `deploy/README.md` "Fresh deployment (operator)" on a throw-away project (ports +31000) to the first intent at G1; steps 2–13 through `pnpm server:setup`'s code, with a fake GitHub API over HTTPS (V19) | Docker | CI job `fresh-deploy`, weekly and on demand only |
| `pnpm test:upgrade` | O02: follows `deploy/README.md` "Upgrade" on a throw-away project (ports +34000): the last release tag (a git worktree, its published images) with an intent at G1, upgraded to this checkout; the intent goes on to G2, the audit chain verifies. `SDLC_UPGRADE_FROM`, `SDLC_UPGRADE_TO` (a tag or `HEAD`) choose the pair (QUESTIONS #581) | Docker, `age`, the release tags, GHCR | CI job `upgrade`, weekly and on demand only; before a release on the version branch (RELEASING.md §2) |
| `pnpm test:trial-up` | `pnpm trial:up` on a throw-away project, stop and `trial:start` again, a wrong passphrase, the intent found. Test-only overrides `SDLC_TRIAL_*` | Docker | CI job `trial-up`, weekly and on demand only |
| `pnpm test:proposal-pilot` | The public pilot repository copied into the stub Git host, `pnpm install` in a `node24` sandbox, the L1 proposal, the runner's peak memory (`SDLC_PROPOSAL_REPORT=<file>`) | Docker, internet | Developer machine only, never in CI |
| `pnpm test:sandbox-live` | Owner only (section 3) | | Never in CI |
| `pnpm test:pilot-live` | Owner only (section 3) | | Never in CI |
| `pnpm test:agent-real` | Owner's developer machine only (section 3) | | Never in CI |
| `pnpm test:agent-api` | Owner only (section 3) | | Never in CI |

CI layout (`.github/workflows/ci.yml`): pull requests, a daily run on `main` (the `scan` job only), a weekly run with every job, and manual dispatch. The heavy jobs (`compose`, `runner-rootless`, `sandbox-runsc`, `sandbox-image`) run only when their paths change, after `checks` passed, never on a draft pull request. After a pull request that changes the gate steps, the worker or the pilot suite, run the weekly jobs on the branch: `gh workflow run ci --ref <branch>`.

CI installs no tool with apt where it can avoid it: GitHub's runners cannot always reach the Ubuntu mirror. `age` (jobs `compose` and `upgrade`) is the release binary pinned by `AGE_VERSION` and `AGE_SHA256`, like Gitleaks, Trivy and actionlint. gVisor (job `sandbox-runsc`, H06) is the release archive pinned by `GVISOR_RELEASE` and `GVISOR_SHA512` (gVisor publishes SHA-512 only). Chromium for `pnpm test:dashboard` comes from Playwright without `--with-deps`; apt (with retries) runs only when the runner image lacks one of its libraries. On a developer machine or the server, install `age` as before.

---

## 3. Live tests run by the owner

These tests use a real GitHub App, a real model or the public pilot repository. **They never run in CI.** The owner runs them in the macOS Terminal app, never through a chat tool or the desktop app's terminal pane (Claude can read those). Files with keys stay outside the repository.

| Test | Command | Prerequisites |
|---|---|---|
| GitHub adapter and poller with the test App | `SDLC_GITHUB_LIVE_TEST=1 SDLC_GITHUB_TEST_APP_FILE=<file outside the repo> pnpm exec vitest run --config vitest.integration.config.ts platform/tests/integration/github`; the poller: `SDLC_GITHUB_LIVE_TEST=1 SDLC_GITHUB_TEST_APP_FILE=<file> SDLC_TEST_DB_DIR=platform/tests/integration/github pnpm test:db` | The test App (GETTING-STARTED Step 11) |
| The push and N6 on the pilot (C08 AC3) | `SDLC_GITHUB_LIVE_TEST=1 SDLC_GITHUB_TEST_APP_FILE=<file> pnpm exec vitest run --config vitest.integration.config.ts platform/tests/integration/github/publish-live.test.ts` | The test App |
| The whole sandbox flow | `SDLC_SANDBOX_LIVE_TEST=1 SDLC_GITHUB_TEST_APP_FILE=<file> pnpm test:sandbox-live` — against `harryforge/pilot-order-inventory` with a real token from the test App and the `node24` image; no model key | The test App, Docker |
| The pilot to G7 | `SDLC_PILOT_LIVE_TEST=1 SDLC_GITHUB_TEST_APP_FILE=<file> pnpm test:pilot-live` — the `test:pilot` stack against the real pilot repository: T01 to G7 with the real `ci-ok`, N6 on the real branch protection, then the pull request closed and the branch deleted. No issue, so no comment on the public repository; the PR text is codes only | GETTING-STARTED Step 11, Step 14 items 1 and 7 (the plan file `.sdlc/plans/INT-<UTC year>-0001.yaml` merged once by a person, QUESTIONS #230; the test stops with a message when it is missing), Docker. Not the dev stack |
| The pilot to G8 | `SDLC_PILOT_LIVE_TEST=1 SDLC_PILOT_LIVE_G8=1 SDLC_GITHUB_TEST_APP_FILE=<file> pnpm test:pilot-live` — waits (`SDLC_PILOT_LIVE_MERGE_TIMEOUT_MINUTES`, 60) until Person B (`person_b_github_id`, `person_b_login` in the settings file) approves and merges on GitHub, then G8 → `done` | As above; GETTING-STARTED Step 14 items 7–8. The live plan (`pilot/fixtures/live-plan.yaml`, `[stub:live]`) allows `docs/live-test/**` only: never let a live run change the pilot's application code |
| The real-model run on a local model (ADR-M10 §3, QUESTIONS #78) | `pnpm test:agent-real` — Ollama with the local tag `gpt-oss:20b` (`ollama pull gpt-oss:20b`; never a `:cloud` model), a throw-away LiteLLM with the Ollama entry of `config.ctmpl` (`reasoning_effort: low`, `num_ctx` 32768), the Cost Controller's virtual key, a `node24` sandbox. No secret. `SDLC_AGENT_REAL_REPORT=<file>` writes time, calls, tokens, cost, peak memory of every run. X11: a second test runs a longer task without and with context condensing (ADR-M29 §2.10) | Ollama on the developer machine. On a developer stack the Ollama entry of `config.ctmpl` appears only when `kv/litellm/providers/ollama` (field `api_base`) exists (runbook T11 §5d) |
| The evaluation harness (L02, ADR-M78) | `pnpm eval --check` checks the task set (each reference solution resolves its task in the scoring container; the base does not). `pnpm eval --out <folder outside the repo> [--config platform/eval/configs/local.yaml] [--configurations a,b] [--tasks t1,t2] [--n 5]` runs every configuration × task × run through the platform's agent path and scores it (install through the package proxy, proxy detached, diff and hidden tests with no egress); each result says it ran on a developer machine and on what hardware (L04, `@sdlc/eval`); one JSON result per run, numbers and codes only; a stopped evaluation continues. `--config platform/eval/configs/stub.yaml --tasks feat-tax --n 1` checks the harness itself in minutes. Then `pnpm eval:report --out <folder>` writes `report.md`, `report.json` and `pareto.svg` there; `pnpm eval:pairs --out <folder> --a <id> --b <id>` asks a reviewer to choose between two configurations' kept diffs (blind A/B); `pnpm eval:pairs purge-diffs --out <folder>` deletes the kept diffs | Docker; internet once (the sample repository at its pinned commit, npm packages through Verdaccio, cached in the volume `sdlc-eval-npm-cache`; the sandbox image is the scoring image too, ADR-M81 §2.5); for `ollama` configurations the local tags pulled (`ollama pull gpt-oss:20b`, `ollama pull qwen3:8b`; never a `:cloud` model); for `vllm` configurations (`platform/eval/configs/gpu.yaml`, L03b) the `vllm` service running and reachable at `SDLC_VLLM_URL` (on a GPU machine: `design/L03b-gpu-measurement-runbook.md`). No secret. Claude may run it |
| One real task with an API model (D-08 E07 AC4, QUESTIONS #81) | `pnpm test:agent-api` — `claude-haiku-4-5-20251001` through the dev stack's LiteLLM, at most USD 1.00. Reads the LiteLLM master key from the rendered configuration in memory only (`integration/agent/litellm-master-key.ts`: never log the configuration; errors with fixed texts and no cause). `SDLC_AGENT_API_REPORT=<file>` gets the numbers for `design/MVP-DONE.md` §3 | `pnpm compose:models`, the provider key in OpenBao (runbook T11 §5d) |

The test App is `harryforge-sdlc-dev` (Client ID `Iv23liQtMQBwNyVYZuJt`), installed only on `harryforge/pilot-order-inventory`. Its private key stays on the owner's machine.

---

## 4. Shared helpers and rules for tests

### 4.1. Rules

- Build fake tokens at run time, never as a literal. The Gitleaks rule `sdlc-api-token` blocks leaked tokens; its fake fixture is allow-listed in `platform/tests/gitleaks/fixtures/` only.
- Never print a key share, root token, password or API token in test output. Throw-away OpenBao keys stay in the test process.
- Never add a fixed sleep; wait for a condition (`waitLong` in the pilot suite).
- A test that creates runs registers an agent first: `integration/agent-seed.ts`. A test that steps intents needs a project AI record: `integration/ai-record-seed.ts` (the workflow fixture seeds one).
- A live test on Compose uses its own throw-away project, its own port offset and its own `access` subnet (`accessNetworkFor` in `platform/deploy/trial/src/env-file.ts`, used by `isolateEnv` and `trialEnv`); otherwise two projects collide. Every `docker compose` call passes `-p`.
- Tests that search for leaked text (feedback, plan text) search every table, the Temporal history and the process output.

### 4.2. Helpers

| Helper | Use |
|---|---|
| `integration/throwaway-compose.ts` | Throw-away Compose projects; `baoClientArgs` and `openbaoCaMount` reach OpenBao over TLS; from the host network use `--add-host openbao:<ip>` |
| `platform/deploy/scripts/test-db.sh` | The throw-away PostgreSQL behind `test:db`, `test:runner`, `test:agent`. On a rootless AuthZ Engine (H07), set `SDLC_TEST_DB_DOCKER_HOST` to another Engine (CI: the machine's Docker); sandboxes keep using `DOCKER_HOST` |
| `platform/deploy/scripts/test-rootless-docker.sh` | CI only (job `runner-rootless`): a rootless Docker Engine next to the machine's own one, with the server's steps from the step code of `runner-host-setup.sh` (`rootless-engine.sh`, V18, ADR-M107: subordinate IDs, AppArmor profile for RootlessKit, cgroup delegation, systemd user service, the AuthZ plugin); sets `DOCKER_HOST` (ADR-M91 §2.4) |
| `platform/deploy/scripts/temporal-test-server.sh` | The Temporal test server: the sdk-java release pinned by version and SHA-256, the cached archive checked again on every run; never the SDK's own download |
| `integration/g4-harness.ts` | Shared set-up for G4 and the run after it |
| `integration/g7-world.ts` | Shared world for the G7 request-for-changes tests |
| `integration/fake-spec-git-host.ts` | Fake Git host for spec linking |
| `integration/memory-evidence-store.ts` | In-memory evidence store for G8 |
| `integration/workflow/g1-g3/stack.ts` | B10's stack: CLI → API, the poller, the intent workflow on the Temporal test server |
| `passkeys/soft-authenticator.ts` | A software passkey for the WebAuthn ceremonies |
| `platform/tests/plans/fixtures/`, `platform/tests/specs/fixtures/` | Spec Kit and BMAD outputs at the pinned versions. A pin upgrade: compare the template files in ADR-M61 §2.2 and update these fixtures |

### 4.3. The pilot suite (`pnpm test:pilot`, C09, E07)

- `platform/tests/integration/pilot/`. `PilotStack` (`pilot/stack.ts`) = B10's stack on the **wall clock** with the worker's G4–G8 activities, the real `CostController` over `StubGateway` (run keys registered at the stub model, `/key/info`), StubOpenBao, and the **real runner** on the task queue `sdlc-runner` (`node24` sandbox, Agent Server, stub model as LiteLLM, the HTTP relay `pilot/relay-http.mjs` as `SDLC_RUNNER_SELF_CONTAINER`).
- The repository is a bare Git repository on `StubGitHost` (`main` protected) with snapshots of the pilot's `AGENTS.md` and specs (`pilot/fixtures/`, commit `PILOT_COMMIT`). The GitHub stub serves refs, contents, trees, pull requests, a `ci-ok` check run (`setCi`) and code scanning (no alert).
- The plan's task `summary` carries the stub model's script marker: `[stub:append]`, `[stub:edit]`, `[stub:count]`, `[stub:slow]`, `[stub:repeat]`, `[stub:silent]`, `[stub:condense]`, `[stub:condensecap]`, `[stub:context]`, `[stub:condenseloop]`, `[stub:selfconfig]` (in `test:agent` only; the four X11 scripts with OpenHands only; `selfconfig` with OpenCode only), `[stub:attack=<name>:<params>]` (in `test:attack` only), `[stub:live]` (live tests).
- Pilot configuration: HOTL block window 1 minute, `run.g6_ci_retries: 1`, `verification.required_checks: [ci-ok]`.
- Files: `t01-n6` (C09 AC1, N6; and E07: T01 from G1 to G8 and `done`, Person B reviews and merges on the stub Git host with `PilotStack.review`, `mergeAsPerson`, `BareRepo.merge`; the test checks that no merge endpoint is called; then the pack, `adlc audit verify` and one cost record per model call), `n1-n2-n3` (C09 AC2), `autonomy` (T09 to `rejected`, T10, C09 AC5), `kill-loop` (C09 AC4; prints `c09:kill_to_clean_up_ms:`). Run the files one at a time. A real G4–G6 run takes about two minutes.

### 4.4. The dashboard suite (`pnpm test:dashboard`)

- Playwright 1.63.0 against `platform/tests/e2e/stub-api.mjs`, which serves the build through the api's own `registerDashboard` with fictional data (`fixtures.mjs`; the token is made at run time). Run `pnpm build` first.
- Screenshots at 375, 768 and 1440 px, light and dark, in `platform/tests/e2e/screenshots/` (Git-ignored).
- `e2e/sign-in.e2e.ts`: the stub API plays GitHub on `localhost`. `SDLC_DASHBOARD_E2E_ALL_BROWSERS=1` adds Firefox and WebKit once `pnpm exec playwright install firefox webkit` ran.
- `e2e/passkeys.e2e.ts`: Chromium's virtual authenticator on `localhost`; the stub checks with the api's built WebAuthn code.
- `e2e/decisions.e2e.ts`: the U07 writes of the stub (`e2e/decisions-stub.mjs`) check the step-up's action, request and bound input hash; each test removes the passkey it added.
- `e2e/intake.e2e.ts`: the U08 writes of the stub (`e2e/intake-stub.mjs`) refuse as the default `access.*` roles do (the demo person is Person A in `shop`, Person B in `pilot`); no passkey is added.
- Unit tests in `platform/tests/dashboard/`: data mapping, static checks of source and build, the no-new-endpoint check, colour contrast.

---

## 5. Test map by area

Each row: the backlog task, its design record, and the tests that prove it. "unit" = `pnpm test`, "db" = `pnpm test:db`, "wf" = `pnpm test:workflow`.

### 5.1. Foundation and infrastructure

| Area | Task, design | Tests |
|---|---|---|
| Workspace, module boundaries, CI | A01, A09; ADR-M16 | unit: `workspace/boundaries.test.ts`, `workspace/structure.test.ts`, `workspace/ci-workflow.test.ts`, `workspace/ignores.test.ts`, `workspace/diagrams.test.ts`, `workspace/development-doc.test.ts` (this document) |
| Docker Compose | A02; ADR-M17 | unit: the static Compose checks; `pnpm test:compose`; `pnpm test:integration` |
| OpenBao bootstrap and client | A03, A04, A11, O05; ADR-M19, ADR-M21, ADR-M102 | `pnpm test:openbao` (also the signing key's rotation period and a revoked version, `run-contract-signing.test.ts`); unit: `deploy/openbao-static.test.ts` (`rotate-credentials`, `auto_rotate_period`), `doctor/checks.test.ts` (the secret ID warning days) |
| OpenBao TLS | A10 PR 1; ADR-M63 | unit: `deploy/openbao-tls-static.test.ts`; `pnpm test:openbao` (`openbao/tls.test.ts`: wrong CA, an IP, plain HTTP refused; renewal without a restart; a missing file stops OpenBao) |
| Backups | A10 PR 2; ADR-M63 §5 | unit: `deploy/backup-static.test.ts`; `pnpm test:backup` |
| Database, migrations | A06; ADR-M09 | db: `migrations.test.ts` and the tenant guard tests |
| Audit log | A07; ADR-M09 §2.8 | unit: `audit/actions.test.ts`; db |
| Logs and traces | A08; ADR-M35 | unit: logger, tracing with real HTTP, load order, static Compose; db: `telemetry-pg.test.ts` (no SQL parameter values in spans); `pnpm test:observability` |
| SeaweedFS access | A12; ADR-M52 | unit: `deploy/seaweedfs-static.test.ts` (the exact command, `start.sh`); `pnpm test:seaweedfs` (`seaweedfs-access.test.ts`: every internal path refused from another container, 18333 `Unauthenticated`, the locked version unchanged, `start.sh` fails closed) |

### 5.2. Intents, gates G1–G3, people

| Area | Task, design | Tests |
|---|---|---|
| Policy engine | B01 | unit: the policy rules and matrix edge cases |
| Registry | B02; ADR-M20 | db |
| API | B03; ADR-M26 | unit: `api/settings.test.ts`; `pnpm test:api` |
| User CLI | B04, U03; ADR-M36 | unit: `platform/tests/cli/` (mocked API and a real local HTTP server), `cli/api-schemas.test.ts` |
| `adlc next` | V06 | unit: `cli/next.test.ts` |
| `adlc help`, hints, what to do after a failure | V10 | unit: `cli/help.test.ts` (every command has help and an example; the next-step line; the fix lines; no colour) |
| `adlc doctor` | V07 PR 1 | unit: `cli/doctor.test.ts`; db: `api.test.ts` (`platform_version`) |
| GitHub adapter | B05; ADR-M23 | unit; live with the test App (section 3) |
| Poller and comment commands | B06; ADR-M27 | unit: grammar, replies, loop, settings, static Compose, `commands/comment-command.test.ts`; db: `git-poller.test.ts` (GitHub stub) |
| Intent workflow | B07; ADR-M30 | db: `intent-workflow-2.test.ts`; wf: `intent-workflow-2.test.ts`; `pnpm test:workflow-compose` |
| Spec linking | B08; ADR-M39 | unit: `platform/tests/specs/`, `cli/spec.test.ts`; db: `spec-linking.test.ts`; wf: `spec-n4.test.ts` |
| G2 needs acceptance criteria | S01; ADR-M61 | unit: `specs/spec-structure.test.ts`, `evidence/pack.test.ts`, `cli/spec.test.ts`; db: `spec-linking.test.ts` (S01), `metrics-gates.test.ts`, `migrations.test.ts` |
| Plan submission | B09; ADR-M40 | unit: `platform/tests/plans/`, `plans/plan-rules.test.ts`, `cli/plan.test.ts`; db: `plan-submission.test.ts`, `gate-g4.test.ts`; wf: `plan-resubmit.test.ts` |
| Plan drafts | S02; ADR-M62 | unit: `plans/plan-draft.test.ts`, `cli/plan-draft.test.ts` |
| The plan in the agent's prompt | B09 PR 2; ADR-M40 §2.7 | unit: `plans/plan-texts.test.ts`, `agent/plan-prompt.test.ts`, `runner/plan-file.test.ts`; db: `plan-in-prompt.test.ts`; wf: `plan-prompt-handoff.test.ts` |
| G1–G3 end to end | B10 | `integration/workflow/g1-g3/` |
| Escalations | B11; ADR-M28 | unit: clock, routing, notices, packet, freeze, loop, `/ack` and `/decide` grammar; db: `escalations.test.ts`, `escalation-commands.test.ts` |
| Project AI record | B12; ADR-M32 | unit: rules, hash, policy, CLI; db: `ai-records.test.ts`; wf: `workflow/ai-record.test.ts` |
| Admin onboarding, tokens | B13; ADR-M37 | unit: `admin/onboarding.test.ts`, `cli/admin-api.test.ts`, `admin-agents.test.ts`, `token-audit.test.ts`; db: `admin-onboarding.test.ts`, `admin-tokens.test.ts`, `admin-agents.test.ts`, `config-reconcile.test.ts` |

### 5.3. Runs and gates G4–G6

| Area | Task, design | Tests |
|---|---|---|
| Run Contracts | C02; ADR-M22 | unit: `run-contract/run-events.test.ts` and the contract tests; db |
| LiteLLM and the Cost Controller | C03; ADR-M24 | unit: `cost/litellm-gateway.test.ts`; `pnpm test:litellm` (also: revoke by run; the key ID is not a key) |
| Self-hosted model (vLLM, profile `models-local`) | L01; ADR-M71 | static: `deploy/models-local-static.test.ts`; `pnpm test:litellm` (L01 AC4, a stub in place of vLLM); owner only: `pnpm test:agent-api` with `SDLC_AGENT_API_MODEL` and `SDLC_AGENT_API_DATA_CLASS` (section 3). vLLM itself needs a GPU: never in CI |
| vLLM on a separate GPU host (profile `models-remote`) | L01 PR 2; ADR-M71 §4 | static: `deploy/models-remote-static.test.ts` (the GPU host's file, the gateway and link templates, `up.sh`, `gpu-link/tls.sh`); `pnpm test:vllm-link` |
| Scheduled spend sync | C12; ADR-M24 §2.5 | unit: `worker/cost-sync-loop.test.ts`, `worker/settings.test.ts`; db: `cost-sync.test.ts` |
| Runner and sandboxes | C04, O01, H07, H06; ADR-M25, ADR-M91, ADR-M105 | unit: `runner/sandbox-runtime.test.ts` (H06: the runtime setting, the guard, `GET /info` at start, the AuthZ option), `deploy/sandbox-profile.test.ts` (the socket proxy allowlist equals `ALLOWED_ENDPOINTS`), `deploy/runner-host.test.ts`, `deploy/docker-authz-plugin.test.ts`, `runner/authz-eval.test.ts` (guard ↔ AuthZ denylist), `doctor/runner.test.ts`, `workspace/ci-workflow.test.ts` (jobs `runner-rootless`, `sandbox-runsc`); `pnpm test:runner` (also on a rootless Engine with the AuthZ plugin; AC3 privileged-create probe; and under gVisor), `pnpm test:runner-compose`, `pnpm test:runner-split`, `pnpm test:sandbox-image` |
| Threat model of a run, attack tests | H01; ADR-M80 | unit: `attack/prompt-injection.test.ts`, `attack/comment-commands.test.ts`; `pnpm test:attack` |
| OpenHands adapter | C05; ADR-M29 | unit; `pnpm test:agent`; `pnpm test:agent-real` (section 3) |
| OpenCode adapter, `@sdlc/agent-kit`, image `node24-opencode` | X03; ADR-M68, ADR-M88 | unit: `agent/opencode-adapter.test.ts`, `agent/opencode-request.test.ts`, `agent/agent-kit.test.ts`, `deploy/sandbox-opencode.test.ts`; `SDLC_AGENT_ADAPTER=opencode pnpm test:agent` (`[stub:selfconfig]`: the agent raises its own cap, the run fails `agent_config_changed`); `pnpm test:sandbox-image` (`node24-opencode.test.ts`); CI step: `node platform/sandbox-images/node24-opencode/licences.mjs` |
| Agent register | C10; ADR-M31 | unit: rules, SQL, CLI; db: `agents.test.ts` |
| Gate G4 | C06; ADR-M33 | unit: `workflow/gate-g4.test.ts`, `config/agent-key-config.test.ts`, notices, `contracts/agent-instructions.test.ts`; db: `gate-g4.test.ts` (every check, POLICY, HITL, block, `prepareRun`) |
| The run after G4, L1 proposals | C06 session 2; ADR-M33 §2.6–§2.9 | unit: runner activity, settings, config; db: `run-lifecycle.test.ts`; wf: `run-handoff.test.ts` (G4 → runner → G5, one slot, expiry, lost heartbeat, replay, no secret in the history); `pnpm test:proposal-pilot` |
| Taking an L1 proposal forward | C13; ADR-M64 | unit: `cli/evidence-proposal.test.ts`, `cli/api-schemas.test.ts`; db: `l1-proposal.test.ts`; `pnpm test:pilot` (`autonomy.test.ts`, T09 to `rejected`) |
| Gate G5 | C07; ADR-M34 | unit; db: the G5 and run tests; `pnpm test:runner` |
| The secret scan of a run's diff | H04; ADR-M93 | unit: `runner/secrets.test.ts` (the added lines, the event, the real Gitleaks with fake secrets built at run time when `SDLC_RUNNER_GITLEAKS_PATH` is set; required in CI), `gitleaks/runner-pin.test.ts` (one pin), `workflow/gate-g5.test.ts`; db: `gate-g5.test.ts` ("H04"); `pnpm test:runner` (`provision.test.ts`). Locally, before any suite that runs the runner in-process (`test:runner`, `test:agent`, `test:pilot`, `test:attack`): `g="$(platform/deploy/scripts/gitleaks.sh)"; export PATH="$(dirname "$g"):$PATH" SDLC_RUNNER_GITLEAKS_PATH="$g"`; without it every run is held at G5 (`secret_scan_failed`) |
| The review size of a run's change | H05; ADR-M95 | unit: `runner/review-size.test.ts` (parsing, counts, the event, a real clone: the limits, binary, lock and generated files, a `.gitattributes` the run changed), `policy/oversight.test.ts` ("H05"), `workflow/gate-g5.test.ts` ("H05"), `commands/comment-command.test.ts` (`/approve G5 <code>`), `cli/next.test.ts` ("H05"); db: `gate-g5.test.ts` ("H05": at the limits, over, the split at G3, not measured, a per-project limit) |
| Gate G6, the push and the pull request | C08 PR 1; ADR-M38 | unit: `git-github/pull-request.test.ts`; db: `gate-g6-publish.test.ts`, `publish-run.test.ts` (the real push to a local Git host that protects `main`); wf: `publish-handoff.test.ts`; live: `publish-live.test.ts` (section 3) |
| Gate G6 reads CI | C08 PR 2; ADR-M38 §2.7 | unit: `workflow/g6-checks.test.ts`, `git-github/pull-request.test.ts`, policy, request; db: `gate-g6-ci.test.ts` (every outcome, N2, timeout, findings, escalations, the poller wake) |
| Kill switch | C11 PR 1; ADR-M42 | unit: rules M25, M26, `/kill` grammar, revoke, CLI, reconcile; db: `kill-switch.test.ts`, `agent-drive.test.ts`; wf: `kill-handoff.test.ts`; `pnpm test:runner` (`provision.test.ts`: the 5-minute measurement on real Docker, about 1 s) |
| Loop detection | C11 PR 2; ADR-M42 §2.7 | unit: `agent/loop.test.ts`, `runner/loop-watch.test.ts`, `config/loop-detection-config.test.ts`; db: `agent-drive.test.ts`; wf: `run-handoff.test.ts`; `pnpm test:agent` (`[stub:repeat]`, `[stub:silent]`: real time, proves the Agent Server sends no periodic events) |
| Context condensing | X11; ADR-M29 §2.10 | unit: `agent/condensing.test.ts`, `config/context-condensing-config.test.ts`, `run-contract/run-events.test.ts`; db: `agent-drive.test.ts` ("X11"); `pnpm test:agent` (`[stub:condense]`, `[stub:context]`: a stub past its context, `[stub:condensecap]`, `[stub:condenseloop]`); `pnpm test:agent-real` (a longer task without and with condensing, section 3) |
| Agent memory: approvals and revocations | X13 PR 1; ADR-M74 0.2 | unit: `memory/set.test.ts` (memory files, the set hash, never an instruction path), `git-github/folder.test.ts` (`listFolder`, `listPathCommits`), `config/memory-config.test.ts` (rule M36), `cli/memory.test.ts`; db: `memory.test.ts` (producers refused, revocation, other projects and tenants, append-only, the API) |
| G4–G6 on the sample repository | C09 | `pnpm test:pilot` (section 4.3); `pnpm test:pilot-live` (section 3) |

### 5.4. Gates G7–G8, evidence, cost, metrics

| Area | Task, design | Tests |
|---|---|---|
| Gate G7, review and merge | E01 PR 1; ADR-M41 | unit: adapter `getReviews`, `getCommitAuthors`, the closed pull request event, run events; db: `gate-g7.test.ts` |
| A request for changes at G7 | E01 PR 2; ADR-M41 §2.7 | unit: `git-github/review-feedback.test.ts`, `agent/feedback-prompt.test.ts`, `runner/feedback-cap.test.ts`, `commands/request-changes-reason.test.ts`; db: `g7-request-changes.test.ts` (searches every table for the text); wf: `request-changes-handoff.test.ts` (the text never in the history, tables or process output) |
| Evidence Packs | E02; ADR-M48 | unit: `evidence/pack.test.ts`, `s3-store.test.ts`, `cli/evidence.test.ts`, `api/settings.test.ts`; db: `evidence-pack.test.ts`, `config-reconcile.test.ts`; `pnpm test:openbao` (`api-evidence.test.ts`) |
| Gate G8, the release | E03; ADR-M49 | unit: `evidence/pack.test.ts` (release hash), `audit/actions.test.ts`, `commands/comment-command.test.ts`, `workflow/intent-notices.test.ts`, `worker/settings.test.ts`, static deploy; db: `gate-g8.test.ts`; wf: `publish-handoff.test.ts` (G7 merge → G8 → done, replay); `pnpm test:openbao` (`api-evidence.test.ts`: both identities) |
| Cost report | E04; ADR-M45 | unit: `cost/report.test.ts`, `cli/cost.test.ts`; db: `cost-report.test.ts`, `config-reconcile.test.ts` |
| Evidence retention, holds, archive | E05 PR 1; ADR-M51 | unit: `retention/rules.test.ts` (fake clock 179/181 days, archive 6/8 days), `worker/retention-loop.test.ts`, `cli/evidence-hold.test.ts`, static deploy; db: `retention.test.ts`; `pnpm test:openbao` (`retention-purge.test.ts`); operator check `pnpm adlc ops retention report --tenant <slug>` |
| The daily audit anchor | E05 PR 2; ADR-M51 §2.9 | unit: `audit/anchor.test.ts`, `worker/retention-loop.test.ts`; db: `audit-anchor.test.ts`; `pnpm test:openbao` (`audit-anchor.test.ts`) |
| Housekeeping of the session tables, table sizes | O04; ADR-M103 | unit: `worker/retention-loop.test.ts`, `worker/settings.test.ts`, `audit/actions.test.ts` (`housekeeping.removed`), `doctor/checks.test.ts` and `host-readonly.test.ts` (`db.table_size`); db: `housekeeping.test.ts` (the cutoffs and floors, tenants, the audit event, no DELETE outside the functions) |
| Client data deletion: tenant states and people | H03a; ADR-M97 §2 | unit: `db/client-data-deletion.test.ts` (statuses, anonymized email and tombstone hashes, no AO UPDATE/DELETE in the migration); db: `client-data-deletion.test.ts` (states, `anonymizeUser` + `scrubProjectConfigs` in one transaction, FKs, audit and gate rows and the hash chain unchanged) |
| Client data deletion: worker purge | H03b; ADR-M97 §2 | unit: `retention/client-purge-rules.test.ts`, `worker/client-purge-loop.test.ts`, `audit/actions.test.ts` (`client_data.*`); db: `client-purge-pass.test.ts` (grace, hold/open block, `client_data.deleted` + `purged`) |
| Client data deletion: request, approve, cancel | H03c; ADR-M97 §2.4 | unit: `client-data/deletion-phase.test.ts`, `cli/client-data-deletion.test.ts` (API mock + ops parser); db: `client-deletion-commands.test.ts` (request → approve → `pending_deletion`, cancel restore, non-admin 403, two-person refuse, allowlist when `pending_deletion`) |
| Evaluation plans | L05; ADR-M82 | unit: config rule M33, `cli/eval.test.ts`, API schemas; db: `evaluation-plans.test.ts` (roles, versions, budgets, triggers), `evaluation-plans-api.test.ts` (the API), `evaluation-plan-loop.test.ts` (Run now, schedules, `on_change`, pauses), `evaluation-execute.test.ts` (a plan's prompt variant on the runner), `evaluation-plans-dashboard.test.ts` (session actions, CSRF, the step-up); unit: `dashboard/evaluations.test.ts`; `pnpm test:dashboard`: `evaluations.e2e.ts` (Run now with a virtual passkey, the form, screens at 320–1440 px) |
| Evaluation reports | L06; ADR-M83 | unit: `eval/recommendations.test.ts` (each rule fires, does not fire, the numbers quoted, thresholds from the configuration), `cli/eval-report.test.ts` (`adlc eval report`, `adlc next` without an intent, the api's mapping of stored results), `config/hash.test.ts`; db: `evaluation-report-api.test.ts` (the report, real-run numbers by role, `GET /v1/evaluations/recent`) |
| A project's own task set | L07; ADR-M85 | unit: `eval/task-card.test.ts` (the card, the base commit), `evaluation/task-check-contract.test.ts`, `evaluation/contract.test.ts` (schema 2: the task set's kind and commit), `dashboard/evaluations.test.ts` (`project` in the form); db: `evaluation-tasks.test.ts` (draft, register, review, producers), `evaluation-tasks-api.test.ts` (the API and the CLI), `evaluation-task-check.test.ts` (the worker side of the check), `evaluation-task-check-runner.test.ts` (the runner's check, real Git), `evaluation-project-task-set.test.ts` (plans and evaluations on the task set `project`, the data class, the contract, the triggers), `evaluation-project-run.test.ts` (a run on a project's task, real Git) |
| Evaluations in the agent register | L09, L10; ADR-M86 | unit: `config/agent-evaluation-config.test.ts` (`agents.evaluation`, rule M34), `runner/evaluation-agent-contract.test.ts` (the agent's own tools); db: `evaluation-fingerprints.test.ts` (the fingerprint columns, plans with `proposed` and `suspended` agents, the approval columns), `evaluation-project-task-set.test.ts` (`approved_tasks_at_start`), `agent-evaluation-approvals.test.ts` (each condition, the modes, a change and its baseline, one evaluation per round, the audit, `show`, the API); `agent-evaluation-recertification.test.ts` (L10: fresh and old evaluations, a drop and no drop, too few shared tasks, no activation evaluation, the modes, the agent never suspended, FR-36, `?overdue=true`); unit: `agents/rules.test.ts` (the refusal texts with their numbers), `cli/admin-agents.test.ts` (`--evaluation`, the warning, `show`) |
| The tool register | X04 PR 1; ADR-M69, ADR-M87 | unit: `tools/tools-contract.test.ts` (tool codes, the call rules and their canonical bytes, the Run Contract of schema 3 and its grants, the G4 proposal hash unchanged without tools), `plans/plan-rules.test.ts` (`tool:<key>` in a plan), `config/mandatory-rules.test.ts` (M18 for tools), `run-contract/verify.test.ts`; db: `tools.test.ts` (the table, its trigger and CHECKs, append-only approvals, `checkToolsForRun` with each refusal, the grants, the fingerprint), `admin-tools.test.ts` (the API: register, approvals by set, change, retire, owner, recertify, the audit), `gate-g4.test.ts` (X04: `tool_not_runnable` with its cause, schema 3 without grants), `runs.test.ts` |
| Register tools in a run (gateway, tool containers) | X04 PR 2; ADR-M69 §2.4–§2.8, ADR-M87 | unit: `runner/tools.test.ts` (the gateway configuration from the contract, the guard of tool and gateway containers, the tool network, `toolGrantsEnforceable`, the counts from the gateway's log lines), `agent/request-tools.test.ts` (OpenHands `mcp_config`, `toolsOf`), `tools/tools-contract.test.ts`; `pnpm test:runner` (`tools.test.ts`: the key, the listed tools, argument rules with a batch, oversized and unparsable bodies, the cap, the tool unreachable from the run network, another run refused, no key, query or answer in the logs, the counts, the clean-up) |
| The index of project documents | X04 PR 3a; ADR-M89 | unit: `tools/knowledge-index.test.ts` (chunks, the embedder, the indexer with fakes: reuse, limits, failures), `worker/knowledge-store.test.ts`; db: `knowledge-index.test.ts` (the tables, reuse, retention and archive with `knowledge.purged`), `gate-g4.test.ts` (`tool_unavailable`); `pnpm test:knowledge` (`knowledge/pgvector-store.test.ts`: the adapter on a real `knowledge-db`) |
| The first tool and its credentials | X04 PR 3b; ADR-M89 §2.7, ADR-M69 §2.4, §2.8 | unit: `tools/project-docs-tool.test.ts` (the MCP side, arguments, the log line, the runtime files), `tools/tool-credentials.test.ts` (issue, wrap, revoke once per tool), `secrets/database.test.ts` (one OpenBao role per run, revoke by prefix), `runner/tool-services.test.ts` (service network, runtime volume, guard, `SDLC_RUNNER_TOOL_SERVICES`, teardown, `knowledge_read` lines), `runner/knowledge-read-record.test.ts`, `cost/litellm-gateway.test.ts` (the tool's key); db: `gate-g4.test.ts` (the login and the key in the run preparation, `credentials_unavailable`), `knowledge-index.test.ts` (`usedByRun`, evidence kind, cost label); `pnpm test:knowledge` (`knowledge/tool-login.test.ts`: the issuer, a login reads its own project only, another project refused, revoked); `pnpm test:runner` (`tool-docs.test.ts`: the real tool image with knowledge-db and a stub model, the egress probe from the sandbox and the gateway, no secret or text in the logs, the clean-up) |
| The code index | X06 PR 1; ADR-M108 | unit: `knowledge/code-extract.test.ts` (the Tree-sitter queries of each language, Vue lines, broken files, the parse time limit, long names), `knowledge/code-index.test.ts` (skipped folders, import resolution, the indexer with fakes: reuse, limits, a file left out, failures, the race); db: `code-index.test.ts` (`kind`, reuse, retention from the code store only, no code store, archive, SDA26), `client-purge-pass.test.ts` (both kinds deleted from their own store); `pnpm test:knowledge` (`knowledge/code-store.test.ts`: the code schema and its read role on a real `knowledge-db`, apart from the documents) |
| The code tool | X06 PR 2; ADR-M108 §2.8 | unit: `tools/code-index-tool.test.ts` (the catalogue, the MCP side, arguments and paths checked again, the log line, the runtime files without a model key), `tools/tool-credentials.test.ts` (a `read_code` login, no model key), `secrets/database.test.ts` (the role `kdocs-<run_id>-code`, the code read role only), `runner/tool-services.test.ts`; db: `tools.test.ts` (`read_code`, never with `read_documents`), `gate-g4.test.ts` (the code index and login in the run preparation); `pnpm test:knowledge` (`knowledge/code-store.test.ts`: the reader's three questions as a run's login) |
| Evaluation on the server (worker side) | L04 PR 4d; ADR-M81 §2.8 | unit: `worker/settings.test.ts`; db: `evaluation-loop.test.ts` (prepare, finish, the loop); wf: `evaluation-handoff.test.ts` (scored, lost runner, cancel; history without secrets) |
| Evaluation harness | L02; ADR-M78 | unit: `eval/eval.test.ts` (task set v1, strict task and configuration files, results with numbers and codes only, diff counts, the scoring script), `eval/report.test.ts` (pass@k, pass^k, McNemar, bootstrap, Bradley-Terry against hand-computed values; the report; kept diffs 700/600, choices, purge); live: `pnpm eval --check`, `pnpm eval` (section 3) |
| Gate waiting-time metrics | E06; ADR-M47 | unit: `metrics/gates.test.ts`, `cli/metrics.test.ts`; db: `metrics-gates.test.ts`, `config-reconcile.test.ts` |
| Agent efficiency report | V13; ADR-M79 | unit: `metrics/agents.test.ts`, `cli/metrics.test.ts`, `cli/api-schemas.test.ts`; db: `metrics-agents.test.ts` (every measure, roles, range, tenants) |
| v0.1 definition of done | E07; `design/MVP-DONE.md` | `pnpm test:pilot` (`t01-n6.test.ts`); `pnpm test:agent-api` (section 3) |
| The Langfuse purge | E08; ADR-M53 | unit: `llm-traces/langfuse-store.test.ts`, `retention/langfuse-rules.test.ts`, `worker/langfuse-store.test.ts`, settings, static deploy; db: `langfuse-purge.test.ts`; `pnpm test:observability` |

### 5.5. Trial, deployment, release

| Area | Task, design | Tests |
|---|---|---|
| `adlc trial report` | V01; ADR-M65 | unit: `cli/trial-report.test.ts` (markers in every free field, no slug, code, UUID, e-mail, repository or link; limits; retries) |
| `pnpm server:setup` | V16, V19, V20; ADR-M98 | unit: `deploy/server-setup.test.ts` (a simulated OpenBao: key custody, tokens, a second start; V20: the `access` and `runner_link` settings, their env keys, the profiles of step 7), `deploy/server-setup-team.test.ts` (V19: steps 8–13 against a simulated `adlc`: the token shown once, the GitHub IDs confirmed, the AI record on behalf of Person A, a second run, refusals), `deploy/server-setup-static.test.ts` (the README steps, the catalog, `configure --issue-admin-token`), `workspace/claude-hook.test.ts`; `pnpm test:fresh-deploy` runs steps 2–7 through it |
| `pnpm trial:up`, `trial:down` | V02 | unit: `trial/trial-up.test.ts`, `deploy/trial-up-static.test.ts` (the script follows the README "Fresh deployment" steps, through the shared `platform/deploy/steps`); `pnpm test:trial-up` |
| `pnpm trial:start` and the key file | V08; ADR-M76 | unit: `trial/trial-keys.test.ts`, `trial/trial-start.test.ts`, `trial/trial-down.test.ts`, `deploy/trial-up-static.test.ts`, `doctor/checks.test.ts`; `pnpm test:trial-up` |
| GitHub App from a manifest | V03 | unit: `deploy/github-app.test.ts` (a fake GitHub only; the manifest equals the README's permissions table) |
| Fresh deployment | E07 | unit: `deploy/fresh-deploy-readme.test.ts` (fails on a README command, option or credentials command that drifts); `pnpm test:fresh-deploy` |
| Upgrade between two releases | O02 | unit: `deploy/upgrade-readme.test.ts` (the README "Upgrade" steps are the live test's, in order; every release's Upgrade notes can be read), `deploy/compose-static.test.ts` (`compose:env --add-missing`), `workspace/ci-workflow.test.ts` (the job `upgrade`); `pnpm test:upgrade` |
| Published images | V04, V15; ADR-M66, ADR-M94 | unit: `deploy/release-images.test.ts` (scan before push, `images.sh` with a fake download); CI job `release-images` on a version pull request |
| The release on the tag | V12, V15; ADR-M94, ADR-M104 | unit: `workspace/release.test.ts` (`release.yml`, `release-tag.yml`, `npm-publish.yml`, the release gate, `verify-images.sh`), `workspace/release-prepare.test.ts` (`pnpm release:prepare`), `workspace/ci-workflow.test.ts` (the upgrade test on a version pull request) |
| The CLI on npm | V05; ADR-M72 | `pnpm cli:pack-check` (CI job `checks`) |
| `pnpm doctor` | V07 PR 2 | unit: `doctor/checks.test.ts` (with `backup.recent`, O03), `doctor/backup-facts.test.ts`, `no-secrets.test.ts`, `host-readonly.test.ts`, `github-permissions.test.ts`, `deploy/doctor-troubleshooting.test.ts` (every README "Troubleshooting" row has an entry; services, jobs and AppRole folders follow the compose file), `worker/doctor-github.test.ts` |
| `pnpm alerts` | O03; ADR-M101 | unit: `alerts/decide.test.ts` (when a problem is sent, reminded, resolved), `alerts/message.test.ts`, `alerts/channels.test.ts` (a recorded POST, a fake `sendmail`), `alerts/settings.test.ts`, `alerts/run.test.ts` (a whole run, the state file, no env value in any output), `alerts/static.test.ts` (R144) |
| Team access | V09; ADR-M67 | unit: `deploy/access-static.test.ts`, `doctor/access.test.ts`, `api/settings.test.ts`, `cli/doctor.test.ts`, `trial/trial-up.test.ts`; `pnpm test:access` |
| Releases | V12; `RELEASING.md` | unit: `workspace/release.test.ts` (the release gate on fixtures, "Upgrade notes" from 0.1.1 on, the tag workflows) |

### 5.6. Dashboard and sign-in

| Area | Task, design | Tests |
|---|---|---|
| Read-only dashboard | U01; ADR-M54 | unit: `api/dashboard-static.test.ts`, `workflow/gate-oversight.test.ts`, `platform/tests/dashboard/`; db: `api.test.ts`, `escalation-commands.test.ts`, the gate tests; `pnpm test:dashboard` |
| What holds an intent | U02; ADR-M54 §2.4b | unit: `workflow/waiting-reason.test.ts`; db: `gate-g4.test.ts` (U02 block) and assertions in the gate tests, `plan-submission.test.ts`; `pnpm test:dashboard` |
| Sign-in with GitHub, sessions | U05; ADR-M73 §2.2b | unit: `api/sign-in-pieces.test.ts`, `git-github/sign-in.test.ts`, `api/settings.test.ts`, `deploy/github-app.test.ts`, `deploy/api-static.test.ts`; db: `web-sessions.test.ts`; `pnpm test:dashboard` (`e2e/sign-in.e2e.ts`) |
| Dashboard writes, CSRF, passkeys | U06; ADR-M73 §2.3b, §2.4b | unit: `passkeys/ceremonies.test.ts`, `api/settings.test.ts`, `deploy/api-static.test.ts`; db: `dashboard-writes.test.ts`; `pnpm test:dashboard` (`e2e/passkeys.e2e.ts`) |
| Dashboard decisions: gates, kills, escalations | U07; ADR-M73 §2.4b, §2.6 | unit: `commands/gate-web-decision.test.ts` (the input hash, source `web`), `dashboard/endpoints.test.ts`; db: `dashboard-decisions.test.ts` (the step-up, the 409, the sources, no session ID in append-only tables); `pnpm test:dashboard` (`e2e/decisions.e2e.ts`: N5 refusals, the kill, escalations, screens at 375–1440 px) |
| Dashboard wave 2: intent and spec, plan, Evidence Pack | U08; ADR-M73 §2.1 | unit: `dashboard/intake.test.ts` (refusal keys, the proposal command), `dashboard/endpoints.test.ts`, `api/session-actions.test.ts`; db: `dashboard-intake.test.ts` (roles, a refused link keeps the intent, CSRF, actions off); `pnpm test:dashboard` (`e2e/intake.e2e.ts`) |
| Dashboard wave 3: administration | U09; ADR-M73 §2.4b; ADR-M54 0.8 | unit: `api/session-actions.test.ts` (every admin change takes the step-up; tokens CLI-only), `passkeys/ceremonies.test.ts` (the admin binding), `dashboard/admin.test.ts` (the line difference, the shape checks, refusal keys, routes), `dashboard/static.test.ts` (the admin writes, each `target` equal to its path, the admin chunk budget), `dashboard/endpoints.test.ts`; db: `dashboard-admin.test.ts` (step-up per route, the binding, actions off, self-grant and Person A = Person B, audit); `pnpm test:dashboard` (`e2e/admin.e2e.ts`, `e2e/admin-register.e2e.ts`) |

---

## 6. Keeping this document current

- A new `pnpm test:*` script gets a row in section 2; `workspace/development-doc.test.ts` fails otherwise, and also when this document names a script that no longer exists.
- A new task adds its row in section 5 in the same pull request. The detail of the design goes in its ADR; a rule a change must never break goes in `CLAUDE.md`.

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 1.0 | 2026-10-12 | Claude (slim CLAUDE.md, PR 1), approved by Harry | First version: the test map and live-test notes that `CLAUDE.md` held (QUESTIONS #424, #425) |
| 1.1 | 2026-10-13 | Claude (task L02, PR 2) | Section 3 and §5.4: the evaluation harness (`pnpm eval`, ADR-M78) |
| 1.2 | 2026-10-13 | Claude (task L02, PR 3) | Section 3 and §5.4: `pnpm eval:report`, `pnpm eval:pairs`, the kept diffs |
| 1.3 | 2026-10-13 | Claude (task V10) | §5.2: `cli/help.test.ts` |
| 1.4 | 2026-10-24 | Claude (task H04) | §5.3: the secret scan of a run's diff (ADR-M93) |
| 1.5 | 2026-10-26 | Claude (task H05) | §5.3: the review size of a run's change (ADR-M95) |
