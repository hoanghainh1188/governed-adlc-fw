// The GitHub poller loop (D-08 B06 AC1, design/ADR-M27 section 2.1): a plain loop in the worker
// process, no Temporal (decision D1).
//
// - Every tick, it reads the list of pollable projects and starts the polls that are due.
// - O06 PR 2c (ADR-M106 §2.4): the projects of one tenant on one repository are one group, polled
//   together with one read of GitHub. The group's interval is the shortest of its projects.
// - Each project has its own interval, read from its configuration before every poll
//   (`github.poll_interval_seconds`), so a configuration change applies without a restart.
// - One group never has two polls running at once in this process. Across processes, the
//   cursor compare-and-set in `pollRepository` rolls a second poll back.
// - All state (cursor, receipts) is in PostgreSQL: after a restart, every group is polled once
//   right away and continues from its stored cursors.
// - O08 (ADR-M112 §2.6): a webhook hint makes the groups of its repository due at once, without
//   waiting for the next tick. A hint never polls earlier than GitHub's rate-limit reset, and a
//   hint for a group being polled gives one more poll after it, however many hints came.
import { GitHostError, type ProjectConfig } from '@sdlc/contracts';
import {
  repositoryKey,
  withLogContext,
  type PollableProject,
  type PollableRepository,
} from '@sdlc/core';

import type { WorkerLogger } from './logger.js';

/** After configurations that cannot be read, the group is tried again this much later. */
export const INVALID_CONFIG_RETRY_MS = 60_000;

/**
 * O08 (ADR-M112 §2.6): after a failed poll without a rate-limit reset time, a hint waits this
 * long, so a stream of deliveries never repeats a failing poll at once.
 */
export const HINT_FAILURE_BACKOFF_MS = 30_000;

/** How a poll was started: by the schedule, or by a webhook hint (O08). */
export type PollReason = 'scheduled' | 'hinted';

/**
 * The project's interval in seconds (ADR-M27 §2.1, ADR-M112 §2.6): `poll_interval_seconds`, or
 * `webhooks.reconcile_interval_seconds` when webhooks are on.
 */
export function pollIntervalSeconds(github: ProjectConfig['github']): number {
  return github.webhooks.enabled
    ? github.webhooks.reconcile_interval_seconds
    : github.poll_interval_seconds;
}

export interface PollerLoopDeps {
  listProjects(): Promise<readonly PollableProject[]>;
  /** The project's interval (`pollIntervalSeconds`); throws when the configuration is invalid. */
  intervalSeconds(project: PollableProject): Promise<number>;
  poll(group: PollableRepository, reason: PollReason): Promise<unknown>;
  /** Milliseconds since the epoch. */
  now(): number;
  readonly logger: WorkerLogger;
  readonly maxConcurrentPolls: number;
  /** Called after every tick (the container health check reads it). */
  heartbeat?(): void;
}

/** A code for logs, never an error message: Git host codes, catalog keys, error codes. */
function errorCode(error: unknown): string {
  if (error instanceof GitHostError) return error.code;
  // `SecretsError` (OpenBao) carries its catalog key, for example `secrets.not_found`.
  if (error instanceof Error && 'key' in error && typeof error.key === 'string') return error.key;
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return 'unexpected';
}

export class PollerLoop {
  readonly #deps: PollerLoopDeps;
  readonly #nextDue = new Map<string, number>();
  readonly #running = new Map<string, Promise<void>>();
  /** O08: GitHub's rate-limit reset per group; a hint never polls before it. */
  readonly #notBefore = new Map<string, number>();
  /** O08: repository keys hinted since the last tick, and groups to poll again after their poll. */
  readonly #hinted = new Set<string>();
  readonly #again = new Set<string>();
  /** O08: groups whose next poll was started by a hint. */
  readonly #hintedGroups = new Set<string>();
  #allHinted = false;
  #timer: NodeJS.Timeout | undefined;
  #ticking: Promise<void> | undefined;
  #loop: (() => void) | undefined;
  #kickPending = false;
  #stopped = false;

  constructor(deps: PollerLoopDeps) {
    this.#deps = deps;
  }

  /** One scheduling pass: starts the due polls and returns without waiting for them. */
  async tick(): Promise<void> {
    const groups = groupByRepository(await this.#deps.listProjects());
    const listed = new Set(groups.map(key));
    for (const known of [...this.#nextDue.keys()]) {
      if (!listed.has(known)) this.#nextDue.delete(known);
    }
    this.#applyHints(groups);
    // Longest-waiting first, so a group late in the list is never starved when more groups are
    // due than `maxConcurrentPolls`.
    const now = this.#deps.now();
    const due = groups
      .filter((g) => !this.#running.has(key(g)) && now >= (this.#nextDue.get(key(g)) ?? 0))
      .sort((a, b) => (this.#nextDue.get(key(a)) ?? 0) - (this.#nextDue.get(key(b)) ?? 0));
    for (const group of due) {
      if (this.#stopped || this.#running.size >= this.#deps.maxConcurrentPolls) break;
      const id = key(group);
      const run = this.#run(group).finally(() => this.#running.delete(id));
      this.#running.set(id, run);
    }
    this.#deps.heartbeat?.();
  }

  /**
   * O08 (ADR-M112 §2.6): a webhook hint for `repository` (`owner/name`). Its groups are polled at
   * once; a hint for a repository that no project polls is dropped at the next tick.
   */
  hint(repository: string): void {
    this.#hinted.add(repositoryKey(repository));
    this.#kick();
  }

  /** O08: every group is due at once (after the hint connection came back: hints may be lost). */
  hintAll(): void {
    this.#allHinted = true;
    this.#kick();
  }

  /** Waits for the polls in progress (tests, shutdown). */
  async idle(): Promise<void> {
    await Promise.all(this.#running.values());
  }

  start(tickMs: number): void {
    const loop = (): void => {
      if (this.#stopped) return;
      this.#kickPending = false;
      this.#ticking = this.tick()
        .catch((error: unknown) => {
          this.#deps.logger.log('error', 'worker.tick_failed', { error: errorCode(error) });
        })
        .finally(() => {
          this.#ticking = undefined;
          if (!this.#stopped) this.#timer = setTimeout(loop, this.#kickPending ? 0 : tickMs);
        });
    };
    this.#loop = loop;
    loop();
  }

  /** Runs the next tick now: at once when no tick runs, or right after the one that runs. */
  #kick(): void {
    if (this.#stopped || !this.#loop) return;
    if (this.#ticking) {
      this.#kickPending = true;
      return;
    }
    clearTimeout(this.#timer);
    this.#loop();
  }

  /** Makes the hinted groups due now (never before their rate-limit reset). */
  #applyHints(groups: readonly Group[]): void {
    const all = this.#allHinted;
    this.#allHinted = false;
    if (!all && this.#hinted.size === 0) return;
    for (const group of groups) {
      if (!all && !this.#hinted.has(repositoryKey(group.repoFullName))) continue;
      const id = key(group);
      if (this.#running.has(id)) {
        this.#again.add(id);
        continue;
      }
      this.#nextDue.set(id, this.#notBefore.get(id) ?? 0);
      this.#hintedGroups.add(id);
    }
    this.#hinted.clear();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    clearTimeout(this.#timer);
    await this.#ticking;
    await this.idle();
  }

  /** The shortest interval of the group's projects; undefined when none can be read. */
  async #intervalMs(group: Group): Promise<number | undefined> {
    let shortest: number | undefined;
    for (const project of group.projects) {
      try {
        const ms = (await this.#deps.intervalSeconds(project)) * 1000;
        shortest = shortest === undefined ? ms : Math.min(shortest, ms);
      } catch (error) {
        this.#deps.logger.log('error', 'worker.poll_config_invalid', {
          tenant_id: project.tenantId,
          project_id: project.projectId,
          error: errorCode(error),
        });
      }
    }
    return shortest;
  }

  async #run(group: Group): Promise<void> {
    const id = key(group);
    const fields = {
      tenant_id: group.tenantId,
      project_id: group.projectIds[0] ?? '',
      projects: group.projectIds.length,
    };
    const intervalMs = await this.#intervalMs(group);
    if (intervalMs === undefined) {
      this.#nextDue.set(id, this.#deps.now() + INVALID_CONFIG_RETRY_MS);
      this.#hintedGroups.delete(id);
      this.#again.delete(id);
      return;
    }
    const target: PollableRepository = {
      tenantId: group.tenantId,
      repoFullName: group.repoFullName,
      projectIds: group.projectIds,
    };
    const reason: PollReason = this.#hintedGroups.delete(id) ? 'hinted' : 'scheduled';
    try {
      // The GitHub adapter's and OpenBao's log lines of this poll carry the tenant (A08).
      await withLogContext({ tenantId: group.tenantId }, () => this.#deps.poll(target, reason));
      this.#nextDue.set(id, this.#deps.now() + intervalMs);
      this.#notBefore.delete(id);
    } catch (error) {
      let due = this.#deps.now() + intervalMs;
      if (error instanceof GitHostError && error.code === 'rate_limited') {
        const retryAt = Date.parse(String(error.params.retry_at ?? ''));
        if (Number.isFinite(retryAt)) {
          due = Math.max(due, retryAt);
          this.#notBefore.set(id, retryAt);
        }
      }
      if (!this.#notBefore.has(id) || (this.#notBefore.get(id) ?? 0) < this.#deps.now()) {
        this.#notBefore.set(id, this.#deps.now() + HINT_FAILURE_BACKOFF_MS);
      }
      this.#nextDue.set(id, due);
      this.#deps.logger.log('error', 'worker.poll_failed', { ...fields, error: errorCode(error) });
    } finally {
      this.#pollAgainIfHinted(id);
    }
  }

  /** A hint came while the group was polled: one more poll, as soon as the limits allow. */
  #pollAgainIfHinted(id: string): void {
    if (!this.#again.delete(id)) return;
    this.#nextDue.set(id, this.#notBefore.get(id) ?? 0);
    this.#hintedGroups.add(id);
    // A macrotask: it runs after `#running` drops this group (the caller's `finally`), so the
    // tick can start it.
    setImmediate(() => {
      this.#kick();
    });
  }
}

interface Group extends PollableRepository {
  readonly projects: readonly PollableProject[];
}

/** The projects of one tenant on one repository, in list order (ADR-M106 §2.4). */
function groupByRepository(projects: readonly PollableProject[]): Group[] {
  const groups = new Map<string, PollableProject[]>();
  for (const project of projects) {
    const id = `${project.tenantId}/${project.repoFullName}`;
    const members = groups.get(id);
    if (members) members.push(project);
    else groups.set(id, [project]);
  }
  return [...groups.values()].map((members) => ({
    tenantId: members[0]!.tenantId,
    repoFullName: members[0]!.repoFullName,
    projectIds: members.map((p) => p.projectId),
    projects: members,
  }));
}

function key(group: PollableRepository): string {
  return `${group.tenantId}/${group.repoFullName}`;
}
