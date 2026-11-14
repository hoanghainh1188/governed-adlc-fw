// The memory loop (task X13 PR 3b, design/ADR-M74 §2.5 steps 5–6, 0.5; QUESTIONS #716): a plain
// loop in the worker process, like the escalation clock loop (ADR-M28), not a Temporal timer and
// not the poller. Each step calls the Git host, so it runs outside the poller's transaction.
//
// - Every tick, it reads the work (`SystemScope.listMemoryWork`, IDs only): runs that pushed a
//   memory branch without a proposal row, and proposals still `pushed` or `opened`, least recently
//   looked at first. Each item is one step in its tenant's scope (`stepMemoryWork`, core).
// - All state is in PostgreSQL: after a restart the loop goes on from the stored states. Moves are
//   compare-and-set, so two workers never record the same step twice.
// - An error skips only that item (logged with a code); the next tick tries it again. The memory
//   pull request never blocks a gate, so nothing here pauses or escalates.
import { withLogContext, type MemoryStepOutcome, type MemoryWork } from '@sdlc/core';

import type { WorkerLogger } from './logger.js';

export interface MemoryLoopDeps {
  listWork(limit: number): Promise<readonly MemoryWork[]>;
  step(work: MemoryWork): Promise<MemoryStepOutcome>;
  readonly logger: WorkerLogger;
  /** Items handled per tick at most; the rest wait for the next tick. */
  readonly batchSize: number;
}

/** A code for logs, never an error message. */
function errorCode(error: unknown): string {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return error instanceof Error ? error.name : 'unexpected';
}

export class MemoryLoop {
  readonly #deps: MemoryLoopDeps;
  #timer: NodeJS.Timeout | undefined;
  #ticking: Promise<void> | undefined;
  #stopped = false;

  constructor(deps: MemoryLoopDeps) {
    this.#deps = deps;
  }

  /** One pass over the batch. An error skips only that item. */
  async tick(): Promise<void> {
    const work = await this.#deps.listWork(this.#deps.batchSize);
    for (const item of work) {
      if (this.#stopped) break;
      const fields: Record<string, string> =
        item.kind === 'run'
          ? { tenant_id: item.tenantId, run_id: item.runId }
          : { tenant_id: item.tenantId, proposal_id: item.proposalId };
      try {
        const outcome = await withLogContext({ tenantId: item.tenantId }, () =>
          this.#deps.step(item),
        );
        if (outcome !== 'waiting' && outcome !== 'seen' && outcome !== 'skipped') {
          this.#deps.logger.log('info', 'worker.memory_step', { ...fields, outcome });
        }
      } catch (error) {
        this.#deps.logger.log('warn', 'worker.memory_step_failed', {
          ...fields,
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
          this.#deps.logger.log('error', 'worker.memory_tick_failed', { error: errorCode(error) });
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
