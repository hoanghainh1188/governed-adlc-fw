// Repeated webhook deliveries (task O08, design/ADR-M112 §2.5, QUESTIONS #751): the delivery IDs
// the api has handled, in memory, with a time limit and a size cap. Like the rate limiter, this is
// enough for one api instance. It only saves work: a second hint for the same events starts a
// poll that finds nothing new, so a restart that forgets the IDs is harmless.

/** At most this many IDs are kept; the oldest go first. */
export const MAX_DELIVERY_IDS = 10_000;

export class DeliveryIds {
  /** ID → expiry (ms since the epoch), in insertion order. */
  readonly #ids = new Map<string, number>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
    private readonly max: number = MAX_DELIVERY_IDS,
  ) {}

  /** True when `id` was recorded and has not expired. */
  has(id: string): boolean {
    const expires = this.#ids.get(id);
    return expires !== undefined && expires > this.now();
  }

  /** Records `id` (after its hint was sent). */
  add(id: string): void {
    const now = this.now();
    this.#ids.delete(id);
    this.#ids.set(id, now + this.ttlMs);
    for (const [old, expires] of this.#ids) {
      if (this.#ids.size <= this.max && expires > now) break;
      this.#ids.delete(old);
    }
  }

  get size(): number {
    return this.#ids.size;
  }
}
