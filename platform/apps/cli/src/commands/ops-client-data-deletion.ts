// `adlc ops client-data-deletion approve|list|status` (task H03c, ADR-M97 §2.4). On the server
// with SDLC_DB_URL as platform_app. Approve needs --operator (a user UUID in the tenant) who is
// not the requester (two-person rule). List has no --tenant; status and approve need one.
import { parseArgs } from 'node:util';

import {
  AdminError,
  approveDeletion,
  deletionStatus,
  listDeletionRequests,
  type ClientDeletionView,
  type PlatformDatabase,
  type TenantScope,
} from '@sdlc/core';
import { t } from '@sdlc/messages';

import { EXIT, type CliContext } from '../context.js';

type Values = Record<string, string | boolean | undefined>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const COMMON = { json: { type: 'boolean', default: false } } as const;

export type ClientDataDeletionCommand = 'approve' | 'list' | 'status';

export interface ParsedClientDataDeletion {
  readonly command: ClientDataDeletionCommand;
  readonly values: Values;
  /** `list` needs no tenant; approve and status do. */
  readonly needsTenant: boolean;
}

/** Parses `args` after `ops client-data-deletion`. Undefined: print the usage. */
export function parseClientDataDeletionCommand(
  args: readonly string[],
): ParsedClientDataDeletion | undefined {
  const [first, ...rest] = args;
  if (first === 'list') {
    try {
      const { values } = parseArgs({
        args: [...rest],
        options: COMMON,
        strict: true,
        allowPositionals: false,
      });
      return { command: 'list', values: values, needsTenant: false };
    } catch {
      return undefined;
    }
  }
  if (first === 'status') {
    try {
      const { values } = parseArgs({
        args: [...rest],
        options: { ...COMMON, tenant: { type: 'string' } },
        strict: true,
        allowPositionals: false,
      });
      const found = values as Values;
      if (typeof found.tenant !== 'string') return undefined;
      return { command: 'status', values: found, needsTenant: true };
    } catch {
      return undefined;
    }
  }
  if (first === 'approve') {
    try {
      const { values } = parseArgs({
        args: [...rest],
        options: {
          ...COMMON,
          tenant: { type: 'string' },
          operator: { type: 'string' },
        },
        strict: true,
        allowPositionals: false,
      });
      const found = values as Values;
      if (typeof found.tenant !== 'string' || typeof found.operator !== 'string') return undefined;
      if (!UUID.test(found.operator)) return undefined;
      return { command: 'approve', values: found, needsTenant: true };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export async function runClientDataDeletionCommand(
  db: PlatformDatabase,
  scope: TenantScope | undefined,
  command: ClientDataDeletionCommand,
  values: Values,
  ctx: CliContext,
): Promise<number> {
  try {
    if (command === 'list') {
      const items = await listDeletionRequests(db);
      if (values.json === true) {
        ctx.stdout(JSON.stringify(items, null, 2));
        return EXIT.ok;
      }
      if (items.length === 0) ctx.stdout(t('cli.ops.client_data.none'));
      for (const item of items) ctx.stdout(line(item));
      return EXIT.ok;
    }
    if (!scope) return usage(ctx);
    if (command === 'status') {
      const view = await deletionStatus(db, scope);
      if (values.json === true) ctx.stdout(JSON.stringify(view, null, 2));
      else ctx.stdout(line(view));
      return EXIT.ok;
    }
    const view = await approveDeletion(db, scope, String(values.operator));
    if (values.json === true) ctx.stdout(JSON.stringify(view, null, 2));
    else {
      ctx.stdout(
        t('cli.ops.client_data.approved', {
          tenant: view.tenant_slug,
          phase: view.phase,
          status: view.tenant_status,
        }),
      );
    }
    return EXIT.ok;
  } catch (error) {
    if (error instanceof AdminError) {
      ctx.stderr(t('cli.ops.refused', { code: error.code, reason: error.extra.reason ?? '-' }));
      return error.code === 'invalid_value' ? EXIT.usage : EXIT.failed;
    }
    throw error;
  }
}

function line(view: ClientDeletionView): string {
  return t('cli.ops.client_data.line', {
    tenant: view.tenant_slug,
    phase: view.phase,
    status: view.tenant_status,
    requested_by: view.requested_by ?? '-',
    operator: view.operator_id ?? '-',
    grace: view.grace_period_days === null ? '-' : String(view.grace_period_days),
  });
}

function usage(ctx: CliContext): number {
  ctx.stderr(t('cli.ops.client_data.usage'));
  return EXIT.usage;
}
