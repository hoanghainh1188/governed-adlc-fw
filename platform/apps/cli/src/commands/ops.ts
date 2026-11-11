// `adlc ops …`: operator commands, run on the server (task B03, ADR-M26 §2.2; renamed from
// `adlc admin …` in task B13, ADR-M37 §2.8). They connect straight to the platform database as
// `platform_app` (SDLC_DB_URL) and are audited as actor `system`. People use the API instead
// (`adlc admin …`, `adlc token …`, `adlc audit verify`); these stay for the first tenant, for a
// one-admin tenant (QUESTIONS #151) and for when the API is down.
// - `adlc ops bootstrap`, `adlc ops token issue|list|revoke` (here);
// - `adlc ops audit verify` (audit-verify.ts);
// - `adlc ops tenant-admin …`, `adlc ops role …` (ops-roles.ts);
// - `adlc ops agent show|list|suspend|quarantine` (ops-agent.ts);
// - `adlc ops ai-record set|show` (ops-ai-record.ts);
// - `adlc ops run kill` (ops-run.ts, C11);
// - `adlc ops retention report` (ops-retention.ts, E05): counts only;
// - `adlc ops eval start` (ops-eval.ts, L04): queues an evaluation on the server.
// A token is printed once, to stdout, and never logged. Run these in a terminal, not in a chat.
// `--db-url-stdin` (any `ops` command, D-08 V19): the database URL from standard input instead of
// SDLC_DB_URL, so `pnpm server:setup` passes it without an environment variable or an argument.
import { parseArgs } from 'node:util';

import {
  bootstrapTenant,
  DbError,
  issueApiToken,
  parseTenantId,
  revokeApiToken,
  type ApiToken,
  type PlatformDatabase,
  type TenantScope,
} from '@sdlc/core';
import { t, type MessageKey } from '@sdlc/messages';

import { EXIT, type CliContext } from '../context.js';
import { auditVerify, parseAuditVerifyOptions } from './audit-verify.js';
import { parseAgentCommand, runAgentCommand } from './ops-agent.js';
import { parseAiRecordCommand, runAiRecordCommand } from './ops-ai-record.js';
import { parseRoleCommand, runRoleCommand } from './ops-roles.js';
import { parseRetentionCommand, runRetentionCommand } from './ops-retention.js';
import {
  parseClientDataDeletionCommand,
  runClientDataDeletionCommand,
} from './ops-client-data-deletion.js';
import { parseEvalCommand, runEvalCommand } from './ops-eval.js';
import { parseRunCommand, runRunCommand } from './ops-run.js';

type Values = Record<string, string | boolean | undefined>;

const COMMON = { json: { type: 'boolean', default: false } } as const;

const SPECS = {
  bootstrap: {
    ...COMMON,
    tenant: { type: 'string' },
    'tenant-name': { type: 'string' },
    email: { type: 'string' },
    name: { type: 'string' },
    'token-name': { type: 'string' },
    days: { type: 'string' },
  },
  'token issue': {
    ...COMMON,
    tenant: { type: 'string' },
    email: { type: 'string' },
    name: { type: 'string' },
    days: { type: 'string' },
  },
  'token list': { ...COMMON, tenant: { type: 'string' }, email: { type: 'string' } },
  'token revoke': { ...COMMON, tenant: { type: 'string' }, id: { type: 'string' } },
} as const;

const REQUIRED: Readonly<Record<keyof typeof SPECS, readonly string[]>> = {
  bootstrap: ['tenant', 'tenant-name', 'email', 'name'],
  'token issue': ['tenant', 'email', 'name'],
  'token list': ['tenant', 'email'],
  'token revoke': ['tenant', 'id'],
};

/** `args` starts after `ops`. Returns the exit code. */
export async function runOps(given: readonly string[], ctx: CliContext): Promise<number> {
  if (given.includes(DB_URL_STDIN)) {
    const url = await readDbUrl(ctx);
    if (url === undefined) {
      ctx.stderr(t('cli.ops.db_url_stdin'));
      return EXIT.usage;
    }
    // The URL stays in this process: a copy of the context, never the process environment.
    ctx = { ...ctx, env: { ...ctx.env, SDLC_DB_URL: url } };
  }
  return runOpsCommand(
    given.filter((a) => a !== DB_URL_STDIN),
    ctx,
  );
}

const DB_URL_STDIN = '--db-url-stdin';

/** The first line of standard input, when it is a PostgreSQL URL. */
async function readDbUrl(ctx: CliContext): Promise<string | undefined> {
  if (!ctx.api || ctx.api.stdinIsTTY) return undefined;
  const line = (await ctx.api.readStdin()).split(/\r?\n/, 1)[0]?.trim() ?? '';
  return /^postgres(?:ql)?:\/\/\S+$/.test(line) ? line : undefined;
}

async function runOpsCommand(args: readonly string[], ctx: CliContext): Promise<number> {
  const [first, second, ...rest] = args;
  if (first === 'audit' && second === 'verify') {
    const options = parseAuditVerifyOptions(rest);
    if (!options) return usage(ctx);
    return auditVerify(options, ctx);
  }
  if (first === 'tenant-admin' || first === 'role') {
    return runScoped(parseRoleCommand(args), runRoleCommand, 'cli.ops.usage', ctx);
  }
  if (first === 'agent') {
    return runScoped(
      parseAgentCommand(args.slice(1)),
      runAgentCommand,
      'cli.admin.agent.usage',
      ctx,
    );
  }
  if (first === 'run') {
    return runScoped(parseRunCommand(args.slice(1)), runRunCommand, 'cli.ops.run.usage', ctx);
  }
  if (first === 'eval') {
    const parsed = parseEvalCommand(args.slice(1));
    return runScoped(parsed, runEvalCommand, 'cli.ops.eval.usage', ctx);
  }
  if (first === 'retention') {
    const parsed = parseRetentionCommand(args.slice(1));
    return runScoped(parsed, runRetentionCommand, 'cli.ops.retention.usage', ctx);
  }
  if (first === 'client-data-deletion') {
    return runClientDataDeletion(args.slice(1), ctx);
  }
  if (first === 'ai-record') {
    const parsed = parseAiRecordCommand(args.slice(1));
    return runScoped(parsed, runAiRecordCommand, 'cli.admin.ai_record.usage', ctx);
  }
  const command = (first === 'token' ? `token ${second ?? ''}` : first) as keyof typeof SPECS;
  if (!Object.hasOwn(SPECS, command)) return usage(ctx);
  const values = parse(command, first === 'token' ? rest : [second, ...rest]);
  if (!values) return usage(ctx);

  const url = ctx.env.SDLC_DB_URL;
  if (!url) {
    ctx.stderr(t('cli.admin.missing_url'));
    return EXIT.usage;
  }
  const days = values.days === undefined ? undefined : Number(values.days);
  if (days !== undefined && !Number.isSafeInteger(days)) return usage(ctx);

  const db = ctx.connect({
    connectionString: url,
    maxConnections: 1,
    applicationName: 'sdlc-admin',
  });
  try {
    switch (command) {
      case 'bootstrap':
        return await bootstrap(db, values, days, ctx);
      case 'token issue':
        return await issue(db, values, days, ctx);
      case 'token list':
        return await list(db, values, ctx);
      case 'token revoke':
        return await revoke(db, values, ctx);
    }
  } catch (error) {
    if (error instanceof DbError && error.code === 'conflict') {
      ctx.stderr(t('cli.admin.conflict'));
      return EXIT.failed;
    }
    if (error instanceof DbError && error.code === 'invalid_value') {
      ctx.stderr(t('cli.admin.invalid', { reason: error.message }));
      return EXIT.usage;
    }
    throw error;
  } finally {
    await db.close();
  }
}

/**
 * `adlc ops agent|ai-record|tenant-admin|role …`: same connection and tenant lookup as the token
 * commands.
 */
async function runScoped<C extends string>(
  parsed: { command: C; values: Values } | undefined,
  run: (scope: TenantScope, command: C, values: Values, ctx: CliContext) => Promise<number>,
  usageKey: MessageKey,
  ctx: CliContext,
): Promise<number> {
  if (!parsed) {
    ctx.stderr(t(usageKey));
    return EXIT.usage;
  }
  const url = ctx.env.SDLC_DB_URL;
  if (!url) {
    ctx.stderr(t('cli.admin.missing_url'));
    return EXIT.usage;
  }
  const db = ctx.connect({
    connectionString: url,
    maxConnections: 1,
    applicationName: 'sdlc-admin',
  });
  try {
    const scope = await tenantScope(db, String(parsed.values.tenant), ctx);
    if (!scope) return EXIT.usage;
    return await run(scope, parsed.command, parsed.values, ctx);
  } finally {
    await db.close();
  }
}

function parse(
  command: keyof typeof SPECS,
  args: readonly (string | undefined)[],
): Values | undefined {
  try {
    const { values } = parseArgs({
      args: args.filter((a): a is string => a !== undefined),
      options: SPECS[command],
      strict: true,
      allowPositionals: false,
    });
    const found = values as Values;
    return REQUIRED[command].every((key) => typeof found[key] === 'string') ? found : undefined;
  } catch {
    return undefined;
  }
}

function usage(ctx: CliContext): number {
  ctx.stderr(t('cli.ops.usage'));
  return EXIT.usage;
}

const str = (values: Values, key: string): string => String(values[key]);

async function bootstrap(
  db: PlatformDatabase,
  values: Values,
  days: number | undefined,
  ctx: CliContext,
): Promise<number> {
  const result = await bootstrapTenant(db, {
    tenantSlug: str(values, 'tenant'),
    tenantName: str(values, 'tenant-name'),
    adminEmail: str(values, 'email'),
    adminName: str(values, 'name'),
    ...(values['token-name'] === undefined ? {} : { tokenName: str(values, 'token-name') }),
    ...(days === undefined ? {} : { lifetimeDays: days }),
  });
  printToken(ctx, values.json === true, {
    tenant: result.tenant.slug,
    tenant_id: result.tenant.id,
    user_id: result.user.id,
    record: result.token.record,
    token: result.token.token,
  });
  return EXIT.ok;
}

async function issue(
  db: PlatformDatabase,
  values: Values,
  days: number | undefined,
  ctx: CliContext,
): Promise<number> {
  const found = await tenantUser(db, values, ctx);
  if (!found) return EXIT.usage;
  const issued = await issueApiToken(found.scope, {
    userId: found.userId,
    name: str(values, 'name'),
    ...(days === undefined ? {} : { lifetimeDays: days }),
  });
  printToken(ctx, values.json === true, {
    tenant: str(values, 'tenant'),
    tenant_id: found.scope.tenantId,
    user_id: found.userId,
    record: issued.record,
    token: issued.token,
  });
  return EXIT.ok;
}

async function list(db: PlatformDatabase, values: Values, ctx: CliContext): Promise<number> {
  const found = await tenantUser(db, values, ctx);
  if (!found) return EXIT.usage;
  const tokens = (await found.scope.apiTokens.listForUser(found.userId)).map(describe);
  if (values.json === true) {
    ctx.stdout(JSON.stringify(tokens, null, 2));
    return EXIT.ok;
  }
  if (tokens.length === 0) ctx.stdout(t('cli.admin.token.none'));
  for (const token of tokens) ctx.stdout(t('cli.admin.token.line', { ...token }));
  return EXIT.ok;
}

async function revoke(db: PlatformDatabase, values: Values, ctx: CliContext): Promise<number> {
  const scope = await tenantScope(db, str(values, 'tenant'), ctx);
  if (!scope) return EXIT.usage;
  const revoked = await revokeApiToken(scope, str(values, 'id'));
  if (!revoked) {
    ctx.stderr(t('cli.admin.token.not_found', { id: str(values, 'id') }));
    return EXIT.failed;
  }
  ctx.stdout(
    values.json === true
      ? JSON.stringify(describe(revoked))
      : t('cli.admin.token.revoked', { id: revoked.id }),
  );
  return EXIT.ok;
}

/** `adlc ops client-data-deletion …` (H03c): list needs no tenant; approve/status do. */
async function runClientDataDeletion(args: readonly string[], ctx: CliContext): Promise<number> {
  const parsed = parseClientDataDeletionCommand(args);
  if (!parsed) {
    ctx.stderr(t('cli.ops.client_data.usage'));
    return EXIT.usage;
  }
  const url = ctx.env.SDLC_DB_URL;
  if (!url) {
    ctx.stderr(t('cli.admin.missing_url'));
    return EXIT.usage;
  }
  const db = ctx.connect({
    connectionString: url,
    maxConnections: 1,
    applicationName: 'sdlc-admin',
  });
  try {
    let scope: TenantScope | undefined;
    if (parsed.needsTenant) {
      scope = await tenantScope(db, String(parsed.values.tenant), ctx);
      if (!scope) return EXIT.usage;
    }
    return await runClientDataDeletionCommand(db, scope, parsed.command, parsed.values, ctx);
  } finally {
    await db.close();
  }
}

async function tenantScope(
  db: PlatformDatabase,
  slug: string,
  ctx: CliContext,
): Promise<TenantScope | undefined> {
  const tenant = await db.system.getTenantBySlug(slug);
  if (!tenant) {
    ctx.stderr(t('cli.admin.tenant_not_found', { slug }));
    return undefined;
  }
  return db.forTenant(parseTenantId(tenant.id));
}

async function tenantUser(
  db: PlatformDatabase,
  values: Values,
  ctx: CliContext,
): Promise<{ scope: TenantScope; userId: string } | undefined> {
  const scope = await tenantScope(db, str(values, 'tenant'), ctx);
  if (!scope) return undefined;
  const user = await scope.users.getByEmail(str(values, 'email'));
  if (!user) {
    ctx.stderr(t('cli.admin.user_not_found'));
    return undefined;
  }
  return { scope, userId: user.id };
}

function describe(token: ApiToken): Record<string, string> {
  return {
    id: token.id,
    name: token.name,
    expires_at: token.expires_at.toISOString(),
    revoked_at: token.revoked_at?.toISOString() ?? '-',
    last_used_at: token.last_used_at?.toISOString() ?? '-',
  };
}

interface PrintedToken {
  readonly tenant: string;
  readonly tenant_id: string;
  readonly user_id: string;
  readonly record: ApiToken;
  readonly token: string;
}

function printToken(ctx: CliContext, json: boolean, printed: PrintedToken): void {
  const summary = {
    tenant: printed.tenant,
    tenant_id: printed.tenant_id,
    user_id: printed.user_id,
    token_id: printed.record.id,
    expires_at: printed.record.expires_at.toISOString(),
  };
  if (json) {
    ctx.stdout(JSON.stringify({ ...summary, token: printed.token }, null, 2));
    return;
  }
  ctx.stdout(t('cli.admin.token.issued', summary));
  ctx.stdout(printed.token);
  ctx.stdout(t('cli.admin.token.shown_once'));
}
