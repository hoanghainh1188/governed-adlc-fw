// Preflight guardrails for `pnpm demo:up` (D-08 V23, issue #561). Pure.
// Strictly refuses NODE_ENV=production and any existing non-demo `sdlc_*` volumes.

const GIB = 1024 ** 3;
/** Minimum Docker memory for Lite Mode (`core` + `platform`, no observability/models/sandbox). */
export const MIN_DEMO_DOCKER_MEMORY_GIB = 4;
const MIN_COMPOSE: readonly [number, number] = [2, 24];
const OPENSSL_3 = /^OpenSSL [3-9]/;

export interface DemoHostFacts {
  readonly nodeEnv: string | undefined;
  readonly envFile: string;
  readonly envFileExists: boolean;
  /** Existing non-demo `sdlc_*` volumes; `null` if Docker could not list volumes. */
  readonly nonDemoVolumes: readonly string[] | null;
  /** Existing `sdlc-demo_*` volumes; `null` if Docker could not list volumes. */
  readonly demoVolumes: readonly string[] | null;
  /** `null` when Docker daemon is unreachable. */
  readonly docker: { readonly composeVersion: string | null; readonly memoryBytes: number } | null;
  /** `openssl version` output, or `null` if unavailable. */
  readonly opensslVersion: string | null;
}

export type DemoRefusalCode =
  | 'production_env'
  | 'env_exists'
  | 'volumes_unknown'
  | 'non_demo_volumes_exist'
  | 'demo_volumes_exist'
  | 'no_docker'
  | 'compose_old'
  | 'docker_memory'
  | 'openssl_old';

export interface DemoRefusal {
  readonly code: DemoRefusalCode;
  readonly message: string;
}

function composeTooOld(version: string): boolean {
  const m = /(\d+)\.(\d+)/.exec(version);
  if (!m) return true;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  return major < MIN_COMPOSE[0] || (major === MIN_COMPOSE[0] && minor < MIN_COMPOSE[1]);
}

/** Returns every guardrail refusal before `demo:up` touches anything. Empty means safe to proceed. */
export function demoPreflight(facts: DemoHostFacts): DemoRefusal[] {
  const out: DemoRefusal[] = [];

  if (facts.nodeEnv === 'production') {
    out.push({
      code: 'production_env',
      message: 'Refused: pnpm demo:up never runs when NODE_ENV=production.',
    });
  }
  if (facts.envFileExists) {
    out.push({
      code: 'env_exists',
      message: `Refused: demo env file already exists at ${facts.envFile}. Run \`pnpm demo:down --wipe\` first.`,
    });
  }
  if (facts.nonDemoVolumes === null || facts.demoVolumes === null) {
    if (facts.docker !== null) {
      out.push({
        code: 'volumes_unknown',
        message:
          'Refused: could not list Docker volumes to verify no production sdlc_* volumes exist.',
      });
    }
  } else {
    if (facts.nonDemoVolumes.length > 0) {
      out.push({
        code: 'non_demo_volumes_exist',
        message: `Refused: found ${facts.nonDemoVolumes.length} non-demo sdlc_* volume(s) (e.g. ${facts.nonDemoVolumes[0]}). Demo mode never runs alongside an existing sdlc_* stack.`,
      });
    }
    if (facts.demoVolumes.length > 0) {
      out.push({
        code: 'demo_volumes_exist',
        message: `Refused: found ${facts.demoVolumes.length} existing demo volume(s) (e.g. ${facts.demoVolumes[0]}). Run \`pnpm demo:down --wipe\` first.`,
      });
    }
  }

  if (facts.docker === null) {
    out.push({
      code: 'no_docker',
      message: 'Refused: Docker daemon is not running or not reachable.',
    });
  } else {
    if (facts.docker.composeVersion === null || composeTooOld(facts.docker.composeVersion)) {
      out.push({
        code: 'compose_old',
        message: `Refused: docker compose >= 2.24 is required (found: ${facts.docker.composeVersion ?? 'none'}).`,
      });
    }
    if (facts.docker.memoryBytes < MIN_DEMO_DOCKER_MEMORY_GIB * GIB) {
      const have = Math.floor(facts.docker.memoryBytes / GIB);
      out.push({
        code: 'docker_memory',
        message: `Refused: Docker has ${have} GiB memory; Lite Mode demo needs at least ${MIN_DEMO_DOCKER_MEMORY_GIB} GiB.`,
      });
    }
  }

  if (facts.opensslVersion === null || !OPENSSL_3.test(facts.opensslVersion)) {
    out.push({
      code: 'openssl_old',
      message: `Refused: OpenSSL 3+ is required on PATH (found: ${facts.opensslVersion ?? 'none'}).`,
    });
  }

  return out;
}
