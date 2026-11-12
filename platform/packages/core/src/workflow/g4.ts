// Gate G4, the execution boundary (task C06, D-08 C06 AC1–AC3, D-02 FR-03, FR-19, FR-36,
// D-03 sections 6 and 6.1, handbook Ch.13 §13.5 Step 1 and §13.8, design/ADR-M33).
//
// `evaluateG4` runs the checks in a fixed order, under the intent lock:
//   1. Critical risk, or an effective maximum autonomy of L0 → block: the agent never runs (T10).
//      Effective = the stricter of the stored value and the current configuration's (QUESTIONS #22).
//   2. The last HOTL block window is closed (ADR-M30 §2.4b); otherwise wait until it closes.
//   3. The intent is not frozen for `run_start` (ADR-M28 §2.4); otherwise wait.
//   4. The spec and plan are still the versions G2 and G3 passed (handbook Ch.13: approved "for
//      these exact versions"). B08 and B09 add the send-back; G4 only refuses.
//   5. The project AI record still allows the data class (FR-19 at G4, ADR-M32 §2.6).
//   6. The configured agent may run (FR-36, `checkAgentForRun`): registered, active, approved for
//      the sandbox, autonomy within its maximum, pinned model among the allowed models, and the
//      instructions file at the base commit equals the registered version, and no other agent
//      instruction file exists at the base commit (C07, QUESTIONS #126, `instructions_unpinned`;
//      a commit the Git host lists only in part is refused too: `tree_truncated`).
//   7. The intent budget and the tenant's budget of this UTC month are not used up (the Cost
//      Controller still caps the run's key when it starts).
// Then it returns the run proposal (g4-proposal.ts), whose hash binds the G4 decision.
//
// `stepG4` (the workflow step at G4) acts on it with the oversight mode of the matrix:
// - POLICY (Low, Medium): a system `pass` bound to the proposal; a failed check records a system
//   `fail` once per cause, and the intent waits at G4: the next wake checks again (#110).
// - HITL (High): the checks first; then Person A approves the proposal (`/approve G4`). A changed
//   proposal (for example a new commit on the default branch) voids the approval (FR-17). The gate
//   deadline and its overdue escalation work as at G1–G3 (ADR-M30 §2.9).
// - Critical (HITL in the matrix, QUESTIONS #5): blocked by check 1 before any approval.
// A passed or approved G4 waits for the run (`run_pending`); session 2 starts it.
//
// Rules that are design, not configuration: the check order, L0 never runs, only active
// registered agents run, nothing above L2 in the MVP, the pinned model and the instructions hash
// must match, no run while a block window is open or the intent is frozen. Tunable values come
// from the project configuration: the G4 matrix row, `autonomy.max_by_risk`, `model_routing`,
// `run.agent_key`, `run.default_max_*`, `budget.default_run_usd` (or the intent's own
// `run_budget_usd` after a G5 budget increase, C07), the approval expiry, the block
// window, the gate deadline and `agents.recertification_months`.
import { createHash } from 'node:crypto';

import { canonicalJson, MVP_MAX_AUTONOMY } from '@sdlc/config';
import {
  AUTONOMY_LEVELS,
  isRegisterToolCode,
  type AutonomyLevel,
  type OversightResolution,
  type GateCode,
  type GateReasonCode,
  type IntentStepResult,
  type PolicyEngine,
  type ProjectRole,
  type RunContractAutonomy,
  type ValidatedProjectConfig,
} from '@sdlc/contracts';

import { aiRecordRefusal } from '../ai-record/rules.js';
import { loadAiRecordFacts } from '../ai-record/service.js';
import { checkAgentForRun, type CheckedAgent } from '../agents/check.js';
import { AgentRegisterError } from '../agents/errors.js';
import { checkToolsForRun, type CheckedTools } from '../tools/check.js';
import { ToolRegisterError } from '../tools/errors.js';
import { intentInputSha256 } from '../commands/gate-input.js';
import { fromMicros, startOfUtcMonth, toMicros } from '../cost/money.js';
import type { GateDecisionRow, Intent } from '../db/schema.js';
import type { TenantScope } from '../db/tenant-scope.js';
import { EscalationError } from '../escalation/errors.js';
import { assertActionAllowed } from '../escalation/freeze.js';
import type { Registry } from '../registry/registry.js';
import { gateHistory, type GateHistory } from './gate-history.js';
import {
  recordRunProposal,
  runProposalSha256,
  type G4Facts,
  type RunProposal,
} from './g4-proposal.js';
import { hotlBlockWindowOpenUntil } from './hotl.js';
import { checkGateOverdue, closeGateOverdue, gateClockStart } from './overdue.js';
import { waitedSeconds } from './waited.js';
import { gateOversight } from './oversight.js';

/** Who hears about a failed G4 check: Person A operates the runs (handbook Ch.13 §13.3). */
export const G4_OPERATOR_ROLES: readonly ProjectRole[] = ['person_a'];

export interface G4Policy {
  readonly config: ValidatedProjectConfig;
  readonly policy: PolicyEngine;
}

export type G4Evaluation =
  /** Critical risk or no autonomy (L0): the agent never runs (FR-03, T10). */
  | { readonly kind: 'block'; readonly autonomy: AutonomyLevel }
  /** Not yet: a block window is open (with the delay until it closes), or the intent is frozen. */
  | {
      readonly kind: 'wait';
      readonly reason: 'hotl_block_window' | 'frozen';
      readonly wakeInMs?: number;
    }
  /** A check failed: the gate decision's reason code and the exact cause for the audit log. */
  | {
      readonly kind: 'fail';
      readonly reason: GateReasonCode;
      readonly check: string;
      /**
       * What the failure is about, when more than its cause: the new spec or plan hash, the
       * instructions file hash, the agent version. A new subject is a new failure to record.
       * Never the branch head: an unrelated commit must not record the same failure again.
       */
      readonly subject: string | null;
    }
  /** Every check passed: the proposal to bind the G4 decision to. */
  | {
      readonly kind: 'ready';
      readonly proposal: RunProposal;
      readonly inputSha256: string;
      readonly agent: CheckedAgent;
      /** X04: the register tools' grants and the overdue recertifications (a warning). */
      readonly tools: CheckedTools;
    };

const rank = (level: AutonomyLevel): number => AUTONOMY_LEVELS.indexOf(level);

/**
 * The run's autonomy (QUESTIONS #22): the stricter of the intent's stored maximum and the one the
 * current configuration gives, never above the MVP cap (L2).
 */
export function effectiveAutonomy(
  intent: Pick<Intent, 'max_autonomy' | 'risk_tier' | 'data_class'>,
  policy: PolicyEngine,
): AutonomyLevel {
  const current = policy.maxAutonomy({ riskTier: intent.risk_tier, dataClass: intent.data_class });
  return [intent.max_autonomy, current, MVP_MAX_AUTONOMY].reduce((a, b) =>
    rank(a) <= rank(b) ? a : b,
  );
}

/** The input of the last approval or pass at `gate` that no `void` cancelled, or null. */
export async function passedInput(scope: TenantScope, intentId: string, gate: GateCode) {
  const decisions = await scope.gateDecisions.listForIntent(intentId, gate);
  const voided = new Set(decisions.map((d) => d.voids_decision_id).filter((id) => id !== null));
  const last = decisions
    .filter((d) => d.decision === 'pass' || (d.decision === 'approve' && !voided.has(d.id)))
    .at(-1);
  return last?.input_sha256 ?? null;
}

/** An agent register refusal → the G4 reason code (QUESTIONS #110). */
function agentReason(code: AgentRegisterError['code']): GateReasonCode {
  if (code === 'instructions_mismatch') return 'instructions_mismatch';
  if (code === 'autonomy_above_agent') return 'autonomy_not_allowed';
  return 'agent_not_runnable';
}

/** The G4 checks, in order (see the header). Records nothing. */
export async function evaluateG4(
  tx: TenantScope,
  registry: Registry,
  policy: G4Policy,
  intent: Intent,
  facts: G4Facts,
): Promise<G4Evaluation> {
  const now = registry.now();
  const autonomy = effectiveAutonomy(intent, policy.policy);
  if (intent.risk_tier === 'critical' || autonomy === 'L0') return { kind: 'block', autonomy };

  const until = await hotlBlockWindowOpenUntil(tx, registry, intent.id);
  if (until !== null) {
    return {
      kind: 'wait',
      reason: 'hotl_block_window',
      wakeInMs: Math.max(0, until.getTime() - now.getTime()),
    };
  }
  try {
    await assertActionAllowed(tx, intent.id, 'run_start', now);
  } catch (error) {
    if (error instanceof EscalationError && error.code === 'frozen') {
      return { kind: 'wait', reason: 'frozen' };
    }
    throw error;
  }

  const spec = await tx.specRefs.latest(intent.id);
  if (!spec || (await passedInput(tx, intent.id, 'G2')) !== spec.content_sha256) {
    const subject = spec?.content_sha256 ?? null;
    return { kind: 'fail', reason: 'input_mismatch', check: 'spec_changed', subject };
  }
  const plan = await tx.plans.latest(intent.id);
  if (!plan || (await passedInput(tx, intent.id, 'G3')) !== plan.plan_sha256) {
    const subject = plan?.plan_sha256 ?? null;
    return { kind: 'fail', reason: 'input_mismatch', check: 'plan_changed', subject };
  }

  const record = aiRecordRefusal(await loadAiRecordFacts(tx, intent.project_id), intent.data_class);
  if (record !== null) return { kind: 'fail', reason: record, check: record, subject: null };

  const { config } = policy;
  if (config.run.agent_key === null) {
    return {
      kind: 'fail',
      reason: 'agent_not_runnable',
      check: 'agent_not_configured',
      subject: null,
    };
  }
  const registered = await tx.agents.getByKey(config.run.agent_key);
  if (!registered || facts.instructions?.agentId !== registered.id) {
    return {
      kind: 'fail',
      reason: 'agent_not_runnable',
      check: 'agent_not_found',
      subject: config.run.agent_key,
    };
  }
  if (facts.instructions.sha256 === null || facts.instructions.root?.sha256 === null) {
    return {
      kind: 'fail',
      reason: 'instructions_mismatch',
      check: 'instructions_missing',
      subject: `${registered.id}@${registered.version}`,
    };
  }
  let agent: CheckedAgent;
  try {
    agent = await checkAgentForRun(tx, {
      agentId: registered.id,
      projectId: intent.project_id,
      autonomyLevel: autonomy,
      allowedModels: facts.allowedModels,
      instructionsSha256: facts.instructions.sha256,
      ...(facts.instructions.root === null
        ? {}
        : { rootInstructionsSha256: facts.instructions.root.sha256 }),
      now,
    });
  } catch (error) {
    if (error instanceof AgentRegisterError) {
      const subject =
        error.code === 'instructions_mismatch'
          ? facts.instructions.sha256
          : `${registered.id}@${registered.version}`;
      return { kind: 'fail', reason: agentReason(error.code), check: error.code, subject };
    }
    throw error;
  }

  // X04 (ADR-M69 §2.3): every register tool the plan asks for must be given to the run, or G4
  // fails (`tool_not_runnable`) with the exact cause; the subject is the tool's key. A plan stored
  // without a file lists no register tool.
  let tools: CheckedTools;
  try {
    tools = await checkToolsForRun(tx, {
      planTools: plan.allowed_tools ?? [],
      agentTools: agent.agent.tools,
      adapter: agent.agent.adapter,
      dataClass: intent.data_class,
      allowedModels: facts.allowedModels,
      maxCallsPerRun: config.tools.max_calls_per_run,
      recertificationMonths: config.tools.recertification_months,
      now,
    });
  } catch (error) {
    if (error instanceof ToolRegisterError) {
      return {
        kind: 'fail',
        reason: 'tool_not_runnable',
        check: error.code,
        subject: error.toolKey ?? null,
      };
    }
    throw error;
  }

  // QUESTIONS #126 (C07): every other file the agent would read as instructions is unpinned. The
  // exact cause goes to the audit event; the subject is the hash of the paths, never the paths.
  const unpinned = facts.instructions.unpinned;
  if (unpinned.kind === 'found') {
    return {
      kind: 'fail',
      reason: 'instructions_unpinned',
      check: 'instructions_unpinned',
      subject: unpinned.pathsSha256,
    };
  }
  if (unpinned.kind === 'tree_truncated') {
    return {
      kind: 'fail',
      reason: 'instructions_unpinned',
      check: 'tree_truncated',
      subject: null,
    };
  }

  const spent = toMicros(await tx.costRecords.totalForIntent(intent.id));
  if (toMicros(intent.budget_usd) - spent <= 0n) {
    return {
      kind: 'fail',
      reason: 'budget_exceeded',
      check: 'intent_budget_exhausted',
      subject: null,
    };
  }
  if (facts.tenantMonthlyBudgetUsd !== null) {
    const month = startOfUtcMonth(now);
    const monthSpent = toMicros(await tx.costRecords.totalSince(month));
    if (toMicros(facts.tenantMonthlyBudgetUsd) - monthSpent <= 0n) {
      return {
        kind: 'fail',
        reason: 'budget_exceeded',
        check: 'tenant_budget_exhausted',
        // One failure per month: a new month is a new budget.
        subject: month.toISOString().slice(0, 7),
      };
    }
  }

  // B09 (ADR-M40 §2.5, QUESTIONS #34, #108): the run's tools are the agent's registered tools
  // that the plan's tasks also list. A plan stored without a file (before B09) lists none: the
  // agent's registered tools, without its register tools (X04: those only when a plan asks).
  const agentTools = [...new Set(agent.agent.tools)].sort();
  const allowedTools =
    plan.allowed_tools === null
      ? agentTools.filter((tool) => !isRegisterToolCode(tool))
      : agentTools.filter((tool) => plan.allowed_tools!.includes(tool));
  if (allowedTools.length === 0) {
    return {
      kind: 'fail',
      reason: 'agent_not_runnable',
      check: 'plan_tools_not_registered',
      subject: `${agent.agent.id}@${agent.agent.version}`,
    };
  }

  const proposal: RunProposal = {
    intentId: intent.id,
    planId: plan.id,
    planSha256: plan.plan_sha256,
    specSha256: spec.content_sha256,
    agentId: agent.agent.id,
    agentKey: agent.agent.key,
    agentVersion: agent.agent.version,
    instructionsSha256: agent.agent.instructionsSha256,
    rootInstructionsSha256: agent.agent.rootInstructionsSha256 ?? null,
    repoPath: facts.repoPath,
    modelRef: agent.agent.modelRef,
    // effectiveAutonomy is at most L2 and not L0 here.
    autonomyLevel: autonomy as RunContractAutonomy,
    allowedTools,
    toolGrants: tools.grants,
    allowedModels: facts.allowedModels,
    // C07 (QUESTIONS #133): after a G5 `resume` with a budget increase, the intent's run budget.
    maxBudgetUsd:
      intent.run_budget_usd === null
        ? usd(config.budget.default_run_usd)
        : fromMicros(toMicros(intent.run_budget_usd)),
    maxIterations: config.run.default_max_iterations,
    maxDurationMin: config.run.default_max_duration_minutes,
    baseSha: facts.baseSha,
    dataClass: intent.data_class,
  };
  return { kind: 'ready', proposal, inputSha256: runProposalSha256(proposal), agent, tools };
}

/** A configuration amount (a number of dollars) as a decimal string with at most 6 decimals. */
function usd(amount: number): string {
  return fromMicros(BigInt(Math.round(amount * 1_000_000)));
}

function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

/** What the step returns (the step builds the `IntentStepResult`). */
export type G4StepOutcome =
  | { readonly kind: 'blocked'; readonly decisionId: string }
  /** Person A rejected the run proposal (HITL): the intent ends as `rejected`. */
  | { readonly kind: 'rejected'; readonly decisionId: string }
  /** G4 is passed or approved for this proposal: the run may start (session 2 moves the intent). */
  | { readonly kind: 'decided'; readonly proposal: RunProposal }
  | { readonly kind: 'waiting'; readonly result: IntentStepResult };

/**
 * The workflow step at G4. Returns `blocked` (the caller moves the intent to `blocked`) or the
 * result to wait with. Must run under the intent lock.
 */
export async function stepG4(
  tx: TenantScope,
  registry: Registry,
  policy: G4Policy,
  intent: Intent,
  facts: G4Facts,
): Promise<G4StepOutcome> {
  // A rejection ends the intent, as at G1–G3; ending it is never frozen (ADR-M28 §2.7).
  const { rejection } = await gateHistory(tx, intent.id, 'G4');
  if (rejection !== null) {
    await closeGateOverdue(tx, registry, intent.id, 'G4');
    return { kind: 'rejected', decisionId: rejection };
  }
  const evaluation = await evaluateG4(tx, registry, policy, intent, facts);
  switch (evaluation.kind) {
    case 'block': {
      await closeGateOverdue(tx, registry, intent.id, 'G4');
      const decision = await registry.decide(tx, {
        intentId: intent.id,
        gate: 'G4',
        decision: 'block',
        actor: { type: 'system' },
        source: 'workflow',
        reasonCode: 'policy_denied',
        inputSha256: sha256({
          v: 1,
          intent_sha256: intentInputSha256(intent),
          autonomy: evaluation.autonomy,
        }),
      });
      return { kind: 'blocked', decisionId: decision.id };
    }
    case 'wait':
      return {
        kind: 'waiting',
        result:
          evaluation.wakeInMs === undefined
            ? { outcome: 'waiting', reason: evaluation.reason }
            : { outcome: 'waiting', reason: evaluation.reason, wakeInMs: evaluation.wakeInMs },
      };
    case 'fail':
      await recordG4Failure(tx, registry, intent, evaluation);
      // U02: the exact check is recorded with the wait (ADR-M54 §2.4b), as in the audit event.
      return {
        kind: 'waiting',
        result: { outcome: 'waiting', reason: 'g4_check', cause: evaluation.check },
      };
    case 'ready': {
      const result = await decideReady(tx, registry, policy, intent, evaluation);
      return result === 'decided'
        ? { kind: 'decided', proposal: evaluation.proposal }
        : { kind: 'waiting', result };
    }
    default:
      return {
        kind: 'waiting',
        result: { outcome: 'waiting', reason: 'not_in_gate' },
      };
  }
}

/**
 * Records a failed check once per cause and subject (as the AI record check at G1, ADR-M32 §2.5): a
 * system `fail` with the reason code, the exact cause in the audit log, and one notice to the
 * people who operate runs. Waking again with the same cause records nothing new.
 */
async function recordG4Failure(
  tx: TenantScope,
  registry: Registry,
  intent: Intent,
  failure: Extract<G4Evaluation, { kind: 'fail' }>,
): Promise<void> {
  const history = await gateHistory(tx, intent.id, 'G4');
  const inputSha256 = sha256({
    v: 1,
    intent_sha256: intentInputSha256(intent),
    entry_seq: history.entrySeq.toString(),
    reason: failure.reason,
    check: failure.check,
    subject: failure.subject,
  });
  const recorded = (await tx.gateDecisions.listForIntent(intent.id, 'G4')).some(
    (d) => d.decision === 'fail' && d.input_sha256 === inputSha256,
  );
  if (recorded) return;
  const decision = await registry.decide(tx, {
    intentId: intent.id,
    gate: 'G4',
    decision: 'fail',
    actor: { type: 'system' },
    source: 'workflow',
    reasonCode: failure.reason,
    inputSha256,
  });
  await tx.audit.append({
    action: 'gate.g4_check_failed',
    actorType: 'system',
    actorId: null,
    entityId: intent.id,
    occurredAt: registry.now(),
    payload: { decision_id: decision.id, check: failure.check },
  });
  await tx.intentNotices.record({
    intentId: intent.id,
    kind: 'g4_refused',
    status: intent.status,
    gate: 'G4',
    previousGate: null,
    decisionId: decision.id,
    audienceRoles: G4_OPERATOR_ROLES,
  });
}

/** Whether G4 is decided for this proposal, and by whom (`runs.triggered_by`). */
export interface G4Decided {
  readonly decided: boolean;
  /** The last HITL approver; null for a system pass (POLICY). */
  readonly approverId: string | null;
  readonly oversight: OversightResolution;
  readonly history: GateHistory;
}

/**
 * Is G4 decided for the proposal with this input hash? POLICY (and any mode but HITL): a system
 * `pass` of it since the intent entered G4. HITL: enough approvals of it, after the entry and the
 * last request for changes; an approval of an older proposal, or an expired one, is voided first
 * (FR-17). Writes only those `void` decisions.
 */
export async function g4Decided(
  tx: TenantScope,
  registry: Registry,
  policy: G4Policy,
  intent: Intent,
  inputSha256: string,
): Promise<G4Decided> {
  const oversight = await gateOversight(tx, policy.policy, intent, 'G4');
  const history = await gateHistory(tx, intent.id, 'G4');
  if (oversight.mode !== 'HITL') {
    const decided = await passedSinceEntry(tx, intent.id, history.entrySeq, inputSha256);
    return { decided, approverId: null, oversight, history };
  }
  const { valid } = await registry.revalidateApprovals(tx, {
    intentId: intent.id,
    gate: 'G4',
    inputSha256,
  });
  const approvals = valid.filter((a) => history.countedApprovals.has(a.id));
  return {
    decided: approvals.length >= Math.max(1, oversight.approvalsNeeded),
    approverId: approvals.at(-1)?.decided_by ?? null,
    oversight,
    history,
  };
}

/**
 * All checks passed. POLICY (and any mode but HITL): a system `pass` bound to the proposal, once.
 * HITL: enough valid approvals of this proposal → the run may start; otherwise wait for Person A,
 * with the gate deadline.
 */
async function decideReady(
  tx: TenantScope,
  registry: Registry,
  policy: G4Policy,
  intent: Intent,
  ready: Extract<G4Evaluation, { kind: 'ready' }>,
): Promise<IntentStepResult | 'decided'> {
  const now = registry.now();
  const isNew = await recordRunProposal(tx, ready.proposal, ready.inputSha256, now);
  const { decided, oversight, history } = await g4Decided(
    tx,
    registry,
    policy,
    intent,
    ready.inputSha256,
  );
  if (oversight.mode !== 'HITL') {
    if (!decided) {
      await registry.decide(tx, {
        intentId: intent.id,
        gate: 'G4',
        decision: 'pass',
        actor: { type: 'system' },
        source: 'workflow',
        inputSha256: ready.inputSha256,
        waitedSeconds: waitedSeconds(intent, now),
      });
    }
    return 'decided';
  }
  if (decided) {
    await closeGateOverdue(tx, registry, intent.id, 'G4');
    return 'decided';
  }
  if (isNew) {
    await tx.intentNotices.record({
      intentId: intent.id,
      kind: 'run_proposed',
      status: intent.status,
      gate: 'G4',
      previousGate: null,
      decisionId: null,
      audienceRoles: oversight.roles.filter((role) => role !== 'viewer'),
    });
  }
  const wakeInMs = await checkGateOverdue(tx, registry, {
    intent,
    gate: 'G4',
    config: policy.config,
    oversight,
    clockStart: gateClockStart(intent, history.latestChangesRequestAt),
    subject: { kind: 'run_contract', sha256: ready.inputSha256 },
  });
  return wakeInMs === undefined
    ? { outcome: 'waiting', reason: 'decision' }
    : { outcome: 'waiting', reason: 'decision', wakeInMs };
}

/** True when a system `pass` of this proposal was recorded since the intent entered G4. */
async function passedSinceEntry(
  tx: TenantScope,
  intentId: string,
  entrySeq: bigint,
  inputSha256: string,
): Promise<boolean> {
  const events = await tx.audit.listForEntity(intentId, ['gate.decided']);
  const ids = new Set(
    events
      .filter((e) => BigInt(e.seq) > entrySeq)
      .map((e) => (e.payload as { decision_id?: string }).decision_id),
  );
  const decisions: GateDecisionRow[] = await tx.gateDecisions.listForIntent(intentId, 'G4');
  return decisions.some(
    (d) => d.decision === 'pass' && d.input_sha256 === inputSha256 && ids.has(d.id),
  );
}
