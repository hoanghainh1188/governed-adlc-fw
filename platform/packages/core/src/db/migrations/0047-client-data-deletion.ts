// Migration 0047: tenant states for client data deletion (task H03a; design/ADR-M97 §2;
// QUESTIONS #611–#615). Rules for every migration: see the header of 0001-tenancy.ts and
// design/ADR-M09. Migrations 0001–0046 are merged and never edited.
//
// - Extends `tenants.status` with `pending_deletion` (grace period after dual approval) and
//   `purged` (tier-1 content gone; append-only rows kept). No `purging` interim (H03a AC1).
// - An unlinked identity stays final except for `external_login`, which client deletion may
//   scrub in place (ADR-M97 §2.1); every other column stays frozen (SDA11).
import { defineMigration } from './define.js';

export const migration0047ClientDataDeletion = defineMigration({
  up: [
    `ALTER TABLE tenants DROP CONSTRAINT tenants_status_check`,
    `ALTER TABLE tenants ADD CONSTRAINT tenants_status_check
       CHECK (status IN ('active', 'suspended', 'pending_deletion', 'purged'))`,

    `CREATE OR REPLACE FUNCTION withdrawal_is_final() RETURNS trigger
       LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
     BEGIN
       IF TG_TABLE_NAME = 'tenant_role_bindings' THEN
         IF OLD.revoked_at IS NOT NULL THEN
           RAISE EXCEPTION 'tenant role % is revoked and cannot change', OLD.id
             USING ERRCODE = 'SDA11';
         END IF;
       ELSIF TG_TABLE_NAME = 'user_identities' THEN
         IF OLD.unlinked_at IS NOT NULL THEN
           IF NEW.unlinked_at IS DISTINCT FROM OLD.unlinked_at
              OR NEW.user_id IS DISTINCT FROM OLD.user_id
              OR NEW.provider IS DISTINCT FROM OLD.provider
              OR NEW.external_id IS DISTINCT FROM OLD.external_id
              OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
              OR NEW.id IS DISTINCT FROM OLD.id
              OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
             RAISE EXCEPTION 'identity % is unlinked and cannot change', OLD.id
               USING ERRCODE = 'SDA11';
           END IF;
         END IF;
       END IF;
       RETURN NEW;
     END $$`,
  ],
  down: [
    `CREATE OR REPLACE FUNCTION withdrawal_is_final() RETURNS trigger
       LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
     BEGIN
       IF TG_TABLE_NAME = 'tenant_role_bindings' THEN
         IF OLD.revoked_at IS NOT NULL THEN
           RAISE EXCEPTION 'tenant role % is revoked and cannot change', OLD.id
             USING ERRCODE = 'SDA11';
         END IF;
       ELSIF TG_TABLE_NAME = 'user_identities' THEN
         IF OLD.unlinked_at IS NOT NULL THEN
           RAISE EXCEPTION 'identity % is unlinked and cannot change', OLD.id
             USING ERRCODE = 'SDA11';
         END IF;
       END IF;
       RETURN NEW;
     END $$`,
    `ALTER TABLE tenants DROP CONSTRAINT tenants_status_check`,
    `ALTER TABLE tenants ADD CONSTRAINT tenants_status_check
       CHECK (status IN ('active', 'suspended'))`,
  ],
});
