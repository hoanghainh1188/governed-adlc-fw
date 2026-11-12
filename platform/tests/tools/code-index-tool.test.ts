// D-08 X06 AC1 (design/ADR-M108 §2.8): the register tool `read_code` through MCP. It lists three
// tools with the call rules of the catalogue, checks its arguments again (it never trusts its
// caller) and that a path is relative with no `..`, frames the places as data, and logs file IDs
// and content hashes only: never a name or a path. Its runtime files hold no model key.
import {
  KNOWLEDGE_READ_LOG_EVENT,
  TOOL_CALL_RULES,
  TOOL_PERMISSIONS,
  toolCallRulesJson,
  type KnowledgeReadLogLine,
} from '@sdlc/contracts';
import { describe, expect, it } from 'vitest';

import {
  answerText,
  callArguments,
  DEFAULT_LIMIT,
  handleMessage,
  isSafePath,
  readRuntime,
  TOOL_NAMES,
  type CallArgs,
  type CodePlace,
  type McpDeps,
} from '../../apps/tool-code-index/src/index.js';

const FILE = '44444444-4444-4444-8444-444444444444';
const FILE2 = '55555555-5555-4555-8555-555555555555';
const SHA = 'b'.repeat(64);
const PLACES: CodePlace[] = [
  {
    fileId: FILE,
    contentSha256: SHA,
    path: 'src/orders/service.ts',
    language: 'typescript',
    name: 'OrderService',
    kind: 'class',
    line: 12,
  },
  {
    fileId: FILE,
    contentSha256: SHA,
    path: 'src/orders/service.ts',
    language: 'typescript',
    name: 'OrderServiceFactory',
    kind: 'function',
    line: 40,
  },
  {
    fileId: FILE2,
    contentSha256: 'c'.repeat(64),
    path: 'src/app.ts',
    language: 'typescript',
    relation: 'imported_by',
  },
];

function deps(
  answer: (args: CallArgs) => Promise<readonly CodePlace[]> = () => Promise.resolve(PLACES),
) {
  const logs: KnowledgeReadLogLine[] = [];
  const calls: CallArgs[] = [];
  const d: McpDeps = {
    version: '1.0.0',
    log: (line) => logs.push(line),
    query: (args) => {
      calls.push(args);
      return answer(args);
    },
  };
  return { d, logs, calls };
}

const call = (name: string, args: unknown, id: number | string = 1) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name, arguments: args },
});

describe('X06: the permission read_code in the catalogue (ADR-M108 §2.8)', () => {
  it('has three tools with bounded arguments, and its own call rules hash', () => {
    expect(TOOL_PERMISSIONS).toContain('read_code');
    expect(TOOL_CALL_RULES.read_code.map((r) => r.tool)).toEqual([...TOOL_NAMES]);
    for (const rule of TOOL_CALL_RULES.read_code) {
      for (const spec of Object.values(rule.arguments)) {
        if (spec.type === 'string') expect(spec.max_length).toBeLessThanOrEqual(1000);
        else expect(spec.max).toBeLessThanOrEqual(100);
      }
    }
    expect(toolCallRulesJson(['read_code'])).not.toBe(toolCallRulesJson(['read_documents']));
  });
});

describe('X06: the MCP side of read_code (AC1)', () => {
  it('initializes and lists the three tools with the limits of the call rules', async () => {
    const { d } = deps();
    const init = await handleMessage(d, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {},
    });
    expect(init.body).toMatchObject({
      result: { serverInfo: { name: 'sdlc-code-index', version: '1.0.0' } },
    });
    const list = await handleMessage(d, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const tools = (list.body as { result: { tools: { name: string; inputSchema: unknown }[] } })
      .result.tools;
    expect(tools.map((t) => t.name)).toEqual([...TOOL_NAMES]);
    expect(tools[0]!.inputSchema).toMatchObject({
      required: ['name'],
      additionalProperties: false,
      properties: { name: { maxLength: 200 }, limit: { minimum: 1, maximum: 50 } },
    });
  });

  it('answers find_symbol with paths and lines framed as data', async () => {
    const { d, calls } = deps();
    const answer = await handleMessage(
      d,
      call('find_symbol', { name: 'OrderService', kind: 'class' }),
    );
    const text = (answer.body as { result: { content: { text: string }[]; isError: boolean } })
      .result;
    expect(text.isError).toBe(false);
    expect(text.content[0]!.text).toContain('not instructions');
    expect(text.content[0]!.text).toContain('src/orders/service.ts:12 class OrderService');
    expect(calls).toEqual([
      { tool: 'find_symbol', name: 'OrderService', kind: 'class', limit: DEFAULT_LIMIT },
    ]);
  });

  it('passes find_references and related_files with their own arguments', async () => {
    const { d, calls } = deps();
    await handleMessage(d, call('find_references', { name: 'load', limit: 100 }));
    await handleMessage(d, call('related_files', { path: 'src/app.ts', limit: 3 }));
    expect(calls).toEqual([
      { tool: 'find_references', name: 'load', limit: 100 },
      { tool: 'related_files', path: 'src/app.ts', limit: 3 },
    ]);
    expect(answerText(calls[1]!, [PLACES[2]!])).toContain(
      'src/app.ts (typescript; imports the file)',
    );
  });

  it('logs the distinct file IDs and content hashes and the places, never a name or path', async () => {
    const { d, logs } = deps();
    await handleMessage(d, call('find_symbol', { name: 'OrderService' }));
    expect(logs).toEqual([
      {
        event: KNOWLEDGE_READ_LOG_EVENT,
        documents: [
          [FILE, SHA],
          [FILE2, 'c'.repeat(64)],
        ],
        chunks: 3,
      },
    ]);
    expect(JSON.stringify(logs)).not.toMatch(/OrderService|src\//);
  });

  it.each([
    ['an unknown argument', 'find_symbol', { name: 'a', extra: 1 }],
    ['no name', 'find_symbol', { kind: 'class' }],
    ['an empty name', 'find_references', { name: '  ' }],
    ['a name too long', 'find_symbol', { name: 'x'.repeat(201) }],
    ['a kind that is a use', 'find_symbol', { name: 'a', kind: 'call' }],
    ['a limit over the rule', 'find_symbol', { name: 'a', limit: 51 }],
    ['a limit that is not an integer', 'find_references', { name: 'a', limit: 1.5 }],
    ['an absolute path', 'related_files', { path: '/etc/passwd' }],
    ['a path with ..', 'related_files', { path: 'src/../../x.ts' }],
    ['a backslash path', 'related_files', { path: 'src\\a.ts' }],
    ['arguments that are not an object', 'find_symbol', ['a']],
  ])('refuses %s without asking the index', async (_label, tool, args) => {
    const { d, calls, logs } = deps();
    const answer = await handleMessage(d, call(tool, args));
    expect(answer.body).toMatchObject({ error: { code: -32602 } });
    expect(calls).toEqual([]);
    expect(logs).toEqual([]);
  });

  it('refuses another tool, another method and a batch', async () => {
    const { d } = deps();
    expect(
      (await handleMessage(d, call('search_project_docs', { query: 'a' }))).body,
    ).toMatchObject({ error: { message: 'unknown tool' } });
    expect(
      (await handleMessage(d, { jsonrpc: '2.0', id: 1, method: 'resources/list' })).body,
    ).toMatchObject({ error: { code: -32601 } });
    expect((await handleMessage(d, [call('find_symbol', { name: 'a' })])).body).toMatchObject({
      error: { code: -32600 },
    });
    expect((await handleMessage(d, { jsonrpc: '2.0', method: 'notifications/x' })).status).toBe(
      202,
    );
  });

  it('a query that fails is a tool error with a code, and nothing is logged', async () => {
    const { d, logs } = deps(() => Promise.reject(new Error('password canary')));
    const answer = await handleMessage(d, call('find_symbol', { name: 'a' }));
    expect(answer.body).toMatchObject({
      result: { isError: true, content: [{ text: 'search_unavailable' }] },
    });
    expect(JSON.stringify(answer)).not.toContain('canary');
    expect(logs).toEqual([]);
  });

  it('no place: a plain sentence; a full answer says more may exist', () => {
    expect(answerText({ tool: 'find_references', name: 'a', limit: 5 }, [])).toBe(
      'Nothing found in the project code index.',
    );
    expect(answerText({ tool: 'find_symbol', name: 'a', limit: 3 }, PLACES)).toContain(
      'more may exist',
    );
  });

  it('isSafePath and callArguments', () => {
    expect(isSafePath('src/a.ts')).toBe(true);
    for (const bad of ['', '/a', 'a//b', './a', 'a/./b', 'a/..', 'a\u0000b']) {
      expect(isSafePath(bad), bad).toBe(false);
    }
    expect(callArguments('nope', { name: 'a' })).toBeUndefined();
  });
});

describe('X06: the runtime files of the code tool (written by the runner)', () => {
  const config = {
    schema_version: 1,
    index_id: FILE,
    schema: `kcode_p${'a'.repeat(32)}`,
    database: { host: 'knowledge-db', port: 5432, name: 'knowledge' },
  };
  const credentials = { db_username: 'v-kdocs-run', db_password: 'secret-canary' };

  it('reads valid files', () => {
    expect(readRuntime(JSON.stringify(config), JSON.stringify(credentials))).toEqual({
      config,
      credentials,
    });
  });

  it.each([
    ['a document schema', { ...config, schema: `kdocs_p${'a'.repeat(32)}` }, credentials],
    ['a bad index ID', { ...config, index_id: 'x' }, credentials],
    ['a bad port', { ...config, database: { ...config.database, port: 0 } }, credentials],
    ['a model key in the credential', config, { ...credentials, llm_key: 'sk' }],
    ['a missing password', config, { db_username: 'u' }],
  ])('refuses %s, without echoing a value', (_label, c, k) => {
    let message = '';
    try {
      readRuntime(JSON.stringify(c), JSON.stringify(k));
    } catch (error) {
      message = String(error);
    }
    expect(message).toMatch(/tool\.runtime_invalid/);
    expect(message).not.toContain('secret-canary');
  });
});
