import path from 'node:path';
import { defineConfig } from 'vitest/config';

// Tests import workspace packages by name. Point them at the TypeScript sources, so `pnpm test`
// does not need a build first. `pnpm typecheck` checks the same imports against the built types.
const SOURCE_PACKAGES = [
  'contracts',
  'config',
  'messages',
  'api-schemas',
  'core',
  'secrets',
  'workflow-client',
  'telemetry',
  'agent-kit',
];
const SOURCE_ADAPTERS = [
  'policy-simple',
  'git-github',
  'model-litellm',
  'agent-openhands',
  'agent-opencode',
  'evidence-s3',
  'traces-langfuse',
  'knowledge-pgvector',
];

export default defineConfig({
  resolve: {
    alias: [
      ...SOURCE_PACKAGES.map((name) => ({
        find: `@sdlc/${name}`,
        replacement: path.resolve(import.meta.dirname, `platform/packages/${name}/src/index.ts`),
      })),
      {
        find: '@sdlc/eval',
        replacement: path.resolve(import.meta.dirname, 'platform/eval/src/index.ts'),
      },
      {
        find: '@sdlc/docker-authz',
        replacement: path.resolve(import.meta.dirname, 'platform/deploy/docker-authz/src/index.ts'),
      },
      ...SOURCE_ADAPTERS.map((name) => ({
        find: `@sdlc/adapter-${name}`,
        replacement: path.resolve(
          import.meta.dirname,
          `platform/packages/adapters/${name}/src/index.ts`,
        ),
      })),
      // The shared deployment steps (D-08 V16): `trial:up` and `server:setup` import their built
      // files (`../../steps/dist/x.js`, the layout at run time); tests read the sources.
      // `pnpm alerts` (O03) imports doctor's built files the same way.
      {
        find: /^(?:\.\.\/)+(?:deploy\/)?doctor\/dist\/(.+)\.js$/,
        replacement: path.resolve(import.meta.dirname, 'platform/deploy/doctor/src/$1.ts'),
      },
      {
        find: /^(?:\.\.\/)+(?:deploy\/)?steps\/dist\/(.+)\.js$/,
        replacement: path.resolve(import.meta.dirname, 'platform/deploy/steps/src/$1.ts'),
      },
    ],
  },
  test: {
    include: ['platform/**/*.test.ts'],
    // Integration tests need running infrastructure: `pnpm test:integration`.
    exclude: ['**/node_modules/**', '**/dist/**', 'platform/tests/integration/**'],
  },
});
