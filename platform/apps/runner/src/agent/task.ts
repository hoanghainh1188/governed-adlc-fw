// The task the agent gets (D-08 C05 AC2): the spec linked at G2 and the plan approved at G3, as
// the Run Contract binds them. The plan must be the contract's plan with the same hash and file
// list; the spec is the intent's latest one (a spec changed after G2 sends the intent back to G2
// before any run, FR-02 / B08). AGENTS.md is loaded by the agent from the workspace.
//
// B09 PR 2 (ADR-M40 §2.7, QUESTIONS #169, #210): a plan read from a file (`plans.commit_sha` set)
// stores no text. The runner reads the file at that commit from its own clone (`plan-file.ts`),
// checks the SHA-256 of its bytes against the contract's `plan_sha256`, parses it with the
// submission rules (`readPlanTaskTexts`) and puts the tasks' text in the prompt, cleaned and
// capped. Any failure fails the run closed (`task_unavailable`, run event `plan_unavailable` with
// the cause). The text goes to the agent only: `plan_read` holds counts.
import { createHash } from 'node:crypto';

import {
  EvidenceError,
  type AgentTask,
  type EvidenceStore,
  type PlanTaskTextBlock,
  type RunContract,
} from '@sdlc/contracts';
import {
  PLAN_MAX_BYTES,
  planPath,
  readPlanTaskTexts,
  type Plan,
  type PlanTaskText,
  type TenantScope,
} from '@sdlc/core';

import type { PlanFileReader } from '../workspace/plan-file.js';
import { AgentRunError } from './errors.js';
import { readRunFeedback, type FeedbackAccess } from './feedback.js';
import { capText, cleanText } from './text.js';

/**
 * The cap of a plan's task text in the agent's prompt, in characters (about 4,000 tokens). A plan
 * file is at most 64 KiB, mostly path patterns the prompt already lists; the cap keeps the context
 * short (D-07 §7 item 6) and stays under the adapter's limit. Technical, not a handbook rule.
 */
export const PLAN_TASK_TEXT_MAX_CHARS = 16_000;

/** The cap of one field of one task, so that one field cannot fill the whole block. */
export const PLAN_FIELD_MAX_CHARS = 2_000;

const FIELD_CUT_NOTE = ' [The platform cut this field here.]';
const TEXT_CUT_NOTE = '\n[The platform cut the plan text here.]';

/** Why a plan file cannot be used (run event `plan_unavailable`). */
type PlanUnavailable =
  | 'no_clone'
  | 'commit_missing'
  | 'missing'
  | 'not_a_file'
  | 'too_large'
  | 'git_failed'
  | 'not_utf8'
  | 'hash_mismatch'
  | 'invalid'
  | 'files_mismatch';

class PlanUnavailableError extends Error {
  constructor(readonly reason: PlanUnavailable) {
    super(reason);
  }
}

/** The tasks' text as plain lines: `Task T1`, `summary: …`, `definition of done:` and `- …`. */
export function renderPlanTasks(tasks: readonly PlanTaskText[]): {
  readonly text: string;
  readonly truncated: boolean;
} {
  let truncated = false;
  const blocks = tasks.map((task) => {
    const lines = [`Task ${task.id}`];
    for (const field of task.fields) {
      const label = field.name.replaceAll('_', ' ');
      const values = field.values.map((value) => cleanText(value));
      const rendered = field.list
        ? [`${label}:`, ...values.map((value) => `- ${value}`)].join('\n')
        : `${label}: ${values[0] ?? ''}`;
      const capped = capText(rendered, PLAN_FIELD_MAX_CHARS, FIELD_CUT_NOTE);
      truncated ||= capped.truncated;
      lines.push(capped.text);
    }
    return lines.join('\n');
  });
  const capped = capText(blocks.join('\n\n'), PLAN_TASK_TEXT_MAX_CHARS, TEXT_CUT_NOTE);
  return { text: capped.text, truncated: truncated || capped.truncated };
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const left = [...new Set(a)].sort();
  const right = [...new Set(b)].sort();
  return left.length === right.length && left.every((item, i) => item === right[i]);
}

function verifyAndRenderPlanBytes(
  bytes: Buffer,
  intentCode: string,
  contract: RunContract,
): { block: PlanTaskTextBlock; skippedFields: number } {
  if (createHash('sha256').update(bytes).digest('hex') !== contract.plan_sha256) {
    throw new PlanUnavailableError('hash_mismatch');
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new PlanUnavailableError('not_utf8');
  }
  const parsed = readPlanTaskTexts(text, intentCode);
  if (!parsed.ok) throw new PlanUnavailableError('invalid');
  if (!sameSet(parsed.plan.plannedFiles, contract.planned_files)) {
    throw new PlanUnavailableError('files_mismatch');
  }
  const rendered = renderPlanTasks(parsed.tasks);
  return {
    block: { text: rendered.text, tasks: parsed.tasks.length, truncated: rendered.truncated },
    skippedFields: parsed.skippedFields,
  };
}

async function readPlanTaskText(
  intentCode: string,
  plan: Plan,
  contract: RunContract,
  reader: PlanFileReader | undefined,
  planStore: Pick<EvidenceStore, 'get'> | undefined,
): Promise<{ block: PlanTaskTextBlock; skippedFields: number }> {
  if (plan.plan_source === 'uploaded' && plan.storage_uri !== null) {
    if (!planStore) throw new PlanUnavailableError('missing');
    let bytes: Buffer;
    try {
      bytes = await planStore.get(plan.storage_uri, { maxBytes: PLAN_MAX_BYTES });
    } catch (error) {
      if (error instanceof EvidenceError && error.code === 'too_large') {
        throw new PlanUnavailableError('too_large');
      }
      throw new PlanUnavailableError('missing');
    }
    return verifyAndRenderPlanBytes(bytes, intentCode, contract);
  }
  if (!reader) throw new PlanUnavailableError('no_clone');
  const read = await reader(plan.commit_sha!, planPath(intentCode));
  if (read.kind === 'unreadable') throw new PlanUnavailableError(read.cause);
  return verifyAndRenderPlanBytes(read.bytes, intentCode, contract);
}

/**
 * The task text of a plan read from a repo file or uploaded to SeaweedFS, or undefined for a
 * legacy plan stored without one (before B09: its `summary` is used). Records `plan_read`, or
 * `plan_unavailable` and throws.
 */
async function loadPlanTaskText(
  scope: TenantScope,
  contract: RunContract,
  plan: Plan,
  reader: PlanFileReader | undefined,
  planStore: Pick<EvidenceStore, 'get'> | undefined,
): Promise<PlanTaskTextBlock | undefined> {
  const isUploaded = plan.plan_source === 'uploaded' && plan.storage_uri !== null;
  if (!isUploaded && plan.commit_sha === null) return undefined;
  const intent = await scope.intents.getById(contract.intent_id);
  if (!intent) throw new AgentRunError('task_unavailable');
  try {
    const { block, skippedFields } = await readPlanTaskText(
      intent.code,
      plan,
      contract,
      reader,
      planStore,
    );
    await scope.runEvents.append(contract.run_id, 'plan_read', {
      tasks: block.tasks,
      chars: block.text.length,
      truncated: block.truncated ? 'yes' : 'no',
      skipped_fields: skippedFields,
    });
    return block;
  } catch (error) {
    if (!(error instanceof PlanUnavailableError)) throw error;
    await scope.runEvents.append(contract.run_id, 'plan_unavailable', { reason: error.reason });
    throw new AgentRunError('task_unavailable');
  }
}

/**
 * C08 PR 2 (QUESTIONS #158): the intent's last G6 decision is a `fail ci_failed`, so this run is a
 * retry after CI failed on the pushed commit.
 */
async function followsCiFailure(scope: TenantScope, intentId: string): Promise<boolean> {
  const last = (await scope.gateDecisions.listForIntent(intentId, 'G6')).at(-1);
  return last?.decision === 'fail' && last.reason_code === 'ci_failed';
}

export async function loadAgentTask(
  scope: TenantScope,
  contract: RunContract,
  feedback: FeedbackAccess = {},
  planFile?: PlanFileReader,
  planStore?: Pick<EvidenceStore, 'get'>,
): Promise<AgentTask> {
  // E01 PR 2: the feedback of a request for changes at G7, read before the agent starts. Throws
  // `feedback_unavailable` itself (fail closed).
  const reviewFeedback = await readRunFeedback(scope, contract, feedback);
  try {
    const plan = (await scope.plans.list(contract.intent_id)).find(
      (p) => p.id === contract.plan_id,
    );
    const spec = await scope.specRefs.latest(contract.intent_id);
    if (!plan || !spec || plan.plan_sha256 !== contract.plan_sha256) {
      throw new AgentRunError('task_unavailable');
    }
    const planned = plan.planned_files;
    if (
      planned.length !== contract.planned_files.length ||
      planned.some((file, i) => file !== contract.planned_files[i])
    ) {
      throw new AgentRunError('task_unavailable');
    }
    const taskText = await loadPlanTaskText(scope, contract, plan, planFile, planStore);
    return {
      spec: {
        path: spec.path,
        commitSha: spec.commit_sha,
        contentSha256: spec.content_sha256,
      },
      plan: {
        summary: plan.summary,
        plannedFiles: [...planned],
        ...(taskText ? { taskText } : {}),
      },
      ...((await followsCiFailure(scope, contract.intent_id)) ? { ciFailed: true } : {}),
      ...(reviewFeedback ? { reviewFeedback } : {}),
    };
  } catch (error) {
    if (error instanceof AgentRunError) throw error;
    throw new AgentRunError('task_unavailable');
  }
}
