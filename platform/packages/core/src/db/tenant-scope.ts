// The only way to reach tenant data (design/D-05 D1, D-08 A06 AC3).
import { sql, type Kysely } from 'kysely';

import type { Database } from './schema.js';
import { TenantGuardPlugin } from './tenant-guard-plugin.js';
import { parseTenantId, type TenantId } from './tenant-id.js';
import { AgentApprovalRepository } from './repositories/agent-approvals.js';
import { AgentRepository } from './repositories/agents.js';
import { KnowledgeIndexRepository } from './repositories/knowledge-indexes.js';
import { MemoryVersionRepository } from './repositories/memory-versions.js';
import { ToolApprovalRepository } from './repositories/tool-approvals.js';
import { ToolRepository } from './repositories/tools.js';
import { ApiTokenRepository } from './repositories/api-tokens.js';
import { AuditLogRepository } from './repositories/audit-log.js';
import { CostRecordRepository } from './repositories/cost-records.js';
import { EvaluationContractRepository } from './repositories/evaluation-contracts.js';
import { EvaluationPlanRepository } from './repositories/evaluation-plans.js';
import { EvaluationTaskCheckContractRepository } from './repositories/evaluation-task-check-contracts.js';
import { EvaluationTaskRepository } from './repositories/evaluation-tasks.js';
import { EvaluationRunRepository } from './repositories/evaluation-runs.js';
import { EvaluationRepository } from './repositories/evaluations.js';
import { EvidenceHoldRepository } from './repositories/evidence-holds.js';
import { EvidenceItemRepository } from './repositories/evidence-items.js';
import { EvidencePackRepository } from './repositories/evidence-packs.js';
import { EscalationNoticeRepository, EscalationRepository } from './repositories/escalations.js';
import { GateDecisionRepository } from './repositories/gate-decisions.js';
import { AgentMetricsRepository } from './repositories/agent-metrics.js';
import { GateMetricsRepository } from './repositories/gate-metrics.js';
import { GitEventCursorRepository } from './repositories/git-event-cursors.js';
import { GitEventReceiptRepository } from './repositories/git-event-receipts.js';
import { IntentNoticeRepository } from './repositories/intent-notices.js';
import { IntentRepository } from './repositories/intents.js';
import { LangfusePurgeRepository } from './repositories/langfuse-purges.js';
import { PlanRepository } from './repositories/plans.js';
import { ProjectAiRecordRepository } from './repositories/project-ai-records.js';
import { ProjectConfigRepository } from './repositories/project-configs.js';
import { ProjectRepository } from './repositories/projects.js';
import { RetentionRepository } from './repositories/retention.js';
import { RoleBindingRepository } from './repositories/role-bindings.js';
import { RunContractRepository } from './repositories/run-contracts.js';
import { RunEventRepository } from './repositories/run-events.js';
import { RunRepository } from './repositories/runs.js';
import { SpecRefRepository } from './repositories/spec-refs.js';
import { TenantRoleBindingRepository } from './repositories/tenant-role-bindings.js';
import { UserIdentityRepository } from './repositories/user-identities.js';
import { UserRepository } from './repositories/users.js';
import { WebSessionRepository } from './repositories/web-sessions.js';
import { HousekeepingRepository } from './repositories/housekeeping.js';
import { ClientDataDeletionRepository } from './repositories/client-data-deletion.js';
import { PasskeyChallengeRepository } from './repositories/passkey-challenges.js';
import { WebauthnCredentialRepository } from './repositories/webauthn-credentials.js';

/**
 * Repositories bound to one tenant. Every query they send passes the tenant guard, which
 * rejects any table access without `tenant_id = <this tenant>`.
 */
export class TenantScope {
  readonly tenantId: TenantId;
  readonly projects: ProjectRepository;
  readonly projectConfigs: ProjectConfigRepository;
  readonly projectAiRecords: ProjectAiRecordRepository;
  readonly users: UserRepository;
  readonly userIdentities: UserIdentityRepository;
  readonly roleBindings: RoleBindingRepository;
  readonly tenantRoles: TenantRoleBindingRepository;
  readonly apiTokens: ApiTokenRepository;
  readonly gitEventCursors: GitEventCursorRepository;
  readonly gitEventReceipts: GitEventReceiptRepository;
  readonly audit: AuditLogRepository;
  readonly intents: IntentRepository;
  readonly intentNotices: IntentNoticeRepository;
  readonly specRefs: SpecRefRepository;
  readonly plans: PlanRepository;
  readonly gateDecisions: GateDecisionRepository;
  readonly gateMetrics: GateMetricsRepository;
  readonly agentMetrics: AgentMetricsRepository;
  readonly runs: RunRepository;
  readonly runContracts: RunContractRepository;
  readonly runEvents: RunEventRepository;
  readonly costRecords: CostRecordRepository;
  readonly evidenceItems: EvidenceItemRepository;
  readonly evidencePacks: EvidencePackRepository;
  readonly evidenceHolds: EvidenceHoldRepository;
  readonly retention: RetentionRepository;
  readonly langfusePurges: LangfusePurgeRepository;
  readonly evaluations: EvaluationRepository;
  readonly evaluationRuns: EvaluationRunRepository;
  readonly evaluationContracts: EvaluationContractRepository;
  readonly evaluationPlans: EvaluationPlanRepository;
  readonly evaluationTasks: EvaluationTaskRepository;
  readonly evaluationTaskCheckContracts: EvaluationTaskCheckContractRepository;
  readonly escalations: EscalationRepository;
  readonly escalationNotices: EscalationNoticeRepository;
  readonly agents: AgentRepository;
  readonly agentApprovals: AgentApprovalRepository;
  readonly tools: ToolRepository;
  readonly toolApprovals: ToolApprovalRepository;
  readonly knowledgeIndexes: KnowledgeIndexRepository;
  readonly memoryVersions: MemoryVersionRepository;
  readonly webSessions: WebSessionRepository;
  readonly webauthnCredentials: WebauthnCredentialRepository;
  readonly passkeyChallenges: PasskeyChallengeRepository;
  readonly housekeeping: HousekeepingRepository;
  readonly clientDataDeletion: ClientDataDeletionRepository;

  private readonly db: Kysely<Database>;
  #savepoints = 0;

  /** @internal Use `PlatformDatabase.forTenant`. */
  constructor(db: Kysely<Database>, tenantId: TenantId) {
    // Checked again at runtime: the brand can be forged with a type assertion.
    this.tenantId = parseTenantId(tenantId);
    this.db = db.withPlugin(new TenantGuardPlugin(this.tenantId));
    this.projects = new ProjectRepository(this.db, this.tenantId);
    this.projectConfigs = new ProjectConfigRepository(this.db, this.tenantId);
    this.projectAiRecords = new ProjectAiRecordRepository(this.db, this.tenantId);
    this.users = new UserRepository(this.db, this.tenantId);
    this.userIdentities = new UserIdentityRepository(this.db, this.tenantId);
    this.roleBindings = new RoleBindingRepository(this.db, this.tenantId);
    this.tenantRoles = new TenantRoleBindingRepository(this.db, this.tenantId);
    this.apiTokens = new ApiTokenRepository(this.db, this.tenantId);
    this.gitEventCursors = new GitEventCursorRepository(this.db, this.tenantId);
    this.gitEventReceipts = new GitEventReceiptRepository(this.db, this.tenantId);
    this.audit = new AuditLogRepository(this.db, this.tenantId);
    this.intents = new IntentRepository(this.db, this.tenantId);
    this.intentNotices = new IntentNoticeRepository(this.db, this.tenantId);
    this.specRefs = new SpecRefRepository(this.db, this.tenantId);
    this.plans = new PlanRepository(this.db, this.tenantId);
    this.gateDecisions = new GateDecisionRepository(this.db, this.tenantId);
    this.gateMetrics = new GateMetricsRepository(this.db, this.tenantId);
    this.agentMetrics = new AgentMetricsRepository(this.db, this.tenantId);
    this.runs = new RunRepository(this.db, this.tenantId);
    this.runContracts = new RunContractRepository(this.db, this.tenantId);
    this.runEvents = new RunEventRepository(this.db, this.tenantId);
    this.costRecords = new CostRecordRepository(this.db, this.tenantId);
    this.evidenceItems = new EvidenceItemRepository(this.db, this.tenantId);
    this.evidencePacks = new EvidencePackRepository(this.db, this.tenantId);
    this.evidenceHolds = new EvidenceHoldRepository(this.db, this.tenantId);
    this.retention = new RetentionRepository(this.db, this.tenantId);
    this.langfusePurges = new LangfusePurgeRepository(this.db, this.tenantId);
    this.evaluations = new EvaluationRepository(this.db, this.tenantId);
    this.evaluationRuns = new EvaluationRunRepository(this.db, this.tenantId);
    this.evaluationContracts = new EvaluationContractRepository(this.db, this.tenantId);
    this.evaluationPlans = new EvaluationPlanRepository(this.db, this.tenantId);
    this.evaluationTasks = new EvaluationTaskRepository(this.db, this.tenantId);
    this.evaluationTaskCheckContracts = new EvaluationTaskCheckContractRepository(
      this.db,
      this.tenantId,
    );
    this.escalations = new EscalationRepository(this.db, this.tenantId);
    this.escalationNotices = new EscalationNoticeRepository(this.db, this.tenantId);
    this.agents = new AgentRepository(this.db, this.tenantId);
    this.agentApprovals = new AgentApprovalRepository(this.db, this.tenantId);
    this.tools = new ToolRepository(this.db, this.tenantId);
    this.toolApprovals = new ToolApprovalRepository(this.db, this.tenantId);
    this.knowledgeIndexes = new KnowledgeIndexRepository(this.db, this.tenantId);
    this.memoryVersions = new MemoryVersionRepository(this.db, this.tenantId);
    this.webSessions = new WebSessionRepository(this.db, this.tenantId);
    this.webauthnCredentials = new WebauthnCredentialRepository(this.db, this.tenantId);
    this.passkeyChallenges = new PasskeyChallengeRepository(this.db, this.tenantId);
    this.housekeeping = new HousekeepingRepository(this.db, this.tenantId);
    this.clientDataDeletion = new ClientDataDeletionRepository(this.db, this.tenantId);
  }

  /**
   * Runs `work` in one database transaction, with repositories bound to the same tenant. Inside a
   * transaction already (a scope from `transaction` or `SystemScope.createTenantWith`), `work` joins it:
   * it commits or rolls back with the outer transaction, never on its own.
   */
  transaction<T>(work: (scope: TenantScope) => Promise<T>): Promise<T> {
    if (this.db.isTransaction) return work(this);
    return this.db.transaction().execute((trx) => work(new TenantScope(trx, this.tenantId)));
  }

  /**
   * Runs `work` inside a savepoint of the current transaction (task B06, ADR-M27): when `work`
   * throws, only its own writes are rolled back and the transaction stays usable. Only inside
   * `transaction`. The savepoint statements reference no table, so they bypass the tenant guard,
   * which refuses raw statements; nothing else may.
   */
  async savepoint<T>(work: (scope: TenantScope) => Promise<T>): Promise<T> {
    if (!this.db.isTransaction) {
      throw new Error('TenantScope.savepoint must run inside TenantScope.transaction');
    }
    this.#savepoints += 1;
    const name = sql.id(`sdlc_sp_${String(this.#savepoints)}`);
    const raw = this.db.withoutPlugins();
    await sql`SAVEPOINT ${name}`.execute(raw);
    try {
      const result = await work(this);
      await sql`RELEASE SAVEPOINT ${name}`.execute(raw);
      return result;
    } catch (error) {
      await sql`ROLLBACK TO SAVEPOINT ${name}`.execute(raw);
      throw error;
    }
  }
}
