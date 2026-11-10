// Gathers the facts of `pnpm doctor` on the machine of the stack (D-08 V07 AC1, AC3). Every
// command comes from `commands.ts` and runs through the allowlist of `exec.ts`; outputs are parsed
// into facts at once and dropped. It reads the env file through `env-facts.ts` (allowlisted keys
// only), the TLS certificates (never the key file) and files of this checkout. It writes nothing.
import { X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { loadProjectConfig } from '@sdlc/config';

import {
  APPROLE_FOLDERS,
  commands,
  PINNED_IMAGE,
  SQL_MIGRATIONS,
  SQL_PROJECTS,
  SQL_TABLE_SIZES,
  type ComposeTarget,
} from './commands.js';
import { parseEnvFacts, requiredSecrets } from './env-facts.js';
import type { Exec } from './exec.js';
import { manifestPermissions } from './github-permissions.js';
import { findLogEvents } from './logs.js';
import type {
  AccessFact,
  AppRoleFact,
  CertFact,
  GitHubFact,
  OpenBaoState,
  OperatorFacts,
  ProjectImageFact,
  PublishedPort,
  RepoFact,
  ServiceState,
  TableSizeFact,
} from './types.js';

export interface HostPaths {
  readonly repoRoot: string;
  readonly envFile: string;
}

const DAY_MS = 86_400_000;
const TLS_FILES = ['ca.pem', 'server.pem', 'server-key.pem'] as const;

export function deployPaths(repoRoot: string) {
  const deploy = path.join(repoRoot, 'platform/deploy');
  return {
    composeFile: path.join(deploy, 'docker-compose.yml'),
    envExample: path.join(deploy, '.env.example'),
    bootstrap: path.join(deploy, 'openbao/bootstrap.sh'),
    images: path.join(deploy, 'scripts/images.sh'),
    manifest: path.join(deploy, 'github-app/manifest.json'),
    migrations: path.join(repoRoot, 'platform/packages/core/src/db/migrations'),
  };
}

function statMode(file: string): number | null {
  try {
    return fs.statSync(file).mode;
  } catch {
    return null;
  }
}

function freeBytes(dir: string): number | null {
  try {
    const s = fs.statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

/** `docker compose ps --format json`: one array, or one object per line (Compose versions). */
/** A complete backup of `backup.sh`: its `<UTC time>` folder (`.partial` until every part is done). */
const BACKUP_FOLDER = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;
export const BACKUP_WARN_HOURS = 26;
export const BACKUP_FAIL_HOURS = 50;

/**
 * The newest complete backup in a folder (O03, ADR-M101): only names are listed and `MANIFEST`
 * is only tested for existence; no backup file is opened.
 */
export function newestBackup(dir: string): { readable: boolean; newest: string | null } {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return { readable: false, newest: null };
  }
  const complete = names
    .map(folderTime)
    .filter(
      (iso, i): iso is string =>
        iso !== null && fs.existsSync(path.join(dir, names[i]!, 'MANIFEST')),
    )
    .sort();
  return { readable: true, newest: complete.at(-1) ?? null };
}

/** The ISO time of a backup folder name, or null when it is not one (or not a real UTC time). */
function folderTime(name: string): string | null {
  const m = BACKUP_FOLDER.exec(name);
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.000Z`;
  const time = Date.parse(iso);
  return !Number.isNaN(time) && new Date(time).toISOString() === iso ? iso : null;
}

function hours(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  return /^[1-9]\d*$/.test(value) ? Number(value) : Number.NaN;
}

/** `SDLC_BACKUP_WARN_HOURS` and `SDLC_BACKUP_FAIL_HOURS`; NaN when a value is not a whole number. */
export function backupHours(values: Readonly<Record<string, string>>): {
  warnHours: number;
  failHours: number;
} {
  return {
    warnHours: hours(values.SDLC_BACKUP_WARN_HOURS, BACKUP_WARN_HOURS),
    failHours: hours(values.SDLC_BACKUP_FAIL_HOURS, BACKUP_FAIL_HOURS),
  };
}

/** The rows of `SQL_TABLE_SIZES`, or null when the answer is not that shape. */
export function parseTableSizes(stdout: string): TableSizeFact[] | null {
  const rows = jsonArray(stdout);
  if (rows === null) return null;
  const out: TableSizeFact[] = [];
  for (const row of rows) {
    const r = row as { table?: unknown; bytes?: unknown };
    if (typeof r?.table !== 'string' || typeof r.bytes !== 'number') return null;
    out.push({ table: r.table, bytes: r.bytes });
  }
  return out;
}

export function parsePs(text: string): ServiceState[] | null {
  const trimmed = text.trim();
  if (trimmed === '') return [];
  let rows: unknown[];
  try {
    rows = trimmed.startsWith('[')
      ? (JSON.parse(trimmed) as unknown[])
      : trimmed.split('\n').map((line) => JSON.parse(line) as unknown);
  } catch {
    return null;
  }
  const out: ServiceState[] = [];
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const r = row as Record<string, unknown>;
    if (typeof r.Service !== 'string') continue;
    out.push({
      service: r.Service,
      state: typeof r.State === 'string' ? r.State : '',
      health: typeof r.Health === 'string' ? r.Health : '',
      exitCode: typeof r.ExitCode === 'number' ? r.ExitCode : 0,
      published: publishers(r.Publishers),
    });
  }
  return out;
}

/** The published ports of one `docker compose ps` row (V09): address and port, nothing else. */
function publishers(value: unknown): PublishedPort[] {
  if (!Array.isArray(value)) return [];
  const out: PublishedPort[] = [];
  for (const p of value as Record<string, unknown>[]) {
    const port = typeof p?.PublishedPort === 'number' ? p.PublishedPort : 0;
    const address = typeof p?.URL === 'string' ? p.URL : '';
    if (port > 0 && /^[0-9a-fA-F.:]{1,45}$/.test(address)) out.push({ address, port });
  }
  return out;
}

export function parseOpenBaoStatus(status: number | null, stdout: string): OpenBaoState {
  if (status !== 0) return 'unreachable';
  const m = /OpenBao is (uninitialised|sealed|unsealed)/.exec(stdout);
  return (m?.[1] as OpenBaoState | undefined) ?? 'unreachable';
}

export function parseValkeyMemory(text: string): { usedBytes: number; maxBytes: number } | null {
  const used = /^used_memory:(\d+)/m.exec(text)?.[1];
  const max = /^maxmemory:(\d+)/m.exec(text)?.[1];
  return used === undefined || max === undefined
    ? null
    : { usedBytes: Number(used), maxBytes: Number(max) };
}

/** `owner/name` of a repository; never `.` or `..` as a part. */
function isRepoName(value: string): boolean {
  const parts = value.split('/');
  return (
    parts.length === 2 &&
    parts.every((p) => /^[A-Za-z0-9._-]{1,100}$/.test(p) && p !== '.' && p !== '..')
  );
}

/** The JSON line of the worker's `doctor-github.js`, checked field by field. */
export function parseWorkerGitHub(status: number | null, stdout: string): GitHubFact {
  if (status !== 0) {
    return { ok: false, error: /Cannot find module/.test(stdout) ? 'not_built' : 'exec_failed' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim().split('\n').at(-1) ?? '');
  } catch {
    return { ok: false, error: 'invalid_answer' };
  }
  const p = parsed as Record<string, unknown>;
  if (p.ok !== true) {
    return {
      ok: false,
      error:
        typeof p.error === 'string' && /^[a-z_]{1,64}$/.test(p.error) ? p.error : 'invalid_answer',
    };
  }
  const perms = (value: unknown): Record<string, string> => {
    const out: Record<string, string> = {};
    if (typeof value !== 'object' || value === null) return out;
    for (const [k, v] of Object.entries(value)) {
      if (
        /^[a-z][a-z0-9_]{0,63}$/.test(k) &&
        typeof v === 'string' &&
        /^(read|write|admin)$/.test(v)
      )
        out[k] = v;
    }
    return out;
  };
  const app = p.app as Record<string, unknown> | undefined;
  const repos: RepoFact[] = [];
  for (const r of Array.isArray(p.repos) ? (p.repos as Record<string, unknown>[]) : []) {
    if (typeof r.repo !== 'string' || !isRepoName(r.repo)) continue;
    repos.push(
      r.installed === true
        ? {
            repo: r.repo,
            installed: true,
            selection: r.selection === 'all' ? 'all' : 'selected',
            permissions: perms(r.permissions),
          }
        : { repo: r.repo, installed: false },
    );
  }
  return { ok: true, app: { permissions: perms(app?.permissions) }, repos };
}

export function parseAppRole(
  status: number | null,
  stdout: string,
  now: Date,
): Pick<AppRoleFact, 'state' | 'ageDays'> {
  const out = stdout.trim();
  if (status !== 0) return { state: 'unreadable' };
  if (out === 'missing') return { state: 'missing' };
  if (!/^\d{1,12}$/.test(out)) return { state: 'unreadable' };
  return { state: 'ok', ageDays: Math.floor((now.getTime() - Number(out) * 1000) / DAY_MS) };
}

function certFact(name: CertFact['name'], file: string): CertFact {
  try {
    const cert = new X509Certificate(fs.readFileSync(file));
    return { name, notAfter: new Date(cert.validTo).toISOString() };
  } catch {
    return { name, notAfter: null };
  }
}

function migrationNames(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .map((f) => /^(\d{4}-[a-z0-9-]+)\.ts$/.exec(f)?.[1])
      .filter((n): n is string => n !== undefined)
      .sort();
  } catch {
    return [];
  }
}

function jsonArray(text: string): unknown[] | null {
  try {
    const parsed = JSON.parse(text.trim()) as unknown;
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const running = (services: readonly ServiceState[] | null | undefined, name: string) =>
  services?.some((s) => s.service === name && s.state === 'running') === true;

/** The trial stack's key file (`platform/deploy/trial/src/keys.ts` `KEY_FILE_NAME`, static test). */
export const TRIAL_KEY_FILE = 'trial-openbao-keys.age';

/** A trial stack's Compose project (`pnpm trial:up`, and its live test). Pure. */
export function isTrialProject(project: string | undefined): boolean {
  return project !== undefined && /^(sdlc-trial|sdlctrialit)[a-z0-9-]*$/.test(project);
}

export async function gatherFacts(
  paths: HostPaths,
  exec: Exec,
  now = new Date(),
): Promise<OperatorFacts> {
  const files = deployPaths(paths.repoRoot);
  const manifest = manifestPermissions(fs.readFileSync(files.manifest, 'utf8'));
  const exists = fs.existsSync(paths.envFile);
  const required = requiredSecrets(fs.readFileSync(files.envExample, 'utf8'));
  const envFacts = exists
    ? parseEnvFacts(fs.readFileSync(paths.envFile, 'utf8'), required)
    : undefined;
  const keyFile = path.join(path.dirname(paths.envFile), TRIAL_KEY_FILE);
  const envFile = {
    path: paths.envFile,
    exists,
    mode: statMode(paths.envFile),
    ...(envFacts ? { facts: envFacts } : {}),
    ...(isTrialProject(envFacts?.values.COMPOSE_PROJECT_NAME)
      ? { trialKeyFile: { path: keyFile, mode: statMode(keyFile) } }
      : {}),
  };

  const disk = [
    { path: path.dirname(paths.envFile), freeBytes: freeBytes(path.dirname(paths.envFile)) },
  ];
  const backupDir = envFacts?.values.SDLC_BACKUP_DIR;
  if (backupDir) disk.push({ path: backupDir, freeBytes: freeBytes(backupDir) });

  const version = await exec(commands.dockerVersion());
  const docker =
    version.status !== 0
      ? null
      : {
          serverVersion: version.stdout.trim() || null,
          composeVersion: await exec(commands.composeVersion()).then((r) =>
            r.status === 0 ? r.stdout.trim() : null,
          ),
          memoryBytes: await exec(commands.dockerMemory()).then((r) =>
            r.status === 0 ? Number(r.stdout.trim()) || null : null,
          ),
          authorizationPlugins: await exec(commands.dockerAuthz()).then((r) => {
            if (r.status !== 0) return null;
            const raw = r.stdout.trim();
            if (raw === '' || raw === 'null') return [];
            try {
              const parsed = JSON.parse(raw) as unknown;
              return Array.isArray(parsed)
                ? parsed.filter((x): x is string => typeof x === 'string')
                : null;
            } catch {
              return null;
            }
          }),
        };

  const mode = await exec(commands.imagesMode(files.images));
  const imagesMode =
    mode.status === 0 && /^(local|published)$/.test(mode.stdout.trim())
      ? (mode.stdout.trim() as 'local' | 'published')
      : 'failed';
  const access = accessFact(envFacts?.values ?? {});
  const backup = envFacts
    ? {
        dir: backupDir || null,
        ...(backupDir ? newestBackup(backupDir) : { readable: true, newest: null }),
        ...backupHours(envFacts.values),
      }
    : undefined;
  const base: OperatorFacts = {
    now,
    envFile,
    docker,
    disk,
    ...(backup ? { backup } : {}),
    manifest,
    imagesMode,
    access,
  };
  const tlsDir = envFacts?.values.SDLC_OPENBAO_TLS_DIR ?? null;
  const tls = {
    dir: tlsDir,
    missing: tlsDir
      ? TLS_FILES.filter((f) => !fs.existsSync(path.join(tlsDir, f)))
      : [...TLS_FILES],
    certs: tlsDir
      ? [
          certFact('ca', path.join(tlsDir, 'ca.pem')),
          certFact('server', path.join(tlsDir, 'server.pem')),
        ]
      : [],
  };
  if (!docker || !envFacts) return { ...base, tls };

  const target: ComposeTarget = {
    composeFile: files.composeFile,
    envFile: paths.envFile,
    project: envFacts.values.COMPOSE_PROJECT_NAME ?? 'deploy',
  };
  const ps = await exec(commands.ps(target));
  const services = ps.status === 0 ? parsePs(ps.stdout) : null;
  const facts: OperatorFacts = { ...base, tls, services };
  if (!services || services.length === 0) return facts;

  const openbao = running(services, 'openbao')
    ? await exec(commands.openbaoStatus(files.bootstrap), { SDLC_ENV_FILE: paths.envFile }).then(
        (r) => parseOpenBaoStatus(r.status, r.stdout),
      )
    : undefined;

  let migrations: OperatorFacts['migrations'];
  let projects: OperatorFacts['projects'];
  let tableSizes: OperatorFacts['tableSizes'];
  if (running(services, 'postgres')) {
    const applied = await exec(commands.psql(target, SQL_MIGRATIONS));
    const names = applied.status === 0 ? jsonArray(applied.stdout) : null;
    migrations = {
      expected: migrationNames(files.migrations),
      applied:
        names?.filter((n): n is string => typeof n === 'string') ??
        (/kysely_migration.*does not exist/.test(applied.stderr) ? [] : null),
    };
    projects = await projectImages(exec, target);
    const sizes = await exec(commands.psql(target, SQL_TABLE_SIZES));
    tableSizes = sizes.status === 0 ? parseTableSizes(sizes.stdout) : null;
  }

  const approles: AppRoleFact[] = [];
  for (const f of APPROLE_FOLDERS) {
    if (!running(services, f.service)) {
      approles.push({ service: f.service, credentials: f.credentials, state: 'not_running' });
      continue;
    }
    const r = await exec(commands.approle(target, f.service, f.folder));
    approles.push({
      service: f.service,
      credentials: f.credentials,
      ...parseAppRole(r.status, r.stdout, now),
    });
  }

  const platformUp = ['sdlc-api', 'sdlc-worker', 'sdlc-runner'].some((s) => running(services, s));
  const logs = platformUp
    ? await exec(commands.logs(target)).then((r) =>
        r.status === 0 ? findLogEvents(r.stdout) : null,
      )
    : undefined;
  const valkey = running(services, 'valkey')
    ? await exec(commands.valkey(target)).then((r) =>
        r.status === 0 ? parseValkeyMemory(r.stdout) : null,
      )
    : undefined;
  const github =
    running(services, 'sdlc-worker') && openbao === 'unsealed'
      ? await exec(commands.workerGitHub(target)).then((r) =>
          parseWorkerGitHub(r.status, `${r.stdout}\n${r.stderr}`),
        )
      : undefined;
  return {
    ...facts,
    ...(openbao ? { openbao } : {}),
    ...(migrations ? { migrations } : {}),
    ...(projects !== undefined ? { projects } : {}),
    ...(tableSizes !== undefined ? { tableSizes } : {}),
    approles,
    ...(logs !== undefined ? { logs } : {}),
    ...(valkey !== undefined ? { valkey } : {}),
    ...(github ? { github } : {}),
  };
}

/**
 * Team access (V09, design/ADR-M67): the settings of the env file and the proxy's certificate.
 * Reads the two certificates (never the key file: only whether it exists).
 */
export function accessFact(values: Readonly<Record<string, string>>): AccessFact {
  const hostname = values.SDLC_ACCESS_HOSTNAME ?? null;
  const bindAddr = values.SDLC_ACCESS_BIND_ADDR ?? null;
  const ips = (values.SDLC_ACCESS_IPS ?? '').split(/\s+/).filter((ip) => ip !== '');
  const dir = values.SDLC_ACCESS_TLS_DIR ?? null;
  let unnamed: string[] | null = null;
  if (dir) {
    try {
      const cert = new X509Certificate(fs.readFileSync(path.join(dir, 'server.pem')));
      unnamed = [
        ...(hostname && cert.checkHost(hostname) === undefined ? [hostname] : []),
        ...ips.filter((ip) => cert.checkIP(ip) === undefined),
      ];
    } catch {
      unnamed = null;
    }
  }
  return {
    configured: hostname !== null || bindAddr !== null,
    bindAddr,
    hostPort: values.SDLC_ACCESS_HOST_PORT ?? '8443',
    hostname,
    ips,
    proxyIp: values.SDLC_ACCESS_PROXY_IP ?? '172.30.1.6',
    trustedProxy: values.SDLC_API_TRUSTED_PROXY ?? null,
    publicOrigin: values.SDLC_API_PUBLIC_ORIGIN ?? null,
    webSignIn: values.SDLC_API_WEB_SIGNIN ?? 'off',
    tls: {
      dir,
      missing: dir ? TLS_FILES.filter((f) => !fs.existsSync(path.join(dir, f))) : [...TLS_FILES],
      certs: dir
        ? [
            certFact('ca', path.join(dir, 'ca.pem')),
            certFact('server', path.join(dir, 'server.pem')),
          ]
        : [],
      unnamed,
    },
  };
}

async function projectImages(
  exec: Exec,
  target: ComposeTarget,
): Promise<ProjectImageFact[] | null> {
  const r = await exec(commands.psql(target, SQL_PROJECTS));
  const rows = r.status === 0 ? jsonArray(r.stdout) : null;
  if (!rows) return null;
  const out: ProjectImageFact[] = [];
  for (const row of rows) {
    const { project, config } = (row ?? {}) as { project?: unknown; config?: unknown };
    if (typeof project !== 'string') continue;
    const loaded = loadProjectConfig(typeof config === 'string' ? config : '');
    const image = loaded.ok ? loaded.config.sandbox.image : null;
    out.push({ project, image, present: await imagePresent(exec, image) });
    // X03 (QUESTIONS #528): an image for another adapter is checked too, named after it.
    const opencode = loaded.ok ? loaded.config.sandbox.images?.opencode : undefined;
    if (opencode !== undefined) {
      const subject = `${project} (opencode)`;
      out.push({ project: subject, image: opencode, present: await imagePresent(exec, opencode) });
    }
  }
  return out;
}

async function imagePresent(exec: Exec, image: string | null): Promise<boolean | null> {
  if (image === null || !PINNED_IMAGE.test(image)) return null;
  return (await exec(commands.imageInspect(image))).status === 0;
}
