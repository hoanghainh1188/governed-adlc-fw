// `pnpm doctor` is read only (D-08 V07 AC3): `exec.ts` starts only what `isAllowed` accepts, the
// allowlist holds read-only forms only, and `host.ts` builds every command with `commands.*`.
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  APPROLE_FOLDERS,
  commands,
  isAllowed,
  SQL_MIGRATIONS,
  SQL_PROJECTS,
  SQL_TABLE_SIZES,
  type ComposeTarget,
} from '../../deploy/doctor/src/commands.js';
import { createExec } from '../../deploy/doctor/src/exec.js';
import { repoRoot } from '../workspace/helpers';

const scripts = {
  bootstrap: '/repo/platform/deploy/openbao/bootstrap.sh',
  images: '/repo/platform/deploy/scripts/images.sh',
};
const target: ComposeTarget = {
  composeFile: '/repo/c.yml',
  envFile: '/repo/.env',
  project: 'sdlc',
};
const src = (file: string) =>
  fs.readFileSync(path.join(repoRoot(), 'platform/deploy/doctor/src', file), 'utf8');
const IMAGE = `ghcr.io/openhands/agent-server:1@sha256:${'c'.repeat(64)}`;

describe('pnpm doctor is read only', () => {
  it('accepts every command it builds', () => {
    const all = [
      commands.dockerVersion(),
      commands.dockerMemory(),
      commands.dockerAuthz(),
      commands.composeVersion(),
      commands.imageInspect(IMAGE),
      commands.ps(target),
      commands.logs(target),
      commands.psql(target, SQL_MIGRATIONS),
      commands.psql(target, SQL_PROJECTS),
      commands.psql(target, SQL_TABLE_SIZES),
      commands.valkey(target),
      commands.workerGitHub(target),
      commands.openbaoStatus(scripts.bootstrap),
      commands.imagesMode(scripts.images),
      ...APPROLE_FOLDERS.map((f) => commands.approle(target, f.service, f.folder)),
    ];
    for (const argv of all) expect(isAllowed(argv, scripts), argv.join(' ')).toBe(true);
  });

  it.each([
    ['compose up', commands.ps(target).map((a) => (a === 'ps' ? 'up' : a))],
    ['compose down', [...commands.ps(target).slice(0, -4), 'down']],
    [
      'compose exec of another script',
      [...commands.valkey(target).slice(0, -1), 'valkey-cli flushall'],
    ],
    ['psql with a write', commands.psql(target, 'delete from audit_log')],
    ['an AppRole folder not in the table', commands.approle(target, 'sdlc-api', '/etc')],
    [
      'an AppRole read of another service',
      commands.approle(target, 'openbao', '/run/sdlc/approle'),
    ],
    ['docker volume prune', ['docker', 'volume', 'prune', '-f']],
    ['docker system prune', ['docker', 'system', 'prune', '--volumes']],
    ['docker image rm', ['docker', 'image', 'rm', IMAGE]],
    ['an image that is an option', commands.imageInspect('--help')],
    ['an unpinned image', commands.imageInspect('ubuntu:latest')],
    ['bootstrap unseal', [scripts.bootstrap, 'unseal']],
    ['bootstrap init', [scripts.bootstrap, 'init']],
    ['images export', [scripts.images, 'export']],
    ['any other program', ['sh', '-c', 'rm -rf /']],
  ])('refuses %s', (_name, argv) => {
    expect(isAllowed(argv, scripts)).toBe(false);
  });

  it('never starts a refused command', async () => {
    const exec = createExec(scripts);
    await expect(exec(['docker', 'volume', 'prune', '-f'])).resolves.toEqual({
      status: null,
      stdout: '',
      stderr: 'refused',
    });
  });

  it('host.ts runs every command through commands.* and never spawns by itself', () => {
    const host = src('host.ts');
    expect(host).not.toMatch(/child_process|spawn|execSync|execFile/);
    const calls = [...host.matchAll(/(?<![.\w])exec\(([^)]*)/g)];
    expect(calls.length).toBeGreaterThan(8);
    for (const m of calls) expect(m[1]).toMatch(/^commands\./);
    expect(src('exec.ts')).toMatch(/if \(!isAllowed\(argv, scripts\)\)/);
  });

  it('host.ts writes no file and never reads the TLS key', () => {
    const host = src('host.ts');
    expect(host).not.toMatch(/writeFile|appendFile|mkdir|rmSync|unlink|chmod|rename/);
    expect(host).not.toMatch(/readFileSync\([^)]*server-key/);
  });

  it('the psql session is read only and the queries only select', () => {
    for (const sql of [SQL_MIGRATIONS, SQL_PROJECTS, SQL_TABLE_SIZES]) {
      expect(sql.trim().toLowerCase().startsWith('select ')).toBe(true);
      expect(sql.toLowerCase()).not.toMatch(
        /\b(insert|update|delete|drop|alter|truncate|grant|create)\b/,
      );
    }
    expect(commands.psql(target, SQL_MIGRATIONS)).toContain(
      'PGOPTIONS=-c default_transaction_read_only=on',
    );
  });

  it("the worker's GitHub check only reads (GET) and keeps no secret", () => {
    const inspect = fs.readFileSync(
      path.join(repoRoot(), 'platform/packages/adapters/git-github/src/inspect.ts'),
      'utf8',
    );
    const methods = [...inspect.matchAll(/http\.json\('([A-Z]+)'/g)].map((m) => m[1]);
    expect(methods.length).toBeGreaterThan(0);
    expect(new Set(methods)).toEqual(new Set(['GET']));
    expect(inspect).not.toMatch(/\bmint\(|access_tokens/);
  });
});
