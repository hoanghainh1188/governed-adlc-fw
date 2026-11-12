// O06 PR 2a (ADR-M106 §2.4, ADR-M31 §2.5 0.6, migration 0049): several projects on one repository,
// each with its folder, and the agent's second pinned file, on PostgreSQL.
import { createSimplePolicyEngine } from '@sdlc/adapter-policy-simple';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SYSTEM_ACTOR } from '../../../packages/core/src/admin/actor.js';
import {
  archiveProject,
  createProject,
  updateProject,
} from '../../../packages/core/src/admin/projects.js';
import { AgentRegisterError } from '../../../packages/core/src/agents/errors.js';
import {
  changeAgentStatus,
  registerAgent,
  updateAgent,
  type RegisterAgent,
} from '../../../packages/core/src/agents/register.js';
import { parseTenantId } from '../../../packages/core/src/db/tenant-id.js';
import type { TenantScope } from '../../../packages/core/src/db/tenant-scope.js';
import type { RegistryDeps } from '../../../packages/core/src/registry/effective-config.js';
import { createTestDatabase, describeDb, type TestDatabase } from './helpers.js';

const REPO = 'org/monorepo';
const SHA = (c: string) => c.repeat(64);
const NOW = new Date('2026-11-12T08:00:00.000Z');
const registryDeps: RegistryDeps = {
  policyFactory: (config) => createSimplePolicyEngine({ config }),
  now: () => NOW,
};

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    if (error instanceof AgentRegisterError) return `${error.code}:${error.field ?? ''}`;
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : String(error);
  }
  return 'resolved';
}

describeDb('O06 PR 2a: projects on one repository, two pinned files', () => {
  let t0: TestDatabase;
  let count = 0;

  beforeAll(async () => {
    t0 = await createTestDatabase();
  }, 60_000);
  afterAll(async () => {
    await t0?.drop();
  });

  async function tenant(): Promise<TenantScope> {
    const slug = `tenant-${String(++count)}`;
    const created = await t0.app.system.createTenant({ slug, name: slug });
    return t0.app.forTenant(parseTenantId(created.id));
  }

  const project = (scope: TenantScope, slug: string, repoPath?: string, repo = REPO) =>
    createProject(scope, SYSTEM_ACTOR, {
      slug,
      name: slug,
      repoFullName: repo,
      ...(repoPath === undefined ? {} : { repoPath }),
    });

  describe('projects.repo_path (D-05 §6.1 1.67)', () => {
    it('defaults to the whole repository; two separate folders share one repository', async () => {
      const scope = await tenant();
      const whole = await project(scope, 'whole', undefined, 'org/other');
      expect(whole.repo_path).toBe('');
      const web = await project(scope, 'web', 'packages/web');
      const api = await project(scope, 'api', 'packages/api');
      expect([web.repo_path, api.repo_path]).toEqual(['packages/web', 'packages/api']);
      // A sibling whose name only starts with the same letters does not overlap.
      expect((await project(scope, 'web2', 'packages/web2')).repo_path).toBe('packages/web2');
    });

    it.each([
      ['the same folder', 'packages/web', 'packages/web'],
      ['a folder inside', 'packages/web', 'packages/web/src'],
      ['a folder around', 'packages/web/src', 'packages'],
      ['the whole repository next to a folder', 'packages/web', ''],
      ['a folder next to the whole repository', '', 'packages/web'],
    ])('refuses %s (repo_path_overlap)', async (_name, first, second) => {
      const scope = await tenant();
      await project(scope, 'first', first);
      expect(await codeOf(project(scope, 'second', second))).toBe('repo_path_overlap');
    });

    it('ignores archived projects and other repositories and tenants', async () => {
      const scope = await tenant();
      await project(scope, 'old', '');
      await archiveProject(scope, SYSTEM_ACTOR, 'old');
      await project(scope, 'new', 'apps/web');
      await project(scope, 'elsewhere', '', 'org/elsewhere');
      const other = await tenant();
      await project(other, 'same', '');
      expect(await codeOf(project(scope, 'next', 'apps/api'))).toBe('resolved');
    });

    it.each(['/abs', 'a/', 'a//b', '.', '..', 'a/../b', 'a/./b', 'a b', 'x'.repeat(201)])(
      'refuses the folder %j (invalid_value)',
      async (repoPath) => {
        const scope = await tenant();
        expect(await codeOf(project(scope, 'bad', repoPath))).toBe('invalid_value');
      },
    );

    it('the CHECK refuses a bad folder written without the admin module', async () => {
      const scope = await tenant();
      const created = await project(scope, 'p', 'apps/web');
      expect(await codeOf(scope.projects.update(created.id, { repo_path: 'a/../b' }))).toBe(
        'invalid_value',
      );
    });

    it('an update into an overlapping folder or repository is refused, by the trigger too', async () => {
      const scope = await tenant();
      await project(scope, 'web', 'apps/web');
      const api = await project(scope, 'api', 'apps/api', 'org/another');
      expect(await codeOf(updateProject(scope, SYSTEM_ACTOR, 'api', { repoFullName: REPO }))).toBe(
        'resolved',
      );
      expect(await codeOf(updateProject(scope, SYSTEM_ACTOR, 'api', { repoPath: 'apps' }))).toBe(
        'repo_path_overlap',
      );
      expect(await codeOf(scope.projects.update(api.id, { repo_path: 'apps/web/x' }))).toBe(
        'conflict',
      );
    });

    it('the folder and the repository change only while no intent is open', async () => {
      const scope = await tenant();
      const created = await project(scope, 'p', 'apps/web');
      const person = await scope.users.create({ display_name: 'a', email: 'a@example.com' });
      await scope.intents.create(
        {
          projectId: created.id,
          title: 'Cancel an order',
          createdBy: person.id,
          riskTier: 'medium',
          dataClass: 'internal',
        },
        registryDeps,
      );
      for (const changes of [{ repoPath: 'apps/api' }, { repoFullName: 'org/moved' }]) {
        expect(await codeOf(updateProject(scope, SYSTEM_ACTOR, 'p', changes))).toBe(
          'project_has_open_intents',
        );
      }
      // The same values, or another field, are no move.
      expect(
        await codeOf(updateProject(scope, SYSTEM_ACTOR, 'p', { repoPath: 'apps/web', name: 'P' })),
      ).toBe('resolved');
    });
  });

  describe('agents.root_instructions_* (ADR-M31 §2.5 0.6)', () => {
    async function owner(scope: TenantScope): Promise<string> {
      return (await scope.users.create({ display_name: 'o', email: 'o@example.com' })).id;
    }

    const base = (ownerId: string, extra: Partial<RegisterAgent> = {}): RegisterAgent => ({
      agentKey: 'coder-web',
      version: '1.0.0',
      ownerId,
      modelRef: 'claude-haiku-4-5-20251001',
      instructionsRef: 'packages/web/AGENTS.md@v1',
      instructionsSha256: SHA('c'),
      allowedTools: ['terminal'],
      maxAutonomy: 'L2',
      approvedEnvironments: ['sandbox'],
      now: NOW,
      ...extra,
    });

    it('registers the second file and audits its hash only', async () => {
      const scope = await tenant();
      const agent = await registerAgent(
        scope,
        base(await owner(scope), { rootInstructions: { ref: 'AGENTS.md@v2', sha256: SHA('d') } }),
      );
      expect(agent).toMatchObject({
        root_instructions_ref: 'AGENTS.md@v2',
        root_instructions_sha256: SHA('d'),
      });
      const [event] = await scope.audit.listForEntity(agent.id, ['agent.registered']);
      expect(event?.payload).toMatchObject({ root_instructions_sha256: SHA('d') });
      expect(JSON.stringify(event?.payload)).not.toContain('AGENTS.md');
    });

    it('none by default; the audit event then has no hash', async () => {
      const scope = await tenant();
      const agent = await registerAgent(scope, base(await owner(scope)));
      expect(agent.root_instructions_ref).toBeNull();
      const [event] = await scope.audit.listForEntity(agent.id, ['agent.registered']);
      expect(event?.payload).not.toHaveProperty('root_instructions_sha256');
    });

    it.each(['packages/web/AGENTS.md@v1', 'README.md@v1', 'AGENTS.md', '../AGENTS.md@v1'])(
      'refuses %j as the root file',
      async (ref) => {
        const scope = await tenant();
        expect(
          await codeOf(
            registerAgent(
              scope,
              base(await owner(scope), { rootInstructions: { ref, sha256: SHA('d') } }),
            ),
          ),
        ).toMatch(/^invalid_input:/);
      },
    );

    it('a change is a new version while suspended; null removes it', async () => {
      const scope = await tenant();
      const ownerId = await owner(scope);
      await registerAgent(scope, base(ownerId));
      await changeAgentStatus(scope, 'coder-web', { to: 'active', now: NOW });
      // Active: no configuration change, the trigger agrees.
      expect(
        await codeOf(
          updateAgent(scope, 'coder-web', {
            version: '1.1.0',
            rootInstructions: { ref: 'CLAUDE.md@v1', sha256: SHA('e') },
          }),
        ),
      ).toBe('config_change_not_allowed:');
      await changeAgentStatus(scope, 'coder-web', { to: 'suspended', reason: 'quality', now: NOW });
      const set = await updateAgent(scope, 'coder-web', {
        version: '1.1.0',
        rootInstructions: { ref: 'CLAUDE.md@v1', sha256: SHA('e') },
      });
      expect(set.root_instructions_ref).toBe('CLAUDE.md@v1');
      const removed = await updateAgent(scope, 'coder-web', {
        version: '1.2.0',
        rootInstructions: null,
      });
      expect([removed.root_instructions_ref, removed.root_instructions_sha256]).toEqual([
        null,
        null,
      ]);
      // Without a new version the trigger refuses a change of the second file.
      expect(
        await codeOf(
          scope.agents.update(
            removed.id,
            { rootInstructions: { ref: 'AGENTS.md@v1', sha256: SHA('f') } },
            NOW,
          ),
        ),
      ).toBe('immutable');
    });
  });
});
