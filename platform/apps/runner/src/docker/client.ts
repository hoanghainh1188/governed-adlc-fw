// Small Docker Engine API client over the Unix socket (ADR-M25 §2.5). No dependencies, like the
// OpenBao client (ADR-M21) and the GitHub adapter (ADR-M23): about fifteen endpoints, and full
// control over what goes into errors and logs.
//
// The socket gives root-equivalent power over the host (D-03 §13). The client therefore:
// - calls only the endpoints in ALLOWED_ENDPOINTS (no exec, build, commit, swarm, plugins, system);
// - sends every container and network definition through the guard (guard.ts) first;
// - never puts Docker's own error text into an error: it can echo request data.
import http from 'node:http';

import { RunnerError } from '../errors.js';
import type { SandboxRuntime } from '../settings.js';
import {
  assertSafeContainerSpec,
  assertSafeGatewaySpec,
  assertSafeNetworkSpec,
  assertSafeScoringSpec,
  assertSafeToolSpec,
  type ContainerSpec,
  type ScoringContainerSpec,
  type ScoringPhase,
  type ToolContainerSpec,
} from './guard.js';

/** Docker Engine 25 or later (API 1.44). The server answers older versions for newer clients. */
export const DOCKER_API_VERSION = 'v1.44';
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

type Method = 'GET' | 'POST' | 'DELETE' | 'PUT' | 'HEAD';

const NAME = '[a-zA-Z0-9][a-zA-Z0-9_.-]*';
/** A run sandbox's container name (`names.ts`): the only container whose files are read. */
const SANDBOX = 'sdlc-sandbox-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** Every endpoint the runner may call. Anything else is refused before it reaches the socket. */
export const ALLOWED_ENDPOINTS: readonly (readonly [Method, RegExp])[] = [
  ['GET', /^\/_ping$/],
  // Task H06 (ADR-M25 §2.12): at start, the runner checks the Engine lists its sandbox runtime.
  ['GET', /^\/info$/],
  [
    'GET',
    new RegExp(
      `^/images/${NAME}(?::[0-9]{1,5})?(?:/${NAME})*(?::[\\w.-]+)?(?:@sha256:[0-9a-f]{64})?/json$`,
    ),
  ],
  ['POST', /^\/images\/create$/],
  ['GET', /^\/containers\/json$/],
  ['POST', /^\/containers\/create$/],
  ['GET', new RegExp(`^/containers/${NAME}/json$`)],
  ['POST', new RegExp(`^/containers/${NAME}/start$`)],
  ['POST', new RegExp(`^/containers/${NAME}/wait$`)],
  ['GET', new RegExp(`^/containers/${NAME}/logs$`)],
  ['PUT', new RegExp(`^/containers/${NAME}/archive$`)],
  // C06 session 2b (ADR-M33 §2.9): read the workspace out of a run sandbox only;
  // `exportWorkspace` also checks the container's name and this runner's labels first.
  ['GET', new RegExp(`^/containers/${SANDBOX}/archive$`)],
  // C11 (ADR-M42 §2.6): kill a run sandbox's processes before its workspace is read after a kill.
  ['POST', new RegExp(`^/containers/${SANDBOX}/kill$`)],
  ['DELETE', new RegExp(`^/containers/${NAME}$`)],
  ['GET', /^\/networks$/],
  ['POST', /^\/networks\/create$/],
  ['GET', new RegExp(`^/networks/${NAME}$`)],
  ['POST', new RegExp(`^/networks/${NAME}/(?:connect|disconnect)$`)],
  ['DELETE', new RegExp(`^/networks/${NAME}$`)],
  ['GET', /^\/volumes$/],
  ['POST', /^\/volumes\/create$/],
  ['DELETE', new RegExp(`^/volumes/${NAME}$`)],
];

export function isAllowedEndpoint(method: string, path: string): boolean {
  return ALLOWED_ENDPOINTS.some(([m, pattern]) => m === method && pattern.test(path));
}

export interface DockerResponse {
  readonly status: number;
  readonly body: Buffer;
  /** Response headers (lower-case names); empty for responses built by the client itself. */
  readonly headers?: Readonly<Record<string, string | string[] | undefined>>;
}

export interface ContainerSummary {
  readonly Id: string;
  readonly Names: readonly string[];
  readonly Labels: Readonly<Record<string, string>>;
  readonly State: string;
}

export interface ContainerInfo {
  readonly Id: string;
  readonly Name: string;
  readonly Image: string;
  readonly State: {
    readonly Status: string;
    readonly Running: boolean;
    readonly ExitCode: number;
    readonly Health?: { readonly Status: string };
  };
  readonly Config: {
    readonly Env: readonly string[] | null;
    readonly Labels: Readonly<Record<string, string>> | null;
  };
  readonly HostConfig: Readonly<Record<string, unknown>>;
  readonly Mounts: readonly {
    readonly Type: string;
    readonly Name?: string;
    readonly Destination: string;
  }[];
  readonly NetworkSettings: { readonly Networks: Readonly<Record<string, unknown>> };
}

export interface NetworkSummary {
  readonly Id: string;
  readonly Name: string;
  readonly Internal: boolean;
  readonly Labels: Readonly<Record<string, string>> | null;
  readonly Containers?: Readonly<Record<string, { readonly Name: string }>>;
}

export interface NetworkSpec {
  readonly Name: string;
  readonly Driver: 'bridge';
  readonly Internal: true;
  readonly Attachable: false;
  readonly EnableIPv6: false;
  readonly Labels: Readonly<Record<string, string>>;
  readonly Options: { readonly 'com.docker.network.bridge.inhibit_ipv4': 'true' };
}

export interface VolumeSummary {
  readonly Name: string;
  readonly Labels: Readonly<Record<string, string>> | null;
}

/** What the runner reads of an image: its ID, digests and labels (X03: `sdlc.agent.adapter`). */
export interface ImageInfo {
  readonly Id: string;
  readonly RepoDigests: string[];
  readonly Config?: { readonly Labels?: Readonly<Record<string, string>> | null } | null;
}

export interface DockerClientOptions {
  readonly socketPath: string;
  readonly timeoutMs?: number;
  /**
   * The runtime every sandbox and scoring container must name (task H06, `SDLC_RUNNER_SANDBOX_RUNTIME`);
   * undefined: none, the Engine's default.
   */
  readonly sandboxRuntime?: SandboxRuntime;
}

/** What the runner reads of `GET /info` (task H06): the runtimes and the security options only. */
export interface EngineInfo {
  /** The names of the runtimes the Engine knows (`runc`, `runsc`, `kata`…). */
  readonly runtimes: readonly string[];
  /** True when the Engine runs rootless (`name=rootless` in `SecurityOptions`). */
  readonly rootless: boolean;
}

/** Reads the two fields the runner needs from a `GET /info` answer; anything else is ignored. */
export function parseEngineInfo(body: unknown): EngineInfo {
  const info = (body !== null && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const runtimes =
    info.Runtimes !== null && typeof info.Runtimes === 'object' && !Array.isArray(info.Runtimes)
      ? Object.keys(info.Runtimes)
      : [];
  const options = Array.isArray(info.SecurityOptions) ? info.SecurityOptions : [];
  const rootless = options.some(
    (opt) => typeof opt === 'string' && opt.split(',').includes('name=rootless'),
  );
  return { runtimes, rootless };
}

/** A filter for the list endpoints: `label=key=value` pairs, all required. */
export type LabelFilter = Readonly<Record<string, string>>;

function labelFilter(labels: LabelFilter): Record<string, string> {
  return {
    filters: JSON.stringify({
      label: Object.entries(labels).map(([key, value]) => `${key}=${value}`),
    }),
  };
}

export class DockerClient {
  readonly #socketPath: string;
  readonly #timeoutMs: number;
  readonly #sandboxRuntime: SandboxRuntime | undefined;

  constructor(options: DockerClientOptions) {
    this.#socketPath = options.socketPath;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#sandboxRuntime = options.sandboxRuntime;
  }

  async ping(): Promise<void> {
    await this.#expect('GET', '/_ping', [200]);
  }

  /** The Engine's runtimes and whether it is rootless (task H06). Nothing else is kept. */
  async engineInfo(): Promise<EngineInfo> {
    const res = await this.#expect('GET', '/info', [200]);
    return parseEngineInfo(JSON.parse(res.body.toString('utf8')) as unknown);
  }

  /**
   * The Docker Engine's version from the `Server` header of the ping answer (`Docker/29.8.2 (linux)`),
   * for the hardware block of an evaluation result (ADR-M81 §2.1). No new endpoint. `unknown` when the
   * header is missing or has another shape.
   */
  async engineVersion(): Promise<string> {
    const res = await this.request('GET', '/_ping');
    this.#check(res, [200], 'GET');
    const header = res.headers?.server;
    const text = Array.isArray(header) ? header[0] : header;
    return /^Docker\/([0-9A-Za-z][0-9A-Za-z._+-]{0,31})/.exec(text ?? '')?.[1] ?? 'unknown';
  }

  /** Image details, or undefined when the image is not on this host. */
  async imageInspect(ref: string): Promise<ImageInfo | undefined> {
    const res = await this.request('GET', `/images/${ref}/json`);
    if (res.status === 404) return undefined;
    this.#check(res, [200], 'GET');
    return JSON.parse(res.body.toString('utf8')) as ImageInfo;
  }

  /** Pulls an image by digest (`name@sha256:…`); tags alone are refused. */
  async imagePull(ref: string): Promise<void> {
    const at = ref.lastIndexOf('@sha256:');
    if (at < 0) throw new RunnerError('runner.docker.image_not_pinned');
    // The answer is a progress stream; an error inside it shows up as an `error` field.
    const res = await this.#expect('POST', '/images/create', [200], undefined, { fromImage: ref });
    if (/"error(?:Detail)?"\s*:/.test(res.body.toString('utf8'))) {
      throw new RunnerError('runner.docker.pull_failed');
    }
  }

  async containerList(labels: LabelFilter): Promise<ContainerSummary[]> {
    const res = await this.#expect('GET', '/containers/json', [200], undefined, {
      all: 'true',
      ...labelFilter(labels),
    });
    return JSON.parse(res.body.toString('utf8')) as ContainerSummary[];
  }

  /** Creates a container from a guarded spec (guard.ts). Returns its ID. */
  async containerCreate(name: string, spec: ContainerSpec): Promise<string> {
    assertSafeContainerSpec(name, spec, this.#sandboxRuntime);
    const res = await this.#expect('POST', '/containers/create', [201], spec, { name });
    return (JSON.parse(res.body.toString('utf8')) as { Id: string }).Id;
  }

  /**
   * Creates a scoring container of an evaluation run (task L04, ADR-M81 §2.5) from a spec the
   * scoring guard accepts for `phase` (guard.ts). Returns its ID.
   */
  async scoringContainerCreate(
    name: string,
    spec: ScoringContainerSpec,
    phase: ScoringPhase,
  ): Promise<string> {
    assertSafeScoringSpec(name, spec, phase, this.#sandboxRuntime);
    const res = await this.#expect('POST', '/containers/create', [201], spec, { name });
    return (JSON.parse(res.body.toString('utf8')) as { Id: string }).Id;
  }

  /**
   * Creates a tool container or the MCP gateway of a run (X04, ADR-M69 §2.4) from a spec its guard
   * accepts (guard.ts). Returns its ID.
   */
  async toolContainerCreate(
    name: string,
    spec: ToolContainerSpec,
    kind: 'tool' | 'gateway',
  ): Promise<string> {
    if (kind === 'tool') assertSafeToolSpec(name, spec);
    else assertSafeGatewaySpec(name, spec);
    const res = await this.#expect('POST', '/containers/create', [201], spec, { name });
    return (JSON.parse(res.body.toString('utf8')) as { Id: string }).Id;
  }

  /**
   * Extracts a tar archive into a created container before it starts (S2: the workspace). Docker
   * writes into the container's volumes, so the archive lands in the run's workspace volume.
   */
  async putArchive(id: string, path: string, tar: Buffer): Promise<void> {
    // copyUIDGID: keep the owners written in the archive (the sandbox user, workspace/tar.ts).
    const res = await this.request('PUT', `/containers/${id}/archive`, tar, {
      path,
      copyUIDGID: 'true',
    });
    this.#check(res, [200], 'PUT');
  }

  /**
   * Reads a path of a container as a tar archive, as a stream (C06 session 2b): the archive of a
   * workspace with `node_modules` is never held whole in memory. The caller checks that the
   * container is the run's own sandbox (`workspace/export.ts`), treats the archive as untrusted,
   * and destroys the stream when it stops reading early.
   */
  getArchive(name: string, path: string): Promise<http.IncomingMessage> {
    const apiPath = `/containers/${name}/archive`;
    if (!isAllowedEndpoint('GET', apiPath)) {
      return Promise.reject(new RunnerError('runner.docker.endpoint_refused', { method: 'GET' }));
    }
    const search = new URLSearchParams({ path }).toString();
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          socketPath: this.#socketPath,
          method: 'GET',
          path: `/${DOCKER_API_VERSION}${apiPath}?${search}`,
          headers: { host: 'docker' },
          timeout: this.#timeoutMs,
        },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status === 200) {
            resolve(res);
            return;
          }
          res.resume();
          try {
            this.#check({ status, body: Buffer.alloc(0) }, [200], 'GET');
          } catch (error) {
            reject(
              error instanceof Error
                ? error
                : new RunnerError('runner.docker.api_error', { method: 'GET', status }),
            );
          }
        },
      );
      req.on('timeout', () => {
        req.destroy(new RunnerError('runner.docker.timeout', { method: 'GET' }));
        reject(new RunnerError('runner.docker.timeout', { method: 'GET' }));
      });
      req.on('error', (error: NodeJS.ErrnoException) => reject(unreachable(error.code ?? 'error')));
      req.end();
    });
  }

  async containerStart(id: string): Promise<void> {
    await this.#expect('POST', `/containers/${id}/start`, [204, 304]);
  }

  async containerInspect(id: string): Promise<ContainerInfo | undefined> {
    const res = await this.request('GET', `/containers/${id}/json`);
    if (res.status === 404) return undefined;
    this.#check(res, [200], 'GET');
    return JSON.parse(res.body.toString('utf8')) as ContainerInfo;
  }

  /**
   * Kills every process of a run sandbox (SIGKILL); the container and its volume stay, so the
   * workspace can still be read (C11). A container that is gone or not running is not an error.
   */
  async containerKill(name: string): Promise<void> {
    const res = await this.request('POST', `/containers/${name}/kill`);
    if (res.status === 404 || res.status === 409) return;
    this.#check(res, [204], 'POST');
  }

  /** Waits until the container exits; returns its exit code. */
  async containerWait(id: string, timeoutMs: number): Promise<number> {
    const res = await this.request('POST', `/containers/${id}/wait`, undefined, {}, { timeoutMs });
    this.#check(res, [200], 'POST');
    return (JSON.parse(res.body.toString('utf8')) as { StatusCode: number }).StatusCode;
  }

  /**
   * Standard output of a container (multiplexed stream, headers removed). `stderr`: both streams
   * (X04: the MCP gateway's log lines, wherever the gateway writes them).
   */
  async containerLogs(id: string, options: { readonly stderr?: boolean } = {}): Promise<string> {
    const res = await this.#expect('GET', `/containers/${id}/logs`, [200], undefined, {
      stdout: 'true',
      stderr: options.stderr === true ? 'true' : 'false',
    });
    return demultiplex(res.body, options);
  }

  /** Removes a container and its anonymous volumes. Returns false when it did not exist. */
  async containerRemove(id: string): Promise<boolean> {
    const res = await this.request('DELETE', `/containers/${id}`, undefined, {
      force: 'true',
      v: 'true',
    });
    if (res.status === 404) return false;
    this.#check(res, [204], 'DELETE');
    return true;
  }

  async networkList(labels: LabelFilter): Promise<NetworkSummary[]> {
    const res = await this.#expect('GET', '/networks', [200], undefined, labelFilter(labels));
    return JSON.parse(res.body.toString('utf8')) as NetworkSummary[];
  }

  async networkCreate(spec: NetworkSpec): Promise<string> {
    assertSafeNetworkSpec(spec);
    const res = await this.#expect('POST', '/networks/create', [201], spec);
    return (JSON.parse(res.body.toString('utf8')) as { Id: string }).Id;
  }

  async networkInspect(name: string): Promise<NetworkSummary | undefined> {
    const res = await this.request('GET', `/networks/${name}`);
    if (res.status === 404) return undefined;
    this.#check(res, [200], 'GET');
    return JSON.parse(res.body.toString('utf8')) as NetworkSummary;
  }

  /** Attaches a container to a network under DNS aliases. */
  async networkConnect(network: string, container: string, aliases: string[]): Promise<void> {
    await this.#expect('POST', `/networks/${network}/connect`, [200], {
      Container: container,
      EndpointConfig: { Aliases: aliases },
    });
  }

  /** Detaches a container. Returns false when the network or the attachment did not exist. */
  async networkDisconnect(network: string, container: string): Promise<boolean> {
    const res = await this.request('POST', `/networks/${network}/disconnect`, {
      Container: container,
      Force: true,
    });
    if (res.status === 404) return false;
    this.#check(res, [200], 'POST');
    return true;
  }

  async networkRemove(name: string): Promise<boolean> {
    const res = await this.request('DELETE', `/networks/${name}`);
    if (res.status === 404) return false;
    this.#check(res, [204], 'DELETE');
    return true;
  }

  async volumeList(labels: LabelFilter): Promise<VolumeSummary[]> {
    const res = await this.#expect('GET', '/volumes', [200], undefined, labelFilter(labels));
    return (
      (JSON.parse(res.body.toString('utf8')) as { Volumes: VolumeSummary[] | null }).Volumes ?? []
    );
  }

  async volumeCreate(name: string, labels: Readonly<Record<string, string>>): Promise<void> {
    await this.#expect('POST', '/volumes/create', [201], {
      Name: name,
      Driver: 'local',
      Labels: labels,
    });
  }

  async volumeRemove(name: string): Promise<boolean> {
    const res = await this.request('DELETE', `/volumes/${name}`, undefined, { force: 'true' });
    if (res.status === 404) return false;
    this.#check(res, [204], 'DELETE');
    return true;
  }

  /**
   * One HTTP call on the socket. Refuses endpoints outside ALLOWED_ENDPOINTS before connecting.
   * Public for tests; the typed methods above are the API.
   */
  request(
    method: Method,
    path: string,
    body?: unknown,
    query: Readonly<Record<string, string>> = {},
    options: { readonly timeoutMs?: number; readonly maxBytes?: number } = {},
  ): Promise<DockerResponse> {
    const timeoutMs = options.timeoutMs ?? this.#timeoutMs;
    const maxBytes = options.maxBytes ?? MAX_RESPONSE_BYTES;
    if (!isAllowedEndpoint(method, path)) {
      return Promise.reject(new RunnerError('runner.docker.endpoint_refused', { method }));
    }
    const search = new URLSearchParams(query).toString();
    const raw = Buffer.isBuffer(body);
    const payload =
      body === undefined ? undefined : raw ? body : Buffer.from(JSON.stringify(body), 'utf8');
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          socketPath: this.#socketPath,
          method,
          path: `/${DOCKER_API_VERSION}${path}${search ? `?${search}` : ''}`,
          headers: {
            host: 'docker',
            ...(payload
              ? {
                  'content-type': raw ? 'application/x-tar' : 'application/json',
                  'content-length': payload.length,
                }
              : {}),
          },
          timeout: timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > maxBytes) {
              req.destroy();
              reject(new RunnerError('runner.docker.response_too_large'));
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              body: Buffer.concat(chunks),
              headers: res.headers,
            }),
          );
          res.on('error', () => reject(unreachable('response')));
        },
      );
      req.on('timeout', () => {
        req.destroy();
        reject(new RunnerError('runner.docker.timeout', { method }));
      });
      req.on('error', (error: NodeJS.ErrnoException) => reject(unreachable(error.code ?? 'error')));
      req.end(payload);
    });
  }

  async #expect(
    method: Method,
    path: string,
    ok: readonly number[],
    body?: unknown,
    query?: Readonly<Record<string, string>>,
  ): Promise<DockerResponse> {
    const res = await this.request(method, path, body, query);
    this.#check(res, ok, method);
    return res;
  }

  #check(res: DockerResponse, ok: readonly number[], method: string): void {
    if (ok.includes(res.status)) return;
    if (res.status === 404) throw new RunnerError('runner.docker.not_found', { method });
    if (res.status === 409) throw new RunnerError('runner.docker.conflict', { method });
    throw new RunnerError('runner.docker.api_error', { method, status: res.status });
  }
}

function unreachable(code: string): RunnerError {
  return new RunnerError('runner.docker.unreachable', { code });
}

/**
 * Removes the 8-byte frame headers of Docker's multiplexed log stream: stdout frames only, or
 * stdout and stderr frames (X04) in the order Docker wrote them.
 */
export function demultiplex(stream: Buffer, options: { readonly stderr?: boolean } = {}): string {
  const parts: Buffer[] = [];
  let offset = 0;
  while (offset + 8 <= stream.length) {
    const type = stream[offset];
    const size = stream.readUInt32BE(offset + 4);
    if (type === 1 || (type === 2 && options.stderr === true)) {
      parts.push(stream.subarray(offset + 8, offset + 8 + size));
    }
    offset += 8 + size;
  }
  return Buffer.concat(parts).toString('utf8');
}
