// Migration 0048: client-data purge support (task H03b; design/ADR-M97 §2.1, §2.5).
// Rules for every migration: see the header of 0001-tenancy.ts and design/ADR-M09.
// Migrations 0001–0047 are merged and never edited.
//
// - Adds `client_purged` to `web_sessions.end_reason` (sessions ended when the tenant purge starts).
// - Extends `langfuse_purges.cause` with `client_deletion` (forced purge after the grace period).
import { defineMigration } from './define.js';

export const migration0048ClientPurge = defineMigration({
  up: [
    `ALTER TABLE web_sessions DROP CONSTRAINT web_sessions_end_reason_check`,
    `ALTER TABLE web_sessions ADD CONSTRAINT web_sessions_end_reason_check
       CHECK (end_reason IS NULL OR end_reason IN
         ('sign_out', 'all', 'admin', 'user_disabled', 'identity_unlinked', 'replaced',
          'client_purged'))`,

    `ALTER TABLE langfuse_purges DROP CONSTRAINT langfuse_purges_cause_check`,
    `ALTER TABLE langfuse_purges ADD CONSTRAINT langfuse_purges_cause_check
       CHECK (cause IN ('retention', 'archive', 'client_deletion'))`,
  ],
  down: [
    `ALTER TABLE langfuse_purges DROP CONSTRAINT langfuse_purges_cause_check`,
    `ALTER TABLE langfuse_purges ADD CONSTRAINT langfuse_purges_cause_check
       CHECK (cause IN ('retention', 'archive'))`,

    `ALTER TABLE web_sessions DROP CONSTRAINT web_sessions_end_reason_check`,
    `ALTER TABLE web_sessions ADD CONSTRAINT web_sessions_end_reason_check
       CHECK (end_reason IS NULL OR end_reason IN
         ('sign_out', 'all', 'admin', 'user_disabled', 'identity_unlinked', 'replaced'))`,
  ],
});
