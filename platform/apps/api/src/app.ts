// Builds the Nest application (task B03, ADR-M26). `main.ts` runs it; tests build it with their
// own database and clock and call it through Fastify `inject()`, without opening a port.
import { Logger, Module, type DynamicModule, type LoggerService } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, NestFactory, Reflector } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { createSimplePolicyEngine } from '@sdlc/adapter-policy-simple';
import type {
  EvidenceStore,
  GitHostAdapter,
  IntentWorkflowSignals,
  WebSignInProvider,
} from '@sdlc/contracts';
import {
  Registry,
  type EvaluationTaskGitHost,
  type PlatformDatabase,
  type PlatformLogger,
  type LessonGitHost,
} from '@sdlc/core';
import { NO_INTENT_SIGNALS } from '@sdlc/workflow-client';

import { AdminAgentsController } from './admin/agents.controller.js';
import { AdminStepUp } from './admin/step-up.js';
import { AdminToolsController } from './admin/tools.controller.js';
import { AdminAuditController } from './admin/audit.controller.js';
import { AdminProjectsController } from './admin/projects.controller.js';
import { AdminTenantAdminsController } from './admin/tenant-admins.controller.js';
import { AdminUsersController } from './admin/users.controller.js';
import { AiRecordsController } from './ai-records/ai-records.controller.js';
import { AiRecordsService } from './ai-records/ai-records.service.js';
import {
  EvalPlansController,
  EvaluationsController,
  ProjectEvalPlansController,
} from './evaluations/evaluations.controller.js';
import { EvaluationsService } from './evaluations/evaluations.service.js';
import { EvalTasksController, ProjectEvalTasksController } from './evaluations/tasks.controller.js';
import { EvaluationTasksService } from './evaluations/tasks.service.js';
import { AuthGuard } from './auth/auth.guard.js';
import { OAuthStates } from './auth/oauth-states.js';
import { RateLimiter } from './auth/rate-limiter.js';
import {
  SIGN_IN_CALLBACKS_PER_MINUTE,
  SIGN_IN_STARTS_PER_MINUTE,
  SignInController,
  type SignInEndpoints,
} from './auth/sign-in.controller.js';
import { SignInService } from './auth/sign-in.service.js';
import {
  PASSKEY_REQUESTS_PER_MINUTE,
  PasskeysController,
  type PasskeyEndpoints,
} from './passkeys/passkeys.controller.js';
import { PasskeysService } from './passkeys/passkeys.service.js';
import { WebAuthnCeremonies } from './passkeys/webauthn.js';
import { ErrorFilter } from './errors/error.filter.js';
import { EscalationsController } from './escalations/escalations.controller.js';
import { EvidenceController } from './evidence/evidence.controller.js';
import { ProposalController } from './evidence/proposal.controller.js';
import { EvidenceHoldsController } from './evidence/holds.controller.js';
import { EvidenceService } from './evidence/evidence.service.js';
import { EscalationsService } from './escalations/escalations.service.js';
import { HealthController } from './health/health.controller.js';
import { IntentsController } from './intents/intents.controller.js';
import { IntentsService } from './intents/intents.service.js';
import { ClientDataDeletionController } from './client-data/deletion.controller.js';
import { MeController } from './me/me.controller.js';
import { MeTokensController } from './me/tokens.controller.js';
import { MemoryController } from './memory/memory.controller.js';
import { MemoryService } from './memory/memory.service.js';
import { LessonsController } from './lessons/lessons.controller.js';
import { LessonsService } from './lessons/lessons.service.js';
import { PlansController } from './plans/plans.controller.js';
import { PlansService } from './plans/plans.service.js';
import { CostController } from './cost/cost.controller.js';
import { CostService } from './cost/cost.service.js';
import { MetricsController } from './metrics/metrics.controller.js';
import { MetricsService } from './metrics/metrics.service.js';
import { RunsController } from './runs/runs.controller.js';
import { RunsService } from './runs/runs.service.js';
import { SpecsController } from './specs/specs.controller.js';
import { SpecsService } from './specs/specs.service.js';
import { registerDashboard, type DashboardFiles, type RouteHost } from './dashboard/static.js';
import { LogContextInterceptor } from './observability/log-context.interceptor.js';
import { createApiLogger } from './observability/logging.js';
import type { ApiSettings, WebSignInSettings } from './settings.js';
import {
  AI_RECORDS,
  CLOCK,
  DATABASE,
  ESCALATIONS,
  EVIDENCE,
  INTENTS,
  PLANS,
  MEMORY,
  LESSONS,
  RUNS,
  COST,
  METRICS,
  REGISTRY,
  SETTINGS,
  PASSKEYS,
  ADMIN_STEP_UP,
  SIGN_IN,
  SPECS,
  EVALUATIONS,
  EVAL_TASKS,
} from './tokens.js';

/** Largest accepted request body. Intents carry at most ~10 kB of text. */
const BODY_LIMIT_BYTES = 64 * 1024;

export interface ApiDeps {
  readonly db: PlatformDatabase;
  readonly settings: Pick<ApiSettings, 'rateLimitPerMinute' | 'authFailuresPerMinute'> &
    Partial<Pick<ApiSettings, 'trustedProxy'>>;
  /** Default: the system clock. */
  readonly now?: () => Date;
  /** Unexpected errors. Default: Nest's logger. Tests pass their own to check that no token is logged. */
  readonly logger?: Pick<Logger, 'error'>;
  /** The platform logger (A08, ADR-M35). Default: JSON lines on stdout. */
  readonly log?: PlatformLogger;
  /** Nest's own messages. Default: Nest's console logger, warnings and errors only. */
  readonly nestLogger?: LoggerService;
  /**
   * Wakes the intent workflow after a change (B07, ADR-M30). Default: no signals; the worker's
   * reconcile loop then catches up.
   */
  readonly intentSignals?: IntentWorkflowSignals;
  /**
   * The Git host the spec and plan endpoints read (B08, ADR-M39 §2.2; B09, ADR-M40 §2.3).
   * Undefined (dev mode without OpenBao): linking a spec or submitting a plan answers
   * `git_host_unavailable`.
   */
  readonly gitHost?: Pick<GitHostAdapter, 'getBranchHead' | 'getFileAtCommit'>;
  /**
   * X08a (ADR-M109 §2.1): builds the web addresses of an intent's `links` (no Git host call).
   * Undefined: the links hold their codes and numbers, without a `url`.
   */
  readonly webLinks?: Pick<GitHostAdapter, 'webUrl'>;
  /**
   * The Git host reads of `adlc memory approve` (X13, ADR-M74 §2.3): the default branch's head,
   * the memory folder and the commits that changed it. Undefined: approving answers
   * `git_host_unavailable`.
   */
  readonly memoryGitHost?: Pick<GitHostAdapter, 'getBranchHead' | 'listFolder' | 'listPathCommits'>;
  /**
   * The Git host reads of `adlc lesson add` (X08b PR 2, ADR-M109 §2.3, QUESTIONS #729): the
   * comment's address and the comment itself, with a read token used once. Undefined: adding a
   * lesson answers `git_host_unavailable`.
   */
  readonly lessonGitHost?: LessonGitHost['gitHost'];
  /**
   * The Git host reads of a project's evaluation tasks (L07, ADR-M85): the merged pull request,
   * commit parents, comparisons and commit authors. Undefined: the task endpoints answer
   * `git_host_unavailable` (list excepted).
   */
  readonly evalTaskGitHost?: EvaluationTaskGitHost;
  /**
   * The evidence store of the Evidence Pack endpoints (E02, ADR-M48), with the api's identity
   * `api-evidence`. Undefined (no credential, or dev mode without OpenBao): building or reading a
   * pack file answers `evidence_unavailable`.
   */
  readonly evidence?: { readonly store: EvidenceStore; readonly maxItemBytes: number };
  /**
   * The read-only dashboard's built files (U01, ADR-M54), served under `/dashboard/`. Undefined
   * (`SDLC_API_DASHBOARD_DIR=off`): no dashboard routes.
   */
  readonly dashboard?: DashboardFiles;
  /**
   * Dashboard sign-in with GitHub (U05, ADR-M73 §2.2): the settings and the GitHub App's OAuth
   * client. Undefined (`SDLC_API_WEB_SIGNIN=off`): no sign-in, session cookies are ignored.
   */
  readonly webSignIn?: {
    readonly settings: WebSignInSettings;
    readonly provider: WebSignInProvider;
    /**
     * Starts, callbacks and passkey requests per address and minute. Default 20, 30 and 30;
     * tests raise them.
     */
    readonly limits?: {
      readonly starts: number;
      readonly callbacks: number;
      readonly passkeys?: number;
    };
  };
}

@Module({})
class ApiModule {
  static create(deps: ApiDeps): DynamicModule {
    const now = deps.now ?? (() => new Date());
    const signals = deps.intentSignals ?? NO_INTENT_SIGNALS;
    const wakeLogger = deps.log ?? createApiLogger();
    const signIn: SignInEndpoints | undefined = deps.webSignIn && {
      service: new SignInService({
        db: deps.db,
        provider: deps.webSignIn.provider,
        states: new OAuthStates(() => now().getTime()),
        settings: deps.webSignIn.settings,
        now,
        log: wakeLogger,
      }),
      starts: new RateLimiter(deps.webSignIn.limits?.starts ?? SIGN_IN_STARTS_PER_MINUTE),
      callbacks: new RateLimiter(deps.webSignIn.limits?.callbacks ?? SIGN_IN_CALLBACKS_PER_MINUTE),
      actions: deps.webSignIn.settings.actions === true,
    };
    // U06 (ADR-M73 §2.4): passkeys need a session, so the ceremonies exist with sign-in only.
    const passkeys: PasskeyEndpoints = {
      service: new PasskeysService({
        ceremonies: deps.webSignIn
          ? new WebAuthnCeremonies(deps.webSignIn.settings.publicOrigin)
          : undefined,
        now,
        log: wakeLogger,
      }),
      perAddress: new RateLimiter(deps.webSignIn?.limits?.passkeys ?? PASSKEY_REQUESTS_PER_MINUTE),
    };
    return {
      module: ApiModule,
      controllers: [
        HealthController,
        SignInController,
        PasskeysController,
        MeController,
        IntentsController,
        SpecsController,
        PlansController,
        RunsController,
        CostController,
        MetricsController,
        EvidenceController,
        ProposalController,
        EvidenceHoldsController,
        EscalationsController,
        AiRecordsController,
        MemoryController,
        LessonsController,
        ProjectEvalPlansController,
        EvalPlansController,
        EvaluationsController,
        ProjectEvalTasksController,
        EvalTasksController,
        AdminProjectsController,
        AdminUsersController,
        AdminTenantAdminsController,
        AdminAuditController,
        AdminAgentsController,
        AdminToolsController,
        MeTokensController,
        ClientDataDeletionController,
      ],
      providers: [
        { provide: DATABASE, useValue: deps.db },
        { provide: SETTINGS, useValue: deps.settings },
        { provide: CLOCK, useValue: now },
        { provide: SIGN_IN, useValue: signIn },
        { provide: PASSKEYS, useValue: passkeys },
        // U09 (ADR-M73 §2.4b): the passkey step-up of an administration change from a session.
        { provide: ADMIN_STEP_UP, useValue: new AdminStepUp(passkeys.service, now) },
        {
          provide: REGISTRY,
          useValue: new Registry({
            policyFactory: (config) => createSimplePolicyEngine({ config }),
            now,
          }),
        },
        {
          provide: INTENTS,
          useFactory: (registry: Registry) =>
            new IntentsService(registry, signals, wakeLogger, passkeys?.service, deps.webLinks),
          inject: [REGISTRY],
        },
        {
          provide: ESCALATIONS,
          useValue: new EscalationsService(now, signals, wakeLogger, passkeys?.service),
        },
        {
          provide: SPECS,
          useValue: new SpecsService(
            deps.gitHost ? { gitHost: deps.gitHost } : undefined,
            signals,
            wakeLogger,
          ),
        },
        {
          provide: MEMORY,
          useValue: new MemoryService(
            deps.memoryGitHost ? { gitHost: deps.memoryGitHost } : undefined,
          ),
        },
        {
          provide: LESSONS,
          useValue: new LessonsService(
            deps.lessonGitHost ? { gitHost: deps.lessonGitHost } : undefined,
            now,
          ),
        },
        {
          provide: PLANS,
          useValue: new PlansService(
            deps.gitHost ? { gitHost: deps.gitHost } : undefined,
            signals,
            wakeLogger,
          ),
        },
        {
          provide: RUNS,
          useFactory: (registry: Registry) => new RunsService(registry, signals, wakeLogger),
          inject: [REGISTRY],
        },
        { provide: COST, useValue: new CostService(now) },
        { provide: METRICS, useValue: new MetricsService(now) },
        {
          provide: EVIDENCE,
          useValue: new EvidenceService({
            store: deps.evidence?.store,
            maxItemBytes: deps.evidence?.maxItemBytes ?? 0,
            now,
          }),
        },
        { provide: AI_RECORDS, useValue: new AiRecordsService(signals, wakeLogger, now) },
        {
          provide: EVALUATIONS,
          useValue: new EvaluationsService({
            ...(deps.gitHost ? { gitHost: deps.gitHost } : {}),
            policyFactory: (config, models) => createSimplePolicyEngine({ config, models }),
            now,
            passkeys: passkeys.service,
          }),
        },
        {
          provide: EVAL_TASKS,
          useValue: new EvaluationTasksService(
            deps.evalTaskGitHost ? { gitHost: deps.evalTaskGitHost } : {},
          ),
        },
        {
          provide: APP_GUARD,
          useFactory: (reflector: Reflector) =>
            new AuthGuard({
              reflector,
              db: deps.db,
              requests: new RateLimiter(deps.settings.rateLimitPerMinute),
              failures: new RateLimiter(deps.settings.authFailuresPerMinute),
              now,
              ...(deps.webSignIn
                ? {
                    sessions: {
                      idleMs: deps.webSignIn.settings.idleMs,
                      publicOrigin: deps.webSignIn.settings.publicOrigin,
                      actions: deps.webSignIn.settings.actions === true,
                    },
                  }
                : {}),
            }),
          inject: [Reflector],
        },
        { provide: APP_INTERCEPTOR, useValue: new LogContextInterceptor() },
        {
          provide: APP_FILTER,
          useValue: new ErrorFilter(deps.logger ?? new Logger('sdlc-api')),
        },
      ],
    };
  }
}

export async function createApp(deps: ApiDeps): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(
    ApiModule.create(deps),
    // ADR-M26 §2.7, ADR-M67 §2.5: the client address is the TCP peer, except on requests from the
    // team access proxy, whose X-Forwarded-For (written by the proxy, never by the client) counts.
    new FastifyAdapter({
      bodyLimit: BODY_LIMIT_BYTES,
      trustProxy: deps.settings.trustedProxy ?? false,
    }),
    { logger: deps.nestLogger ?? ['error', 'warn'] },
  );
  app.enableShutdownHooks();
  if (deps.dashboard) {
    registerDashboard(app.getHttpAdapter().getInstance() as unknown as RouteHost, deps.dashboard);
  }
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}
