// The services' own log events, for `pnpm doctor` (D-08 V07, QUESTIONS #402): which feature lacks
// its credential, read from the event codes the api, worker and runner log at start. Only the
// `event` field of each JSON line is read (and, for a start failure, whether its catalog message is
// the AppRole or the sealed one); no line, field value or message is ever kept or printed.
import { t, type MessageKey } from '@sdlc/messages';

import type { LogFindings, Text } from './types.js';

/** Event codes that mean a missing credential or a stopped feature, each with its fix. */
export const LOG_EVENT_FIXES: Readonly<Record<string, Text>> = {
  'api.evidence_missing': {
    key: 'doctor.fix.credentials',
    params: { command: 'api-evidence-credentials', section: 'T11 §5h' },
  },
  'worker.evidence_missing': {
    key: 'doctor.fix.credentials',
    params: { command: 'worker-evidence-credentials', section: 'T11 §5i' },
  },
  'runner.evidence_missing': {
    key: 'doctor.fix.credentials',
    params: { command: 'runner-evidence-credentials', section: 'T11 §5g' },
  },
  'worker.retention_missing': {
    key: 'doctor.fix.credentials',
    params: { command: 'worker-purge-credentials', section: 'T11 §5j' },
  },
  'worker.anchor_missing': {
    key: 'doctor.fix.credentials',
    params: { command: 'worker-anchor-credentials', section: 'T11 §5k' },
  },
  'worker.langfuse_missing': {
    key: 'doctor.fix.credentials',
    params: { command: 'worker-langfuse-credentials', section: 'T11 §5m' },
  },
  'worker.knowledge_missing': {
    key: 'doctor.fix.credentials',
    params: { command: 'worker-knowledge-credentials', section: 'T11 §5o' },
  },
  'worker.runs_off': {
    key: 'doctor.fix.credentials',
    params: { command: 'worker-credentials', section: 'T11 §5f' },
  },
  'worker.cost_sync_off': {
    key: 'doctor.fix.credentials',
    params: { command: 'worker-credentials', section: 'T11 §5f' },
  },
  'worker.cost_sync_gap': {
    key: 'doctor.fix.readme',
    params: { section: 'Scheduled spend sync (C12)' },
  },
  'api.approle_login_failed': {
    key: 'doctor.fix.credentials',
    params: { command: 'api-credentials', section: 'T11 §8' },
  },
  'worker.approle_login_failed': {
    key: 'doctor.fix.credentials',
    params: { command: 'worker-credentials', section: 'T11 §8' },
  },
  'runner.approle_login_failed': {
    key: 'doctor.fix.credentials',
    params: { command: 'runner-credentials', section: 'T11 §8' },
  },
  'openbao.sealed': { key: 'doctor.fix.unseal' },
  // O08 (ADR-M112 §2.8): the api could not read its webhook secret again.
  'webhook.secret_refresh_failed': {
    key: 'doctor.fix.credentials',
    params: { command: 'github-webhook-secret', section: 'T11 §5p' },
  },
};

/** O08 (ADR-M112 §2.9): the api's events of a delivery whose signature was correct. */
const WEBHOOK_DELIVERY_EVENTS = new Set([
  'webhook.accepted',
  'webhook.duplicate',
  'webhook.ignored',
]);

/** The start-failure events of the three processes (`*.failed`, `*.start_failed`). */
const FAILED_EVENTS: Readonly<Record<string, string>> = {
  'api.start_failed': 'api',
  'worker.failed': 'worker',
  'runner.start_failed': 'runner',
};

const STARTED_EVENTS: Readonly<Record<string, string>> = {
  'api.started': 'sdlc-api',
  'worker.started': 'sdlc-worker',
  'runner.started': 'sdlc-runner',
};

/** The fixed parts of a catalog message (its text between placeholders). */
function fragments(key: MessageKey): string[] {
  return t(key)
    .split(/\{[a-z_][a-z0-9_]*\}/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 8);
}

const LOGIN_FAILED = fragments('secrets.login_failed');
const SEALED = fragments('secrets.openbao.sealed');

function matches(message: string, parts: readonly string[]): boolean {
  let from = 0;
  for (const part of parts) {
    const at = message.indexOf(part, from);
    if (at < 0) return false;
    from = at + part.length;
  }
  return parts.length > 0;
}

/** Event codes in the log text: one each, sorted; unknown events and non-JSON lines are skipped. */
export function findLogEvents(text: string): LogFindings {
  const events = new Set<string>();
  const started = new Set<string>();
  let webhookDelivered = false;
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    const event = (parsed as { event?: unknown }).event;
    if (typeof event !== 'string') continue;
    if (Object.hasOwn(STARTED_EVENTS, event)) started.add(STARTED_EVENTS[event] ?? '');
    if (WEBHOOK_DELIVERY_EVENTS.has(event)) webhookDelivered = true;
    if (Object.hasOwn(LOG_EVENT_FIXES, event)) events.add(event);
    const process = FAILED_EVENTS[event];
    if (process !== undefined) {
      const message = (parsed as { message?: unknown }).message;
      if (typeof message !== 'string') continue;
      if (matches(message, LOGIN_FAILED)) events.add(`${process}.approle_login_failed`);
      else if (matches(message, SEALED)) events.add('openbao.sealed');
    }
  }
  return { events: [...events].sort(), started: [...started].sort(), webhookDelivered };
}
