// Every path of a commit's tree, also for very large repositories (task O06 AC1, ADR-M106).
//
// One recursive call to the Git trees API is enough for most repositories. GitHub cuts a large
// tree short (`truncated: true`; about 100 000 entries or 7 MB). A partial list could hide an agent
// instruction file, so a cut listing is never used: the folder is listed again without
// `recursive`, and each of its sub-trees is listed recursively by its own SHA. Only a sub-tree
// that is still cut is split again. The number of requests has a limit (`maxTreeRequests`): past
// it, and for a folder that GitHub cuts even without `recursive`, the call fails closed with
// `tree_truncated` (ADR-M34 §2.4). Paths are never logged.
import { GitHostError, type RepoRef } from '@sdlc/contracts';

import type { AppAuth } from './app-auth.js';
import type { GitHubHttp } from './http.js';
import { arr, bool, obj, repoPath, sha, str } from './json.js';

/** One tree to list: its SHA (the commit's SHA for the root) and the path before its entries. */
interface TreeJob {
  readonly sha: string;
  readonly prefix: string;
}

interface TreeEntry {
  readonly path: string;
  readonly type: 'blob' | 'commit' | 'tree';
  readonly sha: string;
}

interface TreeListing {
  readonly truncated: boolean;
  readonly entries: readonly TreeEntry[];
}

export interface TreeWalkDeps {
  readonly http: GitHubHttp;
  readonly auth: AppAuth;
  /** Most Git trees requests for one commit. */
  readonly maxRequests: number;
}

function entryOf(item: unknown): TreeEntry {
  const entry = obj(item, 'tree.entry');
  const type = str(entry.type, 'tree.entry.type');
  if (type !== 'blob' && type !== 'commit' && type !== 'tree') {
    throw new GitHostError('invalid_response', { field: 'tree.entry.type' });
  }
  const path = str(entry.path, 'tree.entry.path');
  if (path.length === 0 || path.startsWith('/')) {
    throw new GitHostError('invalid_response', { field: 'tree.entry.path' });
  }
  return { path, type, sha: type === 'tree' ? sha(entry.sha, 'tree.entry.sha') : '' };
}

/** A folder name of a listing without `recursive`: one segment, never `.` or `..`. */
function checkSegment(name: string): void {
  if (name.includes('/') || name === '.' || name === '..') {
    throw new GitHostError('invalid_response', { field: 'tree.entry.path' });
  }
}

/** Every non-directory path at `commitSha`, sorted; `tree_truncated` past the limits. */
export async function listTreePaths(
  deps: TreeWalkDeps,
  ref: RepoRef,
  commitSha: string,
): Promise<string[]> {
  const base = repoPath(ref);
  let requests = 0;
  const read = async (treeSha: string, recursive: boolean): Promise<TreeListing> => {
    requests += 1;
    if (requests > deps.maxRequests) throw new GitHostError('tree_truncated');
    const res = await deps.auth.withRepoAuth(ref, (auth) =>
      deps.http.json('GET', `${base}/git/trees/${treeSha}`, {
        auth,
        ...(recursive ? { query: { recursive: 1 } } : {}),
      }),
    );
    const body = obj(res.body, 'tree');
    return {
      truncated: bool(body.truncated, 'tree.truncated'),
      entries: arr(body.tree, 'tree.tree').map(entryOf),
    };
  };

  const paths = new Set<string>();
  const queue: TreeJob[] = [{ sha: commitSha, prefix: '' }];
  for (let job = queue.shift(); job !== undefined; job = queue.shift()) {
    const full = await read(job.sha, true);
    if (!full.truncated) {
      for (const entry of full.entries) {
        if (entry.type !== 'tree') paths.add(job.prefix + entry.path);
      }
      continue;
    }
    // Cut short: list this folder alone and walk its sub-trees one by one.
    const folder = await read(job.sha, false);
    if (folder.truncated) throw new GitHostError('tree_truncated');
    for (const entry of folder.entries) {
      checkSegment(entry.path);
      if (entry.type === 'tree') {
        queue.push({ sha: entry.sha, prefix: `${job.prefix}${entry.path}/` });
      } else {
        paths.add(job.prefix + entry.path);
      }
    }
  }
  return [...paths].sort();
}
