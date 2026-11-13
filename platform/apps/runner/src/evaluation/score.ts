// Scoring an evaluation run on the server (task L04, design/ADR-M81 §2.5, QUESTIONS #463). The
// runner scores a run with the project's sandbox image, in the same three steps as a developer
// machine (`LocalExecutor` in `@sdlc/eval`), so both places score the same way:
//
// 1. a clean install from the base lockfile, through the package proxy (container `install`, on
//    the run's internal network with the proxy attached);
// 2. the proxy is detached and the network removed;
// 3. the agent's diff and the hidden tests are applied and run with **no network at all**
//    (container `score`, `NetworkMode: none`), in the same workspace volume.
//
// The Docker client has no exec (ADR-M25 §2.5), so each step is a container with a fixed command
// over one volume. Every spec passes the scoring guard (docker/guard.ts). The result is the
// script's last line on standard output; the commands of the task write nothing there. Nothing of
// the repository, the diff or the hidden tests is logged or put in an error.
//
// The objects use the run's own names (`sdlc-sandbox-…`, `sdlc-run-…`, `sdlc-ws-…`) and labels, so
// the sweep, the clean-up at start and the teardown remove them like a sandbox's. The agent's
// sandbox must be gone first: scoring starts from a clean volume made of the pinned commit's tree.
import {
  installScript,
  parseScoreOutput,
  scoringScript,
  SCORING_DIRS,
  type EvalTask,
  type Score,
} from '@sdlc/eval';

import type { DockerClient } from '../docker/client.js';
import { assertSafeNetworkConnect } from '../docker/guard.js';
import { RunnerError } from '../errors.js';
import { runLabels, runNames } from '../names.js';
import { runNetworkHosts } from '../sandbox/hosts.js';
import { ensureImage, teardownSandbox } from '../sandbox/lifecycle.js';
import { planEgress, runNetworkSpec } from '../sandbox/network.js';
import { buildScoringSpec } from '../sandbox/scoring-spec.js';
import type { RunnerSettings } from '../settings.js';
import { directoryEntries, packTar, type TarEntry } from '../workspace/tar.js';

/** Why scoring did not produce a result. Codes only (the run gets no result and can be repeated). */
export type ScoringFailure =
  | 'no_package_proxy'
  | 'image_unavailable'
  | 'install_failed'
  | 'install_timeout'
  | 'workspace_invalid'
  | 'docker_error';

export class ScoringError extends RunnerError {
  constructor(readonly reason: ScoringFailure) {
    super('runner.scoring_failed', { reason });
  }
}

export interface ScoreEvaluationDeps {
  readonly docker: DockerClient;
  readonly settings: RunnerSettings;
  /** Default 20 minutes each; tests shorten them. */
  readonly installTimeoutMs?: number;
  readonly scoreTimeoutMs?: number;
}

export interface ScoreEvaluationInput {
  /** The evaluation run's ID: the Docker objects are named from it. */
  readonly runId: string;
  readonly tenantId: string;
  /** The project's sandbox image, pinned by digest. */
  readonly image: string;
  /** The pinned commit's tree as files (no `.git`); the install script makes the repository. */
  readonly treeDir: string;
  /** The task's hidden tests (`<task>/hidden`). */
  readonly hiddenDir: string;
  /** The base of the run as a patch on the pinned commit. */
  readonly basePatch: string;
  /** The agent's change, recomputed outside the sandbox; empty when it made none. */
  readonly agentPatch: string;
  readonly task: Pick<EvalTask, 'ci' | 'passToPass' | 'failToPass'>;
}

const DEFAULT_TIMEOUT_MS = 20 * 60_000;
const NOT_APPLIED: Score = {
  applied: false,
  ci: false,
  passToPass: false,
  failToPass: false,
  lintFindings: 0,
};

function file(path: string, text: string): TarEntry {
  return { type: 'file', path, content: Buffer.from(text, 'utf8') };
}

/** The workspace volume's content: the tree, the scripts, the patches and the hidden tests. */
function workspaceEntries(input: ScoreEvaluationInput, settings: RunnerSettings): TarEntry[] {
  const max = settings.workspaceMaxBytes;
  return [
    { type: 'dir', path: 'work' },
    ...directoryEntries(input.treeDir, max, 'work'),
    { type: 'dir', path: 'in' },
    file('in/base.patch', input.basePatch),
    file('in/agent.patch', input.agentPatch),
    file('in/install.sh', installScript()),
    file('in/score.sh', scoringScript(input.task)),
    { type: 'dir', path: 'in/hidden' },
    ...directoryEntries(input.hiddenDir, max, 'in/hidden'),
    { type: 'dir', path: 'out' },
  ];
}

/**
 * Scores one run. Returns the score (all false when the change did not apply, the run timed out or
 * left no result), or throws `ScoringError` when the packages could not be installed or Docker
 * failed: that is not the agent's fault, so the run gets no result and can be repeated.
 */
export async function scoreEvaluationRun(
  deps: ScoreEvaluationDeps,
  input: ScoreEvaluationInput,
): Promise<Score> {
  const { docker, settings } = deps;
  const names = runNames(input.runId);
  const labels = runLabels(settings.instance, input.runId, input.tenantId);
  if (!settings.npmRegistry) throw new ScoringError('no_package_proxy');
  const registry = new URL(settings.npmRegistry);
  const egress = planEgress(
    [`${registry.hostname}:${registry.port === '' ? '80' : registry.port}`],
    settings.egressServices,
  );
  if (!egress.ok) throw new ScoringError('no_package_proxy');

  let tar: Buffer;
  try {
    tar = packTar(workspaceEntries(input, settings));
  } catch {
    throw new ScoringError('workspace_invalid');
  }
  try {
    // Nothing of an earlier attempt may be left: scoring starts from a clean volume.
    await teardownSandbox(docker, input.runId);
    try {
      await ensureImage(docker, input.image);
    } catch {
      throw new ScoringError('image_unavailable');
    }

    // Step 1: install, on the run's internal network with the package proxy attached.
    await docker.volumeCreate(names.volume, labels);
    await docker.networkCreate(runNetworkSpec(names, labels));
    const attachable = settings.egressServices.map((s) => s.container);
    for (const service of egress.services) {
      assertSafeNetworkConnect(names.network, service.container, attachable);
      await docker.networkConnect(names.network, service.container, [service.alias]);
    }
    // H06: gVisor has no Docker DNS; the package proxy's name goes into /etc/hosts.
    const hosts = settings.sandboxRuntime ? await runNetworkHosts(docker, names.network) : [];
    const installId = await docker.scoringContainerCreate(
      names.container,
      buildScoringSpec({ names, labels, image: input.image, phase: 'install', hosts }, settings),
      'install',
    );
    await docker.putArchive(installId, '/workspace', tar);
    await docker.containerStart(installId);
    let code: number;
    try {
      code = await docker.containerWait(installId, deps.installTimeoutMs ?? DEFAULT_TIMEOUT_MS);
    } catch {
      await docker.containerKill(names.container).catch(() => undefined);
      throw new ScoringError('install_timeout');
    }
    if (code !== 0) throw new ScoringError('install_failed');
    await docker.containerRemove(installId);

    // Step 2: the proxy leaves and the network goes: nothing else can be reached from now on.
    for (const service of egress.services) {
      await docker.networkDisconnect(names.network, service.container);
    }
    await docker.networkRemove(names.network);

    // Step 3: the agent's diff and the hidden tests, with no network at all.
    const scoreId = await docker.scoringContainerCreate(
      names.container,
      buildScoringSpec({ names, labels, image: input.image, phase: 'score' }, settings),
      'score',
    );
    await docker.containerStart(scoreId);
    try {
      await docker.containerWait(scoreId, deps.scoreTimeoutMs ?? DEFAULT_TIMEOUT_MS);
    } catch {
      // A timeout leaves no result: "not resolved", like a failed container.
      await docker.containerKill(names.container).catch(() => undefined);
      return NOT_APPLIED;
    }
    try {
      return parseScoreOutput(await docker.containerLogs(scoreId));
    } catch {
      return NOT_APPLIED;
    }
  } catch (error) {
    if (error instanceof ScoringError) throw error;
    throw new ScoringError('docker_error');
  } finally {
    await teardownSandbox(docker, input.runId).catch(() => undefined);
  }
}

/** Where the scripts expect the repository, for tests that lay out a tree by hand. */
export const SCORING_WORK_DIR = SCORING_DIRS.work;
