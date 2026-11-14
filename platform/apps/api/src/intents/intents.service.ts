// Intents and gate decisions for the authenticated caller (D-08 B03 AC3). Access follows the
// project configuration (`access.*`, QUESTIONS.md #66): no role on the project → 404; a read role
// without a create role → 403 on create. Gate decisions go through the shared command handler.
// After a change, the intent's workflow is woken (B07, ADR-M30): creating an intent is its submit.
import {
  CommandError,
  consumeStepUp,
  currentGateWaitingFor,
  decideGate,
  gateInputSha256,
  INTENT_CODE_PATTERN,
  isDecidableGate,
  PasskeyError,
  projectAccess,
  recordEffortEstimate,
  RegistryError,
  stepUpRequestSha256,
  type Intent,
  type IntentFilters,
  type Project,
  type Registry,
  type TenantScope,
} from '@sdlc/core';
import type { GateCode, GitHostAdapter, IntentWorkflowSignals } from '@sdlc/contracts';
import type { z } from 'zod';

import type { Principal } from '../auth/principal.js';
import { ApiError } from '../errors/api-error.js';
import { wakeQuietly, type WakeLogger } from '../intent-signals.js';
import type { PasskeysService } from '../passkeys/passkeys.service.js';
import { decodeCursor, encodeCursor } from './cursor.js';
import {
  presentDecision,
  presentIntent,
  presentLinks,
  presentPlan,
  presentSpec,
  presentWaitingFor,
  type IntentBody,
} from './present.js';
import type {
  createIntentSchema,
  decisionSchema,
  effortEstimateSchema,
  listIntentsSchema,
} from './schemas.js';

export interface IntentPage {
  readonly items: readonly IntentBody[];
  readonly next_cursor: string | null;
}

/** X08a (ADR-M109 §2.1): the list filters, in the repository's words. */
function listFilters(query: z.infer<typeof listIntentsSchema>): IntentFilters {
  return {
    ...(query.gate === undefined ? {} : { gate: query.gate }),
    ...(query.risk_tier === undefined ? {} : { riskTier: query.risk_tier }),
    ...(query.created_from === undefined ? {} : { createdFrom: query.created_from }),
    ...(query.created_to === undefined ? {} : { createdTo: query.created_to }),
    ...(query.closed_from === undefined ? {} : { closedFrom: query.closed_from }),
    ...(query.closed_to === undefined ? {} : { closedTo: query.closed_to }),
    ...(query.sealed === undefined ? {} : { sealed: query.sealed }),
    ...(query.q === undefined ? {} : { q: query.q }),
  };
}

export class IntentsService {
  constructor(
    private readonly registry: Registry,
    private readonly signals: IntentWorkflowSignals,
    private readonly logger: WakeLogger,
    private readonly passkeys?: PasskeysService,
    private readonly webLinks?: Pick<GitHostAdapter, 'webUrl'>,
  ) {}

  async create(p: Principal, body: z.infer<typeof createIntentSchema>): Promise<IntentBody> {
    const project = await p.scope.projects.getBySlug(body.project);
    const access = project ? await projectAccess(p.scope, project.id, p.userId) : undefined;
    if (!project || !access?.canRead) {
      throw new CommandError('project_not_found', `project ${body.project} not found`);
    }
    if (!access.canCreateIntent) {
      throw new CommandError('forbidden', 'the caller may not create intents in this project');
    }
    const intent = await this.registry.createIntent(p.scope, {
      projectId: project.id,
      title: body.title,
      description: body.description,
      createdBy: p.userId,
      riskTier: body.risk_tier,
      dataClass: body.data_class,
      ...(body.budget_usd === undefined ? {} : { budgetUsd: body.budget_usd }),
      ...(body.issue_number === undefined ? {} : { issueNumber: body.issue_number }),
    });
    await wakeQuietly(
      this.signals,
      { tenantId: p.scope.tenantId, intentId: intent.id },
      this.logger,
    );
    return presentIntent(intent, project);
  }

  async show(p: Principal, ref: string): Promise<Record<string, unknown>> {
    const { intent, project } = await this.readable(p, ref);
    const [decisions, spec, plan, waitingFor, gateInputSha256, packs] = await Promise.all([
      p.scope.gateDecisions.listForIntent(intent.id),
      p.scope.specRefs.latest(intent.id),
      p.scope.plans.latest(intent.id),
      this.waitingFor(p, intent),
      this.gateInput(p, intent),
      p.scope.evidencePacks.listForIntent(intent.id),
    ]);
    const sealed = packs.some((pack) => pack.sealed_at !== null);
    return {
      ...presentIntent(intent, project),
      gate_input_sha256: gateInputSha256,
      waiting_for: presentWaitingFor(waitingFor),
      spec: presentSpec(spec),
      plan: presentPlan(plan),
      decisions: decisions.map(presentDecision),
      links: presentLinks(intent, project, { spec, plan, sealed }, this.webLinks),
    };
  }

  /** U07: the current gate's input hash the confirmation step shows. */
  private async gateInput(p: Principal, intent: Intent): Promise<string | null> {
    if (
      intent.status !== 'in_gate' ||
      !intent.current_gate ||
      !isDecidableGate(intent.current_gate)
    ) {
      return null;
    }
    try {
      return await gateInputSha256(p.scope, intent, intent.current_gate);
    } catch (error) {
      if (error instanceof CommandError && error.code === 'gate_input_missing') return null;
      throw error;
    }
  }

  async list(p: Principal, query: z.infer<typeof listIntentsSchema>): Promise<IntentPage> {
    const projects = await this.readableProjects(p, query.project);
    const rows = await p.scope.intents.page({
      projectIds: projects.map((project) => project.id),
      ...(query.status === undefined ? {} : { status: query.status }),
      limit: query.limit + 1,
      ...(query.cursor === undefined ? {} : { after: decodeCursor(query.cursor) }),
      filters: listFilters(query),
    });
    const page = rows.slice(0, query.limit);
    const bySlug = new Map(projects.map((project) => [project.id, project]));
    const last = page.at(-1);
    return {
      items: page.map((intent) => presentIntent(intent, bySlug.get(intent.project_id)!)),
      next_cursor:
        rows.length > query.limit && last
          ? encodeCursor({ createdAt: last.created_at, id: last.id })
          : null,
    };
  }

  async decide(
    p: Principal,
    ref: string,
    gate: string,
    body: z.infer<typeof decisionSchema>,
  ): Promise<Record<string, unknown>> {
    const { intent } = await this.readable(p, ref);
    const source = p.credential.kind === 'session' ? 'web' : 'cli';
    let row;
    if (p.credential.kind === 'session') {
      const { step_up: answer, expected_input_sha256, ...rest } = body;
      if (!answer || !this.passkeys) throw new ApiError(403, 'step_up_refused');
      const verified = await this.passkeys.verifyStepUp(p, answer);
      const binding = {
        action: 'gate.decide' as const,
        decision: body.decision,
        intentId: intent.id,
        escalationId: null,
        gate: gate as GateCode,
        expectedInputSha256: expected_input_sha256 ?? null,
        requestSha256: stepUpRequestSha256(rest),
      };
      row = await p.scope.transaction(async (tx) => {
        await consumeStepUp(tx, verified, binding, this.registry.now()).catch((error: unknown) => {
          throw error instanceof PasskeyError ? new ApiError(403, 'step_up_refused') : error;
        });
        return decideGate(this.registry, tx, {
          intent,
          gate,
          decision: body.decision,
          actorId: p.userId,
          reasonCode: body.reason_code ?? null,
          reasonRef: body.reason_ref ?? null,
          scope: body.scope ?? null,
          source,
          expectedInputSha256: body.expected_input_sha256 ?? null,
        });
      });
    } else {
      row = await decideGate(this.registry, p.scope, {
        intent,
        gate,
        decision: body.decision,
        actorId: p.userId,
        reasonCode: body.reason_code ?? null,
        reasonRef: body.reason_ref ?? null,
        scope: body.scope ?? null,
        source,
        expectedInputSha256: body.expected_input_sha256 ?? null,
      });
    }
    await wakeQuietly(
      this.signals,
      { tenantId: p.scope.tenantId, intentId: intent.id },
      this.logger,
    );
    return presentDecision(row);
  }

  /**
   * V14 (ADR-M79 §2.6, QUESTIONS #692, #693): records the human-effort estimate. A role in
   * `access.intent_create_roles` or a tenant admin; a finished intent → 409 `intent_finished`.
   */
  async estimate(
    p: Principal,
    ref: string,
    body: z.infer<typeof effortEstimateSchema>,
  ): Promise<IntentBody> {
    const intent = await findIntent(p.scope, ref);
    const project = intent ? await p.scope.projects.getById(intent.project_id) : undefined;
    if (!intent || !project) throw new CommandError('intent_not_found', `intent ${ref} not found`);
    const stored = await recordEffortEstimate(p.scope, {
      intent,
      hours: String(body.hours),
      actorId: p.userId,
    });
    return presentIntent(stored, project);
  }

  /** U01 (QUESTIONS #261): the workflow's resolution of the current gate, read only. */
  private async waitingFor(p: Principal, intent: Intent) {
    if (intent.status !== 'in_gate') return null;
    let policy;
    try {
      ({ policy } = await this.registry.policyFor(p.scope, intent.project_id));
    } catch (error) {
      // A configuration the platform refuses stops the workflow too: nothing is certain.
      if (error instanceof RegistryError) return null;
      throw error;
    }
    return currentGateWaitingFor(p.scope, policy, intent);
  }

  /** The intent and its project, or `intent_not_found` when the caller cannot read the project. */
  private async readable(p: Principal, ref: string): Promise<{ intent: Intent; project: Project }> {
    const intent = await findIntent(p.scope, ref);
    const project = intent ? await p.scope.projects.getById(intent.project_id) : undefined;
    if (!intent || !project || !(await projectAccess(p.scope, project.id, p.userId)).canRead) {
      throw new CommandError('intent_not_found', `intent ${ref} not found`);
    }
    return { intent, project };
  }

  private async readableProjects(p: Principal, slug: string | undefined): Promise<Project[]> {
    const candidates = slug
      ? [await p.scope.projects.getBySlug(slug)].filter((x): x is Project => x !== undefined)
      : await p.scope.projects.list();
    const readable: Project[] = [];
    for (const project of candidates) {
      if ((await projectAccess(p.scope, project.id, p.userId)).canRead) readable.push(project);
    }
    if (slug && readable.length === 0) {
      throw new CommandError('project_not_found', `project ${slug} not found`);
    }
    return readable;
  }
}

function findIntent(scope: TenantScope, ref: string): Promise<Intent | undefined> {
  return INTENT_CODE_PATTERN.test(ref) ? scope.intents.getByCode(ref) : scope.intents.getById(ref);
}
