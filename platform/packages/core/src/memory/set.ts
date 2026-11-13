// The memory set of a commit and its hash (task X13, ADR-M74 §2.1, QUESTIONS #715). The platform
// reads the folder listing from the Git host (no file content); the runner computes the same
// hash from its clone (X13 PR 2). Paths and blob IDs stay in memory: only the hash and the count
// are kept.
import { createHash } from 'node:crypto';

import {
  MEMORY_DIR,
  memorySetCanonicalJson,
  memorySetOf,
  type GitHostAdapter,
  type MemorySetEntry,
  type RepoRef,
} from '@sdlc/contracts';

/** SHA-256 of the canonical JSON of a memory set (an empty set has a hash too). */
export function memorySetSha256(set: readonly MemorySetEntry[]): string {
  return createHash('sha256').update(memorySetCanonicalJson(set), 'utf8').digest('hex');
}

/** A memory set as the platform keeps it: its hash and its number of files. */
export interface MemorySetFacts {
  readonly setSha256: string;
  readonly files: number;
}

/** The memory set of a commit, read from the Git host. Throws `GitHostError`. */
export async function readMemorySet(
  gitHost: Pick<GitHostAdapter, 'listFolder'>,
  ref: RepoRef,
  commitSha: string,
): Promise<MemorySetFacts> {
  const set = memorySetOf(await gitHost.listFolder(ref, commitSha, MEMORY_DIR));
  return { setSha256: memorySetSha256(set), files: set.length };
}
