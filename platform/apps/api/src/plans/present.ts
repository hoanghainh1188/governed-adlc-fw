// Response bodies of the plan endpoints (task B09, ADR-M40 §2.3): the version, commit, SHA-256,
// path patterns, tools and change flags of each version, never the file's text. The CLI checks
// them with its own schemas (api-schemas test).
import type { Plan } from '@sdlc/core';

export function presentPlanVersion(plan: Plan): Record<string, unknown> {
  return {
    version: plan.version,
    plan_source: plan.plan_source,
    commit_sha: plan.commit_sha,
    plan_sha256: plan.plan_sha256,
    planned_files: [...plan.planned_files],
    allowed_tools: plan.allowed_tools === null ? null : [...plan.allowed_tools],
    change_flags: [...plan.change_flags],
    created_at: plan.created_at.toISOString(),
  };
}

export function presentSubmittedPlan(intentCode: string, plan: Plan): Record<string, unknown> {
  return { intent: intentCode, ...presentPlanVersion(plan) };
}

export function presentPlanList(
  intentCode: string,
  plans: readonly Plan[],
): Record<string, unknown> {
  return { intent: intentCode, items: plans.map((plan) => presentPlanVersion(plan)) };
}
