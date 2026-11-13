import type { ProjectMemoryRevocation, ProjectMemoryVersion, TenantInsert } from '../schema.js';
import { TenantRepository } from './base.js';

/** A memory version with its revocation, if any (ADR-M74 §2.3, §2.7). */
export interface MemoryVersionRow extends ProjectMemoryVersion {
  readonly revoked_at: Date | null;
  readonly revoked_by: string | null;
  readonly revocation_reason: ProjectMemoryRevocation['reason'] | null;
}

/**
 * Approved and revoked agent memory sets (task X13, migration 0053, ADR-M74). Both tables are
 * append-only: insert and read, nothing else. Every query names the tenant and the project.
 */
export class MemoryVersionRepository extends TenantRepository {
  /** Records a version; a taken number fails with `conflict` (two approvals at once). */
  record(
    input: Omit<TenantInsert<'project_memory_versions'>, 'tenant_id'>,
  ): Promise<ProjectMemoryVersion> {
    return this.run(
      this.db
        .insertInto('project_memory_versions')
        .values({ ...input, tenant_id: this.tenantId })
        .returningAll()
        .executeTakeFirstOrThrow(),
    );
  }

  /** Records a revocation; a second one of the same version fails with `conflict`. */
  revoke(
    input: Omit<TenantInsert<'project_memory_revocations'>, 'tenant_id'>,
  ): Promise<ProjectMemoryRevocation> {
    return this.run(
      this.db
        .insertInto('project_memory_revocations')
        .values({ ...input, tenant_id: this.tenantId })
        .returningAll()
        .executeTakeFirstOrThrow(),
    );
  }

  /** The project's versions, newest first, with their revocation. */
  list(projectId: string, limit = 100): Promise<MemoryVersionRow[]> {
    return this.run(this.query(projectId).orderBy('v.version', 'desc').limit(limit).execute());
  }

  /** One version of the project with its revocation, or undefined. */
  get(projectId: string, version: number): Promise<MemoryVersionRow | undefined> {
    return this.run(this.query(projectId).where('v.version', '=', version).executeTakeFirst());
  }

  /** The newest version of the project, revoked or not, or undefined. */
  latest(projectId: string): Promise<MemoryVersionRow | undefined> {
    return this.run(this.query(projectId).orderBy('v.version', 'desc').limit(1).executeTakeFirst());
  }

  /**
   * The newest version of the project with this set hash, revoked or not (ADR-M74 §2.6: G4 gives
   * no memory when it is revoked). Never another project's version.
   */
  findBySet(projectId: string, setSha256: string): Promise<MemoryVersionRow | undefined> {
    return this.run(
      this.query(projectId)
        .where('v.set_sha256', '=', setSha256)
        .orderBy('v.version', 'desc')
        .limit(1)
        .executeTakeFirst(),
    );
  }

  private query(projectId: string) {
    return this.db
      .selectFrom('project_memory_versions as v')
      .leftJoin('project_memory_revocations as r', (join) =>
        join
          .on('r.tenant_id', '=', this.tenantId)
          .onRef('r.project_id', '=', 'v.project_id')
          .onRef('r.version', '=', 'v.version'),
      )
      .selectAll('v')
      .select([
        'r.created_at as revoked_at',
        'r.revoked_by as revoked_by',
        'r.reason as revocation_reason',
      ])
      .where('v.tenant_id', '=', this.tenantId)
      .where('v.project_id', '=', projectId);
  }
}
