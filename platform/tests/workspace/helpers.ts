import fs from 'node:fs';
import path from 'node:path';

/** Walks up from the current directory to the folder that holds pnpm-workspace.yaml. */
export function repoRoot(): string {
  let dir = process.cwd();
  while (!fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('pnpm-workspace.yaml not found above ' + process.cwd());
    dir = parent;
  }
  return dir;
}

export interface WorkspacePackage {
  dir: string;
  name: string;
}

/** The packages required by design/D-03 section 11 (D-08 A01 AC2), plus `messages` (ADR-M18), `secrets` (A04,
 * ADR-M21), `workflow-client` (B07, ADR-M30), `telemetry` (A08, ADR-M35), and `api-schemas` and the
 * `dashboard` app (U01, ADR-M54). */
export const EXPECTED_PACKAGES: readonly WorkspacePackage[] = [
  { dir: 'platform/apps/api', name: '@sdlc/api' },
  { dir: 'platform/apps/worker', name: '@sdlc/worker' },
  { dir: 'platform/apps/runner', name: '@sdlc/runner' },
  { dir: 'platform/apps/tool-project-docs', name: '@sdlc/tool-project-docs' },
  { dir: 'platform/apps/cli', name: '@sdlc/cli' },
  { dir: 'platform/apps/dashboard', name: '@sdlc/dashboard' },
  { dir: 'platform/eval', name: '@sdlc/eval' },
  { dir: 'platform/packages/core', name: '@sdlc/core' },
  { dir: 'platform/packages/contracts', name: '@sdlc/contracts' },
  { dir: 'platform/packages/config', name: '@sdlc/config' },
  { dir: 'platform/packages/messages', name: '@sdlc/messages' },
  { dir: 'platform/packages/api-schemas', name: '@sdlc/api-schemas' },
  { dir: 'platform/packages/secrets', name: '@sdlc/secrets' },
  { dir: 'platform/packages/workflow-client', name: '@sdlc/workflow-client' },
  { dir: 'platform/packages/telemetry', name: '@sdlc/telemetry' },
  { dir: 'platform/packages/agent-kit', name: '@sdlc/agent-kit' },
  { dir: 'platform/packages/adapters/git-github', name: '@sdlc/adapter-git-github' },
  { dir: 'platform/packages/adapters/agent-openhands', name: '@sdlc/adapter-agent-openhands' },
  { dir: 'platform/packages/adapters/agent-opencode', name: '@sdlc/adapter-agent-opencode' },
  { dir: 'platform/packages/adapters/model-litellm', name: '@sdlc/adapter-model-litellm' },
  { dir: 'platform/packages/adapters/evidence-s3', name: '@sdlc/adapter-evidence-s3' },
  {
    dir: 'platform/packages/adapters/knowledge-pgvector',
    name: '@sdlc/adapter-knowledge-pgvector',
  },
  { dir: 'platform/packages/adapters/traces-langfuse', name: '@sdlc/adapter-traces-langfuse' },
  { dir: 'platform/packages/adapters/policy-simple', name: '@sdlc/adapter-policy-simple' },
  { dir: 'platform/deploy/docker-authz', name: '@sdlc/docker-authz' },
];

export interface PackageManifest {
  name: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

export function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}
