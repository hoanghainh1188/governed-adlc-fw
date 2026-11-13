// Response bodies of agent memory (snake_case, fields picked explicitly). Hashes, versions, codes
// and IDs only (ADR-M74 §2.8).
import type { MemoryVersionRow } from '@sdlc/core';

export function presentMemoryVersion(row: MemoryVersionRow): Record<string, unknown> {
  return {
    version: row.version,
    set_sha256: row.set_sha256,
    commit_sha: row.commit_sha,
    source: row.source,
    approved_by: row.approved_by,
    pr_number: row.pr_number,
    intent_id: row.intent_id,
    run_id: row.run_id,
    created_at: row.created_at.toISOString(),
    revoked: row.revoked_at !== null,
    revoked_at: row.revoked_at?.toISOString() ?? null,
    revoked_by: row.revoked_by,
    revocation_reason: row.revocation_reason,
  };
}

export function presentProject(project: { readonly id: string; readonly slug: string }) {
  return { id: project.id, slug: project.slug };
}
