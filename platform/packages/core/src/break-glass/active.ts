// What an active break-glass grant changes (task H08 PR 3b, ADR-M111 §2.2, §2.3). Read-only
// helpers with few imports, so the workflow modules can call them without an import cycle.
// Expiry is checked on every read: an expired grant has no effect even before the worker ends it.
import type { BreakGlassScope } from '@sdlc/contracts';

import type { BreakGlassGrant } from '../db/schema.js';
import type { TenantScope } from '../db/tenant-scope.js';

/** The active grant of the intent that names `wanted` at `at`, whoever acts; else undefined. */
export async function grantWithScope(
  scope: TenantScope,
  intentId: string,
  at: Date,
  wanted: BreakGlassScope,
): Promise<BreakGlassGrant | undefined> {
  const grant = await scope.breakGlass.openForIntent(intentId);
  if (
    grant?.status !== 'active' ||
    grant.expires_at === null ||
    grant.expires_at.getTime() <= at.getTime() ||
    !grant.scopes.includes(wanted)
  ) {
    return undefined;
  }
  return grant;
}

/**
 * True when the run goes first in the runner queue (`runner_priority`). The grant is not
 * transferable: a run that another person allowed at G4 never uses it. A run the platform started
 * by itself (G4 passed by policy, `triggered_by` null) uses it (ADR-M111 0.4 §2.2).
 */
export async function breakGlassRunPriority(
  scope: TenantScope,
  runId: string,
  at: Date,
): Promise<boolean> {
  const run = await scope.runs.getById(runId);
  if (!run) return false;
  const grant = await grantWithScope(scope, run.intent_id, at, 'runner_priority');
  return (
    grant !== undefined && (run.triggered_by === null || run.triggered_by === grant.operator_id)
  );
}

/** The gates whose HOTL block window `hotl_window_skip` ends (never a HITL gate: it has none). */
export const SKIPPABLE_WINDOW_GATES: readonly string[] = ['G2', 'G3'];
