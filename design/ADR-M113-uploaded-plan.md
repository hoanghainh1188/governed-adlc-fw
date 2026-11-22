# ADR-M113. Low-risk uploaded plans (`plan_source: uploaded`)

| Item | Value |
|---|---|
| Status | **Accepted** (Harry, 2026-11-22 — task U10, GitHub issue #559) |
| Date | 2026-11-22 |
| Relates to | ADR-M40 (plan submission), ADR-M48 (Evidence Pack), D-03 §6, QUESTIONS #230 |

## 1. Context

Under ADR-M40, every intent must merge `.sdlc/plans/<INT-…>.yaml` onto the protected default branch before G3 can pass. For small Low-risk tasks and bug fixes, opening and merging a dedicated pull request solely for the plan YAML file is the largest developer friction point (`QUESTIONS #230`).

## 2. Decision

Support two plan sources on `plans`:

1. **`plan_source: 'repo'` (existing default):** `.sdlc/plans/<INT-…>.yaml` on the head of the default branch (`commit_sha` set, `storage_uri` null). Always mandatory for `high` and `critical` risk tiers.
2. **`plan_source: 'uploaded'` (new, U10):** A person with a role in `access.plan_submit_roles` submits a local YAML file directly through the API/CLI without merging a plan PR to `main` first (`commit_sha` null, `storage_uri` set).

### 2.1. Risk tier enforcement
- Project config adds optional `oversight.uploaded_plan_risks` (allowed values: `'low'`, `'medium'`; defaults to `['low']` when omitted).
- Schema validation strictly forbids `'high'` and `'critical'` from `uploaded_plan_risks`. High and Critical intents always require `plan_source: 'repo'`.

### 2.2. Integrity, storage, and security invariants
- Uploaded plan bytes are validated with the exact same rules as repo plans (`PLAN_MAX_BYTES` = 64 KiB, valid UTF-8, `parsePlanFile(text, intent.code)`).
- Raw bytes are stored in SeaweedFS (`EvidenceStore`, never in plaintext PostgreSQL columns or logs) and bound to `plans.plan_sha256` and `plans.storage_uri`.
- Separation of duties (Rule M21) is unchanged: `submitted_by` is always recorded and the submitter can never approve G3, G7, or G8.
- File scope (`planned_files`), tool allow-lists (`allowed_tools`), and `change_flags` (forced HITL at G3, dual approval at G7) behave identically to repo-backed plans.
- On runner execution (PR 2), the runner reads the uploaded plan from `EvidenceStore` and verifies `sha256(bytes) === contract.plan_sha256` and `planned_files` before injecting tasks into the agent prompt (fail-closed on mismatch).

## 3. Rollout split
- **PR 1 (Core & Schema):** ADR-M113, `oversight.uploaded_plan_risks` config, migration `0062-uploaded-plans`, `PlanRepository` + `submitUploadedPlan`, Evidence Pack support, unit tests.
- **PR 2 (API, CLI, SeaweedFS IAM & Runner):** `POST /v1/intents/:intent/plans` (`plan_yaml`), `adlc plan submit <INT> --file <path>`, SeaweedFS `evidence/plans/*` permissions in `bootstrap.sh`, and runner `EvidenceStore` plan reader.
