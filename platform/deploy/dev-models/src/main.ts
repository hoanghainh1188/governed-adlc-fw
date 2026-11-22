// Entry point for `pnpm dev:models:up` and `pnpm dev:models:down` (D-08 V24, issue #562).
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import { exec } from '../../steps/dist/exec.js';

import { DevKeyFileError } from './keys.js';
import { DevModelsGuardrailError, DevModelsStepError, devModelsDown, devModelsUp } from './up.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const DEFAULT_ENV_FILE = path.join(REPO_ROOT, 'platform/deploy/.env');

/** Reads one hidden line from an interactive terminal without echoing characters. */
function readHiddenTty(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    process.stderr.write(prompt);
    const stdin = process.stdin;
    const rl = readline.createInterface({ input: stdin, terminal: false });
    if (stdin.isTTY) stdin.setRawMode(true);
    let value = '';

    const finish = (err?: Error) => {
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.removeListener('data', onData);
      rl.close();
      process.stderr.write('\n');
      if (err) reject(err);
      else resolve(value);
    };

    const onData = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      for (const ch of text) {
        if (ch === '\u0003') {
          finish(new Error('interrupted'));
          return;
        }
        if (ch === '\r' || ch === '\n') {
          finish();
          return;
        }
        if (ch === '\u007f' || ch === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        value += ch;
      }
    };

    stdin.on('data', onData);
  });
}

function usage(): void {
  process.stderr.write(
    [
      'Usage:',
      '  pnpm dev:models:up [--ollama <url>]   Bootstrap/unseal dev OpenBao and start models (litellm, litellm-agent)',
      '  pnpm dev:models:down                  Stop dev LiteLLM services (volumes preserved)',
      '',
    ].join('\n'),
  );
}

async function cmdUp(args: readonly string[]): Promise<number> {
  let ollamaUrl: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--ollama' && args[i + 1]) {
      ollamaUrl = args[i + 1];
      i += 1;
    } else {
      usage();
      return 2;
    }
  }

  let activeCleanup: (() => Promise<void>) | null = null;
  const onSignal = (signal: NodeJS.Signals) => {
    void (async () => {
      if (activeCleanup) await activeCleanup().catch(() => undefined);
      process.stderr.write(`\nReceived ${signal}; temporary tokens revoked.\n`);
      process.exit(130);
    })();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    const res = await devModelsUp({
      repoRoot: REPO_ROOT,
      envFile: process.env.SDLC_ENV_FILE || DEFAULT_ENV_FILE,
      nodeEnv: process.env.NODE_ENV,
      stdinIsTTY: Boolean(process.stdin.isTTY),
      ollamaUrl,
      exec,
      prompts: { hidden: readHiddenTty },
      log: (line) => process.stdout.write(`${line}\n`),
      onActiveCleanup: (fn) => {
        activeCleanup = fn;
      },
    });
    process.stdout.write(
      [
        '',
        '=== Dev Models Ready ===',
        `Compose project : ${res.composeProject}`,
        `OpenBao state   : ${res.state} -> unsealed`,
        `Key file        : ${res.keyFile}`,
        'Next step       : pnpm test:agent-api',
        '',
      ].join('\n'),
    );
    return 0;
  } catch (error) {
    if (error instanceof DevModelsGuardrailError) {
      for (const msg of error.messages) process.stderr.write(`${msg}\n`);
      return 1;
    }
    if (error instanceof DevKeyFileError) {
      process.stderr.write(`Key file error (${error.code}).\n`);
      return 1;
    }
    if (error instanceof DevModelsStepError) {
      process.stderr.write(`Step "${error.step}" failed:\n${error.detail}\n`);
      return 1;
    }
    throw error;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

async function cmdDown(): Promise<number> {
  const r = await devModelsDown({
    repoRoot: REPO_ROOT,
    envFile: process.env.SDLC_ENV_FILE || DEFAULT_ENV_FILE,
    exec,
  });
  if (r.status !== 0) {
    process.stderr.write(`dev:models:down failed:\n${r.stderr}\n`);
    return 1;
  }
  process.stdout.write('Stopped dev LiteLLM services (OpenBao and Postgres volumes preserved).\n');
  return 0;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  let code: number;
  if (command === 'up') code = await cmdUp(rest);
  else if (command === 'down') code = await cmdDown();
  else {
    usage();
    code = 2;
  }
  process.exitCode = code;
}

await main();
