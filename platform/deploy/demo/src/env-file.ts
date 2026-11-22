// Environment file helpers for the 5-minute local demo stack (D-08 V23, issue #561).
// Uses Lite Mode (`core` + `platform`, observability off) in its own Compose project
// (`sdlc-demo`), never sharing volumes with the dev/production stack (`sdlc_*`). Pure.
import { envSecrets, envValue, hostPort } from '../../steps/dist/env-file.js';

export { envSecrets, envValue, hostPort };

/** Isolated Compose project for local demo: volumes are `sdlc-demo_*`, never `sdlc_*`. */
export const DEMO_PROJECT = 'sdlc-demo';

/** Profiles started by `pnpm demo:up` (Lite Mode: core stores, LiteLLM, and API/worker/dashboard). */
export const DEMO_PROFILES = ['core', 'models', 'platform'] as const;

/** OpenBao credentials commands required by `core` + `models` + `platform`. */
export const DEMO_CREDENTIALS_COMMANDS = [
  'litellm-credentials',
  'api-credentials',
  'worker-credentials',
  'api-evidence-credentials',
  'worker-evidence-credentials',
  'worker-purge-credentials',
  'worker-anchor-credentials',
] as const;

function set(text: string, key: string, value: string): string {
  const line = new RegExp(`^${key}=.*$`, 'm');
  if (!line.test(text)) throw new Error(`${key} is missing in the env file`);
  return text.replace(line, `${key}=${value}`);
}

/** Transforms a freshly generated `init-env.sh` file into a Lite Mode demo env file. Pure. */
export function demoEnv(text: string, project = DEMO_PROJECT): string {
  let out = set(text, 'COMPOSE_PROJECT_NAME', project);
  out = set(out, 'SDLC_OBSERVABILITY_ENABLED', 'false');
  out = set(out, 'LITELLM_MASTER_KEY', '');
  out = set(out, 'LITELLM_SALT_KEY', '');
  return out;
}

/** Local API and Dashboard URL for the demo stack. Pure. */
export function demoApiUrl(text: string): string {
  return `http://127.0.0.1:${hostPort(text, 'SDLC_API_HOST_PORT', 8090)}`;
}
