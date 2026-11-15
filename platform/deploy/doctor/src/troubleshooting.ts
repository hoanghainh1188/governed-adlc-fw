// Every row of platform/deploy/README.md "Troubleshooting" has a check of `pnpm doctor`, or a
// stated reason why it has none (D-08 V07 AC4). The key is the start of the row's first cell; a
// static test fails when a row is added without an entry, or an entry has no row.
import type { MessageKey } from '@sdlc/messages';

import type { CheckId } from './types.js';

export type Coverage = { readonly checks: readonly CheckId[] } | { readonly reason: MessageKey };

export const TROUBLESHOOTING: Readonly<Record<string, Coverage>> = {
  '`sdlc-api`, `sdlc-worker` or `sdlc-runner` restart every minute': {
    checks: ['services.health', 'openbao.state', 'credentials.logs'],
  },
  '`up.sh` times out': { checks: ['services.health', 'openbao.state', 'models.litellm'] },
  'A log line ending in `_missing`': { checks: ['credentials.logs'] },
  '`openbao` does not start': { checks: ['openbao.tls_files'] },
  "`up.sh` warns that OpenBao's TLS certificate ends soon": { checks: ['openbao.tls_expiry'] },
  '"AppRole login failed': { checks: ['credentials.approle', 'credentials.logs'] },
  '`worker.runs_off`': { checks: ['credentials.approle', 'credentials.logs'] },
  'Intents wait at G8': { checks: ['credentials.logs'] },
  '`worker.cost_sync_gap`': { checks: ['credentials.logs'] },
  'An evaluation stays `queued`': { reason: 'doctor.no_check.evaluation' },
  'LiteLLM lists no model': { checks: ['models.litellm'] },
  'A service stays unhealthy': { checks: ['services.health'] },
  'Valkey writes fail': { checks: ['valkey.memory'] },
  // The trial stack (V08).
  'The trial stack does not start after a reboot': { checks: ['openbao.state', 'env.file'] },
  // Team access (V09, design/ADR-M67).
  '`up.sh` says the profile access is not ready': {
    checks: [
      'access.tls_files',
      'access.tls_names',
      'access.public_origin',
      'access.trusted_proxy',
    ],
  },
  '`sdlc-access` does not start': { checks: ['access.proxy', 'access.tls_files'] },
  // GitHub webhooks (O08, design/ADR-M112 §2.9).
  'GitHub shows failed webhook deliveries': { checks: ['github.webhook', 'access.ports'] },
  'People on other machines get a certificate error': {
    checks: ['access.tls_names', 'access.tls_expiry'],
  },
  'Every person gets `429` at the same time': { reason: 'doctor.no_check.shared_address' },
};
