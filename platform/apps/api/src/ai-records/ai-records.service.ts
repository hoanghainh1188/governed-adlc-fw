// The project AI record for the authenticated caller (D-08 B12 AC1, ADR-M32 §2.4). Access follows
// the project configuration (`access.ai_record_*`, QUESTIONS.md #103): no role on the project →
// 404; a read role without a write role → 403 on save. After a save, the project's draft intents
// are woken: the submit (Draft → G1) waits for a record that allows their data class (FR-19).
import {
  aiRecordAccess,
  CommandError,
  saveAiRecord,
  type Project,
  type TenantScope,
} from '@sdlc/core';
import type { IntentWorkflowSignals } from '@sdlc/contracts';
import type { z } from 'zod';

import type { Principal } from '../auth/principal.js';
import { ApiError } from '../errors/api-error.js';
import { wakeQuietly, type WakeLogger } from '../intent-signals.js';
import { presentAiRecord } from './present.js';
import type { saveAiRecordSchema } from './schemas.js';

export class AiRecordsService {
  constructor(
    private readonly signals: IntentWorkflowSignals,
    private readonly logger: WakeLogger,
    private readonly now: () => Date,
  ) {}

  async show(p: Principal, slug: string): Promise<Record<string, unknown>> {
    const project = await this.project(p.scope, slug, p.userId, 'read');
    const record = await p.scope.projectAiRecords.get(project.id);
    if (!record) throw new ApiError(404, 'ai_record_not_found');
    return presentAiRecord(record, project);
  }

  /**
   * Saves a new version. `run` wraps the write: a dashboard session's passkey step-up runs it in
   * the step-up's transaction (U09, ADR-M73 §2.4b); the drafts are woken after it commits.
   */
  async save(
    p: Principal,
    slug: string,
    body: z.infer<typeof saveAiRecordSchema>,
    run: <T>(write: (q: Principal) => Promise<T>) => Promise<T> = (write) => write(p),
  ): Promise<Record<string, unknown>> {
    const { project, saved } = await run((q) => this.write(q, slug, body));
    // Every draft, on purpose: the step decides again and records nothing new for the same cause.
    const drafts = await p.scope.intents.listForProject(project.id, { status: 'draft' });
    for (const intent of drafts) {
      await wakeQuietly(
        this.signals,
        { tenantId: p.scope.tenantId, intentId: intent.id },
        this.logger,
      );
    }
    return presentAiRecord(saved, project);
  }

  private async write(p: Principal, slug: string, body: z.infer<typeof saveAiRecordSchema>) {
    const project = await this.project(p.scope, slug, p.userId, 'write');
    const saved = await saveAiRecord(p.scope, project.id, {
      expectedVersion: body.expected_version,
      aiAllowed: body.ai_allowed,
      allowedDataClasses: body.allowed_data_classes,
      prodLogsAllowed: body.prod_logs_allowed,
      disclosureFormat: body.disclosure_format,
      confirmedAt: body.confirmed_at,
      recordRef: body.record_ref,
      updatedBy: p.userId,
      actorType: 'human',
      today: this.now().toISOString().slice(0, 10),
    });
    return { project, saved };
  }

  private async project(
    scope: TenantScope,
    slug: string,
    userId: string,
    need: 'read' | 'write',
  ): Promise<Project> {
    const project = await scope.projects.getBySlug(slug);
    const access = project ? await aiRecordAccess(scope, project.id, userId) : undefined;
    if (!project || !access?.canRead) {
      throw new CommandError('project_not_found', `project ${slug} not found`);
    }
    if (need === 'write' && !access.canWrite) {
      throw new CommandError('forbidden', 'the caller may not write the AI record');
    }
    return project;
  }
}
