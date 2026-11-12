// What the worker needs for G4 and agent runs (task C06 session 2, design/ADR-M33 §2.5, QUESTIONS
// #112). The worker holds the Cost Controller capability: it logs in to OpenBao with a second
// AppRole, `cost-controller`, which may read the LiteLLM master key. The two AppRoles keep separate
// policies; the master key never leaves this process (the runner gets the run's virtual key as a
// single-use wrapping token).
import { LiteLLMGateway } from '@sdlc/adapter-model-litellm';
import { createSimplePolicyEngine } from '@sdlc/adapter-policy-simple';
import type {
  GitHostAdapter,
  ModelRef,
  RunContractSigner,
  RunDatabaseCredentials,
  SecretWrapper,
} from '@sdlc/contracts';
import {
  CostController,
  parseTenantId,
  type G4Deps,
  type G6Deps,
  type CodeIndexDeps,
  KnowledgeDeps,
  type PlatformDatabase,
  type PublishDeps,
  type Registry,
  type RunDeps,
} from '@sdlc/core';
import { OpenBaoClient, optionsFromEnv, type SecretsLogger } from '@sdlc/secrets';

import type { WorkerRunSettings } from './settings.js';

/** The field of the master key entry (`kv/cost-controller/litellm-master-key`, ADR-M24). */
export const MASTER_KEY_FIELD = 'value';

export interface WorkerRuns {
  readonly g4: G4Deps;
  readonly runs: RunDeps;
  /** C08: the push token and the pull request at G6. */
  readonly publish: PublishDeps;
  /** C08 PR 2: what G6 reads from CI. */
  readonly g6: G6Deps;
  /** C12: the scheduled spend sync uses the same Cost Controller (ADR-M24 §2.5). */
  readonly costController: CostController;
  /** L04: the gateway's current model list, for the model re-check of an evaluation run. */
  readonly models: () => Promise<readonly ModelRef[]>;
  close(): Promise<void>;
}

export async function createWorkerRuns(options: {
  readonly settings: WorkerRunSettings;
  readonly env: NodeJS.ProcessEnv;
  readonly db: PlatformDatabase;
  readonly registry: Registry;
  readonly gitHost: GitHostAdapter;
  /** The worker's own OpenBao client: Transit signing and response wrapping. */
  readonly signer: RunContractSigner;
  readonly wrapper: SecretWrapper;
  readonly logger?: SecretsLogger;
  /** X04 PR 3a: the index of a project's documents; absent when `knowledge-db` is off. */
  readonly knowledge?: KnowledgeDeps;
  /** X06 PR 2: the code index of a project; absent when `knowledge-db` is off. */
  readonly code?: CodeIndexDeps;
  /** X04 PR 3b: OpenBao's database engine, for the database login of a `read_documents` tool. */
  readonly databaseCredentials?: RunDatabaseCredentials;
}): Promise<WorkerRuns> {
  const { settings } = options;
  // Same OpenBao address and TLS settings as the worker's client; the cost-controller's files.
  const cost = new OpenBaoClient({
    ...optionsFromEnv(options.env),
    roleIdFile: settings.costRoleIdFile,
    secretIdFile: settings.costSecretIdFile,
    ...(options.logger ? { logger: options.logger } : {}),
  });
  try {
    const entry = await cost.kv().read(settings.costMasterKeyPath);
    const masterKey = entry.data[MASTER_KEY_FIELD];
    if (!masterKey) throw new Error('the LiteLLM master key entry has no value field');
    const gateway = new LiteLLMGateway({ baseUrl: settings.litellmUrl, masterKey });
    const costController = new CostController({ gateway, db: options.db });
    const g4: G4Deps = {
      gitHost: options.gitHost,
      // The policy engine over the gateway's current model list (QUESTIONS #17).
      allowedModels: async (config, dataClass) =>
        createSimplePolicyEngine({ config, models: await gateway.listModels() }).allowedModels({
          dataClass,
        }),
      tenantMonthlyBudget: async (tenantId) =>
        (await options.db.system.getTenant(parseTenantId(tenantId)))?.monthly_budget_usd ?? null,
    };
    return {
      g4,
      runs: {
        registry: options.registry,
        g4,
        signer: options.signer,
        costController,
        gitHost: options.gitHost,
        wrapper: options.wrapper,
        egressAllowlist: settings.egressAllowlist,
        ...(options.knowledge ? { knowledge: options.knowledge } : {}),
        ...(options.code ? { code: options.code } : {}),
        ...(options.databaseCredentials
          ? { databaseCredentials: options.databaseCredentials }
          : {}),
      },
      publish: { registry: options.registry, gitHost: options.gitHost, wrapper: options.wrapper },
      g6: { gitHost: options.gitHost },
      costController,
      models: () => gateway.listModels(),
      close: () => cost.close(),
    };
  } catch (error) {
    await cost.close();
    throw error;
  }
}
