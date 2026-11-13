// The code index of a project in `knowledge-db` (task X06, design/ADR-M108 §2.4).
//
// - One schema per project, `kcode_p<project ID without dashes>`, and one read role per project
//   (no login), `kcode_p<…>_read`, that may read that schema only: a `read_documents` login cannot
//   read code, and a `read_code` login cannot read documents. The issuer `kdocs_issuer` holds the
//   read role with the admin option only (PR 2 gives a run's tool a login in it). Names are built
//   from the project's UUID only, never from input text.
// - Rows are not shared between index versions: deleting a version deletes all its rows.
// - Every value is a query parameter. Errors become `KnowledgeError('store_unavailable')`, never
//   the driver's text (it can echo values).
import { randomUUID } from 'node:crypto';

import {
  CODE_LANGUAGES,
  CODE_SYMBOL_KINDS,
  KNOWLEDGE_DATABASE,
  KNOWLEDGE_ISSUER_ROLE,
  KnowledgeError,
  codeIndexReadRole,
  codeIndexSchema,
  type CodeIndexInput,
  type CodeIndexStore,
} from '@sdlc/contracts';
import pg from 'pg';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{40}$/;
const FORMAT = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;
const LANGUAGES = new Set<string>(CODE_LANGUAGES);
const KINDS = new Set<string>(CODE_SYMBOL_KINDS);
/** Rows per INSERT statement: one round trip per batch, under the 65535 parameter limit. */
const BATCH = 1000;

function checked(value: string, pattern: RegExp): string {
  if (!pattern.test(value)) throw new KnowledgeError('store_unavailable');
  return value;
}

function member(value: string, set: ReadonlySet<string>): string {
  if (!set.has(value)) throw new KnowledgeError('store_unavailable');
  return value;
}

/** `($1,$2,$3),($4,$5,$6)…` for `rows` rows of `width` values. */
function placeholders(rows: number, width: number): string {
  return Array.from(
    { length: rows },
    (_, r) => `(${Array.from({ length: width }, (_, c) => `$${r * width + c + 1}`).join(',')})`,
  ).join(',');
}

export interface PgCodeIndexStoreOptions {
  /** `postgresql://<user>:<password>@knowledge-db:5432/knowledge`; never logged. */
  readonly connectionString: string;
  readonly maxConnections?: number;
}

export class PgCodeIndexStore implements CodeIndexStore {
  readonly #pool: pg.Pool;

  constructor(options: PgCodeIndexStoreOptions) {
    this.#pool = new pg.Pool({
      connectionString: options.connectionString,
      max: options.maxConnections ?? 2,
      // An unreachable `knowledge-db` fails the build (`store_unavailable`), never hangs it.
      connectionTimeoutMillis: 10_000,
    });
    // A pool without an error listener ends the process on an idle-client error (R084).
    this.#pool.on('error', () => undefined);
  }

  async #run<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    let client: pg.PoolClient;
    try {
      client = await this.#pool.connect();
    } catch {
      throw new KnowledgeError('store_unavailable');
    }
    let broken = false;
    try {
      return await work(client);
    } catch (error) {
      // A client whose query failed may be in a bad state: it never goes back to the pool.
      broken = true;
      if (error instanceof KnowledgeError) throw error;
      throw new KnowledgeError('store_unavailable');
    } finally {
      client.release(broken);
    }
  }

  async #transaction<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    return this.#run(async (client) => {
      await client.query('BEGIN');
      try {
        const result = await work(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    });
  }

  async #schemaExists(client: pg.PoolClient, schema: string): Promise<boolean> {
    const exists = await client.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [schema]);
    return (exists.rowCount ?? 0) > 0;
  }

  async ensureProject(input: { readonly tenantId: string; readonly projectId: string }) {
    checked(input.tenantId, UUID);
    const schema = codeIndexSchema(input.projectId);
    const role = codeIndexReadRole(input.projectId);
    await this.#transaction(async (client) => {
      // One project at a time: two runs of a project never create its schema at once.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [schema]);
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
      await client.query(
        `CREATE TABLE IF NOT EXISTS ${schema}.index_versions (
           id         uuid PRIMARY KEY,
           tenant_id  uuid NOT NULL,
           base_sha   char(40) NOT NULL,
           format     text NOT NULL,
           created_at timestamptz NOT NULL DEFAULT now()
         )`,
      );
      await client.query(
        `CREATE TABLE IF NOT EXISTS ${schema}.files (
           index_id       uuid NOT NULL REFERENCES ${schema}.index_versions (id) ON DELETE CASCADE,
           file_id        uuid NOT NULL,
           path           text NOT NULL,
           language       text NOT NULL,
           content_sha256 char(64) NOT NULL,
           PRIMARY KEY (index_id, file_id),
           UNIQUE (index_id, path)
         )`,
      );
      await client.query(
        `CREATE TABLE IF NOT EXISTS ${schema}.symbols (
           index_id uuid NOT NULL,
           file_id  uuid NOT NULL,
           name     text NOT NULL,
           kind     text NOT NULL,
           role     text NOT NULL CHECK (role IN ('def', 'ref')),
           line     integer NOT NULL CHECK (line > 0),
           FOREIGN KEY (index_id, file_id) REFERENCES ${schema}.files (index_id, file_id)
             ON DELETE CASCADE
         )`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS symbols_name_idx ON ${schema}.symbols (index_id, name text_pattern_ops)`,
      );
      await client.query(
        `CREATE TABLE IF NOT EXISTS ${schema}.imports (
           index_id       uuid NOT NULL,
           file_id        uuid NOT NULL,
           module         text NOT NULL,
           target_file_id uuid,
           FOREIGN KEY (index_id, file_id) REFERENCES ${schema}.files (index_id, file_id)
             ON DELETE CASCADE
         )`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS imports_target_idx ON ${schema}.imports (index_id, target_file_id)`,
      );
      // The cascade from `files` finds a file's rows by these: deleting a large version stays fast.
      await client.query(
        `CREATE INDEX IF NOT EXISTS symbols_file_idx ON ${schema}.symbols (index_id, file_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS imports_file_idx ON ${schema}.imports (index_id, file_id)`,
      );
      const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
      if (exists.rowCount === 0) await client.query(`CREATE ROLE ${role} NOLOGIN`);
      await client.query(`REVOKE ALL ON SCHEMA ${schema} FROM PUBLIC`);
      await client.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
      await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO ${role}`);
      await client.query(`GRANT CONNECT ON DATABASE ${KNOWLEDGE_DATABASE} TO ${role}`);
      const issuer = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [
        KNOWLEDGE_ISSUER_ROLE,
      ]);
      if ((issuer.rowCount ?? 0) > 0) {
        await client.query(
          `GRANT ${role} TO ${KNOWLEDGE_ISSUER_ROLE} WITH ADMIN OPTION, INHERIT FALSE, SET FALSE`,
        );
      }
    });
  }

  async putIndexVersion(input: CodeIndexInput) {
    const schema = codeIndexSchema(input.projectId);
    checked(input.tenantId, UUID);
    checked(input.indexId, UUID);
    checked(input.baseSha, GIT_SHA);
    checked(input.format, FORMAT);
    const ids = new Map(input.files.map((file) => [file.path, randomUUID()]));
    if (ids.size !== input.files.length) throw new KnowledgeError('store_unavailable');
    await this.#transaction(async (client) => {
      await client.query(
        `INSERT INTO ${schema}.index_versions (id, tenant_id, base_sha, format)
         VALUES ($1, $2, $3, $4)`,
        [input.indexId, input.tenantId, input.baseSha, input.format],
      );
      const files = input.files.map((file) => [
        input.indexId,
        ids.get(file.path)!,
        file.path,
        member(file.language, LANGUAGES),
        checked(file.contentSha256, SHA256),
      ]);
      await this.#insert(
        client,
        `${schema}.files`,
        'index_id, file_id, path, language, content_sha256',
        files,
      );
      const symbols = input.files.flatMap((file) =>
        file.symbols.map((symbol) => [
          input.indexId,
          ids.get(file.path)!,
          symbol.name,
          member(symbol.kind, KINDS),
          symbol.role === 'def' ? 'def' : 'ref',
          Math.max(1, Math.trunc(symbol.line)),
        ]),
      );
      await this.#insert(
        client,
        `${schema}.symbols`,
        'index_id, file_id, name, kind, role, line',
        symbols,
      );
      const imports = input.files.flatMap((file) =>
        file.imports.map((entry) => [
          input.indexId,
          ids.get(file.path)!,
          entry.module,
          entry.targetPath === null ? null : (ids.get(entry.targetPath) ?? null),
        ]),
      );
      await this.#insert(
        client,
        `${schema}.imports`,
        'index_id, file_id, module, target_file_id',
        imports,
      );
    });
  }

  async #insert(
    client: pg.PoolClient,
    table: string,
    columns: string,
    rows: readonly (readonly unknown[])[],
  ): Promise<void> {
    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH);
      const width = batch[0]!.length;
      await client.query(
        `INSERT INTO ${table} (${columns}) VALUES ${placeholders(batch.length, width)}`,
        batch.flat(),
      );
    }
  }

  async deleteIndexVersion(projectId: string, indexId: string) {
    const schema = codeIndexSchema(projectId);
    checked(indexId, UUID);
    return this.#transaction(async (client) => {
      if (!(await this.#schemaExists(client, schema))) return { chunks: 0 };
      const removed = await client.query(
        `SELECT count(*)::int AS n FROM ${schema}.symbols WHERE index_id = $1`,
        [indexId],
      );
      await client.query(`DELETE FROM ${schema}.index_versions WHERE id = $1`, [indexId]);
      return { chunks: (removed.rows[0] as { n: number } | undefined)?.n ?? 0 };
    });
  }

  async listIndexVersions(projectId: string) {
    const schema = codeIndexSchema(projectId);
    return this.#run(async (client) => {
      if (!(await this.#schemaExists(client, schema))) return [];
      const rows = await client.query<{ id: string; created_at: Date }>(
        `SELECT id, created_at FROM ${schema}.index_versions ORDER BY created_at, id`,
      );
      return rows.rows.map((row) => ({ id: row.id, createdAt: new Date(row.created_at) }));
    });
  }

  /**
   * No rows are shared between versions, so nothing is ever left without one: always 0. The cut-off
   * of the interface (`before`) has nothing to compare.
   */
  deleteOrphanChunks(projectId: string, before: Date): Promise<number> {
    codeIndexSchema(projectId);
    if (Number.isNaN(before.getTime())) throw new KnowledgeError('store_unavailable');
    return Promise.resolve(0);
  }

  async dropProject(projectId: string) {
    const schema = codeIndexSchema(projectId);
    const role = codeIndexReadRole(projectId);
    await this.#transaction(async (client) => {
      // The lock of `ensureProject`: never drop a schema while a build creates it.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [schema]);
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
      if ((exists.rowCount ?? 0) > 0) {
        await client.query(`REVOKE ALL ON DATABASE ${KNOWLEDGE_DATABASE} FROM ${role}`);
        await client.query(`DROP ROLE ${role}`);
      }
    });
  }

  async close() {
    await this.#pool.end();
  }
}
