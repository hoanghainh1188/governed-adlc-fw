#!/usr/bin/env node
// The `read_code` tool of one run (task X06 PR 2, design/ADR-M108 §2.8, ADR-M69 §2.4). One
// container per run, started by the runner:
//
// - its settings and credential are files the runner wrote before the start
//   (`/run/sdlc-tool/config.json`, `credentials.json`), never environment values;
// - it reaches `knowledge-db` only (the run's own login, read-only on the project's code schema),
//   on its service network; it calls no model;
// - the run's gateway is its only caller, on the tool network (port 8080, path `/mcp`).
//
// It logs one line per answer with file IDs and content hashes, nothing else: never a name, a
// path, a key or a login.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { PgCodeIndexReader } from '@sdlc/adapter-knowledge-pgvector';
import {
  TOOL_CONFIG_FILE,
  TOOL_CREDENTIALS_FILE,
  TOOL_MCP_PATH,
  TOOL_MCP_PORT,
  TOOL_RUNTIME_DIR,
} from '@sdlc/contracts';

import { handleMessage, type McpDeps } from './mcp.js';
import { readRuntime } from './runtime.js';

/** The largest request body: arguments of at most 1000 characters fit many times. */
const MAX_BODY_BYTES = 64 * 1024;
const VERSION = '1.0.0';

function write(line: unknown): void {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

function main(): void {
  const read = (name: string) => fs.readFileSync(path.join(TOOL_RUNTIME_DIR, name), 'utf8');
  const { config, credentials } = readRuntime(read(TOOL_CONFIG_FILE), read(TOOL_CREDENTIALS_FILE));
  const reader = new PgCodeIndexReader({
    host: config.database.host,
    port: config.database.port,
    database: config.database.name,
    user: credentials.db_username,
    password: credentials.db_password,
    schema: config.schema,
  });
  const indexId = config.index_id;
  const deps: McpDeps = {
    version: VERSION,
    log: write,
    query: (args) => {
      switch (args.tool) {
        case 'find_symbol':
          return reader.findSymbol({ indexId, ...args });
        case 'find_references':
          return reader.findReferences({ indexId, ...args });
        case 'related_files':
          return reader.relatedFiles({ indexId, ...args });
      }
    },
  };
  serve(deps);
}

function serve(deps: McpDeps): void {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200).end('ok');
      return;
    }
    if (req.url !== TOOL_MCP_PATH) {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        res.writeHead(413).end();
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (size > MAX_BODY_BYTES) return;
      let message: unknown;
      try {
        message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        res.writeHead(400).end();
        return;
      }
      void handleMessage(deps, message).then(
        (answer) => {
          if (answer.body === undefined) {
            res.writeHead(answer.status).end();
            return;
          }
          res
            .writeHead(answer.status, { 'content-type': 'application/json' })
            .end(JSON.stringify(answer.body));
        },
        () => res.writeHead(500).end(),
      );
    });
  });
  server.listen(TOOL_MCP_PORT, '0.0.0.0');
}

main();
