// Paths that give the agent instructions (task C07, QUESTIONS #126, design/ADR-M34 §2.4).
//
// OpenHands 1.48.0 (`load_project_skills`, source at tag `v1.48.0`) reads, without case:
// - at the repository root: `AGENTS.md`, `agent.md`, `CLAUDE.md`, `GEMINI.md`, `.cursorrules`;
// - in any folder: `AGENTS.md` (a rule for that folder);
// - every file under `.agents/skills/`, `.openhands/skills/` and `.openhands/microagents/`.
// The agent register pins one of them (`instructions_ref`, ADR-M31 §2.5). Any other one would
// change the agent's instructions without a new agent version, so:
// - G4 refuses a run when the base commit holds one besides the pinned file (`instructions_unpinned`);
// - G5 fails a run that added, changed or removed one, the pinned file included.
//
// Paths are compared folded, like `.git` in the runner (`foldSegment`): a case-insensitive,
// normalising file system may see `Agents.MD` or `AGENTS.md` with a zero-width character as the
// same file. When the agent changes version, check this list again (ADR-M34 §2.4).

/** Characters that some file systems ignore in names (HFS+, APFS): zero-width, bidi, BOM. */
const IGNORABLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g;

/** How a case-insensitive, normalising file system may see one path segment. */
function fold(segment: string): string {
  return segment.normalize('NFC').replace(IGNORABLE, '').toLowerCase();
}

/** Root files the agent reads (folded). */
const ROOT_FILES: ReadonlySet<string> = new Set([
  'agents.md',
  'agent.md',
  'claude.md',
  'gemini.md',
  '.cursorrules',
]);

/** A file with this name in any folder is a rule for that folder (folded). */
const NESTED_FILE = 'agents.md';

/** Folders whose files are skills (folded segments from the root). */
const SKILL_FOLDERS: readonly (readonly string[])[] = [
  ['.agents', 'skills'],
  ['.openhands', 'skills'],
  ['.openhands', 'microagents'],
];

/** True when the agent would read `path` (a repository-relative path with `/`) as instructions. */
export function isAgentInstructionPath(path: string): boolean {
  const segments = path
    .split('/')
    .filter((s) => s.length > 0 && s !== '.')
    .map(fold);
  if (segments.length === 0) return false;
  const name = segments.at(-1)!;
  if (segments.length === 1 && ROOT_FILES.has(name)) return true;
  if (name === NESTED_FILE) return true;
  return SKILL_FOLDERS.some(
    (folder) => segments.length > folder.length && folder.every((part, i) => segments[i] === part),
  );
}

/**
 * The instruction paths of `paths` other than the pinned file (G4). Only the exact pinned path is
 * left out: a second spelling of it (`agents.md` next to `AGENTS.md`) is another file in Git.
 */
export function unpinnedInstructionPaths(paths: readonly string[], pinnedPath: string): string[] {
  return paths.filter((p) => p !== pinnedPath && isAgentInstructionPath(p));
}

/**
 * True when `path` (repository-relative) is a file at the repository root that the agent reads as
 * instructions: a root file, or a file of a root skill folder. A nested `AGENTS.md` is not one.
 */
export function isRootLevelInstructionPath(path: string): boolean {
  const segments = path
    .split('/')
    .filter((s) => s.length > 0 && s !== '.')
    .map(fold);
  if (segments.length === 1) return ROOT_FILES.has(segments[0]!);
  return SKILL_FOLDERS.some(
    (folder) => segments.length > folder.length && folder.every((part, i) => segments[i] === part),
  );
}

/**
 * True when the agent of a project whose folder is `repoPath` reads `path` as instructions (task
 * O06, ADR-M106 §2.4; OpenHands 1.48.0 `load_project_skills` with `working_dir` =
 * `<clone>/<repoPath>`): inside the folder, the usual rule applied to the path below the folder;
 * outside it, only the files at the repository root (the clone keeps `.git`). An empty `repoPath`
 * is the whole repository, the rule of `isAgentInstructionPath`.
 */
export function readsAsInstructions(path: string, repoPath: string): boolean {
  if (repoPath === '') return isAgentInstructionPath(path);
  if (path.startsWith(`${repoPath}/`)) {
    return isAgentInstructionPath(path.slice(repoPath.length + 1));
  }
  return isRootLevelInstructionPath(path);
}

/**
 * The instruction paths of `paths` that the agent of the folder `repoPath` reads, other than the
 * pinned ones (G4, O06). Only the exact pinned paths are left out, as in `unpinnedInstructionPaths`.
 */
export function unpinnedInstructionPathsIn(
  paths: readonly string[],
  repoPath: string,
  pinnedPaths: readonly string[],
): string[] {
  return paths.filter((p) => !pinnedPaths.includes(p) && readsAsInstructions(p, repoPath));
}
