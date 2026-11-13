// Guard for everything the runner asks Docker to create (ADR-M25 §2.5). The spec builder
// (sandbox/spec.ts) already produces a hardened container; the guard checks it again at the last
// point before the socket, so a later code change cannot weaken a sandbox by accident.
//
// Allowlist, not blocklist: a key that is not listed here is refused, so a new Docker option
// (privileged, host mounts, devices, host namespaces…) never slips through unnoticed.
// The shared AuthZ denylist (H07, ADR-M105) is checked too, so the guard and the Engine plugin
// cannot disagree on host-escape create bodies.
import { TOOL_RUNTIME_DIR } from '@sdlc/contracts';
import { evaluateAuthz } from '@sdlc/docker-authz';

import { RunnerError } from '../errors.js';
import { LABELS, MANAGED_BY } from '../names.js';
import { isSandboxRuntime, type SandboxRuntime } from '../settings.js';

/** Environment variables a sandbox may receive (FR-33, ADR-M10 §2.4). Values are never secrets. */
export const SANDBOX_ENV_ALLOWLIST = [
  'SESSION_API_KEY', // random per run, authenticates the runner to the Agent Server
  'OH_SECRET_KEY', // random per run, encrypts the Agent Server's own state
  'OH_ENABLE_VSCODE',
  'OH_TELEMETRY_EXPORTER',
  'DO_NOT_TRACK',
  'OPENHANDS_SUPPRESS_BANNER',
  'NPM_CONFIG_REGISTRY', // the package proxy (QUESTIONS #59 C)
  'COREPACK_NPM_REGISTRY', // same proxy, so a project's `packageManager` pin can be fetched
] as const;

/**
 * Environment variables of a scoring container (task L04, ADR-M81 §2.5, QUESTIONS #463). The
 * install step reaches the package proxy; the step that runs the tests has no network at all.
 * Values are never secrets.
 */
export const SCORING_ENV_ALLOWLIST = [
  'HOME',
  'CI',
  'NPM_CONFIG_REGISTRY',
  'COREPACK_NPM_REGISTRY',
  'NPM_CONFIG_STORE_DIR',
  'COREPACK_HOME', // on the volume, so the pnpm the install step fetched is there for the next step
] as const;

/**
 * The two steps of the scoring container, each with its one fixed command (the scripts are written
 * by the platform into the volume). `install`: a clean install from the base lockfile, on the run's
 * internal network with the package proxy. `score`: the agent's diff and the hidden tests, with
 * **no network** (`NetworkMode: none`).
 */
export const SCORING_COMMANDS = {
  install: 'sh /workspace/in/install.sh',
  score: 'sh /workspace/in/score.sh',
} as const;
export type ScoringPhase = keyof typeof SCORING_COMMANDS;
export const SCORING_ENTRYPOINT = ['/bin/sh', '-c'] as const;

export const WORKSPACE_PATH = '/workspace';
export const SANDBOX_USER = '10001:10001';
/** tmpfs mounts of a sandbox. `/tmp` needs `exec` (ADR-M10 §2.4). */
export const TMPFS_PATHS = ['/tmp', '/home/openhands'] as const;

export interface ContainerSpec {
  readonly Image: string;
  readonly User: string;
  readonly Env: readonly string[];
  readonly Labels: Readonly<Record<string, string>>;
  readonly WorkingDir: string;
  readonly NetworkDisabled: false;
  readonly HostConfig: {
    readonly NetworkMode: string;
    readonly ReadonlyRootfs: true;
    readonly CapDrop: readonly ['ALL'];
    readonly SecurityOpt: readonly ['no-new-privileges:true'];
    readonly Memory: number;
    readonly MemorySwap: number;
    readonly NanoCpus: number;
    readonly PidsLimit: number;
    readonly Tmpfs: Readonly<Record<string, string>>;
    readonly Mounts: readonly {
      readonly Type: 'volume';
      readonly Source: string;
      readonly Target: string;
      readonly ReadOnly: false;
    }[];
    readonly RestartPolicy: { readonly Name: 'no' };
    readonly AutoRemove: false;
    readonly Init: true;
    /** Task H06: only when the runner is configured with a stronger runtime (`runsc`, `kata`). */
    readonly Runtime?: SandboxRuntime;
  };
}

/** A scoring container: a sandbox container with a fixed command (`Entrypoint`, `Cmd`). */
export interface ScoringContainerSpec extends ContainerSpec {
  readonly Entrypoint: readonly string[];
  readonly Cmd: readonly string[];
}

const TOP_KEYS = new Set([
  'Image',
  'User',
  'Env',
  'Labels',
  'WorkingDir',
  'NetworkDisabled',
  'HostConfig',
]);
const SCORING_TOP_KEYS = new Set([...TOP_KEYS, 'Entrypoint', 'Cmd']);
const HOST_KEYS = new Set([
  'NetworkMode',
  'ReadonlyRootfs',
  'CapDrop',
  'SecurityOpt',
  'Memory',
  'MemorySwap',
  'NanoCpus',
  'PidsLimit',
  'Tmpfs',
  'Mounts',
  'RestartPolicy',
  'AutoRemove',
  'Init',
]);
/** Sandbox and scoring containers only (task H06): tool and gateway containers keep the default. */
const SANDBOX_HOST_KEYS = new Set([...HOST_KEYS, 'Runtime']);
const PINNED = /@sha256:[0-9a-f]{64}$/;
const SANDBOX_NAME = /^sdlc-sandbox-[0-9a-f-]{36}$/;
const RUN_NETWORK = /^sdlc-run-[0-9a-f-]{36}$/;
const TOOL_NETWORK = /^sdlc-tool-[0-9a-f-]{36}$/;
/** X04 PR 3b (QUESTIONS #531): a tool's service network, `sdlc-toolsvc-<run_id>-<tool_key>`. */
const SERVICE_NETWORK = /^sdlc-toolsvc-([0-9a-f-]{36})-[a-z][a-z0-9-]{1,62}$/;
const RUN_VOLUME = /^sdlc-ws-[0-9a-f-]{36}$/;
const TMPFS_OPTIONS =
  /^(?:rw,)?(?:exec|noexec),nosuid,nodev,size=[0-9]+,mode=[0-7]{3,4}(?:,uid=10001,gid=10001)?$/;

function refuse(check: string): never {
  throw new RunnerError('runner.docker.spec_refused', { check });
}

function sameList(actual: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((v, i) => v === expected[i])
  );
}

function positiveInt(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/**
 * Throws `runner.docker.spec_refused` unless the container is a hardened sandbox of one run.
 * `runtime` is the runner's configured sandbox runtime (task H06): the spec must name exactly that
 * runtime, or none when there is none.
 */
export function assertSafeContainerSpec(
  name: string,
  spec: ContainerSpec,
  runtime?: SandboxRuntime,
): void {
  checkHardening(name, spec, undefined, runtime);
}

/**
 * Throws `runner.docker.spec_refused` unless the container is a hardened scoring container of one
 * run (task L04, ADR-M81 §2.5, ADR-M25 §2.5): everything a sandbox must be (same name, labels,
 * image by digest, user, no capability, read-only root, limits, one volume of the run), plus a
 * fixed command for its `phase` and its own environment allowlist. The install step is on the run's
 * internal network; the step that runs the agent's diff and the hidden tests has no network.
 */
export function assertSafeScoringSpec(
  name: string,
  spec: ScoringContainerSpec,
  phase: ScoringPhase,
  runtime?: SandboxRuntime,
): void {
  checkHardening(name, spec, phase, runtime);
}

/**
 * Task H06 (ADR-M25 §2.12): with a configured runtime, the container must name it, and nothing else;
 * without one, it must name none (the Engine's default). Any other value is refused, so a code
 * change cannot pick a runtime the operator did not choose.
 */
function checkRuntime(host: Readonly<Record<string, unknown>>, runtime?: SandboxRuntime): void {
  const configured = runtime === undefined ? undefined : isSandboxRuntime(runtime) ? runtime : null;
  if (configured === null) refuse('runtime');
  if (!('Runtime' in host)) {
    if (configured !== undefined) refuse('runtime');
    return;
  }
  if (configured === undefined || host.Runtime !== configured) refuse('runtime');
}

function assertAuthzAllows(method: string, path: string, body: unknown): void {
  const decision = evaluateAuthz(method, path, body);
  if (!decision.allow) refuse(decision.reason ?? 'authz');
}

function checkHardening(
  name: string,
  spec: ContainerSpec,
  scoring: ScoringPhase | undefined,
  runtime: SandboxRuntime | undefined,
): void {
  assertAuthzAllows('POST', '/containers/create', spec);
  const raw = spec as unknown as Record<string, unknown>;
  const host = (raw.HostConfig ?? {}) as Record<string, unknown>;
  if (!SANDBOX_NAME.test(name)) refuse('name');
  const topKeys = scoring === undefined ? TOP_KEYS : SCORING_TOP_KEYS;
  if (Object.keys(raw).some((key) => !topKeys.has(key))) refuse('unknown_option');
  if (scoring !== undefined) {
    if (!sameList(raw.Entrypoint, SCORING_ENTRYPOINT)) refuse('scoring_entrypoint');
    if (!sameList(raw.Cmd, [SCORING_COMMANDS[scoring]])) refuse('scoring_command');
  }
  if (Object.keys(host).some((key) => !SANDBOX_HOST_KEYS.has(key))) refuse('unknown_host_option');
  checkRuntime(host, runtime);
  if (typeof spec.Image !== 'string' || !PINNED.test(spec.Image)) refuse('image_not_pinned');
  if (spec.User !== SANDBOX_USER) refuse('user');
  if (spec.WorkingDir !== WORKSPACE_PATH) refuse('working_dir');
  if (spec.NetworkDisabled !== false) refuse('network_disabled');

  const env = Array.isArray(spec.Env) ? spec.Env : refuse('env');
  const names = env.map((entry) => (typeof entry === 'string' ? entry.split('=')[0] : ''));
  const allowed: readonly string[] =
    scoring === undefined ? SANDBOX_ENV_ALLOWLIST : SCORING_ENV_ALLOWLIST;
  if (names.some((n) => !allowed.includes(n ?? ''))) refuse('env');
  if (new Set(names).size !== names.length) refuse('env');

  const labels = spec.Labels as Record<string, unknown> | undefined;
  if (labels?.[LABELS.managed] !== MANAGED_BY) refuse('labels');
  if (`sdlc-sandbox-${String(labels[LABELS.runId])}` !== name) refuse('labels');

  const hc = spec.HostConfig;
  if (scoring === 'score') {
    // The agent's code runs here: no network of any kind, not even the run's internal one.
    if (hc.NetworkMode !== 'none') refuse('network');
  } else if (
    !RUN_NETWORK.test(hc.NetworkMode) ||
    hc.NetworkMode !== `sdlc-run-${String(labels[LABELS.runId])}`
  ) {
    refuse('network');
  }
  if (hc.ReadonlyRootfs !== true) refuse('read_only');
  if (!sameList(hc.CapDrop, ['ALL'])) refuse('capabilities');
  if (!sameList(hc.SecurityOpt, ['no-new-privileges:true'])) refuse('security_opt');
  if (!positiveInt(hc.Memory) || hc.MemorySwap !== hc.Memory) refuse('memory');
  if (!positiveInt(hc.NanoCpus)) refuse('cpus');
  if (!positiveInt(hc.PidsLimit)) refuse('pids');
  if (hc.RestartPolicy?.Name !== 'no' || hc.AutoRemove !== false || hc.Init !== true) {
    refuse('lifecycle');
  }

  const tmpfs = Object.entries(hc.Tmpfs ?? {});
  if (
    !sameList(
      tmpfs.map(([path]) => path),
      TMPFS_PATHS,
    ) ||
    tmpfs.some(([, options]) => !TMPFS_OPTIONS.test(options))
  ) {
    refuse('tmpfs');
  }

  // The only mount: the run's own workspace volume. Never a bind mount, never the Docker socket.
  const mounts: readonly unknown[] = Array.isArray(hc.Mounts)
    ? (hc.Mounts as readonly unknown[])
    : refuse('mounts');
  const mount = (mounts[0] ?? {}) as Readonly<Record<string, unknown>>;
  const workspaceVolume = `sdlc-ws-${String(labels[LABELS.runId])}`;
  if (
    mounts.length !== 1 ||
    mount.Type !== 'volume' ||
    mount.Source !== workspaceVolume ||
    !RUN_VOLUME.test(workspaceVolume) ||
    mount.Target !== WORKSPACE_PATH ||
    mount.ReadOnly !== false ||
    Object.keys(mount).length !== 4
  ) {
    refuse('mounts');
  }
}

/** Throws unless the network is a run's own internal bridge (no route out, ADR-M25 §2.2). */
export function assertSafeNetworkSpec(spec: {
  readonly Name: string;
  readonly Driver: string;
  readonly Internal: boolean;
  readonly Attachable: boolean;
  readonly EnableIPv6: boolean;
  readonly Labels: Readonly<Record<string, string>>;
  readonly Options: Readonly<Record<string, string>>;
}): void {
  assertAuthzAllows('POST', '/networks/create', spec);
  const allowed = new Set([
    'Name',
    'Driver',
    'Internal',
    'Attachable',
    'EnableIPv6',
    'Labels',
    'Options',
  ]);
  if (Object.keys(spec).some((key) => !allowed.has(key))) refuse('unknown_network_option');
  // A run's network, or (X04, ADR-M69 §2.4) its tool network or a tool's service network: the
  // same internal bridge.
  if (
    !RUN_NETWORK.test(spec.Name) &&
    !TOOL_NETWORK.test(spec.Name) &&
    !SERVICE_NETWORK.test(spec.Name)
  ) {
    refuse('network_name');
  }
  if (spec.Driver !== 'bridge' || spec.Internal !== true) refuse('network_internal');
  if (spec.Attachable !== false || spec.EnableIPv6 !== false) refuse('network_options');
  if (spec.Labels[LABELS.managed] !== MANAGED_BY) refuse('labels');
  const runId = String(spec.Labels[LABELS.runId]);
  if (
    `sdlc-run-${runId}` !== spec.Name &&
    `sdlc-tool-${runId}` !== spec.Name &&
    SERVICE_NETWORK.exec(spec.Name)?.[1] !== runId
  ) {
    refuse('labels');
  }
  // Exactly one option: no IP address for the bridge, so the host is not reachable (ADR-M25 §2.2).
  const options = Object.entries(spec.Options);
  if (
    options.length !== 1 ||
    options[0]?.[0] !== 'com.docker.network.bridge.inhibit_ipv4' ||
    options[0][1] !== 'true'
  ) {
    refuse('network_options');
  }
}

/**
 * Throws unless `container` may join the run's network `network` (ADR-M25 §2.2, ADR-M29): only a
 * run's own network, and only a container the runner was configured to attach (the egress services
 * and the runner itself). Everything else stays off the sandbox's network.
 */
export function assertSafeNetworkConnect(
  network: string,
  container: string,
  allowed: readonly string[],
): void {
  if (!RUN_NETWORK.test(network)) refuse('connect_network');
  if (!allowed.includes(container)) refuse('connect_container');
}

/**
 * Throws unless `container` may join a tool's service network (X04 PR 3b, ADR-M69 §2.4, QUESTIONS
 * #531): only a service network of `toolContainer`'s own run and tool, and only the tool itself or
 * one of the backing services the runner was configured with (`SDLC_RUNNER_TOOL_SERVICES`). Never
 * the gateway, the sandbox or another tool.
 */
export function assertSafeServiceConnect(
  network: string,
  container: string,
  toolContainer: string,
  services: readonly string[],
): void {
  const match = SERVICE_NETWORK.exec(network);
  if (!match || `sdlc-toolsvc-${toolContainer.slice('sdlc-tool-'.length)}` !== network) {
    refuse('connect_network');
  }
  if (!TOOL_NAME.test(toolContainer)) refuse('connect_network');
  if (container !== toolContainer && !services.includes(container)) refuse('connect_container');
}

/** The user every `http` tool image runs as (ADR-M69 §2.4): never root. */
export const TOOL_USER = '10001:10001';
/** The user of the agentgateway image (`nonroot`). */
export const GATEWAY_USER = '65532:65532';
/** Where the gateway reads its configuration (the run's config volume). */
export const GATEWAY_CONFIG_DIR = '/config';
/** The gateway's one fixed command: its configuration file, nothing else. */
export const GATEWAY_COMMAND = ['-f', `${GATEWAY_CONFIG_DIR}/config.yaml`] as const;
/** tmpfs of a tool container: `/tmp` only, never executable. */
export const TOOL_TMPFS_PATH = '/tmp';
/**
 * The bounded log of a tool or gateway container: one file of at most 4 MiB, so the host's disk
 * stays safe and the runner can read the whole log (its responses are capped at 8 MiB). A sandbox
 * that floods the gateway can only push older lines out: the counts are then a lower bound.
 */
export const TOOL_LOG_CONFIG = { 'max-size': '4m', 'max-file': '1' } as const;

/** A tool or gateway container of one run (X04, ADR-M69 §2.4). Fields as `ContainerSpec`. */
export interface ToolContainerSpec {
  readonly Image: string;
  readonly User: string;
  readonly Env: readonly string[];
  readonly Labels: Readonly<Record<string, string>>;
  readonly Cmd?: readonly string[];
  readonly NetworkDisabled: false;
  /**
   * Tools only: a short alias on the tool network (`t-<12 hex>`), the host the gateway calls. A
   * container name (`sdlc-tool-<run>-<key>`) can be longer than a DNS label (63 characters).
   */
  readonly NetworkingConfig?: {
    readonly EndpointsConfig: Readonly<Record<string, { readonly Aliases: readonly string[] }>>;
  };
  readonly HostConfig: {
    readonly NetworkMode: string;
    /** Bounded logs (X04): the gateway's log is evidence the sandbox could otherwise flood. */
    readonly LogConfig: { readonly Type: 'json-file'; readonly Config: typeof TOOL_LOG_CONFIG };
    readonly ReadonlyRootfs: true;
    readonly CapDrop: readonly ['ALL'];
    readonly SecurityOpt: readonly ['no-new-privileges:true'];
    readonly Memory: number;
    readonly MemorySwap: number;
    readonly NanoCpus: number;
    readonly PidsLimit: number;
    readonly Tmpfs: Readonly<Record<string, string>>;
    readonly Mounts: readonly {
      readonly Type: 'volume';
      readonly Source: string;
      readonly Target: string;
      readonly ReadOnly: false;
    }[];
    readonly RestartPolicy: { readonly Name: 'no' };
    readonly AutoRemove: false;
    readonly Init: true;
  };
}

const TOOL_TOP_KEYS = new Set([
  'Image',
  'User',
  'Env',
  'Labels',
  'Cmd',
  'NetworkDisabled',
  'NetworkingConfig',
  'HostConfig',
]);
const TOOL_HOST_KEYS = new Set([...HOST_KEYS, 'LogConfig']);
const TOOL_ALIAS = /^t-[0-9a-f]{12}$/;
const TOOL_NAME = /^sdlc-tool-([0-9a-f-]{36})-[a-z][a-z0-9-]{1,62}$/;
const GATEWAY_NAME = /^sdlc-gw-([0-9a-f-]{36})$/;
const TOOL_TMPFS_OPTIONS = /^rw,noexec,nosuid,nodev,size=[0-9]+,mode=1777$/;

/**
 * The hardening of a tool or gateway container: a run's labels, the image by digest, a fixed
 * non-root user, no environment value (none is allowed yet), no capability, a read-only root, the
 * limits, the run's tool network only, no restart. The mounts and the command are checked by the
 * caller.
 */
function checkToolHardening(
  name: string,
  spec: ToolContainerSpec,
  runId: string,
  user: string,
): void {
  assertAuthzAllows('POST', '/containers/create', spec);
  const raw = spec as unknown as Record<string, unknown>;
  const host = (raw.HostConfig ?? {}) as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !TOOL_TOP_KEYS.has(key))) refuse('unknown_option');
  if (Object.keys(host).some((key) => !TOOL_HOST_KEYS.has(key))) refuse('unknown_host_option');
  if (typeof spec.Image !== 'string' || !PINNED.test(spec.Image)) refuse('image_not_pinned');
  if (spec.User !== user) refuse('user');
  const log = host.LogConfig as Record<string, unknown> | undefined;
  if (
    log?.Type !== 'json-file' ||
    JSON.stringify(log.Config) !== JSON.stringify(TOOL_LOG_CONFIG) ||
    Object.keys(log).length !== 2
  ) {
    refuse('log_config');
  }
  if (spec.NetworkDisabled !== false) refuse('network_disabled');
  // No environment value: a tool's credential is a file (ADR-M69 §2.4), never an environment value.
  if (!Array.isArray(spec.Env) || spec.Env.length !== 0) refuse('env');
  const labels = spec.Labels as Record<string, unknown> | undefined;
  if (labels?.[LABELS.managed] !== MANAGED_BY || labels[LABELS.runId] !== runId) refuse('labels');
  const hc = spec.HostConfig;
  if (hc.NetworkMode !== `sdlc-tool-${runId}`) refuse('network');
  if (hc.ReadonlyRootfs !== true) refuse('read_only');
  if (!sameList(hc.CapDrop, ['ALL'])) refuse('capabilities');
  if (!sameList(hc.SecurityOpt, ['no-new-privileges:true'])) refuse('security_opt');
  if (!positiveInt(hc.Memory) || hc.MemorySwap !== hc.Memory) refuse('memory');
  if (!positiveInt(hc.NanoCpus)) refuse('cpus');
  if (!positiveInt(hc.PidsLimit)) refuse('pids');
  if (hc.RestartPolicy?.Name !== 'no' || hc.AutoRemove !== false || hc.Init !== true) {
    refuse('lifecycle');
  }
  void name;
}

/**
 * Throws unless the container is a hardened tool container of one run (X04, ADR-M69 §2.4): the
 * tool image by digest, its own command (none given), no mount, `/tmp` as a non-executable tmpfs,
 * on the run's tool network only, never on the run network.
 */
export function assertSafeToolSpec(name: string, spec: ToolContainerSpec): void {
  const runId = TOOL_NAME.exec(name)?.[1] ?? refuse('name');
  checkToolHardening(name, spec, runId, TOOL_USER);
  if (spec.Cmd !== undefined) refuse('command');
  const endpoints = Object.entries(spec.NetworkingConfig?.EndpointsConfig ?? {});
  const endpoint = endpoints[0];
  if (
    endpoints.length !== 1 ||
    endpoint?.[0] !== `sdlc-tool-${runId}` ||
    Object.keys(spec.NetworkingConfig ?? {}).length !== 1 ||
    Object.keys(endpoint[1]).length !== 1 ||
    !Array.isArray(endpoint[1].Aliases) ||
    endpoint[1].Aliases.length !== 1 ||
    !TOOL_ALIAS.test(String(endpoint[1].Aliases[0]))
  ) {
    refuse('network_alias');
  }
  const tmpfs = Object.entries(spec.HostConfig.Tmpfs ?? {});
  if (
    tmpfs.length !== 1 ||
    tmpfs[0]?.[0] !== TOOL_TMPFS_PATH ||
    !TOOL_TMPFS_OPTIONS.test(tmpfs[0][1])
  ) {
    refuse('tmpfs');
  }
  // X04 PR 3b: no mount, or one: the tool's own runtime volume (its settings and credential).
  const mounts: readonly unknown[] = Array.isArray(spec.HostConfig.Mounts)
    ? spec.HostConfig.Mounts
    : refuse('mounts');
  if (mounts.length > 1) refuse('mounts');
  if (mounts.length === 1) {
    const mount = mounts[0] as Readonly<Record<string, unknown>>;
    if (
      mount.Type !== 'volume' ||
      mount.Source !== `sdlc-toolrt-${name.slice('sdlc-tool-'.length)}` ||
      mount.Target !== TOOL_RUNTIME_DIR ||
      mount.ReadOnly !== false ||
      Object.keys(mount).length !== 4
    ) {
      refuse('mounts');
    }
  }
}

/**
 * Throws unless the container is the hardened MCP gateway of one run (X04, ADR-M87 §5): the
 * gateway image by digest, its one fixed command, no tmpfs, and one mount: the run's config volume.
 */
export function assertSafeGatewaySpec(name: string, spec: ToolContainerSpec): void {
  const runId = GATEWAY_NAME.exec(name)?.[1] ?? refuse('name');
  checkToolHardening(name, spec, runId, GATEWAY_USER);
  if (spec.NetworkingConfig !== undefined) refuse('network_alias');
  if (!sameList(spec.Cmd, GATEWAY_COMMAND)) refuse('command');
  if (Object.keys(spec.HostConfig.Tmpfs ?? {}).length !== 0) refuse('tmpfs');
  const mounts: readonly unknown[] = Array.isArray(spec.HostConfig.Mounts)
    ? spec.HostConfig.Mounts
    : refuse('mounts');
  const mount = (mounts[0] ?? {}) as Readonly<Record<string, unknown>>;
  if (
    mounts.length !== 1 ||
    mount.Type !== 'volume' ||
    mount.Source !== `sdlc-gwcfg-${runId}` ||
    mount.Target !== GATEWAY_CONFIG_DIR ||
    mount.ReadOnly !== false ||
    Object.keys(mount).length !== 4
  ) {
    refuse('mounts');
  }
}
