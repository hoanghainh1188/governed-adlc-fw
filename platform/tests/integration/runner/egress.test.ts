// D-08 C04 AC1, AC4, AC5 on a real Docker Engine (ADR-M25 §2.2, §2.4, §2.8). Runs only with
// SDLC_RUNNER_TEST=1 (`pnpm test:runner`; CI job `compose`). Same test on Docker Desktop (dev) and
// Linux (CI and the server): egress is enforced by the network layout, not by host firewall rules.
//
// Set-up (test infrastructure only, through the docker CLI):
// - a fixture sandbox image (live-helpers.ts: local build or a throw-away `registry:2`, QUESTIONS
//   #54) that probes the network from inside and prints the results (fixture/probe.sh);
// - an internal "platform" network with stub LiteLLM, stub npm proxy and a stub OpenBao (H07 AuthZ
//   requires Internal on every networks/create; the runner still attaches stubs to each run net);
// - host listeners in this process (H07 refuses `--network host` / port bindings on the Engine).
// The sandboxes themselves are created by the runner code under test (createSandbox), through the
// guard, exactly as in production.
import crypto from 'node:crypto';
import net from 'node:net';
import os from 'node:os';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createSandbox,
  DockerClient,
  LABELS,
  packTar,
  runnerSettingsFromEnv,
  teardownSandbox,
  type RunnerSettings,
} from '../../../apps/runner/src/index.js';
import {
  BUSYBOX,
  buildFixtureImage,
  createInternalNetwork,
  docker,
  dockerSocket,
  liveEnabled,
  quietly,
  startStub,
  waitForProbes,
  type FixtureImage,
} from './live-helpers';

const CANARY = `sk-c04-canary-${crypto.randomBytes(8).toString('hex')}`;
const TENANT_A = '33333333-3333-4333-8333-333333333333';
const TENANT_B = '44444444-4444-4444-8444-444444444444';

const suffix = crypto.randomBytes(4).toString('hex');
const instance = `c04-test-${suffix}`;
const names = {
  platformNet: `sdlc-c04-platform-${suffix}`,
  litellm: `sdlc-c04-litellm-${suffix}`,
  npm: `sdlc-c04-npm-${suffix}`,
  openbao: `sdlc-c04-openbao-${suffix}`,
};
/** Port of a second host listener (same process / host NS as rootless `--network host`). */
const HOST_NS_PORT = 40_000 + crypto.randomInt(10_000);

function hostIpv4Addresses(): string[] {
  const out = new Set<string>(['127.0.0.1']);
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) out.add(entry.address);
    }
  }
  return [...out];
}

function listen(port: number): Promise<net.Server> {
  const server = net.createServer((socket) => socket.end());
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => resolve(server));
  });
}

function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: 3_000 });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(false));
  });
}

function targets(lines: string[]): Buffer {
  return packTar([
    { type: 'dir', path: '.' },
    { type: 'file', path: 'probe-targets', content: Buffer.from(`${lines.join('\n')}\n`) },
  ]);
}

describe.skipIf(!liveEnabled)('C04 live: sandbox egress and hardening on Docker', () => {
  let client: DockerClient;
  let settings: RunnerSettings;
  let image: string;
  let fixture: FixtureImage | undefined;
  let hostServer: net.Server;
  let hostNsServer: net.Server;
  let hostPort: number;
  let hostAddresses: string[];
  const runA = crypto.randomUUID();
  const runB = crypto.randomUUID();

  beforeAll(async () => {
    docker('pull', '-q', BUSYBOX);
    fixture = await buildFixtureImage(suffix);
    image = fixture.image;

    createInternalNetwork(names.platformNet);
    startStub(names.litellm, names.platformNet, 4000, [`PROVIDER_KEY=${CANARY}`]);
    startStub(names.npm, names.platformNet, 4873, [`PROVIDER_KEY=${CANARY}`]);
    startStub(names.openbao, names.platformNet, 8200, [`PROVIDER_KEY=${CANARY}`]);

    // Host listeners in this process. AuthZ (H07) refuses `--network host` and port bindings on
    // the runner Engine; on rootless CI this process shares the same host NS as that mode.
    hostServer = await listen(0);
    hostPort = (hostServer.address() as net.AddressInfo).port;
    hostNsServer = await listen(HOST_NS_PORT);
    hostAddresses = hostIpv4Addresses();

    // The canary is in the runner's own environment: it must never reach a sandbox (AC4).
    process.env.ANTHROPIC_API_KEY = CANARY;
    settings = runnerSettingsFromEnv({
      SDLC_RUNNER_DOCKER_SOCKET: dockerSocket(),
      SDLC_RUNNER_INSTANCE: instance,
      SDLC_RUNNER_SANDBOX_MEMORY_MB: '256',
      SDLC_RUNNER_EGRESS_SERVICES: `litellm=${names.litellm}:4000,npm-proxy=${names.npm}:4873`,
      SDLC_RUNNER_NPM_REGISTRY: 'http://npm-proxy:4873/',
    });
    client = new DockerClient({ socketPath: settings.dockerSocket, timeoutMs: 120_000 });
  }, 300_000);

  afterAll(async () => {
    delete process.env.ANTHROPIC_API_KEY;
    if (client) {
      for (const run of [runA, runB]) {
        await teardownSandbox(client, run).catch(() => undefined);
      }
    }
    hostServer?.close();
    hostNsServer?.close();
    for (const name of [names.litellm, names.npm, names.openbao]) {
      quietly('rm', '-f', '-v', name);
    }
    quietly('network', 'rm', names.platformNet);
    fixture?.cleanup();
  }, 120_000);

  it('confines each sandbox to LiteLLM and the package proxy (AC1, AC4), then removes it (AC5)', async () => {
    // Positive control: the host listener is up on this process (same host NS as rootless
    // `--network host`). AuthZ forbids non-internal networks/create and host-network containers,
    // so we cannot probe it from a Docker "ordinary" network anymore; a local connect proves the
    // listener exists, and "blocked" below still means the sandbox network stops it.
    expect(hostAddresses).toContain('127.0.0.1');
    expect(await canConnect('127.0.0.1', HOST_NS_PORT)).toBe(true);
    expect(await canConnect('127.0.0.1', hostPort)).toBe(true);

    // Run B first: run A tries to reach it.
    const b = await createSandbox(client, settings, {
      runId: runB,
      tenantId: TENANT_B,
      image,
      adapter: 'openhands',
      egressAllowlist: ['litellm:4000'],
      workspaceTar: targets(['litellm_from_b litellm 4000', 'npm_from_b npm-proxy 4873']),
    });
    const probesB = await waitForProbes(client, b.containerId);
    expect(probesB.get('litellm_from_b')).toBe('open');
    expect(probesB.get('npm_from_b')).toBe('blocked'); // not in run B's allowlist
    const infoB = await client.containerInspect(b.containerId);
    const ipB = (Object.values(infoB!.NetworkSettings.Networks)[0] as { IPAddress: string })
      .IPAddress;

    const a = await createSandbox(client, settings, {
      runId: runA,
      tenantId: TENANT_A,
      image,
      adapter: 'openhands',
      egressAllowlist: ['litellm:4000', 'npm-proxy:4873'],
      workspaceTar: targets([
        'litellm litellm 4000',
        'npm_proxy npm-proxy 4873',
        `openbao_by_name ${names.openbao} 8200`,
        'openbao_alias openbao 8200',
        `litellm_by_container_name ${names.litellm} 4000`,
        'internet_ip 1.1.1.1 443',
        'github api.github.com 443',
        `host_docker_internal host.docker.internal ${String(hostPort)}`,
        `other_sandbox_by_name sdlc-sandbox-${runB} 8000`,
        `other_sandbox_by_ip ${ipB} 8000`,
        ...hostAddresses.flatMap((ip, i) => [
          `host_ns_${String(i)} ${ip} ${String(HOST_NS_PORT)}`,
          `host_process_${String(i)} ${ip} ${String(hostPort)}`,
        ]),
      ]),
    });
    const probes = await waitForProbes(client, a.containerId);
    expect(Object.fromEntries(probes)).toEqual({
      litellm: 'open',
      npm_proxy: 'open',
      openbao_by_name: 'blocked',
      openbao_alias: 'blocked',
      // Docker's DNS also knows an attached container by its own name: the same allowed service
      // and port, nothing more. Its other networks (OpenBao above) stay out of reach.
      litellm_by_container_name: 'open',
      internet_ip: 'blocked',
      github: 'blocked',
      host_docker_internal: 'blocked',
      other_sandbox_by_name: 'blocked',
      other_sandbox_by_ip: 'blocked',
      ...Object.fromEntries(
        hostAddresses.flatMap((_ip, i) => [
          [`host_ns_${String(i)}`, 'blocked'],
          [`host_process_${String(i)}`, 'blocked'],
        ]),
      ),
      default_route: 'none',
      rootfs: 'readonly',
      workspace: 'writable',
      uid: '10001',
      // O01 (ADR-M91): the limits are enforced by the kernel, also on rootless Docker (256 MiB,
      // swap = memory so no extra swap, 512 processes, 1.5 CPUs), and no capability is left.
      memory_max: String(256 * 1024 * 1024),
      memory_swap_max: '0',
      pids_max: '512',
      cpu_max: '150000/100000',
      cap_eff: '0000000000000000',
      no_new_privs: '1',
      branch: 'none', // no repository in this test (see provision.test.ts)
      git_auth: 'absent',
      readme: 'none',
      canary: 'absent',
      secret_env: 'absent',
    });

    // AC4 from the outside: no secret value in the sandbox definition, no socket or host mount.
    const info = await client.containerInspect(a.containerId);
    expect(JSON.stringify(info)).not.toContain(CANARY);
    expect(info!.Mounts.map((m) => [m.Type, m.Destination])).toEqual([['volume', '/workspace']]);
    expect(Object.keys(info!.NetworkSettings.Networks)).toEqual([`sdlc-run-${runA}`]);
    expect(info!.HostConfig).toMatchObject({
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      Privileged: false,
      NetworkMode: `sdlc-run-${runA}`,
    });
    expect((await client.networkInspect(`sdlc-run-${runA}`))?.Internal).toBe(true);

    // AC5: teardown removes the containers, networks and workspaces of both runs and detaches the
    // shared services; the services themselves keep running.
    for (const run of [runA, runB]) {
      expect(await teardownSandbox(client, run)).toMatchObject({
        container: true,
        network: true,
        volume: true,
      });
    }
    const labels = { [LABELS.instance]: instance };
    expect(await client.containerList(labels)).toEqual([]);
    expect(await client.networkList(labels)).toEqual([]);
    expect(await client.volumeList(labels)).toEqual([]);
    expect(docker('inspect', '--format', '{{.State.Running}}', names.litellm)).toBe('true');
    expect(
      Object.keys(
        JSON.parse(
          docker('inspect', '--format', '{{json .NetworkSettings.Networks}}', names.litellm),
        ) as object,
      ),
    ).toEqual([names.platformNet]);
  }, 300_000);
});
