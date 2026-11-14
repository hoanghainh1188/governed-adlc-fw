// X08b PR 1 on a live PostgreSQL (design/ADR-M109 §2.2–§2.4, §5 "X08b"; QUESTIONS #707, #708,
// #726): `/lesson <category> <target>` on an intent's issue, read by the real poller from the
// GitHub stub. Person A, Person B or a tenant admin records a lesson from G8 until
// `learning.lesson_window_days` after the intent closed; governance, a bot and an unknown account
// do not. The platform stores codes, the comment's link and its numeric ID: never the words.
// Refusals reply and, for the role and the window, write `lesson.refused`. Both tables are
// append-only.
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

import { loadProjectConfig } from '../../../packages/config/src/index.js';
import type { Intent } from '../../../packages/core/src/db/schema.js';
import { createWorkflowFixture, type WorkflowFixture } from '../workflow/fixture.js';
import { createTestDatabase, describeDb, tamper, type TestDatabase } from './helpers.js';

const DAY = 86_400_000;
const WORDS = 'The agent assumed the old export format. alice@example.com canary-lesson-41';

describeDb('X08b: lessons recorded with /lesson on PostgreSQL', () => {
  let db: TestDatabase;
  let f: WorkflowFixture;

  beforeAll(async () => {
    db = await createTestDatabase();
    f = await createWorkflowFixture(db, () => new Date());
  }, 60_000);

  afterAll(async () => {
    await f?.close();
    await db?.drop();
  });

  beforeEach(() => {
    f.h.stub.now = new Date();
  });

  /** An intent at G8, or finished `daysAgo` days ago. */
  async function intentAt(
    state: 'G8' | 'G3' | { readonly closedDaysAgo: number },
  ): Promise<Intent> {
    const intent = await f.newIntent();
    if (state === 'G8' || state === 'G3') {
      await tamper(
        db.name,
        `UPDATE intents SET status = 'in_gate', current_gate = $1, gate_entered_at = now()
         WHERE id = $2`,
        [state, intent.id],
      );
    } else {
      const closed = new Date(Date.now() - state.closedDaysAgo * DAY);
      await tamper(
        db.name,
        `UPDATE intents SET status = 'done', current_gate = 'G8', gate_entered_at = NULL,
           updated_at = $1, closed_at = $1 WHERE id = $2`,
        [closed, intent.id],
      );
    }
    return (await f.scope.intents.getById(intent.id))!;
  }

  async function say(
    intent: Intent,
    body: string,
    who: 'a' | 'b' | 'gov' | { gh: number; login: string },
  ) {
    f.h.stub.now = new Date();
    f.comment(intent, body, who);
    await f.poll();
  }
  const lessons = (intent: Intent) => f.scope.lessons.listForIntent(intent.id);
  const lastReply = (intent: Intent) => f.posted(intent).at(-1) ?? '';
  const audit = async (intent: Intent) =>
    (await f.scope.audit.listForEntity(intent.id, ['lesson.recorded', 'lesson.refused'])).map(
      (e) => [e.action, e.payload],
    );

  it('Person A records a lesson at G8: codes, the comment link and ID; never the words', async () => {
    const intent = await intentAt('G8');
    await say(intent, `/lesson agent-assumption agents_md\n${WORDS}`, 'a');
    const [lesson] = await lessons(intent);
    expect(lesson).toMatchObject({
      category: 'agent_assumption',
      target: 'agents_md',
      recorded_by: f.users.a,
      source: 'github_comment',
      outcome: null,
    });
    expect(lesson?.comment_url).toMatch(/^https:\/\//);
    expect(lesson?.comment_id).toMatch(/^[0-9]+$/);
    expect(lastReply(intent)).toContain('Lesson recorded');
    expect(await audit(intent)).toEqual([
      [
        'lesson.recorded',
        {
          lesson_id: lesson!.id,
          category: 'agent_assumption',
          target: 'agents_md',
          comment_id: lesson!.comment_id,
          source: 'github_comment',
        },
      ],
    ]);
    // Never stored: the words, an address, the canary.
    const stored = JSON.stringify([await lessons(intent), await audit(intent)]);
    expect(stored).not.toMatch(/canary|alice|export format/);
  });

  it('Person B too; after the close inside the window, and refused after it', async () => {
    const recent = await intentAt({ closedDaysAgo: 3 });
    await say(recent, '/lesson rework config\nwords', 'b');
    expect(await lessons(recent)).toHaveLength(1);

    const old = await intentAt({ closedDaysAgo: 20 });
    await say(old, '/lesson rework config\nwords', 'b');
    expect(await lessons(old)).toEqual([]);
    expect(lastReply(old)).toContain('learning.lesson_window_days');
    expect(await audit(old)).toEqual([['lesson.refused', { cause: 'window_closed' }]]);

    // Before G8 it is refused the same way.
    const early = await intentAt('G3');
    await say(early, '/lesson process none\nwords', 'a');
    expect(await lessons(early)).toEqual([]);
    expect(await audit(early)).toEqual([['lesson.refused', { cause: 'window_closed' }]]);
  });

  it('a wider window from the project configuration', async () => {
    const old = await intentAt({ closedDaysAgo: 20 });
    const yaml = 'learning:\n  lesson_window_days: 30\n';
    const loaded = loadProjectConfig(yaml);
    if (!loaded.ok) throw new Error('configuration refused');
    await f.scope.projectConfigs.save(f.target.projectId, {
      configYaml: yaml,
      configHash: loaded.configHash,
      updatedBy: null,
      expectedVersion: 0,
    });
    try {
      await say(old, '/lesson tooling none\nwords', 'a');
      expect(await lessons(old)).toHaveLength(1);
    } finally {
      await tamper(db.name, 'DELETE FROM project_configs WHERE project_id = $1', [
        f.target.projectId,
      ]);
    }
  });

  it('governance and an unknown account are refused; a bot is ignored', async () => {
    const intent = await intentAt('G8');
    await say(intent, '/lesson gate handbook\nwords', 'gov');
    expect(lastReply(intent)).toContain('Person A or Person B');
    expect(await audit(intent)).toEqual([['lesson.refused', { cause: 'not_allowed' }]]);
    await say(intent, '/lesson gate handbook\nwords', { gh: 999_999, login: 'stranger' });
    expect(lastReply(intent)).toContain(
      (await import('@sdlc/messages'))
        .t('comment.reply.user_not_linked', { gate: '' })
        .slice(0, 20),
    );
    expect(await lessons(intent)).toEqual([]);
  });

  it('syntax: missing codes, an unknown code, missing words; each reply names the syntax', async () => {
    const intent = await intentAt('G8');
    await say(intent, '/lesson rework', 'a');
    expect(lastReply(intent)).toContain('/lesson <category> <target>');
    await say(intent, '/lesson rework somewhere\nwords', 'a');
    expect(lastReply(intent)).toContain('unknown target');
    await say(intent, '/lesson rework agents_md', 'a');
    expect(lastReply(intent)).toContain('in words on the lines below');
    expect(lastReply(intent)).not.toContain('/request-changes');
    expect(await lessons(intent)).toEqual([]);
  });

  it('the tables are append-only', async () => {
    const intent = await intentAt('G8');
    await say(intent, '/lesson other none\nwords', 'a');
    const [lesson] = await lessons(intent);
    // Columns typed immutable cannot be set through Kysely: raw SQL, as platform_app.
    await expect(
      sql`UPDATE intent_lessons SET target = 'memory' WHERE id = ${lesson!.id}`.execute(db.appRaw),
    ).rejects.toThrow();
    await expect(
      db.appRaw.deleteFrom('intent_lessons').where('id', '=', lesson!.id).execute(),
    ).rejects.toThrow();
  });
});
