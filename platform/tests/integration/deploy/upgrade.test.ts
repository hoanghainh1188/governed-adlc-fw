// D-08 O02 AC1: a tested upgrade between two releases. Follows `platform/deploy/README.md`,
// section "Upgrade", on a throw-away Compose project. Needs Docker, `age`, `git` with the release
// tags, and network access to GHCR. Skipped unless SDLC_UPGRADE_TEST=1. Run with: pnpm test:upgrade
// (CI: the job `upgrade`, weekly and manual runs only). The static test
// `platform/tests/deploy/upgrade-readme.test.ts` keeps the README and this test in step: the
// calls of `step` below are the README's steps, in order.
//
// The pair (QUESTIONS #581): SDLC_UPGRADE_TO is a tag `vX.Y.Z` or `HEAD` (default: this checkout);
// SDLC_UPGRADE_FROM is a tag (default: the newest release tag before SDLC_UPGRADE_TO). A tag is
// checked out as a git worktree and built there (`pnpm install --frozen-lockfile && pnpm build`), so
// it runs its own scripts, migrations and CLI, and, as a release checkout, its published images by
// digest from its own `images.lock`. `HEAD` builds its images locally (README step 4, a branch).
//
// 1. The previous release: README "Fresh deployment" steps 2–14 (`deploy-steps.ts`), with an
//    intent waiting at G1.
// 2. The upgrade: the ten README steps on the same project and volumes. The credentials commands
//    come from the first bullet of each release's Upgrade notes in the CHANGELOG (upgrade-notes.ts).
// 3. The intent goes on (QUESTIONS #584): Person A approves G1 after the upgrade and it reaches G2
//    on the same workflow (no workflow task failure in the worker's log); a new intent reaches G1;
//    the audit chain verifies through the API and as the operator.
//
// Own Compose project (ports +34000, random env file, throw-away keys and age key), removed
// afterwards with the worktrees. Secrets stay in memory and are redacted from every message.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { findLogEvents } from '../../../deploy/doctor/src/logs.js';
import { parseEnvFile } from '../../deploy/compose';
import { requiredBootstrapCommands, sectionsBetween } from '../../deploy/upgrade-notes';
import { repoRoot } from '../../workspace/helpers';
import { CREDENTIALS_COMMANDS, Deployment, SERVER_PROFILES } from './deploy-steps';

const enabled = process.env.SDLC_UPGRADE_TEST === '1';
const PORT_OFFSET = 34000;
const TIMEOUT_MS = 35 * 60 * 1000;
/** Every profile `pnpm compose:down` stops (package.json). */
const DOWN_PROFILES = [
  ...SERVER_PROFILES,
  'observability',
  'access',
  'knowledge',
  'models-local',
  'models-remote',
] as const;
/** The platform's own images of a release (`images.lock`). */
const PLATFORM_IMAGES = ['API', 'WORKER', 'RUNNER', 'OTEL_COLLECTOR'] as const;

function git(args: string[]): string {
  const r = spawnSync('git', args, { cwd: repoRoot(), encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** `pnpm install --frozen-lockfile && pnpm build` in a checkout (README "Upgrade" step 2). */
function installAndBuild(root: string): void {
  for (const args of [['install', '--frozen-lockfile'], ['build']]) {
    const r = spawnSync('pnpm', args, {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, CI: 'true' }, // no prompt from pnpm
    });
    if (r.status !== 0) {
      throw new Error(`pnpm ${args[0]} in ${root}: ${(r.stderr + r.stdout).slice(-4000)}`);
    }
  }
}

describe.skipIf(!enabled)(
  'O02 AC1: an upgrade between two releases following the README (live)',
  () => {
    const to = process.env.SDLC_UPGRADE_TO ?? 'HEAD';
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-upgrade-'));
    const subnet = `172.29.${40 + (process.pid % 10)}.0/24`;
    const worktrees: string[] = [];
    const timings: Record<string, number> = {};
    const started = Date.now();
    const mark = (name: string) => {
      timings[name] = Math.round((Date.now() - started) / 1000);
    };
    /** One README "Upgrade" step; the static test reads these calls. */
    const step = (name: string) => mark(name);

    let from = '';
    let old: Deployment;
    let current: Deployment;
    let intent = '';

    /** A release tag as a git worktree, installed and built; this repository for `HEAD`. */
    const checkout = (ref: string): string => {
      if (ref === 'HEAD') return repoRoot();
      const dir = path.join(tmp, ref);
      git(['worktree', 'add', '--detach', dir, ref]);
      worktrees.push(dir);
      installAndBuild(dir);
      return dir;
    };

    beforeAll(async () => {
      from =
        process.env.SDLC_UPGRADE_FROM ??
        git(['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*.[0-9]*.[0-9]*', `${to}^`]);
      expect(from).toMatch(/^v\d+\.\d+\.\d+$/);

      old = new Deployment({
        root: checkout(from),
        tmp,
        envFile: path.join(tmp, 'it.env'),
        project: {
          project: `sdlcupgrade${process.pid}`,
          subnet,
          gateway: subnet.replace(/0\/24$/, '1'),
          portOffset: PORT_OFFSET,
        },
      });
      // A release checkout uses the published images of its own images.lock: in the tagged commit
      // up to v0.6.0 (ADR-M66 §2.5), the asset of its GitHub Release after that (ADR-M94 §2.4).
      expect(old.imagesMode()).toBe('published');
      mark('from_checkout');

      // The previous release: README "Fresh deployment" steps 2–14, with its own scripts and CLI.
      const env = old.settingsFile();
      for (const [key, value] of env) {
        if (/_(PASSWORD|KEY|SECRET)[A-Z_]*$/.test(key) && value) old.keep(value);
      }
      const backups = path.join(tmp, 'backups');
      const identity = path.join(tmp, 'age-identity.txt');
      const recipients = path.join(tmp, 'age-recipients.txt');
      fs.mkdirSync(backups);
      old.ok(old.run('age-keygen', ['-o', identity]), 'age-keygen');
      fs.writeFileSync(
        recipients,
        old.ok(old.run('age-keygen', ['-y', identity]), 'age-keygen -y').stdout,
      );
      const text = fs
        .readFileSync(old.options.envFile, 'utf8')
        .replace(/^SDLC_BACKUP_DIR=.*$/m, `SDLC_BACKUP_DIR=${backups}`)
        .replace(/^SDLC_BACKUP_AGE_RECIPIENTS=.*$/m, `SDLC_BACKUP_AGE_RECIPIENTS=${recipients}`);
      fs.writeFileSync(old.options.envFile, text, { mode: 0o600 });

      old.startStores();
      old.initOpenBao();
      old.sharedSecrets();
      for (const command of CREDENTIALS_COMMANDS) old.credentials(command);
      old.migrate();
      old.up();
      old.tenant();
      old.team();
      old.agentConfigAndRecord(old.publishedSandboxImage());
      intent = old.createIntent('Waits at G1 during the upgrade');
      expect(await old.waitForGate(intent, 'G1')).toMatchObject({
        status: 'in_gate',
        current_gate: 'G1',
      });
      mark('from_deployed');
    }, TIMEOUT_MS);

    afterAll(() => {
      process.stdout.write(`o02:upgrade_seconds:${JSON.stringify({ from, to, ...timings })}\n`);
      if (process.env.SDLC_UPGRADE_KEEP === '1') return;
      (current ?? old)?.down();
      for (const dir of worktrees) git(['worktree', 'remove', '--force', dir]);
      fs.rmSync(tmp, { recursive: true, force: true });
    }, 300_000);

    it(
      'upgrades with the ten steps of the README "Upgrade" section',
      async () => {
        const upgradeStarted = new Date().toISOString();

        step('Backup');
        old.ok(old.run('sh', [path.join(old.deployDir, 'backup/backup.sh')]), 'backup');
        expect(fs.readdirSync(path.join(tmp, 'backups')).length).toBeGreaterThan(0);

        step('The new release');
        current = old.at(checkout(to));

        step('New settings');
        const before = current.env();
        const initEnv = path.join(current.deployDir, 'scripts/init-env.sh');
        if (fs.readFileSync(initEnv, 'utf8').includes('--add-missing')) {
          current.ok(
            current.run(initEnv, ['--add-missing', current.options.envFile]),
            'add-missing',
          );
        } else {
          // A release before O02: what the README asked an operator to do by hand.
          appendMissing(current.options.envFile, path.join(current.deployDir, '.env.example'));
        }
        isolateAdded(current.options.envFile, before, PORT_OFFSET);
        for (const [key, value] of current.env()) {
          if (!before.has(key) && /_(PASSWORD|KEY|SECRET)[A-Z_]*$/.test(key)) current.keep(value);
        }

        step('The images');
        const mode = current.imagesMode();
        expect(mode).toBe(to === 'HEAD' ? 'local' : 'published');
        if (mode === 'local') {
          // The platform images have a `build` and no published name: pull only the others.
          for (const command of [['pull', '--ignore-buildable'], ['build']]) {
            current.ok(current.compose('', ...current.composeProfileArgs, ...command), command[0]!);
          }
        }

        step('Stop');
        current.ok(
          current.compose('', ...DOWN_PROFILES.flatMap((p) => ['--profile', p]), 'down'),
          'compose:down',
        );

        step('Unseal');
        current.startStores();
        current.unseal();

        step('Migrations');
        current.migrate();

        step('Credentials');
        const changelog = fs.readFileSync(path.join(current.options.root, 'CHANGELOG.md'), 'utf8');
        for (const command of requiredBootstrapCommands(
          sectionsBetween(changelog, from, to === 'HEAD' ? 'HEAD' : to),
        )) {
          current.newRootToken();
          current.credentials(command);
        }
        mark('credentials');

        step('Start');
        current.up();
        if (process.env.CI === 'true' && mode === 'published') {
          // A CI runner has little disk: the old release's platform images are no longer used.
          for (const name of PLATFORM_IMAGES) {
            const ref = old.run(path.join(old.deployDir, 'scripts/images.sh'), ['get', name]);
            if (ref.status === 0) current.run('docker', ['image', 'rm', ref.stdout.trim()]);
          }
        }

        step('Check');
        expect((await fetch(`${current.apiUrl}/health/ready`)).status).toBe(200);
        const logs = current.ok(
          current.compose(
            '',
            ...current.composeProfileArgs,
            'logs',
            '--no-color',
            '--no-log-prefix',
            '--since',
            upgradeStarted,
            'sdlc-api',
            'sdlc-worker',
            'sdlc-runner',
          ),
          'logs',
        );
        const problems = findLogEvents(logs.stdout).events.filter(
          (e) =>
            e.endsWith('_missing') ||
            e.endsWith('approle_login_failed') ||
            ['openbao.sealed', 'worker.runs_off'].includes(e),
        );
        expect(problems).toEqual([]);
        // `adlc ops audit verify` (every tenant, as the operator) exits non-zero on a broken chain.
        expect(current.sdlc('operator', ['ops', 'audit', 'verify'])).toEqual([
          expect.objectContaining({ tenant: 'fresh', ok: true, broken: null }),
        ]);
        mark('upgraded');
      },
      TIMEOUT_MS,
    );

    it('the intent that waited at G1 goes on; a new intent reaches G1; the audit chain verifies', async () => {
      current.sdlc('a', ['gate', 'approve', 'G1', intent]);
      expect(await current.waitForGate(intent, 'G2')).toMatchObject({ current_gate: 'G2' });

      const next = current.createIntent('Created after the upgrade');
      expect(await current.waitForGate(next, 'G1')).toMatchObject({
        status: 'in_gate',
        current_gate: 'G1',
      });

      // The workflow that the old worker started was replayed by the new one without a failure.
      const worker = current.compose(
        '',
        ...current.composeProfileArgs,
        'logs',
        '--no-color',
        'sdlc-worker',
      );
      expect(worker.stdout).not.toMatch(/nondetermin|workflow task failed/i);

      expect(current.sdlc('admin', ['audit', 'verify'])).toMatchObject({ ok: true, broken: null });
      // `adlc ops audit verify` (every tenant, as the operator) exits non-zero on a broken chain.
      expect(current.sdlc('operator', ['ops', 'audit', 'verify'])).toEqual([
        expect.objectContaining({ tenant: 'fresh', ok: true, broken: null }),
      ]);
      mark('intent_goes_on');
    }, 600_000);
  },
  TIMEOUT_MS,
);

/** Appends the keys of `template` that `envFile` lacks (a `CHANGEME` gets a random value). */
function appendMissing(envFile: string, template: string): void {
  const have = parseEnvFile(fs.readFileSync(envFile, 'utf8'));
  const lines = fs
    .readFileSync(template, 'utf8')
    .split('\n')
    .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line) && !have.has(line.slice(0, line.indexOf('='))))
    .map((line) =>
      line.endsWith('=CHANGEME')
        ? `${line.slice(0, -'CHANGEME'.length)}${randomBytes(24).toString('hex')}`
        : line,
    );
  if (lines.length > 0) fs.appendFileSync(envFile, `\n${lines.join('\n')}\n`);
}

/**
 * The keys added in step 3 keep a throw-away project apart from a developer's stack: a new host
 * port gets the offset; a new network setting is refused until `isolateEnv` knows it.
 */
function isolateAdded(envFile: string, before: Map<string, string>, offset: number): void {
  const text = fs.readFileSync(envFile, 'utf8');
  for (const key of parseEnvFile(text).keys()) {
    if (!before.has(key) && /SUBNET|_IP$|IP_RANGE|GATEWAY/.test(key)) {
      throw new Error(`${key} is new: teach isolateEnv (throwaway-compose.ts) about it`);
    }
  }
  const shifted = text.replace(/^(\w+_HOST_PORT)=(\d+)$/gm, (line, key: string, port: string) =>
    before.has(key) ? line : `${key}=${Number(port) + offset}`,
  );
  fs.writeFileSync(envFile, shifted, { mode: 0o600 });
}
