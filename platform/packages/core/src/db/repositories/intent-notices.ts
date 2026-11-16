// Outbox of the gate status comments (D-02 FR-22, D-08 B07, design/ADR-M30 §2.5). The workflow
// records one notice per status change of an intent, in the transaction of the change; the poller
// posts it on the intent's issue. Codes and IDs only: the text comes from the message catalog when
// the comment is posted.
import type { GateCode, IntentStatus, ProjectRole } from '@sdlc/contracts';

import { sql } from 'kysely';

import { DbError } from '../errors.js';
import type { IntentNotice } from '../schema.js';
import { isUuid } from '../tenant-id.js';
import { TenantRepository } from './base.js';

/**
 * Kinds of status notice: the intent was submitted (now at G1), moved to the next gate, was
 * rejected, or a person requested changes at its gate (the status stays; the notice confirms it).
 * Session 2: the platform passed a HOTL gate (`hotl_passed`), or a person's request for changes
 * within the block window took the intent back to the passed gate (`returned`).
 * `ai_record_refused` (B12): the project AI record check stopped the submit; the intent stays
 * `draft` until the record allows it.
 * C06 (G4, ADR-M33): `g4_refused` (a G4 check failed; the intent waits at G4), `blocked` (Critical
 * risk or no autonomy: the agent never runs, the intent ends), `run_proposed` (G4 is HITL: the run
 * proposal to approve is new or changed), `agent_recertification_due` (a run starts with an agent
 * whose recertification is overdue; mentions the agent's owner, `agent_id`).
 * C06 session 2 (ADR-M33 §2.6–§2.7): `run_started` (G4 decided, the run is prepared),
 * `run_finished` (the run ended; the intent waits at G5), `run_failed` (the run failed or was lost;
 * the intent is paused and escalated), `run_not_started` (the run could not start; G4 decides again),
 * `run_resumed` (the run's escalation allows a new run; the intent is back at G4).
 * C06 session 2b (ADR-M33 §2.9): `proposal_ready` (an L1 run stored its proposal as evidence; the
 * intent is paused and Person A takes the proposal forward).
 */
export const INTENT_NOTICE_KINDS = [
  'submitted',
  'advanced',
  'rejected',
  'changes_requested',
  'hotl_passed',
  'returned',
  'ai_record_refused',
  'g4_refused',
  'blocked',
  'run_proposed',
  'agent_recertification_due',
  'run_started',
  'run_finished',
  'run_failed',
  'run_not_started',
  'run_resumed',
  'proposal_ready',
  // C07 PR 2 (ADR-M34 §2.8–§2.9): G5.
  'budget_warning',
  'scope_returned',
  'g5_breach',
  'g5_returned',
  'terminated',
  // B08 (ADR-M39 §2.4): the spec changed at the head of the default branch, or cannot be read.
  'spec_changed',
  'spec_unavailable',
  // S01 (ADR-M61): the spec at G2 has no acceptance criteria; the intent waits at G2.
  'spec_unclear',
  // B09 (ADR-M40 §2.4): a new plan was submitted after G3 (back to G3), or the plan file at the
  // head of the default branch is not the submitted plan (G3 or G4 held until it is submitted).
  'plan_changed',
  'plan_resubmit_needed',
  // C08 PR 1 (ADR-M38 §2.4–§2.5): the push and the pull request.
  'pr_opened',
  'g6_publish_stopped',
  'g6_returned',
  // C08 PR 2 (ADR-M38 §2.7): G6 reads CI.
  'ci_retry',
  'ci_returned',
  'g6_decision',
  'g6_escalated',
  'g6_resumed',
  // E01 (ADR-M41): G7, review and merge.
  'g7_review_needed',
  'g7_changes_requested',
  'g7_merge_ready',
  'g7_escalated',
  'g7_returned',
  'g7_resumed',
  'merged',
  // C11 (ADR-M42): a person used the kill switch on the intent's run; an escalation was raised.
  'run_killed',
  // QUESTIONS #211 (B09 PR 2): `modify` or `roll_back` on the escalation of a failed run → G3, HITL.
  'run_returned',
  // E03 (ADR-M49): G8, the release.
  'g8_review_needed',
  'g8_changes_requested',
  'g8_refused',
  'g8_escalated',
  'g8_resumed',
  'released',
  // H08 (ADR-M111 §2.8): a break-glass grant ended without its post-incident review in time.
  'break_glass_review_overdue',
] as const;
export type IntentNoticeKind = (typeof INTENT_NOTICE_KINDS)[number];

const SCALAR_COLUMNS = [
  'id',
  'tenant_id',
  'intent_id',
  'kind',
  'status',
  'gate',
  'previous_gate',
  'decision_id',
  'agent_id',
  'attempts',
  'posted_at',
  'abandoned_at',
  'created_at',
] as const;
// `pg` does not parse arrays of custom enum types; read them as text[] (like plans.change_flags).
const audienceRoles = sql<ProjectRole[]>`audience_roles::text[]`.as('audience_roles');

export interface NewIntentNotice {
  readonly intentId: string;
  readonly kind: IntentNoticeKind;
  readonly status: IntentStatus;
  readonly gate: GateCode | null;
  readonly previousGate: GateCode | null;
  /** The gate decision that caused the change, if one did. */
  readonly decisionId: string | null;
  /** Roles to mention: the people who act next. Never `viewer`. */
  readonly audienceRoles: readonly ProjectRole[];
  /** The agent the notice is about; its owner is mentioned too (C06). */
  readonly agentId?: string | null;
}

export class IntentNoticeRepository extends TenantRepository {
  record(notice: NewIntentNotice): Promise<IntentNotice> {
    const roles = [...new Set(notice.audienceRoles)].sort();
    if (roles.includes('viewer')) throw new DbError('invalid_value', 'viewer is never mentioned');
    return this.run(
      this.db
        .insertInto('intent_notices')
        .values({
          tenant_id: this.tenantId,
          intent_id: notice.intentId,
          kind: notice.kind,
          status: notice.status,
          gate: notice.gate,
          previous_gate: notice.previousGate,
          decision_id: notice.decisionId,
          audience_roles: roles,
          agent_id: notice.agentId ?? null,
        })
        .returning([...SCALAR_COLUMNS, audienceRoles])
        .executeTakeFirstOrThrow(),
    );
  }

  /** Notices still to post for the intents of one project, oldest first. */
  pendingForProject(projectId: string, limit: number): Promise<IntentNotice[]> {
    if (!isUuid(projectId)) return Promise.resolve([]);
    return this.run(
      this.db
        .selectFrom('intent_notices as n')
        .innerJoin('intents as i', (join) =>
          join
            .onRef('i.tenant_id', '=', 'n.tenant_id')
            .onRef('i.id', '=', 'n.intent_id')
            .on('i.tenant_id', '=', this.tenantId),
        )
        .select([
          ...SCALAR_COLUMNS.map((c) => `n.${c}` as const),
          sql<ProjectRole[]>`n.audience_roles::text[]`.as('audience_roles'),
        ])
        .where('n.tenant_id', '=', this.tenantId)
        .where('i.project_id', '=', projectId)
        .where('n.posted_at', 'is', null)
        .where('n.abandoned_at', 'is', null)
        .orderBy('n.id')
        .limit(limit)
        .execute(),
    );
  }

  /**
   * Records the delivery of one notice. Conditional: a notice another poller already finished
   * stays as it is. `abandonAt` gives it up.
   */
  async markDelivery(
    id: string,
    result: { readonly attempts: number; readonly postedAt?: Date; readonly abandonAt?: Date },
  ): Promise<void> {
    await this.run(
      this.db
        .updateTable('intent_notices')
        .set({
          attempts: result.attempts,
          ...(result.postedAt ? { posted_at: result.postedAt } : {}),
          ...(result.abandonAt ? { abandoned_at: result.abandonAt } : {}),
        })
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', id)
        .where('posted_at', 'is', null)
        .where('abandoned_at', 'is', null)
        .where('attempts', '<=', result.attempts)
        .execute(),
    );
  }

  /** True when a notice about this gate decision was already recorded. */
  async existsForDecision(decisionId: string): Promise<boolean> {
    if (!isUuid(decisionId)) return false;
    const row = await this.run(
      this.db
        .selectFrom('intent_notices')
        .select('id')
        .where('tenant_id', '=', this.tenantId)
        .where('decision_id', '=', decisionId)
        .limit(1)
        .executeTakeFirst(),
    );
    return row !== undefined;
  }

  listForIntent(intentId: string): Promise<IntentNotice[]> {
    if (!isUuid(intentId)) return Promise.resolve([]);
    return this.run(
      this.db
        .selectFrom('intent_notices')
        .select([...SCALAR_COLUMNS, audienceRoles])
        .where('tenant_id', '=', this.tenantId)
        .where('intent_id', '=', intentId)
        .orderBy('id')
        .execute(),
    );
  }
}
