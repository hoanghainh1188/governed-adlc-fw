// The credentials of a run's register tools (task X04 PR 3b, design/ADR-M69 §2.4, §2.8, ADR-M89,
// QUESTIONS #535, #537, #540, #541). For each grant with `read_documents`, in the run preparation:
//
//   a database login in `knowledge-db` (OpenBao's database engine, role `kdocs-<run_id>`, member
//   of the project's read role only) + the tool's own model key (alias `tool-<run_id>-<tool_key>`)
//   → one single-use wrapping token per tool (`{ db_username, db_password, llm_key }`)
//
// Only the wrapping tokens and the index IDs travel to the runner (R031). At the end of the run, at
// a kill and for an abandoned run, everything is found again from the run ID and the stored
// contract: the logins by the run's role, the keys by their aliases. Revoking twice is harmless;
// the run events `tool_credential_revoked` / `tool_credential_revoke_failed` are written once per
// tool.
//
// X06 (ADR-M108 §2.8, QUESTIONS #700): a `read_code` grant gets a login of the role
// `kdocs-<run_id>-code` (member of the project's code read role only) and no model key: its
// wrapping token holds `{ db_username, db_password }`.
import {
  codeIndexReadRole,
  knowledgeReadRole,
  validateRunContract,
  type RedactedSecret,
  type RunDatabaseCredentials,
  type SecretWrapper,
  type ToolGrant,
} from '@sdlc/contracts';

import type { CostController } from '../cost/controller.js';
import { fromMicros, toMicros } from '../cost/money.js';
import type { TenantScope } from '../db/tenant-scope.js';

/** The permissions whose tools read one of the project's indexes (ADR-M89, ADR-M108). */
const READ_DOCUMENTS = 'read_documents';
const READ_CODE = 'read_code';

/** One tool's secrets for the runner: its wrapping token and the index version it reads. */
export interface PreparedToolSecrets {
  readonly wrapped: RedactedSecret;
  readonly indexId: string;
}

export interface IssueToolSecretsInput {
  readonly runId: string;
  readonly projectId: string;
  readonly grants: readonly ToolGrant[];
  /** The index version of each `read_documents` or `read_code` grant, by tool key. */
  readonly indexIds: ReadonlyMap<string, string>;
  /** The model of each `read_documents` grant's tool (`model_ref`), by tool key. */
  readonly models: ReadonlyMap<string, string>;
  /** The logins and keys live as long as the run may (its time cap plus the start window). */
  readonly ttlSeconds: number;
  /** The wrapping tokens live as long as the contract is valid. */
  readonly wrapTtlSeconds: number;
  /** The smaller of `tools.model_budget_usd` and the run key's cap (decimal USD). */
  readonly toolBudgetUsd: string;
}

export interface ToolCredentialDeps {
  /** Undefined when OpenBao's database engine is not set up: a `read_documents` run then fails. */
  readonly databaseCredentials: RunDatabaseCredentials | undefined;
  readonly wrapper: SecretWrapper;
  readonly costController: Pick<CostController, 'issueToolKey'>;
}

/** The grants whose tools need a credential: `read_documents` and `read_code`. */
export function credentialGrants(grants: readonly ToolGrant[]): ToolGrant[] {
  return grants.filter(
    (grant) => grant.permissions.includes(READ_DOCUMENTS) || grant.permissions.includes(READ_CODE),
  );
}

/** The smaller of two decimal USD amounts, as a decimal string. */
export function smallerUsd(a: string, b: string): string {
  const [x, y] = [toMicros(a), toMicros(b)];
  return fromMicros(x < y ? x : y);
}

/**
 * Issues and wraps the secrets of each grant with `read_documents`. Throws on any failure; the
 * caller then revokes what was issued (`revokeToolCredentials`) and fails the run.
 */
export async function issueToolSecrets(
  scope: TenantScope,
  deps: ToolCredentialDeps,
  input: IssueToolSecretsInput,
): Promise<ReadonlyMap<string, PreparedToolSecrets>> {
  const secrets = new Map<string, PreparedToolSecrets>();
  const grants = credentialGrants(input.grants);
  if (grants.length === 0) return secrets;
  if (!deps.databaseCredentials) throw new Error('tool credentials are not set up');
  for (const grant of grants) {
    const indexId = input.indexIds.get(grant.tool_key);
    if (indexId === undefined) throw new Error('tool index missing');
    if (grant.permissions.includes(READ_CODE)) {
      const login = await deps.databaseCredentials.issueRunLogin({
        runId: input.runId,
        grantRole: codeIndexReadRole(input.projectId),
        ttlSeconds: input.ttlSeconds,
        kind: 'code',
      });
      const wrapped = await deps.wrapper.wrap(
        { db_username: login.username, db_password: login.password },
        { ttlSeconds: input.wrapTtlSeconds },
      );
      secrets.set(grant.tool_key, { wrapped, indexId });
      continue;
    }
    const model = input.models.get(grant.tool_key);
    if (model === undefined) throw new Error('tool index missing');
    const login = await deps.databaseCredentials.issueRunLogin({
      runId: input.runId,
      grantRole: knowledgeReadRole(input.projectId),
      ttlSeconds: input.ttlSeconds,
    });
    const key = await deps.costController.issueToolKey({
      tenantId: scope.tenantId,
      runId: input.runId,
      gate: 'G4',
      toolKey: grant.tool_key,
      model,
      maxBudgetUsd: input.toolBudgetUsd,
    });
    const wrapped = await deps.wrapper.wrap(
      { db_username: login.username, db_password: login.password, llm_key: key.key },
      { ttlSeconds: input.wrapTtlSeconds },
    );
    secrets.set(grant.tool_key, { wrapped, indexId });
  }
  return secrets;
}

/** The register tool grants of a run's stored contract; none for an unknown run. */
export async function runToolGrants(scope: TenantScope, runId: string): Promise<ToolGrant[]> {
  const stored = await scope.runContracts.getByRunId(runId);
  if (!stored) return [];
  const checked = validateRunContract(stored.contract_json);
  return checked.ok ? [...(checked.contract.tool_grants ?? [])] : [];
}

/**
 * Revokes the database logins of a run's `read_documents` tools (the keys go with the run's key,
 * `endRunKey`). Never throws: a failure is recorded, and the logins' time to live still ends them.
 */
export async function revokeToolCredentials(
  scope: TenantScope,
  databaseCredentials: RunDatabaseCredentials | undefined,
  runId: string,
  grants: readonly ToolGrant[],
): Promise<void> {
  const tools = credentialGrants(grants);
  if (tools.length === 0) return;
  let reason: string | undefined;
  if (!databaseCredentials) {
    reason = 'credentials_unavailable';
  } else {
    try {
      await databaseCredentials.revokeRunLogins(runId);
    } catch {
      reason = 'revoke_failed';
    }
  }
  const events = await scope.runEvents.list(runId);
  const done = (type: string, toolKey: string) =>
    events.some(
      (event) =>
        event.event_type === type && (event.payload as { tool_key?: unknown }).tool_key === toolKey,
    );
  for (const tool of tools) {
    if (done('tool_credential_revoked', tool.tool_key)) continue;
    if (reason === undefined) {
      await scope.runEvents.append(runId, 'tool_credential_revoked', { tool_key: tool.tool_key });
    } else if (!done('tool_credential_revoke_failed', tool.tool_key)) {
      await scope.runEvents.append(runId, 'tool_credential_revoke_failed', {
        tool_key: tool.tool_key,
        reason,
      });
    }
  }
}

/**
 * Ends a run's key, its tools' keys and its tools' database logins (the end of a run, a kill, an
 * abandoned run). Used instead of `endRunKey` alone wherever a run ends.
 */
export async function endRunCredentials(
  scope: TenantScope,
  deps: {
    readonly costController: Pick<CostController, 'endRunKey'>;
    readonly databaseCredentials?: RunDatabaseCredentials | undefined;
  },
  runId: string,
  syncFrom: Date,
): Promise<void> {
  const grants = await runToolGrants(scope, runId);
  await deps.costController.endRunKey({
    runId,
    syncFrom,
    ...(grants.length > 0 ? { toolKeys: grants.map((g) => g.tool_key) } : {}),
  });
  await revokeToolCredentials(scope, deps.databaseCredentials, runId, grants);
}
