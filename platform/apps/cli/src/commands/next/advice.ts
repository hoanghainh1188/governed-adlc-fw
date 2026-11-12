// `adlc next` (task V06): what the signed-in person does next for one intent. Pure: it reads the
// intent (`GET /v1/intents/:intent`) and the person (`GET /v1/me`) only, and never evaluates a gate
// again: the hold is what the workflow's step recorded (U02, ADR-M54 §2.4b) and who decides is the
// API's `waiting_for` (U01). QUESTIONS #368: the plan submitter is not in these two answers, so at G3
// a note says the platform refuses their approval. QUESTIONS #369: an escalation is found with
// `adlc escalation list --intent`.
import type { IntentWaitReason } from '@sdlc/contracts';
import type { MessageKey } from '@sdlc/messages';

import type { IntentDetail, Me } from '../../api/schemas.js';

/** Who acts next, from the caller's point of view. */
export type AdviceKind = 'you_act' | 'waits_for' | 'platform' | 'fix_setup' | 'finished';

export interface Advice {
  readonly kind: AdviceKind;
  /** A stable code for `--json` and the tests; the text is `cli.next.advice.<code>`. */
  readonly code: AdviceCode;
  readonly params: Readonly<Record<string, string>>;
  /** Roles that act next when the caller does not (`waits_for`); empty otherwise. */
  readonly roles: readonly string[];
  /** True when the caller is a producer of the change at this gate (never told to approve). */
  readonly producer: boolean;
  /** Extra notes, `cli.next.note.<code>`. */
  readonly notes: readonly NoteCode[];
}

export const ADVICE_CODES = [
  'decide_gate',
  'decide_g4',
  'decide_g5',
  'decide_g5_review',
  'decide_g6',
  'review_g7',
  'merge_g7',
  'decide_g8',
  'already_approved',
  'waits_role',
  'producer',
  'link_spec',
  'fix_spec',
  'spec_unclear',
  'write_plan',
  'new_plan',
  'resubmit_plan',
  'ai_record',
  'escalation',
  'waits_escalation',
  'block_window',
  'run_running',
  'run_watch',
  'run_pending',
  'proposal',
  'ci_pending',
  'publish_retry',
  'changes_requested',
  'setup_ci',
  'setup_git_host',
  'setup_evidence',
  'setup_later_gate',
  'setup_agent',
  'setup_budget',
  'finished',
  'blocked',
  'unknown',
] as const;
export type AdviceCode = (typeof ADVICE_CODES)[number];

export const NOTE_CODES = ['g3_submitter', 'default_roles', 'admin_only'] as const;
export type NoteCode = (typeof NOTE_CODES)[number];

/** Catalog key of each advice's text (literal keys: the catalog test finds them). */
const ADVICE_KEYS: Readonly<Record<AdviceCode, MessageKey>> = {
  decide_gate: 'cli.next.advice.decide_gate',
  decide_g4: 'cli.next.advice.decide_g4',
  decide_g5: 'cli.next.advice.decide_g5',
  decide_g5_review: 'cli.next.advice.decide_g5_review',
  decide_g6: 'cli.next.advice.decide_g6',
  review_g7: 'cli.next.advice.review_g7',
  merge_g7: 'cli.next.advice.merge_g7',
  decide_g8: 'cli.next.advice.decide_g8',
  already_approved: 'cli.next.advice.already_approved',
  waits_role: 'cli.next.advice.waits_role',
  producer: 'cli.next.advice.producer',
  link_spec: 'cli.next.advice.link_spec',
  fix_spec: 'cli.next.advice.fix_spec',
  spec_unclear: 'cli.next.advice.spec_unclear',
  write_plan: 'cli.next.advice.write_plan',
  new_plan: 'cli.next.advice.new_plan',
  resubmit_plan: 'cli.next.advice.resubmit_plan',
  ai_record: 'cli.next.advice.ai_record',
  escalation: 'cli.next.advice.escalation',
  waits_escalation: 'cli.next.advice.waits_escalation',
  block_window: 'cli.next.advice.block_window',
  run_running: 'cli.next.advice.run_running',
  run_watch: 'cli.next.advice.run_watch',
  run_pending: 'cli.next.advice.run_pending',
  proposal: 'cli.next.advice.proposal',
  ci_pending: 'cli.next.advice.ci_pending',
  publish_retry: 'cli.next.advice.publish_retry',
  changes_requested: 'cli.next.advice.changes_requested',
  setup_ci: 'cli.next.advice.setup_ci',
  setup_git_host: 'cli.next.advice.setup_git_host',
  setup_evidence: 'cli.next.advice.setup_evidence',
  setup_later_gate: 'cli.next.advice.setup_later_gate',
  setup_agent: 'cli.next.advice.setup_agent',
  setup_budget: 'cli.next.advice.setup_budget',
  finished: 'cli.next.advice.finished',
  blocked: 'cli.next.advice.blocked',
  unknown: 'cli.next.advice.unknown',
};

const NOTE_KEYS: Readonly<Record<NoteCode, MessageKey>> = {
  g3_submitter: 'cli.next.note.g3_submitter',
  default_roles: 'cli.next.note.default_roles',
  admin_only: 'cli.next.note.admin_only',
};

export function adviceKey(code: AdviceCode): MessageKey {
  return ADVICE_KEYS[code];
}

export function noteKey(code: NoteCode): MessageKey {
  return NOTE_KEYS[code];
}

const FINISHED = new Set(['done', 'rejected', 'cancelled']);

/**
 * The default `access.*` roles (platform/packages/config/defaults/project-config.default.yaml).
 * A project may change them; the advice then says so (`note.default_roles`).
 */
const DEFAULT_ACCESS = {
  spec_link: ['person_a', 'pm_brse'],
  plan_submit: ['person_a'],
  ai_record_write: ['person_a', 'pm_brse'],
  kill: ['person_a', 'person_b', 'governance'],
} as const;

/** Who owns the escalation that holds the intent, by the default routing (ADR-M28 §2.3). */
const ESCALATION_OWNERS: Readonly<Record<string, readonly string[]>> = {
  run_review: ['person_b', 'governance'], // technical
  g5_review: ['person_a', 'person_b', 'governance'], // intent, or security for instruction files
  publish_review: ['person_b', 'governance'], // technical or security
  g7_review: ['person_b', 'governance'], // technical or security
  g8_review: ['person_b', 'governance'], // security
  frozen: ['person_a', 'person_b', 'governance'], // any route
};

/** The facts about the caller that the advice needs. */
interface Caller {
  readonly roles: ReadonlySet<string>;
  readonly tenantAdmin: boolean;
  readonly producer: boolean;
  readonly approvedHere: boolean;
}

interface Facts {
  readonly intent: IntentDetail;
  readonly caller: Caller;
  readonly base: Readonly<Record<string, string>>;
}

type Rule = (facts: Facts) => Advice;

function advice(
  kind: AdviceKind,
  code: AdviceCode,
  facts: Facts,
  extra: Readonly<Record<string, string>> = {},
  roles: readonly string[] = [],
  notes: readonly NoteCode[] = [],
): Advice {
  return {
    kind,
    code,
    params: { ...facts.base, ...extra },
    roles,
    producer: facts.caller.producer,
    notes,
  };
}

function holdsAny(caller: Caller, roles: readonly string[]): boolean {
  return roles.some((role) => caller.roles.has(role));
}

/** An action that needs one of the project's default access roles. */
function byAccess(
  facts: Facts,
  roles: readonly string[],
  code: AdviceCode,
  extra: Readonly<Record<string, string>> = {},
): Advice {
  return holdsAny(facts.caller, roles)
    ? advice('you_act', code, facts, extra, [], ['default_roles'])
    : advice('waits_for', 'waits_role', facts, { roles: roles.join(', ') }, roles, [
        'default_roles',
      ]);
}

/** A gate a person decides: the roles of `waiting_for`, never a producer. */
function decide(code: AdviceCode): Rule {
  return (facts) => {
    const waiting = facts.intent.waiting_for;
    const roles = waiting?.roles ?? [];
    const gate = facts.base.gate ?? '';
    const notes: NoteCode[] = gate === 'G3' ? ['g3_submitter'] : [];
    const params = {
      roles: roles.join(', ') || '-',
      needed: String(waiting?.approvals_needed ?? 1),
    };
    if (!holdsAny(facts.caller, roles)) {
      return advice('waits_for', 'waits_role', facts, params, roles, notes);
    }
    if (facts.caller.producer) return advice('waits_for', 'producer', facts, params, roles, notes);
    if (facts.caller.approvedHere) {
      return advice('waits_for', 'already_approved', facts, params, roles, notes);
    }
    return advice('you_act', code, facts, params, [], notes);
  };
}

/** The gate's own decision advice: G4–G8 have their own text, G1–G3 the common one. */
function decideAtGate(facts: Facts): Advice {
  switch (facts.base.gate) {
    case 'G4':
      return decide('decide_g4')(facts);
    case 'G5':
      return decide('decide_g5')(facts);
    case 'G6':
      return decide('decide_g6')(facts);
    case 'G7':
      return decide('review_g7')(facts);
    case 'G8':
      return decide('decide_g8')(facts);
    default:
      return decide('decide_gate')(facts);
  }
}

function escalationRule(reason: string): Rule {
  return (facts) => {
    const owners = ESCALATION_OWNERS[reason] ?? ['governance'];
    return holdsAny(facts.caller, owners)
      ? advice('you_act', 'escalation', facts)
      : advice('waits_for', 'waits_escalation', facts, { roles: owners.join(', ') }, owners);
  };
}

const inputMissing: Rule = (facts) =>
  facts.base.gate === 'G2'
    ? byAccess(facts, DEFAULT_ACCESS.spec_link, 'link_spec')
    : byAccess(facts, DEFAULT_ACCESS.plan_submit, 'write_plan');

/** Causes of a G4 check that failed (`waiting_cause`), as `WAITING_CAUSE_KEYS` lists them. */
export const CAUSE_RULES: Readonly<Record<string, Rule>> = {
  spec_changed: (facts) => byAccess(facts, DEFAULT_ACCESS.spec_link, 'link_spec'),
  plan_changed: (facts) => byAccess(facts, DEFAULT_ACCESS.plan_submit, 'resubmit_plan'),
  ai_record_missing: (facts) => byAccess(facts, DEFAULT_ACCESS.ai_record_write, 'ai_record'),
  data_class_not_allowed: (facts) => byAccess(facts, DEFAULT_ACCESS.ai_record_write, 'ai_record'),
  agent_not_configured: setupAgent,
  agent_not_found: setupAgent,
  agent_not_active: setupAgent,
  autonomy_above_agent: setupAgent,
  environment_not_approved: setupAgent,
  model_not_allowed: setupAgent,
  model_not_pinned: setupAgent,
  instructions_missing: setupAgent,
  instructions_mismatch: setupAgent,
  instructions_unpinned: setupAgent,
  tree_truncated: setupAgent,
  plan_tools_not_registered: setupAgent,
  // X04: the tool register is set up by tenant admins, like the agent register.
  tool_not_found: setupAgent,
  tool_not_allowed_for_agent: setupAgent,
  tool_not_active: setupAgent,
  tool_data_class_not_allowed: setupAgent,
  tool_transport_not_supported: setupAgent,
  // H05 (ADR-M95): G5 waits for Person A because the change is over the review limits.
  review_too_large: decide('decide_g5_review'),
  review_size_unknown: decide('decide_g5_review'),
  // H02 (ADR-M96): G6 waits for Person B because dependencies have findings or scan failed.
  dependency_finding: decide('decide_g6'),
  dependency_scan_failed: decide('decide_g6'),
  intent_budget_exhausted: (facts) => advice('fix_setup', 'setup_budget', facts),
  tenant_budget_exhausted: (facts) => advice('fix_setup', 'setup_budget', facts),
};

function setupAgent(facts: Facts): Advice {
  return advice('fix_setup', 'setup_agent', facts, {}, [], ['admin_only']);
}

/**
 * G7's approvals are complete; a person merges (ADR-M41 §2.5). Only a holder of G7's role who is
 * not a producer is told to merge (D-08 V06 AC2): person_b, and the second approver when two
 * approvals are needed. Everyone else waits for them.
 */
function mergeAtG7(facts: Facts): Advice {
  const waiting = facts.intent.waiting_for;
  const roles =
    waiting && waiting.roles.length > 0
      ? waiting.roles
      : (waiting?.approvals_needed ?? 1) > 1
        ? ['person_b', 'second_approver']
        : ['person_b'];
  const params = { roles: roles.join(', '), needed: String(waiting?.approvals_needed ?? 1) };
  if (!holdsAny(facts.caller, roles))
    return advice('waits_for', 'waits_role', facts, params, roles);
  if (facts.caller.producer) return advice('waits_for', 'producer', facts, params, roles);
  return advice('you_act', 'merge_g7', facts);
}

/** One rule per waiting reason; `Record` makes the compiler check that none is missing. */
export const REASON_RULES: Readonly<Record<IntentWaitReason, Rule>> = {
  decision: decideAtGate,
  // H05: a run held for its size has its own advice (the allowing reason codes, the split).
  g5_decision: (facts) => {
    const cause = facts.intent.waiting_cause;
    const rule = cause ? CAUSE_RULES[cause] : undefined;
    return rule ? rule(facts) : decide('decide_g5')(facts);
  },
  g6_decision: decide('decide_g6'),
  g7_decision: decide('review_g7'),
  g8_decision: decide('decide_g8'),
  g7_merge: mergeAtG7,
  input_missing: inputMissing,
  new_plan_needed: (facts) => byAccess(facts, DEFAULT_ACCESS.plan_submit, 'new_plan'),
  plan_resubmit_needed: (facts) => byAccess(facts, DEFAULT_ACCESS.plan_submit, 'resubmit_plan'),
  spec_unavailable: (facts) => byAccess(facts, DEFAULT_ACCESS.spec_link, 'fix_spec'),
  spec_unclear: (facts) => byAccess(facts, DEFAULT_ACCESS.spec_link, 'spec_unclear'),
  ai_record: (facts) => byAccess(facts, DEFAULT_ACCESS.ai_record_write, 'ai_record'),
  frozen: escalationRule('frozen'),
  run_review: escalationRule('run_review'),
  g5_review: escalationRule('g5_review'),
  publish_review: escalationRule('publish_review'),
  g7_review: escalationRule('g7_review'),
  g8_review: escalationRule('g8_review'),
  // The passed gate is an earlier one (the intent may already wait at G4): one advice for all.
  hotl_block_window: (facts) => advice('platform', 'block_window', facts),
  g4_check: (facts) => {
    const cause = facts.intent.waiting_cause;
    const rule = cause ? CAUSE_RULES[cause] : undefined;
    return rule ? rule(facts) : advice('fix_setup', 'setup_agent', facts, {}, [], ['admin_only']);
  },
  run_pending: (facts) => advice('platform', 'run_pending', facts),
  run_in_progress: (facts) =>
    holdsAny(facts.caller, DEFAULT_ACCESS.kill)
      ? advice('platform', 'run_running', facts)
      : advice('platform', 'run_watch', facts),
  proposal_review: (facts) =>
    facts.caller.roles.has('person_a')
      ? advice('you_act', 'proposal', facts)
      : advice('waits_for', 'waits_role', facts, { roles: 'person_a' }, ['person_a']),
  ci_pending: (facts) => advice('platform', 'ci_pending', facts),
  // O06 (ADR-M106): no check at all; the project's people add CI (not only an admin).
  ci_missing: (facts) => advice('fix_setup', 'setup_ci', facts),
  publish_retry: (facts) => advice('platform', 'publish_retry', facts),
  g7_changes_requested: (facts) => advice('platform', 'changes_requested', facts),
  git_host_unavailable: (facts) => advice('fix_setup', 'setup_git_host', facts),
  evidence_unavailable: (facts) => advice('fix_setup', 'setup_evidence', facts),
  later_gate: (facts) => advice('fix_setup', 'setup_later_gate', facts),
  not_in_gate: byStatus,
};

/** Without a recorded reason: the intent's status says what is left. */
function byStatus(facts: Facts): Advice {
  const status = facts.intent.status;
  if (FINISHED.has(status)) return advice('finished', 'finished', facts);
  if (status === 'blocked') return advice('finished', 'blocked', facts);
  if (status === 'running') return REASON_RULES.run_in_progress(facts);
  if (status === 'paused') return escalationRule('frozen')(facts);
  if (status === 'in_gate' && facts.intent.waiting_for) return decideAtGate(facts);
  return advice('waits_for', 'unknown', facts);
}

/**
 * Producers known from the two reads (QUESTIONS #368), as the platform counts them (core
 * `gate-command.ts` `producersOf`): at G5 and G6 the person who allowed the last run (the latest
 * G4 approval); at G7 and G8 the intent's creator and every G4 approver. The plan submitter (G3,
 * G7, G8) and commit authors (G7) are not in these answers.
 */
function isProducer(intent: IntentDetail, userId: string): boolean {
  const gate = intent.current_gate;
  const g4Approvals = intent.decisions.filter((d) => d.gate === 'G4' && d.decision === 'approve');
  // G5, G6: the person who allowed the last run (`runProducers` in core `gate-command.ts`), that
  // is the latest G4 approval.
  if (gate === 'G5' || gate === 'G6') {
    const latest = g4Approvals.reduce<(typeof g4Approvals)[number] | undefined>(
      (last, d) => (last === undefined || d.created_at > last.created_at ? d : last),
      undefined,
    );
    return latest?.decided_by === userId;
  }
  // G7, G8: the creator and every run's starter (`g7Producers`, `g8Producers`).
  if (gate === 'G7' || gate === 'G8') {
    return intent.created_by === userId || g4Approvals.some((d) => d.decided_by === userId);
  }
  return false;
}

/** The caller already approved the current gate in this visit (after it entered the gate). */
function approvedHere(intent: IntentDetail, userId: string): boolean {
  const since = intent.gate_entered_at;
  return intent.decisions.some(
    (d) =>
      d.gate === intent.current_gate &&
      d.decision === 'approve' &&
      d.decided_by === userId &&
      (since === null || d.created_at >= since),
  );
}

/** The advice for `me` about `intent`. */
export function adviseNext(intent: IntentDetail, me: Me): Advice {
  const roles = new Set(
    me.roles.filter((binding) => binding.project.id === intent.project.id).map((b) => b.role),
  );
  const caller: Caller = {
    roles,
    tenantAdmin: me.tenant_admin === true,
    producer: isProducer(intent, me.user.id),
    approvedHere: approvedHere(intent, me.user.id),
  };
  const facts: Facts = {
    intent,
    caller,
    base: {
      intent: intent.code,
      project: intent.project.slug,
      gate: intent.current_gate ?? '-',
      status: intent.status,
      issue: intent.issue_number === null ? '-' : String(intent.issue_number),
      pr: intent.pr_number === null ? '-' : String(intent.pr_number),
      data_class: intent.data_class,
      until: intent.waiting_until ?? '-',
      cause: intent.waiting_cause ?? '-',
      reason: intent.waiting_reason ?? intent.status,
    },
  };
  if (FINISHED.has(intent.status)) return advice('finished', 'finished', facts);
  if (intent.status === 'blocked') return advice('finished', 'blocked', facts);
  const reason = intent.waiting_reason;
  if (reason === null || reason === undefined) return byStatus(facts);
  const rule = (REASON_RULES as Readonly<Record<string, Rule>>)[reason];
  return rule ? rule(facts) : advice('waits_for', 'unknown', facts);
}
