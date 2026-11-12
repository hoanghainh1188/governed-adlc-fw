// Passkeys and the step-up before a decision in the dashboard (task U06, design/ADR-M73 §2.4,
// MVP1-UI-SCOPE §5.4, QUESTIONS #410–#414).
//
// - Registering a passkey needs a dashboard session that signed in with GitHub in the last
//   5 minutes and a registration challenge of that session. At most 10 active passkeys a person.
// - A step-up challenge is 32 random bytes made here, never derived from the request, stored as
//   its SHA-256 with the session and the action it is bound to (the action code, the intent or
//   escalation, the gate, the decision, the expected input hash and the SHA-256 of the request,
//   QUESTIONS #411). It lives 2 minutes and is used once, in the transaction of the decision
//   (`consumeStepUp`): a decision that rolls back leaves it unused.
// - The WebAuthn signature itself is checked by the api (`@simplewebauthn/server`): core keeps no
//   outside package but Kysely and pg (ADR-M09). Core stores and compares.
// - Audit `passkey.registered`, `passkey.revoked` (entity: the user; codes only). Never a
//   credential ID, a passkey row ID or a session ID in the audit log (ADR-M73 §2.6).
import { createHash, randomBytes } from 'node:crypto';

import { canonicalJson } from '@sdlc/config';
import { GATE_CODES, type GateCode } from '@sdlc/contracts';

import { assertTenantAdmin } from '../admin/actor.js';
import { AdminError } from '../admin/errors.js';
import type { PasskeyChallenge, WebauthnCredential } from '../db/schema.js';
import { isUuid } from '../db/tenant-id.js';
import type { TenantScope } from '../db/tenant-scope.js';

/** A challenge lives this long (ADR-M73 §2.4: about 2 minutes). */
export const PASSKEY_CHALLENGE_TTL_MS = 2 * 60_000;
/** A passkey is registered within this time after the GitHub sign-in (ADR-M73 §2.4). */
export const PASSKEY_REGISTRATION_WINDOW_MS = 5 * 60_000;
/** Active passkeys a person may hold. */
export const MAX_ACTIVE_PASSKEYS = 10;
/** Open challenges a session may hold at once (QUESTIONS #412). */
export const MAX_OPEN_CHALLENGES = 5;

/**
 * The actions a step-up may be bound to. U07 uses the first two; U09 adds the admin changes.
 * A kill and an acknowledgement never take a step-up (ADR-M73 §2.4).
 */
export const ADMIN_STEP_UP_ACTIONS = [
  'admin.project',
  'admin.user',
  'admin.tenant_admin',
  'admin.agent',
  'admin.ai_record',
  'admin.evidence_hold',
  'admin.passkey',
] as const;
export type AdminStepUpAction = (typeof ADMIN_STEP_UP_ACTIONS)[number];

export function isAdminStepUpAction(value: unknown): value is AdminStepUpAction {
  return typeof value === 'string' && (ADMIN_STEP_UP_ACTIONS as readonly string[]).includes(value);
}

export const STEP_UP_ACTIONS = [
  'gate.decide',
  'escalation.decide',
  // L05 (ADR-M82 §2.7, QUESTIONS #470): the evaluation plan actions of the dashboard.
  'eval_plan.create',
  'eval_plan.change',
  'eval_plan.run',
  // U09 (ADR-M73 §2.4b, QUESTIONS #681, #685): every administration change from a dashboard
  // session, one code per area; the decision names the change (`create`, `role_grant`, ...).
  ...ADMIN_STEP_UP_ACTIONS,
] as const;
export type StepUpAction = (typeof STEP_UP_ACTIONS)[number];

export function isStepUpAction(value: unknown): value is StepUpAction {
  return typeof value === 'string' && (STEP_UP_ACTIONS as readonly string[]).includes(value);
}

export type PasskeyErrorCode =
  /** The session signed in with GitHub more than 5 minutes ago: sign in again. */
  | 'recent_signin_required'
  /** The person holds the maximum number of active passkeys. */
  | 'too_many_passkeys'
  /** The session holds the maximum number of open challenges. */
  | 'too_many_challenges'
  /** The challenge is unknown, used, expired, or of another session or purpose. */
  | 'challenge_refused'
  /** No active passkey with this ID for the person. */
  | 'passkey_not_found'
  /** The step-up does not hold: challenge, binding or passkey counter (one answer for all). */
  | 'step_up_refused'
  /** A value has the wrong shape; `field` says which. */
  | 'invalid_value';

export class PasskeyError extends Error {
  override readonly name = 'PasskeyError';

  constructor(
    readonly code: PasskeyErrorCode,
    message: string,
    readonly field?: string,
  ) {
    super(message);
  }
}

/** What a step-up is bound to (ADR-M73 §2.4, QUESTIONS #411). IDs, codes and hashes only. */
export interface StepUpBinding {
  readonly action: StepUpAction;
  readonly intentId: string | null;
  readonly escalationId: string | null;
  readonly gate: GateCode | null;
  readonly decision: string | null;
  readonly expectedInputSha256: string | null;
  /** SHA-256 of the RFC 8785 canonical JSON of the decision's body without `step_up`. */
  readonly requestSha256: string;
}

const HEX64 = /^[0-9a-f]{64}$/;
const CODE = /^[a-z][a-z0-9_.]{0,63}$/;
const CREDENTIAL_ID = /^[A-Za-z0-9_-]{16,1366}$/;

/**
 * SHA-256 of the RFC 8785 canonical JSON of a request body (QUESTIONS #411). The decision
 * endpoint computes it again from the body it received, without `step_up`.
 */
export function stepUpRequestSha256(body: unknown): string {
  return sha256Hex(canonicalJson(body));
}

/** SHA-256 of a challenge as the browser sends it back (base64url), lowercase hex. */
export function hashPasskeyChallenge(challenge: string): string {
  return sha256Hex(challenge);
}

/** A WebAuthn signature counter: an unsigned 32-bit integer. */
function isSignCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= 0xffff_ffff;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Refuses a binding that is not one of the known shapes. */
export function assertStepUpBinding(binding: StepUpBinding): void {
  const bad = (field: string): never => {
    throw new PasskeyError('invalid_value', `step-up ${field} is invalid`, field);
  };
  if (!isStepUpAction(binding.action)) bad('action');
  if (!HEX64.test(binding.requestSha256)) bad('request_sha256');
  if (binding.expectedInputSha256 !== null && !HEX64.test(binding.expectedInputSha256)) {
    bad('expected_input_sha256');
  }
  if (binding.decision === null || !CODE.test(binding.decision)) bad('decision');
  if (isAdminStepUpAction(binding.action)) {
    // An administration change binds no intent or escalation: the path it writes to and its body
    // are in the request's SHA-256; the decision names the change (U09, QUESTIONS #685).
    if (binding.intentId !== null || binding.escalationId !== null || binding.gate !== null) {
      bad('intent');
    }
    if (binding.expectedInputSha256 !== null) bad('expected_input_sha256');
  } else if (binding.action.startsWith('eval_plan.')) {
    // An evaluation plan action binds no intent or escalation: the plan and its body are in the
    // request's SHA-256; the decision is the action's own name (`create`, `change`, `run`).
    if (binding.intentId !== null || binding.escalationId !== null || binding.gate !== null) {
      bad('intent');
    }
    if (binding.decision !== binding.action.slice('eval_plan.'.length)) bad('decision');
  } else if (binding.action === 'gate.decide') {
    if (binding.intentId === null || !isUuid(binding.intentId)) bad('intent');
    if (binding.gate === null || !(GATE_CODES as readonly string[]).includes(binding.gate)) {
      bad('gate');
    }
    if (binding.escalationId !== null) bad('escalation');
  } else {
    if (binding.escalationId === null || !isUuid(binding.escalationId)) bad('escalation');
    if (binding.intentId !== null || binding.gate !== null) bad('intent');
  }
}

export interface NewChallenge {
  readonly userId: string;
  readonly sessionId: string;
  readonly now: Date;
}

export interface IssuedChallenge {
  readonly challengeId: string;
  /** 32 random bytes, base64url: goes to the browser only, never stored or logged. */
  readonly challenge: string;
  readonly expiresAt: Date;
}

/** A registration challenge for the session (purpose `register`). */
export async function createRegistrationChallenge(
  scope: TenantScope,
  input: NewChallenge,
): Promise<IssuedChallenge> {
  return issueChallenge(scope, input, 'register', null);
}

/** A step-up challenge bound to one action (purpose `step_up`). */
export async function createStepUpChallenge(
  scope: TenantScope,
  input: NewChallenge & { readonly binding: StepUpBinding },
): Promise<IssuedChallenge> {
  assertStepUpBinding(input.binding);
  return issueChallenge(scope, input, 'step_up', input.binding);
}

async function issueChallenge(
  scope: TenantScope,
  input: NewChallenge,
  purpose: 'register' | 'step_up',
  binding: StepUpBinding | null,
): Promise<IssuedChallenge> {
  const challenge = randomBytes(32).toString('base64url');
  const expiresAt = new Date(input.now.getTime() + PASSKEY_CHALLENGE_TTL_MS);
  return scope.transaction(async (tx) => {
    // The session's row lock orders concurrent requests of one session, so the cap holds.
    await tx.passkeyChallenges.lockSession(input.sessionId);
    if ((await tx.passkeyChallenges.countOpen(input.sessionId, input.now)) >= MAX_OPEN_CHALLENGES) {
      throw new PasskeyError('too_many_challenges', 'too many open challenges for the session');
    }
    const row = await tx.passkeyChallenges.create({
      user_id: input.userId,
      session_id: input.sessionId,
      purpose,
      action: binding?.action ?? null,
      intent_id: binding?.intentId ?? null,
      escalation_id: binding?.escalationId ?? null,
      gate: binding?.gate ?? null,
      decision: binding?.decision ?? null,
      expected_input_sha256: binding?.expectedInputSha256 ?? null,
      request_sha256: binding?.requestSha256 ?? null,
      challenge_sha256: hashPasskeyChallenge(challenge),
      expires_at: expiresAt,
      created_at: input.now,
    });
    return { challengeId: row.id, challenge, expiresAt };
  });
}

/**
 * The open challenge of this session and purpose, for the api to check an answer against. It is
 * not used here: `registerPasskey` and `consumeStepUp` use it in their transaction.
 */
export async function openChallenge(
  scope: TenantScope,
  input: {
    readonly challengeId: string;
    readonly userId: string;
    readonly sessionId: string;
    readonly purpose: 'register' | 'step_up';
    readonly now: Date;
  },
): Promise<PasskeyChallenge> {
  const row = isUuid(input.challengeId)
    ? await scope.passkeyChallenges.getById(input.challengeId)
    : undefined;
  if (
    !row ||
    row.user_id !== input.userId ||
    row.session_id !== input.sessionId ||
    row.purpose !== input.purpose ||
    row.used_at !== null ||
    row.expires_at.getTime() <= input.now.getTime()
  ) {
    throw new PasskeyError('challenge_refused', 'the challenge cannot be used');
  }
  return row;
}

/** A passkey the api verified (`@simplewebauthn/server`), as stored. */
export interface VerifiedCredential {
  readonly credentialId: string;
  readonly publicKey: Uint8Array;
  readonly algorithm: number;
  readonly signCount: number;
  readonly aaguid: string | null;
}

export interface RegisterPasskey {
  readonly userId: string;
  readonly sessionId: string;
  /** When the session signed in with GitHub (`web_sessions.created_at`). */
  readonly signedInAt: Date;
  readonly challenge: PasskeyChallenge;
  readonly credential: VerifiedCredential;
  readonly now: Date;
}

/** Stores a verified passkey, uses its registration challenge, audits; one transaction. */
export async function registerPasskey(
  scope: TenantScope,
  input: RegisterPasskey,
): Promise<WebauthnCredential> {
  assertRecentSignIn(input.signedInAt, input.now);
  const credential = input.credential;
  if (!CREDENTIAL_ID.test(credential.credentialId)) {
    throw new PasskeyError('invalid_value', 'credential ID is invalid', 'credential_id');
  }
  if (!isSignCount(credential.signCount)) {
    throw new PasskeyError('invalid_value', 'counter is invalid', 'sign_count');
  }
  if (![-7, -8, -257].includes(credential.algorithm)) {
    throw new PasskeyError('invalid_value', 'algorithm is not allowed', 'algorithm');
  }
  return scope.transaction(async (tx) => {
    const used = await tx.passkeyChallenges.use(
      input.challenge.id,
      {
        userId: input.userId,
        sessionId: input.sessionId,
        purpose: 'register',
        challengeSha256: input.challenge.challenge_sha256,
        action: null,
        intentId: null,
        escalationId: null,
        gate: null,
        decision: null,
        expectedInputSha256: null,
        requestSha256: null,
      },
      input.now,
    );
    if (!used) throw new PasskeyError('challenge_refused', 'the challenge cannot be used');
    // The person's row lock orders concurrent registrations, so the cap holds.
    await tx.webauthnCredentials.lockUser(input.userId);
    const active = await tx.webauthnCredentials.listForUser(input.userId, true);
    if (active.length >= MAX_ACTIVE_PASSKEYS) {
      throw new PasskeyError('too_many_passkeys', 'the person holds the maximum of passkeys');
    }
    const row = await tx.webauthnCredentials.create({
      user_id: input.userId,
      credential_id: credential.credentialId,
      public_key: Buffer.from(credential.publicKey),
      algorithm: credential.algorithm,
      sign_count: credential.signCount,
      aaguid: credential.aaguid,
    });
    await tx.audit.append({
      action: 'passkey.registered',
      actorType: 'human',
      actorId: input.userId,
      entityId: input.userId,
      payload: {},
      occurredAt: input.now,
    });
    return row;
  });
}

/** Refuses a registration more than 5 minutes after the GitHub sign-in. */
export function assertRecentSignIn(signedInAt: Date, now: Date): void {
  if (now.getTime() - signedInAt.getTime() > PASSKEY_REGISTRATION_WINDOW_MS) {
    throw new PasskeyError('recent_signin_required', 'sign in with GitHub again first');
  }
}

/** A person's passkeys, active and revoked, oldest first. */
export async function listPasskeys(
  scope: TenantScope,
  userId: string,
): Promise<WebauthnCredential[]> {
  return scope.webauthnCredentials.listForUser(userId);
}

/** The active passkeys of a person, for the `allowCredentials` of a step-up. */
export async function activePasskeys(
  scope: TenantScope,
  userId: string,
): Promise<WebauthnCredential[]> {
  return scope.webauthnCredentials.listForUser(userId, true);
}

/** A person removes one of their passkeys (`self`). */
export async function revokeOwnPasskey(
  scope: TenantScope,
  userId: string,
  passkeyId: string,
  now: Date,
): Promise<WebauthnCredential> {
  return revoke(scope, userId, passkeyId, userId, 'self', now);
}

/** A tenant admin removes a person's passkey (`admin`, QUESTIONS #414). */
export async function revokeUserPasskey(
  scope: TenantScope,
  adminUserId: string,
  userId: string,
  passkeyId: string,
  now: Date,
): Promise<WebauthnCredential> {
  return scope.transaction(async (tx) => {
    await assertTenantAdmin(tx, { type: 'human', userId: adminUserId });
    const user = isUuid(userId) ? await tx.users.getById(userId) : undefined;
    if (!user) throw new AdminError('user_not_found', 'user not found');
    return revoke(tx, user.id, passkeyId, adminUserId, 'admin', now);
  });
}

/** A tenant admin lists a person's passkeys (QUESTIONS #414). */
export async function listUserPasskeys(
  scope: TenantScope,
  adminUserId: string,
  userId: string,
): Promise<WebauthnCredential[]> {
  await assertTenantAdmin(scope, { type: 'human', userId: adminUserId });
  const user = isUuid(userId) ? await scope.users.getById(userId) : undefined;
  if (!user) throw new AdminError('user_not_found', 'user not found');
  return scope.webauthnCredentials.listForUser(user.id);
}

async function revoke(
  scope: TenantScope,
  userId: string,
  passkeyId: string,
  by: string,
  reason: 'self' | 'admin',
  now: Date,
): Promise<WebauthnCredential> {
  return scope.transaction(async (tx) => {
    const revoked = isUuid(passkeyId)
      ? await tx.webauthnCredentials.revoke(passkeyId, userId, by, now)
      : undefined;
    if (!revoked) throw new PasskeyError('passkey_not_found', 'passkey not found');
    await tx.audit.append({
      action: 'passkey.revoked',
      actorType: 'human',
      actorId: by,
      entityId: userId,
      payload: { reason },
      occurredAt: now,
    });
    return revoked;
  });
}

/** A step-up the api verified: the signature held for this challenge and this passkey. */
export interface VerifiedStepUp {
  readonly challengeId: string;
  readonly challengeSha256: string;
  readonly userId: string;
  readonly sessionId: string;
  /** The passkey row (`webauthn_credentials.id`) that signed. */
  readonly passkeyId: string;
  /** The counter the authenticator reported. */
  readonly signCount: number;
}

/**
 * Uses a verified step-up for the action the caller is about to record (ADR-M73 §2.4). Call it
 * inside the transaction of the decision: the challenge is marked used and the passkey's counter
 * moves in that transaction, so a decision that rolls back leaves both as they were. Any
 * difference (another session, person or action, a used or expired challenge, a revoked passkey,
 * a counter that does not go up) refuses with one code, `step_up_refused`.
 */
export async function consumeStepUp(
  tx: TenantScope,
  verified: VerifiedStepUp,
  binding: StepUpBinding,
  now: Date,
): Promise<void> {
  assertStepUpBinding(binding);
  if (!isSignCount(verified.signCount)) {
    throw new PasskeyError('step_up_refused', 'the step-up does not hold');
  }
  await tx.transaction(async (inner) => {
    const used = await inner.passkeyChallenges.use(
      verified.challengeId,
      {
        userId: verified.userId,
        sessionId: verified.sessionId,
        purpose: 'step_up',
        challengeSha256: verified.challengeSha256,
        action: binding.action,
        intentId: binding.intentId,
        escalationId: binding.escalationId,
        gate: binding.gate,
        decision: binding.decision,
        expectedInputSha256: binding.expectedInputSha256,
        requestSha256: binding.requestSha256,
      },
      now,
    );
    if (!used) throw new PasskeyError('step_up_refused', 'the step-up does not hold');
    const counted = await inner.webauthnCredentials.recordUse(
      verified.passkeyId,
      verified.userId,
      verified.signCount,
      now,
    );
    if (!counted) throw new PasskeyError('step_up_refused', 'the step-up does not hold');
  });
}
