// Agent memory across runs (task X13, design/ADR-M74 §2.1, §2.2, QUESTIONS #715).
//
// Memory is Markdown in the project's repository, in one fixed folder. A memory file is a regular
// file directly in that folder named `<name>.md`; anything else there (a sub-folder, a symbolic
// link, a submodule, another name) is not memory: it is never read and never part of the set.
// The folder is fixed here, not in the configuration, so every check uses the same path.
//
// The memory text is client data: it never goes into Temporal, logs, run events, audit events or
// a table (R030, R031). The platform keeps only hashes, counts and versions.
import { isAgentInstructionPath } from './agent-instructions.js';

/** The memory folder at the repository root. Not an agent instruction path (ADR-M74 §2.1). */
export const MEMORY_DIR = '.sdlc/memory';

/** The name of a memory file, without `.md`. */
export const MEMORY_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * The memory branch of one run (X13 PR 3a, ADR-M74 §2.5 step 4): `agent/INT-…-memory-<attempt>`.
 * The only branches the platform deletes (`GitHostAdapter.deleteBranch`, PR 3b).
 */
export const MEMORY_BRANCH = /^agent\/INT-[0-9]{4}-[0-9]{4,9}-memory-[1-9][0-9]{0,3}$/;

/** `memory.mode` of the project configuration (ADR-M74 §2.2). */
export const MEMORY_MODES = ['off', 'read', 'read_propose'] as const;
export type MemoryMode = (typeof MEMORY_MODES)[number];

/** Reasons of a revocation (D-05 §6.11). */
export const MEMORY_REVOCATION_REASONS = ['poisoned', 'wrong', 'other'] as const;
export type MemoryRevocationReason = (typeof MEMORY_REVOCATION_REASONS)[number];

/** How a memory version was approved (D-05 §6.11). */
export const MEMORY_SOURCES = ['memory_pr', 'cli'] as const;
export type MemorySource = (typeof MEMORY_SOURCES)[number];

/** Kinds of entry in a folder of a commit's tree (`GitHostAdapter.listFolder`). */
export const FOLDER_ENTRY_KINDS = ['file', 'executable', 'symlink', 'submodule', 'folder'] as const;
export type FolderEntryKind = (typeof FOLDER_ENTRY_KINDS)[number];

/** One entry directly in a folder: its name, kind and Git object ID (40 hex characters). */
export interface FolderEntry {
  readonly name: string;
  readonly kind: FolderEntryKind;
  readonly sha: string;
}

/** One file of a memory set: its repository path and Git blob ID. */
export interface MemorySetEntry {
  readonly path: string;
  readonly blob: string;
}

/**
 * True when a folder entry is a memory file: a regular file named `<name>.md` that is not an agent
 * instruction file (`agents.md`).
 */
export function isMemoryFile(entry: Pick<FolderEntry, 'name' | 'kind'>): boolean {
  if (entry.kind !== 'file' && entry.kind !== 'executable') return false;
  if (!entry.name.endsWith('.md')) return false;
  if (!MEMORY_NAME.test(entry.name.slice(0, -'.md'.length))) return false;
  // `agents.md` is an agent instruction file in any folder (G4 refuses it unpinned): never memory.
  return !isAgentInstructionPath(`${MEMORY_DIR}/${entry.name}`);
}

/** The memory set of a folder listing: its memory files, sorted by path. */
export function memorySetOf(entries: readonly FolderEntry[]): MemorySetEntry[] {
  return entries
    .filter(isMemoryFile)
    .map((entry) => ({ path: `${MEMORY_DIR}/${entry.name}`, blob: entry.sha }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * The canonical JSON (RFC 8785) of a memory set: an array of `{"blob":…,"path":…}` in path order.
 * Paths and blob IDs are ASCII without characters JSON escapes, so sorted keys and
 * `JSON.stringify` give the canonical form. Its SHA-256 is the set's `set_sha256`.
 */
export function memorySetCanonicalJson(set: readonly MemorySetEntry[]): string {
  return JSON.stringify(set.map((entry) => ({ blob: entry.blob, path: entry.path })));
}
