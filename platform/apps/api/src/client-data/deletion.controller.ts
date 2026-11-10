// Client data deletion request, cancel and status (task H03c, design/ADR-M97 §2.4; D-08 H03c).
// Tenant admins only. Approval is an operator command on the server (`adlc ops …`), never here.
import { Body, Controller, Delete, Get, HttpCode, Inject, Post } from '@nestjs/common';
import {
  cancelDeletion,
  DEFAULT_CLIENT_DELETION_GRACE_DAYS,
  DEFAULT_DELETION_LEGAL_BASIS,
  deletionStatus,
  requestDeletion,
  type ClientDeletionView,
  type PlatformDatabase,
} from '@sdlc/core';
import { z } from 'zod';

import { actorOf } from '../admin/actor.js';
import { CurrentPrincipal, type Principal } from '../auth/principal.js';
import { CLOCK, DATABASE } from '../tokens.js';
import { parseRequest } from '../validation.js';

const LEGAL_BASIS = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

export const requestDeletionBodySchema = z.strictObject({
  legal_basis: z.string().regex(LEGAL_BASIS).max(64).optional(),
});

@Controller('v1/client/data-deletion')
export class ClientDataDeletionController {
  constructor(
    @Inject(DATABASE) private readonly db: PlatformDatabase,
    @Inject(CLOCK) private readonly now: () => Date,
  ) {}

  @Get()
  async status(@CurrentPrincipal() p: Principal): Promise<Record<string, unknown>> {
    return present(await deletionStatus(this.db, p.scope));
  }

  @Post()
  @HttpCode(201)
  async request(
    @CurrentPrincipal() p: Principal,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    const input = parseRequest(requestDeletionBodySchema, body ?? {}, 'body');
    const view = await requestDeletion(
      this.db,
      p.scope,
      actorOf(p),
      {
        legalBasis: input.legal_basis ?? DEFAULT_DELETION_LEGAL_BASIS,
        gracePeriodDays: DEFAULT_CLIENT_DELETION_GRACE_DAYS,
      },
      this.now(),
    );
    return present(view);
  }

  @Delete()
  async cancel(@CurrentPrincipal() p: Principal): Promise<Record<string, unknown>> {
    return present(await cancelDeletion(this.db, p.scope, actorOf(p), this.now()));
  }
}

function present(view: ClientDeletionView): Record<string, unknown> {
  return {
    tenant_id: view.tenant_id,
    tenant_slug: view.tenant_slug,
    tenant_status: view.tenant_status,
    phase: view.phase,
    requested_by: view.requested_by,
    requested_at: view.requested_at,
    grace_period_days: view.grace_period_days,
    legal_basis: view.legal_basis,
    operator_id: view.operator_id,
    approved_at: view.approved_at,
    cancelled_by: view.cancelled_by,
    cancelled_at: view.cancelled_at,
  };
}
