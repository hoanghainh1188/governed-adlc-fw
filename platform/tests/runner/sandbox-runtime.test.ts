// Task H06 AC1 (ADR-M25 §2.12, QUESTIONS #701–#704): a stronger sandbox runtime (gVisor `runsc` or
// Kata `kata`). The setting is a closed list; the sandbox and scoring containers name it, tool and
// gateway containers never do; the guard refuses any other value; the runner refuses to start when
// the Engine does not list the runtime or is rootless; the AuthZ plugin can require it.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { startAuthzPlugin } from '../../deploy/docker-authz/src/server.js';
import {
  assertEngineRuntime,
  assertSafeContainerSpec,
  assertSafeScoringSpec,
  assertSafeToolSpec,
  buildSandboxSpec,
  buildScoringSpec,
  buildToolSpec,
  evaluateAuthz,
  isAllowedEndpoint,
  parseEngineInfo,
  RunnerError,
  runLabels,
  runNames,
  SANDBOX_RUNTIMES,
  toolObjectNames,
  type ContainerSpec,
  type EngineInfo,
  type SandboxRuntime,
  type ToolContainerSpec,
} from '../../apps/runner/src/index.js';
import { IMAGE, RUN_ID, settings, TENANT_ID } from './helpers.js';

const names = runNames(RUN_ID);
const labels = runLabels('sdlc', RUN_ID, TENANT_ID);
const KEY = 'k'.repeat(43);
const withRuntime = (runtime: string) => settings({ SDLC_RUNNER_SANDBOX_RUNTIME: runtime });

const sandbox = (runtime?: SandboxRuntime): ContainerSpec =>
  buildSandboxSpec(
    { names, labels, image: IMAGE, sessionApiKey: KEY, agentSecretKey: KEY },
    runtime ? withRuntime(runtime) : settings(),
  );

const refusedWith = (check: string) => (fn: () => void) => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(RunnerError);
    expect((error as RunnerError).key).toBe('runner.docker.spec_refused');
    expect((error as RunnerError).params).toEqual({ check });
    return;
  }
  throw new Error('expected a refusal');
};

describe('the sandbox runtime setting (H06 AC1)', () => {
  it('is empty by default: the Engine default runtime, no Runtime in the spec', () => {
    expect(settings().sandboxRuntime).toBeUndefined();
    expect('Runtime' in sandbox().HostConfig).toBe(false);
    expect(settings({ SDLC_RUNNER_SANDBOX_RUNTIME: '' }).sandboxRuntime).toBeUndefined();
  });

  it.each(SANDBOX_RUNTIMES)('accepts %s', (runtime) => {
    expect(withRuntime(runtime).sandboxRuntime).toBe(runtime);
  });

  it.each(['runc', 'RUNSC', 'nvidia', 'runsc ', '/usr/bin/runsc', 'io.containerd.runsc.v1'])(
    'refuses %j',
    (runtime) => {
      expect(() => withRuntime(runtime)).toThrow(RunnerError);
    },
  );
});

describe('the guard and the runtime (H06 AC1)', () => {
  it.each(SANDBOX_RUNTIMES)('the sandbox names %s, and the guard accepts it', (runtime) => {
    const spec = sandbox(runtime);
    expect(spec.HostConfig.Runtime).toBe(runtime);
    expect(() => assertSafeContainerSpec(names.container, spec, runtime)).not.toThrow();
  });

  it.each(['install', 'score'] as const)(
    'the %s scoring container names the runtime too',
    (phase) => {
      const spec = buildScoringSpec({ names, labels, image: IMAGE, phase }, withRuntime('runsc'));
      expect(spec.HostConfig.Runtime).toBe('runsc');
      expect(() => assertSafeScoringSpec(names.container, spec, phase, 'runsc')).not.toThrow();
      refusedWith('runtime')(() => assertSafeScoringSpec(names.container, spec, phase));
    },
  );

  it('refuses a configured runtime the spec does not name', () => {
    refusedWith('runtime')(() => assertSafeContainerSpec(names.container, sandbox(), 'runsc'));
  });

  it('refuses a runtime when none is configured', () => {
    refusedWith('runtime')(() => assertSafeContainerSpec(names.container, sandbox('runsc')));
  });

  it('refuses another runtime than the configured one', () => {
    refusedWith('runtime')(() =>
      assertSafeContainerSpec(names.container, sandbox('kata'), 'runsc'),
    );
  });

  it.each(['runc', 'nvidia', '', 'runsc-debug'])('refuses the runtime %j', (value) => {
    const spec = structuredClone(sandbox('runsc')) as unknown as {
      HostConfig: Record<string, unknown>;
    };
    spec.HostConfig.Runtime = value;
    refusedWith('runtime')(() =>
      assertSafeContainerSpec(names.container, spec as unknown as ContainerSpec, 'runsc'),
    );
  });

  it('refuses a configured runtime outside the closed list', () => {
    refusedWith('runtime')(() =>
      assertSafeContainerSpec(names.container, sandbox(), 'runc' as SandboxRuntime),
    );
  });

  it('never lets a tool container name a runtime (QUESTIONS #704)', () => {
    const toolNames = toolObjectNames(RUN_ID);
    const tool = buildToolSpec({
      names: toolNames,
      labels,
      toolKey: 'project-docs',
      image: IMAGE,
      limits: settings().limits,
      runtime: true,
    });
    const name = toolNames.tool('project-docs');
    expect('Runtime' in tool.HostConfig).toBe(false);
    const spec = structuredClone(tool) as unknown as { HostConfig: Record<string, unknown> };
    spec.HostConfig.Runtime = 'runsc';
    refusedWith('unknown_host_option')(() =>
      assertSafeToolSpec(name, spec as unknown as ToolContainerSpec),
    );
  });
});

describe('the Engine check at start (H06 AC1, QUESTIONS #701)', () => {
  const engine = (info: EngineInfo) => ({ engineInfo: () => Promise.resolve(info) });
  const never = {
    engineInfo: () => Promise.reject(new Error('the runner must not ask the Engine')),
  };

  it('reads the runtimes and the rootless flag only', () => {
    expect(
      parseEngineInfo({
        Runtimes: { runc: { path: 'runc' }, runsc: { path: '/usr/local/bin/runsc' } },
        SecurityOptions: ['name=seccomp,profile=builtin', 'name=cgroupns'],
        Name: 'host-name',
      }),
    ).toEqual({ runtimes: ['runc', 'runsc'], rootless: false });
    expect(parseEngineInfo({ Runtimes: { runc: {} }, SecurityOptions: ['name=rootless'] })).toEqual(
      { runtimes: ['runc'], rootless: true },
    );
    expect(parseEngineInfo(null)).toEqual({ runtimes: [], rootless: false });
    expect(parseEngineInfo({ Runtimes: ['runsc'], SecurityOptions: 'name=rootless' })).toEqual({
      runtimes: [],
      rootless: false,
    });
  });

  it('asks nothing without a configured runtime', async () => {
    await expect(assertEngineRuntime(never, undefined)).resolves.toBeUndefined();
  });

  it('passes when a rootful Engine lists the runtime', async () => {
    await expect(
      assertEngineRuntime(engine({ runtimes: ['runc', 'runsc'], rootless: false }), 'runsc'),
    ).resolves.toBeUndefined();
  });

  it('refuses to start when the Engine does not list the runtime', async () => {
    await expect(
      assertEngineRuntime(engine({ runtimes: ['runc'], rootless: false }), 'kata'),
    ).rejects.toMatchObject({ key: 'runner.docker.runtime_missing', params: { runtime: 'kata' } });
  });

  it('refuses to start on a rootless Engine', async () => {
    await expect(
      assertEngineRuntime(engine({ runtimes: ['runc', 'runsc'], rootless: true }), 'runsc'),
    ).rejects.toMatchObject({ key: 'runner.docker.runtime_rootless' });
  });

  it('reaches GET /info through the endpoint allowlist, and nothing below it', () => {
    expect(isAllowedEndpoint('GET', '/info')).toBe(true);
    expect(isAllowedEndpoint('GET', '/info/x')).toBe(false);
    expect(isAllowedEndpoint('POST', '/info')).toBe(false);
  });
});

describe('the AuthZ plugin can require the runtime (H06, QUESTIONS #703)', () => {
  const create = '/v1.44/containers/create?name=x';
  const required = { requireRuntime: 'runsc' };

  it('changes nothing without the option', () => {
    expect(evaluateAuthz('POST', create, sandbox()).allow).toBe(true);
  });

  it('allows a sandbox that names the runtime', () => {
    expect(evaluateAuthz('POST', create, sandbox('runsc'), required).allow).toBe(true);
  });

  it('refuses a sandbox without the runtime or with another one', () => {
    expect(evaluateAuthz('POST', create, sandbox(), required)).toEqual({
      allow: false,
      reason: 'runtime_required',
    });
    expect(evaluateAuthz('POST', create, sandbox('kata'), required).reason).toBe(
      'runtime_required',
    );
  });

  it.each<[string, Record<string, unknown>]>([
    ['a workspace volume in Binds', { Binds: [`sdlc-ws-${RUN_ID}:/workspace`] }],
    ['a workspace volume in Mounts', { Mounts: [{ Type: 'volume', Source: `sdlc-ws-${RUN_ID}` }] }],
    ['VolumesFrom', { VolumesFrom: [`sdlc-sandbox-${RUN_ID}`] }],
  ])('refuses %s without the runtime', (_label, host) => {
    expect(evaluateAuthz('POST', create, { Image: IMAGE, HostConfig: host }, required).reason).toBe(
      'runtime_required',
    );
  });

  it('allows a container without the workspace (tools, the gateway) on the default runtime', () => {
    const body = {
      Image: IMAGE,
      HostConfig: {
        Mounts: [{ Type: 'volume', Source: `sdlc-gwcfg-${RUN_ID}`, Target: '/config' }],
      },
    };
    expect(evaluateAuthz('POST', create, body, required).allow).toBe(true);
  });

  describe('the plugin process', () => {
    const dirs: string[] = [];
    afterEach(() => {
      for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    });

    it('refuses to start with a runtime outside the closed list', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'sdlc-authz-'));
      dirs.push(dir);
      await expect(
        startAuthzPlugin({ socketPath: join(dir, 'a.sock'), requireRuntime: 'runc' }),
      ).rejects.toThrow('authz.invalid_runtime');
    });

    it('starts with runsc', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'sdlc-authz-'));
      dirs.push(dir);
      const plugin = await startAuthzPlugin({
        socketPath: join(dir, 'a.sock'),
        requireRuntime: 'runsc',
      });
      await plugin.close();
    });
  });
});
