// Dashboard sign-in sessions (U05, migration 0027, design/ADR-M73 §2.2). The session secret never
// reaches this layer: callers pass its SHA-256 (`hashSessionSecret`). Rows are never deleted.
import { createHash } from 'node:crypto';

import { DbError } from '../errors.js';
import type { TenantInsert, WebSession, WebSessionEndReason } from '../schema.js';
import { TenantRepository } from './base.js';

const HEX64 = /^[0-9a-f]{64}$/;

/** SHA-256 of a session secret, lowercase hex. Only this hash is stored. */
export function hashSessionSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

function assertSecretHash(value: string): void {
  if (!HEX64.test(value)) {
    throw new DbError('invalid_value', 'secret_sha256 must be a SHA-256 hex digest');
  }
}

export class WebSessionRepository extends TenantRepository {
  async create(input: TenantInsert<'web_sessions'>): Promise<WebSession> {
    assertSecretHash(input.secret_sha256);
    return this.run(
      this.db
        .insertInto('web_sessions')
        .values({ ...input, tenant_id: this.tenantId })
        .returningAll()
        .executeTakeFirstOrThrow(),
    );
  }

  getById(id: string): Promise<WebSession | undefined> {
    return this.run(
      this.db
        .selectFrom('web_sessions')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', id)
        .executeTakeFirst(),
    );
  }

  /** The open sessions of a user (not ended, not past their absolute end), oldest first. */
  listOpenForUser(userId: string, now: Date): Promise<WebSession[]> {
    return this.run(
      this.db
        .selectFrom('web_sessions')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('user_id', '=', userId)
        .where('revoked_at', 'is', null)
        .where('expires_at', '>', now)
        .orderBy('created_at')
        .execute(),
    );
  }

  /** Moves `last_seen_at` forward; never back, never on an ended session. */
  touch(id: string, at: Date): Promise<void> {
    return this.run(
      this.db
        .updateTable('web_sessions')
        .set({ last_seen_at: at })
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', id)
        .where('revoked_at', 'is', null)
        .where('last_seen_at', '<', at)
        .execute()
        .then(() => undefined),
    );
  }

  /** Ends one session. Returns it when this call ended it; undefined when it was already ended. */
  end(id: string, reason: WebSessionEndReason, at: Date): Promise<WebSession | undefined> {
    return this.run(
      this.db
        .updateTable('web_sessions')
        .set({ revoked_at: at, end_reason: reason })
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', id)
        .where('revoked_at', 'is', null)
        .returningAll()
        .executeTakeFirst(),
    );
  }

  /** Ends every open session of this tenant. Returns how many this call ended. */
  endAllOpen(reason: WebSessionEndReason, at: Date): Promise<number> {
    return this.run(
      this.db
        .updateTable('web_sessions')
        .set({ revoked_at: at, end_reason: reason })
        .where('tenant_id', '=', this.tenantId)
        .where('revoked_at', 'is', null)
        .executeTakeFirst()
        .then((r) => Number(r.numUpdatedRows)),
    );
  }

  /** Ends every session of a user that is not ended yet. Returns how many this call ended. */
  endAllForUser(userId: string, reason: WebSessionEndReason, at: Date): Promise<number> {
    return this.run(
      this.db
        .updateTable('web_sessions')
        .set({ revoked_at: at, end_reason: reason })
        .where('tenant_id', '=', this.tenantId)
        .where('user_id', '=', userId)
        .where('revoked_at', 'is', null)
        .executeTakeFirst()
        .then((r) => Number(r.numUpdatedRows)),
    );
  }

  /** Ends every session opened with one identity. Returns how many this call ended. */
  endAllForIdentity(identityId: string, reason: WebSessionEndReason, at: Date): Promise<number> {
    return this.run(
      this.db
        .updateTable('web_sessions')
        .set({ revoked_at: at, end_reason: reason })
        .where('tenant_id', '=', this.tenantId)
        .where('identity_id', '=', identityId)
        .where('revoked_at', 'is', null)
        .executeTakeFirst()
        .then((r) => Number(r.numUpdatedRows)),
    );
  }
}
