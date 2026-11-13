// Starting and removing a run's register tools and its MCP gateway (task X04, design/ADR-M69 §2.4,
// §2.8, ADR-M87 §5). Called by `createSandbox` after the run network exists and before the sandbox:
//
//   tool network → for a tool with backing services (X04 PR 3b): its service network and its
//   runtime volume → each tool container (by digest) → its settings and credential written as files
//   (archive upload) → the tool and its backing services joined to the service network → started
//   → tools healthy (their image's health check) → gateway config volume and file → gateway
//   container → joined to the run network under the alias `tools` → started → ready (its log line)
//
// A failure at any step throws `ProvisioningError('tool_unavailable')`; `createSandbox` then removes
// everything. The credential never reaches the sandbox, the gateway or another tool.
import crypto from 'node:crypto';

import {
  TOOL_CONFIG_FILE,
  TOOL_CREDENTIALS_FILE,
  TOOL_GATEWAY_ALIAS,
  TOOL_RUNTIME_DIR,
  toolCallRulesJson,
  type ToolGrant,
  type ToolRuntimeConfig,
  type ToolRuntimeCredentials,
  type CodeToolRuntimeConfig,
  type CodeToolRuntimeCredentials,
} from '@sdlc/contracts';

import type { DockerClient } from '../docker/client.js';
import {
  assertSafeNetworkConnect,
  assertSafeServiceConnect,
  GATEWAY_CONFIG_DIR,
} from '../docker/guard.js';
import { toolObjectNames, type RunNames, type ToolObjectNames } from '../names.js';
import { ProvisioningError } from '../sandbox/lifecycle.js';
import { INHIBIT_IPV4 } from '../sandbox/network.js';
import type { EgressService } from '../settings.js';
import { packTar } from '../workspace/tar.js';
import { buildGatewayConfig, GATEWAY_READY_MESSAGE } from './gateway-config.js';
import { buildGatewaySpec, buildToolSpec, toolHost, type ToolLimits } from './spec.js';

/** Why the tools of a run could not start: `provisioning_failed`, reason `tool_unavailable`. */
function unavailable(): ProvisioningError {
  return new ProvisioningError('tool_unavailable');
}

/**
 * True when this runner can enforce every grant (ADR-M69 §2.6): an `http` tool with a digest,
 * call rules equal to the runner's own catalogue, and (X04 PR 3b) only backing services this
 * runner was configured with, by alias and port (`SDLC_RUNNER_TOOL_SERVICES`).
 */
export function toolGrantsEnforceable(
  grants: readonly ToolGrant[],
  services: readonly EgressService[] = [],
): boolean {
  const known = new Set(services.map((s) => `${s.alias}:${String(s.port)}`));
  return grants.every(
    (grant) =>
      grant.transport === 'http' &&
      grant.backing_services.every((entry) => known.has(entry)) &&
      callRulesSha256(grant) === grant.call_rules_sha256,
  );
}

type Revealable<T> = { readonly [K in keyof T]: { reveal(): string } };

/**
 * X04 PR 3b: what a tool with backing services gets as files before it starts. X06 PR 2: a
 * `read_code` tool gets its own config and only a database login (ADR-M108 §2.8).
 */
export type ToolRuntime =
  | {
      readonly config: ToolRuntimeConfig;
      /** Revealed only into the file. */
      readonly credentials: Revealable<ToolRuntimeCredentials>;
    }
  | {
      readonly config: CodeToolRuntimeConfig;
      readonly credentials: Revealable<CodeToolRuntimeCredentials>;
    };

function callRulesSha256(grant: ToolGrant): string {
  return crypto
    .createHash('sha256')
    .update(toolCallRulesJson(grant.permissions), 'utf8')
    .digest('hex');
}

export interface StartToolsInput {
  readonly run: RunNames;
  readonly labels: Readonly<Record<string, string>>;
  readonly grants: readonly ToolGrant[];
  /** The image of each grant: `<image_ref>@<image_digest>`, by tool key. */
  readonly images: ReadonlyMap<string, string>;
  /** The gateway image by digest (configuration `tools.gateway.image`). */
  readonly gatewayImage: string;
  readonly limits: ToolLimits;
  readonly readyTimeoutMs: number;
  /** X04 PR 3b: the backing services this runner may attach (`SDLC_RUNNER_TOOL_SERVICES`). */
  readonly services?: readonly EgressService[];
  /** X04 PR 3b: the settings and credential of each tool with backing services, by tool key. */
  readonly runtime?: ReadonlyMap<string, ToolRuntime>;
}

export interface StartedTools {
  /** Random per run: the agent's key to the gateway. Never logged; the gateway holds its hash. */
  readonly key: string;
  /** The tools that became healthy, in key order (run event `tool_started`). */
  readonly started: readonly ToolGrant[];
}

const POLL_MS = 250;

/** Starts the tools and the gateway of a run. The caller removes everything on failure. */
export async function startTools(
  docker: DockerClient,
  input: StartToolsInput,
): Promise<StartedTools> {
  const names = toolObjectNames(input.run.runId);
  const grants = [...input.grants].sort((a, b) => (a.tool_key < b.tool_key ? -1 : 1));
  await docker.networkCreate({
    Name: names.toolNetwork,
    Driver: 'bridge',
    Internal: true,
    Attachable: false,
    EnableIPv6: false,
    Labels: input.labels,
    Options: { [INHIBIT_IPV4]: 'true' },
  });
  for (const grant of grants) {
    const image = input.images.get(grant.tool_key);
    if (image === undefined) throw unavailable();
    await ensure(docker, image);
    const withServices = grant.backing_services.length > 0;
    if (withServices) await prepareServices(docker, names, input, grant);
    const id = await docker.toolContainerCreate(
      names.tool(grant.tool_key),
      buildToolSpec({
        names,
        labels: input.labels,
        toolKey: grant.tool_key,
        image,
        limits: input.limits,
        runtime: withServices,
      }),
      'tool',
    );
    if (withServices) await attachServices(docker, names, input, grant, id);
    await docker.containerStart(id);
  }
  for (const grant of grants) await waitHealthy(docker, names.tool(grant.tool_key), input);

  const key = crypto.randomBytes(32).toString('base64url');
  const config = buildGatewayConfig({
    grants,
    keySha256: crypto.createHash('sha256').update(key, 'utf8').digest('hex'),
    toolHost,
  });
  await ensure(docker, input.gatewayImage);
  await docker.volumeCreate(names.gatewayConfig, input.labels);
  const gatewayId = await docker.toolContainerCreate(
    names.gateway,
    buildGatewaySpec({ names, labels: input.labels, image: input.gatewayImage }),
    'gateway',
  );
  await docker.putArchive(
    gatewayId,
    GATEWAY_CONFIG_DIR,
    packTar([{ type: 'file', path: 'config.yaml', content: Buffer.from(config, 'utf8') }]),
  );
  assertSafeNetworkConnect(input.run.network, names.gateway, [names.gateway]);
  await docker.networkConnect(input.run.network, names.gateway, [TOOL_GATEWAY_ALIAS]);
  await docker.containerStart(gatewayId);
  await waitGatewayReady(docker, names, input.readyTimeoutMs);
  return { key, started: grants };
}

/** The service network and the runtime volume of a tool with backing services (X04 PR 3b). */
async function prepareServices(
  docker: DockerClient,
  names: ToolObjectNames,
  input: StartToolsInput,
  grant: ToolGrant,
): Promise<void> {
  if (!input.runtime?.has(grant.tool_key)) throw unavailable();
  await docker.networkCreate({
    Name: names.serviceNetwork(grant.tool_key),
    Driver: 'bridge',
    Internal: true,
    Attachable: false,
    EnableIPv6: false,
    Labels: input.labels,
    Options: { [INHIBIT_IPV4]: 'true' },
  });
  await docker.volumeCreate(names.toolRuntime(grant.tool_key), input.labels);
}

/**
 * Writes the tool's settings and credential into its runtime volume (the container is created,
 * not started), then joins the tool and each of its backing services to its service network.
 */
async function attachServices(
  docker: DockerClient,
  names: ToolObjectNames,
  input: StartToolsInput,
  grant: ToolGrant,
  containerId: string,
): Promise<void> {
  const runtime = input.runtime?.get(grant.tool_key);
  if (runtime === undefined) throw unavailable();
  // Only the fields of the tool's own kind: a `read_code` tool has no model key (X06).
  const credentials: ToolRuntimeCredentials | CodeToolRuntimeCredentials = {
    db_username: runtime.credentials.db_username.reveal(),
    db_password: runtime.credentials.db_password.reveal(),
    ...('llm_key' in runtime.credentials ? { llm_key: runtime.credentials.llm_key.reveal() } : {}),
  };
  await docker.putArchive(
    containerId,
    TOOL_RUNTIME_DIR,
    packTar([
      {
        type: 'file',
        path: TOOL_CONFIG_FILE,
        content: Buffer.from(JSON.stringify(runtime.config), 'utf8'),
      },
      {
        type: 'file',
        path: TOOL_CREDENTIALS_FILE,
        content: Buffer.from(JSON.stringify(credentials), 'utf8'),
      },
    ]),
  );
  const network = names.serviceNetwork(grant.tool_key);
  const tool = names.tool(grant.tool_key);
  const services = input.services ?? [];
  const attachable = services.map((service) => service.container);
  assertSafeServiceConnect(network, tool, tool, attachable);
  await docker.networkConnect(network, tool, []);
  for (const entry of grant.backing_services) {
    const service = services.find((s) => `${s.alias}:${String(s.port)}` === entry);
    if (service === undefined) throw unavailable();
    assertSafeServiceConnect(network, service.container, tool, attachable);
    try {
      await docker.networkConnect(network, service.container, [service.alias]);
    } catch {
      // The service is not running (for example the profile `knowledge` is off).
      throw unavailable();
    }
  }
}

async function ensure(docker: DockerClient, image: string): Promise<void> {
  if (await docker.imageInspect(image)) return;
  try {
    await docker.imagePull(image);
  } catch {
    throw unavailable();
  }
  if (!(await docker.imageInspect(image))) throw unavailable();
}

/** A tool image must have a health check, like a sandbox image (ADR-M25 §2.3). */
async function waitHealthy(
  docker: DockerClient,
  name: string,
  input: Pick<StartToolsInput, 'readyTimeoutMs'>,
): Promise<void> {
  const deadline = Date.now() + input.readyTimeoutMs;
  for (;;) {
    const info = await docker.containerInspect(name);
    const health = info?.State.Health?.Status;
    if (!info?.State.Running) throw unavailable();
    if (health === undefined) throw unavailable();
    if (health === 'healthy') return;
    if (health === 'unhealthy' || Date.now() >= deadline) {
      throw unavailable();
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/**
 * The gateway is ready when its log says so: the runner never calls the gateway (it is not on the
 * tool network, and the readiness port is not published).
 */
async function waitGatewayReady(
  docker: DockerClient,
  names: ToolObjectNames,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const info = await docker.containerInspect(names.gateway);
    if (!info?.State.Running) throw unavailable();
    const logs = await docker.containerLogs(names.gateway, { stderr: true });
    if (logs.includes(GATEWAY_READY_MESSAGE)) return;
    if (Date.now() >= deadline) throw unavailable();
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}
