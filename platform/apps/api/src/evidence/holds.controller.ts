// Evidence holds of an intent (task E05, design/ADR-M51, QUESTIONS #235; handbook Ch.15). A hold
// keeps the intent's evidence files from the purge until it is released. Who: tenant admins, or a
// role in config `access.evidence_hold_roles` (never `viewer`, rule M32). Every handler works on
// the caller's tenant scope.
import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Put } from '@nestjs/common';
import {
  holdEvidence,
  releaseEvidenceHold,
  showEvidenceHolds,
  type EvidenceHold,
} from '@sdlc/core';
import { z } from 'zod';

import { emptyBodySchema } from '../admin/schemas.js';
import type { AdminStepUp } from '../admin/step-up.js';
import { SessionAction } from '../auth/auth.guard.js';
import { CurrentPrincipal, type Principal } from '../auth/principal.js';
import { intentRefSchema } from '../intents/schemas.js';
import { ADMIN_STEP_UP } from '../tokens.js';
import { parseRequest } from '../validation.js';

export const holdBodySchema = z.strictObject({
  reason_ref: z
    .string()
    .max(512)
    .regex(/^https:\/\/\S+$/)
    .optional(),
});

/** A hold as the API shows it: IDs, times and the optional link; never text. */
export function presentHold(hold: EvidenceHold): Record<string, unknown> {
  return {
    id: hold.id,
    held_by: hold.held_by,
    reason_ref: hold.reason_ref,
    created_at: hold.created_at.toISOString(),
    released_at: hold.released_at?.toISOString() ?? null,
    released_by: hold.released_by,
  };
}

// U09 (ADR-M73 §2.4b): a hold and a release also take a dashboard session, with a passkey step-up.
@Controller('v1/intents/:intent/evidence-hold')
export class EvidenceHoldsController {
  constructor(@Inject(ADMIN_STEP_UP) private readonly stepUp: AdminStepUp) {}

  @Get()
  async show(
    @CurrentPrincipal() p: Principal,
    @Param('intent') ref: string,
  ): Promise<Record<string, unknown>> {
    const view = await showEvidenceHolds(
      p.scope,
      { userId: p.userId },
      parseRequest(intentRefSchema, ref, 'path'),
    );
    return {
      intent: view.intent.code,
      active: view.active ? presentHold(view.active) : null,
      history: view.history.map(presentHold),
    };
  }

  @Put()
  @SessionAction('actions')
  @HttpCode(201)
  async hold(
    @CurrentPrincipal() p: Principal,
    @Param('intent') ref: string,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    const intent = parseRequest(intentRefSchema, ref, 'path');
    const change = {
      action: 'admin.evidence_hold',
      decision: 'hold',
      target: `/v1/intents/${intent}/evidence-hold`,
    } as const;
    const hold = await this.stepUp.apply(p, body, holdBodySchema, change, (q, input) =>
      holdEvidence(q.scope, { userId: q.userId }, intent, input.reason_ref ?? null),
    );
    return { hold: presentHold(hold) };
  }

  @Delete()
  @SessionAction('actions')
  async release(
    @CurrentPrincipal() p: Principal,
    @Param('intent') ref: string,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    const intent = parseRequest(intentRefSchema, ref, 'path');
    const change = {
      action: 'admin.evidence_hold',
      decision: 'release',
      target: `/v1/intents/${intent}/evidence-hold`,
    } as const;
    const hold = await this.stepUp.apply(p, body, emptyBodySchema, change, (q) =>
      releaseEvidenceHold(q.scope, { userId: q.userId }, intent),
    );
    return { hold: presentHold(hold) };
  }
}
