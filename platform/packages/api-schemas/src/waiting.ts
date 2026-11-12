// Labels of the workflow's waiting reasons and causes (U02, ADR-M54 §2.4b): catalog keys of
// `@sdlc/messages`, shared by the CLI and the dashboard. A reason or cause without a key here is
// shown as its code; the catalog test checks that every known one has a key.

/** `IntentWaitReason` (contracts) → its catalog key. */
export const WAITING_REASON_KEYS: Readonly<Record<string, string>> = {
  decision: 'intent.waiting.decision',
  input_missing: 'intent.waiting.input_missing',
  ai_record: 'intent.waiting.ai_record',
  frozen: 'intent.waiting.frozen',
  later_gate: 'intent.waiting.later_gate',
  hotl_block_window: 'intent.waiting.hotl_block_window',
  g4_check: 'intent.waiting.g4_check',
  run_pending: 'intent.waiting.run_pending',
  git_host_unavailable: 'intent.waiting.git_host_unavailable',
  spec_unavailable: 'intent.waiting.spec_unavailable',
  spec_unclear: 'intent.waiting.spec_unclear',
  plan_resubmit_needed: 'intent.waiting.plan_resubmit_needed',
  run_in_progress: 'intent.waiting.run_in_progress',
  run_review: 'intent.waiting.run_review',
  proposal_review: 'intent.waiting.proposal_review',
  g5_review: 'intent.waiting.g5_review',
  g5_decision: 'intent.waiting.g5_decision',
  new_plan_needed: 'intent.waiting.new_plan_needed',
  publish_review: 'intent.waiting.publish_review',
  publish_retry: 'intent.waiting.publish_retry',
  ci_pending: 'intent.waiting.ci_pending',
  ci_missing: 'intent.waiting.ci_missing',
  g6_decision: 'intent.waiting.g6_decision',
  g7_decision: 'intent.waiting.g7_decision',
  g7_merge: 'intent.waiting.g7_merge',
  g7_changes_requested: 'intent.waiting.g7_changes_requested',
  g7_review: 'intent.waiting.g7_review',
  g8_decision: 'intent.waiting.g8_decision',
  g8_review: 'intent.waiting.g8_review',
  evidence_unavailable: 'intent.waiting.evidence_unavailable',
  not_in_gate: 'intent.waiting.not_in_gate',
};

/** Known causes (the failed G4 check; the G5 review size, H05) → their catalog key. */
export const WAITING_CAUSE_KEYS: Readonly<Record<string, string>> = {
  spec_changed: 'intent.waiting_cause.spec_changed',
  plan_changed: 'intent.waiting_cause.plan_changed',
  ai_record_missing: 'intent.waiting_cause.ai_record_missing',
  data_class_not_allowed: 'intent.waiting_cause.data_class_not_allowed',
  agent_not_configured: 'intent.waiting_cause.agent_not_configured',
  agent_not_found: 'intent.waiting_cause.agent_not_found',
  agent_not_active: 'intent.waiting_cause.agent_not_active',
  autonomy_above_agent: 'intent.waiting_cause.autonomy_above_agent',
  environment_not_approved: 'intent.waiting_cause.environment_not_approved',
  model_not_allowed: 'intent.waiting_cause.model_not_allowed',
  model_not_pinned: 'intent.waiting_cause.model_not_pinned',
  instructions_missing: 'intent.waiting_cause.instructions_missing',
  instructions_mismatch: 'intent.waiting_cause.instructions_mismatch',
  instructions_unpinned: 'intent.waiting_cause.instructions_unpinned',
  tree_truncated: 'intent.waiting_cause.tree_truncated',
  intent_budget_exhausted: 'intent.waiting_cause.intent_budget_exhausted',
  tenant_budget_exhausted: 'intent.waiting_cause.tenant_budget_exhausted',
  plan_tools_not_registered: 'intent.waiting_cause.plan_tools_not_registered',
  // X04 (ADR-M69 §2.3): a register tool the plan asks for cannot be given to the run.
  tool_not_found: 'intent.waiting_cause.tool_not_found',
  tool_not_allowed_for_agent: 'intent.waiting_cause.tool_not_allowed_for_agent',
  tool_not_active: 'intent.waiting_cause.tool_not_active',
  tool_data_class_not_allowed: 'intent.waiting_cause.tool_data_class_not_allowed',
  tool_transport_not_supported: 'intent.waiting_cause.tool_transport_not_supported',
  // H05 (ADR-M95): G5 is HITL because the run's change is over the review limits, or not measured.
  review_too_large: 'intent.waiting_cause.review_too_large',
  review_size_unknown: 'intent.waiting_cause.review_size_unknown',
  // H02 (ADR-M96): G6 is HITL because added dependencies have findings or scan failed.
  dependency_finding: 'intent.waiting_cause.dependency_finding',
  dependency_scan_failed: 'intent.waiting_cause.dependency_scan_failed',
};

/** The reason a person needs to see: `decision` is the normal wait, already shown elsewhere. */
export function isHold(reason: string | null | undefined): reason is string {
  return reason !== null && reason !== undefined && reason !== 'decision';
}
