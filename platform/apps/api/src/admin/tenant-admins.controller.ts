// Admin endpoints for tenant admins (task B13, QUESTIONS #150, #151; ADR-M37 §2.1). Tenant admins
// only. Nobody grants the role to themselves, and the last active tenant admin is never removed.
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { grantTenantRole, listTenantRoles, revokeTenantRole } from '@sdlc/core';

import { SessionAction } from '../auth/auth.guard.js';
import { CurrentPrincipal, type Principal } from '../auth/principal.js';
import { ADMIN_STEP_UP } from '../tokens.js';
import { parseRequest } from '../validation.js';
import { actorOf } from './actor.js';
import { presentTenantRole } from './present.js';
import {
  emptyBodySchema,
  grantTenantAdminSchema,
  historyQuerySchema,
  idSchema,
} from './schemas.js';
import type { AdminStepUp } from './step-up.js';

type Body = Record<string, unknown>;

const BASE = '/v1/admin/tenant-admins';

// U09 (ADR-M73 §2.4b): a change also takes a dashboard session, with a passkey step-up.
@Controller('v1/admin/tenant-admins')
export class AdminTenantAdminsController {
  constructor(@Inject(ADMIN_STEP_UP) private readonly stepUp: AdminStepUp) {}

  @Get()
  async list(@CurrentPrincipal() p: Principal, @Query() query: unknown): Promise<Body> {
    const history = parseRequest(historyQuerySchema, query, 'query');
    const bindings = await listTenantRoles(p.scope, actorOf(p), history.include_revoked === 'true');
    return { items: bindings.map(presentTenantRole) };
  }

  @Post()
  @SessionAction('actions')
  @HttpCode(201)
  async grant(@CurrentPrincipal() p: Principal, @Body() body: unknown): Promise<Body> {
    const change = { action: 'admin.tenant_admin', decision: 'grant', target: BASE } as const;
    return presentTenantRole(
      await this.stepUp.apply(p, body, grantTenantAdminSchema, change, (q, input) =>
        grantTenantRole(q.scope, actorOf(q), { userId: input.user_id }),
      ),
    );
  }

  @Delete(':id')
  @SessionAction('actions')
  async revoke(
    @CurrentPrincipal() p: Principal,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<Body> {
    const bindingId = parseRequest(idSchema, id, 'path');
    const change = {
      action: 'admin.tenant_admin',
      decision: 'revoke',
      target: `${BASE}/${bindingId}`,
    } as const;
    return presentTenantRole(
      await this.stepUp.apply(p, body, emptyBodySchema, change, (q) =>
        revokeTenantRole(q.scope, actorOf(q), bindingId),
      ),
    );
  }
}
