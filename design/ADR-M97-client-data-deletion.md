# ADR-M97. Deleting a client's data on request: compliance, append-only integrity, and audit trail

| Item | Value |
|---|---|
| Status | **Accepted** (Harry, 2026-10-27; task H03 design); 1.1 with X08a PR 1 (Harry, 2026-11-14, QUESTIONS #725) |
| Date | 2026-10-27 |
| Decided by | Harry (2026-10-27, H03 design with answers to QUESTIONS #611–#615) |
| Related | D-08 task H03 (AC1–AC3); D-02 FR-44, §10; D-03 §7.5, §8.2, §10; D-05 §10, §10.1; ADR-M26 (operator tokens), ADR-M35 & ADR-M53 (Langfuse traces & purges), ADR-M51 (evidence retention, object lock & holds), ADR-M74 (project memory), ADR-M89 (project document index); Japan APPI (Act on the Protection of Personal Information, Art. 34–35); GDPR Art. 17; QUESTIONS #611–#615 |

## 1. Context & Problem Statement

### 1.1. Regulatory and contractual drivers
Enterprise clients adopting the Agentic SDLC Platform operate under strict data protection laws and commercial contracts:
1. **Japan's Act on the Protection of Personal Information (APPI)**: Articles 34 and 35 grant data subjects the right to request the deletion or cessation of processing of retained personal data when the data is no longer necessary or was improperly acquired.
2. **Global Data Privacy Laws (e.g. GDPR Art. 17)**: Requires the erasure of personal data ("right to be forgotten") upon contract termination or consent withdrawal.
3. **Enterprise Contractual Offboarding**: Master Services Agreements (MSAs) mandate that upon tenant termination or formal notice, vendor systems must purge all proprietary source code, confidential proposals, diffs, internal documentation, developer credentials, and user identities within a stipulated timeframe (typically 30 days).

### 1.2. The core architectural conflict
The platform is built on an uncompromising **Append-Only Architecture**:
- All audit entries (`audit_log`), gate decisions (`gate_decisions`), agent execution events (`run_events`), and token consumption logs (`cost_records`) are immutable (enforced by PostgreSQL trigger `SDA01` / `forbid_mutation()`).
- Audit entries form a cryptographic SHA-256 hash chain per tenant (`hash = SHA256(prev_hash + canonical_json(entry))`), anchored daily to prove tamper-evidence to external auditors.
- Compliance standards (SOC 2 Type II, ISO/IEC 27001, Japanese enterprise audit guidelines) and handbook Chapter 3 (FR-44) require **audit log and gate decisions to be retained for at least 2 years** to establish non-repudiation and accountability for agentic actions (e.g., who approved code deployments, what models ran, what gates were checked).

If a tenant deletion physically removes rows from append-only tables:
1. Trigger `SDA01` will abort the transaction.
2. If forced, the cryptographic hash chain breaks, invalidating historical compliance audits for both the client and the platform operator.
3. Referential integrity (`ON DELETE RESTRICT` foreign keys pointing from `gate_decisions`, `audit_log`, `agent_approvals` to `users.id`) would collapse.

Therefore, the platform requires a rigorous design defining **what is deleted**, **what is retained**, **how PII is scrubbed without row deletions**, and **how the audit log captures the deletion itself**.

---

## 2. Decision

### 2.1. Taxonomy of Client Data: What is Purged vs What is Retained

The platform categorizes all data assets into two distinct tiers: **Proprietary & Personal Content (Purged)** versus **System Telemetry & Structural Evidence (Retained)**.

```
+---------------------------------------------------------------------------------------------+
|                                    CLIENT DATA PURGE REQUEST                                 |
+---------------------------------------------------------------------------------------------+
               |                                                             |
               v                                                             v
+---------------------------------------------+               +-------------------------------+
|      TIER 1: PURGED CONTENT (Hard Delete)    |               | TIER 2: RETAINED STRUCTURAL   |
|      - SeaweedFS: Diffs, proposals, packs   |               |         EVIDENCE (Kept 2+ yrs)|
|      - Langfuse: Prompts, completions, tags |               | - audit_log (SHA-256 chain)   |
|      - knowledge-db: Vector index & docs    |               | - gate_decisions & run_events |
|      - users: PII anonymized (email, name)  |               | - cost_records (token sums)   |
|      - project_configs: Source YAML scrubbed|               | - sha256 hashes & UUIDs only  |
+---------------------------------------------+               +-------------------------------+
```

#### Detailed Breakdown Table:

| Subsystem / Storage | Specific Assets | Action on Request | Technical Mechanism & Notes |
|---|---|---|---|
| **SeaweedFS / S3** (`evidence` bucket) | Proposals, diffs, patches, test outputs, execution logs, Evidence Packs (`packs/*`), context snapshots (`snapshots/*`) | **Hard Purged** | Deleted by `worker-purge` using `BypassGovernanceRetention` header (ADR-M51 §2.1). `purged_at` timestamp set on `evidence_items` and `evidence_packs` (triggers `SDA15`/`SDA14`). Zero file bytes remain in object store. |
| **Langfuse / Observability** (ClickHouse + OTLP store) | LLM prompts, model responses, system prompts, tool call arguments, trace tags | **Hard Purged** | Selected via tag `tenant:<tenant_slug>` via `DELETE /api/public/traces` (ADR-M53 §2). Raw OTLP files swept from SeaweedFS; disk space reclaimed in ClickHouse via `ALTER TABLE ... APPLY DELETED MASK`. |
| **Vector DB / Knowledge Store** (`knowledge-db`) | Document chunks, embeddings, extracted source text | **Hard Purged** | Drops the tenant/project schemas in PostgreSQL/pgvector (`DROP SCHEMA <tenant_project> CASCADE`), sets `knowledge_indexes.purged_at`, and audits `knowledge.purged` (ADR-M89 §2.4). |
| **Project Memory** (X12 / ADR-M74) | Context memory files, project summaries | **Hard Purged** | Memory branch deleted in Git; memory file payloads purged; `project_memory_revocations` written to prevent future reference. |
| **User Directory** (`users` table) | `display_name`, `email` | **Anonymized / Scrubbed (In-Place)** | Rows are **not deleted**. Fields are overwritten: `email = 'deleted-' || id || '@redacted.invalid'`, `display_name = 'Redacted User ' || substring(id::text, 1, 8)`, `status = 'disabled'`. Satisfies APPI/GDPR right to erasure while preserving foreign keys. |
| **User Identities & Auth** (`user_identities`, `passkeys`, `web_sessions`) | OAuth logins (`external_login`), passkeys, active sessions | **Revoked & Redacted** | `user_identities.external_login` set to `'redacted-' || id`; all `web_sessions` terminated (`revoked_at = now()`, `end_reason = 'client_purged'`); all `passkeys` revoked (`revoked_at = now()`). |
| **Intents** (`intents`, version 1.1, X08a, QUESTIONS #725) | `title`, `description` (and the search vector `search_tsv` generated from them) | **Scrubbed (In-Place)** | `title = 'Redacted intent ' || code`, `description = ''`; the trigger `intents_scrub_only` (SDA31) allows no other change; `client_data.deleted` counts them (`intents_scrubbed`). Codes, gates and dates stay. |
| **Project Configurations** (`project_configs`) | `config_yaml` | **Scrubbed** | Replaced with minimal tombstone YAML (`redacted: true`, `purged_at: <iso8601>`); `config_hash` updated to SHA-256 of tombstone. |
| **Append-Only Tables** (`audit_log`, `gate_decisions`, `run_events`, `cost_records`) | Decision records, event timestamps, run metadata, cost USD, token counts, SHA-256 hashes | **Retained Intact (Minimum 2 years)** | **Zero rows modified or deleted.** Triggers `SDA01` remain active. None of these tables contain raw user code, plain prompts, or client secrets (verified by schema rules [R047], [R078], D-05 §6.4). Hashes and UUIDs alone cannot reconstruct source code. |

---

### 2.2. Append-Only Compliance & Hash Chain Integrity

#### The Invariant
> **Client Data Deletion Invariant:** Under no circumstance shall any row in an append-only table (`audit_log`, `gate_decisions`, `run_events`, `cost_records`, `project_ai_record_versions`, `agent_approvals`) be deleted or updated during a client deletion process.

#### Foreign Key Preservation via Pseudonymization
Tables referencing `users(tenant_id, id)` use foreign keys with `ON DELETE RESTRICT`. Because append-only tables cannot tolerate cascade deletes or nullified foreign keys without mutating history, the `users` table is treated as a **stateful identity register**:
1. When client data deletion executes, the user account is permanently disabled.
2. Personal Identifiable Information (PII) is replaced with deterministic, non-reversible pseudonyms.
3. Historical decisions (`gate_decisions.decided_by`, `audit_log.actor_id`) continue to resolve to the valid UUID in `users`, but inspection reveals only an anonymized entity:
   ```json
   {
     "id": "e4b2d3c1-0000-0000-0000-000000000001",
     "display_name": "Redacted User e4b2d3c1",
     "email": "deleted-e4b2d3c1@redacted.invalid",
     "status": "disabled"
   }
   ```
4. This complies with Japan APPI Article 35 and GDPR Recital 26 (anonymized data no longer constitutes personal data).

---

### 2.3. The Audit Trail of Deletion

The client deletion process does not erase the audit log; rather, **the deletion itself becomes the final, verifiable chapter of the tenant's audit chain**.

#### Sequence of Audit Events:
1. `client_data.deletion_requested`: Logged when an authorized tenant admin or compliance officer submits the deletion request.
   - `payload`: `{ "ticket_ref": "https://jira.internal/LEGAL-102", "legal_basis": "appi_article_34", "requested_by": "<uuid>", "grace_period_days": 14 }`
2. `client_data.deletion_approved`: Logged when the Platform Operator (Two-Person rule) confirms authorization.
   - `payload`: `{ "operator_id": "<uuid>", "approved_at": "<iso>", "confirmed_scope": "all_projects" }`
3. `client_data.deletion_started`: Logged by the worker when the grace period elapses and physical purge commences.
   - `payload`: `{ "worker_instance": "worker-purge-01", "targets": ["s3", "langfuse", "knowledge_db", "users_pii"] }`
4. `client_data.deleted`: The definitive terminal event recorded upon successful deletion of all tier 1 data.
   - `payload`:
     ```json
     {
       "evidence_files_purged": 1420,
       "langfuse_traces_purged": 3810,
       "knowledge_indexes_dropped": 4,
       "users_anonymized": 18,
       "retained_audit_rows": 9520,
       "deletion_receipt_hash": "a1b2c3d4e5f6... (SHA-256 of deletion certificate)"
     }
     ```

#### Cryptographic Hash Chain Continuity
Each event advances the tenant's audit sequence (`seq = N + 1`, `prev_hash = hash_N`). When external auditors or the former client request proof of deletion:
1. The platform exports the tenant's audit chain up to `client_data.deleted`.
2. The auditor runs `pnpm sdlc audit verify --tenant <id>`.
3. The cryptographic verification succeeds, demonstrating that:
   - All past gate decisions and changes were untampered.
   - The deletion was formally requested, authorized by two individuals, and executed completely.
   - No data was surreptitiously altered retroactively.

---

### 2.4. Dual Authorization (Two-Person Rule), Grace Period, and Holds

#### Two-Person Rule (HITL Enforcement)
Because client data deletion is catastrophic and irreversible, a single actor cannot execute it:
1. **Initiator (Person 1)**: Must hold the `tenant_admin` role in the client organization, submitting via `sdlc client request-data-deletion`.
2. **Approver (Person 2)**: Must be an authorized SDLC Platform Operator executing via `sdlc ops client-data-deletion approve <request-id>`.
3. Self-approval is strictly forbidden: a platform operator cannot initiate a deletion for their own managed tenant without an independent client request.

#### Grace Period
- **Default Grace Period**: 14 calendar days (`SDLC_CLIENT_DELETION_GRACE_DAYS = 14`), matching standard enterprise cooling-off periods.
- During the grace period:
  - The tenant is set to `status = 'pending_deletion'`.
  - All running agent intents and API access are suspended.
  - A cancellation request (`sdlc client cancel-data-deletion`) can abort the scheduled deletion with mutual approval.
- **Emergency Bypass**: In court-mandated injunctions or severe data breach containment, an emergency flag `--emergency-skip-grace` is permitted only if accompanied by a cryptographic dual-signature signed by both the Client Legal Officer and the Platform Governance Lead.

#### Interaction with Legal Holds (`evidence_holds`)
- If any intent or project in the tenant has an active legal hold (`evidence_holds`, ADR-M51 §2.5):
  - Physical deletion of evidence files for that held intent is **BLOCKED**.
  - The worker purge skips held items, recording `client_data.purge_blocked_by_hold` in the audit log.
  - Legal counsel must formally release the hold (`sdlc admin evidence release`) before the deletion can complete.

---

### 2.5. Execution Engine & Worker Integration

The deletion workflow integrates into the existing worker retention loop (`RetentionLoop`, ADR-M51 §2.8):
1. **Advisory Lock**: Runs under tenant-specific PostgreSQL advisory locks to prevent race conditions with concurrent runs or backup snapshots.
2. **Phased Execution**:
   - **Phase 1 (Store Revocation)**: Revoke API tokens, invalidate web sessions, set tenant status to `purging`.
   - **Phase 2 (External Purges)**:
     - Invoke `@sdlc/adapter-traces-langfuse` to delete traces and wait for verification (ADR-M53).
     - Invoke `@aws-sdk/client-s3` via `worker-purge` identity to delete evidence objects with `BypassGovernanceRetention` (ADR-M51).
     - Drop vector schemas in `knowledge-db` (ADR-M89).
   - **Phase 3 (Postgres PII Scrubbing)**: Execute atomic update transaction on `users`, `user_identities`, and `project_configs`.
   - **Phase 4 (Final Audit Seal)**: Write `client_data.deleted` to `audit_log`, update daily anchor, and mark tenant status as `purged`.

---

## 3. Backlog & Implementation Tasks (Follow-ups)

In compliance with AC3 (pure design in H03), the implementation is decomposed into subsequent backlog tasks:

1. **H03a (Database Schema & User Anonymization Engine)** [Size S]:
   - Migration for tenant status `pending_deletion`, `purged`.
   - `anonymizeUser()` DAO helper and PII scrubbing transactions.
   - Unit and integration tests verifying `users` scrubbing preserves FKs on `gate_decisions` and `audit_log`.
2. **H03b (Worker Client Purge Activity & External Purges)** [Size M]:
   - Extend `RetentionLoop` with `runClientPurgePass()`.
   - Orchestrate S3 file deletion with governance bypass, Langfuse trace deletion, and knowledge schema dropping.
   - Safety checks verifying legal holds block deletion.
3. **H03c (CLI & Admin Ops Tooling)** [Size S]:
   - Client CLI: `sdlc client request-data-deletion`, `sdlc client cancel-data-deletion`.
   - Server Ops CLI: `pnpm sdlc ops client-data-deletion approve|list|status`.
   - Audit event emitters for all deletion lifecycle events.

---

## 4. Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Accidental tenant deletion due to operator error or compromised token | High (Data Loss) | Two-Person rule (initiator + platform operator approval) and mandatory 14-day grace period. |
| Deletion breaks hash chain or violates trigger `SDA01` | High (System Failure) | Append-only tables are never modified. Invariant enforced by unit test suite asserting `audit_log` row count and hash continuity. |
| Incomplete deletion leaving orphaned files in S3 or Langfuse | Medium (Compliance Breach) | Deletion worker verifies empty queries from S3 and Langfuse before writing `client_data.deleted`. Orphan sweep detects residual files. |
| Client requests deletion while under regulatory subpoena/investigation | High (Legal Liability) | `evidence_holds` check halts evidence purge for held items until legal release. |

---

## 5. References

- **Internal**:
  - `design/D-02.md` §10 (Requirements FR-44).
  - `design/D-05-data-model.md` §10 (Retention & deletion) and §12 (Risks).
  - `design/ADR-M51-evidence-retention.md` (Object locks, holds, archive purges).
  - `design/ADR-M53-langfuse-purge.md` (Langfuse trace deletion & ClickHouse compaction).
  - `design/ADR-M89-project-docs-index.md` (Knowledge index purge).
- **External**:
  - Act on the Protection of Personal Information (Act No. 57 of 2003, amended 2020/2022, Japan), Articles 34 & 35.
  - General Data Protection Regulation (GDPR, EU 2016/679), Article 17 ("Right to erasure") & Recital 26 (Anonymization).
  - AICPA Trust Services Criteria (SOC 2) Common Criteria 6.5 & CC7.3 (Disposal and Retention of Data).

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 1.0 | 2026-10-27 | Claude (task H03) | Accepted |
| 1.1 | 2026-11-14 | Claude Code (task X08a PR 1), approved by Harry | §2.1: the intents' title and description become a tombstone (QUESTIONS #725) |
