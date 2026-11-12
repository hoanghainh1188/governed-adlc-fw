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

import { CurrentPrincipal, type Principal } from '../auth/principal.js';
import { localeOf } from '../errors/locale.js';
import { parseRequest } from '../validation.js';
import { actorOf } from './actor.js';
import { presentConfig, presentProject, presentRoleBinding } from './present.js';
import {
  createProjectSchema,
  grantRoleSchema,
  historyQuerySchema,
  idSchema,
  projectSlugSchema,
  saveConfigSchema,
  updateProjectSchema,
} from './schemas.js';

type Body = Record<string, unknown>;

@Controller('v1/admin/projects')
export class AdminProjectsController {
  @Get()
  async list(@CurrentPrincipal() p: Principal): Promise<Body> {
    const projects = await listProjects(p.scope, actorOf(p));
    return { items: projects.map(presentProject) };
  }

  @Post()
  @HttpCode(201)
  async create(@CurrentPrincipal() p: Principal, @Body() body: unknown): Promise<Body> {
    const input = parseRequest(createProjectSchema, body, 'body');
    const project = await createProject(p.scope, actorOf(p), {
      slug: input.slug,
      name: input.name,
      repoFullName: input.repo_full_name,
      ...(input.repo_path === undefined ? {} : { repoPath: input.repo_path }),
      ...(input.default_branch === undefined ? {} : { defaultBranch: input.default_branch }),
      ...(input.git_provider === undefined ? {} : { gitProvider: input.git_provider }),
    });
    return presentProject(project);
  }

  @Get(':project')
  async show(@CurrentPrincipal() p: Principal, @Param('project') slug: string): Promise<Body> {
    return presentProject(
      await showProject(p.scope, actorOf(p), parseRequest(projectSlugSchema, slug, 'path')),
    );
  }

  @Patch(':project')
  async update(
    @CurrentPrincipal() p: Principal,
    @Param('project') slug: string,
    @Body() body: unknown,
  ): Promise<Body> {
    const input = parseRequest(updateProjectSchema, body, 'body');
    const project = await updateProject(
      p.scope,
      actorOf(p),
      parseRequest(projectSlugSchema, slug, 'path'),
      {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.repo_full_name === undefined ? {} : { repoFullName: input.repo_full_name }),
        ...(input.repo_path === undefined ? {} : { repoPath: input.repo_path }),
        ...(input.default_branch === undefined ? {} : { defaultBranch: input.default_branch }),
      },
    );
    return presentProject(project);
  }

  @Post(':project/archive')
  @HttpCode(200)
  async archive(@CurrentPrincipal() p: Principal, @Param('project') slug: string): Promise<Body> {
    return presentProject(
      await archiveProject(p.scope, actorOf(p), parseRequest(projectSlugSchema, slug, 'path')),
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
  @HttpCode(201)
  async grant(
    @CurrentPrincipal() p: Principal,
    @Param('project') slug: string,
    @Body() body: unknown,
  ): Promise<Body> {
    const projectSlug = parseRequest(projectSlugSchema, slug, 'path');
    const input = parseRequest(grantRoleSchema, body, 'body');
    const binding = await grantProjectRole(p.scope, actorOf(p), projectSlug, {
      userId: input.user_id,
      role: input.role,
    });
    return presentRoleBinding(binding, { id: binding.project_id, slug: projectSlug });
  }

  @Delete(':project/roles/:id')
  async revoke(
    @CurrentPrincipal() p: Principal,
    @Param('project') slug: string,
    @Param('id') id: string,
  ): Promise<Body> {
    const projectSlug = parseRequest(projectSlugSchema, slug, 'path');
    const binding = await revokeProjectRole(
      p.scope,
      actorOf(p),
      projectSlug,
      parseRequest(idSchema, id, 'path'),
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
  async saveConfig(
    @CurrentPrincipal() p: Principal,
    @Param('project') slug: string,
    @Body() body: unknown,
    @Headers('accept-language') language: string | undefined,
  ): Promise<Body> {
    const input = parseRequest(saveConfigSchema, body, 'body');
    const view = await saveProjectConfig(
      p.scope,
      actorOf(p),
      parseRequest(projectSlugSchema, slug, 'path'),
      { configYaml: input.config_yaml, expectedVersion: input.expected_version },
    );
    return presentConfig(view, localeOf(language));
  }
}
