// The runner's Docker Engine (D-08 O01, design/ADR-M91). On a server the runner and its sandboxes
// run on their own Engine; the platform's Engine publishes their services on the link address
// only (overlay docker-compose.runner-link.yml). Pure: decides from the services and the env file.
import type { CheckResult, OperatorFacts, ServiceState } from '../types.js';
import { ok, problem, skipped, text } from './result.js';

/** The services the overlay publishes on SDLC_RUNNER_LINK_ADDR (static test against the file). */
export const LINK_SERVICES = [
  'knowledge-db',
  'litellm',
  'openbao',
  'postgres',
  'registry',
  'seaweedfs',
  'temporal',
] as const;
/** The services that must never run on the platform's Engine when the runner has its own. */
export const RUNNER_SERVICES = ['docker-socket-proxy', 'sdlc-runner'] as const;

const SECTION = 'The runner on its own Docker Engine';
const fix = () => text('doctor.fix.readme', { section: SECTION });

/** SDLC_RUNNER_LINK_ADDR of the env file, or null when it is not set. */
export function linkAddress(f: OperatorFacts): string | null {
  return f.envFile.facts?.values['SDLC_RUNNER_LINK_ADDR'] ?? null;
}

const runsHere = (services: readonly ServiceState[]) =>
  services.some(
    (s) => (RUNNER_SERVICES as readonly string[]).includes(s.service) && s.state === 'running',
  );

export function runnerChecks(f: OperatorFacts): CheckResult[] {
  if (!f.docker) return [skipped('runner.engine', 'doctor.skipped.no_docker')];
  if (!f.envFile.exists) return [skipped('runner.engine', 'doctor.skipped.no_env')];
  // A trial runs on a developer machine and shares its Engine on purpose (TRIAL.md).
  if (f.envFile.trialKeyFile) return [skipped('runner.engine', 'doctor.skipped.trial')];
  if (!f.services) return [skipped('runner.engine', 'doctor.skipped.stopped')];
  const link = linkAddress(f);
  if (runsHere(f.services)) {
    return link === null
      ? [problem('runner.engine', 'warning', text('doctor.runner.shared_engine'), fix())]
      : [problem('runner.engine', 'failed', text('doctor.runner.two_runners'), fix())];
  }
  if (link === null) return [skipped('runner.engine', 'doctor.skipped.no_runner')];
  const out: CheckResult[] = [];
  for (const s of f.services) {
    if (!(LINK_SERVICES as readonly string[]).includes(s.service)) continue;
    for (const p of s.published ?? []) {
      if (p.address !== link && p.address !== '127.0.0.1') {
        out.push(
          problem(
            'runner.engine',
            'failed',
            text('doctor.runner.link_exposed', { address: p.address, port: p.port, link }),
            fix(),
            s.service,
          ),
        );
      }
    }
  }
  if (out.length === 0) out.push(ok('runner.engine', text('doctor.runner.own_engine', { link })));
  return out;
}

const AUTHZ_SECTION = 'The runner on its own Docker Engine';
const authzFix = () => text('doctor.fix.readme', { section: AUTHZ_SECTION });

/**
 * H07 (ADR-M105): warn when the Engine has no authorization plugin. Non-blocking on developer
 * machines; required on the company server's runner Engine (install via T11).
 */
export function runnerAuthzChecks(f: OperatorFacts): CheckResult[] {
  if (!f.docker) return [skipped('runner.authz', 'doctor.skipped.no_docker')];
  if (!f.envFile.exists) return [skipped('runner.authz', 'doctor.skipped.no_env')];
  if (f.envFile.trialKeyFile) return [skipped('runner.authz', 'doctor.skipped.trial')];
  const plugins = f.docker.authorizationPlugins;
  if (plugins === null) {
    return [problem('runner.authz', 'warning', text('doctor.runner.authz_unknown'), authzFix())];
  }
  if (plugins.length === 0) {
    return [problem('runner.authz', 'warning', text('doctor.runner.authz_missing'), authzFix())];
  }
  return [ok('runner.authz', text('doctor.runner.authz_ok', { plugins: plugins.join(', ') }))];
}
