// Run event types and their declared payload fields (design/D-05 section 6.4, ADR-M22 section 2.5).
//
// `run_events` is append-only and kept as evidence, so data written there can never be erased.
// Payloads therefore hold **only IDs, codes, hashes, versions and counts**: never free text,
// personal data (names, e-mail addresses, account names) or client data (paths, code, logs).
// `append` accepts only the fields declared here for the event type, each with a strict format;
// the database CHECK `run_event_payload_is_coded` refuses anything else as a backstop.
//
// Adding an event type (C04, C07, C11…): add it below with the smallest set of fields that makes
// the event traceable, and a test. Reviewers check that no field can carry personal or client data.
// A field whose kind ends with `?` is optional: it may be left out, never set to null.
import { isUsd } from '../cost/money.js';
import { DbError } from '../db/errors.js';
import { isUuid } from '../db/tenant-id.js';

/**
 * - `uuid`: a platform ID (lowercase UUID)
 * - `sha256`: a lowercase hex SHA-256 digest
 * - `version`: a positive integer
 * - `count`: a non-negative integer (iterations, tokens, percent)
 * - `code`: a short code such as `expired` or `G5` (letters, digits, `_ . : -`; max 64)
 * - `decimal`: an amount of money in USD as a decimal string with at most 6 decimals, never a
 *   float (D-05 D6; C07)
 * - `model`: a model gateway name, which may hold `/` and be 128 characters long (V13,
 *   QUESTIONS #434); still no space and no `@`, as the database CHECK requires
 * - `codes`: codes joined by `:` (each letters, digits, `_ . -`; max 128 in all), for a short list
 *   such as the rule codes of a secret scan (H04, ADR-M93 §2.3)
 */
export type RunEventFieldKind =
  'uuid' | 'sha256' | 'version' | 'count' | 'code' | 'decimal' | 'model' | 'codes';
export type RunEventFieldSpec = RunEventFieldKind | `${RunEventFieldKind}?`;

export const RUN_EVENT_TYPES = {
  /** The worker issued and stored the signed Run Contract (C02). */
  contract_issued: { contract_sha256: 'sha256', key_version: 'version' },
  /**
   * The model the run calls (V13, QUESTIONS #434, ADR-M79 §2.3): the agent version's `model_ref`
   * that G4 bound into the run proposal and the runner gives the agent. Written by `prepareRun`
   * before the key is issued; skipped when the name does not fit the `model` format.
   */
  model_selected: { model: 'model' },
  /** The runner verified the contract and may start the sandbox (C02). */
  contract_accepted: { contract_sha256: 'sha256', key_version: 'version' },
  /** The runner refused the contract; `reason` is a `RunContractRejectReason` (C02). */
  contract_rejected: { reason: 'code' },
  /**
   * The runner cloned the repository at `base_sha` and created the `agent/INT-…` branch in the
   * run's workspace (C04, ADR-M25). The branch name is in the contract, not repeated here.
   */
  workspace_prepared: { base_sha: 'code', duration_ms: 'count' },
  /** The runner created the sandbox container from the project image, pinned by digest (C04). */
  sandbox_created: { image_sha256: 'sha256' },
  /** The sandbox passed its health check (C04). */
  sandbox_ready: { duration_ms: 'count' },
  /**
   * X04 (ADR-M69 §2.7, QUESTIONS #518, #532): register tools. Codes and counts only, never a
   * query, an argument, an answer, a document name or path, a credential or a key.
   * - `tool_started`: the tool container is healthy (`image_sha256`: the hex of its digest);
   * - `tool_used`: once per tool at the end of the run, also after a kill or a failure, counted
   *   from the run gateway's log lines;
   * - `tool_refused`: the first call the gateway refused for a reason, once per reason
   *   (`max_calls`, `tool_not_allowed`, `argument_refused` with the tool, `key_refused` without);
   * - `tool_failed`: the tool stopped or became unhealthy during the run.
   */
  tool_started: { tool_key: 'code', tool_version: 'code', image_sha256: 'sha256' },
  tool_used: { tool_key: 'code', calls: 'count', failed_calls: 'count', refused_calls: 'count' },
  tool_refused: { reason: 'code', tool_key: 'code?' },
  tool_failed: { tool_key: 'code', reason: 'code' },
  /**
   * X04 PR 3a (ADR-M89 §2.3): the index of the project's documents for a `read_documents` tool
   * could not be built in the run preparation; `reason` is a `KnowledgeErrorCode`. The run ended
   * `failed` with the stop reason `tool_unavailable`, before its sandbox.
   */
  knowledge_unavailable: { reason: 'code' },
  /**
   * X04 PR 3b (ADR-M89 §2.5, QUESTIONS #533, #536, #543): once per run and `read_documents` tool,
   * at the end of the run (also after a kill or a failure), from the tool's own log lines read by
   * the runner outside the sandbox. `list_sha256`: the SHA-256 of the evidence item `knowledge_read`
   * (the sorted list of document ID and content hash the tool returned); `documents`: how many
   * distinct documents; `chunks`: how many chunks it returned in all. Never a query, a path or a
   * text.
   */
  knowledge_read: {
    tool_key: 'code',
    index_id: 'uuid',
    list_sha256: 'sha256',
    documents: 'count',
    chunks: 'count',
  },
  /**
   * X07 (ADR-M90 §2.3, QUESTIONS #556): once per run, after `knowledge_read`, at the end of the run
   * (also after a kill, a failure or a restart's clean-up). `snapshot_sha256`: the SHA-256 of the
   * evidence item `context_snapshot`; `source`: where the file list comes from (`agent_log`, or
   * `unavailable` when the runner could not read the agent's log); `files`: distinct repository
   * files the agent opened; `files_outside`: opens outside the workspace; `unattributed_calls`:
   * tool calls that can read files without naming them (a shell command, a search);
   * `document_tools`: `knowledge_read` events of the run; `documents`: their documents in all.
   * Never a path, a query or a text.
   */
  context_snapshot: {
    snapshot_sha256: 'sha256',
    source: 'code',
    files: 'count',
    files_outside: 'count',
    unattributed_calls: 'count',
    document_tools: 'count',
    documents: 'count',
  },
  /**
   * X04 PR 3b (ADR-M69 §2.7–§2.8, QUESTIONS #540, #541): the run's tool credentials (the database
   * logins and the tools' model keys) were revoked at the end of the run or at a kill;
   * `tool_credential_revoke_failed` with a code when it failed (the time to live still ends them).
   */
  tool_credential_revoked: { tool_key: 'code' },
  tool_credential_revoke_failed: { tool_key: 'code', reason: 'code' },
  /** Provisioning stopped before the sandbox was ready; `reason` is a `ProvisioningFailure` (C04). */
  provisioning_failed: { reason: 'code' },
  /**
   * The runner removed the sandbox, its network and its workspace (C04). `reason` is a
   * `TeardownReason` code (`finished`, `failed`, `orphan`, …).
   */
  sandbox_removed: { reason: 'code', duration_ms: 'count' },
  /**
   * The runner ended a run that had not reached a final status because its sandbox was lost: the
   * runner restarted (`stop_reason` `runner_restarted`) or the sweep found the sandbox without its
   * process (`sandbox_lost`). `previous_status` is the run status before `failed` (C04, ADR-M25).
   */
  run_abandoned: { previous_status: 'code' },
  /**
   * The runner started the agent in the sandbox with the contract's caps (C05, ADR-M29). The model
   * name is not repeated here: model names may hold `/` or `@`; `cost_records` has the model.
   * X11 (ADR-M29 §2.10): `condensing` is `off`, `summarize`, `context_unknown` or `unsupported`.
   */
  agent_started: { max_iterations: 'count', max_duration_min: 'count', condensing: 'code?' },
  /**
   * The runner interrupted the agent (C05): `reason` `max_duration`, `max_budget` (C07), `killed`,
   * `cancelled` (C11), `loop_detected` or `no_progress` (C11 PR 2); `method` `interrupt` (the agent
   * stopped within the grace period) or `kill` (the sandbox was removed without waiting).
   */
  agent_stopped: { reason: 'code', method: 'code' },
  /**
   * Loop detection stopped the agent (C11 PR 2, D-02 FR-35, ADR-M42 §2.7), written before
   * `agent_stopped` (which names the cause). Counts only, never tool arguments, paths or commands:
   * `identical_calls` in a row at the end of the log, the contract's `threshold`, and the whole
   * minutes since the agent's log last grew (`idle_minutes`).
   */
  loop_detected: { identical_calls: 'count', threshold: 'count', idle_minutes: 'count' },
  /**
   * The agent run ended (C05, ADR-M29). `outcome`: `finished`, `max_iterations`, `max_duration`,
   * `max_budget`, `stuck`, `loop_detected`, `no_progress`, `agent_error`, `killed`. `commit`: `committed` (the runner committed what the agent left, QUESTIONS
   * #80) or `nothing`; left out when the runner did not commit. `head_sha` is the final `HEAD`;
   * `changed_files` counts the files changed since `base_sha` (the paths are client data).
   * X11 (ADR-M29 §2.10, QUESTIONS #552): with condensing on, `condensations` and the
   * `events_forgotten` they removed from the model's view; counts only, never a summary.
   */
  agent_finished: {
    outcome: 'code',
    iterations: 'count',
    changed_files: 'count?',
    head_sha: 'code?',
    commit: 'code?',
    condensations: 'count?',
    events_forgotten: 'count?',
  },
  /** An agent call failed (C05); `reason` is an `AgentErrorCode` or `model_unreachable`. */
  agent_failed: { reason: 'code' },
  /**
   * The proposal of an L1 run was computed in the runner's clone and stored as evidence (C06
   * session 2b, ADR-M33 §2.9). The URI and the paths stay in `evidence_items` and the file.
   */
  proposal_stored: { sha256: 'sha256', size_bytes: 'count', changed_files: 'count' },
  /**
   * The worker issued the run's capped virtual key (C07, ADR-M34 §2.6). `limited_by`: which budget
   * set the cap, `run`, `intent` or `tenant` (the smallest remainder). Never the key or its ID.
   */
  key_issued: { max_budget_usd: 'decimal', limited_by: 'code' },
  /**
   * The runner's spend check reached the warning share of the key's cap (C07): once per run.
   * `percent` is the share used when it was read.
   */
  budget_warning: { spend_usd: 'decimal', max_budget_usd: 'decimal', percent: 'count' },
  /**
   * The full diff of the run against `base_sha`, computed in the runner's clone from the sandbox's
   * workspace, stored as evidence `diff` (C07, ADR-M34 §2.2). The URI and the paths stay in
   * `evidence_items` and the file.
   */
  diff_stored: { sha256: 'sha256', size_bytes: 'count', changed_files: 'count' },
  /**
   * The runner's check of the run's changes, at the end of the run (C07, QUESTIONS #130, ADR-M34
   * §2.3): counts only. `paths_sha256` is the SHA-256 of the sorted changed paths (G5 binds to it);
   * `out_of_scope` counts paths outside the plan, `instruction_files` paths the agent reads as
   * instructions (QUESTIONS #126). The paths themselves are client data and never stored here.
   */
  changes_checked: {
    changed_files: 'count',
    out_of_scope: 'count',
    instruction_files: 'count',
    paths_sha256: 'sha256',
  },
  /**
   * The runner's secret scan of the run's added lines, outside the sandbox (H04, ADR-M93 §2.3):
   * `result` is `clean`, `found` or `failed`; `findings` the number of findings; `rules` where the
   * rules came from (`repository`: the base commit's `.gitleaks.toml`, or `built_in`); `rule_ids`
   * the distinct rule codes found (a rule ID that is not a code is `custom`); `cause` why a scan
   * failed. Never a match, a line, a path or a fingerprint. G5 holds the run on `found` and
   * `failed` (QUESTIONS #587).
   */
  secrets_scanned: {
    result: 'code',
    findings: 'count',
    rules: 'code',
    rule_ids: 'codes?',
    config_sha256: 'sha256?',
    scanner_version: 'code?',
    cause: 'code?',
  },
  /**
   * The size of the run's change a person must review (H05, ADR-M95 §2.2), measured by the runner
   * outside the sandbox from the staged diff: `result` `measured` or `failed` (with `cause`). The
   * review counts leave out the generated files (lock files, and the files the base commit's
   * `.gitattributes` marks `linguist-generated`), which are counted apart. A binary file counts as
   * one file and no lines. Counts only, never a path.
   */
  diff_measured: {
    result: 'code',
    review_files: 'count?',
    review_lines: 'count?',
    generated_files: 'count?',
    generated_lines: 'count?',
    binary_files: 'count?',
    cause: 'code?',
  },
  /**
   * The runner's dependency scan of the run's changed manifest and lockfiles, outside the sandbox
   * (H02, ADR-M96 §2.3): `result` is `clean`, `warning`, `finding` or `failed`.
   * Counts and codes only, never package text, commands or secrets.
   */
  dependencies_scanned: {
    result: 'code',
    new_dependencies: 'count',
    changed_dependencies: 'count',
    license_violations: 'count',
    install_scripts: 'count',
    typosquatting_warnings: 'count',
    advisory_findings: 'count',
    cause: 'code?',
  },
  /**
   * The runner pushed the run's checked changes as one commit on `agent/INT-…` (C08, ADR-M38
   * §2.2): `head_sha` is the commit the runner made from the stored diff (never what the sandbox
   * reported) and that the Git host now shows for the branch; `diff_sha256` and `paths_sha256` are
   * the values G5 checked. `parent_sha` is the commit it was made on (the run's base).
   */
  branch_pushed: {
    head_sha: 'code',
    parent_sha: 'code',
    diff_sha256: 'sha256',
    paths_sha256: 'sha256',
  },
  /**
   * The runner will not push this run (C08, QUESTIONS #156): a final cause a person decides on,
   * such as `empty_diff`, `diff_mismatch` (the stored diff is not the one G5 checked) or
   * `branch_moved` (someone else changed `agent/INT-…`).
   */
  publish_refused: { reason: 'code' },
  /** A push attempt failed for a cause that may pass (Git host, network, token); C08. */
  publish_failed: { reason: 'code' },
  /**
   * What G6 read from the Git host about the run's pull request (C08 PR 2, ADR-M38 §2.7): the
   * pull request's state and head, the result of the checks G6 waits for (`state`: `passed`,
   * `failed`, `pending`, `missing`: no check at all, O06), the SHA-256 of their sorted names and conclusions (the names stay on the
   * Git host), and the open security findings per severity (`findings`: `known`, `not_enabled`,
   * `forbidden`). Recorded when it changed; G6 decides from the latest one.
   */
  ci_checked: {
    pr_number: 'count',
    pr_state: 'code',
    head_sha: 'code',
    state: 'code',
    checks_sha256: 'sha256',
    findings: 'code',
    critical: 'count',
    high: 'count',
    medium: 'count',
    low: 'count',
  },
  /**
   * What G7 read about the run's pull request (E01, ADR-M41 §2.3): its state and head, the merge
   * commit and who merged it (`merger`: `person`, `producer`, `bot`, `unknown`; never the account),
   * the SHA-256 of the latest review decisions (review IDs, states, commits; never a login or a
   * text), the counts of approvals and requests for changes of the head, and of the commit authors
   * with and without an account. Recorded when it changed; G7 decides from the latest one.
   */
  g7_checked: {
    pr_number: 'count',
    pr_state: 'code',
    head_sha: 'code',
    merge_commit_sha: 'code?',
    merger: 'code?',
    reviews_sha256: 'sha256',
    approvals: 'count',
    changes_requested: 'count',
    commit_authors: 'count',
    commits_without_account: 'count',
  },
  /**
   * G7 passed: a person merged the run's pull request with the approved head (E01 AC5). The merge
   * commit is the source commit of the release (E03).
   */
  pr_merged: { pr_number: 'count', head_sha: 'code', merge_commit_sha: 'code?' },
  /**
   * A person (or an operator, actor `system`) used the kill switch (C11, ADR-M42): the run was
   * `previous_status`; `source` is `api`, `github_comment` or `ops`. Who killed is in
   * `runs.killed_by` and the audit event `run.kill_requested`.
   */
  kill_requested: { previous_status: 'code', source: 'code' },
  /**
   * The runner revoked a short-lived GitHub token right after its use (C11, ADR-M42 §2.4): `token`
   * is `clone`, `push` or (E01 PR 2) `feedback`. `token_revoke_failed` gives a `GitHostErrorCode`; the token then expires
   * by itself within the hour.
   */
  token_revoked: { token: 'code' },
  token_revoke_failed: { token: 'code', reason: 'code' },
  /**
   * A single-use wrapping token of the run was already used when the runner opened it (C11,
   * ADR-M38 §2.3, ADR-M42 §2.5): `token` is `clone`, `push`, `virtual_key` or (E01 PR 2)
   * `feedback`. Someone else may
   * hold the secret: the run fails and its escalation goes to the security route.
   */
  wrap_token_reused: { token: 'code' },
  /**
   * The diff of a killed run could not be stored as evidence (C11, QUESTIONS #183): the store is
   * best-effort and never delays the kill. `reason` is a code (`timeout`, `unavailable`, …).
   */
  kill_evidence_failed: { reason: 'code' },
  /**
   * The runner read the feedback of the request for changes the run answers (E01 PR 2, ADR-M41
   * §2.7, QUESTIONS #179): `source` is `review` or `comment`; the text's length in characters
   * after the cap, whether it was cut (`truncated`: `yes`, `no`) and the review's line comments.
   * Counts only: the text itself goes to the agent's prompt in memory, never here.
   */
  feedback_read: { source: 'code', chars: 'count', truncated: 'code', comments: 'count' },
  /**
   * The feedback of the request for changes cannot be used, so the run never starts its agent
   * (E01 PR 2): `reason` is a code (`review_withdrawn`, `identity_unlinked`, `author_mismatch`,
   * `git_host_unavailable`, …). Recorded by the worker before the key, or by the runner.
   */
  feedback_unavailable: { reason: 'code' },
  /**
   * The runner read the plan file at the plan's commit from its own clone for the agent's prompt
   * (B09 PR 2, ADR-M40 §2.7, QUESTIONS #169, #210): the number of tasks, the length in characters of
   * the task text after the caps, whether it was cut (`truncated`: `yes`, `no`), and the
   * agent-facing fields left out because they are not text. Counts only: the text goes to the
   * agent's prompt in memory, never here.
   */
  plan_read: { tasks: 'count', chars: 'count', truncated: 'code', skipped_fields: 'count' },
  /**
   * The plan file of a run cannot be used, so the run never starts its agent and fails with
   * `task_unavailable` (B09 PR 2): `reason` is `no_clone`, `commit_missing`, `missing`,
   * `not_a_file`, `too_large`, `git_failed` (git could not answer: a timeout, a broken clone), `not_utf8`,
   * `hash_mismatch`, `invalid` or `files_mismatch`.
   */
  plan_unavailable: { reason: 'code' },
} as const satisfies Readonly<Record<string, Readonly<Record<string, RunEventFieldSpec>>>>;

export type RunEventType = keyof typeof RUN_EVENT_TYPES;

type FieldValue<K> = K extends
  | 'uuid'
  | 'uuid?'
  | 'sha256'
  | 'sha256?'
  | 'code'
  | 'code?'
  | 'decimal'
  | 'decimal?'
  | 'model'
  | 'model?'
  | 'codes'
  | 'codes?'
  ? string
  : number;
type Fields<T extends RunEventType> = (typeof RUN_EVENT_TYPES)[T];
type OptionalKeys<T extends RunEventType> = {
  [F in keyof Fields<T>]: Fields<T>[F] extends `${string}?` ? F : never;
}[keyof Fields<T>];

export type RunEventPayload<T extends RunEventType> = {
  readonly [F in Exclude<keyof Fields<T>, OptionalKeys<T>>]: FieldValue<Fields<T>[F]>;
} & {
  readonly [F in OptionalKeys<T>]?: FieldValue<Fields<T>[F]>;
};

/** Upper bound of the payload (same as the audit log and the database CHECK). */
export const MAX_RUN_EVENT_PAYLOAD_BYTES = 2048;

const SHA256 = /^[0-9a-f]{64}$/;
// No spaces (no sentences) and no '@' (no e-mail addresses).
const CODE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const CODES = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}(?::[A-Za-z0-9][A-Za-z0-9_.-]{0,63})*$/;
// A gateway model name as the database CHECK accepts it: no space, no '@', no '+'.
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

/** Whether a model name can be recorded in a run event (`model_selected`, V13). */
export function isRecordableModel(value: unknown): value is string {
  return typeof value === 'string' && MODEL.test(value);
}

function isValidField(kind: RunEventFieldKind, value: unknown): boolean {
  switch (kind) {
    case 'uuid':
      return isUuid(value);
    case 'sha256':
      return typeof value === 'string' && SHA256.test(value);
    case 'version':
      return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
    case 'count':
      return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
    case 'code':
      return typeof value === 'string' && CODE.test(value);
    case 'decimal':
      return isUsd(value);
    case 'model':
      return isRecordableModel(value);
    case 'codes':
      return typeof value === 'string' && value.length <= 128 && CODES.test(value);
  }
}

export function isRunEventType(type: unknown): type is RunEventType {
  return typeof type === 'string' && Object.hasOwn(RUN_EVENT_TYPES, type);
}

/**
 * Checks a payload against the declared fields of its event type and returns exactly those
 * fields. Throws `DbError('invalid_value')` for an unknown type or a missing, extra or badly
 * formatted field.
 */
export function checkRunEvent(
  type: string,
  payload: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  if (!isRunEventType(type)) throw invalid(`unknown run event type ${JSON.stringify(type)}`);
  const fields: Readonly<Record<string, RunEventFieldSpec>> = RUN_EVENT_TYPES[type];
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw invalid(`${type}: payload must be an object`);
  }
  const extra = Object.keys(payload).filter((key) => !Object.hasOwn(fields, key));
  if (extra.length > 0) throw invalid(`${type}: undeclared payload fields ${extra.join(', ')}`);
  const checked: Record<string, unknown> = {};
  for (const [field, declared] of Object.entries(fields)) {
    const optional = declared.endsWith('?');
    const kind = (optional ? declared.slice(0, -1) : declared) as RunEventFieldKind;
    const value = payload[field];
    if (optional && value === undefined) continue;
    if (!isValidField(kind, value))
      throw invalid(`${type}: payload field ${field} must be a ${kind}`);
    checked[field] = value;
  }
  return checked;
}

function invalid(message: string): DbError {
  return new DbError('invalid_value', message);
}
