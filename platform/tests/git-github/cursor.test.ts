// The polling cursor (design/ADR-M23 §2.3): only times and numeric IDs, deterministic text,
// strict parsing, bounded size, and a lower bound that never lets an item through twice.
import type { EventCursor } from '@sdlc/contracts';
import { describe, expect, it } from 'vitest';

import {
  advance,
  decodeCursor,
  encodeCursor,
  initialState,
  isNew,
  MAX_SEEN,
  oldestCursor,
  type CursorState,
} from '../../packages/adapters/git-github/src/cursor.js';

describe('encode and decode', () => {
  it('round-trips and always gives the same text for the same state', () => {
    const state = {
      comments: {
        t: 100,
        seen: [
          ['12', 130],
          ['11', 120],
        ] as const,
      },
      reviews: { t: 50, seen: [] },
      checks: {
        t: 60,
        seen: [
          ['r5', 60],
          ['s7', 61],
        ] as const,
      },
    };
    const text = encodeCursor(state);
    expect(text).toBe(
      '{"comments":{"seen":[["11",120],["12",130]],"t":100},"reviews":{"seen":[],"t":50},' +
        '"checks":{"seen":[["r5",60],["s7",61]],"t":60},"v":1}',
    );
    const decoded = decodeCursor(text)!;
    expect(encodeCursor(decoded)).toBe(text);
  });

  it('treats the initial cursor as "never polled"', () => {
    expect(decodeCursor('' as EventCursor)).toBeNull();
  });

  it.each([
    ['not JSON', 'x'],
    ['another version', '{"v":2}'],
    ['a missing stream', '{"comments":{"seen":[],"t":1},"reviews":{"seen":[],"t":1},"v":1}'],
    ['an extra key', encodeCursor(initialState(1)).replace('"v":1', '"v":1,"x":1')],
    ['a negative time', encodeCursor(initialState(1)).replace('"t":1', '"t":-1')],
    [
      'a text key',
      encodeCursor({ ...initialState(1), comments: { t: 1, seen: [['free text', 1]] } }),
    ],
    ['a fractional time', encodeCursor(initialState(1)).replace('"t":1', '"t":1.5')],
    ['too long', `${'x'.repeat(70_000)}`],
  ])('refuses %s', (_case, text) => {
    expect(() => decodeCursor(text as EventCursor)).toThrow(
      expect.objectContaining({ code: 'invalid_cursor' }),
    );
  });
});

describe('advance', () => {
  const start = { t: 1000, seen: [] };

  it('trails the newest item by the overlap window and remembers the items inside it', () => {
    const next = advance(
      start,
      [
        { key: '1', at: 1010 },
        { key: '2', at: 1100 },
      ],
      60,
    );
    expect(next).toEqual({ t: 1040, seen: [['2', 1100]] });
    expect(isNew(next, '2', 1100)).toBe(false);
    expect(isNew(next, '1', 1010)).toBe(false); // below the lower bound
    expect(isNew(next, '3', 1050)).toBe(true); // shown late, inside the window
  });

  it('never moves the lower bound back', () => {
    expect(advance({ t: 1000, seen: [] }, [{ key: '1', at: 1001 }], 60).t).toBe(1000);
    expect(advance({ t: 1000, seen: [] }, [], 60)).toEqual({ t: 1000, seen: [] });
  });

  it('stops at a ceiling (items the poll could not reach)', () => {
    expect(advance(start, [{ key: '1', at: 2000 }], 60, 1500).t).toBe(1500);
    expect(advance(start, [{ key: '1', at: 2000 }], 60, 900).t).toBe(1000);
  });

  it(`keeps at most ${MAX_SEEN} items and moves the lower bound past the dropped ones`, () => {
    const many = Array.from({ length: MAX_SEEN + 10 }, (_, i) => ({
      key: String(i),
      at: 1000 + i,
    }));
    const next = advance(start, many, 3600);
    expect(next.seen.length).toBeLessThanOrEqual(MAX_SEEN);
    // Every dropped item is below the new lower bound, so none can come back.
    const kept = new Set(next.seen.map(([k]) => k));
    for (const item of many) {
      if (!kept.has(item.key)) expect(isNew(next, item.key, item.at)).toBe(false);
    }
  });
});

describe('oldestCursor (O06 PR 2c, ADR-M106 §2.4)', () => {
  const state = (comments: CursorState['comments']): CursorState => ({
    comments,
    reviews: { t: 50, seen: [] },
    checks: { t: 50, seen: [] },
  });
  const ahead = encodeCursor(
    state({
      t: 120,
      seen: [
        ['3', 125],
        ['4', 130],
      ],
    }),
  );
  const behind = encodeCursor(
    state({
      t: 100,
      seen: [
        ['1', 100],
        ['2', 110],
        ['3', 125],
      ],
    }),
  );

  it('takes the smallest lower bound and keeps only items every cursor handled', () => {
    const merged = decodeCursor(oldestCursor([ahead, behind]))!;
    // 1 and 2 are older than the first cursor's bound, 3 both saw; 4 only the first one saw.
    expect(merged.comments).toEqual({
      t: 100,
      seen: [
        ['1', 100],
        ['2', 110],
        ['3', 125],
      ],
    });
    expect(isNew(merged.comments, '4', 130)).toBe(true);
    expect(oldestCursor([behind, ahead])).toBe(oldestCursor([ahead, behind]));
  });

  it('never returns fewer items than a read from any of the cursors', () => {
    const merged = decodeCursor(oldestCursor([ahead, behind]))!;
    for (const cursor of [ahead, behind]) {
      const own = decodeCursor(cursor)!.comments;
      for (const [key, at] of [
        ['1', 100],
        ['2', 110],
        ['3', 125],
        ['4', 130],
        ['5', 140],
      ] as const) {
        if (isNew(own, key, at)) expect(isNew(merged.comments, key, at), key).toBe(true);
      }
    }
  });

  it('one cursor is returned as it is; a project never polled is left out', () => {
    expect(oldestCursor([ahead])).toBe(ahead);
    expect(oldestCursor(['' as EventCursor, ahead])).toBe(ahead);
    expect(oldestCursor(['' as EventCursor])).toBe('');
    expect(oldestCursor([])).toBe('');
  });

  it('refuses a cursor it cannot read', () => {
    expect(() => oldestCursor([ahead, '{"v":2}' as EventCursor])).toThrow();
  });
});
