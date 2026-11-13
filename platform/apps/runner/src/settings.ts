// Runner settings (ADR-M25 §2.6). Deployment settings come from the environment, not from
// @sdlc/config: they describe this Docker host, not the handbook rules of a project. The sandbox
// image is the one exception that belongs to the project (config `sandbox.image`, QUESTIONS #59).
//
// Nothing here can loosen the sandbox hardening (ADR-M25 §2.4): the settings choose sizes and the
// services a sandbox may reach, never capabilities, mounts or the network type.
import os from 'node:os';
import path from 'node:path';

import { RunnerError } from './errors.js';
import type { GitSettings } from './workspace/git.js';

export const RUNNER_ENV = {
  dockerSocket: 'SDLC_RUNNER_DOCKER_SOCKET',
  instance: 'SDLC_RUNNER_INSTANCE',
  maxSandboxes: 'SDLC_RUNNER_MAX_SANDBOXES',
  maxEvalSandboxes: 'SDLC_RUNNER_MAX_EVAL_SANDBOXES',
  memoryMb: 'SDLC_RUNNER_SANDBOX_MEMORY_MB',
  cpus: 'SDLC_RUNNER_SANDBOX_CPUS',
  pids: 'SDLC_RUNNER_SANDBOX_PIDS',
  tmpMb: 'SDLC_RUNNER_SANDBOX_TMP_MB',
  sandboxRuntime: 'SDLC_RUNNER_SANDBOX_RUNTIME',
  egressServices: 'SDLC_RUNNER_EGRESS_SERVICES',
  toolServices: 'SDLC_RUNNER_TOOL_SERVICES',
  npmRegistry: 'SDLC_RUNNER_NPM_REGISTRY',
  gitBaseUrl: 'SDLC_RUNNER_GIT_BASE_URL',
  gitAllowPlaintext: 'SDLC_RUNNER_GIT_ALLOW_PLAINTEXT',
  gitTimeoutSeconds: 'SDLC_RUNNER_GIT_TIMEOUT_SECONDS',
  workDir: 'SDLC_RUNNER_WORK_DIR',
  workspaceMaxMb: 'SDLC_RUNNER_WORKSPACE_MAX_MB',
  exportMaxMb: 'SDLC_RUNNER_EXPORT_MAX_MB',
  readyTimeoutSeconds: 'SDLC_RUNNER_READY_TIMEOUT_SECONDS',
  sweepIntervalSeconds: 'SDLC_RUNNER_SWEEP_INTERVAL_SECONDS',
  selfContainer: 'SDLC_RUNNER_SELF_CONTAINER',
  agentPort: 'SDLC_RUNNER_AGENT_PORT',
  agentLlmUrl: 'SDLC_RUNNER_AGENT_LLM_URL',
  agentPollMs: 'SDLC_RUNNER_AGENT_POLL_MS',
  agentStopGraceSeconds: 'SDLC_RUNNER_AGENT_STOP_GRACE_SECONDS',
  agentSpendCheckSeconds: 'SDLC_RUNNER_AGENT_SPEND_CHECK_SECONDS',
  agentSpendRecheckSeconds: 'SDLC_RUNNER_AGENT_SPEND_RECHECK_SECONDS',
  killEvidenceSeconds: 'SDLC_RUNNER_KILL_EVIDENCE_SECONDS',
  evalTasksDir: 'SDLC_EVAL_TASKS_DIR',
  evalConfigDir: 'SDLC_EVAL_CONFIG_DIR',
  gpu: 'SDLC_RUNNER_GPU',
  gitleaksPath: 'SDLC_RUNNER_GITLEAKS_PATH',
  secretScanTimeoutSeconds: 'SDLC_RUNNER_SECRET_SCAN_TIMEOUT_SECONDS',
} as const;

/**
 * A service a sandbox may reach (D-03 §9 v1.6): LiteLLM or a package proxy. The runner attaches
 * `container` to the run's internal network under `alias`; the contract names it `alias:port`.
 */
export interface EgressService {
  readonly alias: string;
  readonly container: string;
  readonly port: number;
}

/**
 * A container runtime stronger than the Engine's default (task H06, ADR-M25 §2.12): gVisor (`runsc`)
 * or Kata Containers (`kata`). It gives the sandbox and the scoring containers a kernel of their
 * own, so code from a repository does not run on the host's kernel. The list is closed: a runtime
 * is a host program the Engine starts.
 */
export const SANDBOX_RUNTIMES = ['runsc', 'kata'] as const;
export type SandboxRuntime = (typeof SANDBOX_RUNTIMES)[number];

export function isSandboxRuntime(value: unknown): value is SandboxRuntime {
  return typeof value === 'string' && (SANDBOX_RUNTIMES as readonly string[]).includes(value);
}

export interface SandboxLimits {
  readonly memoryBytes: number;
  /** Docker `NanoCpus` (1.5 CPUs = 1_500_000_000). */
  readonly nanoCpus: number;
  readonly pids: number;
  readonly tmpBytes: number;
}

/** How the runner drives the agent in a sandbox (C05, ADR-M29). Technical, not handbook rules. */
export interface AgentSettings {
  /**
   * The runner's own container. The runner joins each run's network with it to call the Agent
   * Server (ADR-M25 §5, ADR-M29), and leaves at clean-up. Required to run an agent.
   */
  readonly selfContainer: string | undefined;
  /** Port of the Agent Server inside the sandbox. */
  readonly port: number;
  /** LiteLLM as the sandbox sees it; its `host:port` must be in the contract's `egress_allowlist`. */
  readonly llmBaseUrl: string;
  /** How often the runner asks the agent for its state. */
  readonly pollMs: number;
  /** After an interrupt at the time cap, how long the runner waits before it removes the sandbox. */
  readonly stopGraceMs: number;
  /**
   * How often the runner reads the spend of the run's key during the run (C07, ADR-M34 §2.6): a
   * warning at `budget.warn_percent`, a stop at `budget.stop_percent` of the key's cap.
   */
  readonly spendCheckMs: number;
  /**
   * LiteLLM records spend with a delay. When the agent ends with an error below the stop share,
   * the runner reads the spend once more after this wait, so a real budget stop is not reported
   * as a technical failure (ADR-M34 §2.6).
   */
  readonly spendRecheckMs: number;
  /**
   * C11 (QUESTIONS #183): the longest the runner spends on a killed run's evidence, after the run
   * is recorded `stopped_killed`: waiting for its key to be revoked, then storing its diff. Outside
   * the 5-minute kill clock; when the time is up, the diff is skipped and the sandbox removed.
   */
  readonly killEvidenceMs: number;
}

/** Where an evaluation run finds its task set and configurations (task L04, ADR-M81 §2.7). */
export interface EvaluationSettings {
  /** The task set (`task-set.yaml`, one folder per task): packed into the image, or a private set. */
  readonly tasksDir: string;
  /** The configuration files (`<config name>.yaml` and the instructions files next to them). */
  readonly configDir: string;
  /** The GPU name for the hardware block of a result; null when none. */
  readonly gpu: string | null;
}

export interface RunnerSettings {
  /** Path of the Docker Engine socket (in Compose: the socket proxy, ADR-M25 §2.5). */
  readonly dockerSocket: string;
  /** Label value that separates runner deployments sharing one Docker host. */
  readonly instance: string;
  /** Concurrent sandboxes (D-03 §10.1: 1–2 on the internal server). Extra runs wait. */
  readonly maxSandboxes: number;
  /**
   * Sandboxes evaluation runs may hold at the same time (task L04, ADR-M81 §2.3, QUESTIONS #461):
   * free slots only, never above `maxSandboxes`; 0 turns evaluations off. A waiting real run takes
   * the slot of a running evaluation run, which is stopped and queued again.
   */
  readonly maxEvalSandboxes: number;
  readonly limits: SandboxLimits;
  /**
   * The runtime of the sandbox and scoring containers (task H06), or undefined for the Engine's
   * default (`runc`). Tool and gateway containers always use the default: they run platform images
   * and join more than one network (ADR-M25 §2.12, QUESTIONS #704).
   */
  readonly sandboxRuntime: SandboxRuntime | undefined;
  readonly egressServices: readonly EgressService[];
  /**
   * X04 PR 3b (ADR-M69 §2.4): the backing services a register tool may reach on its own service
   * network (`alias=container:port`, for example `knowledge-db` and `litellm`). A grant that names
   * another `alias:port` is refused (`tool_not_enforceable`).
   */
  readonly toolServices: readonly EgressService[];
  /** npm registry URL given to the sandbox; its host must be an egress service alias. */
  readonly npmRegistry: string | undefined;
  /** How the runner clones (never the sandbox, QUESTIONS #52). */
  readonly git: GitSettings;
  /** Where the runner clones before the upload; each run gets its own subfolder, removed after. */
  readonly workDir: string;
  /** Largest workspace the runner uploads (file content, `.git` included). */
  readonly workspaceMaxBytes: number;
  /**
   * Largest archive the runner reads out of a sandbox for an L1 proposal (C06 session 2b), ignored
   * paths such as `node_modules` included. Streamed, never held in memory; only the files kept
   * for the proposal count against `workspaceMaxBytes`.
   */
  readonly exportMaxBytes: number;
  /** How long the runner waits for the sandbox health check. */
  readonly readyTimeoutMs: number;
  /** How often the runner removes objects of runs it does not hold (ADR-M25 §2.8). */
  readonly sweepIntervalMs: number;
  readonly agent: AgentSettings;
  readonly evaluation: EvaluationSettings;
  /** The secret scan of every run's diff (task H04, ADR-M93): always on, never configurable off. */
  readonly secretScan: SecretScanSettings;
}

export interface SecretScanSettings {
  /** The Gitleaks executable (the runner image: `/usr/local/bin/gitleaks`; else found on PATH). */
  readonly gitleaksPath: string;
  readonly timeoutMs: number;
}

export const DEFAULT_DOCKER_SOCKET = '/var/run/docker.sock';
export const DEFAULTS = {
  instance: 'sdlc',
  maxSandboxes: 1,
  maxEvalSandboxes: 1,
  evalTasksDir: '/app/eval-tasks',
  evalConfigDir: '/app/eval-configs',
  memoryMb: 2048,
  cpus: '1.5',
  pids: 512,
  tmpMb: 512,
  gitBaseUrl: 'https://github.com',
  gitTimeoutSeconds: 300,
  workspaceMaxMb: 1024,
  exportMaxMb: 8192,
  readyTimeoutSeconds: 120,
  sweepIntervalSeconds: 300,
  gitleaksPath: 'gitleaks',
  secretScanTimeoutSeconds: 120,
  agentPort: 8000,
  agentLlmUrl: 'http://litellm:4000',
  agentPollMs: 1000,
  agentStopGraceSeconds: 30,
  agentSpendCheckSeconds: 30,
  // Above LiteLLM's spend write interval (`proxy_batch_write_at`, 10 s by default, measured in
  // `pnpm test:litellm`): the re-read must see the spend that blocked the agent.
  agentSpendRecheckSeconds: 25,
  killEvidenceSeconds: 60,
} as const;
/** More than this on one host is a mistake, not a setting (each sandbox reserves ~2 GiB). */
export const MAX_SANDBOXES_LIMIT = 16;

const NAME = /^[a-z0-9][a-z0-9_.-]{0,62}$/;
const ALIAS = /^[a-z][a-z0-9-]{0,62}$/;
const CPUS = /^(?:[0-9]{1,2})(?:\.[0-9]{1,2})?$/;
const MIB = 1024 * 1024;

function invalid(name: string): RunnerError {
  return new RunnerError('runner.config.invalid_setting', { name });
}

function intSetting(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^[0-9]+$/.test(raw)) throw invalid(name);
  const value = Number(raw);
  if (value < min || value > max) throw invalid(name);
  return value;
}

function workDir(raw: string | undefined): string {
  const dir = raw || path.join(os.tmpdir(), 'sdlc-runner');
  if (!path.isAbsolute(dir)) throw invalid(RUNNER_ENV.workDir);
  return dir;
}

/** Parses `alias=container:port,alias=container:port`. */
export function parseEgressServices(
  raw: string | undefined,
  name: string = RUNNER_ENV.egressServices,
): EgressService[] {
  if (raw === undefined || raw.trim() === '') return [];
  const services = raw.split(',').map((entry) => {
    const match = /^([^=]+)=([^:]+):([0-9]{1,5})$/.exec(entry.trim());
    const alias = match?.[1] ?? '';
    const container = match?.[2] ?? '';
    const port = Number(match?.[3]);
    if (!ALIAS.test(alias) || !NAME.test(container) || port < 1 || port > 65535) {
      throw invalid(name);
    }
    return { alias, container, port };
  });
  const aliases = services.map((s) => s.alias);
  if (new Set(aliases).size !== aliases.length) throw invalid(name);
  return services;
}

function npmRegistry(
  raw: string | undefined,
  services: readonly EgressService[],
): string | undefined {
  if (raw === undefined || raw === '') return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalid(RUNNER_ENV.npmRegistry);
  }
  // Inside the sandbox the only reachable names are the egress aliases, on the internal network.
  const service = services.find((s) => s.alias === url.hostname);
  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username !== '' ||
    url.password !== '' ||
    service?.port !== port
  ) {
    throw invalid(RUNNER_ENV.npmRegistry);
  }
  return url.toString();
}

function gitSettings(env: NodeJS.ProcessEnv): GitSettings {
  const allow = env[RUNNER_ENV.gitAllowPlaintext] ?? '';
  if (!['', '0', '1'].includes(allow)) throw invalid(RUNNER_ENV.gitAllowPlaintext);
  let baseUrl: URL;
  try {
    baseUrl = new URL(env[RUNNER_ENV.gitBaseUrl] || DEFAULTS.gitBaseUrl);
  } catch {
    throw invalid(RUNNER_ENV.gitBaseUrl);
  }
  const plaintextOk = baseUrl.protocol === 'http:' && allow === '1';
  if (
    (baseUrl.protocol !== 'https:' && !plaintextOk) ||
    baseUrl.username !== '' ||
    baseUrl.password !== '' ||
    baseUrl.pathname !== '/' ||
    baseUrl.search !== '' ||
    baseUrl.hash !== ''
  ) {
    throw invalid(RUNNER_ENV.gitBaseUrl);
  }
  return {
    baseUrl,
    allowPlaintext: allow === '1',
    timeoutMs:
      intSetting(env, RUNNER_ENV.gitTimeoutSeconds, DEFAULTS.gitTimeoutSeconds, 10, 3600) * 1000,
  };
}

function absoluteDir(raw: string | undefined, fallback: string, name: string): string {
  const dir = raw || fallback;
  if (!path.isAbsolute(dir)) throw invalid(name);
  return dir;
}

function evaluationSettings(env: NodeJS.ProcessEnv): EvaluationSettings {
  const gpu = env[RUNNER_ENV.gpu];
  if (gpu !== undefined && gpu !== '' && !/^[A-Za-z0-9][A-Za-z0-9 ._:@()/+-]{0,127}$/.test(gpu)) {
    throw invalid(RUNNER_ENV.gpu);
  }
  return {
    tasksDir: absoluteDir(
      env[RUNNER_ENV.evalTasksDir],
      DEFAULTS.evalTasksDir,
      RUNNER_ENV.evalTasksDir,
    ),
    configDir: absoluteDir(
      env[RUNNER_ENV.evalConfigDir],
      DEFAULTS.evalConfigDir,
      RUNNER_ENV.evalConfigDir,
    ),
    gpu: gpu ? gpu : null,
  };
}

function agentSettings(env: NodeJS.ProcessEnv): AgentSettings {
  const self = env[RUNNER_ENV.selfContainer];
  if (self !== undefined && self !== '' && !NAME.test(self))
    throw invalid(RUNNER_ENV.selfContainer);
  const raw = env[RUNNER_ENV.agentLlmUrl] || DEFAULTS.agentLlmUrl;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalid(RUNNER_ENV.agentLlmUrl);
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !ALIAS.test(url.hostname) ||
    url.port === '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw invalid(RUNNER_ENV.agentLlmUrl);
  }
  return {
    selfContainer: self || undefined,
    port: intSetting(env, RUNNER_ENV.agentPort, DEFAULTS.agentPort, 1, 65_535),
    llmBaseUrl: url.origin,
    pollMs: intSetting(env, RUNNER_ENV.agentPollMs, DEFAULTS.agentPollMs, 100, 10_000),
    stopGraceMs:
      intSetting(env, RUNNER_ENV.agentStopGraceSeconds, DEFAULTS.agentStopGraceSeconds, 1, 600) *
      1000,
    spendCheckMs:
      intSetting(env, RUNNER_ENV.agentSpendCheckSeconds, DEFAULTS.agentSpendCheckSeconds, 5, 600) *
      1000,
    spendRecheckMs:
      intSetting(
        env,
        RUNNER_ENV.agentSpendRecheckSeconds,
        DEFAULTS.agentSpendRecheckSeconds,
        1,
        60,
      ) * 1000,
    killEvidenceMs:
      intSetting(env, RUNNER_ENV.killEvidenceSeconds, DEFAULTS.killEvidenceSeconds, 5, 300) * 1000,
  };
}

/** Reads and checks the runner settings from environment variables. */
export function runnerSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): RunnerSettings {
  const dockerSocket = env[RUNNER_ENV.dockerSocket] || DEFAULT_DOCKER_SOCKET;
  if (!dockerSocket.startsWith('/')) throw invalid(RUNNER_ENV.dockerSocket);
  const instance = env[RUNNER_ENV.instance] || DEFAULTS.instance;
  if (!NAME.test(instance)) throw invalid(RUNNER_ENV.instance);
  const cpus = env[RUNNER_ENV.cpus] || DEFAULTS.cpus;
  if (!CPUS.test(cpus) || Number(cpus) <= 0) throw invalid(RUNNER_ENV.cpus);
  const egressServices = parseEgressServices(env[RUNNER_ENV.egressServices]);
  const maxSandboxes = intSetting(
    env,
    RUNNER_ENV.maxSandboxes,
    DEFAULTS.maxSandboxes,
    1,
    MAX_SANDBOXES_LIMIT,
  );
  // Never above the pool: an evaluation run can only use a slot the pool has (ADR-M81 §2.3).
  const maxEvalSandboxes = intSetting(
    env,
    RUNNER_ENV.maxEvalSandboxes,
    Math.min(DEFAULTS.maxEvalSandboxes, maxSandboxes),
    0,
    maxSandboxes,
  );
  return {
    dockerSocket,
    instance,
    maxSandboxes,
    maxEvalSandboxes,
    limits: {
      memoryBytes: intSetting(env, RUNNER_ENV.memoryMb, DEFAULTS.memoryMb, 256, 65_536) * MIB,
      nanoCpus: Math.round(Number(cpus) * 1e9),
      pids: intSetting(env, RUNNER_ENV.pids, DEFAULTS.pids, 64, 32_768),
      tmpBytes: intSetting(env, RUNNER_ENV.tmpMb, DEFAULTS.tmpMb, 64, 16_384) * MIB,
    },
    sandboxRuntime: sandboxRuntime(env[RUNNER_ENV.sandboxRuntime]),
    egressServices,
    toolServices: parseEgressServices(env[RUNNER_ENV.toolServices], RUNNER_ENV.toolServices),
    npmRegistry: npmRegistry(env[RUNNER_ENV.npmRegistry], egressServices),
    git: gitSettings(env),
    workDir: workDir(env[RUNNER_ENV.workDir]),
    workspaceMaxBytes:
      intSetting(env, RUNNER_ENV.workspaceMaxMb, DEFAULTS.workspaceMaxMb, 1, 16_384) * MIB,
    exportMaxBytes: intSetting(env, RUNNER_ENV.exportMaxMb, DEFAULTS.exportMaxMb, 1, 65_536) * MIB,
    readyTimeoutMs:
      intSetting(env, RUNNER_ENV.readyTimeoutSeconds, DEFAULTS.readyTimeoutSeconds, 5, 1800) * 1000,
    sweepIntervalMs:
      intSetting(env, RUNNER_ENV.sweepIntervalSeconds, DEFAULTS.sweepIntervalSeconds, 30, 3600) *
      1000,
    agent: agentSettings(env),
    evaluation: evaluationSettings(env),
    secretScan: secretScanSettings(env),
  };
}

function sandboxRuntime(raw: string | undefined): SandboxRuntime | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (!isSandboxRuntime(raw)) throw invalid(RUNNER_ENV.sandboxRuntime);
  return raw;
}

function secretScanSettings(env: NodeJS.ProcessEnv): SecretScanSettings {
  const gitleaksPath = env[RUNNER_ENV.gitleaksPath] || DEFAULTS.gitleaksPath;
  // A bare name is looked up on PATH; anything else must be an absolute path.
  if (gitleaksPath !== DEFAULTS.gitleaksPath && !path.isAbsolute(gitleaksPath)) {
    throw invalid(RUNNER_ENV.gitleaksPath);
  }
  return {
    gitleaksPath,
    timeoutMs:
      intSetting(
        env,
        RUNNER_ENV.secretScanTimeoutSeconds,
        DEFAULTS.secretScanTimeoutSeconds,
        5,
        1800,
      ) * 1000,
  };
}
