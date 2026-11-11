// D-08 X04 (PR 2) on a real Docker Engine (design/ADR-M69 §2.4–§2.8, ADR-M87 §5, ADR-M80 §4.2).
// Runs only with SDLC_RUNNER_TEST=1 (`pnpm test:runner`). The runner code under test creates the
// run network, the register tool, the MCP gateway and the sandbox (`createSandbox` with
// `startTools`), through the guard, as in production. A "client" container on the run network
// stands in for the agent in the sandbox (test infrastructure, docker CLI).
//
// Checked: the key (none, wrong) is refused; only the granted tool is listed and called; argument
// rules refuse a bad value, a batch, an oversized and an unparsable body; the cap; the tool is not
// reachable from the run network; another run cannot reach this gateway; the gateway logs hold no
// key, query or answer; the counts from its logs; the clean-up removes the gateway, the tool, the
// tool network and the config volume.
import crypto from 'node:crypto';

import type { ToolGrant } from '@sdlc/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createSandbox,
  DockerClient,
  runNetworkSpec,
  runNames,
  runnerSettingsFromEnv,
  runLabels,
  startTools,
  teardownSandbox,
  toolObjectNames,
  toolUsage,
  type RunnerSettings,
} from '../../../apps/runner/src/index.js';
import { callRulesSha256 } from '../../../packages/core/src/tools/check.js';
import {
  buildFixtureImage,
  docker,
  dockerSocket,
  liveEnabled,
  quietly,
  type FixtureImage,
} from './live-helpers';

const GATEWAY =
  'cr.agentgateway.dev/agentgateway:v1.7.0@sha256:60216aafb03d37f94e952ff3d51d2f630a65b10ecaebdc0a864882f92610c45b';
const NODE =
  'docker.io/library/node:24.21.0-alpine3.23@sha256:9ec4a2e289874ed0d722e1772ec2de45d2801541db8612f3638b26f128c69ac2';
const TENANT = '33333333-3333-4333-8333-333333333333';
const QUERY_CANARY = `X04QUERY${crypto.randomBytes(6).toString('hex')}`;
const CAP = 4;

const suffix = crypto.randomBytes(4).toString('hex');
const instance = `x04-test-${suffix}`;

/** The agent stand-in: MCP calls to the gateway, one JSON result per scenario. */
const CLIENT = String.raw`
const URL = 'http://tools:3000/mcp';
const KEY = process.env.KEY;
async function post(body, { key = KEY, session, raw } = {}) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (key) headers.authorization = 'Bearer ' + key;
  if (session) headers['mcp-session-id'] = session;
  try {
    const res = await fetch(URL, { method: 'POST', headers, body: raw ?? JSON.stringify(body) });
    const text = await res.text();
    const data = text.match(/data: (.*)/);
    let json = null;
    try { json = JSON.parse(data ? data[1] : text); } catch {}
    return { status: res.status, session: res.headers.get('mcp-session-id'), json };
  } catch (error) {
    return { status: 0, error: String(error.cause?.code ?? error) };
  }
}
const init = { jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x04', version: '1' } } };
const out = {};
out.noKey = (await post(init, { key: null })).status;
out.wrongKey = (await post(init, { key: 'wrong' })).status;
const opened = await post(init);
out.init = opened.status;
const session = opened.session;
await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, { session });
const listed = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { session });
out.tools = (listed.json?.result?.tools ?? []).map((t) => t.name);
const call = (name, args, extra = {}) =>
  post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args } }, { session, ...extra });
out.allowed = (await call('search_project_docs', { query: process.env.QUERY, limit: 5 })).status;
out.notGranted = (await call('delete_docs', {})).status;
out.limit21 = (await call('search_project_docs', { query: 'q', limit: 21 })).status;
out.extraArg = (await call('search_project_docs', { query: 'q', path: '/etc/passwd' })).status;
out.batch = (await post([{ jsonrpc: '2.0', id: 4, method: 'tools/call',
  params: { name: 'search_project_docs', arguments: { query: 'q' } } }], { session })).status;
out.unparsable = (await post(null, { session, raw: '{not json' })).status;
out.oversized = (await call('search_project_docs', { query: 'x'.repeat(2_000_000) })).status;
const capped = [];
for (let i = 0; i < 6; i++) {
  // Over the cap the gateway answers 200 with a tool result marked as an error.
  const r = await call('search_project_docs', { query: 'q' });
  capped.push(r.json?.error || r.json?.result?.isError ? 'refused' : 'ok');
}
out.capped = capped;
try {
  await fetch('http://' + process.env.TOOL_HOST + ':8080/healthz');
  out.toolDirect = 'reached';
} catch (error) {
  out.toolDirect = String(error.cause?.code ?? 'failed');
}
console.log(JSON.stringify(out));
`;

describe.skipIf(!liveEnabled)('X04 live: register tools behind the run MCP gateway', () => {
  let client: DockerClient;
  let settings: RunnerSettings;
  let tool: FixtureImage | undefined;
  let sandboxImage: FixtureImage | undefined;
  const run = crypto.randomUUID();
  const other = crypto.randomUUID();
  let grant: ToolGrant;

  beforeAll(async () => {
    docker('pull', '-q', GATEWAY);
    docker('pull', '-q', NODE);
    tool = await buildFixtureImage(suffix, { dir: 'fixture-tool', name: 'x04-tool' });
    sandboxImage = await buildFixtureImage(suffix);
    settings = runnerSettingsFromEnv({
      SDLC_RUNNER_DOCKER_SOCKET: dockerSocket(),
      SDLC_RUNNER_INSTANCE: instance,
      SDLC_RUNNER_SANDBOX_MEMORY_MB: '256',
      SDLC_RUNNER_EGRESS_SERVICES: '',
    });
    client = new DockerClient({ socketPath: settings.dockerSocket, timeoutMs: 120_000 });
    grant = {
      tool_key: 'project-docs',
      tool_version: '1.0.0',
      transport: 'http',
      image_digest: tool.image.slice(tool.image.indexOf('@') + 1),
      permissions: ['read_documents'],
      call_rules_sha256: callRulesSha256(['read_documents']),
      backing_services: [],
      max_calls: CAP,
    };
  }, 600_000);

  afterAll(async () => {
    if (client) {
      for (const id of [run, other]) await teardownSandbox(client, id).catch(() => undefined);
    }
    tool?.cleanup();
    sandboxImage?.cleanup();
  }, 120_000);

  function clientRun(network: string, key: string): Record<string, unknown> {
    const text = docker(
      'run',
      '--rm',
      '--network',
      network,
      '--read-only',
      '--cap-drop',
      'ALL',
      '-e',
      `KEY=${key}`,
      '-e',
      `QUERY=${QUERY_CANARY}`,
      '-e',
      `TOOL_HOST=${toolObjectNames(run).tool('project-docs')}`,
      NODE,
      // The script travels as an argument: in CI the tests run in a container whose files the
      // Docker daemon cannot mount.
      'node',
      '--input-type=module',
      '-e',
      CLIENT,
    );
    return JSON.parse(text.trim().split('\n').at(-1)!) as Record<string, unknown>;
  }

  it('gives the sandbox the granted tool only, through the gateway, with every rule enforced', async () => {
    let key = '';
    const sandbox = await createSandbox(client, settings, {
      runId: run,
      tenantId: TENANT,
      image: sandboxImage!.image,
      adapter: 'openhands',
      egressAllowlist: [],
      startTools: async (names, labels) => {
        const started = await startTools(client, {
          run: names,
          labels,
          grants: [grant],
          images: new Map([['project-docs', tool!.image]]),
          gatewayImage: GATEWAY,
          limits: { memoryBytes: 128 * 1024 * 1024, nanoCpus: 500_000_000, pids: 128 },
          readyTimeoutMs: 60_000,
        });
        key = started.key;
        return started.key;
      },
    });
    expect(sandbox.toolKey).toBe(key);

    const names = toolObjectNames(run);
    // The gateway is on both networks; the tool on the tool network only.
    const gateway = JSON.parse(docker('inspect', names.gateway)) as [
      { NetworkSettings: { Networks: Record<string, { Aliases: string[] | null }> } },
    ];
    expect(Object.keys(gateway[0].NetworkSettings.Networks).sort()).toEqual(
      [runNames(run).network, names.toolNetwork].sort(),
    );
    const toolInfo = JSON.parse(docker('inspect', names.tool('project-docs'))) as [
      { NetworkSettings: { Networks: Record<string, unknown> } },
    ];
    expect(Object.keys(toolInfo[0].NetworkSettings.Networks)).toEqual([names.toolNetwork]);

    const out = clientRun(runNames(run).network, key);
    expect(out).toMatchObject({
      noKey: 401,
      wrongKey: 401,
      init: 200,
      tools: ['search_project_docs'],
      allowed: 200,
      limit21: 403,
      extraArg: 403,
      batch: 403,
      unparsable: 403,
    });
    expect(out.notGranted).not.toBe(200);
    expect([403, 413]).toContain(out.oversized);
    expect(out.toolDirect).not.toBe('reached');
    // Calls refused by the argument rule never reach the cap: one allowed call before leaves
    // exactly CAP - 1 here, then every call is refused.
    expect((out.capped as string[]).filter((c) => c === 'ok').length).toBe(CAP - 1);
    expect((out.capped as string[]).at(-1)).toBe('refused');

    // Only allowed calls reached the tool.
    const stats = JSON.parse(
      docker(
        'run',
        '--rm',
        '--network',
        names.toolNetwork,
        NODE,
        'node',
        '-e',
        `fetch('http://${names.tool('project-docs')}:8080/stats').then((r) => r.text()).then((t) => console.log(t))`,
      ),
    ) as Record<string, number>;
    expect(stats.delete_docs).toBe(0);
    expect(stats.search_project_docs).toBeGreaterThanOrEqual(1);

    // The gateway's logs: never the key, the query or the answer; the counts come from them.
    const logs = await client.containerLogs(names.gateway, { stderr: true });
    expect(logs).not.toContain(key);
    expect(logs).not.toContain(QUERY_CANARY);
    expect(logs).not.toContain('X04ANSWERCANARY');
    const usage = toolUsage(logs, [grant]);
    expect(usage.tools[0]?.counts.calls).toBe(stats.search_project_docs);
    expect(usage.refusals.map((r) => r.reason).sort()).toEqual(
      expect.arrayContaining(['argument_refused', 'key_refused', 'max_calls']),
    );
  }, 300_000);

  it("another run's sandbox network cannot reach this run's gateway", async () => {
    const labels = runLabels(instance, other, TENANT);
    await client.networkCreate(runNetworkSpec(runNames(other), labels));
    const out = clientRun(runNames(other).network, 'any');
    expect(out.init).toBe(0);
  }, 120_000);

  it('the clean-up removes the gateway, the tool, the tool network and the config volume', async () => {
    await teardownSandbox(client, run);
    const names = toolObjectNames(run);
    for (const name of [names.gateway, names.tool('project-docs')]) {
      expect(await client.containerInspect(name)).toBeUndefined();
    }
    expect(await client.networkInspect(names.toolNetwork)).toBeUndefined();
    expect(docker('volume', 'ls', '-q', '--filter', `name=${names.gatewayConfig}`)).toBe('');
    quietly('network', 'rm', runNames(other).network);
  }, 120_000);
});
