// `adlc break-glass request|approve|refuse|revoke|review|list` and `adlc ops break-glass` parsing
// (H08 PR 3a, design/ADR-M111 §2.9, QUESTIONS #742) against a mocked API: the paths and bodies
// sent, what is printed, and the usage refusals made without a request.
import { t } from '@sdlc/messages';
import { describe, expect, it } from 'vitest';

import { scopesOf } from '../../apps/cli/src/commands/break-glass.js';
import { parseBreakGlassCommand } from '../../apps/cli/src/commands/ops-break-glass.js';
import { EXIT } from '../../apps/cli/src/index.js';
import { apiError, useHarness } from './harness.js';

const harness = useHarness();
const INT = 'INT-2026-0042';
const REASON = 'https://github.com/acme/shop/issues/42#issuecomment-123';
const REVIEW = 'https://github.com/acme/shop/issues/42#issuecomment-456';

const grant = (status = 'requested', extra: object = {}) => ({
  id: '00000000-0000-4000-8000-0000000000c1',
  intent: INT,
  project: 'shop',
  status,
  scopes: ['runner_priority', 'budget'],
  duration_seconds: 7200,
  budget_increase_usd: '5.000000',
  reason_url: REASON,
  operator_id: '00000000-0000-4000-8000-0000000000a1',
  approver_id: status === 'requested' ? null : '00000000-0000-4000-8000-0000000000b1',
  incident: status === 'requested' ? null : 'ESC-2026-0007',
  created_at: '2026-11-15T03:00:00.000Z',
  lapses_at: '2026-11-15T03:30:00.000Z',
  decided_at: status === 'requested' ? null : '2026-11-15T03:05:00.000Z',
  expires_at: status === 'requested' ? null : '2026-11-15T05:05:00.000Z',
  ended_at: null,
  revoked_by: null,
  review_url: null,
  reviewed_by: null,
  reviewed_at: null,
  review_overdue_at: null,
  ...extra,
});

describe('adlc break-glass request', () => {
  it('sends the scope codes in the API words, the hours, the link and the amount', async () => {
    const h = await harness({
      routes: { [`POST /v1/intents/${INT}/break-glass`]: { status: 201, body: grant() } },
    });
    const argv = ['break-glass', 'request', 'int-2026-0042', '--scope', 'Runner-Priority,budget'];
    expect(
      await h.run([...argv, '--hours', '2', '--reason', REASON, '--budget-increase', '5']),
    ).toBe(EXIT.ok);
    expect(h.requests[0]?.body).toEqual({
      scopes: ['runner_priority', 'budget'],
      hours: 2,
      reason_url: REASON,
      budget_increase_usd: '5',
    });
    expect(h.out[0]).toContain(INT);
    expect(h.out[0]).toContain('adlc break-glass approve');
  });

  it('shows the refusal of the server', async () => {
    const h = await harness({
      routes: {
        [`POST /v1/intents/${INT}/break-glass`]: apiError(409, 'break_glass_refused', {
          reason: 'scope_invalid',
        }),
      },
    });
    const argv = ['break-glass', 'request', INT, '--scope', 'budget', '--hours', '1'];
    expect(await h.run([...argv, '--reason', REASON, '--budget-increase', '1'])).toBe(EXIT.failed);
    expect(h.err[0]).toContain('break_glass_refused');
  });
});

describe('adlc break-glass approve|refuse|revoke|review|list', () => {
  it('posts each decision to its path with an empty body', async () => {
    const h = await harness({
      routes: {
        [`POST /v1/intents/${INT}/break-glass/approve`]: { status: 200, body: grant('active') },
        [`POST /v1/intents/${INT}/break-glass/refuse`]: { status: 200, body: grant('refused') },
        [`POST /v1/intents/${INT}/break-glass/revoke`]: { status: 200, body: grant('revoked') },
      },
    });
    expect(await h.run(['break-glass', 'approve', INT])).toBe(EXIT.ok);
    expect(await h.run(['break-glass', 'refuse', INT, '--json'])).toBe(EXIT.ok);
    expect(await h.run(['break-glass', 'revoke', INT])).toBe(EXIT.ok);
    expect(h.requests.map((r) => [r.url.pathname, r.body])).toEqual([
      [`/v1/intents/${INT}/break-glass/approve`, {}],
      [`/v1/intents/${INT}/break-glass/refuse`, {}],
      [`/v1/intents/${INT}/break-glass/revoke`, {}],
    ]);
    expect(h.out[0]).toContain('ESC-2026-0007');
    expect(JSON.parse(h.out[1]!)).toMatchObject({ status: 'refused' });
    expect(h.out[2]).toContain('adlc break-glass review');
  });

  it('review sends the comment link; list prints one line per grant', async () => {
    const reviewed = grant('revoked', { review_url: REVIEW });
    const h = await harness({
      routes: {
        [`POST /v1/intents/${INT}/break-glass/review`]: { status: 200, body: reviewed },
        'GET /v1/break-glass': { status: 200, body: { items: [reviewed, grant()] } },
      },
    });
    expect(await h.run(['break-glass', 'review', INT, '--comment', REVIEW])).toBe(EXIT.ok);
    expect(await h.run(['break-glass', 'list', '--project', 'shop', '--open'])).toBe(EXIT.ok);
    expect(h.requests[0]?.body).toEqual({ comment_url: REVIEW });
    expect(Object.fromEntries(h.requests[1]!.url.searchParams)).toEqual({
      project: 'shop',
      open: 'true',
    });
    expect(h.out[0]).toContain(REVIEW);
    expect(h.out.slice(1)).toEqual([
      t('cli.break_glass.list_header'),
      expect.stringContaining('revoked'),
      expect.stringContaining('requested'),
    ]);
  });
});

describe('usage', () => {
  it.each([
    ['break-glass'],
    ['break-glass', 'merge', INT],
    ['break-glass', 'request', INT, '--scope', 'merge', '--hours', '1', '--reason', REASON],
    ['break-glass', 'request', INT, '--scope', 'budget', '--hours', '9', '--reason', REASON],
    ['break-glass', 'request', INT, '--scope', 'budget', '--hours', '0', '--reason', REASON],
    ['break-glass', 'request', INT, '--scope', 'budget', '--hours', '1'],
    ['break-glass', 'request', INT, '--scope', 'budget', '--hours', '1', '--reason', 'http://x'],
    [
      'break-glass',
      'request',
      INT,
      '--scope',
      'budget',
      '--hours',
      '1',
      '--reason',
      REASON,
      '--budget-increase',
      '1.1234567',
    ],
    ['break-glass', 'approve', 'INT-42'],
    ['break-glass', 'review', INT],
    ['break-glass', 'list', '--project', 'Shop!'],
  ])('%j prints the usage and sends nothing', async (...argv) => {
    const h = await harness();
    expect(await h.run(argv)).toBe(EXIT.usage);
    expect(h.err).toEqual([t('cli.break_glass.usage')]);
    expect(h.requests).toEqual([]);
  });

  it('reads scopes in the API words and refuses unknown ones', () => {
    expect(scopesOf('runner-priority, BUDGET')).toEqual(['runner_priority', 'budget']);
    expect(scopesOf('budget,merge')).toBeUndefined();
    expect(scopesOf('')).toBeUndefined();
  });
});

describe('adlc ops break-glass (operator, never request or approve)', () => {
  it('parses list and revoke only', () => {
    expect(parseBreakGlassCommand(['list', '--tenant', 'internal', '--open'])).toMatchObject({
      command: 'list',
      values: { tenant: 'internal', open: true },
    });
    expect(
      parseBreakGlassCommand(['revoke', '--tenant', 'internal', '--intent', 'int-2026-0042']),
    ).toMatchObject({ command: 'revoke', values: { intent: INT } });
    for (const args of [
      ['request', '--tenant', 'internal', '--intent', INT],
      ['approve', '--tenant', 'internal', '--intent', INT],
      ['revoke', '--tenant', 'internal'],
      ['revoke', '--intent', INT],
      ['list', '--tenant', 'internal', '--project', 'Bad Slug'],
    ]) {
      expect(parseBreakGlassCommand(args), args.join(' ')).toBeUndefined();
    }
  });
});
