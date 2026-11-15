// Escalation vocabularies (design/D-05 sections 5 and 6.4b, handbook Ch.6 §6.4–§6.6, template T16,
// task B11, design/ADR-M28). Each list is the single source of the matching union type.

/** What raised the escalation (handbook Ch.6 §6.4 "What triggers an escalation"). */
export const ESCALATION_TRIGGERS = [
  'risky_action',
  'uncertainty',
  'out_of_scope',
  'disagreement',
  'unusual_behaviour',
  'accumulated_risk',
  'time',
  // H08 (ADR-M111 §2.6): the stand-in for the incident of an approved break-glass grant.
  'break_glass',
] as const;
export type EscalationTrigger = (typeof ESCALATION_TRIGGERS)[number];

/** Response levels, named not numbered (handbook Ch.6 §6.4). */
export const RESPONSE_LEVELS = ['observe', 'notify', 'pause', 'contain', 'incident'] as const;
export type ResponseLevel = (typeof RESPONSE_LEVELS)[number];

/** Levels that freeze the intent from the moment the escalation is raised (QUESTIONS #76). */
export const FREEZING_RESPONSE_LEVELS = [
  'pause',
  'contain',
  'incident',
] as const satisfies readonly ResponseLevel[];

export const ESCALATION_STATUSES = ['open', 'acknowledged', 'resolved', 'closed'] as const;
export type EscalationStatus = (typeof ESCALATION_STATUSES)[number];

/**
 * Who receives the escalation first (handbook Ch.6 §6.4 "Who receives it", QUESTIONS #74). Set by
 * whoever raises it; the roles per route come from the project configuration.
 */
export const ESCALATION_ROUTES = ['intent', 'technical', 'security', 'policy'] as const;
export type EscalationRoute = (typeof ESCALATION_ROUTES)[number];

/** The chain when nobody acknowledges (handbook Ch.6 §6.5): owner → backup → governance. */
export const ESCALATION_STEPS = ['owner', 'backup', 'governance'] as const;
export type EscalationStep = (typeof ESCALATION_STEPS)[number];

/** Decisions on an escalation (template T16 §4, QUESTIONS #77). */
export const ESCALATION_DECISIONS = [
  'resume',
  'modify',
  'roll_back',
  'terminate',
  'escalate_further',
] as const;
export type EscalationDecision = (typeof ESCALATION_DECISIONS)[number];

/** The agent's or raiser's recommendation in the decision packet (template T16 §2). */
export const ESCALATION_RECOMMENDATIONS = ['approve', 'modify', 'reject'] as const;
export type EscalationRecommendation = (typeof ESCALATION_RECOMMENDATIONS)[number];

/** What the packet's `subject_sha256` is the hash of: the version the decision is bound to. */
export const ESCALATION_SUBJECT_KINDS = [
  'intent',
  'spec',
  'plan',
  'run_contract',
  'diff',
  'config',
  // C07 (ADR-M34 §2.8): the G5 input of a run (run, contract, diff, checked paths, spend).
  'g5_input',
  // C08 PR 2 (ADR-M38 §2.7): the G6 input of a run (its push, pull request, checks, findings).
  'g6_input',
  // E01 (ADR-M41): the G7 input of a run (its pushed head, pull request, approved plan's flags).
  'g7_input',
  // E03 (ADR-M49): the G8 input of an intent (its merged run, merge commit, release hash).
  'g8_input',
] as const;
export type EscalationSubjectKind = (typeof ESCALATION_SUBJECT_KINDS)[number];

/**
 * Actions that may continue while an escalation is open, when the project configuration lists them
 * (handbook Ch.6 §6.5: read-only work, tests in a sandbox, unpublished drafts, collecting metrics).
 * The configuration can only choose from this list, so it can never put a risky action on it.
 */
export const SAFE_ACTIONS = [
  'read_only',
  'sandbox_test',
  'unpublished_draft',
  'collect_metrics',
] as const;
export type SafeAction = (typeof SAFE_ACTIONS)[number];

/**
 * Platform actions that are refused while the intent is frozen (QUESTIONS #76). Callers: B07
 * (`gate_advance`), C06 (`run_start`), C07 (`run_resume`, `budget_increase`), C08 (`push`,
 * `open_pr`), E01 (`merge`), E03 (`release`).
 */
export const PROTECTED_ACTIONS = [
  'gate_advance',
  'run_start',
  'run_resume',
  'push',
  'open_pr',
  'merge',
  'release',
  'budget_increase',
] as const;
export type ProtectedAction = (typeof PROTECTED_ACTIONS)[number];

/** Containment is never frozen: stopping a run and revoking its credentials (C11, FR-34). */
export const CONTAINMENT_ACTIONS = ['kill_run', 'revoke_credentials'] as const;
export type ContainmentAction = (typeof CONTAINMENT_ACTIONS)[number];

export type EscalationAction = SafeAction | ProtectedAction | ContainmentAction;

/** Kinds of notice the escalation clock records for delivery (task B11 PR 2 posts them). */
export const ESCALATION_NOTICE_KINDS = [
  'raised',
  'reminder',
  'step_changed',
  'ack_overdue',
  'resolve_overdue',
  'incident_due',
] as const;
export type EscalationNoticeKind = (typeof ESCALATION_NOTICE_KINDS)[number];
