// The settings file of `pnpm server:setup` (D-08 V16 AC4): one YAML file outside the repository
// that names the key holders, the GitHub App, the model providers and the optional parts. It holds
// paths to the secret files and public keys, never a secret itself (a missing file means a hidden
// prompt). Pure: the caller reads the file.
import path from 'node:path';

import { parse } from 'yaml';

/** The optional parts of README step 7 (QUESTIONS #616 (5)). */
export const OPTIONAL_PARTS = [
  'observability',
  'knowledge',
  'dashboard-signin',
  'dashboard-actions',
] as const;
export type OptionalPart = (typeof OPTIONAL_PARTS)[number];

export interface KeyHolder {
  readonly name: string;
  /** The holder's PGP public key (armored or base64), for `init -pgp-keys` (QUESTIONS #616 (c)). */
  readonly pgpKeyFile?: string;
}

export type ProviderSettings =
  | { readonly provider: 'anthropic'; readonly apiKeyFile?: string }
  | { readonly provider: 'ollama'; readonly apiBase: string };

/** Team access through the proxy (README "Team access", V09, ADR-M67; D-08 V20 AC1). */
export interface AccessSettings {
  /** The DNS name people open; never an IP address (passkeys refuse it). */
  readonly hostname: string;
  /** The server's LAN address the proxy is published on. */
  readonly bindAddr: string;
  readonly port: number;
  /** IPv4 addresses for the CLI, in the certificate too (`SDLC_ACCESS_IPS`). */
  readonly ips: readonly string[];
  /** `SDLC_ACCESS_TLS_DIR`: outside the repository. */
  readonly tlsDir: string;
  /** A folder with the company CA's `ca.pem`, `server.pem`, `server-key.pem` for `access:tls import`. */
  readonly certificateFolder?: string;
}

/** The runner on its own Engine, the platform host's side (README runner steps 3, 4, 6; V20 AC2). */
export interface RunnerLinkSettings {
  /** `SDLC_RUNNER_LINK_ADDR`: the platform host's address on the link. */
  readonly linkAddr: string;
  /** `SDLC_RUNNER_SOURCE_CIDR`: the runner host as OpenBao sees it. */
  readonly sourceCidr: string;
  /** `SDLC_RUNNER_DOCKER_HOST`: `ssh://<user>@<host>` or `unix:///<socket>`. */
  readonly dockerHost: string;
}

export interface ServerSettings {
  /** The env file of README step 2; default `platform/deploy/.env` of the checkout. */
  readonly envFile?: string;
  readonly keyHolders: readonly KeyHolder[];
  readonly appClientId: string;
  readonly appKeyFile: string;
  readonly providers: readonly ProviderSettings[];
  readonly optional: readonly OptionalPart[];
  readonly dashboard?: { readonly publicOrigin: string; readonly clientSecretFile?: string };
  readonly access?: AccessSettings;
  readonly runnerLink?: RunnerLinkSettings;
  /**
   * Go on to step 3 with the throw-away certificate of `compose:env` (a development machine, the
   * live test). Off by default: on a server, OpenBao's certificate comes from the company CA
   * before step 3 (T11 §3c), so a new env file stops the command after step 2.
   */
  readonly throwawayTls: boolean;
}

/** A field that is missing or malformed: `field` is its path in the file, never its value. */
export class SettingsError extends Error {
  constructor(readonly field: string) {
    super(`invalid settings field: ${field}`);
  }
}

const CLIENT_ID = /^[A-Za-z0-9._-]{4,64}$/;
const URL = /^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?\/?$/;
const ORIGIN = /^(https:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?|http:\/\/localhost(?::\d{1,5})?)$/;
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
/** A DNS name with at least one dot, never an IPv4 address. */
const HOSTNAME =
  /^(?=.{1,253}$)(?!\d+(?:\.\d+){3}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
/** The forms `bootstrap.sh runner-credentials` accepts (ADR-M91 §2.7). */
const DOCKER_HOST =
  /^(?:ssh:\/\/[A-Za-z0-9._-]+@[A-Za-z0-9.-]+(?::\d{1,5})?|unix:\/\/\/[A-Za-z0-9._/-]+)$/;

/** The public origin of the dashboard behind the proxy: `https://<host>[:<port>]`. Pure. */
export function accessOrigin(a: Pick<AccessSettings, 'hostname' | 'port'>): string {
  return a.port === 443 ? `https://${a.hostname}` : `https://${a.hostname}:${a.port}`;
}

type Mapping = Readonly<Record<string, unknown>>;

function mapping(value: unknown, field: string): Mapping {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SettingsError(field);
  }
  return value as Mapping;
}

function list(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new SettingsError(field);
  return value;
}

function text(map: Mapping, key: string, field: string, pattern?: RegExp): string {
  const s = map[key];
  if (typeof s !== 'string' || s.trim() === '' || s.length > 500) throw new SettingsError(field);
  // Never read as a command-line option, never a control character (review V02).
  // eslint-disable-next-line no-control-regex
  if (s.startsWith('-') || /[\u0000-\u001f\u007f]/.test(s)) throw new SettingsError(field);
  if (pattern && !pattern.test(s)) throw new SettingsError(field);
  return s;
}

function absolutePath(map: Mapping, key: string, field: string, home: string): string {
  const raw = text(map, key, field);
  const expanded = raw === '~' ? home : raw.startsWith('~/') ? path.join(home, raw.slice(2)) : raw;
  if (!path.isAbsolute(expanded)) throw new SettingsError(field);
  return path.normalize(expanded);
}

function optionalPath(map: Mapping, key: string, field: string, home: string): string | undefined {
  return map[key] === undefined ? undefined : absolutePath(map, key, field, home);
}

function cidr(map: Mapping, key: string, field: string): string {
  const value = text(map, key, field);
  const [addr = '', bits = '', ...rest] = value.split('/');
  const n = Number(bits);
  if (rest.length > 0 || !IPV4.test(addr) || !/^\d{1,2}$/.test(bits) || n > 32) {
    throw new SettingsError(field);
  }
  return value;
}

function accessSettings(value: unknown, home: string): AccessSettings {
  const a = mapping(value, 'access');
  const port = a.port === undefined ? 8443 : a.port;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new SettingsError('access.port');
  }
  const ips = (a.cli_ips === undefined ? [] : list(a.cli_ips, 'access.cli_ips')).map((v, i) => {
    if (typeof v !== 'string' || !IPV4.test(v)) throw new SettingsError(`access.cli_ips[${i}]`);
    return v;
  });
  const certificateFolder = optionalPath(
    a,
    'certificate_folder',
    'access.certificate_folder',
    home,
  );
  return {
    hostname: text(a, 'hostname', 'access.hostname', HOSTNAME).toLowerCase(),
    bindAddr: text(a, 'bind_addr', 'access.bind_addr', IPV4),
    port,
    ips,
    tlsDir: absolutePath(a, 'tls_dir', 'access.tls_dir', home),
    ...(certificateFolder ? { certificateFolder } : {}),
  };
}

function runnerLinkSettings(value: unknown): RunnerLinkSettings {
  const r = mapping(value, 'runner_link');
  return {
    linkAddr: text(r, 'link_addr', 'runner_link.link_addr', IPV4),
    sourceCidr: cidr(r, 'source_cidr', 'runner_link.source_cidr'),
    dockerHost: text(r, 'docker_host', 'runner_link.docker_host', DOCKER_HOST),
  };
}

function provider(value: unknown, i: number, home: string): ProviderSettings {
  const at = (f: string) => `model_providers[${i}].${f}`;
  const p = mapping(value, `model_providers[${i}]`);
  const name = text(p, 'provider', at('provider'));
  if (name === 'anthropic') {
    const apiKeyFile = optionalPath(p, 'api_key_file', at('api_key_file'), home);
    return apiKeyFile ? { provider: name, apiKeyFile } : { provider: name };
  }
  if (name === 'ollama') {
    return { provider: name, apiBase: text(p, 'api_base', at('api_base'), URL).replace(/\/$/, '') };
  }
  throw new SettingsError(at('provider'));
}

/**
 * Parses and checks the settings file. `shares` is `BAO_KEY_SHARES` of `bootstrap.conf`: one key
 * holder per share. Throws `SettingsError` naming the first bad field.
 */
export function parseSettings(yamlText: string, home: string, shares: number): ServerSettings {
  let doc: unknown;
  try {
    doc = parse(yamlText);
  } catch {
    throw new SettingsError('(file)');
  }
  const root = mapping(doc, '(file)');

  const holders = list(root.key_holders, 'key_holders').map((value, i): KeyHolder => {
    const h = mapping(value, `key_holders[${i}]`);
    const name = text(h, 'name', `key_holders[${i}].name`);
    const pgpKeyFile = optionalPath(
      h,
      'pgp_public_key_file',
      `key_holders[${i}].pgp_public_key_file`,
      home,
    );
    return pgpKeyFile ? { name, pgpKeyFile } : { name };
  });
  if (holders.length !== shares) throw new SettingsError('key_holders');
  if (new Set(holders.map((h) => h.name.toLowerCase())).size !== holders.length)
    throw new SettingsError('key_holders');
  // All or none: `-pgp-keys` needs one key per share (QUESTIONS #616 (c)).
  const withKey = holders.filter((h) => h.pgpKeyFile).length;
  if (withKey !== 0 && withKey !== holders.length)
    throw new SettingsError('key_holders.pgp_public_key_file');

  const app = mapping(root.github_app, 'github_app');
  const providers = list(root.model_providers, 'model_providers').map((v, i) =>
    provider(v, i, home),
  );
  if (providers.length === 0) throw new SettingsError('model_providers');
  if (new Set(providers.map((p) => p.provider)).size !== providers.length)
    throw new SettingsError('model_providers');

  const optional = (root.optional === undefined ? [] : list(root.optional, 'optional')).map(
    (v, i) => {
      if (!OPTIONAL_PARTS.includes(v as OptionalPart)) throw new SettingsError(`optional[${i}]`);
      return v as OptionalPart;
    },
  );
  if (new Set(optional).size !== optional.length) throw new SettingsError('optional');
  // The api refuses to start with actions on and the sign-in off (U06, ADR-M73 §2.3).
  if (optional.includes('dashboard-actions') && !optional.includes('dashboard-signin'))
    throw new SettingsError('optional');

  const access = root.access === undefined ? undefined : accessSettings(root.access, home);
  const runnerLink =
    root.runner_link === undefined ? undefined : runnerLinkSettings(root.runner_link);

  let dashboard: ServerSettings['dashboard'];
  if (optional.includes('dashboard-signin')) {
    const d = root.dashboard === undefined && access ? {} : mapping(root.dashboard, 'dashboard');
    const clientSecretFile = optionalPath(
      d,
      'client_secret_file',
      'dashboard.client_secret_file',
      home,
    );
    // Behind the proxy there is one public origin, the proxy's (ADR-M67 §2.8): derived from
    // `access`, and a different `public_origin` is refused.
    const publicOrigin =
      access && d.public_origin === undefined
        ? accessOrigin(access)
        : text(d, 'public_origin', 'dashboard.public_origin', ORIGIN);
    if (access && publicOrigin !== accessOrigin(access)) {
      throw new SettingsError('dashboard.public_origin');
    }
    dashboard = { publicOrigin, ...(clientSecretFile ? { clientSecretFile } : {}) };
  } else if (root.dashboard !== undefined) {
    throw new SettingsError('dashboard');
  }

  const throwawayTls = root.throwaway_tls === undefined ? false : root.throwaway_tls;
  if (typeof throwawayTls !== 'boolean') throw new SettingsError('throwaway_tls');

  const envFile = optionalPath(root, 'env_file', 'env_file', home);
  return {
    ...(envFile ? { envFile } : {}),
    keyHolders: holders,
    appClientId: text(app, 'client_id', 'github_app.client_id', CLIENT_ID),
    appKeyFile: absolutePath(app, 'private_key_file', 'github_app.private_key_file', home),
    providers,
    optional,
    ...(dashboard ? { dashboard } : {}),
    ...(access ? { access } : {}),
    ...(runnerLink ? { runnerLink } : {}),
    throwawayTls,
  };
}

/** True when every key holder has a PGP public key: `init -pgp-keys` (the default). Pure. */
export function usesPgp(s: ServerSettings): boolean {
  return s.keyHolders.length > 0 && s.keyHolders.every((h) => h.pgpKeyFile !== undefined);
}

/** The files the settings name that hold secrets: readable by their owner only. */
export function secretFiles(s: ServerSettings): string[] {
  return [
    s.appKeyFile,
    ...s.providers.flatMap((p) =>
      p.provider === 'anthropic' && p.apiKeyFile ? [p.apiKeyFile] : [],
    ),
    ...(s.dashboard?.clientSecretFile ? [s.dashboard.clientSecretFile] : []),
  ];
}

/**
 * The base64 of a PGP public key's binary form, as `bao operator init -pgp-keys` wants it, from an
 * armored key (`gpg --export --armor`) or a base64 one (`gpg --export | base64`). Pure; throws
 * when the text is neither.
 */
export function pgpKeyBase64(fileText: string): string {
  const textIn = fileText.trim();
  let body = textIn;
  if (textIn.startsWith('-----BEGIN PGP PUBLIC KEY BLOCK-----')) {
    const lines = textIn.split(/\r?\n/);
    const end = lines.findIndex((l) => l.startsWith('-----END PGP PUBLIC KEY BLOCK-----'));
    if (end < 0) throw new Error('not a PGP public key');
    // The headers end at the first empty line; the checksum line starts with `=`.
    const blank = lines.findIndex((l) => l.trim() === '');
    body = lines
      .slice(blank + 1, end)
      .filter((l) => !l.startsWith('='))
      .join('');
  } else if (textIn.startsWith('-----')) {
    throw new Error('not a PGP public key');
  }
  body = body.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body) || body.length < 100) {
    throw new Error('not a PGP public key');
  }
  // The first packet is a public key (tag 6), never a secret key (tag 5): RFC 9580 §4.2–§4.3.
  const first = Buffer.from(body.slice(0, 4), 'base64')[0] ?? 0;
  const tag = (first & 0x40) !== 0 ? first & 0x3f : (first >> 2) & 0x0f;
  if ((first & 0x80) === 0 || tag !== 6) throw new Error('not a PGP public key');
  return body;
}
