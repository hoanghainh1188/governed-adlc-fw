// X06 PR 1 on a real knowledge-db (design/ADR-M108 §2.4; `pnpm test:knowledge`): the code store as
// the role `knowledge`, as the worker connects.
// - `ensureProject`: one code schema and one read role (no login) per project, idempotent, apart
//   from the document schema.
// - A version with its files, symbols and resolved imports; a search by name and the importers of
//   a file work in SQL.
// - The code read role reads its own project's code only: not another project's, not the
//   project's documents; the document read role cannot read code.
// - `deleteIndexVersion` removes a version and all its rows, keeps the other version;
//   `deleteOrphanChunks` is 0; `dropProject` removes the schema and the role, idempotent.
// - Errors: `store_unavailable`, never the password or a value.
import crypto from 'node:crypto';

import {
  PgCodeIndexStore,
  PgVectorKnowledgeStore,
  projectRole,
  projectSchema,
} from '@sdlc/adapter-knowledge-pgvector';
import {
  CODE_INDEX_FORMAT,
  KnowledgeError,
  codeIndexReadRole,
  codeIndexSchema,
  type CodeFile,
} from '@sdlc/contracts';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const superUrl = process.env.SDLC_KNOWLEDGE_TEST_URL;
const TENANT = '11111111-1111-4111-8111-111111111111';
const sha = (text: string) => crypto.createHash('sha256').update(text).digest('hex');

const FILES: CodeFile[] = [
  {
    path: 'src/order.ts',
    language: 'typescript',
    contentSha256: sha('order'),
    symbols: [
      { name: 'OrderService', kind: 'class', role: 'def', line: 3 },
      { name: 'find', kind: 'method', role: 'def', line: 4 },
      { name: 'loadOrder', kind: 'call', role: 'ref', line: 5 },
    ],
    imports: [
      { module: './repo', targetPath: 'src/repo.ts' },
      { module: 'pg', targetPath: null },
    ],
  },
  {
    path: 'src/repo.ts',
    language: 'typescript',
    contentSha256: sha('repo'),
    symbols: [{ name: 'loadOrder', kind: 'function', role: 'def', line: 1 }],
    imports: [],
  },
];

describe.skipIf(!superUrl)('X06 PR 1 live: the code index store', () => {
  let admin: pg.Client;
  let store: PgCodeIndexStore;
  let docs: PgVectorKnowledgeStore;
  let knowledgeUrl: string;
  const password = crypto.randomBytes(24).toString('hex');
  const projectA = crypto.randomUUID();
  const projectB = crypto.randomUUID();
  const v1 = crypto.randomUUID();
  const v2 = crypto.randomUUID();

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: superUrl });
    await admin.connect();
    // As `worker-knowledge-credentials` does (bootstrap.sh).
    await admin.query(`ALTER ROLE knowledge LOGIN NOSUPERUSER CREATEROLE PASSWORD '${password}'`);
    const url = new URL(superUrl!);
    url.username = 'knowledge';
    url.password = password;
    knowledgeUrl = url.toString();
    store = new PgCodeIndexStore({ connectionString: knowledgeUrl });
    docs = new PgVectorKnowledgeStore({ connectionString: knowledgeUrl });
  });
  afterAll(async () => {
    await store?.close();
    await docs?.close();
    await admin?.end();
  });

  const asRole = async (role: string, sql: string) => {
    await admin.query('BEGIN');
    try {
      await admin.query(`SET LOCAL ROLE ${role}`);
      return await admin.query(sql);
    } finally {
      await admin.query('ROLLBACK');
    }
  };

  it('creates one code schema and one read role per project, apart from the documents', async () => {
    await store.ensureProject({ tenantId: TENANT, projectId: projectA });
    await store.ensureProject({ tenantId: TENANT, projectId: projectA });
    await store.ensureProject({ tenantId: TENANT, projectId: projectB });
    await docs.ensureProject({ tenantId: TENANT, projectId: projectA });
    expect(codeIndexSchema(projectA)).toBe(`kcode_p${projectA.replaceAll('-', '')}`);
    expect(codeIndexSchema(projectA)).not.toBe(projectSchema(projectA));
    const roles = await admin.query<{ rolcanlogin: boolean }>(
      'SELECT rolcanlogin FROM pg_roles WHERE rolname = $1',
      [codeIndexReadRole(projectA)],
    );
    expect(roles.rows).toEqual([{ rolcanlogin: false }]);
  });

  it('stores a version with files, symbols and resolved imports; searches work in SQL', async () => {
    for (const id of [v1, v2]) {
      await store.putIndexVersion({
        tenantId: TENANT,
        projectId: projectA,
        indexId: id,
        baseSha: (id === v1 ? 'a' : 'b').repeat(40),
        format: CODE_INDEX_FORMAT,
        files: FILES,
      });
    }
    const schema = codeIndexSchema(projectA);
    const defs = await admin.query<{ path: string; line: number }>(
      `SELECT f.path, s.line FROM ${schema}.symbols s JOIN ${schema}.files f
         ON f.index_id = s.index_id AND f.file_id = s.file_id
        WHERE s.index_id = $1 AND s.role = 'def' AND s.name LIKE $2 ORDER BY f.path`,
      [v1, 'load%'],
    );
    expect(defs.rows).toEqual([{ path: 'src/repo.ts', line: 1 }]);
    const importers = await admin.query<{ path: string }>(
      `SELECT f.path FROM ${schema}.imports i
         JOIN ${schema}.files t ON t.index_id = i.index_id AND t.file_id = i.target_file_id
         JOIN ${schema}.files f ON f.index_id = i.index_id AND f.file_id = i.file_id
        WHERE i.index_id = $1 AND t.path = 'src/repo.ts'`,
      [v1],
    );
    expect(importers.rows).toEqual([{ path: 'src/order.ts' }]);
    const external = await admin.query(
      `SELECT module FROM ${schema}.imports WHERE index_id = $1 AND target_file_id IS NULL`,
      [v1],
    );
    expect(external.rows).toEqual([{ module: 'pg' }]);
    expect((await store.listIndexVersions(projectA)).map((v) => v.id).sort()).toEqual(
      [v1, v2].sort(),
    );
  });

  it("the code read role reads its own project's code only, never the documents", async () => {
    const codeA = codeIndexSchema(projectA);
    const read = await asRole(codeIndexReadRole(projectA), `SELECT count(*) FROM ${codeA}.files`);
    expect(read.rows).toEqual([{ count: '4' }]);
    await expect(
      asRole(codeIndexReadRole(projectA), `SELECT 1 FROM ${codeIndexSchema(projectB)}.files`),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asRole(codeIndexReadRole(projectA), `SELECT 1 FROM ${projectSchema(projectA)}.chunks`),
    ).rejects.toThrow(/permission denied/);
    await expect(asRole(projectRole(projectA), `SELECT 1 FROM ${codeA}.files`)).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      asRole(codeIndexReadRole(projectA), `DELETE FROM ${codeA}.symbols`),
    ).rejects.toThrow(/permission denied/);
  });

  it('deletes a version with all its rows and keeps the other; no orphans', async () => {
    const schema = codeIndexSchema(projectA);
    expect(await store.deleteIndexVersion(projectA, v1)).toEqual({ chunks: 4 });
    for (const table of ['files', 'symbols', 'imports']) {
      const left = await admin.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${schema}.${table} WHERE index_id = $1`,
        [v1],
      );
      expect(left.rows, table).toEqual([{ n: 0 }]);
    }
    expect((await store.listIndexVersions(projectA)).map((v) => v.id)).toEqual([v2]);
    expect(await store.deleteOrphanChunks(projectA, new Date())).toBe(0);
    expect(await store.deleteIndexVersion(projectB, v2)).toEqual({ chunks: 0 });
  });

  it('drops a project’s code schema and role, idempotent; its documents stay', async () => {
    await store.dropProject(projectA);
    await store.dropProject(projectA);
    const schemas = await admin.query<{ nspname: string }>(
      'SELECT nspname FROM pg_namespace WHERE nspname = ANY($1)',
      [[codeIndexSchema(projectA), projectSchema(projectA), codeIndexSchema(projectB)]],
    );
    expect(schemas.rows.map((r) => r.nspname).sort()).toEqual(
      [projectSchema(projectA), codeIndexSchema(projectB)].sort(),
    );
    const role = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [
      codeIndexReadRole(projectA),
    ]);
    expect(role.rowCount).toBe(0);
    expect(await store.listIndexVersions(projectA)).toEqual([]);
  });

  it('errors are store_unavailable, without the password or a value', async () => {
    await expect(
      store.putIndexVersion({
        tenantId: TENANT,
        projectId: projectB,
        indexId: crypto.randomUUID(),
        baseSha: 'not a sha',
        format: CODE_INDEX_FORMAT,
        files: [],
      }),
    ).rejects.toThrow(KnowledgeError);
    const bad = new PgCodeIndexStore({
      connectionString: knowledgeUrl.replace(password, 'wrong-password-canary'),
    });
    const error = await bad
      .listIndexVersions(projectB)
      .then(() => undefined)
      .catch((e: unknown) => e);
    await bad.close();
    expect(error).toMatchObject({ code: 'store_unavailable' });
    expect(String(error) + JSON.stringify(error)).not.toMatch(/canary|wrong-password/);
    expect(() => codeIndexSchema('x; DROP SCHEMA public')).toThrow(KnowledgeError);
  });
});
