// The memory a run may read, as G4 finds it at the run's base commit (task X13 PR 2, ADR-M74
// §2.6, QUESTIONS #712). The worker lists `.sdlc/memory/` at `base_sha` on the Git host, hashes
// the set and looks the hash up among the approved versions **of the same tenant and project**.
// The Run Contract (schema 5) carries the result: the version and the hash when the set is an
// approved version nobody revoked, otherwise why not. G4 never fails for memory: a run without
// memory is a run as before X13. Only the hash, the version and a reason code travel on.
import {
  GitHostError,
  type GitHostAdapter,
  type MemoryMode,
  type RepoRef,
  type RunContractMemory,
} from '@sdlc/contracts';

import type { TenantScope } from '../db/tenant-scope.js';
import { readMemorySet } from './set.js';

export interface RunMemoryInput {
  readonly projectId: string;
  readonly ref: RepoRef;
  readonly baseSha: string;
  /** The project's `memory.mode` when the run is prepared. */
  readonly mode: MemoryMode;
}

/**
 * The contract's `memory`, or undefined when the project's memory is `off` (the contract stays
 * schema 3 or 4). A tree the Git host lists only in part gives `tree_truncated`; any other Git
 * host error is thrown, like the other G4 reads (the step waits and tries again).
 */
export async function memoryForRun(
  scope: TenantScope,
  gitHost: Pick<GitHostAdapter, 'listFolder'>,
  input: RunMemoryInput,
): Promise<RunContractMemory | undefined> {
  if (input.mode === 'off') return undefined;
  let set;
  try {
    set = await readMemorySet(gitHost, input.ref, input.baseSha);
  } catch (error) {
    if (error instanceof GitHostError && error.code === 'tree_truncated') {
      return { reason: 'tree_truncated', version: null, set_sha256: null };
    }
    throw error;
  }
  if (set.files === 0) return { reason: 'none', version: null, set_sha256: null };
  // A set hash that equals another project's approved version does not count (ADR-M74 §2.6).
  const found = await scope.memoryVersions.findBySet(input.projectId, set.setSha256);
  if (!found) return { reason: 'unapproved', version: null, set_sha256: null };
  if (found.revoked_at !== null) return { reason: 'revoked', version: null, set_sha256: null };
  return { reason: 'approved', version: found.version, set_sha256: found.set_sha256 };
}
