// H03c: `adlc client …` against a mocked API, and the ops client-data-deletion parser.
import { t } from '@sdlc/messages';
import { describe, expect, it } from 'vitest';

import { parseClientDataDeletionCommand } from '../../apps/cli/src/commands/ops-client-data-deletion.js';
import { EXIT } from '../../apps/cli/src/index.js';
import { apiError, useHarness } from './harness.js';

const harness = useHarness();

const VIEW = {
  tenant_id: '00000000-0000-4000-8000-000000000001',
  tenant_slug: 'acme',
  tenant_status: 'active',
  phase: 'requested',
  requested_by: '11111111-2222-4333-8444-555555555555',
  requested_at: '2026-11-10T12:00:00.000Z',
  grace_period_days: 14,
  legal_basis: 'contract_offboarding',
  operator_id: null,
  approved_at: null,
  cancelled_by: null,
  cancelled_at: null,
};

describe('adlc client data-deletion', () => {
  it('requests with an optional basis and prints the catalog line', async () => {
    const h = await harness({
      routes: {
        'POST /v1/client/data-deletion': { status: 201, body: VIEW },
      },
    });
    expect(await h.run(['client', 'request-data-deletion', '--basis', 'appi_article_34'])).toBe(
      EXIT.ok,
    );
    expect(h.requests[0]?.body).toEqual({ legal_basis: 'appi_article_34' });
    expect(h.out).toEqual([
      t('cli.client.requested', {
        tenant: 'acme',
        phase: 'requested',
        status: 'active',
        grace: '14',
      }),
    ]);
  });

  it('cancels and shows status; refuses a bad basis', async () => {
    const cancelled = {
      ...VIEW,
      phase: 'cancelled',
      cancelled_by: VIEW.requested_by,
      cancelled_at: '2026-11-10T13:00:00.000Z',
    };
    const h = await harness({
      routes: {
        'DELETE /v1/client/data-deletion': { status: 200, body: cancelled },
        'GET /v1/client/data-deletion': { status: 200, body: cancelled },
      },
    });
    expect(await h.run(['client', 'cancel-data-deletion'])).toBe(EXIT.ok);
    expect(await h.run(['client', 'status', '--json'])).toBe(EXIT.ok);
    expect(JSON.parse(h.out[1]!)).toMatchObject({ phase: 'cancelled' });
    expect(await h.run(['client', 'request-data-deletion', '--basis', 'not a code'])).toBe(
      EXIT.usage,
    );
  });

  it('shows the API refusal from the catalog', async () => {
    const h = await harness({
      routes: {
        'POST /v1/client/data-deletion': apiError(409, 'already_exists'),
      },
    });
    expect(await h.run(['client', 'request-data-deletion'])).toBe(EXIT.failed);
  });
});

describe('adlc ops client-data-deletion (parser)', () => {
  it('needs tenant+operator UUID for approve; list needs none', () => {
    expect(parseClientDataDeletionCommand(['list'])).toMatchObject({
      command: 'list',
      needsTenant: false,
    });
    expect(
      parseClientDataDeletionCommand([
        'approve',
        '--tenant',
        'acme',
        '--operator',
        '11111111-2222-4333-8444-555555555555',
      ]),
    ).toMatchObject({ command: 'approve', needsTenant: true });
    expect(
      parseClientDataDeletionCommand(['approve', '--tenant', 'acme', '--operator', 'not-a-uuid']),
    ).toBeUndefined();
    expect(parseClientDataDeletionCommand(['status'])).toBeUndefined();
    expect(parseClientDataDeletionCommand(['status', '--tenant', 'acme'])).toMatchObject({
      command: 'status',
    });
  });
});
