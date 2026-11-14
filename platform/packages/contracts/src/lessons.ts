// Lessons recorded at G8 (task X08b, design/ADR-M109 §2.2–§2.5, QUESTIONS #706–#710, #726–#730).
//
// A lesson is something a person learned from one intent. Its words stay in a GitHub comment on
// the intent's issue or pull request, where the author can edit or delete them; the platform keeps
// codes, IDs and the comment's link only (R030, ADR-M20). Never an agent, never a bot.

/** What a lesson is about (ADR-M109 §2.2). */
export const LESSON_CATEGORIES = [
  'gate',
  'rework',
  'agent_assumption',
  'instructions',
  'process',
  'tooling',
  'other',
] as const;
export type LessonCategory = (typeof LESSON_CATEGORIES)[number];

/** What the lesson should change (ADR-M109 §2.2). */
export const LESSON_TARGETS = ['agents_md', 'memory', 'handbook', 'config', 'none'] as const;
export type LessonTarget = (typeof LESSON_TARGETS)[number];

/** How a lesson was recorded. */
/** `web`: the dashboard, later (QUESTIONS #728). */
export const LESSON_SOURCES = ['github_comment', 'api', 'web'] as const;
export type LessonSource = (typeof LESSON_SOURCES)[number];

/** The outcome of a lesson (ADR-M109 §2.5); a lesson without one is `open`. */
export const LESSON_OUTCOMES = ['applied', 'dropped'] as const;
export type LessonOutcome = (typeof LESSON_OUTCOMES)[number];

/** Why a lesson was dropped (ADR-M109 §2.5). */
export const LESSON_DROP_REASONS = ['duplicate', 'not_valid', 'record_only', 'other'] as const;
export type LessonDropReason = (typeof LESSON_DROP_REASONS)[number];
