# Chapter 14. P4 — Testing (G6)

> Readers: **testers, developers, Person B** · Reading time: about 15 minutes
> Status: **Draft 0.2**, awaiting Harry's comments.
> Section 14.10 (platform usage) is written by Claude Code together with the platform code.

---

## 14.1. Purpose

- Get **independent evidence** that the change does what the specification says, and nothing harmful.
- Never rely on the producing agent checking its own work.

## 14.2. Scope

From the agent's pull request (end of P3) until G6 passes.

---

## 14.3. Principles

1. **Independent verification.** Tests, scans and validators run separately from the producing agent. A validator never edits what it checks; the producer never edits a validator's verdict.
2. **Machines first, people last.** Deterministic checks (format, lint, types, tests, scans) run before any AI reviewer or human reviewer.
3. **Tests check the business behaviour**, not only that code runs. Every acceptance criterion has at least one test.
4. **Evidence is tied to the exact commit.** A result for another commit is not evidence.
5. **No fake passes.** Tests that are skipped, mocked away or weakened to pass are a failure, not a pass.

---

## 14.4. Roles

| Role | In P4 |
|---|---|
| Test / security validator agents | Run independent tests and scans; generate additional test cases; report verdicts |
| CI | Runs the deterministic checks; stores results |
| Tester (QA) | Designs the test strategy for Medium+ risk; reviews failures; owns the test plan |
| Person B | Judges critical evidence (G6 for High+ risk); accepts or rejects residual risk |
| Person A | Fixes or sends back failures; decides on rework |

---

## 14.5. Steps

### Step 1 — Plan the tests (Medium risk and above)

- From the specification: one or more tests per acceptance criterion; negative and edge cases; non-functional checks where the spec requires them.
- Agents may generate test cases and **fake test data**. Never use real client personal data (Chapter 2).

### Step 2 — Run the checks

| Group | Checks |
|---|---|
| Deterministic | Format, lint, compile / type check, unit, integration, contract and end-to-end tests, migration dry-run |
| Security | Static analysis, dependency vulnerabilities, secret scanning, licence scanning, container and infrastructure-as-code scans, authorisation tests |
| Behaviour against the spec | Coverage of acceptance criteria; spec–code drift; API compatibility; architecture rules; business invariants |
| Operational (when the spec requires) | Performance, load, resilience, retries, timeouts, observability, rollback |
| Agent behaviour | Did the agent stay in scope? Did it add unexpected dependencies? Are its assumptions acceptable? |

Choose the depth by risk: Low risk needs the deterministic and security groups; higher risk adds the others.

### Step 3 — Gate G6: independent verification

**Pass** when:
- all required checks pass;
- no critical finding (security findings at or above the configured severity go to HITL at any risk tier; default HIGH, and CRITICAL always);
- the evidence is tied to the right commit;
- every acceptance criterion traces to a passing test;
- no test result was faked or weakened by the agent;
- any remaining failure is accepted by a named owner, with a reason.

| On failure | Response |
|---|---|
| Fails, retries left | Back to the agent (P3) with the failure details |
| Fails, no retries left | Back to G3 (plan) or G2 (spec) — the problem is probably not the code |
| Critical security finding | Block; Person B and the security owner decide; no majority override |
| Validator and producer disagree | Freeze; Person B decides (Chapter 5 §5.6) |

- Oversight: Low → automated + AUDIT (sampled review); Medium → automated + HOTL; High and Critical → automated + **HITL by Person B**.

---

## 14.6. Mandatory artifacts

| Artifact | Content |
|---|---|
| Test report | Results per acceptance criterion; coverage; failures and their resolution |
| Security report | Scanner results with severity; accepted findings with owner and reason |
| Verification summary | For the pull request: what was checked, on which commit, what is left and who accepted it |

These become part of the **evidence pack** for the task.

---

## 14.7. Inputs and outputs

| Inputs | Outputs |
|---|---|
| Pull request and diff; approved spec and acceptance criteria; ADR and architecture rules; test plan; security policy; run record | G6 decision; test and security reports; verification summary |

---

## 14.8. Approval points

| Gate | Low | Medium | High | Critical |
|---|---|---|---|---|
| G6 | Automated + AUDIT | Automated + HOTL | Automated + HITL (Person B) | Automated + HITL (Person B) |

Security findings at or above the configured severity (default **HIGH**; **CRITICAL always**, not configurable): HITL at every tier. Lower-severity findings are kept as evidence and G6 keeps the mode above. A higher threshold rarely helps: if every PR waits for a person, reviews turn into rubber-stamping (Chapter 19).

---

## 14.9. Tools

| Need | Tool |
|---|---|
| CI | GitHub Actions (or the client's CI) |
| Secrets | Gitleaks or equivalent |
| Code issues | Semgrep or CodeQL |
| Dependencies and containers | Trivy or equivalent |
| Test generation, test data | Approved AI tools / validator agents, fake data only |

---

## 14.10. Using the platform

> Written by Claude Code together with the platform code (task C08, `design/ADR-M38-gate-g6.md`).

### 14.10.1. The push and the pull request

When the platform passed G5 (Chapter 13 §13.10.5), the intent waits at **G6**. The platform then puts the agent's changes into a pull request by itself:

1. **It waits for the G5 block window.** While Person A can still send the changes back at G5, nothing leaves the platform.
2. **It pushes the checked changes.** G5 already scanned the lines the run added for secrets (Chapter 13 §13.10.5a): a change with a secret never gets this far. The agent in its sandbox has no access to GitHub. The platform's runner takes the diff that G5 checked (never what the agent reports), makes **one commit** from it on the run's start commit, and pushes it to the branch `agent/INT-…`. The commit's author is `sdlc-agent`. The runner never pushes to the default branch, and never force-pushes; branch protection on the default branch also refuses it.
3. **It opens the pull request** from `agent/INT-…` into the default branch, or uses the open one, and posts a comment on the intent's issue: **the pull request is open**. The comment mentions Person B.

The pull request follows template T2:

- The description holds codes only: the intent code (with a link to its issue), the run ID, the agent, its version and model, the autonomy level, and the hashes of the approved plan and of the checked diff. It never holds the intent's title or description, file paths, or text from the agent: in a public repository everybody can read it.
- "AI wrote most / all of this change" is ticked, and so is "Only files in the approved plan were changed" (G5 checked it). The box "A human reviewed every file" is **never** ticked by the platform: the reviewer ticks it when approving (T2 rule).
- The author of the pull request is the platform's GitHub App, so Person B can approve it.
- Decide gates in comments on the intent's **issue**, not on the pull request.

**Later runs of the same intent** (for example after a request for changes) start from the commit the platform pushed, and push to the same branch: the same pull request shows the new commit.

**When the platform cannot push or open the pull request**, it tries again after a minute, up to three times in all. It stops at once when:

| Cause | Meaning |
|---|---|
| `empty_diff` | The run changed nothing |
| `diff_mismatch` | The stored diff is not the one G5 checked |
| `branch_moved` | Someone else changed the branch `agent/INT-…` |
| `publish_attempts` | Three attempts failed (GitHub, the runner, the token, or the pull request kept showing another commit) |

The intent is then **paused** at G6, and a **technical** escalation goes to Person B (Chapter 18). Acknowledge it, then decide:

| Decision | What happens |
|---|---|
| `resume` | The intent goes back to **G4**, and a new run starts after G4. After `branch_moved`, first restore the branch to the platform's last commit, or delete it |
| `modify` or `roll-back` | The intent goes back to **G3**, which is HITL from now on |
| `terminate` | The intent is closed (`cancelled`). Close the pull request if one is open |

**Platform operator:** the GitHub App needs Contents and Pull requests "Read and write" ([`platform/deploy/README.md`](../../platform/deploy/README.md#github-app-permissions)), and the runner's evidence identity must be created again once after this update (runbook T11 §5g step 3b).

### 14.10.2. How G6 reads CI

When the pull request is open, the platform reads its CI by itself. It reads the checks again whenever a check finishes (GitHub is read about every 30 seconds), and at least every 10 minutes.

**Which checks count.** The project setting `verification.required_checks` names the checks G6 waits for. Empty (the default) means every check on the pushed commit. A project with one summary check names it; the pilot repository uses `[ci-ok]`.

| Check result | Counts as |
|---|---|
| success, neutral, skipped | passed |
| failure, error, timed out | failed |
| still running, cancelled, stale, action required, a required check that is missing | pending (a person can run a check again) |
| no check at all on the pushed commit | missing: the repository may have no CI (§14.10.3) |

A project without CI never passes G6.

**What happens next:**

| CI… | What the platform does |
|---|---|
| failed, retries left | G6 fails (`ci_failed`). The intent goes back to **G4**; a new run starts **on top of the pushed commit**, and the agent is told that CI failed and to fix the checks. The same pull request gets the new commit. Retries: `run.g6_ci_retries` (2 by default), counted since the last G3 approval |
| failed, no retry left | G6 fails. The intent goes back to **G3**, which is HITL at every risk tier from now on. Check the plan and the spec: the problem is probably not the code |
| still pending after `verification.ci_timeout_minutes` (60 by default) | The intent is **paused** at G6, and a **technical** escalation goes to Person B. No retry is used. `resume` lets G6 read CI again, with a new timeout |
| missing (no check at all) after `verification.ci_missing_minutes` (15 by default) | The same as a timeout, with the cause `ci_missing` (§14.10.3) |
| passed | The platform checks the security findings (below), then decides G6 by the risk tier: Low (AUDIT) and Medium (HOTL) the platform passes G6 and the intent moves to **G7**; Person B is told and can still send it back with `/request-changes G6 <reason>` within the block window (a new run after G4). High and Critical (HITL): Person B approves with `/approve G6` |

**Security findings.** The platform reads the open GitHub code-scanning alerts of the pull request, counts them per severity, and stores only the counts.

- A finding at or above the configured severity (`oversight.g6_security_findings.min_severity`, HIGH by default; CRITICAL always) makes G6 **HITL** at every risk tier: Person B approves with `/approve G6` (§14.8).
- A **critical** finding pauses the intent with a **security** escalation to Person B. `resume` takes the intent back to G6, where Person B still has to approve.
- If GitHub cannot report findings (code scanning is not enabled, or the App may not read it), G6 is **HITL** every time. GitHub code scanning is free for public repositories only; on a private repository without GitHub Advanced Security, plan for Person B to approve every G6. The project's CI must upload its scanner results (SARIF) for the counts to exist.

**Dependency findings (task H02, ADR-M96).** The runner scans the staged manifest and lockfiles (`package.json`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`) outside the sandbox before pushing:
- Checks added or changed dependencies against allowed SPDX licenses (`dependencies.allowed_licenses`).
- Checks for install scripts (`preinstall`, `install`, `postinstall`, or lockfile flags like `requiresBuild: true`).
- Checks for typosquatting against popular packages using Levenshtein distance.
- Checks against blocked packages (`dependencies.blocked_packages`).

If any unapproved licenses, install scripts, or typosquatting warnings are detected, G6 is forced to **HITL** with reason `dependency_finding`. If any blocked package advisory finding is detected, G6 is paused with a **security** escalation to Person B.

**The pull request changes.** If someone closes or merges the pull request, or pushes another commit to the agent branch, G6 stops: the intent is **paused** with a **technical** escalation (§14.10.1 shows the decisions).

**Who approves.** Person B, never the person who allowed the run at G4 (the producer). Decide with `/approve G6`, `/reject G6 <reason>` or `/request-changes G6 <reason>` on the intent's issue (Chapter 19 §19.8).

**Platform operator:** for the security counts the GitHub App needs "Code scanning alerts: Read-only" ([`platform/deploy/README.md`](../../platform/deploy/README.md#github-app-permissions)).

---

### 14.10.3. A repository without CI

G6 needs independent evidence, so it never passes without CI. When the pushed commit has no check at all, the intent waits with the reason `ci_missing`, and `adlc next` says that the repository has no CI. After `verification.ci_missing_minutes` (15 by default; never longer than the CI timeout) the intent is **paused** with a **technical** escalation and the cause `ci_missing`.

To go on:

1. Add a CI workflow that runs on pull requests to the default branch: at least the build and the tests. On GitHub, this is a file under `.github/workflows/`.
2. Optional: make one summary job (for example `ci-ok`) and name it in `verification.required_checks`, so that G6 waits for exactly that check.
3. Merge the workflow into the default branch.
4. Decide the escalation (§14.10.1 shows the decisions):
   - `roll-back`: the intent goes back to **G3** (HITL from now on). After G3 and G4 a new run pushes to the same pull request, and that push starts the new CI.
   - `resume`: G6 only reads CI again, with a new timeout. Use it when the pull request's head commit already has checks (for example a person started them).
   - Do not close the pull request or push to the branch `agent/INT-…` yourself: G6 would stop with `pr_closed` or `branch_moved`.

The next intents of the repository get CI on their pull requests from the start.

If the commit has checks but none of the names in `verification.required_checks`, the intent waits as `ci_pending`, not `ci_missing`: fix the names.

## 14.11. Metrics

- First-pass qualification (Chapter 8 §8.5).
- Defect escape rate; change failure rate.
- Acceptance criteria without a test (target: zero).
- Critical findings released (target: zero).
- Retries per task before G6 passes.

---

## 14.12. Risks and mitigations

| Risk | Mitigation |
|---|---|
| The agent writes tests that confirm its own mistakes | Tests derived from the spec, not from the code; independent validators; tester review for Medium+ |
| Tests weakened or skipped to go green | Diff review of test changes; rule 14.3 (5) |
| Evidence from a different commit | Evidence bound to the commit; checked at G7 |
| Slow pipelines as agent output grows | Run affected tests first; deterministic checks before AI review |

---

## 14.13. References

**Related documents**
- Handbook: codes table §4; Chapters 2, 5, 8, 11, 13, 15, 17.
- `design/D-02` (G6 requirements), `design/D-09` (sample repo CI).

---

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.0 | 2026-09-24 | — | Skeleton |
| 0.1 | 2026-09-24 | Claude (draft) | First content; platform usage section reserved for Claude Code |
| 0.2 | 2026-09-25 | Claude (draft) | G6 security findings: configurable severity threshold, default HIGH, CRITICAL always (QUESTIONS #19) |
| 0.3 | 2026-10-03 | Claude Code (task C08, PR 1) | §14.10.1: the push and the pull request (ADR-M38 §2.1–§2.6, QUESTIONS #155, #156) |
| 0.4 | 2026-10-03 | Claude Code (task C08, PR 2) | §14.10.2: how G6 reads CI, retries, the timeout, security findings (ADR-M38 §2.7, QUESTIONS #157–#159) |
| 0.6 | 2026-10-09 | Claude (docs review fixes) | `roll-back` is the decision's spelling (the CLI refuses `roll_back`) |
| 0.7 | 2026-10-24 | Claude (task H04) | §14.10.1: the push comes after the secret scan of G5 (Chapter 13 §13.10.5a, ADR-M93) |
| 0.9 | 2026-11-12 | Claude (task O06) | §14.10.2: no check at all is `missing`, with `verification.ci_missing_minutes`; new §14.10.3: a repository without CI (ADR-M106) |
| 0.8 | 2026-10-27 | Claude Code (task H02) | §14.10.2: dependency scanning outside the sandbox (ADR-M96, QUESTIONS #606–#608) |
| 0.5 | 2026-10-09 | Claude Code (docs review PR C) | §14.10.1, §14.10.2: the GitHub App permissions link to the one list in `platform/deploy/README.md` |
