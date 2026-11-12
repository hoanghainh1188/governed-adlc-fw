# ADR-M34. Gate G5: the run's changes, the budget during the run, and the G5 decision

| Item | Value |
|---|---|
| Status | **Accepted** (Harry, 2026-10-16; built by task C07) |
| Date | 2026-10-03 |
| Decided by | Harry (plan approved 2026-09-28: two PRs, QUESTIONS #130–#134 with conditions; the PR 1 step-1 adjustments approved 2026-10-03, with two conditions: re-read the spend after an agent error before choosing `stopped_budget` or `failed`, and record the exact cause of a G4 refusal in the audit event; the PR 2 adjustments and decisions A–C approved 2026-10-03) |
| Related | D-02 FR-11, FR-13, FR-17, FR-18, FR-32, FR-50…FR-52; D-03 sections 6, 7.1, 7.4 (version 1.16); D-05 sections 5, 6.2, 6.4, 6.6 (version 1.20); handbook Ch.13 §13.10.5, Ch.18 §18.8b; D-08 tasks C07, C08, C09, E02, E05; D-09 N1, N3; handbook Ch.13, Ch.20 §20.9; ADR-M24, ADR-M25, ADR-M28, ADR-M29 §2.5, ADR-M31 §2.5, ADR-M33 §2.4, §2.6–§2.9; QUESTIONS #14, #21, #82, #126, #130–#134 |

## 1. Context

G5 checks scope drift and budget while and after the agent works (codes table §4, D-02 FR-13, FR-52, D-09 N1 and N3). C06 ends every run that succeeded or stopped at a cap in `in_gate G5`, and leaves the decision to C07.

Three facts shape the design:

- What the sandbox reports is untrusted (ADR-M29 §2.5). C06 session 2b built a safe way to read a sandbox's workspace and compute its diff outside the sandbox (ADR-M33 §2.9). G5 reuses it.
- The agent can change its own instructions through the repository: OpenHands 1.48.0 reads more files than the one the register pins (QUESTIONS #126).
- LiteLLM refuses calls past a key's cap, but it records spend late and can be one call over (QUESTIONS #14). A run that hits its budget can therefore end as an agent error.

C07 has two pull requests:

- **PR 1** (merged): the runner keeps its clone for every run, stores the diff of every run that goes to G5, checks it against the plan and the agent instruction paths, and watches the budget during the run. G4 refuses a run when the base commit holds an unpinned instruction file. `GitHostAdapter.listPaths`, migration 0013.
- **PR 2** (version 0.2): the G5 workflow step (`workflow/g5.ts`, §2.8): oversight from the matrix, the outcome table, escalations, the decisions on them and `resume` with a budget increase (§2.9), the budget warning during the run, migration 0015, handbook Ch.13 §13.10.5 and Ch.18 §18.8b.

## 2. Decision

### 2.1. One snapshot at the end of the run (QUESTIONS #130 A)

The runner checks the changes once, at the end of the run, from one consistent snapshot of the workspace. It does not read the workspace while the agent works. The budget is the only check during the run (§2.6).

### 2.2. The diff of every run that goes to G5

- `provisionRun` keeps the runner's own clone for every run (until C06 2b: L1 runs only). The token was only in git's environment; the clone's `.git/config` never holds it (test). The runner removes the clone when it releases the run.
- After the agent stops, for every run whose status goes to G5 (`succeeded`, `stopped_budget`, `stopped_scope`, `stopped_timeout`, `stopped_stalled`), the runner computes the changes with `computeRunPatch`: `exportWorkspace` → `mirrorWorkspace` → hardened `git add -A -f` and `git diff --binary` against `base_sha` (ADR-M33 §2.9, the same code as the L1 proposal). Committed and uncommitted edits count alike: a stopped run's edits are kept as evidence (D-08 C07 note).
- The diff is stored through `EvidenceStore` at `s3://evidence/diffs/<tenant>/<intent>/<run>.patch` (`If-None-Match: *`, never overwritten), with an `evidence_items` row (kind `diff`, which exists since migration 0012) and the run event `diff_stored` (hash, size, count).
- The runner's SeaweedFS identity `runner-evidence` gets a second action: `Write:evidence/proposals/*,Write:evidence/diffs/*` (`openbao:bootstrap runner-evidence-credentials`). The runner uses one credential with two stores (key prefixes `proposals/` and `diffs/`). An identity made before C07 must be made again once (runbook T11 §5g step 3b).
- **Fail closed.** If the changes cannot be computed or stored (no evidence store, export too large, git error, store refused), the run ends `failed` with `stop_reason` `agent_changes_unavailable`, and takes the failed-run path of ADR-M33 §2.7 (paused, `technical` escalation). No run reaches G5 without its checked changes. The stop reason follows the convention of `agent_proposal_failed`.
- A run killed at the time cap (the agent did not stop in the grace period) still has its container until the runner releases it, so its workspace can be read. The agent may still write while the archive is read; an inconsistent archive fails the export, which fails the run as above. The runner does not stop the container first: that would need another Docker endpoint in the guard.

### 2.3. The check of the changed paths

The runner checks the changed paths of the diff (never the paths the sandbox reports):

- **Scope:** `PolicyEngine.checkScope` with the contract's `planned_files` (the plan G3 approved). The runner builds the project's policy engine from the effective configuration (`loadEffectiveConfig`, `createSimplePolicyEngine`), as the worker does.
- **Instruction files:** `isAgentInstructionPath` (§2.4), the pinned file included: editing `AGENTS.md` changes the agent (Ch.20 §20.9).
- The run event `changes_checked` holds counts only: `changed_files`, `out_of_scope`, `instruction_files`, and `paths_sha256` = the SHA-256 of the RFC 8785 JSON of the sorted paths (for an array of strings, exactly `JSON.stringify`). The paths are client data and never enter the database. G5 (PR 2) binds its decision to `paths_sha256` and the diff hash.

The runner records; G5 decides. The order of the G5 checks (PR 2) is: instruction files, scope, caps.

Blind spot: paths the ignore rules of `base_sha` ignore (`node_modules`, build output) are read past (ADR-M33 §2.9), so they count neither as changed nor as out of scope, and they are not in the diff. An instruction file the agent adds under an ignored folder is therefore not seen; OpenHands reads instruction files from the paths of §2.4 only, which a `.gitignore` at `base_sha` rarely covers.

### 2.4. Agent instruction files (QUESTIONS #126 A)

- `isAgentInstructionPath` (`@sdlc/contracts`) follows OpenHands 1.48.0 (`load_project_skills`): at the root `AGENTS.md`, `agent.md`, `CLAUDE.md`, `GEMINI.md`, `.cursorrules`; `AGENTS.md` in any folder; every file under `.agents/skills/`, `.openhands/skills/` and `.openhands/microagents/`. Paths are compared folded (NFC, zero-width and bidi characters removed, lower case), like `.git` in the runner: a case-insensitive file system could see `Agents.MD` as the pinned file. When the agent's version changes, this list must be checked again against its source.
- **G4** (C06 check 6, after the agent register): `gatherG4Facts` reads every path at `base_sha` with the new `GitHostAdapter.listPaths(ref, sha)` (GitHub: one recursive call to the Git trees API). Any instruction path other than the exact pinned path (`unpinnedInstructionPaths`; a second spelling such as `agents.md` next to `AGENTS.md` is another file in Git) fails G4 with the reason code `instructions_unpinned`. The audit event `gate.g4_check_failed` records the exact cause: `instructions_unpinned` or `tree_truncated`. The failure's subject is the SHA-256 of the sorted paths, so a new set of files is a new failure, and the paths are never stored.
- **Truncated trees fail closed.** GitHub lists a commit's tree only in part for very large repositories (`truncated: true`). The adapter then throws `tree_truncated`, and G4 refuses the run with `instructions_unpinned` (cause `tree_truncated`): the platform cannot prove there is no unpinned file. Very large repositories cannot run an agent for now; a paged tree walk can lift this later.
- **G5** (PR 2): a run whose `changes_checked` counts an instruction file fails G5 with `instructions_unpinned`: a `security` escalation, the intent paused at G5 (QUESTIONS #132).

### 2.5. The run event `key_issued`

`prepareRun` records the run event `key_issued` when the Cost Controller issued the run's key: `max_budget_usd` (the key's cap) and `limited_by` (`run`, `intent` or `tenant`: the budget whose remainder set the cap, ADR-M24). Run events gain the value kind `decimal`: an amount in USD as a decimal string with at most 6 decimals, never a float (D-05 D6). The key and its ID never enter run events.

### 2.6. The budget during the run (D-08 C07 AC2, FR-52)

- The runner reads the spend of the run's key **with the key itself**: `RunKeySpendReader` (`@sdlc/contracts`), `LiteLLMKeySpendReader` (`@sdlc/adapter-model-litellm`): `GET /key/info` with the run key as the bearer and no `key` parameter, so LiteLLM answers for the calling key. The runner never holds the master key. `pnpm test:litellm` proves a run key gets no information about another key (by its hash, by the key, or through `/key/list`), and that a revoked key reads nothing.
- **Finding (PR 1 live test):** LiteLLM v1.102.1 lets a key read another key's info (`/key/info?key=<hash or key>`: alias, cap, spend, labels with the tenant) when both keys have the same `user_id` (`_can_user_query_key_info`), and two keys without a `user_id` compare equal. Every run key, so also the agent in the sandbox, could read every other run key it could name, across tenants. Fix in the adapter: `createRunKey` gives each run key its own `user_id` = `run-<run_id>` (the key alias). With it, a run key reads only its own info; budgets, the team (tenant) cap and revocation by alias are unchanged (`pnpm test:litellm`). LiteLLM keeps one user row per run. Check this rule again whenever LiteLLM is upgraded.
- Every `SDLC_RUNNER_AGENT_SPEND_CHECK_SECONDS` (default 30) while the agent runs. Shares are of the key's cap, which is still the smallest of the run budget, what is left of the intent budget and what is left of the tenant's month (ADR-M24; QUESTIONS #133); the contract's `max_budget_usd` is used only when the gateway reports no cap.
  - At `budget.warn_percent` (default 80): the run event `budget_warning` (spend, cap, percent), once per run. The comment on the issue comes with G5 (PR 2, FR-52).
  - At `budget.stop_percent` (default 100): the runner stops the agent like at the time cap (interrupt, then kill; `agent_stopped` with reason `max_budget`). The run ends `stopped_budget` with `stop_reason` `max_budget` and goes to G5, which escalates (PR 2). The iteration cap stays `stopped_budget` / `max_iterations` (QUESTIONS #82).
- **An agent error may be a budget stop.** LiteLLM refuses calls past the cap and records spend late (QUESTIONS #14), so the agent can end with an error before the runner's next check. When the agent ends with an error, the runner reads the spend at once and, below the stop share, **once more** after `SDLC_RUNNER_AGENT_SPEND_RECHECK_SECONDS` (default 25, at most 60). Measured in `pnpm test:litellm`: LiteLLM refuses calls at once, but `/key/info` shows the spend only after its batch write (about 10 s, `proxy_batch_write_at`); `/key/info` itself still answers for a key over its cap. The default must stay above that interval; the live test fails when the lag exceeds 25 s (measured 10–13 s). At or above the stop share, the run ends `stopped_budget` / `max_budget` (G5, an `intent` escalation in PR 2), not `failed` (a `technical` escalation). The wait is bounded: one re-read only.
- A read that fails counts as unknown: the run goes on. The gateway's own cap stays the backstop. A warning that cannot be recorded never aborts the run.
- The runner checks the spend only while the agent works and after an agent error. A run that ends by itself (finished, stuck, iteration cap) between two checks keeps that status even if its spend reached the stop share: **G5 (PR 2) must read the run's spend again** (synced `cost_records` and the key) and never rely on the runner's status alone.
- Keys issued before this change have no `user_id` and can still read each other's info until they expire (at most the contract window plus the run's time cap); no rotation is needed beyond letting them expire.

### 2.8. The G5 step (PR 2; QUESTIONS #131, #132)

`stepG5` (core, `workflow/g5.ts`) runs when the intent waits `in_gate G5` after a run (`finishRun`, which revokes the key and syncs the spend first). It reads the run's result with `gatherG5Facts`: the run's status and stop reason, the runner's `diff_stored` and `changes_checked`, the key's cap (`key_issued`), the run's synced spend and the intent's synced spend.

- **The G5 input hash** = SHA-256 of the RFC 8785 JSON of: the run ID, the contract's `contract_sha256`, the run's status and stop reason, `diff_sha256`, `paths_sha256` and the intent's spend after the sync. Every G5 decision and the G5 escalation are bound to it (FR-17).
- **Oversight** from `policy.oversightMode(G5, risk)`: HOTL at Low and Medium, HOTL with `on_breach: HITL` at High (a breach goes to a person through the escalation), HITL at Critical (never reached: Critical never runs). A failed check is recorded with `context: { breached: true }`.
- **The checks, in order** (the first failure wins; each is recorded once as a system `fail` with its reason code, and the audit event `gate.g5_check_failed` holds the exact cause and the run ID):

| # | Check | Reason code (cause) | Next |
|---|---|---|---|
| 0 | The runner recorded the changes (never missing: the runner fails the run first, §2.2) | `input_mismatch` (`changes_missing`) | `paused`, `technical` escalation |
| 1 | No agent instruction file added, changed or removed (`instruction_files` = 0) | `instructions_unpinned` (`instructions_changed`) | `paused`, `security` escalation, trigger `risky_action` |
| 2 | No changed path outside the plan (`out_of_scope` = 0, and the run did not end `stopped_scope`) | `out_of_scope` (`out_of_scope`) | back to `in_gate G3`, no escalation |
| 3 | The cost cap: not `stopped_budget` / `max_budget`, and the run's synced spend below `budget.stop_percent` of the key's cap (§2.6: the runner may have missed it) | `budget_exceeded` (`max_budget`, `spend_at_stop`) | `paused`, `intent` escalation, trigger `accumulated_risk` |
| 4 | Not stopped at the iteration cap, the time cap, or as stalled | `run_cap_reached` (`max_iterations`, `max_duration`, `stalled`) | `paused`, `intent` escalation, trigger `accumulated_risk` |

- **The escalation** of a breach: severity and response level from the new configuration `run.g5_breach_escalation` (default `high` / `pause`); the new mandatory rule **M22** keeps its level at `pause`, `contain` or `incident`, so a breach always freezes the intent (QUESTIONS #21). Packet: `subject_kind` `g5_input` (new), `subject_sha256` = the G5 input hash, `gate` G5, the run, the agent and the reason code. The run's `triggered_by` (the G4 approver) is a producer: never owner, backup or decider (FR-18).
- **Back to G3** (N1, QUESTIONS #131): G3 is HITL at every tier from then on (`GateContext.returnedFromG5`, override `returned_from_g5` in `policy-simple`), the G3 approvals still in force are voided (`voidApprovals`, reason `out_of_scope`), and the plan the run went outside of is refused: `decideGate` answers `plan_refused` (409), and the step waits `new_plan_needed`. A new plan (another hash) is approved by a person.
- **Pass:** HOTL → a system `pass` and `in_gate G6` (notice `hotl_passed`). The HOTL block window applies to G5 (`PASSABLE_GATES`): within it, `/reject G5` closes the intent and `/request-changes G5` takes it back to G4 for a new run; C08 waits for the window before it acts at G6. HITL (a configuration) → a person approves `/approve G5`; the producer of the run never counts (FR-11). G5 is now a gate a person may decide by command (`DECIDABLE_GATES`). A HITL G5 has the gate deadline of ADR-M30 §2.9 (FR-12): past `oversight.hitl_gate_deadline` it raises one overdue escalation (trigger `time`, level `oversight.gate_overdue`, the run's producer excluded), closed when G5 is decided. B11's floor "a G5 escalation is at least `pause`" now applies to breaches only, not to this `time` escalation (QUESTIONS #21 is about breaches).
- **The budget warning** (FR-52, decision C): the runner records the run event `budget_warning` and the intent's notice `budget_warning` in one transaction (`recordBudgetWarning`), so the comment appears while the agent works. The notice holds codes; the comment reads the percent from the run event when it is posted.

### 2.9. The decision on a G5 escalation (QUESTIONS #133, #134; decisions A and B)

`stepPausedG5` acts on the decision of the run's G5 escalation, under the intent lock:

- **First, the binding:** when the current G5 input differs from the escalation's subject (for example a late spend sync), the decision is voided (`input_mismatch`), the escalation is closed, and the intent goes back to `in_gate G5`, where G5 is evaluated again and raises a new escalation bound to the new input. Without this, a decision could never match again.
- An escalation closed outside this step (for example by a person, with no decision acted on) is handled the same way: G5 is evaluated again and raises a new one, so a paused intent always has an escalation to decide.
- An invalid `budget_increase_usd` (the API refuses it already) is ignored by the step: no increase, never a blocked step. A compare-and-set that misses under the lock throws, so the step's decisions and escalations roll back.
- `resume` → `revalidateEscalationDecision(…, action: run_start)` (an expired decision is voided). Then, when the decision names `budget_increase` with `budget_increase_usd` X (API or CLI only; a comment never names it, ADR-M28 §2.7): `intents.budget_usd += X` and `intents.run_budget_usd` = the stopped run's contract cap + X (`raiseBudget`, audit `intent.budget_increased`). The escalation is closed and the intent goes back to `in_gate G4` (notice `run_resumed`). Names in `actions` replace the defaults, so a decision with more budget names `run_start` and `budget_increase`; one that names only `budget_increase` allows no run (`scope_mismatch`) and the intent keeps waiting.
- `modify` or `roll_back` (decision A) → back to `in_gate G3` (notice `g5_returned`): G3 is HITL from then on, the G3 approvals still in force are voided with the breach's reason code, and **the same plan may be approved** again by a person. The new-plan rule applies only after `out_of_scope`.
- `terminate` (decision B) → the intent ends `cancelled`, the escalation is closed (notice `terminated`).
- **The run cap:** G4 puts `run_budget_usd` (when set) into the run proposal, so a HITL G4 approves the new cap. The key's cap is still the smallest of the run budget, what is left of the intent budget and what is left of the tenant's month (ADR-M24); the Cost Controller is unchanged.
- **Budgets only go up:** migration 0015 adds `intents.run_budget_usd` (null: `budget.default_run_usd`), grants `platform_app` UPDATE on `budget_usd` and `run_budget_usd`, and a trigger refuses a lower value or a run budget back to null (SQLSTATE `SDA12`).
- **#134:** the new run starts after G4 from the head of the default branch, never from the stopped run's workspace; the stopped run's diff stays as evidence. Once C08 pushes `agent/INT-…`, the next run continues from that branch (D-08 C08 note).

### 2.7. Where the rules live

| Rule | Where |
|---|---|
| The instruction paths of OpenHands 1.48.0, folding | `@sdlc/contracts` `agent-instructions.ts` (design, not configuration) |
| Warning and stop shares | Project config `budget.warn_percent`, `budget.stop_percent` (existing) |
| Spend check interval, re-read wait | Runner settings `SDLC_RUNNER_AGENT_SPEND_CHECK_SECONDS`, `SDLC_RUNNER_AGENT_SPEND_RECHECK_SECONDS` (technical) |
| Fail closed (no diff → failed, truncated tree → refused) | Code (design) |
| The G5 check order, the outcome table, fail closed, budgets only up, the new-plan rule after `out_of_scope` | Code (design), §2.8–§2.9 |
| The G5 oversight per risk tier | Project config `oversight.matrix.G5` (existing) |
| The G5 escalation's severity and level (level ≥ `pause`, rule M22) | Project config `run.g5_breach_escalation` |

## 3. Alternatives considered

- **Check the scope during the run** (QUESTIONS #130 B): more Docker access while the agent runs and many partial snapshots; refused.
- **Remove the unpinned instruction files from the workspace** (QUESTIONS #126 B): a hidden change of the client's repository; refused.
- **Read the spend with the master key in the runner:** the runner would hold a key that can read and change every key; refused. The run key is enough.
- **Wait longer or poll after an agent error:** a bounded single re-read keeps the run's end fast; a budget stop that the re-read still misses ends `failed` and is reviewed by a person (ADR-M33 §2.7).
- **Page through truncated trees now:** more API calls and a new failure mode; the pilot repository is small. Refuse for now.

## 4. Consequences

- Every run now pays the export of its workspace at the end (C06 2b measured an L1 proposal of the pilot repository with `node_modules`, `pnpm test:proposal-pilot`). The limits `SDLC_RUNNER_EXPORT_MAX_MB` and `SDLC_RUNNER_WORKSPACE_MAX_MB` apply; a run over them fails (`agent_changes_unavailable`).
- The runner's disk holds one clone per active run until release.
- With PR 2, every run that ends at G5 is decided by the platform or escalated; nothing waits at G5 for C08.
- A late spend sync after G5 failed re-raises the G5 escalation (§2.9): people may see a second escalation for the same run. The sync in `finishRun` makes this rare.
- G3 stays HITL for the rest of an intent's life once G5 sent it back; this is stricter than the matrix and needs no configuration.
- The evidence identity can also delete under `diffs/` (SeaweedFS has no write-only action, ADR-M33 §2.9 gap 1); the bucket is versioned, and E02 re-checks the SHA-256 of each item.
- C08 recomputes changed files and `head_sha` from the pushed branch with the same code (D-08 C08 note).
- Very large repositories are refused at G4 (`tree_truncated`) until a paged tree walk exists. Version 0.4: the walk exists (ADR-M106 §2.1).
- `listPaths` is one more GitHub call each time G4 is evaluated (every wake and reconcile while an intent waits at G4), next to `getBranchHead` and `getFileAtCommit`. Cache by `base_sha` if API quota becomes a problem.
- The nested `AGENTS.md` rule follows OpenHands 1.48.0 (QUESTIONS #126): a monorepo with `AGENTS.md` files in sub-folders cannot run an agent until those files are pinned (a later agent register change) or removed. Version 0.4: a project with a `repo_path` checks only the files inside its folder and at the repository root, and its agent may pin the root file too (ADR-M106 §2.4).

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-10-03 | Claude (task C07, PR 1), approved by Harry | First version: §2.1–§2.7 for PR 1; PR 2 adds the G5 step |
| 0.2 | 2026-10-03 | Claude (task C07, PR 2), approved by Harry | §2.8 the G5 step, §2.9 the decision on a G5 escalation and the budget increase; §2.7, §4 updated (migration 0015, rule M22, SQLSTATE SDA12) |
| 0.3 | 2026-10-16 | Harry | Accepted (the design is built and merged; open items stay follow-ups) |
| 0.4 | 2026-11-12 | Claude Code (task O06), approved by Harry (QUESTIONS #676–#678) | §4: very large trees are listed in parts; the instruction files of a project with a `repo_path`; a change outside the folder fails G5 (ADR-M106) |
