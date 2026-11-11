#!/usr/bin/env node
// Starts the Docker AuthZ plugin (ADR-M105). Usage:
//   node dist/main.js --socket <path> [--operator-key-file <path>]
// Default socket: SDLC_DOCKER_AUTHZ_SOCKET or /run/docker/plugins/sdlc-authz.sock
// Default operator key file: `operator-key` next to the socket (QUESTIONS #661).
import { dirname, join } from 'node:path';

import { startAuthzPlugin } from './server.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const socket =
  arg('--socket') ?? process.env.SDLC_DOCKER_AUTHZ_SOCKET ?? '/run/docker/plugins/sdlc-authz.sock';

const operatorKeyFile =
  arg('--operator-key-file') ??
  process.env.SDLC_DOCKER_AUTHZ_OPERATOR_KEY_FILE ??
  join(dirname(socket), 'operator-key');

const plugin = await startAuthzPlugin({ socketPath: socket, operatorKeyFile });
process.stdout.write(`sdlc-docker-authz listening on ${socket}\n`);

const stop = () => {
  void plugin.close().finally(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
