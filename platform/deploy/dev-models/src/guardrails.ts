// Pure guardrails for `pnpm dev:models:up` (D-08 V24, issue #562).
// Refuses NODE_ENV=production and non-TTY stdin when a secret prompt is required.

export const MIN_PASSPHRASE_LENGTH = 12;
export const MAX_PASSPHRASE_LENGTH = 1024;
export const DEFAULT_OLLAMA_URL = 'http://host.docker.internal:11434';

export type DevModelsRefusalCode = 'production_env' | 'not_tty';

export interface DevModelsRefusal {
  readonly code: DevModelsRefusalCode;
  readonly message: string;
}

export interface GuardrailInput {
  readonly nodeEnv: string | undefined;
  /** Whether stdin is attached to an interactive terminal. */
  readonly stdinIsTTY: boolean;
  /** Whether this run needs to prompt for a secret (passphrase or API key). */
  readonly needsSecretPrompt: boolean;
}

/** Checks safety guardrails before touching Docker or OpenBao. Empty means safe to proceed. */
export function checkDevModelsGuardrails(input: GuardrailInput): DevModelsRefusal[] {
  const out: DevModelsRefusal[] = [];
  if (input.nodeEnv === 'production') {
    out.push({
      code: 'production_env',
      message: 'Refused: pnpm dev:models:up never runs when NODE_ENV=production.',
    });
  }
  if (input.needsSecretPrompt && !input.stdinIsTTY) {
    out.push({
      code: 'not_tty',
      message:
        'Refused: secret prompts require an interactive terminal (TTY). Run pnpm dev:models:up directly in your own terminal.',
    });
  }
  return out;
}

/** Validates a new passphrase for encrypting `dev-openbao-keys.age`. Pure. */
export function validatePassphrase(
  raw: string,
): { readonly ok: true; readonly value: string } | { readonly ok: false; readonly reason: string } {
  const value = raw.normalize('NFC');
  if (value.trim() === '') return { ok: false, reason: 'Passphrase must not be blank.' };
  const len = [...value].length;
  if (len < MIN_PASSPHRASE_LENGTH) {
    return {
      ok: false,
      reason: `Passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters.`,
    };
  }
  if (len > MAX_PASSPHRASE_LENGTH) {
    return {
      ok: false,
      reason: `Passphrase must be at most ${MAX_PASSPHRASE_LENGTH} characters.`,
    };
  }
  return { ok: true, value };
}
