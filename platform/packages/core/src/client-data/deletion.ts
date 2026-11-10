// Client data deletion request, cancel, approve and status (task H03c, design/ADR-M97 §2.4;
// D-08 H03c). Tenant admins request and cancel through the API; a platform operator approves on
// the server (`adlc ops client-data-deletion …`). Two-person rule: the operator is never the
// requester. Codes and IDs only in audit payloads. The physical purge is H03b.
import { assertTenantAdmin, type AdminActor } from '../admin/actor.js';
import { AdminError } from '../admin/errors.js';
import type { PlatformDatabase } from '../db/platform-database.js';
import type { AuditLogRow, Tenant } from '../db/schema.js';
import { isUuid, type TenantId } from '../db/tenant-id.js';
import type { TenantScope } from '../db/tenant-scope.js';
import type { TenantStatus } from '../db/vocabulary.js';
import { DEFAULT_CLIENT_DELETION_GRACE_DAYS } from '../retention/client-purge-pass.js';

/** Lifecycle phase derived from the tenant row plus the `client_data.*` audit chain. */
export type ClientDeletionPhase =
  'none' | 'requested' | 'approved' | 'started' | 'blocked' | 'deleted' | 'cancelled' | 'purged';

export interface ClientDeletionView {
  readonly tenant_id: string;
  readonly tenant_slug: string;
  readonly tenant_status: TenantStatus;
  readonly phase: ClientDeletionPhase;
  readonly requested_by: string | null;
  readonly requested_at: string | null;
  readonly grace_period_days: number | null;
  readonly legal_basis: string | null;
  readonly operator_id: string | null;
  readonly approved_at: string | null;
  readonly cancelled_by: string | null;
  readonly cancelled_at: string | null;
}

/** Default legal basis code when the requester does not pass one (ADR-M97: codes only). */
export const DEFAULT_DELETION_LEGAL_BASIS = 'contract_offboarding';

const LEGAL_BASIS = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

const LIFECYCLE_ACTIONS = [
  'client_data.deletion_requested',
  'client_data.deletion_approved',
  'client_data.deletion_cancelled',
  'client_data.deletion_started',
  'client_data.purge_blocked_by_hold',
  'client_data.deleted',
] as const;

export interface RequestDeletionInput {
  readonly legalBasis?: string;
  readonly gracePeriodDays?: number;
}

/** A tenant admin asks to delete the client's data. The tenant stays `active` until approval. */
export async function requestDeletion(
  db: PlatformDatabase,
  scope: TenantScope,
  actor: AdminActor,
  input: RequestDeletionInput = {},
  now: Date = new Date(),
): Promise<ClientDeletionView> {
  await assertTenantAdmin(scope, actor);
  if (actor.type !== 'human') {
    throw new AdminError('invalid_value', 'only a tenant admin may request deletion', {
      field: 'actor',
    });
  }
  const legalBasis = input.legalBasis ?? DEFAULT_DELETION_LEGAL_BASIS;
  if (!LEGAL_BASIS.test(legalBasis)) {
    throw new AdminError('invalid_value', 'legal_basis must be a short code', {
      field: 'legal_basis',
    });
  }
  const grace =
    input.gracePeriodDays === undefined
      ? DEFAULT_CLIENT_DELETION_GRACE_DAYS
      : input.gracePeriodDays;
  if (!Number.isSafeInteger(grace) || grace < 1 || grace > 365) {
    throw new AdminError('invalid_value', 'grace_period_days must be 1–365', {
      field: 'grace_period_days',
    });
  }

  const tenant = await requireTenant(db, scope.tenantId);
  if (tenant.status === 'purged' || tenant.status === 'pending_deletion') {
    throw new AdminError('already_exists', 'deletion already in progress or completed', {
      reason: 'deletion_already_open',
    });
  }
  const events = await lifecycleEvents(scope);
  const phase = derivePhase(tenant.status, events);
  if (
    phase === 'requested' ||
    phase === 'approved' ||
    phase === 'started' ||
    phase === 'blocked' ||
    phase === 'deleted'
  ) {
    throw new AdminError('already_exists', 'deletion already requested', {
      reason: 'deletion_already_open',
    });
  }

  await scope.audit.append({
    action: 'client_data.deletion_requested',
    actorType: 'human',
    actorId: actor.userId,
    entityId: scope.tenantId,
    payload: {
      requested_by: actor.userId,
      grace_period_days: grace,
      legal_basis: legalBasis,
    },
    occurredAt: now,
  });
  return deletionStatus(db, scope);
}

/**
 * A tenant admin cancels an open request or an approved deletion still in the grace period.
 * After `deletion_started` / `deleted` / `purged` it is refused.
 */
export async function cancelDeletion(
  db: PlatformDatabase,
  scope: TenantScope,
  actor: AdminActor,
  now: Date = new Date(),
): Promise<ClientDeletionView> {
  await assertTenantAdmin(scope, actor);
  if (actor.type !== 'human') {
    throw new AdminError('invalid_value', 'only a tenant admin may cancel deletion', {
      field: 'actor',
    });
  }

  const tenant = await requireTenant(db, scope.tenantId);
  if (tenant.status === 'purged') {
    throw new AdminError('invalid_value', 'the tenant is already purged', {
      reason: 'deletion_not_cancellable',
    });
  }
  const events = await lifecycleEvents(scope);
  const phase = derivePhase(tenant.status, events);
  if (phase !== 'requested' && phase !== 'approved') {
    throw new AdminError('invalid_value', 'no cancellable deletion request', {
      reason: 'deletion_not_cancellable',
    });
  }

  await scope.audit.append({
    action: 'client_data.deletion_cancelled',
    actorType: 'human',
    actorId: actor.userId,
    entityId: scope.tenantId,
    payload: { cancelled_by: actor.userId, role: 'tenant_admin' },
    occurredAt: now,
  });
  if (tenant.status === 'pending_deletion') {
    const updated = await db.system.setTenantStatus(scope.tenantId, 'active');
    if (!updated) {
      throw new AdminError('invalid_value', 'could not restore the tenant to active', {
        reason: 'tenant_restore_failed',
      });
    }
  }
  return deletionStatus(db, scope);
}

/**
 * A platform operator approves an open request (two-person rule). Sets the tenant to
 * `pending_deletion`. The grace period for H03b starts at this event's `occurred_at`.
 */
export async function approveDeletion(
  db: PlatformDatabase,
  scope: TenantScope,
  operatorUserId: string,
  now: Date = new Date(),
): Promise<ClientDeletionView> {
  if (!isUuid(operatorUserId)) {
    throw new AdminError('invalid_value', 'operator must be a user UUID', { field: 'operator' });
  }
  const tenant = await requireTenant(db, scope.tenantId);
  if (tenant.status === 'purged' || tenant.status === 'pending_deletion') {
    throw new AdminError('already_exists', 'deletion already approved or completed', {
      reason: 'deletion_already_open',
    });
  }
  const events = await lifecycleEvents(scope);
  const phase = derivePhase(tenant.status, events);
  if (phase !== 'requested') {
    throw new AdminError('invalid_value', 'no open deletion request to approve', {
      reason: 'deletion_not_open',
    });
  }
  const request = latestOf(events, 'client_data.deletion_requested');
  const requestedBy = codeField(request?.payload, 'requested_by');
  if (requestedBy === null) {
    throw new AdminError('invalid_value', 'deletion request has no requester', {
      reason: 'deletion_not_open',
    });
  }
  if (requestedBy === operatorUserId) {
    throw new AdminError('self_action', 'the requester cannot approve the deletion', {
      reason: 'requester_cannot_approve',
    });
  }
  const operator = await scope.users.getById(operatorUserId);
  if (!operator) throw new AdminError('user_not_found', 'operator user not found in this tenant');
  if (operator.status !== 'active') {
    throw new AdminError('user_not_active', 'operator user is disabled');
  }

  await scope.audit.append({
    action: 'client_data.deletion_approved',
    actorType: 'system',
    actorId: null,
    entityId: scope.tenantId,
    payload: {
      operator_id: operatorUserId,
      confirmed_scope: 'all_projects',
    },
    occurredAt: now,
  });
  const updated = await db.system.setTenantStatus(scope.tenantId, 'pending_deletion');
  if (!updated) {
    throw new AdminError('invalid_value', 'could not set pending_deletion', {
      reason: 'tenant_status_failed',
    });
  }
  return deletionStatus(db, scope);
}

/** Status of one tenant's deletion lifecycle. */
export async function deletionStatus(
  db: PlatformDatabase,
  scope: TenantScope,
): Promise<ClientDeletionView> {
  const tenant = await requireTenant(db, scope.tenantId);
  const events = await lifecycleEvents(scope);
  return present(tenant, events);
}

/**
 * Open deletion requests across tenants (phase `requested` or `approved`), for the operator list.
 * Slugs and IDs only.
 */
export async function listDeletionRequests(db: PlatformDatabase): Promise<ClientDeletionView[]> {
  const tenants = await db.system.listTenants();
  const out: ClientDeletionView[] = [];
  for (const tenant of tenants) {
    if (tenant.status === 'purged') continue;
    const scope = db.forTenant(tenant.id as TenantId);
    const events = await lifecycleEvents(scope);
    const phase = derivePhase(tenant.status, events);
    if (phase !== 'requested' && phase !== 'approved') continue;
    out.push(present(tenant, events));
  }
  return out;
}

export function derivePhase(
  tenantStatus: TenantStatus,
  events: readonly AuditLogRow[],
): ClientDeletionPhase {
  if (tenantStatus === 'purged') return 'purged';
  let phase: ClientDeletionPhase = 'none';
  for (const event of events) {
    switch (event.action) {
      case 'client_data.deletion_requested':
        phase = 'requested';
        break;
      case 'client_data.deletion_approved':
        phase = 'approved';
        break;
      case 'client_data.deletion_cancelled':
        phase = 'cancelled';
        break;
      case 'client_data.deletion_started':
        phase = 'started';
        break;
      case 'client_data.purge_blocked_by_hold':
        phase = 'blocked';
        break;
      case 'client_data.deleted':
        phase = 'deleted';
        break;
      default:
        break;
    }
  }
  return phase;
}

async function lifecycleEvents(scope: TenantScope): Promise<AuditLogRow[]> {
  return scope.audit.listForEntity(scope.tenantId, [...LIFECYCLE_ACTIONS]);
}

async function requireTenant(db: PlatformDatabase, tenantId: TenantId): Promise<Tenant> {
  const tenant = await db.system.getTenant(tenantId);
  if (!tenant) {
    throw new AdminError('invalid_value', 'tenant not found', { reason: 'tenant_not_found' });
  }
  return tenant;
}

function present(tenant: Tenant, events: readonly AuditLogRow[]): ClientDeletionView {
  const phase = derivePhase(tenant.status, events);
  const requested = latestOf(events, 'client_data.deletion_requested');
  const approved = latestOf(events, 'client_data.deletion_approved');
  const cancelled = latestOf(events, 'client_data.deletion_cancelled');
  const requestSeq = requested?.seq ?? -1;
  const approvedAt =
    approved && Number(approved.seq) > Number(requestSeq) ? iso(approved.occurred_at) : null;
  const cancelledAt =
    cancelled && Number(cancelled.seq) > Number(requestSeq) ? iso(cancelled.occurred_at) : null;
  return {
    tenant_id: tenant.id,
    tenant_slug: tenant.slug,
    tenant_status: tenant.status,
    phase,
    requested_by: codeField(requested?.payload, 'requested_by'),
    requested_at: requested ? iso(requested.occurred_at) : null,
    grace_period_days: countField(requested?.payload, 'grace_period_days'),
    legal_basis: codeField(requested?.payload, 'legal_basis'),
    operator_id: approvedAt ? codeField(approved?.payload, 'operator_id') : null,
    approved_at: approvedAt,
    cancelled_by: cancelledAt ? codeField(cancelled?.payload, 'cancelled_by') : null,
    cancelled_at: cancelledAt,
  };
}

function latestOf(
  events: readonly AuditLogRow[],
  action: (typeof LIFECYCLE_ACTIONS)[number],
): AuditLogRow | undefined {
  let last: AuditLogRow | undefined;
  for (const event of events) {
    if (event.action === action) last = event;
  }
  return last;
}

function codeField(payload: Record<string, unknown> | undefined, key: string): string | null {
  const value = payload?.[key];
  return typeof value === 'string' ? value : null;
}

function countField(payload: Record<string, unknown> | undefined, key: string): number | null {
  const value = payload?.[key];
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
