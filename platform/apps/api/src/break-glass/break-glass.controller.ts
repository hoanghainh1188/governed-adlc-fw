// Break-glass endpoints (task H08 PR 3a, ADR-M111 §2.9): request, approve, refuse, revoke and
// review a grant of one intent, and list the grants. For the CLI (`adlc break-glass`); no
// dashboard session may write here (only the routes of ADR-M73 do).
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';

import { CurrentPrincipal, type Principal } from '../auth/principal.js';
import { intentRefSchema } from '../intents/schemas.js';
import { BREAK_GLASS } from '../tokens.js';
import { parseRequest } from '../validation.js';
import type { BreakGlassService } from './break-glass.service.js';
import {
  emptyBodySchema,
  listBreakGlassSchema,
  requestBreakGlassSchema,
  reviewBreakGlassSchema,
} from './schemas.js';

@Controller('v1')
export class BreakGlassController {
  constructor(@Inject(BREAK_GLASS) private readonly breakGlass: BreakGlassService) {}

  @Post('intents/:intent/break-glass')
  @HttpCode(201)
  request(
    @CurrentPrincipal() p: Principal,
    @Param('intent') intent: string,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    return this.breakGlass.request(
      p,
      parseRequest(intentRefSchema, intent, 'path'),
      parseRequest(requestBreakGlassSchema, body ?? {}, 'body'),
    );
  }

  @Post('intents/:intent/break-glass/approve')
  @HttpCode(200)
  approve(
    @CurrentPrincipal() p: Principal,
    @Param('intent') intent: string,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    parseRequest(emptyBodySchema, body ?? {}, 'body');
    return this.breakGlass.approve(p, parseRequest(intentRefSchema, intent, 'path'));
  }

  @Post('intents/:intent/break-glass/refuse')
  @HttpCode(200)
  refuse(
    @CurrentPrincipal() p: Principal,
    @Param('intent') intent: string,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    parseRequest(emptyBodySchema, body ?? {}, 'body');
    return this.breakGlass.refuse(p, parseRequest(intentRefSchema, intent, 'path'));
  }

  @Post('intents/:intent/break-glass/revoke')
  @HttpCode(200)
  revoke(
    @CurrentPrincipal() p: Principal,
    @Param('intent') intent: string,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    parseRequest(emptyBodySchema, body ?? {}, 'body');
    return this.breakGlass.revoke(p, parseRequest(intentRefSchema, intent, 'path'));
  }

  @Post('intents/:intent/break-glass/review')
  @HttpCode(200)
  review(
    @CurrentPrincipal() p: Principal,
    @Param('intent') intent: string,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    return this.breakGlass.review(
      p,
      parseRequest(intentRefSchema, intent, 'path'),
      parseRequest(reviewBreakGlassSchema, body ?? {}, 'body'),
    );
  }

  @Get('break-glass')
  list(
    @CurrentPrincipal() p: Principal,
    @Query() query: unknown,
  ): Promise<Record<string, unknown>> {
    return this.breakGlass.list(p, parseRequest(listBreakGlassSchema, query, 'query'));
  }
}
