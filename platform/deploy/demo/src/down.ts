// `pnpm demo:down [--wipe]` (D-08 V23, issue #561): stops the isolated `sdlc-demo` stack and,
// when `--wipe` is passed, removes all demo volumes and the `platform/deploy/.demo/` directory.
// Never touches any non-demo `sdlc_*` volumes or `platform/deploy/.env`.
import fs from 'node:fs';
import path from 'node:path';

import { DEMO_PROFILES, DEMO_PROJECT, envValue } from './env-file.js';
import type { Exec } from './up.js';

export type DemoDownRefusal = 'no_env' | 'not_demo';

/** Validates that the env file belongs to the isolated demo project. Pure. */
export function demoDownRefusal(
  envText: string | undefined,
  demoProject = DEMO_PROJECT,
): DemoDownRefusal | undefined {
  if (envText === undefined) return 'no_env';
  return envValue(envText, 'COMPOSE_PROJECT_NAME') === demoProject ? undefined : 'not_demo';
}

export interface DemoDownOptions {
  readonly repoRoot: string;
  readonly demoDir: string;
  readonly project?: string;
  readonly wipe: boolean;
  readonly exec: Exec;
}

export interface DemoDownResult {
  readonly status: number | null;
  readonly stderr: string;
}

export async function demoDown(o: DemoDownOptions): Promise<DemoDownResult> {
  const project = o.project ?? DEMO_PROJECT;
  const envFile = path.join(o.demoDir, '.env');
  const args = [
    'compose',
    '-p',
    project,
    '-f',
    path.join(o.repoRoot, 'platform/deploy/docker-compose.yml'),
    '--env-file',
    envFile,
    ...DEMO_PROFILES.flatMap((p) => ['--profile', p]),
    'down',
    '--remove-orphans',
    ...(o.wipe ? ['--volumes'] : []),
  ];
  const r = await o.exec('docker', args);
  if (r.status !== 0 || !o.wipe) return { status: r.status, stderr: r.stderr };
  fs.rmSync(o.demoDir, { recursive: true, force: true });
  return { status: 0, stderr: '' };
}
