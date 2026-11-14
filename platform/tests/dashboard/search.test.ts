// X08a PR 2 (ADR-M109 §2.1): the board's search filters as the URL holds them. Each value is
// checked like the API checks it; one that would be refused is left out, never sent.
import { describe, expect, it } from 'vitest';

import { apiPath } from '../../apps/dashboard/src/api/client.js';
import { isDay, isSearching, searchOf, searchText } from '../../apps/dashboard/src/model/search.js';

const of = (query: string) => searchOf(new URLSearchParams(query));

describe('the board search (X08a PR 2)', () => {
  it('keeps the valid filters of the URL', () => {
    expect(
      of(
        'q=%20h%E1%BB%A7y%20%C4%91%C6%A1n%20&gate=G3&risk_tier=high&created_from=2026-11-01' +
          '&created_to=2026-11-30&closed_from=2026-11-02&closed_to=2026-11-03&sealed=false&show=x',
      ),
    ).toEqual({
      q: 'hủy đơn',
      gate: 'G3',
      risk_tier: 'high',
      created_from: '2026-11-01',
      created_to: '2026-11-30',
      closed_from: '2026-11-02',
      closed_to: '2026-11-03',
      sealed: 'false',
    });
  });

  it('leaves out a value the API would refuse', () => {
    expect(
      of(`q=x&gate=G9&risk_tier=huge&created_from=2026-02-30&closed_to=1%20Nov&sealed=yes`),
    ).toEqual({});
    expect(of(`q=${'a'.repeat(201)}`)).toEqual({});
    expect(isDay('2026-02-28')).toBe(true);
    expect(isDay('2026-02-29')).toBe(false);
    expect(searchText('  ab ')).toBe('ab');
    expect(searchText(' a ')).toBeUndefined();
  });

  it('searching means at least one filter; the project and the open/finished switch are not', () => {
    expect(isSearching(of('project=shop&show=finished'))).toBe(false);
    expect(isSearching(of('sealed=true'))).toBe(true);
  });

  it('sends the filters as query parameters of GET /v1/intents', () => {
    expect(apiPath('/v1/intents', { project: 'shop', ...of('q=a%26b&gate=G1'), limit: 100 })).toBe(
      '/v1/intents?project=shop&q=a%26b&gate=G1&limit=100',
    );
  });
});
