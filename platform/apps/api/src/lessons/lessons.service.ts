// Lessons for the authenticated caller (task X08b PR 2, ADR-M109 §2.3–§2.5). The rules live in
// `@sdlc/core` (`addLesson`, `decideLesson`, …): the same as for `/lesson` on GitHub.
import {
  addLesson,
  decideLesson,
  lessonMetrics,
  listLessons,
  readLesson,
  type LessonGitHost,
} from '@sdlc/core';
import type { z } from 'zod';

import type { Principal } from '../auth/principal.js';
import { presentLesson, presentLessonMetrics } from './present.js';
import type {
  addLessonSchema,
  applyLessonSchema,
  dropLessonSchema,
  lessonMetricsSchema,
  listLessonsSchema,
} from './schemas.js';

const sinceOf = (day: string | undefined) =>
  day === undefined ? undefined : new Date(`${day}T00:00:00.000Z`);

export class LessonsService {
  constructor(
    private readonly git: LessonGitHost | undefined,
    private readonly now: () => Date,
  ) {}

  async add(
    p: Principal,
    intentRef: string,
    body: z.infer<typeof addLessonSchema>,
  ): Promise<Record<string, unknown>> {
    const { intent, lesson } = await addLesson(p.scope, this.git, {
      intentRef,
      category: body.category,
      target: body.target,
      commentUrl: body.comment_url,
      actorId: p.userId,
      now: this.now(),
    });
    const project = await p.scope.projects.getById(intent.project_id);
    return presentLesson({ ...lesson, outcome: null }, intent, project);
  }

  async show(p: Principal, id: string): Promise<Record<string, unknown>> {
    const { lesson, intent, project } = await readLesson(p.scope, id, p.userId);
    return presentLesson(lesson, intent, project);
  }

  async apply(
    p: Principal,
    id: string,
    body: z.infer<typeof applyLessonSchema>,
  ): Promise<Record<string, unknown>> {
    await decideLesson(p.scope, {
      lessonId: id,
      actorId: p.userId,
      outcome: { kind: 'applied', linkUrl: body.link_url },
    });
    return this.show(p, id);
  }

  async drop(
    p: Principal,
    id: string,
    body: z.infer<typeof dropLessonSchema>,
  ): Promise<Record<string, unknown>> {
    await decideLesson(p.scope, {
      lessonId: id,
      actorId: p.userId,
      outcome: { kind: 'dropped', reason: body.reason },
    });
    return this.show(p, id);
  }

  async list(
    p: Principal,
    query: z.infer<typeof listLessonsSchema>,
  ): Promise<Record<string, unknown>> {
    const since = sinceOf(query.since);
    const { lessons, projects, intents } = await listLessons(p.scope, {
      actorId: p.userId,
      ...(query.project === undefined ? {} : { projectSlug: query.project }),
      ...(query.open === undefined ? {} : { open: query.open }),
      ...(since === undefined ? {} : { since }),
    });
    return {
      items: lessons.map((l) =>
        presentLesson(l, intents.get(l.intent_id), projects.get(l.project_id)),
      ),
    };
  }

  async metrics(
    p: Principal,
    query: z.infer<typeof lessonMetricsSchema>,
  ): Promise<Record<string, unknown>> {
    const since = sinceOf(query.since);
    const { lessons } = await listLessons(p.scope, {
      actorId: p.userId,
      ...(query.project === undefined ? {} : { projectSlug: query.project }),
      ...(since === undefined ? {} : { since }),
    });
    return presentLessonMetrics(lessonMetrics(lessons));
  }
}
