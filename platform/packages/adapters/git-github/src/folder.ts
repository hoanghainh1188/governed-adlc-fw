// One folder of a commit's tree, and the commits that changed a path (task X13, ADR-M74 0.2,
// QUESTIONS #715). The memory set needs each file's mode and blob ID, which `listTreePaths` does
// not keep; the producers of a memory change are the authors of the commits that changed the
// memory folder. Paths and names are never logged.
import {
  FOLDER_ENTRY_KINDS,
  GitHostError,
  type FolderEntry,
  type FolderEntryKind,
  type PathCommit,
  type PathCommits,
  type RepoRef,
} from '@sdlc/contracts';

import type { AppAuth } from './app-auth.js';
import type { GitHubHttp } from './http.js';
import { actor, arr, bool, isSha, obj, repoPath, sha, str } from './json.js';
import { listPages } from './pages.js';

export interface FolderDeps {
  readonly http: GitHubHttp;
  readonly auth: AppAuth;
}

/** A plain segment: never empty, `.`, `..` or with a `/`. */
const SEGMENT = /^[A-Za-z0-9_.-]+$/;

/** Git modes of tree entries (`git/trees`). */
const KINDS: Readonly<Record<string, FolderEntryKind>> = {
  '100644': 'file',
  '100755': 'executable',
  '120000': 'symlink',
  '160000': 'submodule',
  '040000': 'folder',
};

function checkFolder(folder: string): string[] {
  const segments = folder.split('/');
  if (folder.length === 0 || folder.length > 200) {
    throw new GitHostError('invalid_input', { field: 'folder' });
  }
  for (const segment of segments) {
    if (!SEGMENT.test(segment) || segment === '.' || segment === '..') {
      throw new GitHostError('invalid_input', { field: 'folder' });
    }
  }
  return segments;
}

function entryOf(item: unknown): FolderEntry {
  const entry = obj(item, 'tree.entry');
  const name = str(entry.path, 'tree.entry.path');
  if (name.length === 0 || name.includes('/') || name === '.' || name === '..') {
    throw new GitHostError('invalid_response', { field: 'tree.entry.path' });
  }
  const kind = KINDS[str(entry.mode, 'tree.entry.mode')];
  if (kind === undefined || !FOLDER_ENTRY_KINDS.includes(kind)) {
    throw new GitHostError('invalid_response', { field: 'tree.entry.mode' });
  }
  return { name, kind, sha: sha(entry.sha, 'tree.entry.sha') };
}

/** Entries directly in `folder` at `commitSha`, sorted by name; [] when there is no such folder. */
export async function listFolderEntries(
  deps: FolderDeps,
  ref: RepoRef,
  commitSha: string,
  folder: string,
): Promise<FolderEntry[]> {
  if (!isSha(commitSha)) throw new GitHostError('invalid_input', { field: 'sha' });
  const segments = checkFolder(folder);
  const base = repoPath(ref);
  const read = async (treeSha: string): Promise<FolderEntry[]> => {
    const res = await deps.auth.withRepoAuth(ref, (auth) =>
      deps.http.json('GET', `${base}/git/trees/${treeSha}`, { auth }),
    );
    const body = obj(res.body, 'tree');
    if (bool(body.truncated, 'tree.truncated')) throw new GitHostError('tree_truncated');
    return arr(body.tree, 'tree.tree').map(entryOf);
  };
  let entries = await read(commitSha);
  for (const segment of segments) {
    const next = entries.find((entry) => entry.name === segment);
    if (next?.kind !== 'folder') return [];
    entries = await read(next.sha);
  }
  return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function commitOf(item: unknown): PathCommit {
  const commit = obj(item, 'commit');
  const author =
    commit.author === null || commit.author === undefined
      ? null
      : actor(commit.author, 'commit.author');
  return { sha: sha(commit.sha, 'commit.sha'), author };
}

/** The commits that changed `path` from `head`, newest first, cut at `max` or before `stopAt`. */
export async function listPathCommits(
  deps: FolderDeps,
  ref: RepoRef,
  head: string,
  path: string,
  options: { readonly stopAt?: string | undefined; readonly max: number },
): Promise<PathCommits> {
  if (!isSha(head)) throw new GitHostError('invalid_input', { field: 'head' });
  if (options.stopAt !== undefined && !isSha(options.stopAt)) {
    throw new GitHostError('invalid_input', { field: 'stop_at' });
  }
  if (!Number.isInteger(options.max) || options.max < 1 || options.max > 100) {
    throw new GitHostError('invalid_input', { field: 'max' });
  }
  checkFolder(path);
  const base = repoPath(ref);
  const stopAt = options.stopAt;
  const list = await deps.auth.withRepoAuth(ref, (auth) =>
    listPages(deps.http, `${base}/commits`, {
      auth,
      // One page more than `max` tells whether the list goes on.
      maxPages: 2,
      cache: false,
      query: { sha: head, path, per_page: options.max },
      ...(stopAt === undefined
        ? {}
        : { stopAt: (item: unknown) => obj(item, 'commit').sha === stopAt }),
    }),
  );
  const commits = list.items.map(commitOf);
  if (commits.length > options.max || list.truncated) {
    return { commits: commits.slice(0, options.max), complete: false };
  }
  return { commits, complete: true };
}
