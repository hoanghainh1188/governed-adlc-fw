// Lessons through the API and the CLI (task X08b PR 2, design/ADR-M109 §2.3–§2.5, QUESTIONS
// #726–#730). `/lesson` on GitHub (PR 1, `git-event-handler.ts`) and `adlc lesson add` record the
// same rows with the same rules:
// - who: Person A or Person B of the project, or a tenant admin; never a bot or an agent;
// - when: from G8 until `learning.lesson_window_days` after the intent closed (`lessonWindowOpen`);
// - what: codes, the comment's link and its numeric ID; never the words. `add` checks that the
//   address names a comment of the intent's issue or pull request in the project's repository
//   (`commentIdOf`), and that the comment exists there (`getIssueComment`, QUESTIONS #729).
// Outcomes (`applied` with a link or a follow-up intent, `dropped` with a reason) are new rows:
// the state of a lesson is its latest outcome. Every step is audited with codes and IDs only.
import {
  GitHostError,
  type GitHostAdapter,
  type LessonCategory,
  type LessonDropReason,
  type LessonTarget,
  type RedactedSecret,
} from '@sdlc/contracts';

import { isTenantAdmin } from '../admin/actor.js';
import { projectAccess } from '../commands/access.js';
import { DbError } from '../db/errors.js';
import type { LessonRow } from '../db/repositories/lessons.js';
import type { Intent, IntentLesson, Project } from '../db/schema.js';
import type { TenantScope } from '../db/tenant-scope.js';
import { loadEffectiveConfig } from '../registry/effective-config.js';
import { INTENT_CODE_PATTERN } from '../registry/intent-code.js';
import { projectRepoRef } from '../workflow/g4-proposal.js';
import { LessonError } from './errors.js';

/** Roles that record lessons and their outcomes, besides a tenant admin (ADR-M109 §2.3). */
export const LESSON_ROLES: readonly string[] = ['person_a', 'person_b'];
const FINISHED: readonly string[] = ['done', 'rejected', 'cancelled', 'blocked'];
const DAY_MS = 86_400_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The intent at G8, or finished no longer than `days` ago (ADR-M109 §2.3). */
export function lessonWindowOpen(
  intent: Pick<Intent, 'status' | 'current_gate' | 'closed_at'>,
  days: number,
  now: Date,
): boolean {
  if (!FINISHED.includes(intent.status)) return intent.current_gate === 'G8';
  return intent.closed_at !== null && now.getTime() - intent.closed_at.getTime() <= days * DAY_MS;
}

/** Person A or Person B of the project, or a tenant admin. */
export async function mayRecordLessons(
  scope: TenantScope,
  projectId: string,
  userId: string,
): Promise<boolean> {
  const roles = (await scope.roleBindings.listForUser(userId))
    .filter((binding) => binding.project_id === projectId)
    .map((binding) => binding.role);
  return roles.some((role) => LESSON_ROLES.includes(role)) || (await isTenantAdmin(scope, userId));
}

/** A project role that reads it, or a tenant admin (ADR-M109 §2.3: admins record lessons too). */
async function mayRead(scope: TenantScope, projectId: string, userId: string): Promise<boolean> {
  return (
    (await projectAccess(scope, projectId, userId)).canRead || (await isTenantAdmin(scope, userId))
  );
}

/** The intent by code or ID, and its project, when the caller may read it; else `not_found`. */
async function readableIntent(
  scope: TenantScope,
  ref: string,
  userId: string,
): Promise<{ intent: Intent; project: Project }> {
  const intent = INTENT_CODE_PATTERN.test(ref.toUpperCase())
    ? await scope.intents.getByCode(ref.toUpperCase())
    : UUID.test(ref)
      ? await scope.intents.getById(ref)
      : undefined;
  const project = intent ? await scope.projects.getById(intent.project_id) : undefined;
  if (!intent || !project || !(await mayRead(scope, project.id, userId))) {
    throw new LessonError('intent_not_found', 'intent not found');
  }
  return { intent, project };
}

export interface LessonGitHost {
  readonly gitHost: Pick<
    GitHostAdapter,
    'commentIdOf' | 'issueShortLivedToken' | 'getIssueComment' | 'revokeShortLivedToken'
  >;
}

export interface AddLessonInput {
  readonly intentRef: string;
  readonly category: LessonCategory;
  readonly target: LessonTarget;
  readonly commentUrl: string;
  readonly actorId: string;
  readonly now: Date;
}

/** `adlc lesson add` (ADR-M109 §2.3): records a lesson that points to an existing comment. */
export async function addLesson(
  scope: TenantScope,
  deps: LessonGitHost | undefined,
  input: AddLessonInput,
): Promise<{ intent: Intent; lesson: IntentLesson }> {
  const { intent, project } = await readableIntent(scope, input.intentRef, input.actorId);
  if (!(await mayRecordLessons(scope, project.id, input.actorId))) {
    throw new LessonError('forbidden', 'only Person A, Person B or a tenant admin');
  }
  const { config } = await loadEffectiveConfig(scope.projectConfigs, project.id);
  if (!lessonWindowOpen(intent, config.learning.lesson_window_days, input.now)) {
    throw new LessonError('window_closed', 'the lesson window is closed');
  }
  if (!deps) throw new LessonError('git_host_unavailable', 'no Git host in this process');
  const ref = projectRepoRef(project);
  const commentId = ref ? deps.gitHost.commentIdOf(ref, input.commentUrl) : null;
  if (!ref || commentId === null) {
    throw new LessonError('comment_invalid', 'not a comment of the project repository');
  }
  const issueNumber = await commentIssue(deps, ref, commentId);
  if (issueNumber === null || ![intent.issue_number, intent.pr_number].includes(issueNumber)) {
    throw new LessonError('comment_not_on_intent', 'the comment is not on the intent');
  }
  if (await scope.lessons.forComment(project.id, commentId)) {
    throw new LessonError('duplicate', 'this comment records a lesson already');
  }
  return scope.transaction(async (tx) => {
    const lesson = await tx.lessons
      .record({
        project_id: project.id,
        intent_id: intent.id,
        category: input.category,
        target: input.target,
        comment_url: input.commentUrl,
        comment_id: commentId,
        recorded_by: input.actorId,
        source: 'api',
      })
      .catch((error: unknown) => {
        throw error instanceof DbError && error.code === 'conflict'
          ? new LessonError('duplicate', 'this comment records a lesson already')
          : error;
      });
    await tx.audit.append({
      action: 'lesson.recorded',
      actorType: 'human',
      actorId: input.actorId,
      entityId: intent.id,
      payload: {
        lesson_id: lesson.id,
        category: lesson.category,
        target: lesson.target,
        comment_id: lesson.comment_id,
        source: 'api',
      },
    });
    return { intent, lesson };
  });
}

/** The issue or pull request number of an existing comment, with a read token used once. */
async function commentIssue(
  deps: LessonGitHost,
  ref: NonNullable<ReturnType<typeof projectRepoRef>>,
  commentId: string,
): Promise<number | null> {
  let token: RedactedSecret | undefined;
  try {
    token = (
      await deps.gitHost.issueShortLivedToken(ref, {
        permissions: { issues: 'read', pull_requests: 'read' },
      })
    ).token;
    return (await deps.gitHost.getIssueComment(token, ref, commentId)).issueNumber;
  } catch (error) {
    if (error instanceof GitHostError && error.code === 'not_found') {
      throw new LessonError('comment_not_found', 'no such comment');
    }
    if (error instanceof GitHostError) {
      throw new LessonError('git_host_error', 'git host unavailable', error.code);
    }
    throw error;
  } finally {
    if (token) await deps.gitHost.revokeShortLivedToken(token).catch(() => undefined);
  }
}

export interface DecideLessonInput {
  readonly lessonId: string;
  readonly actorId: string;
  readonly outcome:
    | { readonly kind: 'applied'; readonly linkUrl?: string; readonly followUpIntentId?: string }
    | { readonly kind: 'dropped'; readonly reason: LessonDropReason };
}

/** `adlc lesson apply|drop` (ADR-M109 §2.5): a new outcome; the latest one is the state. */
export async function decideLesson(
  scope: TenantScope,
  input: DecideLessonInput,
): Promise<LessonRow> {
  const lesson = UUID.test(input.lessonId) ? await scope.lessons.get(input.lessonId) : undefined;
  if (!lesson || !(await mayRead(scope, lesson.project_id, input.actorId))) {
    throw new LessonError('lesson_not_found', 'no such lesson');
  }
  if (!(await mayRecordLessons(scope, lesson.project_id, input.actorId))) {
    throw new LessonError('forbidden', 'only Person A, Person B or a tenant admin');
  }
  const o = input.outcome;
  if (o.kind === 'applied' && o.linkUrl === undefined && o.followUpIntentId === undefined) {
    throw new LessonError('link_missing', 'an applied lesson names its change');
  }
  return scope.transaction(async (tx) => {
    const row = await tx.lessons.recordOutcome({
      lesson_id: lesson.id,
      outcome: o.kind,
      link_url: o.kind === 'applied' ? (o.linkUrl ?? null) : null,
      reason: o.kind === 'dropped' ? o.reason : null,
      follow_up_intent_id: o.kind === 'applied' ? (o.followUpIntentId ?? null) : null,
      decided_by: input.actorId,
    });
    const audit = {
      actorType: 'human' as const,
      actorId: input.actorId,
      entityId: lesson.intent_id,
    };
    if (o.kind === 'applied') {
      await tx.audit.append({
        ...audit,
        action: 'lesson.applied',
        payload: {
          lesson_id: lesson.id,
          ...(o.followUpIntentId === undefined ? {} : { follow_up_intent_id: o.followUpIntentId }),
        },
      });
    } else {
      await tx.audit.append({
        ...audit,
        action: 'lesson.dropped',
        payload: { lesson_id: lesson.id, reason: o.reason },
      });
    }
    return { ...lesson, outcome: row };
  });
}

/** A lesson the caller may read, with its latest outcome; else `lesson_not_found`. */
export async function readLesson(
  scope: TenantScope,
  lessonId: string,
  actorId: string,
): Promise<{ lesson: LessonRow; intent: Intent; project: Project }> {
  const lesson = UUID.test(lessonId) ? await scope.lessons.get(lessonId) : undefined;
  const project = lesson ? await scope.projects.getById(lesson.project_id) : undefined;
  const intent = lesson ? await scope.intents.getById(lesson.intent_id) : undefined;
  if (!lesson || !project || !intent || !(await mayRead(scope, project.id, actorId))) {
    throw new LessonError('lesson_not_found', 'no such lesson');
  }
  return { lesson, intent, project };
}

export interface LessonListQuery {
  readonly projectSlug?: string;
  /** Only lessons with no outcome yet. */
  readonly open?: boolean;
  /** Recorded on or after this UTC day. */
  readonly since?: Date;
  readonly actorId: string;
}

/** `adlc lessons list` (ADR-M109 §2.5): the lessons of the projects the caller may read. */
export async function listLessons(
  scope: TenantScope,
  query: LessonListQuery,
): Promise<{ lessons: LessonRow[]; projects: Map<string, Project>; intents: Map<string, Intent> }> {
  const all = await scope.projects.list();
  const projects = new Map<string, Project>();
  for (const project of all) {
    if (query.projectSlug !== undefined && project.slug !== query.projectSlug) continue;
    if (await mayRead(scope, project.id, query.actorId)) {
      projects.set(project.id, project);
    }
  }
  if (query.projectSlug !== undefined && projects.size === 0) {
    throw new LessonError('project_not_found', 'project not found');
  }
  const lessons = (await scope.lessons.listForProjects([...projects.keys()], query.since)).filter(
    (lesson) => query.open !== true || lesson.outcome === null,
  );
  const intents = new Map<string, Intent>();
  for (const id of new Set(lessons.map((l) => l.intent_id))) {
    const intent = await scope.intents.getById(id);
    if (intent) intents.set(id, intent);
  }
  return { lessons, projects, intents };
}

export interface LessonMetrics {
  readonly recorded: number;
  readonly open: number;
  readonly applied: number;
  readonly dropped: number;
  readonly byCategory: Readonly<Record<string, number>>;
  readonly byTarget: Readonly<Record<string, number>>;
  /** Median days from recording to the latest outcome, of the lessons with one; null for none. */
  readonly medianDaysToOutcome: number | null;
}

/** `adlc metrics lessons` (ADR-M109 §2.5): counts for the monthly learning step. */
export function lessonMetrics(lessons: readonly LessonRow[]): LessonMetrics {
  const count = (pick: (l: LessonRow) => string) => {
    const out: Record<string, number> = {};
    for (const lesson of lessons) out[pick(lesson)] = (out[pick(lesson)] ?? 0) + 1;
    return out;
  };
  const days = lessons
    .filter((l) => l.outcome !== null)
    .map((l) => (l.outcome!.created_at.getTime() - l.created_at.getTime()) / DAY_MS)
    .sort((a, b) => a - b);
  const mid = Math.floor(days.length / 2);
  const median =
    days.length === 0 ? null : days.length % 2 ? days[mid]! : (days[mid - 1]! + days[mid]!) / 2;
  return {
    recorded: lessons.length,
    open: lessons.filter((l) => l.outcome === null).length,
    applied: lessons.filter((l) => l.outcome?.outcome === 'applied').length,
    dropped: lessons.filter((l) => l.outcome?.outcome === 'dropped').length,
    byCategory: count((l) => l.category),
    byTarget: count((l) => l.target),
    medianDaysToOutcome: median === null ? null : Math.round(median * 10) / 10,
  };
}
