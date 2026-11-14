// Lesson endpoints (task X08b PR 2, ADR-M109 §2.3–§2.5): record a lesson that points to a GitHub
// comment, mark it applied or dropped, list the lessons and their counts. For the CLI (`adlc
// lesson`, `adlc lessons list`, `adlc metrics lessons`): no dashboard session may write here
// (QUESTIONS #728: the dashboard only lists them).
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';

import { CurrentPrincipal, type Principal } from '../auth/principal.js';
import { intentRefSchema } from '../intents/schemas.js';
import { LESSONS } from '../tokens.js';
import { parseRequest } from '../validation.js';
import type { LessonsService } from './lessons.service.js';
import {
  addLessonSchema,
  applyLessonSchema,
  dropLessonSchema,
  lessonIdSchema,
  lessonMetricsSchema,
  listLessonsSchema,
} from './schemas.js';

@Controller('v1')
export class LessonsController {
  constructor(@Inject(LESSONS) private readonly lessons: LessonsService) {}

  @Post('intents/:intent/lessons')
  @HttpCode(201)
  add(
    @CurrentPrincipal() p: Principal,
    @Param('intent') intent: string,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    return this.lessons.add(
      p,
      parseRequest(intentRefSchema, intent, 'path'),
      parseRequest(addLessonSchema, body ?? {}, 'body'),
    );
  }

  @Get('lessons')
  list(
    @CurrentPrincipal() p: Principal,
    @Query() query: unknown,
  ): Promise<Record<string, unknown>> {
    return this.lessons.list(p, parseRequest(listLessonsSchema, query, 'query'));
  }

  @Get('lessons/:id')
  show(
    @CurrentPrincipal() p: Principal,
    @Param('id') id: string,
  ): Promise<Record<string, unknown>> {
    return this.lessons.show(p, parseRequest(lessonIdSchema, id, 'path'));
  }

  @Post('lessons/:id/apply')
  @HttpCode(200)
  apply(
    @CurrentPrincipal() p: Principal,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    return this.lessons.apply(
      p,
      parseRequest(lessonIdSchema, id, 'path'),
      parseRequest(applyLessonSchema, body ?? {}, 'body'),
    );
  }

  @Post('lessons/:id/drop')
  @HttpCode(200)
  drop(
    @CurrentPrincipal() p: Principal,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    return this.lessons.drop(
      p,
      parseRequest(lessonIdSchema, id, 'path'),
      parseRequest(dropLessonSchema, body ?? {}, 'body'),
    );
  }

  @Get('metrics/lessons')
  metrics(
    @CurrentPrincipal() p: Principal,
    @Query() query: unknown,
  ): Promise<Record<string, unknown>> {
    return this.lessons.metrics(p, parseRequest(lessonMetricsSchema, query, 'query'));
  }
}
