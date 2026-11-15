# ADR-M09. Database access and migration tooling

| Item | Value |
|---|---|
| Status | **Accepted** (Harry, 2026-10-16; built by task A06) |
| Date | 2026-09-25 |
| Decided by | Harry (plan approved 2026-09-25) |
| Related | D-05 sections 3, 5, 6.1, 6.7, 7, 8, 9, 10 and 11; D-03 AP6 and section 12; D-08 tasks A06, A07; ADR-M16; ADR-M17; ADR-M18; NFR-02, NFR-04; FR-41, FR-44 |

## 1. Context

Task A06 chooses the ORM or migration tool and creates the tenancy tables of D-05 section 6.1. Requirements:

- Raw SQL migrations. Task A07 needs triggers, `REVOKE` / `GRANT` and advisory locks.
- Good TypeScript support.
- A data access layer that **requires** a tenant (D-05 D1, D-08 A06 AC3).
- A licence that allows commercial use (NFR-04).

## 2. Decision

### 2.1. Tools

| Need | Choice | Version | Licence |
|---|---|---|---|
| Query builder and migrator | Kysely | 0.29.6 | MIT |
| PostgreSQL driver | `pg` (node-postgres) | 8.23.0 | MIT |
| Driver types | `@types/pg` | 8.23.1 | MIT |

- Neither package runs an install script, so `pnpm.onlyBuiltDependencies` stays empty (ADR-M16 section 2.4).
- Kysely 0.29 is published **as ESM only**. Our packages compile to CommonJS (ADR-M16 section 2.2). Node.js 24 loads ESM packages with `require()`, so this works without changes. The migrator is imported from `kysely/migration`.
- The Kysely `Database` types are **written by hand** (`platform/packages/core/src/db/schema.ts`). `TABLE_COLUMNS` mirrors them at runtime; a type check keeps both equal, and an integration test compares both with the live schema. No code generator is needed.

### 2.2. Migrations

- A migration is a TypeScript module holding **plain SQL statements** (`platform/packages/core/src/db/migrations/NNNN-name.ts`). The statements run one by one; the migrator wraps each migration in one transaction.
- Migrations are listed in a static, ordered index (`migrations/index.ts`): no directory scan, no computed `import()`.
- **Once merged to `main`, a migration never changes.** Fix forward with a new migration.
- Production migrations only go forward. `down` exists for development only.
- The migrator keeps its state in `kysely_migration` and `kysely_migration_lock` (created by Kysely). These two tables have no `tenant_id`: they are infrastructure, not business data, and `platform_app` has no access to them.
- Commands: `pnpm db:migrate` and `pnpm db:status`, with `SDLC_DB_MIGRATION_URL` (owner role). In production, run them after a backup (D-05 section 11). Automatic migration when the API starts in development belongs to task B03.

### 2.3. Database roles

| Role | Used by | Rights in the `platform` database |
|---|---|---|
| `platform` | Migrations only | Owner: creates and changes tables, grants rights |
| `platform_app` | api, worker, runner (the data access layer) | `SELECT` and `INSERT`; `UPDATE` **only on columns that may change**. Never `DELETE`, `TRUNCATE` or DDL. No access to the migration tables |

- `platform_app` is created by `platform/deploy/postgres/init/02-create-platform-app-role.sh` with `PLATFORM_APP_DB_PASSWORD`. Every migration grants it rights on the tables it creates. The first migration stops with a clear error if the role is missing.
- `id`, `tenant_id` and `created_at` are never updatable, so a row cannot move to another tenant even through a bug.
- No `DELETE` enforces D-05 D7 (no hard deletes of business data) in the database.
- A07 grants only `SELECT` and `INSERT` on the append-only tables.
- **Purge and retention (E05, FR-44)** will use a **separate maintenance role**, used only by the cleanup job, with every action written to the audit log. `platform_app` never receives extra rights for purging.
- Until A04, database URLs and passwords come from the environment (`.env`, allowed by NFR-03). Later they come from OpenBao (D-03 section 8.2).
- Existing data volumes do not run the init scripts again. The script is idempotent: run it once by hand (`platform/deploy/README.md`, "Platform database roles").

### 2.4. How the data access layer requires a tenant

| Layer | Mechanism |
|---|---|
| Type | `TenantId` is a branded string, created only by `parseTenantId()` (UUID check). Tenant data is only reachable through `PlatformDatabase.forTenant(tenantId)`, which returns a `TenantScope` with the repositories. Insert inputs omit `tenant_id`; the scope sets it. The raw query builder is not exported from `@sdlc/core` |
| Runtime | `TenantScope` checks the tenant ID again. Every repository query adds `tenant_id = <tenant>`. The **tenant guard** (a Kysely plugin) checks every query before it runs. Rules are listed below |
| Database | Composite foreign keys `(tenant_id, <fk>) → parent (tenant_id, id)` (D-05 D2): a row can never reference another tenant's row. Column-level `UPDATE` grants (section 2.3) |

Tenant guard rules:

- Every occurrence of a platform table needs its own condition `<table or alias>.<tenant column> = <this tenant>`. This covers `FROM`, `JOIN`, `UPDATE` and `DELETE`, in every query level: the main query, subqueries, derived tables and CTEs.
- The condition must be in `WHERE`, or in the `ON` clause of that table's own `JOIN`. It must not sit under `OR` or `NOT`.
- An unqualified `tenant_id` counts only when the query level reads one table.
- `INSERT` must set the tenant column to this tenant in every row. `INSERT … SELECT` is rejected.
- `ON CONFLICT DO UPDATE` is rejected, because its target row may belong to another tenant. `UPDATE` must never write the tenant column.
- `INSERT` into and `UPDATE` of `tenants` are rejected. A tenant may read its own row; tenants are managed through the system scope only.
- These are rejected: raw SQL statements, `MERGE`, tables not in `TENANT_COLUMN`, other schemas, and CTE names equal to a table name.
- Raw SQL *fragments* inside a built query (for example ``sql`lower(email)` ``) are allowed. They must never reference a table; code review checks this.

**System scope.** A few operations cannot be bound to one tenant. They live in `SystemScope` as a short list of named methods; there is no generic access:

- create a tenant
- read a tenant by ID or slug
- `resolveApiToken(hash)`: task B03 finds the tenant from the token, so this lookup crosses tenants
- `listPollableProjects()`: task B06, the GitHub poller runs for every tenant (ADR-M27). It returns only `tenant_id`, `project_id` and the repository name of the active GitHub projects of active tenants; everything after it runs in `forTenant(tenant_id)`

PostgreSQL Row-Level Security stays in MVP+1 (D-05 section 8). Task H09 builds it (ADR-M110): `forTenant()` sets the tenant per transaction, and the system scope reads tenant data one tenant at a time; `resolveApiToken` and the web-session lookups find the tenant through two definer functions (migration 0059). Migration 0060 turns on row-level security (ADR-M110 §2.1).

### 2.5. Enums

- Only the enums used by existing tables are created: `data_class`, `project_role` and `git_provider`. Each later task creates its enums with its tables. This keeps rework small while the handbook is not yet approved as a whole.
- Enums hold **vocabulary** only: role names, data classes. The **rules** that use them live in project config (A05) and policy (B01): who approves which gate, which data classes need consent, SLAs.
- **`@sdlc/contracts` (`codes.ts`) is the source of the canonical lists**: `data_class` (`DATA_CLASSES`) and `project_role` (`PROJECT_ROLES`). Core imports them; it keeps no copy (ADR-M16 §2.5 allows core to import contracts).
- `platform/packages/core/src/db/vocabulary.ts` lists only the values that exist in the database layer alone: `git_provider` and the values of the CHECK columns (statuses, AI record values). `DB_ENUMS` maps each enum type to its list.
- The migration SQL keeps literal values (section 2.2). Tests compare the migration SQL and the live `pg_enum` values with `DB_ENUMS`, and the live `data_class` and `project_role` values with the `@sdlc/contracts` lists, so any drift fails CI.

**Changing an enum later** (for example when the handbook changes the 2+N roles):

1. Add the value in a new migration: `ALTER TYPE project_role ADD VALUE 'new_role';`.
2. PostgreSQL does not allow a new enum value to be **used in the same transaction** that added it. Each migration runs in one transaction, so a migration that adds a value must not insert or compare that value. Use it in a later migration or in application code.
3. Add the value to its list in the same PR: `@sdlc/contracts` (`codes.ts`) for a canonical code, `vocabulary.ts` for a value of the database layer only.
4. To rename a value, use `ALTER TYPE … RENAME VALUE 'old' TO 'new'`.
5. PostgreSQL cannot remove a value. Removing one means creating a new type, converting the columns, and dropping the old type. Plan it as its own migration and design review.

### 2.6. Tests

| Kind | Where | Database |
|---|---|---|
| Unit | `platform/tests/db/` (in `pnpm test`) | None: queries are compiled with a dummy driver. Covers the tenant guard (including JOIN, subquery and CTE cases), `TenantId`, the migration SQL, and compile-time checks |
| Integration | `platform/tests/integration/db/` (`pnpm test:db`) | Throw-away PostgreSQL |

- `platform/deploy/scripts/test-db.sh` starts the Compose PostgreSQL image with the Compose init script. It uses random passwords and a port bound to 127.0.0.1, and removes the container afterwards. With `SDLC_TEST_DATABASE_URL` set, it uses that server instead.
- Each test file creates its own database and drops it afterwards.
- Tests connect as superuser with `-c role=platform` or `-c role=platform_app`, so every check runs with the privileges of the real role.
- CI job `db` runs `pnpm test:db` on every PR. `ci-ok` waits for it. With `SDLC_REQUIRE_DB=1`, a missing database fails the tests instead of skipping them.

### 2.7. Details not written in D-05

Approved with the plan:

- `tenants.created_at`
- email unique per tenant ignoring case (`lower(email)`)
- `api_tokens.token_hash` unique across tenants
- unique `(tenant_id, user_id, project_id, role)` on `role_bindings`

Implementation choices:

- Text status and AI record columns use `CHECK` constraints with the values of D-05.
- Every foreign key uses `ON DELETE RESTRICT`.
- `project_configs.updated_by` may be null: the platform wrote the config itself.
- `api_tokens` stores only the SHA-256 hash (`CHECK` on 64 lowercase hex characters). The repository rejects anything else, and the raw token never reaches the database.
- `project_configs` and `project_ai_records` are versioned with optimistic locking: `save(…, expectedVersion)`. From A07 on, each save appends an audit event in the same transaction (section 2.8).
- `role_bindings.revoked_at` (QUESTIONS #11, approved): a role is withdrawn by setting it; revoked rows stay as history. The unique key applies to active bindings only (`WHERE revoked_at IS NULL`), so a role can be granted again. `platform_app` may update only `revoked_at`, and a `CHECK` keeps it after `created_at`. `revoke()` uses the database clock by default. Since A07, a trigger refuses any change once `revoked_at` is set, so a withdrawn role can never be reactivated, even with raw SQL or by the owner role (QUESTIONS #12).
- The 1–1 tables are keyed by `project_id` alone (D-05). A cross-tenant insert into them fails on the primary key before the foreign key. It is still rejected, but with the error code `conflict` instead of `reference_not_found`.

### 2.8. Audit log (task A07)

Migration `0002-audit-log` creates `audit_log` (D-05 sections 6.7 and 7).

**Append-only (D-05 D3).**

- `platform_app` has only `SELECT` and `INSERT` on `audit_log`.
- The shared trigger function `forbid_mutation()` refuses `UPDATE` and `DELETE` (row trigger) and `TRUNCATE` (statement trigger), for every role that does not bypass triggers, including the owner `platform`. Tasks B02, C02 and C03 attach the same function to `gate_decisions`, `run_events` and `cost_records`.
- `id` is `bigint GENERATED ALWAYS AS IDENTITY` (same behaviour as `bigserial`; `platform_app` needs no sequence grant).

**Hash chain (D-05 section 7.1).**

- One chain per tenant. `hash = SHA-256(prev_hash || canonical_json(record))`, where `canonical_json` is RFC 8785, the same module as `config_hash` (`@sdlc/config` `canonicalJson`, ADR-M18). Core imports `@sdlc/config` for it (allowed by ADR-M16 §2.5).
- Hashed fields, version 1: `hash_version`, `tenant_id`, `seq`, `actor_type`, `actor_id`, `action`, `entity_type`, `entity_id`, `payload`, `occurred_at` (ISO 8601 UTC, millisecond precision) and `prev_hash`. Not hashed: `id` and `created_at` (set by the database) and `hash` itself.
- `hash_version` is stored in its own column and is part of the hashed record (Harry, 2026-09-25). A later change to the field list or to canonicalisation gets a new version, and old rows still verify under their own version. The column has a `CHECK (hash_version = 1)`; a new version needs a migration.
- First record of a tenant: `seq = 1`, `prev_hash` = 64 zeros (`CHECK`).
- Writes: `AuditLogRepository.append` runs in the caller's transaction (or opens one), takes `pg_advisory_xact_lock(<audit class>, hashtext(tenant_id))`, reads the tenant's last row, computes the hash and inserts. The lock is a query fragment without a table, so it passes the tenant guard.
- **Chain link trigger** (`BEFORE INSERT`): refuses a row whose `seq` is not the tenant's last `seq + 1`, or whose `prev_hash` is not the last `hash`. It cannot recompute the SHA-256, but a writer that skipped the lock cannot create a gap or a fork. Unique `(tenant_id, seq)` stays as well.
- Trigger errors use our own SQLSTATE codes, mapped to `DbError` codes: `SDA01` append-only → `immutable`; `SDA02` chain link → `conflict`; `SDA03` revoked role binding → `immutable`; `SDA04` void of a non-approval → `invalid_value` (B02, ADR-M20); `SDA06` a delivered or abandoned reply of a Git event receipt → `immutable` (B06, ADR-M27). (`SDA05`: a run in a final status, C02, ADR-M22.)

**What the payload may contain.** The audit log is never deleted and is kept at least 2 years (D-05 section 10, FR-44). Personal data or client data written there could never be erased (handbook Ch.7). Therefore:

- Audit payloads hold **only IDs, codes, hashes and versions**. Never personal data (names, emails, account names), client data, free text, configuration text or record contents.
- `append` accepts only the fields **declared for the action** in `platform/packages/core/src/audit/actions.ts` (`AUDIT_ACTIONS`). Each field has a strict format: `uuid`, `sha256`, `version` (positive integer) or `code` (at most 64 characters, no spaces). Unknown actions, missing, extra or badly formatted fields are refused with `DbError('invalid_value')`.
- The canonical payload must fit in 2048 bytes (`MAX_AUDIT_PAYLOAD_BYTES`).
- The actor is checked too: `human` and `agent` need a UUID `actor_id`; `system` has none.
- `entity_type` and `entity_id` are nullable, both or neither (`CHECK`): some events (tenant-level, configuration) have no single entity (D-05 section 6.7).
- A new action is added to `AUDIT_ACTIONS` with the smallest set of fields that makes the event traceable, and a test. Reviewers check that no field can carry personal or client data.

**Actions so far.**

| Action | Entity | Payload | Written by |
|---|---|---|---|
| `config.changed` | `project` | `version`, `config_hash` | `projectConfigs.save`, same transaction. Actor `system` when the platform writes the config |
| `ai_record.changed` | `project` | `version` | `projectAiRecords.save`, same transaction. Never the record contents (client contact, locations) |
| `intent.created` | `intent` | `code`, `project_id`, `risk_tier`, `data_class`, `max_autonomy` | `intents.create` (B02). Never the title or description |
| `intent.state_changed` | `intent` | `status`, `current_gate`? | `intents.updateState` (B02) |
| `spec.linked` | `intent` | `spec_ref_id`, `version`, `content_sha256` | `specRefs.link` (B02). Never the path or content |
| `plan.submitted` | `intent` | `plan_id`, `version`, `plan_sha256` | `plans.submit` (B02). Never the file list or summary |
| `gate.decided` | `intent` | `decision_id`, `gate`, `decision`, `oversight_mode`, `input_sha256`, `config_hash`, `approver_role`?, `reason_code`?, `voids_decision_id`? | `gateDecisions.decide` and `revalidateApprovals` (B02). Never a free-text reason |

Fields marked `?` are optional (ADR-M20 section 2.4): left out when there is no value, never null, same format rule when present.

**Integrity check (D-05 section 7.3, FR-41).**

- `TenantScope.audit.verify()` reads the tenant's rows in `seq` order, 1000 at a time, and reports the first broken record: `seq_gap`, `prev_hash_mismatch`, `hash_mismatch` or `unknown_hash_version`.
- `sdlc audit verify [--tenant <slug>] [--json]` (`pnpm sdlc audit verify …`) checks one tenant or every tenant. Exit codes: 0 intact, 1 broken, 2 usage or setup error, 3 unexpected error. Text comes from the message catalog.
- **Temporary:** the command connects straight to the database as `platform_app` with `SDLC_DB_URL`, because the API does not exist yet (Harry, 2026-09-25). **Task B04 moves `sdlc audit verify` behind the API.**
- Limits: someone with owner or superuser access can rewrite the whole chain, or delete its last records, without `verify` seeing it. The daily external anchor of each tenant's last hash (D-05 section 7.4, task E05) covers this.

**Role bindings (QUESTIONS #12).** Trigger `role_bindings_revocation_is_final`: once `revoked_at` is set, every `UPDATE` of the row is refused (no un-revoking, no re-revoking), for every role. `revoke()` already filters on `revoked_at IS NULL`, so it returns `undefined` for a revoked binding and never reaches the trigger.

## 3. Alternatives not chosen

| Option | Why not |
|---|---|
| Drizzle ORM + drizzle-kit (Apache-2.0 / MIT) | Migrations are generated from a schema file; triggers and grants live outside it, so generated diffs and the real database drift apart |
| Prisma 7 (Apache-2.0) | Its schema language does not model triggers or grants; heavier (CLI, generated client); tenant enforcement only through client extensions |
| TypeORM (MIT) | Decorator metadata, weaker types, history of maintenance problems |
| node-pg-migrate (MIT) + plain `pg` | Good SQL-first migrations, but no typed query builder |
| Testcontainers (MIT) for tests | Extra dependencies (dockerode and friends); a 60-line script does the same |
| Separate CI `services:` container | Service containers start before checkout and cannot mount the init script |

## 4. Consequences

- Every later table must follow section 2.2 and the rules in the header of `0001-tenancy.ts`, and be added to `schema.ts` (types, `TABLE_COLUMNS`, `TENANT_COLUMN`). Tests fail otherwise.
- Repository code must satisfy the tenant guard. A query the guard rejects is a bug in the repository, not in the guard.
- A role is withdrawn by setting `role_bindings.revoked_at`, never by `DELETE` (`design/QUESTIONS.md` #11, approved). Reads return active bindings only by default, so approval checks never see a revoked role.
- Every later append-only table attaches `forbid_mutation()` and gets `SELECT, INSERT` only. Every later audit event is declared in `AUDIT_ACTIONS` first (section 2.8).

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-09-25 | Claude (task A06) | First version |
| 0.2 | 2026-09-25 | Claude (task A06) | `role_bindings.revoked_at` (QUESTIONS #11, approved by Harry) |
| 0.3 | 2026-09-25 | Claude (issue #55) | §2.5: `@sdlc/contracts` is the source of `data_class` and `project_role`; `vocabulary.ts` keeps DB-only lists; test of `pg_enum` against contracts |
| 0.4 | 2026-09-25 | Claude (task A07) | §2.8 audit log: triggers, hash chain with `hash_version`, payload rule (IDs, codes, hashes, versions only; declared fields; 2048 bytes), audited config and AI record saves, `sdlc audit verify` (temporary direct DB access, B04 moves it behind the API); §2.7 QUESTIONS #12 done |
| 0.5 | 2026-09-25 | Claude (task B02) | §2.8: registry audit actions, optional fields, `SDA04`. `gate_decisions` attaches `forbid_mutation()` (ADR-M20) |
| 0.6 | 2026-09-27 | Claude (task B06) | §2.4: `listPollableProjects()` added to the system scope (IDs only, ADR-M27); `TenantScope.savepoint` issues savepoint statements outside the guard (no table); `SDA06` |
| 0.7 | 2026-10-16 | Harry | Accepted (the design is built and merged; open items stay follow-ups) |
| 0.8 | 2026-11-15 | Claude (task H09, PR 1) | §2.4: pointer to ADR-M110 (tenant per transaction, system scope per tenant, authentication lookups) |
| 0.9 | 2026-11-15 | Claude (task H09, PR 2) | §2.4: row-level security on (migration 0060) |
