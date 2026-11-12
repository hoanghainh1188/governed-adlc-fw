// Audit actions and their declared payload fields (ADR-M09 section 2.8).
//
// The audit log is never deleted and is kept at least 2 years (D-05 section 10, FR-44), so data
// written there can never be erased. Payloads therefore hold **only IDs, codes, hashes and
// versions**: never personal data, client data, free text, config text or record contents.
// `append` accepts only the fields declared here for the action, each with a strict format, and
// the canonical payload must fit in `MAX_AUDIT_PAYLOAD_BYTES`.
//
// Adding an action: add it below with the smallest set of fields that makes the event
// traceable, and a test. Reviewers check that no field can carry personal or client data.
// A field whose kind ends with `?` is optional (ADR-M20): it may be left out, never set to null;
// when present it follows the same format rule.
import { isUsd } from '../cost/money.js';
import { DbError } from '../db/errors.js';
import { isUuid } from '../db/tenant-id.js';

/**
 * - `uuid`: a platform ID (lowercase UUID)
 * - `sha256`: a lowercase hex SHA-256 digest
 * - `version`: a positive integer
 * - `code`: a short code such as `G3`, `INT-2026-0001` or an enum value (no spaces, max 64)
 * - `codes`: a list of 1 to `MAX_AUDIT_CODES` codes (B13: the warning codes of `config.changed`)
 * - `decimal`: an amount of money in USD as a decimal string with at most 6 decimals (C07)
 * - `count`: a count or a duration in seconds, an integer of 0 or more (E03, `intent.closed`)
 */
export type AuditFieldKind = 'uuid' | 'sha256' | 'version' | 'code' | 'codes' | 'decimal' | 'count';

/** A declared field: its kind, with a trailing `?` when the field is optional. */
export type AuditFieldSpec = AuditFieldKind | `${AuditFieldKind}?`;

export interface AuditActionSpec {
  /** Entity the event is about; null for events without one. `entity_id` is then null too. */
  readonly entityType: string | null;
  readonly fields: Readonly<Record<string, AuditFieldSpec>>;
}

export const AUDIT_ACTIONS = {
  /** A tenant was created by the one-time bootstrap (B03, ADR-M26). Never its slug or name. */
  'tenant.created': { entityType: 'tenant', fields: {} },
  /** A user was created (B03 bootstrap). Never the name or e-mail address. */
  'user.created': { entityType: 'user', fields: {} },
  /** A personal API token was issued (B03). Never the token or its hash; the token ID is the entity. */
  'api_token.issued': { entityType: 'api_token', fields: { user_id: 'uuid' } },
  /** A personal API token was revoked (B03). Written once, on the first revocation. */
  'api_token.revoked': { entityType: 'api_token', fields: { user_id: 'uuid' } },
  /**
   * A project configuration was created or replaced (FR-14, ADR-M13). Never the config text.
   * B13 (ADR-M37): `override_sha256` (the stored YAML), the `cause` (`upload`, `defaults_changed`)
   * and the loosening warnings as `<warning>:<path>` codes, with their count (D-08 B13 AC4).
   */
  'config.changed': {
    entityType: 'project',
    fields: {
      version: 'version',
      config_hash: 'sha256',
      override_sha256: 'sha256?',
      cause: 'code?',
      warning_count: 'version?',
      warnings: 'codes?',
    },
  },
  /** A project was created (B13). Never its slug, name or repository. */
  'project.created': { entityType: 'project', fields: { git_provider: 'code' } },
  /** A project's name, repository or default branch changed (B13). Never the values. */
  'project.updated': { entityType: 'project', fields: {} },
  /**
   * A project was archived (B13). Its evidence files are purged after the archive grace period by
   * the retention loop (E05, FR-44, ADR-M51); its time starts that period.
   */
  'project.archived': { entityType: 'project', fields: {} },
  /**
   * The retention loop, in `purge` mode, scheduled the purge of an archived project (E05, ADR-M51
   * §2.6): its evidence is purged `grace_days` after the later of this event and the archive.
   * Written once per archive, so a project archived before the purge was turned on still gets the
   * whole grace period, visible in the audit log.
   */
  'project.purge_scheduled': { entityType: 'project', fields: { grace_days: 'count' } },
  /**
   * The retention loop purged every evidence file of an archived project that is not held (E05,
   * FR-44, ADR-M51): counts of rows. Written once per project. `langfuse` (E08, ADR-M53): `purged`
   * (every finished, not held intent's traces are confirmed deleted), `not_deployed` (the worker's
   * Langfuse purge is off: `SDLC_WORKER_LANGFUSE_URL=off`), or `manual` in events written before
   * E08 (runbook T11 §5j).
   */
  'project.purged': {
    entityType: 'project',
    fields: { intents: 'count', purged: 'count', held: 'count', langfuse: 'code' },
  },
  /** A user's name or e-mail address changed (B13). Never the values. */
  'user.updated': { entityType: 'user', fields: {} },
  /** A user was disabled: their tokens stop working at once (B13). */
  'user.disabled': { entityType: 'user', fields: {} },
  /** A disabled user was enabled again (B13). */
  'user.enabled': { entityType: 'user', fields: {} },
  /**
   * A person signed in to the dashboard with GitHub (U05, ADR-M73 §2.2). The user is the entity;
   * never the session ID, the GitHub account ID or a login.
   */
  'web_session.started': { entityType: 'user', fields: { provider: 'code' } },
  /**
   * Dashboard sessions of a user ended (U05): `reason` is `sign_out`, `all` (sign out everywhere),
   * `admin`, `user_disabled`, `identity_unlinked`, `replaced` (a new sign-in in the same
   * browser) or `client_purged` (H03b); `count` how many. Never a session ID. The idle and absolute timeouts are not events.
   */
  'web_session.ended': { entityType: 'user', fields: { reason: 'code', count: 'count' } },
  /**
   * A person registered a passkey for the dashboard's step-up (U06, ADR-M73 §2.4). Never the
   * credential ID, the passkey's row ID or the session ID: the user is the entity.
   */
  'passkey.registered': { entityType: 'user', fields: {} },
  /** A passkey was removed (U06): `reason` is `self` or `admin` (QUESTIONS #414). */
  'passkey.revoked': { entityType: 'user', fields: { reason: 'code' } },
  /**
   * A Git host account was linked to a user (B13 AC3, QUESTIONS #45). Never the account ID or
   * login: the identity row is the entity.
   */
  'identity.linked': { entityType: 'identity', fields: { user_id: 'uuid', provider: 'code' } },
  /** A Git host account was unlinked (B13). */
  'identity.unlinked': { entityType: 'identity', fields: { user_id: 'uuid', provider: 'code' } },
  /** A project role was granted (B13, FR-11). The binding is the entity. */
  'role.granted': {
    entityType: 'role_binding',
    fields: { user_id: 'uuid', project_id: 'uuid', role: 'code' },
  },
  /** A project role was revoked (B13): `revoked_at` was set; the binding stays as history. */
  'role.revoked': {
    entityType: 'role_binding',
    fields: { user_id: 'uuid', project_id: 'uuid', role: 'code' },
  },
  /** A tenant role was granted (B13, QUESTIONS #150). */
  'tenant_role.granted': {
    entityType: 'tenant_role_binding',
    fields: { user_id: 'uuid', role: 'code' },
  },
  /** A tenant role was revoked (B13). */
  'tenant_role.revoked': {
    entityType: 'tenant_role_binding',
    fields: { user_id: 'uuid', role: 'code' },
  },
  /**
   * A project AI record was created or replaced (FR-19, B12, ADR-M32 §2.2). Codes, the version and
   * the hash of the coded record only; the allowed classes are in the hash and in
   * `project_ai_record_versions`. Never the link or anything from the human record.
   */
  'ai_record.changed': {
    entityType: 'project',
    fields: {
      version: 'version',
      record_sha256: 'sha256',
      ai_allowed: 'code',
      prod_logs_allowed: 'code',
      disclosure_format: 'code',
      consent: 'code',
      updated_by: 'uuid',
    },
  },
  /** An intent was created (FR-01, FR-03). Never the title or description. */
  'intent.created': {
    entityType: 'intent',
    fields: {
      code: 'code',
      project_id: 'uuid',
      risk_tier: 'code',
      data_class: 'code',
      max_autonomy: 'code',
    },
  },
  /** An intent moved to another status or gate. `current_gate` is left out when there is none. */
  'intent.state_changed': {
    entityType: 'intent',
    fields: { status: 'code', current_gate: 'code?' },
  },
  /**
   * A G5 `resume` decision with a budget increase raised the intent budget (task C07, QUESTIONS
   * #133): the amount added, the new intent budget, the run budget of the next runs and the
   * escalation whose decision allowed it.
   */
  'intent.budget_increased': {
    entityType: 'intent',
    fields: {
      escalation_id: 'uuid',
      added_usd: 'decimal',
      budget_usd: 'decimal',
      run_budget_usd: 'decimal',
    },
  },
  /**
   * A spec was linked to an intent (FR-02). Never the path or the content. B08 (ADR-M39): the
   * linked commit and the `cause`: `linked` (a person) or `head_changed` (the platform linked the
   * spec at the head of the default branch because its content changed there). S01 (ADR-M61):
   * the structure rule that matched and the number of acceptance criteria found; never their text.
   */
  'spec.linked': {
    entityType: 'intent',
    fields: {
      spec_ref_id: 'uuid',
      version: 'version',
      content_sha256: 'sha256',
      commit_sha: 'code?',
      cause: 'code?',
      structure: 'code',
      acceptance_criteria: 'count',
    },
  },
  /**
   * The linked spec cannot be read at the head of the default branch (B08, ADR-M39 §2.4): `cause`
   * is `missing`, `not_a_file`, `too_large` or `not_utf8`. Written once per spec version and cause;
   * the intent waits at G2 until a person links a spec that can be read. Never the path.
   */
  'spec.unavailable': {
    entityType: 'intent',
    fields: { spec_ref_id: 'uuid', cause: 'code', head_sha: 'code' },
  },
  /**
   * A plan was submitted for an intent. Never the file list or the summary. B09 (ADR-M40): the
   * commit the plan file was read at.
   */
  'plan.submitted': {
    entityType: 'intent',
    fields: { plan_id: 'uuid', version: 'version', plan_sha256: 'sha256', commit_sha: 'code?' },
  },
  /**
   * The plan file at the head of the default branch is no longer the submitted plan (B09,
   * ADR-M40 §2.4, QUESTIONS #167): `cause` is `changed` or why the file cannot be read (`missing`,
   * `not_a_file`, `too_large`, `not_utf8`). Written once per plan version and cause; G3 or G4 is
   * held until a person submits the plan again. Never the path or the content.
   */
  'plan.resubmit_needed': {
    entityType: 'intent',
    fields: { plan_id: 'uuid', cause: 'code', head_sha: 'code' },
  },
  /** A gate decision was recorded (FR-10, FR-17). Never a free-text reason (ADR-M20). */
  'gate.decided': {
    entityType: 'intent',
    fields: {
      decision_id: 'uuid',
      gate: 'code',
      decision: 'code',
      oversight_mode: 'code',
      input_sha256: 'sha256',
      config_hash: 'sha256',
      approver_role: 'code?',
      reason_code: 'code?',
      voids_decision_id: 'uuid?',
    },
  },
  /** A Run Contract was signed and stored for a new run (D-03 section 8, ADR-M22). */
  'run.contract_issued': {
    entityType: 'run',
    fields: {
      intent_id: 'uuid',
      attempt: 'version',
      contract_sha256: 'sha256',
      key_version: 'version',
    },
  },
  /**
   * The kill switch was used on a run (C11, D-02 FR-34, ADR-M42). The actor is the person (or
   * `system` for an operator). `previous_status` is the run status before; `source` is `api`,
   * `github_comment` or `ops`; `escalation_id` the escalation raised for the review.
   */
  'run.kill_requested': {
    entityType: 'run',
    fields: {
      intent_id: 'uuid',
      previous_status: 'code',
      source: 'code',
      escalation_id: 'uuid?',
    },
  },
  /**
   * G4 computed a new run proposal for the intent (task C06, ADR-M33 §2.3): the terms a G4
   * approval or pass is bound to. `input_sha256` is the G4 input hash; `base_sha` the commit of the
   * default branch the run would start from. Hashes, IDs and codes only; never the model name (it
   * may hold `/` or `@`, ADR-M31 §2.8), which the hash covers.
   */
  'run.proposed': {
    entityType: 'intent',
    fields: {
      input_sha256: 'sha256',
      base_sha: 'code',
      plan_id: 'uuid',
      agent_id: 'uuid',
      agent_version: 'code',
      instructions_sha256: 'sha256',
      autonomy_level: 'code',
    },
  },
  /**
   * A G4 check failed (task C06, ADR-M33 §2.4). The gate decision holds the reason code
   * (`gate_reason_code`); `check` is the exact cause, for example an agent register refusal
   * (`agent_not_active`, `model_not_allowed`) or `spec_changed`.
   */
  'gate.g4_check_failed': {
    entityType: 'intent',
    fields: { decision_id: 'uuid', check: 'code' },
  },
  /**
   * G5 failed for a run (task C07, ADR-M34 §2.8): the exact cause next to the gate decision's
   * reason code: `instructions_changed`, `secret_found`, `secret_scan_failed`, `out_of_scope`,
   * `max_budget`, `spend_at_stop`, `max_iterations`, `max_duration`, `stalled` or
   * `changes_missing` (H04 added the two secret checks, ADR-M93 §2.4). The run's plan is refused at G3
   * after `out_of_scope` (QUESTIONS #131). Never a path.
   */
  'gate.g5_check_failed': {
    entityType: 'intent',
    fields: { decision_id: 'uuid', check: 'code', run_id: 'uuid' },
  },
  /**
   * A person requested changes at G5 on a run whose change is over the review limits (H05,
   * ADR-M95 §2.5): the intent goes back to G3 to split the plan, and G3 is HITL from then on
   * (`returnedFromG5`). `decision_id` is the request for changes; `check` is `review_too_large` or
   * `review_size_unknown`. Never a path.
   */
  'gate.g5_split_requested': {
    entityType: 'intent',
    fields: { decision_id: 'uuid', check: 'code', run_id: 'uuid' },
  },
  /**
   * The pull request of the intent's agent branch was linked to the intent (C08, ADR-M38 §2.4):
   * the run whose push it shows, its number and the pushed head. Never its title, body or URL.
   */
  'intent.pr_linked': {
    entityType: 'intent',
    fields: { run_id: 'uuid', pr_number: 'version', head_sha: 'code' },
  },
  /**
   * G6 stopped before CI: the run's changes could not be pushed or the pull request not opened
   * (C08, QUESTIONS #156). `reason`: the runner's refusal code (`empty_diff`, `diff_mismatch`,
   * `branch_moved`…) or `publish_attempts` (too many failed attempts).
   */
  'gate.g6_publish_stopped': {
    entityType: 'intent',
    fields: { run_id: 'uuid', reason: 'code', escalation_id: 'uuid' },
  },
  /**
   * A G6 check failed (C08 PR 2, ADR-M38 §2.7): the exact cause next to the decision's reason
   * code: `ci_failed` (a retry), `ci_no_retries` (back to G3), `ci_timeout`, `ci_missing` (O06), `pr_closed`,
   * `pr_merged`, `branch_moved`, `critical_finding`.
   */
  'gate.g6_check_failed': {
    entityType: 'intent',
    fields: { decision_id: 'uuid?', check: 'code', run_id: 'uuid' },
  },
  /**
   * A G7 check failed (E01, ADR-M41 §2.5): `pr_closed`, `head_changed` (the pull request shows
   * another commit than the platform pushed), `merged_before_approval`, `merged_by_producer`
   * (a bot, a producer of the change or an unknown account merged it).
   */
  'gate.g7_check_failed': {
    entityType: 'intent',
    fields: { decision_id: 'uuid?', check: 'code', run_id: 'uuid', escalation_id: 'uuid?' },
  },
  /**
   * G7 passed (E01 AC5): a person merged the run's pull request with the approved head. The merge
   * commit, never the merger's account.
   */
  'intent.pr_merged': {
    entityType: 'intent',
    fields: { run_id: 'uuid', pr_number: 'version', head_sha: 'code', merge_commit_sha: 'code?' },
  },
  /** The runner refused the Run Contract of a known run; `reason` is a reject reason code. */
  'run.contract_rejected': { entityType: 'run', fields: { reason: 'code' } },
  /** An escalation was raised (FR-18, B11). Codes and IDs only, never the words of the package. */
  'escalation.created': {
    entityType: 'escalation',
    fields: {
      code: 'code',
      intent_id: 'uuid',
      trigger: 'code',
      route: 'code',
      severity: 'code',
      response_level: 'code',
      step: 'code',
      subject_sha256: 'sha256',
      run_id: 'uuid?',
      gate: 'code?',
    },
  },
  /** Nobody but producers holds any role of the route or governance (QUESTIONS #74). */
  'escalation.unrouted': { entityType: 'escalation', fields: { code: 'code' } },
  /** The holder of the current step was reminded (Ch.6 §6.5, QUESTIONS #75). */
  'escalation.reminded': { entityType: 'escalation', fields: { code: 'code', step: 'code' } },
  /** Nobody acknowledged in time: the escalation moved to the next step (Ch.6 §6.5). */
  'escalation.step_changed': {
    entityType: 'escalation',
    fields: { code: 'code', from_step: 'code', to_step: 'code' },
  },
  /** Governance, the last step, did not acknowledge in time either. Recorded once. */
  'escalation.ack_overdue': { entityType: 'escalation', fields: { code: 'code' } },
  /** The resolve deadline passed without a decision; governance takes over. Recorded once. */
  'escalation.resolve_overdue': {
    entityType: 'escalation',
    fields: { code: 'code', from_step: 'code' },
  },
  /** A Critical escalation passed its resolve deadline: the incident process is due (Ch.6 §6.7). */
  'escalation.incident_due': { entityType: 'escalation', fields: { code: 'code' } },
  /** A person acknowledged the escalation (B11 PR 2); `step` is where it was. */
  'escalation.acknowledged': { entityType: 'escalation', fields: { code: 'code', step: 'code' } },
  /** A person decided (T16 §4), bound to the reviewed hash. Never the reason text (a link only). */
  'escalation.decided': {
    entityType: 'escalation',
    fields: {
      code: 'code',
      decision: 'code',
      subject_sha256: 'sha256',
      reason_code: 'code?',
      budget_increase_usd: 'code?',
    },
  },
  /** A person moved the escalation to governance (`escalate_further`). */
  'escalation.escalated_further': {
    entityType: 'escalation',
    fields: { code: 'code', from_step: 'code' },
  },
  /** A decision expired or no longer matched the version acted on (Ch.6 §6.6); `reason` is a code. */
  'escalation.decision_voided': {
    entityType: 'escalation',
    fields: { code: 'code', reason: 'code' },
  },
  /** The escalation was closed; `status` is the status it had before. */
  'escalation.closed': { entityType: 'escalation', fields: { code: 'code', status: 'code' } },
  /**
   * An agent was registered (C10, ADR-M31). Never the model name (it may hold `/` and `@`) or the
   * owner; the instructions hash identifies the instructions version.
   */
  'agent.registered': {
    entityType: 'agent',
    fields: { agent_key: 'code', version: 'code', instructions_sha256: 'sha256', adapter: 'code' },
  },
  /** An agent got a new version: model, instructions, tools, autonomy or environments (Ch.20 §20.9). */
  'agent.updated': {
    entityType: 'agent',
    fields: { agent_key: 'code', version: 'code', instructions_sha256: 'sha256', adapter: 'code' },
  },
  /** An agent's status changed. `reason_code` is set for suspend, quarantine and retire. */
  'agent.status_changed': {
    entityType: 'agent',
    fields: { agent_key: 'code', from: 'code', to: 'code', reason_code: 'code?' },
  },
  /**
   * A person approved an agent's activation or retirement (B13 AC7, Ch.20 §20.7, §20.11), in a
   * capacity (`owner`, `person_a`, `person_b`, `governance`). The actor is the approver.
   */
  'agent.approval_recorded': {
    entityType: 'agent',
    fields: {
      agent_key: 'code',
      version: 'code',
      purpose: 'code',
      capacity: 'code',
      // L09 (ADR-M86 §2.7): the evaluation an activation named, and the result of its check.
      evaluation_id: 'uuid?',
      evaluation_result: 'code?',
    },
  },
  /** The agent's owner changed (the owner left, Ch.20 §20.8). Never who the owner is. */
  'agent.owner_changed': { entityType: 'agent', fields: { agent_key: 'code' } },
  /** An agent was recertified (Ch.20 §20.8), or certified by its first activation (ADR-M31 §2.6). */
  'agent.recertified': {
    entityType: 'agent',
    // L10 (ADR-M86 §2.6): the evaluation a recertification named and the result of its check.
    fields: { agent_key: 'code', evaluation_id: 'uuid?', evaluation_result: 'code?' },
  },
  /**
   * A run started with an agent whose recertification is overdue (FR-36: a warning, not a block).
   * Written by the G4 check of C06 (ADR-M31 §2.6).
   */
  'agent.recertification_overdue': {
    entityType: 'agent',
    fields: { agent_key: 'code', run_id: 'uuid?' },
  },
  /**
   * A tool was registered in the tool register (X04, ADR-M69 §2.2). Keys, versions, codes and the
   * image digest (`image_sha256`: the hex of `sha256:…`) only: never the image name (it may hold `/` and `:`) or the model name.
   */
  'tool.registered': {
    entityType: 'tool',
    fields: { tool_key: 'code', version: 'code', transport: 'code', image_sha256: 'sha256?' },
  },
  /** A tool got a new version: image, permissions, data classes, backing services or model. */
  'tool.updated': {
    entityType: 'tool',
    fields: { tool_key: 'code', version: 'code', transport: 'code', image_sha256: 'sha256?' },
  },
  /** A tool's status changed. `reason_code` is set for suspend, quarantine and retire. */
  'tool.status_changed': {
    entityType: 'tool',
    fields: { tool_key: 'code', from: 'code', to: 'code', reason_code: 'code?' },
  },
  /** A person approved a tool's activation or retirement, in a capacity (ADR-M69 §2.2). */
  'tool.approval_recorded': {
    entityType: 'tool',
    fields: { tool_key: 'code', version: 'code', purpose: 'code', capacity: 'code' },
  },
  /** The tool's owner changed. Never who the owner is. */
  'tool.owner_changed': { entityType: 'tool', fields: { tool_key: 'code' } },
  /** A tool was recertified, or certified by its first activation. */
  'tool.recertified': { entityType: 'tool', fields: { tool_key: 'code' } },
  /** A run got a tool whose recertification is overdue (a warning, not a block). */
  'tool.recertification_overdue': {
    entityType: 'tool',
    fields: { tool_key: 'code', run_id: 'uuid?' },
  },
  /**
   * An intent's Evidence Pack was built (E02, ADR-M48). The pack is the entity. Hashes and the
   * version only: never the pack's content, which names the approvers.
   */
  'evidence.pack_built': {
    entityType: 'evidence_pack',
    fields: {
      intent_id: 'uuid',
      version: 'version',
      content_sha256: 'sha256',
      manifest_sha256: 'sha256',
      markdown_sha256: 'sha256',
    },
  },
  /**
   * A stored evidence file failed its re-check while a pack was built (E02, ADR-M33 §2.9 gap 2):
   * `reason` `hash_mismatch`, `size_mismatch`, `missing` or `too_large`. A possible tampering
   * signal. The evidence item is the entity.
   */
  'evidence.check_failed': {
    entityType: 'evidence_item',
    fields: { intent_id: 'uuid', kind: 'code', reason: 'code' },
  },
  /**
   * A person downloaded an L1 proposal (C13, ADR-M64 §2.1): the run, the patch's hash and size,
   * checked before it was served. Never the content.
   */
  'evidence.proposal_read': {
    entityType: 'evidence_item',
    fields: { intent_id: 'uuid', run_id: 'uuid', sha256: 'sha256', size_bytes: 'count' },
  },
  /** A stored pack file failed its re-check when it was read (E02): `file` `manifest` or `markdown`. */
  'evidence.pack_check_failed': {
    entityType: 'evidence_pack',
    fields: { intent_id: 'uuid', version: 'version', file: 'code', reason: 'code' },
  },
  /**
   * G8 sealed one version of the intent's Evidence Pack (E03, ADR-M49 §2.4): the version, the
   * content hash and the release hash G8 approved. Never the pack's content.
   */
  'evidence.pack_sealed': {
    entityType: 'evidence_pack',
    fields: {
      intent_id: 'uuid',
      version: 'version',
      content_sha256: 'sha256',
      release_sha256: 'sha256',
    },
  },
  /**
   * The retention loop deleted every stored version of an evidence file (E05, ADR-M51). The intent
   * is the entity. `kind` `proposal`, `diff` or `pack` (with `pack_id` and `pack_version`, both
   * files); `cause` `retention` or `archive`; `versions` how many versions and delete markers were
   * deleted. The row and its hashes stay (D-05 §10.1).
   */
  'evidence.purged': {
    entityType: 'intent',
    fields: {
      item_id: 'uuid?',
      pack_id: 'uuid?',
      pack_version: 'version?',
      kind: 'code',
      sha256: 'sha256',
      markdown_sha256: 'sha256?',
      versions: 'count',
      cause: 'code',
    },
  },
  /**
   * The retention loop deleted the files of a pack version without a row (a build that failed
   * after its upload; E05, ADR-M48 §2.7, ADR-M51). IDs from the file path and counts only.
   */
  'evidence.orphan_swept': {
    entityType: 'intent',
    fields: { pack_id: 'uuid', files: 'count', versions: 'count' },
  },
  /**
   * The retention loop removed ended web sessions and used or expired passkey challenges of this
   * tenant (O04, migration 0046, ADR-M103). Counts only; the tenant is the entity.
   */
  'housekeeping.removed': {
    entityType: 'tenant',
    fields: { sessions: 'count', challenges: 'count' },
  },
  /**
   * A tenant admin asked to delete the client's data (H03c, ADR-M97 §2.3). Declared here so H03b
   * can read the approval clock; H03c writes it. Codes and IDs only; never a ticket URL text.
   */
  'client_data.deletion_requested': {
    entityType: 'tenant',
    fields: { requested_by: 'uuid', grace_period_days: 'count', legal_basis: 'code' },
  },
  /**
   * A platform operator approved the deletion (H03c, ADR-M97 §2.3). The grace period starts at
   * this event's `occurred_at` (H03b). Never a free-text reason.
   */
  'client_data.deletion_approved': {
    entityType: 'tenant',
    fields: { operator_id: 'uuid', confirmed_scope: 'code' },
  },
  /**
   * The requester and the operator cancelled a pending deletion (H03c). Codes and IDs only.
   */
  'client_data.deletion_cancelled': {
    entityType: 'tenant',
    fields: { cancelled_by: 'uuid', role: 'code' },
  },
  /**
   * The retention loop began the physical purge after the grace period (H03b, ADR-M97 §2.3).
   * `targets` lists the subsystems it will touch (`s3`, `langfuse`, `knowledge_db`, `users_pii`).
   */
  'client_data.deletion_started': {
    entityType: 'tenant',
    fields: { targets: 'codes' },
  },
  /**
   * An active evidence hold or an open intent blocks completing the client purge (H03b, ADR-M97
   * §2.4). Counts only; the held or open intent IDs stay out of the payload.
   */
  'client_data.purge_blocked_by_hold': {
    entityType: 'tenant',
    fields: { open_intents: 'count', active_holds: 'count' },
  },
  /**
   * Tier-1 client content is gone; the tenant is `purged` (H03b AC3, ADR-M97 §2.3). Counts and the
   * receipt hash only. Append-only rows stay.
   */
  'client_data.deleted': {
    entityType: 'tenant',
    fields: {
      evidence_files_purged: 'count',
      langfuse_intents_purged: 'count',
      knowledge_indexes_dropped: 'count',
      users_anonymized: 'count',
      retained_audit_rows: 'count',
      deletion_receipt_hash: 'sha256',
    },
  },
  /**
   * The daily audit anchor check found anchors that do not match this tenant's chain (E05 PR 2,
   * D-05 §7.4, ADR-M51 §2.9). Once per check run. Counts and the first mismatch's `reason`
   * (`hash_mismatch`, `seq_missing`, `anchor_invalid`, `anchor_versions`) and `seq`; **never a
   * hash**. The tenant is the entity.
   */
  'audit.anchor_mismatch': {
    entityType: 'tenant',
    fields: { checked: 'count', mismatched: 'count', reason: 'code', first_seq: 'count?' },
  },
  /**
   * The retention loop asked Langfuse to delete the intent's model-call traces (E08, ADR-M53):
   * the traces it found by the intent's run tags, all checked. Langfuse deletes asynchronously;
   * `langfuse.purged` follows on a later pass. Counts and codes only, never a trace ID or a tag.
   */
  'langfuse.purge_requested': {
    entityType: 'intent',
    fields: { traces: 'count', attempt: 'count', cause: 'code' },
  },
  /**
   * The intent's traces are no longer found in Langfuse (E08, ADR-M53): the purge is confirmed.
   * `traces` is what the last request found (0: the intent had none).
   */
  'langfuse.purged': {
    entityType: 'intent',
    fields: { traces: 'count', attempts: 'count', cause: 'code' },
  },
  /**
   * One version of a project's document index was deleted from `knowledge-db` (X04 PR 3a,
   * ADR-M89 §2.4): `cause` `retention` or `archive`. The platform's row keeps its counts.
   */
  'knowledge.purged': {
    entityType: 'project',
    fields: { index_id: 'uuid', documents: 'count', chunks: 'count', cause: 'code' },
  },
  /** A person put an intent's evidence on hold (E05, QUESTIONS #235): never purged until released. */
  'evidence.hold_set': { entityType: 'intent', fields: { hold_id: 'uuid' } },
  /** A person released the hold on an intent's evidence (E05, QUESTIONS #235). */
  'evidence.hold_released': { entityType: 'intent', fields: { hold_id: 'uuid' } },
  /**
   * G8 stopped (E03, ADR-M49 §2.5): `check` `evidence_hash_mismatch` or `evidence_missing` (a
   * stored evidence file failed its re-check while the release pack was built). The intent is
   * paused at G8 with a `security` escalation.
   */
  'gate.g8_check_failed': {
    entityType: 'intent',
    fields: { check: 'code', escalation_id: 'uuid' },
  },
  /**
   * G8 passed and the intent is `done` (E03 AC3, ADR-M49 §2.4): the sealed pack and the intent's
   * coded metrics. `lead_time_seconds` from the intent's creation to its close; token sums as digit
   * strings and the cost as a decimal string (as in E04). Never names or text.
   */
  'intent.closed': {
    entityType: 'intent',
    fields: {
      pack_id: 'uuid',
      pack_version: 'version',
      release_sha256: 'sha256',
      lead_time_seconds: 'count',
      runs: 'count',
      g7_change_requests: 'count',
      cost_usd: 'decimal',
      input_tokens: 'code',
      output_tokens: 'code',
    },
  },
  /**
   * An evaluation was started on the server (task L04, ADR-M81 §2.7, QUESTIONS #464). The actor is
   * the system for the operator command. The entity is the evaluation. `code` is `EVAL-YYYY-NNNN`;
   * `config_name` the configuration file's code; `runs_total` the runs queued. Never a task text,
   * a prompt or a model name.
   */
  'evaluation.started': {
    entityType: 'evaluation',
    fields: {
      project_id: 'uuid',
      code: 'code',
      data_class: 'code',
      // L07: a numbered task set has a version; a project's task set has a kind and a commit.
      task_set_version: 'version?',
      task_set_kind: 'code?',
      task_set_commit: 'code?',
      config_name: 'code?',
      runs_total: 'version',
      budget_usd: 'decimal',
      // L05: the plan and its version, when the evaluation was started from a plan.
      plan_id: 'uuid?',
      plan_version: 'version?',
    },
  },
  /**
   * An evaluation ended (L04): `status` is `completed`, `stopped_budget`, `cancelled` or `failed`;
   * `stop_reason` a code; the counts are runs by outcome.
   */
  'evaluation.finished': {
    entityType: 'evaluation',
    fields: {
      status: 'code',
      stop_reason: 'code?',
      runs_scored: 'count',
      runs_failed: 'count',
      runs_cancelled: 'count',
      cost_usd: 'decimal',
    },
  },
  /**
   * A project's evaluation task was registered, or its changed card registered again (task L07,
   * ADR-M85 §2.6). The entity is the task. `task` is the task ID; the card's SHA-256 and commit;
   * never its content or a path of the project.
   */
  'evaluation_task.registered': {
    entityType: 'evaluation_task',
    fields: {
      project_id: 'uuid',
      task: 'code',
      intent_id: 'uuid',
      card_sha256: 'sha256',
      card_commit: 'code',
    },
  },
  /**
   * The check of an evaluation task ended (L07 PR 4, ADR-M85 §2.5): `result` is `checked` or
   * `check_failed`, with the failure `code`; `attempt` counts the hand-overs to a runner.
   */
  'evaluation_task.checked': {
    entityType: 'evaluation_task',
    fields: {
      project_id: 'uuid',
      task: 'code',
      card_sha256: 'sha256',
      result: 'code',
      attempt: 'count',
      code: 'code?',
    },
  },
  /** An evaluation task's card was removed from the default branch: the task is gone (L07). */
  'evaluation_task.gone': {
    entityType: 'evaluation_task',
    fields: { project_id: 'uuid', task: 'code' },
  },
  /** A reviewer approved an evaluation task (L07): bound to the card's SHA-256. */
  'evaluation_task.approved': {
    entityType: 'evaluation_task',
    fields: { project_id: 'uuid', task: 'code', card_sha256: 'sha256' },
  },
  /** A reviewer rejected an evaluation task (L07): a reason code, never text. */
  'evaluation_task.rejected': {
    entityType: 'evaluation_task',
    fields: { project_id: 'uuid', task: 'code', card_sha256: 'sha256', reason: 'code' },
  },
  /**
   * An evaluation plan was created (task L05, ADR-M82 §2.8). The entity is the plan. Amounts are
   * decimals; `trigger` is `once`, `schedule` or `on_change`. Never a prompt text or a path.
   */
  'evaluation_plan.created': {
    entityType: 'evaluation_plan',
    fields: {
      project_id: 'uuid',
      code: 'code',
      version: 'version',
      trigger: 'code',
      budget_per_run_usd: 'decimal',
      monthly_cap_usd: 'decimal',
      configurations: 'count',
    },
  },
  /**
   * A plan got a new version (L05): `fields` names the changed fields (codes); the amounts before
   * and after.
   */
  'evaluation_plan.changed': {
    entityType: 'evaluation_plan',
    fields: {
      version: 'version',
      fields: 'codes',
      trigger: 'code',
      old_budget_per_run_usd: 'decimal',
      budget_per_run_usd: 'decimal',
      old_monthly_cap_usd: 'decimal',
      monthly_cap_usd: 'decimal',
    },
  },
  /** A plan was archived (L05): final. */
  'evaluation_plan.archived': { entityType: 'evaluation_plan', fields: { version: 'version' } },
  /**
   * A run of a plan started (L05): the evaluation; `reason` is `manual`, `schedule` or
   * `on_change`; `budget_usd` the evaluation's budget.
   */
  'evaluation_plan.run_started': {
    entityType: 'evaluation_plan',
    fields: {
      evaluation_id: 'uuid',
      version: 'version',
      reason: 'code',
      budget_usd: 'decimal',
    },
  },
  /** A person asked to run a plan now (L05, QUESTIONS #476); the worker starts it. */
  'evaluation_plan.run_requested': {
    entityType: 'evaluation_plan',
    fields: { version: 'version' },
  },
  /** The worker could not start a plan (L05): `reason` a code (`model_not_allowed`, …). */
  'evaluation_plan.run_refused': {
    entityType: 'evaluation_plan',
    fields: { version: 'version', reason: 'code' },
  },
  /** A plan's schedule paused (L05): `reason` a code (`monthly_cap_used`). */
  'evaluation_plan.paused': { entityType: 'evaluation_plan', fields: { reason: 'code' } },
} as const satisfies Readonly<Record<string, AuditActionSpec>>;

export type AuditAction = keyof typeof AUDIT_ACTIONS;

type FieldValue<K> = K extends 'version' | 'version?' | 'count' | 'count?'
  ? number
  : K extends 'codes' | 'codes?'
    ? readonly string[]
    : string;
type Fields<A extends AuditAction> = (typeof AUDIT_ACTIONS)[A]['fields'];
type OptionalKeys<A extends AuditAction> = {
  [F in keyof Fields<A>]: Fields<A>[F] extends `${string}?` ? F : never;
}[keyof Fields<A>];

export type AuditPayload<A extends AuditAction> = {
  readonly [F in Exclude<keyof Fields<A>, OptionalKeys<A>>]: FieldValue<Fields<A>[F]>;
} & {
  readonly [F in OptionalKeys<A>]?: FieldValue<Fields<A>[F]>;
};

/** Upper bound of the canonical JSON payload, in UTF-8 bytes. */
export const MAX_AUDIT_PAYLOAD_BYTES = 2048;

/** Most codes in one `codes` field. */
export const MAX_AUDIT_CODES = 16;

const SHA256 = /^[0-9a-f]{64}$/;
const CODE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

function isValidField(kind: AuditFieldKind, value: unknown): boolean {
  switch (kind) {
    case 'uuid':
      return isUuid(value);
    case 'sha256':
      return typeof value === 'string' && SHA256.test(value);
    case 'version':
      return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
    case 'code':
      return typeof value === 'string' && CODE.test(value);
    case 'codes':
      return (
        Array.isArray(value) &&
        value.length >= 1 &&
        value.length <= MAX_AUDIT_CODES &&
        value.every((item) => typeof item === 'string' && CODE.test(item))
      );
    case 'decimal':
      return isUsd(value);
    case 'count':
      return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  }
}

export function isAuditAction(action: unknown): action is AuditAction {
  return typeof action === 'string' && Object.hasOwn(AUDIT_ACTIONS, action);
}

/**
 * Checks an event against its declared spec and returns the payload with exactly the declared
 * fields. Throws `DbError('invalid_value')` for an unknown action, a missing, extra or badly
 * formatted field, or a wrong entity.
 */
export function checkAuditEvent(
  action: string,
  entityId: string | null,
  payload: Readonly<Record<string, unknown>>,
): { entityType: string | null; payload: Record<string, unknown> } {
  if (!isAuditAction(action)) throw invalid(`unknown audit action ${JSON.stringify(action)}`);
  const spec: AuditActionSpec = AUDIT_ACTIONS[action];
  if (spec.entityType === null ? entityId !== null : !isUuid(entityId)) {
    throw invalid(`${action}: entity ID must be ${spec.entityType ? 'a UUID' : 'null'}`);
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw invalid(`${action}: payload must be an object`);
  }
  const extra = Object.keys(payload).filter((key) => !Object.hasOwn(spec.fields, key));
  if (extra.length > 0) throw invalid(`${action}: undeclared payload fields ${extra.join(', ')}`);
  const checked: Record<string, unknown> = {};
  for (const [field, declared] of Object.entries(spec.fields)) {
    const optional = declared.endsWith('?');
    const kind = (optional ? declared.slice(0, -1) : declared) as AuditFieldKind;
    const value = payload[field];
    if (optional && value === undefined) continue;
    if (!isValidField(kind, value))
      throw invalid(`${action}: payload field ${field} must be a ${kind}`);
    checked[field] = value;
  }
  return { entityType: spec.entityType, payload: checked };
}

function invalid(message: string): DbError {
  return new DbError('invalid_value', message);
}
