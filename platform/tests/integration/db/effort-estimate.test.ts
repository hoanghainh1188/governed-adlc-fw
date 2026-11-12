// D-08 V14 AC1 on a live PostgreSQL, through the Nest app and Fastify `inject()` (no port): a
// person with a write role records an estimate of the human effort for an intent (ADR-M79 §2.6,
// QUESTIONS #691–#693). Hours only (a number, never a text), empty by default. Migration 0050:
// the column, its CHECK, and the trigger SDA29 (no change on a finished intent, never back to
// null). Who: a role in `access.intent_create_roles` or a tenant admin; never `viewer`.
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { createApp, type ApiDeps } from '../../../apps/api/src/app.js';
import { issueApiToken } from '../../../packages/core/src/admin/tokens.js';
import { DbError } from '../../../packages/core/src/db/errors.js';
import { seedRun, type SeededRun } from '../cost-seed.js';
import { tokenIssuedAt } from '../token-clock.js';
import { createTestDatabase, describeDb, tamper, type TestDatabase } from './helpers.js';

type App = Awaited<ReturnType<typeof createApp>>;
const asApiDb = (db: TestDatabase): ApiDeps['db'] => db.app as unknown as ApiDeps['db'];

type Who = 'a' | 'admin' | 'reviewer' | 'viewer' | 'outsider';

describeDb('V14: human-effort estimate of an intent on PostgreSQL', () => {
  let t0: TestDatabase;
  let app: App;
  let seeded: SeededRun;
  const tokens = {} as Record<Who, string>;
  const users = {} as Record<Who, string>;

  const put = async (ref: string, token: string, body: unknown) =>
    await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'PUT',
        url: `/v1/intents/${ref}/effort-estimate`,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        payload: JSON.stringify(body),
      });

  const get = async (ref: string, token: string) =>
    await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'GET',
        url: `/v1/intents/${ref}`,
        headers: { authorization: `Bearer ${token}` },
      });

  const refused = (reply: Awaited<ReturnType<typeof put>>, status: number, code: string) => {
    expect(reply.statusCode, reply.body).toBe(status);
    expect(reply.json<{ error: { code: string } }>().error.code).toBe(code);
  };

  const events = async () =>
    (
      await sql<{
        actor_type: string;
        actor_id: string | null;
        entity_id: string;
        payload: Record<string, unknown>;
      }>`SELECT actor_type, actor_id, entity_id, payload FROM audit_log
          WHERE action = 'intent.effort_estimated' ORDER BY seq`.execute(t0.owner)
    ).rows;

  const stored = async () =>
    (
      await sql<{
        hours: string | null;
      }>`SELECT human_effort_hours::text AS hours FROM intents WHERE id = ${seeded.intentId}`.execute(
        t0.owner,
      )
    ).rows[0]!.hours;

  beforeAll(async () => {
    t0 = await createTestDatabase();
    seeded = await seedRun(t0.app, { slug: 'acme', models: ['model-a'], now: new Date() });
    const { scope } = seeded;
    const roles: Record<Who, string | null> = {
      a: 'person_a',
      admin: null,
      reviewer: 'person_b',
      viewer: 'viewer',
      outsider: null,
    };
    for (const [who, role] of Object.entries(roles) as [Who, string | null][]) {
      const user =
        who === 'a'
          ? seeded.personA
          : (await scope.users.create({ display_name: who, email: `${who}@acme.example.com` })).id;
      users[who] = user;
      if (role) {
        await scope.roleBindings.grant({
          user_id: user,
          project_id: seeded.projectId,
          role: role as 'person_a',
        });
      }
      if (who === 'admin') await scope.tenantRoles.grant({ user_id: user, role: 'tenant_admin' });
      tokens[who] = (
        await issueApiToken(scope, { userId: user, name: who, now: tokenIssuedAt() })
      ).token;
    }
    app = await createApp({
      db: asApiDb(t0),
      settings: { rateLimitPerMinute: 1000, authFailuresPerMinute: 1000 },
      logger: { error: () => undefined },
    });
  }, 90_000);

  afterAll(async () => {
    await app?.close();
    await t0?.drop();
  });

  it('AC1: the estimate is empty by default, in the database and on the intent body', async () => {
    expect(await stored()).toBeNull();
    const reply = await get(seeded.intentCode, tokens.a);
    expect(reply.statusCode, reply.body).toBe(200);
    expect(reply.json<{ human_effort_hours: unknown }>().human_effort_hours).toBeNull();
  });

  it('AC1: Person A (a write role) records it; the body and the audit event hold numbers only', async () => {
    const reply = await put(seeded.intentCode, tokens.a, { hours: 12.5 });
    expect(reply.statusCode, reply.body).toBe(200);
    expect(reply.json<{ human_effort_hours: unknown }>().human_effort_hours).toBe('12.5');
    expect(await stored()).toBe('12.50');
    const shown = await get(seeded.intentCode, tokens.reviewer);
    expect(shown.json<{ human_effort_hours: unknown }>().human_effort_hours).toBe('12.5');
    expect(await events()).toEqual([
      {
        actor_type: 'human',
        actor_id: seeded.personA,
        entity_id: seeded.intentId,
        payload: { hours: '12.5' },
      },
    ]);
  });

  it('AC1: a change keeps the earlier value in the event; the same value writes nothing', async () => {
    expect((await put(seeded.intentId, tokens.a, { hours: 8 })).statusCode).toBe(200);
    expect((await put(seeded.intentId, tokens.a, { hours: 8 })).statusCode).toBe(200);
    const all = await events();
    expect(all).toHaveLength(2);
    expect(all[1]!.payload).toEqual({ hours: '8', previous_hours: '12.5' });
    expect(await stored()).toBe('8.00');
  });

  it('AC1: a tenant admin may record it without a project role (QUESTIONS #693)', async () => {
    const reply = await put(seeded.intentCode, tokens.admin, { hours: 6.25 });
    expect(reply.statusCode, reply.body).toBe(200);
    expect((await events()).at(-1)!.actor_id).toBe(users.admin);
  });

  it('AC1: a read role only is refused (403); no role on the project is not found (404)', async () => {
    refused(await put(seeded.intentCode, tokens.viewer, { hours: 3 }), 403, 'forbidden');
    refused(await put(seeded.intentCode, tokens.reviewer, { hours: 3 }), 403, 'forbidden');
    refused(await put(seeded.intentCode, tokens.outsider, { hours: 3 }), 404, 'intent_not_found');
    refused(await put('INT-2026-9999', tokens.a, { hours: 3 }), 404, 'intent_not_found');
    expect(await stored()).toBe('6.25');
  });

  it.each([
    [{ hours: 0 }],
    [{ hours: 0.2 }],
    [{ hours: 10_000.01 }],
    [{ hours: 1.255 }],
    [{ hours: -1 }],
    [{ hours: '4' }],
    [{ hours: 'four hours' }],
    [{ hours: null }],
    [{}],
    [{ hours: 4, note: 'about a day' }],
  ])('AC1: refuses %j: a number of hours only (400)', async (body) => {
    refused(await put(seeded.intentCode, tokens.a, body), 400, 'invalid_request');
    expect(await stored()).toBe('6.25');
  });

  it('AC1: accepts the limits 0.25 and 10000 hours', async () => {
    expect((await put(seeded.intentCode, tokens.a, { hours: 10_000 })).statusCode).toBe(200);
    expect(await stored()).toBe('10000.00');
    expect((await put(seeded.intentCode, tokens.a, { hours: 0.25 })).statusCode).toBe(200);
    expect(await stored()).toBe('0.25');
  });

  it('migration 0050: the CHECK refuses a value out of range, even for the platform', async () => {
    await expect(
      seeded.scope.intents.recordEffortEstimate(seeded.intentId, {
        hours: '0.1',
        actorId: seeded.personA,
      }),
    ).rejects.toBeInstanceOf(DbError);
    await expect(
      sql`UPDATE intents SET human_effort_hours = 20000 WHERE id = ${seeded.intentId}`.execute(
        t0.appRaw,
      ),
    ).rejects.toThrow();
  });

  it('migration 0050: an estimate never goes back to null (SDA29)', async () => {
    await expect(
      sql`UPDATE intents SET human_effort_hours = NULL WHERE id = ${seeded.intentId}`.execute(
        t0.appRaw,
      ),
    ).rejects.toMatchObject({ code: 'SDA29' });
    expect(await stored()).toBe('0.25');
  });

  it('AC1: a finished intent keeps its estimate: 409 from the API, SDA29 in the database', async () => {
    await tamper(
      t0.name,
      `UPDATE intents SET status = 'done', current_gate = NULL,
      gate_entered_at = NULL WHERE id = $1`,
      [seeded.intentId],
    );
    refused(await put(seeded.intentCode, tokens.a, { hours: 5 }), 409, 'intent_finished');
    await expect(
      sql`UPDATE intents SET human_effort_hours = 5 WHERE id = ${seeded.intentId}`.execute(
        t0.appRaw,
      ),
    ).rejects.toMatchObject({ code: 'SDA29' });
    await expect(
      seeded.scope.intents.recordEffortEstimate(seeded.intentId, {
        hours: '5',
        actorId: seeded.personA,
      }),
    ).rejects.toBeInstanceOf(DbError);
    expect(await stored()).toBe('0.25');
  });
});
