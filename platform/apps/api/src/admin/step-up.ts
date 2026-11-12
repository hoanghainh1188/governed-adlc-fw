// The passkey step-up of an administration change from a dashboard session (task U09, design/
// ADR-M73 §2.4b, MVP1-UI-SCOPE §3.4, QUESTIONS #681, #685).
//
// - A personal token (the CLI) writes as before: no step-up, and a `step_up` field is refused by
//   the route's strict body schema.
// - A dashboard session must carry `step_up` in the body. The answer is checked first
//   (`PasskeysService.verifyStepUp`), then core `consumeStepUp` marks the challenge used in the
//   transaction of the change, so a refused or failed change leaves the challenge unused.
// - The binding: the action code of the area, the change's name as `decision`, and the SHA-256 of
//   the body without `step_up`, plus `decision` and `target` (the path the change writes to). The
//   page asks `POST /v1/auth/step-up` with that same request.
// - Every refusal of the step-up is 403 `step_up_refused`: nothing to tell apart.
import {
  consumeStepUp,
  PasskeyError,
  stepUpRequestSha256,
  type AdminStepUpAction,
} from '@sdlc/core';

import type { z } from 'zod';

import type { Principal } from '../auth/principal.js';
import { ApiError } from '../errors/api-error.js';
import type { PasskeysService } from '../passkeys/passkeys.service.js';
import { stepUpAnswerSchema } from '../passkeys/schemas.js';
import { parseRequest } from '../validation.js';

/** One administration change: what the step-up is bound to. */
export interface AdminChange {
  readonly action: AdminStepUpAction;
  /** The change, a code: `create`, `update`, `archive`, `role_grant`, ... */
  readonly decision: string;
  /** The path the change writes to, built from the parsed path values: `/v1/admin/...`. */
  readonly target: string;
}

/** A request body split into the change's own body and the session's passkey answer. */
export interface SplitBody {
  /** The body as the route parses it: without `step_up` for a session, unchanged for a token. */
  readonly body: unknown;
  readonly answer: unknown;
}

export class AdminStepUp {
  constructor(
    private readonly passkeys: PasskeysService | undefined,
    private readonly now: () => Date,
  ) {}

  /**
   * Takes `step_up` out of a session's body. A token's body stays as sent, so its strict schema
   * refuses a `step_up` field. A body-less request of a session is `{}`.
   */
  split(p: Principal, raw: unknown): SplitBody {
    if (p.credential.kind !== 'session') return { body: raw, answer: undefined };
    const object =
      raw !== null && typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {};
    const { step_up: answer, ...body } = object;
    return { body, answer };
  }

  /**
   * Splits the body, parses the change's own body with `schema` (a missing body is `{}`), then
   * runs the change with `run`.
   */
  async apply<S extends z.ZodType, T>(
    p: Principal,
    raw: unknown,
    schema: S,
    change: AdminChange,
    write: (q: Principal, input: z.infer<S>) => Promise<T>,
  ): Promise<T> {
    const split = this.split(p, raw);
    const input = parseRequest(schema, split.body ?? {}, 'body');
    return this.run(p, change, split, (q) => write(q, input));
  }

  /**
   * Runs the change. For a session: checks the passkey answer, then consumes the challenge and
   * makes the change in one transaction; `write` gets a principal whose scope is that transaction.
   */
  async run<T>(
    p: Principal,
    change: AdminChange,
    split: SplitBody,
    write: (q: Principal) => Promise<T>,
  ): Promise<T> {
    if (p.credential.kind !== 'session') return write(p);
    if (split.answer === undefined || !this.passkeys) throw new ApiError(403, 'step_up_refused');
    const answer = parseRequest(stepUpAnswerSchema, split.answer, 'body');
    const verified = await this.passkeys.verifyStepUp(p, answer);
    const body = (split.body ?? {}) as Record<string, unknown>;
    const binding = {
      action: change.action,
      decision: change.decision,
      intentId: null,
      escalationId: null,
      gate: null,
      expectedInputSha256: null,
      requestSha256: stepUpRequestSha256({
        ...body,
        decision: change.decision,
        target: change.target,
      }),
    };
    return p.scope.transaction(async (tx) => {
      await consumeStepUp(tx, verified, binding, this.now()).catch((error: unknown) => {
        throw error instanceof PasskeyError ? new ApiError(403, 'step_up_refused') : error;
      });
      return write({ ...p, scope: tx });
    });
  }
}
