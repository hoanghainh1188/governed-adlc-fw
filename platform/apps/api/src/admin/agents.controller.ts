// The agent register through the API (task B13 AC7, handbook Ch.20, ADR-M37 §2.8). Any person of
// the tenant reads it; the changes follow the Ch.20 approval rules (`@sdlc/core` agents/approvals).
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  AgentRegisterError,
  agentRound,
  approveAgent,
  changeOwnerAs,
  latestAgentEvaluation,
  recertificationMonths,
  recertifyAgentAs,
  registerAgentAs,
  stopAgentAs,
  updateAgentAs,
  type Agent,
} from '@sdlc/core';

import { CurrentPrincipal, type Principal } from '../auth/principal.js';
import { agentApiError } from '../errors/api-error.js';
import { CLOCK } from '../tokens.js';
import { parseRequest } from '../validation.js';
import { actorOf } from './actor.js';
import { presentAgent, presentRound, presentVerdict } from './agents.present.js';
import {
  agentKeySchema,
  approveAgentSchema,
  changeOwnerSchema,
  listAgentsSchema,
  recertifySchema,
  registerAgentSchema,
  stopAgentSchema,
  updateAgentSchema,
} from './schemas.js';

type Body = Record<string, unknown>;

@Controller('v1/admin/agents')
export class AdminAgentsController {
  constructor(@Inject(CLOCK) private readonly now: () => Date) {}

  @Get()
  async list(@CurrentPrincipal() p: Principal, @Query() query: unknown): Promise<Body> {
    const filter = parseRequest(listAgentsSchema, query ?? {}, 'query');
    const months = await recertificationMonths(p.scope, null);
    const now = this.now();
    const items = (await p.scope.agents.list()).map((agent) => ({
      agent,
      body: presentAgent(agent, months, now),
    }));
    if (filter.overdue !== 'true') return { items: items.map((item) => item.body) };
    // L10 (ADR-M86 §2.6): overdue agents only, each with its latest evaluation for a
    // recertification.
    const overdue = items.filter((item) => item.body.overdue === true);
    return {
      items: await Promise.all(
        overdue.map(async ({ agent, body }) => ({
          ...body,
          evaluation: presentVerdict(
            await latestAgentEvaluation(p.scope, agent, now, 'recertification'),
          ),
        })),
      ),
    };
  }

  @Get(':key')
  async show(@CurrentPrincipal() p: Principal, @Param('key') key: string): Promise<Body> {
    const agentKey = parseRequest(agentKeySchema, key, 'path');
    return this.call(agentKey, async () => {
      const months = await recertificationMonths(p.scope, null);
      const [activate, retire] = await Promise.all([
        agentRound(p.scope, agentKey, 'activate'),
        agentRound(p.scope, agentKey, 'retire'),
      ]);
      return {
        ...presentAgent(activate.agent, months, this.now()),
        rounds: [activate, retire].map((round) => presentRound(round, months, this.now())),
        // L09 (ADR-M86 §2.5): the latest evaluation of the current fingerprint and its check.
        evaluation: presentVerdict(
          await latestAgentEvaluation(p.scope, activate.agent, this.now()),
        ),
      };
    });
  }

  @Post()
  @HttpCode(201)
  async register(@CurrentPrincipal() p: Principal, @Body() body: unknown): Promise<Body> {
    const input = parseRequest(registerAgentSchema, body, 'body');
    return this.call(input.key, async () =>
      this.present(
        p,
        await registerAgentAs(p.scope, actorOf(p), {
          agentKey: input.key,
          version: input.version,
          ownerId: input.owner_id,
          modelRef: input.model_ref ?? null,
          instructionsRef: input.instructions_ref,
          instructionsSha256: input.instructions_sha256,
          allowedTools: input.allowed_tools,
          maxAutonomy: input.max_autonomy,
          approvedEnvironments: input.approved_environments,
          ...(input.adapter === undefined ? {} : { adapter: input.adapter }),
          ...rootOf(input),
          now: this.now(),
        }),
      ),
    );
  }

  @Patch(':key')
  async update(
    @CurrentPrincipal() p: Principal,
    @Param('key') key: string,
    @Body() body: unknown,
  ): Promise<Body> {
    const agentKey = parseRequest(agentKeySchema, key, 'path');
    const input = parseRequest(updateAgentSchema, body, 'body');
    return this.call(agentKey, async () =>
      this.present(
        p,
        await updateAgentAs(p.scope, actorOf(p), agentKey, {
          version: input.version,
          now: this.now(),
          ...(input.model_ref === undefined ? {} : { modelRef: input.model_ref }),
          ...(input.instructions_ref === undefined
            ? {}
            : { instructionsRef: input.instructions_ref }),
          ...(input.instructions_sha256 === undefined
            ? {}
            : { instructionsSha256: input.instructions_sha256 }),
          ...(input.allowed_tools === undefined ? {} : { allowedTools: input.allowed_tools }),
          ...(input.max_autonomy === undefined ? {} : { maxAutonomy: input.max_autonomy }),
          ...(input.approved_environments === undefined
            ? {}
            : { approvedEnvironments: input.approved_environments }),
          ...(input.adapter === undefined ? {} : { adapter: input.adapter }),
          ...rootOf(input),
        }),
      ),
    );
  }

  /** Approves the activation or retirement; the last approval of a set changes the status. */
  @Post(':key/approvals')
  @HttpCode(200)
  async approve(
    @CurrentPrincipal() p: Principal,
    @Param('key') key: string,
    @Body() body: unknown,
  ): Promise<Body> {
    const agentKey = parseRequest(agentKeySchema, key, 'path');
    const input = parseRequest(approveAgentSchema, body, 'body');
    return this.call(agentKey, async () => {
      const result = await approveAgent(p.scope, actorOf(p), agentKey, {
        purpose: input.purpose,
        capacity: input.as,
        now: this.now(),
        ...(input.reason_code === undefined ? {} : { reason: input.reason_code }),
        ...(input.evaluation_code === undefined ? {} : { evaluationCode: input.evaluation_code }),
      });
      return presentRound(result, await recertificationMonths(p.scope, null), this.now());
    });
  }

  @Post(':key/suspend')
  @HttpCode(200)
  suspend(@CurrentPrincipal() p: Principal, @Param('key') key: string, @Body() body: unknown) {
    return this.stop(p, key, body, 'suspended');
  }

  @Post(':key/quarantine')
  @HttpCode(200)
  quarantine(@CurrentPrincipal() p: Principal, @Param('key') key: string, @Body() body: unknown) {
    return this.stop(p, key, body, 'quarantined');
  }

  @Put(':key/owner')
  async owner(
    @CurrentPrincipal() p: Principal,
    @Param('key') key: string,
    @Body() body: unknown,
  ): Promise<Body> {
    const agentKey = parseRequest(agentKeySchema, key, 'path');
    const input = parseRequest(changeOwnerSchema, body, 'body');
    return this.call(agentKey, async () =>
      this.present(
        p,
        await changeOwnerAs(p.scope, actorOf(p), agentKey, input.owner_id, this.now()),
      ),
    );
  }

  @Post(':key/recertify')
  @HttpCode(200)
  async recertify(
    @CurrentPrincipal() p: Principal,
    @Param('key') key: string,
    @Body() body: unknown,
  ): Promise<Body> {
    const agentKey = parseRequest(agentKeySchema, key, 'path');
    const input = parseRequest(recertifySchema, body ?? {}, 'body');
    return this.call(agentKey, async () => {
      const result = await recertifyAgentAs(p.scope, actorOf(p), agentKey, {
        now: this.now(),
        ...(input.day === undefined ? {} : { day: input.day }),
        ...(input.evaluation_code === undefined ? {} : { evaluationCode: input.evaluation_code }),
      });
      // L10: the agent and the check of its evaluation (a warning in `warn` mode).
      return {
        ...(await this.present(p, result.agent)),
        evaluation: presentVerdict(result.evaluation),
      };
    });
  }

  private async stop(
    p: Principal,
    key: string,
    body: unknown,
    to: 'suspended' | 'quarantined',
  ): Promise<Body> {
    const agentKey = parseRequest(agentKeySchema, key, 'path');
    const input = parseRequest(stopAgentSchema, body, 'body');
    return this.call(agentKey, async () =>
      this.present(
        p,
        await stopAgentAs(p.scope, actorOf(p), agentKey, to, input.reason_code, this.now()),
      ),
    );
  }

  private async present(p: Principal, agent: Agent): Promise<Body> {
    return presentAgent(agent, await recertificationMonths(p.scope, null), this.now());
  }

  /** Register refusals carry the agent key into their catalog text. */
  private async call(agentKey: string, work: () => Promise<Body>): Promise<Body> {
    try {
      return await work();
    } catch (error) {
      throw error instanceof AgentRegisterError ? agentApiError(error, agentKey) : error;
    }
  }
}

/**
 * The second pinned file of the request (O06, ADR-M31 §2.5 0.6): set (ref and hash), removed
 * (`null` ref), or left out. The schema already checked that the two fields go together.
 */
function rootOf(input: {
  root_instructions_ref?: string | null | undefined;
  root_instructions_sha256?: string | undefined;
}): { rootInstructions?: { ref: string; sha256: string } | null } {
  const ref = input.root_instructions_ref;
  if (ref === undefined) return {};
  if (ref === null) return { rootInstructions: null };
  return { rootInstructions: { ref, sha256: input.root_instructions_sha256 ?? '' } };
}
