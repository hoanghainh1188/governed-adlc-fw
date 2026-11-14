// Settings of the worker process (task B06, design/ADR-M27 section 2.5). Infrastructure settings
// come from the environment, never from project configuration: the polling interval of each
// project is project configuration (`github.poll_interval_seconds`). No secret is ever read from an
// environment variable: the database password and the GitHub App key come from OpenBao, the
// AppRole credentials from files (ADR-M21). The Temporal settings are technical too (B07, ADR-M30).
import { TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE, type TemporalSettings } from '@sdlc/workflow-client';
import { z } from 'zod';

export const WORKER_ENV = {
  dbHost: 'SDLC_WORKER_DB_HOST',
  dbPort: 'SDLC_WORKER_DB_PORT',
  dbName: 'SDLC_WORKER_DB_NAME',
  dbSecretPath: 'SDLC_WORKER_DB_SECRET_PATH',
  githubApiUrl: 'SDLC_WORKER_GITHUB_API_URL',
  tickMs: 'SDLC_WORKER_TICK_MS',
  maxConcurrentPolls: 'SDLC_WORKER_MAX_CONCURRENT_POLLS',
  maxReplyAttempts: 'SDLC_WORKER_MAX_REPLY_ATTEMPTS',
  maxEventAttempts: 'SDLC_WORKER_MAX_EVENT_ATTEMPTS',
  heartbeatFile: 'SDLC_WORKER_HEARTBEAT_FILE',
  escalationTickMs: 'SDLC_WORKER_ESCALATION_TICK_MS',
  escalationBatch: 'SDLC_WORKER_ESCALATION_BATCH',
  memoryTickMs: 'SDLC_WORKER_MEMORY_TICK_MS',
  temporalAddress: 'SDLC_WORKER_TEMPORAL_ADDRESS',
  temporalNamespace: 'SDLC_WORKER_TEMPORAL_NAMESPACE',
  reconcileMs: 'SDLC_WORKER_RECONCILE_MS',
  reconcileBatch: 'SDLC_WORKER_RECONCILE_BATCH',
  workflowBundle: 'SDLC_WORKER_WORKFLOW_BUNDLE',
  costRoleIdFile: 'SDLC_WORKER_COST_ROLE_ID_FILE',
  costSecretIdFile: 'SDLC_WORKER_COST_SECRET_ID_FILE',
  costMasterKeyPath: 'SDLC_WORKER_COST_MASTER_KEY_PATH',
  litellmUrl: 'SDLC_WORKER_LITELLM_URL',
  runEgress: 'SDLC_WORKER_RUN_EGRESS',
  costSyncIntervalSeconds: 'SDLC_WORKER_COST_SYNC_INTERVAL_SECONDS',
  costSyncLookbackMinutes: 'SDLC_WORKER_COST_SYNC_LOOKBACK_MINUTES',
  costSyncCatchUpMinutes: 'SDLC_WORKER_COST_SYNC_CATCH_UP_MINUTES',
  costSyncSettleMinutes: 'SDLC_WORKER_COST_SYNC_SETTLE_MINUTES',
  evalTickSeconds: 'SDLC_WORKER_EVAL_TICK_SECONDS',
  evalTasksDir: 'SDLC_EVAL_TASKS_DIR',
  evalMaxInFlight: 'SDLC_WORKER_EVAL_MAX_IN_FLIGHT',
  evidenceUrl: 'SDLC_WORKER_EVIDENCE_URL',
  evidenceBucket: 'SDLC_WORKER_EVIDENCE_BUCKET',
  evidenceSecretPath: 'SDLC_WORKER_EVIDENCE_SECRET_PATH',
  evidenceMaxItemMb: 'SDLC_WORKER_EVIDENCE_MAX_ITEM_MB',
  retentionUrl: 'SDLC_WORKER_RETENTION_URL',
  retentionBucket: 'SDLC_WORKER_RETENTION_BUCKET',
  retentionSecretPath: 'SDLC_WORKER_RETENTION_SECRET_PATH',
  retentionMode: 'SDLC_WORKER_RETENTION_MODE',
  retentionIntervalMinutes: 'SDLC_WORKER_RETENTION_INTERVAL_MINUTES',
  retentionBatch: 'SDLC_WORKER_RETENTION_BATCH',
  retentionGuardPercent: 'SDLC_WORKER_RETENTION_GUARD_PERCENT',
  retentionGuardFloor: 'SDLC_WORKER_RETENTION_GUARD_FLOOR',
  retentionArchiveGraceDays: 'SDLC_WORKER_RETENTION_ARCHIVE_GRACE_DAYS',
  retentionOrphanGraceHours: 'SDLC_WORKER_RETENTION_ORPHAN_GRACE_HOURS',
  clientDeletionGraceDays: 'SDLC_CLIENT_DELETION_GRACE_DAYS',
  housekeepingMode: 'SDLC_WORKER_HOUSEKEEPING_MODE',
  sessionKeepDays: 'SDLC_WORKER_SESSION_KEEP_DAYS',
  challengeKeepHours: 'SDLC_WORKER_CHALLENGE_KEEP_HOURS',
  anchorUrl: 'SDLC_WORKER_ANCHOR_URL',
  anchorBucket: 'SDLC_WORKER_ANCHOR_BUCKET',
  anchorSecretPath: 'SDLC_WORKER_ANCHOR_SECRET_PATH',
  knowledgeDbUrl: 'SDLC_WORKER_KNOWLEDGE_DB_URL',
  knowledgeSecretPath: 'SDLC_WORKER_KNOWLEDGE_SECRET_PATH',
  langfuseUrl: 'SDLC_WORKER_LANGFUSE_URL',
  langfuseSecretPath: 'SDLC_WORKER_LANGFUSE_SECRET_PATH',
  langfuseProjectId: 'SDLC_WORKER_LANGFUSE_PROJECT_ID',
  langfuseClickhouseUrl: 'SDLC_WORKER_LANGFUSE_CLICKHOUSE_URL',
  langfuseBatch: 'SDLC_WORKER_LANGFUSE_BATCH',
  langfuseRawUrl: 'SDLC_WORKER_LANGFUSE_RAW_URL',
  langfuseRawBucket: 'SDLC_WORKER_LANGFUSE_RAW_BUCKET',
  langfuseRawMaxAgeHours: 'SDLC_WORKER_LANGFUSE_RAW_MAX_AGE_HOURS',
  langfuseRawBatch: 'SDLC_WORKER_LANGFUSE_RAW_BATCH',
  devMode: 'SDLC_WORKER_DEV_MODE',
  devDbUrl: 'SDLC_WORKER_DEV_DB_URL',
} as const;

/** The database role of every platform process (ADR-M09 section 2.3). */
export const DB_USER = 'platform_app';

const port = z.coerce.number().int().min(1).max(65_535);

const schema = z.object({
  [WORKER_ENV.dbHost]: z.string().min(1).default('postgres'),
  [WORKER_ENV.dbPort]: port.default(5432),
  [WORKER_ENV.dbName]: z
    .string()
    .regex(/^[a-z_][a-z0-9_]{0,62}$/)
    .default('platform'),
  // Path in the KV engine; the `worker` AppRole may read `kv/data/worker/*` only (ADR-M19 §2.4).
  [WORKER_ENV.dbSecretPath]: z
    .string()
    .regex(/^worker\/[A-Za-z0-9_.-]+$/)
    .default('worker/database'),
  [WORKER_ENV.githubApiUrl]: z
    .string()
    .regex(/^https:\/\/[^\s]+$/)
    .default('https://api.github.com'),
  [WORKER_ENV.tickMs]: z.coerce.number().int().min(100).max(60_000).default(1000),
  [WORKER_ENV.maxConcurrentPolls]: z.coerce.number().int().min(1).max(32).default(4),
  [WORKER_ENV.maxReplyAttempts]: z.coerce.number().int().min(1).max(100).default(5),
  [WORKER_ENV.maxEventAttempts]: z.coerce.number().int().min(1).max(20).default(3),
  [WORKER_ENV.heartbeatFile]: z.string().min(1).default('/tmp/sdlc-worker.heartbeat'),
  // The shortest SLA clock is minutes long (codes table §6.3), so 15 s is precise enough.
  [WORKER_ENV.escalationTickMs]: z.coerce.number().int().min(1000).max(300_000).default(15_000),
  [WORKER_ENV.escalationBatch]: z.coerce.number().int().min(1).max(1000).default(100),
  // X13 PR 3b: the memory loop (ADR-M74 §2.5); a memory pull request is never urgent.
  [WORKER_ENV.memoryTickMs]: z.coerce.number().int().min(10_000).max(3_600_000).default(300_000),
  // `off` runs the worker without the intent workflow: development mode only.
  [WORKER_ENV.temporalAddress]: z
    .string()
    .refine((v) => v === 'off' || TEMPORAL_ADDRESS.test(v))
    .default('temporal:7233'),
  [WORKER_ENV.temporalNamespace]: z.string().regex(TEMPORAL_NAMESPACE).default('default'),
  // A lost wake signal is caught up within this time (ADR-M30 §2.3).
  [WORKER_ENV.reconcileMs]: z.coerce.number().int().min(10_000).max(86_400_000).default(600_000),
  [WORKER_ENV.reconcileBatch]: z.coerce.number().int().min(1).max(5000).default(500),
  // Set in the image: the workflow bundle made at build time (ADR-M30 §2.1).
  [WORKER_ENV.workflowBundle]: z
    .string()
    .regex(/^\/[^\s]+\.js$/)
    .optional(),
  // C06 session 2 (ADR-M33 §2.5, QUESTIONS #112): the second AppRole `cost-controller`, whose
  // files the bootstrap delivers with the worker's. Both set: the worker runs agent runs.
  [WORKER_ENV.costRoleIdFile]: z
    .string()
    .regex(/^\/[^\s]+$/)
    .optional(),
  [WORKER_ENV.costSecretIdFile]: z
    .string()
    .regex(/^\/[^\s]+$/)
    .optional(),
  // The `cost-controller` AppRole reads `kv/data/cost-controller/*` only (ADR-M24).
  [WORKER_ENV.costMasterKeyPath]: z
    .string()
    .regex(/^cost-controller\/[A-Za-z0-9_.-]+$/)
    .default('cost-controller/litellm-master-key'),
  [WORKER_ENV.litellmUrl]: z
    .string()
    .regex(/^https?:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/)
    .default('http://litellm:4000'),
  // Services a sandbox may reach, `alias:port` (ADR-M25 §2.2): the Run Contract's egress list.
  [WORKER_ENV.runEgress]: z
    .string()
    .regex(/^[a-z][a-z0-9-]*:[0-9]{1,5}(,[a-z][a-z0-9-]*:[0-9]{1,5})*$/)
    .default('litellm:4000,npm-proxy:4873'),
  // C12 (ADR-M24 §2.5): the scheduled spend sync. LiteLLM writes spend logs in batches, so each
  // pass reads back over a look-back window; the first pass after a start reads the catch-up window.
  [WORKER_ENV.costSyncIntervalSeconds]: z.coerce.number().int().min(30).max(3600).default(300),
  [WORKER_ENV.costSyncLookbackMinutes]: z.coerce.number().int().min(10).max(1440).default(120),
  [WORKER_ENV.costSyncCatchUpMinutes]: z.coerce.number().int().min(10).max(10_080).default(1440),
  [WORKER_ENV.costSyncSettleMinutes]: z.coerce.number().int().min(5).max(1440).default(30),
  [WORKER_ENV.evalTickSeconds]: z.coerce.number().int().min(5).max(300).default(15),
  // L05: the task sets the plan loop checks a plan against (the image's copy of task set v1).
  [WORKER_ENV.evalTasksDir]: z.string().min(1).max(4096).default('/app/eval-tasks'),
  [WORKER_ENV.evalMaxInFlight]: z.coerce.number().int().min(1).max(16).default(2),
  // E03 (ADR-M49 §2.2): the evidence store for G8's release pack, SeaweedFS's S3 API on the
  // Compose network; `off`: intents wait at G8. An origin only.
  [WORKER_ENV.evidenceUrl]: z
    .string()
    .refine((v) => v === 'off' || isOrigin(v))
    .default('http://seaweedfs:8333'),
  [WORKER_ENV.evidenceBucket]: z
    .string()
    .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/)
    .default('evidence'),
  // The `worker` AppRole reads `kv/data/worker/*` only.
  [WORKER_ENV.evidenceSecretPath]: z
    .string()
    .regex(/^worker\/[A-Za-z0-9_.-]+$/)
    .default('worker/evidence'),
  // The largest evidence file the worker reads back to check its hash, one file at a time.
  [WORKER_ENV.evidenceMaxItemMb]: z.coerce.number().int().min(1).max(4096).default(256),
  // E05 (ADR-M51): the retention loop with the purge identity `worker-purge` (`kv/worker/purge`).
  // `off`: no retention loop. Mode `report` (default) counts and deletes nothing; `purge` deletes.
  [WORKER_ENV.retentionUrl]: z
    .string()
    .refine((v) => v === 'off' || isOrigin(v))
    .default('http://seaweedfs:8333'),
  [WORKER_ENV.retentionBucket]: z
    .string()
    .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/)
    .default('evidence'),
  [WORKER_ENV.retentionSecretPath]: z
    .string()
    .regex(/^worker\/[A-Za-z0-9_.-]+$/)
    .default('worker/purge'),
  [WORKER_ENV.retentionMode]: z.enum(['report', 'purge']).default('report'),
  [WORKER_ENV.retentionIntervalMinutes]: z.coerce.number().int().min(5).max(1440).default(60),
  [WORKER_ENV.retentionBatch]: z.coerce.number().int().min(1).max(5000).default(200),
  // The guard: one pass purges at most this share of a tenant's stored rows for retention, or the
  // floor when larger (ADR-M51 §2.4). Archive purges are not counted.
  [WORKER_ENV.retentionGuardPercent]: z.coerce.number().int().min(1).max(100).default(20),
  [WORKER_ENV.retentionGuardFloor]: z.coerce.number().int().min(0).max(100_000).default(20),
  // Days after `project.archived` before its evidence is purged: a mistaken archive is noticed first.
  [WORKER_ENV.retentionArchiveGraceDays]: z.coerce.number().int().min(1).max(365).default(7),
  [WORKER_ENV.retentionOrphanGraceHours]: z.coerce.number().int().min(24).max(720).default(24),
  // H03b (ADR-M97 §2.4): grace after `client_data.deletion_approved` before the physical purge.
  [WORKER_ENV.clientDeletionGraceDays]: z.coerce.number().int().min(1).max(365).default(14),
  // O04 (ADR-M103): ended web sessions and used or expired passkey challenges, removed in the
  // retention loop at its interval. Needs only the database. The floors are the database's own
  // (migration 0046): 7 days and 1 hour.
  [WORKER_ENV.housekeepingMode]: z.enum(['off', 'report', 'remove']).default('remove'),
  [WORKER_ENV.sessionKeepDays]: z.coerce.number().int().min(7).max(3650).default(30),
  [WORKER_ENV.challengeKeepHours]: z.coerce.number().int().min(1).max(720).default(24),
  // E05 PR 2 (ADR-M51 §2.9): the daily audit anchor with the identity `worker-anchor`
  // (`kv/worker/anchor`) in the bucket `audit-anchors` (COMPLIANCE). `off`: no anchors. It runs in
  // the retention loop, at its interval.
  [WORKER_ENV.anchorUrl]: z
    .string()
    .refine((v) => v === 'off' || isOrigin(v))
    .default('http://seaweedfs:8333'),
  [WORKER_ENV.anchorBucket]: z
    .string()
    .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/)
    .default('audit-anchors'),
  [WORKER_ENV.anchorSecretPath]: z
    .string()
    .regex(/^worker\/[A-Za-z0-9_.-]+$/)
    .default('worker/anchor'),
  // E08 (ADR-M53): the Langfuse purge in the retention loop, with `kv/worker/langfuse` (the
  // worker's own Langfuse key, the ClickHouse user `sdlc_purge`, the SeaweedFS identity
  // `worker-langfuse`). `off` (default): Langfuse is not deployed; `project.purged` records
  // `not_deployed`. up.sh sets it with the profile observability.
  // X04 PR 3a (ADR-M89 §2.1): `knowledge-db` (profile `knowledge`) as a URL without a password,
  // for example `postgresql://knowledge@knowledge-db:5432/knowledge`; the password is in OpenBao
  // (`kv/worker/knowledge-db`, field `password`). `off`: no index, so no `read_documents` tool runs.
  [WORKER_ENV.knowledgeDbUrl]: z
    .string()
    .refine((v) => v === 'off' || isKnowledgeUrl(v))
    .default('off'),
  [WORKER_ENV.knowledgeSecretPath]: z
    .string()
    .regex(/^worker\/[A-Za-z0-9_.-]+$/)
    .default('worker/knowledge-db'),
  [WORKER_ENV.langfuseUrl]: z
    .string()
    .refine((v) => v === 'off' || isOrigin(v))
    .default('off'),
  [WORKER_ENV.langfuseSecretPath]: z
    .string()
    .regex(/^worker\/[A-Za-z0-9_.-]+$/)
    .default('worker/langfuse'),
  // The Langfuse project the collector writes to (`LANGFUSE_INIT_PROJECT_ID`): the worker's key must
  // belong to it, or no Langfuse step runs (an empty answer of another project proves nothing).
  [WORKER_ENV.langfuseProjectId]: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,128}$/)
    .default('sdlc-platform'),
  [WORKER_ENV.langfuseClickhouseUrl]: z
    .string()
    .refine((v) => isOrigin(v))
    .default('http://clickhouse:8123'),
  // Intents per project and pass whose traces are selected, at most.
  [WORKER_ENV.langfuseBatch]: z.coerce.number().int().min(1).max(1000).default(50),
  // The raw OTLP files Langfuse keeps in SeaweedFS (bucket `langfuse`, `events/otel/`): swept for
  // every tenant when older than the maximum age (D1, QUESTIONS #250). At most `_RAW_BATCH` per pass.
  [WORKER_ENV.langfuseRawUrl]: z
    .string()
    .refine((v) => isOrigin(v))
    .default('http://seaweedfs:8333'),
  [WORKER_ENV.langfuseRawBucket]: z
    .string()
    .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/)
    .default('langfuse'),
  [WORKER_ENV.langfuseRawMaxAgeHours]: z.coerce.number().int().min(1).max(720).default(24),
  [WORKER_ENV.langfuseRawBatch]: z.coerce.number().int().min(1).max(20_000).default(2000),
  [WORKER_ENV.devMode]: z.enum(['', '0', '1']).default(''),
  [WORKER_ENV.devDbUrl]: z.string().optional(),
  NODE_ENV: z.string().optional(),
});

/** `postgresql://<user>@<host>:<port>/<database>`: a user, no password, no query. */
function isKnowledgeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'postgresql:' &&
      url.hostname !== '' &&
      /^[a-z][a-z0-9_]{0,62}$/.test(url.username) &&
      url.password === '' &&
      /^\/[a-z][a-z0-9_]{0,62}$/.test(url.pathname) &&
      url.search === '' &&
      url.hash === ''
    );
  } catch {
    return false;
  }
}

function isOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      url.username === '' &&
      url.password === '' &&
      url.pathname === '/' &&
      url.search === '' &&
      url.hash === '' &&
      !value.endsWith('#') &&
      !value.endsWith('?')
    );
  } catch {
    return false;
  }
}

/** E05: the retention loop (ADR-M51). */
export interface WorkerRetentionSettings {
  readonly url: string;
  readonly bucket: string;
  readonly secretPath: string;
  readonly mode: 'report' | 'purge';
  readonly intervalMs: number;
  readonly batch: number;
  readonly guardPercent: number;
  readonly guardFloor: number;
  readonly archiveGraceDays: number;
  readonly orphanGraceHours: number;
  /** Days after `client_data.deletion_approved` before H03b may purge (ADR-M97). */
  readonly clientDeletionGraceDays: number;
}

/** O04: housekeeping of the session tables (ADR-M103), in the retention loop. */
export interface WorkerHousekeepingSettings {
  readonly mode: 'report' | 'remove';
  readonly sessionDays: number;
  readonly challengeHours: number;
  /** The retention loop's interval. */
  readonly intervalMs: number;
}

/** E05 PR 2: the daily audit anchor (ADR-M51 §2.9). */
export interface WorkerAnchorSettings {
  readonly url: string;
  readonly bucket: string;
  readonly secretPath: string;
  /** The retention loop's interval: the anchor pass runs in it. */
  readonly intervalMs: number;
}

/** E08: the Langfuse purge in the retention loop (ADR-M53). */
/** X04 PR 3a: `knowledge-db` (ADR-M89 §2.1); null when off. */
export interface WorkerKnowledgeSettings {
  /** Without the password. */
  readonly url: string;
  /** The KV entry with the field `password`. */
  readonly secretPath: string;
}

export interface WorkerLangfuseSettings {
  readonly url: string;
  readonly secretPath: string;
  readonly projectId: string;
  readonly clickhouseUrl: string;
  readonly batch: number;
  readonly rawUrl: string;
  readonly rawBucket: string;
  readonly rawMaxAgeHours: number;
  readonly rawBatch: number;
}

/** E03: the worker's evidence store (ADR-M49 §2.2). */
export interface WorkerEvidenceSettings {
  readonly url: string;
  readonly bucket: string;
  readonly secretPath: string;
  readonly maxItemBytes: number;
}

export type WorkerDatabase =
  | {
      readonly kind: 'openbao';
      readonly host: string;
      readonly port: number;
      readonly name: string;
      readonly secretPath: string;
    }
  | { readonly kind: 'dev_url'; readonly url: string };

/** C06 session 2: what the worker needs to run agents; null when the cost AppRole is not set. */
export interface WorkerRunSettings {
  readonly costRoleIdFile: string;
  readonly costSecretIdFile: string;
  readonly costMasterKeyPath: string;
  readonly litellmUrl: string;
  readonly egressAllowlist: readonly string[];
}

/** C12: the scheduled spend sync (ADR-M24 §2.5). Technical settings, all in milliseconds. */
export interface CostSyncSettings {
  /** Time between two passes. */
  readonly intervalMs: number;
  /** Each pass syncs at least the calls of this window before now. */
  readonly lookbackMs: number;
  /** The first pass after a start, and the oldest a retry reaches back. */
  readonly catchUpMs: number;
  /** Runs that ended within this window are synced again from their start. */
  readonly settleMs: number;
}

/** L04 (ADR-M81 §2.8): the evaluation loop. Technical settings. */
export interface EvaluationLoopSettings {
  /** Time between two passes. */
  readonly tickMs: number;
  /** Runs handed to the runner at most at one time (running, or waiting for a slot there). */
  readonly maxInFlight: number;
  /** L05: the task set folder the plan loop reads (versions, commit, task IDs). */
  readonly tasksDir: string;
}

export interface WorkerSettings {
  readonly database: WorkerDatabase;
  readonly githubApiUrl: string;
  /** How often the loop checks which projects are due (not the polling interval). */
  readonly tickMs: number;
  readonly maxConcurrentPolls: number;
  readonly maxReplyAttempts: number;
  /** Failed attempts before an event is given up (`failed_internal`, ADR-M27 §2.2). */
  readonly maxEventAttempts: number;
  readonly heartbeatFile: string;
  /** How often the escalation clock loop runs (B11, ADR-M28 §2.2). Technical, not a handbook rule. */
  readonly escalationTickMs: number;
  /** Escalations advanced per tick at most. */
  readonly escalationBatch: number;
  /** How often the memory loop runs (X13 PR 3b, ADR-M74 §2.5). Technical, not a handbook rule. */
  readonly memoryTickMs: number;
  /** The Temporal frontend of the intent workflow (B07); null: no workflow (development only). */
  readonly temporal: TemporalSettings | null;
  /** How often every open intent's workflow is woken, to catch up a lost signal (B07). */
  readonly reconcileMs: number;
  /** Intents read per page by the reconcile loop. */
  readonly reconcileBatch: number;
  /** Absolute path of the prebuilt workflow bundle; null: bundle at start-up. */
  readonly workflowBundle: string | null;
  /** C06 session 2: agent runs (G4, the handoff to the runner); null: G4 waits. */
  readonly runs: WorkerRunSettings | null;
  /** C12: the scheduled spend sync; it runs when `runs` is set (the cost-controller AppRole). */
  readonly costSync: CostSyncSettings;
  /** L04: the evaluation loop; it runs when `runs` is set (it needs the Cost Controller). */
  readonly evaluation: EvaluationLoopSettings;
  /** E03: the evidence store for G8's release pack; null: `SDLC_WORKER_EVIDENCE_URL=off`. */
  readonly evidence: WorkerEvidenceSettings | null;
  /** E05: the retention loop; null: `SDLC_WORKER_RETENTION_URL=off`. */
  readonly retention: WorkerRetentionSettings | null;
  /** E05 PR 2: the daily audit anchor; null: `SDLC_WORKER_ANCHOR_URL=off`. */
  readonly anchor: WorkerAnchorSettings | null;
  /** O04: the session tables; null: `SDLC_WORKER_HOUSEKEEPING_MODE=off`. */
  readonly housekeeping: WorkerHousekeepingSettings | null;
  /** E08: the Langfuse purge; null: `SDLC_WORKER_LANGFUSE_URL=off` (not deployed). */
  readonly langfuse: WorkerLangfuseSettings | null;
  readonly knowledge: WorkerKnowledgeSettings | null;
}

export type WorkerSettingsKey =
  | 'worker.settings.invalid'
  | 'worker.settings.dev_mode_in_production'
  | 'worker.settings.dev_url_missing'
  | 'worker.settings.temporal_off_in_production'
  | 'worker.settings.cost_role_incomplete';

/** A setting is missing or wrong. `key` is a message catalog key; `setting` the variable. */
export class SettingsError extends Error {
  override readonly name = 'SettingsError';

  constructor(
    readonly key: WorkerSettingsKey,
    readonly setting: string,
  ) {
    super(`${key}: ${setting}`);
  }
}

export function loadSettings(env: Readonly<Record<string, string | undefined>>): WorkerSettings {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new SettingsError(
      'worker.settings.invalid',
      String(parsed.error.issues[0]?.path[0] ?? ''),
    );
  }
  const v = parsed.data;
  const dev = v[WORKER_ENV.devMode] === '1';
  if (dev && v.NODE_ENV === 'production') {
    throw new SettingsError('worker.settings.dev_mode_in_production', WORKER_ENV.devMode);
  }
  const temporalOff = v[WORKER_ENV.temporalAddress] === 'off';
  if (temporalOff && !dev) {
    throw new SettingsError(
      'worker.settings.temporal_off_in_production',
      WORKER_ENV.temporalAddress,
    );
  }
  const roleId = v[WORKER_ENV.costRoleIdFile];
  const secretId = v[WORKER_ENV.costSecretIdFile];
  if ((roleId === undefined) !== (secretId === undefined)) {
    throw new SettingsError(
      'worker.settings.cost_role_incomplete',
      roleId === undefined ? WORKER_ENV.costRoleIdFile : WORKER_ENV.costSecretIdFile,
    );
  }
  const intervalSeconds = v[WORKER_ENV.costSyncIntervalSeconds];
  const lookbackMinutes = v[WORKER_ENV.costSyncLookbackMinutes];
  const catchUpMinutes = v[WORKER_ENV.costSyncCatchUpMinutes];
  // Two passes at least inside every window, so one failed pass loses nothing.
  if (lookbackMinutes * 60 < 2 * intervalSeconds) {
    throw new SettingsError('worker.settings.invalid', WORKER_ENV.costSyncLookbackMinutes);
  }
  if (catchUpMinutes < lookbackMinutes) {
    throw new SettingsError('worker.settings.invalid', WORKER_ENV.costSyncCatchUpMinutes);
  }
  let database: WorkerDatabase;
  if (dev) {
    const url = v[WORKER_ENV.devDbUrl];
    if (!url) throw new SettingsError('worker.settings.dev_url_missing', WORKER_ENV.devDbUrl);
    database = { kind: 'dev_url', url };
  } else {
    database = {
      kind: 'openbao',
      host: v[WORKER_ENV.dbHost],
      port: v[WORKER_ENV.dbPort],
      name: v[WORKER_ENV.dbName],
      secretPath: v[WORKER_ENV.dbSecretPath],
    };
  }
  return {
    database,
    githubApiUrl: v[WORKER_ENV.githubApiUrl],
    tickMs: v[WORKER_ENV.tickMs],
    maxConcurrentPolls: v[WORKER_ENV.maxConcurrentPolls],
    maxReplyAttempts: v[WORKER_ENV.maxReplyAttempts],
    maxEventAttempts: v[WORKER_ENV.maxEventAttempts],
    heartbeatFile: v[WORKER_ENV.heartbeatFile],
    escalationTickMs: v[WORKER_ENV.escalationTickMs],
    escalationBatch: v[WORKER_ENV.escalationBatch],
    memoryTickMs: v[WORKER_ENV.memoryTickMs],
    temporal: temporalOff
      ? null
      : {
          address: v[WORKER_ENV.temporalAddress],
          namespace: v[WORKER_ENV.temporalNamespace],
        },
    reconcileMs: v[WORKER_ENV.reconcileMs],
    reconcileBatch: v[WORKER_ENV.reconcileBatch],
    workflowBundle: v[WORKER_ENV.workflowBundle] ?? null,
    runs:
      roleId === undefined || secretId === undefined || temporalOff
        ? null
        : {
            costRoleIdFile: roleId,
            costSecretIdFile: secretId,
            costMasterKeyPath: v[WORKER_ENV.costMasterKeyPath],
            litellmUrl: v[WORKER_ENV.litellmUrl],
            egressAllowlist: v[WORKER_ENV.runEgress].split(','),
          },
    costSync: {
      intervalMs: intervalSeconds * 1000,
      lookbackMs: lookbackMinutes * 60_000,
      catchUpMs: catchUpMinutes * 60_000,
      settleMs: v[WORKER_ENV.costSyncSettleMinutes] * 60_000,
    },
    evaluation: {
      tickMs: v[WORKER_ENV.evalTickSeconds] * 1000,
      maxInFlight: v[WORKER_ENV.evalMaxInFlight],
      tasksDir: v[WORKER_ENV.evalTasksDir],
    },
    evidence:
      v[WORKER_ENV.evidenceUrl] === 'off'
        ? null
        : {
            url: new URL(v[WORKER_ENV.evidenceUrl]).origin,
            bucket: v[WORKER_ENV.evidenceBucket],
            secretPath: v[WORKER_ENV.evidenceSecretPath],
            maxItemBytes: v[WORKER_ENV.evidenceMaxItemMb] * 1024 * 1024,
          },
    retention:
      v[WORKER_ENV.retentionUrl] === 'off'
        ? null
        : {
            url: new URL(v[WORKER_ENV.retentionUrl]).origin,
            bucket: v[WORKER_ENV.retentionBucket],
            secretPath: v[WORKER_ENV.retentionSecretPath],
            mode: v[WORKER_ENV.retentionMode],
            intervalMs: v[WORKER_ENV.retentionIntervalMinutes] * 60_000,
            batch: v[WORKER_ENV.retentionBatch],
            guardPercent: v[WORKER_ENV.retentionGuardPercent],
            guardFloor: v[WORKER_ENV.retentionGuardFloor],
            archiveGraceDays: v[WORKER_ENV.retentionArchiveGraceDays],
            orphanGraceHours: v[WORKER_ENV.retentionOrphanGraceHours],
            clientDeletionGraceDays: v[WORKER_ENV.clientDeletionGraceDays],
          },
    anchor:
      v[WORKER_ENV.anchorUrl] === 'off'
        ? null
        : {
            url: new URL(v[WORKER_ENV.anchorUrl]).origin,
            bucket: v[WORKER_ENV.anchorBucket],
            secretPath: v[WORKER_ENV.anchorSecretPath],
            intervalMs: v[WORKER_ENV.retentionIntervalMinutes] * 60_000,
          },
    housekeeping:
      v[WORKER_ENV.housekeepingMode] === 'off'
        ? null
        : {
            mode: v[WORKER_ENV.housekeepingMode] === 'report' ? 'report' : 'remove',
            sessionDays: v[WORKER_ENV.sessionKeepDays],
            challengeHours: v[WORKER_ENV.challengeKeepHours],
            intervalMs: v[WORKER_ENV.retentionIntervalMinutes] * 60_000,
          },
    knowledge:
      v[WORKER_ENV.knowledgeDbUrl] === 'off'
        ? null
        : { url: v[WORKER_ENV.knowledgeDbUrl], secretPath: v[WORKER_ENV.knowledgeSecretPath] },
    langfuse:
      v[WORKER_ENV.langfuseUrl] === 'off'
        ? null
        : {
            url: new URL(v[WORKER_ENV.langfuseUrl]).origin,
            secretPath: v[WORKER_ENV.langfuseSecretPath],
            projectId: v[WORKER_ENV.langfuseProjectId],
            clickhouseUrl: new URL(v[WORKER_ENV.langfuseClickhouseUrl]).origin,
            batch: v[WORKER_ENV.langfuseBatch],
            rawUrl: new URL(v[WORKER_ENV.langfuseRawUrl]).origin,
            rawBucket: v[WORKER_ENV.langfuseRawBucket],
            rawMaxAgeHours: v[WORKER_ENV.langfuseRawMaxAgeHours],
            rawBatch: v[WORKER_ENV.langfuseRawBatch],
          },
  };
}
