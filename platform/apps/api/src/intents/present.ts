// Response bodies (snake_case, like the database and the codes table). Presenters pick fields
// explicitly, so a new column never leaks into the API by accident.
import type { GitHostAdapter, RepoRef, WebTarget } from '@sdlc/contracts';
import {
  planPath,
  type GateDecisionRow,
  type Intent,
  type Plan,
  type Project,
  type SpecRef,
  type WaitingFor,
  type LessonRow,
} from '@sdlc/core';

export interface IntentBody {
  readonly id: string;
  readonly code: string;
  /** U01 (QUESTIONS #262): `repo_full_name` for the issue and pull request links. */
  readonly project: {
    readonly id: string;
    readonly slug: string;
    readonly repo_full_name: string;
  };
  readonly title: string;
  readonly description: string;
  readonly risk_tier: string;
  readonly data_class: string;
  readonly max_autonomy: string;
  readonly budget_usd: string;
  readonly status: string;
  readonly current_gate: string | null;
  /** U01 (QUESTIONS #260): when the intent last entered `current_gate` (FR-12). */
  readonly gate_entered_at: string | null;
  /**
   * U02 (ADR-M54 §2.4b): why the workflow holds the intent, as its step recorded it under the
   * intent lock (`IntentWaitReason`), a cause code (the failed G4 check), since when, and until
   * when for a HOTL block window. Null when nothing is recorded.
   */
  readonly waiting_reason: string | null;
  readonly waiting_cause: string | null;
  readonly waiting_since: string | null;
  readonly waiting_until: string | null;
  /** V14 (ADR-M79 §2.6): a person's estimate of the human effort in hours; null when none. */
  readonly human_effort_hours: string | null;
  readonly issue_number: number | null;
  readonly pr_number: number | null;
  readonly created_by: string;
  readonly created_at: string;
  readonly updated_at: string;
}

/** PostgreSQL returns numeric(7,2) as `12.50`; the API sends `12.5`. */
const formatHours = (value: string): string =>
  value.includes('.') ? value.replace(/\.?0+$/, '') : value;

export function presentIntent(
  intent: Intent,
  project: Pick<Project, 'id' | 'slug' | 'repo_full_name'>,
): IntentBody {
  return {
    id: intent.id,
    code: intent.code,
    project: { id: project.id, slug: project.slug, repo_full_name: project.repo_full_name },
    title: intent.title,
    description: intent.description,
    risk_tier: intent.risk_tier,
    data_class: intent.data_class,
    max_autonomy: intent.max_autonomy,
    budget_usd: intent.budget_usd,
    status: intent.status,
    current_gate: intent.current_gate,
    gate_entered_at: intent.gate_entered_at?.toISOString() ?? null,
    waiting_reason: intent.waiting_reason,
    waiting_cause: intent.waiting_cause,
    waiting_since: intent.waiting_since?.toISOString() ?? null,
    waiting_until: intent.waiting_until?.toISOString() ?? null,
    human_effort_hours:
      intent.human_effort_hours === null ? null : formatHours(intent.human_effort_hours),
    issue_number: intent.issue_number,
    pr_number: intent.pr_number,
    created_by: intent.created_by,
    created_at: intent.created_at.toISOString(),
    updated_at: intent.updated_at.toISOString(),
  };
}

export function presentDecision(row: GateDecisionRow): Record<string, unknown> {
  return {
    id: row.id,
    gate: row.gate,
    decision: row.decision,
    oversight_mode: row.oversight_mode,
    approver_role: row.approver_role,
    actor_type: row.actor_type,
    decided_by: row.decided_by,
    reason_code: row.reason_code,
    reason_ref: row.reason_ref,
    input_sha256: row.input_sha256,
    scope: row.scope,
    expires_at: row.expires_at?.toISOString() ?? null,
    config_hash: row.config_hash,
    source: row.source,
    voids_decision_id: row.voids_decision_id,
    created_at: row.created_at.toISOString(),
  };
}

export function presentSpec(spec: SpecRef | undefined): Record<string, unknown> | null {
  return spec
    ? {
        version: spec.version,
        path: spec.path,
        commit_sha: spec.commit_sha,
        content_sha256: spec.content_sha256,
        // S01 (ADR-M61): codes and a count; null for a spec linked before S01.
        source_tool: spec.source_tool,
        structure: spec.structure,
        acceptance_criteria: spec.acceptance_criteria,
      }
    : null;
}

export function presentPlan(plan: Plan | undefined): Record<string, unknown> | null {
  return plan
    ? { version: plan.version, plan_sha256: plan.plan_sha256, change_flags: plan.change_flags }
    : null;
}

/**
 * U01 (QUESTIONS #261): who the intent waits for at its current gate, as the workflow resolves it
 * (`currentGateWaitingFor`, core). Null when nothing is certain (not at a gate, or G6 waiting for
 * CI).
 */
export function presentWaitingFor(waiting: WaitingFor | null): Record<string, unknown> | null {
  return waiting
    ? {
        gate: waiting.gate,
        mode: waiting.mode,
        roles: [...waiting.roles],
        approvals_needed: waiting.approvalsNeeded,
      }
    : null;
}

/** The repository of a project as a Git host reference, or null. */
function repoRefOf(project: Pick<Project, 'repo_full_name'>): RepoRef | null {
  const [owner, name, ...rest] = project.repo_full_name.split('/');
  return owner && name && rest.length === 0 ? { owner, name } : null;
}

/**
 * X08b (ADR-M109 §2.5): the lessons of an intent (codes, state and the comment's link) and the
 * codes of the intents created from them.
 */
export function presentLessonLinks(
  lessons: readonly LessonRow[],
  followUps: readonly string[],
): Record<string, unknown> {
  return {
    lessons: lessons.map((l) => ({
      id: l.id,
      category: l.category,
      target: l.target,
      state: l.outcome === null ? 'open' : l.outcome.outcome,
      comment_url: l.comment_url,
    })),
    follow_ups: [...followUps],
  };
}

/**
 * X08a (ADR-M109 §2.1): what a person follows from one intent, built from stored codes and
 * numbers only. `url` comes from the Git host adapter (no call to it); null without one.
 */
export function presentLinks(
  intent: Pick<Intent, 'code' | 'issue_number' | 'pr_number'>,
  project: Pick<Project, 'repo_full_name'>,
  facts: {
    readonly spec: SpecRef | undefined;
    readonly plan: Plan | undefined;
    readonly sealed: boolean;
  },
  web: Pick<GitHostAdapter, 'webUrl'> | undefined,
): Record<string, unknown> {
  const ref = repoRefOf(project);
  const url = (target: WebTarget): string | null => {
    if (!web || !ref) return null;
    try {
      return web.webUrl(ref, target);
    } catch {
      return null;
    }
  };
  const { spec, plan } = facts;
  const planFile = planPath(intent.code);
  return {
    issue:
      intent.issue_number === null
        ? null
        : { number: intent.issue_number, url: url({ kind: 'issue', number: intent.issue_number }) },
    pull_request:
      intent.pr_number === null
        ? null
        : {
            number: intent.pr_number,
            url: url({ kind: 'pull_request', number: intent.pr_number }),
          },
    spec: spec
      ? {
          path: spec.path,
          commit_sha: spec.commit_sha,
          url: url({ kind: 'file', path: spec.path, commitSha: spec.commit_sha }),
        }
      : null,
    // A plan read from its file (B09) has a commit; a plan sent as text has none.
    plan: plan?.commit_sha
      ? {
          path: planFile,
          commit_sha: plan.commit_sha,
          url: url({ kind: 'file', path: planFile, commitSha: plan.commit_sha }),
        }
      : null,
    evidence: { path: `/v1/intents/${intent.code}/evidence`, sealed: facts.sealed },
  };
}
