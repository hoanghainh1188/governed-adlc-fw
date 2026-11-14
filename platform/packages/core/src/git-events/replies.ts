// Reply comments of the GitHub poller (D-08 B06 AC4, design/ADR-M27 section 2.4). The receipt
// stores a reply code and code parameters; the text is rendered here from the message catalog when
// the reply is posted (NFR-08). Never text from the Git host.
import { GATE_REASON_CODES } from '@sdlc/contracts';
import { t, type MessageKey } from '@sdlc/messages';

import { COMMENT_REPLY_CODES, type CommentReplyCode } from '../commands/git-event-handler.js';
import { isRefusalReason, refusalReasonMessage } from '../commands/refusal-messages.js';

/** Catalog key of each reply code (tested: every code has one). */
export const COMMENT_REPLY_KEYS: Readonly<Record<CommentReplyCode, MessageKey>> = {
  syntax_gate_missing: 'comment.reply.syntax_gate_missing',
  syntax_gate_invalid: 'comment.reply.syntax_gate_invalid',
  syntax_unexpected_text: 'comment.reply.syntax_unexpected_text',
  syntax_reason_missing: 'comment.reply.syntax_reason_missing',
  syntax_decision_missing: 'comment.reply.syntax_decision_missing',
  syntax_decision_invalid: 'comment.reply.syntax_decision_invalid',
  user_not_linked: 'comment.reply.user_not_linked',
  intent_not_linked: 'comment.reply.intent_not_linked',
  intent_ambiguous: 'comment.reply.intent_ambiguous',
  intent_not_found: 'comment.reply.intent_not_found',
  forbidden: 'comment.reply.forbidden',
  gate_not_supported: 'comment.reply.gate_not_supported',
  gate_input_missing: 'comment.reply.gate_input_missing',
  gate_not_current: 'comment.reply.gate_not_current',
  plan_refused: 'comment.reply.plan_refused',
  spec_unclear: 'comment.reply.spec_unclear',
  review_reason_required: 'comment.reply.review_reason_required',
  g7_use_pr_review: 'comment.reply.g7_use_pr_review',
  approval_refused: 'comment.reply.approval_refused',
  decision_not_allowed: 'comment.reply.decision_not_allowed',
  project_not_active: 'comment.reply.project_not_active',
  config_invalid: 'comment.reply.config_invalid',
  escalation_not_found: 'comment.reply.escalation_not_found',
  escalation_ambiguous: 'comment.reply.escalation_ambiguous',
  escalation_forbidden: 'comment.reply.escalation_forbidden',
  escalation_not_open: 'comment.reply.escalation_not_open',
  escalation_already_acknowledged: 'comment.reply.escalation_already_acknowledged',
  escalation_decision_not_allowed: 'comment.reply.escalation_decision_not_allowed',
  kill_forbidden: 'comment.reply.kill_forbidden',
  kill_no_active_run: 'comment.reply.kill_no_active_run',
  syntax_lesson_codes_missing: 'comment.reply.syntax_lesson_codes_missing',
  syntax_lesson_category_invalid: 'comment.reply.syntax_lesson_category_invalid',
  syntax_lesson_target_invalid: 'comment.reply.syntax_lesson_target_invalid',
  syntax_lesson_text_missing: 'comment.reply.syntax_lesson_text_missing',
  lesson_recorded: 'comment.reply.lesson_recorded',
  lesson_not_allowed: 'comment.reply.lesson_not_allowed',
  lesson_window_closed: 'comment.reply.lesson_window_closed',
  failed: 'comment.reply.failed',
};

function isReplyCode(code: string): code is CommentReplyCode {
  return (COMMENT_REPLY_CODES as readonly string[]).includes(code);
}

/**
 * The Markdown body of a reply. Syntax replies end with the command syntax and the list of valid
 * reason codes. A hidden marker names the event, so a person can trace a reply to its receipt.
 */
export function renderCommentReply(
  code: string,
  params: Readonly<Record<string, string>>,
  eventId: string,
  locale?: string,
): string {
  // A code from a newer version of the platform (rolled back since): answer generically.
  const key = isReplyCode(code) ? COMMENT_REPLY_KEYS[code] : COMMENT_REPLY_KEYS.failed;
  // Gate commands name their gate; escalation commands (B11) their command word, `/ack` or `/decide`.
  const command = params.command === 'ack' || params.command === 'decide' ? params.command : '';
  const label = params.gate ?? (command ? `/${command}` : '');
  const parts = [t(key, { gate: label }, locale)];
  // Known reason codes only: the text of an unknown code is never echoed into a comment.
  if (params.reason !== undefined && isRefusalReason(params.reason)) {
    parts.push(
      t('comment.reply.reason', { reason: refusalReasonMessage(params.reason, locale) }, locale),
    );
  }
  // X08b: a `/lesson` syntax reply names its own syntax and codes; no gate usage.
  if (code.startsWith('syntax_') && !code.startsWith('syntax_lesson_')) {
    const usage = command ? 'comment.reply.usage_escalation' : 'comment.reply.usage';
    parts.push(t(usage, { codes: GATE_REASON_CODES.join(', ') }, locale));
  }
  parts.push(t('comment.reply.footer', {}, locale));
  return `${parts.join('\n\n')}\n\n<!-- sdlc-reply ${eventId} -->`;
}
