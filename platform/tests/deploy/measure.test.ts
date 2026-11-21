// D-08 task A10 AC4 (PR 3a): `pnpm measure` (platform/deploy/scripts/measure.sh), the resource
// measurement of a running deployment. Read only; it prints numbers and names, never an env value.
// The tests run it against a fake `docker` on the PATH.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { deployDir, readDeployFile } from './compose';

const SCRIPT = path.join(deployDir, 'scripts/measure.sh');
const ID_A = 'a'.repeat(64);
const ID_B = 'b'.repeat(64);

// The fake Engine: two containers of the project `sdlc`, memory in two units, two samples that
// differ (a counter file), one image, three volumes (one of another project).
const FAKE_DOCKER = `#!/bin/sh
echo "$*" >>"$FAKE_LOG"
case "$1" in
  info) echo "8 16777216000 29.0.0" ;;
  ps)
    case "$*" in
      *label=com.docker.compose.project=sdlc*) ;;
      *label=*) exit 0 ;;
    esac
    echo "${ID_B} postgres registry.example/postgres:17@sha256:abc"
    echo "${ID_A} litellm registry.example/litellm:1.0"
    ;;
  stats)
    n="$(cat "$FAKE_COUNT" 2>/dev/null || echo 0)"
    n=$((n + 1))
    echo "$n" >"$FAKE_COUNT"
    if [ "$n" -eq 1 ]; then
      echo "${ID_A} 10.00% 512MiB / 16GiB"
      echo "${ID_B} 1.00% 100MiB / 16GiB"
    else
      echo "${ID_A} 30.00% 1GiB / 16GiB"
      echo "${ID_B} 3.00% 200MiB / 16GiB"
    fi
    ;;
  image) echo 2500000000 ;;
  volume)
    echo "sdlc_postgres-data"
    echo "sdlc_openbao-data"
    ;;
  system)
    echo "sdlc_postgres-data 1.2GB"
    echo "sdlc_openbao-data 30MB"
    echo "sdlc_trial_data 5GB"
    echo "other_data 9GB"
    ;;
  *) exit 64 ;;
esac
`;

describe('pnpm measure (A10 AC4)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-measure-'));
  const bin = path.join(tmp, 'bin');
  const log = path.join(tmp, 'docker.log');
  const count = path.join(tmp, 'count');
  const envFile = path.join(tmp, '.env');
  const run = (args: string[]) => {
    fs.rmSync(log, { force: true });
    fs.rmSync(count, { force: true });
    return spawnSync(SCRIPT, args, {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        FAKE_LOG: log,
        FAKE_COUNT: count,
        SDLC_ENV_FILE: '',
      },
    });
  };

  beforeAll(() => {
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'docker'), FAKE_DOCKER, { mode: 0o755 });
    fs.writeFileSync(envFile, 'COMPOSE_PROJECT_NAME=sdlc\nPOSTGRES_PASSWORD=not-for-the-report\n', {
      mode: 0o600,
    });
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('is valid POSIX sh, executable, and a root script', () => {
    expect(spawnSync('sh', ['-n', SCRIPT]).status).toBe(0);
    expect(fs.statSync(SCRIPT).mode & 0o111).not.toBe(0);
    const pkg = JSON.parse(fs.readFileSync(path.join(deployDir, '../../package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.measure).toBe('platform/deploy/scripts/measure.sh');
  });

  it('runs only read-only docker commands', () => {
    const code = readDeployFile('scripts/measure.sh')
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n')
      .replace(/fail "[^"]*"/g, 'fail');
    const used = [...code.matchAll(/\bdocker ([a-z]+(?: (?:df|inspect|ls))?)/g)].map((m) => m[1]);
    expect([...new Set(used)].sort()).toEqual(
      ['image inspect', 'info', 'ps', 'stats', 'system df', 'volume ls'].sort(),
    );
    expect(code).not.toMatch(/\bdocker (exec|compose|logs|run|rm|kill|stop|cp)\b|\.Config\.Env/);
    expect(code).not.toMatch(/\btee\b|>>|\bmktemp\b/); // writes no file
  });

  it('prints the mean and the peak per service and for all, the images and the volumes', () => {
    const r = run(['--env', envFile, '--samples', '2', '--interval', '1']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('- Host: 8 CPUs, 15.6 GiB RAM, Docker Engine 29.0.0');
    expect(r.stdout).toContain('- 2 samples, 1 s apart');
    // litellm: (512 + 1024) / 2 = 768, peak 1024; CPU (10 + 30) / 2 = 20, peak 30.
    expect(r.stdout).toContain('| `litellm` | 768 | 1024 | 20.0 | 30.0 |');
    expect(r.stdout).toContain('| `postgres` | 150 | 200 | 2.0 | 3.0 |');
    // All: the mean of the two samples' sums, and the larger sum.
    expect(r.stdout).toContain('| **All** | **918** | **1224** | **22.0** | **33.0** |');
    expect(r.stdout.indexOf('`litellm`')).toBeLessThan(r.stdout.indexOf('`postgres`'));
    expect(r.stdout).toContain('| `postgres:17` | 2.50 |');
    expect(r.stdout).toContain('| `sdlc_postgres-data` | 1.2GB |');
    expect(r.stdout).not.toContain('other_data');
    // A project whose name only starts the same is not this project.
    expect(r.stdout).not.toContain('sdlc_trial_data');
    expect(r.stdout).not.toContain('registry.example');
  });

  it('reads only the project name from the env file, and only its own containers', () => {
    const r = run(['--env', envFile, '--samples', '1']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout + r.stderr).not.toContain('not-for-the-report');
    const calls = fs.readFileSync(log, 'utf8');
    expect(calls).toContain('--filter label=com.docker.compose.project=sdlc');
    expect(calls).toMatch(new RegExp(`^stats .*${ID_A} ${ID_B}$`, 'm'));
    expect(calls).not.toContain('not-for-the-report');
  });

  it('--all measures every container of the Engine, without an env file', () => {
    const r = run(['--all', '--samples', '1']);
    expect(r.status, r.stderr).toBe(0);
    expect(fs.readFileSync(log, 'utf8')).not.toContain('--filter');
    expect(r.stdout).toContain('| `other_data` | 9GB |');
  });

  it('fails with a clear message: no env file, a bad number, an unknown option, no container', () => {
    expect(run(['--env', path.join(tmp, 'missing')]).stderr).toMatch(/not found/);
    expect(run(['--env', envFile, '--samples', '0']).stderr).toMatch(/at least 1/);
    expect(run(['--env', envFile, '--interval', 'x']).stderr).toMatch(/whole number/);
    expect(run(['--env-file', envFile]).stderr).toMatch(/unknown option: --env-file/);
    const other = path.join(tmp, 'other.env');
    fs.writeFileSync(other, 'COMPOSE_PROJECT_NAME=nothing\n');
    const r = run(['--env', other]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/no running container found/);
    expect(r.stdout).toBe('');
  });
});
