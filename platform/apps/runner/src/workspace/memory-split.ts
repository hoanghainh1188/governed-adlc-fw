// The memory part of a run's change (task X13 PR 3a, design/ADR-M74 §2.5 step 2, 0.4).
//
// With the project's `memory.mode` at `read_propose`, an agent run at L2 or higher may add, change
// or remove notes in `.sdlc/memory/`. After the run, the runner has staged the whole change in its
// own clone (`computeProposal`). `splitMemory` then takes the **memory part** out of the index:
// the changed paths `.sdlc/memory/<name>.md` (a memory file, `isMemoryFile`) whose new state is a
// regular file of valid UTF-8 within `max_file_chars`, or a removed memory file, as long as the
// set they make stays within `max_files`. Each such path is reset in the index to `base_sha`, so
// what follows (the diff G5 checks, the review size, the dependency scan) sees the code part only.
//
// Anything else under `.sdlc/memory/` (a sub-folder, a symbolic link, another name, a file over a
// cap, new files past `max_files`, a path whose base state is not a memory file) stays in the code
// change, where G5 fails it `out_of_scope` as before (fail closed). Plan patterns never match
// `.sdlc/` (ADR-M40 §2.2).
//
// Hardened git in the runner's clone only (`gitIn`). Paths and text are client data: they stay in
// memory; the caller records counts and hashes.
import {
  isMemoryFile,
  MEMORY_DIR,
  memorySetOf,
  type FolderEntry,
  type FolderEntryKind,
  type ProjectConfig,
} from '@sdlc/contracts';
import { memorySetSha256 } from '@sdlc/core';

import { diffIndex, gitIn, type ProposalGitOptions } from './proposal.js';

export interface MemorySplit {
  /** The memory paths taken out of the change, sorted. Client data: never in a run event. */
  readonly paths: readonly string[];
  /** `git diff --binary` of the memory part against `base_sha`. */
  readonly patch: Buffer;
  readonly added: number;
  readonly changed: number;
  readonly removed: number;
  /** The paths under `.sdlc/memory/` left in the code change. */
  readonly kept: number;
  /** `set_sha256` of the memory set after the proposal (`memorySetSha256`, ADR-M74 §2.1). */
  readonly setSha256: string;
}

const PREFIX = `${MEMORY_DIR}/`;
const OID = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;
const MODES: Readonly<Record<string, FolderEntryKind>> = {
  '100644': 'file',
  '100755': 'executable',
  '120000': 'symlink',
  '160000': 'submodule',
  '040000': 'folder',
};

/** Parses `<mode> <type|oid> …\t<path>` lines (`ls-tree -z`, `ls-files -s -z`) of the folder. */
function entriesOf(listing: Buffer, oidField: 1 | 2): Map<string, FolderEntry> {
  const entries = new Map<string, FolderEntry>();
  for (const line of listing.toString('utf8').split('\0')) {
    if (line === '') continue;
    const tab = line.indexOf('\t');
    const meta = line.slice(0, tab).split(' ');
    const path = line.slice(tab + 1);
    const kind = MODES[meta[0] ?? ''];
    const oid = meta[oidField];
    if (tab < 0 || !path.startsWith(PREFIX) || !kind || !oid || !OID.test(oid)) continue;
    const name = path.slice(PREFIX.length);
    if (name === '' || name.includes('/')) continue;
    entries.set(name, { name, kind, sha: oid });
  }
  return entries;
}

/** True when the blob is valid UTF-8 within `maxChars` characters. */
async function fitsText(
  repoDir: string,
  home: string,
  oid: string,
  maxChars: number,
  options: ProposalGitOptions,
): Promise<boolean> {
  // A UTF-8 character is at most 4 bytes: a larger blob cannot fit.
  const size = Number((await gitIn(repoDir, home, ['cat-file', '-s', oid], options)).toString());
  if (!Number.isSafeInteger(size) || size > maxChars * 4) return false;
  const bytes = await gitIn(repoDir, home, ['cat-file', 'blob', oid], options);
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return text.length <= maxChars;
  } catch {
    return false;
  }
}

/**
 * Takes the memory part out of the clone's staged change (see the header). Returns null when no
 * changed path qualifies; the index is then untouched.
 */
export async function splitMemory(
  repoDir: string,
  home: string,
  baseSha: string,
  changedFiles: readonly string[],
  limits: Pick<ProjectConfig['memory'], 'max_files' | 'max_file_chars'>,
  options: ProposalGitOptions,
): Promise<MemorySplit | null> {
  const inFolder = changedFiles.filter((p) => p.startsWith(PREFIX));
  if (inFolder.length === 0) return null;
  const base = entriesOf(
    await gitIn(repoDir, home, ['ls-tree', '-z', baseSha, '--', PREFIX], options),
    2,
  );
  const staged = entriesOf(
    await gitIn(repoDir, home, ['ls-files', '-s', '-z', '--', PREFIX], options),
    1,
  );
  const added: string[] = [];
  const changed: string[] = [];
  const removed: string[] = [];
  for (const path of inFolder) {
    const name = path.slice(PREFIX.length);
    const before = base.get(name);
    const after = staged.get(name);
    // The base state must be no file or a memory file; anything else stays in the change.
    if (before !== undefined && !isMemoryFile(before)) continue;
    if (after === undefined) {
      if (before !== undefined) removed.push(path);
      continue;
    }
    if (!isMemoryFile(after)) continue;
    if (!(await fitsText(repoDir, home, after.sha, limits.max_file_chars, options))) continue;
    (before === undefined ? added : changed).push(path);
  }
  // The set after the proposal: the base set with the memory part applied.
  const next = new Map([...base].filter(([, entry]) => isMemoryFile(entry)));
  for (const path of removed) next.delete(path.slice(PREFIX.length));
  for (const path of changed) {
    const name = path.slice(PREFIX.length);
    next.set(name, staged.get(name)!);
  }
  // New files past `max_files` all stay in the change: G5 fails it (fail closed).
  const withAdded = next.size + added.length <= limits.max_files ? added : [];
  for (const path of withAdded) {
    const name = path.slice(PREFIX.length);
    next.set(name, staged.get(name)!);
  }
  const paths = [...withAdded, ...changed, ...removed].sort();
  if (paths.length === 0) return null;
  const memory = await diffIndex(repoDir, home, baseSha, options, paths);
  await gitIn(repoDir, home, ['reset', '-q', baseSha, '--', ...paths], options);
  return {
    paths,
    patch: memory.patch,
    added: withAdded.length,
    changed: changed.length,
    removed: removed.length,
    kept: inFolder.length - paths.length,
    setSha256: memorySetSha256(memorySetOf([...next.values()])),
  };
}
