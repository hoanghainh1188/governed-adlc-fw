// Request schemas of agent memory (task X13 PR 1, ADR-M74 §2.3, §2.7). Codes, numbers and SHAs
// only: memory text never reaches the API.
import { MEMORY_REVOCATION_REASONS } from '@sdlc/contracts';
import { z } from 'zod';

export const approveMemorySchema = z.strictObject({
  /** A commit that holds the same memory set as the head of the default branch. */
  commit_sha: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .optional(),
});

export const revokeMemorySchema = z.strictObject({
  reason: z.enum(MEMORY_REVOCATION_REASONS),
});

export const memoryVersionSchema = z.coerce.number().int().min(1).max(1_000_000);
