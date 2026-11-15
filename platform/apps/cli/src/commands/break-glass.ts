// `adlc break-glass request|approve|refuse|revoke|review|list` over the API (task H08 PR 3a,
// ADR-M111 §2.4, §2.9; QUESTIONS #742). A grant gives one intent named scopes for a few hours in a
// production P0 incident. Person A or Person B requests it with a GitHub comment that explains the
// incident; governance or Person B approves it, never the requester or a producer. The words stay
// in the comments; the platform keeps codes, IDs, times and the links.
import { BREAK_GLASS_SCOPES } from '@sdlc/contracts';
import { t } from '@sdlc/messages';

import { breakGlassListSchema, breakGlassSchema, type BreakGlassView } from '../api/schemas.js';
import { parseCommand, segment, withApi } from '../api/session.js';
import { EXIT, type CliContext } from '../context.js';
import { say, show, toJson } from '../output.js';

const INTENT = /^INT-\d{4}-\d{4,9}$/;
const LINK = /^https:\/\/\S{1,504}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const USD = /^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$/;
const HOURS = /^[1-8]$/;

type Decision = 'approve' | 'refuse' | 'revoke';

const DONE = {
  approve: 'cli.break_glass.approved',
  refuse: 'cli.break_glass.refused',
  revoke: 'cli.break_glass.revoked',
} as const;

export async function runBreakGlass(args: readonly string[], ctx: CliContext): Promise<number> {
  const [command, ...rest] = args;
  if (command === 'request') return request(rest, ctx);
  if (command === 'approve' || command === 'refuse' || command === 'revoke') {
    return decide(command, rest, ctx);
  }
  if (command === 'review') return review(rest, ctx);
  if (command === 'list') return list(rest, ctx);
  return usage(ctx);
}

/** `runner_priority,budget` or `runner-priority`: the API's codes, or undefined for any unknown. */
export function scopesOf(value: unknown): string[] | undefined {
  if (typeof value !== 'string') return undefined;
  const scopes = value
    .split(',')
    .map((s) => s.trim().toLowerCase().replaceAll('-', '_'))
    .filter((s) => s !== '');
  const known = (BREAK_GLASS_SCOPES as readonly string[]).includes.bind(BREAK_GLASS_SCOPES);
  return scopes.length > 0 && scopes.every(known) ? scopes : undefined;
}

function intentOf(value: string | undefined): string | undefined {
  const intent = value?.toUpperCase();
  return intent !== undefined && INTENT.test(intent) ? intent : undefined;
}

async function request(args: readonly string[], ctx: CliContext): Promise<number> {
  const parsed = parseCommand(
    args,
    {
      scope: { type: 'string' },
      hours: { type: 'string' },
      reason: { type: 'string' },
      'budget-increase': { type: 'string' },
    },
    1,
  );
  const intent = intentOf(parsed?.positionals[0]);
  const v = parsed?.values;
  const scopes = scopesOf(v?.scope);
  const budget = v?.['budget-increase'];
  if (
    !parsed ||
    !v ||
    intent === undefined ||
    scopes === undefined ||
    typeof v.hours !== 'string' ||
    !HOURS.test(v.hours) ||
    typeof v.reason !== 'string' ||
    !LINK.test(v.reason) ||
    (budget !== undefined && (typeof budget !== 'string' || !USD.test(budget)))
  ) {
    return usage(ctx);
  }
  const json = v.json === true;
  return withApi(ctx, json, async (client) => {
    const grant = await client.post(
      `/v1/intents/${segment(intent)}/break-glass`,
      breakGlassSchema,
      {
        scopes,
        hours: Number(v.hours),
        reason_url: v.reason,
        ...(typeof budget === 'string' ? { budget_increase_usd: budget } : {}),
      },
    );
    if (json) ctx.stdout(toJson(grant));
    else say(ctx, 'cli.break_glass.requested', params(grant));
    return EXIT.ok;
  });
}

async function decide(
  command: Decision,
  args: readonly string[],
  ctx: CliContext,
): Promise<number> {
  const parsed = parseCommand(args, {}, 1);
  const intent = intentOf(parsed?.positionals[0]);
  if (!parsed || intent === undefined) return usage(ctx);
  const json = parsed.values.json === true;
  return withApi(ctx, json, async (client) => {
    const grant = await client.post(
      `/v1/intents/${segment(intent)}/break-glass/${command}`,
      breakGlassSchema,
      {},
    );
    if (json) ctx.stdout(toJson(grant));
    else say(ctx, DONE[command], params(grant));
    return EXIT.ok;
  });
}

async function review(args: readonly string[], ctx: CliContext): Promise<number> {
  const parsed = parseCommand(args, { comment: { type: 'string' } }, 1);
  const intent = intentOf(parsed?.positionals[0]);
  const comment = parsed?.values.comment;
  if (!parsed || intent === undefined || typeof comment !== 'string' || !LINK.test(comment)) {
    return usage(ctx);
  }
  const json = parsed.values.json === true;
  return withApi(ctx, json, async (client) => {
    const grant = await client.post(
      `/v1/intents/${segment(intent)}/break-glass/review`,
      breakGlassSchema,
      { comment_url: comment },
    );
    if (json) ctx.stdout(toJson(grant));
    else say(ctx, 'cli.break_glass.reviewed', params(grant));
    return EXIT.ok;
  });
}

async function list(args: readonly string[], ctx: CliContext): Promise<number> {
  const parsed = parseCommand(args, { project: { type: 'string' }, open: { type: 'boolean' } });
  const v = parsed?.values;
  if (!v) return usage(ctx);
  if (v.project !== undefined && (typeof v.project !== 'string' || !SLUG.test(v.project))) {
    return usage(ctx);
  }
  const json = v.json === true;
  return withApi(ctx, json, async (client) => {
    const view = await client.get('/v1/break-glass', breakGlassListSchema, {
      project: typeof v.project === 'string' ? v.project : undefined,
      open: v.open === true ? 'true' : undefined,
    });
    if (json) {
      ctx.stdout(toJson(view));
      return EXIT.ok;
    }
    if (view.items.length === 0) {
      say(ctx, 'cli.break_glass.none');
      return EXIT.ok;
    }
    say(ctx, 'cli.break_glass.list_header');
    for (const grant of view.items) ctx.stdout(t('cli.break_glass.line', params(grant)));
    return EXIT.ok;
  });
}

function params(grant: BreakGlassView) {
  return {
    intent: show(grant.intent),
    project: show(grant.project),
    status: grant.status,
    scopes: grant.scopes.join(','),
    hours: grant.duration_seconds / 3600,
    budget: show(grant.budget_increase_usd),
    incident: show(grant.incident),
    expires: show(grant.expires_at),
    lapses: grant.lapses_at,
    review: show(grant.review_url),
  };
}

function usage(ctx: CliContext): number {
  ctx.stderr(t('cli.break_glass.usage'));
  return EXIT.usage;
}
