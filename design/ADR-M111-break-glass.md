# ADR-M111. Break-glass: audited emergency access for a production P0 incident

| Item | Value |
|---|---|
| Status | **Proposed** (2026-11-15). Plan approved by Harry on 2026-11-15 (QUESTIONS #741–#744); PR 1 is this ADR; PR 2–PR 4 build it |
| Date | 2026-11-15 |
| Decided by | Harry (to accept); H08 builds it |
| Related | D-08 H08 (AC1–AC5); D-02 FR-41, FR-44, NFR-03; handbook Ch.6 §6.7, §6.9, §6.11; codes table §2.1, §4, §5, §6.3; ADR-M28 (escalations); ADR-M34 (budgets); ADR-M41 (G7 producers); ADR-M42 (kill switch); ADR-M49 (G8); ADR-M54 (waiting reasons); ADR-M101 (operational alerts); ADR-M110 (row-level security); CLAUDE.md R028–R031, R044–R047; QUESTIONS #731, #741–#744 |

## 1. Context

Handbook Ch.6 §6.9 allows **break-glass**: access or actions outside the normal rules when a production emergency needs them. It sets eight requirements: short-lived with automatic expiry, limited scope, only the named operator, a second approver (leadership or Person B), an incident created automatically, immutable audit, a post-incident review within 48 hours, and revocation at once.

The platform must enforce these rules without breaking the rules that hold at every level (codes table §2.1, §4; CLAUDE.md R028):

- a person merges at G7; the platform never merges or deploys;
- three things are never skipped: permission before dangerous actions, independent verification, human approval of high-risk effects;
- agents never change their own permissions and never approve their own output.

QUESTIONS #731 (Harry, 2026-11-15) fixed the frame: design first; the reason is a GitHub comment link, never words in the audit log; the approver is leadership or Person B and never the producer; an escalation with Critical severity stands in for the incident, because the incident module is still in "Also later".

So break-glass on this platform does not open doors that the platform itself never opens. It removes **waiting** that is safe to remove in an emergency, for one intent, for a few hours, under a second person's approval.

## 2. Decision

### 2.1. The grant

A break-glass **grant** belongs to one open intent. It is a row in a new table `break_glass_grants` (PR 2, migration after ADR-M110's migration 0060, so expect 0061):

| Column | Content |
|---|---|
| `id`, `tenant_id`, `intent_id` | IDs (R026) |
| `operator_id` | The requester: the only person whose actions use the grant (not transferable) |
| `approver_id` | Null until approved |
| `scopes` | Scope codes (§2.2), at least one |
| `status` | `requested`, `active`, `refused`, `revoked`, `expired`, `lapsed` |
| `requested_at`, `decided_at`, `expires_at`, `ended_at` | Times |
| `reason_url` | `https://` link to a GitHub comment on the intent's issue or pull request that explains the incident in words |
| `review_url` | `https://` link to the post-incident review comment; null until recorded |
| `escalation_id` | The stand-in incident (§2.6) |

- The row holds codes, IDs, times and links only, as lessons do (R156). The words stay on GitHub, where they can be edited or deleted (R030).
- A link is checked as for lessons (QUESTIONS #729): it names a comment of the intent's issue or pull request in the project's repository, and the comment exists.
- The row is mutable only along the status moves of §2.5 (a trigger refuses other moves). The history is the audit log (§2.7).
- The table gets row-level security and both policies of ADR-M110 §2.1 in its migration.
- At most one grant per intent is `requested` or `active` at a time.

### 2.2. What a grant may change (scopes)

A closed list of scope codes in `@sdlc/contracts` (QUESTIONS #741). A project allows a subset in its configuration (`break_glass.allowed_scopes`, default: all three); a request names one or more allowed scopes.

| Scope | Effect while the grant is active | Limit |
|---|---|---|
| `runner_priority` | The intent's queued runs are offered to a runner before other queued runs and before evaluation runs | Never stops or pre-empts a run that is already running; the concurrency limit is unchanged (R041) |
| `budget` | One increase of the intent's run budget, by the amount named in the request | At most `break_glass.max_budget_increase_usd`; the approval is the decision that names `budget_increase` with an amount (R045); budgets only go up |
| `hotl_window_skip` | Ends the open HOTL block windows of G2 and G3 at once, so a run may start (`hotlBlockWindowOpenUntil`, R046) | Only for a gate that passed as HOTL; never touches a HITL gate |

The effects apply only to actions of the operator (runs the operator starts or allows). A run started by another person does not use the grant.

### 2.3. What a grant never changes

These hold whatever the scope, and PR 2–PR 3 test each one (AC5):

- **G1, G7 and G8 decisions.** G7 still needs the review of Person B (and the second approver where the change flags require one); a person merges (R028). G8 still needs its HITL decision.
- **G6.** The checks run; security findings at or above the configured severity still go to HITL (codes table §4).
- **G4 and permissions.** The policy check, the tool list, `max_autonomy` and the data class are unchanged. Break-glass never raises autonomy (codes table §2.1).
- **G2 and G3 HITL.** A HITL G2 or G3, and every forced HITL G3, still waits for a person.
- **Escalation freezes, kills and suspensions.** A frozen intent stays frozen until a person decides; a kill stays a kill (R052); a suspended or quarantined agent stays so.
- **Producer rules.** The producers of ADR-M41 and ADR-M49 still never decide.
- **Who may invoke it.** Only people with a personal token. Agents, run tokens, the GitHub App and bots never request, approve or revoke; there is no GitHub comment command.

### 2.4. Who

| Action | Who | Refused |
|---|---|---|
| Request | Person A or Person B of the intent's project | Viewer; agents and bots |
| Approve or refuse | `governance` (leadership) or `person_b` of the project | The requester (rule M21: two different people); any producer of the intent (creator, every run's `triggered_by`, plan submitters, commit authors; ADR-M41); agents and bots |
| Revoke | The operator, the approver, any `person_b` or `governance` of the project, or an operator on the server as `system` | Viewer; agents and bots |
| Record the review | Person A or Person B of the project | Agents and bots |

Revoking is containment, like a kill (QUESTIONS #180): it is never frozen and needs no second person.

### 2.5. Time and status

```text
requested ──approve──▶ active ──revoke──▶ revoked
    │                    └──expiry──▶ expired
    ├──refuse──▶ refused
    └──no decision in request_ttl_minutes──▶ lapsed
```

- `break_glass.max_hours`: default 4; mandatory rule: between 1 and 8 ("maximum a few hours", Ch.6 §6.9). A request asks for a duration up to this value; `expires_at` = approval time + duration.
- `break_glass.request_ttl_minutes`: default 30. An emergency request that waits longer lapses; the operator asks again.
- Every read that uses a grant checks `status = 'active' AND expires_at > now()`, so an expired grant has no effect even before the loop below runs.
- A plain worker loop (R044, never a Temporal timer or schedule) moves due rows to `expired` or `lapsed` and writes the audit event once.
- A run already started under the grant is not stopped at expiry; nothing new starts under it.

### 2.6. The stand-in incident (QUESTIONS #744)

On approval, in the same transaction, the platform raises an escalation (ADR-M28):

- trigger `break_glass` (a new `EscalationTrigger`), severity `critical`, route `policy` (owner: governance, from the routing configuration);
- response level `notify`: **not freezing**, otherwise break-glass would freeze the intent it is meant to help;
- packet: the grant ID, the scope codes and the reason link (the one link the packet allows);
- the producers of the intent as producers, so they never acknowledge or decide it.

Its code (`ESC-YYYY-NNNN`) is the **incident code** of the grant and of its audit events. It follows the Critical SLA of codes table §6.3 (15 minutes to acknowledge, told to the roles in `notify_on_raise.critical`). It can close only when the review is recorded (§2.8). When the incident module comes ("Also later"), it replaces this escalation; the grant then links the incident.

### 2.7. Audit events

Declared in `audit/actions.ts` (R075), entity `break_glass_grant`, fields of the strict kinds only:

| Action | Fields |
|---|---|
| `break_glass.requested` | `intent_id`, `operator_id`, `scopes`, `duration` (count, seconds) |
| `break_glass.approved` | `intent_id`, `approver_id`, `incident` (code), `scopes`, `expires_in` (count, seconds), `budget_increase_usd` (decimal, optional) |
| `break_glass.refused` | `intent_id`, `approver_id` |
| `break_glass.revoked` | `intent_id`, `revoked_by` (uuid, optional: absent for `system`) |
| `break_glass.expired`, `break_glass.lapsed` | `intent_id` |
| `break_glass.reviewed` | `intent_id`, `incident` (code) |
| `break_glass.review_overdue` | `intent_id`, `incident` (code) |

Never the reason, a link, a comment text or a name (R030, R031). Temporal carries no grant data: the workflow is woken with the intent ID only.

### 2.8. Post-incident review and G8

- The review is a GitHub comment; a person records its link with `review` (§2.9).
- **G8 cannot pass** while the intent has a grant that was ever `active` and has no `review_url`. The G8 step returns a new waiting reason `break_glass_review` (ADR-M54: its `IntentWaitReason`, catalog label, `api-schemas` map and `adlc next` rule, R047).
- 48 hours after the grant ended (revoked or expired) without a review, the worker loop writes `break_glass.review_overdue` once and sends a notice to Person A, Person B and governance. The stand-in escalation stays open.
- Recording the review closes the stand-in escalation.

### 2.9. Interfaces (QUESTIONS #742)

People act through the API with their personal token, so every action has a person as actor (rule M21 needs two people; `adlc ops` runs as `system` and cannot tell them apart):

| Command | API |
|---|---|
| `adlc break-glass request <INT> --scope <code>[,<code>] --hours <n> --reason <comment-url> [--budget-increase <usd>]` | `POST /v1/intents/{code}/break-glass` |
| `adlc break-glass approve <INT>` / `refuse <INT>` | `POST …/break-glass/approve`, `…/refuse` |
| `adlc break-glass revoke <INT>` | `POST …/break-glass/revoke` |
| `adlc break-glass review <INT> --comment <url>` | `POST …/break-glass/review` |
| `adlc break-glass list [--project <p>] [--active]` | `GET /v1/break-glass` |

- `adlc ops break-glass list|revoke` (as `system`, SDLC_DB_URL) stays for when the API is down: listing and containment only, never request or approve.
- All user-facing text goes through `@sdlc/messages` (R014).
- The dashboard shows active grants read-only in a later task; it gets no session action in H08 (R085).

### 2.10. Operational alert (QUESTIONS #743)

- A new doctor check `break_glass.active`: one `warning` line per active grant, subject = the grant ID, text with the intent code and the expiry time only. `pnpm alerts` (ADR-M101) sends a line when it is new, so **every approval** is sent on the next alert run, and a "resolved" line when the grant ends.
- The check reads every tenant. Under ADR-M110 it loops over the tenants and sets the tenant per transaction, like the other cross-tenant work (QUESTIONS #733); it never uses a role with `BYPASSRLS`.
- The alert interval is the O03 timer; the Critical escalation (§2.6) is the fast channel to people.

### 2.11. Configuration

New section `break_glass` in the project configuration (ADR-M18; values in config, not code):

```yaml
break_glass:
  enabled: true
  allowed_scopes: [runner_priority, budget, hotl_window_skip]
  max_hours: 4                    # mandatory rule: 1–8
  request_ttl_minutes: 30
  max_budget_increase_usd: "50.00"
  review_due_hours: 48            # mandatory rule: at most 48 (Ch.6 §6.9)
```

Mandatory rules (`mandatory-rules.ts`): `max_hours` 1–8; `review_due_hours` 1–48; the request, approve and review roles are fixed by §2.4 and are not configurable (they follow Ch.6 §6.9 and rule M21).

## 3. Alternatives not chosen

| Option | Why not |
|---|---|
| Break-glass lets an intent pass blocking gates (GitHub issue #519) | Codes table §4: permission before dangerous actions, independent verification and human approval of high-risk effects are never skipped; every merge is HITL (QUESTIONS #731) |
| A `--reason <text>` stored in the audit log | The audit log is kept at least 2 years and never edited (R030, R031) |
| A "Tech Director" approver role | Not a 2+N role (codes table §5); leadership is `governance` |
| `adlc ops break-glass` for every action | Runs as `system`: cannot prove two different people (rule M21) |
| A freezing response level for the stand-in escalation | Would freeze the intent that break-glass is meant to help |
| A Temporal timer for the expiry | R044: clocks live in rows and plain worker loops |
| A grant for the whole project or tenant | Ch.6 §6.9 "limited scope": one intent, named scopes |

## 4. Consequences

- Break-glass speeds up an emergency fix only where waiting is not a safety control: the runner queue, the budget, HOTL objection windows. A team that needs more (a merge, a deploy) does it outside the platform, under its own production break-glass process; the platform records nothing it did not do.
- One new table, one new escalation trigger, one new waiting reason, one new doctor check, seven audit actions.
- Handbook Ch.18–20 usage sections describe the commands (PR 3). Handbook Ch.6 is unchanged.

### 4.1. Pull requests

| PR | Content |
|---|---|
| PR 1 | This ADR; QUESTIONS #741–#744; number blocks (docs only) |
| PR 2 | After ADR-M110's PR 2 is merged: migration (table, status trigger, RLS policies, `migrations.lock.json`), contracts (scopes, trigger, configuration and mandatory rules), core module `break-glass` (request, approve, refuse, revoke, expire, lapse, review, `activeGrant`), audit actions, messages, tests |
| PR 3 | API routes, `adlc break-glass …`, `adlc ops break-glass list|revoke`, the worker loop, the G8 waiting reason, the three scope effects, handbook Ch.18–20, CHANGELOG |
| PR 4 | Doctor check and alert, deploy README, `platform/DEVELOPMENT.md`, `design/RULES.md` rows and the `CLAUDE.md` rule line |

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-11-15 | Claude (task H08, PR 1) | First version, from the plan Harry approved on 2026-11-15 (QUESTIONS #741–#744) |
