// D-08 A01 AC2: the workspace layout matches design/D-03 section 11.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { EXPECTED_PACKAGES, type PackageManifest, readJson, repoRoot } from './helpers';

const root = repoRoot();

/** Reads the include globs from pnpm-workspace.yaml (plain list, no YAML library needed). */
function workspaceGlobs(): { include: string[]; exclude: string[] } {
  const lines = fs.readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8').split('\n');
  const entries = lines
    .map((line) => /^\s*-\s*['"]?([^'"]+)['"]?\s*$/.exec(line)?.[1])
    .filter((entry): entry is string => entry !== undefined);
  return {
    include: entries.filter((e) => !e.startsWith('!')),
    exclude: entries.filter((e) => e.startsWith('!')).map((e) => e.slice(1)),
  };
}

/** Matches a path against a glob where `*` stands for exactly one path segment. */
function matchesSegmentGlob(dir: string, glob: string): boolean {
  const dirParts = dir.split('/');
  const globParts = glob.split('/');
  return (
    dirParts.length === globParts.length &&
    globParts.every((part, i) => part === '*' || part === dirParts[i])
  );
}

describe('workspace structure (D-03 section 11)', () => {
  it.each(EXPECTED_PACKAGES)('$dir is a package named $name', ({ dir, name }) => {
    const pkgDir = path.join(root, dir);
    expect(readJson<PackageManifest>(path.join(pkgDir, 'package.json')).name).toBe(name);
    expect(fs.existsSync(path.join(pkgDir, 'tsconfig.json'))).toBe(true);
    expect(fs.existsSync(path.join(pkgDir, 'src', 'index.ts'))).toBe(true);
  });

  it.each(EXPECTED_PACKAGES)('$dir is included by pnpm-workspace.yaml', ({ dir }) => {
    const { include, exclude } = workspaceGlobs();
    expect(include.some((glob) => matchesSegmentGlob(dir, glob))).toBe(true);
    expect(exclude).not.toContain(dir);
  });

  it('the root tsconfig references every package, so `pnpm build` builds all of them', () => {
    const { references } = readJson<{ references: { path: string }[] }>(
      path.join(root, 'tsconfig.json'),
    );
    // Plus `pnpm trial:up` (D-08 V02), `pnpm github-app:create` (V03), `pnpm doctor` (V07),
    // `pnpm server:setup` and the deployment steps it shares with `trial:up` (V16), `pnpm alerts`
    // (O03): TypeScript projects, not workspace packages.
    expect(references.map((r) => r.path).sort()).toEqual(
      [
        ...EXPECTED_PACKAGES.map((p) => p.dir),
        'platform/deploy/steps',
        'platform/deploy/trial',
        'platform/deploy/demo',
        'platform/deploy/server-setup',
        'platform/deploy/doctor',
        'platform/deploy/github-app',
        'platform/deploy/alerts',
      ].sort(),
    );
  });

  it('the adapters folder itself is not a package', () => {
    expect(fs.existsSync(path.join(root, 'platform/packages/adapters/package.json'))).toBe(false);
  });
});
