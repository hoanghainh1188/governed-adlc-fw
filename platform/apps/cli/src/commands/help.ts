// `adlc help [topic|command]` and `adlc <command> --help` (task V10 AC1). Every text comes from the
// catalog: an overview, five short guides, and for every command group its usage and one example.
// A test fails when a command group has no help (`cli/help.test.ts`).
import { t, type MessageKey } from '@sdlc/messages';

import { EXIT, type CliContext } from '../context.js';

/** The guides of `adlc help <topic>`. */
export const HELP_TOPICS = {
  'getting-started': 'cli.help.topic.getting_started',
  roles: 'cli.help.topic.roles',
  gates: 'cli.help.topic.gates',
  comments: 'cli.help.topic.comments',
  troubleshooting: 'cli.help.topic.troubleshooting',
} as const satisfies Readonly<Record<string, MessageKey>>;

/** For every command group: its usage text and one example. */
export const COMMAND_HELP = {
  login: { usage: 'cli.login.usage', example: 'cli.help.example.login' },
  logout: { usage: 'cli.logout.usage', example: 'cli.help.example.logout' },
  whoami: { usage: 'cli.whoami.usage', example: 'cli.help.example.whoami' },
  intent: { usage: 'cli.intent.usage', example: 'cli.help.example.intent' },
  next: { usage: 'cli.next.usage', example: 'cli.help.example.next' },
  doctor: { usage: 'cli.doctor.usage', example: 'cli.help.example.doctor' },
  gate: { usage: 'cli.gate.usage', example: 'cli.help.example.gate' },
  escalation: { usage: 'cli.escalation.usage', example: 'cli.help.example.escalation' },
  'ai-record': { usage: 'cli.ai_record.usage', example: 'cli.help.example.ai_record' },
  memory: { usage: 'cli.memory.usage', example: 'cli.help.example.memory' },
  spec: { usage: 'cli.spec.usage', example: 'cli.help.example.spec' },
  plan: { usage: 'cli.plan.usage', example: 'cli.help.example.plan' },
  run: { usage: 'cli.run.usage', example: 'cli.help.example.run' },
  cost: { usage: 'cli.cost.usage', example: 'cli.help.example.cost' },
  metrics: { usage: 'cli.metrics.usage', example: 'cli.help.example.metrics' },
  eval: { usage: 'cli.eval.usage', example: 'cli.help.example.eval' },
  trial: { usage: 'cli.trial.usage', example: 'cli.help.example.trial' },
  evidence: { usage: 'cli.evidence.usage', example: 'cli.help.example.evidence' },
  client: { usage: 'cli.client.usage', example: 'cli.help.example.client' },
  token: { usage: 'cli.token.usage', example: 'cli.help.example.token' },
  admin: { usage: 'cli.admin.api.usage', example: 'cli.help.example.admin' },
  audit: { usage: 'cli.audit.usage', example: 'cli.help.example.audit' },
  ops: { usage: 'cli.ops.usage', example: 'cli.help.example.ops' },
} as const satisfies Readonly<Record<string, { usage: MessageKey; example: MessageKey }>>;

export const isHelpFlag = (arg: string | undefined): boolean => arg === '--help' || arg === '-h';

/** The help of one command group, or undefined for an unknown group. */
export function commandHelp(group: string): string | undefined {
  if (!Object.hasOwn(COMMAND_HELP, group)) return undefined;
  const { usage, example } = COMMAND_HELP[group as keyof typeof COMMAND_HELP];
  return `${t(usage)}\n\n${t('cli.help.example_header')}\n  ${t(example)}`;
}

export function runHelp(args: readonly string[], ctx: CliContext): number {
  const [subject, ...rest] = args;
  if (rest.length > 0) {
    ctx.stderr(t('cli.help.unknown', { subject: args.join(' ') }));
    return EXIT.usage;
  }
  if (subject === undefined || isHelpFlag(subject)) {
    ctx.stdout(t('cli.help.overview'));
    return EXIT.ok;
  }
  if (Object.hasOwn(HELP_TOPICS, subject)) {
    ctx.stdout(t(HELP_TOPICS[subject as keyof typeof HELP_TOPICS]));
    return EXIT.ok;
  }
  const help = commandHelp(subject);
  if (help !== undefined) {
    ctx.stdout(help);
    return EXIT.ok;
  }
  ctx.stderr(t('cli.help.unknown', { subject }));
  return EXIT.usage;
}
