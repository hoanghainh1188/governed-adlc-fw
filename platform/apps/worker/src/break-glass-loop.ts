// The break-glass loop (task H08 PR 3b, design/ADR-M111 §2.5, §2.8): a plain loop in the worker
// process, like the escalation clock (R044: never a Temporal timer or schedule). Every tick, for
// each tenant (ADR-M110: one tenant per transaction), it ends the grants whose time is over
// (`expired`, `lapsed`) and marks the reviews that are overdue, with their audit events and the
// notice. Expiry is also checked on every read, so a slow tick never extends a grant. Each move is
// written once (row lock, trigger SDA32): two workers never repeat one.
import { withLogContext, type BreakGlassPassResult, type TenantId } from '@sdlc/core';

import type { WorkerLogger } from './logger.js';

export interface BreakGlassLoopDeps {
  listTenants(): Promise<readonly TenantId[]>;
  pass(tenantId: TenantId, now: Date): Promise<BreakGlassPassResult>;
  now(): Date;
  readonly logger: WorkerLogger;
}

/** A code for logs, never an error message. */
function errorCode(error: unknown): string {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return error instanceof Error ? error.name : 'unexpected';
}

export class BreakGlassLoop {
  readonly #deps: BreakGlassLoopDeps;
  #timer: NodeJS.Timeout | undefined;
  #ticking: Promise<void> | undefined;
  #stopped = false;

  constructor(deps: BreakGlassLoopDeps) {
    this.#deps = deps;
  }

  /** One pass over every tenant. An error skips only that tenant. */
  async tick(): Promise<void> {
    const now = this.#deps.now();
    for (const tenantId of await this.#deps.listTenants()) {
      if (this.#stopped) break;
      try {
        const result = await withLogContext({ tenantId }, () => this.#deps.pass(tenantId, now));
        if (result.expired + result.lapsed + result.reviewOverdue > 0) {
          this.#deps.logger.log('info', 'worker.break_glass_pass', {
            tenant_id: tenantId,
            expired: result.expired,
            lapsed: result.lapsed,
            review_overdue: result.reviewOverdue,
          });
        }
      } catch (error) {
        this.#deps.logger.log('error', 'worker.break_glass_failed', {
          tenant_id: tenantId,
          error: errorCode(error),
        });
      }
    }
  }

  start(tickMs: number): void {
    const loop = (): void => {
      if (this.#stopped) return;
      this.#ticking = this.tick()
        .catch((error: unknown) => {
          this.#deps.logger.log('error', 'worker.break_glass_tick_failed', {
            error: errorCode(error),
          });
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
  }
}
