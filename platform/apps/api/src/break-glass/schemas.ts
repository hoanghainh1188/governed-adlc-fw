// Request schemas of the break-glass endpoints (task H08 PR 3a, ADR-M111 §2.9): codes, a whole
// number of hours, a USD decimal string and `https://` links only. The reason and the review stay
// in GitHub comments (R030). The core checks the rules (roles, scopes allowed, the caps).
import { BREAK_GLASS_SCOPES } from '@sdlc/contracts';
import { z } from 'zod';

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
const link = z
  .string()
  .max(512)
  .regex(/^https:\/\/\S+$/);
const flag = z.enum(['true', 'false']).transform((value) => value === 'true');

export const requestBreakGlassSchema = z.strictObject({
  scopes: z.array(z.enum(BREAK_GLASS_SCOPES)).min(1).max(BREAK_GLASS_SCOPES.length),
  hours: z.number().int().min(1).max(8),
  reason_url: link,
  budget_increase_usd: z
    .string()
    .regex(/^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$/)
    .optional(),
});

/** Approve, refuse and revoke take no body (an empty object at most). */
export const emptyBodySchema = z.strictObject({});

export const reviewBreakGlassSchema = z.strictObject({ comment_url: link });

export const listBreakGlassSchema = z.strictObject({
  project: slug.optional(),
  open: flag.optional(),
});
