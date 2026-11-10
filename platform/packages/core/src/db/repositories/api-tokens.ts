import { createHash } from 'node:crypto';

import { DbError } from '../errors.js';
import type { ApiToken, TenantInsert } from '../schema.js';
import { TenantRepository } from './base.js';

const HEX64 = /^[0-9a-f]{64}$/;

/** SHA-256 of an API token, lowercase hex. Only this hash is stored (D-05 section 6.1). */
export function hashApiToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Rejects anything that is not a SHA-256 hex digest, so a raw token can never be stored. */
export function assertTokenHash(value: string): void {
  if (!HEX64.test(value)) {
    throw new DbError(
      'invalid_value',
      'token_hash must be a SHA-256 hex digest (use hashApiToken)',
    );
  }
}

export class ApiTokenRepository extends TenantRepository {
  /** Stores a token by its hash. Callers hash the token with `hashApiToken`; the raw token never reaches the database. */
  async create(input: TenantInsert<'api_tokens'>): Promise<ApiToken> {
    assertTokenHash(input.token_hash);
    return this.run(
      this.db
        .insertInto('api_tokens')
        .values({ ...input, tenant_id: this.tenantId })
        .returningAll()
        .executeTakeFirstOrThrow(),
    );
  }

  getById(id: string): Promise<ApiToken | undefined> {
    return this.run(
      this.db
        .selectFrom('api_tokens')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', id)
        .executeTakeFirst(),
    );
  }

  listForUser(userId: string): Promise<ApiToken[]> {
    return this.run(
      this.db
        .selectFrom('api_tokens')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('user_id', '=', userId)
        .orderBy('created_at')
        .execute(),
    );
  }

  /** Revokes a token. Idempotent: an already revoked token keeps its first revocation time. */
  revoke(id: string, at: Date = new Date()): Promise<ApiToken | undefined> {
    return this.run(
      this.db
        .updateTable('api_tokens')
        .set((eb) => ({ revoked_at: eb.fn.coalesce('revoked_at', eb.val(at)) }))
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirst(),
    );
  }

  /** Revokes every active token of this tenant. Returns how many this call revoked. */
  revokeAllActive(at: Date = new Date()): Promise<number> {
    return this.run(
      this.db
        .updateTable('api_tokens')
        .set({ revoked_at: at })
        .where('tenant_id', '=', this.tenantId)
        .where('revoked_at', 'is', null)
        .executeTakeFirst()
        .then((r) => Number(r.numUpdatedRows)),
    );
  }

  touchLastUsed(id: string, at: Date = new Date()): Promise<void> {
    return this.run(
      this.db
        .updateTable('api_tokens')
        .set({ last_used_at: at })
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', id)
        .execute()
        .then(() => undefined),
    );
  }
}
