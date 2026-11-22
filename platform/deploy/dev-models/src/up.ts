// `pnpm dev:models:up` and `pnpm dev:models:down` (D-08 V24, issue #562).
// Reuses `FreshDeployment`, `SecretBag`, and `parseInitOutput` from `platform/deploy/steps`.
import fs from 'node:fs';
import path from 'node:path';

import { envSecrets, envValue } from '../../steps/dist/env-file.js';
import type { Exec, ExecResult } from '../../steps/dist/exec.js';
import {
  DeployStepError,
  FreshDeployment,
  type OpenBaoState,
} from '../../steps/dist/fresh-deployment.js';
import { SecretBag } from '../../steps/dist/secrets.js';

import { checkDevModelsGuardrails, DEFAULT_OLLAMA_URL, validatePassphrase } from './guardrails.js';
import {
  decryptDevKeys,
  devKeyFileFor,
  encryptDevKeys,
  KEY_THRESHOLD,
  readDevKeyFile,
  SCRYPT_LOG_N,
  writeDevKeyFile,
} from './keys.js';

export type { Exec, ExecResult };
export { DeployStepError as DevModelsStepError };

export const DEV_MODELS_PROFILES = ['core', 'models'] as const;

export interface SecretPrompts {
  /** Reads a hidden line from the interactive terminal (never echoed). */
  readonly hidden: (prompt: string) => Promise<string>;
}

export interface DevModelsUpDeps {
  readonly repoRoot: string;
  readonly envFile: string;
  readonly nodeEnv: string | undefined;
  readonly stdinIsTTY: boolean;
  /** Optional Ollama base URL; defaults to `http://host.docker.internal:11434`. */
  readonly ollamaUrl?: string;
  /** Optional scrypt work factor override (tests use a fast value). */
  readonly scryptLogN?: number;
  readonly exec: Exec;
  readonly prompts: SecretPrompts;
  readonly log: (line: string) => void;
  /** Registers an async cleanup hook for SIGINT/SIGTERM to revoke active tokens. */
  readonly onActiveCleanup?: (fn: (() => Promise<void>) | null) => void;
}

export interface DevModelsUpResult {
  readonly state: OpenBaoState;
  readonly composeProject: string;
  readonly keyFile: string;
  readonly providerStored: 'anthropic' | 'ollama' | 'unchanged';
}

export class DevModelsGuardrailError extends Error {
  constructor(readonly messages: readonly string[]) {
    super(messages.join('\n'));
  }
}

/** Ensures `LITELLM_MASTER_KEY` and `LITELLM_SALT_KEY` are empty so LiteLLM uses OpenBao. */
function clearInlineLitellmKeys(envText: string): string {
  return envText
    .replace(/^LITELLM_MASTER_KEY=.*$/m, 'LITELLM_MASTER_KEY=')
    .replace(/^LITELLM_SALT_KEY=.*$/m, 'LITELLM_SALT_KEY=');
}

async function promptNewPassphrase(
  prompts: SecretPrompts,
  log: (l: string) => void,
): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const firstRaw = await prompts.hidden(
      'Choose a passphrase (>= 12 chars) to encrypt dev-openbao-keys.age: ',
    );
    const checked = validatePassphrase(firstRaw);
    if (!checked.ok) {
      log(checked.reason);
      continue;
    }
    const second = (await prompts.hidden('Confirm passphrase: ')).normalize('NFC');
    if (second === checked.value) return checked.value;
    log('Passphrases did not match. Try again.');
  }
  throw new DeployStepError('passphrase', 'failed to confirm passphrase after 3 attempts');
}

export async function devModelsUp(deps: DevModelsUpDeps): Promise<DevModelsUpResult> {
  const preRefusals = checkDevModelsGuardrails({
    nodeEnv: deps.nodeEnv,
    stdinIsTTY: deps.stdinIsTTY,
    needsSecretPrompt: false,
  });
  if (preRefusals.length > 0) {
    throw new DevModelsGuardrailError(preRefusals.map((r) => r.message));
  }

  const bag = new SecretBag();
  const deployDir = path.join(deps.repoRoot, 'platform/deploy');
  const keyFile = devKeyFileFor(deps.envFile);

  // Step 1: Ensure platform/deploy/.env exists (never clobbers an existing dev .env).
  if (!fs.existsSync(deps.envFile)) {
    deps.log('[1/4] Creating platform/deploy/.env via init-env.sh...');
    const initEnv = await deps.exec(path.join(deployDir, 'scripts/init-env.sh'), [deps.envFile], {
      env: { SDLC_ENV_FILE: deps.envFile },
    });
    if (initEnv.status !== 0) {
      throw new DeployStepError('compose:env', bag.redact(initEnv.stderr));
    }
    const cleaned = clearInlineLitellmKeys(fs.readFileSync(deps.envFile, 'utf8'));
    fs.writeFileSync(deps.envFile, cleaned, { mode: 0o600 });
  } else {
    deps.log('[1/4] Using existing platform/deploy/.env...');
  }

  const envText = fs.readFileSync(deps.envFile, 'utf8');
  for (const value of envSecrets(envText)) bag.keep(value);
  const composeProject = envValue(envText, 'COMPOSE_PROJECT_NAME') ?? 'sdlc';

  const deploy = new FreshDeployment({
    repoRoot: deps.repoRoot,
    envFile: deps.envFile,
    composeProject,
    exec: deps.exec,
    bag,
    bootstrapEnv: { SDLC_OPENBAO_THROWAWAY: '1' },
  });

  // Step 2: Start core stores (openbao, postgres, seaweedfs) and check OpenBao state.
  deps.log('[2/4] Starting core stores (OpenBao, PostgreSQL, SeaweedFS)...');
  await deploy.startStores();
  const state = await deploy.openbaoState();
  let providerStored: DevModelsUpResult['providerStored'] = 'unchanged';

  if (state === 'uninitialised') {
    const ttyRefusals = checkDevModelsGuardrails({
      nodeEnv: deps.nodeEnv,
      stdinIsTTY: deps.stdinIsTTY,
      needsSecretPrompt: true,
    });
    if (ttyRefusals.length > 0) {
      throw new DevModelsGuardrailError(ttyRefusals.map((r) => r.message));
    }

    deps.log('[3/4] Initialising throw-away dev OpenBao and provisioning LiteLLM secrets...');
    const passphrase = bag.keep(await promptNewPassphrase(deps.prompts, deps.log));
    const { shares, rootToken } = await deploy.initOpenBao({ shares: 3, threshold: KEY_THRESHOLD });
    let activeToken = rootToken;
    deps.onActiveCleanup?.(async () => {
      if (activeToken) await deploy.revoke(activeToken);
    });

    let adminToken = '';
    try {
      try {
        await deploy.unseal(shares.slice(0, KEY_THRESHOLD));
        const encrypted = await encryptDevKeys(
          {
            project: composeProject,
            createdAt: new Date().toISOString(),
            shares: shares.slice(0, KEY_THRESHOLD),
          },
          passphrase,
          deps.scryptLogN ?? SCRYPT_LOG_N,
        );
        writeDevKeyFile(keyFile, encrypted);
        deps.log(`      Saved encrypted OpenBao unseal shares to ${keyFile}`);
      } finally {
        for (const share of shares) bag.drop(share);
        shares.length = 0;
        bag.drop(passphrase);
      }
      adminToken = await deploy.configure(rootToken);
      activeToken = adminToken;
    } finally {
      if (!adminToken) await deploy.revoke(rootToken);
      bag.drop(rootToken);
    }

    try {
      await deploy.storeLitellmKeys(adminToken);
      const apiKeyRaw = await deps.prompts.hidden(
        'Anthropic API key (hidden; press Enter to skip and use Ollama only): ',
      );
      const apiKey = apiKeyRaw.trim();
      if (apiKey !== '') {
        bag.keep(apiKey);
        await deploy.storeProvider(adminToken, { provider: 'anthropic', apiKey });
        bag.drop(apiKey);
        providerStored = 'anthropic';
      } else {
        await deploy.storeProvider(adminToken, {
          provider: 'ollama',
          apiBase: deps.ollamaUrl ?? DEFAULT_OLLAMA_URL,
        });
        providerStored = 'ollama';
      }
      await deploy.credentials(adminToken, 'litellm-credentials');
    } finally {
      activeToken = '';
      deps.onActiveCleanup?.(null);
      await deploy.revoke(adminToken);
      bag.drop(adminToken);
    }
  } else if (state === 'sealed') {
    const ttyRefusals = checkDevModelsGuardrails({
      nodeEnv: deps.nodeEnv,
      stdinIsTTY: deps.stdinIsTTY,
      needsSecretPrompt: true,
    });
    if (ttyRefusals.length > 0) {
      throw new DevModelsGuardrailError(ttyRefusals.map((r) => r.message));
    }

    deps.log(
      '[3/4] Unsealing existing dev OpenBao from dev-openbao-keys.age (volumes preserved)...',
    );
    const bytes = readDevKeyFile(keyFile);
    const passphrase = bag.keep(
      (await deps.prompts.hidden('Passphrase for dev-openbao-keys.age: ')).normalize('NFC'),
    );
    try {
      const record = await decryptDevKeys(bytes, passphrase, composeProject);
      try {
        await deploy.unseal(record.shares);
      } finally {
        for (const share of record.shares) bag.drop(share);
      }
    } finally {
      bag.drop(passphrase);
    }
  } else {
    deps.log('[3/4] Dev OpenBao is already unsealed; skipping init/unseal.');
  }

  // Step 4: Bring `core` + `models` (`litellm`, `litellm-agent`) to healthy.
  deps.log('[4/4] Starting models profile (litellm, litellm-agent)...');
  await deploy.up(DEV_MODELS_PROFILES);

  return { state, composeProject, keyFile, providerStored };
}

export interface DevModelsDownDeps {
  readonly repoRoot: string;
  readonly envFile: string;
  readonly exec: Exec;
}

/** Stops LiteLLM model services without deleting any Docker volumes. */
export async function devModelsDown(deps: DevModelsDownDeps): Promise<ExecResult> {
  const envText = fs.existsSync(deps.envFile) ? fs.readFileSync(deps.envFile, 'utf8') : '';
  const composeProject = envValue(envText, 'COMPOSE_PROJECT_NAME') ?? 'sdlc';
  return deps.exec(
    'docker',
    [
      'compose',
      '-p',
      composeProject,
      '-f',
      path.join(deps.repoRoot, 'platform/deploy/docker-compose.yml'),
      '--env-file',
      deps.envFile,
      '--profile',
      'models',
      'stop',
      'litellm',
      'litellm-agent',
    ],
    { env: { SDLC_ENV_FILE: deps.envFile } },
  );
}
