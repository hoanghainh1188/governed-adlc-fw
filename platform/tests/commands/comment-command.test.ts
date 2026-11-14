// D-08 B06 AC2 and AC4 (static part): the comment command grammar (design/ADR-M27 §2.3) and the
// reply comments from the message catalog. Live behaviour: tests/integration/db/git-poller.test.ts.
import { GATE_REASON_CODES } from '@sdlc/contracts';
import { catalogFor, placeholdersOf, t } from '@sdlc/messages';
import { describe, expect, it } from 'vitest';

import { parseCommentCommand } from '../../packages/core/src/commands/comment-command.js';
import { COMMENT_REPLY_CODES } from '../../packages/core/src/commands/git-event-handler.js';
import {
  COMMENT_REPLY_KEYS,
  renderCommentReply,
} from '../../packages/core/src/git-events/replies.js';

const en = catalogFor('en')!;

describe('comment command grammar', () => {
  it.each([
    ['/approve G3', 'approve', 'G3', null],
    ['/approve g1', 'approve', 'G1', null],
    ['  \n\n/approve G2\n\nLooks good to me.', 'approve', 'G2', null],
    ['/Approve G3', 'approve', 'G3', null],
    ['/reject G3 The plan misses the migration', 'reject', 'G3', 'other'],
    ['/reject G3 spec_unclear AC2 is vague', 'reject', 'G3', 'spec_unclear'],
    ['/reject G2 Spec-Unclear AC2 is vague', 'reject', 'G2', 'spec_unclear'],
    [
      '/request-changes G3 tests_insufficient\nAdd a test for AC3.',
      'request_changes',
      'G3',
      'tests_insufficient',
    ],
    ['/request-changes G1\nThe scope is too wide.', 'request_changes', 'G1', 'other'],
    ['/reject G3\tout_of_scope\tsee below', 'reject', 'G3', 'out_of_scope'],
    ['/approve G7', 'approve', 'G7', null],
    // E03 (ADR-M49): Person B decides the release.
    ['/approve G8', 'approve', 'G8', null],
    ['/reject G8 security_finding the rollback is untested', 'reject', 'G8', 'security_finding'],
    ['/request-changes G8\nThe release notes are missing.', 'request_changes', 'G8', 'other'],
    // A named reason code is a reason by itself.
    ['/reject G3 spec_unclear', 'reject', 'G3', 'spec_unclear'],
    ['/request-changes G2 tests-insufficient', 'request_changes', 'G2', 'tests_insufficient'],
    // H05 (ADR-M95 §2.4): one allowing reason code after the gate, for a change over the limits.
    ['/approve G5 generated_change', 'approve', 'G5', 'generated_change'],
    ['/approve G5 Mechanical-Change', 'approve', 'G5', 'mechanical_change'],
    ['/approve G5 cannot_split\nOne migration with its code.', 'approve', 'G5', 'cannot_split'],
  ])('%j → %s %s (%s)', (body, decision, gate, reasonCode) => {
    expect(parseCommentCommand(body)).toMatchObject({
      kind: 'gate_decision',
      decision,
      gate,
      reasonCode,
    });
  });

  it.each([
    ['/approve', 'gate_missing'],
    ['/reject', 'gate_missing'],
    ['/approve G9', 'gate_invalid'],
    ['/approve G0', 'gate_invalid'],
    ['/approve INT-2026-0001', 'gate_invalid'],
    ['/approve G3 if the tests pass', 'unexpected_text'],
    ['/approve G3 G4', 'unexpected_text'],
    // H05: only an allowing reason code, and nothing after it.
    ['/approve G5 other', 'unexpected_text'],
    ['/approve G5 spec_unclear', 'unexpected_text'],
    ['/approve G5 generated_change it is all generated', 'unexpected_text'],
    ['/reject G3', 'reason_missing'],
    ['/reject G3 other', 'reason_missing'],
    ['/request-changes G3   \n   \n', 'reason_missing'],
  ])('%j is refused with %s', (body, problem) => {
    expect(parseCommentCommand(body)).toMatchObject({ kind: 'invalid', problem });
  });

  it.each([
    [''],
    ['   \n  '],
    ['LGTM'],
    ['Please /approve G3 when ready'],
    ['> /approve G3\nquoted from someone else'],
    ['Thanks!\n/approve G3'],
    ['```\n/approve G3\n```'],
    ['/label bug'],
    ['/acknowledge ESC-2026-0001'],
    ['/approveG3'],
    ['/ approve G3'],
  ])('%j is not a command of the platform', (body) => {
    expect(parseCommentCommand(body)).toEqual({ kind: 'none' });
  });

  // C11 (ADR-M42 §2.6): `/kill` stops the intent's current run; any text after it is the reason.
  it.each([
    ['/kill'],
    ['/KILL'],
    ['  \n/kill\n'],
    ['/kill the agent loops on npm install'],
    ['/kill INT-2026-0001'],
  ])('%j is the kill switch', (body) => {
    expect(parseCommentCommand(body)).toEqual({ kind: 'kill', verb: 'kill' });
  });

  it.each([['Please /kill it'], ['> /kill\nquoted'], ['/killall'], ['/kill-run']])(
    '%j is not the kill switch',
    (body) => {
      expect(parseCommentCommand(body)).toEqual({ kind: 'none' });
    },
  );

  // X08b (ADR-M109 §2.3): `/lesson <category> <target>` with the words on the lines below.
  it.each([
    ['/lesson rework agents_md\nThe agent assumed the old API.', 'rework', 'agents_md'],
    ['  \n/LESSON Agent-Assumption memory\n\nwords', 'agent_assumption', 'memory'],
    ['/lesson gate none\n  - a list item', 'gate', 'none'],
  ])('%j is a lesson', (body, category, target) => {
    expect(parseCommentCommand(body)).toEqual({ kind: 'lesson', verb: 'lesson', category, target });
  });

  it.each([
    ['/lesson', 'lesson_codes_missing'],
    ['/lesson rework\nwords', 'lesson_codes_missing'],
    ['/lesson weird agents_md\nwords', 'lesson_category_invalid'],
    ['/lesson rework somewhere\nwords', 'lesson_target_invalid'],
    ['/lesson rework agents_md the words on the first line\nmore', 'unexpected_text'],
    ['/lesson rework agents_md', 'lesson_text_missing'],
    ['/lesson rework agents_md\n   \n', 'lesson_text_missing'],
  ])('%j is refused (%s)', (body, problem) => {
    expect(parseCommentCommand(body)).toEqual({ kind: 'invalid', verb: 'lesson', problem });
  });

  it.each([
    ['> /lesson rework agents_md\nquoted'],
    ['see /lesson rework none\nx'],
    ['/lessons x y\nz'],
  ])('%j is not a lesson', (body) => {
    expect(parseCommentCommand(body)).toEqual({ kind: 'none' });
  });

  it('a lesson keeps only its codes, never its words', () => {
    const parsed = parseCommentCommand('/lesson process handbook\nalice@example.com secret words');
    expect(JSON.stringify(parsed)).not.toMatch(/secret|alice|example/);
  });

  it('never returns text from the comment, only codes', () => {
    const parsed = parseCommentCommand('/reject G3 other secret-looking text alice@example.com');
    expect(JSON.stringify(parsed)).not.toMatch(/secret|alice|example/);
  });
});

describe('reply comments (AC4)', () => {
  it('has a catalog message for every reply code', () => {
    expect(Object.keys(COMMENT_REPLY_KEYS).sort()).toEqual([...COMMENT_REPLY_CODES].sort());
    for (const code of COMMENT_REPLY_CODES) {
      const template = en[COMMENT_REPLY_KEYS[code]];
      expect(template, code).toBeDefined();
      for (const name of placeholdersOf(template!)) expect(['gate'], code).toContain(name);
    }
  });

  it('syntax replies show the syntax and list every valid reason code', () => {
    for (const code of COMMENT_REPLY_CODES.filter((c) => c.startsWith('syntax_lesson_'))) {
      // X08b: a `/lesson` reply shows its own syntax, never the gate usage.
      const body = renderCommentReply(code, { command: 'lesson' }, 'github:comment:9');
      expect(body).not.toContain('/request-changes');
      expect(body).not.toMatch(/\{[a-z_]+\}/);
    }
    for (const code of COMMENT_REPLY_CODES.filter(
      (c) => c.startsWith('syntax_') && !c.startsWith('syntax_lesson_'),
    )) {
      const body = renderCommentReply(code, {}, 'github:comment:9');
      expect(body).toContain('`/request-changes G<n> [reason code] <reason>`');
      for (const reason of GATE_REASON_CODES) expect(body, code).toContain(reason);
      expect(body).not.toMatch(/\{[a-z_]+\}/);
    }
  });

  it('refusal replies name the gate and the reason in the same words as the API', () => {
    const body = renderCommentReply(
      'approval_refused',
      { gate: 'G3', reason: 'role_missing' },
      'github:comment:9',
    );
    expect(body).toContain(t('comment.reply.approval_refused', { gate: 'G3' }));
    expect(body).toContain(t('gate.reason.role_missing'));
    expect(body).not.toContain('Valid reason codes');
    expect(body).toMatch(/<!-- sdlc-reply github:comment:9 -->$/);
  });

  it('says that successful commands get no reply until the gate status comment', () => {
    expect(renderCommentReply('intent_not_linked', { gate: 'G1' }, 'github:comment:9')).toContain(
      t('comment.reply.footer'),
    );
    expect(t('comment.reply.footer')).toMatch(/Successful commands get no reply/);
  });

  it('never echoes an unknown reason code into a reply', () => {
    const body = renderCommentReply(
      'approval_refused',
      { gate: 'G3', reason: 'something_new' },
      'github:comment:9',
    );
    expect(body).not.toContain('something_new');
    expect(body).not.toContain(t('comment.reply.reason', { reason: '' }).trim());
  });

  it('answers an unknown reply code generically', () => {
    expect(renderCommentReply('from_the_future', { gate: 'G1' }, 'github:comment:9')).toContain(
      t('comment.reply.failed', { gate: 'G1' }),
    );
  });
});
