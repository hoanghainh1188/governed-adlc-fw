// The retention loop (task E05, design/ADR-M51; D-05 §10.1; D-02 FR-44): a plain loop in the
// worker process, like the escalation clock loop (ADR-M28) and the spend sync (C12), not a
// Temporal schedule: it carries no workflow data, and a fake clock tests it.
//
// - Every interval one pass (`runRetentionPass`, core) under a PostgreSQL advisory lock, so one
//   process at a time deletes evidence; another holder → `worker.retention_busy`.
// - Mode `report` (the default) counts and deletes nothing; `purge` deletes. Holds and lock moves
//   run in both modes: they only protect evidence.
// - The orphan sweep goes through `packs/` one page per pass and starts again at the end.
// - The loop never throws: a failed pass is logged and the next one tries again.
// - E05 PR 2 (ADR-M51 §2.9): each pass first runs the daily audit anchor (`runAnchorPass`, core),
//   under the same lock. The loop runs when either identity is there (`worker-purge`,
//   `worker-anchor`); each part only with its own. A failed anchor pass never stops the purge.
// - O04 (ADR-M103): before the evidence pass, housekeeping of the dashboard's session tables
//   (`runHousekeepingPass`, core). It needs only the database, so the loop runs for it alone too,
//   and a failing evidence pass (S3 down) never stops it; its own failure is logged and never stops
//   the other parts.
// - H03b (ADR-M97): `runClientPurgePass` runs first under the same lock so today's audit anchor
//   (when written later in the tick) can cover `client_data.deleted`.
import type {
  AnchorPassResult,
  ClientPurgePassResult,
  HousekeepingPassResult,
  HousekeepingSettings,
  RetentionPassDeps,
  RetentionPassResult,
  SpendSyncLockResult,
} from '@sdlc/core';

import type { WorkerLogger } from './logger.js';

export interface RetentionLoopDeps {
  /** `runAnchorPass` (core) bound to its dependencies; absent without `worker-anchor`. */
  readonly anchor?: () => Promise<AnchorPassResult>;
  /** `runRetentionPass` (core) bound to its dependencies; absent without `worker-purge`. */
  readonly pass?: (orphanCursor: string | null) => Promise<RetentionPassResult>;
  /** `runHousekeepingPass` (core) bound to its dependencies; absent with `SDLC_WORKER_HOUSEKEEPING_MODE=off`. */
  readonly housekeeping?: () => Promise<HousekeepingPassResult>;
  /** `runClientPurgePass` (core, H03b); absent without `worker-purge`. */
  readonly clientPurge?: () => Promise<ClientPurgePassResult>;
  readonly housekeepingMode?: HousekeepingSettings['mode'];
  /** `SystemScope.withRetentionLock`. */
  withLock<T>(fn: () => Promise<T>): Promise<SpendSyncLockResult<T>>;
  readonly logger: WorkerLogger;
  readonly mode: RetentionPassDeps['settings']['mode'];
  readonly intervalMs: number;
}

export type RetentionLoopPass =
  | {
      readonly outcome: 'done';
      /** Null when the part did not run (no identity) or failed (logged). */
      readonly anchors: AnchorPassResult | null;
      readonly result: RetentionPassResult | null;
      /** Null when housekeeping is off or failed (logged). */
      readonly housekeeping: HousekeepingPassResult | null;
      /** Null when client purge did not run or failed (logged). */
      readonly clientPurge: ClientPurgePassResult | null;
    }
  | { readonly outcome: 'busy' }
  | { readonly outcome: 'failed' };

function errorCode(error: unknown): string {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return error instanceof Error ? error.name : 'unexpected';
}

export class RetentionLoop {
  readonly #deps: RetentionLoopDeps;
  #orphanCursor: string | null = null;
  #timer: NodeJS.Timeout | undefined;
  #ticking: Promise<unknown> | undefined;
  #stopped = false;

  constructor(deps: RetentionLoopDeps) {
    this.#deps = deps;
  }

  /** One pass: anchors first, then the retention steps. Never throws. */
  async tick(): Promise<RetentionLoopPass> {
    try {
      const locked = await this.#deps.withLock(async () => ({
        // H03b: before the daily anchor so today's file can cover `client_data.deleted`.
        clientPurge: await this.#clientPurge(),
        anchors: await this.#anchors(),
        // Before the evidence pass: it needs only the database, so S3 being down never stops it.
        housekeeping: await this.#housekeeping(),
        result: this.#deps.pass ? await this.#deps.pass(this.#orphanCursor) : null,
      }));
      if (!locked.ran) {
        this.#deps.logger.log('info', 'worker.retention_busy', {});
        return { outcome: 'busy' };
      }
      const { anchors, result, housekeeping, clientPurge } = locked.value;
      if (result) {
        const { orphanCursor, ...counts } = result;
        this.#orphanCursor = orphanCursor;
        this.#deps.logger.log(counts.failed > 0 ? 'warn' : 'info', 'worker.retention_pass', {
          mode: this.#deps.mode,
          ...counts,
        });
      }
      return { outcome: 'done', anchors, result, housekeeping, clientPurge };
    } catch (error) {
      this.#deps.logger.log('error', 'worker.retention_failed', { error: errorCode(error) });
      return { outcome: 'failed' };
    }
  }

  /** The anchor pass; a failure is logged and never stops the retention steps. */
  async #anchors(): Promise<AnchorPassResult | null> {
    if (!this.#deps.anchor) return null;
    try {
      const counts = await this.#deps.anchor();
      const bad = counts.failed + counts.mismatched + counts.unlocked > 0;
      this.#deps.logger.log(bad ? 'warn' : 'info', 'worker.anchor_pass', { ...counts });
      return counts;
    } catch (error) {
      this.#deps.logger.log('error', 'worker.anchor_pass_failed', { error: errorCode(error) });
      return null;
    }
  }

  /** The client-data purge; a failure is logged and never stops the other parts. */
  async #clientPurge(): Promise<ClientPurgePassResult | null> {
    if (!this.#deps.clientPurge) return null;
    try {
      const counts = await this.#deps.clientPurge();
      const bad = counts.failed > 0 || counts.tenantsBlocked > 0;
      this.#deps.logger.log(bad ? 'warn' : 'info', 'worker.client_purge_pass', { ...counts });
      return counts;
    } catch (error) {
      this.#deps.logger.log('error', 'worker.client_purge_failed', { error: errorCode(error) });
      return null;
    }
  }

  /** The housekeeping pass; a failure is logged and never stops the other parts. */
  async #housekeeping(): Promise<HousekeepingPassResult | null> {
    if (!this.#deps.housekeeping) return null;
    try {
      const counts = await this.#deps.housekeeping();
      this.#deps.logger.log(counts.failed > 0 ? 'warn' : 'info', 'worker.housekeeping_pass', {
        mode: this.#deps.housekeepingMode ?? 'report',
        ...counts,
      });
      return counts;
    } catch (error) {
      this.#deps.logger.log('error', 'worker.housekeeping_failed', { error: errorCode(error) });
      return null;
    }
  }

  start(): void {
    const loop = (): void => {
      if (this.#stopped) return;
      this.#ticking = this.tick().finally(() => {
        if (!this.#stopped) this.#timer = setTimeout(loop, this.#deps.intervalMs);
      });
    };
    loop();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    clearTimeout(this.#timer);
    await this.#ticking;
  }
}
