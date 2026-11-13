// The runner reads a run's memory notes from its own clone (task X13 PR 2, design/ADR-M74 §2.6):
// `.sdlc/memory/` at the run's `base_sha`, never from the sandbox and never from the Git host. The
// set hash is computed the same way as the worker's (`memorySetOf`, `memorySetSha256`), from
// `git ls-tree`: a regular file named `<name>.md` directly in the folder; anything else is not
// memory. Hardened git only (`gitArgs`, `gitEnv`), no token, no network, as for the plan file
// (`plan-file.ts`). The bytes are client text: returned to the caller only, never logged.
import {
  FOLDER_ENTRY_KINDS,
  MEMORY_DIR,
  memorySetOf,
  type FolderEntry,
  type FolderEntryKind,
} from '@sdlc/contracts';
import { memorySetSha256 } from '@sdlc/core';

import { GitFailed, gitIn } from './plan-file.js';

/** The largest memory file the runner reads, in bytes (8,000 characters of 4-byte UTF-8). */
export const MEMORY_FILE_MAX_BYTES = 32 * 1024;

export interface MemoryFile {
  /** The file's name in `.sdlc/memory/` (`<name>.md`). */
  readonly name: string;
  readonly bytes: Buffer;
}

export type MemoryFilesRead =
  | {
      readonly kind: 'ok';
      /** The hash of the whole set (every memory file, read or not). */
      readonly setSha256: string;
      /** Number of memory files in the set. */
      readonly setFiles: number;
      /** The first `maxFiles` memory files by name, with their bytes. */
      readonly files: readonly MemoryFile[];
    }
  // git could not answer, the commit is not in the clone, or a file is too large or not a blob.
  | { readonly kind: 'unreadable' };

/** Reads the memory notes at a commit; the runner builds it from the run's kept clone. */
export type MemoryFilesReader = (commitSha: string, maxFiles: number) => Promise<MemoryFilesRead>;

const SHA = /^[0-9a-f]{40}$/;
const OID = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;
const MODES: Readonly<Record<string, FolderEntryKind>> = {
  '100644': 'file',
  '100755': 'executable',
  '120000': 'symlink',
  '160000': 'submodule',
  '040000': 'folder',
};

/** The entries of `git ls-tree -z <sha> -- .sdlc/memory/` as folder entries. */
function entriesOf(listing: Buffer): FolderEntry[] {
  const prefix = `${MEMORY_DIR}/`;
  const entries: FolderEntry[] = [];
  for (const line of listing.toString('utf8').split('\0')) {
    if (line === '') continue;
    const [meta, path] = line.split('\t');
    const [mode, , oid] = (meta ?? '').split(' ');
    const kind = MODES[mode ?? ''];
    if (!path?.startsWith(prefix) || !kind || !FOLDER_ENTRY_KINDS.includes(kind)) continue;
    const name = path.slice(prefix.length);
    if (name === '' || name.includes('/') || !oid || !OID.test(oid)) continue;
    entries.push({ name, kind, sha: oid });
  }
  return entries;
}

async function read(
  cloneDir: string,
  commitSha: string,
  maxFiles: number,
  timeoutMs: number,
): Promise<MemoryFilesRead> {
  if (!SHA.test(commitSha)) return { kind: 'unreadable' };
  const small = 1024 * 1024;
  await gitIn(cloneDir, ['cat-file', '-e', `${commitSha}^{commit}`], timeoutMs, small);
  const listing = await gitIn(
    cloneDir,
    ['ls-tree', '-z', commitSha, '--', `${MEMORY_DIR}/`],
    timeoutMs,
    small,
  );
  const set = memorySetOf(entriesOf(listing));
  const files: MemoryFile[] = [];
  for (const entry of set.slice(0, maxFiles)) {
    const size = Number(
      (await gitIn(cloneDir, ['cat-file', '-s', entry.blob], timeoutMs, small)).toString(),
    );
    if (!Number.isSafeInteger(size) || size > MEMORY_FILE_MAX_BYTES) return { kind: 'unreadable' };
    const bytes = await gitIn(
      cloneDir,
      ['cat-file', 'blob', entry.blob],
      timeoutMs,
      MEMORY_FILE_MAX_BYTES + 1,
    );
    if (bytes.length !== size) return { kind: 'unreadable' };
    files.push({ name: entry.path.slice(MEMORY_DIR.length + 1), bytes });
  }
  return { kind: 'ok', setSha256: memorySetSha256(set), setFiles: set.length, files };
}

/** The memory notes at `commitSha` in the runner's clone; every git failure is `unreadable`. */
export async function readMemoryFiles(
  cloneDir: string,
  commitSha: string,
  maxFiles: number,
  timeoutMs: number,
): Promise<MemoryFilesRead> {
  try {
    return await read(cloneDir, commitSha, maxFiles, timeoutMs);
  } catch (error) {
    if (error instanceof GitFailed) return { kind: 'unreadable' };
    throw error;
  }
}

/** The reader of one run's kept clone. */
export function memoryFilesReader(cloneDir: string, timeoutMs: number): MemoryFilesReader {
  return (commitSha, maxFiles) => readMemoryFiles(cloneDir, commitSha, maxFiles, timeoutMs);
}
