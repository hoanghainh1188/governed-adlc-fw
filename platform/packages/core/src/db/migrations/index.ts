// All migrations, in order. Add new ones at the end; never rename, reorder or edit a merged one.
// A static list (no directory scan, no computed import) keeps the build simple and reviewable.
import { migration0001Tenancy } from './0001-tenancy.js';
import { migration0002AuditLog } from './0002-audit-log.js';
import { migration0003Registry } from './0003-registry.js';
import { migration0004Runs } from './0004-runs.js';
import { migration0005CostRecords } from './0005-cost-records.js';
import { migration0006GitEventReceipts } from './0006-git-event-receipts.js';
import { migration0007Escalations } from './0007-escalations.js';
import { migration0008Agents } from './0008-agents.js';
import { migration0009IntentWorkflow } from './0009-intent-workflow.js';
import { migration0010AiRecord } from './0010-ai-record.js';
import { migration0011GateG4 } from './0011-gate-g4.js';
import { migration0012EvidenceItems } from './0012-evidence-items.js';
import { migration0013GateG5Runner } from './0013-gate-g5-runner.js';
import { migration0014AdminOnboarding } from './0014-admin-onboarding.js';
import { migration0015GateG5 } from './0015-gate-g5.js';
import { migration0016AgentApprovals } from './0016-agent-approvals.js';
import { migration0017PushedHead } from './0017-pushed-head.js';
import { migration0018PlanFiles } from './0018-plan-files.js';
import { migration0019GateG7 } from './0019-gate-g7.js';
import { migration0020KillSwitch } from './0020-kill-switch.js';
import { migration0021EvidencePacks } from './0021-evidence-packs.js';
import { migration0022GateG8 } from './0022-gate-g8.js';
import { migration0023Retention } from './0023-retention.js';
import { migration0024LangfusePurges } from './0024-langfuse-purges.js';
import { migration0025IntentsWaitingReason } from './0025-intents-waiting-reason.js';
import { migration0026SpecStructure } from './0026-spec-structure.js';
import { migration0027WebSessions } from './0027-web-sessions.js';
import { migration0028DashboardWrites } from './0028-dashboard-writes.js';
import { migration0029Evaluations } from './0029-evaluations.js';
import { migration0030EvaluationContracts } from './0030-evaluation-contracts.js';
import { migration0031EvaluationPlans } from './0031-evaluation-plans.js';
import { migration0032EvaluationPlanRequests } from './0032-evaluation-plan-requests.js';
import { migration0033EvaluationTasks } from './0033-evaluation-tasks.js';
import { migration0034EvaluationTaskChecks } from './0034-evaluation-task-checks.js';
import { migration0035ProjectTaskSets } from './0035-project-task-sets.js';
import { migration0036EvaluationFingerprints } from './0036-evaluation-fingerprints.js';
import { migration0037AgentAdapter } from './0037-agent-adapter.js';
import { migration0038ToolRegister } from './0038-tool-register.js';
import { migration0039KnowledgeIndexes } from './0039-knowledge-indexes.js';
import { migration0040KnowledgeReadEvidence } from './0040-knowledge-read-evidence.js';
import { migration0041ContextSnapshotEvidence } from './0041-context-snapshot-evidence.js';
import { migration0042DiffScan } from './0042-diff-scan.js';
import { migration0043ReviewLimits } from './0043-review-limits.js';
import { migration0044DependencyChecks } from './0044-dependency-checks.js';
import { migration0045WebDecisionSource } from './0045-web-decision-source.js';
import { migration0046Housekeeping } from './0046-housekeeping.js';
import { migration0047ClientDataDeletion } from './0047-client-data-deletion.js';
import { migration0048ClientPurge } from './0048-client-purge.js';
import { migration0049ProjectRepoPath } from './0049-project-repo-path.js';
import { migration0050IntentEffortEstimate } from './0050-intent-effort-estimate.js';
import { migration0051CodeIndex } from './0051-code-index.js';
import { migration0052ReadCodePermission } from './0052-read-code-permission.js';
import { migration0053MemoryVersions } from './0053-memory-versions.js';
import { migration0054MemoryDiffEvidence } from './0054-memory-diff-evidence.js';
import { migration0055MemoryProposals } from './0055-memory-proposals.js';
import { migration0056IntentSearch } from './0056-intent-search.js';
import type { SqlMigration } from './define.js';

export const MIGRATIONS: Readonly<Record<string, SqlMigration>> = {
  '0001-tenancy': migration0001Tenancy,
  '0002-audit-log': migration0002AuditLog,
  '0003-registry': migration0003Registry,
  '0004-runs': migration0004Runs,
  '0005-cost-records': migration0005CostRecords,
  '0006-git-event-receipts': migration0006GitEventReceipts,
  '0007-escalations': migration0007Escalations,
  '0008-agents': migration0008Agents,
  '0009-intent-workflow': migration0009IntentWorkflow,
  '0010-ai-record': migration0010AiRecord,
  '0011-gate-g4': migration0011GateG4,
  '0012-evidence-items': migration0012EvidenceItems,
  '0013-gate-g5-runner': migration0013GateG5Runner,
  '0014-admin-onboarding': migration0014AdminOnboarding,
  '0015-gate-g5': migration0015GateG5,
  '0016-agent-approvals': migration0016AgentApprovals,
  '0017-pushed-head': migration0017PushedHead,
  '0018-plan-files': migration0018PlanFiles,
  '0019-gate-g7': migration0019GateG7,
  '0020-kill-switch': migration0020KillSwitch,
  '0021-evidence-packs': migration0021EvidencePacks,
  '0022-gate-g8': migration0022GateG8,
  '0023-retention': migration0023Retention,
  '0024-langfuse-purges': migration0024LangfusePurges,
  '0025-intents-waiting-reason': migration0025IntentsWaitingReason,
  '0026-spec-structure': migration0026SpecStructure,
  '0027-web-sessions': migration0027WebSessions,
  '0028-dashboard-writes': migration0028DashboardWrites,
  '0029-evaluations': migration0029Evaluations,
  '0030-evaluation-contracts': migration0030EvaluationContracts,
  '0031-evaluation-plans': migration0031EvaluationPlans,
  '0032-evaluation-plan-requests': migration0032EvaluationPlanRequests,
  '0033-evaluation-tasks': migration0033EvaluationTasks,
  '0034-evaluation-task-checks': migration0034EvaluationTaskChecks,
  '0035-project-task-sets': migration0035ProjectTaskSets,
  '0036-evaluation-fingerprints': migration0036EvaluationFingerprints,
  '0037-agent-adapter': migration0037AgentAdapter,
  '0038-tool-register': migration0038ToolRegister,
  '0039-knowledge-indexes': migration0039KnowledgeIndexes,
  '0040-knowledge-read-evidence': migration0040KnowledgeReadEvidence,
  '0041-context-snapshot-evidence': migration0041ContextSnapshotEvidence,
  '0042-diff-scan': migration0042DiffScan,
  '0043-review-limits': migration0043ReviewLimits,
  '0044-dependency-checks': migration0044DependencyChecks,
  '0045-web-decision-source': migration0045WebDecisionSource,
  '0046-housekeeping': migration0046Housekeeping,
  '0047-client-data-deletion': migration0047ClientDataDeletion,
  '0048-client-purge': migration0048ClientPurge,
  '0049-project-repo-path': migration0049ProjectRepoPath,
  '0050-intent-effort-estimate': migration0050IntentEffortEstimate,
  '0051-code-index': migration0051CodeIndex,
  '0052-read-code-permission': migration0052ReadCodePermission,
  '0053-memory-versions': migration0053MemoryVersions,
  '0054-memory-diff-evidence': migration0054MemoryDiffEvidence,
  '0055-memory-proposals': migration0055MemoryProposals,
  '0056-intent-search': migration0056IntentSearch,
};
