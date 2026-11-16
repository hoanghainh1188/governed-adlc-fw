# ADR-M110. PostgreSQL row-level security as a second tenant barrier

| Item | Value |
|---|---|
| Status | **Accepted** (Harry, 2026-11-16), after H09 was built and merged (#541, #544); proposed on 2026-11-15. Plan approved by Harry on 2026-11-15; PR 1 built §2.2–§2.4 (merged, #541); PR 2 builds §2.1 and §2.5 and adds the measured cost (§2.6) |
| Date | 2026-11-15 |
| Decided by | Harry (to accept); H09 builds it |
| Related | D-08 H09 (AC1–AC5); D-02 NFR-02, NFR-03; D-03 §9 (tenant isolation); D-05 §8; ADR-M09 §2.3 (roles), §2.4 (tenant guard, system scope); ADR-M103 (housekeeping definer functions, migration 0046); CLAUDE.md R026; QUESTIONS #733 |

## 1. Context

Today one barrier keeps tenants apart: the data access layer. `PlatformDatabase.forTenant()` returns a `TenantScope`, and its tenant guard refuses any query without `tenant_id = <tenant>` (ADR-M09 §2.4). The database itself adds composite foreign keys, but it would return another tenant's rows to a query that forgot the filter.

D-03 §9 and D-05 §8 planned PostgreSQL row-level security (RLS) "in Later", as a second barrier that holds even when application code is wrong. H09 builds it. QUESTIONS #733 (Harry, 2026-11-15) decided how work that crosses tenants runs:

- it loops over the tenants and sets the tenant per transaction, as `forTenant()` does;
- no role of the application gets `BYPASSRLS`;
- this ADR checks each process and lists every exception.

## 2. Decision

### 2.1. Policies (PR 2, migration 0060)

On every table with a `tenant_id` column:

- `ALTER TABLE … ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY`.
- Policy `tenant_isolation`, `TO platform_app`, `USING` and `WITH CHECK`:
  `tenant_id = (SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid)`.
  - `NULLIF(…, '')`: once a transaction-local setting has ended, PostgreSQL returns an empty string, not NULL, and `''::uuid` is an error. With `NULLIF`, a query without a tenant matches no row. The meaning is the one of the H09 AC text.
  - `(SELECT …)`: the value is computed once per query (an init plan), so the index on `tenant_id` is still used.
- Policy `owner_all`, `TO platform`, `USING (true) WITH CHECK (true)`: the migration owner keeps the access it has today (migrations, the definer functions of §2.4 and of migration 0046, test seeds). The owner is never used by the application processes (ADR-M09 §2.3).
- No role gets `BYPASSRLS`. The superuser (`postgres`) bypasses RLS as PostgreSQL always does: backups (`pg_dumpall -U postgres`) are not changed.
- A test lists the live tables with a `tenant_id` column and fails when one has no RLS or no policies, as `platform/tests/db/append-only.test.ts` does for append-only tables. Two tests: `platform/tests/db/row-level-security.test.ts` (the migration SQL against `TENANT_COLUMN`) and `platform/tests/integration/db/row-level-security.test.ts` (the live tables, `pg_class` and `pg_policies`, and the leak checks with raw SQL).
- The table list is written out in migration 0060 (51 tables), not imported: a merged migration never changes. A later table with `tenant_id` gets the same four statements in its own migration; both tests fail otherwise.

### 2.2. The tenant of a transaction (PR 1)

- `PlatformDatabase` shares one pool (one `PostgresDriver`). `forTenant(tenantId)` returns a `TenantScope` over a **tenant-bound driver** (`platform/packages/core/src/db/tenant-driver.ts`) for that tenant, cached per tenant.
- Every transaction of the tenant-bound driver starts with one message: `BEGIN; SELECT set_config('app.tenant_id', '<tenant>', true)` (or `START TRANSACTION …` with the isolation level or access mode Kysely asked for, checked against a fixed list). The simple query protocol takes no parameters, so the tenant ID is written into the text; `parseTenantId` has checked it first (36 characters of `[0-9a-f-]`).
- A statement sent outside a transaction runs in its own short transaction: that message, the statement, `COMMIT`. When the statement fails, the driver sends `ROLLBACK` before the connection goes back to the pool.
- The setting is **always transaction-local** (`true`). PostgreSQL resets it at `COMMIT` or `ROLLBACK`, so a pooled connection never keeps another tenant (R026). The driver never sets it per session (`set_config(…, false)` or `SET`). Streaming queries are refused: they would keep a transaction open between reads.
- `SystemScope.createTenantWith` sets the new tenant in its transaction right after the `tenants` row is inserted.
- The tenant guard stays. It is the first barrier; RLS is the second.

### 2.3. Work that crosses tenants (PR 1, QUESTIONS #733)

Each process, and the path it uses:

| Process | Reads | Path |
|---|---|---|
| GitHub poller (B06) | `listPollableProjects` | Loop over active tenants; one query per tenant in its transaction |
| Escalation clock (B11) | `listDueEscalations` | Loop; merge by due time, then ID; keep `limit` |
| Memory loop (X13) | `listMemoryWork` | Loop; merge each kind by its time; keep `limit` |
| Intent reconcile (B07) | `listOpenIntents` | Loop in tenant order from the keyset position; stop at `limit` |
| Kill signals (C11) | `listKillingIntents` | Loop in tenant order; stop at `limit` |
| Evaluation loops (L04, L05, L07) | `listTenantsWith…` | Loop in tenant order; one `LIMIT 1` probe per tenant; stop at `limit` |
| Spend sync (C12) | `earliestStartOfRunsEndedSince` | Loop over every tenant; the earliest time |
| Retention orphan sweep (E05) | `existingPackIds` | Loop over every tenant; the union |
| Retention, housekeeping, client purge, audit anchor, admin config, client-data deletion | `listTenants` + `forTenant` | Already per tenant: no change |
| `adlc ops audit verify` | `listTenants` + `forTenant` | Already per tenant: no change |
| Load test (O07) | the processes above | No change: it drives the real poller and worker |
| Operational alerts (O03, ADR-M101) | none | Do not read the platform database |

- The signatures of `SystemScope` do not change, so the worker and the API do not change.
- Each loop sends one small query per tenant per tick. The platform has few tenants (20 in the load test); §2.6 records the cost.

### 2.4. Exceptions

| Exception | Why | Limit |
|---|---|---|
| `tenants` has no RLS | It has no `tenant_id`: it is the list every loop of §2.3 starts from, and the authentication result needs its status | The tenant guard still lets a tenant read its own row only; only `SystemScope` changes it |
| `auth_api_token_tenant(text)` and `auth_web_session_tenant(text)` (migration 0059) | An API token or a session cookie names no tenant. One query per tenant on every API request would be too slow | `SECURITY DEFINER`, owned by `platform`, `search_path` fixed, `EXECUTE` for `platform_app` only. In: a SHA-256 hash (anything else returns NULL). Out: the tenant ID only. The full lookup then runs in that tenant's transaction (`resolveApiToken`, `resolveWebSession`, `endWebSessionBySecret`) |
| Owner policy `owner_all` for `platform` (§2.1) | Migrations, the definer functions of 0046 and 0059, and the test seeds run as the owner | The owner is the migration role only; it never serves requests |
| Kysely migration tables | Infrastructure, no `tenant_id`, no access for `platform_app` (ADR-M09 §2.2) | — |
| The knowledge database (pgvector, X04, X06) | A separate database: one schema and one login per project (ADR-M89, ADR-M108) | Not changed by H09 |

### 2.5. What stays the same

- Append-only triggers and grants (A07 and later), the hash chain, the column-level `UPDATE` grants, the migration owner `platform`.
- Foreign-key checks are not subject to RLS in PostgreSQL, so the composite foreign keys keep working. Unique keys stay global (for example `api_tokens.token_hash`).
- Temporal, the logs and the audit log hold no new value: the tenant ID was already there.

### 2.6. Cost

- A statement sent outside a transaction now takes three round trips to the database instead of one (`BEGIN` with `set_config`, the statement, `COMMIT`). A transaction takes no extra round trip.
- PR 1, on a developer machine (PostgreSQL in Docker Desktop, 2026-11-15): the whole database suite (`pnpm test:db`, 1206 tests) passed in 66 s; on `main` the same run took 80 s, with 3 tests past their 5-second limit under load. The test files that time out under load do so on `main` too; alone, each runs in under 2 s on both.
- PR 2, the policies (`platform/tests/integration/db/rls-cost.test.ts`, run with `SDLC_RLS_BENCH=1`; same machine, 2026-11-15). 10 tenants × 2,000 users; the same repository calls through `forTenant()` with row-level security turned off by the owner, then on; median of 300 calls (30 for `list`):

| Call | RLS off (ms) | RLS on (ms) | On / off |
|---|---|---|---|
| `users.getById` (one statement) | 0.80 | 0.67 | 0.84 |
| `users.list` (2,000 rows) | 5.79 | 6.63 | 1.15 |
| a transaction with two reads | 1.24 | 1.40 | 1.13 |
| `users.create` (one insert, `WITH CHECK`) | 0.99 | 0.88 | 0.89 |

  - The differences are within the noise of a developer machine: the policies add no measurable cost. The tenant condition is an init plan (`One-Time Filter`), and the query still uses the index on `tenant_id` (`Bitmap Index Scan on users_tenant_id_id_key`).
  - The test fails when the plan loses the index or a ratio passes 3, a wide bound for a noisy machine. It does not run in CI.

## 3. Alternatives not chosen

| Option | Why not |
|---|---|
| Set the tenant per session (`SET app.tenant_id` when a connection is checked out) | A connection returned to the pool keeps the tenant of its last user; a missed reset leaks data. Refused by the AC |
| A role with `BYPASSRLS` for the worker | Refused by QUESTIONS #733: one bug in a loop would read every tenant |
| One database role per tenant | Many logins and pools on a modest server; grants per tenant in every migration |
| RLS on `tenants` too | Every loop would need an exception to list the tenants |

## 4. Consequences

- A later table with `tenant_id` gets RLS and both policies in its migration; the live test fails otherwise (PR 2).
- New cross-tenant work loops over the tenants through `SystemScope`; it never reads tenant tables without a tenant.
- A person who queries the database by hand as `platform_app` sees no tenant rows unless they set `app.tenant_id` in their transaction (deploy README, "Platform database roles").
- Database tests that check triggers, constraints or grants on tenant rows with raw SQL use `appAs(tenantId)` (the tenant set per transaction, no tenant guard) instead of `appRaw` (no tenant: sees no tenant row).
- `PlatformDatabase.close()` closes the shared pool itself (PR 2): Kysely closes a driver only when its own instance ran a query, and a process may use only `forTenant()`.

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-11-15 | Claude (task H09, PR 1) | First version: policies (built in PR 2), tenant-bound driver, loops per tenant, exceptions, migration 0059 |
| 0.2 | 2026-11-15 | Claude (task H09, PR 2) | §2.1 built (migration 0060, 51 tables) and its tests; §2.6 the measured cost; §4 the test helper `appAs`, `close()` closes the shared pool |
| 0.3 | 2026-11-16 | Claude Code, accepted by Harry | Accepted: H09 is built and merged (#541, #544); no change to the design |
