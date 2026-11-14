// `adlc intent create|list|show` over the API (D-08 B04 AC1, FR-20; ADR-M26 §2.8).
// `create --spec` (U03) links the spec right after, with the same call as `adlc spec link`; a
// refused link keeps the intent and says how to link again.
import { readFile } from 'node:fs/promises';

import { DATA_CLASSES, INTENT_STATUSES, RISK_TIERS } from '@sdlc/contracts';
import { INTENT_CODE_PATTERN } from '@sdlc/core';
import { isHold, WAITING_CAUSE_KEYS, WAITING_REASON_KEYS } from '@sdlc/api-schemas';
import { t, type MessageKey } from '@sdlc/messages';

import {
  intentDetailSchema,
  intentPageSchema,
  intentSchema,
  lessonSchema,
  type DecisionView,
  type IntentDetail,
  type IntentView,
} from '../api/schemas.js';
import { ApiCallError } from '../api/client.js';
import { exitCodeOf, reportApiFailure } from '../api/errors.js';
import { CommandExit, parseCommand, segment, withApi, type Values } from '../api/session.js';
import { EXIT, type CliContext } from '../context.js';
import { say, sayError, show, toJson } from '../output.js';
import { linkSpec, sayLinked, specLinkBody } from './spec-link.js';
import type { ApiClient } from '../api/client.js';
import { sayNextHint } from './next/hint.js';

/** The API's limits (ADR-M26 §2.8, `createIntentSchema`). */
const MAX_DESCRIPTION = 10_000;
const MAX_PAGE = 100;
const DECIMAL = /^\d{1,12}(\.\d{1,6})?$/;
const LESSON_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const OPTIONS = {
  create: {
    project: { type: 'string' },
    title: { type: 'string' },
    description: { type: 'string' },
    'description-file': { type: 'string' },
    risk: { type: 'string' },
    'data-class': { type: 'string' },
    budget: { type: 'string' },
    issue: { type: 'string' },
    spec: { type: 'string' },
    'spec-commit': { type: 'string' },
    'spec-tool': { type: 'string' },
    // X08b (ADR-M109 §2.5): a follow-up of a lesson; its project when --project is left out.
    'from-lesson': { type: 'string' },
  },
  list: {
    project: { type: 'string' },
    status: { type: 'string' },
    limit: { type: 'string' },
    cursor: { type: 'string' },
    // X08a (ADR-M109 §2.1): the filters of `GET /v1/intents`.
    gate: { type: 'string' },
    risk: { type: 'string' },
    'created-from': { type: 'string' },
    'created-to': { type: 'string' },
    'closed-from': { type: 'string' },
    'closed-to': { type: 'string' },
    sealed: { type: 'string' },
    'has-lessons': { type: 'string' },
    search: { type: 'string' },
  },
  show: {},
  estimate: { hours: { type: 'string' } },
} as const;

/** V14: hours from 0.25 to 10000 with at most two decimals (the API's `effortEstimateSchema`). */
const HOURS = /^(0|[1-9][0-9]{0,4})(\.[0-9]{1,2})?$/;

export async function runIntent(args: readonly string[], ctx: CliContext): Promise<number> {
  const [command, ...rest] = args;
  if (command === 'create') return create(rest, ctx);
  if (command === 'list') return list(rest, ctx);
  if (command === 'show') return showIntent(rest, ctx);
  if (command === 'estimate') return estimate(rest, ctx);
  return usage(ctx);
}

/** An intent code (any case) or UUID, as the API expects it; undefined when neither. */
export function intentRef(value: string): string | undefined {
  const upper = value.toUpperCase();
  if (INTENT_CODE_PATTERN.test(upper)) return upper;
  return UUID.test(value) ? value.toLowerCase() : undefined;
}

async function create(args: readonly string[], ctx: CliContext): Promise<number> {
  const parsed = parseCommand(args, OPTIONS.create);
  const values = parsed?.values;
  if (!values || !validCreate(values)) return usage(ctx);
  const specBody = specOptions(values);
  if (specBody === null) return usage(ctx);
  const json = values.json === true;
  return withApi(ctx, json, async (client) => {
    const fromLesson = values['from-lesson'];
    const lesson =
      typeof fromLesson === 'string'
        ? await client.get(`/v1/lessons/${fromLesson}`, lessonSchema)
        : undefined;
    const body = {
      project: typeof values.project === 'string' ? values.project : show(lesson?.project),
      ...(lesson === undefined ? {} : { from_lesson: lesson.id }),
      title: String(values.title),
      description: await description(ctx, values),
      risk_tier: String(values.risk),
      data_class: String(values['data-class']),
      ...(typeof values.budget === 'string' ? { budget_usd: values.budget } : {}),
      ...(typeof values.issue === 'string' ? { issue_number: Number(values.issue) } : {}),
    };
    const intent = await client.post('/v1/intents', intentSchema, body);
    if (specBody === undefined) {
      if (json) ctx.stdout(toJson(intent));
      else say(ctx, 'cli.intent.created', summary(intent));
      await sayNextHint(ctx, client, intent.code, json);
      return EXIT.ok;
    }
    if (!json) say(ctx, 'cli.intent.created', summary(intent));
    return linkAfterCreate(ctx, client, intent, specBody, json);
  });
}

/**
 * The spec options as a link request body: undefined without `--spec`, null when malformed
 * (`--spec-commit` or `--spec-tool` without `--spec` too), checked before any API call.
 */
function specOptions(values: Values): Record<string, string> | undefined | null {
  if (values.spec === undefined) {
    return values['spec-commit'] === undefined && values['spec-tool'] === undefined
      ? undefined
      : null;
  }
  return (
    specLinkBody({ path: values.spec, commit: values['spec-commit'], tool: values['spec-tool'] }) ??
    null
  );
}

/** U03: links the spec of the intent just created; a failure keeps the intent and names it. */
async function linkAfterCreate(
  ctx: CliContext,
  client: ApiClient,
  intent: IntentView,
  specBody: Record<string, string>,
  json: boolean,
): Promise<number> {
  try {
    const spec = await linkSpec(client, intent.code, specBody);
    if (json) ctx.stdout(toJson({ intent, spec, spec_error: null }));
    else sayLinked(ctx, spec);
    await sayNextHint(ctx, client, intent.code, json);
    return EXIT.ok;
  } catch (error) {
    if (!(error instanceof ApiCallError)) throw error;
    if (json) {
      const specError = error.envelope?.error ?? {
        code: `cli_${error.kind}`,
        ...(error.status === undefined ? {} : { status: error.status }),
      };
      ctx.stdout(toJson({ intent, spec: null, spec_error: specError }));
      return exitCodeOf(error);
    }
    const exit = reportApiFailure(ctx, error, false);
    sayError(ctx, 'cli.intent.spec_link_refused', { code: intent.code, path: specBody.path ?? '' });
    return exit;
  }
}

function validCreate(values: Values): boolean {
  if (!['title', 'risk', 'data-class'].every((k) => typeof values[k] === 'string')) return false;
  const lesson = values['from-lesson'];
  if (lesson !== undefined && (typeof lesson !== 'string' || !LESSON_ID.test(lesson))) return false;
  if (typeof values.project !== 'string' && lesson === undefined) return false;
  if (values.description !== undefined && values['description-file'] !== undefined) return false;
  if (!(RISK_TIERS as readonly string[]).includes(String(values.risk))) return false;
  if (!(DATA_CLASSES as readonly string[]).includes(String(values['data-class']))) return false;
  if (typeof values.budget === 'string' && !DECIMAL.test(values.budget)) return false;
  if (typeof values.issue === 'string' && !/^[1-9]\d{0,8}$/.test(values.issue)) return false;
  return true;
}

async function description(ctx: CliContext, values: Values): Promise<string> {
  const file = values['description-file'];
  const text =
    typeof file === 'string'
      ? await readFile(file, 'utf8').catch(() => {
          sayError(ctx, 'cli.intent.description_unreadable', { file });
          throw new CommandExit(EXIT.usage);
        })
      : typeof values.description === 'string'
        ? values.description
        : '';
  if (text.length > MAX_DESCRIPTION) {
    sayError(ctx, 'cli.intent.description_too_long', { max: MAX_DESCRIPTION });
    throw new CommandExit(EXIT.usage);
  }
  return text;
}

const GATE = /^G[1-8]$/;
const RISKS = ['low', 'medium', 'high', 'critical'];
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** X08a: the filter options as API query parameters; undefined when one is not valid. */
function listFilters(values: Values): Record<string, string> | undefined {
  const text = (name: string) => (typeof values[name] === 'string' ? values[name] : undefined);
  const out: Record<string, string> = {};
  const gate = text('gate');
  if (gate !== undefined) {
    if (!GATE.test(gate)) return undefined;
    out.gate = gate;
  }
  const risk = text('risk');
  if (risk !== undefined) {
    if (!RISKS.includes(risk)) return undefined;
    out.risk_tier = risk;
  }
  for (const [option, param] of [
    ['created-from', 'created_from'],
    ['created-to', 'created_to'],
    ['closed-from', 'closed_from'],
    ['closed-to', 'closed_to'],
  ] as const) {
    const day = text(option);
    if (day === undefined) continue;
    if (!DAY.test(day)) return undefined;
    out[param] = day;
  }
  const sealed = text('sealed');
  if (sealed !== undefined) {
    if (sealed !== 'yes' && sealed !== 'no') return undefined;
    out.sealed = sealed === 'yes' ? 'true' : 'false';
  }
  const hasLessons = text('has-lessons');
  if (hasLessons !== undefined) {
    if (hasLessons !== 'yes' && hasLessons !== 'no') return undefined;
    out.has_lessons = hasLessons === 'yes' ? 'true' : 'false';
  }
  const search = text('search')?.trim();
  if (search !== undefined) {
    if (search.length < 2 || search.length > 200) return undefined;
    out.q = search;
  }
  return out;
}

async function list(args: readonly string[], ctx: CliContext): Promise<number> {
  const values = parseCommand(args, OPTIONS.list)?.values;
  if (!values) return usage(ctx);
  if (
    typeof values.status === 'string' &&
    !(INTENT_STATUSES as readonly string[]).includes(values.status)
  ) {
    return usage(ctx);
  }
  const limit = typeof values.limit === 'string' ? Number(values.limit) : undefined;
  if (limit !== undefined && !(Number.isInteger(limit) && limit >= 1 && limit <= MAX_PAGE)) {
    return usage(ctx);
  }
  const filters = listFilters(values);
  if (filters === undefined) return usage(ctx);
  const json = values.json === true;
  return withApi(ctx, json, async (client) => {
    const page = await client.get('/v1/intents', intentPageSchema, {
      project: values.project as string | undefined,
      status: values.status as string | undefined,
      limit,
      cursor: values.cursor as string | undefined,
      ...filters,
    });
    if (json) {
      ctx.stdout(toJson(page));
      return EXIT.ok;
    }
    if (page.items.length === 0) say(ctx, 'cli.intent.none');
    for (const intent of page.items) {
      say(ctx, 'cli.intent.line', {
        code: intent.code,
        status: intent.status,
        gate: show(intent.current_gate),
        risk: intent.risk_tier,
        project: intent.project.slug,
        title: intent.title,
      });
    }
    if (page.next_cursor !== null) say(ctx, 'cli.intent.more', { cursor: page.next_cursor });
    return EXIT.ok;
  });
}

async function showIntent(args: readonly string[], ctx: CliContext): Promise<number> {
  const parsed = parseCommand(args, OPTIONS.show, 1);
  const ref = parsed ? intentRef(parsed.positionals[0] ?? '') : undefined;
  if (!parsed || ref === undefined) return usage(ctx);
  const json = parsed.values.json === true;
  return withApi(ctx, json, async (client) => {
    const intent = await client.get(`/v1/intents/${segment(ref)}`, intentDetailSchema);
    if (json) ctx.stdout(toJson(intent));
    else printDetail(ctx, intent);
    return EXIT.ok;
  });
}

/** V14 (ADR-M79 §2.6): records a person's estimate of the human effort, in hours. */
async function estimate(args: readonly string[], ctx: CliContext): Promise<number> {
  const parsed = parseCommand(args, OPTIONS.estimate, 1);
  const ref = parsed ? intentRef(parsed.positionals[0] ?? '') : undefined;
  const hours = parsed?.values.hours;
  if (!parsed || ref === undefined || typeof hours !== 'string' || !validHours(hours)) {
    return usage(ctx);
  }
  const json = parsed.values.json === true;
  return withApi(ctx, json, async (client) => {
    const intent = await client.put(`/v1/intents/${segment(ref)}/effort-estimate`, intentSchema, {
      hours: Number(hours),
    });
    if (json) ctx.stdout(toJson(intent));
    else
      say(ctx, 'cli.intent.estimated', {
        code: intent.code,
        hours: show(intent.human_effort_hours),
      });
    return EXIT.ok;
  });
}

function validHours(value: string): boolean {
  if (!HOURS.test(value)) return false;
  const hours = Number(value);
  return hours >= 0.25 && hours <= 10_000;
}

function printDetail(ctx: CliContext, intent: IntentDetail): void {
  say(ctx, 'cli.intent.detail', {
    ...summary(intent),
    title: intent.title,
    gate: show(intent.current_gate),
    issue: show(intent.issue_number),
    pr: show(intent.pr_number),
    created_at: intent.created_at,
    effort: show(intent.human_effort_hours),
  });
  printHold(ctx, intent);
  if (intent.spec) {
    say(ctx, 'cli.intent.spec', {
      version: intent.spec.version,
      path: intent.spec.path,
      commit: intent.spec.commit_sha,
      sha256: intent.spec.content_sha256,
    });
  } else {
    say(ctx, 'cli.intent.spec_none');
  }
  if (intent.plan) {
    say(ctx, 'cli.intent.plan', {
      version: intent.plan.version,
      sha256: intent.plan.plan_sha256,
      flags: intent.plan.change_flags.join(',') || '-',
    });
  } else {
    say(ctx, 'cli.intent.plan_none');
  }
  printLinks(ctx, intent);
  if (intent.decisions.length === 0) say(ctx, 'cli.intent.decisions_none');
  for (const decision of intent.decisions)
    say(ctx, 'cli.intent.decision', decisionParams(decision));
}

/** X08a (ADR-M109 §2.1): the addresses to follow, one line each; nothing when there are none. */
function printLinks(ctx: CliContext, intent: IntentDetail): void {
  const links = intent.links;
  if (!links) return;
  const line = (kind: MessageKey, url: string | null | undefined, ref: string) =>
    say(ctx, 'cli.intent.link', { kind: t(kind), target: url ?? ref });
  if (links.issue) line('cli.intent.link_issue', links.issue.url, `#${String(links.issue.number)}`);
  if (links.pull_request) {
    line('cli.intent.link_pr', links.pull_request.url, `#${String(links.pull_request.number)}`);
  }
  if (links.spec) line('cli.intent.link_spec', links.spec.url, links.spec.path);
  if (links.plan) line('cli.intent.link_plan', links.plan.url, links.plan.path);
  if (links.evidence.sealed) line('cli.intent.link_evidence', undefined, links.evidence.path);
  // X08b (ADR-M109 §2.5): the lessons and the intents created from them.
  for (const lesson of links.lessons ?? []) {
    say(ctx, 'cli.intent.link_lesson', {
      id: lesson.id,
      category: lesson.category,
      target: lesson.target,
      state: lesson.state,
      comment: lesson.comment_url,
    });
  }
  for (const code of links.follow_ups ?? []) {
    line('cli.intent.link_follow_up', undefined, code);
  }
}

/** U02 (ADR-M54 §2.4b): what holds the intent, as the workflow's step recorded it. */
function printHold(ctx: CliContext, intent: IntentDetail): void {
  if (!isHold(intent.waiting_reason)) return;
  const label = (keys: Readonly<Record<string, string>>, code: string): string => {
    const key = keys[code];
    return key ? t(key as MessageKey) : code;
  };
  say(ctx, 'cli.intent.waiting', {
    reason: label(WAITING_REASON_KEYS, intent.waiting_reason),
    since: show(intent.waiting_since),
  });
  if (intent.waiting_cause) {
    say(ctx, 'cli.intent.waiting_cause', {
      cause: label(WAITING_CAUSE_KEYS, intent.waiting_cause),
    });
  }
  if (intent.waiting_until) {
    say(ctx, 'cli.intent.waiting_until', { until: intent.waiting_until });
  }
}

export function decisionParams(decision: DecisionView): Record<string, string> {
  return {
    gate: decision.gate,
    decision: decision.decision,
    mode: decision.oversight_mode,
    role: show(decision.approver_role),
    actor: decision.actor_type,
    reason: show(decision.reason_code),
    at: decision.created_at,
    expires: show(decision.expires_at),
  };
}

function summary(intent: IntentView): Record<string, string> {
  return {
    code: intent.code,
    project: intent.project.slug,
    status: intent.status,
    risk: intent.risk_tier,
    data_class: intent.data_class,
    max_autonomy: intent.max_autonomy,
    budget: intent.budget_usd,
  };
}

function usage(ctx: CliContext): number {
  ctx.stderr(t('cli.intent.usage'));
  return EXIT.usage;
}
