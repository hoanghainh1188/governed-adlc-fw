// Migration 0059: tenant lookups for authentication (task H09 PR 1, design/ADR-M110 §2.4).
// Rules for every migration: see the header of 0001-tenancy.ts and design/ADR-M09. Migrations
// 0001–0058 are merged and never edited.
//
// - An API token or a session cookie names no tenant. With row-level security (H09 PR 2), the
//   application role `platform_app` sees only the rows of the tenant set in its transaction, so it
//   cannot find a token's tenant by itself.
// - Two narrow SECURITY DEFINER functions, owned by `platform` (the pattern of migration 0046),
//   return the tenant ID of one SHA-256 hash, and nothing else. The full lookup then runs in that
//   tenant's transaction. A malformed hash returns NULL. Only `platform_app` may call them.
import { defineMigration } from './define.js';

export const migration0059AuthTenantLookups = defineMigration({
  up: [
    `CREATE FUNCTION auth_api_token_tenant(p_token_sha256 text)
       RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
       SELECT t.tenant_id FROM api_tokens t
        WHERE p_token_sha256 ~ '^[0-9a-f]{64}$' AND t.token_hash = p_token_sha256
     $$`,
    `CREATE FUNCTION auth_web_session_tenant(p_secret_sha256 text)
       RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
       SELECT s.tenant_id FROM web_sessions s
        WHERE p_secret_sha256 ~ '^[0-9a-f]{64}$' AND s.secret_sha256 = p_secret_sha256
     $$`,
    `REVOKE ALL ON FUNCTION auth_api_token_tenant(text) FROM PUBLIC`,
    `REVOKE ALL ON FUNCTION auth_web_session_tenant(text) FROM PUBLIC`,
    `GRANT EXECUTE ON FUNCTION auth_api_token_tenant(text) TO platform_app`,
    `GRANT EXECUTE ON FUNCTION auth_web_session_tenant(text) TO platform_app`,
  ],
  // Development only (ADR-M09).
  down: [
    `DROP FUNCTION auth_web_session_tenant(text)`,
    `DROP FUNCTION auth_api_token_tenant(text)`,
  ],
});
