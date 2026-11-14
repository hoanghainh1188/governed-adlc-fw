// The lessons screen (task X08b PR 3, design/ADR-M109 §2.5, QUESTIONS #728): its filters live in
// the URL (`#/lessons?project=shop&open=true`), checked like the API checks them. Read only: the
// dashboard never records a lesson or its outcome. Pure: no DOM.
import type { LessonView } from '@sdlc/api-schemas';

/** The labels of the codes (explicit, so every key is checked against the catalog). */
export const LESSON_CATEGORY_KEYS: Readonly<Record<string, string>> = {
  gate: 'dashboard.lessons.category.gate',
  rework: 'dashboard.lessons.category.rework',
  agent_assumption: 'dashboard.lessons.category.agent_assumption',
  instructions: 'dashboard.lessons.category.instructions',
  process: 'dashboard.lessons.category.process',
  tooling: 'dashboard.lessons.category.tooling',
  other: 'dashboard.lessons.category.other',
};

export const LESSON_TARGET_KEYS: Readonly<Record<string, string>> = {
  agents_md: 'dashboard.lessons.target.agents_md',
  memory: 'dashboard.lessons.target.memory',
  handbook: 'dashboard.lessons.target.handbook',
  config: 'dashboard.lessons.target.config',
  none: 'dashboard.lessons.target.none',
};

export const LESSON_STATE_KEYS: Readonly<Record<string, string>> = {
  open: 'dashboard.lessons.state.open',
  applied: 'dashboard.lessons.state.applied',
  dropped: 'dashboard.lessons.state.dropped',
};

export const LESSON_REASON_KEYS: Readonly<Record<string, string>> = {
  duplicate: 'dashboard.lessons.reason.duplicate',
  not_valid: 'dashboard.lessons.reason.not_valid',
  record_only: 'dashboard.lessons.reason.record_only',
  other: 'dashboard.lessons.reason.other',
};

export interface LessonFilter {
  /** One of the person's projects; the first one when the URL names none or another. */
  readonly project: string | undefined;
  readonly open: boolean;
}

export function lessonFilterOf(query: URLSearchParams, projects: readonly string[]): LessonFilter {
  const asked = query.get('project');
  const project = asked !== null && projects.includes(asked) ? asked : projects[0];
  return { project, open: query.get('open') === 'true' };
}

const DAY_MS = 86_400_000;

/** Whole days since the lesson was recorded; null for a time that does not parse. */
export function ageInDays(createdAt: string, now: Date): number | null {
  const at = Date.parse(createdAt);
  return Number.isNaN(at) ? null : Math.max(0, Math.floor((now.getTime() - at) / DAY_MS));
}

/** What a lesson's outcome names: the change's link, a reason code, or nothing. */
export type LessonOutcome =
  | { readonly kind: 'none' }
  | { readonly kind: 'link'; readonly url: string }
  | { readonly kind: 'follow_up' }
  | { readonly kind: 'reason'; readonly reason: string };

export function outcomeOf(lesson: LessonView): LessonOutcome {
  const o = lesson.outcome;
  if (o === null) return { kind: 'none' };
  if (o.link_url !== null) return { kind: 'link', url: o.link_url };
  if (o.reason !== null) return { kind: 'reason', reason: o.reason };
  return o.follow_up_intent_id === null ? { kind: 'none' } : { kind: 'follow_up' };
}
