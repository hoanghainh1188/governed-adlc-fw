// Runner: provisions sandboxes and runs the agent. See design/D-03 section 5.1 and ADR-M25.
export {
  ALLOWED_ENDPOINTS,
  DockerClient,
  isAllowedEndpoint,
  parseEngineInfo,
} from './docker/client.js';
export type {
  ContainerInfo,
  DockerClientOptions,
  EngineInfo,
  NetworkSpec,
  NetworkSummary,
} from './docker/client.js';
export {
  assertSafeContainerSpec,
  assertSafeGatewaySpec,
  assertSafeNetworkSpec,
  assertSafeScoringSpec,
  assertSafeToolSpec,
  GATEWAY_COMMAND,
  GATEWAY_USER,
  TOOL_USER,
  SANDBOX_ENV_ALLOWLIST,
  SCORING_COMMANDS,
  SCORING_ENV_ALLOWLIST,
  SCORING_ENTRYPOINT,
  type ContainerSpec,
  type ScoringContainerSpec,
  type ScoringPhase,
  type ToolContainerSpec,
} from './docker/guard.js';
export {
  AUTHZ_RULES,
  AUTHZ_RULES_PATH,
  evaluateAuthz,
  evaluateAuthzRaw,
  type AuthzDecision,
  type AuthzRules,
} from './docker/authz.js';
export { buildScoringSpec, type ScoringSpecInput } from './sandbox/scoring-spec.js';
export {
  scoreEvaluationRun,
  ScoringError,
  type ScoreEvaluationDeps,
  type ScoreEvaluationInput,
  type ScoringFailure,
} from './evaluation/score.js';
export { agentUrl, attachRunner } from './agent/access.js';
export {
  AGENT_WORKING_DIR,
  agentCommitAuthor,
  driveAgent,
  llmReachable,
  outcomeOf,
  type AgentDriveDeps,
  type AgentOutcome,
  type AgentRunRequest,
  type AgentRunResult,
} from './agent/drive.js';
export { AgentRunError, type AgentRunFailure } from './agent/errors.js';
export {
  LoopWatch,
  type LoopLimits,
  type LoopStop,
  type LoopStopReason,
} from './agent/loop-watch.js';
export {
  SpendWatch,
  type BudgetWarning,
  type SpendLimits,
  type SpendState,
} from './agent/spend.js';
export { AGENT_ERROR_MESSAGES, agentErrorMessage } from './agent/messages.js';
export {
  loadAgentTask,
  PLAN_FIELD_MAX_CHARS,
  PLAN_TASK_TEXT_MAX_CHARS,
  renderPlanTasks,
} from './agent/task.js';
export { capText, cleanText } from './agent/text.js';
export {
  capFeedback,
  readRunFeedback,
  REVIEW_FEEDBACK_MAX_CHARS,
  type FeedbackAccess,
  type FeedbackReader,
} from './agent/feedback.js';
export { assertSafeNetworkConnect, assertSafeServiceConnect } from './docker/guard.js';
export { RunnerError, type RunnerErrorKey } from './errors.js';
export { HeldRuns } from './held.js';
export {
  recordWrapTokenReused,
  revokeAfterUse,
  type GitTokenRevoker,
  type RunToken,
} from './tokens.js';
export {
  isRunId,
  LABELS,
  MANAGED_BY,
  runLabels,
  runNames,
  runOfLabels,
  toolObjectNames,
  type LabelledRun,
  type RunNames,
  type ToolObjectNames,
} from './names.js';
export { SlotPool, type Slot } from './pool.js';
export {
  DB_PASSWORD_FIELD,
  DB_USER,
  PROCESS_ENV,
  processSettingsFromEnv,
  type ProcessSettings,
} from './process.js';
export {
  findRunObjects,
  MAX_EVALUATION_ATTEMPTS,
  reconcileOnStart,
  sweepOrphans,
  type ReconcileDeps,
  type ReconcileResult,
} from './reconcile.js';
export { Runner, type RunnerAgentOptions, type RunnerHooks } from './runner.js';
export {
  createSandbox,
  ProvisioningError,
  releaseWorkspace,
  reserveWorkspace,
  teardownSandbox,
  type CreateSandboxInput,
  type ProvisioningFailure,
  type Sandbox,
  type TeardownReason,
  type TeardownResult,
} from './sandbox/lifecycle.js';
export { planEgress, runNetworkSpec, type EgressPlan } from './sandbox/network.js';
export { buildSandboxSpec, type SandboxSpecInput } from './sandbox/spec.js';
export {
  argumentRuleCel,
  buildGatewayConfig,
  exposedToolName,
  GATEWAY_READY_MESSAGE,
  type GatewayConfigInput,
} from './tools/gateway-config.js';
export {
  startTools,
  toolGrantsEnforceable,
  type StartToolsInput,
  type StartedTools,
  type ToolRuntime,
} from './tools/provision.js';
export {
  knowledgeReadOf,
  recordKnowledgeRead,
  type KnowledgeRead,
} from './tools/knowledge-read.js';
export {
  buildContextSnapshot,
  documentsOf,
  recordContextSnapshot,
  SNAPSHOT_SCHEMA_VERSION,
  specAtStart,
  type ContextSnapshot,
  type FileListSource,
  type SnapshotDocuments,
  type SnapshotInput,
} from './snapshot/context.js';
export { recordToolUse } from './tools/record.js';
export {
  buildGatewaySpec,
  buildToolSpec,
  GATEWAY_LIMITS,
  toolHost,
  type ToolLimits,
} from './tools/spec.js';
export { teardownTools } from './tools/teardown.js';
export { toolUsage, type ToolCounts, type ToolRefusal, type ToolUsage } from './tools/usage.js';
export {
  releaseSandbox,
  provisionRun,
  type ProvisionRequest,
  type ProvisionResult,
  type RunnerDeps,
} from './provision.js';
export {
  authEnv,
  CloneError,
  cloneForPush,
  cloneForRun,
  cloneUrl,
  PushError,
  pushCommit,
  remoteBranchHead,
  type CloneFailure,
  type PushFailure,
  type CloneInput,
  type GitSettings,
} from './workspace/git.js';
export { packDirectory, packTar, SANDBOX_UID, type TarEntry } from './workspace/tar.js';
export {
  computeRunPatch,
  exportWorkspace,
  MAX_WORKSPACE_ENTRIES,
  storeProposal,
  type ProposalDeps,
  type StoredProposal,
} from './workspace/export.js';
export {
  checkChangedPaths,
  diffMeasuredPayload,
  secretsScannedPayload,
  storeChanges,
  type ChangesDeps,
  type CheckedChanges,
} from './workspace/changes.js';
export {
  addedLines,
  configExtendsFile,
  reportRuleIds,
  ruleCodes,
  scanDiffForSecrets,
  scanFilePath,
  type SecretScan,
  type SecretScanCause,
} from './workspace/secrets.js';
export {
  countReviewSize,
  isLockFile,
  LOCK_FILE_NAMES,
  measureReviewSize,
  parseCheckAttr,
  parseNumstat,
  type NumstatEntry,
  type ReviewSize,
  type ReviewSizeCause,
} from './workspace/review-size.js';
export {
  DEFAULT_ALLOWED_LICENSES,
  DEPENDENCY_MANIFEST_NAMES,
  POPULAR_PACKAGES,
  isTyposquatting,
  levenshteinDistance,
  parsePackageJson,
  parsePackageLockJson,
  scanDependencies,
  type DependencyScan,
  type DependencyScanInput,
  type DependencyScanResult,
  type PackageEntry,
} from './workspace/dependencies.js';
export { IgnoreChecker } from './workspace/ignore.js';
export {
  planFileReader,
  readPlanBlob,
  type PlanBlobFailure,
  type PlanBlobRead,
  type PlanFileReader,
} from './workspace/plan-file.js';
export {
  publishRun,
  type PublishDeps,
  type PublishFailure,
  type PublishRefusal,
} from './workspace/publish.js';
export {
  computeProposal,
  mirrorWorkspace,
  neutraliseAttributes,
  type Proposal,
  type ProposalGitOptions,
} from './workspace/proposal.js';
export {
  untarWorkspace,
  type EntryDecision,
  type EntryFilter,
  type UntarLimits,
  type WorkspaceEntry,
} from './workspace/untar.js';
export {
  isSandboxRuntime,
  parseEgressServices,
  RUNNER_ENV,
  runnerSettingsFromEnv,
  SANDBOX_RUNTIMES,
  type AgentSettings,
  type EgressService,
  type RunnerSettings,
  type SandboxLimits,
  type SandboxRuntime,
} from './settings.js';
export { assertEngineRuntime, type EngineInfoReader } from './docker/runtime.js';
export { EVALUATION_AGENT_BRANCH, agentContractOf } from './evaluation/agent-contract.js';
export {
  driveEvaluationAgent,
  type EvaluationDriveDeps,
  type EvaluationDriveRequest,
  type EvaluationDriveResult,
} from './evaluation/drive.js';
export {
  executeEvaluation,
  type ExecuteEvaluationContext,
  type ExecuteEvaluationDeps,
} from './evaluation/execute.js';
export {
  createEvaluationActivities,
  EVALUATION_HEARTBEAT_MS,
  type EvaluationActivityContextLike,
  type EvaluationActivityDeps,
} from './evaluation/activities.js';
export { ServerExecutor, type ServerExecutorOptions } from './evaluation/server-executor.js';
export { checkTask, type CheckTaskDeps } from './evaluation/check.js';
