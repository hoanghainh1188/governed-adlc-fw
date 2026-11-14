// The memory pull request of an intent (task X13 PR 3b, design/ADR-M74 §2.3–§2.5, 0.5; QUESTIONS
// #716). The worker's memory loop calls `stepMemoryWork` for each item of
// `SystemScope.listMemoryWork`; every step reads the Git host outside a transaction, then records
// the move in one transaction with a compare-and-set on the proposal's state.
//
// 1. A run that pushed its memory branch (`memory_branch_pushed`, PR 3a) gets a proposal row
//    (`pushed`).
// 2. `pushed`:
//    - the intent's code pull request was merged at G7 (`pr_merged`) by this run → the memory pull
//      request is found or opened (`MEMORY <INT-…> run <attempt>`, codes only), its head checked
//      against the pushed commit → `opened`, audit `memory.pr_opened`. A moved branch → `failed`;
//    - it was merged by another run of the intent, or the intent closed without a merge → the
//      memory branch is deleted when it still holds the pushed commit → `deleted`, audit
//      `memory.branch_deleted`;
//    - otherwise it waits (the intent is still open).
// 3. `opened`: the pull request is read again. Open → seen. Closed without a merge → `closed`.
//    Merged → the merger must be a person: active, linked by the numeric account ID (R037), with
//    the Person A or Person B role on the project, and not a producer (the G7 producers of the
//    intent plus the memory pull request's commit authors; FR-11). Then the memory set at the
//    merge commit becomes the next version (`source memory_pr`), or nothing new when it is the
//    latest version already → `recorded`, audit `memory.approved`. Otherwise → `refused`, audit
//    `memory.approval_refused` (cause `bot`, `producer`, `not_linked`, `not_allowed`), and runs
//    read no new set until a person approves it with `adlc memory approve`.
// The memory pull request is never part of a gate: nothing here waits, pauses or escalates. A
// Git host error is thrown; the loop logs it and tries again on its next pass.
import {
  GitHostError,
  MEMORY_BRANCH,
  type GitHostAdapter,
  type PullRequestInfo,
} from '@sdlc/contracts';
import { t } from '@sdlc/messages';

import { userOfAccount } from '../commands/git-event-handler.js';
import type { MemoryWork } from '../db/system-scope.js';
import type { Intent, MemoryProposal, Project, Run } from '../db/schema.js';
import type { TenantScope } from '../db/tenant-scope.js';
import { g7Producers } from '../workflow/g7-facts.js';
import { projectRepoRef } from '../workflow/g4-proposal.js';
import { MEMORY_APPROVE_ROLES } from './service.js';
import { readMemorySet } from './set.js';

/** The Git host calls of the memory loop. */
export interface MemoryProposalDeps {
  readonly gitHost: Pick<
    GitHostAdapter,
    | 'findOpenPullRequest'
    | 'openPullRequest'
    | 'getPullRequest'
    | 'getCommitAuthors'
    | 'listFolder'
    | 'deleteBranch'
  >;
  now(): Date;
}

/** What one step did, for the loop's log (codes only). */
export type MemoryStepOutcome =
  | 'recorded_pushed'
  | 'waiting'
  | 'opened'
  | 'deleted'
  | 'failed'
  | 'seen'
  | 'closed'
  | 'recorded'
  | 'refused'
  | 'skipped';

export type MemoryRefusal = 'bot' | 'producer' | 'not_linked' | 'not_allowed';

const CLOSED_INTENT: readonly string[] = ['done', 'rejected', 'cancelled', 'blocked'];

/** The memory branch of a run (`agent/INT-…-memory-<attempt>`, PR 3a). */
export function memoryBranchOf(run: Pick<Run, 'branch' | 'attempt'>): string {
  return `${run.branch}-memory-${String(run.attempt)}`;
}

/** One item of the loop's work (see the header). */
export async function stepMemoryWork(
  scope: TenantScope,
  deps: MemoryProposalDeps,
  work: MemoryWork,
): Promise<MemoryStepOutcome> {
  if (work.kind === 'run') return recordPushed(scope, work.runId);
  const proposal = await scope.memoryProposals.get(work.proposalId);
  if (proposal?.state === 'pushed') return stepPushed(scope, deps, proposal);
  if (proposal?.state === 'opened') return stepOpened(scope, deps, proposal);
  return 'skipped';
}

async function recordPushed(scope: TenantScope, runId: string): Promise<MemoryStepOutcome> {
  const run = await scope.runs.getById(runId);
  const pushed = (await scope.runEvents.list(runId)).find(
    (e) => e.event_type === 'memory_branch_pushed',
  );
  const intent = run ? await scope.intents.getById(run.intent_id) : undefined;
  if (!run || !pushed || !intent) return 'skipped';
  await scope.memoryProposals.recordPushed({
    project_id: intent.project_id,
    intent_id: intent.id,
    run_id: run.id,
    head_sha: String(pushed.payload.head_sha),
  });
  return 'recorded_pushed';
}

interface Context {
  readonly run: Run;
  readonly intent: Intent;
  readonly project: Project;
}

async function contextOf(scope: TenantScope, proposal: MemoryProposal): Promise<Context> {
  const run = await scope.runs.getById(proposal.run_id);
  const intent = await scope.intents.getById(proposal.intent_id);
  const project = await scope.projects.getById(proposal.project_id);
  if (!run || !intent || !project) throw new GitHostError('invalid_input', { field: 'proposal' });
  return { run, intent, project };
}

/** The run whose code pull request was merged at G7, or null. */
async function mergedRunOf(scope: TenantScope, intentId: string): Promise<string | null> {
  for (const run of await scope.runs.listForIntent(intentId)) {
    const events = await scope.runEvents.list(run.id);
    if (events.some((e) => e.event_type === 'pr_merged')) return run.id;
  }
  return null;
}

function repoOf(project: Project) {
  const ref = projectRepoRef(project);
  if (!ref) throw new GitHostError('invalid_input', { field: 'repo' });
  return ref;
}

async function stepPushed(
  scope: TenantScope,
  deps: MemoryProposalDeps,
  proposal: MemoryProposal,
): Promise<MemoryStepOutcome> {
  const { run, intent, project } = await contextOf(scope, proposal);
  const merged = await mergedRunOf(scope, intent.id);
  if (merged === proposal.run_id)
    return openPullRequest(scope, deps, proposal, { run, intent, project });
  if (merged === null && !CLOSED_INTENT.includes(intent.status)) {
    await scope.memoryProposals.move(proposal.id, 'pushed', 'pushed', deps.now());
    return 'waiting';
  }
  // Another run's code was merged, or the intent closed without a merge.
  const branch = memoryBranchOf(run);
  if (!MEMORY_BRANCH.test(branch)) throw new GitHostError('invalid_input', { field: 'branch' });
  const result = await deps.gitHost.deleteBranch(repoOf(project), branch, proposal.head_sha);
  return scope.transaction(async (tx) => {
    const moved = await tx.memoryProposals.move(proposal.id, 'pushed', 'deleted', deps.now(), {
      cause: result === 'deleted' ? (merged === null ? 'intent_closed' : 'not_merged') : result,
    });
    if (!moved) return 'skipped';
    await tx.audit.append({
      action: 'memory.branch_deleted',
      actorType: 'system',
      actorId: null,
      entityId: intent.id,
      payload: { run_id: run.id, result },
    });
    return 'deleted';
  });
}

async function openPullRequest(
  scope: TenantScope,
  deps: MemoryProposalDeps,
  proposal: MemoryProposal,
  { run, intent, project }: Context,
): Promise<MemoryStepOutcome> {
  const ref = repoOf(project);
  const head = memoryBranchOf(run);
  if (!MEMORY_BRANCH.test(head)) throw new GitHostError('invalid_input', { field: 'branch' });
  const pr =
    (await deps.gitHost.findOpenPullRequest(ref, head, project.default_branch)) ??
    (await deps.gitHost.openPullRequest(ref, {
      head,
      base: project.default_branch,
      title: t('memory.pr.title', { code: intent.code, attempt: run.attempt }),
      body: t('memory.pr.body', { code: intent.code, run_id: run.id, attempt: run.attempt }),
    }));
  return scope.transaction(async (tx) => {
    if (pr.headSha !== proposal.head_sha) {
      // Someone else changed the memory branch: never offered for approval.
      const moved = await tx.memoryProposals.move(proposal.id, 'pushed', 'failed', deps.now(), {
        cause: 'branch_moved',
      });
      return moved ? 'failed' : 'skipped';
    }
    const moved = await tx.memoryProposals.move(proposal.id, 'pushed', 'opened', deps.now(), {
      prNumber: pr.number,
    });
    if (!moved) return 'skipped';
    await tx.audit.append({
      action: 'memory.pr_opened',
      actorType: 'system',
      actorId: null,
      entityId: intent.id,
      payload: { run_id: run.id, pr_number: pr.number },
    });
    return 'opened';
  });
}

async function stepOpened(
  scope: TenantScope,
  deps: MemoryProposalDeps,
  proposal: MemoryProposal,
): Promise<MemoryStepOutcome> {
  const context = await contextOf(scope, proposal);
  const ref = repoOf(context.project);
  const prNumber = proposal.pr_number;
  if (prNumber === null) return 'skipped';
  const pr = await deps.gitHost.getPullRequest(ref, prNumber);
  if (pr.state === 'open') {
    await scope.memoryProposals.move(proposal.id, 'opened', 'opened', deps.now());
    return 'seen';
  }
  if (!pr.merged || pr.mergeCommitSha === null) {
    return closeAs(scope, deps, proposal, context, 'closed', { cause: 'not_merged' });
  }
  const verdict = await judgeMerger(scope, deps, context, pr);
  if (verdict !== 'person') return refuse(scope, deps, proposal, context, verdict);
  const set = await readMemorySet(deps.gitHost, ref, pr.mergeCommitSha);
  return record(scope, deps, proposal, context, pr, set.setSha256);
}

/** Who merged the memory pull request (§2.4): a person who may approve, or why not. */
async function judgeMerger(
  scope: TenantScope,
  deps: MemoryProposalDeps,
  { intent, project }: Context,
  pr: PullRequestInfo,
): Promise<MemoryRefusal | 'person'> {
  const by = pr.mergedBy;
  if (by === null || by.type === 'bot') return by === null ? 'not_linked' : 'bot';
  const provider = project.git_provider;
  const user = await userOfAccount(scope, provider, by.id);
  if (user === undefined) return 'not_linked';
  const authors = await deps.gitHost.getCommitAuthors(repoOf(project), pr.number);
  const authorUsers: string[] = [];
  for (const account of authors.accounts) {
    if (account.type !== 'user') continue;
    const id = await userOfAccount(scope, provider, account.id);
    if (id !== undefined) authorUsers.push(id);
  }
  const producers = await g7Producers(scope, intent, authorUsers);
  if (producers.includes(user)) return 'producer';
  const roles = (await scope.roleBindings.listForUser(user))
    .filter((binding) => binding.project_id === project.id)
    .map((binding) => binding.role);
  return roles.some((role) => MEMORY_APPROVE_ROLES.includes(role)) ? 'person' : 'not_allowed';
}

async function closeAs(
  scope: TenantScope,
  deps: MemoryProposalDeps,
  proposal: MemoryProposal,
  { intent, run }: Context,
  to: 'closed' | 'refused',
  fields: { readonly cause: string },
): Promise<MemoryStepOutcome> {
  return scope.transaction(async (tx) => {
    const moved = await tx.memoryProposals.move(proposal.id, 'opened', to, deps.now(), fields);
    if (!moved) return 'skipped';
    if (to === 'closed') {
      await tx.audit.append({
        action: 'memory.pr_closed',
        actorType: 'system',
        actorId: null,
        entityId: intent.id,
        payload: { run_id: run.id, pr_number: proposal.pr_number! },
      });
    }
    return to;
  });
}

async function refuse(
  scope: TenantScope,
  deps: MemoryProposalDeps,
  proposal: MemoryProposal,
  context: Context,
  cause: MemoryRefusal,
): Promise<MemoryStepOutcome> {
  return scope.transaction(async (tx) => {
    const moved = await tx.memoryProposals.move(proposal.id, 'opened', 'refused', deps.now(), {
      cause,
    });
    if (!moved) return 'skipped';
    await tx.audit.append({
      action: 'memory.approval_refused',
      actorType: 'system',
      actorId: null,
      entityId: context.project.id,
      payload: { cause, source: 'memory_pr' },
    });
    return 'refused';
  });
}

async function record(
  scope: TenantScope,
  deps: MemoryProposalDeps,
  proposal: MemoryProposal,
  { intent, project, run }: Context,
  pr: PullRequestInfo,
  setSha256: string,
): Promise<MemoryStepOutcome> {
  const merger = await userOfAccount(scope, project.git_provider, pr.mergedBy!.id);
  return scope.transaction(async (tx) => {
    const latest = await tx.memoryVersions.latest(project.id);
    if (latest && latest.revoked_at === null && latest.set_sha256 === setSha256) {
      // The same set as the latest version: nothing new to approve.
      const moved = await tx.memoryProposals.move(proposal.id, 'opened', 'recorded', deps.now(), {
        cause: 'unchanged',
      });
      return moved ? 'recorded' : 'skipped';
    }
    const version = await tx.memoryVersions.record({
      project_id: project.id,
      version: (latest?.version ?? 0) + 1,
      set_sha256: setSha256,
      commit_sha: pr.mergeCommitSha!,
      source: 'memory_pr',
      approved_by: merger!,
      pr_number: pr.number,
      intent_id: intent.id,
      run_id: run.id,
    });
    const moved = await tx.memoryProposals.move(proposal.id, 'opened', 'recorded', deps.now(), {
      version: version.version,
    });
    // Another worker moved it first: roll the version back.
    if (!moved) throw new Error('memory proposal moved meanwhile');
    await tx.audit.append({
      action: 'memory.approved',
      actorType: 'human',
      actorId: merger!,
      entityId: project.id,
      payload: { version: version.version, set_sha256: setSha256, source: 'memory_pr' },
    });
    return 'recorded';
  });
}
