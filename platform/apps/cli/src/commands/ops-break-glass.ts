// `adlc ops break-glass list|revoke`: break-glass on the server (task H08 PR 3a, ADR-M111 §2.9,
// QUESTIONS #742). An operator command with SDLC_DB_URL (`platform_app`), audited as actor
// `system`, for when the API is down: it lists the grants and revokes one at once (containment,
// like `adlc ops run kill`). It never requests or approves: those need two people (rule M21), so
// they go through the API with personal tokens (`adlc break-glass`).
import { parseArgs } from 'node:util';

import {
  BreakGlassError,
  listBreakGlass,
  revokeBreakGlass,
  type BreakGlassErrorCode,
  type BreakGlassListed,
  type TenantScope,
} from '@sdlc/core';
import { t, type MessageKey } from '@sdlc/messages';

import { EXIT, type CliContext } from '../context.js';

type Values = Record<string, string | boolean | undefined>;
type Command = 'list' | 'revoke';

const SPECS = {
  list: {
    tenant: { type: 'string' },
    project: { type: 'string' },
    open: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
  },
  revoke: {
    tenant: { type: 'string' },
    intent: { type: 'string' },
    json: { type: 'boolean', default: false },
  },
} as const;

const INTENT = /^INT-\d{4}-\d{4,9}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** The refusals an operator can meet; the others never happen without a person. */
const ERROR_KEYS: Partial<Record<BreakGlassErrorCode, MessageKey>> = {
  intent_not_found: 'cli.ops.break_glass.error.intent_not_found',
  project_not_found: 'cli.ops.break_glass.error.project_not_found',
  no_grant: 'cli.ops.break_glass.error.no_grant',
};

/** Parses `args` (after `ops break-glass`). Undefined: print the usage. */
export function parseBreakGlassCommand(
  args: readonly string[],
): { command: Command; values: Values } | undefined {
  const [first, ...rest] = args;
  if (first !== 'list' && first !== 'revoke') return undefined;
  try {
    const { values } = parseArgs({
      args: [...rest],
      options: SPECS[first],
      strict: true,
      allowPositionals: false,
    });
    const found = values as Values;
    if (typeof found.tenant !== 'string') return undefined;
    if (first === 'revoke') {
      const intent = typeof found.intent === 'string' ? found.intent.toUpperCase() : '';
      if (!INTENT.test(intent)) return undefined;
      return { command: first, values: { ...found, intent } };
    }
    if (found.project !== undefined && !SLUG.test(String(found.project))) return undefined;
    return { command: first, values: found };
  } catch {
    return undefined;
  }
}

export async function runBreakGlassCommand(
  scope: TenantScope,
  command: Command,
  values: Values,
  ctx: CliContext,
): Promise<number> {
  try {
    if (command === 'revoke') {
      const { intent, grant } = await revokeBreakGlass(scope, {
        intentRef: String(values.intent),
        actor: { type: 'system' },
        now: new Date(),
      });
      const view = { intent: intent.code, grant: grant.id, status: grant.status };
      if (values.json === true) ctx.stdout(JSON.stringify(view));
      else ctx.stdout(t('cli.ops.break_glass.revoked', view));
      return EXIT.ok;
    }
    const rows = await listBreakGlass(scope, {
      actorId: null,
      ...(typeof values.project === 'string' ? { projectSlug: values.project } : {}),
      open: values.open === true,
    });
    if (values.json === true) {
      ctx.stdout(JSON.stringify({ items: rows.map(line) }));
    } else if (rows.length === 0) {
      ctx.stdout(t('cli.ops.break_glass.none'));
    } else {
      ctx.stdout(t('cli.ops.break_glass.list_header'));
      for (const row of rows) ctx.stdout(t('cli.ops.break_glass.line', line(row)));
    }
    return EXIT.ok;
  } catch (error) {
    if (!(error instanceof BreakGlassError)) throw error;
    ctx.stderr(
      t(ERROR_KEYS[error.code] ?? 'cli.ops.break_glass.error.refused', { code: error.code }),
    );
    return EXIT.failed;
  }
}

/** Codes, IDs and times only: no link, so the operator's terminal holds no comment address. */
function line(row: BreakGlassListed) {
  return {
    grant: row.grant.id,
    intent: row.intent?.code ?? '-',
    project: row.project?.slug ?? '-',
    status: row.grant.status,
    scopes: row.grant.scopes.join(','),
    incident: row.escalation?.code ?? '-',
    expires: row.grant.expires_at?.toISOString() ?? '-',
    reviewed: row.grant.review_url === null ? 'no' : 'yes',
  };
}
