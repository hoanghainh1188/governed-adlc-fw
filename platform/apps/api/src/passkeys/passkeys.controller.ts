// Passkeys and the step-up challenge (task U06, design/ADR-M73 §2.4, QUESTIONS #411–#414). These
// endpoints change no intent, gate, run or escalation.
//
// - `GET    /v1/me/passkeys`                        the caller's passkeys (token or session)
// - `POST   /v1/me/passkeys/registration-options`   session, actions on: a registration challenge
// - `POST   /v1/me/passkeys`                        session, actions on: store a verified passkey
// - `DELETE /v1/me/passkeys/:id`                    remove one's own passkey
// - `POST   /v1/auth/step-up`                       session, actions on: a challenge for one decision
// - `GET    /v1/admin/users/:user/passkeys`         a tenant admin (QUESTIONS #414)
// - `DELETE /v1/admin/users/:user/passkeys/:id`     a tenant admin; a session with a step-up (U09)
//
// The POST endpoints are also limited per client address. Answers are `no-store`.
import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { PASSKEY_CHALLENGE_TTL_MS, type WebauthnCredential } from '@sdlc/core';

import { emptyBodySchema, idSchema } from '../admin/schemas.js';
import type { AdminStepUp } from '../admin/step-up.js';
import { SessionAction } from '../auth/auth.guard.js';
import { CurrentPrincipal, type Principal } from '../auth/principal.js';
import type { RateLimiter } from '../auth/rate-limiter.js';
import { ApiError } from '../errors/api-error.js';
import { ADMIN_STEP_UP, PASSKEYS } from '../tokens.js';
import { parseRequest } from '../validation.js';
import type { PasskeysService } from './passkeys.service.js';
import { registerPasskeySchema, stepUpRequestSchema } from './schemas.js';

/** Passkey requests a client address may send per minute (ADR-M73 §2.7). */
export const PASSKEY_REQUESTS_PER_MINUTE = 30;

export interface PasskeyEndpoints {
  readonly service: PasskeysService;
  readonly perAddress: RateLimiter;
}

type Json = Record<string, unknown>;

interface Request {
  readonly ip: string;
}

/** A passkey as the API shows it: IDs, a model UUID and times; never the key or the counter. */
export function presentPasskey(row: WebauthnCredential): Json {
  return {
    id: row.id,
    aaguid: row.aaguid,
    created_at: row.created_at.toISOString(),
    last_used_at: row.last_used_at?.toISOString() ?? null,
    revoked_at: row.revoked_at?.toISOString() ?? null,
  };
}

@Controller('v1')
export class PasskeysController {
  constructor(
    @Inject(PASSKEYS) private readonly passkeys: PasskeyEndpoints,
    @Inject(ADMIN_STEP_UP) private readonly adminStepUp: AdminStepUp,
  ) {}

  @Get('me/passkeys')
  @Header('Cache-Control', 'no-store')
  async list(@CurrentPrincipal() p: Principal): Promise<Json> {
    return { items: (await this.passkeys.service.list(p)).map(presentPasskey) };
  }

  @Post('me/passkeys/registration-options')
  @SessionAction('actions')
  @HttpCode(200)
  async registrationOptions(@CurrentPrincipal() p: Principal, @Req() req: Request): Promise<Json> {
    this.#limit(req);
    const { challengeId, options } = await this.passkeys.service.registrationOptions(p);
    return { challenge_id: challengeId, options, expires_in_seconds: ttlSeconds() };
  }

  @Post('me/passkeys')
  @SessionAction('actions')
  @HttpCode(201)
  async register(
    @CurrentPrincipal() p: Principal,
    @Req() req: Request,
    @Body() body: unknown,
  ): Promise<Json> {
    this.#limit(req);
    const input = parseRequest(registerPasskeySchema, body, 'body');
    return presentPasskey(
      await this.passkeys.service.register(p, input.challenge_id, input.response),
    );
  }

  @Delete('me/passkeys/:id')
  @SessionAction('actions')
  async revokeOwn(@CurrentPrincipal() p: Principal, @Param('id') id: string): Promise<Json> {
    return presentPasskey(
      await this.passkeys.service.revokeOwn(p, parseRequest(idSchema, id, 'path')),
    );
  }

  @Post('auth/step-up')
  @SessionAction('actions')
  @HttpCode(200)
  async stepUp(
    @CurrentPrincipal() p: Principal,
    @Req() req: Request,
    @Body() body: unknown,
  ): Promise<Json> {
    this.#limit(req);
    const input = parseRequest(stepUpRequestSchema, body, 'body');
    const { challengeId, options } = await this.passkeys.service.stepUpOptions(p, input);
    return { challenge_id: challengeId, options, expires_in_seconds: ttlSeconds() };
  }

  @Get('admin/users/:user/passkeys')
  @Header('Cache-Control', 'no-store')
  async listFor(@CurrentPrincipal() p: Principal, @Param('user') user: string): Promise<Json> {
    const rows = await this.passkeys.service.listFor(p, parseRequest(idSchema, user, 'path'));
    return { items: rows.map(presentPasskey) };
  }

  @Delete('admin/users/:user/passkeys/:id')
  @SessionAction('actions')
  async revokeFor(
    @CurrentPrincipal() p: Principal,
    @Param('user') user: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<Json> {
    const userId = parseRequest(idSchema, user, 'path');
    const passkeyId = parseRequest(idSchema, id, 'path');
    const change = {
      action: 'admin.passkey',
      decision: 'revoke',
      target: `/v1/admin/users/${userId}/passkeys/${passkeyId}`,
    } as const;
    return presentPasskey(
      await this.adminStepUp.apply(p, body, emptyBodySchema, change, (q) =>
        this.passkeys.service.revokeFor(q, userId, passkeyId),
      ),
    );
  }

  #limit(req: Request): void {
    if (!this.passkeys.perAddress.hit(`ip:${req.ip}`)) throw new ApiError(429, 'rate_limited');
  }
}

function ttlSeconds(): number {
  return PASSKEY_CHALLENGE_TTL_MS / 1000;
}
