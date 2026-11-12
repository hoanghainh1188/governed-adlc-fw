// What G6 reads from CI (task C08 PR 2, D-08 C08 AC2, design/ADR-M38 §2.7, QUESTIONS #157, #159).
//
// `readCi` runs before the step's transaction (no HTTP call under the intent lock, as at G4): the
// run's pull request, the checks of its head commit and the open security findings. The step then
// records what it read as the run event `ci_checked` (codes, counts and hashes: check names stay on
// the Git host) when it changed, and decides from the database (`gatherG6Facts`), never from what
// the Git host said in an event. The G6 input hash binds every G6 decision and escalation (FR-17).
//
// Checks (QUESTIONS #159): the project's `verification.required_checks` by name (empty: every check
// on the commit). Passed: `success`, `neutral`, `skipped`. Failed: `failure`, `error`, `timed_out`.
// Pending: not finished, `cancelled`, `stale`, `action_required` (a person can run it again), a
// required check that is missing. No check at all on the commit is `missing` (O06, ADR-M106): the
// repository may have no CI; it never passes, and G6 stops sooner with a cause of its own.
import { createHash } from 'node:crypto';

import { canonicalJson } from '@sdlc/config';
import type { CheckItem, GitHostAdapter, ProjectConfig, Severity } from '@sdlc/contracts';

import type { Intent, Run } from '../db/schema.js';
import type { TenantScope } from '../db/tenant-scope.js';
import { projectRepoRef } from './g4-proposal.js';
import { latestRun, publishState } from './publish-state.js';

/** What G6 reads outside the database (the worker wires the Git host in; tests pass fakes). */
export interface G6Deps {
  readonly gitHost: Pick<
    GitHostAdapter,
    'getPullRequest' | 'getCheckStatus' | 'getSecurityFindings'
  >;
}

export type CiState = 'passed' | 'failed' | 'pending' | 'missing';
export type FindingsState = 'known' | 'not_enabled' | 'forbidden';

export interface CiReading {
  readonly runId: string;
  readonly prNumber: number;
  readonly prState: 'open' | 'closed' | 'merged';
  readonly headSha: string;
  readonly state: CiState;
  readonly checksSha256: string;
  readonly findings: FindingsState;
  readonly counts: Readonly<Record<Severity, number>>;
}

const PASSED = new Set(['success', 'neutral', 'skipped']);
const FAILED = new Set(['failure', 'error', 'timed_out']);
const NO_FINDINGS: Readonly<Record<Severity, number>> = { critical: 0, high: 0, medium: 0, low: 0 };

function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function outcome(check: CheckItem | undefined): CiState {
  if (!check?.completed || check.conclusion === null) return 'pending';
  if (PASSED.has(check.conclusion)) return 'passed';
  if (FAILED.has(check.conclusion)) return 'failed';
  return 'pending';
}

/**
 * The result of the checks G6 waits for, and the hash of what it saw (names and outcomes, sorted).
 * With required names, each name counts once: a status and a check run of the same name both
 * count, and the worse one wins.
 */
export function evaluateChecks(
  checks: readonly CheckItem[],
  required: readonly string[],
): { readonly state: CiState; readonly checksSha256: string } {
  const considered: [string, CiState][] =
    required.length === 0
      ? checks.map((c) => [c.name, outcome(c)])
      : required.map((name) => {
          const named = checks.filter((c) => c.name === name);
          if (named.length === 0) return [name, 'pending'];
          const states = named.map(outcome);
          return [
            name,
            states.includes('failed')
              ? 'failed'
              : states.includes('pending')
                ? 'pending'
                : 'passed',
          ];
        });
  considered.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0] < b[0] ? -1 : 1));
  const states = considered.map(([, state]) => state);
  const state: CiState =
    checks.length === 0
      ? 'missing'
      : states.includes('failed')
        ? 'failed'
        : states.includes('pending')
          ? 'pending'
          : 'passed';
  return { state, checksSha256: sha256(considered) };
}

/**
 * Reads the run's pull request, its checks and its security findings from the Git host. Null when
 * the intent has no pushed run with a linked pull request (nothing to read yet). Throws
 * `GitHostError` when the Git host cannot be read (the step waits and tries again).
 */
export async function readCi(
  scope: TenantScope,
  deps: G6Deps,
  intent: Intent,
  config: ProjectConfig,
): Promise<CiReading | null> {
  const run = await latestRun(scope, intent.id);
  if (!run || intent.pr_number === null) return null;
  const { pushed } = await publishState(scope, run.id);
  const project = await scope.projects.getById(intent.project_id);
  const ref = project ? projectRepoRef(project) : undefined;
  if (!pushed || !ref) return null;
  const pr = await deps.gitHost.getPullRequest(ref, intent.pr_number);
  const checks = await deps.gitHost.getCheckStatus(ref, pr.headSha);
  const { state, checksSha256 } = evaluateChecks(
    checks.checks,
    config.verification.required_checks,
  );
  const findings = await deps.gitHost.getSecurityFindings(ref, pr.number);
  return {
    runId: run.id,
    prNumber: pr.number,
    prState: pr.merged ? 'merged' : pr.state,
    headSha: pr.headSha,
    state,
    checksSha256,
    findings: findings.known ? 'known' : findings.reason,
    counts: findings.known ? findings.counts : NO_FINDINGS,
  };
}

function payloadOf(reading: CiReading) {
  return {
    pr_number: reading.prNumber,
    pr_state: reading.prState,
    head_sha: reading.headSha,
    state: reading.state,
    checks_sha256: reading.checksSha256,
    findings: reading.findings,
    critical: reading.counts.critical,
    high: reading.counts.high,
    medium: reading.counts.medium,
    low: reading.counts.low,
  };
}

/**
 * Records the reading as `ci_checked` when it differs from the run's last one. Under the lock.
 * Returns true when it recorded a new reading.
 */
export async function recordCiReading(tx: TenantScope, reading: CiReading): Promise<boolean> {
  const events = await tx.runEvents.list(reading.runId);
  const last = events.filter((e) => e.event_type === 'ci_checked').at(-1)?.payload;
  const next = payloadOf(reading);
  if (last && canonicalJson(last) === canonicalJson(next)) return false;
  await tx.runEvents.append(reading.runId, 'ci_checked', next);
  return true;
}

export interface DependencyScanFacts {
  readonly result: string;
  readonly newDependencies: number;
  readonly changedDependencies: number;
  readonly licenseViolations: number;
  readonly installScripts: number;
  readonly typosquattingWarnings: number;
  readonly advisoryFindings: number;
  readonly cause?: string;
}

export interface G6Facts {
  readonly run: Run;
  /** The commit the platform pushed. */
  readonly pushedHead: string;
  /** The last reading of the pull request and CI; null before the first one. */
  readonly ci: Omit<CiReading, 'runId'> | null;
  /** When the last reading was recorded (database clock); null before the first one. */
  readonly ciReadAt: Date | null;
  /** The scan of added or changed dependencies (H02, ADR-M96); null before recorded. */
  readonly dependencies: DependencyScanFacts | null;
  /** The G6 input hash: the decisions and escalations are bound to it. */
  readonly inputSha256: string;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

/** The G6 facts of the intent's last run from the database, or null before its push. */
export async function gatherG6Facts(scope: TenantScope, intentId: string): Promise<G6Facts | null> {
  const run = await latestRun(scope, intentId);
  if (run?.status !== 'succeeded') return null;
  const events = await scope.runEvents.list(run.id);
  const pushedEvent = events.filter((e) => e.event_type === 'branch_pushed').at(-1);
  if (!pushedEvent) return null;
  const pushedHead = str(pushedEvent.payload.head_sha);
  const depEvent = events.filter((e) => e.event_type === 'dependencies_scanned').at(-1);
  const depPayload = depEvent?.payload;
  const dependencies: DependencyScanFacts | null = depPayload
    ? {
        result: str(depPayload.result),
        newDependencies: num(depPayload.new_dependencies),
        changedDependencies: num(depPayload.changed_dependencies),
        licenseViolations: num(depPayload.license_violations),
        installScripts: num(depPayload.install_scripts),
        typosquattingWarnings: num(depPayload.typosquatting_warnings),
        advisoryFindings: num(depPayload.advisory_findings),
        ...(depPayload.cause ? { cause: str(depPayload.cause) } : {}),
      }
    : null;
  const checkedEvent = events.filter((e) => e.event_type === 'ci_checked').at(-1);
  const checked = checkedEvent?.payload;
  const ci: G6Facts['ci'] = checked
    ? {
        prNumber: num(checked.pr_number),
        prState: str(checked.pr_state) as CiReading['prState'],
        headSha: str(checked.head_sha),
        state: str(checked.state) as CiState,
        checksSha256: str(checked.checks_sha256),
        findings: str(checked.findings) as FindingsState,
        counts: {
          critical: num(checked.critical),
          high: num(checked.high),
          medium: num(checked.medium),
          low: num(checked.low),
        },
      }
    : null;
  return {
    run,
    pushedHead,
    ci,
    ciReadAt: checkedEvent ? new Date(checkedEvent.created_at) : null,
    dependencies,
    inputSha256: sha256({ v: 1, run_id: run.id, pushed_head: pushedHead, ci, dependencies }),
  };
}
