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
import { GitHostError } from '@sdlc/contracts';
import { withLogContext, type PollableProject, type PollableRepository } from '@sdlc/core';

import type { WorkerLogger } from './logger.js';

/** After configurations that cannot be read, the group is tried again this much later. */
export const INVALID_CONFIG_RETRY_MS = 60_000;

export interface PollerLoopDeps {
  listProjects(): Promise<readonly PollableProject[]>;
  /** The project's `github.poll_interval_seconds`; throws when the configuration is invalid. */
  intervalSeconds(project: PollableProject): Promise<number>;
  poll(group: PollableRepository): Promise<unknown>;
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
  #timer: NodeJS.Timeout | undefined;
  #ticking: Promise<void> | undefined;
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

  /** Waits for the polls in progress (tests, shutdown). */
  async idle(): Promise<void> {
    await Promise.all(this.#running.values());
  }

  start(tickMs: number): void {
    const loop = (): void => {
      if (this.#stopped) return;
      this.#ticking = this.tick()
        .catch((error: unknown) => {
          this.#deps.logger.log('error', 'worker.tick_failed', { error: errorCode(error) });
        })
        .finally(() => {
          if (!this.#stopped) this.#timer = setTimeout(loop, tickMs);
        });
    };
    loop();
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
      return;
    }
    const target: PollableRepository = {
      tenantId: group.tenantId,
      repoFullName: group.repoFullName,
      projectIds: group.projectIds,
    };
    try {
      // The GitHub adapter's and OpenBao's log lines of this poll carry the tenant (A08).
      await withLogContext({ tenantId: group.tenantId }, () => this.#deps.poll(target));
      this.#nextDue.set(id, this.#deps.now() + intervalMs);
    } catch (error) {
      let due = this.#deps.now() + intervalMs;
      if (error instanceof GitHostError && error.code === 'rate_limited') {
        const retryAt = Date.parse(String(error.params.retry_at ?? ''));
        if (Number.isFinite(retryAt)) due = Math.max(due, retryAt);
      }
      this.#nextDue.set(id, due);
      this.#deps.logger.log('error', 'worker.poll_failed', { ...fields, error: errorCode(error) });
    }
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
