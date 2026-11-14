// `adlc lesson add|apply|drop|issue|list`, `adlc lessons list`, `adlc metrics lessons` and the
// lesson options of `adlc intent` (X08b PR 2, design/ADR-M109 §2.3–§2.5, QUESTIONS #727) against a
// mocked API: the paths and bodies sent, what is printed, and the usage refusals made without a
// request. `lesson issue` prints a link with codes and the comment link only.
import { t } from '@sdlc/messages';
import { describe, expect, it } from 'vitest';

import { handbookIssueUrl, HANDBOOK_REPO } from '../../apps/cli/src/commands/lesson.js';
import { EXIT } from '../../apps/cli/src/index.js';
import { apiError, useHarness } from './harness.js';

const harness = useHarness();
const ID = '00000000-0000-4000-8000-0000000000c1';
const COMMENT = 'https://github.com/acme/shop/issues/42#issuecomment-123';

const lesson = (state: 'open' | 'applied' | 'dropped' = 'open') => ({
  id: ID,
  intent: 'INT-2026-0042',
  project: 'shop',
  category: 'agent_assumption',
  target: 'handbook',
  source: 'api',
  comment_url: COMMENT,
  comment_id: '123',
  recorded_by: '00000000-0000-4000-8000-0000000000a1',
  created_at: '2026-11-01T10:00:00.000Z',
  state,
  outcome:
    state === 'open'
      ? null
      : {
          outcome: state,
          link_url: state === 'applied' ? 'https://github.com/acme/shop/pull/9' : null,
          reason: state === 'dropped' ? 'duplicate' : null,
          follow_up_intent_id: null,
          decided_by: '00000000-0000-4000-8000-0000000000b1',
          created_at: '2026-11-02T10:00:00.000Z',
        },
});

describe('adlc lesson add', () => {
  it('sends the codes in the API words and the comment link', async () => {
    const h = await harness({
      routes: { 'POST /v1/intents/INT-2026-0042/lessons': { status: 201, body: lesson() } },
    });
    const argv = ['lesson', 'add', 'int-2026-0042', '--category', 'Agent-Assumption'];
    expect(await h.run([...argv, '--target', 'handbook', '--comment', COMMENT])).toBe(EXIT.ok);
    expect(h.requests[0]?.body).toEqual({
      category: 'agent_assumption',
      target: 'handbook',
      comment_url: COMMENT,
    });
    expect(h.out[0]).toContain(ID);
    expect(h.out[0]).toContain(COMMENT);
  });

  it('shows the refusal of the server', async () => {
    const h = await harness({
      routes: {
        'POST /v1/intents/INT-2026-0042/lessons': apiError(409, 'lesson_refused', {
          reason: 'window_closed',
        }),
      },
    });
    const argv = ['lesson', 'add', 'INT-2026-0042', '--category', 'gate', '--target', 'none'];
    expect(await h.run([...argv, '--comment', COMMENT])).toBe(EXIT.failed);
    expect(h.err[0]).toContain('lesson_refused');
  });
});

describe('adlc lesson apply|drop', () => {
  it('apply sends the link; drop sends the reason code', async () => {
    const h = await harness({
      routes: {
        [`POST /v1/lessons/${ID}/apply`]: { status: 200, body: lesson('applied') },
        [`POST /v1/lessons/${ID}/drop`]: { status: 200, body: lesson('dropped') },
      },
    });
    const link = 'https://github.com/acme/shop/pull/9';
    expect(await h.run(['lesson', 'apply', ID, '--link', link])).toBe(EXIT.ok);
    expect(await h.run(['lesson', 'drop', ID, '--reason', 'duplicate', '--json'])).toBe(EXIT.ok);
    expect(h.requests.map((r) => r.body)).toEqual([{ link_url: link }, { reason: 'duplicate' }]);
    expect(h.out[0]).toContain('applied');
    expect(h.out[0]).toContain(link);
    expect(JSON.parse(h.out[1]!)).toMatchObject({ state: 'dropped' });
  });
});

describe('adlc lesson issue (QUESTIONS #727)', () => {
  it('prints a new-issue link with codes and the comment link only', async () => {
    const h = await harness({
      routes: { [`GET /v1/lessons/${ID}`]: { status: 200, body: lesson() } },
    });
    expect(await h.run(['lesson', 'issue', ID])).toBe(EXIT.ok);
    const url = new URL(h.out[0]!.split('\n').at(-1)!);
    expect(`${url.origin}${url.pathname}`).toBe(`https://github.com/${HANDBOOK_REPO}/issues/new`);
    expect(url.searchParams.get('labels')).toBe('handbook');
    expect(url.searchParams.get('title')).toContain('INT-2026-0042');
    const body = url.searchParams.get('body') ?? '';
    for (const part of ['agent_assumption', 'handbook', ID, COMMENT]) expect(body).toContain(part);
    expect(h.requests.map((r) => r.method)).toEqual(['GET']);
  });

  it('another repository with --repo', () => {
    expect(handbookIssueUrl('acme/handbook', lesson())).toMatch(
      /^https:\/\/github\.com\/acme\/handbook\/issues\/new\?/,
    );
  });
});

describe('adlc lessons list and adlc lesson list', () => {
  it('sends the filters and prints one line per lesson', async () => {
    const h = await harness({
      routes: {
        'GET /v1/lessons': { status: 200, body: { items: [lesson(), lesson('dropped')] } },
      },
    });
    expect(
      await h.run(['lessons', 'list', '--project', 'shop', '--open', '--since', '2026-11-01']),
    ).toBe(EXIT.ok);
    const query = h.requests[0]!.url.searchParams;
    expect([query.get('project'), query.get('open'), query.get('since')]).toEqual([
      'shop',
      'true',
      '2026-11-01',
    ]);
    expect(h.out[0]).toBe(t('cli.lesson.list_header'));
    expect(h.out).toHaveLength(3);
    expect(h.out[2]).toContain('dropped');
    expect(h.out[2]).toContain('duplicate');
    expect(await h.run(['lesson', 'list', '--json'])).toBe(EXIT.ok);
    expect(JSON.parse(h.out[3]!)).toMatchObject({ items: [{ id: ID }, { id: ID }] });
  });

  it('says when there is none', async () => {
    const h = await harness({
      routes: { 'GET /v1/lessons': { status: 200, body: { items: [] } } },
    });
    expect(await h.run(['lessons', 'list'])).toBe(EXIT.ok);
    expect(h.out).toEqual([t('cli.lesson.none')]);
  });
});

describe('adlc metrics lessons', () => {
  it('prints the counts', async () => {
    const h = await harness({
      routes: {
        'GET /v1/metrics/lessons': {
          status: 200,
          body: {
            recorded: 3,
            open: 1,
            applied: 1,
            dropped: 1,
            by_category: { rework: 1, gate: 2 },
            by_target: { none: 3 },
            median_days_to_outcome: 2.5,
          },
        },
      },
    });
    expect(await h.run(['metrics', 'lessons', '--project', 'shop'])).toBe(EXIT.ok);
    expect(h.requests[0]!.url.searchParams.get('project')).toBe('shop');
    expect(h.out).toEqual([
      t('cli.metrics.lessons', { recorded: 3, open: 1, applied: 1, dropped: 1, median: 2.5 }),
      t('cli.metrics.lessons_by', { categories: 'gate 2, rework 1', targets: 'none 3' }),
    ]);
  });
});

describe('adlc intent and lessons', () => {
  const intent = {
    id: '00000000-0000-4000-8000-0000000000d1',
    code: 'INT-2026-0050',
    project: 'shop',
    title: 'Fix',
    status: 'draft',
    risk_tier: 'low',
    data_class: 'internal',
  };

  it('create --from-lesson takes the project of the lesson and sends from_lesson', async () => {
    const h = await harness({
      routes: {
        [`GET /v1/lessons/${ID}`]: { status: 200, body: lesson() },
        'POST /v1/intents': { status: 201, body: intent },
      },
    });
    const argv = ['intent', 'create', '--title', 'Fix', '--risk', 'low'];
    await h.run([...argv, '--data-class', 'internal', '--from-lesson', ID, '--json']);
    const post = h.requests.find((r) => r.method === 'POST');
    expect(post?.body).toMatchObject({ project: 'shop', from_lesson: ID, title: 'Fix' });
  });

  it('list --has-lessons yes|no sends has_lessons', async () => {
    const h = await harness({
      routes: { 'GET /v1/intents': { status: 200, body: { items: [], next_cursor: null } } },
    });
    expect(await h.run(['intent', 'list', '--has-lessons', 'yes'])).toBe(EXIT.ok);
    expect(await h.run(['intent', 'list', '--has-lessons', 'no'])).toBe(EXIT.ok);
    expect(h.requests.map((r) => r.url.searchParams.get('has_lessons'))).toEqual(['true', 'false']);
    expect(await h.run(['intent', 'list', '--has-lessons', 'maybe'])).toBe(EXIT.usage);
    expect(h.requests).toHaveLength(2);
  });
});

describe('usage', () => {
  it.each([
    [['lesson']],
    [['lesson', 'show', ID]],
    [['lesson', 'add', 'INT-2026-0042', '--category', 'gate', '--target', 'none']],
    [['lesson', 'add', 'X-1', '--category', 'gate', '--target', 'none', '--comment', COMMENT]],
    [
      [
        'lesson',
        'add',
        'INT-2026-0042',
        '--category',
        'mood',
        '--target',
        'none',
        '--comment',
        COMMENT,
      ],
    ],
    [
      [
        'lesson',
        'add',
        'INT-2026-0042',
        '--category',
        'gate',
        '--target',
        'wiki',
        '--comment',
        COMMENT,
      ],
    ],
    [
      [
        'lesson',
        'add',
        'INT-2026-0042',
        '--category',
        'gate',
        '--target',
        'none',
        '--comment',
        'http://x',
      ],
    ],
    [['lesson', 'apply', ID]],
    [['lesson', 'apply', 'not-an-id', '--link', 'https://x.example']],
    [['lesson', 'apply', ID, '--link', 'ftp://x']],
    [['lesson', 'drop', ID, '--reason', 'boring']],
    [['lesson', 'issue', ID, '--repo', 'no slash']],
    [['lessons', 'show']],
    [['lessons', 'list', '--since', 'yesterday']],
    [['lessons', 'list', '--project', 'Shop']],
  ])('%j prints the usage and sends nothing', async (argv) => {
    const h = await harness({ routes: {} });
    expect(await h.run(argv)).toBe(EXIT.usage);
    expect(h.err).toEqual([t('cli.lesson.usage')]);
    expect(h.requests).toEqual([]);
  });
});
