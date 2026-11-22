// Real host bindings for `pnpm demo:up`, `pnpm demo:walkthrough`, and `pnpm demo:down` (D-08 V23).
import fs from 'node:fs';
import os from 'node:os';

import { processApiIo, processContext, runCli, type CliContext } from '@sdlc/cli';

import { exec } from '../../steps/dist/exec.js';

import type { DemoHostFacts } from './preflight.js';
import type { Sdlc } from './up.js';

export { exec };

/** Runs one `adlc ...` command in-process with an isolated environment. */
export const sdlc: Sdlc = async (argv, env, stdin) => {
  const out: string[] = [];
  const err: string[] = [];
  const base = processContext();
  const io = processApiIo();
  const ctx: CliContext = {
    ...base,
    env: { PATH: process.env.PATH, HOME: os.homedir(), ...env },
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    api:
      stdin === undefined
        ? io
        : { ...io, stdinIsTTY: false, readStdin: () => Promise.resolve(stdin) },
  };
  const status = await runCli(argv, ctx);
  return { status, stdout: out.join('\n'), stderr: err.join('\n') };
};

async function dockerFacts(): Promise<DemoHostFacts['docker']> {
  const info = await exec('docker', ['info', '--format', '{{.MemTotal}}']);
  if (info.status !== 0) return null;
  const compose = await exec('docker', ['compose', 'version', '--short']);
  return {
    composeVersion: compose.status === 0 ? compose.stdout.trim() : null,
    memoryBytes: Number(info.stdout.trim()) || 0,
  };
}

async function listVolumes(): Promise<string[] | null> {
  const r = await exec('docker', ['volume', 'ls', '-q']);
  if (r.status !== 0) return null;
  return r.stdout
    .split('\n')
    .map((v) => v.trim())
    .filter((v) => v !== '');
}

async function opensslVersion(): Promise<string | null> {
  const r = await exec('openssl', ['version']);
  return r.status === 0 ? r.stdout.trim() : null;
}

export async function gatherDemoFacts(
  envFile: string,
  demoProject: string,
): Promise<DemoHostFacts> {
  const docker = await dockerFacts();
  const allVolumes = docker ? await listVolumes() : [];
  return {
    nodeEnv: process.env.NODE_ENV,
    envFile,
    envFileExists: fs.existsSync(envFile),
    nonDemoVolumes: allVolumes === null ? null : allVolumes.filter((v) => v.startsWith('sdlc_')),
    demoVolumes:
      allVolumes === null ? null : allVolumes.filter((v) => v.startsWith(`${demoProject}_`)),
    docker,
    opensslVersion: await opensslVersion(),
  };
}
