// X08a on a live PostgreSQL (design/ADR-M109 §2.1, §5 "X08a"; QUESTIONS #706, #721–#725):
// `GET /v1/intents` filters by gate, risk tier, creation and close dates, a sealed Evidence Pack
// and a search text, always inside the caller's tenant and readable projects. The search text
// (`q`) is PostgreSQL full-text search with the `simple` configuration on the generated column
// `intents.search_tsv`, a bound parameter; an intent code or `#<number>` matches its column. A
// client data deletion turns the title and description into the tombstone, so the words no longer
// match. `GET /v1/intents/:intent` gains `links`. The GIN index is measured on 10,000 intents.
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { createApp, type ApiDeps } from '../../../apps/api/src/app.js';
import { issueApiToken } from '../../../packages/core/src/admin/tokens.js';
import type { Intent } from '../../../packages/core/src/db/schema.js';
import { tokenIssuedAt } from '../token-clock.js';
import { createWorkflowFixture, type WorkflowFixture } from '../workflow/fixture.js';
import { createTestDatabase, describeDb, tamper, type TestDatabase } from './helpers.js';

const T0 = new Date('2026-11-01T03:00:00.000Z');
const DAY = 86_400_000;

describeDb('X08a: finding past intents on PostgreSQL', () => {
  let db: TestDatabase;
  let f: WorkflowFixture;
  let other: WorkflowFixture;
  let app: Awaited<ReturnType<typeof createApp>>;
  let token = '';
  let otherToken = '';
  let clock = T0;
  const made: Record<string, Intent> = {};

  async function make(key: string, title: string, description: string, extra = {}) {
    const intent = await f.registry.createIntent(f.scope, {
      projectId: f.target.projectId,
      title,
      description,
      createdBy: f.users.a,
      riskTier: 'medium',
      dataClass: 'internal',
      ...extra,
    });
    made[key] = intent;
    // `created_at` is the database's time: set it to the test's day.
    await tamper(db.name, 'UPDATE intents SET created_at = $1 WHERE id = $2', [clock, intent.id]);
    return intent;
  }

  beforeAll(async () => {
    db = await createTestDatabase();
    f = await createWorkflowFixture(db, () => clock);
    other = await createWorkflowFixture(db, () => clock, { tenantSlug: 'other' });
    clock = T0;
    await make('cancel', 'Cancel an order', 'The stock returns to the warehouse.', {
      issueNumber: 42,
    });
    clock = new Date(T0.getTime() + DAY);
    await make('vi', 'Hủy đơn hàng', 'Trả hàng về kho khi khách hủy.', { riskTier: 'high' });
    clock = new Date(T0.getTime() + 2 * DAY);
    await make('ja', '注文 キャンセル', '在庫 を 倉庫 に 戻す');
    clock = new Date(T0.getTime() + 3 * DAY);
    await make('export', 'Export orders as CSV', 'A monthly export for accounting.');
    // Another tenant with the same words: never returned to this tenant's people.
    await other.registry.createIntent(other.scope, {
      projectId: other.target.projectId,
      title: 'Cancel an order (other tenant)',
      description: 'The stock returns.',
      createdBy: other.users.a,
      riskTier: 'medium',
      dataClass: 'internal',
    });
    token = (await issueApiToken(f.scope, { userId: f.users.a, name: 'a', now: tokenIssuedAt() }))
      .token;
    otherToken = (
      await issueApiToken(other.scope, { userId: other.users.a, name: 'o', now: tokenIssuedAt() })
    ).token;
    app = await createApp({
      db: db.app as unknown as ApiDeps['db'],
      settings: { rateLimitPerMinute: 10_000, authFailuresPerMinute: 1000 },
      now: () => new Date(),
      webLinks: {
        webUrl: (ref, target) =>
          target.kind === 'file'
            ? `https://git.example/${ref.owner}/${ref.name}/blob/${target.commitSha}/${target.path}`
            : `https://git.example/${ref.owner}/${ref.name}/${target.kind}/${String(target.number)}`,
      },
    });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await f?.close();
    await other?.close();
    await db?.drop();
  });

  async function get(url: string, bearer = token) {
    const reply = await app
      .getHttpAdapter()
      .getInstance()
      .inject({ method: 'GET', url, headers: { authorization: `Bearer ${bearer}` } });
    return { status: reply.statusCode, body: reply.json<Record<string, unknown>>() };
  }
  const codes = async (query: string, bearer = token) => {
    const reply = await get(`/v1/intents?${query}`, bearer);
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    return (reply.body.items as { code: string }[]).map((i) => i.code);
  };
  const code = (key: string) => made[key]!.code;
  const q = (text: string) => `q=${encodeURIComponent(text)}`;

  it('AC2: words of the title and description match, newest first; Vietnamese and Japanese by token', async () => {
    expect(await codes(q('cancel order'))).toEqual([code('cancel')]);
    expect(await codes(q('stock'))).toEqual([code('cancel')]);
    expect(await codes(q('hủy'))).toEqual([code('vi')]);
    expect(await codes(q('kho'))).toEqual([code('vi')]);
    expect(await codes(q('キャンセル'))).toEqual([code('ja')]);
    expect(await codes(q('倉庫'))).toEqual([code('ja')]);
    // `websearch_to_tsquery`: OR and a phrase.
    expect(await codes(q('csv or hủy'))).toEqual([code('export'), code('vi')]);
    expect(await codes(q('"monthly export"'))).toEqual([code('export')]);
    expect(await codes(q('nothing-like-this'))).toEqual([]);
  });

  it('AC2: an intent code or #number matches its column; the text is a bound parameter', async () => {
    expect(await codes(q(code('export').toLowerCase()))).toEqual([code('export')]);
    expect(await codes(q('#42'))).toEqual([code('cancel')]);
    for (const text of [`'; DROP TABLE intents; --`, 'a & b | !c', `o'brien:*`, '((()))']) {
      const reply = await get(`/v1/intents?${q(text)}`);
      expect(reply.status, text).toBe(200);
    }
    expect((await get(`/v1/intents?${q('x')}`)).status).toBe(400); // under 2 characters
    expect((await get(`/v1/intents?${q('x'.repeat(201))}`)).status).toBe(400);
  });

  it('AC1: risk tier, creation dates, gate; an unknown parameter or a bad value is 400', async () => {
    expect(await codes('risk_tier=high')).toEqual([code('vi')]);
    expect(await codes('created_from=2026-11-02&created_to=2026-11-03')).toEqual([
      code('ja'),
      code('vi'),
    ]);
    expect(await codes('created_to=2026-11-01')).toEqual([code('cancel')]);
    // Every intent is a draft (no gate yet): a gate filter returns none.
    expect(await codes('gate=G1')).toEqual([]);
    for (const bad of [
      'owner=a',
      'gate=G9',
      'risk_tier=huge',
      'created_from=2026-13-01',
      'sealed=1',
    ]) {
      expect((await get(`/v1/intents?${bad}`)).status, bad).toBe(400);
    }
    // Filters combine. `simple` does not stem: `order` never matches `orders`.
    expect(await codes(`risk_tier=medium&${q('order')}`)).toEqual([code('cancel')]);
    expect(await codes(`risk_tier=medium&${q('orders')}`)).toEqual([code('export')]);
  });

  it('AC1: another tenant, or a project without a role, is never returned', async () => {
    // Codes are counted per tenant: compare the IDs.
    const reply = await get(`/v1/intents?${q('cancel order')}`, otherToken);
    const theirs = (reply.body.items as { id: string }[]).map((i) => i.id);
    expect(theirs).toHaveLength(1);
    expect(theirs).not.toContain(made.cancel!.id);
    expect(await codes(q('other tenant'))).toEqual([]);
    // A second project of this tenant where Person A has no role.
    const hidden = await f.scope.projects.create({
      slug: 'hidden',
      name: 'Hidden',
      git_provider: 'github',
      repo_full_name: 'acme/hidden',
    });
    await tamper(
      db.name,
      `INSERT INTO intents (tenant_id, code, project_id, title, description, created_by,
         risk_tier, data_class, max_autonomy, budget_usd, status)
       VALUES ($1, 'INT-2026-9001', $2, 'Cancel a hidden order', '', $3, 'low', 'internal',
         'L2', '1', 'draft')`,
      [f.target.tenantId, hidden.id, f.users.a],
    );
    expect(await codes(q('hidden'))).toEqual([]);
  });

  it('AC1: closed dates from closed_at (set when the intent finishes) and sealed packs', async () => {
    const closed = await f.scope.intents.updateState(made.export!.id, {
      status: 'cancelled',
      currentGate: null,
      actorType: 'system',
      actorId: null,
    });
    // The move's `updated_at`; draft intents have none.
    expect(closed.closed_at?.getTime()).toBe(closed.updated_at.getTime());
    expect((await f.scope.intents.getById(made.vi!.id))?.closed_at).toBeNull();
    const day = closed.closed_at!.toISOString().slice(0, 10);
    const before = new Date(closed.closed_at!.getTime() - DAY).toISOString().slice(0, 10);
    expect(await codes(`closed_from=${day}&closed_to=${day}`)).toEqual([code('export')]);
    expect(await codes(`closed_to=${before}`)).toEqual([]);
    // No sealed pack yet; one sealed pack makes `sealed=true` match.
    expect(await codes('sealed=true')).toEqual([]);
    expect(await codes('sealed=false')).toContain(code('export'));
    await tamper(
      db.name,
      `INSERT INTO evidence_packs (id, tenant_id, intent_id, version, content_sha256,
         release_sha256, manifest_uri, manifest_sha256, manifest_size_bytes, markdown_uri,
         markdown_sha256, markdown_size_bytes, locale, disclosure_format, item_count, built_by,
         sealed_at)
       VALUES (gen_random_uuid(), $1, $2, 1, $3, $3, 's3://evidence/packs/x/m.json', $3, 1,
         's3://evidence/packs/x/m.md', $3, 1, 'en', 'standard_note', 0, NULL, now())`,
      [f.target.tenantId, made.cancel!.id, 'a'.repeat(64)],
    );
    expect(await codes('sealed=true')).toEqual([code('cancel')]);
  });

  it('AC4: the intent body has links built from stored codes and numbers', async () => {
    const reply = await get(`/v1/intents/${code('cancel')}`);
    expect(reply.status).toBe(200);
    expect(reply.body.links).toEqual({
      issue: { number: 42, url: 'https://git.example/acme/shop/issue/42' },
      pull_request: null,
      spec: null,
      plan: null,
      evidence: { path: `/v1/intents/${code('cancel')}/evidence`, sealed: true },
      // X08b PR 2: no lesson on this intent yet.
      lessons: [],
      follow_ups: [],
    });
  });

  it('AC2: a client data deletion turns the title and description into the tombstone', async () => {
    expect(await codes(q('warehouse'))).toEqual([code('cancel')]);
    // Anything but the tombstone is refused by the database (SDA31).
    await expect(
      sql`UPDATE intents SET title = 'Something else' WHERE id = ${made.cancel!.id}`.execute(
        db.appRaw,
      ),
    ).rejects.toMatchObject({ code: 'SDA31' });
    const scrubbed = await f.scope.clientDataDeletion.scrubIntents();
    expect(scrubbed).toBeGreaterThanOrEqual(4);
    expect(await f.scope.clientDataDeletion.scrubIntents()).toBe(0); // idempotent
    const after = await f.scope.intents.getById(made.cancel!.id);
    expect(after).toMatchObject({ title: `Redacted intent ${code('cancel')}`, description: '' });
    expect(await codes(q('warehouse'))).toEqual([]);
    expect(await codes(q('hủy'))).toEqual([]);
    // The other tenant keeps its own text.
    expect(await codes(q('stock'), otherToken)).toHaveLength(1);
  });

  it('AC2: on 10,000 intents the search stays fast (measured; the GIN index exists)', async () => {
    const t = f.target;
    await sql`INSERT INTO intents (tenant_id, code, project_id, title, description, created_by,
                risk_tier, data_class, max_autonomy, budget_usd, status, created_at)
              SELECT ${t.tenantId}::uuid, 'INT-2025-' || lpad(n::text, 5, '0'), ${t.projectId}::uuid,
                'Intent number ' || n || ' about '
                  || (ARRAY['orders','stock','billing','users'])[1 + n % 4]
                  || CASE WHEN n % 100 = 0 THEN ' refund' ELSE '' END,
                'Description ' || n, ${f.users.a}::uuid, 'medium', 'internal', 'L2', '1', 'draft',
                now() - (n || ' minutes')::interval
              FROM generate_series(1, 10000) AS n`.execute(db.owner);
    await sql`ANALYZE intents`.execute(db.owner);
    const explain = await sql<{ 'QUERY PLAN': string }>`EXPLAIN (ANALYZE, FORMAT TEXT)
      SELECT id FROM intents
      WHERE tenant_id = ${t.tenantId}::uuid AND project_id = ${t.projectId}::uuid
        AND search_tsv @@ websearch_to_tsquery('simple', 'refund')
      ORDER BY created_at DESC, id DESC LIMIT 51`.execute(db.owner);
    const plan = explain.rows.map((r) => r['QUERY PLAN']).join('\n');
    process.stdout.write(`X08a search on 10,000 intents (the planner's choice):\n${plan}\n`);
    // ADR-M109 0.2: at this size the planner reads the project's rows by the tenant and project
    // index and checks the vector; it needs no GIN scan, and the search stays far under 50 ms.
    const ms = Number(/Execution Time: ([0-9.]+) ms/.exec(plan)?.[1]);
    expect(ms).toBeLessThan(50);
    const index = await sql<{ indexdef: string }>`SELECT indexdef FROM pg_indexes
      WHERE indexname = 'intents_search_tsv_idx'`.execute(db.owner);
    expect(index.rows[0]?.indexdef).toContain('USING gin (search_tsv)');
    const started = Date.now();
    expect((await codes(`${q('refund')}&limit=100`)).length).toBe(100);
    const rare = Date.now() - started;
    const common = Date.now();
    // A common word (a quarter of the rows): the planner may scan; the page is still quick.
    expect((await codes(`${q('billing')}&limit=50`)).length).toBe(50);
    process.stdout.write(
      `X08a GET /v1/intents on 10,000 intents: q=refund (1%) ${String(rare)} ms, ` +
        `q=billing (25%) ${String(Date.now() - common)} ms\n`,
    );
  });
});
