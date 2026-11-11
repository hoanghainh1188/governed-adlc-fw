// D-08 O01 (design/ADR-M91): `pnpm doctor` warns when the runner shares the platform's Docker
// Engine, fails when it runs there although the link address is set (two runners with one instance
// label, R062), and checks that the link services listen on the link address or 127.0.0.1 only.
import { describe, expect, it } from 'vitest';

import { evaluate } from '../../deploy/doctor/src/checks/index.js';
import type { CheckResult, OperatorFacts } from '../../deploy/doctor/src/types.js';
import { healthyFacts, LINK, RUNNING, service } from './fixtures';

const runnerLines = (f: OperatorFacts): CheckResult[] =>
  evaluate(f).filter((r) => r.id === 'runner.engine');
const withoutLink = (): OperatorFacts => {
  const base = healthyFacts();
  const values = { ...base.envFile.facts!.values };
  delete values['SDLC_RUNNER_LINK_ADDR'];
  return { ...base, envFile: { ...base.envFile, facts: { ...base.envFile.facts!, values } } };
};

describe('pnpm doctor: runner.engine (O01)', () => {
  it('ok: the runner has its own Engine and the link ports listen on the link address', () => {
    const [line] = runnerLines(healthyFacts());
    expect(line).toMatchObject({ status: 'ok', text: { key: 'doctor.runner.own_engine' } });
    expect(line?.text.params).toEqual({ link: LINK });
  });

  it('warning: the runner and its socket proxy run on the platform Engine (developer machine)', () => {
    for (const name of ['sdlc-runner', 'docker-socket-proxy']) {
      const f = { ...withoutLink(), services: [...RUNNING, service(name)] };
      const lines = runnerLines(f);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        status: 'warning',
        text: { key: 'doctor.runner.shared_engine' },
        fix: {
          key: 'doctor.fix.readme',
          params: { section: 'The runner on its own Docker Engine' },
        },
      });
    }
  });

  it('failed: the link address is set and a runner still runs here (R062)', () => {
    const f = healthyFacts({ services: [...RUNNING, service('sdlc-runner')] });
    expect(runnerLines(f)[0]).toMatchObject({
      status: 'failed',
      text: { key: 'doctor.runner.two_runners' },
    });
  });

  it('failed: a link service is published on another address', () => {
    const exposed = service('temporal', { published: [{ address: '0.0.0.0', port: 7233 }] });
    const f = healthyFacts({
      services: [...RUNNING.filter((s) => s.service !== 'temporal'), exposed],
    });
    const lines = runnerLines(f);
    expect(lines).toEqual([
      expect.objectContaining({
        status: 'failed',
        subject: 'temporal',
        text: {
          key: 'doctor.runner.link_exposed',
          params: { address: '0.0.0.0', port: 7233, link: LINK },
        },
      }),
    ]);
  });

  it('access.ports accepts a link port on the link address only, for the link services only', () => {
    const ports = (f: OperatorFacts) => evaluate(f).filter((r) => r.id === 'access.ports');
    expect(ports(healthyFacts()).map((r) => r.status)).toEqual(['ok']);
    const other = service('sdlc-api', { published: [{ address: LINK, port: 8090 }] });
    expect(ports(healthyFacts({ services: [...RUNNING, other] }))).toEqual([
      expect.objectContaining({ status: 'failed', subject: 'sdlc-api' }),
    ]);
    const noLink = { ...withoutLink(), services: RUNNING };
    expect(ports(noLink).some((r) => r.status === 'failed')).toBe(true);
  });

  it('skipped: no runner here and no link address; a trial stack; no Docker', () => {
    const skip = (f: OperatorFacts) => runnerLines(f)[0]?.text.key;
    expect(skip({ ...withoutLink(), services: RUNNING })).toBe('doctor.skipped.no_runner');
    const trial = healthyFacts();
    expect(
      skip({
        ...trial,
        services: [...RUNNING, service('sdlc-runner')],
        envFile: { ...trial.envFile, trialKeyFile: { path: '/x/keys.age', mode: 0o100600 } },
      }),
    ).toBe('doctor.skipped.trial');
    expect(skip(healthyFacts({ docker: null }))).toBe('doctor.skipped.no_docker');
  });
});

const authzLines = (f: OperatorFacts): CheckResult[] =>
  evaluate(f).filter((r) => r.id === 'runner.authz');

describe('pnpm doctor: runner.authz (H07)', () => {
  it('ok when the Engine lists an authorization plugin', () => {
    const [line] = authzLines(healthyFacts());
    expect(line).toMatchObject({
      status: 'ok',
      text: { key: 'doctor.runner.authz_ok', params: { plugins: 'sdlc-authz' } },
    });
  });

  it('warning when no authorization plugin is installed', () => {
    const base = healthyFacts();
    const f = {
      ...base,
      docker: { ...base.docker!, authorizationPlugins: [] },
    };
    expect(authzLines(f)[0]).toMatchObject({
      status: 'warning',
      text: { key: 'doctor.runner.authz_missing' },
    });
  });

  it('skipped on a trial stack', () => {
    const base = healthyFacts();
    const f = {
      ...base,
      envFile: {
        ...base.envFile,
        trialKeyFile: { path: '/tmp/trial.key', mode: 0o600 },
      },
    };
    expect(authzLines(f)[0]?.text.key).toBe('doctor.skipped.trial');
  });
});
