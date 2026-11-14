// Comment commands on the Git host (D-02 FR-21, D-08 B06 AC2, design/ADR-M27 section 2.3).
//
//   /approve G<n> [<allow_reason_code>]                     (H05: G5 over the review limits)
//   /reject G<n> [<reason_code>] <reason>
//   /request-changes G<n> [<reason_code>] <reason>
//   /ack [ESC-YYYY-NNNN]                                                  (B11, ADR-M28 §2.7)
//   /decide [ESC-YYYY-NNNN] <resume|modify|roll-back|terminate|escalate> [<reason_code>] [<reason>]
//   /kill [<reason>]                                                      (C11, ADR-M42 §2.6)
//   /lesson <category> <target>                               (X08b, ADR-M109 §2.3, ADR-M27 1.x)
//   <the lesson in words, on the following lines>
//
// The reason text may be left out when a reason code other than `other` is given. For `/ack` and
// `/decide`, the escalation code may be left out when the intent has exactly one unresolved
// escalation; a `/decide` reason is optional (the comment is linked as `ref` either way). `/kill`
// stops the current run of the intent of the issue or pull request; any text after it is the
// reason and stays on the Git host (a kill must never fail on its wording).
//
// Only the first non-empty line of a comment is read; text quoted or written further down is
// never taken as a command. The reason text stays in the comment on the Git host: the parser
// returns codes only, and the decision stores the comment URL as `reason_ref` (ADR-M20).
// Other slash words (`/label`) are not ours and are ignored. `/lesson` needs both codes on its
// line and words below it; the platform never reads or stores those words (ADR-M109 §2.3).
import {
  GATE_CODES,
  GATE_REASON_CODES,
  REVIEW_ALLOW_REASON_CODES,
  type EscalationDecision,
  type GateCode,
  type GateReasonCode,
  LESSON_CATEGORIES,
  LESSON_TARGETS,
  type LessonCategory,
  type LessonTarget,
} from '@sdlc/contracts';

import { ESCALATION_CODE_PATTERN } from '../escalation/code.js';

import type { CommandDecision } from './gate-command.js';

/** The command words and the decision each one sends. */
export const COMMENT_VERBS = {
  approve: 'approve',
  reject: 'reject',
  'request-changes': 'request_changes',
} as const satisfies Readonly<Record<string, CommandDecision>>;
export type GateCommentVerb = keyof typeof COMMENT_VERBS;
/** Escalation command words (B11). */
export const ESCALATION_VERBS = ['ack', 'decide'] as const;
export type EscalationCommentVerb = (typeof ESCALATION_VERBS)[number];
/** The kill switch (C11). */
export const KILL_VERB = 'kill';
/** A lesson recorded at G8 (X08b). */
export const LESSON_VERB = 'lesson';
export type CommentVerb =
  GateCommentVerb | EscalationCommentVerb | typeof KILL_VERB | typeof LESSON_VERB;

/** Decision words of `/decide` and the decision each one records (template T16 §4). */
export const DECISION_WORDS: Readonly<Record<string, EscalationDecision>> = {
  resume: 'resume',
  modify: 'modify',
  'roll-back': 'roll_back',
  roll_back: 'roll_back',
  rollback: 'roll_back',
  terminate: 'terminate',
  escalate: 'escalate_further',
  'escalate-further': 'escalate_further',
  escalate_further: 'escalate_further',
};

/** Why a command could not be read. Each has a reply `comment.reply.syntax_<problem>`. */
export const COMMENT_SYNTAX_PROBLEMS = [
  'gate_missing',
  'gate_invalid',
  'unexpected_text',
  'reason_missing',
  'decision_missing',
  'decision_invalid',
  // X08b: `/lesson`.
  'lesson_codes_missing',
  'lesson_category_invalid',
  'lesson_target_invalid',
  'lesson_text_missing',
] as const;
export type CommentSyntaxProblem = (typeof COMMENT_SYNTAX_PROBLEMS)[number];

export type ParsedComment =
  /** Not a command of the platform: no reply, no receipt. */
  | { readonly kind: 'none' }
  | {
      readonly kind: 'invalid';
      readonly verb: CommentVerb;
      readonly problem: CommentSyntaxProblem;
    }
  | {
      readonly kind: 'gate_decision';
      readonly verb: CommentVerb;
      readonly gate: GateCode;
      readonly decision: CommandDecision;
      /** Null for `/approve`; `other` when a reject or request-changes names no code. */
      readonly reasonCode: GateReasonCode | null;
    }
  | {
      readonly kind: 'escalation_ack';
      readonly verb: 'ack';
      /** `ESC-YYYY-NNNN`, or null: the intent's only unresolved escalation. */
      readonly code: string | null;
    }
  | { readonly kind: 'kill'; readonly verb: typeof KILL_VERB }
  | {
      readonly kind: 'lesson';
      readonly verb: typeof LESSON_VERB;
      readonly category: LessonCategory;
      readonly target: LessonTarget;
    }
  | {
      readonly kind: 'escalation_decision';
      readonly verb: 'decide';
      readonly code: string | null;
      readonly decision: EscalationDecision;
      readonly reasonCode: GateReasonCode | null;
    };

const COMMAND_LINE = /^\/([A-Za-z][A-Za-z-]*)(?:[ \t]+(.*))?$/;
const GATE = /^[Gg]([0-9]+)$/;

function isVerb(word: string): word is GateCommentVerb {
  return Object.hasOwn(COMMENT_VERBS, word);
}

function isEscalationVerb(word: string): word is EscalationCommentVerb {
  return (ESCALATION_VERBS as readonly string[]).includes(word);
}

/** A reason code as the first word of the reason: `spec_unclear` or `spec-unclear`, any case. */
function reasonCodeOf(word: string | undefined): GateReasonCode | undefined {
  if (word === undefined) return undefined;
  const code = word.toLowerCase().replaceAll('-', '_');
  return (GATE_REASON_CODES as readonly string[]).includes(code)
    ? (code as GateReasonCode)
    : undefined;
}

export function parseCommentCommand(body: string): ParsedComment {
  const lines = body.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n');
  const first = lines.findIndex((line) => line.trim() !== '');
  if (first === -1) return { kind: 'none' };
  const match = COMMAND_LINE.exec(lines[first]!.trim());
  if (!match) return { kind: 'none' };
  const verb = match[1]!.toLowerCase();
  const words = (match[2] ?? '').split(/[ \t]+/).filter((word) => word !== '');
  if (isEscalationVerb(verb)) return parseEscalationCommand(verb, words);
  if (verb === KILL_VERB) return { kind: 'kill', verb: KILL_VERB };
  if (verb === LESSON_VERB) return parseLessonCommand(words, lines.slice(first + 1));
  if (!isVerb(verb)) return { kind: 'none' };

  const [gateWord, ...rest] = words;
  if (gateWord === undefined) return { kind: 'invalid', verb, problem: 'gate_missing' };
  const gateMatch = GATE.exec(gateWord);
  const gate = gateMatch ? `G${String(Number(gateMatch[1]))}` : undefined;
  if (gate === undefined || !(GATE_CODES as readonly string[]).includes(gate)) {
    return { kind: 'invalid', verb, problem: 'gate_invalid' };
  }
  const decision = COMMENT_VERBS[verb];

  if (decision === 'approve') {
    // Only the gate: "/approve G3 if the tests pass" must not pass as a plain approval. H05
    // (ADR-M95 §2.4): one allowing reason code may follow, for a change over the review limits.
    const allow = rest.length === 1 ? allowReasonCodeOf(rest[0]) : undefined;
    if (rest.length > 0 && allow === undefined) {
      return { kind: 'invalid', verb, problem: 'unexpected_text' };
    }
    return {
      kind: 'gate_decision',
      verb,
      gate: gate as GateCode,
      decision,
      reasonCode: allow ?? null,
    };
  }

  const code = reasonCodeOf(rest[0]);
  const reasonWords = code === undefined ? rest : rest.slice(1);
  const moreLines = lines.slice(first + 1).some((line) => line.trim() !== '');
  // A named reason code is a reason by itself (`/reject G3 spec_unclear`); `other` is not.
  const namedCode = code !== undefined && code !== 'other';
  if (reasonWords.length === 0 && !moreLines && !namedCode) {
    return { kind: 'invalid', verb, problem: 'reason_missing' };
  }
  return {
    kind: 'gate_decision',
    verb,
    gate: gate as GateCode,
    decision,
    reasonCode: code ?? 'other',
  };
}

/** A code word: `agent_assumption`, `agent-assumption` or any case. */
function codeWord(word: string | undefined): string | undefined {
  return word?.toLowerCase().replaceAll('-', '_');
}

/** `/lesson <category> <target>` and words on the lines below (X08b, ADR-M109 §2.3). */
function parseLessonCommand(words: readonly string[], below: readonly string[]): ParsedComment {
  const invalid = (problem: CommentSyntaxProblem): ParsedComment => ({
    kind: 'invalid',
    verb: LESSON_VERB,
    problem,
  });
  if (words.length < 2) return invalid('lesson_codes_missing');
  const category = codeWord(words[0]);
  const target = codeWord(words[1]);
  if (!(LESSON_CATEGORIES as readonly string[]).includes(category ?? '')) {
    return invalid('lesson_category_invalid');
  }
  if (!(LESSON_TARGETS as readonly string[]).includes(target ?? '')) {
    return invalid('lesson_target_invalid');
  }
  // Only the two codes on the command line: the words go below it.
  if (words.length > 2) return invalid('unexpected_text');
  if (!below.some((line) => line.trim() !== '')) return invalid('lesson_text_missing');
  return {
    kind: 'lesson',
    verb: LESSON_VERB,
    category: category as LessonCategory,
    target: target as LessonTarget,
  };
}

/**
 * The reason text of a `/request-changes G<gate>` comment (task E01 PR 2, ADR-M41 §2.7): the rest
 * of the command line after the gate and the optional reason code, then the lines below it. Null
 * when the comment is not that command (for example, edited since). The text is untrusted client
 * data: the runner hands it to the agent in memory only.
 */
export function requestChangesReason(body: string, gate: GateCode): string | null {
  const parsed = parseCommentCommand(body);
  if (
    parsed.kind !== 'gate_decision' ||
    parsed.decision !== 'request_changes' ||
    parsed.gate !== gate
  ) {
    return null;
  }
  const lines = body.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n');
  const first = lines.findIndex((line) => line.trim() !== '');
  const words = (COMMAND_LINE.exec(lines[first]!.trim())?.[2] ?? '')
    .split(/[ \t]+/)
    .filter((word) => word !== '')
    .slice(1);
  const reasonWords = reasonCodeOf(words[0]) === undefined ? words : words.slice(1);
  return [reasonWords.join(' '), ...lines.slice(first + 1)].join('\n').trim();
}

/** `/ack [ESC-…]` and `/decide [ESC-…] <decision> [reason_code] [reason]` (B11, ADR-M28 §2.7). */
function parseEscalationCommand(
  verb: EscalationCommentVerb,
  words: readonly string[],
): ParsedComment {
  const first = words[0];
  const code = first !== undefined && ESCALATION_CODE_PATTERN.test(first.toUpperCase());
  const rest = code ? words.slice(1) : words;
  const escalation = code ? first.toUpperCase() : null;
  if (verb === 'ack') {
    // Only the code: "/ack but I disagree" must not pass as a plain acknowledgement.
    if (rest.length > 0) return { kind: 'invalid', verb, problem: 'unexpected_text' };
    return { kind: 'escalation_ack', verb, code: escalation };
  }
  const [decisionWord, ...reason] = rest;
  if (decisionWord === undefined) return { kind: 'invalid', verb, problem: 'decision_missing' };
  const decision = DECISION_WORDS[decisionWord.toLowerCase()];
  if (decision === undefined) return { kind: 'invalid', verb, problem: 'decision_invalid' };
  return {
    kind: 'escalation_decision',
    verb,
    code: escalation,
    decision,
    reasonCode: reasonCodeOf(reason[0]) ?? null,
  };
}

/** A reason code that allows a change over the review limits (`generated_change` …), or undefined. */
function allowReasonCodeOf(word: string | undefined): GateReasonCode | undefined {
  const code = word?.toLowerCase().replaceAll('-', '_');
  return code !== undefined && (REVIEW_ALLOW_REASON_CODES as readonly string[]).includes(code)
    ? (code as GateReasonCode)
    : undefined;
}
