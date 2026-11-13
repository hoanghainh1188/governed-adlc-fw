// Agent memory of a project for the authenticated caller (task X13 PR 1, ADR-M74 §2.3, §2.7).
// No role on the project → 404. Approving reads the Git host; without one (dev mode without
// OpenBao) it answers `git_host_unavailable` after the access check.
import {
  approveMemory,
  listMemoryVersions,
  memoryProject,
  MemoryError,
  revokeMemory,
  type MemoryGitHost,
} from '@sdlc/core';
import type { MemoryRevocationReason } from '@sdlc/contracts';

import type { Principal } from '../auth/principal.js';
import { presentMemoryVersion, presentProject } from './present.js';

export class MemoryService {
  constructor(private readonly git: MemoryGitHost | undefined) {}

  async list(p: Principal, slug: string): Promise<Record<string, unknown>> {
    const { project, versions } = await listMemoryVersions(p.scope, {
      projectSlug: slug,
      actorId: p.userId,
    });
    return {
      project: presentProject(project),
      versions: versions.map(presentMemoryVersion),
    };
  }

  async approve(
    p: Principal,
    slug: string,
    commitSha: string | undefined,
  ): Promise<Record<string, unknown>> {
    if (!this.git) {
      await memoryProject(p.scope, slug, p.userId);
      throw new MemoryError('git_host_unavailable', 'no Git host in this process');
    }
    const result = await approveMemory(p.scope, this.git, {
      projectSlug: slug,
      commitSha: commitSha ?? null,
      actorId: p.userId,
    });
    return {
      project: presentProject(result.project),
      recorded: result.recorded,
      files: result.files,
      commits_without_account: result.commitsWithoutAccount,
      version: presentMemoryVersion(result.version),
    };
  }

  async revoke(
    p: Principal,
    slug: string,
    version: number,
    reason: MemoryRevocationReason,
  ): Promise<Record<string, unknown>> {
    const result = await revokeMemory(p.scope, {
      projectSlug: slug,
      version,
      reason,
      actorId: p.userId,
    });
    return {
      project: presentProject(result.project),
      version: presentMemoryVersion(result.version),
    };
  }
}
