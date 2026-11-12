# ADR-M73. Actions in the web dashboard

| Item | Value |
|---|---|
| Status | **Accepted** (Harry, 2026-10-10). Built by tasks U05–U07 (UX) and U08–U09 (Later). Version 1.1: U05's details (§2.2b, QUESTIONS #385–#389); 1.2: wording; 1.3: U06's details (§2.3b, §2.4b, QUESTIONS #410–#414); 1.6: U08 as built (§2.1); 1.7: U09's step-up for administration (§2.1, §2.4b, QUESTIONS #681–#685) |
| Date | 2026-10-12 |
| Decided by | Harry (V11: `design/MVP1-UI-SCOPE.md` 1.0 approved 2026-10-10; QUESTIONS #375–#380) |
| Related | `design/MVP1-UI-SCOPE.md` 1.2 (the plan); ADR-M54 (the read-only dashboard); ADR-M03 (approvals through comments and the CLI); ADR-M26 (the API); ADR-M37 (admin); ADR-M41 (G7); ADR-M42 (kill switch); ADR-M28 (escalations); [ADR-M67](ADR-M67-team-access.md) (V09, team access); D-02 §4.2 (1.10); D-03 §5.1, §9, §12 (1.40); D-05 (1.40); D-08 U05–U09, V03 |

## 1. Context

The dashboard of ADR-M54 is read only: a person pastes a personal token, the page keeps it in memory, and every call is a `GET`. Every decision is made in GitHub comments and reviews, or with the CLI. Harry asked for a plan of the dashboard's actions (QUESTIONS #355, #358). Task V11 wrote it (`design/MVP1-UI-SCOPE.md`), and Harry approved it on 2026-10-10.

Writes from a browser need what the read-only dashboard avoids: a sign-in that is not a pasted token, a session, CSRF protection, a stronger proof before a decision, and an audit trail that names the channel.

## 2. Decision

### 2.1. What the dashboard may do

- Actions in three waves, all through **existing API endpoints and core handlers** (MVP1-UI-SCOPE §3). Wave 1 (U07): kill a run; approve, reject or request changes at a gate, never at G7; acknowledge and decide an escalation. Wave 2 (U08): create an intent with its spec, submit a plan, evidence packs. Wave 3 (U09): administration.
- No new business endpoint. New endpoints only for sign-in, the session and passkeys; they change no intent, gate, run or escalation.
- The L1 proposal download stays in the CLI (hash checked again, file mode 600, ADR-M64); a browser download would land in the Downloads folder with the usual permissions. The page shows the command.
- **As built by U08** (2026-10-29): wave 2 marks `POST /v1/intents/:intent/specs`, `/plans` and `/evidence-packs` `@SessionAction('actions')` (create was marked by PR #462), with no step-up; the services and their `access.*` roles are unchanged. The page creates the intent, then links the spec; a refused link keeps the intent. Refusals use the catalog keys of the API and the CLI.
- **As built by U09** (2026-11-12, PR 1, QUESTIONS #681–#685): wave 3 marks every administration change `@SessionAction('actions')`, always with the passkey step-up (§2.4b): projects (create, update, archive, roles, configuration), users (create, update, disable, enable, Git host identities, sign out everywhere), tenant admins, the agent register (register, update, approvals, suspend, quarantine, owner, recertify), the project AI record, evidence holds, and a tenant admin's removal of a person's passkey. Containment changes take the step-up too; the CLI stays the fast path (#681). The token routes and the tool register stay closed to sessions (#682, #684). The configuration difference is a line difference in the browser; `PUT …/config` still checks the file and `expected_version` (#683). The services and their permission checks are unchanged.
- Never in the dashboard: merging, approving or requesting changes at G7, editing append-only rows, entering secrets, a self-grant, getting around a refusal, showing a new API token (MVP1-UI-SCOPE §4).

### 2.2. Sign-in and session (QUESTIONS #375)

- **GitHub OAuth through the platform's GitHub App** (the same App as the poller), with a random `state` and PKCE (S256) kept server-side together with the chosen tenant (10 minutes, used once).
- **Login CSRF:** a short-lived pre-login cookie `__Host-sdlc_oauth` (`HttpOnly`, `Secure`, `SameSite=Lax`, about 10 minutes) holds the hash of `state` and the PKCE verifier; the callback needs both, and deletes the cookie whatever the result. `Lax`, because the redirect back from `github.com` is a cross-site top-level navigation that never carries a `Strict` cookie.
- The api reads the person's **numeric GitHub account ID** and **drops the GitHub user token at once**: never stored, logged or used to act on GitHub.
- The user is the active user with a **linked** identity (tenant, `github`, numeric ID) in `user_identities`. Every other case gets the same refusal.
- The App's **client secret** lives in OpenBao at `kv/api/github-oauth`, readable by the `api` AppRole only. The App lists the callback URLs (localhost, and the V09 origin). This changes V03, which dropped the client secret; U05 does it.
- At sign-in the api always makes a **new session ID and secret**; a cookie that existed before is never reused or upgraded (its row, if any, is revoked).
- A **server-side session** in a new table `web_sessions` (D-05): only the SHA-256 of the session secret and of its CSRF token, the tenant, the user, timestamps, the idle expiry (default 30 minutes) and the absolute expiry (default 8 hours), and `revoked_at`. The cookie is `__Host-sdlc_session; HttpOnly; Secure; SameSite=Strict; Path=/`.
- A session is revoked at sign-out, when the user is disabled, when the identity is unlinked, and by a tenant admin. A person can **sign out everywhere** (all their sessions); a tenant admin can do it for a person. Audit `web_session.started`, `web_session.ended` (reason code, `all` for sign out everywhere).
- The guard accepts a bearer token **or** a session cookie, never both. The personal-token sign-in of ADR-M54 stays for read-only use.
- Company single sign-on (OIDC) stays Later.

### 2.2b. As built by U05 (QUESTIONS #385–#389)

- **Settings** (all off by default): `SDLC_API_WEB_SIGNIN` (`off`, `github`), `SDLC_API_PUBLIC_ORIGIN` (required with `github`; `https://`, or `http://` on `localhost` only, never `127.0.0.1`), `SDLC_API_SESSION_IDLE_MINUTES` (30, 5–120), `SDLC_API_SESSION_MAX_HOURS` (8, 1–24), `SDLC_API_GITHUB_WEB_URL`, `SDLC_API_GITHUB_OAUTH_SECRET_PATH` (`api/github-oauth`). In development mode (no OpenBao) sign-in stays off.
- **Endpoints** (no business state): `GET /v1/auth/config`, `GET /v1/auth/github/start?tenant=<slug>`, `GET /v1/auth/github/callback`, `POST /v1/auth/sign-out`, `DELETE /v1/me/sessions` (sign out everywhere), `DELETE /v1/admin/users/:user/sessions` (a tenant admin; CLI `sdlc admin user sign-out`). A refusal redirects to `/dashboard/?signin=refused` (or `unavailable` when GitHub or the client secret cannot be used); the cause is logged as a code only. Start and callback are rate-limited per address.
- **Pending sign-ins** live in the api process's memory (#385): keyed by the SHA-256 of the pre-login cookie's random handle, 10 minutes, used once whatever the result, at most 10,000. The cookie holds the handle only.
- **The GitHub user token** is revoked right after the account ID is read (`DELETE /applications/{client_id}/token`, #388); a failed revoke is logged as a code.
- **Before U06, a session only reads** (#387): `GET`, `HEAD`, plus sign out and sign out everywhere with an `Origin` equal to the public origin (and `Sec-Fetch-Site: same-origin` when sent). Every other write answers 403 `session_write_not_allowed`. A request with a bearer token and a session cookie answers 400 `credentials_ambiguous`. With sign-in off, a session cookie is ignored.
- **`web_sessions`** (D-05 1.41): hashes, IDs and times only; the CSRF token's hash comes with U06 (#386). **No DELETE for `platform_app`** (Harry, 2026-10-10): ended and expired rows stay; removing them is a later retention-loop task with its own grant.
- **Security review** (before PR 1): the callback does the GitHub round trip before it looks up the tenant (no tenant enumeration by timing); an ended session is not counted against the address and its 401 deletes the cookie; start and callback have their own limits per address (20, 30 a minute); a full pending map drops its oldest entry; only a matching state uses a pending sign-in up; a callback error redirects (`unavailable`). Accepted: a link opened in the person's browser can cancel their pending sign-in (the pre-login cookie is deleted at every callback, as above); the person signs in again. **WebKit on `http://localhost` (U05 PR 2, 2026-10-12, Playwright WebKit 26.6):** it keeps no `Secure` cookie there, so the GitHub sign-in is refused: the known limit of §4, now confirmed for WebKit; a test pins it. **`http://localhost` is for development only:** cookies are not scoped by port, so another local server on `localhost` sees and can set them; teams use the V09 HTTPS origin.
- **The client secret**: `pnpm github-app:create` keeps it in `<key file>.client-secret` (mode 600) and lists the callback URLs (`--callback-url`, default `http://localhost:8090/v1/auth/github/callback`); `pnpm openbao:bootstrap api-github-oauth-credentials` stores it at `kv/api/github-oauth` (runbook T11 §5n). The api reads it again within 10 minutes of a rotation. `pnpm trial:up` leaves sign-in off (#389).

### 2.3. CSRF and origin (QUESTIONS #377)

- Every write with a session cookie needs all three: `SameSite=Strict`; the session's CSRF token in the header `X-SDLC-CSRF`; `Origin` equal to `SDLC_API_PUBLIC_ORIGIN` (and `Sec-Fetch-Site: same-origin` when the browser sends it). Bodies are `application/json` only.
- Actions are **off by default** (`SDLC_API_DASHBOARD_ACTIONS=off`). They may be turned on only on `http://localhost` or behind the V09 TLS proxy: the api refuses to start with actions on and no public origin, or a plain `http://` origin on another host.
- Bearer requests (CLI) are unchanged.

### 2.3b. As built by U06 (QUESTIONS #410)

- **The CSRF token** is HMAC-SHA256 of the label `sdlc-csrf-1` with the session secret as the key (base64url). The api gives it to the page from the session cookie (`GET /v1/auth/session`: `csrf_token`, `signed_in_at`, `actions`; no-store; a token caller gets 404); `web_sessions.csrf_sha256` holds its SHA-256 (migration `0028-dashboard-writes`). A session made before U06 has none: it reads, and writes nothing until the person signs in again.
- **One rule in the guard.** A route takes session writes only when marked `@SessionAction('always')` (sign out, sign out everywhere) or `@SessionAction('actions')` (passkeys, the step-up; the decisions with U07); every other write answers 403 `session_write_not_allowed`. L05 adds four evaluation plan actions as a named exception before U07 (ADR-M82 §2.7, QUESTIONS #470). With actions off, `'actions'` routes answer 403 `dashboard_actions_off`. Every session write needs `Origin` = the public origin, `Sec-Fetch-Site: same-origin` when sent, the token in `X-SDLC-CSRF` (constant-time compare of hashes) and a JSON body or none (`text/plain` and forms refused: 403 `csrf_refused`, or 415 before the guard); answers are `no-store`.
- **The setting** `SDLC_API_DASHBOARD_ACTIONS` (`off`, `on`): `on` with `SDLC_API_WEB_SIGNIN=off` refuses to start (`api.settings.actions_need_signin`); the public origin rules of §2.2b (`https://`, or `http://` on `localhost` only) then cover actions too. `GET /v1/auth/config` gains `actions`.

### 2.4. Passkey step-up (QUESTIONS #376)

- Every gate decision, escalation decision and admin change needs a **passkey assertion** (WebAuthn) made for that one request. The challenge is **random** (32 bytes, made by the server, never derived from the request), **stored server-side with the action it is bound to** (the session, the action, the intent or escalation, the gate, the decision and `expected_input_sha256`), lives about 2 minutes and is **used once**: marked used in the same transaction as the decision. A request that differs from the stored action is refused. A kill and an acknowledgement need none.
- Registering a passkey needs a GitHub sign-in in the last 5 minutes. A new table `webauthn_credentials` (D-05) holds the credential ID, the public key, the counter, the tenant, the user, `created_at`, `revoked_at`; no free text. Audit `passkey.registered`, `passkey.revoked`.
- Library: `@simplewebauthn/server` and `@simplewebauthn/browser` (MIT), pinned exactly by U06 to a version at least two weeks old: **`@simplewebauthn/server` 14.0.3** (2026-09-25; in the api only, never in core) and **`@simplewebauthn/browser` 14.0.0** (2026-09-02; in the dashboard, U06 PR 2).
- WebAuthn refuses an IP address as its site name: on a developer machine the dashboard is opened at `http://localhost:8090`.

### 2.4b. As built by U06 (QUESTIONS #411–#414)

- **Ceremonies** (`apps/api/src/passkeys/webauthn.ts`): the site name is the public origin's host name and the expected origin is that origin; user verification **required**; attestation `none`; algorithms EdDSA, ES256, RS256 only (never the library's post-quantum default); 2 minutes to answer. The library's error text never reaches the client: `passkey_refused` (400) and a logged code.
- **Tables** (D-05 1.42, migration `0028-dashboard-writes`): `webauthn_credentials` (trigger `SDA20`: the counter and the last use only grow, revoked once) and `passkey_challenges` (trigger `SDA19`: only `used_at`, once, before the expiry). Only the challenge's SHA-256 is stored. **No DELETE** on either (QUESTIONS #412). At most 10 active passkeys a person and 5 open challenges a session.
- **Endpoints** (no business state): `GET /v1/me/passkeys` (token or session), `POST /v1/me/passkeys/registration-options` and `POST /v1/me/passkeys` (a session, within 5 minutes of its GitHub sign-in), `DELETE /v1/me/passkeys/:id`, `POST /v1/auth/step-up`, `GET /v1/admin/users/:user/passkeys` and `DELETE /v1/admin/users/:user/passkeys/:id` (tenant admins, never from a session until wave 3; CLI `sdlc admin passkey list|revoke`, QUESTIONS #414). The POST endpoints are limited to 30 a minute per address.
- **The binding** (QUESTIONS #411): a step-up names the action (`gate.decide` with an intent and a gate, `escalation.decide` with an escalation), the decision, the optional `expected_input_sha256` and the decision's body; the api stores `request_sha256`, the SHA-256 of the RFC 8785 canonical JSON of that body. The intent or escalation must be one the caller can read.
- **The use** (for U07): the decision endpoint calls `PasskeysService.verifyStepUp` (the challenge open and the session's, the passkey active and the caller's, the signature and the counter), then core `consumeStepUp` in the decision's transaction: one conditional update that matches every bound column marks the challenge used, and the counter moves in the same transaction. Every refusal is 403 `step_up_refused`. **U06 opens no business endpoint to sessions:** decisions, kills and acknowledgements stay 403 `session_write_not_allowed` until U07 marks and wires them.
- **Administration changes** (U09, QUESTIONS #685): one action code per area: `admin.project`, `admin.user`, `admin.tenant_admin`, `admin.agent`, `admin.ai_record`, `admin.evidence_hold`, `admin.passkey`. The decision names the change (`create`, `update`, `archive`, `role_grant`, `role_revoke`, `config`, `disable`, `enable`, `identity_link`, `identity_unlink`, `sessions_end`, `grant`, `revoke`, `register`, `approve`, `suspend`, `quarantine`, `owner`, `recertify`, `save`, `hold`, `release`). No intent, escalation, gate or input hash; the request SHA-256 covers the body without `step_up`, plus `decision` and `target`, the path the change writes to (for example `/v1/admin/projects/web/roles/<id>`). A body-less change (a `DELETE`, an archive) sends `{ "step_up": … }`. The api helper `admin/step-up.ts` checks the answer, then consumes the challenge and makes the change in one transaction; a refused change leaves the challenge unused. A token never sends `step_up` (the strict body schemas refuse it). No migration: `passkey_challenges.action` is a code (D-05 1.69).
- Audit `passkey.registered` (no field) and `passkey.revoked` (`reason` `self`, `admin`); entity the user.

### 2.5. The two-person rule and the binding (QUESTIONS #378)

- The API decides with the same handlers (`decideGate`, the escalation services, `requestRunKill`). The browser has no rule set; it only hides buttons from `waiting_for` and `/v1/me`, and shows the API's refusal.
- An optional field **`expected_input_sha256`** on gate decisions: a different current input → 409, nothing recorded. The current gate input hash becomes a read-only field of the intent's `GET` answer, resolved by the workflow's own function (as `waiting_for`, ADR-M54 §2.4). FR-17 is unchanged.

### 2.6. Audit

- The actor stays the person's user ID (`human`).
- A new source code **`web`** in `gate_decisions.source` and in the kill source (D-05, migration in U07).
- No session or passkey credential ID in an append-only table.

### 2.7. Unchanged

- The CSP of ADR-M54 §2.3: `connect-src 'self'` covers the calls; WebAuthn needs no CSP change; actions are `fetch` calls, so `form-action 'none'` stays. The GitHub redirect is the api's `302`.
- Server text as text, never HTML; every label from the catalog; rate limits per session as per token, and per address on sign-in, callback and passkey endpoints.

## 3. Alternatives considered

| Option | Why not |
|---|---|
| Keep the pasted personal token, in memory, for writes too | No session control, no step-up, and a long-lived secret in the page; refused by D-08 V11 AC2 |
| Exchange the personal token once for a session cookie | Simpler, but people still paste a long-lived secret; kept only as a fallback idea if GitHub sign-in cannot be used (MVP1-UI-SCOPE §9) |
| Company OIDC first | Not needed for the open project; Later |
| Sessions in Valkey | Lost on restart and outside the tenant guard; PostgreSQL keeps both |
| SameSite alone against CSRF | One layer only |
| "Recent sign-in" as the step-up | GitHub does not force a new password entry, so it proves little |
| Re-typing the personal token as the step-up | A long-lived secret typed often; weaker than a passkey |
| New write endpoints for the dashboard | A second path could drift from the CLI and comment rules |
| Revising ADR-M54 | ADR-M54 stays the record of the read-only decision (QUESTIONS #379) |

## 4. Consequences and gaps

- People decide gates and escalations in the page, with the same rules as the CLI and comments, and the audit shows `web`.
- Two new tables and a few new settings; the GitHub App needs a client secret (one more secret in OpenBao).
- A person without a passkey can read and kill but not decide in the page; they use the CLI or a comment.
- Passkeys registered on `localhost` do not work behind V09 (another site name); people register again there.
- Until V09, only someone on the machine of the stack can use the actions.
- Safari may refuse `Secure` (and `__Host-`) cookies on `http://localhost`. U05 tests Safari, Chrome and Firefox; if Safari refuses, it is a known limit (use Chrome or Firefox on `localhost`, Safari behind V09); the cookie rules are never weakened.
- Revised from `design/M-E-REPORT.md` (MVP1-UI-SCOPE §9): the order of the waves, the sign-in, the step-up method (never removed for approvals).

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 1.3 | 2026-10-12 | Claude (task U06, PR 1), approved by Harry | §2.3b, §2.4b: U06 as built: the CSRF token derived from the session secret, one guard rule for session writes, the actions setting, the ceremonies, the two tables, the endpoints, the binding with the request's hash, the use in the decision's transaction for U07; the library versions (QUESTIONS #410–#414) |
| 1.7 | 2026-11-12 | Claude (task U09, PR 1), approved by Harry in the U09 plan | §2.1, §2.4b: the administration changes of wave 3 take a session write, always with the passkey step-up; one action code per area; tokens and the tool register stay CLI-only (QUESTIONS #681–#685) |
| 1.6 | 2026-10-29 | Claude (task U08) | §2.1: U08 as built: the three wave 2 routes take a session write, with no step-up; meaning unchanged |
| 1.5 | 2026-10-15 | Claude (task L05, PR 5) | §2.4b: the step-up actions `eval_plan.create`, `eval_plan.change`, `eval_plan.run` (no intent or escalation; the request SHA-256 names the plan or project) are the first used (ADR-M82 §2.7) |
| 1.4 | 2026-10-14 | Claude (task L05, PR 1) | §2.3b: the four evaluation plan actions of L05 as a named exception before U07 (ADR-M82 §2.7, QUESTIONS #470) |
| 1.2 | 2026-10-12 | Claude (task V09, PR 1) | Wording only: the "Related" row links ADR-M67 (no longer "not written yet"); meaning unchanged |
| 1.1 | 2026-10-10 | Claude (task U05), approved by Harry | §2.2b: U05 as built: settings, endpoints, pending sign-ins in memory, the user token revoked, reads only before U06, no DELETE on `web_sessions`, the client secret's path (QUESTIONS #385–#389) |
| 1.0 | 2026-10-10 | Claude (task V11, design PR), accepted by Harry | First version, from `design/MVP1-UI-SCOPE.md` 1.0 and Harry's review in 1.1 (QUESTIONS #375–#380): login CSRF with a pre-login cookie, a new session ID at sign-in, sign out everywhere, a random stored single-use passkey challenge, the proposal download in the CLI only, the Safari limit |
