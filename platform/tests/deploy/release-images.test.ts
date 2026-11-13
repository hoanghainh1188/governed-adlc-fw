// D-08 V04 (design/ADR-M66) and V15 (design/ADR-M94): the platform's images on GHCR for a release.
// - the release workflow builds and scans all seven images on both architectures before the first
//   push (release-images-scan.yml), and only then pushes, tags, signs and attests them; its
//   thresholds equal ci.yml (V15 AC3);
// - Compose uses the published images by digest on a release checkout (the release's images.lock,
//   an asset of its GitHub Release; the overlay docker-compose.images.yml; scripts/images.sh) and
//   builds locally everywhere else (V15 AC5);
// - the README says how to verify them, with the identity the workflow signs with.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { loadCompose, readDeployFile, root } from './compose';

interface Step {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, unknown>;
}
interface Job {
  needs?: string | string[];
  if?: string;
  uses?: string;
  with?: Record<string, unknown>;
  permissions?: Record<string, string>;
  strategy?: { matrix: Record<string, unknown> };
  steps: Step[];
}
interface Workflow {
  on: Record<
    string,
    { inputs?: Record<string, { type: string; default?: unknown; required?: boolean }> }
  >;
  permissions: Record<string, string>;
  env: Record<string, string>;
  jobs: Record<string, Job>;
}
interface MatrixEntry {
  image: string;
  context: string;
  dockerfile: string;
  ignorefile: string;
}

const PREFIX = 'ghcr.io/hoanghainh1188/governed-adlc-fw';
const IMAGES = [
  'sdlc-api',
  'sdlc-worker',
  'sdlc-runner',
  'sdlc-otel-collector',
  'sandbox-node24',
  'tool-project-docs',
  'tool-code-index',
];
const LOCK_NAMES: Record<string, string> = {
  API: 'sdlc-api',
  WORKER: 'sdlc-worker',
  RUNNER: 'sdlc-runner',
  OTEL_COLLECTOR: 'sdlc-otel-collector',
  SANDBOX_NODE24: 'sandbox-node24',
  TOOL_PROJECT_DOCS: 'tool-project-docs',
  TOOL_CODE_INDEX: 'tool-code-index',
};

const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');
const wf = parse(read('.github/workflows/release-images.yml')) as Workflow;
const scanWf = parse(read('.github/workflows/release-images-scan.yml')) as Workflow;
const ci = parse(read('.github/workflows/ci.yml')) as { env: Record<string, string> };
const readme = read('platform/deploy/README.md');

function job(name: string): Job {
  const found = wf.jobs[name];
  if (!found) throw new Error(`release-images.yml has no job "${name}"`);
  return found;
}
/** The one job of release-images-scan.yml: build and scan, push nothing. */
const scanJob = (): Job => scanWf.jobs.scan!;
const stepIndex = (j: Job, pred: (s: Step) => boolean) => j.steps.findIndex(pred);
const matrixEntries = () => scanJob().strategy?.matrix.include as MatrixEntry[];

describe('V04: the release workflow', () => {
  it('runs only when called (V12) or started by a person, and pushes nothing by default', () => {
    expect(Object.keys(wf.on).sort()).toEqual(['workflow_call', 'workflow_dispatch']);
    for (const trigger of ['workflow_call', 'workflow_dispatch']) {
      const inputs = wf.on[trigger]?.inputs ?? {};
      expect(Object.keys(inputs).sort()).toEqual(['push', 'version']);
      expect(inputs.push).toMatchObject({ type: 'boolean', default: false });
    }
  });

  it('only reads by default; packages, id-token and attestations only where needed', () => {
    expect(wf.permissions).toEqual({ contents: 'read' });
    expect(Object.keys(wf.jobs)).toEqual(['check', 'scan', 'push', 'publish', 'lock']);
    expect(job('check').permissions).toBeUndefined();
    expect(job('lock').permissions).toBeUndefined();
    expect(job('scan').permissions).toBeUndefined();
    expect(scanWf.permissions).toEqual({ contents: 'read' });
    expect(scanJob().permissions).toBeUndefined();
    expect(job('push').permissions).toEqual({ contents: 'read', packages: 'write' });
    expect(job('publish').permissions).toEqual({
      contents: 'read',
      packages: 'write',
      'id-token': 'write',
      attestations: 'write',
    });
    for (const name of ['push', 'publish', 'lock']) expect(job(name).if).toBe('inputs.push');
  });

  it('checks the version against package.json and pushes only on the release tag (ADR-M94)', () => {
    const run = job('check')
      .steps.map((s) => s.run ?? '')
      .join('\n');
    expect(run).toContain('jq -r .version package.json');
    expect(run).toContain('[ "$PUSH" = true ] && [ "$REF" != "refs/tags/v$VERSION" ]');
    expect(run).not.toContain('refs/heads/main');
  });

  it('builds the seven images for amd64 and arm64, each on a native runner', () => {
    const scan = scanJob();
    expect(scan.strategy?.matrix.arch).toEqual(['amd64', 'arm64']);
    expect(scan.strategy?.matrix.image).toEqual(IMAGES);
    expect(matrixEntries().map((e) => e.image)).toEqual(IMAGES);
    // The job push builds the same images from the same inputs.
    expect(job('push').strategy).toEqual(scan.strategy);
    expect(job('publish').strategy?.matrix.image).toEqual(IMAGES);
    for (const e of matrixEntries()) {
      expect(fs.existsSync(path.join(root, e.dockerfile)), e.dockerfile).toBe(true);
      expect(fs.existsSync(path.join(root, e.ignorefile)), e.ignorefile).toBe(true);
    }
    for (const file of ['release-images.yml', 'release-images-scan.yml'])
      expect(read(`.github/workflows/${file}`)).toContain(
        "matrix.arch == 'arm64' && 'ubuntu-24.04-arm' || 'ubuntu-24.04'",
      );
  });

  it('builds exactly what Compose builds (same Dockerfiles, same contexts)', () => {
    const compose = parse(readDeployFile('docker-compose.yml'), { merge: true }) as {
      services: Record<
        string,
        { image?: string; build?: { context: string; dockerfile?: string } }
      >;
    };
    const built = Object.entries(compose.services).filter(([, s]) => s.build);
    expect(built.length).toBe(4);
    for (const [, s] of built) {
      const name = s.image!.split(':')[0]!;
      const entry = matrixEntries().find((e) => e.image === name);
      expect(entry, name).toBeDefined();
      const context = path.relative(root, path.resolve(root, 'platform/deploy', s.build!.context));
      expect(entry!.context === '.' ? '' : entry!.context).toBe(context);
      const dockerfile = s.build!.dockerfile ?? path.join(context, 'Dockerfile');
      expect(entry!.dockerfile).toBe(dockerfile);
    }
  });

  it('keeps the Trivy version and thresholds of ci.yml, both archives checked by SHA-256', () => {
    for (const key of [
      'TRIVY_BLOCK_SEVERITY',
      'TRIVY_REPORT_SEVERITY',
      'TRIVY_VERSION',
      'TRIVY_SHA256',
    ]) {
      expect(wf.env[key], key).toBe(ci.env[key]);
      expect(scanWf.env[key], key).toBe(ci.env[key]);
    }
    expect(wf.env.TRIVY_ARM64_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(scanWf.env.TRIVY_ARM64_SHA256).toBe(wf.env.TRIVY_ARM64_SHA256);
    for (const j of [scanJob(), job('push')]) {
      const install = j.steps.find((s) => s.name === 'Install trivy')?.run ?? '';
      expect(install).toContain('sha256sum -c -');
    }
  });

  it('the job scan builds and scans each image and can push nothing (release-images-scan.yml)', () => {
    expect(Object.keys(scanWf.on)).toEqual(['workflow_call']);
    const inputs = scanWf.on.workflow_call?.inputs ?? {};
    expect(Object.keys(inputs).sort()).toEqual(['cache', 'version']);
    expect(inputs.version).toMatchObject({ type: 'string', required: true });
    expect(inputs.cache).toMatchObject({ type: 'boolean', default: false });
    const scan = scanJob();
    const local = stepIndex(scan, (s) => s.name === 'Build (local, for the scan)');
    const block = stepIndex(scan, (s) => s.name === 'Trivy scan (severity CRITICAL blocks)');
    expect(local).toBeGreaterThanOrEqual(0);
    expect(local).toBeLessThan(block);
    expect(scan.steps[local]?.with).toMatchObject({ load: true });
    expect(scan.steps[local]?.with?.push).toBeUndefined();
    expect(scan.steps[block]?.run).toContain('--exit-code 1');
    expect(scan.steps.some((s) => s.uses?.startsWith('docker/login-action@'))).toBe(false);
    expect(scan.steps.some((s) => s.name === 'Push by digest')).toBe(false);
    // Only a release fills the cache; a pull request writes none.
    expect(String(scan.steps[local]?.with?.['cache-to'])).toMatch(/^\$\{\{ inputs\.cache && /);
  });

  it('pushes nothing until all twelve scans passed (ADR-M94 §2.5), and only with push: true', () => {
    expect(job('scan').uses).toBe('./.github/workflows/release-images-scan.yml');
    expect(job('scan').needs).toBe('check');
    expect(job('scan').with).toEqual({
      version: '${{ inputs.version }}',
      cache: '${{ inputs.push }}',
    });
    const push = job('push');
    expect(push.needs).toEqual(['check', 'scan']);
    expect(job('publish').needs).toEqual(['check', 'push']);
    const digest = stepIndex(push, (s) => s.name === 'Push by digest');
    expect(push.steps[digest]?.with).toMatchObject({ provenance: 'mode=max', sbom: true });
    expect(String(push.steps[digest]?.with?.outputs)).toContain('push-by-digest=true');
    // The same image as the scan: the cache scope the scan wrote, the same commit time.
    expect(String(push.steps[digest]?.with?.['cache-from'])).toBe(
      'type=gha,scope=${{ matrix.image }}-${{ matrix.arch }}-${{ inputs.version }}',
    );
    expect(read('.github/workflows/release-images-scan.yml')).toContain(
      "format('type=gha,mode=max,scope={0}-{1}-{2}', matrix.image, matrix.arch, inputs.version)",
    );
    // The pushed digest is scanned again from GHCR before its digest reaches publish.
    const rescan = stepIndex(push, (s) =>
      (s.name ?? '').startsWith('Trivy scan of the pushed digest'),
    );
    const keep = stepIndex(push, (s) => s.name === 'Keep the digest');
    expect(digest).toBeLessThan(rescan);
    expect(rescan).toBeLessThan(keep);
    expect(push.steps[rescan]?.run).toContain('--image-src remote');
    expect(push.steps[rescan]?.run).toContain('--exit-code 1');
    expect(push.steps[rescan]?.run).toContain('$TRIVY_BLOCK_SEVERITY');
  });

  it('never moves a tag, signs with cosign keyless and records a build provenance attestation', () => {
    const publish = job('publish');
    const text = publish.steps.map((s) => s.run ?? '').join('\n');
    expect(text).toContain('already exists');
    expect(text).toContain('cosign sign --yes');
    expect(text).not.toMatch(/--key\b/);
    expect(publish.steps.some((s) => s.uses?.startsWith('actions/attest-build-provenance@'))).toBe(
      true,
    );
    expect(wf.env.COSIGN_VERSION).toMatch(/^v\d+\.\d+\.\d+$/);
  });

  it('uses one registry path everywhere', () => {
    expect(wf.env.IMAGE_PREFIX).toBe(PREFIX);
    expect(readDeployFile('scripts/images.sh')).toContain(`PREFIX="${PREFIX}"`);
    expect(readme).toContain(PREFIX);
  });

  it('writes a lock file with the names images.sh reads, as a release asset', () => {
    const run = job('lock')
      .steps.map((s) => s.run ?? '')
      .join('\n');
    const written = [...run.matchAll(/echo "(SDLC_IMAGE[A-Z0-9_]*)=/g)].map((m) => m[1]!);
    expect(written).toEqual([
      'SDLC_IMAGES_VERSION',
      ...Object.keys(LOCK_NAMES).map((n) => `SDLC_IMAGE_${n}`),
    ]);
    expect(run).toContain('An asset of the GitHub Release');
    expect(readDeployFile('scripts/images.sh')).toContain(
      `NAMES="${Object.keys(LOCK_NAMES).join(' ')}"`,
    );
  });
});

describe('V04, V15: Compose uses the published images on a release checkout only', () => {
  it('the lock file is not in the repository; a downloaded one is ignored (ADR-M94 §2.4)', () => {
    const tracked = spawnSync('git', ['-C', root, 'ls-files', 'platform/deploy/images.lock']);
    expect(String(tracked.stdout).trim()).toBe('');
    const ignored = spawnSync('git', [
      '-C',
      root,
      'check-ignore',
      '-q',
      'platform/deploy/.images/v9.9.9.lock',
    ]);
    expect(ignored.status).toBe(0);
  });

  it('the overlay covers every service Compose builds, removes its build and names its lock entry', () => {
    const text = readDeployFile('docker-compose.images.yml');
    const overlay = parse(text, { customTags: [{ tag: '!reset', resolve: () => null }] }) as {
      services: Record<string, { image?: string; build?: unknown; pull_policy?: string }>;
    };
    const built = Object.entries(loadCompose().services)
      .filter(([, s]) => (s as { build?: unknown }).build)
      .map(([name]) => name)
      .sort();
    expect(Object.keys(overlay.services).sort()).toEqual(built);
    expect(text.match(/^ {4}build: !reset null$/gm)?.length).toBe(built.length);
    for (const s of Object.values(overlay.services)) {
      expect(s.build).toBeNull();
      expect(s.image).toMatch(/^\$\{SDLC_IMAGE_[A-Z_]+:\?/);
      expect(s.pull_policy).toBe('missing');
    }
    for (const n of ['API', 'WORKER', 'RUNNER', 'OTEL_COLLECTOR'])
      expect(text).toContain(`\${SDLC_IMAGE_${n}:?`);
  });

  it('up.sh adds the overlay only in the published mode, with the lock entries', () => {
    const up = readDeployFile('scripts/up.sh');
    expect(up).toContain('scripts/images.sh" mode');
    expect(up).toContain('scripts/images.sh" export');
    expect(up).toContain('-f "$deploy_dir/docker-compose.images.yml"');
    const trial = read('platform/deploy/trial/src/up.ts');
    expect(trial).toContain("['get', 'SANDBOX_NODE24']");
  });
});

describe('V04, V15: scripts/images.sh (ADR-M94 §2.4)', () => {
  const temp: string[] = [];
  afterAll(() => {
    for (const dir of temp) fs.rmSync(dir, { recursive: true, force: true });
  });
  const mkdir = (prefix: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    temp.push(dir);
    return dir;
  };

  const digest = (c: string) => `sha256:${c.repeat(64)}`;
  const completeLock = (version: string, prefix = PREFIX) =>
    [
      `SDLC_IMAGES_VERSION=${version}`,
      ...Object.entries(LOCK_NAMES).map(
        ([n, image], i) => `SDLC_IMAGE_${n}=${prefix}/${image}@${digest('abcdef0'[i]!)}`,
      ),
    ].join('\n') + '\n';

  /** A throw-away tree with the script and a package.json; Git when asked. No lock file. */
  function tree(opts: { pkg: string; git?: 'tagged' | 'untagged' | 'dirty' | 'other-tag' }) {
    const dir = mkdir('sdlc-images-');
    fs.mkdirSync(path.join(dir, 'platform/deploy/scripts'), { recursive: true });
    fs.copyFileSync(
      path.join(root, 'platform/deploy/scripts/images.sh'),
      path.join(dir, 'platform/deploy/scripts/images.sh'),
    );
    fs.writeFileSync(path.join(dir, '.gitignore'), 'platform/deploy/.images/\n');
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      `{\n  "name": "x",\n  "version": "${opts.pkg}",\n  "dependencies": { "y": { "version": "9.9.9" } }\n}\n`,
    );
    if (opts.git) {
      const git = (...args: string[]) => {
        const r = spawnSync('git', ['-C', dir, ...args], {
          encoding: 'utf8',
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: 't',
            GIT_AUTHOR_EMAIL: 't@example.invalid',
            GIT_COMMITTER_NAME: 't',
            GIT_COMMITTER_EMAIL: 't@example.invalid',
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_CONFIG_NOSYSTEM: '1',
          },
        });
        expect(r.status, r.stderr).toBe(0);
      };
      git('init', '-q');
      git('add', '-A');
      git('commit', '-q', '-m', 'release');
      if (opts.git === 'other-tag') git('tag', 'v0.0.9');
      else if (opts.git !== 'untagged') git('tag', `v${opts.pkg}`);
      if (opts.git === 'dirty') fs.appendFileSync(path.join(dir, 'package.json'), '\n');
    }
    return dir;
  }

  /**
   * A fake `curl` first on PATH: it logs its arguments and writes FAKE_LOCK to the `-o` file, or
   * fails like a 404 when FAKE_LOCK is unset. The real curl is never reached.
   */
  function fakeCurl(): string {
    const bin = mkdir('sdlc-images-bin-');
    fs.writeFileSync(
      path.join(bin, 'curl'),
      [
        '#!/bin/sh',
        'echo "$@" >> "$FAKE_DIR/calls"',
        'out=""; while [ $# -gt 0 ]; do [ "$1" = -o ] && out="$2"; shift; done',
        '[ -n "${FAKE_LOCK:-}" ] || exit 22',
        'printf "%s" "$FAKE_LOCK" > "$out"',
      ].join('\n'),
      { mode: 0o755 },
    );
    return bin;
  }

  function images(dir: string, args: string[], env: Record<string, string> = {}) {
    const bin = fakeCurl();
    const r = spawnSync('sh', [path.join(dir, 'platform/deploy/scripts/images.sh'), ...args], {
      encoding: 'utf8',
      env: { PATH: `${bin}:${process.env.PATH ?? ''}`, FAKE_DIR: bin, ...env },
    });
    const callsFile = path.join(bin, 'calls');
    const calls = fs.existsSync(callsFile) ? fs.readFileSync(callsFile, 'utf8').trim() : '';
    return { status: r.status, out: r.stdout.trim(), err: r.stderr, calls };
  }
  const cachedLock = (dir: string, version: string) =>
    path.join(dir, `platform/deploy/.images/v${version}.lock`);

  it('this checkout is not a release checkout: local, nothing downloaded', () => {
    const r = spawnSync('sh', [path.join(root, 'platform/deploy/scripts/images.sh'), 'mode'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH },
    });
    expect(r.status, r.stderr).toBe(0);
    // A clean checkout of a release tag is published; every other checkout is local.
    expect(['local', 'published']).toContain(r.stdout.trim());
  });

  it('a release checkout downloads the Release asset once, over HTTPS, and uses it', () => {
    const dir = tree({ pkg: '0.7.0', git: 'tagged' });
    const lock = completeLock('0.7.0');
    const first = images(dir, ['mode'], { FAKE_LOCK: lock });
    expect(first.err).toBe('');
    expect(first.out).toBe('published');
    expect(first.calls).toContain('--proto =https');
    expect(first.calls).toContain(
      'https://github.com/hoanghainh1188/governed-adlc-fw/releases/download/v0.7.0/images.lock',
    );
    expect(fs.readFileSync(cachedLock(dir, '0.7.0'), 'utf8')).toBe(lock);
    // The second time it reads the kept file: no download, and the checkout stays clean.
    const second = images(dir, ['export']);
    expect(second.calls).toBe('');
    expect(second.out.split('\n')).toEqual(lock.trim().split('\n'));
    expect(images(dir, ['mode']).out).toBe('published');
  });

  it('a failed download stops with a clear error and keeps no file (never a silent local build)', () => {
    const dir = tree({ pkg: '0.7.0', git: 'tagged' });
    const r = images(dir, ['mode']);
    expect(r.status).toBe(1);
    expect(r.out).toBe('');
    expect(r.err).toContain('could not download images.lock of the GitHub Release v0.7.0');
    expect(r.err).toContain('SDLC_IMAGES_LOCK=');
    expect(r.err).toContain('SDLC_IMAGES=local');
    expect(fs.existsSync(cachedLock(dir, '0.7.0'))).toBe(false);
    expect(fs.readdirSync(path.join(dir, 'platform/deploy/.images'))).toEqual([]);
  });

  it.each([
    ['another version', completeLock('0.6.9')],
    ['another registry', completeLock('0.7.0', 'ghcr.io/someone-else/fork')],
    ['a missing image', completeLock('0.7.0').replace(/^SDLC_IMAGE_RUNNER=.*\n/m, '')],
    ['a tag, not a digest', completeLock('0.7.0').replace(/@sha256:a+/, ':0.7.0')],
  ])('a downloaded file with %s is refused and not kept', (_, lock) => {
    const dir = tree({ pkg: '0.7.0', git: 'tagged' });
    const r = images(dir, ['mode'], { FAKE_LOCK: lock });
    expect(r.status).toBe(1);
    expect(r.err).toContain('is not complete');
    expect(fs.existsSync(cachedLock(dir, '0.7.0'))).toBe(false);
  });

  it('SDLC_IMAGES_LOCK gives the file by hand: no download; an incomplete one is refused', () => {
    const dir = tree({ pkg: '0.7.0', git: 'tagged' });
    const file = path.join(mkdir('sdlc-images-lock-'), 'images.lock');
    fs.writeFileSync(file, completeLock('0.7.0'));
    const r = images(dir, ['get', 'SANDBOX_NODE24'], { SDLC_IMAGES_LOCK: file });
    expect(r.err).toBe('');
    expect(r.out).toBe(`${PREFIX}/sandbox-node24@${digest('e')}`);
    expect(r.calls).toBe('');
    fs.writeFileSync(file, completeLock('0.6.9'));
    const bad = images(dir, ['mode'], { SDLC_IMAGES_LOCK: file });
    expect(bad.status).toBe(1);
    expect(bad.err).toContain('not a complete lock file for v0.7.0');
  });

  it('local on a branch, with a changed file or on the tag of another version: no download', () => {
    for (const git of ['untagged', 'dirty', 'other-tag'] as const) {
      const r = images(tree({ pkg: '0.7.0', git }), ['mode'], { FAKE_LOCK: completeLock('0.7.0') });
      expect(r.out, git).toBe('local');
      expect(r.calls, git).toBe('');
    }
  });

  it('a source archive (no .git) builds locally, unless SDLC_IMAGES=published', () => {
    const archive = tree({ pkg: '0.7.0' });
    expect(images(archive, ['mode']).out).toBe('local');
    const r = images(archive, ['mode'], {
      SDLC_IMAGES: 'published',
      FAKE_LOCK: completeLock('0.7.0'),
    });
    expect(r.out).toBe('published');
    expect(r.calls).toContain('/v0.7.0/images.lock');
  });

  it('SDLC_IMAGES overrides the choice; published needs a complete lock file', () => {
    const tagged = tree({ pkg: '0.7.0', git: 'tagged' });
    const local = images(tagged, ['mode'], { SDLC_IMAGES: 'local' });
    expect(local.out).toBe('local');
    expect(local.calls).toBe('');
    expect(
      images(tree({ pkg: '0.7.0', git: 'untagged' }), ['mode'], { SDLC_IMAGES: 'published' })
        .status,
    ).toBe(1);
    expect(images(tagged, ['mode'], { SDLC_IMAGES: 'yes' }).status).toBe(1);
  });

  it('get and export print the pinned references; an unknown name or a bad usage is refused', () => {
    const dir = tree({ pkg: '0.7.0', git: 'tagged' });
    const env = { FAKE_LOCK: completeLock('0.7.0') };
    expect(images(dir, ['get', 'SANDBOX_NODE24'], env).out).toBe(
      `${PREFIX}/sandbox-node24@${digest('e')}`,
    );
    expect(images(dir, ['get', 'POSTGRES'], env).status).toBe(1);
    expect(images(dir, ['export'], env).out.split('\n')).toEqual(
      completeLock('0.7.0').trim().split('\n'),
    );
    expect(images(dir, [], env).status).toBe(2);
    expect(images(dir, ['mode', 'extra'], env).status).toBe(1);
  });

  it('verify needs cosign and gh, and runs the shared check with the tag of the version', () => {
    const dir = tree({ pkg: '0.7.0', git: 'tagged' });
    const file = path.join(mkdir('sdlc-images-lock-'), 'images.lock');
    fs.writeFileSync(file, completeLock('0.7.0'));
    // A PATH without cosign and gh (they are never in /usr/bin or /bin).
    const r = spawnSync('sh', [path.join(dir, 'platform/deploy/scripts/images.sh'), 'verify'], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', SDLC_IMAGES_LOCK: file },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('verify needs cosign and gh');
    expect(readDeployFile('scripts/images.sh')).toContain(
      'bash "$root/platform/tools/release/verify-images.sh" "$refs" "v$version"',
    );
  });
});

describe('V04: the README says how to verify the published images', () => {
  const start = readme.indexOf('## Verify the published images');
  const section = readme.slice(start, readme.indexOf('\n## ', start + 1));

  it('has the section, with the identity and issuer the workflow signs with', () => {
    expect(start).toBeGreaterThan(0);
    expect(section).toContain('cosign verify');
    expect(section).toContain(
      "--certificate-identity-regexp '^https://github\\.com/hoanghainh1188/governed-adlc-fw/\\.github/workflows/release-images\\.yml@'",
    );
    expect(section).toContain(
      '--certificate-oidc-issuer https://token.actions.githubusercontent.com',
    );
    expect(section).toContain('gh attestation verify');
    expect(section).toContain('--repo hoanghainh1188/governed-adlc-fw');
  });
});
