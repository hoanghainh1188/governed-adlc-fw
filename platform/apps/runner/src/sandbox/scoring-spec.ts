// The scoring container of an evaluation run (task L04, design/ADR-M81 §2.5, QUESTIONS #463). The
// sandbox image scores the run in two steps, each a container of its own over one workspace volume:
//
// 1. `install`: a clean install from the base lockfile, on the run's internal network with the
//    package proxy only (the same reach as the agent's sandbox);
// 2. `score`: the agent's diff and the hidden tests, with **no network at all**.
//
// Both are as hardened as the sandbox (read-only root, user 10001, no capability, no-new-
// privileges, memory, CPU and process limits, tmpfs, the one volume of the run). They differ in a
// fixed command and their own environment. The guard (docker/guard.ts) checks them again before
// they reach Docker. The Docker client has no exec: the command is the container's own.
import {
  SANDBOX_USER,
  SCORING_COMMANDS,
  SCORING_ENTRYPOINT,
  TMPFS_PATHS,
  WORKSPACE_PATH,
  type ScoringContainerSpec,
  type ScoringPhase,
} from '../docker/guard.js';
import type { RunNames } from '../names.js';
import type { RunnerSettings } from '../settings.js';

export interface ScoringSpecInput {
  readonly names: RunNames;
  readonly labels: Readonly<Record<string, string>>;
  /** The sandbox image pinned by digest. */
  readonly image: string;
  readonly phase: ScoringPhase;
}

/** On the volume next to the repository, so pnpm links packages from the store. */
const PNPM_STORE = '/workspace/.pnpm-store';
/**
 * Corepack's cache on the volume too: the install step fetches the pnpm a project pins, and the
 * step without a network must find it again (the tmpfs of the first container is gone).
 */
const COREPACK_HOME = '/workspace/.corepack';

export function buildScoringSpec(
  input: ScoringSpecInput,
  settings: RunnerSettings,
): ScoringContainerSpec {
  const { limits } = settings;
  const tmpfs = (mode: string, exec: boolean) =>
    `rw,${exec ? 'exec' : 'noexec'},nosuid,nodev,size=${String(limits.tmpBytes)},mode=${mode},uid=10001,gid=10001`;
  const install = input.phase === 'install';
  if (install && !settings.npmRegistry)
    throw new TypeError('the install step needs the package proxy');
  return {
    Image: input.image,
    User: SANDBOX_USER,
    Env: [
      'HOME=/home/openhands',
      'CI=1',
      `COREPACK_HOME=${COREPACK_HOME}`,
      ...(install && settings.npmRegistry
        ? [
            `NPM_CONFIG_REGISTRY=${settings.npmRegistry}`,
            `COREPACK_NPM_REGISTRY=${settings.npmRegistry.replace(/\/$/, '')}`,
            `NPM_CONFIG_STORE_DIR=${PNPM_STORE}`,
          ]
        : [`NPM_CONFIG_STORE_DIR=${PNPM_STORE}`]),
    ],
    Labels: input.labels,
    WorkingDir: WORKSPACE_PATH,
    NetworkDisabled: false,
    Entrypoint: SCORING_ENTRYPOINT,
    Cmd: [SCORING_COMMANDS[input.phase]],
    HostConfig: {
      // The step that runs the agent's code has no network, not even the run's internal one.
      NetworkMode: install ? input.names.network : 'none',
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
      // Task H06 (ADR-M25 §2.12): the agent's code runs here too, under the same runtime.
      ...(settings.sandboxRuntime ? { Runtime: settings.sandboxRuntime } : {}),
    },
  };
}
