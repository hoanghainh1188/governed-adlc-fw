// Intents (design/D-05 section 6.2, D-02 FR-01 and FR-03, D-08 B02 AC1 and AC2).
import type { ActorType, DataClass, GateCode, IntentStatus, RiskTier } from '@sdlc/contracts';
import { INTENT_STATUSES, GATE_CODES } from '@sdlc/contracts';
import { sql, type Kysely } from 'kysely';

import { fromMicros, isUsd, toMicros } from '../../cost/money.js';
import { clock, loadEffectiveConfig, type RegistryDeps } from '../../registry/effective-config.js';
import { RegistryError } from '../../registry/errors.js';
import { formatIntentCode, intentCodeYear } from '../../registry/intent-code.js';
import { DbError } from '../errors.js';
import type { Database, Intent } from '../schema.js';
import { isUuid } from '../tenant-id.js';
import { AuditLogRepository } from './audit-log.js';
import { TenantRepository } from './base.js';
import { lockIntent, lockIntentCodes } from './locks.js';
import { ProjectConfigRepository } from './project-configs.js';

export interface NewIntent {
  readonly projectId: string;
  readonly title: string;
  readonly description?: string;
  /** The intent owner (Person A), who approves G1 (design/QUESTIONS.md #16). */
  readonly createdBy: string;
  readonly riskTier: RiskTier;
  readonly dataClass: DataClass;
  /** USD, as a decimal string (D-05 D6). Default: `budget.default_intent_usd` from the config. */
  readonly budgetUsd?: string;
  readonly issueNumber?: number | null;
}

export interface IntentStateChange {
  readonly status: IntentStatus;
  readonly currentGate: GateCode | null;
  readonly actorType: Exclude<ActorType, 'agent'>;
  /** Required for `human`; null for `system`. */
  readonly actorId: string | null;
}

/** A move of the intent workflow (B07): applied only when the intent is still in `from`. */
export interface IntentMove {
  readonly from: { readonly status: IntentStatus; readonly currentGate: GateCode | null };
  readonly to: { readonly status: IntentStatus; readonly currentGate: GateCode | null };
  /** When the move enters `to.currentGate` (null when it leaves the gates). */
  readonly at: Date;
}

export interface IntentQuery {
  readonly status?: IntentStatus;
}

/** Keyset position: the last intent of the previous page (task B03). */
export interface IntentPosition {
  readonly createdAt: Date;
  readonly id: string;
}

export interface IntentPageQuery {
  /** Projects to include. An empty list gives an empty page. */
  readonly projectIds: readonly string[];
  readonly status?: IntentStatus;
  /** 1 to `MAX_INTENT_PAGE`. */
  readonly limit: number;
  readonly after?: IntentPosition;
  /** X08a (ADR-M109 §2.1): the filters of `GET /v1/intents`. Dates are UTC days, both included. */
  readonly filters?: IntentFilters;
}

export interface IntentFilters {
  /** Open intents whose current gate is this gate. */
  readonly gate?: GateCode;
  readonly riskTier?: RiskTier;
  readonly createdFrom?: string;
  readonly createdTo?: string;
  readonly closedFrom?: string;
  readonly closedTo?: string;
  /** Has a sealed Evidence Pack (G8 passed), or has none. */
  readonly sealed?: boolean;
  /** X08b (QUESTIONS #730): has at least one lesson, whatever its state, or has none. */
  readonly hasLessons?: boolean;
  /** A search text (2–200 characters): an intent code, `#<number>` or words. Client data. */
  readonly q?: string;
}

/** How a search text is read (ADR-M109 §2.1): an intent code, an issue or PR number, or words. */
export type IntentSearch =
  | { readonly kind: 'code'; readonly code: string }
  | { readonly kind: 'number'; readonly number: number }
  | { readonly kind: 'words'; readonly text: string };

const CODE_SEARCH = /^INT-\d{4}-\d{4,9}$/i;
const NUMBER_SEARCH = /^#(\d{1,9})$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const FINISHED = ['done', 'rejected', 'cancelled', 'blocked'] as const;

export function parseIntentSearch(q: string): IntentSearch {
  const text = q.trim();
  if (CODE_SEARCH.test(text)) return { kind: 'code', code: text.toUpperCase() };
  const number = NUMBER_SEARCH.exec(text);
  if (number) return { kind: 'number', number: Number(number[1]) };
  return { kind: 'words', text };
}

/** The start of a UTC day, or of the next day (`end`), for the inclusive date filters. */
function dayBound(day: string, end: boolean): Date {
  if (!DAY.test(day)) throw new DbError('invalid_value', 'a date filter must be YYYY-MM-DD');
  const at = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(at.getTime()) || at.toISOString().slice(0, 10) !== day) {
    throw new DbError('invalid_value', 'a date filter must be a real day');
  }
  return end ? new Date(at.getTime() + 86_400_000) : at;
}

export const MAX_INTENT_PAGE = 100;

const MONEY = /^\d{1,12}(\.\d{1,6})?$/;

/** Lowest and highest human-effort estimate in hours (migration 0050's CHECK, V14). */
export const MIN_EFFORT_HOURS = 0.25;
export const MAX_EFFORT_HOURS = 10_000;
const EFFORT_HOURS = /^(0|[1-9][0-9]{0,4})(\.[0-9]{1,2})?$/;

/** True for a decimal string of hours from 0.25 to 10000 with at most two decimals (V14). */
export function isEffortHours(value: unknown): value is string {
  if (typeof value !== 'string' || !EFFORT_HOURS.test(value)) return false;
  const micros = toMicros(value);
  return micros >= 250_000n && micros <= 10_000_000_000n;
}

/** The format of a waiting reason or cause (migration 0025's CHECK). */
const WAITING_CODE = /^[a-z][a-z0-9_]{0,63}$/;

export class IntentRepository extends TenantRepository {
  /**
   * Creates an intent in status `draft` with the next code of the tenant for the current UTC year.
   * `max_autonomy` comes from the policy engine of the project configuration (FR-03). In the same
   * transaction, appends `intent.created` (never the title or description).
   */
  async create(input: NewIntent, deps: RegistryDeps): Promise<Intent> {
    const budget = input.budgetUsd;
    if (budget !== undefined && !MONEY.test(budget)) {
      throw new DbError('invalid_value', 'budgetUsd must be a non-negative decimal string');
    }
    const year = intentCodeYear(clock(deps));
    return this.run(
      this.transactional(async (db) => {
        const project = await db
          .selectFrom('projects')
          .select(['id', 'status'])
          .where('tenant_id', '=', this.tenantId)
          .where('id', '=', input.projectId)
          .executeTakeFirst();
        if (project?.status !== 'active') {
          throw new RegistryError('project_not_active', `project ${input.projectId} is not active`);
        }
        const { config } = await loadEffectiveConfig(
          new ProjectConfigRepository(db, this.tenantId),
          input.projectId,
        );
        const policy = deps.policyFactory(config);
        const maxAutonomy = policy.maxAutonomy({
          riskTier: input.riskTier,
          dataClass: input.dataClass,
        });

        await lockIntentCodes(db, this.tenantId);
        const code = formatIntentCode(year, (await this.lastNumber(db, year)) + 1);
        const intent = await db
          .insertInto('intents')
          .values({
            tenant_id: this.tenantId,
            code,
            project_id: input.projectId,
            title: input.title,
            description: input.description ?? '',
            created_by: input.createdBy,
            risk_tier: input.riskTier,
            data_class: input.dataClass,
            max_autonomy: maxAutonomy,
            budget_usd: budget ?? String(config.budget.default_intent_usd),
            issue_number: input.issueNumber ?? null,
          })
          .returningAll()
          .executeTakeFirstOrThrow()
          .catch((error: unknown) => {
            // One open intent per issue (QUESTIONS #68): a comment always names exactly one.
            if (
              (error as { constraint?: unknown } | null)?.constraint === 'intents_open_issue_key'
            ) {
              throw new RegistryError(
                'issue_already_linked',
                `another open intent is linked to issue ${String(input.issueNumber)}`,
              );
            }
            throw error;
          });
        await new AuditLogRepository(db, this.tenantId).append({
          action: 'intent.created',
          actorType: 'human',
          actorId: intent.created_by,
          entityId: intent.id,
          payload: {
            code: intent.code,
            project_id: intent.project_id,
            risk_tier: intent.risk_tier,
            data_class: intent.data_class,
            max_autonomy: intent.max_autonomy,
          },
        });
        return intent;
      }),
    );
  }

  getById(id: string): Promise<Intent | undefined> {
    if (!isUuid(id)) return Promise.resolve(undefined);
    return this.run(
      this.db
        .selectFrom('intents')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', id)
        .executeTakeFirst(),
    );
  }

  getByCode(code: string): Promise<Intent | undefined> {
    return this.run(
      this.db
        .selectFrom('intents')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('code', '=', code)
        .executeTakeFirst(),
    );
  }

  /**
   * Open intents of a project linked to an issue or a pull request (task B06: a comment command
   * on GitHub → its intent). An open intent is one not `done`, `rejected`, `cancelled` or
   * `blocked` (C06: a blocked intent is finished, migration 0011). Returns
   * at most two rows: two mean the link is ambiguous (design/QUESTIONS.md #68).
   */
  findOpenByGitNumber(
    projectId: string,
    link: { readonly kind: 'issue' | 'pull_request'; readonly number: number },
  ): Promise<Intent[]> {
    const column = link.kind === 'issue' ? 'issue_number' : 'pr_number';
    return this.run(
      this.db
        .selectFrom('intents')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('project_id', '=', projectId)
        .where(column, '=', link.number)
        .where('status', 'not in', ['done', 'rejected', 'cancelled', 'blocked'])
        .orderBy('created_at')
        .limit(2)
        .execute(),
    );
  }

  /**
   * X08b (ADR-M109 §2.3, ADR-M27 1.x): every intent of a project linked to an issue or a pull
   * request, open or finished, newest first, at most five. A `/lesson` comment may match a
   * finished intent whose lesson window is open; gate commands keep `findOpenByGitNumber`.
   */
  findByGitNumber(
    projectId: string,
    link: { readonly kind: 'issue' | 'pull_request'; readonly number: number },
  ): Promise<Intent[]> {
    const column = link.kind === 'issue' ? 'issue_number' : 'pr_number';
    return this.run(
      this.db
        .selectFrom('intents')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('project_id', '=', projectId)
        .where(column, '=', link.number)
        .orderBy('created_at', 'desc')
        .limit(5)
        .execute(),
    );
  }

  /** Whether the project has an intent that is not finished (E05: an archive refuses it). */
  async hasOpenInProject(projectId: string): Promise<boolean> {
    if (!isUuid(projectId)) return false;
    const row = await this.run(
      this.db
        .selectFrom('intents')
        .select('id')
        .where('tenant_id', '=', this.tenantId)
        .where('project_id', '=', projectId)
        .where('status', 'not in', ['done', 'rejected', 'cancelled', 'blocked'])
        .limit(1)
        .executeTakeFirst(),
    );
    return row !== undefined;
  }

  listForProject(projectId: string, query: IntentQuery = {}): Promise<Intent[]> {
    return this.run(
      this.db
        .selectFrom('intents')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('project_id', '=', projectId)
        .$if(query.status !== undefined, (qb) => qb.where('status', '=', query.status!))
        .orderBy('code')
        .execute(),
    );
  }

  /**
   * One page of intents of the given projects, newest first, by (`created_at`, `id`). Returns at
   * most `limit` rows; callers ask for one more to know whether a next page exists.
   */
  page(query: IntentPageQuery): Promise<Intent[]> {
    if (
      !Number.isSafeInteger(query.limit) ||
      query.limit < 1 ||
      query.limit > MAX_INTENT_PAGE + 1
    ) {
      throw new DbError('invalid_value', `limit must be 1 to ${String(MAX_INTENT_PAGE)}`);
    }
    if (query.projectIds.length === 0) return Promise.resolve([]);
    const after = query.after;
    const f = query.filters ?? {};
    const search = f.q === undefined ? undefined : parseIntentSearch(f.q);
    const bound = (day: string | undefined, end: boolean) =>
      day === undefined ? undefined : dayBound(day, end);
    const createdFrom = bound(f.createdFrom, false);
    const createdTo = bound(f.createdTo, true);
    const closedFrom = bound(f.closedFrom, false);
    const closedTo = bound(f.closedTo, true);
    const tenantId = this.tenantId;
    return this.run(
      this.db
        .selectFrom('intents')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('project_id', 'in', [...query.projectIds])
        .$if(query.status !== undefined, (qb) => qb.where('status', '=', query.status!))
        .$if(f.gate !== undefined, (qb) =>
          qb.where('current_gate', '=', f.gate!).where('status', 'not in', [...FINISHED]),
        )
        .$if(f.riskTier !== undefined, (qb) => qb.where('risk_tier', '=', f.riskTier!))
        .$if(createdFrom !== undefined, (qb) => qb.where('created_at', '>=', createdFrom!))
        .$if(createdTo !== undefined, (qb) => qb.where('created_at', '<', createdTo!))
        .$if(closedFrom !== undefined, (qb) => qb.where('closed_at', '>=', closedFrom!))
        .$if(closedTo !== undefined, (qb) => qb.where('closed_at', '<', closedTo!))
        .$if(f.sealed !== undefined, (qb) =>
          qb.where((eb) => {
            const packs = eb
              .selectFrom('evidence_packs as ep')
              .select('ep.id')
              .where('ep.tenant_id', '=', tenantId)
              .whereRef('ep.intent_id', '=', 'intents.id')
              .where('ep.sealed_at', 'is not', null);
            return f.sealed ? eb.exists(packs) : eb.not(eb.exists(packs));
          }),
        )
        .$if(f.hasLessons !== undefined, (qb) =>
          qb.where((eb) => {
            const lessons = eb
              .selectFrom('intent_lessons as il')
              .select('il.id')
              .where('il.tenant_id', '=', tenantId)
              .whereRef('il.intent_id', '=', 'intents.id');
            return f.hasLessons ? eb.exists(lessons) : eb.not(eb.exists(lessons));
          }),
        )
        .$if(search?.kind === 'code', (qb) =>
          qb.where('code', '=', (search as { code: string }).code),
        )
        .$if(search?.kind === 'number', (qb) =>
          qb.where((eb) =>
            eb.or([
              eb('issue_number', '=', (search as { number: number }).number),
              eb('pr_number', '=', (search as { number: number }).number),
            ]),
          ),
        )
        .$if(search?.kind === 'words', (qb) =>
          // A bound parameter, never a string in the SQL text (ADR-M109 §2.1).
          qb.where(
            sql<boolean>`search_tsv @@ websearch_to_tsquery('simple', ${(search as { text: string }).text})`,
          ),
        )
        .$if(after !== undefined, (qb) =>
          qb.where((eb) =>
            eb.or([
              eb('created_at', '<', after!.createdAt),
              eb.and([eb('created_at', '=', after!.createdAt), eb('id', '<', after!.id)]),
            ]),
          ),
        )
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(query.limit)
        .execute(),
    );
  }

  /**
   * Moves the intent to a status and gate. Which moves are allowed belongs to the workflow (B07).
   * In the same transaction, appends `intent.state_changed`.
   */
  async updateState(id: string, change: IntentStateChange): Promise<Intent> {
    // Checked at runtime too: the type can be bypassed with a cast (D-02 FR-11).
    if ((change.actorType as string) === 'agent') {
      throw new DbError('invalid_value', 'agents never change the state of an intent');
    }
    if (!INTENT_STATUSES.includes(change.status)) {
      throw new DbError('invalid_value', 'unknown status');
    }
    if (change.currentGate !== null && !GATE_CODES.includes(change.currentGate)) {
      throw new DbError('invalid_value', 'unknown gate');
    }
    return this.run(
      this.transactional(async (db) => {
        const intent = await db
          .updateTable('intents')
          .set({
            status: change.status,
            current_gate: change.currentGate,
            // U02 (ADR-M54 §2.4b): a move ends any wait; the next step records the new one.
            waiting_reason: null,
            waiting_cause: null,
            waiting_since: null,
            waiting_until: null,
            updated_at: sql<Date>`now()`,
          })
          .where('tenant_id', '=', this.tenantId)
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirst();
        if (!intent) throw new RegistryError('intent_not_found', `intent ${id} not found`);
        await new AuditLogRepository(db, this.tenantId).append({
          action: 'intent.state_changed',
          actorType: change.actorType,
          actorId: change.actorId,
          entityId: intent.id,
          payload: {
            status: intent.status,
            ...(intent.current_gate === null ? {} : { current_gate: intent.current_gate }),
          },
        });
        return intent;
      }),
    );
  }

  /** Holds the intent lock until the transaction ends, then reads the intent (B07 workflow step). */
  async lockAndGet(id: string): Promise<Intent | undefined> {
    if (!isUuid(id)) return undefined;
    if (!this.db.isTransaction) {
      throw new DbError('invalid_value', 'lockAndGet must run inside a transaction');
    }
    await lockIntent(this.db, id);
    return this.getById(id);
  }

  /**
   * U02 (ADR-M54 §2.4b): records why the intent waits, as the workflow's step decided it, in the
   * step's transaction (the caller holds the intent lock). Writes only on a change, so
   * `waiting_since` keeps the moment the hold began; `null` clears it. Never touches `updated_at`
   * (retention reads it). Codes only: `reason` is an `IntentWaitReason`, `cause` a check code.
   */
  async recordWaiting(
    id: string,
    waiting: { reason: string; cause: string | null; until: Date | null } | null,
    at: Date,
  ): Promise<void> {
    for (const code of [waiting?.reason, waiting?.cause]) {
      if (code !== undefined && code !== null && !WAITING_CODE.test(code)) {
        throw new DbError('invalid_value', 'waiting code');
      }
    }
    const reason = waiting?.reason ?? null;
    const cause = waiting?.cause ?? null;
    const until = waiting?.until ?? null;
    await this.run(
      this.db
        .updateTable('intents')
        .set({
          waiting_reason: reason,
          waiting_cause: cause,
          waiting_until: until,
          waiting_since:
            reason === null
              ? null
              : sql<Date>`CASE WHEN waiting_reason IS NOT DISTINCT FROM ${reason}
                  AND waiting_cause IS NOT DISTINCT FROM ${cause}
                  THEN waiting_since ELSE ${at} END`,
        })
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', id)
        .where(
          sql<boolean>`(waiting_reason, waiting_cause, waiting_until) IS DISTINCT FROM
            (${reason}::text, ${cause}::text, ${until}::timestamptz)`,
        )
        .execute(),
    );
  }

  /**
   * Moves the intent with compare-and-set (task B07, ADR-M30): only when its status and gate still
   * equal `move.from`. Returns the moved intent, or undefined when it is no longer in `from` (for
   * example an activity retried after the move was committed). A move to another gate sets
   * `gate_entered_at`; staying at the same gate keeps it. The workflow is the only caller; it
   * checks which moves are allowed. Appends `intent.state_changed` (system actor) in the same
   * transaction.
   */
  async moveState(id: string, move: IntentMove): Promise<Intent | undefined> {
    for (const state of [move.from, move.to]) {
      if (!INTENT_STATUSES.includes(state.status)) throw new DbError('invalid_value', 'status');
      if (state.currentGate !== null && !GATE_CODES.includes(state.currentGate)) {
        throw new DbError('invalid_value', 'unknown gate');
      }
    }
    const entersGate = move.to.currentGate !== move.from.currentGate;
    return this.run(
      this.transactional(async (db) => {
        const intent = await db
          .updateTable('intents')
          .set({
            status: move.to.status,
            current_gate: move.to.currentGate,
            ...(entersGate
              ? { gate_entered_at: move.to.currentGate === null ? null : move.at }
              : {}),
            // U02 (ADR-M54 §2.4b): a move ends any wait; the next step records the new one.
            waiting_reason: null,
            waiting_cause: null,
            waiting_since: null,
            waiting_until: null,
            updated_at: sql<Date>`now()`,
          })
          .where('tenant_id', '=', this.tenantId)
          .where('id', '=', id)
          .where('status', '=', move.from.status)
          .$if(move.from.currentGate === null, (qb) => qb.where('current_gate', 'is', null))
          .$if(move.from.currentGate !== null, (qb) =>
            qb.where('current_gate', '=', move.from.currentGate!),
          )
          .returningAll()
          .executeTakeFirst();
        if (!intent) return undefined;
        await new AuditLogRepository(db, this.tenantId).append({
          action: 'intent.state_changed',
          actorType: 'system',
          actorId: null,
          entityId: intent.id,
          payload: {
            status: intent.status,
            ...(intent.current_gate === null ? {} : { current_gate: intent.current_gate }),
          },
        });
        return intent;
      }),
    );
  }

  /**
   * Raises the intent budget by `addUsd` and sets the run budget of its next runs (task C07, G5
   * `resume` with `budget_increase_usd`, QUESTIONS #133). Both only go up (trigger SDA12). Appends
   * `intent.budget_increased` with the amounts and the escalation that allowed it. Call under the
   * intent lock.
   */
  async raiseBudget(
    id: string,
    raise: {
      readonly addUsd: string;
      readonly runBudgetUsd: string;
      readonly escalationId: string;
    },
  ): Promise<Intent> {
    for (const amount of [raise.addUsd, raise.runBudgetUsd]) {
      if (!isUsd(amount) || toMicros(amount) <= 0n) {
        throw new DbError('invalid_value', 'a budget amount must be a decimal above 0');
      }
    }
    if (!isUuid(raise.escalationId)) throw new DbError('invalid_value', 'escalationId');
    return this.run(
      this.transactional(async (db) => {
        const current = await new IntentRepository(db, this.tenantId).getById(id);
        if (!current) throw new DbError('reference_not_found', `intent ${id} not found`);
        const budgetUsd = fromMicros(toMicros(current.budget_usd) + toMicros(raise.addUsd));
        const intent = await db
          .updateTable('intents')
          .set({
            budget_usd: budgetUsd,
            run_budget_usd: raise.runBudgetUsd,
            updated_at: sql<Date>`now()`,
          })
          .where('tenant_id', '=', this.tenantId)
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirstOrThrow();
        await new AuditLogRepository(db, this.tenantId).append({
          action: 'intent.budget_increased',
          actorType: 'system',
          actorId: null,
          entityId: intent.id,
          payload: {
            escalation_id: raise.escalationId,
            added_usd: fromMicros(toMicros(raise.addUsd)),
            budget_usd: budgetUsd,
            run_budget_usd: fromMicros(toMicros(raise.runBudgetUsd)),
          },
        });
        return intent;
      }),
    );
  }

  /**
   * Records a person's estimate of the human effort in hours (task V14, ADR-M79 §2.6): `hours` is
   * a decimal string from 0.25 to 10000 with at most two decimals. Appends
   * `intent.effort_estimated` in the same transaction; the same value again changes nothing and
   * writes no event. A finished intent or a value back to null is refused by the trigger (SDA29).
   * Call under the intent lock; the caller checks who may write.
   */
  async recordEffortEstimate(
    id: string,
    estimate: { readonly hours: string; readonly actorId: string },
  ): Promise<Intent> {
    if (!isEffortHours(estimate.hours)) {
      throw new DbError('invalid_value', 'hours must be 0.25 to 10000 with at most 2 decimals');
    }
    if (!isUuid(estimate.actorId)) throw new DbError('invalid_value', 'actorId');
    const hours = fromMicros(toMicros(estimate.hours));
    return this.run(
      this.transactional(async (db) => {
        const current = await new IntentRepository(db, this.tenantId).getById(id);
        if (!current) throw new DbError('reference_not_found', `intent ${id} not found`);
        const previous =
          current.human_effort_hours === null
            ? null
            : fromMicros(toMicros(current.human_effort_hours));
        if (previous === hours) return current;
        const intent = await db
          .updateTable('intents')
          .set({ human_effort_hours: hours })
          .where('tenant_id', '=', this.tenantId)
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirstOrThrow();
        await new AuditLogRepository(db, this.tenantId).append({
          action: 'intent.effort_estimated',
          actorType: 'human',
          actorId: estimate.actorId,
          entityId: id,
          payload: { hours, ...(previous === null ? {} : { previous_hours: previous }) },
        });
        return intent;
      }),
    );
  }

  /**
   * Links the pull request of the intent's agent branch (task C08, ADR-M38 §2.4): `pr_number`
   * goes from null to `prNumber`, or stays when it already is `prNumber` (a repeated call).
   * Returns false when the intent holds another pull request. The unique index of migration 0011
   * keeps one open intent per pull request. Appends `intent.pr_linked` when the link is new.
   * Call under the intent lock.
   */
  async linkPullRequest(
    id: string,
    link: { readonly prNumber: number; readonly runId: string; readonly headSha: string },
  ): Promise<boolean> {
    if (!Number.isSafeInteger(link.prNumber) || link.prNumber < 1) {
      throw new DbError('invalid_value', 'prNumber');
    }
    if (!isUuid(link.runId)) throw new DbError('invalid_value', 'runId');
    if (!/^[0-9a-f]{40}$/.test(link.headSha)) throw new DbError('invalid_value', 'headSha');
    return this.run(
      this.transactional(async (db) => {
        const updated = await db
          .updateTable('intents')
          .set({ pr_number: link.prNumber, updated_at: sql<Date>`now()` })
          .where('tenant_id', '=', this.tenantId)
          .where('id', '=', id)
          .where('pr_number', 'is', null)
          .returning('id')
          .executeTakeFirst();
        if (!updated) {
          const current = await new IntentRepository(db, this.tenantId).getById(id);
          return current?.pr_number === link.prNumber;
        }
        await new AuditLogRepository(db, this.tenantId).append({
          action: 'intent.pr_linked',
          actorType: 'system',
          actorId: null,
          entityId: id,
          payload: { run_id: link.runId, pr_number: link.prNumber, head_sha: link.headSha },
        });
        return true;
      }),
    );
  }

  /** Highest number used this year by the tenant, 0 when none. Call with the code lock held. */
  private async lastNumber(db: Kysely<Database>, year: number): Promise<number> {
    const row = await db
      .selectFrom('intents')
      .select(sql<number | null>`max(substring(code from 10)::int)`.as('last'))
      .where('tenant_id', '=', this.tenantId)
      .where('code', 'like', `INT-${String(year)}-%`)
      .executeTakeFirst();
    return row?.last ?? 0;
  }
}
