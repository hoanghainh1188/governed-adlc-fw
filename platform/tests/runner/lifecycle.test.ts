// D-08 C04 AC1, AC5 against the in-process Docker stub (ADR-M25 §2.3, §2.5, §2.8): creation order,
// the endpoint allowlist, clean-up after success and after a failure at every step, idempotency,
// and errors that never echo Docker's text.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createSandbox,
  DockerClient,
  isAllowedEndpoint,
  ProvisioningError,
  RunnerError,
  teardownSandbox,
} from '../../apps/runner/src/index.js';
import { IMAGE, RUN_ID, settings, TENANT_ID } from './helpers';
import { StubDocker } from './stub-docker';

const s = settings();
const input = {
  runId: RUN_ID,
  tenantId: TENANT_ID,
  image: IMAGE,
  adapter: 'openhands' as const,
  egressAllowlist: ['litellm:4000', 'npm-proxy:4873'],
};

describe('sandbox lifecycle (stub Docker)', () => {
  let stub: StubDocker;
  let docker: DockerClient;

  beforeAll(async () => {
    stub = await StubDocker.start();
    docker = new DockerClient({ socketPath: stub.socketPath, timeoutMs: 5000 });
  });
  afterAll(() => stub.stop());
  beforeEach(() => {
    stub.calls.length = 0;
    stub.failures.clear();
    stub.containers.clear();
    stub.networks.clear();
    stub.volumes.clear();
    stub.images.clear();
    stub.imageLabels.clear();
  });

  const empty = () =>
    expect([stub.containers.size, stub.networks.size, stub.volumes.size]).toEqual([0, 0, 0]);

  it('pulls the pinned image, then creates volume, internal network, services, container, start', async () => {
    const tar = Buffer.from('fixture');
    const sandbox = await createSandbox(docker, s, { ...input, workspaceTar: tar });
    expect(sandbox.imageSha256).toBe('e'.repeat(64));
    expect(sandbox.sessionApiKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(stub.trace).toEqual([
      `GET /images/${IMAGE}/json`,
      'POST /images/create',
      `GET /images/${IMAGE}/json`,
      'POST /volumes/create',
      'POST /networks/create',
      `POST /networks/sdlc-run-${RUN_ID}/connect`,
      `POST /networks/sdlc-run-${RUN_ID}/connect`,
      'POST /containers/create',
      `PUT /containers/${sandbox.containerId}/archive`,
      `POST /containers/${sandbox.containerId}/start`,
    ]);
    expect(stub.calls.every((c) => isAllowedEndpoint(c.method, c.path))).toBe(true);
    expect(stub.networks.get(`sdlc-run-${RUN_ID}`)?.attached).toEqual(
      new Set(['sdlc-litellm-1', 'sdlc-npm-proxy-1', `sdlc-sandbox-${RUN_ID}`]),
    );
    const connects = stub.calls.filter((c) => c.path.endsWith('/connect')).map((c) => c.body);
    expect(connects).toEqual([
      { Container: 'sdlc-litellm-1', EndpointConfig: { Aliases: ['litellm'] } },
      { Container: 'sdlc-npm-proxy-1', EndpointConfig: { Aliases: ['npm-proxy'] } },
    ]);
    expect(stub.calls.find((c) => c.path === '/networks/create')?.body).toMatchObject({
      Internal: true,
    });
    expect(stub.containers.get(sandbox.containerId)?.archives).toEqual(['/workspace']);

    // AC5: clean-up after success removes everything and detaches the shared services.
    const result = await teardownSandbox(docker, RUN_ID);
    expect(result).toMatchObject({ container: true, network: true, volume: true });
    empty();
  });

  it('refuses an allowlist it cannot enforce before touching Docker', async () => {
    const error = await createSandbox(docker, s, {
      ...input,
      egressAllowlist: ['litellm:4000', 'github.com'],
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProvisioningError);
    expect((error as ProvisioningError).reason).toBe('egress_not_enforceable');
    expect(stub.calls).toEqual([]);
  });

  it('reports an image that cannot be pulled', async () => {
    stub.failures.set(/^POST \/images\/create$/, 500);
    const error = await createSandbox(docker, s, input).catch((e: unknown) => e);
    expect((error as ProvisioningError).reason).toBe('image_unavailable');
    empty();
  });

  it.each([
    /^POST \/volumes\/create$/,
    /^POST \/networks\/create$/,
    /^POST \/networks\/[^/]+\/connect$/,
    /^POST \/containers\/create$/,
    /^PUT \/containers\/[^/]+\/archive$/,
    /^POST \/containers\/[^/]+\/start$/,
  ])('a failure at %s removes everything created so far (AC5)', async (step) => {
    stub.images.add(IMAGE);
    stub.failures.set(step, 500);
    await expect(
      createSandbox(docker, s, { ...input, workspaceTar: Buffer.from('x') }),
    ).rejects.toBeInstanceOf(RunnerError);
    expect(stub.trace.some((call) => step.test(call))).toBe(true);
    stub.failures.clear();
    empty();
  });

  it('teardown detaches only the services attached to this run', async () => {
    stub.images.add(IMAGE);
    await createSandbox(docker, s, { ...input, egressAllowlist: ['litellm:4000'] });
    await teardownSandbox(docker, RUN_ID);
    expect(stub.trace.filter((call) => call.endsWith('/disconnect'))).toHaveLength(1);
    empty();
  });

  it('teardown is idempotent: nothing left, nothing to remove', async () => {
    expect(await teardownSandbox(docker, RUN_ID)).toMatchObject({
      container: false,
      network: false,
      volume: false,
    });
  });

  it('teardown runs every step even when one fails, then reports the first error', async () => {
    stub.images.add(IMAGE);
    await createSandbox(docker, s, input);
    stub.failures.set(/^DELETE \/containers\//, 500);
    await expect(teardownSandbox(docker, RUN_ID)).rejects.toThrow(/HTTP 500/);
    expect(stub.volumes.size).toBe(0);
    stub.failures.clear();
    await teardownSandbox(docker, RUN_ID);
    empty();
  });

  // X03 (ADR-M68 §7): the image's `sdlc.agent.adapter` label must name the run's adapter.
  it('refuses an image of another adapter before it creates anything (adapter_mismatch)', async () => {
    stub.imageLabels.set(IMAGE, { 'sdlc.agent.adapter': 'opencode' });
    const error = await createSandbox(docker, s, input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProvisioningError);
    expect((error as ProvisioningError).reason).toBe('adapter_mismatch');
    empty();
    stub.imageLabels.clear();
    const unlabelled = await createSandbox(docker, s, { ...input, adapter: 'opencode' }).catch(
      (e: unknown) => e,
    );
    expect((unlabelled as ProvisioningError).reason).toBe('adapter_mismatch');
    empty();
  });

  it('starts an image whose label names the adapter of the run, and an unlabelled one for OpenHands', async () => {
    stub.imageLabels.set(IMAGE, {
      'sdlc.agent.adapter': 'opencode',
      'sdlc.agent.version': '1.18.35',
    });
    await createSandbox(docker, s, { ...input, adapter: 'opencode' });
    await teardownSandbox(docker, RUN_ID);
    stub.imageLabels.clear();
    await createSandbox(docker, s, input);
    await teardownSandbox(docker, RUN_ID);
    empty();
  });

  it('never calls endpoints outside the allowlist (exec, build, commit, system)', async () => {
    for (const [method, path] of [
      ['POST', `/containers/sdlc-sandbox-${RUN_ID}/exec`],
      ['POST', '/exec/abc/start'],
      ['POST', '/build'],
      ['POST', '/commit'],
      ['GET', '/info/x'],
      ['POST', '/swarm/init'],
      ['POST', '/plugins/pull'],
      ['GET', '/containers/../info/json'],
    ] as const) {
      await expect(docker.request(method as 'POST', path)).rejects.toThrow(/allowlist/);
    }
    expect(stub.calls).toEqual([]);
  });

  it('errors never contain Docker’s own text', async () => {
    stub.failures.set(/^POST \/volumes\/create$/, 500);
    const error = await docker.volumeCreate('sdlc-ws-x', {}).catch((e: unknown) => e);
    expect(String(error)).toMatch(/HTTP 500/);
    expect(String(error)).not.toMatch(/secret-value/);
  });

  it('reports an unreachable socket with its error code only', async () => {
    const missing = new DockerClient({ socketPath: '/nonexistent/docker.sock' });
    await expect(missing.ping()).rejects.toThrow(/cannot reach the Docker socket \(ENOENT\)/);
  });
});
