// Checks of the running stack (D-08 V07 AC1, AC3). Pure. A stopped stack or a sealed OpenBao gives
// `skipped` lines with the reason, never a failure of the tool itself.
import type { MessageKey } from '@sdlc/messages';

import { LOG_EVENT_FIXES } from '../logs.js';
import type { AppRoleFact, CheckResult, OperatorFacts, ServiceState, Text } from '../types.js';
import { GIB, ok, problem, skipped, text } from './result.js';

/** Long-running services of the profile `core` (static test against docker-compose.yml). */
export const CORE_SERVICES = [
  'litellm',
  'openbao',
  'postgres',
  'seaweedfs',
  'temporal',
  'temporal-ui',
  'valkey',
] as const;
/** One-shot jobs (`restart: "no"`), the same list as `up.sh` `JOBS` (static test). */
export const JOBS = [
  'access-tls-init',
  'backup-agent',
  'openbao-tls-init',
  'seaweedfs-init',
  'temporal-namespace',
  'temporal-schema',
  'vllm-link-tls-init',
  'vllm-pull',
] as const;
/** The AppRole secret ID lifetime (runbook T11 §8): 90 days. */
export const SECRET_ID_DAYS = 90;
/** O05 (ADR-M102): the warning comes this many days before the end; `SDLC_APPROLE_WARN_DAYS`. */
export const SECRET_ID_WARN_DAYS_BEFORE = 14;
export const TLS_WARNING_DAYS = 30;
export const VALKEY_WARNING_SHARE = 0.9;

const DAY_MS = 86_400_000;
const running = (services: readonly ServiceState[], name: string) =>
  services.some((s) => s.service === name && s.state === 'running');

const t11 = (section: string) => text('doctor.fix.runbook', { section });
const readme = (section: string) => text('doctor.fix.readme', { section });

/**
 * A trial stack (V08) is started and unsealed with `pnpm trial:start`, never by key holders; one
 * without a key file cannot be unsealed again. Undefined for any other stack.
 */
function trialFix(f: OperatorFacts): Text | undefined {
  const key = f.envFile.trialKeyFile;
  if (!key) return undefined;
  return key.mode === null ? text('doctor.fix.trial_rebuild') : text('doctor.fix.trial_start');
}

function serviceChecks(services: readonly ServiceState[]): CheckResult[] {
  const out: CheckResult[] = [];
  const jobs = new Set<string>(JOBS);
  for (const s of services) {
    if (jobs.has(s.service)) {
      if (s.state === 'exited' && s.exitCode !== 0) {
        out.push(
          problem(
            'services.health',
            'failed',
            text('doctor.services.job_failed', { code: s.exitCode }),
            text('doctor.fix.logs', { service: s.service }),
            s.service,
          ),
        );
      }
      continue;
    }
    if (
      s.state === 'restarting' ||
      s.health === 'unhealthy' ||
      (s.state !== 'running' && s.state !== 'created')
    ) {
      out.push(
        problem(
          'services.health',
          'failed',
          text('doctor.services.unhealthy', { state: s.state, health: s.health || '-' }),
          text('doctor.fix.logs', { service: s.service }),
          s.service,
        ),
      );
    } else if (s.health === 'starting') {
      out.push(
        problem(
          'services.health',
          'warning',
          text('doctor.services.starting'),
          readme('Health: what "healthy" means'),
          s.service,
        ),
      );
    }
  }
  const absent = CORE_SERVICES.filter((name) => !running(services, name));
  if (absent.length > 0) {
    out.push(
      problem(
        'services.health',
        'warning',
        text('doctor.services.core_absent', { names: absent.join(', ') }),
        readme('Restart after a reboot'),
      ),
    );
  }
  if (out.length === 0) {
    const count = services.filter((s) => s.state === 'running').length;
    out.push(ok('services.health', text('doctor.services.ok', { count })));
  }
  return out;
}

function tlsChecks(f: OperatorFacts): CheckResult[] {
  const tls = f.tls;
  if (!tls || !f.envFile.exists)
    return [
      skipped('openbao.tls_files', 'doctor.skipped.no_env'),
      skipped('openbao.tls_expiry', 'doctor.skipped.no_env'),
    ];
  const out: CheckResult[] = [];
  const fix = text('doctor.fix.tls');
  if (!tls.dir) {
    out.push(problem('openbao.tls_files', 'failed', text('doctor.tls.no_dir'), fix));
  } else if (tls.missing.length > 0) {
    out.push(
      problem(
        'openbao.tls_files',
        'failed',
        text('doctor.tls.missing', { files: tls.missing.join(', '), dir: tls.dir }),
        fix,
      ),
    );
  } else {
    out.push(ok('openbao.tls_files', text('doctor.tls.files_ok', { dir: tls.dir })));
  }
  if (tls.certs.length === 0) out.push(skipped('openbao.tls_expiry', 'doctor.skipped.no_tls'));
  for (const cert of tls.certs) {
    if (cert.notAfter === null) {
      out.push(problem('openbao.tls_expiry', 'failed', text('doctor.tls.invalid'), fix, cert.name));
      continue;
    }
    const days = Math.floor((new Date(cert.notAfter).getTime() - f.now.getTime()) / DAY_MS);
    const params = { date: cert.notAfter.slice(0, 10), days: Math.max(days, 0) };
    if (days < 0)
      out.push(
        problem(
          'openbao.tls_expiry',
          'failed',
          text('doctor.tls.expired', params),
          t11('§3c'),
          cert.name,
        ),
      );
    else if (days < TLS_WARNING_DAYS)
      out.push(
        problem(
          'openbao.tls_expiry',
          'warning',
          text('doctor.tls.soon', params),
          t11('§3c'),
          cert.name,
        ),
      );
    else out.push(ok('openbao.tls_expiry', text('doctor.tls.ok', params), cert.name));
  }
  return out;
}

function openbaoCheck(f: OperatorFacts, services: readonly ServiceState[]): CheckResult {
  if (!running(services, 'openbao')) return skipped('openbao.state', 'doctor.skipped.not_running');
  switch (f.openbao) {
    case 'unsealed':
      return ok('openbao.state', text('doctor.openbao.unsealed'));
    case 'sealed':
      return problem(
        'openbao.state',
        'failed',
        text('doctor.openbao.sealed'),
        trialFix(f) ?? text('doctor.fix.unseal'),
      );
    case 'uninitialised':
      return problem(
        'openbao.state',
        'failed',
        text('doctor.openbao.uninitialised'),
        readme('3. OpenBao'),
      );
    default:
      return problem(
        'openbao.state',
        'warning',
        text('doctor.openbao.unreachable'),
        text('doctor.fix.logs', { service: 'openbao' }),
      );
  }
}

/** O04 (ADR-M103): an append-only table this large is a warning; `SDLC_DB_TABLE_WARN_GB`. */
export const DB_TABLE_WARN_GB = 20;

/** `SDLC_DB_TABLE_WARN_GB` (1–10000), or null when it is not a whole number in that range. */
function tableWarnGb(f: OperatorFacts): number | null {
  const value = f.envFile.facts?.values.SDLC_DB_TABLE_WARN_GB;
  if (value === undefined) return DB_TABLE_WARN_GB;
  return /^[1-9]\d{0,4}$/.test(value) && Number(value) <= 10_000 ? Number(value) : null;
}

/**
 * O04 (ADR-M103): the append-only tables only grow and are never deleted; past the size the
 * README names, plan the monthly partitions. One ok line with the largest table, or one warning per
 * large table.
 */
function tableSizeChecks(f: OperatorFacts, services: readonly ServiceState[]): CheckResult[] {
  if (!running(services, 'postgres') || f.tableSizes === undefined) {
    return [skipped('db.table_size', 'doctor.skipped.not_running')];
  }
  if (f.tableSizes === null) return [skipped('db.table_size', 'doctor.skipped.table_sizes')];
  const out: CheckResult[] = [];
  const configured = tableWarnGb(f);
  if (configured === null) {
    out.push(
      problem(
        'db.table_size',
        'warning',
        text('doctor.db.bad_warn_gb', { default: DB_TABLE_WARN_GB }),
        readme('Database growth'),
        'SDLC_DB_TABLE_WARN_GB',
      ),
    );
  }
  const max = configured ?? DB_TABLE_WARN_GB;
  const gib = (bytes: number) => (bytes / GIB).toFixed(1);
  const large = f.tableSizes.filter((t) => t.bytes >= max * GIB);
  for (const t of large) {
    out.push(
      problem(
        'db.table_size',
        'warning',
        text('doctor.db.table_large', { gib: gib(t.bytes), max }),
        readme('Database growth'),
        t.table,
      ),
    );
  }
  if (large.length === 0) {
    const largest = [...f.tableSizes].sort((x, y) => y.bytes - x.bytes)[0];
    out.push(
      ok(
        'db.table_size',
        text('doctor.db.tables_ok', {
          table: largest?.table ?? '-',
          gib: gib(largest?.bytes ?? 0),
          max,
        }),
      ),
    );
  }
  return out;
}

function migrationCheck(f: OperatorFacts, services: readonly ServiceState[]): CheckResult {
  if (!running(services, 'postgres') || !f.migrations)
    return skipped('db.migrations', 'doctor.skipped.not_running');
  if (f.migrations.applied === null) {
    return problem(
      'db.migrations',
      'warning',
      text('doctor.migrations.unreadable'),
      text('doctor.fix.db_status'),
    );
  }
  const applied = new Set(f.migrations.applied);
  const pending = f.migrations.expected.filter((name) => !applied.has(name));
  if (pending.length > 0) {
    return problem(
      'db.migrations',
      'failed',
      text('doctor.migrations.pending', { count: pending.length, first: pending[0] ?? '-' }),
      text('doctor.fix.migrate'),
    );
  }
  return ok('db.migrations', text('doctor.migrations.ok', { count: applied.size }));
}

/** Days before the end that warn: `SDLC_APPROLE_WARN_DAYS` (1–89), or null when it is not valid. */
function warnDaysBefore(f: OperatorFacts): number | null {
  const value = f.envFile.facts?.values.SDLC_APPROLE_WARN_DAYS;
  if (value === undefined) return SECRET_ID_WARN_DAYS_BEFORE;
  const days = /^[1-9]\d?$/.test(value) ? Number(value) : Number.NaN;
  return days < SECRET_ID_DAYS ? days : null;
}

/** The age of one delivered secret ID; renewing every one at once: `rotate-credentials` (O05). */
function secretIdAge(a: AppRoleFact, warnAt: number): CheckResult {
  const days = a.ageDays ?? 0;
  const params = { days, max: SECRET_ID_DAYS };
  const renew = text('doctor.fix.credentials', {
    command: 'rotate-credentials',
    section: 'T11 §8.1',
  });
  if (days >= SECRET_ID_DAYS) {
    return problem(
      'credentials.approle',
      'failed',
      text('doctor.approle.expired', params),
      renew,
      a.service,
    );
  }
  if (days >= warnAt) {
    return problem(
      'credentials.approle',
      'warning',
      text('doctor.approle.old', params),
      renew,
      a.service,
    );
  }
  return ok('credentials.approle', text('doctor.approle.ok', params), a.service);
}

function approleChecks(f: OperatorFacts): CheckResult[] {
  const out: CheckResult[] = [];
  const before = warnDaysBefore(f);
  if (before === null) {
    out.push(
      problem(
        'credentials.approle',
        'warning',
        text('doctor.approle.bad_warn_days', { default: SECRET_ID_WARN_DAYS_BEFORE }),
        readme('Doctor (`pnpm doctor`)'),
        'SDLC_APPROLE_WARN_DAYS',
      ),
    );
  }
  const warnAt = SECRET_ID_DAYS - (before ?? SECRET_ID_WARN_DAYS_BEFORE);
  for (const a of f.approles ?? []) {
    const fix = text('doctor.fix.credentials', { command: a.credentials, section: 'T11 §8' });
    if (a.state === 'not_running') continue;
    if (a.state === 'missing')
      out.push(
        problem('credentials.approle', 'failed', text('doctor.approle.missing'), fix, a.service),
      );
    else if (a.state === 'unreadable')
      out.push(
        problem(
          'credentials.approle',
          'warning',
          text('doctor.approle.unreadable'),
          fix,
          a.service,
        ),
      );
    else out.push(secretIdAge(a, warnAt));
  }
  const checked = out.some((r) => r.subject !== 'SDLC_APPROLE_WARN_DAYS');
  return checked
    ? out
    : [...out, skipped('credentials.approle', 'doctor.skipped.platform_stopped')];
}

const LOG_EVENT_KEYS: Readonly<Record<string, MessageKey>> = {
  'worker.cost_sync_gap': 'doctor.logs.cost_sync_gap',
  'openbao.sealed': 'doctor.logs.sealed',
};

function logChecks(f: OperatorFacts): CheckResult[] {
  if (f.logs === undefined) return [skipped('credentials.logs', 'doctor.skipped.platform_stopped')];
  if (f.logs === null) {
    return [
      problem(
        'credentials.logs',
        'warning',
        text('doctor.logs.unreadable'),
        text('doctor.fix.logs', { service: 'sdlc-worker' }),
      ),
    ];
  }
  const out = f.logs.events.map((event) =>
    problem(
      'credentials.logs',
      'warning',
      text(LOG_EVENT_KEYS[event] ?? 'doctor.logs.event', { event }),
      LOG_EVENT_FIXES[event] ?? readme('Troubleshooting'),
      event,
    ),
  );
  if (out.length > 0) return out;
  return f.logs.started.length > 0
    ? [ok('credentials.logs', text('doctor.logs.ok', { services: f.logs.started.join(', ') }))]
    : [skipped('credentials.logs', 'doctor.skipped.no_start_events')];
}

function modelsCheck(services: readonly ServiceState[]): CheckResult {
  if (!running(services, 'sdlc-worker'))
    return skipped('models.litellm', 'doctor.skipped.platform_stopped');
  if (!running(services, 'litellm-agent')) {
    return problem(
      'models.litellm',
      'warning',
      text('doctor.models.no_agent'),
      text('doctor.fix.models'),
    );
  }
  return ok('models.litellm', text('doctor.models.ok'));
}

function valkeyCheck(f: OperatorFacts, services: readonly ServiceState[]): CheckResult {
  if (!running(services, 'valkey') || f.valkey === undefined)
    return skipped('valkey.memory', 'doctor.skipped.not_running');
  if (f.valkey === null)
    return problem(
      'valkey.memory',
      'warning',
      text('doctor.valkey.unreadable'),
      readme('Shared Valkey: memory limit'),
    );
  const { usedBytes, maxBytes } = f.valkey;
  const mib = (n: number) => (n / 1024 ** 2).toFixed(0);
  const params = { used: mib(usedBytes), max: maxBytes > 0 ? mib(maxBytes) : '-' };
  if (maxBytes > 0 && usedBytes >= VALKEY_WARNING_SHARE * maxBytes) {
    return problem(
      'valkey.memory',
      'warning',
      text('doctor.valkey.full', params),
      readme('Shared Valkey: memory limit'),
    );
  }
  return ok('valkey.memory', text('doctor.valkey.ok', params));
}

function imageChecks(f: OperatorFacts, services: readonly ServiceState[]): CheckResult[] {
  if (!running(services, 'postgres') || f.projects === undefined)
    return [skipped('sandbox.image', 'doctor.skipped.not_running')];
  if (f.projects === null)
    return [
      problem(
        'sandbox.image',
        'warning',
        text('doctor.image.unreadable'),
        text('doctor.fix.db_status'),
      ),
    ];
  if (f.projects.length === 0) return [skipped('sandbox.image', 'doctor.skipped.no_projects')];
  return f.projects.map((p) => {
    if (p.image === null) {
      return problem(
        'sandbox.image',
        'warning',
        text('doctor.image.config_invalid'),
        readme('Troubleshooting'),
        p.project,
      );
    }
    if (!/@sha256:[0-9a-f]{64}$/.test(p.image)) {
      return problem(
        'sandbox.image',
        'failed',
        text('doctor.image.not_pinned'),
        t11('§5g'),
        p.project,
      );
    }
    if (p.present === false) {
      return problem(
        'sandbox.image',
        'warning',
        text('doctor.image.absent'),
        text('doctor.fix.sandbox_image'),
        p.project,
      );
    }
    return ok('sandbox.image', text('doctor.image.ok'), p.project);
  });
}

export function stackChecks(f: OperatorFacts): CheckResult[] {
  const tls = tlsChecks(f);
  const ids = [
    'services.health',
    'openbao.state',
    'db.migrations',
    'db.table_size',
    'credentials.approle',
    'credentials.logs',
    'models.litellm',
    'valkey.memory',
    'sandbox.image',
  ] as const;
  if (!f.docker || !f.envFile.exists || f.services === undefined) {
    const reason = !f.docker ? 'doctor.skipped.no_docker' : 'doctor.skipped.no_env';
    return [
      ...ids.slice(0, 2).map((id) => skipped(id, reason)),
      ...tls,
      ...ids.slice(2).map((id) => skipped(id, reason)),
    ];
  }
  if (f.services === null) {
    return [
      problem(
        'services.health',
        'failed',
        text('doctor.services.ps_failed'),
        readme('Troubleshooting'),
      ),
      skipped('openbao.state', 'doctor.skipped.ps_failed'),
      ...tls,
      ...ids.slice(2).map((id) => skipped(id, 'doctor.skipped.ps_failed')),
    ];
  }
  const services = f.services;
  if (services.length === 0) {
    return [
      problem(
        'services.health',
        'warning',
        text('doctor.services.stopped'),
        trialFix(f) ?? readme('Restart after a reboot'),
      ),
      skipped('openbao.state', 'doctor.skipped.stopped'),
      ...tls,
      ...ids.slice(2).map((id) => skipped(id, 'doctor.skipped.stopped')),
    ];
  }
  return [
    ...serviceChecks(services),
    openbaoCheck(f, services),
    ...tls,
    migrationCheck(f, services),
    ...tableSizeChecks(f, services),
    ...approleChecks(f),
    ...logChecks(f),
    modelsCheck(services),
    valkeyCheck(f, services),
    ...imageChecks(f, services),
  ];
}
