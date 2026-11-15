// Reads the env file for `pnpm doctor` (D-08 V07 AC3). Only allowlisted, non-secret settings are
// kept; for each required secret only whether it is set (never its value, its length or a hash).
// The required secrets are the keys `.env.example` marks with the placeholder `CHANGEME`.
import type { EnvFacts, SecretState } from './types.js';

/** Non-secret settings doctor needs. Never add a password, key, token or salt here. */
export const ENV_ALLOWLIST = [
  'COMPOSE_PROJECT_NAME',
  'SDLC_OPENBAO_TLS_DIR',
  'SDLC_BACKUP_DIR',
  // O03 (design/ADR-M101): how old the newest backup may be, in hours.
  'SDLC_BACKUP_WARN_HOURS',
  'SDLC_BACKUP_FAIL_HOURS',
  // O05 (design/ADR-M102): how many days before a secret ID ends doctor warns.
  'SDLC_APPROLE_WARN_DAYS',
  // O04 (design/ADR-M103): the size of an append-only table that is a warning, in GiB.
  'SDLC_DB_TABLE_WARN_GB',
  // Team access (V09, design/ADR-M67): addresses, names, a folder and an origin; none is secret.
  'SDLC_ACCESS_BIND_ADDR',
  'SDLC_ACCESS_HOST_PORT',
  'SDLC_ACCESS_HOSTNAME',
  'SDLC_ACCESS_IPS',
  'SDLC_ACCESS_TLS_DIR',
  'SDLC_ACCESS_PROXY_IP',
  'SDLC_API_TRUSTED_PROXY',
  'SDLC_API_PUBLIC_ORIGIN',
  'SDLC_API_WEB_SIGNIN',
  // GitHub webhooks (O08, design/ADR-M112 §2.9): a switch, an address, a port and a network.
  'SDLC_API_GITHUB_WEBHOOKS',
  'SDLC_ACCESS_WEBHOOK_BIND_ADDR',
  'SDLC_ACCESS_WEBHOOK_HOST_PORT',
  'SDLC_ACCESS_WEBHOOK_ALLOW_CIDR',
  // The runner on its own Engine (O01, design/ADR-M91): an address, not a secret.
  'SDLC_RUNNER_LINK_ADDR',
] as const;

export const PLACEHOLDER = 'CHANGEME';

function entries(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"'))
      value = value.slice(1, -1);
    out.set(key, value);
  }
  return out;
}

/** The keys of `.env.example` whose value is the placeholder: the secrets `init-env.sh` fills. */
export function requiredSecrets(exampleText: string): string[] {
  return [...entries(exampleText)]
    .filter(([, value]) => value === PLACEHOLDER)
    .map(([key]) => key)
    .sort();
}

/** The non-empty values of the named keys only; every other value of the file is dropped. */
export function allowedValues(text: string, keys: readonly string[]): Record<string, string> {
  const all = entries(text);
  const values: Record<string, string> = {};
  for (const key of keys) {
    const value = all.get(key);
    if (value !== undefined && value !== '') values[key] = value;
  }
  return values;
}

export function parseEnvFacts(text: string, required: readonly string[]): EnvFacts {
  const all = entries(text);
  const values = allowedValues(text, ENV_ALLOWLIST);
  const secrets: Record<string, SecretState> = {};
  for (const key of required) {
    const value = all.get(key);
    secrets[key] =
      value === undefined
        ? 'missing'
        : value === ''
          ? 'empty'
          : value === PLACEHOLDER
            ? 'placeholder'
            : 'set';
  }
  // `all` (with every value) goes out of scope here; nothing else keeps it.
  return { values, secrets };
}
