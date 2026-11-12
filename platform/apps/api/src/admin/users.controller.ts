// Admin endpoints for users and their Git host identities (task B13 AC2, AC3; ADR-M37 §2.6).
// Tenant admins only. Users are addressed by ID: an e-mail address never goes into a URL.
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  issueTokenFor,
  listTokensOf,
  revokeTokenOf,
  createUser,
  endUserWebSessions,
  isTenantAdmin,
  linkIdentity,
  listIdentities,
  listTenantRoles,
  listUsers,
  setUserActive,
  showUser,
  unlinkIdentity,
  updateUser,
  type User,
} from '@sdlc/core';

import { SessionAction } from '../auth/auth.guard.js';
import { CurrentPrincipal, type Principal } from '../auth/principal.js';
import { ADMIN_STEP_UP, CLOCK } from '../tokens.js';
import { parseRequest } from '../validation.js';
import { actorOf } from './actor.js';
import { presentIdentity, presentIssuedToken, presentToken, presentUser } from './present.js';
import type { AdminChange, AdminStepUp } from './step-up.js';
import {
  createUserSchema,
  emptyBodySchema,
  historyQuerySchema,
  idSchema,
  issueTokenSchema,
  linkIdentitySchema,
  updateUserSchema,
} from './schemas.js';

type Body = Record<string, unknown>;

const BASE = '/v1/admin/users';

/** A user change of a dashboard session takes a passkey step-up (U09, ADR-M73 §2.4b). */
function userChange(decision: string, target: string): AdminChange {
  return { action: 'admin.user', decision, target };
}

// Tokens stay in the CLI (MVP1-UI-SCOPE §3.4, QUESTIONS #684): their routes take no session write.
@Controller('v1/admin/users')
export class AdminUsersController {
  constructor(
    @Inject(CLOCK) private readonly now: () => Date,
    @Inject(ADMIN_STEP_UP) private readonly stepUp: AdminStepUp,
  ) {}

  @Get()
  async list(@CurrentPrincipal() p: Principal): Promise<Body> {
    const users = await listUsers(p.scope, actorOf(p));
    const admins = new Set(
      (await listTenantRoles(p.scope, actorOf(p))).map((binding) => binding.user_id),
    );
    return { items: users.map((user) => presentUser(user, admins.has(user.id))) };
  }

  @Post()
  @SessionAction('actions')
  @HttpCode(201)
  async create(@CurrentPrincipal() p: Principal, @Body() body: unknown): Promise<Body> {
    const user = await this.stepUp.apply(
      p,
      body,
      createUserSchema,
      userChange('create', BASE),
      (q, input) =>
        createUser(q.scope, actorOf(q), { email: input.email, displayName: input.display_name }),
    );
    return presentUser(user, false);
  }

  @Get(':user')
  async show(@CurrentPrincipal() p: Principal, @Param('user') id: string): Promise<Body> {
    return this.present(p, await showUser(p.scope, actorOf(p), parseRequest(idSchema, id, 'path')));
  }

  @Patch(':user')
  @SessionAction('actions')
  async update(
    @CurrentPrincipal() p: Principal,
    @Param('user') id: string,
    @Body() body: unknown,
  ): Promise<Body> {
    const userId = parseRequest(idSchema, id, 'path');
    const user = await this.stepUp.apply(
      p,
      body,
      updateUserSchema,
      userChange('update', `${BASE}/${userId}`),
      (q, input) =>
        updateUser(q.scope, actorOf(q), userId, {
          ...(input.email === undefined ? {} : { email: input.email }),
          ...(input.display_name === undefined ? {} : { displayName: input.display_name }),
        }),
    );
    return this.present(p, user);
  }

  @Post(':user/disable')
  @SessionAction('actions')
  @HttpCode(200)
  async disable(
    @CurrentPrincipal() p: Principal,
    @Param('user') id: string,
    @Body() body: unknown,
  ): Promise<Body> {
    const userId = parseRequest(idSchema, id, 'path');
    const user = await this.stepUp.apply(
      p,
      body,
      emptyBodySchema,
      userChange('disable', `${BASE}/${userId}/disable`),
      (q) => setUserActive(q.scope, actorOf(q), userId, false, this.now()),
    );
    return this.present(p, user);
  }

  @Post(':user/enable')
  @SessionAction('actions')
  @HttpCode(200)
  async enable(
    @CurrentPrincipal() p: Principal,
    @Param('user') id: string,
    @Body() body: unknown,
  ): Promise<Body> {
    const userId = parseRequest(idSchema, id, 'path');
    const user = await this.stepUp.apply(
      p,
      body,
      emptyBodySchema,
      userChange('enable', `${BASE}/${userId}/enable`),
      (q) => setUserActive(q.scope, actorOf(q), userId, true),
    );
    return this.present(p, user);
  }

  @Get(':user/identities')
  async identities(
    @CurrentPrincipal() p: Principal,
    @Param('user') id: string,
    @Query() query: unknown,
  ): Promise<Body> {
    const history = parseRequest(historyQuerySchema, query, 'query');
    const identities = await listIdentities(
      p.scope,
      actorOf(p),
      parseRequest(idSchema, id, 'path'),
      history.include_unlinked === 'true',
    );
    return { items: identities.map(presentIdentity) };
  }

  @Post(':user/identities')
  @SessionAction('actions')
  @HttpCode(201)
  async link(
    @CurrentPrincipal() p: Principal,
    @Param('user') id: string,
    @Body() body: unknown,
  ): Promise<Body> {
    const userId = parseRequest(idSchema, id, 'path');
    const identity = await this.stepUp.apply(
      p,
      body,
      linkIdentitySchema,
      userChange('identity_link', `${BASE}/${userId}/identities`),
      (q, input) =>
        linkIdentity(q.scope, actorOf(q), userId, {
          ...(input.provider === undefined ? {} : { provider: input.provider }),
          externalId: input.external_id,
          externalLogin: input.external_login,
        }),
    );
    return presentIdentity(identity);
  }

  @Delete(':user/identities/:identity')
  @SessionAction('actions')
  async unlink(
    @CurrentPrincipal() p: Principal,
    @Param('user') id: string,
    @Param('identity') identityId: string,
    @Body() body: unknown,
  ): Promise<Body> {
    const userId = parseRequest(idSchema, id, 'path');
    const identity = parseRequest(idSchema, identityId, 'path');
    const unlinked = await this.stepUp.apply(
      p,
      body,
      emptyBodySchema,
      userChange('identity_unlink', `${BASE}/${userId}/identities/${identity}`),
      (q) => unlinkIdentity(q.scope, actorOf(q), userId, identity),
    );
    return presentIdentity(unlinked);
  }

  // Other users' tokens (B13 AC5, QUESTIONS #152): a token issued for someone else lives at most
  // 7 days; the user creates their own and revokes it.
  @Get(':user/tokens')
  async tokens(@CurrentPrincipal() p: Principal, @Param('user') id: string): Promise<Body> {
    const tokens = await listTokensOf(p.scope, actorOf(p), parseRequest(idSchema, id, 'path'));
    return { items: tokens.map(presentToken) };
  }

  @Post(':user/tokens')
  @HttpCode(201)
  async issueToken(
    @CurrentPrincipal() p: Principal,
    @Param('user') id: string,
    @Body() body: unknown,
  ): Promise<Body> {
    const input = parseRequest(issueTokenSchema, body, 'body');
    const issued = await issueTokenFor(p.scope, actorOf(p), parseRequest(idSchema, id, 'path'), {
      name: input.name,
      now: this.now(),
      ...(input.days === undefined ? {} : { lifetimeDays: input.days }),
    });
    return presentIssuedToken(issued);
  }

  @Delete(':user/tokens/:token')
  async revokeToken(
    @CurrentPrincipal() p: Principal,
    @Param('user') id: string,
    @Param('token') tokenId: string,
  ): Promise<Body> {
    const revoked = await revokeTokenOf(
      p.scope,
      actorOf(p),
      parseRequest(idSchema, id, 'path'),
      parseRequest(idSchema, tokenId, 'path'),
      this.now(),
    );
    return presentToken(revoked);
  }

  /** U05 (ADR-M73 §2.2): a tenant admin signs a person out of the dashboard everywhere. */
  @Delete(':user/sessions')
  @SessionAction('actions')
  async endSessions(
    @CurrentPrincipal() p: Principal,
    @Param('user') id: string,
    @Body() body: unknown,
  ): Promise<Body> {
    const userId = parseRequest(idSchema, id, 'path');
    const ended = await this.stepUp.apply(
      p,
      body,
      emptyBodySchema,
      userChange('sessions_end', `${BASE}/${userId}/sessions`),
      (q) => endUserWebSessions(q.scope, actorOf(q), userId, this.now()),
    );
    return { ended };
  }

  private async present(p: Principal, user: User): Promise<Body> {
    return presentUser(user, await isTenantAdmin(p.scope, user.id));
  }
}
