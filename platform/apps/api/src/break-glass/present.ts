// The JSON of a break-glass grant (task H08 PR 3a, ADR-M111 §2.1): codes, IDs, times and links.
import type { BreakGlassGrant } from '@sdlc/core';

const iso = (value: Date | null) => (value === null ? null : value.toISOString());

export function presentBreakGlass(
  grant: BreakGlassGrant,
  intent: string | null,
  project: string | null,
  incident: string | null,
): Record<string, unknown> {
  return {
    id: grant.id,
    intent,
    project,
    status: grant.status,
    scopes: grant.scopes,
    duration_seconds: grant.duration_seconds,
    budget_increase_usd: grant.budget_increase_usd,
    reason_url: grant.reason_url,
    operator_id: grant.operator_id,
    approver_id: grant.approver_id,
    incident,
    created_at: grant.created_at.toISOString(),
    lapses_at: grant.lapses_at.toISOString(),
    decided_at: iso(grant.decided_at),
    expires_at: iso(grant.expires_at),
    ended_at: iso(grant.ended_at),
    revoked_by: grant.revoked_by,
    review_url: grant.review_url,
    reviewed_by: grant.reviewed_by,
    reviewed_at: iso(grant.reviewed_at),
    review_overdue_at: iso(grant.review_overdue_at),
  };
}
