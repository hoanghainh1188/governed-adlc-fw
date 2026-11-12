// Errors of the data access layer. They carry a stable `code`; the API and CLI turn codes into
// user-facing text through the message catalog (NFR-08). `message` is for logs and developers only.

export type DbErrorCode =
  | 'invalid_tenant_id'
  | 'invalid_value'
  | 'conflict'
  | 'reference_not_found'
  | 'version_conflict'
  | 'permission_denied'
  | 'immutable';

export class DbError extends Error {
  override readonly name = 'DbError';

  constructor(
    readonly code: DbErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export type TenantGuardErrorCode =
  | 'raw_sql'
  | 'unsupported_statement'
  | 'unknown_table'
  | 'missing_tenant_filter'
  | 'tenant_column_write'
  | 'insert_without_tenant'
  | 'cte_shadows_table';

/** A query that could read or write another tenant's data. Always a programming error. */
export class TenantGuardError extends Error {
  override readonly name = 'TenantGuardError';

  constructor(
    readonly code: TenantGuardErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const PG_ERROR_CODES: Record<string, DbErrorCode> = {
  '23505': 'conflict', // unique_violation
  '23503': 'reference_not_found', // foreign_key_violation (includes cross-tenant references, D-05 D2)
  '23514': 'invalid_value', // check_violation
  '23502': 'invalid_value', // not_null_violation
  '22P02': 'invalid_value', // invalid_text_representation (bad UUID, bad enum value)
  '42501': 'permission_denied', // insufficient_privilege
  // Our own codes, raised by triggers (migrations 0002 to 0020).
  SDA01: 'immutable', // append-only table: UPDATE, DELETE or TRUNCATE
  SDA02: 'conflict', // audit chain link broken: the row does not follow the tenant's last row
  SDA03: 'immutable', // role binding already revoked
  SDA04: 'invalid_value', // a void gate decision must point to an approval
  SDA05: 'immutable', // a run in a final status can never change (migration 0004)
  SDA06: 'immutable', // a delivered or abandoned reply of a Git event receipt (migration 0006)
  SDA07: 'immutable', // an escalation status move not allowed, or a closed escalation (0007)
  SDA08: 'immutable', // a posted or abandoned escalation notice (migration 0007)
  SDA09: 'immutable', // an agent status move not allowed, a retired agent, or a config change (0008)
  SDA10: 'immutable', // a posted or abandoned intent status notice (migration 0009)
  SDA11: 'immutable', // a revoked tenant role or an unlinked identity (migration 0014)
  SDA12: 'immutable', // an intent budget that would go down (migration 0015)
  SDA13: 'immutable', // a stopping run that would not end stopped_killed, or killed_by changed (0020)
  SDA14: 'immutable', // an evidence pack's fixed columns, or sealed_at / purged_at changed (0021)
  SDA15: 'immutable', // an evidence item's fixed columns, purged_at changed, a lock moved back (0023)
  SDA16: 'immutable', // an evidence hold's fixed columns, or a release changed (0023)
  SDA17: 'immutable', // a Langfuse purge's fixed columns, or a confirmed purge changed (0024)
  SDA18: 'immutable', // a web session's fixed columns, or an ended session changed (0027)
  SDA21: 'immutable', // an evaluation's fixed columns, a final status, or a budget going down (0029)
  SDA22: 'immutable', // an evaluation run's fixed columns, a final status, or a move not allowed (0029)
  SDA23: 'immutable', // an evaluation plan's fixed columns, an archived plan, or a version going down (0031)
  SDA24: 'immutable', // an evaluation task's identity, or a task that is gone (0033)
  SDA25: 'immutable', // a tool status move not allowed, a retired tool, or a config change (0038)
  SDA26: 'immutable', // a knowledge index's fixed columns, or a purge set twice (0039)
  SDA27: 'immutable', // a session or challenge removed before its floor (0046)
  SDA28: 'conflict', // a project folder that overlaps another project of the same repository (0049)
};

/** Maps a PostgreSQL error to a DbError; anything else is rethrown unchanged. */
export function translatePgError(error: unknown): never {
  const code = (error as { code?: unknown } | null)?.code;
  const mapped = typeof code === 'string' ? PG_ERROR_CODES[code] : undefined;
  if (mapped) {
    const constraint = (error as { constraint?: unknown }).constraint;
    const detail = typeof constraint === 'string' ? ` (${constraint})` : '';
    throw new DbError(mapped, `database rejected the statement: ${mapped}${detail}`, {
      cause: error,
    });
  }
  throw error;
}
