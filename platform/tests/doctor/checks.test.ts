// `pnpm doctor`, the checks (D-08 V07 AC1, AC3, AC4): pure functions on facts, no host. A stopped
// stack, a sealed OpenBao and a missing env file give `skipped` lines with the reason; every
// warning and failure names its fix; every text exists in the catalog with its parameters.
import { catalogFor, placeholdersOf } from '@sdlc/messages';
import { describe, expect, it } from 'vitest';

import { evaluate } from '../../deploy/doctor/src/checks/index.js';
import {
  isTrialProject,
  parseAppRole,
  parseOpenBaoStatus,
  parseTableSizes,
  parsePs,
  parseValkeyMemory,
  parseWorkerGitHub,
} from '../../deploy/doctor/src/host.js';
import { renderText } from '../../deploy/doctor/src/render.js';
import { CHECK_IDS, type CheckResult, type OperatorFacts } from '../../deploy/doctor/src/types.js';
import { GIB, healthyFacts, HOUR, inDays, MANIFEST, NOW, RUNNING, service } from './fixtures.js';

const of = (results: readonly CheckResult[], id: string, subject?: string) =>
  results.filter((r) => r.id === id && (subject === undefined || r.subject === subject));
const one = (results: readonly CheckResult[], id: string, subject?: string) => {
  const found = of(results, id, subject);
  expect(found).toHaveLength(1);
  return found[0] as CheckResult;
};

describe('pnpm doctor: the checks', () => {
  it('a healthy deployment: every check ok, in the order of CHECK_IDS', () => {
    const results = evaluate(healthyFacts());
    expect(results.filter((r) => r.status !== 'ok')).toEqual([]);
    const order = [...new Set(results.map((r) => r.id))];
    expect(order).toEqual([...CHECK_IDS]);
  });

  it('every text and fix exists in the catalog with the parameters it uses', () => {
    const catalog = catalogFor('en') as Readonly<Record<string, string>>;
    const variants: OperatorFacts[] = [
      healthyFacts(),
      healthyFacts({ docker: null }),
      healthyFacts({ services: [] }),
      healthyFacts({ services: null }),
      healthyFacts({ openbao: 'sealed', github: undefined }),
      healthyFacts({ envFile: { path: '/x/.env', exists: false, mode: null } }),
      healthyFacts({
        approles: [{ service: 'sdlc-api', credentials: 'api-credentials', state: 'missing' }],
        logs: {
          events: ['worker.evidence_missing', 'worker.cost_sync_gap', 'openbao.sealed'],
          started: [],
        },
        github: { ok: false, error: 'not_built' },
        migrations: { expected: ['0001-a', '0002-b'], applied: null },
        projects: null,
        valkey: null,
        imagesMode: 'failed',
      }),
    ];
    for (const facts of variants) {
      for (const r of evaluate(facts)) {
        for (const item of [r.text, r.fix].filter((x) => x !== undefined)) {
          expect(Object.hasOwn(catalog, item.key), item.key).toBe(true);
          for (const name of placeholdersOf(catalog[item.key] ?? '')) {
            expect(Object.keys(item.params ?? {}), `${item.key}: ${name}`).toContain(name);
          }
        }
        if (r.status === 'warning' || r.status === 'failed') expect(r.fix, r.id).toBeDefined();
      }
    }
  });

  it('no Docker: fails host.docker and skips the stack checks (never crashes)', () => {
    const results = evaluate(healthyFacts({ docker: null, services: undefined }));
    expect(one(results, 'host.docker').status).toBe('failed');
    for (const id of ['services.health', 'openbao.state', 'db.migrations', 'github.app']) {
      expect(
        of(results, id).every((r) => r.status === 'skipped'),
        id,
      ).toBe(true);
    }
  });

  it('an old docker compose fails', () => {
    const facts = healthyFacts({
      docker: {
        serverVersion: '27',
        composeVersion: '2.20.0',
        memoryBytes: 16 * GIB,
        authorizationPlugins: [],
      },
    });
    expect(one(evaluate(facts), 'host.docker').status).toBe('failed');
  });

  it('little memory and disk: warning; very little disk: failed', () => {
    const facts = healthyFacts({
      docker: {
        serverVersion: '29',
        composeVersion: '2.30.0',
        memoryBytes: 4 * GIB,
        authorizationPlugins: [],
      },
      disk: [
        { path: '/a', freeBytes: 10 * GIB },
        { path: '/b', freeBytes: 1 * GIB },
      ],
    });
    const results = evaluate(facts);
    expect(one(results, 'host.memory').status).toBe('warning');
    expect(one(results, 'host.disk', '/a').status).toBe('warning');
    expect(one(results, 'host.disk', '/b').status).toBe('failed');
  });

  describe('backup.recent (O03): the newest complete backup in SDLC_BACKUP_DIR', () => {
    const backup = (over: Partial<NonNullable<OperatorFacts['backup']>>) =>
      one(
        evaluate(healthyFacts({ backup: { ...healthyFacts().backup!, ...over } })),
        'backup.recent',
      );
    const hoursAgo = (h: number) => new Date(NOW.getTime() - h * HOUR).toISOString();

    it('ok within the warning hours, with its age and date', () => {
      expect(backup({ newest: hoursAgo(25) })).toMatchObject({
        status: 'ok',
        text: { key: 'doctor.backup.ok', params: { hours: 25, date: hoursAgo(25).slice(0, 10) } },
      });
    });

    it('a warning from SDLC_BACKUP_WARN_HOURS, a failure from SDLC_BACKUP_FAIL_HOURS', () => {
      expect(backup({ newest: hoursAgo(26) })).toMatchObject({
        status: 'warning',
        text: { key: 'doctor.backup.old' },
        fix: { key: 'doctor.fix.backup' },
      });
      expect(backup({ newest: hoursAgo(50) }).status).toBe('failed');
      expect(backup({ newest: hoursAgo(10), warnHours: 8, failHours: 12 }).status).toBe('warning');
    });

    it('no complete backup yet, or an unreadable folder, is a failure with its fix', () => {
      expect(backup({ newest: null })).toMatchObject({
        status: 'failed',
        text: { key: 'doctor.backup.none' },
        fix: { key: 'doctor.fix.backup' },
      });
      expect(backup({ readable: false, newest: null })).toMatchObject({
        status: 'failed',
        text: { key: 'doctor.backup.unreadable' },
        subject: '/mnt/backup',
      });
    });

    it('thresholds that make no sense are a warning, never ignored', () => {
      expect(backup({ warnHours: 50, failHours: 26 })).toMatchObject({
        status: 'warning',
        text: { key: 'doctor.backup.bad_hours', params: { warn: 50, fail: 26 } },
      });
      expect(backup({ warnHours: Number.NaN }).text).toEqual({
        key: 'doctor.backup.bad_hours',
        params: { warn: '-', fail: 50 },
      });
    });

    it('skipped without SDLC_BACKUP_DIR (a trial or a dev stack) or without an env file', () => {
      expect(backup({ dir: null })).toMatchObject({
        status: 'skipped',
        text: { key: 'doctor.skipped.no_backup_dir' },
      });
      expect(one(evaluate(healthyFacts({ backup: undefined })), 'backup.recent')).toMatchObject({
        status: 'skipped',
        text: { key: 'doctor.skipped.no_env' },
      });
    });
  });

  it('the env file: missing, readable by others, unset secrets (names only)', () => {
    const missing = evaluate(
      healthyFacts({
        envFile: { path: '/x/.env', exists: false, mode: null },
        services: undefined,
      }),
    );
    expect(one(missing, 'env.file')).toMatchObject({
      status: 'failed',
      fix: { key: 'doctor.fix.compose_env' },
    });
    expect(one(missing, 'openbao.tls_files').status).toBe('skipped');
    const open = evaluate(
      healthyFacts({
        envFile: {
          path: '/x/.env',
          exists: true,
          mode: 0o100644,
          facts: { values: {}, secrets: { A_PASSWORD: 'placeholder', B_KEY: 'empty', C: 'set' } },
        },
      }),
    );
    expect(one(open, 'env.file')).toMatchObject({
      status: 'failed',
      fix: { key: 'doctor.fix.chmod' },
    });
    expect(one(open, 'env.secrets')).toMatchObject({
      status: 'failed',
      text: { params: { names: 'A_PASSWORD, B_KEY' } },
    });
  });

  it('a stopped stack: a warning, and the checks that need it are skipped (AC3)', () => {
    const results = evaluate(healthyFacts({ services: [] }));
    expect(one(results, 'services.health').status).toBe('warning');
    for (const id of [
      'openbao.state',
      'db.migrations',
      'credentials.approle',
      'valkey.memory',
      'sandbox.image',
    ]) {
      expect(one(results, id)).toMatchObject({
        status: 'skipped',
        text: { key: 'doctor.skipped.stopped' },
      });
    }
    // The TLS files are on the host: checked also when the stack is stopped.
    expect(one(results, 'openbao.tls_files').status).toBe('ok');
  });

  it('services: unhealthy, restarting, a failed job, a core service not running', () => {
    const services = [
      ...RUNNING.filter((s) => s.service !== 'temporal' && s.service !== 'litellm'),
      service('litellm', { health: 'unhealthy' }),
      service('temporal-schema', { state: 'exited', health: '', exitCode: 1 }),
    ];
    const results = evaluate(healthyFacts({ services }));
    expect(one(results, 'services.health', 'litellm').status).toBe('failed');
    expect(one(results, 'services.health', 'temporal-schema').status).toBe('failed');
    const absent = of(results, 'services.health').find(
      (r) => r.text.key === 'doctor.services.core_absent',
    );
    expect(absent).toMatchObject({ status: 'warning', text: { params: { names: 'temporal' } } });
  });

  it('OpenBao sealed: failed with the unseal fix; the GitHub check is skipped', () => {
    const results = evaluate(healthyFacts({ openbao: 'sealed', github: undefined }));
    expect(one(results, 'openbao.state')).toMatchObject({
      status: 'failed',
      fix: { key: 'doctor.fix.unseal' },
    });
    expect(one(results, 'github.app')).toMatchObject({
      status: 'skipped',
      text: { key: 'doctor.skipped.openbao_sealed' },
    });
  });

  it('V08: a sealed trial stack points to pnpm trial:start, or to a new set-up without its key file', () => {
    const trial = (mode: number | null): OperatorFacts['envFile'] => ({
      ...healthyFacts().envFile,
      facts: { values: { COMPOSE_PROJECT_NAME: 'sdlc-trial' }, secrets: {} },
      trialKeyFile: { path: '/repo/platform/deploy/trial-openbao-keys.age', mode },
    });
    const sealed = evaluate(
      healthyFacts({ openbao: 'sealed', github: undefined, envFile: trial(0o100600) }),
    );
    expect(one(sealed, 'openbao.state').fix).toEqual({ key: 'doctor.fix.trial_start' });
    expect(one(sealed, 'env.file', 'trial key file')).toMatchObject({
      status: 'ok',
      text: { key: 'doctor.trial_key.ok' },
    });
    const stopped = evaluate(healthyFacts({ services: [], envFile: trial(0o100600) }));
    expect(one(stopped, 'services.health').fix).toEqual({ key: 'doctor.fix.trial_start' });

    const lost = evaluate(
      healthyFacts({ openbao: 'sealed', github: undefined, envFile: trial(null) }),
    );
    expect(one(lost, 'openbao.state').fix).toEqual({ key: 'doctor.fix.trial_rebuild' });
    expect(one(lost, 'env.file', 'trial key file')).toMatchObject({
      status: 'warning',
      text: { key: 'doctor.trial_key.missing' },
    });
    const open = evaluate(healthyFacts({ envFile: trial(0o100644) }));
    expect(one(open, 'env.file', 'trial key file')).toMatchObject({
      status: 'failed',
      fix: { key: 'doctor.fix.chmod' },
    });
    // A server never gets the trial hints.
    expect(
      one(evaluate(healthyFacts({ openbao: 'sealed', github: undefined })), 'openbao.state').fix,
    ).toEqual({ key: 'doctor.fix.unseal' });
  });

  it('TLS: a missing file fails; a certificate within 30 days warns; an ended one fails', () => {
    const results = evaluate(
      healthyFacts({
        tls: {
          dir: '/t',
          missing: ['server-key.pem'],
          certs: [
            { name: 'ca', notAfter: inDays(10) },
            { name: 'server', notAfter: inDays(-1) },
          ],
        },
      }),
    );
    expect(one(results, 'openbao.tls_files').status).toBe('failed');
    expect(one(results, 'openbao.tls_expiry', 'ca')).toMatchObject({
      status: 'warning',
      text: { params: { days: 10 } },
    });
    expect(one(results, 'openbao.tls_expiry', 'server').status).toBe('failed');
  });

  it('migrations: pending fails with the count and the first; unreadable warns', () => {
    const pending = evaluate(
      healthyFacts({
        migrations: { expected: ['0001-a', '0002-b', '0003-c'], applied: ['0001-a'] },
      }),
    );
    expect(one(pending, 'db.migrations')).toMatchObject({
      status: 'failed',
      text: { params: { count: 2, first: '0002-b' } },
      fix: { key: 'doctor.fix.migrate' },
    });
    expect(
      one(
        evaluate(healthyFacts({ migrations: { expected: ['0001-a'], applied: null } })),
        'db.migrations',
      ).status,
    ).toBe('warning');
  });

  describe('db.table_size (O04, ADR-M103): the append-only tables against SDLC_DB_TABLE_WARN_GB', () => {
    const sized = (
      tableSizes: OperatorFacts['tableSizes'],
      values: Record<string, string> = {},
    ) => {
      const base = healthyFacts();
      return evaluate(
        healthyFacts({
          envFile: {
            ...base.envFile,
            facts: { ...base.envFile.facts!, values: { ...base.envFile.facts!.values, ...values } },
          },
          tableSizes,
        }),
      );
    };

    it('one ok line with the largest table while every table is below the warning', () => {
      expect(one(sized([{ table: 'audit_log', bytes: 3 * GIB }]), 'db.table_size')).toMatchObject({
        status: 'ok',
        text: { key: 'doctor.db.tables_ok', params: { table: 'audit_log', gib: '3.0', max: 20 } },
      });
    });

    it('a warning for each table at or above SDLC_DB_TABLE_WARN_GB, with the fix', () => {
      const results = sized(
        [
          { table: 'audit_log', bytes: 25 * GIB },
          { table: 'run_events', bytes: 5 * GIB },
        ],
        { SDLC_DB_TABLE_WARN_GB: '4' },
      );
      expect(of(results, 'db.table_size').map((r) => [r.subject, r.status])).toEqual([
        ['audit_log', 'warning'],
        ['run_events', 'warning'],
      ]);
      expect(one(results, 'db.table_size', 'audit_log')).toMatchObject({
        text: { key: 'doctor.db.table_large', params: { gib: '25.0', max: 4 } },
        fix: { key: 'doctor.fix.readme', params: { section: 'Database growth' } },
      });
    });

    it('a bad SDLC_DB_TABLE_WARN_GB is a warning of its own; the default is used', () => {
      const results = sized([{ table: 'audit_log', bytes: GIB }], { SDLC_DB_TABLE_WARN_GB: 'big' });
      expect(one(results, 'db.table_size', 'SDLC_DB_TABLE_WARN_GB').text.key).toBe(
        'doctor.db.bad_warn_gb',
      );
      // 1 GiB is below the default 20 GiB: the ok line comes too.
      expect(of(results, 'db.table_size').map((r) => r.status)).toEqual(['warning', 'ok']);
    });

    it('skipped when the sizes could not be read or the database is stopped', () => {
      expect(one(sized(null), 'db.table_size').status).toBe('skipped');
      expect(one(sized(undefined), 'db.table_size').status).toBe('skipped');
    });

    it('parses the query result; anything else is null', () => {
      expect(parseTableSizes('[{"table":"audit_log","bytes":123}]\n')).toEqual([
        { table: 'audit_log', bytes: 123 },
      ]);
      expect(parseTableSizes('not json')).toBeNull();
      expect(parseTableSizes('[{"table":1}]')).toBeNull();
    });
  });

  describe('secret ID age (O05, ADR-M102): a warning 14 days before the 90 days end', () => {
    const age = (ageDays: number, values: Record<string, string> = {}) => {
      const base = healthyFacts();
      return evaluate(
        healthyFacts({
          envFile: {
            ...base.envFile,
            facts: { ...base.envFile.facts!, values: { ...base.envFile.facts!.values, ...values } },
          },
          approles: [{ service: 'sdlc-api', credentials: 'api-credentials', state: 'ok', ageDays }],
        }),
      );
    };

    it('ok until day 75, a warning from day 76, failed from day 90; renewal names rotate-credentials', () => {
      expect(one(age(75), 'credentials.approle', 'sdlc-api').status).toBe('ok');
      expect(one(age(76), 'credentials.approle', 'sdlc-api')).toMatchObject({
        status: 'warning',
        text: { key: 'doctor.approle.old', params: { days: 76, max: 90 } },
        fix: { key: 'doctor.fix.credentials', params: { command: 'rotate-credentials' } },
      });
      expect(one(age(90), 'credentials.approle', 'sdlc-api')).toMatchObject({
        status: 'failed',
        fix: { params: { command: 'rotate-credentials' } },
      });
    });

    it('SDLC_APPROLE_WARN_DAYS moves the warning', () => {
      expect(
        one(age(60, { SDLC_APPROLE_WARN_DAYS: '30' }), 'credentials.approle', 'sdlc-api').status,
      ).toBe('warning');
      expect(
        one(age(59, { SDLC_APPROLE_WARN_DAYS: '30' }), 'credentials.approle', 'sdlc-api').status,
      ).toBe('ok');
    });

    it('a value that is not a whole number of 1 to 89 is a warning of its own; the default is used', () => {
      for (const bad of ['0', '90', 'soon', '7.5']) {
        const results = age(76, { SDLC_APPROLE_WARN_DAYS: bad });
        expect(one(results, 'credentials.approle', 'SDLC_APPROLE_WARN_DAYS'), bad).toMatchObject({
          status: 'warning',
          text: { key: 'doctor.approle.bad_warn_days' },
        });
        expect(one(results, 'credentials.approle', 'sdlc-api').status, bad).toBe('warning');
      }
    });
  });

  it('a bad SDLC_APPROLE_WARN_DAYS on a stopped stack: its warning and the skip line', () => {
    const base = healthyFacts();
    const results = evaluate(
      healthyFacts({
        envFile: {
          ...base.envFile,
          facts: {
            ...base.envFile.facts!,
            values: { ...base.envFile.facts!.values, SDLC_APPROLE_WARN_DAYS: 'soon' },
          },
        },
        approles: [],
      }),
    );
    expect(of(results, 'credentials.approle').map((r) => r.status)).toEqual(['warning', 'skipped']);
  });

  it('AppRole credentials: missing fails, 80 days warns, 90 days fails, each with its command', () => {
    const results = evaluate(
      healthyFacts({
        approles: [
          { service: 'sdlc-api', credentials: 'api-credentials', state: 'missing' },
          { service: 'sdlc-worker', credentials: 'worker-credentials', state: 'ok', ageDays: 85 },
          { service: 'sdlc-runner', credentials: 'runner-credentials', state: 'ok', ageDays: 90 },
          { service: 'litellm-agent', credentials: 'litellm-credentials', state: 'not_running' },
        ],
      }),
    );
    expect(one(results, 'credentials.approle', 'sdlc-api')).toMatchObject({
      status: 'failed',
      fix: { params: { command: 'api-credentials' } },
    });
    expect(one(results, 'credentials.approle', 'sdlc-worker').status).toBe('warning');
    expect(one(results, 'credentials.approle', 'sdlc-runner').status).toBe('failed');
    expect(of(results, 'credentials.approle', 'litellm-agent')).toEqual([]);
  });

  it('log events: one warning each with its credentials command; no start event: skipped', () => {
    const results = evaluate(
      healthyFacts({
        logs: { events: ['api.evidence_missing', 'worker.runs_off'], started: ['sdlc-api'] },
      }),
    );
    expect(one(results, 'credentials.logs', 'api.evidence_missing')).toMatchObject({
      status: 'warning',
      fix: { params: { command: 'api-evidence-credentials' } },
    });
    expect(one(results, 'credentials.logs', 'worker.runs_off').fix?.params).toMatchObject({
      command: 'worker-credentials',
    });
    const quiet = evaluate(healthyFacts({ logs: { events: [], started: [] } }));
    expect(one(quiet, 'credentials.logs')).toMatchObject({
      status: 'skipped',
      text: { key: 'doctor.skipped.no_start_events' },
    });
  });

  it('the platform without the profile models: a warning', () => {
    const results = evaluate(
      healthyFacts({ services: RUNNING.filter((s) => s.service !== 'litellm-agent') }),
    );
    expect(one(results, 'models.litellm')).toMatchObject({
      status: 'warning',
      fix: { key: 'doctor.fix.models' },
    });
  });

  it('Valkey at 90 % of its memory: a warning', () => {
    const results = evaluate(
      healthyFacts({ valkey: { usedBytes: 240 * 1024 ** 2, maxBytes: 256 * 1024 ** 2 } }),
    );
    expect(one(results, 'valkey.memory').status).toBe('warning');
  });

  it('GitHub: a missing permission fails, an uninstalled repository fails, "all repositories" warns', () => {
    const noContents = Object.fromEntries(
      Object.entries(MANIFEST).filter(([k]) => k !== 'contents'),
    );
    const results = evaluate(
      healthyFacts({
        github: {
          ok: true,
          app: { permissions: { ...MANIFEST, administration: 'write' } },
          repos: [
            { repo: 'acme/shop', installed: true, selection: 'selected', permissions: noContents },
            { repo: 'acme/other', installed: false },
            { repo: 'acme/all', installed: true, selection: 'all', permissions: { ...MANIFEST } },
          ],
        },
      }),
    );
    expect(one(results, 'github.app', 'app')).toMatchObject({
      status: 'warning',
      text: { params: { permissions: 'administration:write' } },
    });
    expect(one(results, 'github.app', 'acme/shop')).toMatchObject({
      status: 'failed',
      text: { params: { permissions: 'contents:write' } },
      fix: { key: 'doctor.fix.accept_permissions' },
    });
    expect(one(results, 'github.app', 'acme/other').status).toBe('failed');
    expect(one(results, 'github.app', 'acme/all').status).toBe('warning');
  });

  it('GitHub: a worker image without the check says to rebuild; a stopped worker skips', () => {
    expect(
      one(evaluate(healthyFacts({ github: { ok: false, error: 'not_built' } })), 'github.app').fix
        ?.key,
    ).toBe('doctor.fix.rebuild_worker');
    const stopped = evaluate(
      healthyFacts({
        github: undefined,
        services: RUNNING.filter((s) => s.service !== 'sdlc-worker'),
      }),
    );
    expect(one(stopped, 'github.app')).toMatchObject({
      status: 'skipped',
      text: { key: 'doctor.skipped.worker_stopped' },
    });
  });

  it('sandbox images: absent warns; an invalid configuration warns', () => {
    const results = evaluate(
      healthyFacts({
        projects: [
          { project: 'a/x', image: `r/i@sha256:${'b'.repeat(64)}`, present: false },
          { project: 'a/y', image: null, present: null },
        ],
      }),
    );
    expect(one(results, 'sandbox.image', 'a/x')).toMatchObject({
      status: 'warning',
      fix: { key: 'doctor.fix.sandbox_image' },
    });
    expect(one(results, 'sandbox.image', 'a/y').status).toBe('warning');
  });

  it('renders one line per check, a fix line under each problem, and a summary', () => {
    const results = evaluate(healthyFacts({ openbao: 'sealed', github: undefined }));
    const lines = renderText(results, '/srv/sdlc/.env');
    expect(lines).toHaveLength(1 + results.length + results.filter((r) => r.fix).length + 1);
    expect(lines.at(-1)).toMatch(/1 failed/);
  });
});

describe('pnpm doctor: parsing command output', () => {
  it('docker compose ps: an array or one object per line', () => {
    const row = { Service: 'postgres', State: 'running', Health: 'healthy', ExitCode: 0 };
    expect(parsePs(JSON.stringify([row]))).toEqual([
      { service: 'postgres', state: 'running', health: 'healthy', exitCode: 0, published: [] },
    ]);
    // V09: the published ports (address and port only).
    const published = parsePs(
      JSON.stringify([
        {
          ...row,
          Service: 'sdlc-access',
          Publishers: [
            { URL: '192.168.10.5', TargetPort: 8443, PublishedPort: 8443, Protocol: 'tcp' },
            { URL: '', TargetPort: 8081, PublishedPort: 0, Protocol: 'tcp' },
          ],
        },
      ]),
    );
    expect(published?.[0]?.published).toEqual([{ address: '192.168.10.5', port: 8443 }]);
    expect(
      parsePs(`${JSON.stringify(row)}\n${JSON.stringify({ ...row, Service: 'valkey' })}`),
    ).toHaveLength(2);
    expect(parsePs('')).toEqual([]);
    expect(parsePs('not json')).toBeNull();
  });

  it('V08: a trial project is sdlc-trial (or the live test sdlctrialit…), never the server', () => {
    expect(isTrialProject('sdlc-trial')).toBe(true);
    expect(isTrialProject('sdlctrialit123')).toBe(true);
    expect(isTrialProject('sdlc')).toBe(false);
    expect(isTrialProject('sdlc-trial_x')).toBe(false);
    expect(isTrialProject(undefined)).toBe(false);
  });

  it('OpenBao status, Valkey memory, AppRole age', () => {
    expect(parseOpenBaoStatus(0, 'bootstrap: OpenBao is sealed\n')).toBe('sealed');
    expect(parseOpenBaoStatus(1, '')).toBe('unreachable');
    expect(parseValkeyMemory('# Memory\r\nused_memory:1048576\r\nmaxmemory:268435456\r\n')).toEqual(
      {
        usedBytes: 1048576,
        maxBytes: 268435456,
      },
    );
    const tenDaysAgo = Math.floor((NOW.getTime() - 10 * 86_400_000) / 1000);
    expect(parseAppRole(0, `${String(tenDaysAgo)}\n`, NOW)).toEqual({ state: 'ok', ageDays: 10 });
    expect(parseAppRole(0, 'missing\n', NOW)).toEqual({ state: 'missing' });
    expect(parseAppRole(0, 'garbage', NOW)).toEqual({ state: 'unreadable' });
  });

  it("the worker's answer: fields checked, odd values dropped", () => {
    const answer = {
      ok: true,
      app: { permissions: { contents: 'write', 'Bad Name': 'write', issues: 'everything' } },
      repos: [
        { repo: 'acme/shop', installed: true, selection: 'all', permissions: { contents: 'read' } },
        { repo: '../etc', installed: false },
      ],
    };
    expect(parseWorkerGitHub(0, JSON.stringify(answer))).toEqual({
      ok: true,
      app: { permissions: { contents: 'write' } },
      repos: [
        { repo: 'acme/shop', installed: true, selection: 'all', permissions: { contents: 'read' } },
      ],
    });
    expect(parseWorkerGitHub(0, '{"ok":false,"error":"openbao_sealed"}')).toEqual({
      ok: false,
      error: 'openbao_sealed',
    });
    expect(parseWorkerGitHub(0, '{"ok":false,"error":"Some Text With Spaces"}')).toEqual({
      ok: false,
      error: 'invalid_answer',
    });
    expect(parseWorkerGitHub(1, "Error: Cannot find module '/app/dist/doctor-github.js'")).toEqual({
      ok: false,
      error: 'not_built',
    });
  });
});
