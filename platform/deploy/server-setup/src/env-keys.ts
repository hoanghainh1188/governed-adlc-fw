// The env file keys that the `access` and `runner_link` settings of `pnpm server:setup` write
// (D-08 V20; README "Team access" step 2, "The runner on its own Docker Engine" step 3). None is a
// secret. A key that already holds another value is refused, never overwritten (V20 AC3). Pure: the
// caller reads and writes the file.
import { envValue, setEnvValue } from '../../steps/dist/env-file.js';

import type { ServerSettings } from './settings.js';

/** The proxy's fixed address when the env file does not set one (`.env.example`, ADR-M67 §2.6). */
export const DEFAULT_PROXY_IP = '172.30.1.6';

/** Values of `.env.example` that the settings may replace: they are defaults, not choices. */
const TEMPLATE_DEFAULTS: Readonly<Record<string, string>> = { SDLC_ACCESS_HOST_PORT: '8443' };

/** A key the env file already sets to another value; `key` is a name, never a value. */
export class EnvKeyConflict extends Error {
  constructor(readonly key: string) {
    super(`env key ${key} already holds another value`);
  }
}

/** The keys the settings ask for, in the order they are written. Pure. */
export function settingsEnvKeys(
  settings: ServerSettings,
  envText: string,
): ReadonlyArray<readonly [string, string]> {
  const keys: Array<readonly [string, string]> = [];
  const a = settings.access;
  if (a) {
    keys.push(
      ['SDLC_ACCESS_BIND_ADDR', a.bindAddr],
      ['SDLC_ACCESS_HOST_PORT', String(a.port)],
      ['SDLC_ACCESS_HOSTNAME', a.hostname],
      ['SDLC_ACCESS_TLS_DIR', a.tlsDir],
      // The api trusts X-Forwarded-For from the proxy's address only (ADR-M67 §2.6).
      ['SDLC_API_TRUSTED_PROXY', envValue(envText, 'SDLC_ACCESS_PROXY_IP') || DEFAULT_PROXY_IP],
    );
    if (a.ips.length > 0) keys.push(['SDLC_ACCESS_IPS', a.ips.join(' ')]);
  }
  const r = settings.runnerLink;
  if (r) {
    keys.push(
      ['SDLC_RUNNER_LINK_ADDR', r.linkAddr],
      ['SDLC_RUNNER_SOURCE_CIDR', r.sourceCidr],
      ['SDLC_RUNNER_DOCKER_HOST', r.dockerHost],
    );
  }
  return keys;
}

/**
 * The env text with the keys set, and the keys it changed. An empty key, or one equal to its
 * template default, is set; one that already holds the same value is left as it is; one that holds
 * another value throws `EnvKeyConflict`, before anything changes. Pure.
 */
export function applyEnvKeys(
  envText: string,
  keys: ReadonlyArray<readonly [string, string]>,
): { readonly text: string; readonly changed: readonly string[] } {
  for (const [key, value] of keys) {
    const current = envValue(envText, key) ?? '';
    if (current !== '' && current !== value && current !== TEMPLATE_DEFAULTS[key]) {
      throw new EnvKeyConflict(key);
    }
  }
  let text = envText;
  const changed: string[] = [];
  for (const [key, value] of keys) {
    if ((envValue(text, key) ?? '') === value) continue;
    text = setEnvValue(text, key, value);
    changed.push(key);
  }
  return { text, changed };
}
