// D-08 V12 and V15 (RELEASING.md, QUESTIONS #364, #390, #591–#595, design/ADR-M94): the release.
// - platform/tools/release/release-check.mjs, the one release gate, on fixtures (V12 AC2, V15);
// - every CHANGELOG release section from 0.1.1 on has "Upgrade notes" (V12 AC3; 0.1.0 is exempt);
// - release.yml: only a pushed tag; builds the images through release-images.yml, verifies them,
//   creates the immutable GitHub Release with images.lock, starts npm; the least permissions per
//   job (V15 AC1, AC2);
// - npm-publish.yml keeps its trusted-publisher identity, runs only when dispatched on a released
//   tag and checks the Release's own images.lock (V15 AC4);
// - verify-images.sh pins the signer release-images.yml at the exact tag (V15 AC2);
// - the lock file pull request is gone: no `pnpm release:lock`, no lock.mjs (V15 AC1).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { repoRoot } from './helpers';

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
}
interface Job {
  needs?: string | string[];
  if?: string;
  uses?: string;
  with?: Record<string, unknown>;
  outputs?: Record<string, string>;
  environment?: string;
  permissions?: Record<string, string>;
  steps?: Step[];
}
interface Workflow {
  on: Record<string, { tags?: string[]; branches?: string[] } | null>;
  concurrency?: Record<string, unknown>;
  permissions: Record<string, string>;
  env?: Record<string, string>;
  jobs: Record<string, Job>;
}

const root = repoRoot();
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');
const CHECK = path.join(root, 'platform/tools/release/release-check.mjs');
const PREFIX = 'ghcr.io/hoanghainh1188/governed-adlc-fw';
const SIGNER =
  'https://github.com/hoanghainh1188/governed-adlc-fw/.github/workflows/release-images.yml@refs/tags/$tag';
const IMAGES: Record<string, string> = {
  API: 'sdlc-api',
  WORKER: 'sdlc-worker',
  RUNNER: 'sdlc-runner',
  OTEL_COLLECTOR: 'sdlc-otel-collector',
  SANDBOX_NODE24: 'sandbox-node24',
  TOOL_PROJECT_DOCS: 'tool-project-docs',
  TOOL_CODE_INDEX: 'tool-code-index',
};

const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-release-test-'));
  temps.push(dir);
  return dir;
}

const digest = (n: number) => `sha256:${n.toString(16).padStart(64, '0')}`;
function lockText(version: string, overrides: Record<string, string | null> = {}): string {
  const lines = ['# fixture', `SDLC_IMAGES_VERSION=${version}`];
  Object.entries(IMAGES).forEach(([key, image], i) => {
    const name = `SDLC_IMAGE_${key}`;
    const value = name in overrides ? overrides[name] : `${PREFIX}/${image}@${digest(i + 1)}`;
    if (value !== null) lines.push(`${name}=${value}`);
  });
  return lines.join('\n') + '\n';
}
const NOTES = '### Upgrade notes\n- No migration, no changed setting.\n';
const changelog = (version: string, section = NOTES) =>
  `# Changelog\n\n## [Unreleased]\n\n### Added\n- next\n\n## [${version}] - 2026-10-11\n\nIntro.\n\n${section}\n### Added\n- something\n\n## [0.1.0] - 2026-10-10\n\n### Added\n- first\n`;

interface Fixture {
  pkg?: string;
  platform?: string;
  changelog?: string;
}
function fixture(version: string, f: Fixture = {}): string {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, 'platform/packages/api-schemas/src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: f.pkg ?? version }));
  fs.writeFileSync(
    path.join(dir, 'platform/packages/api-schemas/src/version.ts'),
    `export const PLATFORM_VERSION = '${f.platform ?? version}';\n`,
  );
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), f.changelog ?? changelog(version));
  return dir;
}
function check(args: string[]) {
  const r = spawnSync(process.execPath, [CHECK, ...args], { encoding: 'utf8' });
  return { status: r.status, out: r.stdout, err: r.stderr };
}
const tagCheck = (dir: string, tag: string, extra: string[] = []) =>
  check(['tag', tag, '--root', dir, ...extra]);
/** `release-check.mjs lock <file> <version>` on a lock file written to a temporary folder. */
function lockCheck(text: string, version: string, extra: string[] = []) {
  const file = path.join(tempDir(), 'images.lock');
  fs.writeFileSync(file, text);
  return check(['lock', file, version, ...extra]);
}
const steps = (j: Job): Step[] => j.steps ?? [];

describe('V12, V15: release-check.mjs, the release gate', () => {
  it('accepts a complete release, writes the notes, and reads no lock file (ADR-M94 §2.4)', () => {
    const dir = fixture('0.1.2');
    const notes = path.join(dir, 'notes.md');
    const r = tagCheck(dir, 'v0.1.2', ['--notes-out', notes]);
    expect(r.err).toBe('');
    expect(r.status).toBe(0);
    expect(r.out).toBe('release-check: v0.1.2 ok\n');
    const body = fs.readFileSync(notes, 'utf8');
    expect(body.startsWith('Intro.')).toBe(true);
    expect(body).toContain('### Upgrade notes');
    expect(body).not.toContain('## [');
    expect(body).not.toContain('first');
    expect(fs.existsSync(path.join(dir, 'platform/deploy/images.lock'))).toBe(false);
  });

  it('the mode tag writes no image list: that belongs to the mode lock', () => {
    const dir = fixture('0.1.2');
    const r = tagCheck(dir, 'v0.1.2', ['--images-out', path.join(dir, 'images.txt')]);
    expect(r.status).toBe(1);
    expect(r.err).toContain('usage: --images-out belongs to the mode lock');
    expect(fs.existsSync(path.join(dir, 'images.txt'))).toBe(false);
  });

  it.each(['0.1.2', 'v0.1', 'v0.1.2-rc.1', 'v01.1.2', 'version', ''])(
    'refuses the tag "%s"',
    (tag) => {
      const r = tagCheck(fixture('0.1.2'), tag);
      expect(r.status).toBe(1);
      expect(r.err).toContain('tag_invalid');
    },
  );

  it('refuses a tag that differs from package.json or PLATFORM_VERSION, and names both', () => {
    let r = tagCheck(fixture('0.1.2', { pkg: '0.1.1' }), 'v0.1.2');
    expect(r.status).toBe(1);
    expect(r.err).toContain('package_version');
    r = tagCheck(fixture('0.1.2', { platform: '0.1.1' }), 'v0.1.2');
    expect(r.status).toBe(1);
    expect(r.err).toContain('platform_version');
    expect(r.out).toBe('');
  });

  it('refuses a missing, repeated or undated CHANGELOG section', () => {
    let r = tagCheck(fixture('0.1.2', { changelog: changelog('0.1.3') }), 'v0.1.2');
    expect(r.err).toContain('changelog_section_missing');
    const twice = changelog('0.1.2') + '\n## [0.1.2] - 2026-10-12\n\n' + NOTES;
    r = tagCheck(fixture('0.1.2', { changelog: twice }), 'v0.1.2');
    expect(r.err).toContain('changelog_section_twice');
    r = tagCheck(
      fixture('0.1.2', {
        changelog: changelog('0.1.2').replace('0.1.2] - 2026-10-11', '0.1.2] - soon'),
      }),
      'v0.1.2',
    );
    expect(r.err).toContain('changelog_date');
  });

  it('refuses a section without Upgrade notes, or with empty ones', () => {
    let r = tagCheck(fixture('0.1.2', { changelog: changelog('0.1.2', '') }), 'v0.1.2');
    expect(r.status).toBe(1);
    expect(r.err).toContain('upgrade_notes_missing');
    r = tagCheck(
      fixture('0.1.2', { changelog: changelog('0.1.2', '### Upgrade notes\n\n') }),
      'v0.1.2',
    );
    expect(r.status).toBe(1);
    expect(r.err).toContain('upgrade_notes_empty');
  });

  it('0.1.0, the first release, needs no Upgrade notes; every later one does', () => {
    const dir = fixture('0.1.2');
    expect(check(['changelog', '0.1.0', '--root', dir]).status).toBe(0);
    expect(check(['changelog', '0.1.2', '--root', dir]).status).toBe(0);
  });

  it('lists every problem at once and writes no output file when it refuses', () => {
    const dir = fixture('0.1.2', { pkg: '0.1.1', changelog: changelog('0.1.2', '') });
    const notes = path.join(dir, 'notes.md');
    const r = tagCheck(dir, 'v0.1.2', ['--notes-out', notes]);
    expect(r.status).toBe(1);
    for (const code of ['package_version', 'upgrade_notes_missing']) expect(r.err).toContain(code);
    expect(fs.existsSync(notes)).toBe(false);
  });

  it('the mode lock accepts a complete lock file and writes the seven image references', () => {
    const images = path.join(tempDir(), 'images.txt');
    const r = lockCheck(lockText('0.1.2'), '0.1.2', ['--images-out', images]);
    expect(r.err).toBe('');
    expect(r.status).toBe(0);
    expect(r.out).toBe('release-check: images.lock for 0.1.2 ok\n');
    const refs = fs.readFileSync(images, 'utf8').trim().split('\n');
    expect(refs).toHaveLength(7);
    for (const ref of refs)
      expect(ref).toMatch(new RegExp(`^${PREFIX}/[a-z0-9-]+@sha256:[0-9a-f]{64}$`));
  });

  it('the mode lock refuses another version, a tag, a missing image, another registry or an extra key', () => {
    const cases: [string, string][] = [
      [lockText('0.1.1'), 'lock_version'],
      [lockText('0.1.2', { SDLC_IMAGE_API: `${PREFIX}/sdlc-api:0.1.2` }), 'lock_image'],
      [lockText('0.1.2', { SDLC_IMAGE_RUNNER: null }), 'lock_image'],
      [
        lockText('0.1.2', { SDLC_IMAGE_WORKER: `docker.io/x/sdlc-worker@${digest(9)}` }),
        'lock_image',
      ],
      [lockText('0.1.2', { SDLC_IMAGE_API: `${PREFIX}/sdlc-worker@${digest(9)}` }), 'lock_image'],
      [lockText('0.1.2') + 'SDLC_IMAGE_EXTRA=x\n', 'lock_unknown'],
      ['', 'lock_version'],
    ];
    for (const [lock, code] of cases) {
      const images = path.join(tempDir(), 'images.txt');
      const r = lockCheck(lock, '0.1.2', ['--images-out', images]);
      expect(r.status, code).toBe(1);
      expect(r.err).toContain(code);
      expect(fs.existsSync(images), code).toBe(false);
    }
    expect(check(['lock', path.join(tempDir(), 'none.lock'), '0.1.2']).err).toContain(
      'file_missing',
    );
  });

  it('refuses unknown modes and missing values', () => {
    expect(check([]).status).toBe(1);
    expect(check(['publish', 'v1.0.0']).err).toContain('usage');
    expect(check(['tag', 'v1.0.0', '--root']).err).toContain('usage');
    expect(check(['lock', 'images.lock']).err).toContain('usage');
  });
});

describe('V12 AC3: the real CHANGELOG', () => {
  const text = read('CHANGELOG.md');
  const lines = text.split('\n');
  const first = lines.findIndex((l) => l.startsWith('## [0.1.0] - '));

  it('every release heading since 0.1.0 is "## [X.Y.Z] - YYYY-MM-DD" (or [Unreleased])', () => {
    expect(first).toBeGreaterThan(0);
    for (const line of lines.slice(0, first).filter((l) => l.startsWith('## '))) {
      expect(line).toMatch(/^## (\[Unreleased\]|\[\d+\.\d+\.\d+\] - \d{4}-\d{2}-\d{2})$/);
    }
  });

  const versions = lines
    .slice(0, first + 1)
    .flatMap((l) => /^## \[(\d+\.\d+\.\d+)\] - /.exec(l)?.[1] ?? []);
  it.each(versions)(
    'the section %s passes the release gate (Upgrade notes from 0.1.1 on)',
    (version) => {
      const r = check(['changelog', version, '--root', root]);
      expect(r.err).toBe('');
      expect(r.status).toBe(0);
    },
  );

  it('the current version of package.json has a section once it is released', () => {
    const pkg = (JSON.parse(read('package.json')) as { version: string }).version;
    expect(versions).toContain(pkg);
  });
});

describe('V15: release.yml makes the release on the tag (ADR-M94 §2.2)', () => {
  const wf = parse(read('.github/workflows/release.yml')) as Workflow;
  const job = (name: string): Job => {
    const found = wf.jobs[name];
    if (!found) throw new Error(`release.yml has no job "${name}"`);
    return found;
  };
  const runs = (j: Job) =>
    steps(j)
      .map((s) => s.run ?? '')
      .join('\n');

  it('runs on a pushed tag v*, or dispatched on a tag (release-tag.yml, ADR-M104); never on a branch', () => {
    expect(wf.on).toEqual({ push: { tags: ['v*'] }, workflow_dispatch: null });
    const refCheck = steps(job('check')).find((s) => s.name === 'Started on a tag');
    expect(refCheck?.run).toContain('refs/tags/v*) ;;');
    expect(refCheck?.run).toContain('exit 1');
    // It is the first step after the checkout: nothing else runs on a branch.
    expect(steps(job('check')).indexOf(refCheck!)).toBe(1);
  });

  it('has the five jobs in order: check, images, verify-images, release, npm', () => {
    expect(Object.keys(wf.jobs)).toEqual(['check', 'images', 'verify-images', 'release', 'npm']);
    expect(job('images').needs).toBe('check');
    expect(job('verify-images').needs).toEqual(['check', 'images']);
    expect(job('release').needs).toEqual(['check', 'verify-images']);
    expect(job('npm').needs).toBe('release');
  });

  it('only reads by default; each job holds only the permissions it needs', () => {
    expect(wf.permissions).toEqual({ contents: 'read' });
    expect(job('check').permissions).toBeUndefined();
    expect(job('images').permissions).toEqual({
      contents: 'read',
      packages: 'write',
      'id-token': 'write',
      attestations: 'write',
    });
    expect(job('verify-images').permissions).toEqual({
      contents: 'read',
      packages: 'read',
      attestations: 'read',
    });
    expect(job('release').permissions).toEqual({ contents: 'write' });
    expect(job('npm').permissions).toEqual({ actions: 'write' });
  });

  it('check runs the release gate on the tag, and the tagged commit must be on main', () => {
    const text = runs(job('check'));
    expect(text).toContain('node platform/tools/release/release-check.mjs tag "$TAG"');
    const gate = steps(job('check')).find((s) => s.run?.includes('release-check.mjs'));
    expect(gate?.env?.TAG).toBe('${{ github.ref_name }}');
    expect(text).toContain('git merge-base --is-ancestor "$GITHUB_SHA" origin/main');
    expect(text).toContain('echo "version=${TAG#v}" >> "$GITHUB_OUTPUT"');
    expect(job('check').outputs?.version).toBe('${{ steps.version.outputs.version }}');
  });

  it('images calls release-images.yml with push: true for the version of the tag', () => {
    const images = job('images');
    expect(images.uses).toBe('./.github/workflows/release-images.yml');
    expect(images.with).toEqual({ version: '${{ needs.check.outputs.version }}', push: true });
    expect(images.steps).toBeUndefined();
  });

  it('no other job builds, pushes or signs an image, or publishes to npm', () => {
    for (const name of ['check', 'verify-images', 'release', 'npm']) {
      for (const step of steps(job(name))) {
        expect(step.uses ?? '').not.toMatch(/build-push-action|release-images/);
        expect(step.run ?? '').not.toMatch(
          /docker (build|push)|buildx|git push|npm publish|cosign sign/,
        );
      }
    }
  });

  it('verify-images checks the artifact images.lock with the signer at this tag', () => {
    const verify = job('verify-images');
    const download = steps(verify).find((s) => s.uses?.startsWith('actions/download-artifact@'));
    expect(download?.with?.name).toBe('images-lock-${{ needs.check.outputs.version }}');
    const text = runs(verify).replace(/\s*\\\n\s*/g, ' ');
    expect(text).toContain(
      'node platform/tools/release/release-check.mjs lock "$RUNNER_TEMP/lock/images.lock" "$VERSION" --images-out "$RUNNER_TEMP/images.txt"',
    );
    expect(text).toContain(
      'platform/tools/release/verify-images.sh "$RUNNER_TEMP/images.txt" "$TAG"',
    );
    expect(text).toContain('platform/tools/release/install-cosign.sh "$COSIGN_VERSION"');
  });

  it('release: a draft with images.lock first, then published; a published release is never changed', () => {
    const release = job('release');
    const text = runs(release);
    expect(text).toContain('--notes-out "$RUNNER_TEMP/notes.md"');
    const create = text.indexOf('gh release create "$TAG"');
    const publish = text.indexOf(
      'gh release edit "$TAG" --repo "$GITHUB_REPOSITORY" --draft=false',
    );
    expect(create).toBeGreaterThan(-1);
    expect(publish).toBeGreaterThan(create);
    const createLine = text.slice(create, text.indexOf('\n', text.indexOf('\n', create) + 1));
    expect(createLine).toContain('--verify-tag --draft');
    expect(createLine).toContain('"$RUNNER_TEMP/lock/images.lock"');
    // Only a draft (not public, not immutable) is ever deleted, and only before it is made again.
    expect(text).toContain('--json isDraft --jq .isDraft');
    expect(text).toContain('it is never changed by this workflow');
    const del = text.indexOf('gh release delete "$TAG"');
    expect(text.lastIndexOf('if [ "$draft" != true ]', del)).toBeGreaterThan(-1);
    expect(del).toBeLessThan(create);
    expect(text).not.toMatch(/gh release upload|--clobber|--cleanup-tag/);
  });

  it('release checks that the published release is immutable before npm starts', () => {
    const text = runs(job('release'));
    expect(text).toContain('gh api "repos/$GITHUB_REPOSITORY/releases/tags/$TAG" --jq .immutable');
    expect(text).toContain('[ "$immutable" = true ]');
  });

  it('npm dispatches npm-publish.yml on the tag, and does nothing else', () => {
    const npm = job('npm');
    expect(steps(npm)).toHaveLength(1);
    expect(runs(npm)).toBe(
      'gh workflow run npm-publish.yml --repo "$GITHUB_REPOSITORY" --ref "$TAG"',
    );
  });

  it('checkouts never keep the token, and no script reads an expression inline', () => {
    for (const j of Object.values(wf.jobs)) {
      for (const step of steps(j)) {
        if (step.uses?.startsWith('actions/checkout@'))
          expect(step.with?.['persist-credentials']).toBe(false);
        expect(step.run ?? '').not.toContain('${{');
      }
    }
  });
});

describe('V15: verify-images.sh pins the signer at the exact tag (ADR-M94 §2.6)', () => {
  const script = read('platform/tools/release/verify-images.sh');
  // Continuation lines joined, so the test reads one command per line.
  const text = script.replace(/\s*\\\n\s*/g, ' ');
  const run = (args: string[]) => {
    const r = spawnSync(
      'bash',
      [path.join(root, 'platform/tools/release/verify-images.sh'), ...args],
      {
        encoding: 'utf8',
        env: { PATH: '/usr/bin:/bin' }, // no cosign: a refused argument must stop before it
      },
    );
    return { status: r.status, err: r.stderr };
  };

  it('pins the exact signer and issuer of release-images.yml at the tag, never a pattern', () => {
    expect(script).toContain(`SIGNER_IDENTITY="${SIGNER}"`);
    expect(script).toContain("SIGNER_ISSUER='https://token.actions.githubusercontent.com'");
    expect(text).toContain(
      'cosign verify --certificate-identity "$SIGNER_IDENTITY" --certificate-oidc-issuer "$SIGNER_ISSUER" "$ref"',
    );
    expect(text).toContain(
      '--cert-identity "$SIGNER_IDENTITY" --cert-oidc-issuer "$SIGNER_ISSUER"',
    );
    expect(script).not.toMatch(/regexp|--signer-workflow|refs\/heads\/main'/);
  });

  it.each([
    [['images.txt']],
    [['images.txt', 'v0.1']],
    [['images.txt', 'main']],
    [['a', 'v1.0.0', 'b']],
  ])('refuses the arguments %j before it verifies anything', (args) => {
    const r = run(args);
    expect(r.status).not.toBe(0);
    expect(r.err).toMatch(/usage|the tag must be vX\.Y\.Z/);
    expect(r.err).not.toContain('cosign');
  });

  it('fails on an error and unless it verified seven images', () => {
    expect(script).toContain('set -euo pipefail');
    expect(script).toContain('if [ "$count" != 7 ]; then');
    expect(
      fs.statSync(path.join(root, 'platform/tools/release/verify-images.sh')).mode & 0o111,
    ).not.toBe(0);
  });
});

describe('V15: npm-publish.yml keeps its identity and starts only on a released tag (ADR-M94 §2.3)', () => {
  const wf = parse(read('.github/workflows/npm-publish.yml')) as Workflow;
  const publish = wf.jobs.publish!;
  const verify = wf.jobs['verify-images']!;
  const runs = (j: Job) =>
    steps(j)
      .map((st) => st.run ?? '')
      .join('\n');

  it('the file and the environment npm are unchanged (npm names them); only a dispatch starts it', () => {
    expect(fs.existsSync(path.join(root, '.github/workflows/npm-publish.yml'))).toBe(true);
    expect(wf.on).toEqual({ workflow_dispatch: null });
    expect(Object.keys(wf.jobs).sort()).toEqual(['publish', 'verify-images']);
    expect(publish.environment).toBe('npm');
    expect(publish.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
  });

  it('verify-images refuses a ref that is not a tag vX.Y.Z with a published Release, first', () => {
    const first = steps(verify)[0]?.run ?? '';
    expect(first).toContain(
      "grep -Eq '^refs/tags/v(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$'",
    );
    expect(first).toContain('--json isDraft --jq .isDraft');
    expect(first).toContain('[ "$draft" = false ]');
    expect(first).toContain(
      'gh release download "$TAG" --repo "$GITHUB_REPOSITORY" --pattern images.lock',
    );
  });

  it("verifies the Release's images.lock first, read only, and publish waits for it", () => {
    expect(verify.permissions).toEqual({
      contents: 'read',
      packages: 'read',
      attestations: 'read',
    });
    expect(verify.environment).toBeUndefined();
    const text = runs(verify).replace(/\s*\\\n\s*/g, ' ');
    expect(text).toContain('node platform/tools/release/release-check.mjs tag "$TAG"');
    expect(text).toContain(
      'release-check.mjs lock "$RUNNER_TEMP/lock/images.lock" "${TAG#v}" --images-out "$RUNNER_TEMP/images.txt"',
    );
    expect(text).toContain(
      'platform/tools/release/verify-images.sh "$RUNNER_TEMP/images.txt" "$TAG"',
    );
    expect(publish.needs).toBe('verify-images');
  });

  it('publish refuses a ref that is not a tag and runs the gate before it builds the package', () => {
    const gate = steps(publish).findIndex((st) => st.run?.includes('release-check.mjs tag "$TAG"'));
    const build = steps(publish).findIndex((st) => st.run?.includes('cli:pack-check'));
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(build);
    expect(steps(publish)[gate]?.run).toContain('case "$GITHUB_REF" in refs/tags/v*)');
  });
});

describe('V15: the lock file pull request is gone (ADR-M94 §2.4)', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };

  it('no pnpm release:lock, no lock.mjs, no tracked images.lock', () => {
    expect(pkg.scripts['release:lock']).toBeUndefined();
    expect(fs.existsSync(path.join(root, 'platform/tools/release/lock.mjs'))).toBe(false);
    const tracked = spawnSync('git', ['-C', root, 'ls-files', 'platform/deploy/images.lock'], {
      encoding: 'utf8',
    });
    expect(tracked.stdout.trim()).toBe('');
  });
});

// After v0.2.0 (npm-publish failed three times on HTTP 504 while installing cosign): cosign is
// installed by one script with long retries and a pinned SHA-256, never by sigstore/cosign-installer.
describe('install-cosign.sh: cosign for the release workflows', () => {
  const SCRIPT = 'platform/tools/release/install-cosign.sh';
  const script = read(SCRIPT);
  const FILES = [
    '.github/workflows/release-images.yml',
    '.github/workflows/release.yml',
    '.github/workflows/npm-publish.yml',
  ];

  it('every release workflow installs cosign with the script, at a version the script pins', () => {
    for (const file of FILES) {
      const text = read(file);
      const wf = parse(text) as Workflow;
      expect(text, file).not.toContain('sigstore/cosign-installer');
      expect(text, file).toContain(`${SCRIPT} "$COSIGN_VERSION"`);
      const version = wf.env?.COSIGN_VERSION ?? '';
      expect(version, file).toMatch(/^v\d+\.\d+\.\d+$/);
      for (const arch of ['amd64', 'arm64']) {
        expect(script, `${file} ${arch}`).toMatch(
          new RegExp(
            `^  ${version.replaceAll('.', '\\.')}/${arch}\\) sha256=[0-9a-f]{64} ;;$`,
            'm',
          ),
        );
      }
    }
  });

  it('retries every network error for minutes and checks the SHA-256 before running cosign', () => {
    expect(script).toContain('--retry 10 --retry-all-errors --retry-delay 15');
    expect(script).toContain('sha256sum --check --status');
    expect(script.indexOf('sha256sum --check')).toBeLessThan(script.indexOf('cosign" version'));
    expect(script).toContain('https://github.com/sigstore/cosign/releases/download/');
    expect(fs.statSync(path.join(root, SCRIPT)).mode & 0o111).not.toBe(0);
  });

  it('refuses a version or an architecture without a pin', () => {
    const r = spawnSync('bash', [path.join(root, SCRIPT), 'v0.0.1'], { encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/no pinned checksum|unsupported architecture/);
  });
});

describe('ADR-M104: release-tag.yml tags a merged version pull request', () => {
  const wf = parse(read('.github/workflows/release-tag.yml')) as Workflow;
  const tag = wf.jobs.tag!;

  it('runs on a push to main only, one at a time, and only reads by default', () => {
    expect(wf.on).toEqual({ push: { branches: ['main'] } });
    expect(wf.permissions).toEqual({ contents: 'read' });
    expect(wf.concurrency).toEqual({ group: 'release-tag', 'cancel-in-progress': false });
    expect(Object.keys(wf.jobs)).toEqual(['tag']);
    expect(tag.permissions).toEqual({ contents: 'write', actions: 'write' });
  });

  it('runs tag-release.mjs with the whole history and the token in the environment only', () => {
    const step = steps(tag).find((s) => s.run?.includes('tag-release.mjs'));
    expect(step?.run).toBe('node platform/tools/release/tag-release.mjs');
    expect(step?.env?.GH_TOKEN).toBe('${{ github.token }}');
    const checkout = steps(tag).find((s) => s.uses?.startsWith('actions/checkout@'));
    expect(checkout?.with?.['fetch-depth']).toBe(0);
  });

  it('tag-release.mjs gates, then tags through the API, then dispatches; it never pushes', () => {
    const script = read('platform/tools/release/tag-release.mjs');
    const gate = script.indexOf("'release-check.mjs'), 'tag', `v${version}`]");
    const create = script.indexOf('`repos/${repo}/git/refs`');
    const dispatch = script.indexOf(
      "run('gh', ['workflow', 'run', 'release.yml', '--ref', `v${version}`])",
    );
    expect(gate).toBeGreaterThan(0);
    expect(create).toBeGreaterThan(gate);
    expect(dispatch).toBeGreaterThan(create);
    expect(script).not.toContain('git push');
    expect(script).not.toMatch(/'tag', '-f'|--force/);
  });

  it('keeps no token on disk and reads no expression inline', () => {
    const checkout = steps(tag).find((s) => s.uses?.startsWith('actions/checkout@'));
    expect(checkout?.with?.['persist-credentials']).toBe(false);
    for (const s of steps(tag)) expect(s.run ?? '').not.toMatch(/\$\{\{/);
  });
});
