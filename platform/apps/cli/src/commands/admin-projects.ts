// `adlc admin project|role|config …` through the API (task B13 AC2, AC4; ADR-M37 §2.7).
import { open } from 'node:fs/promises';

import {
  adminConfigSchema,
  adminProjectListSchema,
  adminProjectSchema,
  adminRoleListSchema,
  adminRoleSchema,
  type AdminConfigView,
  type AdminProjectView,
  type AdminRoleView,
} from '../api/schemas.js';
import { CommandExit, segment } from '../api/session.js';
import { EXIT } from '../context.js';
import { clean, say, sayError, show } from '../output.js';
import {
  opt,
  output,
  resolveUser,
  str,
  type AdminApiCommand,
  type AdminCall,
} from './admin-call.js';
import { PROJECT_APPLY_COMMAND } from './admin-project-apply.js';

/** Largest configuration file read (the API refuses more than 32 KiB of YAML). */
export const MAX_CONFIG_FILE_BYTES = 32 * 1024;

const project = { project: { type: 'string' } } as const;
const all = { all: { type: 'boolean', default: false } } as const;

const projectPath = (call: AdminCall): string =>
  `/v1/admin/projects/${segment(str(call.values, 'project'))}`;

export const PROJECT_COMMANDS: Readonly<Record<string, AdminApiCommand>> = {
  'project create': {
    options: {
      slug: { type: 'string' },
      name: { type: 'string' },
      repo: { type: 'string' },
      // O06 (ADR-M106 §2.4): the project's folder in a monorepo.
      folder: { type: 'string' },
      'default-branch': { type: 'string' },
    },
    required: ['slug', 'name', 'repo'],
    run: async (call) => {
      const branch = opt(call.values, 'default-branch');
      const folder = opt(call.values, 'folder');
      const created = await call.client.post('/v1/admin/projects', adminProjectSchema, {
        slug: str(call.values, 'slug'),
        name: str(call.values, 'name'),
        repo_full_name: str(call.values, 'repo'),
        ...(folder === undefined ? {} : { repo_path: folder }),
        ...(branch === undefined ? {} : { default_branch: branch }),
      });
      return output(call, created, () => sayProject(call, created));
    },
  },
  'project list': {
    options: {},
    required: [],
    run: async (call) => {
      const list = await call.client.get('/v1/admin/projects', adminProjectListSchema);
      return output(call, list, () => {
        if (list.items.length === 0) say(call.ctx, 'cli.admin.api.none');
        for (const item of list.items) say(call.ctx, 'cli.admin.project.line', projectParams(item));
      });
    },
  },
  'project show': {
    options: project,
    required: ['project'],
    run: async (call) => {
      const found = await call.client.get(projectPath(call), adminProjectSchema);
      return output(call, found, () => sayProject(call, found));
    },
  },
  'project update': {
    options: {
      ...project,
      name: { type: 'string' },
      repo: { type: 'string' },
      folder: { type: 'string' },
      'default-branch': { type: 'string' },
    },
    required: ['project'],
    run: async (call) => {
      const changes = {
        name: opt(call.values, 'name'),
        repo_full_name: opt(call.values, 'repo'),
        repo_path: opt(call.values, 'folder'),
        default_branch: opt(call.values, 'default-branch'),
      };
      const updated = await call.client.patch(
        projectPath(call),
        adminProjectSchema,
        Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined)),
      );
      return output(call, updated, () => sayProject(call, updated));
    },
  },
  'project apply': PROJECT_APPLY_COMMAND,
  'project archive': {
    options: project,
    required: ['project'],
    run: async (call) => {
      const archived = await call.client.post(`${projectPath(call)}/archive`, adminProjectSchema);
      return output(call, archived, () => sayProject(call, archived));
    },
  },
  'role grant': {
    options: { ...project, user: { type: 'string' }, role: { type: 'string' } },
    required: ['project', 'user', 'role'],
    run: async (call) => {
      const granted = await call.client.post(`${projectPath(call)}/roles`, adminRoleSchema, {
        user_id: await resolveUser(call, str(call.values, 'user')),
        role: str(call.values, 'role'),
      });
      return output(call, granted, () =>
        say(call.ctx, 'cli.admin.role.saved', roleParams(granted)),
      );
    },
  },
  'role list': {
    options: { ...project, ...all },
    required: ['project'],
    run: async (call) => {
      const list = await call.client.get(`${projectPath(call)}/roles`, adminRoleListSchema, {
        include_revoked: call.values.all === true ? 'true' : undefined,
      });
      return output(call, list, () => {
        if (list.items.length === 0) say(call.ctx, 'cli.admin.api.none');
        for (const item of list.items) say(call.ctx, 'cli.admin.role.line', roleParams(item));
      });
    },
  },
  'role revoke': {
    options: { ...project, id: { type: 'string' } },
    required: ['project', 'id'],
    run: async (call) => {
      const revoked = await call.client.delete(
        `${projectPath(call)}/roles/${segment(str(call.values, 'id'))}`,
        adminRoleSchema,
      );
      return output(call, revoked, () =>
        say(call.ctx, 'cli.admin.role.saved', roleParams(revoked)),
      );
    },
  },
  'config show': {
    options: project,
    required: ['project'],
    run: async (call) => {
      const config = await call.client.get(`${projectPath(call)}/config`, adminConfigSchema);
      return output(call, config, () => {
        sayConfig(call, config);
        say(call.ctx, 'cli.admin.config.yaml');
        for (const line of config.config_yaml.split('\n')) call.ctx.stdout(clean(line));
      });
    },
  },
  'config set': {
    options: { ...project, file: { type: 'string' }, 'expected-version': { type: 'string' } },
    required: ['project', 'file', 'expected-version'],
    run: async (call) => {
      const version = str(call.values, 'expected-version');
      if (!/^(0|[1-9][0-9]{0,8})$/.test(version)) {
        sayError(call.ctx, 'cli.admin.api.usage');
        return EXIT.usage;
      }
      const yaml = await readConfigFile(call, str(call.values, 'file'));
      const saved = await call.client.put(`${projectPath(call)}/config`, adminConfigSchema, {
        expected_version: Number(version),
        config_yaml: yaml,
      });
      return output(call, saved, () => sayConfig(call, saved));
    },
  },
};

/** Reads a regular file of at most `MAX_CONFIG_FILE_BYTES`, as UTF-8. */
async function readConfigFile(call: AdminCall, path: string): Promise<string> {
  try {
    const handle = await open(path, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_CONFIG_FILE_BYTES) throw new Error('unreadable');
      return await handle.readFile('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    sayError(call.ctx, 'cli.admin.api.file_unreadable', { path, max: MAX_CONFIG_FILE_BYTES });
    throw new CommandExit(EXIT.usage);
  }
}

function projectParams(item: AdminProjectView): Record<string, string> {
  return {
    id: item.id,
    slug: item.slug,
    name: item.name,
    provider: item.git_provider,
    repo: item.repo_path ? `${item.repo_full_name}:${item.repo_path}` : item.repo_full_name,
    branch: item.default_branch,
    status: item.status,
  };
}

function sayProject(call: AdminCall, item: AdminProjectView): void {
  say(call.ctx, 'cli.admin.project.saved', projectParams(item));
}

function roleParams(item: AdminRoleView): Record<string, string> {
  return {
    id: item.id,
    role: item.role,
    user_id: item.user_id,
    project: item.project.slug,
    revoked: show(item.revoked_at),
  };
}

function sayConfig(call: AdminCall, config: AdminConfigView): void {
  say(call.ctx, 'cli.admin.config.detail', {
    project: config.project.slug,
    version: config.version,
    hash: config.config_hash,
    updated_by: show(config.updated_by),
    updated_at: show(config.updated_at),
  });
  for (const warning of config.warnings) {
    say(call.ctx, 'cli.admin.config.warning', { message: warning.message });
  }
}
