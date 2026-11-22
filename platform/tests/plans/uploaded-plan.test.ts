// Unit tests for U10 PR 1 (#559, ADR-M113): `oversight.uploaded_plan_risks` config schema and
// `submitUploadedPlan` core validation, risk enforcement, storage and idempotency.
import { loadProjectConfig } from '@sdlc/config';
import { EvidenceError, type EvidenceStore, type RiskTier } from '@sdlc/contracts';
import { describe, expect, it } from 'vitest';

import type { Intent, Plan } from '../../packages/core/src/db/schema.js';
import type { TenantScope } from '../../packages/core/src/db/tenant-scope.js';
import {
  allowedUploadedPlanRisks,
  PLAN_MAX_BYTES,
  type PlanError,
  submitUploadedPlan,
} from '../../packages/core/src/plans/index.js';

const VALID_PLAN_YAML = `plan:
  intent_id: INT-2026-0042
tasks:
  - id: T1
    summary: Fix tax rounding in order total
    owner_agent: coder
    depends_on: []
    input: spec AC1
    output: code and tests
    allowed_paths: [src/orders/tax.ts]
    tools: [file_editor, terminal]
    environments: [sandbox]
    definition_of_done: [Unit tests pass]
    required_evidence: [unit_tests]
    escalate_when: [a change outside allowed_paths is needed]
    checkpoint: after each passing test run
`;

function memoryStore(): { store: EvidenceStore; objects: Map<string, Buffer> } {
  const objects = new Map<string, Buffer>();
  const store: EvidenceStore = {
    async put(tenantId, objectPath, content) {
      const key = `${tenantId}/${objectPath}`;
      if (objects.has(key)) throw new EvidenceError('exists');
      objects.set(key, Buffer.from(content));
      const { createHash } = await import('node:crypto');
      return {
        uri: `s3://evidence/${key}`,
        sha256: createHash('sha256').update(content).digest('hex'),
        sizeBytes: content.byteLength,
      };
    },
    get(uri) {
      const key = uri.replace(/^s3:\/\/evidence\//, '');
      const buf = objects.get(key);
      if (!buf) return Promise.reject(new EvidenceError('not_found'));
      return Promise.resolve(buf);
    },
  };
  return { store, objects };
}

function stubScope(options: { riskTier: RiskTier; configYaml?: string; initialPlans?: Plan[] }): {
  scope: TenantScope;
  submitted: Plan[];
} {
  const submitted: Plan[] = [...(options.initialPlans ?? [])];
  const intent: Intent = {
    id: 'intent-1',
    tenant_id: 'tenant-1',
    project_id: 'project-1',
    code: 'INT-2026-0042',
    title: 'Fix tax rounding',
    description: 'Round tax consistently',
    risk_tier: options.riskTier,
    data_class: 'internal',
    max_autonomy: 'L2',
    budget_usd: '5.000000',
    run_budget_usd: null,
    status: 'in_gate',
    current_gate: 'G3',
    issue_number: 1,
    pr_number: null,
    human_effort_hours: null,
    created_by: 'user-a',
    gate_entered_at: new Date('2026-11-22T00:00:00Z'),
    waiting_reason: null,
    waiting_cause: null,
    waiting_since: null,
    waiting_until: null,
    search_tsv: '',
    closed_at: null,
    created_at: new Date('2026-11-22T00:00:00Z'),
    updated_at: new Date('2026-11-22T00:00:00Z'),
  };

  const scope = {
    tenantId: 'tenant-1',
    roleBindings: {
      listForUser: () => Promise.resolve([{ project_id: 'project-1', role: 'person_a' }]),
    },
    projectConfigs: {
      get: () => {
        if (!options.configYaml) return Promise.resolve(undefined);
        const loaded = loadProjectConfig(options.configYaml);
        if (!loaded.ok) throw new Error('test config invalid');
        return Promise.resolve({
          config_yaml: options.configYaml,
          config_hash: loaded.configHash,
          version: 1,
        });
      },
    },
    intents: {
      lockAndGet: () => Promise.resolve(intent),
    },
    plans: {
      latest: () => Promise.resolve(submitted.at(-1)),
      list: () => Promise.resolve([...submitted]),
      submit: (_intentId: string, input: Record<string, unknown>) => {
        const uploaded = input.uploaded as { storageUri: string; allowedTools: string[] };
        const plan: Plan = {
          id: `plan-${String(submitted.length + 1)}`,
          tenant_id: 'tenant-1',
          intent_id: 'intent-1',
          version: submitted.length + 1,
          planned_files: [...(input.plannedFiles as string[])],
          summary: '',
          plan_sha256: input.planSha256 as string,
          proposed_by_type: 'human',
          change_flags: [...((input.changeFlags as Plan['change_flags']) ?? [])],
          commit_sha: null,
          allowed_tools: [...uploaded.allowedTools],
          submitted_by: input.actorId as string,
          plan_source: 'uploaded',
          storage_uri: uploaded.storageUri,
          created_at: new Date('2026-11-22T00:00:00Z'),
        };
        submitted.push(plan);
        return Promise.resolve(plan);
      },
    },
    transaction: async <T>(fn: (tx: TenantScope) => Promise<T>) => fn(scope),
  } as unknown as TenantScope;

  return { scope, submitted };
}

describe('U10 uploaded plan config & submission (#559, ADR-M113)', () => {
  it('defaults uploaded_plan_risks to [low] and rejects high or critical in config', () => {
    const defaults = loadProjectConfig('');
    expect(defaults.ok).toBe(true);
    if (defaults.ok) {
      expect(allowedUploadedPlanRisks(defaults.config)).toEqual(['low']);
    }

    const withMedium = loadProjectConfig('oversight:\n  uploaded_plan_risks: [low, medium]\n');
    expect(withMedium.ok).toBe(true);
    if (withMedium.ok) {
      expect(allowedUploadedPlanRisks(withMedium.config)).toEqual(['low', 'medium']);
    }

    expect(loadProjectConfig('oversight:\n  uploaded_plan_risks: [low, high]\n').ok).toBe(false);
    expect(loadProjectConfig('oversight:\n  uploaded_plan_risks: [critical]\n').ok).toBe(false);
  });

  it('stores a valid Low-risk uploaded plan in EvidenceStore and is idempotent on repeat submit', async () => {
    const { store, objects } = memoryStore();
    const { scope, submitted } = stubScope({ riskTier: 'low' });
    const intent = (await scope.intents.lockAndGet('intent-1'))!;

    const first = await submitUploadedPlan(scope, store, {
      intent,
      content: VALID_PLAN_YAML,
      actorId: 'user-a',
    });

    expect(first.plan_source).toBe('uploaded');
    expect(first.commit_sha).toBeNull();
    expect(first.storage_uri).toMatch(
      /^s3:\/\/evidence\/tenant-1\/plans\/intent-1\/[0-9a-f]{64}\.yaml$/,
    );
    expect(first.submitted_by).toBe('user-a');
    expect(first.planned_files).toEqual(['src/orders/tax.ts']);
    expect(first.allowed_tools).toEqual(['file_editor', 'terminal']);
    expect(objects.size).toBe(1);

    const second = await submitUploadedPlan(scope, store, {
      intent,
      content: VALID_PLAN_YAML,
      actorId: 'user-a',
    });
    expect(second.id).toBe(first.id);
    expect(submitted).toHaveLength(1);
  });

  it('refuses High, Critical, and unconfigured Medium risk tiers without touching EvidenceStore', async () => {
    for (const riskTier of ['medium', 'high', 'critical'] as const) {
      const { store, objects } = memoryStore();
      const { scope } = stubScope({ riskTier });
      const intent = (await scope.intents.lockAndGet('intent-1'))!;

      await expect(
        submitUploadedPlan(scope, store, { intent, content: VALID_PLAN_YAML, actorId: 'user-a' }),
      ).rejects.toMatchObject({ code: 'uploaded_plan_not_allowed' } satisfies Partial<PlanError>);
      expect(objects.size).toBe(0);
    }

    // Medium succeeds when explicitly enabled in project config.
    const { store, objects } = memoryStore();
    const { scope } = stubScope({
      riskTier: 'medium',
      configYaml: 'oversight:\n  uploaded_plan_risks: [low, medium]\n',
    });
    const intent = (await scope.intents.lockAndGet('intent-1'))!;
    const plan = await submitUploadedPlan(scope, store, {
      intent,
      content: VALID_PLAN_YAML,
      actorId: 'user-a',
    });
    expect(plan.plan_source).toBe('uploaded');
    expect(objects.size).toBe(1);
  });

  it('refuses oversized or invalid YAML plans before writing to EvidenceStore', async () => {
    const { store, objects } = memoryStore();
    const { scope } = stubScope({ riskTier: 'low' });
    const intent = (await scope.intents.lockAndGet('intent-1'))!;

    await expect(
      submitUploadedPlan(scope, store, {
        intent,
        content: 'a'.repeat(PLAN_MAX_BYTES + 1),
        actorId: 'user-a',
      }),
    ).rejects.toMatchObject({ code: 'plan_invalid', refusal: 'too_large' });

    await expect(
      submitUploadedPlan(scope, store, {
        intent,
        content: VALID_PLAN_YAML.replace('INT-2026-0042', 'INT-2026-9999'),
        actorId: 'user-a',
      }),
    ).rejects.toMatchObject({ code: 'plan_invalid', refusal: 'intent_mismatch' });

    expect(objects.size).toBe(0);
  });
});
