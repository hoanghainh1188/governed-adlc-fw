// The facts `pnpm doctor` gathers and the results its checks give (D-08 V07 AC1). Facts hold codes,
// counts, dates, names of services and variables, and repository names: never a secret value
// (`env-facts.ts` keeps only whether a secret is set), never a log line or a command's output.
import type { MessageKey, MessageParams } from '@sdlc/messages';

export type CheckStatus = 'ok' | 'warning' | 'failed' | 'skipped';

export interface Text {
  readonly key: MessageKey;
  readonly params?: MessageParams;
}

export interface CheckResult {
  readonly id: CheckId;
  /** What the line is about when one check gives several lines (a service, a project, a repo). */
  readonly subject?: string;
  readonly status: CheckStatus;
  readonly text: Text;
  /** The command or README / runbook section that fixes it; set for `warning` and `failed`. */
  readonly fix?: Text;
}

export const CHECK_IDS = [
  'host.docker',
  'host.memory',
  'host.disk',
  'backup.recent',
  'env.file',
  'env.secrets',
  'services.health',
  'openbao.state',
  'openbao.tls_files',
  'openbao.tls_expiry',
  'db.migrations',
  'db.table_size',
  'credentials.approle',
  'credentials.logs',
  'models.litellm',
  'valkey.memory',
  'sandbox.image',
  'github.app',
  'images.mode',
  'access.proxy',
  'access.tls_files',
  'access.tls_expiry',
  'access.tls_names',
  'access.ports',
  'access.public_origin',
  'access.trusted_proxy',
  'runner.engine',
  'runner.authz',
] as const;
export type CheckId = (typeof CHECK_IDS)[number];

export type SecretState = 'set' | 'empty' | 'placeholder' | 'missing';

export interface EnvFacts {
  /** Allowlisted, non-secret settings only (`env-facts.ts` `ENV_ALLOWLIST`). */
  readonly values: Readonly<Record<string, string>>;
  /** Whether each required secret is set; never its value. */
  readonly secrets: Readonly<Record<string, SecretState>>;
}

export interface ServiceState {
  readonly service: string;
  /** Docker's state: `running`, `exited`, `restarting`, `created`, `paused`, `dead`. */
  readonly state: string;
  /** `healthy`, `unhealthy`, `starting`, or empty without a health check. */
  readonly health: string;
  readonly exitCode: number;
  /** Published ports (V09): the host address and port of each; empty when none. */
  readonly published?: readonly PublishedPort[];
}

export interface PublishedPort {
  /** The host address the port is bound to, as Docker reports it (`127.0.0.1`, `0.0.0.0`, `::`). */
  readonly address: string;
  readonly port: number;
}

/** Team access (V09, design/ADR-M67): its settings and certificate, from the env file and files. */
export interface AccessFact {
  /** SDLC_ACCESS_HOSTNAME or SDLC_ACCESS_BIND_ADDR is set. */
  readonly configured: boolean;
  readonly bindAddr: string | null;
  readonly hostPort: string;
  readonly hostname: string | null;
  readonly ips: readonly string[];
  readonly proxyIp: string;
  readonly trustedProxy: string | null;
  readonly publicOrigin: string | null;
  readonly webSignIn: string;
  readonly tls: {
    readonly dir: string | null;
    readonly missing: readonly string[];
    readonly certs: readonly CertFact[];
    /** The names the server certificate does not hold (host name, IPs); null: not readable. */
    readonly unnamed: readonly string[] | null;
  };
}

export interface TableSizeFact {
  readonly table: string;
  readonly bytes: number;
}

export type OpenBaoState = 'uninitialised' | 'sealed' | 'unsealed' | 'unreachable';

export interface CertFact {
  readonly name: 'ca' | 'server';
  /** ISO time; null when the file is missing or not a certificate. */
  readonly notAfter: string | null;
}

export interface AppRoleFact {
  readonly service: string;
  /** `credentials` of `pnpm openbao:bootstrap <credentials>`. */
  readonly credentials: string;
  readonly state: 'ok' | 'missing' | 'unreadable' | 'not_running';
  /** Age of the secret ID file in days (state `ok`). */
  readonly ageDays?: number;
}

export interface LogFindings {
  /** Event codes found (one each), already mapped to their fix (`logs.ts`). */
  readonly events: readonly string[];
  /** Services whose start event (`*.started`) is in the window. */
  readonly started: readonly string[];
}

export interface GitHubAppFact {
  readonly permissions: Readonly<Record<string, string>>;
}

export type RepoFact =
  | {
      readonly repo: string;
      readonly installed: true;
      readonly selection: 'all' | 'selected';
      readonly permissions: Readonly<Record<string, string>>;
    }
  | { readonly repo: string; readonly installed: false };

export type GitHubFact =
  | { readonly ok: true; readonly app: GitHubAppFact; readonly repos: readonly RepoFact[] }
  | { readonly ok: false; readonly error: string };

export interface ProjectImageFact {
  readonly project: string;
  /** The effective `sandbox.image`; null when the stored configuration is not valid. */
  readonly image: string | null;
  /** Present in the local Docker image store; null when not asked. */
  readonly present: boolean | null;
}

export interface OperatorFacts {
  readonly now: Date;
  readonly envFile: {
    readonly path: string;
    readonly exists: boolean;
    readonly mode: number | null;
    readonly facts?: EnvFacts;
    /**
     * A trial stack's key file (V08, `pnpm trial:start`), next to the env file; only for a trial
     * project. `mode` null: there is none. Its content is never read.
     */
    readonly trialKeyFile?: { readonly path: string; readonly mode: number | null };
  };
  /** null: no Docker, or the daemon does not answer. */
  readonly docker: {
    readonly serverVersion: string | null;
    readonly composeVersion: string | null;
    readonly memoryBytes: number | null;
    /**
     * Authorization plugins reported by `docker info` (H07, ADR-M105). Empty: none; null: the
     * field could not be read.
     */
    readonly authorizationPlugins: readonly string[] | null;
  } | null;
  readonly disk: readonly { readonly path: string; readonly freeBytes: number | null }[];
  /**
   * O03 (ADR-M101): the newest complete backup of `backup.sh` in `SDLC_BACKUP_DIR` (a `<UTC time>`
   * folder with `MANIFEST`) and the thresholds. Absent without an env file; `dir` null: not set.
   */
  readonly backup?: {
    readonly dir: string | null;
    readonly readable: boolean;
    /** ISO time of the newest complete backup; null: none. */
    readonly newest: string | null;
    /** `SDLC_BACKUP_WARN_HOURS`, `SDLC_BACKUP_FAIL_HOURS`; NaN: not a whole number of 1 or more. */
    readonly warnHours: number;
    readonly failHours: number;
  };
  /** null: `docker compose ps` failed; empty: nothing of the project runs. */
  readonly services?: readonly ServiceState[] | null;
  readonly openbao?: OpenBaoState;
  readonly tls?: {
    readonly dir: string | null;
    readonly missing: readonly string[];
    readonly certs: readonly CertFact[];
  };
  /** O04 (ADR-M103): each append-only table's bytes with indexes; null: could not be read. */
  readonly tableSizes?: readonly TableSizeFact[] | null;
  /** `applied` null: the table could not be read. */
  readonly migrations?: {
    readonly expected: readonly string[];
    readonly applied: readonly string[] | null;
  };
  readonly approles?: readonly AppRoleFact[];
  /** null: the logs could not be read. */
  readonly logs?: LogFindings | null;
  /** null: could not be read. */
  readonly valkey?: { readonly usedBytes: number; readonly maxBytes: number } | null;
  readonly github?: GitHubFact;
  /** The App manifest's `default_permissions`. */
  readonly manifest: Readonly<Record<string, string>>;
  /** null: could not be read. */
  readonly projects?: readonly ProjectImageFact[] | null;
  readonly imagesMode?: 'local' | 'published' | 'failed';
  readonly access?: AccessFact;
}
