// Break-glass grants (task H08 PR 2, design/ADR-M111 §2.1–§2.8; QUESTIONS #741–#744).
//
// A grant belongs to one open intent. A person (Person A or B) requests it with named scopes, a
// duration and a GitHub comment that explains the incident; a second person (governance or
// Person B, never the requester, never a producer) approves or refuses it. Approval raises a
// Critical, non-freezing escalation that stands in for the incident (§2.6). The grant ends by
// revocation (at once) or by expiry; a person then records the review comment, which closes the
// escalation. Every step is one transaction with its audit event: codes, IDs and durations only.
//
// What a grant changes (runner priority, the budget, HOTL windows) is read through `activeGrant`
// (PR 3). It never changes G1, G4, G6, G7 or G8 (§2.3).
import { createHash } from 'node:crypto';

import { BREAK_GLASS_SCOPES, type BreakGlassScope } from '@sdlc/contracts';

import { fromMicros, isUsd, toMicros } from '../cost/money.js';
import { DbError } from '../db/errors.js';
import type { BreakGlassGrant, Intent, Project } from '../db/schema.js';
import type { TenantScope } from '../db/tenant-scope.js';
import { closeEscalation } from '../escalation/decide.js';
import { raiseEscalation } from '../escalation/raise.js';
import { loadEffectiveConfig } from '../registry/effective-config.js';
import { g7Producers } from '../workflow/g7-facts.js';
import { FINISHED_INTENT_STATUSES } from '../workflow/step.js';
import {
  BREAK_GLASS_APPROVE_ROLES,
  BREAK_GLASS_REQUEST_ROLES,
  BREAK_GLASS_REVOKE_ROLES,
  checkIntentComment,
  holdsAny,
  readableIntent,
  rolesOn,
  type BreakGlassGitHost,
} from './access.js';
import { BreakGlassError } from './errors.js';

const MINUTE_MS = 60_000;

/** A person acts as themselves; an operator on the server as the system (revoke and list only). */
export type BreakGlassActor =
  { readonly type: 'human'; readonly id: string } | { readonly type: 'system' };

export interface RequestBreakGlassInput {
  readonly intentRef: string;
  readonly scopes: readonly string[];
  readonly hours: number;
  /** A comment on the intent's issue or pull request that explains the incident. */
  readonly reasonUrl: string;
  /** USD decimal string; with the `budget` scope only. */
  readonly budgetIncreaseUsd?: string;
  readonly actorId: string;
  readonly now: Date;
}

function assertOpen(intent: Intent): void {
  if ((FINISHED_INTENT_STATUSES as readonly string[]).includes(intent.status)) {
    throw new BreakGlassError('intent_not_open', `intent ${intent.code} is ${intent.status}`);
  }
}

async function settings(scope: TenantScope, project: Project) {
  return (await loadEffectiveConfig(scope.projectConfigs, project.id)).config.break_glass;
}

function checkScopes(
  given: readonly string[],
  allowed: readonly BreakGlassScope[],
): BreakGlassScope[] {
  const known = given.filter((s): s is BreakGlassScope =>
    (BREAK_GLASS_SCOPES as readonly string[]).includes(s),
  );
  if (
    given.length === 0 ||
    known.length !== given.length ||
    new Set(known).size !== known.length ||
    known.some((s) => !allowed.includes(s))
  ) {
    throw new BreakGlassError('scope_invalid', 'scopes not allowed');
  }
  // Stored in the order of the closed list, so the same request always reads the same.
  return BREAK_GLASS_SCOPES.filter((s) => known.includes(s));
}

function checkBudget(
  scopes: readonly BreakGlassScope[],
  amount: string | undefined,
  cap: number,
): string | null {
  if (!scopes.includes('budget')) {
    if (amount !== undefined) throw new BreakGlassError('budget_invalid', 'no budget scope');
    return null;
  }
  if (amount === undefined || !isUsd(amount) || toMicros(amount) <= 0n) {
    throw new BreakGlassError('budget_invalid', 'the budget scope needs an amount');
  }
  if (toMicros(amount) > toMicros(String(cap))) {
    throw new BreakGlassError('budget_invalid', 'over break_glass.max_budget_increase_usd');
  }
  return fromMicros(toMicros(amount));
}

/** `adlc break-glass request` (ADR-M111 §2.1, §2.4): a requested grant, waiting for approval. */
export async function requestBreakGlass(
  scope: TenantScope,
  deps: BreakGlassGitHost | undefined,
  input: RequestBreakGlassInput,
): Promise<{ intent: Intent; grant: BreakGlassGrant }> {
  const { intent, project } = await readableIntent(scope, input.intentRef, input.actorId);
  if (!holdsAny(await rolesOn(scope, project.id, input.actorId), BREAK_GLASS_REQUEST_ROLES)) {
    throw new BreakGlassError('forbidden', 'only Person A or Person B requests');
  }
  assertOpen(intent);
  const config = await settings(scope, project);
  if (!config.enabled) throw new BreakGlassError('disabled', 'break-glass is off');
  const scopes = checkScopes(input.scopes, config.allowed_scopes);
  if (!Number.isInteger(input.hours) || input.hours < 1 || input.hours > config.max_hours) {
    throw new BreakGlassError('duration_invalid', 'hours out of range');
  }
  const budget = checkBudget(scopes, input.budgetIncreaseUsd, config.max_budget_increase_usd);
  if (await scope.breakGlass.openForIntent(intent.id)) {
    throw new BreakGlassError('already_open', 'the intent has an open grant');
  }
  await checkIntentComment(deps, project, intent, input.reasonUrl);
  return scope.transaction(async (tx) => {
    const grant = await tx.breakGlass
      .request({
        project_id: project.id,
        intent_id: intent.id,
        operator_id: input.actorId,
        scopes,
        duration_seconds: input.hours * 3600,
        budget_increase_usd: budget,
        reason_url: input.reasonUrl,
        lapses_at: new Date(input.now.getTime() + config.request_ttl_minutes * MINUTE_MS),
      })
      .catch((error: unknown) => {
        throw error instanceof DbError && error.code === 'conflict'
          ? new BreakGlassError('already_open', 'the intent has an open grant')
          : error;
      });
    await tx.audit.append({
      action: 'break_glass.requested',
      actorType: 'human',
      actorId: input.actorId,
      entityId: grant.id,
      payload: {
        intent_id: intent.id,
        operator_id: input.actorId,
        scopes,
        duration: grant.duration_seconds,
      },
    });
    return { intent, grant };
  });
}

export interface DecideBreakGlassInput {
  readonly intentRef: string;
  readonly actorId: string;
  readonly now: Date;
}

/** Checks the approver of a requested grant (ADR-M111 §2.4); returns the locked grant. */
async function lockForDecision(
  tx: TenantScope,
  intent: Intent,
  project: Project,
  input: DecideBreakGlassInput,
): Promise<BreakGlassGrant> {
  if (!holdsAny(await rolesOn(tx, project.id, input.actorId), BREAK_GLASS_APPROVE_ROLES)) {
    throw new BreakGlassError('forbidden', 'only governance or Person B decides');
  }
  const open = await tx.breakGlass.openForIntent(intent.id);
  const grant = open ? await tx.breakGlass.lockForUpdate(open.id) : undefined;
  if (grant?.status !== 'requested') throw new BreakGlassError('no_grant', 'no requested grant');
  if (grant.operator_id === input.actorId) {
    throw new BreakGlassError('same_person', 'the requester never approves');
  }
  if ((await g7Producers(tx, intent)).includes(input.actorId)) {
    throw new BreakGlassError('producer', 'a producer never approves');
  }
  if (grant.lapses_at.getTime() <= input.now.getTime()) {
    throw new BreakGlassError('lapsed', 'the request lapsed');
  }
  return grant;
}

/** The hash the stand-in escalation is bound to: the grant, its scopes and its expiry. */
export function grantSubjectSha256(grantId: string, scopes: readonly string[], expiresAt: Date) {
  return createHash('sha256')
    .update(`break_glass:${grantId}:${scopes.join(',')}:${expiresAt.toISOString()}`)
    .digest('hex');
}

/**
 * `adlc break-glass approve` (ADR-M111 §2.4–§2.6): the grant becomes active until `now` + its
 * duration, and a Critical `break_glass` escalation (route `policy`, level `notify`: not freezing)
 * stands in for the incident. Its code is the incident code.
 */
export async function approveBreakGlass(
  scope: TenantScope,
  input: DecideBreakGlassInput,
): Promise<{ intent: Intent; grant: BreakGlassGrant; incident: string }> {
  const { intent, project } = await readableIntent(scope, input.intentRef, input.actorId);
  assertOpen(intent);
  if (!(await settings(scope, project)).enabled) {
    throw new BreakGlassError('disabled', 'break-glass is off');
  }
  return scope.transaction(async (tx) => {
    const grant = await lockForDecision(tx, intent, project, input);
    const expiresAt = new Date(input.now.getTime() + grant.duration_seconds * 1000);
    const escalation = await raiseEscalation(
      tx,
      {
        intentId: intent.id,
        trigger: 'break_glass',
        route: 'policy',
        severity: 'critical',
        responseLevel: 'notify',
        packet: {
          subject_kind: 'intent',
          subject_sha256: grantSubjectSha256(grant.id, grant.scopes, expiresAt),
          ref: grant.reason_url,
        },
        producers: await g7Producers(tx, intent),
        raisedBy: { type: 'human', id: input.actorId },
      },
      { now: () => input.now },
    );
    const updated = await tx.breakGlass.update(grant.id, {
      status: 'active',
      approver_id: input.actorId,
      decided_at: input.now,
      expires_at: expiresAt,
      escalation_id: escalation.id,
    });
    await tx.audit.append({
      action: 'break_glass.approved',
      actorType: 'human',
      actorId: input.actorId,
      entityId: grant.id,
      payload: {
        intent_id: intent.id,
        approver_id: input.actorId,
        incident: escalation.code,
        scopes: grant.scopes,
        expires_in: grant.duration_seconds,
        ...(grant.budget_increase_usd === null
          ? {}
          : { budget_increase_usd: fromMicros(toMicros(grant.budget_increase_usd)) }),
      },
    });
    return { intent, grant: updated, incident: escalation.code };
  });
}

/** `adlc break-glass refuse`: the request ends without effect. */
export async function refuseBreakGlass(
  scope: TenantScope,
  input: DecideBreakGlassInput,
): Promise<{ intent: Intent; grant: BreakGlassGrant }> {
  const { intent, project } = await readableIntent(scope, input.intentRef, input.actorId);
  return scope.transaction(async (tx) => {
    const grant = await lockForDecision(tx, intent, project, input);
    const updated = await tx.breakGlass.update(grant.id, {
      status: 'refused',
      approver_id: input.actorId,
      decided_at: input.now,
      ended_at: input.now,
    });
    await tx.audit.append({
      action: 'break_glass.refused',
      actorType: 'human',
      actorId: input.actorId,
      entityId: grant.id,
      payload: { intent_id: intent.id, approver_id: input.actorId },
    });
    return { intent, grant: updated };
  });
}

export interface RevokeBreakGlassInput {
  readonly intentRef: string;
  readonly actor: BreakGlassActor;
  readonly now: Date;
}

/**
 * `adlc break-glass revoke` and `adlc ops break-glass revoke` (ADR-M111 §2.4): ends the active
 * grant at once. Containment, like a kill: never frozen, no second person. The operator, the
 * approver, Person B, governance, or an operator on the server.
 */
export async function revokeBreakGlass(
  scope: TenantScope,
  input: RevokeBreakGlassInput,
): Promise<{ intent: Intent; grant: BreakGlassGrant }> {
  const actorId = input.actor.type === 'human' ? input.actor.id : null;
  const { intent, project } = await readableIntent(scope, input.intentRef, actorId);
  return scope.transaction(async (tx) => {
    const open = await tx.breakGlass.openForIntent(intent.id);
    const grant = open ? await tx.breakGlass.lockForUpdate(open.id) : undefined;
    if (grant?.status !== 'active') throw new BreakGlassError('no_grant', 'no active grant');
    if (actorId !== null) {
      const allowed =
        grant.operator_id === actorId ||
        grant.approver_id === actorId ||
        holdsAny(await rolesOn(tx, project.id, actorId), BREAK_GLASS_REVOKE_ROLES);
      if (!allowed) throw new BreakGlassError('forbidden', 'not allowed to revoke');
    }
    const updated = await tx.breakGlass.update(grant.id, {
      status: 'revoked',
      ended_at: input.now,
      revoked_by: actorId,
    });
    await tx.audit.append({
      action: 'break_glass.revoked',
      ...(actorId === null
        ? { actorType: 'system' as const, actorId: null }
        : { actorType: 'human' as const, actorId }),
      entityId: grant.id,
      payload: { intent_id: intent.id, ...(actorId === null ? {} : { revoked_by: actorId }) },
    });
    return { intent, grant: updated };
  });
}

export interface ReviewBreakGlassInput {
  readonly intentRef: string;
  /** The post-incident review comment on the intent's issue or pull request. */
  readonly commentUrl: string;
  readonly actorId: string;
  readonly now: Date;
}

/**
 * `adlc break-glass review` (ADR-M111 §2.8): records the review link of the oldest grant of the
 * intent that ended without one, and closes its stand-in escalation.
 */
export async function reviewBreakGlass(
  scope: TenantScope,
  deps: BreakGlassGitHost | undefined,
  input: ReviewBreakGlassInput,
): Promise<{ intent: Intent; grant: BreakGlassGrant; incident: string }> {
  const { intent, project } = await readableIntent(scope, input.intentRef, input.actorId);
  if (!holdsAny(await rolesOn(scope, project.id, input.actorId), BREAK_GLASS_REQUEST_ROLES)) {
    throw new BreakGlassError('forbidden', 'only Person A or Person B records the review');
  }
  const pending = unreviewed(await scope.breakGlass.listForIntent(intent.id))[0];
  if (!pending) throw new BreakGlassError('nothing_to_review', 'no grant to review');
  await checkIntentComment(deps, project, intent, input.commentUrl);
  return scope.transaction(async (tx) => {
    const grant = await tx.breakGlass.lockForUpdate(pending.id);
    if (!grant || unreviewed([grant]).length === 0 || grant.escalation_id === null) {
      throw new BreakGlassError('nothing_to_review', 'no grant to review');
    }
    const updated = await tx.breakGlass.update(grant.id, {
      review_url: input.commentUrl,
      reviewed_by: input.actorId,
      reviewed_at: input.now,
    });
    const escalation = await closeEscalation(
      tx,
      { escalationId: grant.escalation_id, closedBy: { type: 'human', id: input.actorId } },
      { now: () => input.now },
    );
    await tx.audit.append({
      action: 'break_glass.reviewed',
      actorType: 'human',
      actorId: input.actorId,
      entityId: grant.id,
      payload: { intent_id: intent.id, incident: escalation.code },
    });
    return { intent, grant: updated, incident: escalation.code };
  });
}

/** Grants that were active, have ended, and have no review yet; oldest first. */
export function unreviewed(grants: readonly BreakGlassGrant[]): BreakGlassGrant[] {
  return grants.filter(
    (g) => (g.status === 'revoked' || g.status === 'expired') && g.review_url === null,
  );
}

/**
 * The active grant of the intent at `now` that gives `scope` to `operatorId`, or undefined
 * (ADR-M111 §2.2, §2.5). Expiry is checked here, so an expired grant has no effect even before the
 * worker loop ends it. Only the operator's own actions use a grant.
 */
export async function activeGrant(
  scope: TenantScope,
  intentId: string,
  at: Date,
  wanted: BreakGlassScope,
  operatorId: string,
): Promise<BreakGlassGrant | undefined> {
  const grant = await scope.breakGlass.openForIntent(intentId);
  if (
    grant?.status !== 'active' ||
    grant.expires_at === null ||
    grant.expires_at.getTime() <= at.getTime() ||
    grant.operator_id !== operatorId ||
    !grant.scopes.includes(wanted)
  ) {
    return undefined;
  }
  return grant;
}

/**
 * True while a grant of the intent is active, or ended without a review: G8 waits (ADR-M111 §2.8,
 * PR 3). A request that was never approved needs no review.
 */
export async function breakGlassReviewPending(
  scope: TenantScope,
  intentId: string,
): Promise<boolean> {
  const grants = await scope.breakGlass.listForIntent(intentId);
  return grants.some((g) => g.status === 'active') || unreviewed(grants).length > 0;
}
