// Project AI record endpoints (D-08 B12 AC1, ADR-M32 §2.4). Every handler works on the caller's
// tenant scope.
import { Body, Controller, Get, Inject, Param, Put } from '@nestjs/common';

import type { AdminStepUp } from '../admin/step-up.js';
import { SessionAction } from '../auth/auth.guard.js';
import { CurrentPrincipal, type Principal } from '../auth/principal.js';
import { ADMIN_STEP_UP, AI_RECORDS } from '../tokens.js';
import { parseRequest } from '../validation.js';
import type { AiRecordsService } from './ai-records.service.js';
import { projectSlugSchema, saveAiRecordSchema } from './schemas.js';

@Controller('v1/projects/:project/ai-record')
export class AiRecordsController {
  constructor(
    @Inject(AI_RECORDS) private readonly records: AiRecordsService,
    @Inject(ADMIN_STEP_UP) private readonly stepUp: AdminStepUp,
  ) {}

  @Get()
  show(
    @CurrentPrincipal() p: Principal,
    @Param('project') project: string,
  ): Promise<Record<string, unknown>> {
    return this.records.show(p, parseRequest(projectSlugSchema, project, 'path'));
  }

  /** U09 (ADR-M73 §2.4b): a dashboard session saves with a passkey step-up. */
  @Put()
  @SessionAction('actions')
  save(
    @CurrentPrincipal() p: Principal,
    @Param('project') project: string,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    const slug = parseRequest(projectSlugSchema, project, 'path');
    const split = this.stepUp.split(p, body);
    const input = parseRequest(saveAiRecordSchema, split.body, 'body');
    const change = {
      action: 'admin.ai_record',
      decision: 'save',
      target: `/v1/projects/${slug}/ai-record`,
    } as const;
    return this.records.save(p, slug, input, (write) => this.stepUp.run(p, change, split, write));
  }
}
