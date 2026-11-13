// D-08 X04 PR 3b (design/ADR-M69 §2.4, §2.8, ADR-M89 §2.5; QUESTIONS #531, #533, #536): a tool
// with backing services. Its service network holds the tool and its services only; its settings and
// credential are files in its own volume, never environment values; the runner enforces only the
// services it was given; what the tool returned becomes `knowledge_read` from its own log lines.
import { KNOWLEDGE_READ_LOG_EVENT, type ToolGrant } from '@sdlc/contracts';
import { describe, expect, it } from 'vitest';

import {
  assertSafeNetworkSpec,
  assertSafeServiceConnect,
  assertSafeToolSpec,
  buildToolSpec,
  GATEWAY_READY_MESSAGE,
  knowledgeReadOf,
  parseEgressServices,
  runLabels,
  runnerSettingsFromEnv,
  startTools,
  teardownTools,
  toolGrantsEnforceable,
  toolObjectNames,
  type ToolContainerSpec,
  type ToolRuntime,
} from '../../apps/runner/src/index.js';
import type { DockerClient } from '../../apps/runner/src/docker/client.js';
import { INHIBIT_IPV4 } from '../../apps/runner/src/sandbox/network.js';
import { callRulesSha256 } from '../../packages/core/src/tools/check.js';
import { RUN_ID, TENANT_ID } from './helpers';

const IMAGE = `ghcr.io/example/project-docs@sha256:${'d'.repeat(64)}`;
const GATEWAY = `cr.agentgateway.dev/agentgateway:v1.7.0@sha256:${'e'.repeat(64)}`;
const names = toolObjectNames(RUN_ID);
const labels = runLabels('sdlc', RUN_ID, TENANT_ID);
const limits = { memoryBytes: 256 * 1024 * 1024, nanoCpus: 1_000_000_000, pids: 128 };
const SERVICES = parseEgressServices(
  'knowledge-db=sdlc-knowledge-db-1:5432,litellm=sdlc-litellm-1:4000',
  'SDLC_RUNNER_TOOL_SERVICES',
);
const DOC = '44444444-4444-4444-8444-444444444444';
const DOC2 = '55555555-5555-4555-8555-555555555555';
const SHA = 'a'.repeat(64);

const grant = (extra: Partial<ToolGrant> = {}): ToolGrant => ({
  tool_key: 'project-docs',
  tool_version: '1.0.0',
  transport: 'http',
  image_digest: `sha256:${'d'.repeat(64)}`,
  permissions: ['read_documents'],
  call_rules_sha256: callRulesSha256(['read_documents']),
  backing_services: ['knowledge-db:5432', 'litellm:4000'],
  max_calls: 100,
  ...extra,
});

describe('the backing services a runner enforces (ADR-M69 §2.6)', () => {
  it('reads SDLC_RUNNER_TOOL_SERVICES like the egress services', () => {
    const settings = runnerSettingsFromEnv({
      SDLC_RUNNER_TOOL_SERVICES: 'knowledge-db=sdlc-knowledge-db-1:5432',
    });
    expect(settings.toolServices).toEqual([
      { alias: 'knowledge-db', container: 'sdlc-knowledge-db-1', port: 5432 },
    ]);
    expect(runnerSettingsFromEnv({}).toolServices).toEqual([]);
    expect(() => runnerSettingsFromEnv({ SDLC_RUNNER_TOOL_SERVICES: 'x=bad name:1' })).toThrow();
  });

  it('accepts a grant whose services this runner was given, by alias and port', () => {
    expect(toolGrantsEnforceable([grant()], SERVICES)).toBe(true);
  });

  it.each<[string, readonly string[]]>([
    ['an unknown alias', ['postgres:5432']],
    ['a wrong port', ['knowledge-db:5433']],
    ['an internet host', ['example-com:443']],
  ])('refuses %s (`tool_not_enforceable`)', (_name, backing) => {
    expect(toolGrantsEnforceable([grant({ backing_services: backing })], SERVICES)).toBe(false);
  });
});

describe("a tool's service network and runtime volume (QUESTIONS #531)", () => {
  const tool = (): ToolContainerSpec =>
    buildToolSpec({
      names,
      labels,
      toolKey: 'project-docs',
      image: IMAGE,
      limits,
      runtime: true,
    });
  const name = names.tool('project-docs');

  it('mounts its own runtime volume only, at /run/sdlc-tool; no environment value', () => {
    const spec = tool();
    expect(spec.Env).toEqual([]);
    expect(spec.HostConfig.Mounts).toEqual([
      {
        Type: 'volume',
        Source: `sdlc-toolrt-${RUN_ID}-project-docs`,
        Target: '/run/sdlc-tool',
        ReadOnly: false,
      },
    ]);
    expect(() => assertSafeToolSpec(name, spec)).not.toThrow();
  });

  it.each<[string, Record<string, unknown>]>([
    ['another volume', { Source: `sdlc-toolrt-${RUN_ID}-other-tool` }],
    ['the workspace', { Source: `sdlc-ws-${RUN_ID}` }],
    ['another path', { Target: '/app' }],
    ['a bind mount', { Type: 'bind', Source: '/var/run' }],
  ])('the guard refuses %s', (_label, change) => {
    const spec = structuredClone(tool()) as unknown as {
      HostConfig: { Mounts: Record<string, unknown>[] };
    };
    spec.HostConfig.Mounts[0] = { ...spec.HostConfig.Mounts[0], ...change };
    expect(() => assertSafeToolSpec(name, spec as unknown as ToolContainerSpec)).toThrow();
  });

  it('creates a service network as an internal bridge of the run', () => {
    const spec = {
      Name: names.serviceNetwork('project-docs'),
      Driver: 'bridge',
      Internal: true,
      Attachable: false,
      EnableIPv6: false,
      Labels: labels,
      Options: { [INHIBIT_IPV4]: 'true' },
    };
    expect(() => assertSafeNetworkSpec(spec)).not.toThrow();
    expect(() =>
      assertSafeNetworkSpec({ ...spec, Name: `sdlc-toolsvc-${TENANT_ID}-project-docs` }),
    ).toThrow();
    expect(() => assertSafeNetworkSpec({ ...spec, Internal: false })).toThrow();
  });

  it('only the tool and its configured services join; never the gateway, the sandbox or another tool', () => {
    const net = names.serviceNetwork('project-docs');
    const allowed = SERVICES.map((s) => s.container);
    expect(() => assertSafeServiceConnect(net, name, name, allowed)).not.toThrow();
    expect(() => assertSafeServiceConnect(net, 'sdlc-knowledge-db-1', name, allowed)).not.toThrow();
    for (const other of [
      names.gateway,
      `sdlc-sandbox-${RUN_ID}`,
      names.tool('other-tool'),
      'sdlc-postgres-1',
      'sdlc-openbao-1',
    ]) {
      expect(() => assertSafeServiceConnect(net, other, name, allowed), other).toThrow();
    }
    // Another tool's service network, or the run network.
    expect(() =>
      assertSafeServiceConnect(names.serviceNetwork('other-tool'), name, name, allowed),
    ).toThrow();
    expect(() => assertSafeServiceConnect(`sdlc-run-${RUN_ID}`, name, name, allowed)).toThrow();
  });
});

/** A Docker stand-in that records the calls of `startTools` and `teardownTools`. */
function fakeDocker(options: { failConnect?: string } = {}) {
  const calls: string[] = [];
  const archives: { path: string; tar: Buffer }[] = [];
  const networks = new Map<string, Set<string>>();
  const docker = {
    networkCreate: (spec: { Name: string }) => {
      calls.push(`network ${spec.Name}`);
      networks.set(spec.Name, new Set());
      return Promise.resolve(spec.Name);
    },
    volumeCreate: (name: string) => {
      calls.push(`volume ${name}`);
      return Promise.resolve();
    },
    imageInspect: () => Promise.resolve({ Id: 'x' }),
    toolContainerCreate: (name: string, spec: ToolContainerSpec) => {
      calls.push(`create ${name} env=${String(spec.Env.length)}`);
      return Promise.resolve(name);
    },
    putArchive: (_id: string, path: string, tar: Buffer) => {
      calls.push(`archive ${path}`);
      archives.push({ path, tar });
      return Promise.resolve();
    },
    networkConnect: (network: string, container: string, aliases: string[]) => {
      if (container === options.failConnect) return Promise.reject(new Error('no such container'));
      calls.push(`connect ${network} ${container} [${aliases.join(',')}]`);
      networks.get(network)?.add(container);
      return Promise.resolve();
    },
    containerStart: (id: string) => {
      calls.push(`start ${id}`);
      return Promise.resolve();
    },
    containerInspect: () =>
      Promise.resolve({ State: { Running: true, Health: { Status: 'healthy' } } }),
    containerLogs: () => Promise.resolve(`{"message":"${GATEWAY_READY_MESSAGE}"}`),
    containerRemove: (name: string) => {
      calls.push(`remove ${name}`);
      return Promise.resolve(true);
    },
    containerList: () => Promise.resolve([{ Names: [`/${names.tool('project-docs')}`] }]),
    networkList: () =>
      Promise.resolve([...networks.keys()].map((Name) => ({ Name, Labels: labels }))),
    networkInspect: (name: string) =>
      Promise.resolve({
        Name: name,
        Containers: Object.fromEntries(
          [...(networks.get(name) ?? [])].map((c, i) => [String(i), { Name: c }]),
        ),
      }),
    networkDisconnect: (network: string, container: string) => {
      calls.push(`disconnect ${network} ${container}`);
      return Promise.resolve(true);
    },
    networkRemove: (name: string) => {
      calls.push(`remove network ${name}`);
      return Promise.resolve(true);
    },
    volumeList: () =>
      Promise.resolve([
        { Name: `sdlc-toolrt-${RUN_ID}-project-docs`, Labels: labels },
        { Name: `sdlc-ws-${RUN_ID}`, Labels: labels },
      ]),
    volumeRemove: (name: string) => {
      calls.push(`remove volume ${name}`);
      return Promise.resolve(true);
    },
  };
  return { docker: docker as unknown as DockerClient, calls, archives };
}

const runtime: ToolRuntime = {
  config: {
    schema_version: 1,
    index_id: DOC,
    schema: `kdocs_p${'1'.repeat(32)}`,
    model: 'bge-m3',
    database: { host: 'knowledge-db', port: 5432, name: 'knowledge' },
    model_gateway_url: 'http://litellm:4000',
  },
  credentials: {
    db_username: { reveal: () => 'v-run-login' },
    db_password: { reveal: () => 'DB-PASSWORD-CANARY' },
    llm_key: { reveal: () => 'sk-TOOL-KEY-CANARY' },
  },
};

function startInput(extra: Partial<Parameters<typeof startTools>[1]> = {}) {
  return {
    run: { runId: RUN_ID, container: '', network: `sdlc-run-${RUN_ID}`, volume: '' },
    labels,
    grants: [grant()],
    images: new Map([['project-docs', IMAGE]]),
    gatewayImage: GATEWAY,
    limits,
    readyTimeoutMs: 1000,
    services: SERVICES,
    runtime: new Map([['project-docs', runtime]]),
    ...extra,
  };
}

describe('starting a tool with backing services (ADR-M69 §2.4 order)', () => {
  it('service network, runtime volume, files, then the tool and its services join, then start', async () => {
    const { docker, calls, archives } = fakeDocker();
    await startTools(docker, startInput());
    const net = names.serviceNetwork('project-docs');
    const tool = names.tool('project-docs');
    const order = calls.filter((c) => !c.startsWith('remove'));
    expect(order.slice(0, 8)).toEqual([
      `network sdlc-tool-${RUN_ID}`,
      `network ${net}`,
      `volume sdlc-toolrt-${RUN_ID}-project-docs`,
      `create ${tool} env=0`,
      'archive /run/sdlc-tool',
      `connect ${net} ${tool} []`,
      `connect ${net} sdlc-knowledge-db-1 [knowledge-db]`,
      `connect ${net} sdlc-litellm-1 [litellm]`,
    ]);
    expect(order[8]).toBe(`start ${tool}`);
    // The gateway never joins the service network.
    expect(calls.filter((c) => c.startsWith(`connect ${net} ${names.gateway}`))).toEqual([]);
    // The files hold the settings and the credential; nothing else got them.
    const tar = archives[0]!.tar.toString('utf8');
    expect(tar).toContain('config.json');
    expect(tar).toContain('credentials.json');
    expect(tar).toContain('DB-PASSWORD-CANARY');
    expect(tar).toContain(`"index_id":"${DOC}"`);
    const gatewayFile = archives.find((a) => a.path === '/config')!.tar.toString('utf8');
    expect(gatewayFile).not.toContain('DB-PASSWORD-CANARY');
    expect(gatewayFile).not.toContain('sk-TOOL-KEY-CANARY');
  });

  it('X06: a read_code tool gets its code settings and only a login: no model key in the files', async () => {
    const { docker, calls, archives } = fakeDocker();
    const codeRuntime: ToolRuntime = {
      config: {
        schema_version: 1,
        index_id: DOC,
        schema: `kcode_p${'1'.repeat(32)}`,
        database: { host: 'knowledge-db', port: 5432, name: 'knowledge' },
      },
      credentials: {
        db_username: { reveal: () => 'v-run-login' },
        db_password: { reveal: () => 'DB-PASSWORD-CANARY' },
      },
    };
    await startTools(
      docker,
      startInput({
        grants: [
          grant({
            permissions: ['read_code'],
            call_rules_sha256: callRulesSha256(['read_code']),
            backing_services: ['knowledge-db:5432'],
          }),
        ],
        runtime: new Map([['project-docs', codeRuntime]]),
      }),
    );
    const net = names.serviceNetwork('project-docs');
    // Only the database joins: the code tool calls no model.
    expect(calls.filter((c) => c.startsWith(`connect ${net} sdlc-`) && !c.endsWith(' []'))).toEqual(
      [`connect ${net} sdlc-knowledge-db-1 [knowledge-db]`],
    );
    const tar = archives[0]!.tar.toString('utf8');
    expect(tar).toContain('"schema":"kcode_p');
    expect(tar).toContain('DB-PASSWORD-CANARY');
    expect(tar).not.toContain('llm_key');
    expect(tar).not.toContain('model_gateway_url');
  });

  it('a service that is not running, or no runtime files: `tool_unavailable`', async () => {
    await expect(
      startTools(fakeDocker({ failConnect: 'sdlc-knowledge-db-1' }).docker, startInput()),
    ).rejects.toMatchObject({ reason: 'tool_unavailable' });
    await expect(
      startTools(fakeDocker().docker, startInput({ runtime: new Map() })),
    ).rejects.toMatchObject({ reason: 'tool_unavailable' });
  });

  it('the teardown detaches the services, removes the service network and the runtime volume', async () => {
    const { docker, calls } = fakeDocker();
    await startTools(docker, startInput());
    await teardownTools(docker, RUN_ID, { 'sdlc.run-id': RUN_ID });
    const net = names.serviceNetwork('project-docs');
    expect(calls).toContain(`disconnect ${net} sdlc-knowledge-db-1`);
    expect(calls).toContain(`disconnect ${net} sdlc-litellm-1`);
    expect(calls).toContain(`remove network ${net}`);
    expect(calls).toContain(`remove volume sdlc-toolrt-${RUN_ID}-project-docs`);
    // The gateway goes first (ADR-M69 §2.8); the workspace is the sandbox teardown's.
    expect(calls.find((c) => c.startsWith('remove '))).toBe(`remove ${names.gateway}`);
    expect(calls).not.toContain(`remove volume sdlc-ws-${RUN_ID}`);
  });
});

describe('knowledge_read from the tool log lines (ADR-M89 §2.5, QUESTIONS #536)', () => {
  const line = (documents: unknown, chunks: unknown = 1) =>
    JSON.stringify({ event: KNOWLEDGE_READ_LOG_EVENT, documents, chunks });

  it('the distinct documents of every answer, sorted, and the chunks in all', () => {
    const logs = [
      line([[DOC2, SHA]], 3),
      'some other line',
      line(
        [
          [DOC, SHA],
          [DOC2, SHA],
        ],
        2,
      ),
    ].join('\n');
    expect(knowledgeReadOf(logs)).toEqual({
      documents: [
        [DOC, SHA],
        [DOC2, SHA],
      ],
      chunks: 5,
    });
  });

  it.each<[string, string]>([
    ['a path instead of an ID', line([['docs/a.md', SHA]])],
    ['a text instead of a hash', line([[DOC, 'secret text']])],
    ['another event', JSON.stringify({ event: 'other', documents: [[DOC, SHA]], chunks: 1 })],
    ['a negative count', line([[DOC, SHA]], -1)],
    ['a huge count', line([[DOC, SHA]], 1_000_000)],
    ['not JSON', `{"event":"${KNOWLEDGE_READ_LOG_EVENT}"`],
  ])('ignores a line with %s', (_name, bad) => {
    expect(knowledgeReadOf(bad)).toEqual({ documents: [], chunks: 0 });
  });

  it('an empty log is an empty list (its hash is still recorded)', () => {
    expect(knowledgeReadOf('')).toEqual({ documents: [], chunks: 0 });
  });
});
