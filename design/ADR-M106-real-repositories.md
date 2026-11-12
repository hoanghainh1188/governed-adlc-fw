# ADR-M106. Real repositories: very large trees and repositories without CI (O06)

| Item | Value |
|---|---|
| Status | **Accepted** for §2.1–§2.3 (Harry, 2026-11-12, in the O06 plan; QUESTIONS #676). §2.4 (monorepos) accepted in version 1.1 (Harry, 2026-11-12, QUESTIONS #677, #678) |
| Date | 2026-11-12 |
| Decided by | Harry (O06 plan, PR 1, approved on 2026-11-12) |
| Related | D-08 O06 AC1–AC3; D-02 NFR-05; D-03 §6 (Run Contract); D-05 §6.1 (`projects`, `agents`); ADR-M31 §2.5; ADR-M34 §2.4 (instruction files); ADR-M38 §2.7 (how G6 reads CI); QUESTIONS #126, #159, #440, #676–#678; handbook Ch.13 §13.10.2a, Ch.14 §14.10.3 |

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

### 2.4. Monorepos (AC2): several projects on one repository (version 1.1)

Decided by Harry on 2026-11-12 (QUESTIONS #677, #678). Built by O06 PR 2.

**The project's folder.** `projects.repo_path` (D-05 §6.1): the project's folder in the repository, empty for the whole repository. Rules:

- a relative path with `/`, without `.`, `..`, empty parts or a trailing `/`;
- unique per tenant, repository and folder; no active project's folder inside another's, and a project with an empty `repo_path` has its repository alone (the admin module checks it under a lock on the repository name);
- changes only while the project has no open intent;
- other tenants are never considered: two tenants on one repository stay apart, as today.

**What OpenHands reads** (`load_project_skills`, tag `v1.48.0`, checked on 2026-11-12). With `working_dir` = `<clone>/<repo_path>`:

| Source | Read |
|---|---|
| Root files (`AGENTS.md`, `agent.md`, `CLAUDE.md`, `GEMINI.md`, `.cursorrules`) and the skill folders (`.agents/skills/`, `.openhands/skills/`, `.openhands/microagents/`) of `working_dir` | yes |
| The same names at the Git repository root (the clone keeps `.git`) | yes |
| `AGENTS.md` in a folder below `working_dir` | yes |
| `AGENTS.md` in any other folder (other packages) | no |

**The agent works in the project's folder.** The Run Contract carries `repo_path` (D-03 §6); the runner gives the agent adapter `<clone>/<repo_path>` as its working folder. The whole repository stays in the sandbox (root build files, lock files), but G5 fails a run that adds, changes or removes a file outside `repo_path`, with the new check `outside_project_path` (no exception; a change to shared root files belongs to a project with an empty `repo_path`).

**Two pinned files** (ADR-M31 §2.5 version 0.6). The agent of such a project pins `<repo_path>/AGENTS.md` (or another root-file name of the folder) as `instructions_ref`, and may pin the repository root's instruction file as `root_instructions_ref`. G4:

- checks both against their registered SHA-256 (`instructions_mismatch`, `instructions_missing`);
- refuses any other instruction file (`instructions_unpinned`) that OpenHands would read: the root files and skill folders of the folder and of the repository root, and every `AGENTS.md` below the folder. Files in other packages' folders do not count;
- a project with an empty `repo_path` keeps today's rule (ADR-M34 §2.4).

G5 fails a run that adds, changes or removes either pinned file, as today for the one file.

**One poll per repository.** The worker groups a tenant's pollable projects by repository and reads GitHub once per group, from the oldest cursor of the group. Each project then handles the events in its own transaction, with its own cursor compare-and-set (D-05 `git_event_cursors` stays per project). An event belongs to the project whose intent has that issue or pull request; the others ignore it as today (`intent_not_linked` outcomes are not written for an event another project of the group handled).

**As built (version 1.2, O06 PR 2b).**

- The Run Contract of a project with a folder or an agent with a second pinned file has `schema_version` 4 (`repo_path`, `root_instructions_sha256`); every other contract stays schema 3, byte for byte, and the G4 proposal hash changes only for such a run.
- Only the OpenHands adapter sets its working folder per run (`working_dir` of the conversation). The OpenCode server works in the folder it was started in, so the runner refuses a contract with a folder for any other adapter (`folder_not_enforceable`, a new reject reason). Git commands and the report of the files the agent read keep the repository root.
- The runner's change check counts the changed paths outside the folder (`changes_checked.outside_folder`, absent when 0) and the folder's own instruction files; G5 fails with the check `outside_project_path` and the reason `out_of_scope` (back to G3, a new plan needed, as for `out_of_scope`).

**As built (version 1.3, O06 PR 2c, QUESTIONS #679).**

- The worker's poller loop groups the pollable projects by tenant and repository (`repo_full_name`, exact text) and polls a group with the shortest `github.poll_interval_seconds` of its projects. A project whose configuration cannot be read is logged and left out of that interval; the group waits only when no interval can be read.
- The core cannot read a cursor: the Git host interface gets `oldestEventCursor` (D-03 §7.1 version 1.54). It needs no call to the host. Per stream it takes the smallest lower bound, and keeps an item as seen only when every cursor counts it as handled. A cursor `''` (never polled) is left out. When all the cursors of the group are the same, the stored one is used as it is. A read may return an event again to a project that handled it: comment commands then find their receipt (`duplicate`); checks, reviews and closed pull requests only wake intents.
- A comment command goes to one project: the project with an open intent on its issue or pull request. With none, it goes to the first project of the group by ID, so a syntax, `user_not_linked` or `intent_not_linked` reply is posted once. With open intents in more than one project, the first of those projects replies `intent_ambiguous`, as for two intents in one project. Checks, reviews, closed pull requests and comments that are no command go to every project of the group.
- Each project stores the read's `next` with its own compare-and-set. A project whose handling fails keeps its cursor and the other projects go on; the next read starts from the oldest cursor, so the failed project misses nothing.

**CI per project.** `verification.required_checks` names the project's own checks (for example `ci-web`); handbook Ch.14 §14.10.2 says how to name jobs per package. G6 does not change.

**Out of scope.** The knowledge index (X04) and the evaluation task set (L07) keep reading the whole repository; a project's spec and plan paths stay relative to the repository root.

## 3. Consequences

- The default project configuration gains `verification.ci_missing_minutes`, so the default `config_hash` changes (upgrade note).
- A large repository costs more GitHub API calls at G4 (at most `maxTreeRequests`); the rate limit is shared with the poller.
- An intent on a repository without CI is paused after 15 minutes instead of 60, with a clear cause.
- Version 1.1: a monorepo package needs its own project and its own agent entry (one `instructions_ref` per agent row); a new column on `projects` and two on `agents`; the Run Contract gets a new schema version for `repo_path`.

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 1.3 | 2026-11-12 | Claude Code (task O06 PR 2c), approved by Harry (QUESTIONS #679) | §2.4 "As built": one read per repository with `oldestEventCursor` (D-03 1.54), where comment commands go, a failed project keeps its cursor |
| 1.2 | 2026-11-12 | Claude Code (task O06 PR 2b) | §2.4 "As built": schema 4, `folder_not_enforceable` for adapters other than OpenHands, `outside_folder` and `outside_project_path` |
| 1.1 | 2026-11-12 | Claude Code (task O06), approved by Harry (QUESTIONS #677, #678) | §2.4: several projects on one repository, each with its folder; what OpenHands 1.48.0 reads from a sub-folder; two pinned files; G5 `outside_project_path`; one poll per repository |
| 1.0 | 2026-11-12 | Claude (task O06 PR 1) | §2.1–§2.3 accepted with the O06 plan; §2.4 decided in principle (QUESTIONS #677), detail in 1.1 |
