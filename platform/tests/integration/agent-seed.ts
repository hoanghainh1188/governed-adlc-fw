// Registers and activates an agent for the tests that create runs: since task C10, `runs.agent_id`
// refers to the agent register (QUESTIONS.md #32, migration 0008).
import crypto from 'node:crypto';

import { changeAgentStatus, registerAgent } from '../../packages/core/src/agents/index.js';
import type { TenantScope } from '../../packages/core/src/db/tenant-scope.js';

export interface SeedAgentOptions {
  readonly version?: string;
  readonly tools?: readonly string[];
  readonly instructionsSha256?: string;
  readonly model?: string;
  /** X03: the adapter that drives the agent. Default `openhands`. */
  readonly adapter?: string;
  /** When the agent is activated (its first certification date). Default: now. */
  readonly activatedAt?: Date;
  /** O06: the pinned file (`path@label`). Default `AGENTS.md@v1`. */
  readonly instructionsRef?: string;
  /** O06: the repository root's file, pinned too. */
  readonly rootInstructions?: { readonly ref: string; readonly sha256: string };
}

export interface SeededAgent {
  readonly id: string;
  readonly key: string;
  readonly version: string;
  readonly instructionsSha256: string;
  readonly tools: readonly string[];
}

/** An active agent owned by `ownerId`, with a unique key. Returns what a Run Contract needs. */
export async function seedAgent(
  scope: TenantScope,
  ownerId: string,
  options: SeedAgentOptions = {},
): Promise<SeededAgent> {
  const key = `coder-test-${crypto.randomBytes(4).toString('hex')}`;
  const version = options.version ?? '1.0.0';
  const instructionsSha256 = options.instructionsSha256 ?? 'c'.repeat(64);
  const tools = [...new Set(options.tools ?? ['editor'])].sort();
  const agent = await registerAgent(scope, {
    agentKey: key,
    version,
    ownerId,
    modelRef: options.model ?? 'gpt-oss-20b',
    instructionsRef: options.instructionsRef ?? 'AGENTS.md@v1',
    instructionsSha256,
    ...(options.rootInstructions === undefined
      ? {}
      : { rootInstructions: options.rootInstructions }),
    allowedTools: tools,
    maxAutonomy: 'L2',
    approvedEnvironments: ['sandbox'],
    ...(options.adapter === undefined ? {} : { adapter: options.adapter }),
  });
  await changeAgentStatus(scope, key, {
    to: 'active',
    ...(options.activatedAt ? { now: options.activatedAt } : {}),
  });
  return { id: agent.id, key, version, instructionsSha256, tools };
}
