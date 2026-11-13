#!/usr/bin/env node
// Entry point of the runner process (D-03 §5.1, ADR-M25). Settings from the environment; the
// database password from OpenBao (AppRole `runner`); Docker through the socket proxy.
//
// At start the runner cleans up after the previous process, then sweeps at the configured
// interval and writes a heartbeat file after each clean-up (the container health check reads it).
// Runs reach it through the Temporal task queue `sdlc-runner` (C06 session 2, QUESTIONS #53):
// one activity slot per sandbox (`SDLC_RUNNER_MAX_SANDBOXES`), so extra runs wait in Temporal.
import fs from 'node:fs';

import { OpenCodeAdapter } from '@sdlc/adapter-agent-opencode';
import { OpenHandsAdapter } from '@sdlc/adapter-agent-openhands';
import { S3EvidenceStore } from '@sdlc/adapter-evidence-s3';
import { GitHubAdapter } from '@sdlc/adapter-git-github';
import { LiteLLMKeySpendReader } from '@sdlc/adapter-model-litellm';
import { createJsonLogger, logIdleDbErrors, PlatformDatabase, withLogContext } from '@sdlc/core';
import { t } from '@sdlc/messages';
import { OpenBaoClient, SecretsError } from '@sdlc/secrets';
import { activityTracingInterceptor } from '@sdlc/telemetry';

import { EVALUATION_RUNNER_TASK_QUEUE, RUNNER_TASK_QUEUE } from '@sdlc/contracts';
import { NativeConnection, Worker } from '@temporalio/worker';

import { createRunnerActivities } from './activities.js';
import { createEvaluationActivities } from './evaluation/activities.js';
import { DockerClient } from './docker/client.js';
import { assertEngineRuntime } from './docker/runtime.js';
import { RunnerError } from './errors.js';
import {
  DB_PASSWORD_FIELD,
  DB_USER,
  EVIDENCE_ACCESS_KEY_FIELD,
  EVIDENCE_DIFF_KEY_PREFIX,
  EVIDENCE_KEY_PREFIX,
  EVIDENCE_SECRET_KEY_FIELD,
  processSettingsFromEnv,
} from './process.js';
import { Runner } from './runner.js';
import { runnerSettingsFromEnv } from './settings.js';

const APPLICATION_NAME = 'sdlc-runner';

/**
 * JSON lines on stderr (the platform logger, A08, ADR-M35): codes and counts only, never a secret,
 * a path or a Docker message. Lines inside a run's activity carry its tenant_id and run_id.
 */
const logger = createJsonLogger({ write: (line) => process.stderr.write(line) });

function log(
  level: 'info' | 'warn' | 'error',
  event: string,
  message: string,
  fields: Record<string, number> = {},
): void {
  logger.log(level, event, { message, ...fields });
}

async function connectDatabase(
  openbao: OpenBaoClient,
  db: ReturnType<typeof processSettingsFromEnv>['db'],
): Promise<PlatformDatabase> {
  const entry = await openbao.kv().read(db.secretPath);
  const password = entry.data[DB_PASSWORD_FIELD];
  if (!password) throw new RunnerError('runner.start.no_db_password');
  const url = new URL(`postgres://${db.host}:${String(db.port)}/${db.name}`);
  url.username = DB_USER;
  url.password = password.reveal();
  return PlatformDatabase.connect({
    connectionString: url.toString(),
    applicationName: APPLICATION_NAME,
    onIdleError: logIdleDbErrors(logger),
  });
}

/**
 * The evidence stores of L1 proposals (C06 session 2b, ADR-M33 §2.9) and run diffs (C07, ADR-M34
 * §2.2), with the runner's SeaweedFS credential from OpenBao (`kv/runner/evidence`): write under
 * `proposals/` and `diffs/`, read under `diffs/` only (C08, QUESTIONS #155). Without it the runner still starts; an
 * L1 run that finishes then fails (`proposal_unavailable`) and the intent is paused.
 */
async function evidenceStores(
  openbao: OpenBaoClient,
  evidence: ReturnType<typeof processSettingsFromEnv>['evidence'],
): Promise<{ proposals: S3EvidenceStore; diffs: S3EvidenceStore } | undefined> {
  if (!evidence) {
    log('warn', 'runner.evidence_off', t('runner.start.evidence_off'));
    return undefined;
  }
  let entry;
  try {
    entry = await openbao.kv().read(evidence.secretPath);
  } catch (error) {
    if (!(error instanceof SecretsError) || error.key !== 'secrets.not_found') throw error;
    log('warn', 'runner.evidence_missing', t('runner.start.evidence_missing'));
    return undefined;
  }
  const accessKeyId = entry.data[EVIDENCE_ACCESS_KEY_FIELD];
  const secretAccessKey = entry.data[EVIDENCE_SECRET_KEY_FIELD];
  if (!accessKeyId || !secretAccessKey) {
    log('warn', 'runner.evidence_missing', t('runner.start.evidence_missing'));
    return undefined;
  }
  // One credential, two key prefixes: L1 proposals (C06 2b) and run diffs (C07, ADR-M34 §2.2).
  const store = (keyPrefix: string) =>
    new S3EvidenceStore({
      endpoint: evidence.url,
      bucket: evidence.bucket,
      keyPrefix,
      accessKeyId,
      secretAccessKey,
    });
  return { proposals: store(EVIDENCE_KEY_PREFIX), diffs: store(EVIDENCE_DIFF_KEY_PREFIX) };
}

async function main(): Promise<void> {
  const settings = runnerSettingsFromEnv(process.env);
  const proc = processSettingsFromEnv(process.env);
  const openbao = OpenBaoClient.fromEnv(process.env, logger);
  await openbao.assertReady();
  const db = await connectDatabase(openbao, proc.db);
  const docker = new DockerClient({
    socketPath: settings.dockerSocket,
    ...(settings.sandboxRuntime ? { sandboxRuntime: settings.sandboxRuntime } : {}),
  });
  await docker.ping();
  await assertEngineRuntime(docker, settings.sandboxRuntime);
  const evidence = await evidenceStores(openbao, proc.evidence);
  // The runner reads its runs' spend with each run's own key (C07, ADR-M34 §2.6).
  const spendReader = new LiteLLMKeySpendReader({ baseUrl: settings.agent.llmBaseUrl });
  // The agent adapters of this process, by code (X03, ADR-M88): one instance each, shared by the
  // runs and the evaluations, because the OpenCode adapter keeps each run's cap and fingerprint.
  const adapters = { openhands: new OpenHandsAdapter(), opencode: new OpenCodeAdapter() };
  // Revokes the run's GitHub tokens right after their use (C11, ADR-M42 §2.4). Token-only: the
  // runner never reads the GitHub App key (QUESTIONS #44), so every App call is refused.
  const tokenRevoker = proc.githubApiUrl
    ? new GitHubAdapter({
        apiUrl: proc.githubApiUrl,
        secrets: {
          read: () => Promise.reject(new Error('the runner holds no GitHub App key')),
        },
      })
    : undefined;

  const beat = () =>
    fs.writeFileSync(proc.heartbeatFile, new Date().toISOString(), { mode: 0o600 });
  const runner = new Runner(
    {
      db,
      docker,
      settings,
      verifier: openbao.transit(),
      unwrapper: openbao.wrapping(),
      // E01 PR 2: the same token-only adapter reads a request's feedback with the run's token.
      ...(tokenRevoker ? { tokenRevoker, feedbackReader: tokenRevoker } : {}),
    },
    {
      onCleanUp: (kind, result) => {
        beat();
        if (result.runs > 0 || result.errors > 0) {
          log(
            result.errors > 0 ? 'warn' : 'info',
            `runner.clean_up.${kind}`,
            t('runner.start.cleaned_up', {
              runs: result.runs,
              failed: result.failedRuns,
              errors: result.errors,
            }),
            { runs: result.runs, failed_runs: result.failedRuns, errors: result.errors },
          );
        }
      },
      onSweepError: (error) =>
        log(
          'warn',
          'runner.sweep_failed',
          t('runner.start.sweep_failed', {
            reason: error instanceof RunnerError ? error.key : 'unknown',
          }),
        ),
    },
    {
      adapters,
      spendReader,
      keyRevoked: (key) => spendReader.keyRevoked(key),
      ...(evidence ? { evidence: evidence.proposals, diffEvidence: evidence.diffs } : {}),
    },
  );
  await runner.start();

  // The task queue `sdlc-runner` (C06 session 2, ADR-M33 §2.6), and `sdlc-runner-eval` for
  // evaluation runs (L04, ADR-M81 §2.3).
  let temporal:
    | {
        connection: NativeConnection;
        worker: Worker;
        running: Promise<void>;
        evaluation?: { worker: Worker; running: Promise<void> };
      }
    | undefined;
  if (proc.temporal) {
    const connection = await NativeConnection.connect({ address: proc.temporal.address });
    const worker = await Worker.create({
      connection,
      namespace: proc.temporal.namespace,
      taskQueue: RUNNER_TASK_QUEUE,
      activities: {
        ...createRunnerActivities({
          db,
          runner,
          unwrapper: openbao.wrapping(),
          logger,
          // C08 (ADR-M38 §2.2): the push reads the run's diff back (`Read:evidence/diffs/*`).
          publish: {
            settings,
            ...(evidence ? { diffEvidence: evidence.diffs } : {}),
            ...(tokenRevoker ? { tokenRevoker } : {}),
          },
        }),
      },
      // The log context (tenant, run) of each activity (A08, ADR-M35 §2.6). No runner traces yet.
      interceptors: { activity: [activityTracingInterceptor({ withLogContext })] },
      maxConcurrentActivityTaskExecutions: settings.maxSandboxes,
    });
    const running = worker.run();
    // A failed Temporal worker stops the process; Compose restarts it (its clean-up then runs).
    running.catch(() => {
      log('error', 'runner.temporal_failed', t('runner.start.temporal_failed'));
      process.exitCode = 1;
      process.kill(process.pid, 'SIGTERM');
    });
    // Evaluation runs: their own queue and slots, never a slot of a real run (QUESTIONS #461).
    let evaluation: { worker: Worker; running: Promise<void> } | undefined;
    if (settings.maxEvalSandboxes > 0) {
      const evalWorker = await Worker.create({
        connection,
        namespace: proc.temporal.namespace,
        taskQueue: EVALUATION_RUNNER_TASK_QUEUE,
        activities: {
          ...createEvaluationActivities({
            logger,
            execute: {
              db,
              docker,
              settings,
              verifier: openbao.transit(),
              unwrapper: openbao.wrapping(),
              pool: runner.pool,
              held: runner.held,
              adapters,
              spendReader,
              ...(tokenRevoker ? { tokenRevoker } : {}),
            },
          }),
        },
        interceptors: { activity: [activityTracingInterceptor({ withLogContext })] },
        maxConcurrentActivityTaskExecutions: settings.maxEvalSandboxes,
        // A cancel (the evaluation ended, its budget is used up) reaches the agent on the next
        // heartbeat: send heartbeats at least every 5 seconds, not every minute (ADR-M81 §2.8).
        maxHeartbeatThrottleInterval: '5s',
        defaultHeartbeatThrottleInterval: '5s',
      });
      const evalRunning = evalWorker.run();
      evalRunning.catch(() => {
        log('error', 'runner.temporal_failed', t('runner.start.temporal_failed'));
        process.exitCode = 1;
        process.kill(process.pid, 'SIGTERM');
      });
      evaluation = { worker: evalWorker, running: evalRunning };
    }
    temporal = { connection, worker, running, ...(evaluation ? { evaluation } : {}) };
  } else {
    log('warn', 'runner.temporal_off', t('runner.start.temporal_off'));
  }
  log(
    'info',
    'runner.started',
    t('runner.start.ready', {
      instance: settings.instance,
      max: settings.maxSandboxes,
    }),
  );

  const shutdown = () => {
    if (temporal?.worker.getState() === 'RUNNING') temporal.worker.shutdown();
    if (temporal?.evaluation?.worker.getState() === 'RUNNING')
      temporal.evaluation.worker.shutdown();
    void Promise.all([
      temporal?.running.catch(() => undefined),
      temporal?.evaluation?.running.catch(() => undefined),
    ])
      .then(() => temporal?.connection.close())
      .then(() => runner.stop())
      .then(() => {
        evidence?.proposals.destroy();
        evidence?.diffs.destroy();
      })
      .then(() => Promise.all([db.close(), openbao.close()]))
      .finally(() => process.exit(0));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

main().catch((error: unknown) => {
  const reason =
    error instanceof RunnerError ? error.message : error instanceof Error ? error.name : 'unknown';
  log('error', 'runner.start_failed', t('runner.start.failed', { reason }));
  process.exitCode = 1;
});
