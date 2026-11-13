// X13 PR 1 on a live PostgreSQL (design/ADR-M74 §2.3, §2.4, §2.7, QUESTIONS #571, #572, #575,
// #715): approving a project's memory set by a person who did not write it, revoking a version,
// listing, the refusals and their audit events, the API's answers, and that only hashes, counts
// and versions reach the database (R030). The Git host is an in-memory fake; the GitHub adapter's
// calls are covered in `platform/tests/git-github/folder.test.ts`.
import {
  GitHostError,
  MEMORY_DIR,
  memorySetOf,
  type FolderEntry,
  type PathCommit,
  type PathCommits,
  type RepoRef,
} from '@sdlc/contracts';
import { t, type MessageKey } from '@sdlc/messages';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp, type ApiDeps } from '../../../apps/api/src/app.js';
import { issueApiToken } from '../../../packages/core/src/admin/tokens.js';
import { parseTenantId } from '../../../packages/core/src/db/tenant-id.js';
import type { TenantScope } from '../../../packages/core/src/db/tenant-scope.js';
import {
  approveMemory,
  listMemoryVersions,
  revokeMemory,
  type MemoryGitHost,
} from '../../../packages/core/src/memory/service.js';
import { memorySetSha256 } from '../../../packages/core/src/memory/set.js';
import { tokenIssuedAt } from '../token-clock.js';
import { createTestDatabase, describeDb, type TestDatabase } from './helpers.js';

const sha = (n: number) => n.toString(16).padStart(40, '0');
const blob = (c: string) => c.repeat(40);
const actor = (id: number) => ({ id: String(id), login: `u${id}`, type: 'user' as const });

/** An in-memory Git host: a head, the memory folder per commit, the commits that changed it. */
class FakeMemoryGitHost implements MemoryGitHost {
  head = sha(100);
  folders = new Map<string, FolderEntry[]>();
  history: PathCommit[] = [];
  incomplete = false;
  down = false;
  readonly calls: { stopAt?: string | undefined }[] = [];
  readonly gitHost = {
    getBranchHead: (_ref: RepoRef, branch: string) => {
      if (this.down) return Promise.reject(new GitHostError('network_error'));
      expect(branch).toBe('main');
      return Promise.resolve(this.head);
    },
    listFolder: (_ref: RepoRef, commit: string, folder: string) => {
      expect(folder).toBe(MEMORY_DIR);
      return Promise.resolve(this.folders.get(commit) ?? []);
    },
    listPathCommits: (
      _ref: RepoRef,
      head: string,
      path: string,
      options: { readonly stopAt?: string | undefined; readonly max: number },
    ): Promise<PathCommits> => {
      expect([head, path, options.max]).toEqual([this.head, MEMORY_DIR, 100]);
      this.calls.push({ stopAt: options.stopAt });
      const stop = this.history.findIndex((c) => c.sha === options.stopAt);
      const commits = stop === -1 ? this.history : this.history.slice(0, stop);
      return Promise.resolve({ commits, complete: !this.incomplete });
    },
  };

  /** A new head whose memory folder holds these files; the commit is by `author`. */
  commit(files: Record<string, string>, author: number | null): string {
    const next = sha(Number.parseInt(this.head, 16) + 1);
    this.folders.set(
      next,
      Object.entries(files).map(([name, c]) => ({ name, kind: 'file' as const, sha: blob(c) })),
    );
    this.history = [{ sha: next, author: author === null ? null : actor(author) }, ...this.history];
    this.head = next;
    return next;
  }
}

const setHash = (files: Record<string, string>) =>
  memorySetSha256(
    memorySetOf(
      Object.entries(files).map(([name, c]) => ({ name, kind: 'file' as const, sha: blob(c) })),
    ),
  );

/** GitHub account IDs of the people. */
const GH = { a: 4001, a2: 4002, b: 4003, gov: 4004, viewer: 4005 } as const;

describeDb('X13 PR 1: approving and revoking agent memory on PostgreSQL', () => {
  let db: TestDatabase;
  let scope: TenantScope;
  let other: TenantScope;
  let git: FakeMemoryGitHost;
  let app: Awaited<ReturnType<typeof createApp>>;
  const users = {} as Record<'a' | 'a2' | 'b' | 'gov' | 'viewer' | 'noid' | 'outsider', string>;
  const tokens = {} as Record<keyof typeof users, string>;
  let projectId = '';

  const approve = (who: keyof typeof users, commitSha?: string) =>
    approveMemory(scope, git, {
      projectSlug: 'shop',
      actorId: users[who],
      commitSha: commitSha ?? null,
    });
  const audit = async (actions: Parameters<TenantScope['audit']['listForEntity']>[1]) =>
    (await scope.audit.listForEntity(projectId, actions)).map((e) => [e.action, e.payload]);

  beforeAll(async () => {
    db = await createTestDatabase();
    const tenant = await db.app.system.createTenant({ slug: 'internal', name: 'Internal' });
    scope = db.app.forTenant(parseTenantId(tenant.id));
    const project = await scope.projects.create({
      slug: 'shop',
      name: 'Shop',
      git_provider: 'github',
      repo_full_name: 'acme/shop',
    });
    projectId = project.id;
    const roles = {
      a: 'person_a',
      a2: 'person_a',
      b: 'person_b',
      gov: 'governance',
      viewer: 'viewer',
      noid: 'person_b',
      outsider: null,
    } as const;
    for (const [key, role] of Object.entries(roles) as [
      keyof typeof users,
      (typeof roles)[keyof typeof users],
    ][]) {
      const user = await scope.users.create({ display_name: key, email: `${key}@example.com` });
      users[key] = user.id;
      if (role) await scope.roleBindings.grant({ user_id: user.id, project_id: project.id, role });
      if (key in GH) {
        await scope.userIdentities.link({
          user_id: user.id,
          provider: 'github',
          external_id: String(GH[key as keyof typeof GH]),
          external_login: key,
        });
      }
      tokens[key] = (
        await issueApiToken(scope, { userId: user.id, name: key, now: tokenIssuedAt() })
      ).token;
    }
    // A second tenant with a project of the same slug: its versions never count for this one.
    const second = await db.app.system.createTenant({ slug: 'other', name: 'Other' });
    other = db.app.forTenant(parseTenantId(second.id));
    await other.projects.create({
      slug: 'shop',
      name: 'Shop',
      git_provider: 'github',
      repo_full_name: 'acme/shop',
    });
    git = new FakeMemoryGitHost();
    app = await createApp({
      db: db.app as unknown as ApiDeps['db'],
      settings: { rateLimitPerMinute: 1000, authFailuresPerMinute: 1000 },
      now: () => new Date('2026-11-13T10:00:00.000Z'),
      memoryGitHost: git.gitHost,
    });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });

  beforeEach(() => {
    git.incomplete = false;
    git.down = false;
  });

  const inject = async (
    method: 'GET' | 'POST',
    url: string,
    who: keyof typeof users,
    body?: unknown,
  ) => {
    const reply = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method,
        url,
        headers: { authorization: `Bearer ${tokens[who]}` },
        ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
      });
    return {
      status: reply.statusCode,
      body: reply.json<
        Record<string, unknown> & { error?: { code: string; reason?: string; message: string } }
      >(),
    };
  };

  it('a person who did not write the memory approves it: version 1, hash only, audited', async () => {
    const files = { 'build.md': '1', 'api.md': '2' };
    git.commit(files, GH.b);
    const result = await approve('a');
    expect(result).toMatchObject({ recorded: true, files: 2, commitsWithoutAccount: 0 });
    expect(result.version).toMatchObject({
      version: 1,
      set_sha256: setHash(files),
      commit_sha: git.head,
      source: 'cli',
      approved_by: users.a,
      pr_number: null,
      revoked_at: null,
    });
    expect(git.calls.at(-1)).toEqual({ stopAt: undefined });
    expect(await audit(['memory.approved'])).toEqual([
      ['memory.approved', { version: 1, set_sha256: setHash(files), source: 'cli' }],
    ]);
  });

  it('the same set again records nothing', async () => {
    const before = git.calls.length;
    const result = await approve('b');
    expect(result).toMatchObject({ recorded: false, version: { version: 1 } });
    // Nothing to check: no commit list read, no audit event.
    expect(git.calls.length).toBe(before);
    expect(await audit(['memory.approved'])).toHaveLength(1);
  });

  it('a producer is refused (FR-11); the refusal is audited; another person approves', async () => {
    const files = { 'build.md': '3', 'api.md': '2' };
    git.commit(files, GH.a);
    await expect(approve('a')).rejects.toMatchObject({ code: 'producer' });
    await expect(approve('a2')).resolves.toMatchObject({ version: { version: 2 } });
    expect(git.calls.at(-1)).toEqual({ stopAt: sha(101) });
    expect(await audit(['memory.approval_refused'])).toEqual([
      ['memory.approval_refused', { cause: 'producer', source: 'cli' }],
    ]);
  });

  it('only commits since the last version count: the earlier producer may approve now', async () => {
    git.commit({ 'build.md': '4', 'api.md': '2' }, GH.b);
    const result = await approve('a');
    expect(result.version.version).toBe(3);
  });

  it('a commit without an account is counted and does not block', async () => {
    git.commit({ 'build.md': '5' }, null);
    const result = await approve('a');
    expect(result).toMatchObject({
      recorded: true,
      commitsWithoutAccount: 1,
      version: { version: 4 },
    });
  });

  it('refuses a viewer, a person without a role, a person without a Git host account', async () => {
    git.commit({ 'build.md': '6' }, GH.b);
    await expect(approve('viewer')).rejects.toMatchObject({ code: 'forbidden' });
    await expect(approve('gov')).rejects.toMatchObject({ code: 'forbidden' });
    await expect(approve('outsider')).rejects.toMatchObject({ code: 'project_not_found' });
    await expect(approve('noid')).rejects.toMatchObject({ code: 'no_git_identity' });
  });

  it('refuses too many commits and a commit with another set (fail closed)', async () => {
    git.incomplete = true;
    await expect(approve('a')).rejects.toMatchObject({ code: 'too_many_commits' });
    git.incomplete = false;
    await expect(approve('a', sha(101))).rejects.toMatchObject({ code: 'not_head' });
    const causes = (await audit(['memory.approval_refused'])).map(
      ([, p]) => (p as { cause: string }).cause,
    );
    expect(causes).toEqual(['producer', 'no_git_identity', 'too_many_commits']);
  });

  it('a Git host that cannot be read refuses with git_host_error', async () => {
    git.down = true;
    await expect(approve('a')).rejects.toMatchObject({ code: 'git_host_error' });
  });

  it('revoke: producers included, once, never undone; the same set needs a new version', async () => {
    const approved = await approve('a');
    expect(approved.version.version).toBe(5);
    await expect(
      revokeMemory(scope, {
        projectSlug: 'shop',
        version: 5,
        reason: 'poisoned',
        actorId: users.viewer,
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    const revoked = await revokeMemory(scope, {
      projectSlug: 'shop',
      version: 5,
      reason: 'poisoned',
      actorId: users.b,
    });
    expect(revoked.version).toMatchObject({
      version: 5,
      revoked_by: users.b,
      revocation_reason: 'poisoned',
    });
    await expect(
      revokeMemory(scope, { projectSlug: 'shop', version: 5, reason: 'wrong', actorId: users.gov }),
    ).rejects.toMatchObject({ code: 'already_revoked' });
    await expect(
      revokeMemory(scope, {
        projectSlug: 'shop',
        version: 99,
        reason: 'wrong',
        actorId: users.gov,
      }),
    ).rejects.toMatchObject({ code: 'version_not_found' });
    // The same set approved again is a new version, not the revoked one.
    const again = await approve('a2');
    expect(again).toMatchObject({
      recorded: true,
      version: { version: 6, set_sha256: approved.version.set_sha256 },
    });
    expect(again.version.commit_sha).toBe(approved.version.commit_sha);
    expect(await audit(['memory.revoked'])).toEqual([
      ['memory.revoked', { version: 5, reason: 'poisoned' }],
    ]);
    const latest = await scope.memoryVersions.findBySet(projectId, approved.version.set_sha256);
    expect(latest).toMatchObject({ version: 6, revoked_at: null });
  });

  it('versions belong to their project and tenant only', async () => {
    const theirs = (await other.projects.getBySlug('shop'))!;
    const ours = (await scope.memoryVersions.latest(projectId))!;
    expect(await other.memoryVersions.findBySet(theirs.id, ours.set_sha256)).toBeUndefined();
    expect(await other.memoryVersions.list(theirs.id)).toEqual([]);
    const listed = await listMemoryVersions(scope, { projectSlug: 'shop', actorId: users.viewer });
    expect(listed.versions.map((v) => v.version)).toEqual([6, 5, 4, 3, 2, 1]);
  });

  it('the tables are append-only and hold no memory text or path', async () => {
    await expect(
      sql`UPDATE project_memory_versions SET version = 9 WHERE project_id = ${projectId}`.execute(
        db.appRaw,
      ),
    ).rejects.toThrow();
    await expect(
      sql`DELETE FROM project_memory_revocations WHERE project_id = ${projectId}`.execute(
        db.appRaw,
      ),
    ).rejects.toThrow();
    const dump = JSON.stringify([
      (await sql`SELECT * FROM project_memory_versions`.execute(db.owner)).rows,
      (await sql`SELECT * FROM project_memory_revocations`.execute(db.owner)).rows,
      (await sql`SELECT payload FROM audit_log`.execute(db.owner)).rows,
    ]);
    expect(dump).not.toContain(MEMORY_DIR);
    expect(dump).not.toContain('build.md');
  });

  describe('API', () => {
    const PATH = '/v1/projects/shop/memory';
    const expectError = (
      reply: Awaited<ReturnType<typeof inject>>,
      status: number,
      code: string,
      reason?: string,
    ) => {
      expect(reply.status, JSON.stringify(reply.body)).toBe(status);
      expect(reply.body.error?.code).toBe(code);
      if (reason !== undefined) expect(reply.body.error?.reason).toBe(reason);
    };

    it('lists, approves and revokes', async () => {
      const list = await inject('GET', PATH, 'viewer');
      expect(list.status).toBe(200);
      expect((list.body.versions as unknown[]).length).toBe(6);
      git.commit({ 'build.md': '7' }, GH.b);
      const approved = await inject('POST', `${PATH}/approve`, 'a', {});
      expect(approved.status, JSON.stringify(approved.body)).toBe(200);
      expect(approved.body).toMatchObject({
        recorded: true,
        files: 1,
        version: { version: 7, revoked: false },
      });
      const revoked = await inject('POST', `${PATH}/versions/7/revoke`, 'gov', { reason: 'wrong' });
      expect(revoked.status).toBe(200);
      expect(revoked.body).toMatchObject({
        version: { version: 7, revoked: true, revocation_reason: 'wrong' },
      });
    });

    it('answers refusals with codes and the memory message', async () => {
      git.commit({ 'build.md': '8' }, GH.a);
      const producer = await inject('POST', `${PATH}/approve`, 'a', {});
      expectError(producer, 409, 'memory_refused', 'producer');
      expect(producer.body.error?.message).toBe(t('api.error.memory_refused'));
      expectError(await inject('POST', `${PATH}/approve`, 'viewer', {}), 403, 'forbidden');
      expectError(await inject('GET', PATH, 'outsider'), 404, 'project_not_found');
      expectError(
        await inject('POST', `${PATH}/versions/1000/revoke`, 'b', { reason: 'wrong' }),
        404,
        'memory_version_not_found',
      );
      expectError(
        await inject('POST', `${PATH}/versions/7/revoke`, 'b', { reason: 'wrong' }),
        409,
        'memory_refused',
        'already_revoked',
      );
      expectError(
        await inject('POST', `${PATH}/versions/7/revoke`, 'b', { reason: 'because' }),
        400,
        'invalid_request',
      );
      expectError(
        await inject('POST', `${PATH}/approve`, 'a2', { commit_sha: 'main' }),
        400,
        'invalid_request',
      );
      git.down = true;
      expectError(
        await inject('POST', `${PATH}/approve`, 'a2', {}),
        503,
        'git_host_unavailable',
        'network_error',
      );
    });

    it('every memory error code has a message', async () => {
      const { MEMORY_ERROR_CODES, MemoryError, memoryErrorMessage } =
        await import('../../../packages/core/src/memory/errors.js');
      for (const code of MEMORY_ERROR_CODES) {
        const text = memoryErrorMessage(new MemoryError(code, code, 'network_error'));
        expect(text, code).not.toMatch(/\{[a-z_]+\}/);
        expect(text).not.toBe(`memory.error.${code}` as MessageKey);
      }
    });
  });
});
