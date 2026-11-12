# ADR-M54. A read-only web dashboard

| Item | Value |
|---|---|
| Status | **Accepted** (Harry, 2026-10-16; built by task U01). Version 0.8: the budget per chunk (Harry, 2026-11-12, QUESTIONS #686) |
| Date | 2026-10-07 |
| Decided by | Harry (QUESTIONS #255; U01 plan approved 2026-10-07 with the answers to QUESTIONS #260–#263: the four read-only fields, #263 option B, the token in memory only) |
| Related | D-08 task U01 (AC1–AC6); D-02 §4.2 (version 1.4); D-03 §5.1, §9, §11 (version 1.32); ADR-M03 (no web UI in the MVP), ADR-M26 (the API), ADR-M36 (the CLI's API client), ADR-M30 (intent workflow), ADR-M28 (escalations), ADR-M45 (cost report), ADR-M47 (gate metrics), ADR-M48 (Evidence Packs); handbook Ch.19 §19.8e; QUESTIONS #255, #260–#265; task U02 |

> **Actions:** since 2026-10-10 the dashboard's actions are decided in [ADR-M73](ADR-M73-dashboard-actions.md). This ADR stays the record of the read-only decision; the token sign-in of §2.3 stays for read-only use.

> **Other machines:** since 2026-10-12 access from other machines (TLS, a reverse proxy) is decided in [ADR-M67](ADR-M67-team-access.md) (task V09). "For 127.0.0.1 only" in §2.2 still holds for the api itself; other machines reach it only through the proxy of the profile `access`.

## 1. Context

The MVP has no web UI (ADR-M03): people use the CLI, comments and reviews on GitHub, and the Temporal and Langfuse UIs. During the trial M-E, Person A, Person B and the coordinator need an overview that the CLI gives only one command at a time: which intents wait where and for whom, which escalations are close to their SLA, what the trial costs, and how long the gates wait (the measures of `design/M-E-TRIAL-PLAN.md` §7.1).

Harry decided (QUESTIONS #255, 2026-10-07): a **read-only** dashboard, started in parallel with the trial M-E (which does not wait for it), signed in with the existing personal API tokens, with four groups of screens. Actions in a web UI, and the full MVP+1 interface scope, still come from the trial data after M-E (D-08 E07 note).

## 2. Decision

### 2.1. Read only, through the existing API

- The dashboard calls **only `GET` endpoints of the API** that the CLI already uses. It adds no write path, no form that changes state, no endpoint. Every decision stays in comments, reviews and the CLI.
- The API applies the same rules as for the CLI: no role on the project → 404, another role → 403, tenant-admin endpoints for tenant admins only. The dashboard hides what a person cannot open, but the API decides.
- Four read-only fields were missing for the screens Harry asked for. They are added to **existing GET responses**, never as new endpoints (§2.4).

### 2.2. Where it lives

- A new app, `platform/apps/dashboard` (`@sdlc/dashboard`), built to static files (PR 2).
- `sdlc-api` serves the built files under `/dashboard/`, on its own origin: `127.0.0.1:8090` in Compose. No new host port, no CORS, no second process.
  - Setting `SDLC_API_DASHBOARD_DIR`: an absolute folder, or `off` (the default outside the image; no dashboard routes).
  - The api reads the folder **once at start-up**: at most 200 files and 10 MB, only `.html`, `.js`, `.css`, `.woff2`, `.svg`, no symbolic links, and `index.html` must exist; otherwise the api does not start. A request is answered from that list by its path as a key, never by reading a path from the request.
  - The routes sit outside the API's guard: they serve the same public files to everyone. The API's routes keep their guard.
- **For 127.0.0.1 only** (Harry, U01 plan): on a developer machine or on the server itself, as the API is today. Exposing the dashboard (and the API) to other machines needs TLS, a reverse proxy and a review of the token handling; that is out of scope here.

### 2.3. Security in the browser

- **Content-Security-Policy** on every `/dashboard/` answer: `default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`. No inline script or style, no third-party origin: every asset, the fonts included, is served by the platform. Also `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, `Cross-Origin-Opener-Policy` and `Cross-Origin-Resource-Policy: same-origin`, a `Permissions-Policy` that turns off camera, microphone and location.
- **Caching:** `index.html` `no-store`; hashed files under `assets/` cached for a year (`immutable`), with an ETag.
- **The token** (Harry, U01 plan): a person pastes their personal token (`sdlc_pat_…`) into a password field; the dashboard checks it with `GET /v1/me` and keeps it **in memory only**: never in a URL, `localStorage`, `sessionStorage`, a cookie or a log. A reload or "Sign out" forgets it; signing out does not revoke the token (the CLI's `sdlc logout` does).
- **Password managers:** the token field is `type="password"` with `autocomplete="one-time-code"`, so browsers do not offer to save the token (they save passwords, never one-time codes). A person who saves it anyway stores it outside the platform's rules; the handbook says not to.
- **zod under the CSP:** zod 4 probes `new Function` for its fast path; the CSP has no `'unsafe-eval'`, so the dashboard sets `config({ jitless: true })` before any schema runs.
- **CSRF:** the token travels only in the `Authorization` header and every call is a `GET`, so another site cannot make the browser act. A static test refuses any other method and any `fetch` outside the one API client (PR 2).
- **Server text** (titles, descriptions, names, and every code: status, severity, route, gate…) is checked with the CLI's zod schemas, cleaned of control, bidirectional and zero-width characters (`cleanText`, shared with the CLI, ADR-M36), and always rendered as text, never as HTML. A CSS class built from a code keeps letters, digits and `_` only; an intent link is built only from a real intent code.

### 2.4. The four fields (QUESTIONS #260–#263)

| # | Field | Where | What |
|---|---|---|---|
| 260 | `gate_entered_at` | intent body (list and show) | When the intent last entered `current_gate` (the column the workflow already keeps, FR-12). The dashboard shows the waiting time from it |
| 261 | `waiting_for` | `GET /v1/intents/:intent` only | `{ gate, mode, roles, approvals_needed }`: who the current gate waits for, **as the intent workflow resolves it**; null when nothing is certain |
| 262 | `project.repo_full_name` | intent body | For the links to the issue and the pull request; people with a project role cannot read `/v1/admin/projects` |
| 263 | `owner_role`, `backup_role`, `step_role` | escalation body | The route's roles in the project configuration in force, the same the escalation clock and its notices use (`stepRole`); null when the configuration cannot be loaded |

**`waiting_for` (Harry's condition):** never a second resolution next to the workflow's. The workflow's steps resolved the oversight in six places (`step.ts` for G1–G3, `g4.ts`, `g5.ts`, `g6-verify.ts`, `g7.ts`, `g8.ts`), each with its own facts. They now all call one function, `resolveGateOversight` (core `workflow/oversight.ts`), and the API calls the same function with the same facts (`currentGateWaitingFor`):

- G1–G4, G7: the latest plan's change flags (the plan G3 passed: a new plan sends the intent back to G3, ADR-M40); G3 HITL once G5, G6 or G7 sent the intent back (`returnedFromG5`);
- G5: no change flags, not breached (a breach pauses the intent, so it no longer waits at G5);
- G6: the findings of the last CI reading (unknown → HITL, QUESTIONS #157);
- G8: the latest plan's change flags, production (QUESTIONS #220);
- POLICY at G4 (Low, Medium) has no roles: the platform decides.

**What `waiting_for` says, and what it does not.** It is the oversight of the current gate: who decides it (HITL: the approver roles and how many approvals; HOTL or AUDIT: the roles told, the platform passes it when its conditions hold; POLICY: the platform). It does **not** say whether a platform check holds the gate right now: a failed G4 check, a spec that cannot be read, a plan to submit again, a missing evidence credential at G8, a merge still to come at G7, or a freezing escalation. Those are the workflow's waiting reasons; copying them into the API would be a second resolution, which this ADR refuses. The dashboard therefore labels the field "decided by" and shows `freezes_intent` from the escalations. Since U02 the workflow's own record of what holds the intent is in the API too (§2.4b).

`waiting_for` is null when the intent is not `in_gate`, when the stored configuration is refused (the workflow stops too), and **at G6 before CI passed**: the workflow resolves G6's oversight only after CI passed; before that it waits for CI, not for a person. Tests: a unit test of every special case, a static test that no step calls `oversightMode` itself, and database tests that compare `waiting_for` with what the workflow does in the G4 (POLICY, HITL), G5 → G3, G6 (CI pending, findings unknown) and G7 (dual approval) tests.

`freezes_intent` (whether an escalation freezes its intent) was already in the escalation body (`isFreezing`, core): the dashboard shows it and never re-implements the freeze rule.

### 2.4b. What holds an intent (task U02, QUESTIONS #264, #265)

- **The record.** The intent workflow's step already returns why it waits (`IntentWaitReason`, about 30 codes), but only to Temporal. Since U02 the step writes it on the intent, in its own transaction, under the intent lock: `intents.waiting_reason`, `waiting_cause`, `waiting_since`, `waiting_until` (migration 0025, D-05 1.36). Written only when it changes, so `waiting_since` is when the hold began; never `updated_at`. Any other outcome writes null, and every move (`moveState`, `setState`) clears it, so another writer that moves the intent never leaves a stale reason. The one wait returned before the lock (the Git host down while G4's facts are read) is recorded under a short lock of its own, only while the intent still waits at G4. **The API reads these columns; it never evaluates a gate again** (#265).
- **The cause.** A failed G4 check records its check code (the one in `gate.g4_check_failed`) as `waiting_cause`. The column and the labels are open to later gates: the database checks the code's format only, and a catalog test checks every known cause. The step's `waiting` result carries it as an optional `cause`; workflow code never reads it, so Temporal replay is unchanged.
- **`hotl_block_window`** (Harry, U02 plan): the step returned `later_gate` both for an open HOTL block window and for a gate this worker does not handle. They are now two codes: wherever `hotlBlockWindowOpenUntil` gives a time (G4, G6, G7, G8 and the step's fallback), the step returns `hotl_block_window` and records the window's close in `waiting_until` (to the second); `later_gate` stays only for a dependency that is off.
- **Shown:** the intent body (list and show) has the four fields; `sdlc intent show` prints "Held: …", the cause and the end; the dashboard shows a "held" line on the board's card and a "What holds it" panel under "Who decides this gate". `decision` (the normal wait for a person) is not shown as a hold. Labels: `intent.waiting.<reason>` and `intent.waiting_cause.<cause>` in the catalog, mapped in `@sdlc/api-schemas` (`WAITING_REASON_KEYS`, `WAITING_CAUSE_KEYS`); a code without a label is shown as its code.
- **#264:** `plan-check.ts` (`plan_changed`) and `spec-check.ts` (G2's notice audience) resolve the gate's oversight with `gateOversight`, like the steps. With the simple policy engine a gate's HOTL and HITL roles come from the same matrix cell, so the audiences do not change today; the shared function keeps them right if a future engine or configuration separates them. Gate decisions do not change.

### 2.5. The dashboard app (PR 2)

- **Preact 11.0.0** (MIT; the stable `latest` release of 2026-09-30, after its betas and release candidates), TSX checked by `tsc` and ESLint; JSX escapes text. No `dangerouslySetInnerHTML` (lint rule and static test).
- **Vite 8.3.1** (already pinned at the root for Vitest) builds it; no Vite dev server in Compose.
- **No chart library:** small SVG components (wait-time bars per gate, cost split, SLA countdown) built on the colour tokens.
- **Fonts:** IBM Plex Sans and IBM Plex Mono 5.3.0 (OFL-1.1) from `@fontsource`, Latin subset, served by the api, `font-display: swap`.
- **Budget:** under 80 kB of JavaScript gzipped, checked on the build output. Version 0.8 (U09, QUESTIONS #686): the budget is for the first load; the administration screens are a chunk of their own, loaded when a person opens one, under 25 kB gzipped, with their `dashboard.admin.*` messages.
- **Response schemas:** the CLI's zod schemas move into a package both apps import (an app never imports another app).
- **Labels and messages** through `@sdlc/messages` (`dashboard.*` keys), bundled at build time (NFR-08).

### 2.5b. As built (PR 2)

- `@sdlc/api-schemas` (`platform/packages/api-schemas`): the CLI's response schemas, moved, and `cleanText`. No workspace dependency; the CLI keeps importing them through `apps/cli/src/api/schemas.ts`. Lint: the dashboard imports only this package; the package imports nothing in the workspace.
- The dashboard is part of `tsc -b` (type-checked, `emitDeclarationOnly`, types in `dist/types`); Vite builds `dist/web`. `pnpm build` runs both. The api image builds it and copies `dist/web` to `/app/dashboard` (`SDLC_API_DASHBOARD_DIR`, also set in Compose).
- Labels: a Vite plugin bundles only the `dashboard.*` keys of `@sdlc/messages` (the whole catalog is ~100 kB). The catalog test now reads TSX and double-quoted keys.
- Routes in the URL hash (`#/intents`, `#/intents/<INT>`, `#/escalations`, `#/numbers?project=…&by=…`, `#/audit`): filters can be shared; the token never is.
- Built: 45 kB of JavaScript gzipped, 4 kB of CSS, four woff2 font files (Plex Sans 400, 600; Plex Mono 400, 500).
- Colours: one token file, light and dark (`prefers-color-scheme`); colour means something only (waiting, past deadline, frozen, risk). Contrast checked by a test.
- What the screens read: the board pages through `GET /v1/intents` (100 a page, up to 1,000) and reads open and acknowledged escalations (100 each); an intent reads its detail, runs, escalations and packs (a 403 or 404 on packs hides the section); the numbers read `GET /v1/metrics/gates` and `GET /v1/cost/report` with the API's default ranges.

### 2.6. Tests and CI

- `pnpm test`: the static route (headers, list only, traversal, the guard), the new fields against the CLI schemas, the shared resolution; in PR 2 the data mapping, the "GET only, one client, no storage" static checks, the catalog keys and the colour contrast.
- `pnpm test:db`: the new fields through the API; `waiting_for` against the workflow.
- `pnpm test:dashboard` (PR 2): Playwright 1.63.0 (Apache-2.0) with Chromium against a stub API (`platform/tests/e2e/stub-api.mjs`) that serves the build through the api's own `registerDashboard`, so the CSP under test is the real one. It checks sign-in (wrong format, unknown token), every screen, GET only, nothing loaded from another origin, no CSP or script error, an inline script blocked, the token never in the URL, storage or cookies, sign-out, keyboard use, no horizontal scroll; screenshots at 375, 768 and 1440 px in both themes.
- CI: the existing `sandbox-image` job runs it (weekly, manual, and when the dashboard, `api-schemas`, the api's static route or the smoke test change: output `run_dashboard`). On a pull request that changes only those, the job's sandbox steps skip, so it costs the browser test only. No new job (Actions minutes).
- `pnpm test` (`platform/tests/dashboard/`): the data mapping; static checks of the source (one `fetch`, GET only, no storage, no HTML injection, every `dashboard.*` key in the catalog, no English text outside it) and of the build (no inline script, only the api's file types, no `data:` URI, the 80 kB budget); every path the dashboard reads is a GET route of an API controller; colour contrast (WCAG AA) in both themes.

## 3. Alternatives considered

| Option | Why not |
|---|---|
| A separate dashboard process or port | A second origin needs CORS and a new port; nothing to gain on 127.0.0.1 |
| `@fastify/static` | A runtime dependency in the api for a dozen files; the fixed list read at start-up is smaller and never reads a path from a request |
| Lit 3.3.3 (BSD-3) | Fine, but its templates are not type-checked; Preact with TSX is |
| A token in `sessionStorage` | Survives a reload, but any script running in the page could read it; memory only (Harry) |
| Re-deriving `waiting_for` with `PolicyEngine.oversightMode` in the API | Could disagree with the workflow (G3 after a return, G6 findings, G8 production); refused by Harry |
| New read endpoints | Not needed: the fields fit the existing responses (QUESTIONS #260–#263) |

## 4. Consequences and gaps

- People see the state of the trial in one page, without a new write path or a new port.
- Every refactored workflow step resolves oversight exactly as before; `pnpm test:db` and `pnpm test:workflow` pass unchanged.
- **Gaps:**
  - the token stays in the browser's memory while the tab is open; anyone at the unlocked screen can read the pages (sign out, lock the screen);
  - a role or a configuration changed after an escalation was raised: the roles shown are those of the configuration in force, as the clock uses them, not those at the raise;
  - closed by U02: `plan-check.ts` and `spec-check.ts` use the shared function (QUESTIONS #264, §2.4b);
  - closed by U02: what holds the intent is `waiting_reason`, recorded by the workflow's step (§2.4b, QUESTIONS #265). An open intent gets it when the reconcile loop next wakes it (within 10 minutes of the upgrade);
  - the dashboard does not refresh by itself in PR 2 beyond a manual "refresh" (no polling of the API every few seconds).

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.6 | 2026-10-12 | Claude (task V09, PR 1) | A pointer to ADR-M67 (team access from other machines); this ADR unchanged otherwise (QUESTIONS #405–#409) |
| 0.5 | 2026-10-10 | Claude (task V11), approved by Harry | A pointer to ADR-M73 (the dashboard's actions); this ADR unchanged otherwise (QUESTIONS #379) |
| 0.4 | 2026-10-07 | Claude (task U02) | §2.4b what holds an intent (the step's record, the cause, `hotl_block_window`, the display), #264; §4 gaps closed |
| 0.3 | 2026-10-07 | Claude (task U01, PR 2) | §2.5b as built (the shared schemas package, the build, the catalog plugin, the routes, the size), §2.6 the smoke test and the CI flag `run_dashboard` |
| 0.2 | 2026-10-07 | Claude (task U01, PR 1) | After the code review: what `waiting_for` does not say (§2.4); Harry: task U02 exposes the workflow's last waiting reason and moves the notice audiences to the shared function (QUESTIONS #264, #265; §4) |
| 0.1 | 2026-10-07 | Claude (task U01, PR 1) | First version: read only, served by the api under `/dashboard/`, 127.0.0.1 only, CSP, the token in memory, the four fields, one oversight resolution for the workflow and `waiting_for`; PR 2's app and tests |
| 0.7 | 2026-10-16 | Harry | Accepted (the design is built and merged; open items stay follow-ups) |
| 0.8 | 2026-11-12 | Claude (task U09, PR 2), decided by Harry | §2.5 Budget: 80 kB for the first load; the administration screens a chunk of their own under 25 kB (QUESTIONS #686) |
