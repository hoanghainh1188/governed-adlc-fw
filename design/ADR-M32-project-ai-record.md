# ADR-M32. Project AI record: codes only, version history, who writes it, the G1 check

| Item | Value |
|---|---|
| Status | **Accepted** (Harry, 2026-10-16; built by task B12) |
| Date | 2026-09-27 |
| Decided by | Harry (plan approved 2026-09-27: D1 = A, D2 = A, D3, D4 = C, D5 = A, D6 = A; no re-check before G1 → G2) |
| Related | D-02 §3, FR-03, FR-19, FR-43; D-03 sections 5.2, 6 ("submit (AI record checked)"); D-05 sections 5, 6.1, 6.2 (version 1.14); D-07 §4; D-08 tasks B04, B10 AC6, B12, B13, C06, E02, E03; handbook Ch.2 §2.3–§2.5, template T7; ADR-M18, ADR-M20, ADR-M26, ADR-M30, ADR-M31; QUESTIONS #89, #103–#106 |

## 1. Context

Handbook Chapter 2 asks every project to keep an **AI record**: whether the client allows AI use, the data classes allowed, whether AI may touch production logs, the disclosure format, and who confirmed it and when (§2.5, template T7). D-02 FR-19 makes G1 fail when the record is missing or does not allow the intent's data class, and says "unknown consent → `client_restricted`". A06 created the table `project_ai_records` (one row per project, compare-and-set on `version`) and its repository, which appends `ai_record.changed` with the version only.

Six points were open in the B12 plan:

- two columns of D-05 §6.1 are free text: `confirmed_by` (a client contact: personal data) and `allowed_tools_locations` (client conditions);
- an update replaces the row, so earlier versions were lost;
- D-02 §3 says PM / BrSE maintains the record; handbook §2.5 says Person A owns it; T7 says both fill it in;
- the direct-database CLI has no user login (the reason B11 moved its CLI to B04);
- what "unknown consent → `client_restricted`" does to an intent;
- what "G1 fails" does to the workflow (QUESTIONS #89 put the check at the Draft → G1 move).

## 2. Decision

### 2.1. Codes only (D1 = A, QUESTIONS #104)

- `confirmed_by` and `allowed_tools_locations` are dropped (migration `0010-ai-record`). There was no row outside tests.
- New `record_ref`: one `https://` link (at most 512 characters, same rule as `gate_decisions.reason_ref`) to the **human** AI record: T7's `docs/project/ai-record.md` in the project repository, or a document link. That record holds the client contact, the allowed tools and locations and the special conditions, where they can be edited or deleted.
- `confirmed_at` (a date) stays. **Consent is known only when `confirmed_at` is set**; a confirmed record needs `record_ref` (the written answer must be traceable). A confirmation date in the future is refused.
- Every stored column is now a code, a date, a link or an ID.

### 2.2. Record hash

- `record_sha256` = SHA-256 of the RFC 8785 canonical JSON of the coded record: `v` (1), `ai_allowed`, `allowed_data_classes` (canonical order), `prod_logs_allowed`, `disclosure_format`, `confirmed_at`, `record_ref`. Changing the field list needs a new `v`.
- `ai_record.changed` holds `version`, `record_sha256`, `ai_allowed`, `prod_logs_allowed`, `disclosure_format`, `consent` (`confirmed` / `unknown`) and `updated_by`. Never the link. The allowed classes are in the hash and in the history table.

### 2.3. Version history (D2 = A)

- The current row stays in `project_ai_records` (fast reads, compare-and-set).
- New append-only table `project_ai_record_versions` (codes only; `forbid_mutation` triggers; `SELECT, INSERT` for `platform_app`), kept like the other append-only tables.
- A trigger on `project_ai_records` appends each inserted or updated row to the history, so no save can skip it, and refuses a change that is not the next version.

### 2.4. Who writes it, and through what (D3, D4 = C, QUESTIONS #103)

- Who owns it (QUESTIONS #103, closed 2026-11-16): **Person A** owns the record and is accountable for it; PM / BrSE asks the client, keeps the written answer and fills the record with Person A (handbook Ch.2 §2.3, §2.5, template T7; D-02 §3 from version 1.12). Both roles write it by default; the audit event names who saved each version (`updated_by`).
- Config `access.ai_record_write_roles` (default `[person_a, pm_brse]`) and `access.ai_record_read_roles` (default the same list as `intent_read_roles`). Writers always read. **Mandatory rule M19**: `viewer` never writes the record.
- `saveAiRecord` (core) checks that the accountable person (`updatedBy`) is an active user with a write role (`not_a_writer`), then saves; a stale version is `version_conflict`.
- **API** (the path with a logged-in user): `GET` and `PUT /v1/projects/:project/ai-record`. No role on the project → 404 `project_not_found`; a read role only → 403 on `PUT`; a rule broken → 422 `ai_record_invalid` with the reason code; a stale `expected_version` → 409 `ai_record_version_conflict`; no record yet → 404 `ai_record_not_found`. After a save, the project's draft intents are woken (§2.5).
- **Operator command** (onboarding before B04 and B13): `sdlc admin ai-record set|show`, direct database access with `SDLC_DB_URL`, like `sdlc admin agent`. `--on-behalf-of <email>` names the accountable person, who must hold a write role; the audit event has actor `system` and that person in `updated_by`.
- **B04** adds `sdlc ai-record show|set` over the API (backlog 1.10, B04 AC5). B13 may retire the operator command once a tenant admin exists.

### 2.5. The G1 check (FR-19, D5 = A, D6 = A, QUESTIONS #105, #106)

- `checkAiRecordAtSubmit` (core) runs in the workflow's Draft → G1 move (`stepIntent`, QUESTIONS #89), under the intent lock, before the freeze check.
- It refuses with `ai_record_missing` when the project has no record, and `data_class_not_allowed` when the record does not allow the intent's data class after the fixed rules of §3.
- On a refusal:
  - the intent **stays `draft`** and the workflow waits (`waiting: ai_record`);
  - once per distinct cause, a system **`fail` decision at G1** with the reason code. Its `input_sha256` binds the intent's G1 input, the record hash (or none) and the reason, so waking again records nothing new, and a new record version that still refuses records one more;
  - one status notice `ai_record_refused` on the intent's issue (catalog `intent.status.ai_record_refused`), mentioning the write roles.
- The next wake after the record is fixed moves the intent Draft → G1. A `fail` recorded before the intent entered G1 never counts at G1 (ADR-M30 §2.4).
- **The platform never raises the intent's data class** (D5): with unknown consent, a `client_confidential` intent is refused; a person decides (get the written answer, or create the intent again as `client_restricted`).
- **No re-check before G1 → G2** (Harry): FR-19 requires the check at G1 and G4; C06 calls the same rule (`aiRecordRefusal`) before a run.

### 2.6. For later tasks

- AC3: `PolicyEngine.productionDataAccess({ aiRecord })` returns `masked` only when AI use is allowed, consent is confirmed and `prod_logs_allowed = yes_masked`; otherwise `none` (also without a record). No caller yet: operations tasks come after the MVP.
- C06 (G4): `loadAiRecordFacts` + `aiRecordRefusal(facts, intent.data_class)`.
- E02 and E03 (FR-43): the disclosure format through `loadAiRecordFacts` (`disclosureFormat`).

## 3. Rules and where they live

| Rule | Source | Where |
|---|---|---|
| Allowed classes, consent, production logs, disclosure format | Handbook §2.5, T7 (the client decides) | The project AI record (data) |
| Who writes and reads the record | D-02 §3, handbook §2.3, §2.5, T7 | Config `access.ai_record_*`; floor M19 |
| `prohibited` is never allowed | Ch.2 Rule 2, D-05 §5 | Code (`ai-record/rules.ts`) and a database CHECK |
| AI use `no` allows no `client_*` class | Ch.2 Rule 3 | Code and a database CHECK |
| Consent unknown → client data only as `client_restricted` | Ch.2 Rule 3 (Harry, 2026-09-24), FR-19 | Code and a database CHECK (on save); code again at G1 |
| A confirmed record links the written answer | Ch.2 Rule 3 ("in writing") | Code and a database CHECK |
| No record, or class not allowed → G1 fails | FR-19 | Code (`aiRecordRefusal`, `checkAiRecordAtSubmit`) |
| Production data only masked, only with confirmed consent | Ch.2 §2.5, T7 | Code (policy adapter), values from the record |

The fixed rules stay in code (Harry, B12 plan): they are the floor of handbook Chapter 2 for every project, not tunable values. Changing one needs an approved handbook change first (CLAUDE.md).

## 4. Alternatives considered

- **Keep the free-text columns** in the mutable row only (D1 B): no history of them, and personal data in the platform database. Refused.
- **No history table** (D2 B): the audit log would prove which version was checked, but not what it said.
- **API only** or **operator command only** (D4 A, B): no way to onboard a project before B04, or no logged-in accountable person.
- **Raise the data class** with unknown consent (D5 B): changes the G1 input and the model routing without a person seeing it.
- **Move to G1 and block there** (D6 B): needs edits in the gate step that B07 session 2 owns, and puts an intent at G1 that nobody may approve.

## 5. Consequences

- D-05 version 1.14: §6.1 `project_ai_records` as built, new `project_ai_record_versions`, §6.2 notice kind `ai_record_refused`, ERD (diagram D13).
- D-03 version 1.10: §5.2 Project AI Record row.
- `@sdlc/contracts`: the AI record codes move here (`AI_ALLOWED_VALUES`, `PROD_LOGS_ALLOWED_VALUES`, `DISCLOSURE_FORMATS`, `ProjectAiFacts`), wait reason `ai_record`, `PolicyEngine.productionDataAccess`.
- `@sdlc/config`: keys `access.ai_record_write_roles`, `access.ai_record_read_roles`, rule M19; the default `config_hash` changes (QUESTIONS #95: no stored configuration exists yet).
- Tests that step intents create a record first (`platform/tests/integration/ai-record-seed.ts`; the workflow fixture does it).
- Handbook Ch.19 §19.8b: the AI record commands and the G1 refusal.

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-09-27 | Claude (task B12) | First version |
| 0.2 | 2026-10-16 | Harry | Accepted (the design is built and merged; open items stay follow-ups) |
| 0.3 | 2026-11-16 | Claude (coordinator), approved by Harry | §2.4: who owns the record, now the same in D-02 §3 and handbook Ch.2 (QUESTIONS #103); no change to the design |
