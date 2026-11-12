// The polling cursor (D-08 B05 AC2, design/ADR-M23 §2.3). Stored by the caller in
// `git_event_cursors.cursor` (B06). It holds only times (Unix seconds from GitHub's clock) and
// numeric IDs, never text from GitHub.
//
// One stream per kind of event. `t` is the lower bound: items older than `t` were handled.
// Each poll reads from `t`, which trails the newest handled item by the overlap window, so items
// that GitHub shows a little late are still found. `seen` holds the items handled inside the
// window, so no item is returned twice.
import { GitHostError, type EventCursor } from '@sdlc/contracts';

export const STREAMS = ['comments', 'reviews', 'checks'] as const;
export type Stream = (typeof STREAMS)[number];

export interface StreamState {
  /** Lower bound, Unix seconds. */
  readonly t: number;
  /** `[item key, Unix seconds]` of items handled at or after `t`. */
  readonly seen: readonly (readonly [string, number])[];
}

export type CursorState = Readonly<Record<Stream, StreamState>>;

export interface Handled {
  readonly key: string;
  /** Unix seconds. */
  readonly at: number;
}

const VERSION = 1;
/** Items remembered per stream. Above this, the lower bound moves up (ADR-M23 §2.3). */
export const MAX_SEEN = 500;
const MAX_CURSOR_CHARS = 64 * 1024;
// `r`/`s`: check runs and statuses; `p`: closed pull requests (E01).
const KEY = /^[prs]?[0-9]{1,20}$/;

export const toSeconds = (iso: string): number => Math.floor(new Date(iso).getTime() / 1000);

export function initialState(serverNowSeconds: number): CursorState {
  const empty: StreamState = { t: serverNowSeconds, seen: [] };
  return { comments: empty, reviews: empty, checks: empty };
}

export function encodeCursor(state: CursorState): EventCursor {
  // Fixed key order, so the same state always gives the same text.
  const streams = STREAMS.map(
    (s) =>
      `"${s}":{"seen":${JSON.stringify(
        [...state[s].seen].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])),
      )},"t":${state[s].t}}`,
  );
  return `{${streams.join(',')},"v":${VERSION}}` as EventCursor;
}

function invalid(): never {
  throw new GitHostError('invalid_cursor');
}

const isSeconds = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/** The state of a stored cursor, or null for a project never polled. Never resets silently. */
export function decodeCursor(cursor: EventCursor): CursorState | null {
  if (cursor === '') return null;
  if (typeof cursor !== 'string' || cursor.length > MAX_CURSOR_CHARS) invalid();
  let raw: unknown;
  try {
    raw = JSON.parse(cursor);
  } catch {
    invalid();
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) invalid();
  const record = raw as Record<string, unknown>;
  if (record.v !== VERSION || Object.keys(record).length !== STREAMS.length + 1) invalid();
  const state = {} as Record<Stream, StreamState>;
  for (const s of STREAMS) {
    const stream = record[s] as Record<string, unknown> | undefined;
    if (typeof stream !== 'object' || stream === null || !isSeconds(stream.t)) invalid();
    if (!Array.isArray(stream.seen) || stream.seen.length > MAX_SEEN) invalid();
    const seen = stream.seen.map((entry: unknown) => {
      if (
        !Array.isArray(entry) ||
        entry.length !== 2 ||
        typeof entry[0] !== 'string' ||
        !KEY.test(entry[0]) ||
        !isSeconds(entry[1])
      ) {
        invalid();
      }
      return [entry[0], entry[1]] as const;
    });
    state[s] = { t: stream.t, seen };
  }
  return state;
}

/** True when the item is new: not older than the lower bound, not handled before. */
export function isNew(stream: StreamState, key: string, at: number): boolean {
  return at >= stream.t && !stream.seen.some(([k]) => k === key);
}

/**
 * The stream after a poll. `ceiling` (Unix seconds) keeps the lower bound from passing items the
 * poll could not reach (page limit).
 */
export function advance(
  stream: StreamState,
  handled: readonly Handled[],
  overlapSeconds: number,
  ceiling?: number,
): StreamState {
  let t = stream.t;
  if (handled.length > 0) {
    const newest = Math.max(...handled.map((h) => h.at));
    t = Math.max(t, newest - overlapSeconds);
  }
  if (ceiling !== undefined) t = Math.max(stream.t, Math.min(t, ceiling));
  const byKey = new Map<string, number>(stream.seen.map(([k, at]) => [k, at]));
  for (const h of handled) byKey.set(h.key, h.at);
  let seen = [...byKey.entries()].filter(([, at]) => at >= t);
  if (seen.length > MAX_SEEN) {
    // Keep the newest items. Everything at or before the first dropped second was handled, so the
    // lower bound moves past it; nothing is returned twice.
    seen.sort((a, b) => b[1] - a[1]);
    const cutoff = seen[MAX_SEEN]![1];
    t = cutoff + 1;
    seen = seen.filter(([, at]) => at > cutoff);
  }
  return { t, seen };
}

/** True when the cursor's stream counts the item as handled: older than `t`, or seen. */
const handledIn = (stream: StreamState, key: string, at: number): boolean =>
  at < stream.t || stream.seen.some(([k]) => k === key);

/**
 * A cursor that is never newer than any of `cursors` (task O06 PR 2c, ADR-M106 §2.4): reading from
 * it returns every item that a read from any of them would return; an item may come again to a
 * project that handled it (the caller is idempotent by event ID). Per stream, the lower bound is the
 * smallest one, and an item stays seen only when every cursor counts it as handled. The seen items
 * all come from the cursor with the smallest bound, so the list stays within `MAX_SEEN`. A cursor
 * of a project never polled (`''`) is left out; with no other cursor the result is `''`.
 */
export function oldestCursor(cursors: readonly EventCursor[]): EventCursor {
  const states = cursors.map(decodeCursor).filter((s): s is CursorState => s !== null);
  if (states.length === 0) return '' as EventCursor;
  const merged = {} as Record<Stream, StreamState>;
  for (const s of STREAMS) {
    const streams = states.map((state) => state[s]);
    const t = Math.min(...streams.map((stream) => stream.t));
    const seen = new Map<string, number>();
    for (const stream of streams) {
      for (const [key, at] of stream.seen) {
        if (at >= t && streams.every((other) => handledIn(other, key, at))) seen.set(key, at);
      }
    }
    merged[s] = { t, seen: [...seen.entries()] };
  }
  return encodeCursor(merged);
}
