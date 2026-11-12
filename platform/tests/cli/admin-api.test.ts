// `adlc admin project|user|identity|role|config|tenant-admin …` over the API (B13 AC2–AC4,
// ADR-M37 §2.7) against a mocked API: the same login and client as B04, usage errors, the e-mail
// lookup, the config file, and a sweep that the token never reaches the output.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { t } from '@sdlc/messages';
import { describe, expect, it } from 'vitest';

import { EXIT } from '../../apps/cli/src/index.js';
import {
  configBody,
  identityBody,
  OTHER_USER,
  PROJECT,
  projectBody,
  roleBody,
  tenantRoleBody,
  userBody,
} from './fixtures.js';
import { apiError, TOKEN, useHarness, type Routes } from './harness.js';

const harness = useHarness();
const USERS: Routes = {
  'GET /v1/admin/users': { status: 200, body: { items: [userBody()] } },
};

describe('adlc admin (through the API)', () => {
  it('creates a project with the bearer token of the saved login', async () => {
    const h = await harness({
      routes: { 'POST /v1/admin/projects': { status: 201, body: projectBody() } },
    });
    expect(
      await h.run([
        'admin',
        'project',
        'create',
        '--slug',
        'pilot',
        '--name',
        'Pilot',
        '--repo',
        'harryforge/pilot-order-inventory',
      ]),
    ).toBe(EXIT.ok);
    expect(h.requests[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(h.requests[0]?.body).toEqual({
      slug: 'pilot',
      name: 'Pilot',
      repo_full_name: 'harryforge/pilot-order-inventory',
    });
    expect(h.out).toEqual([
      t('cli.admin.project.saved', {
        id: PROJECT.id,
        slug: 'pilot',
        name: 'Pilot',
        provider: 'github',
        repo: 'harryforge/pilot-order-inventory',
        branch: 'main',
        status: 'active',
      }),
    ]);
  });

  it('O06: creates a project on a folder of a monorepo and shows it', async () => {
    const h = await harness({
      routes: {
        'POST /v1/admin/projects': {
          status: 201,
          body: projectBody({ repo_path: 'packages/web' }),
        },
        'PATCH /v1/admin/projects/pilot': {
          status: 200,
          body: projectBody({ repo_path: 'packages/api' }),
        },
      },
    });
    expect(
      await h.run([
        'admin',
        'project',
        'create',
        '--slug',
        'pilot',
        '--name',
        'Pilot',
        '--repo',
        'harryforge/pilot-order-inventory',
        '--folder',
        'packages/web',
      ]),
    ).toBe(EXIT.ok);
    expect(h.requests[0]?.body).toMatchObject({ repo_path: 'packages/web' });
    expect(h.out[0]).toContain('harryforge/pilot-order-inventory:packages/web');
    expect(
      await h.run(['admin', 'project', 'update', '--project', 'pilot', '--folder', 'packages/api']),
    ).toBe(EXIT.ok);
    expect(h.requests[1]?.body).toEqual({ repo_path: 'packages/api' });
  });

  it('O06: shows the API refusal of an overlapping folder (exit 1)', async () => {
    const h = await harness({
      routes: {
        'POST /v1/admin/projects': apiError(409, 'repo_path_overlap'),
      },
    });
    expect(
      await h.run([
        'admin',
        'project',
        'create',
        '--slug',
        'web',
        '--name',
        'Web',
        '--repo',
        'harryforge/pilot-order-inventory',
        '--folder',
        'packages',
      ]),
    ).toBe(EXIT.failed);
    expect(h.err.join('\n')).toContain(t('api.error.repo_path_overlap'));
  });

  it('updates only the given fields and archives', async () => {
    const h = await harness({
      routes: {
        'PATCH /v1/admin/projects/pilot': { status: 200, body: projectBody({ name: 'New' }) },
        'POST /v1/admin/projects/pilot/archive': {
          status: 200,
          body: projectBody({ status: 'archived' }),
        },
      },
    });
    expect(await h.run(['admin', 'project', 'update', '--project', 'pilot', '--name', 'New'])).toBe(
      EXIT.ok,
    );
    expect(h.requests[0]?.body).toEqual({ name: 'New' });
    expect(await h.run(['admin', 'project', 'archive', '--project', 'pilot', '--json'])).toBe(
      EXIT.ok,
    );
    expect(JSON.parse(h.out[1] ?? '{}')).toMatchObject({ status: 'archived' });
  });

  it('finds a user by e-mail address in the list, never in the URL', async () => {
    const h = await harness({
      routes: {
        ...USERS,
        [`POST /v1/admin/users/${OTHER_USER}/disable`]: {
          status: 200,
          body: userBody({ status: 'disabled' }),
        },
      },
    });
    expect(await h.run(['admin', 'user', 'disable', '--user', 'BAO@example.test'])).toBe(EXIT.ok);
    expect(h.requests.map((r) => `${r.method} ${r.url.pathname}${r.url.search}`)).toEqual([
      'GET /v1/admin/users',
      `POST /v1/admin/users/${OTHER_USER}/disable`,
    ]);
    expect(h.out[0]).toContain('disabled');
  });

  it('refuses an unknown e-mail address with exit 1', async () => {
    const h = await harness({ routes: USERS });
    expect(await h.run(['admin', 'user', 'show', '--user', 'nobody@example.test'])).toBe(
      EXIT.failed,
    );
    expect(h.err).toEqual([t('cli.admin.api.user_unknown')]);
  });

  it('links a GitHub account by its numeric ID', async () => {
    const h = await harness({
      routes: {
        [`POST /v1/admin/users/${OTHER_USER}/identities`]: { status: 201, body: identityBody() },
      },
    });
    expect(
      await h.run([
        'admin',
        'identity',
        'link',
        '--user',
        OTHER_USER,
        '--github-id',
        '583231',
        '--github-login',
        'octocat',
      ]),
    ).toBe(EXIT.ok);
    expect(h.requests[0]?.body).toEqual({
      provider: 'github',
      external_id: '583231',
      external_login: 'octocat',
    });
  });

  it('grants and revokes a project role; lists with history', async () => {
    const h = await harness({
      routes: {
        ...USERS,
        'POST /v1/admin/projects/pilot/roles': { status: 201, body: roleBody() },
        'GET /v1/admin/projects/pilot/roles': { status: 200, body: { items: [roleBody()] } },
        'DELETE /v1/admin/projects/pilot/roles/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa': {
          status: 200,
          body: roleBody({ revoked_at: new Date('2026-10-03T05:00:00.000Z') }),
        },
      },
    });
    expect(
      await h.run([
        'admin',
        'role',
        'grant',
        '--project',
        'pilot',
        '--user',
        'bao@example.test',
        '--role',
        'person_b',
      ]),
    ).toBe(EXIT.ok);
    expect(h.requests[1]?.body).toEqual({ user_id: OTHER_USER, role: 'person_b' });
    expect(await h.run(['admin', 'role', 'list', '--project', 'pilot', '--all'])).toBe(EXIT.ok);
    expect(h.requests[2]?.url.searchParams.get('include_revoked')).toBe('true');
    expect(
      await h.run([
        'admin',
        'role',
        'revoke',
        '--project',
        'pilot',
        '--id',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      ]),
    ).toBe(EXIT.ok);
    expect(h.out.at(-1)).toContain('2026-10-03T05:00:00.000Z');
  });

  it('shows a refused grant with its reason (exit 1)', async () => {
    const h = await harness({
      routes: {
        'POST /v1/admin/projects/pilot/roles': apiError(409, 'conflicting_role', {
          reason: 'person_a',
          reason_message: 'person_a',
        }),
      },
    });
    expect(
      await h.run([
        'admin',
        'role',
        'grant',
        '--project',
        'pilot',
        '--user',
        OTHER_USER,
        '--role',
        'person_b',
      ]),
    ).toBe(EXIT.failed);
    expect(h.err[0]).toBe(
      t('cli.api.refused', { code: 'conflicting_role', message: t('api.error.conflicting_role') }),
    );
    expect(h.err[1]).toContain('person_a');
  });

  it('uploads a config file and prints the warnings', async () => {
    const h = await harness({
      routes: { 'PUT /v1/admin/projects/pilot/config': { status: 200, body: configBody() } },
    });
    const file = join(h.home, 'config.yaml');
    await writeFile(file, 'budget:\n  warn_percent: 70\n');
    expect(
      await h.run([
        'admin',
        'config',
        'set',
        '--project',
        'pilot',
        '--file',
        file,
        '--expected-version',
        '0',
      ]),
    ).toBe(EXIT.ok);
    expect(h.requests[0]?.body).toEqual({
      expected_version: 0,
      config_yaml: 'budget:\n  warn_percent: 70\n',
    });
    expect(h.out.some((line) => line.startsWith('  Warning: '))).toBe(true);
  });

  it('prints the rule of each refused config line', async () => {
    const h = await harness({
      routes: {
        'PUT /v1/admin/projects/pilot/config': apiError(422, 'config_rejected', {
          details: [
            {
              path: 'body.config_yaml.access.conflicting_roles',
              issue: 'config.rule.person_a_person_b_conflict',
              message: 'access.conflicting_roles: Person A and Person B must stay apart',
            },
          ],
        }),
      },
    });
    const file = join(h.home, 'config.yaml');
    await writeFile(file, 'access:\n  conflicting_roles: []\n');
    expect(
      await h.run([
        'admin',
        'config',
        'set',
        '--project',
        'pilot',
        '--file',
        file,
        '--expected-version',
        '1',
      ]),
    ).toBe(EXIT.failed);
    expect(h.err).toContain(
      t('cli.api.detail', {
        path: 'body.config_yaml.access.conflicting_roles',
        issue: 'access.conflicting_roles: Person A and Person B must stay apart',
      }),
    );
  });

  it('refuses a missing or too large config file before calling the API', async () => {
    const h = await harness();
    const big = join(h.home, 'big.yaml');
    await writeFile(big, `# ${'x'.repeat(40_000)}\n`);
    for (const file of [join(h.home, 'missing.yaml'), big, h.home]) {
      const args = ['admin', 'config', 'set', '--project', 'pilot', '--file', file];
      expect(await h.run([...args, '--expected-version', '1'])).toBe(EXIT.usage);
    }
    expect(h.requests).toEqual([]);
    expect(h.err[0]).toContain('missing.yaml');
  });

  it('shows the stored YAML, cleaned of control characters', async () => {
    const body = { ...configBody(), config_yaml: 'budget:\n  warn_percent: 70 \u001b[31m\n' };
    const h = await harness({
      routes: { 'GET /v1/admin/projects/pilot/config': { status: 200, body } },
    });
    expect(await h.run(['admin', 'config', 'show', '--project', 'pilot'])).toBe(EXIT.ok);
    expect(h.out.join('\n')).not.toContain('\u001b');
    expect(h.out).toContain('budget:');
  });

  it('grants, lists and revokes tenant admins', async () => {
    const h = await harness({
      routes: {
        'POST /v1/admin/tenant-admins': { status: 201, body: tenantRoleBody() },
        'GET /v1/admin/tenant-admins': { status: 200, body: { items: [tenantRoleBody()] } },
        'DELETE /v1/admin/tenant-admins/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb': apiError(
          409,
          'last_tenant_admin',
        ),
      },
    });
    expect(await h.run(['admin', 'tenant-admin', 'grant', '--user', OTHER_USER])).toBe(EXIT.ok);
    expect(h.requests[0]?.body).toEqual({ user_id: OTHER_USER });
    expect(await h.run(['admin', 'tenant-admin', 'list'])).toBe(EXIT.ok);
    expect(
      await h.run([
        'admin',
        'tenant-admin',
        'revoke',
        '--id',
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      ]),
    ).toBe(EXIT.failed);
    expect(h.err[0]).toContain(t('api.error.last_tenant_admin'));
  });

  it.each([
    [['admin', 'project']],
    [['admin', 'project', 'create', '--slug', 'pilot']],
    [['admin', 'role', 'grant', '--project', 'pilot', '--user', OTHER_USER]],
    [['admin', 'user', 'show', '--user', OTHER_USER, 'extra']],
    [['admin', 'config', 'set', '--project', 'p', '--file', 'f', '--expected-version', '-1']],
    [['admin', 'identity', 'link', '--user', OTHER_USER, '--token', 'x']],
  ])('prints the usage for %j (exit 2, no request)', async (argv) => {
    const h = await harness();
    expect(await h.run(argv)).toBe(EXIT.usage);
    expect(h.requests).toEqual([]);
    expect(h.err).toEqual([t('cli.admin.api.usage')]);
  });

  it('needs a login like every user command', async () => {
    const h = await harness({ loggedIn: false });
    expect(await h.run(['admin', 'project', 'list'])).toBe(EXIT.usage);
    expect(h.err).toEqual([t('cli.not_logged_in')]);
  });

  it('never prints the token', async () => {
    const h = await harness({
      routes: {
        ...USERS,
        'GET /v1/admin/projects': { status: 200, body: { items: [projectBody()] } },
        'POST /v1/admin/users': apiError(409, 'already_exists'),
      },
    });
    await h.run(['admin', 'project', 'list', '--json']);
    await h.run(['admin', 'user', 'list']);
    await h.run(['admin', 'user', 'create', '--email', 'x@example.test', '--name', 'X', '--json']);
    expect([...h.out, ...h.err].join('\n')).not.toContain(TOKEN);
  });
});
