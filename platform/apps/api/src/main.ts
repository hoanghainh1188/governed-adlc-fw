#!/usr/bin/env node
// Entry point of the api process (task B03, ADR-M26 section 2.6). Settings from the environment;
// the database password from OpenBao (AppRole `api`), or a URL in dev mode.
// Tracing starts first (A08, ADR-M35): `./telemetry.js` must stay the first import.
import { SERVICE_NAME, tracing, tracingEndpointValid } from './telemetry.js';

import 'reflect-metadata';

import { GitHubAdapter, GitHubSignIn } from '@sdlc/adapter-git-github';
import { checkStoredConfigsAtStart, SPEC_MAX_BYTES } from '@sdlc/core';
import { t } from '@sdlc/messages';
import { OpenBaoClient } from '@sdlc/secrets';
import { OTEL_ENDPOINT_ENV } from '@sdlc/telemetry';
import { connectTemporal, TemporalIntentSignals } from '@sdlc/workflow-client';

import { createApp } from './app.js';
import { loadDashboardFiles } from './dashboard/static.js';
import { connectDatabase } from './database.js';
import { openEvidenceStore } from './evidence/store.js';
import { createApiLogger, NestJsonLogger } from './observability/logging.js';
import { loadSettings, SettingsError } from './settings.js';

const log = createApiLogger();

async function main(): Promise<void> {
  if (!tracingEndpointValid) throw new SettingsError('api.settings.invalid', OTEL_ENDPOINT_ENV);
  const settings = loadSettings(process.env);
  if (settings.database.kind === 'dev_url') {
    log.log('warn', 'api.dev_mode', { message: t('api.start.dev_mode') });
  }
  // Outside dev mode OpenBao stays open: the GitHub adapter of the spec endpoints (B08) reads
  // the App key again every 10 minutes (ADR-M23 §2.2).
  const openbao =
    settings.database.kind === 'openbao' ? OpenBaoClient.fromEnv(process.env, log) : undefined;
  await openbao?.assertReady();
  const secrets = openbao?.kv();
  const db = await connectDatabase(settings, secrets, log);
  const gitHost = secrets
    ? new GitHubAdapter({
        secrets,
        apiUrl: settings.githubApiUrl,
        logger: log,
        // The api reads spec files only: never download more than a spec may be (ADR-M39 §2.3).
        maxFileBytes: SPEC_MAX_BYTES,
      })
    : undefined;
  if (!gitHost) log.log('warn', 'api.git_host_off', { message: t('api.start.git_host_off') });
  // The Evidence Pack store (E02, ADR-M48); undefined: the pack endpoints answer 503.
  const evidence = await openEvidenceStore(settings.evidence, secrets, log);
  // Stored configurations after a change of platform defaults (B13 AC8, ADR-M37 §2.5).
  await checkStoredConfigsAtStart(db, log);
  // Wakes the intent workflow after a change (B07, ADR-M30).
  const temporal = settings.temporal ? await connectTemporal(settings.temporal) : undefined;
  if (!temporal) log.log('warn', 'api.temporal_off', { message: t('api.start.temporal_off') });
  // The read-only dashboard (U01, ADR-M54): fails the start when the folder is wrong.
  const dashboard = settings.dashboardDir
    ? await loadDashboardFiles(settings.dashboardDir)
    : undefined;
  if (!dashboard) log.log('info', 'api.dashboard_off', { message: t('api.start.dashboard_off') });
  // Dashboard sign-in with GitHub (U05, ADR-M73 §2.2): needs OpenBao for the App's client secret
  // (`kv/api/github-oauth`), so it stays off in dev mode.
  const webSignIn =
    settings.webSignIn && secrets
      ? {
          settings: settings.webSignIn,
          provider: new GitHubSignIn({
            secrets,
            oauthSecretPath: settings.webSignIn.oauthSecretPath,
            webUrl: settings.webSignIn.githubWebUrl,
            apiUrl: settings.webSignIn.githubApiUrl,
          }),
        }
      : undefined;
  if (settings.webSignIn && !webSignIn) {
    log.log('warn', 'api.web_signin_off', { message: t('api.start.web_signin_dev_mode') });
  }
  const app = await createApp({
    db,
    settings,
    log,
    nestLogger: new NestJsonLogger(log),
    ...(gitHost ? { gitHost, evalTaskGitHost: gitHost, memoryGitHost: gitHost } : {}),
    ...(evidence ? { evidence } : {}),
    ...(dashboard ? { dashboard } : {}),
    ...(webSignIn ? { webSignIn } : {}),
    ...(temporal ? { intentSignals: new TemporalIntentSignals(temporal.client) } : {}),
  });
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onClose', async () => {
      await temporal?.close();
      await db.close();
      evidence?.store.destroy();
      await openbao?.close();
      await tracing?.shutdown();
    });
  await app.listen({ host: settings.host, port: settings.port });
  log.log('info', 'api.started', {
    message: t('api.start.listening', { host: settings.host, port: settings.port }),
    service: SERVICE_NAME,
    tracing: tracing !== undefined,
  });
}

main().catch((error: unknown) => {
  const reason =
    error instanceof SettingsError
      ? t(error.key, { name: error.setting })
      : error instanceof Error
        ? error.message
        : String(error);
  log.log('error', 'api.start_failed', { message: t('api.start.failed', { reason }) });
  process.exitCode = 1;
});
