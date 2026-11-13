// D-08 A05 AC2: validation refuses configurations that loosen mandatory rules, with clear messages
// from the message catalog. Rules M1–M32: platform/packages/config/src/mandatory-rules.ts.
import { formatIssue, MANDATORY_RULES } from '@sdlc/config';
import { describe, expect, it } from 'vitest';

import { keysAndPaths, loadErrors, loadValid } from './helpers';

const cell = (gate: string, tier: string, body: string) =>
  `oversight:\n  matrix:\n    ${gate}:\n      ${tier}: ${body}\n`;
const g8 = (env: string, tier: string, body: string) =>
  `oversight:\n  matrix:\n    G8:\n      ${env}:\n        ${tier}: ${body}\n`;
const sla = (severity: string, clock: string, body: string) =>
  `escalation:\n  sla:\n    ${severity}:\n      ${clock}: ${body}\n`;

interface Case {
  name: string;
  rule: string;
  yaml: string;
  key: string;
  path: string;
}

const CASES: Case[] = [
  // M1: G1 HITL at every tier.
  {
    name: 'G1 low as HOTL',
    rule: 'M1',
    yaml: cell('G1', 'low', '{ mode: HOTL }'),
    key: 'config.rule.g1_hitl',
    path: 'oversight.matrix.G1.low.mode',
  },
  {
    name: 'G1 critical as AUDIT',
    rule: 'M1',
    yaml: cell('G1', 'critical', '{ mode: AUDIT }'),
    key: 'config.rule.g1_hitl',
    path: 'oversight.matrix.G1.critical.mode',
  },
  // M2: G7 HITL at every tier, Person B, Critical dual approval.
  {
    name: 'G7 low as HOTL',
    rule: 'M2',
    yaml: cell('G7', 'low', '{ mode: HOTL }'),
    key: 'config.rule.g7_hitl',
    path: 'oversight.matrix.G7.low.mode',
  },
  {
    name: 'G7 without Person B',
    rule: 'M2',
    yaml: cell('G7', 'medium', '{ roles: [person_a] }'),
    key: 'config.rule.person_b_required',
    path: 'oversight.matrix.G7.medium.roles',
  },
  {
    name: 'G7 critical with one approval',
    rule: 'M2',
    yaml: cell('G7', 'critical', '{ approvals: 1 }'),
    key: 'config.rule.critical_dual_approval',
    path: 'oversight.matrix.G7.critical',
  },
  {
    name: 'G7 critical without the second approver',
    rule: 'M2',
    yaml: cell('G7', 'critical', '{ roles: [person_b, governance] }'),
    key: 'config.rule.critical_dual_approval',
    path: 'oversight.matrix.G7.critical',
  },
  // M3: G8 production HITL, Person B, Critical dual approval (both environments).
  {
    name: 'G8 production low as HOTL',
    rule: 'M3',
    yaml: g8('production', 'low', '{ mode: HOTL }'),
    key: 'config.rule.g8_production_hitl',
    path: 'oversight.matrix.G8.production.low.mode',
  },
  {
    name: 'G8 production without Person B',
    rule: 'M3',
    yaml: g8('production', 'high', '{ roles: [governance] }'),
    key: 'config.rule.person_b_required',
    path: 'oversight.matrix.G8.production.high.roles',
  },
  {
    name: 'G8 non-production critical with one approval',
    rule: 'M3',
    yaml: g8('non_production', 'critical', '{ approvals: 1 }'),
    key: 'config.rule.critical_dual_approval',
    path: 'oversight.matrix.G8.non_production.critical',
  },
  // M4, M5: handbook change-flag lists.
  {
    name: 'forced-HITL list without migration',
    rule: 'M4',
    yaml: 'oversight:\n  forced_hitl_g3:\n    change_flags: [breaking_contract, new_service_boundary, security_boundary, system_of_record, prod_infrastructure, core_business_rule]\n',
    key: 'config.rule.forced_hitl_flag_missing',
    path: 'oversight.forced_hitl_g3.change_flags',
  },
  {
    name: 'dual-approval list without personal_data',
    rule: 'M5',
    yaml: 'oversight:\n  dual_approval_g7:\n    change_flags: [migration, payment, prod_infrastructure, breaking_contract, safety_function]\n',
    key: 'config.rule.dual_approval_flag_missing',
    path: 'oversight.dual_approval_g7.change_flags',
  },
  {
    name: 'dual-approval roles without the second approver',
    rule: 'M5',
    yaml: 'oversight:\n  dual_approval_g7:\n    roles: [person_b, governance]\n',
    key: 'config.rule.dual_approval_role_missing',
    path: 'oversight.dual_approval_g7.roles',
  },
  // M6: security findings at G6.
  {
    name: 'security findings as HOTL',
    rule: 'M6',
    yaml: 'oversight:\n  g6_security_findings: { mode: HOTL }\n',
    key: 'config.rule.g6_security_hitl',
    path: 'oversight.g6_security_findings.mode',
  },
  // M7: autonomy.
  {
    name: 'low risk at L3',
    rule: 'M7',
    yaml: 'autonomy:\n  max_by_risk: { low: L3 }\n',
    key: 'config.rule.autonomy_above_mvp',
    path: 'autonomy.max_by_risk.low',
  },
  {
    name: 'critical risk at L1',
    rule: 'M7',
    yaml: 'autonomy:\n  max_by_risk: { critical: L1 }\n',
    key: 'config.rule.autonomy_critical_l0',
    path: 'autonomy.max_by_risk.critical',
  },
  {
    name: 'high risk at L2',
    rule: 'M7',
    yaml: 'autonomy:\n  max_by_risk: { high: L2 }\n',
    key: 'config.rule.autonomy_high_l1',
    path: 'autonomy.max_by_risk.high',
  },
  {
    name: 'medium risk above low risk',
    rule: 'M7',
    yaml: 'autonomy:\n  max_by_risk: { low: L1, medium: L2 }\n',
    key: 'config.rule.autonomy_order',
    path: 'autonomy.max_by_risk.medium',
  },
  // M8: model routing.
  {
    name: 'client_restricted data to API models',
    rule: 'M8',
    yaml: 'model_routing:\n  allowed_provider_types:\n    client_restricted: [self_hosted, api]\n',
    key: 'config.rule.routing_restricted_self_hosted',
    path: 'model_routing.allowed_provider_types.client_restricted',
  },
  {
    name: 'prohibited data to a model',
    rule: 'M8',
    yaml: 'model_routing:\n  allowed_provider_types:\n    prohibited: [self_hosted]\n',
    key: 'config.rule.routing_prohibited_none',
    path: 'model_routing.allowed_provider_types.prohibited',
  },
  // M9: budget thresholds.
  {
    name: 'warning at 90 %',
    rule: 'M9',
    yaml: 'budget:\n  warn_percent: 90\n',
    key: 'config.rule.budget_warn_max',
    path: 'budget.warn_percent',
  },
  {
    name: 'stop at 120 %',
    rule: 'M9',
    yaml: 'budget:\n  stop_percent: 120\n',
    key: 'config.rule.budget_stop_max',
    path: 'budget.stop_percent',
  },
  {
    name: 'warning after the stop',
    rule: 'M9',
    yaml: 'budget:\n  warn_percent: 70\n  stop_percent: 60\n',
    key: 'config.rule.budget_warn_before_stop',
    path: 'budget.warn_percent',
  },
  // M10: loop detection.
  {
    name: 'loop limit 5',
    rule: 'M10',
    yaml: 'run:\n  loop_detection:\n    identical_tool_calls_max: 5\n',
    key: 'config.rule.loop_max',
    path: 'run.loop_detection.identical_tool_calls_max',
  },
  // M11: SLA clocks.
  {
    name: 'critical acknowledge 30 minutes',
    rule: 'M11',
    yaml: sla('critical', 'acknowledge', '{ value: 30, unit: minutes }'),
    key: 'config.rule.sla_longer',
    path: 'escalation.sla.critical.acknowledge',
  },
  {
    name: 'high acknowledge in working time',
    rule: 'M11',
    yaml: sla('high', 'acknowledge', '{ value: 1, unit: working_hours }'),
    key: 'config.rule.sla_longer',
    path: 'escalation.sla.high.acknowledge',
  },
  {
    name: 'medium resolve 4 working days',
    rule: 'M11',
    yaml: sla('medium', 'resolve', '{ value: 4, unit: working_days }'),
    key: 'config.rule.sla_longer',
    path: 'escalation.sla.medium.resolve',
  },
  {
    name: 'high resolve without a clock',
    rule: 'M11',
    yaml: sla('high', 'resolve', '{ kind: next_planned_work }'),
    key: 'config.rule.sla_longer',
    path: 'escalation.sla.high.resolve',
  },
  {
    name: 'critical resolve at the end of the day',
    rule: 'M11',
    yaml: sla('critical', 'resolve', '{ kind: end_of_working_day }'),
    key: 'config.rule.sla_longer',
    path: 'escalation.sla.critical.resolve',
  },
  {
    name: 'calendar with 4 working days per week',
    rule: 'M11',
    yaml: 'escalation:\n  calendar:\n    working_days: [mon, tue, wed, thu]\n',
    key: 'config.rule.calendar_min_working_days',
    path: 'escalation.calendar.working_days',
  },
  {
    name: 'calendar with 6 h 59 min working days',
    rule: 'M11',
    yaml: "escalation:\n  calendar:\n    working_hours: { start: '09:00', end: '15:59' }\n",
    key: 'config.rule.calendar_min_working_hours',
    path: 'escalation.calendar.working_hours',
  },
  // M12: cell structure.
  {
    name: 'POLICY at G5',
    rule: 'M12',
    yaml: cell('G5', 'low', '{ mode: POLICY, roles: [] }'),
    key: 'config.rule.policy_only_g4',
    path: 'oversight.matrix.G5.low.mode',
  },
  {
    name: 'POLICY with roles',
    rule: 'M12',
    yaml: cell('G4', 'low', '{ roles: [person_a] }'),
    key: 'config.rule.policy_no_roles',
    path: 'oversight.matrix.G4.low.roles',
  },
  {
    name: 'HOTL with nobody to notify',
    rule: 'M12',
    yaml: cell('G2', 'low', '{ roles: [] }'),
    key: 'config.rule.roles_required',
    path: 'oversight.matrix.G2.low.roles',
  },
  {
    name: 'more approvals than roles',
    rule: 'M12',
    yaml: cell('G3', 'medium', '{ approvals: 2 }'),
    key: 'config.rule.approvals_exceed_roles',
    path: 'oversight.matrix.G3.medium.approvals',
  },
  {
    name: 'viewer as approver',
    rule: 'M12',
    yaml: cell('G3', 'medium', '{ roles: [person_b, viewer] }'),
    key: 'config.rule.viewer_never_approves',
    path: 'oversight.matrix.G3.medium.roles',
  },
  {
    name: 'on_breach that is not stricter',
    rule: 'M12',
    yaml: cell('G5', 'high', '{ on_breach: AUDIT }'),
    key: 'config.rule.on_breach_stricter',
    path: 'oversight.matrix.G5.high.on_breach',
  },
  // M13: human approval of high-risk effects.
  {
    name: 'G2 high as HOTL',
    rule: 'M13',
    yaml: cell('G2', 'high', '{ mode: HOTL }'),
    key: 'config.rule.high_risk_hitl',
    path: 'oversight.matrix.G2.high.mode',
  },
  {
    name: 'G3 critical as HOTL',
    rule: 'M13',
    yaml: cell('G3', 'critical', '{ mode: HOTL }'),
    key: 'config.rule.high_risk_hitl',
    path: 'oversight.matrix.G3.critical.mode',
  },
  {
    name: 'G6 high as HOTL',
    rule: 'M13',
    yaml: cell('G6', 'high', '{ mode: HOTL }'),
    key: 'config.rule.high_risk_hitl',
    path: 'oversight.matrix.G6.high.mode',
  },
  {
    name: 'G8 non-production critical as HOTL',
    rule: 'M13',
    yaml: g8('non_production', 'critical', '{ mode: HOTL, approvals: 2 }'),
    key: 'config.rule.high_risk_hitl',
    path: 'oversight.matrix.G8.non_production.critical.mode',
  },
  // M14: permission before dangerous actions.
  {
    name: 'G4 high as POLICY',
    rule: 'M14',
    yaml: cell('G4', 'high', '{ mode: POLICY, roles: [] }'),
    key: 'config.rule.g4_high_risk_hitl',
    path: 'oversight.matrix.G4.high.mode',
  },
  // M15: independent verification.
  {
    name: 'G6 low as POLICY',
    rule: 'M15',
    yaml: cell('G6', 'low', '{ mode: POLICY, roles: [] }'),
    key: 'config.rule.g6_independent_verification',
    path: 'oversight.matrix.G6.low.mode',
  },
  // M16: the viewer role never creates intents (B03, QUESTIONS.md #66).
  {
    name: 'viewer may create intents',
    rule: 'M16',
    yaml: 'access:\n  intent_create_roles: [person_a, viewer]\n',
    key: 'config.rule.viewer_never_creates',
    path: 'access.intent_create_roles',
  },
  // M17: escalation routing and notification (B11, QUESTIONS.md #74, handbook Ch.6 §6.4).
  {
    name: 'policy escalations owned by Person A',
    rule: 'M17',
    yaml: 'escalation:\n  routing:\n    policy: { owner_role: person_a, backup_role: null }\n',
    key: 'config.rule.escalation_policy_owner',
    path: 'escalation.routing.policy.owner_role',
  },
  {
    name: 'viewer as escalation owner',
    rule: 'M17',
    yaml: 'escalation:\n  routing:\n    intent: { owner_role: viewer, backup_role: person_b }\n',
    key: 'config.rule.escalation_viewer',
    path: 'escalation.routing.intent.owner_role',
  },
  {
    name: 'viewer as escalation backup',
    rule: 'M17',
    yaml: 'escalation:\n  routing:\n    technical: { owner_role: person_b, backup_role: viewer }\n',
    key: 'config.rule.escalation_viewer',
    path: 'escalation.routing.technical.backup_role',
  },
  {
    name: 'backup role equal to the owner role',
    rule: 'M17',
    yaml: 'escalation:\n  routing:\n    security: { owner_role: person_b, backup_role: person_b }\n',
    key: 'config.rule.escalation_backup_same',
    path: 'escalation.routing.security.backup_role',
  },
  {
    name: 'critical escalation does not tell governance',
    rule: 'M17',
    yaml: 'escalation:\n  notify_on_raise:\n    critical: [person_a, person_b]\n',
    key: 'config.rule.escalation_notify_missing',
    path: 'escalation.notify_on_raise.critical',
  },
  {
    name: 'viewer told about a low escalation',
    rule: 'M17',
    yaml: 'escalation:\n  notify_on_raise:\n    low: [person_a, viewer]\n',
    key: 'config.rule.escalation_viewer',
    path: 'escalation.notify_on_raise.low',
  },
  // M18: agent recertification at least every 3 months (C10, handbook Ch.20 §20.8, ADR-M31).
  {
    name: 'agents recertified every 4 months',
    rule: 'M18',
    yaml: 'agents:\n  recertification_months: 4\n',
    key: 'config.rule.recertification_max',
    path: 'agents.recertification_months',
  },
  // X04 (ADR-M69 §2.2): the same limit for register tools.
  {
    name: 'tools recertified every 4 months',
    rule: 'M18',
    yaml: 'tools:\n  recertification_months: 4\n',
    key: 'config.rule.recertification_max',
    path: 'tools.recertification_months',
  },
  // M19: the viewer role never writes the project AI record (B12, ADR-M32, QUESTIONS.md #103).
  {
    name: 'viewer may write the AI record',
    rule: 'M19',
    yaml: 'access:\n  ai_record_write_roles: [pm_brse, viewer]\n',
    key: 'config.rule.viewer_never_writes_ai_record',
    path: 'access.ai_record_write_roles',
  },
  // M23: the viewer role never links a spec (B08, ADR-M39, QUESTIONS.md #162).
  {
    name: 'viewer may link a spec',
    rule: 'M23',
    yaml: 'access:\n  spec_link_roles: [person_a, viewer]\n',
    key: 'config.rule.viewer_never_links_spec',
    path: 'access.spec_link_roles',
  },
  // M24: the viewer role never submits a plan (B09, ADR-M40, QUESTIONS.md #168).
  {
    name: 'viewer may submit a plan',
    rule: 'M24',
    yaml: 'access:\n  plan_submit_roles: [person_a, viewer]\n',
    key: 'config.rule.viewer_never_submits_plan',
    path: 'access.plan_submit_roles',
  },
  // M20: a failed or lost run freezes the intent (C06 session 2, ADR-M33 §2.7).
  {
    name: 'a failed run only notifies',
    rule: 'M20',
    yaml: 'run:\n  failed_run_escalation: { severity: high, response_level: notify }\n',
    key: 'config.rule.failed_run_escalation_freezes',
    path: 'run.failed_run_escalation.response_level',
  },
  // M21: Person A and Person B stay a conflicting pair (B13, ADR-M37, QUESTIONS #154).
  {
    name: 'conflicting roles without Person A and Person B',
    rule: 'M21',
    yaml: 'access:\n  conflicting_roles: [[person_b, second_approver]]\n',
    key: 'config.rule.person_a_person_b_conflict',
    path: 'access.conflicting_roles',
  },
  {
    name: 'no conflicting roles at all',
    rule: 'M21',
    yaml: 'access:\n  conflicting_roles: []\n',
    key: 'config.rule.person_a_person_b_conflict',
    path: 'access.conflicting_roles',
  },
  // M22: a G5 breach freezes the intent (C07, QUESTIONS #21, ADR-M34 §2.8).
  {
    name: 'a G5 breach only observes',
    rule: 'M22',
    yaml: 'run:\n  g5_breach_escalation: { severity: medium, response_level: observe }\n',
    key: 'config.rule.g5_breach_escalation_freezes',
    path: 'run.g5_breach_escalation.response_level',
  },
  // M25: FR-34's roles may always kill; the viewer never (C11, ADR-M42, QUESTIONS #180).
  {
    name: 'governance may not kill',
    rule: 'M25',
    yaml: 'access:\n  kill_roles: [person_a, person_b]\n',
    key: 'config.rule.kill_roles_contain_fr34',
    path: 'access.kill_roles',
  },
  {
    name: 'viewer may kill',
    rule: 'M25',
    yaml: 'access:\n  kill_roles: [person_a, person_b, governance, viewer]\n',
    key: 'config.rule.viewer_never_kills',
    path: 'access.kill_roles',
  },
  // M26: a kill freezes the intent (C11, QUESTIONS #181).
  {
    name: 'a kill only notifies',
    rule: 'M26',
    yaml: 'run:\n  kill_escalation: { severity: high, response_level: notify }\n',
    key: 'config.rule.kill_escalation_freezes',
    path: 'run.kill_escalation.response_level',
  },
  // M27: the no-progress window of loop detection (C11 PR 2, QUESTIONS #184).
  {
    name: 'no-progress window 31 minutes',
    rule: 'M27',
    yaml: 'run:\n  loop_detection:\n    no_progress_window_minutes: 31\n',
    key: 'config.rule.loop_window_max',
    path: 'run.loop_detection.no_progress_window_minutes',
  },
  // M28: the viewer never reads the cost report (E04, ADR-M45, QUESTIONS #196).
  {
    name: 'viewer may read cost',
    rule: 'M28',
    yaml: 'access:\n  cost_read_roles: [person_a, viewer]\n',
    key: 'config.rule.viewer_never_reads_cost',
    path: 'access.cost_read_roles',
  },
  // M29: the viewer never reads the gate metrics (E06, ADR-M47, QUESTIONS #206).
  {
    name: 'viewer may read gate metrics',
    rule: 'M29',
    yaml: 'access:\n  metrics_read_roles: [person_a, viewer]\n',
    key: 'config.rule.viewer_never_reads_metrics',
    path: 'access.metrics_read_roles',
  },
  // M33: the viewer never creates or runs evaluation plans (L05, ADR-M82, QUESTIONS #470).
  {
    name: 'viewer may run evaluation plans',
    rule: 'M33',
    yaml: 'access:\n  eval_roles: [person_a, viewer]\n',
    key: 'config.rule.viewer_never_runs_evaluations',
    path: 'access.eval_roles',
  },
  // M34: an evaluation counts for a recertification for 90 days at most (L09, ADR-M86 §2.4).
  {
    name: 'an evaluation counts for a recertification for 91 days',
    rule: 'M34',
    yaml: 'agents:\n  evaluation:\n    recertification_max_age_days: 91\n',
    key: 'config.rule.recertification_evaluation_max_age',
    path: 'agents.evaluation.recertification_max_age_days',
  },
  // M35: context condensing only with a known context size (X11, ADR-M29 §2.10).
  {
    name: 'context condensing on without any context size',
    rule: 'M35',
    yaml: 'run:\n  context_condensing:\n    mode: summarize\n',
    key: 'config.rule.condensing_context_unknown',
    path: 'run.context_condensing.model_context_tokens',
  },
  // M36: agent memory caps and proposals (X13, ADR-M74 §2.2, QUESTIONS #574).
  {
    name: 'a memory file cap above the total cap',
    rule: 'M36',
    yaml: 'memory:\n  max_file_chars: 8000\n  max_total_chars: 4000\n',
    key: 'config.rule.memory_file_over_total',
    path: 'memory.max_file_chars',
  },
  {
    name: 'memory proposals on a project whose agents never run at L2',
    rule: 'M36',
    yaml: 'memory:\n  mode: read_propose\nautonomy:\n  max_by_risk:\n    low: L1\n    medium: L1\n    high: L1\n    critical: L0\n',
    key: 'config.rule.memory_propose_needs_l2',
    path: 'memory.mode',
  },
  // M30: the viewer never builds or reads an Evidence Pack (E02, ADR-M48, QUESTIONS #218).
  {
    name: 'viewer may build evidence packs',
    rule: 'M30',
    yaml: 'access:\n  evidence_build_roles: [person_a, viewer]\n',
    key: 'config.rule.viewer_never_reads_evidence',
    path: 'access.evidence_build_roles',
  },
  {
    name: 'viewer may read evidence packs',
    rule: 'M30',
    yaml: 'access:\n  evidence_read_roles: [person_a, viewer]\n',
    key: 'config.rule.viewer_never_reads_evidence',
    path: 'access.evidence_read_roles',
  },
  // M31: evidence is kept between 180 and 3650 days (E05, ADR-M51, QUESTIONS #236).
  {
    name: 'evidence retention below 180 days',
    rule: 'M31',
    yaml: 'retention:\n  evidence_retention_days: 179\n',
    key: 'config.rule.evidence_retention_bounds',
    path: 'retention.evidence_retention_days',
  },
  {
    name: 'evidence retention above 3650 days',
    rule: 'M31',
    yaml: 'retention:\n  evidence_retention_days: 3651\n',
    key: 'config.rule.evidence_retention_bounds',
    path: 'retention.evidence_retention_days',
  },
  // M32: the viewer never puts evidence on hold (E05, ADR-M51, QUESTIONS #235).
  {
    name: 'viewer may hold evidence',
    rule: 'M32',
    yaml: 'access:\n  evidence_hold_roles: [governance, viewer]\n',
    key: 'config.rule.viewer_never_holds_evidence',
    path: 'access.evidence_hold_roles',
  },
];

describe('mandatory rules refuse loosening (AC2)', () => {
  it.each(CASES)('$rule: $name', ({ rule, yaml, key, path }) => {
    const errors = loadErrors(yaml);
    const match = errors.find((e) => e.key === key && e.path === path);
    expect(match, errors.map((e) => formatIssue(e)).join('\n')).toBeDefined();
    expect(match?.params.rule).toBe(rule);
  });

  it('has at least one test case for every rule', () => {
    const tested = new Set(CASES.map((c) => c.rule));
    expect(Object.keys(MANDATORY_RULES).filter((rule) => !tested.has(rule))).toEqual([]);
  });

  it('renders every refusal completely from the catalog', () => {
    for (const { yaml } of CASES) {
      for (const error of loadErrors(yaml)) {
        const text = formatIssue(error);
        expect(text, text).not.toMatch(/\{[a-z_]+\}/);
        expect(text.startsWith(`${error.path}: `)).toBe(true);
      }
    }
  });

  it('gives a clear English message', () => {
    const [error] = loadErrors(cell('G1', 'low', '{ mode: HOTL }'));
    expect(formatIssue(error!)).toBe(
      'oversight.matrix.G1.low.mode: G1 must be HITL at every risk tier; found HOTL for low (rule M1, codes table §4).',
    );
  });
});

describe('tightening is always allowed (AC2)', () => {
  it.each([
    ['G2 low HOTL → HITL', cell('G2', 'low', '{ mode: HITL }')],
    ['G4 low POLICY → HITL', cell('G4', 'low', '{ mode: HITL, roles: [person_a] }')],
    ['G6 low AUDIT → HOTL', cell('G6', 'low', '{ mode: HOTL }')],
    ['G5 medium with on_breach HITL', cell('G5', 'medium', '{ on_breach: HITL }')],
    [
      'G7 medium with two approvals',
      cell('G7', 'medium', '{ roles: [person_b, second_approver], approvals: 2 }'),
    ],
    ['medium risk at L1', 'autonomy:\n  max_by_risk: { medium: L1 }\n'],
    ['warning at 70 %, stop at 90 %', 'budget:\n  warn_percent: 70\n  stop_percent: 90\n'],
    ['loop limit 2', 'run:\n  loop_detection:\n    identical_tool_calls_max: 2\n'],
    ['agents recertified every 2 months', 'agents:\n  recertification_months: 2\n'],
    [
      'critical acknowledge 10 minutes',
      sla('critical', 'acknowledge', '{ value: 10, unit: minutes }'),
    ],
    [
      'medium acknowledge 4 wall-clock hours',
      sla('medium', 'acknowledge', '{ value: 4, unit: hours }'),
    ],
    ['medium resolve 2 working days', sla('medium', 'resolve', '{ value: 2, unit: working_days }')],
    [
      'low resolve 5 working days (was no clock)',
      sla('low', 'resolve', '{ value: 5, unit: working_days }'),
    ],
    ['G5 high set to HITL (on_breach HITL stays)', cell('G5', 'high', '{ mode: HITL }')],
    [
      'internal data self-hosted only',
      'model_routing:\n  allowed_provider_types:\n    internal: [self_hosted]\n',
    ],
  ])('%s', (_name, yaml) => {
    const { warnings } = loadValid(yaml);
    expect(warnings).toEqual([]);
  });
});

/** `count` distinct dates in `year`, one per week starting on 2 January. */
function holidays(year: number, count: number): string[] {
  return Array.from({ length: count }, (_, week) =>
    new Date(Date.UTC(year, 0, 2 + week * 7)).toISOString().slice(0, 10),
  );
}

describe('allowed loosening is reported as a warning (ADR-M13)', () => {
  it('warns when a non-mandatory cell is loosened', () => {
    const { warnings } = loadValid(cell('G2', 'medium', '{ mode: HOTL }'));
    expect(warnings.map((w) => [w.key, w.path])).toEqual([
      ['config.warning.mode_loosened', 'oversight.matrix.G2.medium.mode'],
    ]);
    expect(formatIssue(warnings[0]!)).toBe(
      'oversight.matrix.G2.medium.mode: oversight loosened from HITL (codes table default) to HOTL. This change must be reviewed.',
    );
  });

  it('warns for moderate calendar changes: a working day swapped out, shorter working hours', () => {
    const { warnings } = loadValid(
      "escalation:\n  calendar:\n    working_days: [tue, wed, thu, fri, sat]\n    working_hours: { start: '09:00', end: '17:00' }\n",
    );
    expect(warnings.map((w) => [w.key, w.path, w.params])).toEqual([
      ['config.warning.working_day_removed', 'escalation.calendar.working_days', { day: 'mon' }],
      [
        'config.warning.working_hours_shortened',
        'escalation.calendar.working_hours',
        { from: 540, to: 480 },
      ],
    ]);
  });

  it('accepts the calendar floor exactly: 5 working days, 7 working hours (with a warning)', () => {
    const { warnings } = loadValid(
      "escalation:\n  calendar:\n    working_hours: { start: '09:00', end: '16:00' }\n",
    );
    expect(warnings.map((w) => [w.key, w.params])).toEqual([
      ['config.warning.working_hours_shortened', { from: 540, to: 420 }],
    ]);
  });

  it('refuses a calendar below both floors with two errors, rule M11', () => {
    const errors = loadErrors(
      "escalation:\n  calendar:\n    working_days: [mon]\n    working_hours: { start: '10:00', end: '11:00' }\n",
    );
    expect(errors.map((e) => [e.key, e.params])).toEqual([
      ['config.rule.calendar_min_working_days', { minimum: 5, found: 1, rule: 'M11' }],
      ['config.rule.calendar_min_working_hours', { minimum: 7, found: 60, rule: 'M11' }],
    ]);
  });

  it('gives no warning for added working days, a longer day or up to 20 holidays a year', () => {
    const twenty = holidays(2027, 20);
    const { warnings } = loadValid(
      `escalation:\n  calendar:\n    holidays: [${twenty.join(', ')}]\n    working_days: [mon, tue, wed, thu, fri, sat]\n    working_hours: { start: '08:00', end: '18:00' }\n`,
    );
    expect(warnings).toEqual([]);
  });

  it('warns when one calendar year has more than 20 holidays', () => {
    const dates = [...holidays(2027, 21), ...holidays(2028, 20)];
    const { warnings } = loadValid(
      `escalation:\n  calendar:\n    holidays: [${dates.join(', ')}]\n`,
    );
    expect(warnings.map((w) => [w.key, w.path, w.params])).toEqual([
      [
        'config.warning.many_holidays',
        'escalation.calendar.holidays',
        { year: '2027', count: 21, maximum: 20 },
      ],
    ]);
    expect(formatIssue(warnings[0]!)).toBe(
      'escalation.calendar.holidays: 21 holidays in 2027 (more than 20), so working-time clocks run longer. This change must be reviewed.',
    );
  });

  it('warns when a G3 cell moves from HITL to HOTL at Medium risk', () => {
    const { warnings } = loadValid(cell('G3', 'medium', '{ mode: HOTL }'));
    expect(warnings.map((w) => w.key)).toEqual(['config.warning.mode_loosened']);
  });
});

// G6 security threshold (design/QUESTIONS.md #19): findings at or above `min_severity` make G6
// HITL; a critical finding always does (rule M6).
describe('G6 security findings threshold', () => {
  const threshold = (value: string) =>
    `oversight:\n  g6_security_findings:\n    min_severity: ${value}\n`;

  it('defaults to HITL for findings at high or above', () => {
    expect(loadValid().config.oversight.g6_security_findings).toEqual({
      mode: 'HITL',
      min_severity: 'high',
    });
  });

  it('accepts a stricter threshold without a warning', () => {
    for (const value of ['medium', 'low']) {
      expect(loadValid(threshold(value)).warnings).toEqual([]);
    }
  });

  it('warns when the threshold is raised to critical', () => {
    const { warnings } = loadValid(threshold('critical'));
    expect(warnings.map((w) => [w.key, w.path, w.params])).toEqual([
      [
        'config.warning.g6_security_threshold_raised',
        'oversight.g6_security_findings.min_severity',
        { from: 'high', to: 'critical' },
      ],
    ]);
    expect(formatIssue(warnings[0]!)).toBe(
      'oversight.g6_security_findings.min_severity: G6 security threshold raised from high (default) to critical, so fewer findings need a person. This change must be reviewed.',
    );
  });

  it('refuses a severity that is not in the codes table (for example info)', () => {
    expect(keysAndPaths(loadErrors(threshold('info')))).toEqual([
      ['config.schema.invalid_value', 'oversight.g6_security_findings.min_severity'],
    ]);
  });

  it('refuses the old scalar form', () => {
    expect(
      keysAndPaths(loadErrors('oversight:\n  g6_security_findings: HITL\n')).map(([k]) => k),
    ).toContain('config.schema.invalid_type');
  });

  it('M6 refuses a threshold that would leave critical findings out', () => {
    const base = loadValid().config;
    const config = {
      ...base,
      oversight: {
        ...base.oversight,
        g6_security_findings: { mode: 'HITL', min_severity: 'none' },
      },
    } as unknown as typeof base;
    expect(MANDATORY_RULES.M6!(config).map((e) => [e.key, e.path, e.params])).toEqual([
      [
        'config.rule.g6_security_critical',
        'oversight.g6_security_findings.min_severity',
        { found: 'none', severity: 'critical' },
      ],
    ]);
  });
});
