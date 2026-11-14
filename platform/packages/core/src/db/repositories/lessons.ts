import type { IntentLesson, IntentLessonOutcomeRow, TenantInsert } from '../schema.js';
import { TenantRepository } from './base.js';

/** A lesson with its latest outcome (ADR-M109 §2.4: none means `open`). */
export interface LessonRow extends IntentLesson {
  readonly outcome: IntentLessonOutcomeRow | null;
}

/**
 * Lessons recorded at G8 and their outcomes (task X08b, migration 0057, ADR-M109 §2.4). Both
 * tables are append-only: insert and read, nothing else. Every query names the tenant.
 */
export class LessonRepository extends TenantRepository {
  /** Records a lesson; a second lesson for the same comment fails with `conflict`. */
  record(input: Omit<TenantInsert<'intent_lessons'>, 'tenant_id'>): Promise<IntentLesson> {
    return this.run(
      this.db
        .insertInto('intent_lessons')
        .values({ ...input, tenant_id: this.tenantId })
        .returningAll()
        .executeTakeFirstOrThrow(),
    );
  }

  /** Records an outcome of a lesson of this tenant. */
  recordOutcome(
    input: Omit<TenantInsert<'intent_lesson_outcomes'>, 'tenant_id'>,
  ): Promise<IntentLessonOutcomeRow> {
    return this.run(
      this.db
        .insertInto('intent_lesson_outcomes')
        .values({ ...input, tenant_id: this.tenantId })
        .returningAll()
        .executeTakeFirstOrThrow(),
    );
  }

  /** The lesson of a comment of the project, or undefined. */
  forComment(projectId: string, commentId: string): Promise<IntentLesson | undefined> {
    return this.run(
      this.db
        .selectFrom('intent_lessons')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('project_id', '=', projectId)
        .where('comment_id', '=', commentId)
        .executeTakeFirst(),
    );
  }

  /** The lessons of an intent, oldest first, with their latest outcome. */
  async listForIntent(intentId: string): Promise<LessonRow[]> {
    const lessons = await this.run(
      this.db
        .selectFrom('intent_lessons')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('intent_id', '=', intentId)
        .orderBy('created_at')
        .orderBy('id')
        .execute(),
    );
    return this.withOutcomes(lessons);
  }

  private async withOutcomes(lessons: readonly IntentLesson[]): Promise<LessonRow[]> {
    if (lessons.length === 0) return [];
    const outcomes = await this.run(
      this.db
        .selectFrom('intent_lesson_outcomes')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where(
          'lesson_id',
          'in',
          lessons.map((l) => l.id),
        )
        .orderBy('created_at')
        .orderBy('id')
        .execute(),
    );
    const latest = new Map<string, IntentLessonOutcomeRow>();
    for (const outcome of outcomes) latest.set(outcome.lesson_id, outcome);
    return lessons.map((lesson) => ({ ...lesson, outcome: latest.get(lesson.id) ?? null }));
  }
}
