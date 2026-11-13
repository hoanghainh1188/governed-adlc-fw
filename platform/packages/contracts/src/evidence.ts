// The evidence store (design/D-03 section 7.5; first user: task C06 session 2b, ADR-M33 §2.9).
// The MVP stores evidence files in SeaweedFS through its S3 API (`@sdlc/adapter-evidence-s3`).
//
// Evidence is never overwritten: `put` refuses a path that exists (`EvidenceError('exists')`), so
// one path holds one version. The SHA-256 returned by `put` is computed by the caller's process
// from the bytes it sent; E02 checks it again when it reads the file for the Evidence Pack.

/** Kinds of evidence file (design/D-05 section 6.6 `evidence_items.kind`). */
/**
 * C13 (ADR-M64 §2.1): the largest L1 proposal a person may download through the API, whatever
 * the per-item cap of the evidence store. The whole patch travels in one JSON answer (base64),
 * so a lower cap keeps the api's and the CLI's memory bounded.
 */
export const PROPOSAL_MAX_BYTES = 32 * 1024 * 1024;

export const EVIDENCE_KINDS = [
  'spec',
  'plan',
  'proposal',
  'diff',
  'ci_result',
  'test_report',
  'scan_report',
  'review',
  'cost_summary',
  'disclosure_note',
  /** X04 PR 3b (ADR-M89 §2.5): the document IDs and content hashes a run's tool returned. */
  'knowledge_read',
  /** X07 (ADR-M90 §2.2): what the agent of one run read, hashes and counts only. */
  'context_snapshot',
  /** X13 PR 3a (ADR-M74 §2.5): the memory part of a run's change, pushed to its memory branch. */
  'memory_diff',
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export interface StoredEvidence {
  /** `s3://<bucket>/<key>`: stored in `evidence_items.storage_uri`. */
  readonly uri: string;
  /** SHA-256 (hex) of the bytes sent. */
  readonly sha256: string;
  readonly sizeBytes: number;
}

export interface EvidenceStore {
  /**
   * Stores a new file for a tenant at `path` (relative, `/`-separated). Throws
   * `EvidenceError('exists')` when the path is taken: evidence is never overwritten.
   */
  put(
    tenantId: string,
    path: string,
    content: Buffer,
    contentType: string,
  ): Promise<StoredEvidence>;
  /**
   * Reads a file back by its URI (needs a credential that may read; the runner's may only read
   * run diffs). With `maxBytes`, a larger file is refused (`EvidenceError('too_large')`) before
   * its body is read (E02, ADR-M48).
   */
  get(uri: string, options?: EvidenceGetOptions): Promise<Buffer>;
}

export interface EvidenceGetOptions {
  readonly maxBytes?: number;
}

export const EVIDENCE_ERROR_CODES = [
  'invalid_input',
  'exists',
  'forbidden',
  'not_found',
  /** The file is larger than the caller's `maxBytes` (E02). */
  'too_large',
  'unavailable',
] as const;
export type EvidenceErrorCode = (typeof EVIDENCE_ERROR_CODES)[number];

/** Why an evidence call failed. A code only: never text from the storage service. */
export class EvidenceError extends Error {
  override readonly name = 'EvidenceError';

  constructor(readonly code: EvidenceErrorCode) {
    super(`evidence.${code}`);
  }
}

/** A key of the evidence store, newest version first (task E05, the orphan sweep). */
export interface EvidenceKeyInfo {
  /** `s3://<bucket>/<key>`. */
  readonly uri: string;
  /** Time of the key's newest version or delete marker. */
  readonly lastModified: Date;
}

export interface EvidenceKeyPage {
  readonly keys: readonly EvidenceKeyInfo[];
  /** Pass back as `after` for the next page; null at the end. */
  readonly next: string | null;
}

/**
 * Retention of evidence files (task E05, design/ADR-M51; D-05 §10.1, D-02 FR-44). Used only by
 * the worker's retention loop, with its own identity `worker-purge`: no read, no new files.
 *
 * - The bucket `evidence` is versioned and carries a GOVERNANCE object lock (180 days by default):
 *   no writer can delete a locked version. Only this identity may delete one early, and only with
 *   `bypassLock` (an archived project, an orphan pack file). A legal hold blocks even that.
 * - Calls name one file by its URI; a URI outside the store's bucket or prefixes is refused
 *   (`EvidenceError('invalid_input')`). A refusal by the lock or the hold is `forbidden`.
 */
export interface EvidenceRetentionStore {
  /**
   * Deletes every version and every delete marker of exactly this key. Returns how many were
   * deleted (0 when the key has none left). Fails `forbidden` when one version is locked or held;
   * versions deleted before the refusal stay deleted.
   */
  deleteAllVersions(uri: string, options: { readonly bypassLock: boolean }): Promise<number>;
  /** Sets (`on`) or removes the legal hold on every version of the key. Returns the count. */
  setLegalHold(uri: string, on: boolean): Promise<number>;
  /**
   * Moves the object lock of every version of the key to at least `until`; never shortens one.
   * Returns how many versions changed.
   */
  extendLock(uri: string, until: Date): Promise<number>;
  /** Keys under `prefix` (one of the store's prefixes), at most `limit`, in key order. */
  listKeys(prefix: string, after: string | null, limit: number): Promise<EvidenceKeyPage>;
}
