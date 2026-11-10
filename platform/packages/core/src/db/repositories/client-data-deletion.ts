// Client data deletion: in-place PII scrubbing (task H03a, design/ADR-M97 §2.1–§2.2).
// Append-only tables are never updated or deleted. Callers that also scrub project configs run
// `anonymizeUser` and `scrubProjectConfigs` in one `TenantScope.transaction` (Harry, 2026-11-10).
import { createHash } from 'node:crypto';

import { sql, type Kysely } from 'kysely';

import { DbError } from '../errors.js';
import type { Database, ProjectConfig, User, UserIdentity } from '../schema.js';
import { TenantRepository } from './base.js';
import { overrideSha256 } from './project-configs.js';

/** Email written for a deleted person (H03a AC2, ADR-M97 §2.1). */
export function anonymizedEmail(userId: string): string {
  return `deleted-${userId}@redacted.invalid`;
}

/** Display name written for a deleted person (ADR-M97 §2.1). */
export function anonymizedDisplayName(userId: string): string {
  return `Redacted User ${userId.slice(0, 8)}`;
}

/** Login written for a redacted identity (ADR-M97 §2.1). */
export function anonymizedExternalLogin(identityId: string): string {
  return `redacted-${identityId}`;
}

/** Minimal YAML that replaces a project's configuration after a client purge (ADR-M97 §2.1). */
export function projectConfigTombstoneYaml(purgedAt: Date): string {
  return `redacted: true\npurged_at: ${purgedAt.toISOString()}\n`;
}

/** SHA-256 of the tombstone YAML (ADR-M97 §2.1: config_hash of the tombstone). */
export function projectConfigTombstoneHash(configYaml: string): string {
  return createHash('sha256').update(configYaml, 'utf8').digest('hex');
}

export interface AnonymizeUserResult {
  readonly user: User;
  readonly identities: readonly UserIdentity[];
}

export interface ScrubProjectConfigsResult {
  readonly configs: readonly ProjectConfig[];
}

/**
 * Scrubs personal data for client deletion without touching append-only tables.
 * Does not write audit events (H03a AC3: the chain stays unchanged until H03b's terminal event).
 */
export class ClientDataDeletionRepository extends TenantRepository {
  /**
   * Replaces one person's `users` and `user_identities` fields in one transaction.
   * Idempotent. Foreign keys that point at the user keep working.
   */
  anonymizeUser(userId: string): Promise<AnonymizeUserResult> {
    return this.transactional(async (db) => {
      const user = await this.run(
        db
          .updateTable('users')
          .set({
            email: anonymizedEmail(userId),
            display_name: anonymizedDisplayName(userId),
            status: 'disabled',
          })
          .where('tenant_id', '=', this.tenantId)
          .where('id', '=', userId)
          .returningAll()
          .executeTakeFirst(),
      );
      if (!user) {
        throw new DbError('reference_not_found', `user ${userId} is not in this tenant`);
      }
      const identities = await this.redactIdentities(db, userId);
      return { user, identities };
    });
  }

  /**
   * Replaces every stored project configuration of this tenant with a tombstone YAML.
   * Does not append `config.changed` (H03a AC3). Idempotent for an already-tombstoned row only
   * when the same `purgedAt` is passed; callers normally pass `new Date()` once per purge.
   */
  scrubProjectConfigs(purgedAt: Date = new Date()): Promise<ScrubProjectConfigsResult> {
    return this.transactional(async (db) => {
      const existing = await this.run(
        db
          .selectFrom('project_configs')
          .selectAll()
          .where('tenant_id', '=', this.tenantId)
          .orderBy('project_id')
          .execute(),
      );
      const configs: ProjectConfig[] = [];
      for (const row of existing) {
        const configYaml = projectConfigTombstoneYaml(purgedAt);
        const updated = await this.run(
          db
            .updateTable('project_configs')
            .set({
              config_yaml: configYaml,
              config_hash: projectConfigTombstoneHash(configYaml),
              override_sha256: overrideSha256(configYaml),
              version: row.version + 1,
            })
            .where('tenant_id', '=', this.tenantId)
            .where('project_id', '=', row.project_id)
            .where('version', '=', row.version)
            .returningAll()
            .executeTakeFirst(),
        );
        if (!updated) {
          throw new DbError(
            'version_conflict',
            `project_configs ${row.project_id} changed during client data scrub`,
          );
        }
        configs.push(updated);
      }
      return { configs };
    });
  }

  private redactIdentities(db: Kysely<Database>, userId: string): Promise<UserIdentity[]> {
    return this.run(
      db
        .updateTable('user_identities')
        .set({ external_login: sql<string>`'redacted-' || id::text` })
        .where('tenant_id', '=', this.tenantId)
        .where('user_id', '=', userId)
        .returningAll()
        .execute(),
    );
  }
}
