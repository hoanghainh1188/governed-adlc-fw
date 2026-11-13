// The sandbox runtime check at start (task H06, ADR-M25 §2.12). With `SDLC_RUNNER_SANDBOX_RUNTIME`
// set, the runner starts only when the Engine lists that runtime and is not rootless: gVisor and
// Kata need a rootful Engine for the run's own network (QUESTIONS #701). Without the setting, the
// runner does not ask the Engine anything more.
import { RunnerError } from '../errors.js';
import type { SandboxRuntime } from '../settings.js';
import type { EngineInfo } from './client.js';

export interface EngineInfoReader {
  engineInfo(): Promise<EngineInfo>;
}

/** Throws unless the Engine can run the configured sandbox runtime. No-op without one. */
export async function assertEngineRuntime(
  docker: EngineInfoReader,
  runtime: SandboxRuntime | undefined,
): Promise<void> {
  if (runtime === undefined) return;
  const info = await docker.engineInfo();
  if (!info.runtimes.includes(runtime)) {
    throw new RunnerError('runner.docker.runtime_missing', { runtime });
  }
  if (info.rootless) throw new RunnerError('runner.docker.runtime_rootless', { runtime });
}
