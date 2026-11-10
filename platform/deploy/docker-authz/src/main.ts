#!/usr/bin/env node
// Starts the Docker AuthZ plugin (ADR-M105). Usage:
//   node dist/main.js --socket <path>
// Default socket: SDLC_DOCKER_AUTHZ_SOCKET or /run/docker/plugins/sdlc-authz.sock
import { startAuthzPlugin } from './server.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const socket =
  arg('--socket') ?? process.env.SDLC_DOCKER_AUTHZ_SOCKET ?? '/run/docker/plugins/sdlc-authz.sock';

const plugin = await startAuthzPlugin({ socketPath: socket });
process.stdout.write(`sdlc-docker-authz listening on ${socket}\n`);

const stop = () => {
  void plugin.close().finally(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
