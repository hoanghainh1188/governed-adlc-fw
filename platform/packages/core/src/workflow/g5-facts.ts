// What G5 reads about the intent's last run (task C07 PR 2, design/ADR-M34 §2.8): the run's final
// status and stop reason, the runner's records of its changes (`diff_stored`, `changes_checked`,
// PR 1), the key's cap (`key_issued`), the run's synced spend
// (`cost_records`), and the intent's synced spend; the runner's secret scan of the added lines
// (`secrets_scanned`, H04, ADR-M93); the size a person reviews (`diff_measured`, H05, ADR-M95). The
// review size is not in the G5 input hash: it is computed from the stored diff, which is. The G5 input hash binds every G5 decision and the G5 escalation to exactly this
// result of exactly this run (FR-17). Codes, counts and hashes only: never a path.
import { createHash } from 'node:crypto';

import { canonicalJson } from '@sdlc/config';
import type { ReviewSizeFacts, RunStatus } from '@sdlc/contracts';

import { fromMicros, toMicros } from '../cost/money.js';
import type { Run, RunEventRow } from '../db/schema.js';
import type { TenantScope } from '../db/tenant-scope.js';

/** Run statuses that go to G5 (`finishRun`, the runner's changes step). */
export const G5_RUN_STATUSES: readonly RunStatus[] = [
  'succeeded',
  'stopped_budget',
  'stopped_scope',
  'stopped_timeout',
  'stopped_stalled',
];

export interface G5Changes {
  readonly changedFiles: number;
  readonly outOfScope: number;
  readonly instructionFiles: number;
  /** O06: changed paths outside the project's folder (0 before O06 and without a folder). */
  readonly outsideFolder: number;
  readonly pathsSha256: string;
}

/** The runner's secret scan (`secrets_scanned`, H04): its result and the number of findings. */
export interface G5SecretScan {
  readonly result: 'clean' | 'found' | 'failed';
  readonly findings: number;
}

export interface G5Facts {
  readonly run: Run;
  /** SHA-256 of the stored diff (`diff_stored`); null when the runner recorded none. */
  readonly diffSha256: string | null;
  /** The runner's check of the changed paths (`changes_checked`); null when missing. */
  readonly changes: G5Changes | null;
  /** The runner's secret scan (`secrets_scanned`); null when missing (QUESTIONS #590). */
  readonly secrets: G5SecretScan | null;
  /** The size a person reviews (`diff_measured`); null when missing or failed (QUESTIONS #603). */
  readonly review: ReviewSizeFacts | null;
  /** The cap of the run's key (`key_issued`); null when unknown. */
  readonly keyCapUsd: string | null;
  /** The run's synced spend (`cost_records`), as a decimal string. */
  readonly spentUsd: string;
  /** The intent's synced spend over all its runs, as a decimal string (bound in the input hash). */
  readonly intentSpentUsd: string;
  /** The G5 input hash: the decisions and the escalation are bound to it. */
  readonly inputSha256: string;
}

function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function num(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

/**
 * The review size of a run from its events (`diff_measured`, H05): the last one, when measured;
 * null when missing, failed or malformed (G5 then holds the run, QUESTIONS #603).
 */
export function reviewSizeOf(
  events: readonly Pick<RunEventRow, 'event_type' | 'payload'>[],
): ReviewSizeFacts | null {
  const measured = events.filter((e) => e.event_type === 'diff_measured').at(-1)?.payload;
  if (measured?.result !== 'measured') return null;
  const { review_files: files, review_lines: lines } = measured;
  if (typeof files !== 'number' || typeof lines !== 'number') return null;
  if (!Number.isSafeInteger(files) || !Number.isSafeInteger(lines)) return null;
  return { files, lines };
}

/** The facts of the intent's last run, or null when it has no run that goes to G5. */
export async function gatherG5Facts(scope: TenantScope, intentId: string): Promise<G5Facts | null> {
  const run = (await scope.runs.listForIntent(intentId)).at(-1);
  if (!run || !G5_RUN_STATUSES.includes(run.status)) return null;
  const events = await scope.runEvents.list(run.id);
  const last = (type: string) => events.filter((e) => e.event_type === type).at(-1)?.payload;
  const diff = last('diff_stored');
  const checked = last('changes_checked');
  const key = last('key_issued');
  const scanned = last('secrets_scanned');
  const result = scanned?.result;
  const secrets: G5SecretScan | null =
    result === 'clean' || result === 'found' || result === 'failed'
      ? { result, findings: num(scanned?.findings) }
      : null;
  const changes: G5Changes | null =
    checked && typeof checked.paths_sha256 === 'string'
      ? {
          changedFiles: num(checked.changed_files),
          outOfScope: num(checked.out_of_scope),
          instructionFiles: num(checked.instruction_files),
          outsideFolder: num(checked.outside_folder),
          pathsSha256: checked.paths_sha256,
        }
      : null;
  const review = reviewSizeOf(events);
  const records = await scope.costRecords.listForRun(run.id);
  const spent = records.reduce((sum, r) => sum + toMicros(String(r.cost_usd)), 0n);
  const diffSha256 = str(diff?.sha256);
  const contract = await scope.runContracts.getByRunId(run.id);
  const intentSpentUsd = fromMicros(toMicros(await scope.costRecords.totalForIntent(intentId)));
  return {
    run,
    diffSha256,
    changes,
    secrets,
    review,
    keyCapUsd: str(key?.max_budget_usd),
    spentUsd: fromMicros(spent),
    intentSpentUsd,
    // The approved plan (Harry, 2026-09-28): the run, its contract, its diff, its checked paths and
    // the intent's spend after the sync. A later spend sync changes the hash: a G5 approval or an
    // escalation decision bound to the earlier result is then voided (FR-17).
    inputSha256: sha256({
      v: 1,
      run_id: run.id,
      contract_sha256: contract?.contract_sha256 ?? null,
      status: run.status,
      stop_reason: run.stop_reason,
      diff_sha256: diffSha256,
      paths_sha256: changes?.pathsSha256 ?? null,
      intent_spent_usd: intentSpentUsd,
    }),
  };
}

/** The share of the key's cap the run spent, in whole percent; null when the cap is unknown. */
export function spentPercent(facts: Pick<G5Facts, 'keyCapUsd' | 'spentUsd'>): number | null {
  if (facts.keyCapUsd === null) return null;
  const cap = toMicros(facts.keyCapUsd);
  if (cap <= 0n) return null;
  return Number((toMicros(facts.spentUsd) * 100n) / cap);
}
