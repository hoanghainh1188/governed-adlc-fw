// Intent and gate endpoints (D-08 B03 AC3). Every handler works on the caller's tenant scope.
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query } from '@nestjs/common';

import { SessionAction } from '../auth/auth.guard.js';
import { CurrentPrincipal, type Principal } from '../auth/principal.js';
import { INTENTS } from '../tokens.js';
import { parseRequest } from '../validation.js';
import type { IntentPage, IntentsService } from './intents.service.js';
import type { IntentBody } from './present.js';
import {
  createIntentSchema,
  decisionSchema,
  effortEstimateSchema,
  gateSchema,
  intentRefSchema,
  listIntentsSchema,
} from './schemas.js';

@Controller('v1/intents')
export class IntentsController {
  constructor(@Inject(INTENTS) private readonly intents: IntentsService) {}

  @Post()
  @SessionAction('actions')
  @HttpCode(201)
  create(@CurrentPrincipal() p: Principal, @Body() body: unknown): Promise<IntentBody> {
    return this.intents.create(p, parseRequest(createIntentSchema, body, 'body'));
  }

  @Get()
  list(@CurrentPrincipal() p: Principal, @Query() query: unknown): Promise<IntentPage> {
    return this.intents.list(p, parseRequest(listIntentsSchema, query, 'query'));
  }

  @Get(':intent')
  show(
    @CurrentPrincipal() p: Principal,
    @Param('intent') ref: string,
  ): Promise<Record<string, unknown>> {
    return this.intents.show(p, parseRequest(intentRefSchema, ref, 'path'));
  }

  /**
   * V14 (ADR-M79 §2.6): records a person's estimate of the human effort. A token only: never a
   * dashboard session write (R085).
   */
  @Put(':intent/effort-estimate')
  @HttpCode(200)
  estimate(
    @CurrentPrincipal() p: Principal,
    @Param('intent') ref: string,
    @Body() body: unknown,
  ): Promise<IntentBody> {
    return this.intents.estimate(
      p,
      parseRequest(intentRefSchema, ref, 'path'),
      parseRequest(effortEstimateSchema, body, 'body'),
    );
  }

  @Post(':intent/gates/:gate/decisions')
  @SessionAction('actions')
  @HttpCode(201)
  decide(
    @CurrentPrincipal() p: Principal,
    @Param('intent') ref: string,
    @Param('gate') gate: string,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    return this.intents.decide(
      p,
      parseRequest(intentRefSchema, ref, 'path'),
      parseRequest(gateSchema, gate, 'path'),
      parseRequest(decisionSchema, body, 'body'),
    );
  }
}
