// The only commands `pnpm doctor` may run (D-08 V07 AC3: read only). `host.ts` builds every
// command here, and `exec.ts` refuses anything `isAllowed` does not accept. Never add a command
// that writes: no `up`, `down`, `start`, `stop`, `restart`, `rm`, `run`, `build`, `pull`,
// `prune`, `volume`/`network` changes, no OpenBao command other than `status`, no SQL that writes
// (the psql session is read only). Test `platform/tests/doctor/host-readonly.test.ts`.

/** Profiles passed to `docker compose ps|logs|exec`, so every service of the project is seen. */
export const PROFILES = [
  'core',
  'observability',
  'models',
  'platform',
  'sandbox',
  'backup',
] as const;

/** AppRole credential folders: service → folder in the service, credentials command. */
export const APPROLE_FOLDERS: readonly {
  readonly service: string;
  readonly folder: string;
  readonly credentials: string;
}[] = [
  { service: 'sdlc-api', folder: '/run/sdlc/approle', credentials: 'api-credentials' },
  { service: 'sdlc-worker', folder: '/run/sdlc/approle', credentials: 'worker-credentials' },
  { service: 'sdlc-worker', folder: '/run/sdlc/cost-approle', credentials: 'worker-credentials' },
  { service: 'sdlc-runner', folder: '/run/sdlc/approle', credentials: 'runner-credentials' },
  { service: 'litellm-agent', folder: '/openbao/approle', credentials: 'litellm-credentials' },
];

/**
 * Prints `missing`, `unreadable` or the modification time (epoch seconds) of the secret ID file.
 * The folder is `$1`, never part of the script text. Reads no file content.
 */
export const APPROLE_SCRIPT =
  'test -s "$1/role_id" && test -s "$1/secret_id" || { echo missing; exit 0; }; ' +
  'stat -c %Y "$1/secret_id" 2>/dev/null || echo unreadable';

/** The two read-only queries (`-c` each), in a read-only transaction (`PGOPTIONS`). */
export const SQL_MIGRATIONS =
  "select coalesce(json_agg(name order by name), '[]'::json) from kysely_migration";
export const SQL_PROJECTS =
  "select coalesce(json_agg(json_build_object('project', t.slug || '/' || p.slug, 'config', " +
  "c.config_yaml) order by t.slug, p.slug), '[]'::json) from projects p join tenants t on " +
  't.id = p.tenant_id left join project_configs c on c.tenant_id = p.tenant_id and ' +
  "c.project_id = p.id where p.status = 'active'";
/**
 * O04 (ADR-M103): the size of each append-only table with its indexes. Names and byte counts
 * only. A plain table counts itself; a partitioned table the sum over its partition tree
 * (`pg_partition_tree`), and partitions are not listed on their own. The list
 * equals the one of `platform/tests/db/append-only.test.ts` (a test checks it).
 */
export const APPEND_ONLY_TABLES = [
  'audit_log',
  'gate_decisions',
  'run_events',
  'cost_records',
  'project_ai_record_versions',
  'agent_approvals',
  'tool_approvals',
  'evaluation_run_contracts',
  'evaluation_run_results',
  'evaluation_plan_versions',
  'evaluation_configurations',
  'evaluation_task_decisions',
  'evaluation_task_check_contracts',
  'knowledge_index_uses',
  'project_memory_versions',
  'project_memory_revocations',
  'intent_lessons',
  'intent_lesson_outcomes',
] as const;
export const SQL_TABLE_SIZES =
  "select coalesce(json_agg(json_build_object('table', c.relname, 'bytes', case c.relkind " +
  "when 'p' then (select coalesce(sum(pg_total_relation_size(t.relid)), 0)::bigint from " +
  'pg_partition_tree(c.oid) t) else pg_total_relation_size(c.oid) end) order by c.relname), ' +
  "'[]'::json) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in " +
  "('r', 'p') and not c.relispartition and c.relname in (" +
  APPEND_ONLY_TABLES.map((t) => `'${t}'`).join(', ') +
  ')';
export const PG_READ_ONLY = 'PGOPTIONS=-c default_transaction_read_only=on';

export const VALKEY_SCRIPT = 'REDISCLI_AUTH="$VALKEY_PASSWORD" valkey-cli info memory';

export const WORKER_GITHUB = ['node', '/app/dist/doctor-github.js'] as const;

/** A pinned image reference (`sandbox.image`), safe as one argument. */
export const PINNED_IMAGE = /^[a-z0-9][a-z0-9._/:-]{0,255}@sha256:[0-9a-f]{64}$/;

export interface ComposeTarget {
  readonly composeFile: string;
  readonly envFile: string;
  readonly project: string;
}

const LOG_SERVICES = ['sdlc-api', 'sdlc-worker', 'sdlc-runner'] as const;

function compose(target: ComposeTarget, ...rest: string[]): string[] {
  return [
    'docker',
    'compose',
    '-f',
    target.composeFile,
    '--env-file',
    target.envFile,
    '-p',
    target.project,
    ...PROFILES.flatMap((p) => ['--profile', p]),
    ...rest,
  ];
}

export const commands = {
  dockerVersion: () => ['docker', 'version', '--format', '{{.Server.Version}}'],
  dockerMemory: () => ['docker', 'info', '--format', '{{.MemTotal}}'],
  /** JSON array of AuthZ plugin names, or `null` / empty when none (H07, ADR-M105). */
  dockerAuthz: () => ['docker', 'info', '--format', '{{json .Plugins.Authorization}}'],
  composeVersion: () => ['docker', 'compose', 'version', '--short'],
  imageInspect: (ref: string) => ['docker', 'image', 'inspect', '--format', '{{.Id}}', ref],
  ps: (t: ComposeTarget) => compose(t, 'ps', '--all', '--format', 'json'),
  logs: (t: ComposeTarget) =>
    compose(t, 'logs', '--since', '24h', '--no-color', '--no-log-prefix', ...LOG_SERVICES),
  approle: (t: ComposeTarget, service: string, folder: string) =>
    compose(t, 'exec', '-T', service, 'sh', '-c', APPROLE_SCRIPT, 'doctor', folder),
  psql: (t: ComposeTarget, sql: string) =>
    compose(
      t,
      'exec',
      '-T',
      '-e',
      PG_READ_ONLY,
      'postgres',
      'psql',
      '-U',
      'platform',
      '-d',
      'platform',
      '-At',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      sql,
    ),
  valkey: (t: ComposeTarget) => compose(t, 'exec', '-T', 'valkey', 'sh', '-c', VALKEY_SCRIPT),
  workerGitHub: (t: ComposeTarget) => compose(t, 'exec', '-T', 'sdlc-worker', ...WORKER_GITHUB),
  openbaoStatus: (bootstrapScript: string) => [bootstrapScript, 'status'],
  imagesMode: (imagesScript: string) => [imagesScript, 'mode'],
};

function same(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * True only for a command `commands` builds with allowed arguments: the fixed forms above, an
 * AppRole folder of `APPROLE_FOLDERS`, one of the two queries, a pinned image, the two scripts.
 */
export function isAllowed(
  argv: readonly string[],
  scripts: { bootstrap: string; images: string },
): boolean {
  const [cmd, ...rest] = argv;
  if (cmd === scripts.bootstrap) return same(rest, ['status']);
  if (cmd === scripts.images) return same(rest, ['mode']);
  if (cmd !== 'docker') return false;
  if (
    same(argv, commands.dockerVersion()) ||
    same(argv, commands.dockerMemory()) ||
    same(argv, commands.dockerAuthz())
  ) {
    return true;
  }
  if (same(argv, commands.composeVersion())) return true;
  if (argv[1] === 'image') {
    return (
      argv.length === 6 &&
      same(argv.slice(0, 5), commands.imageInspect('x').slice(0, 5)) &&
      PINNED_IMAGE.test(argv[5] ?? '')
    );
  }
  if (argv[1] !== 'compose' || argv[2] !== '-f' || argv[4] !== '--env-file' || argv[6] !== '-p') {
    return false;
  }
  const target = { composeFile: argv[3] ?? '', envFile: argv[5] ?? '', project: argv[7] ?? '' };
  const allowed = [
    commands.ps(target),
    commands.logs(target),
    commands.psql(target, SQL_MIGRATIONS),
    commands.psql(target, SQL_PROJECTS),
    commands.psql(target, SQL_TABLE_SIZES),
    commands.valkey(target),
    commands.workerGitHub(target),
    ...APPROLE_FOLDERS.map((f) => commands.approle(target, f.service, f.folder)),
  ];
  return allowed.some((form) => same(argv, form));
}
