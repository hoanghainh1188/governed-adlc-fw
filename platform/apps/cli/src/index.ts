// The adlc command-line tool. See design/D-03 section 5.1.
// A07 adds `adlc audit verify`, B03 the operator commands `adlc admin …` (database, on the
// server). B04 adds the user commands (through the API, design/ADR-M36): login, logout, whoami,
// intent, gate, escalation, ai-record. B08 adds `adlc spec`, B09 `adlc plan`, C11 `adlc run`, E04 `adlc cost`, E06 `adlc metrics`, E02 `adlc evidence`, V01 `adlc trial`, V05 `adlc --version`, V06 `adlc next`, V07 `adlc doctor`. B13 adds the admin commands, `adlc token` and
// `adlc audit verify` through the API, and moves the operator commands to `adlc ops` (ADR-M37).
import { t } from '@sdlc/messages';

import { renderBanner } from './banner.js';
import { runAdminApi } from './commands/admin-api.js';
import { runAiRecord } from './commands/ai-record.js';
import { runClient } from './commands/client.js';
import { runEval } from './commands/eval.js';
import { runAuditVerify } from './commands/audit-verify-api.js';
import { runCost } from './commands/cost.js';
import { runDoctor } from './commands/doctor.js';
import { runEscalation } from './commands/escalation.js';
import { runEvidence } from './commands/evidence.js';
import { runGate } from './commands/gate.js';
import { commandHelp, isHelpFlag, runHelp } from './commands/help.js';
import { runIntent } from './commands/intent.js';
import { runMetrics } from './commands/metrics.js';
import { runNext } from './commands/next.js';
import { runLogin, runLogout, runWhoami } from './commands/login.js';
import { runOps } from './commands/ops.js';
import { runPlan } from './commands/plan.js';
import { runRun } from './commands/run.js';
import { runSpec } from './commands/spec.js';
import { runToken } from './commands/token.js';
import { runTrial } from './commands/trial.js';
import { EXIT, type CliContext } from './context.js';
import { clean } from './output.js';
import { PLATFORM_VERSION } from './version.js';

export { EXIT, processApiIo, processContext, type ApiIo, type CliContext } from './context.js';
export { renderBanner } from './banner.js';
export { InputAbortedError, readHiddenLine } from './credentials/prompt.js';

/** User commands: through the API, with the login of `adlc login` (task B04, ADR-M36). */
const USER_COMMANDS: Readonly<
  Record<string, (args: readonly string[], ctx: CliContext) => Promise<number>>
> = {
  login: runLogin,
  logout: runLogout,
  whoami: runWhoami,
  intent: runIntent,
  next: runNext,
  doctor: runDoctor,
  gate: runGate,
  escalation: runEscalation,
  'ai-record': runAiRecord,
  eval: runEval,
  spec: runSpec,
  plan: runPlan,
  run: runRun,
  cost: runCost,
  metrics: runMetrics,
  trial: (args, ctx) => runTrial(args, ctx),
  evidence: runEvidence,
  client: runClient,
  token: runToken,
  admin: runAdminApi,
};

/** The command groups that go through the API; `cli.usage` lists them (test `cli/usage-texts.test.ts`). */
export const USER_COMMAND_GROUPS: readonly string[] = Object.keys(USER_COMMANDS);

/** Runs one `adlc` command and returns its exit code. */
export async function runCli(argv: readonly string[], ctx: CliContext): Promise<number> {
  const [group, command, ...rest] = argv;
  // V05: the published package (`@hoanghainh/governed-adlc`, ADR-M100) and a checkout print the same version.
  if (argv.length === 1 && (group === '--version' || group === '-V')) {
    ctx.stdout(PLATFORM_VERSION);
    return EXIT.ok;
  }
  // Print ASCII banner: `adlc banner` or `adlc --banner`.
  if (argv.length === 1 && (group === 'banner' || group === '--banner')) {
    ctx.stdout(renderBanner(ctx.env));
    return EXIT.ok;
  }
  // V10: `adlc help …`, `adlc --help`, and `adlc <group> … --help` print help and do nothing else.
  if (group === undefined || group === 'help' || isHelpFlag(group)) {
    if (group === undefined) {
      ctx.stderr(t('cli.usage'));
      return EXIT.usage;
    }
    return runHelp(group === 'help' ? argv.slice(1) : [], ctx);
  }
  if (argv.slice(1).some(isHelpFlag)) {
    const help = commandHelp(group);
    if (help !== undefined) {
      ctx.stdout(help);
      return EXIT.ok;
    }
  }
  const user = Object.hasOwn(USER_COMMANDS, group) ? USER_COMMANDS[group] : undefined;
  if (user) {
    try {
      return await user(argv.slice(1), ctx);
    } catch (error) {
      ctx.stderr(
        t('cli.failed', { reason: clean(error instanceof Error ? error.message : String(error)) }),
      );
      return EXIT.error;
    }
  }
  if (group === 'audit' && command === 'verify') {
    return guardedRun(() => runAuditVerify(rest, ctx), ctx);
  }
  // Operator commands on the server (B13 PR 2: renamed from `sdlc admin`, ADR-M37 §2.8).
  if (group === 'ops') return guardedRun(() => runOps(argv.slice(1), ctx), ctx);
  ctx.stderr(t('cli.usage'));
  return EXIT.usage;
}

async function guardedRun(run: () => Promise<number>, ctx: CliContext): Promise<number> {
  try {
    return await run();
  } catch (error) {
    ctx.stderr(
      t('cli.failed', { reason: clean(error instanceof Error ? error.message : String(error)) }),
    );
    return EXIT.error;
  }
}
