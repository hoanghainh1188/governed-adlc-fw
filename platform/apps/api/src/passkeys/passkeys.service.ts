// Passkeys and the step-up (task U06, design/ADR-M73 §2.4, MVP1-UI-SCOPE §5.4, QUESTIONS
// #411–#414). No intent, gate, run or escalation changes here: U07 makes the decision endpoints
// call `verifyStepUp`, then `consumeStepUp` (core) in the decision's transaction.
import {
  ESCALATION_CODE_PATTERN,
  INTENT_CODE_PATTERN,
  activePasskeys,
  assertRecentSignIn,
  createRegistrationChallenge,
  createStepUpChallenge,
  isAdminStepUpAction,
  isUuid,
  listPasskeys,
  listUserPasskeys,
  mayReadPlans,
  openChallenge,
  projectAccess,
  registerPasskey,
  revokeOwnPasskey,
  revokeUserPasskey,
  stepUpRequestSha256,
  PasskeyError,
  type PlatformLogger,
  type StepUpBinding,
  type VerifiedStepUp,
  type WebauthnCredential,
} from '@sdlc/core';
import type { GateCode } from '@sdlc/contracts';
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';

import type { Principal } from '../auth/principal.js';
import { ApiError } from '../errors/api-error.js';
import { PasskeyCheckError, type WebAuthnCeremonies } from './webauthn.js';

/** A step-up request of the page: what the decision will be, and the decision's body. */
export interface StepUpRequest {
  readonly action: StepUpBinding['action'];
  readonly intent?: string | undefined;
  readonly escalation?: string | undefined;
  readonly gate?: GateCode | undefined;
  readonly expected_input_sha256?: string | undefined;
  /** The decision's body, as the page will send it (without `step_up`). */
  readonly request: Readonly<Record<string, unknown>>;
}

/** The passkey answer a decision carries (U07): `step_up` in the decision's body. */
export interface StepUpAnswer {
  readonly challenge_id: string;
  readonly response: AuthenticationResponseJSON;
}

export interface PasskeysDeps {
  /** Undefined: sign-in is off, so no session can register or confirm. */
  readonly ceremonies: WebAuthnCeremonies | undefined;
  readonly now: () => Date;
  readonly log: PlatformLogger;
}

export class PasskeysService {
  constructor(private readonly deps: PasskeysDeps) {}

  /** The caller's passkeys (a token or a session). */
  async list(p: Principal): Promise<WebauthnCredential[]> {
    return listPasskeys(p.scope, p.userId);
  }

  /** A registration challenge for the session, within 5 minutes of its GitHub sign-in. */
  async registrationOptions(p: Principal): Promise<{
    challengeId: string;
    options: PublicKeyCredentialCreationOptionsJSON;
  }> {
    const { ceremonies, session } = this.#session(p);
    const now = this.deps.now();
    assertRecentSignIn(session.signedInAt, now);
    const user = await p.scope.users.getById(p.userId);
    if (!user) throw new ApiError(401, 'unauthorized');
    const exclude = (await activePasskeys(p.scope, p.userId)).map((c) => c.credential_id);
    const issued = await createRegistrationChallenge(p.scope, {
      userId: p.userId,
      sessionId: session.id,
      now,
    });
    const options = await ceremonies.registrationOptions({
      challenge: issued.challenge,
      user: { id: user.id, email: user.email, displayName: user.display_name },
      exclude,
    });
    return { challengeId: issued.challengeId, options };
  }

  /** Checks the browser's answer and stores the passkey. */
  async register(
    p: Principal,
    challengeId: string,
    response: RegistrationResponseJSON,
  ): Promise<WebauthnCredential> {
    const { ceremonies, session } = this.#session(p);
    const now = this.deps.now();
    const challenge = await openChallenge(p.scope, {
      challengeId,
      userId: p.userId,
      sessionId: session.id,
      purpose: 'register',
      now,
    });
    const credential = await this.#checked(() =>
      ceremonies.verifyRegistration(response, challenge.challenge_sha256),
    );
    return registerPasskey(p.scope, {
      userId: p.userId,
      sessionId: session.id,
      signedInAt: session.signedInAt,
      challenge,
      credential,
      now,
    });
  }

  async revokeOwn(p: Principal, passkeyId: string): Promise<WebauthnCredential> {
    return revokeOwnPasskey(p.scope, p.userId, passkeyId, this.deps.now());
  }

  async listFor(p: Principal, userId: string): Promise<WebauthnCredential[]> {
    return listUserPasskeys(p.scope, p.userId, userId);
  }

  async revokeFor(p: Principal, userId: string, passkeyId: string): Promise<WebauthnCredential> {
    return revokeUserPasskey(p.scope, p.userId, userId, passkeyId, this.deps.now());
  }

  /**
   * A step-up challenge bound to one decision (ADR-M73 §2.4, QUESTIONS #411). The intent or the
   * escalation must be one the caller can read; the decision itself is checked again by its own
   * endpoint.
   */
  async stepUpOptions(
    p: Principal,
    request: StepUpRequest,
  ): Promise<{ challengeId: string; options: PublicKeyCredentialRequestOptionsJSON }> {
    const { ceremonies, session } = this.#session(p);
    const binding = await this.bindingOf(p, request);
    const allow = (await activePasskeys(p.scope, p.userId)).map((c) => c.credential_id);
    if (allow.length === 0) throw new ApiError(404, 'passkey_not_found');
    const issued = await createStepUpChallenge(p.scope, {
      userId: p.userId,
      sessionId: session.id,
      now: this.deps.now(),
      binding,
    });
    const options = await ceremonies.authenticationOptions({ challenge: issued.challenge, allow });
    return { challengeId: issued.challengeId, options };
  }

  /** The binding of a step-up request: IDs from codes, the SHA-256 of the decision's body. */
  async bindingOf(p: Principal, request: StepUpRequest): Promise<StepUpBinding> {
    const decision = request.request.decision;
    const common = {
      action: request.action,
      decision: typeof decision === 'string' ? decision : '',
      expectedInputSha256: request.expected_input_sha256 ?? null,
      requestSha256: stepUpRequestSha256(request.request),
    };
    if (isAdminStepUpAction(request.action)) {
      // An administration change: the endpoint checks who may make it, in its transaction.
      return { ...common, intentId: null, escalationId: null, gate: null };
    }
    if (request.action.startsWith('eval_plan.')) {
      await this.#readablePlanTarget(p, request.request.target);
      return { ...common, intentId: null, escalationId: null, gate: null };
    }
    if (request.action === 'gate.decide') {
      const intent = await this.#readableIntent(p, request.intent ?? '');
      return {
        ...common,
        intentId: intent,
        escalationId: null,
        gate: request.gate ?? null,
      };
    }
    return {
      ...common,
      intentId: null,
      escalationId: await this.#readableEscalation(p, request.escalation ?? ''),
      gate: null,
    };
  }

  /**
   * Checks the passkey answer a decision carries, for U07 (ADR-M73 §2.4): the challenge is open
   * and this session's, the passkey is the caller's and active, and its signature holds. It is
   * not used here: the decision's transaction calls `consumeStepUp` (core), which also compares
   * the bound action.
   */
  async verifyStepUp(p: Principal, answer: StepUpAnswer): Promise<VerifiedStepUp> {
    const { ceremonies, session } = this.#session(p);
    const now = this.deps.now();
    // One answer for every refusal of a step-up (ADR-M73 §2.4): nothing to tell apart.
    const challenge = await openChallenge(p.scope, {
      challengeId: answer.challenge_id,
      userId: p.userId,
      sessionId: session.id,
      purpose: 'step_up',
      now,
    }).catch((error: unknown) => {
      throw error instanceof PasskeyError ? new ApiError(403, 'step_up_refused') : error;
    });
    const passkey = await p.scope.webauthnCredentials.findActive(p.userId, answer.response.id);
    if (!passkey) throw new ApiError(403, 'step_up_refused');
    const signCount = await this.#checked(() =>
      ceremonies.verifyAuthentication(answer.response, challenge.challenge_sha256, {
        credentialId: passkey.credential_id,
        publicKey: passkey.public_key,
        signCount: Number(passkey.sign_count),
      }),
    );
    return {
      challengeId: challenge.id,
      challengeSha256: challenge.challenge_sha256,
      userId: p.userId,
      sessionId: session.id,
      passkeyId: passkey.id,
      signCount,
    };
  }

  #session(p: Principal): {
    ceremonies: WebAuthnCeremonies;
    session: { id: string; signedInAt: Date };
  } {
    const ceremonies = this.deps.ceremonies;
    if (p.credential.kind !== 'session' || !ceremonies) {
      // Passkeys are made and used in the dashboard only: never with an API token.
      throw new ApiError(403, 'session_write_not_allowed');
    }
    return { ceremonies, session: p.credential };
  }

  async #checked<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (!(error instanceof PasskeyCheckError)) throw error;
      this.deps.log.log('info', 'api.passkey_refused', { code: error.code });
      throw new ApiError(400, 'passkey_refused');
    }
  }

  async #readableIntent(p: Principal, ref: string): Promise<string> {
    const intent = INTENT_CODE_PATTERN.test(ref)
      ? await p.scope.intents.getByCode(ref)
      : isUuid(ref)
        ? await p.scope.intents.getById(ref)
        : undefined;
    if (!intent || !(await projectAccess(p.scope, intent.project_id, p.userId)).canRead) {
      throw new ApiError(404, 'intent_not_found');
    }
    return intent.id;
  }

  /** L05: the project (create) or the plan (change, run) a plan step-up names must be readable. */
  async #readablePlanTarget(p: Principal, target: unknown): Promise<void> {
    const plan =
      typeof target === 'string' && isUuid(target)
        ? await p.scope.evaluationPlans.getById(target)
        : undefined;
    const project = plan
      ? await p.scope.projects.getById(plan.project_id)
      : typeof target === 'string'
        ? await p.scope.projects.getBySlug(target)
        : undefined;
    if (!project || !(await mayReadPlans(p.scope, p.userId, project.id))) {
      throw new ApiError(404, 'not_found');
    }
  }

  async #readableEscalation(p: Principal, code: string): Promise<string> {
    const escalation = ESCALATION_CODE_PATTERN.test(code)
      ? await p.scope.escalations.getByCode(code)
      : undefined;
    const intent = escalation ? await p.scope.intents.getById(escalation.intent_id) : undefined;
    if (
      !escalation ||
      !intent ||
      !(await projectAccess(p.scope, intent.project_id, p.userId)).canRead
    ) {
      throw new ApiError(404, 'escalation_not_found');
    }
    return escalation.id;
  }
}
