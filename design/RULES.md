# Rules register

| Item | Value |
|---|---|
| Status | Draft (task W01, PR 1; ADR-M84) |
| Date | 2026-10-20 |
| Readers | Contributors, reviewers, Claude Code |
| Related | `CLAUDE.md`, ADR-M84, D-08 task W01, QUESTIONS #479 |

This register lists every rule of the root `CLAUDE.md` and the check that enforces it today. Use it to find the rules that are only text, and to decide where a rule belongs (ADR-M84).

- **ID**: `R` + the number of the bullet in the root `CLAUDE.md` on 2026-10-20 (R001–R131; later rules from R132), with a letter when one bullet holds several rules. Bullets that only hold commands, reading lists, decisions or the layout (R001–R012, R017–R023, R097–R120, R128–R131) are not listed. IDs never change and are never reused; a removed rule keeps its row with the proposal `removed`.
- **Kind**: lint · test · db (trigger, grant, constraint in a migration) · runtime (guard code) · ci · hook-candidate · text-only · INFO.
- **Enforced by**: the file and line of the check. Paths that start with `tests/`, `packages/` or `apps/` are under `platform/`; `migrations/` is `platform/packages/core/src/db/migrations/`.
- **Coverage**: full (a change that breaks the rule fails a check) · partial (some cases only) · none.
- **File**: the `CLAUDE.md` that holds the rule, tagged at the end of its bullet with its ID (`[R043]`). `platform/tests/workspace/claude-md.test.ts` checks that every ID is in exactly that file, once (W01 PR 4).
- **Proposal**: keep-root (stays in the root `CLAUDE.md`) · move:<folder> (goes to a `CLAUDE.md` in that folder, W01 PR 4) · pointer-only (enforced; `CLAUDE.md` needs one short line only) · add-lint · add-test · add-hook (W01 PR 2–3) · drop-or-move-to-doc.
- A new rule in `CLAUDE.md` gets a row here in the same pull request.

## 1. Hard rules, language, documentation, constraints

| ID | Rule | Kind | Enforced by | Coverage | Proposal | File |
|---|---|---|---|---|---|---|
| R013 | Everything in English | text-only | – | none | keep-root | CLAUDE.md |
| R014a | User-facing messages through `@sdlc/messages` | test | tests/messages/catalog.test.ts:41 | partial | move:platform/packages/messages; add-lint | CLAUDE.md |
| R015 | Plain English (writing-style link) | text-only | – | none | keep-root (pointer) | CLAUDE.md |
| R016 | Handbook never cites internal source docs | test | tests/workspace/docs-codes.test.ts | full | move:handbook (pointer) | CLAUDE.md |
| R024a | Only canonical codes | test | tests/config/codes-table-drift.test.ts:317 | partial | keep-root | CLAUDE.md |
| R024b | Never reintroduce old codes (G0–G12, S0–S9) | test | tests/workspace/docs-codes.test.ts (the old gate and level codes; the old S codes are not checked, since "S3" is the storage API) | partial | keep-root | CLAUDE.md |
| R025 | Codes table wins; conflicts to QUESTIONS | text-only | – | none | keep-root | CLAUDE.md |
| R026a | Every table has tenant_id | test | tests/db/schema.test.ts:54 | full | pointer-only | CLAUDE.md |
| R026b | Every query through forTenant/TenantScope | runtime+test | packages/core/src/db/tenant-scope.ts:97; tests/db/tenant-guard.test.ts | full | pointer-only | CLAUDE.md |
| R027 | LLM calls via LiteLLM with 7 labels | test | tests/agent/request.test.ts:49 | partial | keep-root | CLAUDE.md |
| R028a | Agents never hold provider keys | test | tests/deploy/litellm-static.test.ts:105 | full | pointer-only | CLAUDE.md |
| R028b | Agents never push to default branch | test+hook | tests/integration/db/publish-run.test.ts:363; the hook refuses Claude's push to `main` (W01 PR 2) | partial | keep-root | CLAUDE.md |
| R028c | Agents never deploy to production | ? | – | none | keep-root | CLAUDE.md |
| R028d | Platform never merges | runtime+test | GitHost contract has no merge method; tests/integration/db/gate-g7.test.ts:161 | partial | keep-root; add-test | CLAUDE.md |
| R029 | Separation of duties, A ≠ B | test+runtime | tests/policy/approvers.test.ts:91 | full | keep-root (short) | CLAUDE.md |
| R030a | Append-only tables: triggers + grants | db+test | migrations/0002-audit-log.ts:48; tests/db/schema.test.ts:68; tests/db/append-only.test.ts (one list, every table) | full | pointer-only | CLAUDE.md |
| R030b | Append-only rows hold no free text | db+test | tests/db/runs-sql.test.ts:63 | partial | keep-root | CLAUDE.md |
| R030c | No deletion path for audit/gates/escalations | db | same as R030a | partial (escalations are not append-only) | keep-root | CLAUDE.md |
| R030d | Audit hash chain RFC 8785 + SHA-256 | test | tests/audit/hash-chain.test.ts:52 | full | move:platform/packages/core | CLAUDE.md |
| R031a | Temporal carries IDs/codes only | test | tests/workflow/workflow-client.test.ts:43 | partial | keep-root | CLAUDE.md |
| R031b | No secrets/client data in logs, events, audit | runtime+test | packages/core/src/observability/logger.ts:89 | partial | keep-root | CLAUDE.md |
| R032 | Evidence retention ≥180 days, holds | test | tests/retention/rules.test.ts:34 | full | pointer-only | CLAUDE.md |
| R033 | Vendors behind interfaces | lint+test | eslint.config.mjs:60; tests/workspace/boundaries.test.ts:40 | partial | pointer-only | CLAUDE.md |
| R034a | No secrets in repo | ci | ci.yml:192 (gitleaks) | full | pointer-only | CLAUDE.md |
| R034b | Secrets in OpenBao, AppRole, files not env | test | tests/deploy/worker-static.test.ts:43 | full | move:platform/deploy | CLAUDE.md |
| R034c | Sandboxes never reach OpenBao | runtime+test | apps/runner/src/docker/guard.ts:138 | full | pointer-only | CLAUDE.md |
| R034d | Never write key shares/root tokens to files | test | tests/deploy/openbao-static.test.ts:72 | partial | keep-root | CLAUDE.md |
| R035 | Secret commands only in owner's Terminal | hook | platform/tools/claude-hooks/guard-bash.mjs; tests/workspace/claude-hook.test.ts | partial (the commands listed in CLAUDE.md; `pnpm adlc`/`pnpm sdlc` and the `adlc`/`sdlc` binaries, ADR-M100) | pointer-only | CLAUDE.md |
| R036 | Run Contracts signed by OpenBao Transit | test | tests/deploy/openbao-static.test.ts:132 | full | pointer-only | CLAUDE.md |
| R037a | Polling now, webhooks later, same handler | test | tests/worker/poller-loop.test.ts:70 | partial | move:platform/packages/adapters/git-github | CLAUDE.md |
| R037b | Users by numeric GitHub ID; bots never decide | test | tests/admin/onboarding.test.ts:117 | full | pointer-only | CLAUDE.md |
| R038a | SeaweedFS + Valkey; never MinIO/Redis/ES | test | tests/deploy/compose-static.test.ts:192 | full | pointer-only | CLAUDE.md |
| R038b | Pin images exactly / by digest | test | tests/deploy/compose-static.test.ts:164 | full | pointer-only | CLAUDE.md |
| R039 | Never prune volumes or touch the dev stack | hook | platform/tools/claude-hooks/guard-bash.mjs; tests/workspace/claude-hook.test.ts | partial (prune only; "touch the dev stack" stays text) | keep-root | CLAUDE.md |
| R040 | Claude never tags, releases, publishes | hook+ci | platform/tools/claude-hooks/guard-bash.mjs; tests/workspace/claude-hook.test.ts; workflows guard the tag side | full | pointer-only | CLAUDE.md |
| R041 | Sandbox concurrency configurable; obs optional | runtime+test | tests/runner/settings.test.ts:16 | full | pointer-only | CLAUDE.md |
| R042 | Every FR has tests for its AC | text-only | – | none | keep-root | CLAUDE.md |
| R091 | Design docs approved; differences to QUESTIONS | text-only | CODEOWNERS review | partial | keep-root | CLAUDE.md |
| R092 | D-08 + CSV generated, never by hand | test | tests/workspace/backlog-generated.test.ts (runs the script, compares) | full | pointer-only | CLAUDE.md |
| R093 | Diagrams: render and commit SVG | ci+test | ci.yml:169; tests/workspace/diagrams.test.ts:46 | partial | pointer-only | CLAUDE.md |
| R094 | Handbook split: what Claude may edit | text-only | – | none | move:handbook | CLAUDE.md |
| R095 | Keep CHANGELOG updated | ci | release-check at release time | partial | keep-root | CLAUDE.md |
| R146 | A pull request with an upgrade step writes its Upgrade notes under [Unreleased] (added by ADR-M104) | test | tests/workspace/release-prepare.test.ts (release:prepare refuses without them); platform/tools/release/prepare.mjs | partial | keep-root | CLAUDE.md |
| R096a | Keep CLAUDE.md short | text-only | – | none | keep-root | CLAUDE.md |
| R096b | One DEVELOPMENT.md row per test script | test | tests/workspace/development-doc.test.ts:25 | full | pointer-only | CLAUDE.md |
| R121 | At most 2 sessions at once | text-only | – | none | drop-or-move-to-doc | CLAUDE.md |
| R122 | One task per session, own worktree | text-only | – | none | keep-root | CLAUDE.md |
| R123 | Project state snapshot | INFO | – | – | drop-or-move-to-doc (ROADMAP) | CLAUDE.md |
| R124 | Open docs follow-ups | INFO | – | – | drop-or-move-to-doc (QUESTIONS) | CLAUDE.md |
| R125 | Merge main into a reviewed branch; never rebase/force-push | hook | platform/tools/claude-hooks/guard-bash.mjs; tests/workspace/claude-hook.test.ts | full | pointer-only | CLAUDE.md |
| R126 | QUESTIONS/ADR number blocks | INFO | – | none | move:design (README "Number blocks") | CLAUDE.md |
| R127 | Throw-away OpenBao keys in dev | INFO | – | – | drop-or-move-to-doc (runbook T11) | CLAUDE.md |
| R132 | Never weaken or bypass the Claude Code hook (added by W01 PR 2) | test | tests/workspace/claude-hook.test.ts (the settings file runs the script) | partial | keep-root | CLAUDE.md |
| R133 | Every CLAUDE.md rule has a register row and an ID tag (added by W01 PR 1, PR 4) | test | tests/workspace/claude-md.test.ts | full | keep-root | CLAUDE.md |

## 2. Workflow and gates

| ID | Rule | Kind | Enforced by | Coverage | Proposal | File |
|---|---|---|---|---|---|---|
| R043a | stepIntent: one move under the lock | test+runtime | tests/integration/db/intent-workflow.test.ts:270 | full | move:platform/packages/core/src/workflow | platform/packages/core/CLAUDE.md |
| R043b | Workflow code imports only allowed modules | lint | eslint.config.mjs:116 | full | pointer-only | platform/packages/core/CLAUDE.md |
| R044a | Escalation clocks in the `escalations` row | text-only | – | none | move:platform/apps/worker | platform/packages/core/CLAUDE.md |
| R044b | Gate deadline is the only workflow timer | test | tests/workflow/hotl-overdue.test.ts:65 | partial | add-test | platform/packages/core/CLAUDE.md |
| R044c | Plain loops, never Temporal schedules | lint | eslint.config.mjs (worker: no ScheduleClient, no `.schedule.create`); tests/workspace/lint-rules.test.ts | full | pointer-only | platform/packages/core/CLAUDE.md |
| R045a | assertActionAllowed / revalidate before acting | runtime+test | tests/integration/db/escalations.test.ts:358 | partial | move:platform/packages/core/src/escalation | platform/packages/core/CLAUDE.md |
| R045b | kill_run, revoke_credentials never frozen | runtime+test | packages/contracts/src/escalation.ts:105 | full | pointer-only | platform/packages/core/CLAUDE.md |
| R045c | Budget up only by a named decision | runtime+test | tests/integration/db/escalation-commands.test.ts:450 | full | move:platform/packages/core/src/escalation | platform/packages/core/CLAUDE.md |
| R045d | Budgets only go up | db | migrations/0015-gate-g5.ts:29 | full | pointer-only | platform/packages/core/CLAUDE.md |
| R046 | No run while the HOTL block window is open | runtime+test | packages/core/src/workflow/g4.ts:158 | full | move:platform/packages/core/src/workflow | platform/packages/core/CLAUDE.md |
| R047a | Oversight via resolveGateOversight only | test | tests/workflow/gate-oversight.test.ts (every file of `workflow/`) | full | pointer-only | platform/packages/core/CLAUDE.md |
| R047b | Waiting reasons only in the step | text-only | – | none | move:platform/packages/core/src/workflow | platform/packages/core/CLAUDE.md |
| R047c | New reason needs enum, label, map, rules | test+db | tests/cli/next.test.ts:76 | full | pointer-only | platform/packages/core/CLAUDE.md |
| R048a | G2 needs ≥1 acceptance criterion | runtime+test | tests/integration/db/spec-linking.test.ts:501 | full | pointer-only | platform/packages/core/CLAUDE.md |
| R048b | Specs/plans read from default branch | runtime+test | tests/integration/db/spec-linking.test.ts:167 | full | move:platform/packages/core/src/specs | platform/packages/core/CLAUDE.md |
| R048c | Store hashes and counts, never text | test | tests/integration/db/spec-linking.test.ts:182 | partial | move:platform/packages/core/src/specs | platform/packages/core/CLAUDE.md |
| R049a | Changed plan holds G3/G4 | runtime+test | tests/integration/workflow/plan-resubmit.test.ts:112 | full | move:platform/packages/core/src/plans | platform/packages/core/CLAUDE.md |
| R049b | plans.commit_sha = head read | test | tests/integration/db/plan-submission.test.ts:278 | full | pointer-only | platform/packages/core/CLAUDE.md |
| R050a | G4 decision bound to the run proposal | test | tests/integration/db/gate-g4.test.ts:77 | full | move:platform/packages/core/src/workflow | platform/packages/core/CLAUDE.md |
| R050b | G8 bound to release_sha256 + merge | db+test | tests/integration/db/gate-g8.test.ts:242 | partial | add-test | platform/packages/core/CLAUDE.md |
| R051a | G7 = PR reviews; /approve G7 refused | runtime+test | tests/integration/db/gate-g7.test.ts:224 | full | pointer-only | platform/packages/core/CLAUDE.md |
| R051b | Changes request found by receipt event ID | runtime+test | tests/integration/db/g7-request-changes.test.ts | partial | move:platform/packages/core/src/workflow | platform/packages/core/CLAUDE.md |
| R051c | API/CLI refuse request_changes at G7 | runtime+test | tests/integration/db/g7-request-changes.test.ts:459 | full | pointer-only | platform/packages/core/CLAUDE.md |
| R052a | Never issue a run twice | db+test | migrations/0004-runs.ts:53 | full | pointer-only | platform/packages/core/CLAUDE.md |
| R052b | End runs only with RunRepository.end | db+test | tests/integration/db/kill-switch.test.ts:231 | partial | add-lint | platform/packages/core/CLAUDE.md |
| R052c | A kill never reaches a later run | runtime | apps/worker/src/workflows/intent-workflow.ts:145 | ? | add-test | platform/packages/core/CLAUDE.md |
| R053a | Eval runs in evaluation tables, append-only | db | migrations/0029-evaluations.ts:226 | full | pointer-only | platform/packages/core/CLAUDE.md |
| R053b | Eval cost never with an intent | db+test | migrations/0029-evaluations.ts:239 | full | pointer-only | platform/packages/core/CLAUDE.md |
| R053c | Eval uses free runner slots only | test | tests/runner/pool-evaluation.test.ts:19 | full | pointer-only | platform/packages/core/CLAUDE.md |
| R053d | Eval stores codes/numbers, never prompts | partial | – | partial | move:platform/packages/core/src/evaluation | platform/packages/core/CLAUDE.md |
| R053e | Scoring containers, NetworkMode none | runtime+test | apps/runner/src/docker/guard.ts:149 | full | pointer-only | platform/packages/core/CLAUDE.md |
| R053f | Eval queue, no run event | runtime | packages/contracts/src/evaluation-activity.ts:9 | partial | move:platform/apps/runner | platform/packages/core/CLAUDE.md |
| R053g | EvaluationLoop plain loop, one workflow per attempt | lint+test | eslint.config.mjs (no Temporal schedule); tests/integration/db/evaluation-loop.test.ts:418 | partial | move:platform/apps/worker | platform/packages/core/CLAUDE.md |
| R054a | Only eval_roles change/run plans | runtime+test | packages/config/src/mandatory-rules.ts:632 | full | pointer-only | platform/packages/core/CLAUDE.md |
| R054b | Prompt variant = path, commit, hash | test | tests/integration/db/evaluation-plans.test.ts:165 | full | pointer-only | platform/packages/core/CLAUDE.md |
| R054c | One open evaluation per plan | db | migrations/0031-evaluation-plans.ts:135 | full | pointer-only | platform/packages/core/CLAUDE.md |
| R054d | Amounts by new version, never below spend | db+test | tests/integration/db/evaluation-plans.test.ts:227 | full | pointer-only | platform/packages/core/CLAUDE.md |
| R134a | Evaluation task = card path, commit, SHA-256; never its content (added by L07 PR 3a) | db+test | migrations/0033-evaluation-tasks.ts; tests/integration/db/evaluation-tasks.test.ts ("the tables hold no text") | full | pointer-only | platform/packages/core/CLAUDE.md |
| R134b | Task reviewer has an eval role, is never a producer; decision bound to the card's SHA-256 (added by L07 PR 3a) | test | tests/integration/db/evaluation-tasks.test.ts ("refuses producers") | full | pointer-only | platform/packages/core/CLAUDE.md |
| R055 | Never offer approval to producer / role-less | test | tests/cli/next.test.ts:200 | partial | move:platform/apps/cli | platform/packages/core/CLAUDE.md |
| R056a | Producers never decide G7/G8 | runtime+test | tests/policy/approvers.test.ts:91 | full | pointer-only | platform/packages/core/CLAUDE.md |
| R056b | Escalations decided by owner/backup/governance | test | tests/integration/db/escalations.test.ts:427 | full | pointer-only | platform/packages/core/CLAUDE.md |
| R057a | Unreadable host/file makes the step wait | test | tests/integration/db/gate-g6-ci.test.ts:405 | partial | add-test | platform/packages/core/CLAUDE.md |
| R057b | HOTL never passes G2 without AC | test | same as R048a | full | removed (duplicate of R048a; W01 PR 1) | platform/packages/core/CLAUDE.md |
| R058a | Never raise data class | db | migrations/0003-registry.ts:185 | full | pointer-only | platform/packages/core/CLAUDE.md |
| R058b | L1 runs never commit or push | runtime | apps/runner/src/agent/drive.ts:521 | partial | move:platform/apps/runner | platform/packages/core/CLAUDE.md |
| R058c | Proposal download mode 600 | runtime+test | tests/cli/evidence-proposal.test.ts:24 | full | pointer-only | platform/packages/core/CLAUDE.md |
| R058d | Only paused L1 takes a G4 rejection | runtime+test | tests/integration/db/l1-proposal.test.ts:252 | full | pointer-only | platform/packages/core/CLAUDE.md |
| R059a | `plan draft`: no API, no Git | test | tests/cli/plan-draft.test.ts:38 | partial | move:platform/apps/cli; add-test | platform/apps/cli/CLAUDE.md |
| R059b | Never fill PERSON MUST by guessing | test | tests/plans/plan-draft.test.ts:80 | full | pointer-only | platform/apps/cli/CLAUDE.md |
| R060a | Public PR text is codes only | runtime+test | packages/core/src/workflow/publish.ts:237 | partial | add-test | platform/packages/core/CLAUDE.md |
| R060b | Logins for mentions read when posting, never stored | runtime | ADR-M28, ADR-M30 (notices); `user_identities.external_login` is the admin identity (ADR-M37), not a mention | partial | keep (wording fixed in W01 PR 1) | platform/packages/core/CLAUDE.md |
| R061a | Sandbox spec only via docker/guard.ts | runtime+test | tests/runner/spec-guard.test.ts:67 | full | pointer-only | platform/apps/runner/CLAUDE.md |
| R061b | Sandbox egress LiteLLM + package proxy only | test+ci | tests/integration/runner/egress.test.ts:145 | full | pointer-only | platform/apps/runner/CLAUDE.md |
| R061c | Socket proxy allowlist = ALLOWED_ENDPOINTS | test | tests/deploy/sandbox-profile.test.ts:177 | full | pointer-only | platform/apps/runner/CLAUDE.md |
| R062a | Trust sdlc.* labels with own instance label | runtime+test | tests/runner/reconcile.test.ts:27 | full | move:platform/apps/runner | platform/apps/runner/CLAUDE.md |
| R062b | One runner per instance label | text-only | comment only | none | move:platform/apps/runner | platform/apps/runner/CLAUDE.md |

## 3. Runner, evidence, storage, migrations, OpenBao

| ID | Rule | Kind | Enforced by | Coverage | Proposal | File |
|---|---|---|---|---|---|---|
| R063a | Runner uses its own Docker client allowlist | runtime+test | apps/runner/src/docker/client.ts:32 | full | pointer-only | platform/apps/runner/CLAUDE.md |
| R063b | GitHub App key never readable by runner | test | tests/deploy/openbao-static.test.ts:213 | full | pointer-only | platform/apps/runner/CLAUDE.md |
| R064a | Recompute diff outside sandbox, hardened git | runtime+test | tests/runner/proposal.test.ts:304 | partial | move:platform/apps/runner | platform/apps/runner/CLAUDE.md |
| R064b | Never push sandbox commit / write working tree | runtime | apps/runner/src/workspace/export.ts:107 | partial | add-test | platform/apps/runner/CLAUDE.md |
| R064c | No force-push; explicit refspec | runtime | apps/runner/src/workspace/git.ts:201 | partial | add-test | platform/apps/runner/CLAUDE.md |
| R065a | Agent tools: 3 built-in; register tools only as granted, through the run's MCP gateway (X04) | db+test | tests/agent/request.test.ts:58; tests/agent/request-tools.test.ts; tests/runner/tools.test.ts; tests/integration/runner/tools.test.ts | full | pointer-only | platform/apps/runner/CLAUDE.md |
| R065b | Model in allowed_models | test | tests/agent/request.test.ts:93 | full | pointer-only | platform/apps/runner/CLAUDE.md |
| R065c | AGENTS.md from workspace only | test | tests/agent/request.test.ts:65 | full | pointer-only | platform/apps/runner/CLAUDE.md |
| R065d | Instructions/model edit = new version | db+test | migrations/0008-agents.ts:101 | full | pointer-only | platform/apps/runner/CLAUDE.md |
| R065e | Never activate an agent via `sdlc ops` | text-only | comment only | none | add-test | platform/apps/runner/CLAUDE.md |
| R066 | Plan/feedback in nonce blocks | runtime+test | tests/agent/plan-prompt.test.ts:24 | full | pointer-only | platform/apps/runner/CLAUDE.md |
| R067a | Budget block = 422 + budget_exceeded | text-only | no code reads the status today; the runner reads the key's spend (ADR-M24 §2.2) | none (guards future code) | move:platform/packages/adapters/model-litellm | platform/apps/runner/CLAUDE.md |
| R067b | Money as decimal string | test | tests/cost/money.test.ts:23 | full | pointer-only (merge with R071b) | platform/apps/runner/CLAUDE.md |
| R067c | listSpend never partial | test | tests/cost/litellm-gateway.test.ts:317 | full | pointer-only | platform/apps/runner/CLAUDE.md |
| R068a | GitHub tokens single-repository | test | tests/git-github/app-auth.test.ts:121 | full | pointer-only | platform/apps/runner/CLAUDE.md |
| R068b | Runner revokes tokens after use | runtime+test | tests/git-github/revoke-token.test.ts:25 | partial | move:platform/apps/runner | platform/apps/runner/CLAUDE.md |
| R069a | Evidence never overwritten | runtime+test | tests/evidence/s3-store.test.ts:106 | full | pointer-only | platform/packages/core/CLAUDE.md |
| R069b | Re-check hash/size before use | runtime+test | packages/core/src/evidence/build.ts:68 | partial | move:platform/packages/core/src/evidence | platform/packages/core/CLAUDE.md |
| R069c | Evidence readers never log bytes | text-only | – | none | keep-root | platform/packages/core/CLAUDE.md |
| R070a | Pack holds codes/hashes only | test | tests/evidence/pack.test.ts:350 | full | pointer-only | platform/packages/core/CLAUDE.md |
| R070b | Names only in Markdown, escaped | test | tests/evidence/pack.test.ts:415 | full | pointer-only | platform/packages/core/CLAUDE.md |
| R070c | worker-purge never reads | test | tests/integration/openbao/retention-purge.test.ts:331 | full | pointer-only | platform/packages/core/CLAUDE.md |
| R071a | Reports sum in SQL | test | tests/cost/report.test.ts:103 | partial | keep-root | platform/packages/core/CLAUDE.md |
| R071b | Money/token sums as strings | test | tests/cost/report.test.ts:112 | full | merge with R067b | platform/packages/core/CLAUDE.md |
| R071c | Never a per-person breakdown | text-only | – | none | add-test | platform/packages/core/CLAUDE.md |
| R071d | `trial report` strict schema | test | tests/cli/trial-report.test.ts:114 | full | pointer-only | platform/packages/core/CLAUDE.md |
| R072a | Lock bypass only for archive purge, orphan sweep, client-data purge | runtime+test | packages/core/src/retention/pass.ts; retention/client-purge-pass.ts | partial | move:platform/packages/core/src/retention | platform/packages/core/CLAUDE.md |
| R072b | Nothing < 180 days purged for retention (client deletion may) | runtime+test | tests/retention/rules.test.ts; tests/retention/client-purge-rules.test.ts | full | pointer-only | platform/packages/core/CLAUDE.md |
| R072c | Anchor bucket COMPLIANCE | test | tests/deploy/worker-static.test.ts:171 | full | pointer-only | platform/packages/core/CLAUDE.md |
| R072d | Never log anchor hash | test | tests/audit/anchor.test.ts:218 | full | pointer-only | platform/packages/core/CLAUDE.md |
| R073a–d | Langfuse purge rules | test | tests/llm-traces/langfuse-store.test.ts; tests/deploy/worker-static.test.ts:235 | full | pointer-only | platform/packages/core/CLAUDE.md |
| R074a,b,d | SeaweedFS: S3 only, no Iceberg/Lance, weed shell master | test | tests/deploy/seaweedfs-static.test.ts | full | pointer-only | platform/deploy/CLAUDE.md |
| R074c | JWT keys only in their file | test | tests/deploy/seaweedfs-static.test.ts:150 | partial | pointer-only | platform/deploy/CLAUDE.md |
| R074e | Never `weed shell s3.config.show` | test+hook | specific scripts; platform/tools/claude-hooks/guard-bash.mjs; tests/workspace/claude-hook.test.ts | full | pointer-only | platform/deploy/CLAUDE.md |
| R074f | Never S3 keys as process arguments | text-only | – | none | move:platform/deploy | platform/deploy/CLAUDE.md |
| R075a | Migrations are plain SQL in TypeScript files | test | tests/db/schema.test.ts:38 | partial | keep (wording fixed in W01 PR 1) | platform/packages/core/CLAUDE.md |
| R075b | Never edit a merged migration | test | migrations/migrations.lock.json; tests/db/migrations-lock.test.ts | full | pointer-only | platform/packages/core/CLAUDE.md |
| R075c | Audit only via TenantScope.audit.append | db+lint | migrations/0002-audit-log.ts; eslint.config.mjs (`insertInto('audit_log')` only in its repository); tests/workspace/lint-rules.test.ts | full | pointer-only | platform/packages/core/CLAUDE.md |
| R075d | New event/action declared with a test | test | tests/audit/actions.test.ts:48 | partial | keep-root | platform/packages/core/CLAUDE.md |
| R076a | OpenBao TLS, verification never off | runtime+test | packages/secrets/src/transport.ts:38 | full | pointer-only | platform/deploy/CLAUDE.md |
| R076b | No plain listener / host TLS mount | test | tests/deploy/openbao-tls-static.test.ts:21 | full | pointer-only | platform/deploy/CLAUDE.md |
| R076c | OpenBao healthy = reachable, not unsealed | test | tests/deploy/openbao-tls-static.test.ts:73 | partial | keep-root | platform/deploy/CLAUDE.md |

## 4. Secrets/deployment, dashboard/API, release

| ID | Rule | Kind | Enforced by | Coverage | Proposal | File |
|---|---|---|---|---|---|---|
| R077 | `Redacted`; reveal() never logged | test | tests/secrets/redaction.test.ts:26 | partial | add-lint | CLAUDE.md |
| R078a | compose:env never overwrites | test | tests/deploy/compose-static.test.ts:353 | full | pointer-only | platform/deploy/CLAUDE.md |
| R078b | `compose down -v` only to wipe dev | hook | platform/tools/claude-hooks/guard-bash.mjs; tests/workspace/claude-hook.test.ts | full | pointer-only | platform/deploy/CLAUDE.md |
| R079a | Backups encrypted while streaming | test | tests/deploy/backup-static.test.ts:20 | full | pointer-only | platform/deploy/CLAUDE.md |
| R079b | Backup schedule is the server's | test | tests/deploy/backup-static.test.ts:49 | partial | move:platform/deploy | platform/deploy/CLAUDE.md |
| R080a | doctor through commands.ts allowlist | test+runtime | tests/doctor/host-readonly.test.ts:78 | full | pointer-only | platform/deploy/CLAUDE.md |
| R080b | doctor never writes | test | tests/doctor/host-readonly.test.ts:96 | partial | move:platform/deploy/doctor | platform/deploy/CLAUDE.md |
| R080c | doctor `--env`, never `--env-file` | runtime+test | platform/deploy/doctor/src/main.ts:26; tests/trial/compose-project-name.test.ts | full | pointer-only | platform/deploy/CLAUDE.md |
| R080d | doctor prints no secret | test | tests/doctor/no-secrets.test.ts:81 | full | pointer-only | platform/deploy/CLAUDE.md |
| R080e | Troubleshooting rows ↔ troubleshooting.ts | test | tests/deploy/doctor-troubleshooting.test.ts:51 | full | pointer-only | platform/deploy/CLAUDE.md |
| R081a | trial only on developer machines | test | tests/deploy/trial-up-static.test.ts:111 | partial | move:platform/deploy/trial | platform/deploy/CLAUDE.md |
| R081b | Every compose call passes `-p` | test | tests/trial/trial-start.test.ts:136 | partial | add-test | platform/deploy/CLAUDE.md |
| R081c | No inherited COMPOSE_PROJECT_NAME | runtime+test | platform/deploy/steps/src/exec.ts:27; tests/trial/compose-project-name.test.ts | full | pointer-only | platform/deploy/CLAUDE.md |
| R081d | Passphrase never from arg/env | test | tests/deploy/trial-up-static.test.ts:204 | full | pointer-only | platform/deploy/CLAUDE.md |
| R081e | Fresh deployment ↔ the shared steps (`platform/deploy/steps`) ↔ trial:up, server:setup, test:fresh-deploy | test+ci | tests/deploy/trial-up-static.test.ts:38; tests/deploy/server-setup-static.test.ts | partial | keep-root | platform/deploy/CLAUDE.md |
| R081f | README "Upgrade" ↔ test:upgrade; `--add-missing` only appends (added by O02) | test+ci | tests/deploy/upgrade-readme.test.ts; tests/deploy/compose-static.test.ts ("--add-missing") | full | pointer-only | platform/deploy/CLAUDE.md |
| R082a–f | Access proxy rules | test | tests/deploy/access-static.test.ts; tests/trial/trial-up.test.ts:307 | full | pointer-only | platform/deploy/CLAUDE.md |
| R137 | vLLM (profile `models-local`) only on the internal network `models` with LiteLLM (and `vllm-link` of `models-remote`, never both at once), no host port; weights read-only, offline; no prompt logging, no remote code; the profile optional (added by L01; L01 PR 2: the link) | test | tests/deploy/models-local-static.test.ts; tests/deploy/models-remote-static.test.ts | full | pointer-only | platform/deploy/CLAUDE.md |
| R147 | Docker AuthZ plugin on the runner Engine: host process (never a container of that Engine); shared create-body denylist with `docker/guard.ts` (`@sdlc/docker-authz`); only the operator header with the operator key (mode 600, never printed) skips it, never the runner (QUESTIONS #661); doctor `runner.authz` warns when missing (H07, ADR-M105) | test+ci | tests/runner/authz-eval.test.ts; tests/deploy/docker-authz-plugin.test.ts; tests/doctor/runner.test.ts; `pnpm test:runner` on rootless (AC3) | full | pointer-only | platform/deploy/CLAUDE.md |
| R148 | vLLM on a separate GPU host: the GPU host's Compose file holds no platform service, volume or network and keeps `vllm` and `vllm-pull` equal to `docker-compose.yml`; the gateway publishes one port, only on `SDLC_GPU_LINK_ADDR`, requires a client certificate of the link's CA with the link's name and forwards four routes only; `vllm-link` verifies the GPU host's certificate and name, has no host port, and never runs with `models-local`; neither logs a header, body or query string; no CA key next to the link's files (added by L01 PR 2) | test+ci | tests/deploy/models-remote-static.test.ts; `pnpm test:vllm-link` (CI job `compose`) | full | pointer-only | platform/deploy/CLAUDE.md |
| R141 | The runner on its own Engine: the runner host's Compose file holds no platform service, volume or network and keeps the runner, socket proxy and package proxy equal to `docker-compose.yml`; each relay has one fixed target on `SDLC_RUNNER_LINK_ADDR`; the link ports (OpenBao's included) only on `SDLC_RUNNER_LINK_ADDR` (added by O01 PR 2) | test+ci | tests/deploy/runner-host.test.ts; tests/deploy/openbao-no-host-port.test.ts; tests/doctor/runner.test.ts; `pnpm test:runner-split` (CI job `runner-rootless`) | full | pointer-only | platform/deploy/CLAUDE.md |
| R149 | The runner host set-up (`runner-host-setup.sh`, V18): the same step code as the CI script (`rootless-engine.sh`); each step checks the state first; a file or `.env` key with another value is refused before any change; never `kernel.apparmor_restrict_unprivileged_userns=0`, never the machine's own Engine, never an Engine with the platform's data; installs no package; only the owner runs it (added by V18) | test+hook+ci | tests/deploy/runner-host-setup.test.ts; platform/tools/claude-hooks/guard-bash.mjs; tests/workspace/claude-hook.test.ts; CI job `runner-rootless` (`test-rootless-docker.sh`) | full | pointer-only | platform/deploy/CLAUDE.md |
| R143 | `pnpm server:setup` (V16): refuses without a terminal on stdin and stdout; clears the screen and scroll-back after each key share; `-pgp-keys` when every key holder has a PGP key; the root token only for `configure` (`--issue-admin-token`, refused on a terminal), revoked on any stop before it; one admin token, revoked at the end; no share or token in a file, an argument, an environment variable or a log; the Bash hook refuses it (added by V16) | test+hook | tests/deploy/server-setup.test.ts; tests/deploy/server-setup-static.test.ts; platform/tools/claude-hooks/guard-bash.mjs; tests/workspace/claude-hook.test.ts | full | pointer-only | platform/deploy/CLAUDE.md |
| R144 | `pnpm alerts` (O03, ADR-M101): only doctor's checks, no process but `sendmail`; a message holds doctor's results only, never an env value, log line or command output; the webhook URL in a file of mode 600, only `https://`, never printed; the state file holds IDs, statuses and times; the schedule is the server's, never a compose service (added by O03) | test | tests/alerts/static.test.ts; tests/alerts/run.test.ts; tests/alerts/channels.test.ts | full | pointer-only | platform/deploy/CLAUDE.md |
| R145 | Ended web sessions and old passkey challenges removed only by the definer functions of migration 0046 (floors 7 days, 1 hour); no DELETE grant for `platform_app`; append-only tables never removed or summarised (added by O04, ADR-M103) | db+test | migrations/0046-housekeeping.ts; tests/integration/db/housekeeping.test.ts; tests/db/append-only.test.ts | full | pointer-only | platform/packages/core/CLAUDE.md |
| R083a,b | GitHub App manifest; secrets dropped | test | tests/deploy/github-app.test.ts:58 | full | pointer-only | platform/deploy/CLAUDE.md |
| R084a | Log only through the platform logger | lint+test | eslint.config.mjs (`no-console` in apps and packages; `migrate-cli.ts` excepted); tests/observability/logger.test.ts:178; tests/workspace/lint-rules.test.ts | full | pointer-only | CLAUDE.md |
| R084b | Spans hold no headers/SQL params | test | tests/observability/tracing.test.ts:100 | full | pointer-only | CLAUDE.md |
| R084c | Pools have error listeners | test | tests/db/connection.test.ts:44 | partial | move:platform/packages/core | CLAUDE.md |
| R084d | api/worker import telemetry first | test | tests/observability/load-order.test.ts:23 | full | pointer-only | CLAUDE.md |
| R084e | otel-collector rules | test | tests/deploy/observability-static.test.ts:31 | full | pointer-only | CLAUDE.md |
| R085a | Dashboard writes only via writes.ts | test+lint | tests/dashboard/static.test.ts:36 | full | pointer-only | platform/apps/dashboard/CLAUDE.md |
| R085b | `@SessionAction` only on the listed routes (L05, U07, U08, U09) | test | tests/integration/db/web-sessions.test.ts:449; tests/api/session-actions.test.ts (the marked routes, by file; every U09 change takes the step-up); tests/integration/db/dashboard-decisions.test.ts (the step-up); tests/integration/db/dashboard-intake.test.ts (U08, no step-up); tests/integration/db/dashboard-admin.test.ts (U09, the admin step-up) | full | pointer-only | platform/apps/dashboard/CLAUDE.md |
| R085c–e | Passkey step-up, bearer XOR cookie, CSRF | test | tests/integration/db/web-sessions.test.ts:440 | full | pointer-only | platform/apps/dashboard/CLAUDE.md |
| R086a–e,g | Cookie, token, no inline/innerHTML/storage, reads.ts, sign-in nav | lint+test | eslint.config.mjs:89; tests/dashboard/static.test.ts | full | pointer-only | platform/apps/dashboard/CLAUDE.md |
| R086f | Server text via cleanText | lint+test | tests/dashboard/static.test.ts:138 | partial | move:platform/apps/dashboard | platform/apps/dashboard/CLAUDE.md |
| R087a,c,d,e | CLI token input, TLS, show once, 700/600 | test | tests/cli/login.test.ts | full | pointer-only | platform/apps/cli/CLAUDE.md |
| R087b | CLI never prints tokens | test | tests/cli/login.test.ts:72 | partial | move:platform/apps/cli | platform/apps/cli/CLAUDE.md |
| R087f | `sdlc doctor` no new endpoint | test | tests/cli/doctor.test.ts:340 | partial | move:platform/apps/cli | platform/apps/cli/CLAUDE.md |
| R088a | No self-grant or self-disable | test | tests/integration/db/admin-onboarding.test.ts:175 | partial (no self-disable test) | add-test | platform/apps/api/CLAUDE.md |
| R088b | Last admin never removed | test | tests/integration/db/admin-onboarding.test.ts:175 | full | pointer-only | platform/apps/api/CLAUDE.md |
| R088c | Roles revoked, never deleted | db+test | tests/integration/db/admin-onboarding.test.ts:239 | partial | add-test | platform/apps/api/CLAUDE.md |
| R088d | Users by ID in URLs | test | tests/cli/admin-api.test.ts:85 | partial | move:platform/apps/api | platform/apps/api/CLAUDE.md |
| R088e | Agents never deleted; key never reused | db+test | tests/db/agents-sql.test.ts:35 | full | pointer-only | platform/apps/api/CLAUDE.md |
| R088f | Activation approvers different people | test | tests/integration/db/admin-agents.test.ts:195 | partial | move:platform/apps/api | platform/apps/api/CLAUDE.md |
| R135 | Agent activation checked against its named evaluation; `required` refuses; one evaluation per round; IDs and codes only in the audit (added by L09 PR 2) | db+test | tests/integration/db/agent-evaluation-approvals.test.ts ("the mode", "one evaluation per round", "passes") | full | pointer-only | platform/apps/api/CLAUDE.md |
| R136 | A quality drop at recertification never suspends the agent; a person decides (added by L10) | test | tests/integration/db/agent-evaluation-recertification.test.ts ("the agent stays active") | full | pointer-only | platform/apps/api/CLAUDE.md |
| R138 | A tool's backing services only from `SDLC_RUNNER_TOOL_SERVICES`, on its own service network; its credential a file in its runtime volume, never an environment value; `knowledge_read` from its own log, IDs and hashes only (added by X04 PR 3b) | test | tests/runner/tool-services.test.ts; tests/runner/knowledge-read-record.test.ts; tests/integration/runner/tool-docs.test.ts | full | pointer-only | platform/apps/runner/CLAUDE.md |
| R139 | Context condensing only for OpenHands work runs with a known context size, on the run's own model, LiteLLM URL and key; summaries leave the adapter as SHA-256 and length only, counts in run events (added by X11) | test | tests/agent/condensing.test.ts; tests/config/context-condensing-config.test.ts; tests/integration/db/agent-drive.test.ts ("X11"); tests/integration/agent/agent-live.test.ts ("X11") | full | pointer-only | platform/apps/runner/CLAUDE.md |
| R140 | Every run's added lines are scanned for secrets outside the sandbox with the pinned Gitleaks of `gitleaks.sh`, the base commit's `.gitleaks.toml` only; `secrets_scanned` holds codes and counts, never a match or a path; G5 holds a run on a finding, a failed scan or no scan (added by H04) | test | tests/runner/secrets.test.ts; tests/gitleaks/runner-pin.test.ts; tests/workflow/gate-g5.test.ts ("H04"); tests/integration/db/gate-g5.test.ts ("H04") | full | pointer-only | platform/apps/runner/CLAUDE.md |
| R142 | Every run's change is measured outside the sandbox (files and lines; lock files and the base commit's `linguist-generated` files apart, never the agent's `.gitattributes`); `diff_measured` holds counts, never a path; over `run.review_limits`, or not measured, G5 is HITL and counts only an approval with an allowing reason code (added by H05) | test | tests/runner/review-size.test.ts; tests/policy/oversight.test.ts ("H05"); tests/workflow/gate-g5.test.ts ("H05"); tests/integration/db/gate-g5.test.ts ("H05") | full | pointer-only | platform/apps/runner/CLAUDE.md |
| R089a | Never rename verify-images / npm | test | tests/workspace/release.test.ts:463 | full | pointer-only | CLAUDE.md |
| R089b | The lock file is a release asset, never edited or replaced (ADR-M94) | test | tests/workspace/release.test.ts:513 (no tracked lock file), tests/workspace/release.test.ts:358 (a published Release is never changed) | partial | pointer-only | CLAUDE.md |
| R089c–e | Tag never moves, Trivy, CLI licences | test+ci | tests/workspace/release.test.ts:358 | full | pointer-only | CLAUDE.md |
| R089f | New image in 4 places together | test | tests/deploy/release-images.test.ts:123 | partial | move:platform/deploy | CLAUDE.md |
| R090a | PLATFORM_VERSION = package.json | test+ci | tests/cli/version.test.ts:45 | full | pointer-only | CLAUDE.md |
| R090b | Upgrade notes in every release section | test+ci | release-check.mjs:90 | partial | add-test | CLAUDE.md |

## 5. Open points

- R067a: no code reads LiteLLM's status today; the runner reads the key's spend (ADR-M24 §2.2). The rule stays for any code that reads the status later.
- R060b: the rule is about the logins mentioned in notice comments (ADR-M28, ADR-M30). The login of an admin identity (`user_identities.external_login`, ADR-M37) is a different case. The wording in `CLAUDE.md` now says so.
- R123, R126, R127 hold dates or task names and will become wrong; W01 PR 4 moves them out of the root `CLAUDE.md`. R085b no longer names "before U07" (task U07, 2026-10-29).
- Same rule twice: R067b and R071b (money as a decimal string); R044c and R053g (plain loops, never Temporal schedules). PR 4 keeps one line each.

## 6. Totals (2026-10-20)

| Coverage | Rows |
|---|---|
| full | 94 |
| partial | 65 |
| none | 27 |
| unknown or INFO | 4 |

Some rows group several rules with the same check (for example R082a–f).

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-10-20 | Claude (task W01, PR 1) | First version, from a review of every bullet of the root `CLAUDE.md` |
| 0.2 | 2026-10-20 | Claude (task W01, PR 2) | R028b, R035, R039, R040, R074e, R078b, R125: the Claude Code hook (`.claude/settings.json`) |
| 0.3 | 2026-10-20 | Claude (task W01, PR 3) | R016, R024b, R030a, R044c, R047a, R053g, R075b, R075c, R080c, R081c, R084a, R085b, R092: lint rules and tests |
| 0.4 | 2026-10-20 | Claude (task W01, PR 4) | Column "File": the root `CLAUDE.md` or a folder's `CLAUDE.md`; new row R133 |
| 0.5 | 2026-10-21 | Claude (task L09, PR 2) | New row R135 (evaluations in the agent approvals, `platform/apps/api/CLAUDE.md`) |
| 0.6 | 2026-10-21 | Claude (task L10) | New row R136 (the platform never suspends an agent by itself, `platform/apps/api/CLAUDE.md`) |
| 0.7 | 2026-10-24 | Claude (task L01, PR 1) | New row R137 (the self-hosted vLLM of the profile `models-local`, `platform/deploy/CLAUDE.md`) |
| 0.8 | 2026-10-24 | Claude (task X04, PR 3b) | New row R138 (a tool's backing services, credential file and `knowledge_read`, `platform/apps/runner/CLAUDE.md`) |
| 0.9 | 2026-10-24 | Claude (task X11) | New row R139 (context condensing: the run's own model and key, summaries never as text, `platform/apps/runner/CLAUDE.md`) |
| 0.10 | 2026-10-24 | Claude (task H04) | New row R140 (the secret scan of every run's diff, `platform/apps/runner/CLAUDE.md`) |
| 0.11 | 2026-10-24 | Claude (task O02) | New row R081f (the README "Upgrade" and `pnpm test:upgrade` in step; `compose:env --add-missing` only appends) |
| 0.12 | 2026-10-24 | Claude (task O01, PR 2) | New row R141 (the runner on its own Docker Engine: the runner host's file, the relays, the link ports, `platform/deploy/CLAUDE.md`) |
| 0.13 | 2026-10-26 | Claude (task H05) | New row R142 (the review size of every run's change, `platform/apps/runner/CLAUDE.md`) |
| 0.14 | 2026-10-29 | Claude (task U07) | R085b: the routes a session may write to since U07 and U08; the step-up test |
| 0.15 | 2026-10-29 | Claude (task V16) | New row R143 (`pnpm server:setup`, `platform/deploy/CLAUDE.md`); R081c and R081e point at the shared steps `platform/deploy/steps` |
| 0.16 | 2026-10-29 | Claude (task U08) | R085b: the spec link, plan submission and Evidence Pack build of U08; the U08 database test |
| 0.17 | 2026-10-29 | Claude (CLI rename, ADR-M100) | R035: the hook refuses `pnpm adlc ops bootstrap\|token` and the bare `adlc`/`sdlc` binaries as it refuses `pnpm sdlc …` |
| 0.18 | 2026-10-30 | Claude (task O03) | New row R144 (`pnpm alerts`, `platform/deploy/CLAUDE.md`) |
| 0.19 | 2026-10-31 | Claude (task O04) | New row R145 (housekeeping of the session tables, `platform/packages/core/CLAUDE.md`) |
| 0.20 | 2026-10-31 | Claude (ADR-M104) | New row R146 (Upgrade notes under [Unreleased]); R040: the tag comes from `release-tag.yml` after Harry's merge |
| 0.21 | 2026-11-10 | Claude (task H07) | New row R147 (Docker AuthZ plugin, `platform/deploy/CLAUDE.md`) |
| 0.22 | 2026-11-11 | Claude (task L01, PR 2) | New row R148 (vLLM on a separate GPU host, `platform/deploy/CLAUDE.md`); R137: `vllm-link` of `models-remote` may be on `models` instead of `vllm` |
| 0.23 | 2026-11-11 | Claude (task H07) | R147: the operator header skips the denylist, never the runner (QUESTIONS #661) |
| 0.24 | 2026-11-12 | Claude (task V18) | New row R149 (the runner host set-up, `platform/deploy/CLAUDE.md`); the hook refuses `runner-host-setup.sh` |
| 0.25 | 2026-11-12 | Claude (task U09, PR 1) | R085, R085b: the administration changes of U09 take a session write, always with the passkey step-up; the U09 database test |
