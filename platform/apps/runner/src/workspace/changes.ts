// The changes of a run, computed and checked outside the sandbox at the end of the run (task C07,
// D-08 C07 AC1, QUESTIONS #130 A, #126, design/ADR-M34 §2.2–§2.4).
//
// 1. `computeRunPatch` (export.ts): the sandbox's workspace mirrored onto the runner's clone, the
//    full diff against `base_sha` with hardened git. Committed and uncommitted edits alike: what the
//    agent left is what G5 judges, and a stopped run's edits are kept as evidence.
// 2. The diff is stored as evidence `diff` (`s3://evidence/diffs/<tenant>/<intent>/<run>.patch`,
//    never overwritten) with an `evidence_items` row and the run event `diff_stored`.
// 3. The changed paths are checked: against the plan (`PolicyEngine.checkScope` with the contract's
//    `planned_files`) and against the paths the agent reads as instructions
//    (`isAgentInstructionPath`, the pinned file included: editing it changes the agent). The run
//    event `changes_checked` holds counts and the SHA-256 of the sorted paths, never a path.
// 4. The added lines are scanned for secrets (`secrets.ts`, H04, ADR-M93): the run event
//    `secrets_scanned` holds the result, counts and rule codes, never a match or a path. A failed
//    scan is recorded, never thrown: G5 holds the run on it (QUESTIONS #587).
// 5. The size a person must review is measured (`review-size.ts`, H05, ADR-M95): the run event
//    `diff_measured` holds counts only. A failed measurement is recorded, never thrown: G5 holds
//    the run on it (QUESTIONS #603).
// 6. X13 PR 3a (ADR-M74 §2.5): with `memory.mode` `read_propose` and a run at L2 or higher, the
//    memory part is split out of the staged change first (`memory-split.ts`): stored apart as
//    evidence `memory_diff` (`<intent>/<run>.memory.patch`) with the run event `memory_proposed`
//    (counts and hashes); `changes_checked.memory_files` counts its paths. The secret scan reads
//    the whole change, memory part included, so a secret in a note also holds the run at G5.
// G5 (PR 2) decides from `changes_checked`, `secrets_scanned` and `diff_measured`; the runner
// only records. Any other
// failure throws: the caller fails the run (`agent_changes_unavailable`), so no run reaches G5
// without its checked changes.
import crypto from 'node:crypto';
import path from 'node:path';

import {
  isAgentInstructionPath,
  isInsideRepoPath,
  readsAsInstructions,
  type EvidenceStore,
  type PolicyEngine,
  type ProjectConfig,
  type RunContract,
} from '@sdlc/contracts';
import { parseTenantId, type PlatformDatabase, type RunEventPayload } from '@sdlc/core';

import type { DockerClient } from '../docker/client.js';
import type { RunnerSettings } from '../settings.js';
import { computeRunPatch } from './export.js';
import { splitMemory, type MemorySplit } from './memory-split.js';
import { diffIndex, type Proposal } from './proposal.js';
import { measureReviewSize, type ReviewSize } from './review-size.js';
import { scanDiffForSecrets, type SecretScan } from './secrets.js';
import { scanDependencies, type DependencyScan } from './dependencies.js';

export interface ChangesDeps {
  readonly db: PlatformDatabase;
  readonly docker: DockerClient;
  readonly settings: RunnerSettings;
  /** The evidence store of diffs (key prefix `diffs/`). */
  readonly evidence: EvidenceStore;
  /** The scope check of the project's policy engine. */
  readonly policy: Pick<PolicyEngine, 'checkScope'>;
  /**
   * X13 PR 3a: the project's `memory` configuration at the end of the run. With `read_propose`,
   * the memory part of an L2+ run's change is split out (ADR-M74 §2.5).
   */
  readonly memory?: ProjectConfig['memory'];
}

export interface CheckedChanges {
  readonly changedFiles: number;
  readonly outOfScope: number;
  readonly instructionFiles: number;
  /** O06 (ADR-M106 §2.4): changed paths outside the contract's `repo_path`. */
  readonly outsideFolder: number;
  /** SHA-256 of the RFC 8785 JSON of the sorted changed paths (an array of strings). */
  readonly pathsSha256: string;
  readonly diffSha256: string;
  readonly secrets: SecretScan;
  readonly reviewSize: ReviewSize;
  readonly dependencies: DependencyScan;
  /** X13 PR 3a: the paths split out as the memory part (0 without a split). */
  readonly memoryFiles: number;
}

/** Counts of the changed paths; the paths stay in memory. */
export function checkChangedPaths(
  policy: Pick<PolicyEngine, 'checkScope'>,
  plannedFiles: readonly string[],
  changedFiles: readonly string[],
  /** O06: the project's folder ('' = the whole repository). */
  repoPath = '',
): Omit<CheckedChanges, 'diffSha256' | 'secrets' | 'reviewSize' | 'dependencies' | 'memoryFiles'> {
  const sorted = [...changedFiles].sort();
  const scope = policy.checkScope({ plannedFiles, changedFiles: sorted });
  return {
    changedFiles: sorted.length,
    outOfScope: scope.outOfScope.length,
    // With a folder, also the files the agent reads from it (its own root files and skills).
    instructionFiles: sorted.filter(
      (p) => isAgentInstructionPath(p) || readsAsInstructions(p, repoPath),
    ).length,
    outsideFolder: sorted.filter((p) => !isInsideRepoPath(p, repoPath)).length,
    // For an array of strings, RFC 8785 is exactly JSON.stringify.
    pathsSha256: crypto.createHash('sha256').update(JSON.stringify(sorted), 'utf8').digest('hex'),
  };
}

/** Computes, stores and checks the run's changes (see the header). */
export async function storeChanges(
  deps: ChangesDeps,
  contract: RunContract,
  cloneDir: string,
): Promise<CheckedChanges> {
  const whole = await computeRunPatch(deps, contract, cloneDir);
  const memory = await memoryPart(deps, contract, cloneDir, whole);
  const patch = memory ? await codePart(deps, contract, cloneDir) : whole;
  const checked = checkChangedPaths(
    deps.policy,
    contract.planned_files,
    patch.changedFiles,
    contract.repo_path ?? '',
  );
  // Before anything else uses the clone: the staged index is the run's change.
  const reviewSize = await measureReviewSize({
    cloneDir,
    baseSha: contract.base_sha,
    timeoutMs: deps.settings.git.timeoutMs,
    maxOutputBytes: deps.settings.workspaceMaxBytes,
  });
  const stored = await deps.evidence.put(
    contract.tenant_id,
    `${contract.intent_id}/${contract.run_id}.patch`,
    patch.patch,
    'text/x-diff',
  );
  const storedMemory = memory
    ? await deps.evidence.put(
        contract.tenant_id,
        `${contract.intent_id}/${contract.run_id}.memory.patch`,
        memory.patch,
        'text/x-diff',
      )
    : undefined;
  const secrets = await scanDiffForSecrets({
    settings: deps.settings.secretScan,
    cloneDir,
    baseSha: contract.base_sha,
    gitTimeoutMs: deps.settings.git.timeoutMs,
    // The whole change: a secret in a memory note holds the run too.
    patch: whole.patch,
  });
  const dependencies = await scanDependencies({
    cloneDir,
    baseSha: contract.base_sha,
    changedFiles: patch.changedFiles,
    gitTimeoutMs: deps.settings.git.timeoutMs,
  });
  const scope = deps.db.forTenant(parseTenantId(contract.tenant_id));
  await scope.transaction(async (tx) => {
    await tx.evidenceItems.record({
      intentId: contract.intent_id,
      runId: contract.run_id,
      kind: 'diff',
      storageUri: stored.uri,
      sha256: stored.sha256,
      sizeBytes: stored.sizeBytes,
    });
    await tx.runEvents.append(contract.run_id, 'diff_stored', {
      sha256: stored.sha256,
      size_bytes: stored.sizeBytes,
      changed_files: checked.changedFiles,
    });
    await tx.runEvents.append(contract.run_id, 'changes_checked', {
      changed_files: checked.changedFiles,
      out_of_scope: checked.outOfScope,
      instruction_files: checked.instructionFiles,
      paths_sha256: checked.pathsSha256,
      ...(checked.outsideFolder > 0 ? { outside_folder: checked.outsideFolder } : {}),
      ...(memory ? { memory_files: memory.paths.length } : {}),
    });
    if (memory && storedMemory) {
      await tx.evidenceItems.record({
        intentId: contract.intent_id,
        runId: contract.run_id,
        kind: 'memory_diff',
        storageUri: storedMemory.uri,
        sha256: storedMemory.sha256,
        sizeBytes: storedMemory.sizeBytes,
      });
      await tx.runEvents.append(contract.run_id, 'memory_proposed', {
        files_added: memory.added,
        files_changed: memory.changed,
        files_removed: memory.removed,
        kept_in_change: memory.kept,
        set_sha256: memory.setSha256,
        memory_sha256: storedMemory.sha256,
        paths_sha256: memoryPathsSha256(memory.paths),
      });
    }
    await tx.runEvents.append(contract.run_id, 'secrets_scanned', secretsScannedPayload(secrets));
    await tx.runEvents.append(contract.run_id, 'diff_measured', diffMeasuredPayload(reviewSize));
    await tx.runEvents.append(
      contract.run_id,
      'dependencies_scanned',
      dependenciesScannedPayload(dependencies),
    );
  });
  return {
    ...checked,
    diffSha256: stored.sha256,
    secrets,
    reviewSize,
    dependencies,
    memoryFiles: memory?.paths.length ?? 0,
  };
}

/** SHA-256 of the RFC 8785 JSON of the sorted memory paths (the push checks it again). */
export function memoryPathsSha256(paths: readonly string[]): string {
  const sorted = [...paths].sort();
  return crypto.createHash('sha256').update(JSON.stringify(sorted), 'utf8').digest('hex');
}

/** Splits the memory part out of the staged change when the project lets runs propose memory. */
async function memoryPart(
  deps: ChangesDeps,
  contract: RunContract,
  cloneDir: string,
  whole: Proposal,
): Promise<MemorySplit | null> {
  // L1 runs never get here (they store a proposal); evaluation runs never use this step.
  if (deps.memory?.mode !== 'read_propose' || contract.autonomy_level === 'L1') return null;
  return splitMemory(
    path.join(cloneDir, 'repo'),
    path.join(cloneDir, 'home'),
    contract.base_sha,
    whole.changedFiles,
    deps.memory,
    { timeoutMs: deps.settings.git.timeoutMs, maxPatchBytes: deps.settings.workspaceMaxBytes },
  );
}

/** The diff of the index once the memory part is out: the code part. */
function codePart(deps: ChangesDeps, contract: RunContract, cloneDir: string): Promise<Proposal> {
  return diffIndex(path.join(cloneDir, 'repo'), path.join(cloneDir, 'home'), contract.base_sha, {
    timeoutMs: deps.settings.git.timeoutMs,
    maxPatchBytes: deps.settings.workspaceMaxBytes,
  });
}

/** The payload of the run event `secrets_scanned`: codes and counts only (ADR-M93 §2.3). */
export function secretsScannedPayload(scan: SecretScan): RunEventPayload<'secrets_scanned'> {
  return {
    result: scan.result,
    findings: scan.findings,
    rules: scan.rules,
    ...(scan.ruleIds.length > 0 ? { rule_ids: scan.ruleIds.join(':') } : {}),
    ...(scan.configSha256 !== null ? { config_sha256: scan.configSha256 } : {}),
    ...(scan.scannerVersion !== null ? { scanner_version: scan.scannerVersion } : {}),
    ...(scan.cause !== undefined ? { cause: scan.cause } : {}),
  };
}

/** The payload of the run event `diff_measured`: the result and counts only (ADR-M95 §2.2). */
export function diffMeasuredPayload(size: ReviewSize): RunEventPayload<'diff_measured'> {
  if (size.result === 'failed') {
    return { result: 'failed', ...(size.cause !== undefined ? { cause: size.cause } : {}) };
  }
  return {
    result: 'measured',
    review_files: size.reviewFiles,
    review_lines: size.reviewLines,
    generated_files: size.generatedFiles,
    generated_lines: size.generatedLines,
    binary_files: size.binaryFiles,
  };
}

/** The payload of the run event `dependencies_scanned`: codes and counts only (ADR-M96 §2.3). */
export function dependenciesScannedPayload(
  scan: DependencyScan,
): RunEventPayload<'dependencies_scanned'> {
  return {
    result: scan.result,
    new_dependencies: scan.newDependencies,
    changed_dependencies: scan.changedDependencies,
    license_violations: scan.licenseViolations,
    install_scripts: scan.installScripts,
    typosquatting_warnings: scan.typosquattingWarnings,
    advisory_findings: scan.advisoryFindings,
    ...(scan.cause !== undefined ? { cause: scan.cause } : {}),
  };
}
