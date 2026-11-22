// Encrypted key file for throw-away dev OpenBao unseal shares (D-08 V24, issue #562).
// Plaintext shares never touch disk: encrypted in memory with age (scrypt) and written mode 600.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { Decrypter, Encrypter } from 'age-encryption';

export const DEV_KEY_FILE_NAME = 'dev-openbao-keys.age';
export const KEY_THRESHOLD = 2;
export const SCRYPT_LOG_N = 18;
const RECORD_VERSION = 1;
const AGE_HEADER = 'age-encryption.org/v1\n';
const MAX_FILE_BYTES = 64 * 1024;

export interface DevKeyRecord {
  readonly project: string;
  readonly createdAt: string;
  readonly shares: readonly string[];
}

export type DevKeyFileErrorCode =
  'missing' | 'mode' | 'invalid' | 'wrong_passphrase' | 'project_mismatch';

export class DevKeyFileError extends Error {
  constructor(readonly code: DevKeyFileErrorCode) {
    super(`dev key file: ${code}`);
  }
}

export function devKeyFileFor(envFile: string): string {
  return path.join(path.dirname(path.resolve(envFile)), DEV_KEY_FILE_NAME);
}

export async function encryptDevKeys(
  record: DevKeyRecord,
  passphrase: string,
  logN = SCRYPT_LOG_N,
): Promise<Uint8Array> {
  if (record.shares.length !== KEY_THRESHOLD || record.shares.some((s) => s === '')) {
    throw new DevKeyFileError('invalid');
  }
  const enc = new Encrypter();
  enc.setPassphrase(passphrase);
  enc.setScryptWorkFactor(logN);
  const body = JSON.stringify({
    v: RECORD_VERSION,
    project: record.project,
    created_at: record.createdAt,
    threshold: KEY_THRESHOLD,
    shares: record.shares,
  });
  return enc.encrypt(body);
}

function parseRecord(text: string): DevKeyRecord {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new DevKeyFileError('invalid');
  }
  const b = body as Record<string, unknown>;
  const shares = b.shares;
  if (
    b.v !== RECORD_VERSION ||
    typeof b.project !== 'string' ||
    typeof b.created_at !== 'string' ||
    b.threshold !== KEY_THRESHOLD ||
    !Array.isArray(shares) ||
    shares.length !== KEY_THRESHOLD ||
    !shares.every((s) => typeof s === 'string' && s !== '')
  ) {
    throw new DevKeyFileError('invalid');
  }
  return { project: b.project, createdAt: b.created_at, shares: shares as string[] };
}

export async function decryptDevKeys(
  bytes: Uint8Array,
  passphrase: string,
  expectedProject: string,
): Promise<DevKeyRecord> {
  const head = Buffer.from(bytes.subarray(0, 64)).toString('latin1');
  if (!head.startsWith(AGE_HEADER)) throw new DevKeyFileError('invalid');
  const dec = new Decrypter();
  dec.addPassphrase(passphrase);
  let text: string;
  try {
    text = await dec.decrypt(bytes, 'text');
  } catch {
    throw new DevKeyFileError('wrong_passphrase');
  }
  const record = parseRecord(text);
  if (record.project !== expectedProject) throw new DevKeyFileError('project_mismatch');
  return record;
}

/** Atomic write with mode 600 (never leaves plaintext or world-readable key file). */
export function writeDevKeyFile(file: string, bytes: Uint8Array): void {
  const dir = path.dirname(file);
  const temp = path.join(dir, `.${path.basename(file)}.${randomBytes(8).toString('hex')}`);
  const fd = fs.openSync(
    temp,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
    0o600,
  );
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } catch (err) {
    fs.closeSync(fd);
    fs.rmSync(temp, { force: true });
    throw err;
  }
  fs.closeSync(fd);
  fs.renameSync(temp, file);
}

/** Reads the key file after verifying mode 600 and bounded size. */
export function readDevKeyFile(file: string): Uint8Array {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch {
    throw new DevKeyFileError('missing');
  }
  if (!stat.isFile() || stat.size === 0 || stat.size > MAX_FILE_BYTES) {
    throw new DevKeyFileError('invalid');
  }
  if ((stat.mode & 0o077) !== 0) throw new DevKeyFileError('mode');
  return new Uint8Array(fs.readFileSync(file));
}
