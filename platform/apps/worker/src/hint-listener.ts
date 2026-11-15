// The worker's webhook hint listener (task O08, design/ADR-M112 §2.6). One `LISTEN` connection
// outside the pool; each hint makes the poller loop poll that repository at once. When the
// connection drops, it comes back with a growing delay, and every group is polled once then,
// because hints sent meanwhile are lost (the reconciliation poll would find their events later).
import type { GitHint, GitHintSubscription } from '@sdlc/core';

import type { WorkerLogger } from './logger.js';

/** First and longest wait before the listener connects again. */
export const HINT_RETRY_MIN_MS = 1_000;
export const HINT_RETRY_MAX_MS = 30_000;

export interface HintListenerDeps {
  listen(onHint: (hint: GitHint) => void): Promise<GitHintSubscription>;
  onHint(hint: GitHint): void;
  /** Called after the connection came back (not after the first connect). */
  onReconnect(): void;
  readonly logger: WorkerLogger;
  /** Waits `ms`; tests pass their own. Default: a timer. */
  sleep?(ms: number): Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });

export class HintListener {
  readonly #deps: HintListenerDeps;
  #current: GitHintSubscription | undefined;
  #running: Promise<void> | undefined;
  #stopped = false;
  /** Ends the wait before the next connect (on stop). */
  #wake: (() => void) | undefined;

  constructor(deps: HintListenerDeps) {
    this.#deps = deps;
  }

  start(): void {
    this.#running ??= this.#run();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#wake?.();
    await this.#current?.close();
    await this.#running;
  }

  async #run(): Promise<void> {
    const sleep = (ms: number): Promise<void> =>
      this.#deps.sleep ? this.#deps.sleep(ms) : defaultSleep(ms);
    let delay = HINT_RETRY_MIN_MS;
    // Hints may be lost while there is no connection: after a lost connection or a failed
    // connect, every group is polled once. Not at the first connect: the loop polls them at start.
    let missedHints = false;
    while (!this.#stopped) {
      try {
        this.#current = await this.#deps.listen((hint) => {
          this.#deps.onHint(hint);
        });
        if (this.#stopped) {
          await this.#current.close();
          return;
        }
        delay = HINT_RETRY_MIN_MS;
        if (missedHints) this.#deps.onReconnect();
        this.#deps.logger.log('info', 'worker.hints_listening', {});
        const code = await this.#current.ended;
        this.#current = undefined;
        if (this.#stopped) return;
        this.#deps.logger.log('warn', 'worker.hints_lost', { code });
      } catch (error) {
        if (this.#stopped) return;
        this.#deps.logger.log('warn', 'worker.hints_connect_failed', {
          code: errorCode(error),
        });
      }
      missedHints = true;
      if (this.#stopped) return;
      await Promise.race([
        sleep(delay),
        new Promise<void>((resolve) => {
          this.#wake = resolve;
        }),
      ]);
      this.#wake = undefined;
      delay = Math.min(delay * 2, HINT_RETRY_MAX_MS);
    }
  }
}

/** A connection error's code, never its message (it can hold the URL). */
function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : 'unknown';
}
