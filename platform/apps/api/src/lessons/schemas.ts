// Request schemas of the lesson endpoints (task X08b PR 2, ADR-M109 §2.3–§2.5): codes, IDs, dates
// and `https://` links only. The words of a lesson stay in its GitHub comment (R030).
import { LESSON_CATEGORIES, LESSON_DROP_REASONS, LESSON_TARGETS } from '@sdlc/contracts';
import { z } from 'zod';

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
const link = z
  .string()
  .max(512)
  .regex(/^https:\/\/\S+$/);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const flag = z.enum(['true', 'false']).transform((value) => value === 'true');

export const lessonIdSchema = z.uuid();

export const addLessonSchema = z.strictObject({
  category: z.enum(LESSON_CATEGORIES),
  target: z.enum(LESSON_TARGETS),
  comment_url: link,
});

export const applyLessonSchema = z.strictObject({ link_url: link });

export const dropLessonSchema = z.strictObject({ reason: z.enum(LESSON_DROP_REASONS) });

export const listLessonsSchema = z.strictObject({
  project: slug.optional(),
  open: flag.optional(),
  since: day.optional(),
});

export const lessonMetricsSchema = z.strictObject({
  project: slug.optional(),
  since: day.optional(),
});
