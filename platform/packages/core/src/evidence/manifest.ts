// The Evidence Pack manifest (task E02, D-02 FR-40, design/ADR-M48 §2.3). JSON, RFC 8785
// canonical form. It holds **only codes, IDs, hashes, versions, counts, times and references**:
// never a diff, the spec or plan text, a comment or review text, the intent's title or
// description, a person's name (names are only in the Markdown), or a secret.
//
// `content_sha256` is the SHA-256 of the canonical content without `build` (the pack ID, version,
// time and builder), so a build whose content did not change returns the existing version.
// `release_sha256` (E03, ADR-M49 §2.2) is the same hash of the content without the G8 parts: the
// G8 gate decisions and the escalations raised at G8. G8 approvals are bound to it, so a new G8
// approval makes a new pack version without voiding the approvals given before it.
import { createHash } from 'node:crypto';

import { canonicalJson } from '@sdlc/config';

import type { CostAmounts } from '../cost/report.js';
import type {
  Agent,
  Escalation,
  EvidenceItem,
  GateDecisionRow,
  Intent,
  Plan,
  Project,
  ProjectAiRecord,
  Run,
  RunEventRow,
  SpecRef,
} from '../db/schema.js';
import { disclosureFacts, type DisclosureFacts } from './disclosure.js';

export const EVIDENCE_PACK_SCHEMA_VERSION = 1;

/** Run events copied into the pack (their payloads are coded values only, D-05 §6.4). */
export const PACK_RUN_EVENTS = [
  'changes_checked',
  // H04 (ADR-M93 §2.3): the secret scan of the run's added lines (codes and counts).
  'secrets_scanned',
  // H05 (ADR-M95 §2.2): the size of the change a person reviews at G7 (counts only).
  'diff_measured',
  'branch_pushed',
  'ci_checked',
  'g7_checked',
  'pr_merged',
  'loop_detected',
  'kill_requested',
  // X07 (ADR-M90 §2.4): the hash and counts of what the run's agent read.
  'context_snapshot',
  // X13 (ADR-M74 §2.8): which approved memory version the run's agent read (hash and counts).
  'memory_read',
] as const;
export type PackRunEvent = (typeof PACK_RUN_EVENTS)[number];

/** An evidence file and the result of its re-check (ADR-M33 §2.9 gap 2). */
export interface VerifiedItem {
  readonly item: EvidenceItem;
  readonly check: 'verified' | 'purged';
}

export interface PackSource {
  readonly intent: Intent;
  readonly project: Project;
  readonly aiRecord: ProjectAiRecord;
  readonly specs: readonly SpecRef[];
  readonly plans: readonly Plan[];
  readonly runs: readonly Run[];
  /** Events per run ID, oldest first. */
  readonly runEvents: ReadonlyMap<string, readonly RunEventRow[]>;
  readonly agents: ReadonlyMap<string, Agent>;
  readonly decisions: readonly GateDecisionRow[];
  readonly escalations: readonly Escalation[];
  readonly items: readonly VerifiedItem[];
  readonly cost: CostAmounts;
}

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

/** The plan file of an intent (ADR-M40 §2.1). */
export function planFilePath(intentCode: string): string {
  return `.sdlc/plans/${intentCode}.yaml`;
}

function latestEvents(events: readonly RunEventRow[]): Record<string, Record<string, unknown>> {
  const latest: Record<string, Record<string, unknown>> = {};
  for (const event of events) {
    if ((PACK_RUN_EVENTS as readonly string[]).includes(event.event_type)) {
      latest[event.event_type] = event.payload;
    }
  }
  return latest;
}

function modelOf(run: Run, agents: ReadonlyMap<string, Agent>): string | null {
  const agent = agents.get(run.agent_id);
  // The register holds the agent's current version only; an older run's model is not known here.
  return agent && agent.version === run.agent_version ? agent.model_ref : null;
}

function runSection(source: PackSource): Record<string, unknown>[] {
  return source.runs.map((run) => ({
    id: run.id,
    attempt: run.attempt,
    status: run.status,
    stop_reason: run.stop_reason,
    plan_id: run.plan_id,
    agent_id: run.agent_id,
    agent_key: source.agents.get(run.agent_id)?.agent_key ?? null,
    agent_version: run.agent_version,
    model: modelOf(run, source.agents),
    branch: run.branch,
    base_sha: run.base_sha,
    head_sha: run.head_sha,
    iterations: run.iterations,
    triggered_by: run.triggered_by,
    killed_by: run.killed_by,
    started_at: iso(run.started_at),
    finished_at: iso(run.finished_at),
    events: latestEvents(source.runEvents.get(run.id) ?? []),
  }));
}

function decisionSection(decisions: readonly GateDecisionRow[]): Record<string, unknown>[] {
  return decisions.map((d) => ({
    id: d.id,
    gate: d.gate,
    decision: d.decision,
    oversight_mode: d.oversight_mode,
    approver_role: d.approver_role,
    actor_type: d.actor_type,
    decided_by: d.decided_by,
    reason_code: d.reason_code,
    reason_ref: d.reason_ref,
    input_sha256: d.input_sha256,
    config_hash: d.config_hash,
    source: d.source,
    waited_seconds: d.waited_seconds,
    expires_at: iso(d.expires_at),
    voids_decision_id: d.voids_decision_id,
    decided_at: d.created_at.toISOString(),
  }));
}

function escalationSection(escalations: readonly Escalation[]): Record<string, unknown>[] {
  return escalations.map((e) => ({
    id: e.id,
    code: e.code,
    run_id: e.run_id,
    trigger: e.trigger,
    route: e.route,
    severity: e.severity,
    response_level: e.response_level,
    status: e.status,
    reason_code: typeof e.packet.reason_code === 'string' ? e.packet.reason_code : null,
    decision: typeof e.decision?.decision === 'string' ? e.decision.decision : null,
    decided_by: e.decided_by,
    created_at: e.created_at.toISOString(),
    acknowledged_at: iso(e.acknowledged_at),
    decided_at: iso(e.decided_at),
    closed_at: iso(e.closed_at),
  }));
}

/** The manifest's content: everything but `build`. Deterministic for the same data. */
export function buildManifestContent(source: PackSource): Record<string, unknown> {
  const { intent, project, aiRecord } = source;
  const disclosure: DisclosureFacts = disclosureFacts(source);
  return {
    schema_version: EVIDENCE_PACK_SCHEMA_VERSION,
    intent: {
      id: intent.id,
      code: intent.code,
      project_id: project.id,
      project: project.slug,
      git_provider: project.git_provider,
      repository: project.repo_full_name,
      default_branch: project.default_branch,
      risk_tier: intent.risk_tier,
      data_class: intent.data_class,
      max_autonomy: intent.max_autonomy,
      status: intent.status,
      current_gate: intent.current_gate,
      issue_number: intent.issue_number,
      pr_number: intent.pr_number,
      created_by: intent.created_by,
      created_at: intent.created_at.toISOString(),
    },
    ai_record: {
      version: aiRecord.version,
      record_sha256: aiRecord.record_sha256,
      disclosure_format: aiRecord.disclosure_format,
    },
    specs: source.specs.map((s) => ({
      version: s.version,
      path: s.path,
      commit_sha: s.commit_sha,
      content_sha256: s.content_sha256,
      source_tool: s.source_tool,
    })),
    plans: source.plans.map((p) => ({
      id: p.id,
      version: p.version,
      path: p.commit_sha === null ? null : planFilePath(intent.code),
      commit_sha: p.commit_sha,
      plan_sha256: p.plan_sha256,
      path_patterns: p.planned_files.length,
      allowed_tools: p.allowed_tools,
      change_flags: p.change_flags,
      submitted_by: p.submitted_by,
    })),
    runs: runSection(source),
    evidence_items: source.items.map(({ item, check }) => ({
      id: item.id,
      run_id: item.run_id,
      kind: item.kind,
      storage_uri: item.storage_uri,
      sha256: item.sha256,
      size_bytes: Number(item.size_bytes),
      check,
    })),
    gate_decisions: decisionSection(source.decisions),
    escalations: escalationSection(source.escalations),
    cost: {
      calls: source.cost.calls,
      input_tokens: source.cost.inputTokens,
      output_tokens: source.cost.outputTokens,
      cached_input_tokens: source.cost.cachedInputTokens,
      cost_usd: source.cost.costUsd,
      wasted_tokens: source.cost.wastedTokens,
      wasted_cost_usd: source.cost.wastedCostUsd,
    },
    disclosure: { ...disclosure },
  };
}

/** The source without the G8 parts (ADR-M49 §2.2): what a G8 approval is bound to. */
export function withoutG8(source: PackSource): PackSource {
  return {
    ...source,
    decisions: source.decisions.filter((d) => d.gate !== 'G8'),
    escalations: source.escalations.filter((e) => e.packet.gate !== 'G8'),
  };
}

/** The release hash of a source: the content hash without the G8 parts. */
export function releaseSha256(source: PackSource): string {
  return contentSha256(buildManifestContent(withoutG8(source)));
}

export function contentSha256(content: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJson(content), 'utf8').digest('hex');
}

export interface PackBuildInfo {
  readonly packId: string;
  readonly version: number;
  readonly builtAt: Date;
  readonly builtBy: string | null;
  readonly contentSha256: string;
  readonly releaseSha256: string;
}

/** The stored manifest: the content and the build's own fields, canonical JSON in UTF-8. */
export function manifestBytes(content: Record<string, unknown>, build: PackBuildInfo): Buffer {
  return Buffer.from(
    canonicalJson({
      ...content,
      build: {
        pack_id: build.packId,
        version: build.version,
        built_at: build.builtAt.toISOString(),
        built_by: build.builtBy,
        content_sha256: build.contentSha256,
        release_sha256: build.releaseSha256,
      },
    }),
    'utf8',
  );
}
