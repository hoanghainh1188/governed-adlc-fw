// Admin endpoints for projects, their roles and their configuration (task B13 AC2, AC4;
// ADR-M37 §2.6). Projects: tenant admins. Roles and configuration: a tenant admin or the project's
// `admin` changes them; anyone with a role on the project reads them.
import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  archiveProject,
  createProject,
  grantProjectRole,
  listProjectRoles,
  listProjects,
  revokeProjectRole,
  saveProjectConfig,
  showProject,
  showProjectConfig,
  updateProject,
} from '@sdlc/core';

import { SessionAction } from '../auth/auth.guard.js';
import { CurrentPrincipal, type Principal } from '../auth/principal.js';
import { localeOf } from '../errors/locale.js';
import { ADMIN_STEP_UP } from '../tokens.js';
import { parseRequest } from '../validation.js';
import { actorOf } from './actor.js';
import { presentConfig, presentProject, presentRoleBinding } from './present.js';
import type { AdminStepUp } from './step-up.js';
import {
  createProjectSchema,
  emptyBodySchema,
  grantRoleSchema,
  historyQuerySchema,
  idSchema,
  projectSlugSchema,
  saveConfigSchema,
  updateProjectSchema,
} from './schemas.js';

type Body = Record<string, unknown>;

const BASE = '/v1/admin/projects';

// U09 (ADR-M73 §2.4b): every change also takes a dashboard session, with a passkey step-up.
@Controller('v1/admin/projects')
export class AdminProjectsController {
  constructor(@Inject(ADMIN_STEP_UP) private readonly stepUp: AdminStepUp) {}

  @Get()
  async list(@CurrentPrincipal() p: Principal): Promise<Body> {
    const projects = await listProjects(p.scope, actorOf(p));
    return { items: projects.map(presentProject) };
  }

  @Post()
  @SessionAction('actions')
  @HttpCode(201)
  async create(@CurrentPrincipal() p: Principal, @Body() body: unknown): Promise<Body> {
    const split = this.stepUp.split(p, body);
    const input = parseRequest(createProjectSchema, split.body, 'body');
    const change = { action: 'admin.project', decision: 'create', target: BASE } as const;
    const project = await this.stepUp.run(p, change, split, (q) =>
      createProject(q.scope, actorOf(q), {
        slug: input.slug,
        name: input.name,
        repoFullName: input.repo_full_name,
        ...(input.repo_path === undefined ? {} : { repoPath: input.repo_path }),
        ...(input.default_branch === undefined ? {} : { defaultBranch: input.default_branch }),
        ...(input.git_provider === undefined ? {} : { gitProvider: input.git_provider }),
      }),
    );
    return presentProject(project);
  }

  @Get(':project')
  async show(@CurrentPrincipal() p: Principal, @Param('project') slug: string): Promise<Body> {
    return presentProject(
      await showProject(p.scope, actorOf(p), parseRequest(projectSlugSchema, slug, 'path')),
    );
  }

  @Patch(':project')
  @SessionAction('actions')
  async update(
    @CurrentPrincipal() p: Principal,
    @Param('project') slug: string,
    @Body() body: unknown,
  ): Promise<Body> {
    const projectSlug = parseRequest(projectSlugSchema, slug, 'path');
    const split = this.stepUp.split(p, body);
    const input = parseRequest(updateProjectSchema, split.body, 'body');
    const change = {
      action: 'admin.project',
      decision: 'update',
      target: `${BASE}/${projectSlug}`,
    } as const;
    const project = await this.stepUp.run(p, change, split, (q) =>
      updateProject(q.scope, actorOf(q), projectSlug, {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.repo_full_name === undefined ? {} : { repoFullName: input.repo_full_name }),
        ...(input.repo_path === undefined ? {} : { repoPath: input.repo_path }),
        ...(input.default_branch === undefined ? {} : { defaultBranch: input.default_branch }),
      }),
    );
    return presentProject(project);
  }

  @Post(':project/archive')
  @SessionAction('actions')
  @HttpCode(200)
  async archive(
    @CurrentPrincipal() p: Principal,
    @Param('project') slug: string,
    @Body() body: unknown,
  ): Promise<Body> {
    const projectSlug = parseRequest(projectSlugSchema, slug, 'path');
    const split = this.stepUp.split(p, body);
    parseRequest(emptyBodySchema, split.body ?? {}, 'body');
    const change = {
      action: 'admin.project',
      decision: 'archive',
      target: `${BASE}/${projectSlug}/archive`,
    } as const;
    return presentProject(
      await this.stepUp.run(p, change, split, (q) =>
        archiveProject(q.scope, actorOf(q), projectSlug),
      ),
    );
  }

  @Get(':project/roles')
  async roles(
    @CurrentPrincipal() p: Principal,
    @Param('project') slug: string,
    @Query() query: unknown,
  ): Promise<Body> {
    const history = parseRequest(historyQuerySchema, query, 'query');
    const { project, bindings } = await listProjectRoles(
      p.scope,
      actorOf(p),
      parseRequest(projectSlugSchema, slug, 'path'),
      history.include_revoked === 'true',
    );
    return { items: bindings.map((binding) => presentRoleBinding(binding, project)) };
  }

  @Post(':project/roles')
  @SessionAction('actions')
  @HttpCode(201)
  async grant(
    @CurrentPrincipal() p: Principal,
    @Param('project') slug: string,
    @Body() body: unknown,
  ): Promise<Body> {
    const projectSlug = parseRequest(projectSlugSchema, slug, 'path');
    const split = this.stepUp.split(p, body);
    const input = parseRequest(grantRoleSchema, split.body, 'body');
    const change = {
      action: 'admin.project',
      decision: 'role_grant',
      target: `${BASE}/${projectSlug}/roles`,
    } as const;
    const binding = await this.stepUp.run(p, change, split, (q) =>
      grantProjectRole(q.scope, actorOf(q), projectSlug, {
        userId: input.user_id,
        role: input.role,
      }),
    );
    return presentRoleBinding(binding, { id: binding.project_id, slug: projectSlug });
  }

  @Delete(':project/roles/:id')
  @SessionAction('actions')
  async revoke(
    @CurrentPrincipal() p: Principal,
    @Param('project') slug: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<Body> {
    const projectSlug = parseRequest(projectSlugSchema, slug, 'path');
    const roleId = parseRequest(idSchema, id, 'path');
    const split = this.stepUp.split(p, body);
    parseRequest(emptyBodySchema, split.body ?? {}, 'body');
    const change = {
      action: 'admin.project',
      decision: 'role_revoke',
      target: `${BASE}/${projectSlug}/roles/${roleId}`,
    } as const;
    const binding = await this.stepUp.run(p, change, split, (q) =>
      revokeProjectRole(q.scope, actorOf(q), projectSlug, roleId),
    );
    return presentRoleBinding(binding, { id: binding.project_id, slug: projectSlug });
  }

  @Get(':project/config')
  async config(
    @CurrentPrincipal() p: Principal,
    @Param('project') slug: string,
    @Headers('accept-language') language: string | undefined,
  ): Promise<Body> {
    const view = await showProjectConfig(
      p.scope,
      actorOf(p),
      parseRequest(projectSlugSchema, slug, 'path'),
    );
    return presentConfig(view, localeOf(language));
  }

  @Put(':project/config')
  @SessionAction('actions')
  async saveConfig(
    @CurrentPrincipal() p: Principal,
    @Param('project') slug: string,
    @Body() body: unknown,
    @Headers('accept-language') language: string | undefined,
  ): Promise<Body> {
    const projectSlug = parseRequest(projectSlugSchema, slug, 'path');
    const split = this.stepUp.split(p, body);
    const input = parseRequest(saveConfigSchema, split.body, 'body');
    const change = {
      action: 'admin.project',
      decision: 'config',
      target: `${BASE}/${projectSlug}/config`,
    } as const;
    const view = await this.stepUp.run(p, change, split, (q) =>
      saveProjectConfig(q.scope, actorOf(q), projectSlug, {
        configYaml: input.config_yaml,
        expectedVersion: input.expected_version,
      }),
    );
    return presentConfig(view, localeOf(language));
  }
}
