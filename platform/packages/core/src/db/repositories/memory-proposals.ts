import type { MemoryProposal, MemoryProposalState, TenantInsert } from '../schema.js';
import { TenantRepository } from './base.js';

/** The fields a move may set besides the state (migration 0055). */
export interface MemoryProposalMove {
  readonly prNumber?: number;
  readonly version?: number;
  readonly cause?: string;
}

/**
 * The memory branches runs pushed and what became of them (task X13 PR 3b, migration 0055,
 * ADR-M74 §2.5). Insert, read and compare-and-set moves of the state; never a delete. Every query
 * names the tenant.
 */
export class MemoryProposalRepository extends TenantRepository {
  /** Records a pushed memory branch once per run; a second call returns undefined. */
  recordPushed(
    input: Pick<
      TenantInsert<'memory_proposals'>,
      'project_id' | 'intent_id' | 'run_id' | 'head_sha'
    >,
  ): Promise<MemoryProposal | undefined> {
    return this.run(
      this.db
        .insertInto('memory_proposals')
        .values({ ...input, tenant_id: this.tenantId })
        .onConflict((oc) => oc.columns(['tenant_id', 'run_id']).doNothing())
        .returningAll()
        .executeTakeFirst(),
    );
  }

  get(id: string): Promise<MemoryProposal | undefined> {
    return this.run(
      this.db
        .selectFrom('memory_proposals')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', id)
        .executeTakeFirst(),
    );
  }

  /** The proposals of an intent, oldest first. */
  listForIntent(intentId: string): Promise<MemoryProposal[]> {
    return this.run(
      this.db
        .selectFrom('memory_proposals')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('intent_id', '=', intentId)
        .orderBy('created_at')
        .orderBy('id')
        .execute(),
    );
  }

  /**
   * Moves a proposal from `from` to `to` (compare-and-set): undefined when its state is not `from`
   * any more (another worker moved it first). `to` equal to `from` only marks it seen.
   */
  move(
    id: string,
    from: MemoryProposalState,
    to: MemoryProposalState,
    now: Date,
    fields: MemoryProposalMove = {},
  ): Promise<MemoryProposal | undefined> {
    return this.run(
      this.db
        .updateTable('memory_proposals')
        .set({
          state: to,
          updated_at: now,
          ...(fields.prNumber === undefined ? {} : { pr_number: fields.prNumber }),
          ...(fields.version === undefined ? {} : { version: fields.version }),
          ...(fields.cause === undefined ? {} : { cause: fields.cause }),
        })
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', id)
        .where('state', '=', from)
        .returningAll()
        .executeTakeFirst(),
    );
  }
}
