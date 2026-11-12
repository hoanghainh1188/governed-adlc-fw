import type { Project, TenantInsert } from '../schema.js';
import type { ProjectStatus } from '../vocabulary.js';
import { TenantRepository } from './base.js';

/** Fields an admin may change (B13; `repo_path`: O06). The slug, Git host and tenant never change. */
export interface ProjectUpdate {
  readonly name?: string;
  readonly repo_full_name?: string;
  readonly repo_path?: string;
  readonly default_branch?: string;
}

export class ProjectRepository extends TenantRepository {
  create(input: TenantInsert<'projects'>): Promise<Project> {
    return this.run(
      this.db
        .insertInto('projects')
        .values({ ...input, tenant_id: this.tenantId })
        .returningAll()
        .executeTakeFirstOrThrow(),
    );
  }

  getById(id: string): Promise<Project | undefined> {
    return this.run(
      this.db
        .selectFrom('projects')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', id)
        .executeTakeFirst(),
    );
  }

  getBySlug(slug: string): Promise<Project | undefined> {
    return this.run(
      this.db
        .selectFrom('projects')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('slug', '=', slug)
        .executeTakeFirst(),
    );
  }

  list(): Promise<Project[]> {
    return this.run(
      this.db
        .selectFrom('projects')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .orderBy('slug')
        .execute(),
    );
  }

  /** Returns the updated project, or undefined when the project is not in this tenant. */
  update(id: string, changes: ProjectUpdate): Promise<Project | undefined> {
    return this.run(
      this.db
        .updateTable('projects')
        .set({ ...changes })
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirst(),
    );
  }

  /** Returns the updated project, or undefined when the project is not in this tenant. */
  setStatus(id: string, status: ProjectStatus): Promise<Project | undefined> {
    return this.run(
      this.db
        .updateTable('projects')
        .set({ status })
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirst(),
    );
  }
}
