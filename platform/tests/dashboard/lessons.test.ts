// X08b PR 3 (design/ADR-M109 §2.5, QUESTIONS #728): the lessons screen's model. The filters come
// from the URL and fall back to the person's first project; every code has a catalog label; the
// outcome names a link, a reason or a follow-up intent.
import fs from 'node:fs';
import path from 'node:path';

import { LESSON_CATEGORIES, LESSON_DROP_REASONS, LESSON_TARGETS } from '@sdlc/contracts';
import { describe, expect, it } from 'vitest';

import {
  ageInDays,
  LESSON_CATEGORY_KEYS,
  LESSON_REASON_KEYS,
  LESSON_STATE_KEYS,
  LESSON_TARGET_KEYS,
  lessonFilterOf,
  outcomeOf,
} from '../../apps/dashboard/src/model/lessons.js';
import { href, parseRoute } from '../../apps/dashboard/src/model/route.js';
import { repoRoot } from '../workspace/helpers';

const catalog = JSON.parse(
  fs.readFileSync(path.join(repoRoot(), 'platform/packages/messages/src/locales/en.json'), 'utf8'),
) as Record<string, string>;
const base = {
  id: '00000000-0000-4000-8000-000000000001',
  intent: 'INT-2026-0002',
  project: 'shop',
  category: 'rework',
  target: 'config',
  source: 'api',
  comment_url: 'https://github.com/acme/shop/issues/1#issuecomment-2',
  comment_id: '2',
  recorded_by: '00000000-0000-4000-8000-0000000000a1',
  created_at: '2026-11-10T10:00:00.000Z',
  state: 'open' as const,
  outcome: null,
};
const outcome = (over: object) => ({
  outcome: 'applied' as const,
  link_url: null,
  reason: null,
  follow_up_intent_id: null,
  decided_by: '00000000-0000-4000-8000-0000000000b1',
  created_at: '2026-11-11T10:00:00.000Z',
  ...over,
});

describe('the lessons screen (X08b PR 3)', () => {
  it('routes #/lessons with its query', () => {
    const route = parseRoute('#/lessons?project=shop&open=true');
    expect(route.name).toBe('lessons');
    expect(route.query.get('open')).toBe('true');
    expect(href('lessons', { project: 'shop', open: undefined })).toBe('#/lessons?project=shop');
  });

  it('takes the project of the URL only when it is one of the person', () => {
    const projects = ['pilot', 'shop'];
    expect(lessonFilterOf(new URLSearchParams('project=shop&open=true'), projects)).toEqual({
      project: 'shop',
      open: true,
    });
    expect(lessonFilterOf(new URLSearchParams('project=other&open=yes'), projects)).toEqual({
      project: 'pilot',
      open: false,
    });
    expect(lessonFilterOf(new URLSearchParams(''), []).project).toBeUndefined();
  });

  it('labels every code from the catalog', () => {
    const keys = [
      ...LESSON_CATEGORIES.map((c) => LESSON_CATEGORY_KEYS[c]),
      ...LESSON_TARGETS.map((c) => LESSON_TARGET_KEYS[c]),
      ...LESSON_DROP_REASONS.map((c) => LESSON_REASON_KEYS[c]),
      ...['open', 'applied', 'dropped'].map((c) => LESSON_STATE_KEYS[c]),
    ];
    for (const key of keys) expect(catalog[key!], key).toBeTruthy();
  });

  it('counts whole days, never a negative age', () => {
    const now = new Date('2026-11-14T09:00:00.000Z');
    expect(ageInDays('2026-11-10T10:00:00.000Z', now)).toBe(3);
    expect(ageInDays('2026-11-15T10:00:00.000Z', now)).toBe(0);
    expect(ageInDays('not a time', now)).toBeNull();
  });

  it('the outcome: none, a link, a reason, or a follow-up intent', () => {
    expect(outcomeOf(base)).toEqual({ kind: 'none' });
    const link = 'https://github.com/acme/shop/pull/3';
    expect(outcomeOf({ ...base, state: 'applied', outcome: outcome({ link_url: link }) })).toEqual({
      kind: 'link',
      url: link,
    });
    expect(
      outcomeOf({
        ...base,
        state: 'dropped',
        outcome: outcome({ outcome: 'dropped', reason: 'duplicate' }),
      }),
    ).toEqual({ kind: 'reason', reason: 'duplicate' });
    expect(
      outcomeOf({
        ...base,
        state: 'applied',
        outcome: outcome({ follow_up_intent_id: '00000000-0000-4000-8000-0000000000d1' }),
      }),
    ).toEqual({ kind: 'follow_up' });
  });

  it('the lesson messages ride in the on-demand chunk, the nav label in the first load', () => {
    expect(
      Object.keys(catalog).filter((k) => k.startsWith('dashboard.lessons.')).length,
    ).toBeGreaterThan(30);
    expect(catalog['dashboard.nav.lessons']).toBe('Lessons');
  });
});
