// `adlc client request-data-deletion|cancel-data-deletion|status` (task H03c, ADR-M97 §2.4;
// handbook Ch.19 §19.8c). Tenant admins only; through the API. Approval is an operator command.
import { t } from '@sdlc/messages';

import { clientDataDeletionSchema, type ClientDataDeletionView } from '../api/schemas.js';
import { parseCommand, withApi } from '../api/session.js';
import { EXIT, type CliContext } from '../context.js';
import { say, toJson } from '../output.js';

const LEGAL_BASIS = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

export async function runClient(args: readonly string[], ctx: CliContext): Promise<number> {
  const [command, ...rest] = args;
  if (command === 'request-data-deletion') return request(rest, ctx);
  if (command === 'cancel-data-deletion') return cancel(rest, ctx);
  if (command === 'status') return status(rest, ctx);
  return usage(ctx);
}

async function request(args: readonly string[], ctx: CliContext): Promise<number> {
  const parsed = parseCommand(args, { basis: { type: 'string' } }, 0);
  if (!parsed) return usage(ctx);
  const basis = parsed.values.basis;
  if (basis !== undefined && (typeof basis !== 'string' || !LEGAL_BASIS.test(basis))) {
    return usage(ctx);
  }
  const json = parsed.values.json === true;
  return withApi(ctx, json, async (client) => {
    const body =
      basis === undefined ? {} : { legal_basis: basis };
    const view = await client.post('/v1/client/data-deletion', clientDataDeletionSchema, body);
    print(ctx, view, json, 'cli.client.requested');
    return EXIT.ok;
  });
}

async function cancel(args: readonly string[], ctx: CliContext): Promise<number> {
  const parsed = parseCommand(args, {}, 0);
  if (!parsed) return usage(ctx);
  const json = parsed.values.json === true;
  return withApi(ctx, json, async (client) => {
    const view = await client.delete('/v1/client/data-deletion', clientDataDeletionSchema);
    print(ctx, view, json, 'cli.client.cancelled');
    return EXIT.ok;
  });
}

async function status(args: readonly string[], ctx: CliContext): Promise<number> {
  const parsed = parseCommand(args, {}, 0);
  if (!parsed) return usage(ctx);
  const json = parsed.values.json === true;
  return withApi(ctx, json, async (client) => {
    const view = await client.get('/v1/client/data-deletion', clientDataDeletionSchema);
    print(ctx, view, json, 'cli.client.status');
    return EXIT.ok;
  });
}

function print(
  ctx: CliContext,
  view: ClientDataDeletionView,
  json: boolean,
  key: 'cli.client.requested' | 'cli.client.cancelled' | 'cli.client.status',
): void {
  if (json) {
    ctx.stdout(toJson(view));
    return;
  }
  say(ctx, key, {
    tenant: view.tenant_slug,
    phase: view.phase,
    status: view.tenant_status,
    grace: view.grace_period_days === null ? '-' : String(view.grace_period_days),
  });
}

function usage(ctx: CliContext): number {
  ctx.stderr(t('cli.client.usage'));
  return EXIT.usage;
}
