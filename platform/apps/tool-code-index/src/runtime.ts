// The run's settings and credential of the `read_code` tool (task X06 PR 2, design/ADR-M108 §2.8):
// the two files the runner wrote into the tool's runtime volume. Checked before use; a file that
// does not match stops the tool, and the runner then sees no healthy container (`tool_unavailable`).
import type { CodeToolRuntimeConfig, CodeToolRuntimeCredentials } from '@sdlc/contracts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SCHEMA = /^kcode_p[0-9a-f]{32}$/;
const HOST = /^[a-z][a-z0-9-]{0,62}$/;

/** Why the files were refused (no value is ever echoed). */
export class RuntimeError extends Error {
  override readonly name = 'RuntimeError';

  constructor(readonly field: string) {
    super(`tool.runtime_invalid: ${field}`);
  }
}

function object(text: string, field: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new RuntimeError(field);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RuntimeError(field);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, pattern: RegExp, field: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) throw new RuntimeError(field);
  return value;
}

function secret(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '' || value.length > 4096) {
    throw new RuntimeError(field);
  }
  return value;
}

export function readRuntime(
  configText: string,
  credentialsText: string,
): { config: CodeToolRuntimeConfig; credentials: CodeToolRuntimeCredentials } {
  const c = object(configText, 'config');
  if (c.schema_version !== 1) throw new RuntimeError('schema_version');
  const db = (c.database ?? {}) as Record<string, unknown>;
  const port = db.port;
  if (!Number.isSafeInteger(port) || (port as number) < 1 || (port as number) > 65535) {
    throw new RuntimeError('database.port');
  }
  const config: CodeToolRuntimeConfig = {
    schema_version: 1,
    index_id: text(c.index_id, UUID, 'index_id'),
    schema: text(c.schema, SCHEMA, 'schema'),
    database: {
      host: text(db.host, HOST, 'database.host'),
      port: port as number,
      name: text(db.name, HOST, 'database.name'),
    },
  };
  const k = object(credentialsText, 'credentials');
  if (Object.keys(k).some((key) => key !== 'db_username' && key !== 'db_password')) {
    throw new RuntimeError('credentials');
  }
  const credentials: CodeToolRuntimeCredentials = {
    db_username: secret(k.db_username, 'db_username'),
    db_password: secret(k.db_password, 'db_password'),
  };
  return { config, credentials };
}
