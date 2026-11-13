// Creating and removing the Docker objects of one run (ADR-M25 §2.3, §2.8). Session 2 of C04
// wraps these in the full provisioning flow: unwrap the GitHub token, verify the Run Contract,
// claim the run, prepare the workspace, record run events.
//
// Order of creation: workspace volume → internal network → attach the allowed services → sandbox
// container → (workspace archive) → start. Any failure removes everything created so far.
import crypto from 'node:crypto';

import { AGENT_ADAPTER_LABEL, type AgentAdapterCode } from '@sdlc/contracts';

import type { DockerClient, ImageInfo } from '../docker/client.js';
import { assertSafeNetworkConnect } from '../docker/guard.js';
import { RunnerError } from '../errors.js';
import { LABELS, runLabels, runNames, type RunNames } from '../names.js';
import type { RunnerSettings } from '../settings.js';
import { teardownTools } from '../tools/teardown.js';
import { runNetworkHosts } from './hosts.js';
import { planEgress, runNetworkSpec } from './network.js';
import { buildSandboxSpec } from './spec.js';

/** Why provisioning stopped before the sandbox was ready (run event `provisioning_failed`). */
export type ProvisioningFailure =
  | 'token_unavailable' // the wrapped GitHub token was unknown, expired or already used
  | 'config_unavailable' // the project configuration could not be loaded
  | 'egress_not_enforceable'
  | 'clone_failed'
  | 'base_sha_not_found'
  | 'token_leaked' // the token was found in the clone's configuration (never expected)
  | 'workspace_too_large'
  | 'workspace_invalid' // a hard link, device, FIFO, socket or path escape in the repository
  | 'image_unavailable'
  | 'image_not_configured' // X03: the project has no sandbox image for the agent's adapter
  | 'adapter_unavailable' // X03: this runner has no adapter of the contract's `agent_adapter`
  | 'adapter_mismatch' // X03: the image's `sdlc.agent.adapter` label names another adapter
  | 'image_has_no_healthcheck'
  | 'sandbox_unhealthy'
  | 'sandbox_not_ready'
  | 'run_stopped' // the run left `provisioning` meanwhile (kill switch)
  | 'tool_unavailable' // X04: a register tool or the run's MCP gateway did not start
  | 'docker_error';

/**
 * Why the runner removed a sandbox (run event `sandbox_removed`). `orphan`: the sweep found objects
 * of a run this process does not hold; `runner_restarted`: the clean-up when the runner starts.
 */
export type TeardownReason =
  'finished' | 'failed' | 'provisioning_failed' | 'killed' | 'orphan' | 'runner_restarted';

export interface CreateSandboxInput {
  readonly runId: string;
  readonly tenantId: string;
  /** Project image pinned by digest (config `sandbox.image` or `sandbox.images.<adapter>`). */
  readonly image: string;
  /**
   * X03 (ADR-M68 §7): the adapter that will drive the agent. The image's `sdlc.agent.adapter`
   * label must name it; an image without the label is an OpenHands image (built before X03).
   */
  readonly adapter: AgentAdapterCode;
  /** The contract's `egress_allowlist`. */
  readonly egressAllowlist: readonly string[];
  /** Tar archive extracted into `/workspace` before the sandbox starts (the cloned repository). */
  readonly workspaceTar?: Buffer;
  /** The workspace volume already exists: `reserveWorkspace` created it before the claim. */
  readonly workspaceReserved?: boolean;
  /**
   * X04 (ADR-M69 §2.4): starts the run's register tools and MCP gateway once the run network
   * exists, before the sandbox. Returns the agent's per-run key to the gateway.
   */
  readonly startTools?: (
    names: RunNames,
    labels: Readonly<Record<string, string>>,
  ) => Promise<string>;
}

export interface Sandbox {
  readonly names: RunNames;
  readonly containerId: string;
  /** Hex digest of the image, for the run event `sandbox_created`. */
  readonly imageSha256: string;
  /** Random per run; the runner uses it to call the Agent Server (C05). Never logged. */
  readonly sessionApiKey: string;
  /** X04: random per run, the agent's key to the run's MCP gateway; absent without tools. */
  readonly toolKey?: string;
}

export class ProvisioningError extends RunnerError {
  constructor(readonly reason: ProvisioningFailure) {
    super('runner.provisioning_failed', { reason });
  }
}

function randomKey(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function digestOf(image: string): string {
  const match = /@sha256:([0-9a-f]{64})$/.exec(image);
  if (!match) throw new ProvisioningError('image_unavailable');
  return match[1]!;
}

export async function ensureImage(docker: DockerClient, image: string): Promise<void> {
  await inspectOrPull(docker, image);
}

async function inspectOrPull(docker: DockerClient, image: string): Promise<ImageInfo> {
  const present = await docker.imageInspect(image);
  if (present) return present;
  try {
    await docker.imagePull(image);
  } catch {
    throw new ProvisioningError('image_unavailable');
  }
  const pulled = await docker.imageInspect(image);
  if (!pulled) throw new ProvisioningError('image_unavailable');
  return pulled;
}

/**
 * The adapter an image names in its label `sdlc.agent.adapter` (ADR-M68 §7). An image without the
 * label is an OpenHands image: the default base and the images built before X03 have none. The
 * image is pinned by digest, so its labels are fixed with it.
 */
export function imageAdapter(labels: Readonly<Record<string, string>> | null | undefined): string {
  return labels?.[AGENT_ADAPTER_LABEL] ?? 'openhands';
}

/** Pulls the image if needed and checks that it is an image of `adapter` (`adapter_mismatch`). */
export async function ensureAdapterImage(
  docker: DockerClient,
  image: string,
  adapter: AgentAdapterCode,
): Promise<void> {
  const info = await inspectOrPull(docker, image);
  if (imageAdapter(info.Config?.Labels) !== adapter) {
    throw new ProvisioningError('adapter_mismatch');
  }
}

/** Creates and starts the sandbox of one run, or removes everything and throws. */
export async function createSandbox(
  docker: DockerClient,
  settings: RunnerSettings,
  input: CreateSandboxInput,
): Promise<Sandbox> {
  const names = runNames(input.runId);
  const labels = runLabels(settings.instance, input.runId, input.tenantId);
  const egress = planEgress(input.egressAllowlist, settings.egressServices);
  if (!egress.ok) throw new ProvisioningError(egress.reason);
  const imageSha256 = digestOf(input.image);
  await ensureAdapterImage(docker, input.image, input.adapter);

  const sessionApiKey = randomKey();
  try {
    if (!input.workspaceReserved) await docker.volumeCreate(names.volume, labels);
    await docker.networkCreate(runNetworkSpec(names, labels));
    const attachable = settings.egressServices.map((s) => s.container);
    for (const service of egress.services) {
      assertSafeNetworkConnect(names.network, service.container, attachable);
      await docker.networkConnect(names.network, service.container, [service.alias]);
    }
    const toolKey = input.startTools ? await input.startTools(names, labels) : undefined;
    // H06: gVisor has no Docker DNS; the names of the run network go into /etc/hosts.
    const hosts = settings.sandboxRuntime ? await runNetworkHosts(docker, names.network) : [];
    const spec = buildSandboxSpec(
      {
        names,
        labels,
        image: input.image,
        sessionApiKey,
        agentSecretKey: randomKey(),
        hosts,
      },
      settings,
    );
    const containerId = await docker.containerCreate(names.container, spec);
    if (input.workspaceTar) await docker.putArchive(containerId, '/workspace', input.workspaceTar);
    await docker.containerStart(containerId);
    return {
      names,
      containerId,
      imageSha256,
      sessionApiKey,
      ...(toolKey === undefined ? {} : { toolKey }),
    };
  } catch (error) {
    await teardownSandbox(docker, input.runId);
    if (error instanceof RunnerError) throw error;
    throw new ProvisioningError('docker_error');
  }
}

/**
 * Creates the run's labelled workspace volume **before** the run is claimed (ADR-M25 §2.8). So
 * every claimed run has at least one labelled Docker object, and the clean-up after a crash finds
 * it. Docker's volume create is idempotent, so the runner looks first: `existed` means the volume
 * was already there (objects of an earlier provisioning of this run), and it must not be removed
 * when the claim fails; the sweep deals with it.
 */
export async function reserveWorkspace(
  docker: DockerClient,
  settings: RunnerSettings,
  runId: string,
  tenantId: string,
): Promise<'created' | 'existed'> {
  const names = runNames(runId);
  const labels = runLabels(settings.instance, runId, tenantId);
  const found = await docker.volumeList({ [LABELS.runId]: runId });
  if (found.some((v) => v.Name === names.volume)) return 'existed';
  await docker.volumeCreate(names.volume, labels);
  return 'created';
}

/** Removes a workspace volume that `reserveWorkspace` created when the claim failed. */
export async function releaseWorkspace(docker: DockerClient, runId: string): Promise<void> {
  await docker.volumeRemove(runNames(runId).volume);
}

export interface TeardownResult {
  readonly container: boolean;
  readonly network: boolean;
  readonly volume: boolean;
  readonly durationMs: number;
}

/**
 * Removes the sandbox, its network and its workspace volume (D-08 C04 AC5). Idempotent: objects
 * that are already gone are skipped, so it is safe after a success, a failure, a kill or a crash.
 * Every step runs even when an earlier one fails; the first error is thrown at the end.
 *
 * Every container still on the run's network is detached first: the egress services, and the
 * runner itself, which joins the network to call the Agent Server (C05, ADR-M29).
 */
export async function teardownSandbox(
  docker: DockerClient,
  runId: string,
): Promise<TeardownResult> {
  const started = Date.now();
  const names = runNames(runId);
  let firstError: Error | undefined;
  // X04 (ADR-M69 §2.8): the gateway first, so every tool of the run is cut at once.
  try {
    await teardownTools(docker, runId, { [LABELS.runId]: runId });
  } catch (error) {
    firstError = error instanceof Error ? error : new ProvisioningError('docker_error');
  }
  const attempt = async (step: () => Promise<boolean>): Promise<boolean> => {
    try {
      return await step();
    } catch (error) {
      firstError ??= error instanceof Error ? error : new ProvisioningError('docker_error');
      return false;
    }
  };

  const container = await attempt(() => docker.containerRemove(names.container));
  // Detach every container still attached (services, the runner) before the network can be
  // removed. Only those actually attached: Docker answers 500, not 404, for a container that is not
  // on the network.
  const network = await docker.networkInspect(names.network).catch(() => undefined);
  const attached = new Set(Object.values(network?.Containers ?? {}).map((c) => c.Name));
  for (const container of attached) {
    if (container === names.container) continue;
    await attempt(() => docker.networkDisconnect(names.network, container));
  }
  const removedNetwork = await attempt(() => docker.networkRemove(names.network));
  const volume = await attempt(() => docker.volumeRemove(names.volume));
  if (firstError !== undefined) throw firstError;
  return { container, network: removedNetwork, volume, durationMs: Date.now() - started };
}
