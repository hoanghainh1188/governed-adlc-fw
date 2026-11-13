// The hardened sandbox of one run (ADR-M10 §2.4, ADR-M25 §2.4). One function builds it; the guard
// (docker/guard.ts) checks it again before it reaches Docker.
//
// - read-only root filesystem; tmpfs `/tmp` (with exec, needed by the Agent Server) and home;
// - user 10001, every capability dropped, no-new-privileges (so `sudo` in the image cannot work);
// - memory (no extra swap), CPU and process limits from the runner settings;
// - no published ports, no Docker socket, no host directory: the only mount is the run's own
//   workspace volume;
// - network: the run's own internal network only (sandbox/network.ts);
// - environment: an allowlist of non-secret values (FR-33). No provider key, no LiteLLM master key,
//   no OpenBao address or token, no GitHub token (QUESTIONS #52).
import { SANDBOX_USER, TMPFS_PATHS, WORKSPACE_PATH, type ContainerSpec } from '../docker/guard.js';
import type { RunNames } from '../names.js';
import type { RunnerSettings } from '../settings.js';

export interface SandboxSpecInput {
  readonly names: RunNames;
  readonly labels: Readonly<Record<string, string>>;
  /** Project image pinned by digest (config `sandbox.image`, QUESTIONS #59). */
  readonly image: string;
  /**
   * Task H06: `name:ip` of the containers on the run's network (`sandbox/hosts.ts`), used only with a
   * sandbox runtime: gVisor cannot use Docker's embedded DNS.
   */
  readonly hosts?: readonly string[];
  /** Random per run; authenticates the runner to the Agent Server (ADR-M10 §2.2). */
  readonly sessionApiKey: string;
  /** Random per run; the Agent Server encrypts its own state with it. */
  readonly agentSecretKey: string;
}

/** Fixed Agent Server flags (ADR-M10 §2.4): no VS Code server, no telemetry. */
const FIXED_ENV = [
  'OH_ENABLE_VSCODE=false',
  'OH_TELEMETRY_EXPORTER=none',
  'DO_NOT_TRACK=1',
  'OPENHANDS_SUPPRESS_BANNER=1',
] as const;

const RANDOM_KEY = /^[A-Za-z0-9_-]{32,128}$/;

export function buildSandboxSpec(input: SandboxSpecInput, settings: RunnerSettings): ContainerSpec {
  for (const key of [input.sessionApiKey, input.agentSecretKey]) {
    if (!RANDOM_KEY.test(key)) throw new TypeError('sandbox keys must be random URL-safe strings');
  }
  const { limits } = settings;
  const tmpfs = (mode: string, exec: boolean) =>
    `rw,${exec ? 'exec' : 'noexec'},nosuid,nodev,size=${String(limits.tmpBytes)},mode=${mode},uid=10001,gid=10001`;
  return {
    Image: input.image,
    User: SANDBOX_USER,
    Env: [
      `SESSION_API_KEY=${input.sessionApiKey}`,
      `OH_SECRET_KEY=${input.agentSecretKey}`,
      ...FIXED_ENV,
      ...(settings.npmRegistry
        ? [
            `NPM_CONFIG_REGISTRY=${settings.npmRegistry}`,
            // Corepack fetches the pnpm (or yarn) version a project pins in `packageManager`.
            `COREPACK_NPM_REGISTRY=${settings.npmRegistry.replace(/\/$/, '')}`,
          ]
        : []),
    ],
    Labels: input.labels,
    WorkingDir: WORKSPACE_PATH,
    NetworkDisabled: false,
    HostConfig: {
      NetworkMode: input.names.network,
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      Memory: limits.memoryBytes,
      MemorySwap: limits.memoryBytes,
      NanoCpus: limits.nanoCpus,
      PidsLimit: limits.pids,
      Tmpfs: {
        [TMPFS_PATHS[0]]: tmpfs('1777', true),
        [TMPFS_PATHS[1]]: tmpfs('0700', false),
      },
      Mounts: [
        { Type: 'volume', Source: input.names.volume, Target: WORKSPACE_PATH, ReadOnly: false },
      ],
      RestartPolicy: { Name: 'no' },
      AutoRemove: false,
      Init: true,
      // Task H06 (ADR-M25 §2.12): gVisor or Kata when the operator chose one.
      ...(settings.sandboxRuntime ? { Runtime: settings.sandboxRuntime } : {}),
      ...(settings.sandboxRuntime && input.hosts && input.hosts.length > 0
        ? { ExtraHosts: [...input.hosts] }
        : {}),
    },
  };
}
