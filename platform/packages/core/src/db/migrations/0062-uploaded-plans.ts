// Migration 0062: Low-risk uploaded plans (task U10, GitHub issue #559, design/ADR-M113).
//
// Allows Low-risk (and optionally Medium-risk, per project config) intents to submit a YAML plan
// stored in SeaweedFS (`plan_source = 'uploaded'`, `storage_uri` set, `commit_sha` null) without
// merging a separate plan PR to the default branch before G3. High and Critical intents continue
// to require `plan_source = 'repo'`.
import { defineMigration } from './define.js';

export const migration0062UploadedPlans = defineMigration({
  up: [
    `ALTER TABLE plans
       ADD COLUMN plan_source text NOT NULL DEFAULT 'repo'
         CHECK (plan_source IN ('repo', 'uploaded')),
       ADD COLUMN storage_uri text
         CHECK (storage_uri IS NULL OR (length(storage_uri) BETWEEN 1 AND 512)),
       DROP CONSTRAINT plans_file_columns_check,
       ADD CONSTRAINT plans_file_columns_check CHECK (
         (plan_source = 'repo' AND commit_sha IS NULL AND storage_uri IS NULL
           AND allowed_tools IS NULL AND submitted_by IS NULL)
         OR (plan_source = 'repo' AND commit_sha IS NOT NULL AND storage_uri IS NULL
           AND allowed_tools IS NOT NULL AND submitted_by IS NOT NULL
           AND proposed_by_type = 'human' AND summary = '')
         OR (plan_source = 'uploaded' AND commit_sha IS NULL AND storage_uri IS NOT NULL
           AND allowed_tools IS NOT NULL AND submitted_by IS NOT NULL
           AND proposed_by_type = 'human' AND summary = ''))`,
  ],
  // Development only (ADR-M09).
  down: [
    `ALTER TABLE plans
       DROP CONSTRAINT plans_file_columns_check,
       DROP COLUMN storage_uri,
       DROP COLUMN plan_source,
       ADD CONSTRAINT plans_file_columns_check CHECK (
         (commit_sha IS NULL AND allowed_tools IS NULL AND submitted_by IS NULL)
         OR (commit_sha IS NOT NULL AND allowed_tools IS NOT NULL AND submitted_by IS NOT NULL
             AND proposed_by_type = 'human' AND summary = ''))`,
  ],
});
