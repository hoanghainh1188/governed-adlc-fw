// D-08 A09: CI for the platform repo. Static checks of the workflow files; the fault-injection
// runs (a failing check, a fake secret, a critical dependency) are linked in the A09 pull request.
import fs from 'node:fs';
import path from 'node:path';
import * as prettier from 'prettier';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { repoRoot } from './helpers';

const root = repoRoot();
const workflowsDir = path.join(root, '.github/workflows');

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, unknown>;
}

interface Job {
  needs?: string | string[];
  if?: string;
  uses?: string; // a job that calls a reusable workflow has no steps and no timeout of its own
  with?: Record<string, unknown>;
  'timeout-minutes'?: number;
  permissions?: unknown;
  outputs?: Record<string, string>;
  steps: Step[];
}

interface Workflow {
  on: Record<string, unknown>;
  permissions?: Record<string, string>;
  env?: Record<string, string>;
  jobs: Record<string, Job>;
}

function readYaml<T>(file: string): T {
  return parse(fs.readFileSync(path.join(root, file), 'utf8')) as T;
}
/** A workflow file; a job that calls a reusable workflow gets an empty step list. */
function readWorkflow(file: string): Workflow {
  const wf = readYaml<Workflow>(file);
  for (const j of Object.values(wf.jobs)) j.steps ??= [];
  return wf;
}

const workflowFiles = fs
  .readdirSync(workflowsDir)
  .filter((name) => name.endsWith('.yml'))
  .map((name) => `.github/workflows/${name}`);
const workflows = workflowFiles.map((file) => ({ file, wf: readWorkflow(file) }));
const ci = readWorkflow('.github/workflows/ci.yml');
const ciEnv = ci.env ?? {};

function job(name: string): Job {
  const found = ci.jobs[name];
  if (!found) throw new Error(`ci.yml has no job "${name}"`);
  return found;
}

function runs(name: string): string[] {
  return job(name).steps.flatMap((step) => (step.run ? [step.run] : []));
}

function runText(name: string): string {
  return runs(name).join('\n');
}

describe('AC1: lint, type check and unit tests run on every PR', () => {
  it('runs on every pull request, daily, weekly and on demand; not again on a push to main', () => {
    expect(Object.keys(ci.on).sort()).toEqual(['pull_request', 'schedule', 'workflow_dispatch']);
    // Every branch, no path filter; ready_for_review starts the heavy jobs a draft skipped.
    expect(ci.on.pull_request).toEqual({
      types: ['opened', 'synchronize', 'reopened', 'ready_for_review'],
    });
    const crons = (ci.on.schedule as { cron: string }[]).map((s) => s.cron);
    expect(crons).toEqual([ciEnv.DAILY_CRON, ciEnv.WEEKLY_CRON]);
    expect(ciEnv.DAILY_CRON).toBe('0 18 * * 1-6');
    expect(ciEnv.WEEKLY_CRON).toBe('0 18 * * 0'); // never on the same day as the daily run
  });

  it('checks runs on every pull request, weekly and manual run; the daily run only scans', () => {
    const condition = "${{ !cancelled() && needs.scan.outputs.run_checks != 'false' }}";
    expect(job('checks').needs).toBe('scan');
    expect(job('checks').if).toBe(condition);
    const scan = runText('scan');
    expect(scan).toContain('checks=true;');
    // The only line that sets run_checks to false is guarded by the daily run.
    const falseLines = scan.split('\n').filter((line) => line.includes('checks=false'));
    expect(falseLines).toHaveLength(1);
    expect(scan).toMatch(/if \[ "\$daily" = true \]; then\s*checks=false;/);
    expect(scan).toMatch(/elif \[ "\$EVENT_NAME" = schedule \]; then\s*daily=true/);
  });

  it('the checks job installs from the lockfile and runs every repo check', () => {
    expect(runs('checks')).toEqual(
      expect.arrayContaining([
        'pnpm install --frozen-lockfile',
        'pnpm build',
        'pnpm typecheck',
        'pnpm lint',
        'pnpm format:check',
        'pnpm test',
      ]),
    );
    expect(runText('checks')).toContain('actionlint');
  });
});

describe('workflow hardening (all workflows)', () => {
  it.each(workflows)('$file pins every action by commit SHA', ({ wf }) => {
    const uses = Object.values(wf.jobs).flatMap((job) =>
      job.steps.flatMap((step) => (step.uses ? [step.uses] : [])),
    );
    expect(uses.length).toBeGreaterThan(0);
    for (const ref of uses) expect(ref).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
  });

  it.each(workflows)(
    '$file declares top-level permissions and never uses pull_request_target',
    ({ wf }) => {
      expect(wf.permissions).toBeDefined();
      expect(Object.keys(wf.on)).not.toContain('pull_request_target');
    },
  );

  // Every change to main goes through a reviewed pull request (CLAUDE.md "Current constraints"),
  // and no workflow commits to a pull request branch either: a commit pushed by a workflow waits
  // for approval and leaves the PR head without ci-ok (the render-diagrams bot, removed).
  // Two exceptions: release.yml's job `release` writes contents to create the GitHub Release of a
  // tag (V12, RELEASING.md), and release-tag.yml's job `tag` creates the tag of a merged version
  // pull request through the API (ADR-M104). Neither pushes (release.test.ts).
  const WRITES_CONTENTS = new Set([
    '.github/workflows/release.yml:release',
    '.github/workflows/release-tag.yml:tag',
  ]);
  it.each(workflows)('$file never writes contents and never pushes', ({ file, wf }) => {
    const grants = [
      wf.permissions,
      ...Object.entries(wf.jobs)
        .filter(([name]) => !WRITES_CONTENTS.has(`${file}:${name}`))
        .map(([, job]) => job.permissions),
    ];
    for (const grant of grants) {
      if (grant && typeof grant === 'object') {
        expect((grant as Record<string, string>).contents).not.toBe('write');
      } else if (grant !== undefined) {
        expect(grant).not.toBe('write-all');
      }
    }
    const runsGitPush = Object.values(wf.jobs).some((job) =>
      job.steps.some((step) => step.run?.includes('git push')),
    );
    expect(runsGitPush).toBe(false);
  });

  it.each(workflows)('$file pins the version of every global npm install', ({ wf }) => {
    const installs = Object.values(wf.jobs).flatMap((job) =>
      job.steps.flatMap((step) =>
        (step.run ?? '').split('\n').filter((line) => /npm (install|i) -g/.test(line)),
      ),
    );
    for (const line of installs) expect(line).toMatch(/@[\w/-]+@(\$\{\w+\}|\d+\.\d+\.\d+)/);
  });

  it('ci.yml only reads the repository and no job widens permissions', () => {
    expect(ci.permissions).toEqual({ contents: 'read' });
    for (const job of Object.values(ci.jobs)) expect(job.permissions).toBeUndefined();
  });

  it('ci.yml checkouts do not keep the token on disk', () => {
    for (const job of Object.values(ci.jobs)) {
      for (const step of job.steps.filter((s) => s.uses?.startsWith('actions/checkout@'))) {
        expect(step.with?.['persist-credentials']).toBe(false);
      }
    }
  });

  it('downloaded tools are checked against a pinned SHA-256', () => {
    for (const tool of ['GITLEAKS', 'TRIVY', 'ACTIONLINT']) {
      expect(ciEnv[`${tool}_SHA256`]).toMatch(/^[0-9a-f]{64}$/);
    }
    const all = Object.keys(ci.jobs).map(runText).join('\n');
    expect(all.match(/curl -fsSLo/g)?.length).toBe(all.match(/sha256sum -c -/g)?.length);
    expect(ciEnv.SEMGREP_IMAGE).toMatch(/@sha256:[0-9a-f]{64}$/);
  });

  it.each(workflows)('$file sets timeout-minutes on every job', ({ wf }) => {
    for (const job of Object.values(wf.jobs)) {
      // A job that calls a workflow cannot set a timeout: the called file's jobs do (V15).
      if (job.uses) continue;
      expect(job['timeout-minutes']).toBeGreaterThan(0);
      expect(job['timeout-minutes']).toBeLessThanOrEqual(40);
    }
  });

  it.each(workflows)('$file calls only local workflows that only run when called', ({ wf }) => {
    for (const job of Object.values(wf.jobs).filter((j) => j.uses)) {
      expect(job.uses).toMatch(/^\.\/\.github\/workflows\/[\w-]+\.yml$/);
      const called = readWorkflow(job.uses!.slice(2));
      expect(Object.keys(called.on)).toContain('workflow_call');
    }
  });

  it('Prettier formats the workflow files (ADR-M16 section 2.6, revisited in A09)', async () => {
    for (const file of workflowFiles) {
      const info = await prettier.getFileInfo(path.join(root, file), {
        ignorePath: path.join(root, '.prettierignore'),
      });
      expect(info.ignored).toBe(false);
    }
  });
});

describe('diagrams: CI checks the committed SVG, it never renders or commits', () => {
  it('the scan job runs the diagram check on every run', () => {
    const step = job('scan').steps.find((s) => s.run === 'python3 scripts/diagrams.py check');
    expect(step?.if).toBe('${{ !cancelled() }}');
    expect(workflowFiles).not.toContain('.github/workflows/render-diagrams.yml');
  });

  it('pnpm diagrams:render uses mermaid-cli pinned by version and digest, offline', () => {
    const script = fs.readFileSync(path.join(root, 'scripts/diagrams.py'), 'utf8');
    expect(script).toMatch(/"minlag\/mermaid-cli:\d+\.\d+\.\d+"\s*"@sha256:[0-9a-f]{64}"/);
    expect(script).toContain('"--network", "none"');
  });
});

describe('AC2: integration job runs the Compose core profile', () => {
  it('the scan job decides; compose shows as skipped (not passed) until the Compose file exists', () => {
    expect(job('scan').outputs?.run_compose).toBeDefined();
    expect(job('scan').outputs?.run_sandbox_image).toBeDefined();
    // Heavy jobs start only after scan and checks passed (no status function in their if).
    for (const heavy of ['compose', 'sandbox-image'])
      expect(job(heavy).needs).toEqual(['scan', 'checks']);
    expect(job('compose').if).toBe("needs.scan.outputs.run_compose == 'true'");
    expect(job('sandbox-image').if).toBe(
      "needs.scan.outputs.run_sandbox_image == 'true' || needs.scan.outputs.run_dashboard == 'true'",
    );
    expect(ciEnv.COMPOSE_FILE_PATH).toBe('platform/deploy/docker-compose.yml');
    const scan = runText('scan');
    expect(scan).toContain('[ ! -f "$COMPOSE_FILE_PATH" ]');
    expect(scan).toContain(
      'platform/deploy/ platform/packages/secrets/ platform/tests/integration/openbao/ platform/packages/adapters/model-litellm/ platform/packages/core/src/cost/ platform/tests/integration/litellm/',
    );
    expect(scan).toContain('git diff --name-only "$BASE_SHA" "$HEAD_SHA" -- "$@"');
  });

  it('C09: the sandbox image job runs the pilot suite on weekly and manual runs only (minutes)', () => {
    const steps = job('sandbox-image').steps;
    const runs = steps.map((s) => s.run ?? '');
    const pilot = runs.indexOf('pnpm test:pilot');
    expect(pilot).toBeGreaterThan(runs.indexOf('pnpm test:agent'));
    expect(steps[pilot]).toMatchObject({
      if: "needs.scan.outputs.run_pilot == 'true' && needs.scan.outputs.run_sandbox_image == 'true'",
    });
    expect(job('scan').outputs?.run_pilot).toBeDefined();
    const scan = runText('scan');
    expect(scan).toContain('echo "run_pilot=$all" >> "$GITHUB_OUTPUT"');
    // The gate steps and the worker no longer start the sandbox image job on a pull request.
    const paths = scan.slice(scan.indexOf('decide_heavy run_sandbox_image')).split('\n\n')[0]!;
    for (const p of ['platform/packages/core/src/workflow/', 'platform/apps/worker/'])
      expect(paths.split(/\s+/)).not.toContain(p);
    expect(paths.split(/\s+/)).toContain('platform/apps/runner/');
  });

  it('U01: the dashboard smoke test runs in the sandbox image job, alone when only it changed', () => {
    const steps = job('sandbox-image').steps;
    const dashboard = steps.findIndex((s) => s.run === 'pnpm test:dashboard');
    expect(dashboard).toBeGreaterThan(0);
    expect(steps[dashboard]).toMatchObject({ if: "needs.scan.outputs.run_dashboard == 'true'" });
    expect(steps[dashboard - 1]).toMatchObject({
      if: "needs.scan.outputs.run_dashboard == 'true'",
      run: 'pnpm exec playwright install --with-deps chromium',
    });
    // Every sandbox step needs its own flag, so a dashboard-only pull request skips them.
    for (const step of steps) {
      if (/sandbox-image|test:agent|test:pilot|trivy|build\.sh/.test(step.run ?? '')) {
        expect(step.if, step.run).toContain("needs.scan.outputs.run_sandbox_image == 'true'");
      }
    }
    expect(job('scan').outputs?.run_dashboard).toBeDefined();
    const scan = runText('scan');
    const paths = scan.slice(scan.indexOf('decide_heavy run_dashboard')).split('\n\n')[0]!;
    for (const p of [
      'platform/apps/dashboard/',
      'platform/packages/api-schemas/',
      'platform/apps/api/src/dashboard/',
      'platform/tests/e2e/',
    ]) {
      expect(paths.split(/\s+/)).toContain(p);
    }
  });

  it('E07: the fresh deployment job runs on the weekly schedule and on demand only, and cleans up', () => {
    expect(job('scan').outputs?.run_fresh_deploy).toBeDefined();
    expect(runText('scan')).toContain('echo "run_fresh_deploy=$all" >> "$GITHUB_OUTPUT"');
    expect(job('fresh-deploy').needs).toEqual(['scan', 'checks']);
    expect(job('fresh-deploy').if).toBe("needs.scan.outputs.run_fresh_deploy == 'true'");
    const steps = job('fresh-deploy').steps;
    expect(steps.map((s) => s.run ?? '')).toContain('pnpm test:fresh-deploy');
    expect(steps.at(-1)).toMatchObject({ if: 'always()' });
    expect(job('ci-ok').needs).toContain('fresh-deploy');
  });

  it('O02: the upgrade job runs with the fresh deployment and on a version pull request, and cleans up', () => {
    const upgrade = job('upgrade');
    expect(upgrade.needs).toEqual(['scan', 'checks']);
    // ADR-M104 §2.1: a pull request that changes the version runs it by itself.
    expect(upgrade.if).toBe(
      "needs.scan.outputs.run_fresh_deploy == 'true' || needs.scan.outputs.release_version != ''",
    );
    expect(upgrade['timeout-minutes']).toBeGreaterThan(0);
    expect(upgrade.steps[0]?.with?.['fetch-depth']).toBe(0);
    expect(upgrade.steps.map((s) => s.run ?? '')).toContain('pnpm test:upgrade');
    expect(upgrade.steps.at(-1)).toMatchObject({ if: 'always()' });
    expect(job('ci-ok').needs).toContain('upgrade');
  });

  it('V02: the trial set-up job has the same trigger as the fresh deployment, and cleans up', () => {
    expect(job('trial-up').needs).toEqual(['scan', 'checks']);
    expect(job('trial-up').if).toBe("needs.scan.outputs.run_fresh_deploy == 'true'");
    const steps = job('trial-up').steps;
    expect(steps.map((s) => s.run ?? '')).toContain('pnpm test:trial-up');
    expect(steps.at(-1)).toMatchObject({ if: 'always()' });
    expect(job('ci-ok').needs).toContain('trial-up');
  });

  it('O01: the runner tests also run on a rootless Engine from pinned archives, like compose (ADR-M91 §2.4)', () => {
    const rootless = job('runner-rootless');
    expect(rootless.needs).toEqual(['scan', 'checks']);
    expect(rootless.if).toBe("needs.scan.outputs.run_compose == 'true'");
    for (const pin of ['DOCKER_STATIC_SHA256', 'DOCKER_ROOTLESS_EXTRAS_SHA256'])
      expect(ciEnv[pin]).toMatch(/^[0-9a-f]{64}$/);
    expect(ciEnv.DOCKER_ROOTLESS_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    const text = runText('runner-rootless');
    expect(text).toContain('$DOCKER_STATIC_SHA256  $RUNNER_TEMP/docker.tgz" | sha256sum -c -');
    expect(text).toContain(
      '$DOCKER_ROOTLESS_EXTRAS_SHA256  $RUNNER_TEMP/extras.tgz" | sha256sum -c -',
    );
    // The Engine starts before the tests, and the tests are the same as in the compose job.
    const order = runs('runner-rootless');
    const start = order.findIndex((r) => r.includes('test-rootless-docker.sh'));
    expect(start).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('pnpm test:runner')).toBeGreaterThan(start);
    expect(runs('compose')).toContain('pnpm test:runner');
    // O01 PR 2: the split set-up after the link address exists.
    const link = order.findIndex((r) => r.includes('ip link add sdlc-link type dummy'));
    expect(link).toBeGreaterThan(start);
    expect(order.indexOf('pnpm test:runner-split')).toBeGreaterThan(link);
    expect(job('ci-ok').needs).toContain('runner-rootless');
  });

  it('heavy jobs run on the weekly schedule and on demand, never on the daily run or a draft (ADR-M25 §2.9)', () => {
    const scan = runText('scan');
    expect(scan).toMatch(/workflow_dispatch \]; then\s*all=true/);
    expect(scan).toMatch(/\[ "\$SCHEDULE" = "\$WEEKLY_CRON" \]; then\s*all=true/);
    expect(scan).toMatch(/elif \[ "\$all" = true \]; then\s*run=true/);
    expect(scan).toMatch(/elif \[ "\$daily" = true \]; then\s*why=/);
    expect(scan).toMatch(/elif \[ "\$DRAFT" = true \]; then\s*why=/);
    expect(scan).toContain('base commit unknown, running to be safe');
  });

  it('starts the core profile with the A02 scripts, runs integration tests and always cleans up', () => {
    const compose = runText('compose');
    expect(compose).toContain('platform/deploy/scripts/init-env.sh');
    expect(compose).toContain('platform/deploy/scripts/up.sh core');
    expect(compose).toContain('pnpm test:integration');
    expect(compose).toContain('pnpm test:litellm');
    expect(compose).toContain('pnpm test:runner');
    const cleanup = job('compose').steps.find((s) => s.run?.includes('down --volumes'));
    expect(cleanup?.if).toBe('always()');
  });
});

describe('A06: database integration job', () => {
  it('runs the DB tests like checks, except on a documentation-only PR, and ci-ok waits for it', () => {
    expect(job('db').needs).toBe('scan');
    expect(job('db').if).toBe("${{ !cancelled() && needs.scan.outputs.run_db != 'false' }}");
    expect(job('scan').outputs?.run_db).toBeDefined();
    const scan = runText('scan');
    expect(scan).toContain('db=$checks;');
    expect(scan).toContain(
      String.raw`grep -vE '\.(md|mmd|svg|csv)$|^(design|handbook|diagrams|_review)/'`,
    );
    // Only a pull request with a known base and documentation-only changes skips it.
    expect(scan).toMatch(/\[ "\$EVENT_NAME" = pull_request \]/);
    expect(scan.split('\n').filter((line) => line.includes('db=false'))).toHaveLength(1);
    expect(runText('db')).toContain('pnpm test:db');
    expect(job('ci-ok').needs).toContain('db');
  });

  it('B07: runs the intent workflow tests on the pinned Temporal test server', () => {
    expect(runText('db')).toContain('pnpm test:workflow');
  });

  it('pnpm test:db uses a throw-away container and requires a database', () => {
    const script = fs.readFileSync(path.join(root, 'platform/deploy/scripts/test-db.sh'), 'utf8');
    expect(script).toContain('SDLC_REQUIRE_DB=1');
    expect(script).toContain('-p 127.0.0.1::5432');
    expect(script).toContain('postgres/init:/docker-entrypoint-initdb.d:ro');
    expect(script).toContain('SDLC_TEST_DB_DOCKER_HOST');
    expect(script).toMatch(/trap cleanup EXIT/);
    const rootless = fs.readFileSync(
      path.join(root, 'platform/deploy/scripts/test-rootless-docker.sh'),
      'utf8',
    );
    expect(rootless).toContain('SDLC_TEST_DB_DOCKER_HOST');
  });
});

describe('AC3: Gitleaks, Semgrep and Trivy run and block critical findings', () => {
  it('thresholds are set once, in the workflow env', () => {
    expect(ciEnv.TRIVY_BLOCK_SEVERITY).toBe('CRITICAL');
    expect(ciEnv.TRIVY_REPORT_SEVERITY).toBe('HIGH');
    expect(ciEnv.SEMGREP_BLOCK_SEVERITY).toBe('ERROR');
    expect(ciEnv.SEMGREP_RULESETS).toBe('p/default p/github-actions');
    expect(runText('scan')).not.toMatch(/--severity[ =]["']?(CRITICAL|HIGH|ERROR)/);
  });

  it('one scan job runs every scanner, even when an earlier one failed', () => {
    const scanners = job('scan').steps.filter((s) => s.run && s.name);
    expect(scanners.length).toBeGreaterThanOrEqual(6);
    for (const step of scanners) expect(step.if).toBe('${{ !cancelled() }}');
  });

  it('gitleaks scans the full history of the checked-out commit and fails on any finding', () => {
    const checkout = job('scan').steps.find((s) => s.uses?.startsWith('actions/checkout@'));
    expect(checkout?.with?.['fetch-depth']).toBe(0);
    expect(runText('scan')).toMatch(/gitleaks" git --config \.gitleaks\.toml .*--exit-code 1/s);
    expect(runText('scan')).toContain('--log-opts HEAD'); // not --all: other branches are not this PR
  });

  it('semgrep fails on findings at the blocking severity', () => {
    expect(runText('scan')).toMatch(/--severity "\$SEMGREP_BLOCK_SEVERITY" --error/);
  });

  it('trivy reports HIGH without blocking, and fails on CRITICAL (dev dependencies included)', () => {
    const [report, block] = runs('scan').filter((r) => r.includes('trivy" fs'));
    expect(report).toContain('--exit-code 0');
    expect(report).toContain('$TRIVY_REPORT_SEVERITY');
    expect(report).toContain('$GITHUB_STEP_SUMMARY');
    expect(block).toContain('--severity "$TRIVY_BLOCK_SEVERITY"');
    expect(block).toContain('--exit-code 1');
    for (const r of [report, block]) expect(r).toContain('--include-dev-deps');
  });

  it('a pull request that changes the version builds and scans the release images, read only (V15)', () => {
    const scan = job('release-images');
    expect(scan.needs).toEqual(['scan', 'checks']);
    expect(scan.if).toBe("needs.scan.outputs.release_version != ''");
    expect(scan.uses).toBe('./.github/workflows/release-images-scan.yml');
    expect(scan.with).toEqual({ version: '${{ needs.scan.outputs.release_version }}' });
    expect(scan.permissions).toBeUndefined();
    const called = readWorkflow('.github/workflows/release-images-scan.yml');
    expect(called.permissions).toEqual({ contents: 'read' });
    for (const j of Object.values(called.jobs)) expect(j.permissions).toBeUndefined();
    expect(job('scan').outputs?.release_version).toBe(
      '${{ steps.decide.outputs.release_version }}',
    );
    const decide = runText('scan');
    expect(decide).toContain('git show "$BASE_SHA:package.json" | jq -r .version');
    expect(decide).toContain('echo "release_version=$version" >> "$GITHUB_OUTPUT"');
  });

  it('ci-ok fails when any job failed or was cancelled, and treats skipped as OK', () => {
    const others = Object.keys(ci.jobs).filter((name) => name !== 'ci-ok');
    expect(job('ci-ok').needs).toEqual(others);
    // Always on pull requests and manual runs; scheduled runs have no summary job.
    expect(job('ci-ok').if).toBe("${{ always() && github.event_name != 'schedule' }}");
    expect(runText('ci-ok')).toContain('success | skipped) ;;');
  });

  it('exception files exist and extend (not replace) the gitleaks default rules', () => {
    for (const file of ['.gitleaks.toml', '.trivyignore', '.semgrepignore']) {
      expect(fs.existsSync(path.join(root, file))).toBe(true);
    }
    expect(fs.readFileSync(path.join(root, '.gitleaks.toml'), 'utf8')).toMatch(
      /\[extend\]\s*useDefault = true/,
    );
  });
});

describe('Dependabot and CODEOWNERS', () => {
  it('Dependabot updates GitHub Actions and Compose images monthly (Actions minutes)', () => {
    const config = readYaml<{
      updates: { 'package-ecosystem': string; schedule: { interval: string } }[];
    }>('.github/dependabot.yml');
    expect(config.updates.map((u) => u['package-ecosystem']).sort()).toEqual([
      'docker-compose',
      'github-actions',
    ]);
    for (const update of config.updates) expect(update.schedule.interval).toBe('monthly');
  });

  it('Dependabot never proposes major image updates, keeps ClickHouse on its LTS line and groups Temporal', () => {
    type Ignore = { 'dependency-name': string; 'update-types'?: string[] };
    const config = readYaml<{
      updates: {
        'package-ecosystem': string;
        ignore?: Ignore[];
        groups?: Record<string, { patterns: string[] }>;
      }[];
    }>('.github/dependabot.yml');
    const compose = config.updates.find((u) => u['package-ecosystem'] === 'docker-compose');
    const ignores = compose?.ignore ?? [];
    const ignored = (name: string, type: string): boolean =>
      ignores.some(
        (i) => i['dependency-name'] === name && (i['update-types'] ?? []).includes(type),
      );
    expect(ignored('*', 'version-update:semver-major')).toBe(true);
    expect(ignored('clickhouse/clickhouse-server', 'version-update:semver-minor')).toBe(true);
    const patterns = Object.values(compose?.groups ?? {}).flatMap((g) => g.patterns);
    expect(patterns).toContain('temporalio/*');
    // Temporal first (a dependency joins the first matching group), then every other image.
    expect(Object.keys(compose?.groups ?? {})).toEqual(['temporal', 'deploy-images']);
    expect(compose?.groups?.['deploy-images']?.patterns).toEqual(['*']);
  });

  it('Dependabot skips the images the platform builds itself (they are on no registry)', () => {
    type Ignore = { 'dependency-name': string; 'update-types'?: string[] };
    const config = readYaml<{
      updates: { 'package-ecosystem': string; ignore?: Ignore[] }[];
    }>('.github/dependabot.yml');
    const compose = config.updates.find((u) => u['package-ecosystem'] === 'docker-compose');
    const local = (compose?.ignore ?? []).find((i) => i['dependency-name'] === 'sdlc-*');
    expect(local).toBeDefined();
    expect(local?.['update-types']).toBeUndefined();
    const deployDir = path.join(root, 'platform/deploy');
    const images = fs
      .readdirSync(deployDir)
      .filter((file) => /\.ya?ml$/.test(file))
      .flatMap((file) =>
        [
          ...fs.readFileSync(path.join(deployDir, file), 'utf8').matchAll(/^\s*image:\s*(\S+)/gm),
        ].map((m) => m[1] ?? ''),
      );
    // The images built from this repo (no registry path) all match the ignore rule.
    const built = images.filter((image) => image.startsWith('sdlc-'));
    expect(built.map((image) => image.split(':')[0]).sort()).toEqual([
      'sdlc-api',
      'sdlc-otel-collector',
      'sdlc-runner',
      'sdlc-worker',
    ]);
  });

  it('CODEOWNERS has a default owner and names only known owners', () => {
    const rules = fs
      .readFileSync(path.join(root, '.github/CODEOWNERS'), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => line.split(/\s+/));
    expect(rules[0]).toEqual(['*', '@hoanghainh1188']);
    for (const [, ...owners] of rules) expect(owners).toEqual(['@hoanghainh1188']);
  });
});
