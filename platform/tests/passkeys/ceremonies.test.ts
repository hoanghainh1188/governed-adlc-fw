// D-08 U06 AC3–AC5 without a database: the WebAuthn ceremonies of the api (`@simplewebauthn/server`
// 14.0.3) against a software passkey, the step-up binding rules and request hash of core, and the
// CSRF token derivation (design/ADR-M73 §2.3, §2.4; QUESTIONS #410, #411, #413).
import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  PasskeyCheckError,
  WebAuthnCeremonies,
  coseAlgorithm,
} from '../../apps/api/src/passkeys/webauthn.js';
import {
  ADMIN_STEP_UP_ACTIONS,
  PasskeyError,
  assertRecentSignIn,
  assertStepUpBinding,
  hashPasskeyChallenge,
  stepUpRequestSha256,
  type StepUpBinding,
} from '../../packages/core/src/passkeys/index.js';
import { deriveCsrfToken, hashCsrfToken } from '../../packages/core/src/web-sessions/index.js';
import { passkeySchema, authConfigSchema } from '../../packages/api-schemas/src/index.js';
import { presentPasskey } from '../../apps/api/src/passkeys/passkeys.controller.js';
import { SoftAuthenticator } from './soft-authenticator.js';

const ORIGIN = 'http://localhost:8090';
const challenge = (): string => randomBytes(32).toString('base64url');
const USER = {
  id: '0b5c1e9e-1a7e-4c4f-9a65-5d1f1c2b3a4d',
  email: 'a@x.example.com',
  displayName: 'A',
};

async function registered(ceremonies: WebAuthnCeremonies, key: SoftAuthenticator) {
  const c = challenge();
  const options = await ceremonies.registrationOptions({ challenge: c, user: USER, exclude: [] });
  expect(options.challenge).toBe(c);
  return ceremonies.verifyRegistration(key.register(options) as never, hashPasskeyChallenge(c));
}

describe('U06: WebAuthn ceremonies', () => {
  const ceremonies = new WebAuthnCeremonies(ORIGIN);

  it('the site name is the public origin host; user verification required; three algorithms', async () => {
    expect(ceremonies.rpId).toBe('localhost');
    const options = await ceremonies.registrationOptions({
      challenge: challenge(),
      user: USER,
      exclude: ['A'.repeat(43)],
    });
    expect(options.rp.id).toBe('localhost');
    expect(options.attestation).toBe('none');
    expect(options.authenticatorSelection?.userVerification).toBe('required');
    expect(options.pubKeyCredParams.map((p) => p.alg).sort((a, b) => a - b)).toEqual([
      -257, -8, -7,
    ]);
    expect(options.excludeCredentials).toEqual([{ id: 'A'.repeat(43), type: 'public-key' }]);
    expect(options.timeout).toBe(120_000);
    expect(new WebAuthnCeremonies('https://sdlc.example.com:8443').rpId).toBe('sdlc.example.com');
  });

  it('registers a passkey, then checks a step-up answer and its counter', async () => {
    const key = new SoftAuthenticator({ origin: ORIGIN });
    const credential = await registered(ceremonies, key);
    expect(credential).toMatchObject({
      credentialId: key.id,
      algorithm: -7,
      signCount: 1,
      aaguid: null,
    });
    const c = challenge();
    const options = await ceremonies.authenticationOptions({ challenge: c, allow: [key.id] });
    expect(options.userVerification).toBe('required');
    const counter = await ceremonies.verifyAuthentication(
      key.authenticate({ challenge: c }) as never,
      hashPasskeyChallenge(c),
      { credentialId: key.id, publicKey: credential.publicKey, signCount: credential.signCount },
    );
    expect(counter).toBe(2);
  });

  it('refuses another challenge, another origin, no user verification, a counter going back', async () => {
    const key = new SoftAuthenticator({ origin: ORIGIN });
    const credential = await registered(ceremonies, key);
    const stored = { credentialId: key.id, publicKey: credential.publicKey, signCount: 5 };
    const check = (answer: unknown, sha: string) =>
      ceremonies.verifyAuthentication(answer as never, sha, stored);
    const c = challenge();
    await expect(
      check(key.authenticate({ challenge: c }), hashPasskeyChallenge(challenge())),
    ).rejects.toBeInstanceOf(PasskeyCheckError);
    // The counter of this answer (2) is below the stored one (5): a cloned authenticator.
    await expect(
      check(key.authenticate({ challenge: c }), hashPasskeyChallenge(c)),
    ).rejects.toBeInstanceOf(PasskeyCheckError);
    key.setCounter(10);
    key.origin = 'http://evil.localhost:8090';
    await expect(
      check(key.authenticate({ challenge: c }), hashPasskeyChallenge(c)),
    ).rejects.toBeInstanceOf(PasskeyCheckError);
    key.origin = ORIGIN;
    key.userVerified = false;
    await expect(
      check(key.authenticate({ challenge: c }), hashPasskeyChallenge(c)),
    ).rejects.toBeInstanceOf(PasskeyCheckError);
    await expect(check({ id: key.id }, hashPasskeyChallenge(c))).rejects.toBeInstanceOf(
      PasskeyCheckError,
    );
  });

  it('refuses a registration without user verification or for another site', async () => {
    const unverified = new SoftAuthenticator({ origin: ORIGIN, userVerified: false });
    await expect(registered(ceremonies, unverified)).rejects.toBeInstanceOf(PasskeyCheckError);
    const elsewhere = new SoftAuthenticator({ origin: 'https://other.example.com' });
    await expect(registered(ceremonies, elsewhere)).rejects.toBeInstanceOf(PasskeyCheckError);
  });

  it('coseAlgorithm reads ES256 and refuses junk', () => {
    expect(() => coseAlgorithm(new Uint8Array([1, 2, 3]))).toThrow(PasskeyCheckError);
  });
});

describe('U06: the step-up binding (QUESTIONS #411)', () => {
  const base: StepUpBinding = {
    action: 'gate.decide',
    intentId: '0b5c1e9e-1a7e-4c4f-9a65-5d1f1c2b3a4d',
    escalationId: null,
    gate: 'G3',
    decision: 'approve',
    expectedInputSha256: 'a'.repeat(64),
    requestSha256: 'b'.repeat(64),
  };

  it('the request hash is RFC 8785: key order and spacing do not matter', () => {
    expect(stepUpRequestSha256({ decision: 'approve', reason_code: null })).toBe(
      stepUpRequestSha256(JSON.parse('{ "reason_code": null,  "decision": "approve" }')),
    );
    expect(stepUpRequestSha256({ decision: 'approve' })).not.toBe(
      stepUpRequestSha256({ decision: 'reject' }),
    );
    expect(stepUpRequestSha256({ decision: 'approve' })).toMatch(/^[0-9a-f]{64}$/);
  });

  it('accepts the two shapes; refuses anything else', () => {
    expect(() => assertStepUpBinding(base)).not.toThrow();
    expect(() =>
      assertStepUpBinding({
        ...base,
        action: 'escalation.decide',
        intentId: null,
        gate: null,
        escalationId: base.intentId,
        expectedInputSha256: null,
        decision: 'resume',
      }),
    ).not.toThrow();
    for (const bad of [
      { action: 'gate.kill' },
      { gate: null },
      { gate: 'G9' },
      { intentId: null },
      { escalationId: base.intentId },
      { decision: 'Approve now' },
      { requestSha256: 'x' },
      { expectedInputSha256: 'A'.repeat(64) },
    ] as Partial<StepUpBinding>[]) {
      expect(() => assertStepUpBinding({ ...base, ...bad }), JSON.stringify(bad)).toThrow(
        PasskeyError,
      );
    }
  });

  it('U09: an administration change binds no intent, escalation, gate or input hash', () => {
    const admin: StepUpBinding = {
      action: 'admin.project',
      intentId: null,
      escalationId: null,
      gate: null,
      decision: 'role_grant',
      expectedInputSha256: null,
      requestSha256: base.requestSha256,
    };
    for (const action of ADMIN_STEP_UP_ACTIONS) {
      expect(() => assertStepUpBinding({ ...admin, action })).not.toThrow();
    }
    for (const bad of [
      { action: 'admin.tokens' },
      { intentId: base.intentId },
      { escalationId: base.intentId },
      { gate: 'G3' },
      { expectedInputSha256: 'a'.repeat(64) },
      { decision: null },
      { decision: 'Role grant' },
    ] as Partial<StepUpBinding>[]) {
      expect(() => assertStepUpBinding({ ...admin, ...bad }), JSON.stringify(bad)).toThrow(
        PasskeyError,
      );
    }
  });

  it('a passkey is registered within 5 minutes of the GitHub sign-in', () => {
    const at = new Date('2026-10-12T10:00:00Z');
    expect(() => assertRecentSignIn(at, new Date(at.getTime() + 5 * 60_000))).not.toThrow();
    expect(() => assertRecentSignIn(at, new Date(at.getTime() + 5 * 60_000 + 1))).toThrowError(
      expect.objectContaining({ code: 'recent_signin_required' }),
    );
  });
});

describe('U06: the CSRF token (QUESTIONS #410)', () => {
  it('is derived from the session secret, stable, and differs per session', () => {
    const secret = randomBytes(32).toString('base64url');
    const token = deriveCsrfToken(secret);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(deriveCsrfToken(secret)).toBe(token);
    expect(deriveCsrfToken(randomBytes(32).toString('base64url'))).not.toBe(token);
    expect(token).not.toBe(secret);
    expect(hashCsrfToken(token)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('U06: shared response schemas', () => {
  it('a presented passkey parses; it holds no key, counter or credential ID', () => {
    const body = presentPasskey({
      id: '0b5c1e9e-1a7e-4c4f-9a65-5d1f1c2b3a4d',
      tenant_id: '1b5c1e9e-1a7e-4c4f-9a65-5d1f1c2b3a4d',
      user_id: '2b5c1e9e-1a7e-4c4f-9a65-5d1f1c2b3a4d',
      credential_id: 'C'.repeat(43),
      public_key: Buffer.alloc(77),
      algorithm: -7,
      sign_count: '3',
      aaguid: null,
      last_used_at: null,
      revoked_at: null,
      revoked_by: null,
      created_at: new Date('2026-10-12T10:00:00Z'),
    });
    expect(passkeySchema.parse(body)).toEqual(body);
    expect(Object.keys(body).sort()).toEqual(
      ['aaguid', 'created_at', 'id', 'last_used_at', 'revoked_at'].sort(),
    );
  });

  it('auth config without `actions` (an older API) means off', () => {
    expect(authConfigSchema.parse({ github: true })).toEqual({ github: true, actions: false });
  });
});
