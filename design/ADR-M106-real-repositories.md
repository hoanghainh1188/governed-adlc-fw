# ADR-M106. Real repositories: very large trees and repositories without CI (O06)

| Item | Value |
|---|---|
| Status | **Accepted** for §2.1–§2.3 (Harry, 2026-11-12, in the O06 plan; QUESTIONS #676). §2.4 (monorepos) decided in principle (Harry, 2026-11-12, QUESTIONS #677); its detail and the D-05 change come in version 1.1 |
| Date | 2026-11-12 |
| Decided by | Harry (O06 plan, PR 1, approved on 2026-11-12) |
| Related | D-08 O06 AC1–AC3; D-02 NFR-05; ADR-M34 §2.4 (instruction files); ADR-M38 §2.7 (how G6 reads CI); QUESTIONS #126, #159, #440, #676–#678; handbook Ch.13 §13.10.2a, Ch.14 §14.10.3 |

## 1. Context

The platform was built and tested on the pilot repository: small, with CI and one `AGENTS.md`. A real repository can be different (QUESTIONS #440):

- **Very large trees.** G4 lists every path of the start commit to find agent instruction files (ADR-M34 §2.4). The GitHub adapter made one call to the Git trees API with `recursive=1`. GitHub cuts that answer short for a large tree (about 100 000 entries or 7 MB, `truncated: true`). G4 then refused the run with `tree_truncated`, so a large repository could never run an agent.
- **No CI.** G6 counted "no check at all" as pending. The intent waited for the whole CI timeout (60 minutes by default), and the escalation said `ci_timeout`, which does not tell the people that the repository has no CI.
- **No `AGENTS.md`.** G4 already refuses with `instructions_missing`, but the handbook had no onboarding steps.
- **Monorepos.** One project has one repository (`projects.repo_full_name`), and a nested `AGENTS.md` blocks G4 (ADR-M34 §2.4).

## 2. Decision

### 2.1. A large tree is listed in parts (AC1)

`listPaths` of the GitHub adapter (`git-github/src/tree.ts`):

1. Lists the tree with `recursive=1`. Not cut: done.
2. Cut: the cut answer is never used. The adapter lists the same tree **without** `recursive` (its direct entries), keeps the files, and lists each sub-tree by its own SHA, again with `recursive=1` first.
3. Only a sub-tree that is still cut is split again.
4. A limit of requests for one commit: `maxTreeRequests` (adapter option, default 200, 1–5000). Past it, and for a folder that GitHub cuts even without `recursive` (a folder with too many direct entries), `listPaths` fails closed with `tree_truncated`, as before.

Each entry is checked: a type of `blob`, `commit` or `tree`; a sub-tree has a valid SHA; a folder name from a listing without `recursive` is one segment, never `.` or `..`. Paths are never logged.

The interface `GitHostAdapter.listPaths` does not change (NFR-05): a later Git host adapter makes its own choice. The knowledge indexer (X04) uses the same call and gets the same benefit.

Why not "check only the instruction paths": a nested `AGENTS.md` can be in any folder, so the full list is needed anyway. Why not the GitHub search API: it is not exact and has its own limits.

### 2.2. No check at all is `missing` (AC3)

`evaluateChecks` returns the CI state `missing` when the pushed commit has **no check of any name**. A commit with checks, but not the names in `verification.required_checks`, stays `pending` (the names are wrong, not the CI).

G6 (`g6-verify.ts`, row 4b of ADR-M38 §2.7):

- waits with the new reason `ci_missing` (an `IntentWaitReason`, with its catalog label, `api-schemas` map and the `adlc next` rule `setup_ci`, which points to handbook Ch.14 §14.10.3);
- after the shorter of the new project setting `verification.ci_missing_minutes` (default 15, at most 1440) and `verification.ci_timeout_minutes`, from the same clock start as the timeout, pauses the intent with a `technical` escalation. The audit `gate.g6_check_failed` names the check `ci_missing`; the packet's reason code stays `ci_failed`, so `resume` stays at G6 and reads CI again, as after a timeout;
- uses no CI retry.

A check that appears before the limit turns the state into `pending` or a result, and G6 goes on as before. The run event `ci_checked` gains the value `missing` for its `state` code; no new field.

### 2.3. Onboarding steps (AC3)

Handbook Ch.13 §13.10.2a lists what a repository needs before its first intent (`AGENTS.md` registered with the agent, no other instruction file, CI on pull requests), with the refusal each missing point causes. Ch.14 §14.10.3 gives the steps for a repository without CI.

### 2.4. Monorepos (AC2): decided in principle

Harry decided the approach on 2026-11-12 (QUESTIONS #677): several projects on one repository, each with its folder (`projects.repo_path`); the agent works in that folder; G4 checks the instruction files inside it; G5 fails a change outside it; one poll per repository. The agent register pins two files for such a project: the repository root's instruction file (if any) and `<repo_path>/AGENTS.md` (QUESTIONS #678; OpenHands 1.48.0 also reads the repository root's files from a sub-folder). The detail and the D-05 change come in a design PR (version 1.1 of this ADR), after a check of how OpenHands 1.48 loads its skills. Until O06 PR 2: one project per repository, and a nested `AGENTS.md` blocks G4 (ADR-M34 §2.4).

## 3. Consequences

- The default project configuration gains `verification.ci_missing_minutes`, so the default `config_hash` changes (upgrade note).
- A large repository costs more GitHub API calls at G4 (at most `maxTreeRequests`); the rate limit is shared with the poller.
- An intent on a repository without CI is paused after 15 minutes instead of 60, with a clear cause.

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 1.0 | 2026-11-12 | Claude (task O06 PR 1) | §2.1–§2.3 accepted with the O06 plan; §2.4 decided in principle (QUESTIONS #677), detail in 1.1 |
