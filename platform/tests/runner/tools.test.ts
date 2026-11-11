// D-08 X04 PR 2 (design/ADR-M69 §2.4, §2.6, §2.7, ADR-M87 §5), the pure parts: the gateway's
// configuration generated from the contract, the guard of tool and gateway containers, the
// contract check of the runner, and the counts read from the gateway's log lines.
import crypto from 'node:crypto';

import type { ToolGrant } from '@sdlc/contracts';
import { describe, expect, it } from 'vitest';

import {
  assertSafeGatewaySpec,
  assertSafeNetworkSpec,
  assertSafeToolSpec,
  buildGatewayConfig,
  buildGatewaySpec,
  buildToolSpec,
  exposedToolName,
  runLabels,
  toolGrantsEnforceable,
  toolHost,
  toolObjectNames,
  toolUsage,
  type ToolContainerSpec,
} from '../../apps/runner/src/index.js';
import { callRulesSha256 } from '../../packages/core/src/tools/check.js';
import { RUN_ID, TENANT_ID } from './helpers';

const IMAGE = `ghcr.io/example/project-docs@sha256:${'d'.repeat(64)}`;
const GATEWAY = `cr.agentgateway.dev/agentgateway:v1.7.0@sha256:${'e'.repeat(64)}`;
const KEY = 'per-run-key-value';
const KEY_SHA = crypto.createHash('sha256').update(KEY).digest('hex');
const names = toolObjectNames(RUN_ID);
const labels = runLabels('sdlc', RUN_ID, TENANT_ID);

const grant = (key: string, extra: Partial<ToolGrant> = {}): ToolGrant => ({
  tool_key: key,
  tool_version: '1.0.0',
  transport: 'http',
  image_digest: `sha256:${'d'.repeat(64)}`,
  permissions: ['read_documents'],
  call_rules_sha256: callRulesSha256(['read_documents']),
  backing_services: [],
  max_calls: 100,
  ...extra,
});

interface Config {
  config: Record<string, unknown>;
  binds: {
    port: number;
    listeners: {
      routes: {
        policies: {
          apiKey: { mode: string; keys: { keyHash: string }[] };
          authorization: { rules: { require: string }[] };
          mcpAuthorization: { rules: { allow: string }[] };
          localRateLimit: { conditional: { condition: string; maxTokens: number }[] };
        };
        backends: { mcp: { targets: { name: string; mcp: { host: string } }[] } }[];
      }[];
    }[];
  }[];
}

function config(grants: readonly ToolGrant[]): { text: string; parsed: Config } {
  const text = buildGatewayConfig({
    grants,
    keySha256: KEY_SHA,
    toolHost: (key) => names.tool(key),
  });
  return { text, parsed: JSON.parse(text) as Config };
}

describe('the gateway configuration, generated from the contract (ADR-M87 §5)', () => {
  const { text, parsed } = config([grant('project-docs')]);
  const route = parsed.binds[0]!.listeners[0]!.routes[0]!;

  it('holds the key hash only, never the key; admin and stats off', () => {
    expect(text).not.toContain(KEY);
    expect(route.policies.apiKey).toEqual({
      mode: 'strict',
      keys: [{ keyHash: `sha256:${KEY_SHA}` }],
    });
    expect(parsed.config).toMatchObject({ adminAddr: 'off', statsAddr: 'off' });
    // agentgateway 1.7 writes a session key it makes into the config file unless this is set.
    expect(parsed.config.session).toEqual({ key: 'disabled' });
    expect(parsed.binds[0]!.port).toBe(3000);
  });

  it('one target per grant, on the tool network by container name; the cap per tool', () => {
    expect(route.backends[0]!.mcp.targets).toEqual([
      {
        name: 'project-docs',
        mcp: { host: `http://${names.tool('project-docs')}:8080/mcp` },
      },
    ]);
    expect(route.policies.localRateLimit.conditional).toEqual([
      expect.objectContaining({
        condition: 'mcp.methodName == "tools/call" && mcp.tool.target == "project-docs"',
        maxTokens: 100,
      }),
    ]);
  });

  it('allows the tools of the permission only, with their argument rules', () => {
    expect(route.policies.mcpAuthorization.rules).toEqual([
      { allow: 'mcp.tool.target == "project-docs" && mcp.tool.name == "search_project_docs"' },
    ]);
    const cel = route.policies.authorization.rules[0]!.require;
    expect(cel).toContain('b.params.name == "search_project_docs"');
    expect(cel).toContain('a.all(k, k in ["limit", "query"])');
    expect(cel).toContain('has(a.query)');
    expect(cel).toContain('double(a["limit"]) >= 1.0 && double(a["limit"]) <= 20.0');
    expect(cel).toContain('size(a["query"]) <= 1000');
  });

  it('names tools by key with more than one target; the same contract gives the same file', () => {
    expect(exposedToolName('a', 'search_project_docs', 1)).toBe('search_project_docs');
    expect(exposedToolName('a', 'search_project_docs', 2)).toBe('a_search_project_docs');
    const two = config([grant('zz-docs'), grant('aa-docs')]);
    const cel = two.parsed.binds[0]!.listeners[0]!.routes[0]!.policies.authorization.rules[0]!;
    expect(cel.require).toContain('"aa-docs_search_project_docs"');
    expect(two.text).toBe(config([grant('aa-docs'), grant('zz-docs')]).text);
  });

  it('refuses a key hash that is not one', () => {
    expect(() =>
      buildGatewayConfig({ grants: [], keySha256: 'nope', toolHost: (key) => names.tool(key) }),
    ).toThrow();
  });
});

describe('the runner enforces only what it can (ADR-M69 §2.6)', () => {
  it('accepts an http grant with its own call rules and no backing service', () => {
    expect(toolGrantsEnforceable([grant('project-docs')])).toBe(true);
  });

  it.each<[string, Partial<ToolGrant>]>([
    ['other call rules', { call_rules_sha256: 'a'.repeat(64) }],
    ['a backing service this runner was not given', { backing_services: ['knowledge-db:5432'] }],
  ])('refuses %s', (_name, extra) => {
    expect(toolGrantsEnforceable([grant('project-docs', extra)])).toBe(false);
  });
});

describe('the guard of tool and gateway containers (ADR-M69 §2.4)', () => {
  const limits = { memoryBytes: 256 * 1024 * 1024, nanoCpus: 1_000_000_000, pids: 128 };
  const tool = (): ToolContainerSpec =>
    buildToolSpec({ names, labels, toolKey: 'project-docs', image: IMAGE, limits });
  const gateway = (): ToolContainerSpec => buildGatewaySpec({ names, labels, image: GATEWAY });
  const name = names.tool('project-docs');

  it('accepts the specs the runner builds', () => {
    expect(() => assertSafeToolSpec(name, tool())).not.toThrow();
    expect(() => assertSafeGatewaySpec(names.gateway, gateway())).not.toThrow();
  });

  type Raw = Record<string, unknown> & { HostConfig: Record<string, unknown> };
  const broken = (spec: ToolContainerSpec, change: (raw: Raw) => void): ToolContainerSpec => {
    const raw = structuredClone(spec) as unknown as Raw;
    change(raw);
    return raw as unknown as ToolContainerSpec;
  };

  it.each<[string, (raw: Raw) => void]>([
    ['a tag, not a digest', (r) => (r.Image = 'ghcr.io/example/project-docs:latest')],
    ['root', (r) => (r.User = '0:0')],
    ['an environment value', (r) => (r.Env = ['TOKEN=secret'])],
    ['privileged', (r) => (r.HostConfig.Privileged = true)],
    ['a bind mount', (r) => (r.HostConfig.Binds = ['/var/run/docker.sock:/var/run/docker.sock'])],
    ['the run network', (r) => (r.HostConfig.NetworkMode = `sdlc-run-${RUN_ID}`)],
    ['a writable root', (r) => (r.HostConfig.ReadonlyRootfs = false)],
    ['a capability', (r) => (r.HostConfig.CapDrop = [])],
    ['a command', (r) => (r.Cmd = ['sh', '-c', 'id'])],
    [
      'a mount',
      (r) =>
        (r.HostConfig.Mounts = [{ Type: 'volume', Source: 'x', Target: '/x', ReadOnly: false }]),
    ],
    [
      'an executable /tmp',
      (r) => (r.HostConfig.Tmpfs = { '/tmp': 'rw,exec,nosuid,nodev,size=1,mode=1777' }),
    ],
    ['another run', (r) => ((r.Labels as Record<string, string>)['sdlc.run-id'] = TENANT_ID)],
    ['no network alias', (r) => delete r.NetworkingConfig],
    [
      'an alias on the run network',
      (r) =>
        (r.NetworkingConfig = {
          EndpointsConfig: { [`sdlc-run-${RUN_ID}`]: { Aliases: ['t-0123456789ab'] } },
        }),
    ],
    [
      'another alias',
      (r) =>
        (r.NetworkingConfig = { EndpointsConfig: { [names.toolNetwork]: { Aliases: ['tools'] } } }),
    ],
    ['an unbounded log', (r) => (r.HostConfig.LogConfig = { Type: 'json-file', Config: {} })],
    [
      'another log driver',
      (r) =>
        (r.HostConfig.LogConfig = {
          Type: 'syslog',
          Config: { 'max-size': '4m', 'max-file': '1' },
        }),
    ],
  ])('refuses a tool container with %s', (_name, change) => {
    expect(() => assertSafeToolSpec(name, broken(tool(), change))).toThrow();
  });

  it.each<[string, (raw: Raw) => void]>([
    ['another command', (r) => (r.Cmd = ['-f', '/tmp/other.yaml'])],
    [
      'another volume',
      (r) =>
        (r.HostConfig.Mounts = [
          { Type: 'volume', Source: `sdlc-ws-${RUN_ID}`, Target: '/config', ReadOnly: false },
        ]),
    ],
    [
      'a second mount',
      (r) =>
        (r.HostConfig.Mounts = [
          ...(r.HostConfig.Mounts as unknown[]),
          { Type: 'volume', Source: 'x', Target: '/x', ReadOnly: false },
        ]),
    ],
    [
      'a tmpfs',
      (r) => (r.HostConfig.Tmpfs = { '/tmp': 'rw,noexec,nosuid,nodev,size=1,mode=1777' }),
    ],
    ['an environment value', (r) => (r.Env = ['RUST_LOG=trace'])],
    [
      'a network alias',
      (r) =>
        (r.NetworkingConfig = {
          EndpointsConfig: { [names.toolNetwork]: { Aliases: ['t-0123456789ab'] } },
        }),
    ],
  ])('refuses a gateway with %s', (_name, change) => {
    expect(() => assertSafeGatewaySpec(names.gateway, broken(gateway(), change))).toThrow();
  });

  it('calls a tool by a short alias, so a long tool key still fits in a DNS label', () => {
    expect(toolHost('a'.repeat(63))).toMatch(/^t-[0-9a-f]{12}$/);
    expect(tool().NetworkingConfig).toEqual({
      EndpointsConfig: { [names.toolNetwork]: { Aliases: [toolHost('project-docs')] } },
    });
  });

  it('refuses a tool container under another name', () => {
    expect(() => assertSafeToolSpec(`sdlc-sandbox-${RUN_ID}`, tool())).toThrow();
    expect(() => assertSafeGatewaySpec(name, gateway())).toThrow();
  });

  it("creates the run's tool network as an internal bridge", () => {
    expect(() =>
      assertSafeNetworkSpec({
        Name: names.toolNetwork,
        Driver: 'bridge',
        Internal: true,
        Attachable: false,
        EnableIPv6: false,
        Labels: labels,
        Options: { 'com.docker.network.bridge.inhibit_ipv4': 'true' },
      }),
    ).not.toThrow();
  });
});

describe('the counts from the gateway log lines (ADR-M69 §2.7, QUESTIONS #532)', () => {
  const line = (fields: Record<string, unknown>) =>
    JSON.stringify({ level: 'info', scope: 'request', ...fields });
  const call = (target: string, status = 200) =>
    line({ 'mcp.method.name': 'tools/call', 'mcp.target': target, 'http.status': status });
  const logs = [
    '{"level":"info","scope":"agent_core::readiness","message":"marking server ready"}',
    line({ 'mcp.method.name': 'initialize', 'http.status': 200 }),
    call('project-docs'),
    call('project-docs'),
    call('project-docs', 502),
    line({ 'http.status': 403, reason: 'Authorization', error: 'authorization failed' }),
    line({ 'http.status': 403, reason: 'Authorization', error: 'authorization failed' }),
    line({ 'http.status': 200, reason: 'RateLimit', error: 'mcp: rate limit exceeded' }),
    line({ 'http.status': 401, reason: 'APIKeyAuth', error: 'missing key' }),
    'not json at all',
  ].join('\n');

  it('counts an error answer of the tool as a failed call, not a refusal', () => {
    const upstream = line({
      'mcp.method.name': 'tools/call',
      'mcp.target': 'project-docs',
      'http.status': 200,
      error: 'upstream',
    });
    const usage = toolUsage(`${call('project-docs', 404)}\n${upstream}`, [grant('project-docs')]);
    expect(usage.tools[0]?.counts).toEqual({ calls: 0, failedCalls: 2, refusedCalls: 0 });
    expect(usage.refusals).toEqual([]);
  });

  it('counts calls, failures and refusals for the one tool of the run', () => {
    expect(toolUsage(logs, [grant('project-docs')])).toEqual({
      tools: [{ toolKey: 'project-docs', counts: { calls: 2, failedCalls: 1, refusedCalls: 3 } }],
      refusals: [
        { reason: 'argument_refused', toolKey: 'project-docs' },
        { reason: 'max_calls', toolKey: 'project-docs' },
        { reason: 'key_refused' },
      ],
    });
  });

  it('with two tools, refusals without a target count for the run only', () => {
    const usage = toolUsage(`${logs}\n${call('other-docs')}`, [
      grant('project-docs'),
      grant('other-docs'),
    ]);
    expect(usage.tools).toEqual([
      { toolKey: 'other-docs', counts: { calls: 1, failedCalls: 0, refusedCalls: 0 } },
      { toolKey: 'project-docs', counts: { calls: 2, failedCalls: 1, refusedCalls: 0 } },
    ]);
    expect(usage.refusals).toEqual([
      { reason: 'argument_refused' },
      { reason: 'max_calls' },
      { reason: 'key_refused' },
    ]);
  });

  it('a tool that was never called gets zero counts', () => {
    expect(toolUsage('', [grant('project-docs')]).tools[0]?.counts).toEqual({
      calls: 0,
      failedCalls: 0,
      refusedCalls: 0,
    });
  });
});
