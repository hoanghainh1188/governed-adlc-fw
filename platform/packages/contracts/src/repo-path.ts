// A project's folder in its repository (task O06, ADR-M106 §2.4, D-05 §6.1 `projects.repo_path`).
// Empty = the whole repository. Otherwise a relative path of plain segments joined by `/`: no
// `.` or `..`, no empty part, no leading or trailing `/`, at most 200 characters. The database
// CHECK of migration 0049 is the same rule.

/** Longest folder path. */
export const MAX_REPO_PATH_LENGTH = 200;

const SEGMENT = /^[A-Za-z0-9_.-]+$/;

/** True when `value` is a valid `repo_path` (the empty string included). */
export function isRepoPath(value: string): boolean {
  if (value === '') return true;
  if (value.length > MAX_REPO_PATH_LENGTH) return false;
  return value.split('/').every((s) => SEGMENT.test(s) && s !== '.' && s !== '..');
}

/** True when the repository-relative `path` is inside the folder `repoPath` ('' = everything). */
export function isInsideRepoPath(path: string, repoPath: string): boolean {
  return repoPath === '' || path.startsWith(`${repoPath}/`);
}

/** True when two folders of one repository overlap: equal, or one inside the other. */
export function repoPathsOverlap(a: string, b: string): boolean {
  return a === '' || b === '' || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}
