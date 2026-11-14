// `adlc lesson add|apply|drop|issue|list` and `adlc lessons list` over the API (task X08b PR 2,
// ADR-M109 §2.3–§2.5, QUESTIONS #727, #729). A lesson is a GitHub comment on the intent's issue
// or pull request: the platform keeps its codes and its link, never its words. Person A or
// Person B of the project, or a tenant admin, records it and its outcome.
import { LESSON_CATEGORIES, LESSON_DROP_REASONS, LESSON_TARGETS } from '@sdlc/contracts';
import { t } from '@sdlc/messages';

import { lessonListSchema, lessonSchema, type LessonView } from '../api/schemas.js';
import { parseCommand, segment, withApi } from '../api/session.js';
import { EXIT, type CliContext } from '../context.js';
import { say, show, toJson } from '../output.js';

const INTENT = /^INT-\d{4}-\d{4,9}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LINK = /^https:\/\/\S{1,504}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
/** QUESTIONS #727: the handbook's repository, unless `--repo` names another. */
export const HANDBOOK_REPO = 'hoanghainh1188/governed-adlc-fw';
const DAY_MS = 86_400_000;

const isOne = (list: readonly string[], value: unknown): value is string =>
  typeof value === 'string' && list.includes(value);

export async function runLesson(args: readonly string[], ctx: CliContext): Promise<number> {
  const [command, ...rest] = args;
  if (command === 'add') return add(rest, ctx);
  if (command === 'apply') return apply(rest, ctx);
  if (command === 'drop') return drop(rest, ctx);
  if (command === 'issue') return issue(rest, ctx);
  if (command === 'list') return list(rest, ctx);
  return usage(ctx);
}

/** `adlc lessons list` is `adlc lesson list`. */
export async function runLessons(args: readonly string[], ctx: CliContext): Promise<number> {
  const [command, ...rest] = args;
  return command === 'list' ? list(rest, ctx) : usage(ctx);
}

async function add(args: readonly string[], ctx: CliContext): Promise<number> {
  const parsed = parseCommand(
    args,
    { category: { type: 'string' }, target: { type: 'string' }, comment: { type: 'string' } },
    1,
  );
  const intent = parsed?.positionals[0]?.toUpperCase();
  const v = parsed?.values;
  if (
    !parsed ||
    !v ||
    intent === undefined ||
    !INTENT.test(intent) ||
    !isOne(LESSON_CATEGORIES, codeOf(v.category)) ||
    !isOne(LESSON_TARGETS, codeOf(v.target)) ||
    typeof v.comment !== 'string' ||
    !LINK.test(v.comment)
  ) {
    return usage(ctx);
  }
  const json = v.json === true;
  return withApi(ctx, json, async (client) => {
    const lesson = await client.post(`/v1/intents/${segment(intent)}/lessons`, lessonSchema, {
      category: codeOf(v.category),
      target: codeOf(v.target),
      comment_url: v.comment,
    });
    if (json) ctx.stdout(toJson(lesson));
    else say(ctx, 'cli.lesson.added', params(lesson, new Date()));
    return EXIT.ok;
  });
}

async function apply(args: readonly string[], ctx: CliContext): Promise<number> {
  const parsed = parseCommand(args, { link: { type: 'string' } }, 1);
  const id = parsed?.positionals[0];
  const link = parsed?.values.link;
  if (!parsed || id === undefined || !UUID.test(id) || typeof link !== 'string') {
    return usage(ctx);
  }
  if (!LINK.test(link)) return usage(ctx);
  return decide(ctx, parsed.values.json === true, `/v1/lessons/${id}/apply`, { link_url: link });
}

async function drop(args: readonly string[], ctx: CliContext): Promise<number> {
  const parsed = parseCommand(args, { reason: { type: 'string' } }, 1);
  const id = parsed?.positionals[0];
  const reason = codeOf(parsed?.values.reason);
  if (!parsed || id === undefined || !UUID.test(id) || !isOne(LESSON_DROP_REASONS, reason)) {
    return usage(ctx);
  }
  return decide(ctx, parsed.values.json === true, `/v1/lessons/${id}/drop`, { reason });
}

function decide(ctx: CliContext, json: boolean, path: string, body: object): Promise<number> {
  return withApi(ctx, json, async (client) => {
    const lesson = await client.post(path, lessonSchema, body);
    if (json) ctx.stdout(toJson(lesson));
    else say(ctx, 'cli.lesson.decided', params(lesson, new Date()));
    return EXIT.ok;
  });
}

/**
 * QUESTIONS #727: prints a filled-in "new issue" link for the handbook's authors. It holds the
 * codes, the intent code and the comment's link only; the person opens it and adds the words.
 */
async function issue(args: readonly string[], ctx: CliContext): Promise<number> {
  const parsed = parseCommand(args, { repo: { type: 'string' } }, 1);
  const id = parsed?.positionals[0];
  const repo = parsed?.values.repo ?? HANDBOOK_REPO;
  if (!parsed || id === undefined || !UUID.test(id) || typeof repo !== 'string') {
    return usage(ctx);
  }
  if (!REPO.test(repo)) return usage(ctx);
  const json = parsed.values.json === true;
  return withApi(ctx, json, async (client) => {
    const lesson = await client.get(`/v1/lessons/${id}`, lessonSchema);
    const url = handbookIssueUrl(repo, lesson);
    if (json) ctx.stdout(toJson({ lesson: lesson.id, url }));
    else say(ctx, 'cli.lesson.issue', { url });
    return EXIT.ok;
  });
}

/** The GitHub "new issue" address: title, label `handbook`, and a body of codes and one link. */
export function handbookIssueUrl(repo: string, lesson: LessonView): string {
  const values = {
    intent: show(lesson.intent),
    category: lesson.category,
    target: lesson.target,
    lesson: lesson.id,
    comment: lesson.comment_url,
  };
  const query = new URLSearchParams({
    title: t('cli.lesson.issue_title', values),
    labels: 'handbook',
    body: t('cli.lesson.issue_body', values),
  });
  return `https://github.com/${repo}/issues/new?${query.toString()}`;
}

async function list(args: readonly string[], ctx: CliContext): Promise<number> {
  const parsed = parseCommand(args, {
    project: { type: 'string' },
    open: { type: 'boolean' },
    since: { type: 'string' },
  });
  const v = parsed?.values;
  if (!v) return usage(ctx);
  if (v.project !== undefined && (typeof v.project !== 'string' || !SLUG.test(v.project))) {
    return usage(ctx);
  }
  if (v.since !== undefined && (typeof v.since !== 'string' || !DAY.test(v.since))) {
    return usage(ctx);
  }
  const json = v.json === true;
  return withApi(ctx, json, async (client) => {
    const view = await client.get('/v1/lessons', lessonListSchema, {
      project: typeof v.project === 'string' ? v.project : undefined,
      open: v.open === true ? 'true' : undefined,
      since: typeof v.since === 'string' ? v.since : undefined,
    });
    if (json) {
      ctx.stdout(toJson(view));
      return EXIT.ok;
    }
    if (view.items.length === 0) {
      say(ctx, 'cli.lesson.none');
      return EXIT.ok;
    }
    say(ctx, 'cli.lesson.list_header');
    const now = new Date();
    for (const lesson of view.items) ctx.stdout(t('cli.lesson.line', params(lesson, now)));
    return EXIT.ok;
  });
}

/** A code as people write it (`agent-assumption`, any case) in the API's words. */
function codeOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value.toLowerCase().replaceAll('-', '_') : undefined;
}

function params(lesson: LessonView, now: Date) {
  const age = Math.max(0, Math.floor((now.getTime() - Date.parse(lesson.created_at)) / DAY_MS));
  const o = lesson.outcome;
  return {
    id: lesson.id,
    intent: show(lesson.intent),
    project: show(lesson.project),
    category: lesson.category,
    target: lesson.target,
    state: lesson.state,
    days: Number.isNaN(age) ? '-' : age,
    comment: lesson.comment_url,
    outcome: o === null ? '-' : (o.link_url ?? o.reason ?? show(o.follow_up_intent_id)),
  };
}

function usage(ctx: CliContext): number {
  ctx.stderr(t('cli.lesson.usage'));
  return EXIT.usage;
}
