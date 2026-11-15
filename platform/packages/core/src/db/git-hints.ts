// The PostgreSQL side of the webhook hints (task O08, design/ADR-M112 §2.5): `NOTIFY` from the
// api, `LISTEN` in the worker. No table is read or written, so no tenant is set (ADR-M110): the
// payload names a repository only, and the worker matches it against the projects it polls.
import pg from 'pg';

import { GIT_HINT_CHANNEL, parseGitHint, type GitHint } from '../git-events/hints.js';
import { connectionErrorCode, type DatabaseConfig } from './connection.js';

/** A live `LISTEN` connection. */
export interface GitHintSubscription {
  /** Resolves once, with a code only, when the connection ends or fails (never rejects). */
  readonly ended: Promise<string>;
  close(): Promise<void>;
}

/**
 * Opens one connection outside the pool and listens for hints. A payload that is not a hint is
 * dropped without a log: only the api writes to the channel, and the content is never logged.
 */
export async function listenGitHints(
  config: DatabaseConfig,
  onHint: (hint: GitHint) => void,
): Promise<GitHintSubscription> {
  const client = new pg.Client({
    connectionString: config.connectionString,
    application_name: `${config.applicationName ?? 'sdlc-platform'}-hints`,
    // A connection that a firewall or NAT drops silently still ends (TCP keep-alive).
    keepAlive: true,
  });
  let resolveEnded: (code: string) => void = () => undefined;
  const ended = new Promise<string>((resolve) => {
    resolveEnded = resolve;
  });
  // Errors of this client never reach Node's default handler (it would end the process).
  client.on('error', (error) => {
    resolveEnded(connectionErrorCode(error));
    void client.end().catch(() => undefined);
  });
  client.on('end', () => {
    resolveEnded('ended');
  });
  client.on('notification', (message) => {
    if (message.channel !== GIT_HINT_CHANNEL) return;
    const hint = parseGitHint(message.payload);
    if (hint) onHint(hint);
  });
  try {
    await client.connect();
    await client.query(`LISTEN ${GIT_HINT_CHANNEL}`);
  } catch (error) {
    await client.end().catch(() => undefined);
    throw error;
  }
  return {
    ended,
    close: async () => {
      await client.end().catch(() => undefined);
    },
  };
}
