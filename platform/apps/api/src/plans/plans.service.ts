// Plans of an intent (task B09, D-08 B09 AC2, ADR-M40 §2.3). Submitting reads the plan file from
// the Git host and stores its SHA-256 and coded fields; reading lists the submitted versions.
// Access follows the project configuration: no role → 404, a read role only → 403 on submit
// (`access.plan_submit_roles`). After a submission the intent's workflow is woken: a plan
// submitted at G4 takes it back to G3, and a held G3 or G4 moves on.
import {
  CommandError,
  INTENT_CODE_PATTERN,
  planAccess,
  PlanError,
  submitPlanFromGitHost,
  submitUploadedPlan,
  type Intent,
  type Plan,
  type SpecGitHost,
  type TenantScope,
} from '@sdlc/core';
import type { EvidenceStore, IntentWorkflowSignals } from '@sdlc/contracts';
import type { z } from 'zod';

import type { Principal } from '../auth/principal.js';
import { wakeQuietly, type WakeLogger } from '../intent-signals.js';
import { presentPlanList, presentSubmittedPlan } from './present.js';
import type { submitPlanSchema } from './schemas.js';

export class PlansService {
  constructor(
    /** Undefined in dev mode without OpenBao: submitting answers `git_host_unavailable`. */
    private readonly git: SpecGitHost | undefined,
    private readonly signals: IntentWorkflowSignals,
    private readonly logger: WakeLogger,
    /** U10 (ADR-M113): evidence store with `keyPrefix: 'plans/'` for uploaded Low-risk plans. */
    private readonly planStore?: EvidenceStore,
  ) {}

  async submit(
    p: Principal,
    ref: string,
    body: z.infer<typeof submitPlanSchema>,
  ): Promise<Record<string, unknown>> {
    const intent = await this.intent(p.scope, ref);
    let plan: Plan;
    if (body.plan_yaml !== undefined) {
      if (!this.planStore) {
        const access = await planAccess(p.scope, intent.project_id, p.userId);
        if (!access.canRead) throw new CommandError('intent_not_found', `intent ${ref} not found`);
        if (!access.canSubmit)
          throw new CommandError('forbidden', 'the caller may not submit a plan');
        throw new PlanError('plan_store_unavailable', 'no evidence store in this process');
      }
      plan = await submitUploadedPlan(p.scope, this.planStore, {
        intent,
        content: body.plan_yaml,
        actorId: p.userId,
      });
    } else {
      if (!this.git) {
        // Check access first, so the answer is the same as with a Git host.
        const access = await planAccess(p.scope, intent.project_id, p.userId);
        if (!access.canRead) throw new CommandError('intent_not_found', `intent ${ref} not found`);
        if (!access.canSubmit)
          throw new CommandError('forbidden', 'the caller may not submit a plan');
        throw new PlanError('git_host_unavailable', 'no Git host in this process');
      }
      plan = await submitPlanFromGitHost(p.scope, this.git, {
        intent,
        commitSha: body.commit_sha ?? null,
        actorId: p.userId,
      });
    }
    await wakeQuietly(
      this.signals,
      { tenantId: p.scope.tenantId, intentId: intent.id },
      this.logger,
    );
    return presentSubmittedPlan(intent.code, plan);
  }

  async list(p: Principal, ref: string): Promise<Record<string, unknown>> {
    const intent = await this.intent(p.scope, ref);
    const access = await planAccess(p.scope, intent.project_id, p.userId);
    if (!access.canRead) throw new CommandError('intent_not_found', `intent ${ref} not found`);
    const plans = await p.scope.plans.list(intent.id);
    return presentPlanList(intent.code, plans);
  }

  private async intent(scope: TenantScope, ref: string): Promise<Intent> {
    const intent = INTENT_CODE_PATTERN.test(ref)
      ? await scope.intents.getByCode(ref)
      : await scope.intents.getById(ref);
    if (!intent) throw new CommandError('intent_not_found', `intent ${ref} not found`);
    return intent;
  }
}
