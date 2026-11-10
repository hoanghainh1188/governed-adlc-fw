// D-08 H03c on a live PostgreSQL through the Nest app: request → approve → pending_deletion;
// cancel restores active; non-admin 403; requester cannot approve; token still works for cancel
// when pending_deletion (ADR-M97 §2.4).
import { afterAll, beforeAll, expect, it } from 'vitest';
import { t, type MessageKey } from '@sdlc/messages';

import { createApp, type ApiDeps } from '../../../apps/api/src/app.js';
import { bootstrapTenant } from '../../../packages/core/src/admin/bootstrap.js';
import { grantTenantRole } from '../../../packages/core/src/admin/tenant-roles.js';
import { issueApiToken } from '../../../packages/core/src/admin/tokens.js';
import {
  approveDeletion,
  requestDeletion,
} from '../../../packages/core/src/client-data/deletion.js';
import { hashApiToken } from '../../../packages/core/src/db/repositories/api-tokens.js';
import { parseTenantId } from '../../../packages/core/src/db/tenant-id.js';
import type { TenantScope } from '../../../packages/core/src/db/tenant-scope.js';
import { createJsonLogger } from '../../../packages/core/src/observability/index.js';
import { tokenIssuedAt } from '../token-clock.js';
import { createTestDatabase, describeDb, type TestDatabase } from './helpers.js';

type App = Awaited<ReturnType<typeof createApp>>;
const asApiDb = (db: TestDatabase): ApiDeps['db'] => db.app as unknown as ApiDeps['db'];

interface Body {
  readonly [field: string]: unknown;
  readonly error: { readonly code: string; readonly message: string; readonly reason?: string };
}

interface Reply {
  readonly statusCode: number;
  json(): Body;
}

interface Seeded {
  readonly slug: string;
  readonly scope: TenantScope;
  readonly adminId: string;
  readonly adminToken: string;
  readonly otherId: string;
  readonly otherToken: string;
  readonly nonAdminToken: string;
}

describeDb('H03c: client data deletion commands on PostgreSQL', () => {
  let t0: TestDatabase;
  let app: App;
  const lines: string[] = [];
  let n = 0;

  const inject = async (
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    token: string,
    body?: unknown,
  ): Promise<Reply> =>
    await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method,
        url,
        headers: { authorization: `Bearer ${token}` },
        ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
      });

  const ok = (reply: Reply, status = 200): Body => {
    expect(reply.statusCode, JSON.stringify(reply.json())).toBe(status);
    return reply.json();
  };

  const refused = (reply: Reply, status: number, code: string): Body['error'] => {
    expect(reply.statusCode, JSON.stringify(reply.json())).toBe(status);
    const error = reply.json().error;
    expect(error.code).toBe(code);
    expect(error.message).toBe(t(`api.error.${code}` as MessageKey));
    return error;
  };

  beforeAll(async () => {
    t0 = await createTestDatabase();
    app = await createApp({
      db: asApiDb(t0),
      settings: { rateLimitPerMinute: 10_000, authFailuresPerMinute: 10_000 },
      now: () => new Date('2026-11-10T12:00:00.000Z'),
      logger: { error: (...args: unknown[]) => lines.push(args.map(String).join(' ')) },
      log: createJsonLogger({ write: (line) => lines.push(line) }),
    });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await t0?.drop();
  });

  async function seed(): Promise<Seeded> {
    const slug = `h03c-${++n}`;
    const result = await bootstrapTenant(t0.app, {
      tenantSlug: slug,
      tenantName: slug,
      adminEmail: `admin@${slug}.example.com`,
      adminName: `Admin ${slug}`,
      now: tokenIssuedAt(),
    });
    const scope = t0.app.forTenant(parseTenantId(result.tenant.id));
    const other = await scope.users.create({
      display_name: 'Other Admin',
      email: `other@${slug}.example.com`,
    });
    await grantTenantRole(scope, { type: 'system' }, { userId: other.id });
    const otherToken = await issueApiToken(scope, {
      userId: other.id,
      name: 'other',
      now: tokenIssuedAt(),
    });
    const member = await scope.users.create({
      display_name: 'Member',
      email: `member@${slug}.example.com`,
    });
    const memberToken = await issueApiToken(scope, {
      userId: member.id,
      name: 'member',
      now: tokenIssuedAt(),
    });
    return {
      slug,
      scope,
      adminId: result.user.id,
      adminToken: result.token.token,
      otherId: other.id,
      otherToken: otherToken.token,
      nonAdminToken: memberToken.token,
    };
  }

  it('AC1/AC2/AC3: request → approve → pending_deletion; audit events; two-person refuse', async () => {
    const s = await seed();
    refused(
      await inject('POST', '/v1/client/data-deletion', s.nonAdminToken, {}),
      403,
      'forbidden',
    );

    const requested = ok(await inject('POST', '/v1/client/data-deletion', s.adminToken, {}), 201);
    expect(requested).toMatchObject({
      tenant_slug: s.slug,
      phase: 'requested',
      tenant_status: 'active',
      requested_by: s.adminId,
      legal_basis: 'contract_offboarding',
      grace_period_days: 14,
    });

    await expect(approveDeletion(t0.app, s.scope, s.adminId)).rejects.toMatchObject({
      code: 'self_action',
    });

    const approved = await approveDeletion(t0.app, s.scope, s.otherId);
    expect(approved).toMatchObject({
      phase: 'approved',
      tenant_status: 'pending_deletion',
      operator_id: s.otherId,
    });

    const tenant = await t0.app.system.getTenant(s.scope.tenantId);
    expect(tenant?.status).toBe('pending_deletion');

    const events = await s.scope.audit.listForEntity(s.scope.tenantId, [
      'client_data.deletion_requested',
      'client_data.deletion_approved',
    ]);
    expect(events.map((e) => e.action)).toEqual([
      'client_data.deletion_requested',
      'client_data.deletion_approved',
    ]);
  });

  it('cancel before approve stays active; cancel after approve restores active', async () => {
    const s = await seed();
    ok(await inject('POST', '/v1/client/data-deletion', s.adminToken, {}), 201);
    const cancelled = ok(await inject('DELETE', '/v1/client/data-deletion', s.adminToken));
    expect(cancelled).toMatchObject({ phase: 'cancelled', tenant_status: 'active' });

    ok(await inject('POST', '/v1/client/data-deletion', s.adminToken, {}), 201);
    await approveDeletion(t0.app, s.scope, s.otherId);
    expect((await t0.app.system.getTenant(s.scope.tenantId))?.status).toBe('pending_deletion');

    const restored = ok(await inject('DELETE', '/v1/client/data-deletion', s.adminToken));
    expect(restored).toMatchObject({ phase: 'cancelled', tenant_status: 'active' });
    expect((await t0.app.system.getTenant(s.scope.tenantId))?.status).toBe('active');
  });

  it('pending_deletion token may cancel/status/me but not other routes', async () => {
    const s = await seed();
    await requestDeletion(t0.app, s.scope, { type: 'human', userId: s.adminId });
    await approveDeletion(t0.app, s.scope, s.otherId);

    const resolved = await t0.app.system.resolveApiToken(hashApiToken(s.adminToken));
    expect(resolved).toMatchObject({ tenantStatus: 'pending_deletion' });

    ok(await inject('GET', '/v1/me', s.adminToken));
    ok(await inject('GET', '/v1/client/data-deletion', s.adminToken));
    refused(await inject('GET', '/v1/admin/projects', s.adminToken), 403, 'forbidden');
    ok(await inject('DELETE', '/v1/client/data-deletion', s.adminToken));
  });
});
