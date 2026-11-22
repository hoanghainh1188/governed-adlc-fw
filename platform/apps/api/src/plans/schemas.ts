// Request schema of the plan endpoint (task B09, ADR-M40 §2.3; U10, ADR-M113).
// Repo-backed plans pass optional `commit_sha`; uploaded Low-risk plans pass `plan_yaml`.
import { PLAN_MAX_BYTES } from '@sdlc/core';
import { z } from 'zod';

export const submitPlanSchema = z
  .strictObject({
    commit_sha: z
      .string()
      .regex(/^[0-9a-f]{40}$/)
      .optional(),
    plan_yaml: z.string().min(1).max(PLAN_MAX_BYTES).optional(),
  })
  .refine((v) => !(v.commit_sha !== undefined && v.plan_yaml !== undefined), {
    message: 'commit_sha and plan_yaml are mutually exclusive',
  });
