// The JSON of a lesson (task X08b PR 2, ADR-M109 §2.4): codes, IDs, times and links only.
import type { Intent, LessonMetrics, LessonRow, Project } from '@sdlc/core';

export function presentLesson(
  lesson: LessonRow,
  intent: Pick<Intent, 'code'> | undefined,
  project: Pick<Project, 'slug'> | undefined,
): Record<string, unknown> {
  const o = lesson.outcome;
  return {
    id: lesson.id,
    intent: intent?.code ?? null,
    project: project?.slug ?? null,
    category: lesson.category,
    target: lesson.target,
    source: lesson.source,
    comment_url: lesson.comment_url,
    comment_id: lesson.comment_id,
    recorded_by: lesson.recorded_by,
    created_at: lesson.created_at.toISOString(),
    state: o === null ? 'open' : o.outcome,
    outcome:
      o === null
        ? null
        : {
            outcome: o.outcome,
            link_url: o.link_url,
            reason: o.reason,
            follow_up_intent_id: o.follow_up_intent_id,
            decided_by: o.decided_by,
            created_at: o.created_at.toISOString(),
          },
  };
}

export function presentLessonMetrics(metrics: LessonMetrics): Record<string, unknown> {
  return {
    recorded: metrics.recorded,
    open: metrics.open,
    applied: metrics.applied,
    dropped: metrics.dropped,
    by_category: metrics.byCategory,
    by_target: metrics.byTarget,
    median_days_to_outcome: metrics.medianDaysToOutcome,
  };
}
