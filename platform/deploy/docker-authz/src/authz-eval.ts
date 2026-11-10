// Shared Docker AuthZ denylist for containers/create and networks/create (task H07, ADR-M105).
// The guard and the AuthZ plugin both call evaluateAuthz so a bypass of the runner still hits the
// Engine. Allowlist hardening stays in docker/guard.ts; this file only refuses host-escape options.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import rulesJson from './authz-rules.json' with { type: 'json' };

export interface AuthzDecision {
  readonly allow: boolean;
  /** Stable reason code when denied; never free text from the request. */
  readonly reason?: string;
}

export interface AuthzRules {
  readonly version: number;
  readonly containerCreate: {
    readonly refusePrivileged: boolean;
    readonly refuseHostNamespaces: readonly string[];
    readonly refuseHostNetworkMode: boolean;
    readonly refuseCapAdd: boolean;
    readonly refuseDevices: boolean;
    readonly refuseDeviceCgroupRules: boolean;
    readonly refuseBinds: boolean;
    readonly refuseBindMounts: boolean;
    readonly refusePublishAllPorts: boolean;
    readonly refusePortBindings: boolean;
    readonly refuseSecurityOptSubstrings: readonly string[];
  };
  readonly networkCreate: {
    readonly requireInternal: boolean;
    readonly refuseDrivers: readonly string[];
  };
}

/** The denylist file both callers must use (AC2). */
export const AUTHZ_RULES: AuthzRules = rulesJson as AuthzRules;

/** Absolute path of the shared rules file next to this module (parity tests). */
export const AUTHZ_RULES_PATH = join(dirname(fileURLToPath(import.meta.url)), 'authz-rules.json');

const CREATE_CONTAINER = /\/containers\/create(?:\?|$)/;
const CREATE_NETWORK = /\/networks\/create(?:\?|$)/;

function pathOnly(uri: string): string {
  const q = uri.indexOf('?');
  return q === -1 ? uri : uri.slice(0, q);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function deny(reason: string): AuthzDecision {
  return { allow: false, reason };
}

function checkContainerCreate(body: unknown): AuthzDecision {
  const cfg = AUTHZ_RULES.containerCreate;
  const top = asRecord(body) ?? {};
  const host = asRecord(top.HostConfig) ?? {};

  if (cfg.refusePrivileged && host.Privileged === true) return deny('privileged');

  if (cfg.refuseHostNetworkMode && host.NetworkMode === 'host') return deny('network_mode_host');

  for (const key of cfg.refuseHostNamespaces) {
    if (key === 'NetworkMode') continue;
    const value = host[key];
    if (typeof value === 'string' && value === 'host') {
      return deny(`host_namespace_${key.toLowerCase()}`);
    }
  }

  if (cfg.refuseCapAdd) {
    const capAdd = host.CapAdd;
    if (Array.isArray(capAdd) && capAdd.length > 0) return deny('cap_add');
  }

  if (cfg.refuseDevices) {
    const devices = host.Devices;
    if (Array.isArray(devices) && devices.length > 0) return deny('devices');
  }

  if (cfg.refuseDeviceCgroupRules) {
    const rulesList = host.DeviceCgroupRules;
    if (Array.isArray(rulesList) && rulesList.length > 0) return deny('device_cgroup_rules');
  }

  if (cfg.refuseBinds) {
    const binds = host.Binds;
    if (Array.isArray(binds) && binds.length > 0) return deny('binds');
  }

  if (cfg.refuseBindMounts) {
    const mounts = host.Mounts;
    if (Array.isArray(mounts)) {
      for (const mount of mounts) {
        const m = asRecord(mount);
        if (m?.Type === 'bind') return deny('bind_mount');
      }
    }
  }

  if (cfg.refusePublishAllPorts && host.PublishAllPorts === true) {
    return deny('publish_all_ports');
  }

  if (cfg.refusePortBindings) {
    const ports = host.PortBindings;
    if (ports !== undefined && ports !== null) {
      if (Array.isArray(ports) && ports.length > 0) return deny('port_bindings');
      const record = asRecord(ports);
      if (record && Object.keys(record).length > 0) return deny('port_bindings');
    }
  }

  if (cfg.refuseSecurityOptSubstrings.length > 0) {
    const opts = host.SecurityOpt;
    if (Array.isArray(opts)) {
      for (const opt of opts) {
        if (typeof opt !== 'string') continue;
        const lower = opt.toLowerCase();
        for (const needle of cfg.refuseSecurityOptSubstrings) {
          if (lower.includes(needle)) return deny('security_opt');
        }
      }
    }
  }

  return { allow: true };
}

function checkNetworkCreate(body: unknown): AuthzDecision {
  const cfg = AUTHZ_RULES.networkCreate;
  const top = asRecord(body) ?? {};

  if (cfg.refuseDrivers.includes(String(top.Driver ?? ''))) return deny('network_driver');
  if (cfg.requireInternal && top.Internal !== true) return deny('network_not_internal');

  return { allow: true };
}

/**
 * Decide whether Docker may accept this API call. Only create bodies are inspected; everything
 * else is allowed so the runner can pull, start, log and remove.
 */
export function evaluateAuthz(method: string, requestUri: string, body: unknown): AuthzDecision {
  const path = pathOnly(requestUri);
  if (method.toUpperCase() !== 'POST') return { allow: true };
  if (CREATE_CONTAINER.test(path)) return checkContainerCreate(body);
  if (CREATE_NETWORK.test(path)) return checkNetworkCreate(body);
  return { allow: true };
}

/** Parse a JSON body; invalid JSON on a create path is refused closed. */
export function evaluateAuthzRaw(
  method: string,
  requestUri: string,
  rawBody: string | Uint8Array | null | undefined,
): AuthzDecision {
  const path = pathOnly(requestUri);
  const isCreate =
    method.toUpperCase() === 'POST' && (CREATE_CONTAINER.test(path) || CREATE_NETWORK.test(path));
  if (!isCreate) return { allow: true };
  if (rawBody === null || rawBody === undefined || rawBody === '') {
    return deny('empty_body');
  }
  const text = typeof rawBody === 'string' ? rawBody : Buffer.from(rawBody).toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return deny('invalid_json');
  }
  return evaluateAuthz(method, requestUri, parsed);
}
