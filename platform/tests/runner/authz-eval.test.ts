// H07 AC1 / AC2 (ADR-M105): the shared AuthZ denylist refuses host-escape create bodies, allows a
// minimal safe sandbox create, and agrees with docker/guard.ts on the fixture matrix.
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  assertSafeContainerSpec,
  assertSafeNetworkSpec,
  AUTHZ_RULES,
  AUTHZ_RULES_PATH,
  buildSandboxSpec,
  evaluateAuthz,
  runLabels,
  runNames,
  runNetworkSpec,
  type ContainerSpec,
} from '../../apps/runner/src/index.js';
import { IMAGE, RUN_ID, settings, TENANT_ID } from './helpers.js';

const names = runNames(RUN_ID);
const labels = runLabels('sdlc', RUN_ID, TENANT_ID);
const KEY = 'k'.repeat(43);

const safeSpec = (): ContainerSpec =>
  buildSandboxSpec(
    { names, labels, image: IMAGE, sessionApiKey: KEY, agentSecretKey: KEY },
    settings(),
  );

const safeNetwork = () => runNetworkSpec(names, labels);

describe('evaluateAuthz denylist (H07 AC1)', () => {
  it('allows a minimal safe sandbox create and an internal run network', () => {
    expect(evaluateAuthz('POST', '/v1.44/containers/create', safeSpec()).allow).toBe(true);
    expect(evaluateAuthz('POST', '/containers/create?name=x', safeSpec()).allow).toBe(true);
    expect(evaluateAuthz('POST', '/v1.44/networks/create', safeNetwork()).allow).toBe(true);
  });

  it('allows non-create methods and paths the runner needs', () => {
    expect(evaluateAuthz('GET', '/containers/json', null).allow).toBe(true);
    expect(evaluateAuthz('POST', '/containers/abc/start', { Privileged: true }).allow).toBe(true);
    expect(evaluateAuthz('POST', '/images/create', null).allow).toBe(true);
  });

  it('refuses privileged, host namespaces, CapAdd, devices, binds and host network', () => {
    const cases: { body: unknown; reason: string }[] = [
      { body: { HostConfig: { Privileged: true } }, reason: 'privileged' },
      { body: { HostConfig: { PidMode: 'host' } }, reason: 'host_namespace_pidmode' },
      { body: { HostConfig: { IpcMode: 'host' } }, reason: 'host_namespace_ipcmode' },
      { body: { HostConfig: { UTSMode: 'host' } }, reason: 'host_namespace_utsmode' },
      { body: { HostConfig: { NetworkMode: 'host' } }, reason: 'network_mode_host' },
      { body: { HostConfig: { CapAdd: ['SYS_ADMIN'] } }, reason: 'cap_add' },
      {
        body: { HostConfig: { Devices: [{ PathOnHost: '/dev/null' }] } },
        reason: 'devices',
      },
      { body: { HostConfig: { Binds: ['/:/host'] } }, reason: 'binds' },
      {
        body: { HostConfig: { Mounts: [{ Type: 'bind', Source: '/', Target: '/host' }] } },
        reason: 'bind_mount',
      },
      {
        body: { HostConfig: { SecurityOpt: ['seccomp:unconfined'] } },
        reason: 'security_opt',
      },
      { body: { HostConfig: { PublishAllPorts: true } }, reason: 'publish_all_ports' },
      {
        body: { HostConfig: { PortBindings: { '80/tcp': [{ HostPort: '8080' }] } } },
        reason: 'port_bindings',
      },
    ];
    for (const { body, reason } of cases) {
      const decision = evaluateAuthz('POST', '/v1.44/containers/create', body);
      expect(decision, reason).toEqual({ allow: false, reason });
    }
  });

  it('allows named volumes in Binds, as Docker Compose sends them (QUESTIONS #661)', () => {
    const body = {
      HostConfig: { Binds: ['sdlc_runner-approle:/run/sdlc/approle:rw', 'work.1:/w'] },
    };
    expect(evaluateAuthz('POST', '/v1.51/containers/create', body)).toEqual({ allow: true });
  });

  it('refuses a Binds entry that is not a named volume, even next to one', () => {
    const entries: unknown[] = [
      '/var/run/docker.sock:/var/run/docker.sock:ro',
      './config.yaml:/c',
      '~/x:/x',
      ':/x',
      'noseparator',
      '-v:/x',
      42,
    ];
    for (const entry of entries) {
      const body = { HostConfig: { Binds: ['ok:/ok', entry] } };
      expect(evaluateAuthz('POST', '/containers/create', body), String(entry)).toEqual({
        allow: false,
        reason: 'binds',
      });
    }
  });

  it('refuses a non-internal network create and a host driver', () => {
    expect(
      evaluateAuthz('POST', '/networks/create', {
        Name: 'x',
        Driver: 'bridge',
        Internal: false,
      }),
    ).toEqual({ allow: false, reason: 'network_not_internal' });
    expect(
      evaluateAuthz('POST', '/networks/create', { Name: 'x', Driver: 'host', Internal: true }),
    ).toEqual({ allow: false, reason: 'network_driver' });
  });

  it('loads one shared rules file (AC2 source)', () => {
    expect(AUTHZ_RULES.version).toBe(1);
    expect(fs.existsSync(AUTHZ_RULES_PATH)).toBe(true);
    expect(path.basename(AUTHZ_RULES_PATH)).toBe('authz-rules.json');
    const onDisk = JSON.parse(fs.readFileSync(AUTHZ_RULES_PATH, 'utf8')) as typeof AUTHZ_RULES;
    expect(onDisk).toEqual(AUTHZ_RULES);
  });
});

describe('guard and evaluateAuthz parity (H07 AC2)', () => {
  const matrix: { name: string; body: unknown; path: '/containers/create' | '/networks/create' }[] =
    [
      {
        name: 'privileged',
        path: '/containers/create',
        body: { HostConfig: { Privileged: true } },
      },
      {
        name: 'host pid',
        path: '/containers/create',
        body: { HostConfig: { PidMode: 'host' } },
      },
      {
        name: 'cap add',
        path: '/containers/create',
        body: { HostConfig: { CapAdd: ['NET_ADMIN'] } },
      },
      {
        name: 'binds',
        path: '/containers/create',
        body: { HostConfig: { Binds: ['/var/run/docker.sock:/sock'] } },
      },
      {
        name: 'bind mount',
        path: '/containers/create',
        body: {
          HostConfig: { Mounts: [{ Type: 'bind', Source: '/etc', Target: '/etc' }] },
        },
      },
      {
        name: 'host network mode',
        path: '/containers/create',
        body: { HostConfig: { NetworkMode: 'host' } },
      },
      {
        name: 'non-internal network',
        path: '/networks/create',
        body: { Name: 'evil', Driver: 'bridge', Internal: false },
      },
    ];

  it.each(matrix)('$name: eval denies and guard refuses', ({ body, path: apiPath }) => {
    const decision = evaluateAuthz('POST', apiPath, body);
    expect(decision.allow).toBe(false);

    if (apiPath === '/containers/create') {
      // Guard allowlist also refuses incomplete specs; merge dangerous fields onto a valid base so
      // the refusal is specifically the AuthZ denylist when the allowlist would otherwise pass keys.
      const raw = structuredClone(safeSpec()) as unknown as Record<string, unknown>;
      const host = { ...(raw.HostConfig as Record<string, unknown>) };
      const incoming = (body as { HostConfig?: Record<string, unknown> }).HostConfig ?? {};
      Object.assign(host, incoming);
      // Unknown host keys (Privileged, CapAdd, …) are refused by the allowlist first; AuthZ is
      // still denied. Assert both refuse.
      raw.HostConfig = host;
      expect(() =>
        assertSafeContainerSpec(names.container, raw as unknown as ContainerSpec),
      ).toThrow(/fails the safety check/);
    } else {
      expect(() =>
        assertSafeNetworkSpec(body as Parameters<typeof assertSafeNetworkSpec>[0]),
      ).toThrow(/fails the safety check/);
    }
  });

  it('a safe sandbox passes both', () => {
    expect(evaluateAuthz('POST', '/containers/create', safeSpec()).allow).toBe(true);
    expect(() => assertSafeContainerSpec(names.container, safeSpec())).not.toThrow();
    expect(evaluateAuthz('POST', '/networks/create', safeNetwork()).allow).toBe(true);
    expect(() => assertSafeNetworkSpec(safeNetwork())).not.toThrow();
  });
});
