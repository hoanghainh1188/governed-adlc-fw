// `adlc admin agent …`: the agent register through the API (task B13 AC7, handbook Ch.20,
// ADR-M37 §2.8). An agent is activated or retired only by approvals: `approve --as <capacity>`;
// the last approval of a set changes the status. `--owner` takes a user ID or an e-mail address.
// An activation names its evaluation with `--evaluation` (L09, ADR-M86 §2.5); `show` gives the
// latest evaluation of the agent's current fingerprint and whether it qualifies.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { AGENT_REGISTER_ERROR_MESSAGES, isAgentRegisterErrorCode } from '@sdlc/core';
import { t } from '@sdlc/messages';

import {
  agentDetailSchema,
  agentListSchema,
  agentRecertifiedSchema,
  agentRoundSchema,
  agentSchema,
  type AgentEvaluationView,
  type AgentView,
} from '../api/schemas.js';
import { CommandExit, segment, type Values } from '../api/session.js';
import { EXIT } from '../context.js';
import { say, sayError, show } from '../output.js';
import {
  opt,
  output,
  resolveUser,
  str,
  type AdminApiCommand,
  type AdminCall,
} from './admin-call.js';

const key = { key: { type: 'string' } } as const;
const CONFIG = {
  model: { type: 'string' },
  instructions: { type: 'string' },
  'instructions-sha256': { type: 'string' },
  'instructions-file': { type: 'string' },
  tools: { type: 'string' },
  'max-autonomy': { type: 'string' },
  environments: { type: 'string' },
  adapter: { type: 'string' },
  // O06 (ADR-M31 §2.5 0.6): the repository root's file of a monorepo, pinned too; `none` removes it.
  'root-instructions': { type: 'string' },
  'root-instructions-file': { type: 'string' },
} as const;

const agentPath = (call: AdminCall): string =>
  `/v1/admin/agents/${segment(str(call.values, 'key'))}`;

const list = (value: string | undefined): string[] | undefined =>
  value
    ?.split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');

/** The SHA-256 of a local file, or a usage error. */
async function fileHash(call: AdminCall, file: string): Promise<string> {
  try {
    return createHash('sha256')
      .update(await readFile(file))
      .digest('hex');
  } catch {
    sayError(call.ctx, 'cli.admin.api.file_unreadable', { path: file, max: '-' });
    throw new CommandExit(EXIT.usage);
  }
}

/**
 * The second pinned file (O06): `--root-instructions <ref>` with `--root-instructions-file`, or
 * `--root-instructions none` alone (removes it). Neither: unchanged.
 */
async function rootInstructions(call: AdminCall): Promise<Record<string, unknown>> {
  const ref = opt(call.values, 'root-instructions');
  const file = opt(call.values, 'root-instructions-file');
  if (ref === undefined && file === undefined) return {};
  if (ref === 'none' && file === undefined) return { root_instructions_ref: null };
  if (ref === undefined || ref === 'none' || file === undefined) {
    sayError(call.ctx, 'cli.admin.api.usage');
    throw new CommandExit(EXIT.usage);
  }
  return { root_instructions_ref: ref, root_instructions_sha256: await fileHash(call, file) };
}

/** The instructions hash from exactly one source: the hash, or the file to hash. */
async function instructionsHash(call: AdminCall, required: boolean): Promise<string | undefined> {
  const file = opt(call.values, 'instructions-file');
  const given = opt(call.values, 'instructions-sha256');
  if ((file !== undefined && given !== undefined) || (required && file === given)) {
    sayError(call.ctx, 'cli.admin.api.usage');
    throw new CommandExit(EXIT.usage);
  }
  if (file === undefined) return given;
  return fileHash(call, file);
}

function configBody(values: Values): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    model_ref: opt(values, 'model'),
    instructions_ref: opt(values, 'instructions'),
    allowed_tools: list(opt(values, 'tools')),
    max_autonomy: opt(values, 'max-autonomy'),
    approved_environments: list(opt(values, 'environments')),
    adapter: opt(values, 'adapter'),
  };
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

const stop = (to: 'suspend' | 'quarantine'): AdminApiCommand => ({
  options: { ...key, reason: { type: 'string' } },
  required: ['key', 'reason'],
  run: async (call) => {
    const agent = await call.client.post(`${agentPath(call)}/${to}`, agentSchema, {
      reason_code: str(call.values, 'reason'),
    });
    return output(call, agent, () => sayAgent(call, 'cli.admin.agent.status_changed', agent));
  },
});

export const AGENT_COMMANDS: Readonly<Record<string, AdminApiCommand>> = {
  'agent register': {
    options: { ...key, ...CONFIG, version: { type: 'string' }, owner: { type: 'string' } },
    required: ['key', 'version', 'owner', 'instructions', 'max-autonomy'],
    run: async (call) => {
      const hash = await instructionsHash(call, true);
      const agent = await call.client.post('/v1/admin/agents', agentSchema, {
        key: str(call.values, 'key'),
        version: str(call.values, 'version'),
        owner_id: await resolveUser(call, str(call.values, 'owner')),
        instructions_sha256: hash,
        ...configBody(call.values),
        ...(await rootInstructions(call)),
      });
      return output(call, agent, () => sayAgent(call, 'cli.admin.agent.registered', agent));
    },
  },
  'agent update': {
    options: { ...key, ...CONFIG, version: { type: 'string' } },
    required: ['key', 'version'],
    run: async (call) => {
      const hash = await instructionsHash(call, false);
      const agent = await call.client.patch(agentPath(call), agentSchema, {
        version: str(call.values, 'version'),
        ...(hash === undefined ? {} : { instructions_sha256: hash }),
        ...configBody(call.values),
        ...(await rootInstructions(call)),
      });
      return output(call, agent, () => sayAgent(call, 'cli.admin.agent.updated', agent));
    },
  },
  'agent approve': {
    options: {
      ...key,
      purpose: { type: 'string' },
      as: { type: 'string' },
      reason: { type: 'string' },
      evaluation: { type: 'string' },
    },
    required: ['key', 'purpose', 'as'],
    run: async (call) => {
      const reason = opt(call.values, 'reason');
      const evaluation = opt(call.values, 'evaluation');
      const round = await call.client.post(`${agentPath(call)}/approvals`, agentRoundSchema, {
        purpose: str(call.values, 'purpose'),
        as: str(call.values, 'as'),
        ...(reason === undefined ? {} : { reason_code: reason }),
        ...(evaluation === undefined ? {} : { evaluation_code: evaluation }),
      });
      return output(call, round, () => {
        say(call.ctx, 'cli.admin.agent.approval', {
          key: round.agent.key,
          version: round.agent.version,
          purpose: round.purpose,
          capacity: str(call.values, 'as'),
          missing: round.missing.join(', ') || '-',
        });
        sayApprovalEvaluation(call, round.evaluation ?? null);
        if (round.completed) sayAgent(call, 'cli.admin.agent.status_changed', round.agent);
      });
    },
  },
  'agent suspend': stop('suspend'),
  'agent quarantine': stop('quarantine'),
  'agent owner': {
    options: { ...key, owner: { type: 'string' } },
    required: ['key', 'owner'],
    run: async (call) => {
      const agent = await call.client.put(`${agentPath(call)}/owner`, agentSchema, {
        owner_id: await resolveUser(call, str(call.values, 'owner')),
      });
      return output(call, agent, () => sayAgent(call, 'cli.admin.agent.owner_changed', agent));
    },
  },
  'agent recertify': {
    options: { ...key, date: { type: 'string' }, evaluation: { type: 'string' } },
    required: ['key'],
    run: async (call) => {
      const day = opt(call.values, 'date');
      const evaluation = opt(call.values, 'evaluation');
      const agent = await call.client.post(`${agentPath(call)}/recertify`, agentRecertifiedSchema, {
        ...(day === undefined ? {} : { day }),
        ...(evaluation === undefined ? {} : { evaluation_code: evaluation }),
      });
      return output(call, agent, () => {
        sayAgent(call, 'cli.admin.agent.recertified', agent);
        sayRecertificationEvaluation(call, agent.evaluation ?? null);
      });
    },
  },
  'agent show': {
    options: key,
    required: ['key'],
    run: async (call) => {
      const agent = await call.client.get(agentPath(call), agentDetailSchema);
      return output(call, agent, () => {
        say(call.ctx, 'cli.admin.agent.detail', text(agent));
        for (const round of agent.rounds) {
          say(call.ctx, 'cli.admin.agent.round', {
            purpose: round.purpose,
            required: round.required.join(', ') || '-',
            missing: round.missing.join(', ') || '-',
          });
        }
        sayLatestEvaluation(call, agent.evaluation ?? null);
      });
    },
  },
  'agent list': {
    options: { overdue: { type: 'boolean', default: false } },
    required: [],
    run: async (call) => {
      const overdue = call.values.overdue === true;
      // L10: the server filters overdue agents and adds each one's latest evaluation.
      const all = await call.client.get(
        overdue ? '/v1/admin/agents?overdue=true' : '/v1/admin/agents',
        agentListSchema,
      );
      const items = all.items.filter((agent) => !overdue || agent.overdue);
      return output(call, { items }, () => {
        if (items.length === 0) say(call.ctx, 'cli.admin.agent.none');
        for (const agent of items) {
          say(call.ctx, 'cli.admin.agent.line', text(agent));
          if (overdue) sayOverdueEvaluation(call, agent.evaluation ?? null);
        }
      });
    },
  },
};

/** The catalog text of an evaluation result that is not `passed` (ADR-M86 §2.8). */
function evaluationText(evaluation: AgentEvaluationView): string {
  const code = evaluation.result === 'missing' ? 'evaluation_missing' : (evaluation.result ?? '');
  return isAgentRegisterErrorCode(code)
    ? t(AGENT_REGISTER_ERROR_MESSAGES[code], evaluation.params)
    : code;
}

/** After an approval (L09): the numbers of a qualifying evaluation, or the `warn` mode warning. */
function sayApprovalEvaluation(call: AdminCall, evaluation: AgentEvaluationView | null): void {
  if (!evaluation || evaluation.result === null) return;
  if (evaluation.qualifies) {
    say(call.ctx, 'cli.admin.agent.evaluation_passed', evaluation.params);
  } else {
    say(call.ctx, 'cli.admin.agent.evaluation_warning', { text: evaluationText(evaluation) });
  }
}

/** After a recertification (L10): the numbers, the comparison with the last activation, or the warning. */
function sayRecertificationEvaluation(
  call: AdminCall,
  evaluation: AgentEvaluationView | null,
): void {
  if (!evaluation || evaluation.result === null) return;
  if (!evaluation.qualifies) {
    say(call.ctx, 'cli.admin.agent.evaluation_warning', { text: evaluationText(evaluation) });
    return;
  }
  say(call.ctx, 'cli.admin.agent.evaluation_recertified', evaluation.params);
  const aging = evaluation.aging;
  if (aging?.status === 'compared') say(call.ctx, 'cli.admin.agent.aging_compared', aging.params);
  if (aging?.reason === 'no_activation_evaluation') {
    say(call.ctx, 'cli.admin.agent.aging_skipped.no_activation_evaluation');
  }
  if (aging?.reason === 'too_few_shared_tasks') {
    say(call.ctx, 'cli.admin.agent.aging_skipped.too_few_shared_tasks', aging.params);
  }
}

/** `list --overdue` (L10): the latest evaluation of each agent and whether it qualifies. */
function sayOverdueEvaluation(call: AdminCall, evaluation: AgentEvaluationView | null): void {
  if (!evaluation || evaluation.code === null) {
    say(call.ctx, 'cli.admin.agent.overdue_no_evaluation');
    return;
  }
  say(call.ctx, 'cli.admin.agent.overdue_evaluation', {
    code: evaluation.code,
    verdict: evaluation.qualifies
      ? t('cli.admin.agent.evaluation_qualifies')
      : evaluationText(evaluation),
  });
}

/** `show` (L09): the latest evaluation of the current fingerprint and whether it qualifies. */
function sayLatestEvaluation(call: AdminCall, evaluation: AgentEvaluationView | null): void {
  if (evaluation?.mode === 'off') {
    say(call.ctx, 'cli.admin.agent.evaluation_off');
  } else if (!evaluation || evaluation.code === null) {
    say(call.ctx, 'cli.admin.agent.evaluation_none', { mode: evaluation?.mode ?? '-' });
  } else {
    say(call.ctx, 'cli.admin.agent.evaluation_line', {
      code: evaluation.code,
      mode: evaluation.mode,
      verdict: evaluation.qualifies
        ? t('cli.admin.agent.evaluation_qualifies')
        : evaluationText(evaluation),
    });
  }
}

function sayAgent(call: AdminCall, key: Parameters<typeof say>[1], agent: AgentView): void {
  say(call.ctx, key, { key: agent.key, version: agent.version, status: agent.status });
}

/** Message parameters: lists joined, missing values as `-`, the overdue flag as catalog text. */
function text(agent: AgentView): Record<string, string> {
  return {
    key: agent.key,
    id: agent.id,
    version: agent.version,
    status: agent.status,
    owner_id: agent.owner_id,
    model: show(agent.model_ref),
    instructions: agent.root_instructions_ref
      ? `${agent.instructions_ref} + ${agent.root_instructions_ref}`
      : agent.instructions_ref,
    instructions_sha256: agent.instructions_sha256,
    tools: agent.allowed_tools.join(',') || '-',
    max_autonomy: agent.max_autonomy,
    environments: agent.approved_environments.join(',') || '-',
    adapter: agent.adapter ?? 'openhands',
    recertified: show(agent.last_recertified_at),
    due: show(agent.recertification_due_on),
    overdue: agent.overdue ? t('cli.admin.agent.overdue_flag') : '',
  };
}
