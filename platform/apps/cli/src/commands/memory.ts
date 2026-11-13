// `adlc memory list|approve|revoke` over the API (task X13 PR 1, ADR-M74 §2.3, §2.7). Memory is
// Markdown in `.sdlc/memory/` of the project's repository; the platform keeps only which sets a
// person approved or revoked. Approve: Person A or Person B who did not write the change; the set
// is the one at the head of the default branch. Revoke: at once, never undone.
import { MEMORY_REVOCATION_REASONS } from '@sdlc/contracts';
import { t } from '@sdlc/messages';

import {
  memoryApproveSchema,
  memoryListSchema,
  memoryRevokeSchema,
  type MemoryVersionView,
} from '../api/schemas.js';
import { parseCommand, segment, withApi } from '../api/session.js';
import { EXIT, type CliContext } from '../context.js';
import { say, show, toJson } from '../output.js';

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const VERSION = /^[1-9][0-9]{0,6}$/;

export async function runMemory(args: readonly string[], ctx: CliContext): Promise<number> {
  const [command, project, ...rest] = args;
  if (project === undefined || !SLUG.test(project)) return usage(ctx);
  const path = `/v1/projects/${segment(project)}/memory`;
  if (command === 'list') return list(rest, path, ctx);
  if (command === 'approve') return approve(rest, path, ctx);
  if (command === 'revoke') return revoke(rest, path, ctx);
  return usage(ctx);
}

async function list(rest: readonly string[], path: string, ctx: CliContext): Promise<number> {
  const parsed = parseCommand(rest, {});
  if (!parsed || parsed.positionals.length > 0) return usage(ctx);
  const json = parsed.values.json === true;
  return withApi(ctx, json, async (client) => {
    const view = await client.get(path, memoryListSchema);
    if (json) {
      ctx.stdout(toJson(view));
      return EXIT.ok;
    }
    if (view.versions.length === 0) {
      say(ctx, 'cli.memory.none', { project: view.project.slug });
      return EXIT.ok;
    }
    say(ctx, 'cli.memory.list_header', { project: view.project.slug });
    for (const version of view.versions) ctx.stdout(line(version));
    return EXIT.ok;
  });
}

async function approve(rest: readonly string[], path: string, ctx: CliContext): Promise<number> {
  const parsed = parseCommand(rest, { commit: { type: 'string' } });
  const commit = parsed?.values.commit;
  if (!parsed || parsed.positionals.length > 0) return usage(ctx);
  if (commit !== undefined && (typeof commit !== 'string' || !COMMIT.test(commit))) {
    return usage(ctx);
  }
  const json = parsed.values.json === true;
  return withApi(ctx, json, async (client) => {
    const view = await client.post(
      `${path}/approve`,
      memoryApproveSchema,
      typeof commit === 'string' ? { commit_sha: commit } : {},
    );
    if (json) {
      ctx.stdout(toJson(view));
      return EXIT.ok;
    }
    say(ctx, view.recorded ? 'cli.memory.approved' : 'cli.memory.unchanged', {
      project: view.project.slug,
      version: view.version.version,
      files: view.files,
      set_sha256: view.version.set_sha256,
      commit: view.version.commit_sha,
    });
    if (view.commits_without_account > 0) {
      say(ctx, 'cli.memory.commits_without_account', { count: view.commits_without_account });
    }
    return EXIT.ok;
  });
}

async function revoke(rest: readonly string[], path: string, ctx: CliContext): Promise<number> {
  const parsed = parseCommand(rest, { reason: { type: 'string' } }, 1);
  const [version, ...extra] = parsed?.positionals ?? [];
  const reason = parsed?.values.reason;
  if (
    !parsed ||
    extra.length > 0 ||
    version === undefined ||
    !VERSION.test(version) ||
    typeof reason !== 'string' ||
    !(MEMORY_REVOCATION_REASONS as readonly string[]).includes(reason)
  ) {
    return usage(ctx);
  }
  const json = parsed.values.json === true;
  return withApi(ctx, json, async (client) => {
    const view = await client.post(`${path}/versions/${version}/revoke`, memoryRevokeSchema, {
      reason,
    });
    if (json) ctx.stdout(toJson(view));
    else {
      say(ctx, 'cli.memory.revoked', {
        project: view.project.slug,
        version: view.version.version,
        reason: show(view.version.revocation_reason),
      });
    }
    return EXIT.ok;
  });
}

function line(version: MemoryVersionView): string {
  return t(version.revoked ? 'cli.memory.line_revoked' : 'cli.memory.line', {
    version: version.version,
    reason: show(version.revocation_reason),
    source: version.source,
    set_sha256: version.set_sha256,
    commit: version.commit_sha,
    pr: show(version.pr_number),
    created_at: version.created_at,
  });
}

function usage(ctx: CliContext): number {
  ctx.stderr(t('cli.memory.usage'));
  return EXIT.usage;
}
