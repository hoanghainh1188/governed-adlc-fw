// Passkeys (U06, migration 0028, design/ADR-M73 §2.4). The public key and the counter only; rows
// are never deleted, a passkey is revoked once (trigger SDA20).
import type { TenantInsert, WebauthnCredential } from '../schema.js';
import { TenantRepository } from './base.js';

export class WebauthnCredentialRepository extends TenantRepository {
  create(input: TenantInsert<'webauthn_credentials'>): Promise<WebauthnCredential> {
    return this.run(
      this.db
        .insertInto('webauthn_credentials')
        .values({ ...input, tenant_id: this.tenantId })
        .returningAll()
        .executeTakeFirstOrThrow(),
    );
  }

  /** Locks the person's row until the transaction ends (orders one person's registrations). */
  async lockUser(userId: string): Promise<void> {
    await this.run(
      this.db
        .selectFrom('users')
        .select('id')
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', userId)
        .forUpdate()
        .execute(),
    );
  }

  getById(id: string): Promise<WebauthnCredential | undefined> {
    return this.run(
      this.db
        .selectFrom('webauthn_credentials')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', id)
        .executeTakeFirst(),
    );
  }

  /** A person's passkeys, oldest first; with `activeOnly`, the ones not revoked. */
  listForUser(userId: string, activeOnly = false): Promise<WebauthnCredential[]> {
    let query = this.db
      .selectFrom('webauthn_credentials')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('user_id', '=', userId);
    if (activeOnly) query = query.where('revoked_at', 'is', null);
    return this.run(query.orderBy('created_at').orderBy('id').execute());
  }

  /** The person's active passkey with this WebAuthn credential ID, or undefined. */
  findActive(userId: string, credentialId: string): Promise<WebauthnCredential | undefined> {
    return this.run(
      this.db
        .selectFrom('webauthn_credentials')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('user_id', '=', userId)
        .where('credential_id', '=', credentialId)
        .where('revoked_at', 'is', null)
        .executeTakeFirst(),
    );
  }

  /**
   * Revokes every active passkey of this tenant. `revoked_by` is the passkey's own user (the
   * foreign key requires a user of this tenant; the system actor has none).
   */
  async revokeAllActive(at: Date): Promise<number> {
    const active = await this.run(
      this.db
        .selectFrom('webauthn_credentials')
        .select(['id', 'user_id'])
        .where('tenant_id', '=', this.tenantId)
        .where('revoked_at', 'is', null)
        .execute(),
    );
    let n = 0;
    for (const row of active) {
      const done = await this.revoke(row.id, row.user_id, row.user_id, at);
      if (done) n += 1;
    }
    return n;
  }

  /** Revokes one passkey of a user. Returns it when this call revoked it. */
  revoke(
    id: string,
    userId: string,
    by: string,
    at: Date,
  ): Promise<WebauthnCredential | undefined> {
    return this.run(
      this.db
        .updateTable('webauthn_credentials')
        .set({ revoked_at: at, revoked_by: by })
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', id)
        .where('user_id', '=', userId)
        .where('revoked_at', 'is', null)
        .returningAll()
        .executeTakeFirst(),
    );
  }

  /**
   * Records one use: the new counter and the time. Accepted only for an active passkey whose
   * counter goes up, or stays 0 for an authenticator that never counts (synced passkeys); a
   * counter that does not go up is a sign of a cloned authenticator (WebAuthn §6.1.1).
   */
  async recordUse(id: string, userId: string, signCount: number, at: Date): Promise<boolean> {
    const result = await this.run(
      this.db
        .updateTable('webauthn_credentials')
        .set({ sign_count: signCount, last_used_at: at })
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', id)
        .where('user_id', '=', userId)
        .where('revoked_at', 'is', null)
        .where('sign_count', signCount === 0 ? '=' : '<', String(signCount))
        .where((eb) => eb.or([eb('last_used_at', 'is', null), eb('last_used_at', '<=', at)]))
        .executeTakeFirst(),
    );
    return Number(result.numUpdatedRows) === 1;
  }
}
