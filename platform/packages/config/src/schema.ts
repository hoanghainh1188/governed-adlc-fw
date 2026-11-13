// Structural schema of the effective project configuration (design/D-08 A05 AC1).
// Mandatory handbook rules are checked separately, in mandatory-rules.ts.
// Error text never comes from zod: issues are mapped to message keys in `toConfigIssues`.
import {
  AGENT_KEY_PATTERN,
  AUTONOMY_LEVELS,
  CHANGE_FLAGS,
  CONTEXT_CONDENSING_MODES,
  OVERSIGHT_MODES,
  PROJECT_ROLES,
  PROVIDER_TYPES,
  RESPONSE_LEVELS,
  SAFE_ACTIONS,
  SEVERITIES,
} from '@sdlc/contracts';
import type { MessageKey } from '@sdlc/messages';
import { z } from 'zod';

import { formatPath, issue, type ConfigIssue } from './issues.js';

const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_USD_DECIMALS = 6; // design/D-05 principle D6: numeric(18,6)

type RefineContext = z.core.$RefinementCtx;

function addIssue(ctx: RefineContext, key: MessageKey, params: Record<string, string> = {}): void {
  ctx.addIssue({ code: 'custom', input: undefined, params: { key, ...params } });
}

function uniqueList<T extends z.ZodType>(item: T) {
  return z.array(item).superRefine((items, ctx) => {
    const seen = new Set<unknown>();
    for (const value of items) {
      if (seen.has(value)) addIssue(ctx, 'config.schema.duplicate_item', { item: String(value) });
      seen.add(value);
    }
  });
}

function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

const positiveInt = z.number().int().positive();
/** Same as the Run Contract's `allowed_models` entries. */
const MODEL_REF = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;
/** X11: bounds of a model's context size in `run.context_condensing.model_context_tokens`. */
export const MIN_CONTEXT_TOKENS = 4096;
export const MAX_CONTEXT_TOKENS = 2_000_000;
/** A share strictly between 0 and 1 (L06 thresholds). */
const share = z.number().gt(0).lt(1);
const nonNegativeInt = z.number().int().nonnegative();
const usd = z
  .number()
  .positive()
  .superRefine((value, ctx) => {
    const decimals = value.toString().split('.')[1]?.length ?? 0;
    if (decimals > MAX_USD_DECIMALS || value.toString().includes('e')) {
      addIssue(ctx, 'config.schema.too_many_decimals', { maximum: String(MAX_USD_DECIMALS) });
    }
  });

// L07 (ADR-M85 §2.4): a repository-relative glob (no `..`, no absolute path, no `.git`) and a
// command run with `sh -c` in the scoring container: plain words only, as the task format of
// `@sdlc/eval`. `{file}` in a `fail_to_pass` command stands for one hidden test file.
const TEST_GLOB = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!\.git(?:\/|$))[A-Za-z0-9._*/@{},-]{1,200}$/;
const TASK_COMMAND = /^[A-Za-z0-9@][A-Za-z0-9 @/._:={}-]{0,199}$/;
const taskCommands = z.array(z.string().regex(TASK_COMMAND)).max(20);
const role = z.enum(PROJECT_ROLES);
const oversightMode = z.enum(OVERSIGHT_MODES);

const cell = z.strictObject({
  mode: z.enum([...OVERSIGHT_MODES, 'POLICY']),
  roles: uniqueList(role).default([]),
  approvals: positiveInt.default(1),
  on_breach: oversightMode.optional(),
});

const tierMatrix = z.strictObject({ low: cell, medium: cell, high: cell, critical: cell });

const duration = z.strictObject({
  value: positiveInt,
  unit: z.enum(['minutes', 'hours', 'days', 'working_hours', 'working_days']),
});

const deadline = z.union([
  duration,
  z.strictObject({ kind: z.literal('end_of_working_day') }),
  z.strictObject({ kind: z.literal('next_planned_work') }),
]);

const hhmm = z.string().superRefine((value, ctx) => {
  if (!HH_MM.test(value)) addIssue(ctx, 'config.schema.invalid_time', { value });
});

const calendar = z.strictObject({
  time_zone: z.string().superRefine((value, ctx) => {
    if (!isValidTimeZone(value)) addIssue(ctx, 'config.schema.invalid_time_zone', { value });
  }),
  working_days: uniqueList(z.enum(WEEKDAYS)).min(1),
  working_hours: z.strictObject({ start: hhmm, end: hhmm }).superRefine((hours, ctx) => {
    if (HH_MM.test(hours.start) && HH_MM.test(hours.end) && hours.start >= hours.end) {
      addIssue(ctx, 'config.schema.working_hours_order', hours);
    }
  }),
  holidays: uniqueList(
    z.string().superRefine((value, ctx) => {
      if (!isValidIsoDate(value)) addIssue(ctx, 'config.schema.invalid_date', { value });
    }),
  ).default([]),
});

const sla = z.strictObject({ acknowledge: duration, resolve: deadline });

const escalationRouting = z.strictObject({ owner_role: role, backup_role: role.nullable() });

const providerList = uniqueList(z.enum(PROVIDER_TYPES));

const autonomyLevel = z.enum(AUTONOMY_LEVELS);

// A container image pinned by digest (QUESTIONS #59, ADR-M25): `[registry/]name[:tag]@sha256:<hex>`.
// A tag alone can move, so it is refused.
const PINNED_IMAGE =
  /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]{1,5})?(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)+(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?@sha256:[0-9a-f]{64}$/;
const pinnedImage = z.string().superRefine((value, ctx) => {
  if (!PINNED_IMAGE.test(value)) addIssue(ctx, 'config.schema.image_not_pinned', { value });
});

/** A CI check name as GitHub shows it (check run or commit status context): no control characters. */
const checkName = z
  .string()
  .min(1)
  .max(200)
  .refine((name) => [...name].every((ch) => ch.charCodeAt(0) > 31 && ch.charCodeAt(0) !== 127), {
    message: 'control characters are not allowed',
  });

export const projectConfigSchema = z.strictObject({
  schema_version: z.literal(1),
  oversight: z.strictObject({
    matrix: z.strictObject({
      G1: tierMatrix,
      G2: tierMatrix,
      G3: tierMatrix,
      G4: tierMatrix,
      G5: tierMatrix,
      G6: tierMatrix,
      G7: tierMatrix,
      G8: z.strictObject({ production: tierMatrix, non_production: tierMatrix }),
    }),
    forced_hitl_g3: z.strictObject({ change_flags: uniqueList(z.enum(CHANGE_FLAGS)) }),
    dual_approval_g7: z.strictObject({
      change_flags: uniqueList(z.enum(CHANGE_FLAGS)),
      roles: uniqueList(role),
    }),
    g6_security_findings: z.strictObject({
      mode: oversightMode,
      min_severity: z.enum(SEVERITIES),
    }),
    hitl_gate_deadline: duration,
    hotl_block_window: duration,
    approval_expiry: duration,
    gate_overdue: z.strictObject({
      severity: z.enum(SEVERITIES),
      response_level: z.enum(RESPONSE_LEVELS),
    }),
  }),
  autonomy: z.strictObject({
    max_by_risk: z.strictObject({
      low: autonomyLevel,
      medium: autonomyLevel,
      high: autonomyLevel,
      critical: autonomyLevel,
    }),
  }),
  escalation: z.strictObject({
    sla: z.strictObject({ critical: sla, high: sla, medium: sla, low: sla }),
    calendar,
    routing: z.strictObject({
      intent: escalationRouting,
      technical: escalationRouting,
      security: escalationRouting,
      policy: escalationRouting,
    }),
    notify_on_raise: z.strictObject({
      critical: uniqueList(role),
      high: uniqueList(role),
      medium: uniqueList(role),
      low: uniqueList(role),
    }),
    reminder_percent: positiveInt.max(99),
    safe_actions: uniqueList(z.enum(SAFE_ACTIONS)),
  }),
  run: z.strictObject({
    g6_ci_retries: nonNegativeInt,
    loop_detection: z.strictObject({
      identical_tool_calls_max: positiveInt,
      no_progress_window_minutes: positiveInt,
    }),
    contract_validity_minutes: positiveInt,
    contract_clock_skew_seconds: nonNegativeInt,
    default_max_iterations: positiveInt,
    default_max_duration_minutes: positiveInt,
    agent_key: z.string().regex(AGENT_KEY_PATTERN).nullable(),
    contract_attempts_max: positiveInt.max(10),
    failed_run_escalation: z.strictObject({
      severity: z.enum(SEVERITIES),
      response_level: z.enum(RESPONSE_LEVELS),
    }),
    g5_breach_escalation: z.strictObject({
      severity: z.enum(SEVERITIES),
      response_level: z.enum(RESPONSE_LEVELS),
    }),
    // C11 (ADR-M42, QUESTIONS #181): the escalation a kill switch raises.
    kill_escalation: z.strictObject({
      severity: z.enum(SEVERITIES),
      response_level: z.enum(RESPONSE_LEVELS),
    }),
    // H05 (ADR-M95, QUESTIONS #456): the largest change a person must review; over it G5 is HITL.
    review_limits: z.strictObject({
      max_changed_files: positiveInt,
      max_changed_lines: positiveInt,
    }),
    // X11 (ADR-M29 §2.10, QUESTIONS #551–#554): context condensing of OpenHands work runs. Rule
    // M35: `summarize` needs a context size for at least one model and fewer kept events than the
    // maximum. Model names are `allowed_models` entries.
    context_condensing: z.strictObject({
      mode: z.enum(CONTEXT_CONDENSING_MODES),
      max_events: positiveInt.min(10).max(1000),
      keep_first: nonNegativeInt.max(50),
      model_context_tokens: z.record(
        z.string().regex(MODEL_REF),
        positiveInt.min(MIN_CONTEXT_TOKENS).max(MAX_CONTEXT_TOKENS),
      ),
    }),
  }),
  budget: z.strictObject({
    warn_percent: positiveInt,
    stop_percent: positiveInt,
    default_intent_usd: usd,
    default_run_usd: usd,
  }),
  model_routing: z.strictObject({
    allowed_provider_types: z.strictObject({
      public: providerList,
      internal: providerList,
      client_confidential: providerList,
      client_restricted: providerList,
      prohibited: providerList,
    }),
  }),
  retention: z.strictObject({ evidence_retention_days: positiveInt }),
  github: z.strictObject({ poll_interval_seconds: positiveInt }),
  // C08 PR 2 (QUESTIONS #159, ADR-M38 §2.7): what G6 reads from CI.
  verification: z.strictObject({
    required_checks: uniqueList(checkName).max(50),
    ci_timeout_minutes: positiveInt.max(24 * 60),
    // O06 (ADR-M106): a commit with no check at all stops sooner than a slow CI.
    ci_missing_minutes: positiveInt.max(24 * 60),
  }),
  access: z.strictObject({
    intent_create_roles: uniqueList(role).min(1),
    intent_read_roles: uniqueList(role).min(1),
    ai_record_write_roles: uniqueList(role).min(1),
    ai_record_read_roles: uniqueList(role).min(1),
    spec_link_roles: uniqueList(role).min(1),
    plan_submit_roles: uniqueList(role).min(1),
    // C11 (ADR-M42, QUESTIONS #180): who may stop a run with the kill switch.
    kill_roles: uniqueList(role).min(1),
    // E04 (ADR-M45, QUESTIONS #196): who may read the cost report of one project or intent.
    cost_read_roles: uniqueList(role).min(1),
    // E06 (ADR-M47, QUESTIONS #206): who may read the gate waiting-time metrics of one project.
    metrics_read_roles: uniqueList(role).min(1),
    // E02 (ADR-M48, QUESTIONS #218): who may build, and who may read, an intent's Evidence Pack.
    evidence_build_roles: uniqueList(role).min(1),
    evidence_read_roles: uniqueList(role).min(1),
    // E05 (ADR-M51, QUESTIONS #235): who may put an intent's evidence on hold and release it.
    evidence_hold_roles: uniqueList(role).min(1),
    // L05 (ADR-M82, QUESTIONS #470): who may create, change, archive and run evaluation plans.
    eval_roles: uniqueList(role).min(1),
    conflicting_roles: z.array(uniqueList(role).length(2)),
  }),
  agents: z.strictObject({
    recertification_months: positiveInt,
    // L09 (ADR-M86 §2.4, QUESTIONS #496–#499): what an evaluation must reach before an agent
    // version is approved or recertified. Rule M34 keeps the recertification age at 90 days or less.
    evaluation: z.strictObject({
      mode: z.enum(['off', 'warn', 'required']),
      min_tasks: positiveInt.max(1000),
      min_resolve_rate: z.number().min(0).max(1),
      approval_max_age_days: positiveInt.max(365),
      recertification_max_age_days: positiveInt.max(365),
    }),
  }),
  // X04 PR 3a (ADR-M89 §2.3): the limits of the index of a project's documents.
  knowledge: z.strictObject({
    max_files: positiveInt.max(100_000),
    max_file_bytes: positiveInt.max(10 * 1024 * 1024),
    max_total_bytes: positiveInt.max(1024 * 1024 * 1024),
    max_chunks: positiveInt.max(1_000_000),
    chunk_chars: positiveInt.min(200).max(20_000),
    embed_batch: positiveInt.max(256),
  }),
  // X06 (ADR-M108 §2.6): the limits of the code index.
  code_index: z.strictObject({
    max_files: positiveInt.max(200_000),
    max_file_bytes: positiveInt.max(16 * 1024 * 1024),
    max_total_bytes: positiveInt.max(2 * 1024 * 1024 * 1024),
    max_symbols: positiveInt.max(10_000_000),
    parse_timeout_ms: positiveInt.min(100).max(60_000),
  }),
  // X04 (ADR-M69 §2.2–§2.7, ADR-M87): register tools. Rule M18 keeps the recertification age at 3
  // months or less, as for agents. `gateway.image`: the run's MCP gateway, by digest; null until a
  // gateway is set up (no register tool runs without one).
  tools: z.strictObject({
    recertification_months: positiveInt,
    max_calls_per_run: positiveInt.max(10_000),
    container_limits: z.strictObject({
      memory_mb: positiveInt.max(16_384),
      cpu_millis: positiveInt.max(16_000),
      pids: positiveInt.max(4096),
    }),
    gateway: z.strictObject({ image: pinnedImage.nullable() }),
    model_budget_usd: usd,
  }),
  // X03 (QUESTIONS #522, #528): `image` is the OpenHands image; `images` gives one image per
  // adapter, each by digest. An `images.openhands` entry must equal `image`.
  sandbox: z
    .strictObject({
      image: pinnedImage,
      images: z
        .strictObject({ openhands: pinnedImage.optional(), opencode: pinnedImage.optional() })
        .optional(),
    })
    .superRefine((sandbox, ctx) => {
      const openhands = sandbox.images?.openhands;
      if (openhands !== undefined && openhands !== sandbox.image) {
        addIssue(ctx, 'config.schema.sandbox_images_conflict');
      }
    }),
  // H02 (ADR-M96 §2.2): dependency checks for libraries added or changed by an agent.
  dependencies: z.strictObject({
    allowed_licenses: uniqueList(z.string().min(1).max(64)),
    blocked_packages: uniqueList(z.string().min(1).max(128)),
  }),
  // L06 (ADR-M83 §2.3, QUESTIONS #481): thresholds of the evaluation recommendation rules.
  evaluation: z.strictObject({
    // L07 (ADR-M85 §2.4, QUESTIONS #485): how `adlc eval task draft` finds the hidden tests of a
    // merged pull request and which commands it proposes for the task card.
    tasks: z.strictObject({
      test_globs: uniqueList(z.string().regex(TEST_GLOB)).min(1).max(20),
      commands: z.strictObject({
        fail_to_pass: taskCommands,
        pass_to_pass: taskCommands,
        ci: taskCommands,
      }),
    }),
    recommendations: z.strictObject({
      alpha: share.max(0.1),
      min_paired_tasks: positiveInt.min(2).max(1000),
      low_ci_first_try_rate: share,
      unstable_gap: share,
      stopped_at_cap_share: share,
    }),
  }),
});

/** Maps zod issues to catalog-keyed configuration issues. Zod's own English text is never used. */
export function toConfigIssues(zodIssues: readonly z.core.$ZodIssue[]): ConfigIssue[] {
  return zodIssues.flatMap((zodIssue) => fromZodIssue(zodIssue));
}

function fromZodIssue(zodIssue: z.core.$ZodIssue): ConfigIssue[] {
  const path = formatPath(zodIssue.path);
  // With `reportInput`, a missing setting is a type or value issue whose input is undefined.
  const missing = 'input' in zodIssue && zodIssue.input === undefined;
  if (missing && (zodIssue.code === 'invalid_type' || zodIssue.code === 'invalid_value')) {
    return [issue('config.schema.missing', path)];
  }
  switch (zodIssue.code) {
    case 'invalid_type':
      return [issue('config.schema.invalid_type', path, { expected: zodIssue.expected })];
    case 'unrecognized_keys':
      return zodIssue.keys.map((key) => issue('config.schema.unknown_key', path, { key }));
    case 'invalid_value':
      return [
        issue('config.schema.invalid_value', path, {
          allowed: zodIssue.values.map((value) => String(value)).join(', '),
        }),
      ];
    case 'too_small':
      return [
        zodIssue.origin === 'array'
          ? issue('config.schema.too_few_items', path, { minimum: String(zodIssue.minimum) })
          : issue('config.schema.too_small', path, { minimum: String(zodIssue.minimum) }),
      ];
    case 'too_big':
      return [issue('config.schema.too_big', path, { maximum: String(zodIssue.maximum) })];
    case 'custom':
      return [fromCustomIssue(path, zodIssue.params)];
    default:
      return [issue('config.schema.invalid', path)];
  }
}

function fromCustomIssue(path: string, params: Record<string, unknown> | undefined): ConfigIssue {
  const { key, ...rest } = params ?? {};
  if (typeof key !== 'string') return issue('config.schema.invalid', path);
  const values = Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, String(v)]));
  return issue(key as MessageKey, path, values);
}
