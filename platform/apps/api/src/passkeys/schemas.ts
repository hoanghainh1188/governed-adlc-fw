// Request schemas of the passkey and step-up endpoints (task U06, design/ADR-M73 §2.4). Shapes and
// sizes only: `@simplewebauthn/server` checks the WebAuthn answers, core checks the binding.
import { GATE_CODES } from '@sdlc/contracts';
import { ADMIN_STEP_UP_ACTIONS, STEP_UP_ACTIONS } from '@sdlc/core';
import { z } from 'zod';

import { idSchema } from '../admin/schemas.js';

const b64url = (max: number) =>
  z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/)
    .max(max);
const credentialId = b64url(1366).min(16);

/** The browser's `PublicKeyCredential.toJSON()` of a registration (WebAuthn L3). */
export const registrationResponseSchema = z.object({
  id: credentialId,
  rawId: credentialId,
  type: z.literal('public-key'),
  response: z.object({
    clientDataJSON: b64url(4096),
    attestationObject: b64url(16_384),
    transports: z.array(z.string().max(32)).max(10).optional(),
    publicKeyAlgorithm: z.number().int().optional(),
    publicKey: b64url(4096).optional(),
    authenticatorData: b64url(8192).optional(),
  }),
  authenticatorAttachment: z.enum(['platform', 'cross-platform']).optional(),
  clientExtensionResults: z.record(z.string(), z.unknown()),
});

/** The browser's `PublicKeyCredential.toJSON()` of an assertion (WebAuthn L3). */
export const authenticationResponseSchema = z.object({
  id: credentialId,
  rawId: credentialId,
  type: z.literal('public-key'),
  response: z.object({
    clientDataJSON: b64url(4096),
    authenticatorData: b64url(8192),
    signature: b64url(2048),
    userHandle: b64url(512).optional(),
  }),
  authenticatorAttachment: z.enum(['platform', 'cross-platform']).optional(),
  clientExtensionResults: z.record(z.string(), z.unknown()),
});

export const registerPasskeySchema = z.strictObject({
  challenge_id: idSchema,
  response: registrationResponseSchema,
});

/** The decision body a step-up is bound to: a flat JSON object, small. */
const decisionBody = z
  .record(z.string().max(64), z.unknown())
  .refine((body) => JSON.stringify(body).length <= 8192, { message: 'too_large' })
  .refine((body) => typeof body.decision === 'string', { message: 'decision' });

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

export const stepUpRequestSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal(STEP_UP_ACTIONS[0]),
    intent: z.string().min(1).max(64),
    gate: z.enum(GATE_CODES),
    expected_input_sha256: sha256.optional(),
    request: decisionBody,
  }),
  z.strictObject({
    action: z.literal(STEP_UP_ACTIONS[1]),
    escalation: z.string().min(1).max(64),
    expected_input_sha256: sha256.optional(),
    request: decisionBody,
  }),
  // L05 (ADR-M82 §2.7): the body the plan endpoint will receive, with `decision` (`create`,
  // `change`, `run`) and `target` (the project's slug for create, else the plan's ID).
  z.strictObject({
    action: z.enum([STEP_UP_ACTIONS[2], STEP_UP_ACTIONS[3], STEP_UP_ACTIONS[4]]),
    request: decisionBody.refine((body) => typeof body.target === 'string', {
      message: 'target',
    }),
  }),
  // U09 (ADR-M73 §2.4b, QUESTIONS #685): the body the admin endpoint will receive, with
  // `decision` (the change) and `target` (the path it writes to, for example
  // `/v1/admin/projects/web/roles/<id>`).
  z.strictObject({
    action: z.enum(ADMIN_STEP_UP_ACTIONS),
    request: decisionBody.refine((body) => typeof body.target === 'string', {
      message: 'target',
    }),
  }),
]);

/** The passkey answer a decision carries (`step_up`, used from U07). */
export const stepUpAnswerSchema = z.strictObject({
  challenge_id: idSchema,
  response: authenticationResponseSchema,
});
