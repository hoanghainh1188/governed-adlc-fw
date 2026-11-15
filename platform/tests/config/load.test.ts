// D-08 A05 AC1: read the YAML configuration (matrix, SLA, change flags, retries, budgets, loop
// threshold, evidence retention, policy rules), merge project overrides over the defaults, and
// read YAML safely.
import fs from 'node:fs';

import { DEFAULT_CONFIG_PATH, defaultProjectConfig, formatIssue } from '@sdlc/config';
import { describe, expect, it } from 'vitest';

import { keysAndPaths, loadErrors, loadValid } from './helpers';

describe('default configuration (AC1)', () => {
  const { config, warnings } = loadValid();

  it('loads without errors or warnings', () => {
    expect(warnings).toEqual([]);
    expect(config).toEqual(defaultProjectConfig());
  });

  it('contains every setting listed in AC1', () => {
    expect(Object.keys(config.oversight.matrix)).toEqual([
      'G1',
      'G2',
      'G3',
      'G4',
      'G5',
      'G6',
      'G7',
      'G8',
    ]);
    expect(Object.keys(config.escalation.sla)).toEqual(['critical', 'high', 'medium', 'low']);
    expect(config.oversight.forced_hitl_g3.change_flags).toHaveLength(7);
    expect(config.oversight.dual_approval_g7.change_flags).toHaveLength(6);
    expect(config.run.g6_ci_retries).toBe(2);
    expect(config.budget).toEqual({
      warn_percent: 80,
      stop_percent: 100,
      default_intent_usd: 10,
      default_run_usd: 2,
    });
    expect(config.run.loop_detection).toEqual({
      identical_tool_calls_max: 3,
      no_progress_window_minutes: 15,
    });
    expect(config.retention.evidence_retention_days).toBe(180);
    expect(config.autonomy.max_by_risk).toEqual({
      low: 'L2',
      medium: 'L2',
      high: 'L1',
      critical: 'L0',
    });
    expect(config.model_routing.allowed_provider_types.client_restricted).toEqual(['self_hosted']);
    expect(config.github.poll_interval_seconds).toBe(30);
    // O08 (ADR-M112 §2.6): webhooks off by default, reconciliation every 5 minutes when on.
    expect(config.github.webhooks).toEqual({ enabled: false, reconcile_interval_seconds: 300 });
    expect(config.escalation.calendar.holidays).toEqual([]);
  });

  it('fills cell defaults: approvals 1, no roles for POLICY', () => {
    expect(config.oversight.matrix.G1.low).toEqual({
      mode: 'HITL',
      roles: ['person_a'],
      approvals: 1,
    });
    expect(config.oversight.matrix.G4.low).toEqual({ mode: 'POLICY', roles: [], approvals: 1 });
  });

  it('marks every value that no document gives as a pilot default (QUESTIONS.md #9)', () => {
    const text = fs.readFileSync(DEFAULT_CONFIG_PATH, 'utf8');
    const marked = text
      .split('\n')
      .filter((line) =>
        line.includes('[Proposal] pilot default, review after 2–4 weeks of data (handbook Ch.8)'),
      );
    // 9 from QUESTIONS.md #9, #33; 1 from #75 (escalation reminder, task B11); 1 from C06
    // session 2 (`run.contract_attempts_max`).
    expect(marked).toHaveLength(11);
  });

  it('is frozen, so callers cannot change it', () => {
    expect(Object.isFrozen(config.oversight.matrix.G1.low)).toBe(true);
    expect(() => {
      (config.budget as { warn_percent: number }).warn_percent = 99;
    }).toThrow(TypeError);
  });
});

describe('project overrides (AC1)', () => {
  it('merges mappings key by key', () => {
    const { config } = loadValid('oversight:\n  matrix:\n    G2:\n      low: { mode: HITL }\n');
    expect(config.oversight.matrix.G2.low).toEqual({
      mode: 'HITL',
      roles: ['person_a'],
      approvals: 1,
    });
    expect(config.oversight.matrix.G2.medium.mode).toBe('HITL');
  });

  it('replaces lists instead of merging them', () => {
    const { config } = loadValid(
      'escalation:\n  calendar:\n    working_days: [mon, tue, wed, thu, fri, sat]\n    holidays: [2027-02-08]\n',
    );
    expect(config.escalation.calendar.working_days).toEqual([
      'mon',
      'tue',
      'wed',
      'thu',
      'fri',
      'sat',
    ]);
    expect(config.escalation.calendar.holidays).toEqual(['2027-02-08']);
  });

  it('replaces durations and deadlines whole, so a clock can change form', () => {
    const { config } = loadValid(
      'escalation:\n  sla:\n    medium:\n      resolve: { value: 20, unit: hours }\n    low:\n      resolve: { kind: end_of_working_day }\n',
    );
    expect(config.escalation.sla.medium.resolve).toEqual({ value: 20, unit: 'hours' });
    expect(config.escalation.sla.low.resolve).toEqual({ kind: 'end_of_working_day' });
  });

  it('accepts extra change flags on the mandatory lists', () => {
    const { config } = loadValid(
      'oversight:\n  forced_hitl_g3:\n    change_flags: [migration, breaking_contract, new_service_boundary, security_boundary, system_of_record, prod_infrastructure, core_business_rule, payment]\n',
    );
    expect(config.oversight.forced_hitl_g3.change_flags).toContain('payment');
  });

  it('accepts an empty file and a comment-only file as "defaults only"', () => {
    expect(loadValid('').config).toEqual(defaultProjectConfig());
    expect(loadValid('# nothing here\n').config).toEqual(defaultProjectConfig());
  });
});

describe('schema errors (AC1, messages from the catalog: AC2)', () => {
  it.each([
    ['unknown top-level setting', 'colour: blue\n', 'config.schema.unknown_key', ''],
    [
      'unknown cell setting',
      'oversight:\n  matrix:\n    G1:\n      low: { mood: HITL }\n',
      'config.schema.unknown_key',
      'oversight.matrix.G1.low',
    ],
    [
      'wrong type',
      'retention:\n  evidence_retention_days: soon\n',
      'config.schema.invalid_type',
      'retention.evidence_retention_days',
    ],
    [
      'unknown mode',
      'oversight:\n  matrix:\n    G2:\n      low: { mode: MAYBE }\n',
      'config.schema.invalid_value',
      'oversight.matrix.G2.low.mode',
    ],
    [
      'unknown role',
      'oversight:\n  matrix:\n    G2:\n      low: { roles: [boss] }\n',
      'config.schema.invalid_value',
      'oversight.matrix.G2.low.roles[0]',
    ],
    [
      'duplicate role',
      'oversight:\n  matrix:\n    G2:\n      low: { roles: [person_a, person_a] }\n',
      'config.schema.duplicate_item',
      'oversight.matrix.G2.low.roles',
    ],
    [
      'zero retention',
      'retention:\n  evidence_retention_days: 0\n',
      'config.schema.too_small',
      'retention.evidence_retention_days',
    ],
    [
      'fractional retries',
      'run:\n  g6_ci_retries: 1.5\n',
      'config.schema.invalid_type',
      'run.g6_ci_retries',
    ],
    [
      'wrong schema version',
      'schema_version: 2\n',
      'config.schema.invalid_value',
      'schema_version',
    ],
    [
      'too many USD decimals',
      'budget:\n  default_run_usd: 0.1234567\n',
      'config.schema.too_many_decimals',
      'budget.default_run_usd',
    ],
    [
      'a whole section replaced by a scalar',
      'budget: 10\n',
      'config.schema.invalid_type',
      'budget',
    ],
    [
      'a duration without a unit (durations are replaced whole)',
      'escalation:\n  sla:\n    high:\n      acknowledge: { value: 30 }\n',
      'config.schema.missing',
      'escalation.sla.high.acknowledge.unit',
    ],
    [
      'a deadline mixing two forms',
      'escalation:\n  sla:\n    high:\n      resolve: { kind: end_of_working_day, value: 2 }\n',
      'config.schema.unknown_key',
      'escalation.sla.high.resolve',
    ],
    [
      'no working days',
      'escalation:\n  calendar:\n    working_days: []\n',
      'config.schema.too_few_items',
      'escalation.calendar.working_days',
    ],
    [
      'bad time zone',
      'escalation:\n  calendar:\n    time_zone: Mars/Base\n',
      'config.schema.invalid_time_zone',
      'escalation.calendar.time_zone',
    ],
    [
      'bad working hour',
      "escalation:\n  calendar:\n    working_hours: { start: '9am', end: '18:00' }\n",
      'config.schema.invalid_time',
      'escalation.calendar.working_hours.start',
    ],
    [
      'O08: reconciliation interval below the poll interval',
      'github:\n  poll_interval_seconds: 60\n  webhooks: { enabled: true, reconcile_interval_seconds: 30 }\n',
      'config.schema.reconcile_interval_too_short',
      'github',
    ],
    [
      'working hours reversed',
      "escalation:\n  calendar:\n    working_hours: { start: '18:00', end: '09:00' }\n",
      'config.schema.working_hours_order',
      'escalation.calendar.working_hours',
    ],
    [
      'impossible holiday',
      'escalation:\n  calendar:\n    holidays: [2027-02-30]\n',
      'config.schema.invalid_date',
      'escalation.calendar.holidays[0]',
    ],
    [
      'duplicate holiday',
      'escalation:\n  calendar:\n    holidays: [2027-02-08, 2027-02-08]\n',
      'config.schema.duplicate_item',
      'escalation.calendar.holidays',
    ],
  ])('%s', (_name, yaml, key, path) => {
    expect(keysAndPaths(loadErrors(yaml))).toContainEqual([key, path]);
  });

  it('never shows text from the validation library', () => {
    const errors = loadErrors('colour: blue\nbudget: 10\nschema_version: 2\n');
    for (const error of errors) {
      expect(formatIssue(error)).not.toMatch(
        /Invalid input|Unrecognized key|expected .* received/i,
      );
    }
  });
});

describe('safe YAML reading (AC1)', () => {
  const bomb = [
    'a: &a [x, x, x, x, x, x, x, x, x]',
    'b: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a]',
    'c: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b]',
    'd: [*c, *c, *c, *c, *c, *c, *c, *c, *c]',
  ].join('\n');

  it.each([
    [
      'duplicate keys',
      'budget:\n  warn_percent: 70\n  warn_percent: 60\n',
      'config.yaml.duplicate_key',
    ],
    ['custom tags', 'budget:\n  warn_percent: !env WARN\n', 'config.yaml.syntax'],
    [
      'YAML 1.1 timestamps',
      'escalation:\n  calendar:\n    holidays: [!!timestamp 2027-02-08]\n',
      'config.yaml.syntax',
    ],
    ['YAML 1.1 binary', 'github: !!binary aGk=\n', 'config.yaml.syntax'],
    ['broken syntax', 'budget: [1\n', 'config.yaml.syntax'],
    ['alias bombs', bomb, 'config.yaml.too_many_aliases'],
    ['a list at the root', '- 1\n- 2\n', 'config.yaml.not_a_mapping'],
    ['a scalar at the root', 'hello\n', 'config.yaml.not_a_mapping'],
  ])('refuses %s', (_name, yaml, key) => {
    expect(loadErrors(yaml).map((e) => e.key)).toContain(key);
  });

  it.each([
    ['at the root', '__proto__:\n  polluted: yes\n', ''],
    ['inside a section', 'budget:\n  __proto__: { warn_percent: 99 }\n', 'budget'],
  ])(
    'refuses a __proto__ key %s as an unknown setting (no prototype change)',
    (_name, yaml, path) => {
      expect(keysAndPaths(loadErrors(yaml))).toContainEqual(['config.schema.unknown_key', path]);
      expect(loadErrors(yaml)[0]?.params).toEqual({ key: '__proto__' });
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    },
  );

  it('reports the line and column of a YAML error', () => {
    const [error] = loadErrors('budget:\n  warn_percent: 70\n  warn_percent: 60\n');
    expect(error?.params).toMatchObject({ line: 3, column: 3 });
    expect(formatIssue(error!)).toBe('The YAML has a duplicate key at line 3, column 3.');
  });

  it('keeps dates as plain strings (YAML 1.2 core schema)', () => {
    const { config } = loadValid('escalation:\n  calendar:\n    holidays: [2027-02-08]\n');
    expect(typeof config.escalation.calendar.holidays[0]).toBe('string');
  });
});
