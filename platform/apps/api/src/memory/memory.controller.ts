// Agent memory endpoints of a project (task X13 PR 1, ADR-M74 §2.3, §2.7): list the approved
// versions, approve the set at the head of the default branch, revoke a version. For the CLI
// (`adlc memory`): no dashboard session may write here.
import { Body, Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';

import { projectSlugSchema } from '../ai-records/schemas.js';
import { CurrentPrincipal, type Principal } from '../auth/principal.js';
import { MEMORY } from '../tokens.js';
import { parseRequest } from '../validation.js';
import type { MemoryService } from './memory.service.js';
import { approveMemorySchema, memoryVersionSchema, revokeMemorySchema } from './schemas.js';

@Controller('v1/projects/:project/memory')
export class MemoryController {
  constructor(@Inject(MEMORY) private readonly memory: MemoryService) {}

  @Get()
  list(
    @CurrentPrincipal() p: Principal,
    @Param('project') project: string,
  ): Promise<Record<string, unknown>> {
    return this.memory.list(p, parseRequest(projectSlugSchema, project, 'path'));
  }

  @Post('approve')
  @HttpCode(200)
  approve(
    @CurrentPrincipal() p: Principal,
    @Param('project') project: string,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    const input = parseRequest(approveMemorySchema, body ?? {}, 'body');
    return this.memory.approve(
      p,
      parseRequest(projectSlugSchema, project, 'path'),
      input.commit_sha,
    );
  }

  @Post('versions/:version/revoke')
  @HttpCode(200)
  revoke(
    @CurrentPrincipal() p: Principal,
    @Param('project') project: string,
    @Param('version') version: string,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    const input = parseRequest(revokeMemorySchema, body ?? {}, 'body');
    return this.memory.revoke(
      p,
      parseRequest(projectSlugSchema, project, 'path'),
      parseRequest(memoryVersionSchema, version, 'path'),
      input.reason,
    );
  }
}
