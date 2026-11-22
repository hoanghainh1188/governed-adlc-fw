// Entry point for `pnpm demo:up`, `pnpm demo:walkthrough`, and `pnpm demo:down [--wipe]` (V23).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { demoDown, demoDownRefusal } from './down.js';
import { DEMO_PROJECT, demoApiUrl } from './env-file.js';
import { exec, gatherDemoFacts, sdlc } from './host.js';
import { demoPreflight } from './preflight.js';
import { DemoStepError, demoUp } from './up.js';
import { runWalkthrough } from './walkthrough.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const DEMO_DIR = path.join(REPO_ROOT, 'platform/deploy/.demo');
const DEMO_ENV = path.join(DEMO_DIR, '.env');

function usage(): void {
  process.stderr.write(
    [
      'Usage:',
      '  pnpm demo:up            Start the 5-minute local demo stack (Lite Mode, no GitHub App)',
      '  pnpm demo:walkthrough   Run the guided G1-G3 + Rule M21 + Evidence Pack walkthrough',
      '  pnpm demo:down [--wipe] Stop the demo stack (--wipe removes volumes and .demo/ state)',
      '',
    ].join('\n'),
  );
}

async function cmdUp(): Promise<number> {
  const facts = await gatherDemoFacts(DEMO_ENV, DEMO_PROJECT);
  const refusals = demoPreflight(facts);
  if (refusals.length > 0) {
    for (const r of refusals) process.stderr.write(`${r.message}\n`);
    return 1;
  }

  try {
    const res = await demoUp({
      repoRoot: REPO_ROOT,
      demoDir: DEMO_DIR,
      project: DEMO_PROJECT,
      exec,
      sdlc,
      log: (line) => process.stdout.write(`${line}\n`),
    });
    process.stdout.write(
      [
        '',
        '=== Local Demo Ready (Lite Mode, throw-away OpenBao, no GitHub App) ===',
        `Dashboard & API : ${res.apiUrl}`,
        `Person A CLI    : XDG_CONFIG_HOME="${res.personAConfigHome}" pnpm adlc ...`,
        `Person B CLI    : XDG_CONFIG_HOME="${res.personBConfigHome}" pnpm adlc ...`,
        '',
        'Next steps:',
        '  1. Run the guided walkthrough (U10 uploaded plan + Rule M21 + Evidence Pack):',
        '       pnpm demo:walkthrough',
        '  2. Tear down and wipe all demo containers, volumes, and credentials:',
        '       pnpm demo:down --wipe',
        '',
      ].join('\n'),
    );
    return 0;
  } catch (error) {
    if (error instanceof DemoStepError) {
      process.stderr.write(`Demo step "${error.step}" failed:\n${error.detail}\n`);
      return 1;
    }
    throw error;
  }
}

async function cmdWalkthrough(): Promise<number> {
  let envText: string | undefined;
  try {
    envText = fs.readFileSync(DEMO_ENV, 'utf8');
  } catch {
    envText = undefined;
  }
  const refusal = demoDownRefusal(envText, DEMO_PROJECT);
  if (refusal !== undefined) {
    process.stderr.write('No running demo stack found. Start it first with `pnpm demo:up`.\n');
    return 1;
  }
  await runWalkthrough({
    repoRoot: REPO_ROOT,
    personAConfigHome: path.join(DEMO_DIR, 'person-a'),
    personBConfigHome: path.join(DEMO_DIR, 'person-b'),
    apiUrl: demoApiUrl(envText!),
    sdlc,
    log: (line) => process.stdout.write(`${line}\n`),
  });
  return 0;
}

async function cmdDown(args: readonly string[]): Promise<number> {
  const wipe = args.includes('--wipe');
  const unknown = args.filter((a) => a !== '--wipe');
  if (unknown.length > 0) {
    usage();
    return 2;
  }

  let envText: string | undefined;
  try {
    envText = fs.readFileSync(DEMO_ENV, 'utf8');
  } catch {
    envText = undefined;
  }
  const refusal = demoDownRefusal(envText, DEMO_PROJECT);
  if (refusal === 'no_env') {
    process.stderr.write(`No demo env file found at ${DEMO_ENV}. Nothing to stop.\n`);
    return 1;
  }
  if (refusal === 'not_demo') {
    process.stderr.write(
      `Refused: ${DEMO_ENV} does not belong to Compose project "${DEMO_PROJECT}".\n`,
    );
    return 1;
  }

  const r = await demoDown({
    repoRoot: REPO_ROOT,
    demoDir: DEMO_DIR,
    project: DEMO_PROJECT,
    wipe,
    exec,
  });
  if (r.status !== 0) {
    process.stderr.write(`demo:down failed:\n${r.stderr}\n`);
    return 1;
  }
  process.stdout.write(
    wipe
      ? 'Demo stack stopped and all demo volumes and .demo/ files removed.\n'
      : 'Demo stack stopped. Pass `--wipe` to also remove demo volumes and .demo/ files.\n',
  );
  return 0;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  let code: number;
  if (command === 'up') code = await cmdUp();
  else if (command === 'walkthrough') code = await cmdWalkthrough();
  else if (command === 'down') code = await cmdDown(rest);
  else {
    usage();
    code = 2;
  }
  process.exitCode = code;
}

await main();
