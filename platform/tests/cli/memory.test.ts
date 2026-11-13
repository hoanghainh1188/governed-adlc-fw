// `adlc memory list|approve|revoke` (X13 PR 1, design/ADR-M74 §2.3, §2.7) against a mocked API:
// the paths and bodies it sends, what it prints, and the usage refusals made without a request.
import { t } from '@sdlc/messages';
import { describe, expect, it } from 'vitest';

import { EXIT } from '../../apps/cli/src/index.js';
import { apiError, useHarness } from './harness.js';

const harness = useHarness();
const PATH = '/v1/projects/shop/memory';
const SET = 'f'.repeat(64);
const COMMIT = 'c'.repeat(40);
const PROJECT = { id: '00000000-0000-4000-8000-000000000001', slug: 'shop' };

const version = (n: number, revoked = false) => ({
  version: n,
  set_sha256: SET,
  commit_sha: COMMIT,
  source: 'cli',
  approved_by: '00000000-0000-4000-8000-0000000000a1',
  pr_number: null,
  intent_id: null,
  run_id: null,
  created_at: '2026-11-13T10:00:00.000Z',
  revoked,
  revoked_at: revoked ? '2026-11-13T11:00:00.000Z' : null,
  revoked_by: revoked ? '00000000-0000-4000-8000-0000000000b1' : null,
  revocation_reason: revoked ? 'poisoned' : null,
});

describe('adlc memory list', () => {
  it('prints the versions, newest first', async () => {
    const h = await harness({
      routes: {
        [`GET ${PATH}`]: {
          status: 200,
          body: { project: PROJECT, versions: [version(2, true), version(1)] },
        },
      },
    });
    expect(await h.run(['memory', 'list', 'shop'])).toBe(EXIT.ok);
    expect(h.out).toEqual([
      t('cli.memory.list_header', { project: 'shop' }),
      t('cli.memory.line_revoked', {
        version: 2,
        reason: 'poisoned',
        source: 'cli',
        set_sha256: SET,
        commit: COMMIT,
        pr: '-',
        created_at: '2026-11-13T10:00:00.000Z',
      }),
      t('cli.memory.line', {
        version: 1,
        reason: '-',
        source: 'cli',
        set_sha256: SET,
        commit: COMMIT,
        pr: '-',
        created_at: '2026-11-13T10:00:00.000Z',
      }),
    ]);
  });

  it('says when there is no version', async () => {
    const h = await harness({
      routes: { [`GET ${PATH}`]: { status: 200, body: { project: PROJECT, versions: [] } } },
    });
    expect(await h.run(['memory', 'list', 'shop'])).toBe(EXIT.ok);
    expect(h.out).toEqual([t('cli.memory.none', { project: 'shop' })]);
  });
});

describe('adlc memory approve', () => {
  const approved = (recorded: boolean, withoutAccount = 0) => ({
    status: 200,
    body: {
      project: PROJECT,
      recorded,
      files: 3,
      commits_without_account: withoutAccount,
      version: version(4),
    },
  });

  it('approves the head of the default branch, or a given commit', async () => {
    const h = await harness({ routes: { [`POST ${PATH}/approve`]: approved(true, 1) } });
    expect(await h.run(['memory', 'approve', 'shop'])).toBe(EXIT.ok);
    expect(await h.run(['memory', 'approve', 'shop', '--commit', COMMIT, '--json'])).toBe(EXIT.ok);
    expect(h.requests.map((r) => r.body)).toEqual([{}, { commit_sha: COMMIT }]);
    const params = { project: 'shop', version: 4, files: 3, set_sha256: SET, commit: COMMIT };
    expect(h.out[0]).toBe(t('cli.memory.approved', params));
    expect(h.out[1]).toBe(t('cli.memory.commits_without_account', { count: 1 }));
    expect(JSON.parse(h.out[2]!)).toMatchObject({ recorded: true, version: { version: 4 } });
  });

  it('says when nothing changed', async () => {
    const h = await harness({ routes: { [`POST ${PATH}/approve`]: approved(false) } });
    expect(await h.run(['memory', 'approve', 'shop'])).toBe(EXIT.ok);
    expect(h.out).toEqual([
      t('cli.memory.unchanged', {
        project: 'shop',
        version: 4,
        files: 3,
        set_sha256: SET,
        commit: COMMIT,
      }),
    ]);
  });

  it('shows a refusal of the server (a producer approves its own change)', async () => {
    const h = await harness({
      routes: { [`POST ${PATH}/approve`]: apiError(409, 'memory_refused', { reason: 'producer' }) },
    });
    expect(await h.run(['memory', 'approve', 'shop'])).toBe(EXIT.failed);
    expect(h.err[0]).toContain('memory_refused');
  });
});

describe('adlc memory revoke', () => {
  it('revokes a version with a reason code', async () => {
    const h = await harness({
      routes: {
        [`POST ${PATH}/versions/2/revoke`]: {
          status: 200,
          body: { project: PROJECT, version: version(2, true) },
        },
      },
    });
    expect(await h.run(['memory', 'revoke', 'shop', '2', '--reason', 'poisoned'])).toBe(EXIT.ok);
    expect(h.requests[0]?.body).toEqual({ reason: 'poisoned' });
    expect(h.out).toEqual([
      t('cli.memory.revoked', { project: 'shop', version: 2, reason: 'poisoned' }),
    ]);
  });
});

describe('usage', () => {
  it.each([
    [['memory']],
    [['memory', 'list']],
    [['memory', 'list', 'Shop']],
    [['memory', 'list', 'shop', 'extra']],
    [['memory', 'show', 'shop']],
    [['memory', 'approve', 'shop', '--commit', 'main']],
    [['memory', 'approve', 'shop', '--force']],
    [['memory', 'revoke', 'shop', '2']],
    [['memory', 'revoke', 'shop', '0', '--reason', 'wrong']],
    [['memory', 'revoke', 'shop', 'two', '--reason', 'wrong']],
    [['memory', 'revoke', 'shop', '2', '--reason', 'because']],
  ])('%j prints the usage and sends nothing', async (argv) => {
    const h = await harness({ routes: {} });
    expect(await h.run(argv)).toBe(EXIT.usage);
    expect(h.err).toEqual([t('cli.memory.usage')]);
    expect(h.requests).toEqual([]);
  });
});
