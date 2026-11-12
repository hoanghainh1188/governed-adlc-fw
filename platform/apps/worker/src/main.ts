#!/usr/bin/env node
// Entry point of the worker process (task B06, design/ADR-M27). It runs the GitHub poller, the
// escalation clock loop (B11, ADR-M28), and the Temporal worker of the intent workflow with its
// reconcile loop (B07, ADR-M30), the scheduled spend sync (C12) and the evidence retention loop
// (E05, ADR-M51). Settings come from the environment, the database password and the
// GitHub App key from OpenBao (AppRole `worker`).
// Tracing starts first (A08, ADR-M35): `./telemetry.js` must stay the first import.
import { tracing, tracingEndpointValid } from './telemetry.js';

import fs from 'node:fs';

import { GitHubAdapter } from '@sdlc/adapter-git-github';
import { createSimplePolicyEngine } from '@sdlc/adapter-policy-simple';
import { GitHostError, type IntentWorkflowSignals } from '@sdlc/contracts';
import {
  advanceEscalation,
  checkStoredConfigsAtStart,
  runAnchorPass,
  runHousekeepingPass,
  runClientPurgePass,
  runRetentionPass,
  gitHostErrorMessage,
  loadEffectiveConfig,
  pollRepository,
  prepareEvaluationRun,
  prepareTaskCheck,
  advanceEvaluationPlan,
  Registry,
} from '@sdlc/core';
import { t } from '@sdlc/messages';
import { OpenBaoClient, SecretsError } from '@sdlc/secrets';
import { OTEL_ENDPOINT_ENV } from '@sdlc/telemetry';
import {
  connectTemporal,
  NO_INTENT_SIGNALS,
  TemporalEvaluationDispatcher,
  TemporalTaskCheckDispatcher,
  TemporalIntentSignals,
  type TemporalClient,
} from '@sdlc/workflow-client';

import { connectDatabase } from './database.js';
import { createIntentActivities } from './activities/intent-activities.js';
import { CostSyncLoop } from './cost-sync-loop.js';
import { openWorkerEvidence } from './evidence-store.js';
import { EscalationLoop } from './escalation-loop.js';
import { EvaluationLoop } from './evaluation-loop.js';
import { TaskCheckLoop } from './evaluation-task-check-loop.js';
import { EvaluationPlanLoop } from './evaluation-plan-loop.js';
import { taskSetReader } from './task-sets.js';
import { jsonLogger } from './logger.js';
import { PollerLoop } from './poller-loop.js';
import { ReconcileLoop } from './reconcile-loop.js';
import { openAnchorStore } from './anchor-store.js';
import { openLangfusePurge } from './langfuse-store.js';
import { RetentionLoop } from './retention-loop.js';
import { openRetentionStore } from './retention-store.js';
import { openKnowledge } from './knowledge-store.js';
import { createWorkerRuns, type WorkerRuns } from './runs.js';
import { loadSettings, SettingsError } from './settings.js';
import { installTemporalLogging, startIntentWorker, type IntentWorkerHandle } from './temporal.js';

const logger = jsonLogger((line) => process.stdout.write(line));

async function main(): Promise<void> {
  if (!tracingEndpointValid) {
    throw new SettingsError('worker.settings.invalid', OTEL_ENDPOINT_ENV);
  }
  const settings = loadSettings(process.env);
  if (settings.database.kind === 'dev_url') {
    logger.log('warn', 'worker.dev_mode', { message: t('worker.start.dev_mode') });
  }
  // Kept open: the GitHub adapter reads the App key again every 10 minutes (ADR-M23 §2.2).
  const openbao = OpenBaoClient.fromEnv(process.env, logger);
  await openbao.assertReady();
  const secrets = openbao.kv();
  const db = await connectDatabase(settings, secrets, logger);
  // Stored configurations after a change of platform defaults (B13 AC8, ADR-M37 §2.5).
  await checkStoredConfigsAtStart(db, logger);
  const gitHost = new GitHubAdapter({ secrets, apiUrl: settings.githubApiUrl, logger });
  const registry = new Registry({
    policyFactory: (config) => createSimplePolicyEngine({ config }),
  });

  // Agent runs (C06 session 2, ADR-M33 §2.5): the cost-controller AppRole, the gateway and the
  // handoff. Without them a decided G4 waits.
  let workerRuns: WorkerRuns | undefined;
  // X04 PR 3a (ADR-M89 §2.1): the index of a project's documents for a `read_documents` tool.
  const knowledge = settings.runs
    ? await openKnowledge(settings.knowledge, secrets, gitHost, settings.runs.litellmUrl, logger)
    : undefined;
  // The Compose file always names the files; until `openbao:bootstrap worker-credentials` wrote
  // them, the worker starts with runs off instead of failing.
  if (settings.runs && fs.existsSync(settings.runs.costRoleIdFile)) {
    workerRuns = await createWorkerRuns({
      settings: settings.runs,
      env: process.env,
      db,
      registry,
      gitHost,
      signer: openbao.transit(),
      wrapper: openbao.wrapping(),
      logger,
      ...(knowledge?.deps
        ? {
            knowledge: knowledge.deps,
            // X04 PR 3b (QUESTIONS #540): the tools' logins, through the worker's own AppRole.
            databaseCredentials: openbao.databaseCredentials(),
          }
        : {}),
    });
  } else if (settings.temporal) {
    logger.log('warn', 'worker.runs_off', { message: t('worker.start.runs_off') });
  }

  // G8 (E03, ADR-M49 §2.2): the release pack needs the worker's own evidence store identity.
  const releases = settings.temporal
    ? await openWorkerEvidence(settings.evidence, secrets, logger)
    : undefined;

  // The intent workflow (B07, ADR-M30): Temporal worker, wake signals and the reconcile loop.
  let temporal: TemporalClient | undefined;
  let intentWorker: IntentWorkerHandle | undefined;
  let signals: IntentWorkflowSignals = NO_INTENT_SIGNALS;
  if (settings.temporal) {
    installTemporalLogging(logger);
    temporal = await connectTemporal(settings.temporal);
    signals = new TemporalIntentSignals(temporal.client);
    intentWorker = await startIntentWorker({
      settings: settings.temporal,
      activities: createIntentActivities({
        db,
        registry,
        // B08 (ADR-M39 §2.4): the spec re-check at G2–G4, always on.
        specs: { gitHost },
        // E01 (ADR-M41): G7 reads the pull request and its reviews; it needs no run capability.
        g7: { gitHost },
        ...(releases ? { releases, logger } : {}),
        // L04: the end of an evaluation run needs the Cost Controller (ADR-M81 §2.8).
        ...(workerRuns ? { evaluations: { costController: workerRuns.costController } } : {}),
        ...(workerRuns
          ? {
              g4: workerRuns.g4,
              runs: workerRuns.runs,
              publish: workerRuns.publish,
              g6: workerRuns.g6,
            }
          : {}),
      }),
      workflowBundlePath: settings.workflowBundle,
    });
    // A failed Temporal worker stops the process; Compose restarts it.
    intentWorker.running.catch(() => {
      logger.log('error', 'worker.temporal_failed', {});
      process.exitCode = 1;
      process.kill(process.pid, 'SIGTERM');
    });
  } else {
    logger.log('warn', 'worker.temporal_off', { message: t('worker.start.temporal_off') });
  }

  const loop = new PollerLoop({
    listProjects: () => db.system.listPollableProjects(),
    intervalSeconds: async (project) => {
      const scope = db.forTenant(project.tenantId);
      const { config } = await loadEffectiveConfig(scope.projectConfigs, project.projectId);
      return config.github.poll_interval_seconds;
    },
    poll: (group) =>
      pollRepository(
        {
          db,
          gitHost,
          registry,
          logger,
          maxReplyAttempts: settings.maxReplyAttempts,
          maxEventAttempts: settings.maxEventAttempts,
          intentSignals: signals,
        },
        group,
      ),
    now: () => Date.now(),
    logger,
    maxConcurrentPolls: settings.maxConcurrentPolls,
    heartbeat: () => fs.writeFileSync(settings.heartbeatFile, ''),
  });
  loop.start(settings.tickMs);
  // The escalation clocks (B11, ADR-M28): state in PostgreSQL, no Temporal timers.
  const escalations = new EscalationLoop({
    listDue: (now, limit) => db.system.listDueEscalations(now, limit),
    advance: (due, now) => advanceEscalation(db.forTenant(due.tenantId), due.escalationId, now),
    now: () => new Date(),
    logger,
    batchSize: settings.escalationBatch,
  });
  escalations.start(settings.escalationTickMs);
  // The scheduled spend sync (C12, ADR-M24 §2.5): needs the Cost Controller, so the cost AppRole.
  const costSync = workerRuns
    ? new CostSyncLoop({
        sync: (range) => workerRuns.costController.syncSpend(range),
        earliestStartOfRunsEndedSince: (since) => db.system.earliestStartOfRunsEndedSince(since),
        withLock: (fn) => db.system.withSpendSyncLock(fn),
        now: () => new Date(),
        logger,
        settings: settings.costSync,
      })
    : undefined;
  if (costSync) costSync.start();
  else logger.log('warn', 'worker.cost_sync_off', { message: t('worker.start.cost_sync_off') });
  // The evaluation loop (L04, ADR-M81 §2.8): hands queued evaluation runs to the runner. It needs
  // the Cost Controller (keys, spend) and Temporal (one workflow per run attempt).
  const evaluations =
    workerRuns && temporal
      ? new EvaluationLoop({
          listTenants: (limit) => db.system.listTenantsWithOpenEvaluations(limit),
          forTenant: (tenantId) => db.forTenant(tenantId),
          prepare: (scope, evaluationRunId) =>
            prepareEvaluationRun(
              scope,
              {
                signer: workerRuns.runs.signer,
                costController: workerRuns.costController,
                gitHost,
                wrapper: workerRuns.runs.wrapper,
                models: workerRuns.models,
                policyFactory: (config, models) => createSimplePolicyEngine({ config, models }),
                egressAllowlist: workerRuns.runs.egressAllowlist,
              },
              evaluationRunId,
            ),
          dispatcher: new TemporalEvaluationDispatcher(temporal.client),
          logger,
          maxInFlight: settings.evaluation.maxInFlight,
        })
      : undefined;
  evaluations?.start(settings.evaluation.tickMs);
  // The check of a project's evaluation tasks (L07, ADR-M85 §2.5): a registered task goes to the
  // runner's evaluation queue with a signed contract and a single-repository read token.
  const taskChecks =
    workerRuns && temporal && gitHost
      ? new TaskCheckLoop({
          listTenants: (limit) => db.system.listTenantsWithTasksToCheck(limit),
          forTenant: (tenantId) => db.forTenant(tenantId),
          prepare: (scope, evaluationTaskId) =>
            prepareTaskCheck(
              scope,
              { signer: workerRuns.runs.signer, gitHost, wrapper: workerRuns.runs.wrapper },
              evaluationTaskId,
            ),
          dispatcher: new TemporalTaskCheckDispatcher(temporal.client),
          logger,
          maxInFlight: settings.evaluation.maxInFlight,
        })
      : undefined;
  taskChecks?.start(settings.evaluation.tickMs);
  // The evaluation plan loop (L05, ADR-M82 §2.4): Run now requests, schedules, `on_change`.
  const taskSets = taskSetReader(settings.evaluation.tasksDir);
  const plans = workerRuns
    ? new EvaluationPlanLoop({
        listTenants: (now, limit) => db.system.listTenantsWithPlanWork(now, limit),
        forTenant: (tenantId) => db.forTenant(tenantId),
        advance: (scope, planId) =>
          advanceEvaluationPlan(
            scope,
            {
              policyFactory: (config, models) => createSimplePolicyEngine({ config, models }),
              models: workerRuns.models,
              taskSet: taskSets,
              gitHost,
            },
            planId,
          ),
        now: () => new Date(),
        logger,
      })
    : undefined;
  plans?.start(settings.evaluation.tickMs);
  // Evidence retention (E05, ADR-M51): its own SeaweedFS identity `worker-purge`.
  const retentionStore = await openRetentionStore(settings.retention, secrets, logger);
  // Pack IDs found without a row, kept across passes: deleted only when seen twice.
  const orphanSuspects = new Set<string>();
  // The daily audit anchor (E05 PR 2, ADR-M51 §2.9): its own identity `worker-anchor`, in the
  // same loop, before the retention steps. The loop runs with either identity.
  const anchorStore = await openAnchorStore(settings.anchor, secrets, logger);
  // Tenant ID → the UTC date it was anchored and checked: once per tenant and day per process.
  const anchoredOn = new Map<string, string>();
  // The Langfuse purge (E08, ADR-M53), a step of the retention pass: its own entry
  // `kv/worker/langfuse`. The compaction state lives as long as the process.
  const langfuse = await openLangfusePurge(
    settings.langfuse,
    secrets,
    logger,
    { maskOwed: false, maskedOn: null },
    {
      percent: settings.retention?.guardPercent ?? 20,
      floor: settings.retention?.guardFloor ?? 20,
    },
  );
  const retentionSettings = retentionStore ? settings.retention : null;
  // O04 (ADR-M103): housekeeping of the session tables needs only the database, so the loop also
  // runs for it alone.
  const housekeeping = settings.housekeeping;
  const loopIntervalMs =
    retentionSettings?.intervalMs ?? settings.anchor?.intervalMs ?? housekeeping?.intervalMs;
  const retention =
    loopIntervalMs !== undefined && (retentionSettings || anchorStore || housekeeping)
      ? new RetentionLoop({
          ...(anchorStore
            ? {
                anchor: () =>
                  runAnchorPass({
                    db,
                    store: anchorStore,
                    logger,
                    now: () => new Date(),
                    anchoredOn,
                  }),
              }
            : {}),
          ...(retentionSettings && retentionStore
            ? {
                clientPurge: () =>
                  runClientPurgePass({
                    db,
                    store: retentionStore,
                    logger,
                    now: () => new Date(),
                    langfuse: langfuse.deps,
                    ...(knowledge?.deps?.store
                      ? {
                          knowledge: {
                            store: knowledge.deps.store,
                            ...(knowledge.code?.store ? { codeStore: knowledge.code.store } : {}),
                          },
                        }
                      : {}),
                    settings: {
                      mode: retentionSettings.mode,
                      bucket: retentionSettings.bucket,
                      batch: retentionSettings.batch,
                      graceDays: retentionSettings.clientDeletionGraceDays,
                    },
                  }),
                pass: (orphanCursor: string | null) =>
                  runRetentionPass(
                    {
                      db,
                      store: retentionStore,
                      logger,
                      now: () => new Date(),
                      orphanSuspects,
                      langfuse: langfuse.deps,
                      // X04 PR 3a (ADR-M89 §2.4): the versions of the document indexes.
                      ...(knowledge?.deps?.store
                        ? {
                            knowledge: {
                              store: knowledge.deps.store,
                              ...(knowledge.code?.store ? { codeStore: knowledge.code.store } : {}),
                            },
                          }
                        : {}),
                      settings: {
                        mode: retentionSettings.mode,
                        bucket: retentionSettings.bucket,
                        batch: retentionSettings.batch,
                        guardPercent: retentionSettings.guardPercent,
                        guardFloor: retentionSettings.guardFloor,
                        archiveGraceDays: retentionSettings.archiveGraceDays,
                        orphanGraceHours: retentionSettings.orphanGraceHours,
                      },
                    },
                    orphanCursor,
                  ),
              }
            : {}),
          ...(housekeeping
            ? {
                housekeeping: () =>
                  runHousekeepingPass({
                    db,
                    logger,
                    now: () => new Date(),
                    settings: {
                      mode: housekeeping.mode,
                      sessionDays: housekeeping.sessionDays,
                      challengeHours: housekeeping.challengeHours,
                    },
                  }),
                housekeepingMode: housekeeping.mode,
              }
            : {}),
          withLock: (fn) => db.system.withRetentionLock(fn),
          logger,
          mode: retentionSettings?.mode ?? 'report',
          intervalMs: loopIntervalMs,
        })
      : undefined;
  retention?.start();
  const reconcile = settings.temporal
    ? new ReconcileLoop({
        listOpen: (limit, after) => db.system.listOpenIntents(limit, after),
        listKilling: (limit) => db.system.listKillingIntents(limit),
        signals,
        logger,
        batchSize: settings.reconcileBatch,
      })
    : undefined;
  reconcile?.start(settings.reconcileMs);
  logger.log('info', 'worker.started', {
    tick_ms: settings.tickMs,
    escalation_tick_ms: settings.escalationTickMs,
    tracing: tracing !== undefined,
  });

  const shutdown = (): void => {
    void Promise.all([
      loop.stop(),
      escalations.stop(),
      reconcile?.stop(),
      costSync?.stop(),
      evaluations?.stop(),
      taskChecks?.stop(),
      plans?.stop(),
      retention?.stop(),
      intentWorker?.shutdown(),
    ])
      .then(() => {
        retentionStore?.destroy();
        anchorStore?.destroy();
        langfuse.destroy();
      })
      .then(() =>
        Promise.all([
          db.close(),
          openbao.close(),
          temporal?.close(),
          workerRuns?.close(),
          knowledge?.close(),
          tracing?.shutdown(),
        ]),
      )
      .then(() => logger.log('info', 'worker.stopped', {}));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

/** Catalog text for the known errors; only the error name otherwise (no library text). */
function failureReason(error: unknown): string {
  if (error instanceof SettingsError) return t(error.key, { name: error.setting });
  // Both messages come from the catalog and hold safe parameters only.
  if (error instanceof SecretsError) return error.message;
  if (error instanceof GitHostError) return gitHostErrorMessage(error);
  return error instanceof Error ? error.name : 'unexpected';
}

main().catch((error: unknown) => {
  const reason = failureReason(error);
  logger.log('error', 'worker.failed', { message: t('worker.failed', { reason }) });
  process.exitCode = 1;
});
