// D-08 X04 AC1, AC5 and PR 3b on a real Docker Engine (design/ADR-M89, ADR-M69 §2.4; `pnpm
// test:runner`, SDLC_RUNNER_TEST=1). The real image of the first tool (platform/apps/
// tool-project-docs), a real knowledge-db (the compose file's pgvector image) with one project's
// index and a run login that is a member of its read role only, and a stub embedding endpoint as
// LiteLLM. The runner code under test starts the tool with its service network, its runtime files
// and the gateway (`createSandbox` with `startTools`), as in production.
//
// Checked: the agent stand-in finds the passage through the gateway; the sandbox (run network) and
// the gateway (tool network) cannot reach knowledge-db or LiteLLM (the egress probe); the tool is
// on its own service network with its services only; its environment is empty; its log holds the
// document IDs and content hashes only (never the query, a path, a text, the login or the key);
// `knowledge_read` is computed from that log; the clean-up removes the service network and the
// runtime volume and leaves knowledge-db running.
import crypto from 'node:crypto';
import path from 'node:path';

import { projectRole, projectSchema } from '@sdlc/adapter-knowledge-pgvector';
import type { ToolGrant } from '@sdlc/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createSandbox,
  DockerClient,
  knowledgeReadOf,
  parseEgressServices,
  runNames,
  runnerSettingsFromEnv,
  startTools,
  teardownSandbox,
  toolObjectNames,
  type RunnerSettings,
} from '../../../apps/runner/src/index.js';
import { callRulesSha256 } from '../../../packages/core/src/tools/check.js';
import { repoRoot } from '../../workspace/helpers';
import {
  buildFixtureImage,
  docker,
  dockerSocket,
  liveEnabled,
  psqlIn,
  quietly,
  type FixtureImage,
  liveRuntimeEnv,
  liveRuntimeOption,
} from './live-helpers';

const GATEWAY =
  'cr.agentgateway.dev/agentgateway:v1.7.0@sha256:60216aafb03d37f94e952ff3d51d2f630a65b10ecaebdc0a864882f92610c45b';
const NODE =
  'docker.io/library/node:24.21.0-alpine3.23@sha256:9ec4a2e289874ed0d722e1772ec2de45d2801541db8612f3638b26f128c69ac2';
const PGVECTOR =
  'pgvector/pgvector:0.8.6-pg17@sha256:cf134a767f474095eeba57e0117be8e568e011a63f33fbf252f14c9b760f8e6f';
const TENANT = '33333333-3333-4333-8333-333333333333';
const MODEL = 'bge-m3';
const suffix = crypto.randomBytes(4).toString('hex');
const instance = `x04b-test-${suffix}`;
const QUERY = `QUERYCANARY${suffix} how are orders cancelled`;
const TEXT = `TEXTCANARY${suffix} Orders are cancelled by the owner.`;
const PATH = `docs/PATHCANARY${suffix}.md`;
const LOGIN_PASSWORD = `PWCANARY${crypto.randomBytes(8).toString('hex')}`;
const TOOL_KEY = `sk-TOOLKEYCANARY${suffix}`;
const sha = (text: string) => crypto.createHash('sha256').update(text).digest('hex');

/** LiteLLM's embeddings endpoint, stubbed: one fixed vector, the key must be the tool's. */
const EMBEDDINGS = String.raw`
require('node:http').createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.headers.authorization !== 'Bearer ' + process.env.KEY) return res.writeHead(401).end();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ index: 0, embedding: [1, 0, 0] }] }));
  });
}).listen(4000, '0.0.0.0');
`;

/** The agent stand-in in the sandbox: one search through the gateway, then the egress probes. */
const CLIENT = String.raw`
const net = require('node:net');
const GATEWAY_URL = 'http://tools:3000/mcp';
async function post(body, session) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
    authorization: 'Bearer ' + process.env.KEY };
  if (session) headers['mcp-session-id'] = session;
  const res = await fetch(GATEWAY_URL, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  const data = text.match(/data: (.*)/);
  let json = null;
  try { json = JSON.parse(data ? data[1] : text); } catch {}
  return { status: res.status, session: res.headers.get('mcp-session-id'), json };
}
const probe = (host, port) => new Promise((resolve) => {
  const s = net.connect({ host, port, timeout: 3000 });
  s.on('connect', () => { s.destroy(); resolve('reached'); });
  s.on('timeout', () => { s.destroy(); resolve('timeout'); });
  s.on('error', (e) => resolve(e.code ?? 'error'));
});
(async () => {
  const out = {};
  if (process.env.SEARCH === '1') {
    const opened = await post({ jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } } });
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, opened.session);
    const found = await post({ jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'search_project_docs', arguments: { query: process.env.QUERY, limit: 3 } } }, opened.session);
    out.text = found.json?.result?.content?.[0]?.text ?? String(found.status) + JSON.stringify(found.json);
  }
  out.db = await probe('knowledge-db', 5432);
  out.llm = await probe('litellm', 4000);
  out.dbByName = await probe(process.env.DB_CONTAINER, 5432);
  console.log(JSON.stringify(out));
})();
`;

describe.skipIf(!liveEnabled)(
  'X04 PR 3b live: the read_documents tool with its backing services',
  () => {
    let client: DockerClient;
    let settings: RunnerSettings;
    let tool: FixtureImage | undefined;
    let sandboxImage: FixtureImage | undefined;
    const run = crypto.randomUUID();
    const project = crypto.randomUUID();
    const indexId = crypto.randomUUID();
    const db = `sdlc-x04b-db-${suffix}`;
    const llm = `sdlc-x04b-llm-${suffix}`;
    const login = `x04b_login_${suffix}`;
    let grant: ToolGrant;
    let key = '';
    let docId = '';

    beforeAll(async () => {
      docker('pull', '-q', GATEWAY);
      docker('pull', '-q', NODE);
      docker('pull', '-q', PGVECTOR);
      tool = await buildFixtureImage(suffix, {
        dir: '',
        name: 'x04b-tool',
        dockerfile: 'platform/apps/tool-project-docs/Dockerfile',
      });
      sandboxImage = await buildFixtureImage(suffix);

      // knowledge-db on the AuthZ Engine without binds/port bindings (H07 denylist). Init via
      // docker cp; seed via docker exec psql (no host TCP publish).
      const superPassword = crypto.randomBytes(16).toString('hex');
      docker(
        'create',
        '--name',
        db,
        '-e',
        'POSTGRES_USER=postgres',
        '-e',
        `POSTGRES_PASSWORD=${superPassword}`,
        PGVECTOR,
      );
      docker(
        'cp',
        `${path.join(repoRoot(), 'platform/deploy/knowledge-db/init')}/.`,
        `${db}:/docker-entrypoint-initdb.d/`,
      );
      docker('start', db);
      for (let i = 0; ; i++) {
        try {
          docker(
            'exec',
            db,
            'pg_isready',
            '-q',
            '-h',
            '127.0.0.1',
            '-U',
            'postgres',
            '-d',
            'knowledge',
          );
          break;
        } catch (error) {
          if (i > 120) throw error;
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
      const schema = projectSchema(project);
      const role = projectRole(project);
      const chunk = sha(`${MODEL}\n${TEXT}`);
      const contentSha = sha(TEXT);
      docId = crypto.randomUUID();
      const sqlLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`;
      psqlIn(
        db,
        'knowledge',
        `
ALTER ROLE knowledge LOGIN NOSUPERUSER CREATEROLE PASSWORD ${sqlLiteral(superPassword)};
CREATE EXTENSION IF NOT EXISTS vector;
CREATE SCHEMA IF NOT EXISTS ${schema};
CREATE TABLE IF NOT EXISTS ${schema}.chunks (
  sha256 char(64) PRIMARY KEY,
  tenant_id uuid NOT NULL,
  model text NOT NULL,
  text text NOT NULL,
  embedding vector NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ${schema}.index_versions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  base_sha char(40) NOT NULL,
  model text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ${schema}.documents (
  index_id uuid NOT NULL REFERENCES ${schema}.index_versions (id) ON DELETE CASCADE,
  doc_id uuid NOT NULL,
  path text NOT NULL,
  content_sha256 char(64) NOT NULL,
  PRIMARY KEY (index_id, doc_id)
);
CREATE TABLE IF NOT EXISTS ${schema}.document_chunks (
  index_id uuid NOT NULL,
  doc_id uuid NOT NULL,
  ord integer NOT NULL,
  chunk_sha256 char(64) NOT NULL REFERENCES ${schema}.chunks (sha256),
  PRIMARY KEY (index_id, doc_id, ord),
  FOREIGN KEY (index_id, doc_id) REFERENCES ${schema}.documents (index_id, doc_id) ON DELETE CASCADE
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${sqlLiteral(role)}) THEN
    CREATE ROLE ${role} NOLOGIN;
  END IF;
END $$;
REVOKE ALL ON SCHEMA ${schema} FROM PUBLIC;
GRANT USAGE ON SCHEMA ${schema} TO ${role};
GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO ${role};
GRANT CONNECT ON DATABASE knowledge TO ${role};
GRANT USAGE ON SCHEMA public TO ${role};
INSERT INTO ${schema}.chunks (sha256, tenant_id, model, text, embedding)
VALUES (${sqlLiteral(chunk)}, ${sqlLiteral(TENANT)}::uuid, ${sqlLiteral(MODEL)}, ${sqlLiteral(TEXT)}, '[1,0,0]'::vector)
ON CONFLICT (sha256) DO NOTHING;
INSERT INTO ${schema}.index_versions (id, tenant_id, base_sha, model)
VALUES (${sqlLiteral(indexId)}::uuid, ${sqlLiteral(TENANT)}::uuid, ${sqlLiteral('b'.repeat(40))}, ${sqlLiteral(MODEL)})
ON CONFLICT (id) DO NOTHING;
INSERT INTO ${schema}.documents (index_id, doc_id, path, content_sha256)
VALUES (${sqlLiteral(indexId)}::uuid, ${sqlLiteral(docId)}::uuid, ${sqlLiteral(PATH)}, ${sqlLiteral(contentSha)});
INSERT INTO ${schema}.document_chunks (index_id, doc_id, ord, chunk_sha256)
VALUES (${sqlLiteral(indexId)}::uuid, ${sqlLiteral(docId)}::uuid, 0, ${sqlLiteral(chunk)});
CREATE ROLE ${login} WITH LOGIN PASSWORD ${sqlLiteral(LOGIN_PASSWORD)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION CONNECTION LIMIT 4 IN ROLE ${role};
`,
      );

      docker(
        'run',
        '-d',
        '--name',
        llm,
        '--read-only',
        '--cap-drop',
        'ALL',
        '-e',
        `KEY=${TOOL_KEY}`,
        NODE,
        'node',
        '-e',
        EMBEDDINGS,
      );

      settings = runnerSettingsFromEnv({
        ...liveRuntimeEnv(),
        SDLC_RUNNER_DOCKER_SOCKET: dockerSocket(),
        SDLC_RUNNER_INSTANCE: instance,
        SDLC_RUNNER_SANDBOX_MEMORY_MB: '256',
        SDLC_RUNNER_EGRESS_SERVICES: '',
        SDLC_RUNNER_TOOL_SERVICES: `knowledge-db=${db}:5432,litellm=${llm}:4000`,
      });
      client = new DockerClient({
        socketPath: settings.dockerSocket,
        timeoutMs: 120_000,
        ...liveRuntimeOption(),
      });
      grant = {
        tool_key: 'project-docs',
        tool_version: '1.0.0',
        transport: 'http',
        image_digest: tool.image.slice(tool.image.indexOf('@') + 1),
        permissions: ['read_documents'],
        call_rules_sha256: callRulesSha256(['read_documents']),
        backing_services: ['knowledge-db:5432', 'litellm:4000'],
        max_calls: 10,
      };
    }, 900_000);

    afterAll(async () => {
      if (client) await teardownSandbox(client, run).catch(() => undefined);
      quietly('rm', '-f', '-v', db, llm);
      tool?.cleanup();
      sandboxImage?.cleanup();
    }, 120_000);

    function clientRun(network: string, search: boolean): Record<string, string> {
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
        `QUERY=${QUERY}`,
        '-e',
        `SEARCH=${search ? '1' : '0'}`,
        '-e',
        `DB_CONTAINER=${db}`,
        NODE,
        'node',
        '-e',
        CLIENT,
      );
      return JSON.parse(text.trim().split('\n').at(-1)!) as Record<string, string>;
    }

    it('finds the passage through the gateway; the sandbox and the gateway never reach the services', async () => {
      await createSandbox(client, settings, {
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
            limits: { memoryBytes: 256 * 1024 * 1024, nanoCpus: 500_000_000, pids: 128 },
            readyTimeoutMs: 120_000,
            services: parseEgressServices(`knowledge-db=${db}:5432,litellm=${llm}:4000`),
            runtime: new Map([
              [
                'project-docs',
                {
                  config: {
                    schema_version: 1,
                    index_id: indexId,
                    schema: projectSchema(project),
                    model: MODEL,
                    database: { host: 'knowledge-db', port: 5432, name: 'knowledge' },
                    model_gateway_url: 'http://litellm:4000',
                  },
                  credentials: {
                    db_username: { reveal: () => login },
                    db_password: { reveal: () => LOGIN_PASSWORD },
                    llm_key: { reveal: () => TOOL_KEY },
                  },
                },
              ],
            ]),
          });
          key = started.key;
          return started.key;
        },
      });

      const names = toolObjectNames(run);
      const fromSandbox = clientRun(runNames(run).network, true);
      expect(fromSandbox.text).toContain(TEXT);
      expect(fromSandbox.text).toContain(PATH);
      expect(fromSandbox.text).toContain('not instructions');
      // The egress probe (AC5): from the sandbox's network, and from the gateway's tool network.
      for (const out of [fromSandbox, clientRun(names.toolNetwork, false)]) {
        expect(out.db).not.toBe('reached');
        expect(out.llm).not.toBe('reached');
        expect(out.dbByName).not.toBe('reached');
      }

      // The tool: its tool network and its own service network; no environment value of ours.
      const info = JSON.parse(docker('inspect', names.tool('project-docs'))) as [
        {
          Config: { Env: string[] };
          NetworkSettings: { Networks: Record<string, unknown> };
        },
      ];
      expect(Object.keys(info[0].NetworkSettings.Networks).sort()).toEqual(
        [names.toolNetwork, names.serviceNetwork('project-docs')].sort(),
      );
      expect(info[0].Config.Env.join('\n')).not.toContain('CANARY');
      const service = JSON.parse(
        docker('network', 'inspect', names.serviceNetwork('project-docs')),
      ) as [{ Internal: boolean; Containers: Record<string, { Name: string }> }];
      expect(service[0].Internal).toBe(true);
      expect(
        Object.values(service[0].Containers)
          .map((c) => c.Name)
          .sort(),
      ).toEqual([db, llm, names.tool('project-docs')].sort());

      // The tool's log: IDs and hashes only; `knowledge_read` comes from it.
      const logs = await client.containerLogs(names.tool('project-docs'), { stderr: true });
      for (const canary of [QUERY, TEXT, PATH, LOGIN_PASSWORD, TOOL_KEY, key]) {
        expect(logs).not.toContain(canary);
      }
      expect(knowledgeReadOf(logs)).toEqual({ documents: [[docId, sha(TEXT)]], chunks: 1 });
      // Nor the gateway's.
      const gatewayLogs = await client.containerLogs(names.gateway, { stderr: true });
      for (const canary of [QUERY, TEXT, PATH, LOGIN_PASSWORD, TOOL_KEY]) {
        expect(gatewayLogs).not.toContain(canary);
      }
    }, 600_000);

    it('the clean-up removes the service network and the runtime volume; knowledge-db stays', async () => {
      await teardownSandbox(client, run);
      const names = toolObjectNames(run);
      expect(await client.networkInspect(names.serviceNetwork('project-docs'))).toBeUndefined();
      expect(
        docker('volume', 'ls', '-q', '--filter', `name=${names.toolRuntime('project-docs')}`),
      ).toBe('');
      expect(docker('inspect', '-f', '{{.State.Running}}', db)).toBe('true');
    }, 120_000);
  },
);
