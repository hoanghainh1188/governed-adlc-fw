// Verifying a Run Contract (runner side, design/D-03 section 8, D-08 C02 AC2, ADR-M22 section
// 2.4). The runner refuses a contract that is malformed, badly signed, not in the database,
// different from the stored one, not yet valid, expired, revoked, or for a run that already left
// `queued`. The signature is checked first, so a forged tenant ID never reaches the database.
//
// Key rotation: the signature names its key version (`vault:v<N>:`) and is checked with that
// version's public key, so contracts signed before a rotation still verify until they expire.
import {
  parseRunContractEnvelope,
  type RunContract,
  type ToolGrant,
  type RunContractRejectReason,
  type RunContractVerifier,
} from '@sdlc/contracts';
import type { MessageKey } from '@sdlc/messages';

import type { PlatformDatabase } from '../db/platform-database.js';
import type { Run } from '../db/schema.js';
import { parseTenantId } from '../db/tenant-id.js';
import type { TenantScope } from '../db/tenant-scope.js';
import { loadEffectiveConfig } from '../registry/effective-config.js';
import { runContractBytes, runContractSha256 } from './canonical.js';

export interface VerifyDeps {
  readonly verifier: RunContractVerifier;
  /**
   * X04 (ADR-M69 §2.6): true when this runner can enforce every tool grant of the contract (the
   * run's gateway and its configuration). Default: no runner can, so a contract with a grant is
   * refused (`tool_not_enforceable`) until the runner wires the gateway (X04 PR 2).
   */
  readonly toolGrantsEnforceable?: (grants: readonly ToolGrant[]) => boolean;
  /** Default: `new Date()`. */
  readonly now?: () => Date;
}

export type RunContractVerification =
  | { readonly ok: true; readonly contract: RunContract; readonly run: Run }
  | {
      readonly ok: false;
      readonly reason: RunContractRejectReason;
      /** Set when the contract names a run of this platform; the rejection is then recorded. */
      readonly runId?: string;
    };

/**
 * Checks a contract envelope received from the worker. Never throws for a bad contract: it returns
 * a reject reason. It throws only when the check itself cannot run (database or OpenBao down).
 * For a known run, the result is recorded as a run event (`contract_accepted` or
 * `contract_rejected`) and, for a rejection, as the audit event `run.contract_rejected`.
 */
export async function verifyRunContract(
  db: PlatformDatabase,
  envelope: unknown,
  deps: VerifyDeps,
): Promise<RunContractVerification> {
  const parsed = parseRunContractEnvelope(envelope);
  if (!parsed) return { ok: false, reason: 'malformed' };
  const { contract, signature, keyVersion } = parsed;

  if (!(await deps.verifier.verify(runContractBytes(contract), signature))) {
    return { ok: false, reason: 'bad_signature' };
  }

  const scope = db.forTenant(parseTenantId(contract.tenant_id));
  const stored = await scope.runContracts.getByRunId(contract.run_id);
  if (!stored) return { ok: false, reason: 'unknown_contract' };

  const reject = (reason: RunContractRejectReason) => recordRejection(scope, contract, reason);
  if (
    stored.contract_sha256 !== runContractSha256(contract) ||
    stored.signature !== signature ||
    stored.key_version !== keyVersion
  ) {
    return reject('mismatch');
  }

  const { config } = await loadEffectiveConfig(scope.projectConfigs, contract.project_id);
  const now = (deps.now ? deps.now() : new Date()).getTime();
  const skewMs = config.run.contract_clock_skew_seconds * 1000;
  if (now < Date.parse(contract.issued_at) - skewMs) return reject('not_yet_valid');
  // Expiry has no tolerance (ADR-M22 section 2.4).
  if (now >= Date.parse(contract.expires_at)) return reject('expired');
  if (stored.revoked_at !== null) return reject('revoked');

  const run = await scope.runs.getById(contract.run_id);
  if (run?.status !== 'queued') return reject('run_not_startable');

  // The runner never opens more than the contract asks for, and never less (ADR-M69 §2.6).
  const grants = contract.tool_grants ?? [];
  if (grants.length > 0 && !(deps.toolGrantsEnforceable?.(grants) ?? false)) {
    return reject('tool_not_enforceable');
  }

  // O06 (ADR-M106 §2.4): only the OpenHands adapter works in the project's folder; any other
  // adapter would run in the whole repository and read other packages' instructions.
  if ((contract.repo_path ?? '') !== '' && contract.agent_adapter !== 'openhands') {
    return reject('folder_not_enforceable');
  }

  await scope.runEvents.append(run.id, 'contract_accepted', {
    contract_sha256: stored.contract_sha256,
    key_version: stored.key_version,
  });
  return { ok: true, contract, run };
}

async function recordRejection(
  scope: TenantScope,
  contract: RunContract,
  reason: RunContractRejectReason,
): Promise<RunContractVerification> {
  await scope.transaction(async (trx) => {
    await trx.runEvents.append(contract.run_id, 'contract_rejected', { reason });
    await trx.audit.append({
      action: 'run.contract_rejected',
      actorType: 'system',
      actorId: null,
      entityId: contract.run_id,
      payload: { reason },
    });
  });
  return { ok: false, reason, runId: contract.run_id };
}

/** Catalog key of each reject reason, for the runner's messages (NFR-08). */
export const RUN_CONTRACT_REJECT_MESSAGES = {
  malformed: 'run_contract.reject.malformed',
  bad_signature: 'run_contract.reject.bad_signature',
  unknown_contract: 'run_contract.reject.unknown_contract',
  mismatch: 'run_contract.reject.mismatch',
  not_yet_valid: 'run_contract.reject.not_yet_valid',
  expired: 'run_contract.reject.expired',
  revoked: 'run_contract.reject.revoked',
  run_not_startable: 'run_contract.reject.run_not_startable',
  tool_not_enforceable: 'run_contract.reject.tool_not_enforceable',
  folder_not_enforceable: 'run_contract.reject.folder_not_enforceable',
} as const satisfies Record<RunContractRejectReason, MessageKey>;
