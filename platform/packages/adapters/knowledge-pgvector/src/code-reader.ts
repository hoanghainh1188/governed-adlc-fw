// The read side of the code index (task X06 PR 2, design/ADR-M108 §2.8): what a run's `read_code`
// tool asks `knowledge-db` with the run's own login, a member of the project's code read role only.
// Three questions over one index version: where a name is defined, where it is used, and which
// files import or are imported by a file. The answer holds client data (paths and names): it goes
// to the agent and nowhere else; never into a log.
import pg from 'pg';

import { KnowledgeReadError } from './reader.js';

const SCHEMA = /^kcode_p[0-9a-f]{32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KIND = /^[a-z_]{1,20}$/;

/** One place in the code: a symbol in a file, or a file. */
export interface CodeHit {
  readonly fileId: string;
  readonly contentSha256: string;
  /** Relative path in the repository (client data). */
  readonly path: string;
  readonly language: string;
  /** The symbol's name and kind; absent for a file of `related_files`. */
  readonly name?: string;
  readonly kind?: string;
  /** 1-based line; absent for a file of `related_files`. */
  readonly line?: number;
  /** For `related_files`: `imports` (the file imports it) or `imported_by`. */
  readonly relation?: 'imports' | 'imported_by';
}

export interface PgCodeIndexReaderOptions {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password: string;
  /** The project's code schema (`kcode_p<32 hex>`), from the run's settings. */
  readonly schema: string;
}

/** `%` and `_` are plain characters in a prefix search. */
function likePrefix(value: string): string {
  return `${value.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

interface Row {
  file_id: string;
  content_sha256: string;
  path: string;
  language: string;
  name?: string;
  kind?: string;
  line?: number;
  relation?: 'imports' | 'imported_by';
}

function hit(row: Row): CodeHit {
  return {
    fileId: row.file_id,
    contentSha256: row.content_sha256.trim(),
    path: row.path,
    language: row.language,
    ...(row.name !== undefined ? { name: row.name } : {}),
    ...(row.kind !== undefined ? { kind: row.kind } : {}),
    ...(row.line !== undefined ? { line: Number(row.line) } : {}),
    ...(row.relation !== undefined ? { relation: row.relation } : {}),
  };
}

export class PgCodeIndexReader {
  readonly #pool: pg.Pool;
  readonly #schema: string;

  constructor(options: PgCodeIndexReaderOptions) {
    if (!SCHEMA.test(options.schema)) throw new KnowledgeReadError();
    this.#schema = options.schema;
    this.#pool = new pg.Pool({
      host: options.host,
      port: options.port,
      database: options.database,
      user: options.user,
      password: options.password,
      // The per-run login has CONNECTION LIMIT 4 (@sdlc/secrets `creationStatements`).
      max: 2,
      statement_timeout: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    // A pool without an error listener ends the process on an idle-client error (R084).
    this.#pool.on('error', () => undefined);
  }

  static #check(indexId: string, limit: number): void {
    if (!UUID.test(indexId) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new KnowledgeReadError();
    }
  }

  async #query(sql: string, values: unknown[]): Promise<CodeHit[]> {
    try {
      const result = await this.#pool.query<Row>(sql, values);
      return result.rows.map(hit);
    } catch {
      throw new KnowledgeReadError();
    }
  }

  /** Definitions of `name`: exact matches first, then names that start with it. */
  async findSymbol(input: {
    readonly indexId: string;
    readonly name: string;
    readonly kind?: string;
    readonly limit: number;
  }): Promise<CodeHit[]> {
    PgCodeIndexReader.#check(input.indexId, input.limit);
    if (input.kind !== undefined && !KIND.test(input.kind)) throw new KnowledgeReadError();
    const s = this.#schema;
    return this.#query(
      `SELECT f.file_id, f.content_sha256, f.path, f.language, y.name, y.kind, y.line
         FROM ${s}.symbols y
         JOIN ${s}.files f ON f.index_id = y.index_id AND f.file_id = y.file_id
        WHERE y.index_id = $1 AND y.role = 'def' AND y.name LIKE $2
          AND ($3::text IS NULL OR y.kind = $3)
        ORDER BY (y.name = $4) DESC, y.name, f.path, y.line
        LIMIT $5`,
      [input.indexId, likePrefix(input.name), input.kind ?? null, input.name, input.limit],
    );
  }

  /** Uses of `name` (calls, `new`, type references), exact name only. */
  async findReferences(input: {
    readonly indexId: string;
    readonly name: string;
    readonly limit: number;
  }): Promise<CodeHit[]> {
    PgCodeIndexReader.#check(input.indexId, input.limit);
    const s = this.#schema;
    return this.#query(
      `SELECT f.file_id, f.content_sha256, f.path, f.language, y.name, y.kind, y.line
         FROM ${s}.symbols y
         JOIN ${s}.files f ON f.index_id = y.index_id AND f.file_id = y.file_id
        WHERE y.index_id = $1 AND y.role = 'ref' AND y.name = $2
        ORDER BY f.path, y.line
        LIMIT $3`,
      [input.indexId, input.name, input.limit],
    );
  }

  /** The files `path` imports and the files that import it, within the index. */
  async relatedFiles(input: {
    readonly indexId: string;
    readonly path: string;
    readonly limit: number;
  }): Promise<CodeHit[]> {
    PgCodeIndexReader.#check(input.indexId, input.limit);
    const s = this.#schema;
    return this.#query(
      `WITH me AS (SELECT file_id FROM ${s}.files WHERE index_id = $1 AND path = $2)
       SELECT DISTINCT f.file_id, f.content_sha256, f.path, f.language, r.relation
         FROM (
           SELECT i.target_file_id AS file_id, 'imports' AS relation
             FROM ${s}.imports i JOIN me ON i.file_id = me.file_id
            WHERE i.index_id = $1 AND i.target_file_id IS NOT NULL
           UNION
           SELECT i.file_id, 'imported_by'
             FROM ${s}.imports i JOIN me ON i.target_file_id = me.file_id
            WHERE i.index_id = $1
         ) r
         JOIN ${s}.files f ON f.index_id = $1 AND f.file_id = r.file_id
        ORDER BY r.relation DESC, f.path
        LIMIT $3`,
      [input.indexId, input.path, input.limit],
    );
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }
}
