// Interfaces for secrets and Run Contract signatures (design/D-03 sections 8 and 8.2, task A04,
// design/ADR-M21). The implementation is `@sdlc/secrets` (OpenBao). Adapters receive these
// interfaces from the apps; they never import the implementation (ADR-M16 §2.5).

/**
 * A secret value that never shows up in logs: `String()`, template literals, `JSON.stringify`
 * and `util.inspect` all give `[redacted]`. `reveal()` is the only way to read the value; call
 * it at the place that uses the value, never to log or store it.
 */
export interface RedactedSecret {
  reveal(): string;
}

/** One secret: a KV entry with its fields (for example `private_key`, `app_id`). */
export interface SecretEntry {
  /** Field name → value. */
  readonly data: Readonly<Record<string, RedactedSecret>>;
  /** Version of the KV entry (KV v2). */
  readonly version: number;
}

/** Reads secrets the process is allowed to read (its own AppRole policy). */
export interface SecretReader {
  /**
   * Reads the entry at `path` (for example `worker/database` or `shared/github-app`). Path
   * segments are letters, digits, `-`, `_` and `.`; `..` is refused. `version` reads an older
   * version; the latest by default.
   */
  read(path: string, options?: { version?: number }): Promise<SecretEntry>;
}

/**
 * Hands a secret from one process to another without storing it on the way (OpenBao response
 * wrapping, ADR-M25 §2.11). The result is a single-use wrapping token that expires after
 * `ttlSeconds`; only the receiver's `unwrap` turns it back into the fields.
 */
export interface SecretWrapper {
  wrap(
    fields: Readonly<Record<string, RedactedSecret>>,
    options: { ttlSeconds: number },
  ): Promise<RedactedSecret>;
}

/**
 * Opens a wrapping token once. Fails when the token is unknown, expired, already used (someone
 * else unwrapped it first) or was not made by `SecretWrapper.wrap`.
 */
export interface SecretUnwrapper {
  unwrap(wrappingToken: RedactedSecret): Promise<Readonly<Record<string, RedactedSecret>>>;
}

/** A database login of one run, made by OpenBao's database secrets engine (X04 PR 3b). */
export interface RunDatabaseLogin {
  readonly username: RedactedSecret;
  readonly password: RedactedSecret;
}

/**
 * Short-lived database logins for a run's tools (X04 PR 3b, ADR-M69 §2.4, QUESTIONS #535, #537,
 * #540): one OpenBao database role per run, `kdocs-<run_id>`, whose only grant is `grantRole`.
 * X06 (ADR-M108 §2.8, QUESTIONS #700): a `read_code` tool's login has the role
 * `kdocs-<run_id>-code` and the project's code read role. Everything is found again from the run
 * ID, so no lease ID ever travels or is stored (R031).
 */
export interface RunDatabaseCredentials {
  /** Creates (or replaces) the run's role and issues one login that lives `ttlSeconds`. */
  issueRunLogin(input: {
    readonly runId: string;
    readonly grantRole: string;
    readonly ttlSeconds: number;
    /** X06: `code` for a `read_code` tool; `docs` when absent. */
    readonly kind?: 'docs' | 'code';
  }): Promise<RunDatabaseLogin>;
  /** Revokes every login of the run and deletes its roles. Revoking twice is harmless. */
  revokeRunLogins(runId: string): Promise<void>;
}

/** A signature and the version of the signing key that made it. */
export interface SignatureResult {
  /** The signature as returned by the signing service, including its version prefix. */
  readonly signature: string;
  /** Signing key version; stored in `run_contracts.key_version` (D-05 §6.4). */
  readonly keyVersion: number;
}

/** Signs Run Contracts with the platform key. The key never leaves the secret manager. */
export interface RunContractSigner {
  /** Signs the exact bytes (the canonical JSON of the contract). Latest key version by default. */
  sign(payload: Uint8Array, options?: { keyVersion?: number }): Promise<SignatureResult>;
}

/** Verifies Run Contract signatures (runner, D-03 §8). */
export interface RunContractVerifier {
  /** True when `signature` is a valid signature of `payload`. The key version comes from the signature. */
  verify(payload: Uint8Array, signature: string): Promise<boolean>;
  /** The public key of one key version, as raw Ed25519 bytes (32 bytes). */
  publicKey(keyVersion: number): Promise<Uint8Array>;
}
