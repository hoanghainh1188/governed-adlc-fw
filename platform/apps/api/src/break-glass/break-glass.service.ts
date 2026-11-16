// Break-glass for the authenticated caller (task H08 PR 3a, ADR-M111 §2.4, §2.9). The rules live
// in `@sdlc/core`. Every action has a person as its actor (a personal token): rule M21 needs two
// different people, which the operator commands (`system`) cannot show.
import {
  approveBreakGlass,
  listBreakGlass,
  refuseBreakGlass,
  requestBreakGlass,
  reviewBreakGlass,
  revokeBreakGlass,
  type BreakGlassGitHost,
  type BreakGlassGrant,
  type Intent,
  type TenantScope,
} from '@sdlc/core';
import type { z } from 'zod';

import type { IntentWorkflowSignals } from '@sdlc/contracts';

import type { Principal } from '../auth/principal.js';
import { wakeQuietly, type WakeLogger } from '../intent-signals.js';
import { presentBreakGlass } from './present.js';
import type {
  listBreakGlassSchema,
  requestBreakGlassSchema,
  reviewBreakGlassSchema,
} from './schemas.js';

export class BreakGlassService {
  constructor(
    private readonly git: BreakGlassGitHost | undefined,
    private readonly now: () => Date,
    private readonly signals: IntentWorkflowSignals,
    private readonly logger: WakeLogger,
  ) {}

  /** PR 3b: a grant changes what the intent may do (the HOTL window, G8): the step reads it again. */
  private wake(p: Principal, intent: Intent): Promise<void> {
    return wakeQuietly(
      this.signals,
      { tenantId: p.scope.tenantId, intentId: intent.id },
      this.logger,
    );
  }

  async request(
    p: Principal,
    intentRef: string,
    body: z.infer<typeof requestBreakGlassSchema>,
  ): Promise<Record<string, unknown>> {
    const { intent, grant } = await requestBreakGlass(p.scope, this.git, {
      intentRef,
      scopes: body.scopes,
      hours: body.hours,
      reasonUrl: body.reason_url,
      ...(body.budget_increase_usd === undefined
        ? {}
        : { budgetIncreaseUsd: body.budget_increase_usd }),
      actorId: p.userId,
      now: this.now(),
    });
    return view(p.scope, intent, grant, null);
  }

  async approve(p: Principal, intentRef: string): Promise<Record<string, unknown>> {
    const input = { intentRef, actorId: p.userId, now: this.now() };
    const { intent, grant, incident } = await approveBreakGlass(p.scope, input);
    await this.wake(p, intent);
    return view(p.scope, intent, grant, incident);
  }

  async refuse(p: Principal, intentRef: string): Promise<Record<string, unknown>> {
    const input = { intentRef, actorId: p.userId, now: this.now() };
    const { intent, grant } = await refuseBreakGlass(p.scope, input);
    return view(p.scope, intent, grant, null);
  }

  async revoke(p: Principal, intentRef: string): Promise<Record<string, unknown>> {
    const { intent, grant } = await revokeBreakGlass(p.scope, {
      intentRef,
      actor: { type: 'human', id: p.userId },
      now: this.now(),
    });
    await this.wake(p, intent);
    return view(p.scope, intent, grant, undefined);
  }

  async review(
    p: Principal,
    intentRef: string,
    body: z.infer<typeof reviewBreakGlassSchema>,
  ): Promise<Record<string, unknown>> {
    const { intent, grant, incident } = await reviewBreakGlass(p.scope, this.git, {
      intentRef,
      commentUrl: body.comment_url,
      actorId: p.userId,
      now: this.now(),
    });
    await this.wake(p, intent);
    return view(p.scope, intent, grant, incident);
  }

  async list(
    p: Principal,
    query: z.infer<typeof listBreakGlassSchema>,
  ): Promise<Record<string, unknown>> {
    const rows = await listBreakGlass(p.scope, {
      actorId: p.userId,
      ...(query.project === undefined ? {} : { projectSlug: query.project }),
      ...(query.open === undefined ? {} : { open: query.open }),
    });
    return {
      items: rows.map((r) =>
        presentBreakGlass(
          r.grant,
          r.intent?.code ?? null,
          r.project?.slug ?? null,
          r.escalation?.code ?? null,
        ),
      ),
    };
  }
}

/** The grant's view; `incident` undefined: read it from the escalation. */
async function view(
  scope: TenantScope,
  intent: Intent,
  grant: BreakGlassGrant,
  incident: string | null | undefined,
): Promise<Record<string, unknown>> {
  const project = await scope.projects.getById(intent.project_id);
  const code =
    incident !== undefined
      ? incident
      : grant.escalation_id === null
        ? null
        : ((await scope.escalations.getById(grant.escalation_id))?.code ?? null);
  return presentBreakGlass(grant, intent.code, project?.slug ?? null, code);
}
