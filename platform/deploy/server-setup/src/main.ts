#!/usr/bin/env node
// `pnpm server:setup --settings <file outside the repo>` (D-08 V16, QUESTIONS #616,
// design/ADR-M98): README "Fresh deployment" steps 2–7 on a server. Run by the owner in a terminal
// on the server (the macOS Terminal app over SSH, or the server's console) only: it shows key shares
// and asks for them at hidden prompts, so it refuses to run when stdin or stdout is not a terminal,
// and the Claude Code hook refuses it (R035). Ctrl-C, SIGTERM and SIGHUP stop it before the next
// step; a stop before `configure` revokes the root token.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { t, type MessageKey, type MessageParams } from '@sdlc/messages';

import { exec } from '../../steps/dist/exec.js';
import { DeployStepError } from '../../steps/dist/fresh-deployment.js';
import { SecretBag } from '../../steps/dist/secrets.js';

import { parseSettings, SettingsError, type ServerSettings } from './settings.js';
import { README_SECTIONS, serverSetup, SetupRefused, SetupStopped } from './setup.js';
import { processTerminal } from './process-terminal.js';
import { terminalRefusal } from './terminal.js';

const EXIT = { ok: 0, failed: 1, usage: 2, interrupted: 130 } as const;
const repoRoot = path.resolve(import.meta.dirname, '../../../..');
const README = 'platform/deploy/README.md';

/** The catalog message of each refusal. */
const REFUSAL_KEYS = {
  stdout_not_terminal: 'server_setup.refused.stdout_not_terminal',
  stdin_not_terminal: 'server_setup.refused.stdin_not_terminal',
  litellm_keys_in_env: 'server_setup.refused.litellm_keys_in_env',
  trial_project: 'server_setup.refused.trial_project',
  no_project: 'server_setup.refused.no_project',
  pgp_key_invalid: 'server_setup.refused.pgp_key_invalid',
  no_share: 'server_setup.refused.no_share',
  secret_file: 'server_setup.refused.secret_file',
  secret_file_mode: 'server_setup.refused.secret_file_mode',
  env_conflict: 'server_setup.refused.env_conflict',
} as const satisfies Record<
  SetupRefused['code'] | NonNullable<ReturnType<typeof terminalRefusal>>,
  MessageKey
>;

const sayError = (key: MessageKey, params?: MessageParams) =>
  process.stderr.write(`${t(key, params)}\n`);

/** `BAO_KEY_SHARES` and `BAO_KEY_THRESHOLD` of `bootstrap.conf` (the one source, ADR-M19). */
function keySettings(): { shares: number; threshold: number } {
  const conf = fs.readFileSync(
    path.join(repoRoot, 'platform/deploy/openbao/bootstrap/bootstrap.conf'),
    'utf8',
  );
  const value = (key: string) => Number(new RegExp(`^${key}=(\\d+)$`, 'm').exec(conf)?.[1]);
  return { shares: value('BAO_KEY_SHARES'), threshold: value('BAO_KEY_THRESHOLD') };
}

function readSettings(file: string, shares: number): ServerSettings | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    sayError('server_setup.settings.unreadable', { path: file });
    return undefined;
  }
  try {
    return parseSettings(text, os.homedir(), shares);
  } catch (error) {
    if (!(error instanceof SettingsError)) throw error;
    sayError('server_setup.settings.invalid', { field: error.field, path: file });
    return undefined;
  }
}

/** The settings file must be outside the repository (it names secret files). */
function insideRepo(file: string): boolean {
  const rel = path.relative(repoRoot, file);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

async function main(argv: string[]): Promise<number> {
  const refusal = terminalRefusal(process.stdin.isTTY === true, process.stdout.isTTY === true);
  if (refusal) {
    sayError(REFUSAL_KEYS[refusal]);
    return EXIT.usage;
  }
  let settingsFile: string | undefined;
  try {
    ({
      values: { settings: settingsFile },
    } = parseArgs({ args: argv, options: { settings: { type: 'string' } }, strict: true }));
  } catch {
    sayError('server_setup.usage');
    return EXIT.usage;
  }
  if (!settingsFile) {
    sayError('server_setup.usage');
    return EXIT.usage;
  }
  const file = path.resolve(settingsFile);
  if (insideRepo(file)) {
    sayError('server_setup.settings.inside_repo', { path: file });
    return EXIT.usage;
  }
  const keys = keySettings();
  const settings = readSettings(file, keys.shares);
  if (!settings) return EXIT.usage;

  let stop = false;
  const onSignal = () => {
    stop = true;
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  process.on('SIGHUP', onSignal);
  const terminal = processTerminal();
  try {
    const r = await serverSetup(settings, {
      repoRoot,
      envFile: settings.envFile ?? path.join(repoRoot, 'platform/deploy/.env'),
      exec,
      terminal,
      bag: new SecretBag(),
      keys,
      stopRequested: () => stop,
      now: () => new Date(),
    });
    if (r.outcome === 'tls') return EXIT.ok;
    terminal.say(r.doctorOk ? 'server_setup.done' : 'server_setup.done_doctor_failed', {
      api_url: r.apiUrl ?? '',
    });
    return r.doctorOk ? EXIT.ok : EXIT.failed;
  } catch (error) {
    if (!(error instanceof SetupStopped)) {
      // Never the message: it may quote output that held a secret.
      sayError('server_setup.unexpected', {
        kind: error instanceof Error ? error.name : 'unknown',
      });
      return EXIT.failed;
    }
    const section = `${README}${README_SECTIONS[error.step]}`;
    const cause = error.cause;
    if (cause instanceof SetupRefused) {
      sayError(REFUSAL_KEYS[cause.code], cause.params);
    } else if (cause instanceof DeployStepError) {
      sayError('server_setup.failed', { step: error.step, what: cause.step, section });
      process.stderr.write(`${cause.detail}\n`);
    } else if (error.reason === 'interrupted') {
      sayError('server_setup.interrupted', { step: error.step });
    } else {
      sayError('server_setup.unexpected', {
        kind: cause instanceof Error ? cause.name : 'unknown',
      });
      sayError('server_setup.failed_at', { step: error.step, section });
    }
    sayError(error.rootRevoked ? 'server_setup.stopped' : 'server_setup.stopped_root_not_revoked');
    return error.reason === 'interrupted' ? EXIT.interrupted : EXIT.failed;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    process.off('SIGHUP', onSignal);
  }
}

process.exitCode = await main(process.argv.slice(2));
