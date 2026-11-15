// Webhook hints (task O08, design/ADR-M112 §2.3, §2.5). A verified webhook delivery only wakes
// the poller for one repository: the api sends a hint with PostgreSQL `NOTIFY`, the worker
// `LISTEN`s and polls that repository at once. The hint holds the host code and the repository
// name only, never an ID of a tenant or project and never content from the delivery (R031).

/** The PostgreSQL channel of the hints. */
export const GIT_HINT_CHANNEL = 'sdlc_git_hint';

/** Git hosts that send hints. One code per host (NFR-05). */
export const GIT_HINT_HOSTS = ['github'] as const;
export type GitHintHost = (typeof GIT_HINT_HOSTS)[number];

export interface GitHint {
  readonly host: GitHintHost;
  /** `owner/name`, as the projects store it (`projects.repo_full_name`). */
  readonly repository: string;
}

/** GitHub owner and repository names: letters, digits, `-`, `_` and `.`, at most 100 each. */
const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

/** The `NOTIFY` payload of a hint. Throws on a repository name that a project could not hold. */
export function encodeGitHint(hint: GitHint): string {
  if (!GIT_HINT_HOSTS.includes(hint.host) || !REPOSITORY.test(hint.repository)) {
    throw new Error('invalid git hint');
  }
  return JSON.stringify({ host: hint.host, repository: hint.repository });
}

/** A hint from a `NOTIFY` payload, or null when the payload is not one (never throws). */
export function parseGitHint(payload: string | undefined): GitHint | null {
  if (payload === undefined || payload.length > 512) return null;
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const { host, repository, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length > 0) return null;
  if (!GIT_HINT_HOSTS.includes(host as GitHintHost)) return null;
  if (typeof repository !== 'string' || !REPOSITORY.test(repository)) return null;
  return { host: host as GitHintHost, repository };
}

/** The key the poller compares repository names by (GitHub names ignore case). */
export function repositoryKey(repository: string): string {
  return repository.toLowerCase();
}
