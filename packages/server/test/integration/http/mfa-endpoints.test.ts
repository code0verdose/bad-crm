import { generateSync } from 'otplib';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createAuthApp, type AuthApp } from '../../support/auth-app.util.js';

/**
 * The 2FA surface on the wire: `POST /auth/2fa/setup`, `POST /auth/2fa/confirm`,
 * `GET /auth/2fa/recovery-codes`, `POST /auth/2fa/recovery-codes/regenerate`,
 * `POST /auth/2fa/disable`.
 *
 * What only this level can show: that the routes sit behind the authentication guard as
 * self-service (no capability check), that `Idempotency-Key` is required where the contract
 * declares it, and that the full stack — validator, controller, real `OtplibTotpAdapter`,
 * `AesFieldEncryption`, `CsprngRecoveryCodeGenerator` — agrees on one otpauth secret end to end. The
 * harness wires real crypto adapters for this surface (`auth-app.util.ts`) rather than scripted
 * doubles, specifically so a code computed by `otplib` here is accepted by the adapter the
 * application actually runs.
 */

const PASSWORD = 'correct-horse-battery';
const IDEMPOTENCY_KEY = 'a'.repeat(32);

interface SignedIn {
  readonly accessToken: string;
}

const signIn = async (test: AuthApp): Promise<SignedIn> => {
  const response = await request(test.server())
    .post('/api/v1/auth/login')
    .send({ email: 'ada@example.com', password: PASSWORD })
    .expect(200);

  return { accessToken: (response.body as { accessToken: string }).accessToken };
};

/**
 * A valid TOTP code for `secret`, computed with the same parameters the adapter verifies against —
 * critically, at the harness's own `FakeClock` time rather than the real system clock: the
 * application checks the code against `clock.now()`, and the two run on different epochs unless
 * this is pinned to match.
 */
const codeFor = (secret: string, at: Date): string =>
  generateSync({
    secret,
    algorithm: 'sha1',
    digits: 6,
    period: 30,
    epoch: Math.floor(at.getTime() / 1000),
  });

const authed = (test: AuthApp, accessToken: string): request.Agent =>
  request
    .agent(test.server())
    .set('Authorization', `Bearer ${accessToken}`) as unknown as request.Agent;

describe('POST /api/v1/auth/2fa/setup', () => {
  it('drafts a secret and returns it with its URI and QR code, without enabling 2FA', async () => {
    const test = createAuthApp();
    const session = await signIn(test);

    const response = await request(test.server())
      .post('/api/v1/auth/2fa/setup')
      .set('Authorization', `Bearer ${session.accessToken}`)
      .expect(200);

    const body = response.body as { secret: string; uri: string; qrSvg: string };

    expect(body.secret).toMatch(/^[A-Z2-7]+$/);
    expect(body.uri).toContain(body.secret);
    expect(body.qrSvg).toContain('<svg');
  });

  it('refuses without a session', async () => {
    const test = createAuthApp();

    const response = await request(test.server()).post('/api/v1/auth/2fa/setup').expect(401);

    expect((response.body as { code: string }).code).toBe('unauthenticated');
  });

  /** M-4: this response carries the base32 secret and an otpauth:// URI that embeds it. */
  it('answers Cache-Control: private, no-store', async () => {
    const test = createAuthApp();
    const session = await signIn(test);

    const response = await request(test.server())
      .post('/api/v1/auth/2fa/setup')
      .set('Authorization', `Bearer ${session.accessToken}`)
      .expect(200);

    expect(response.headers['cache-control']).toBe('private, no-store');
  });
});

describe('POST /api/v1/auth/2fa/confirm', () => {
  it('enables 2FA and returns ten recovery codes for a correct code', async () => {
    const test = createAuthApp();
    const session = await signIn(test);

    const setup = await request(test.server())
      .post('/api/v1/auth/2fa/setup')
      .set('Authorization', `Bearer ${session.accessToken}`)
      .expect(200);

    const { secret } = setup.body as { secret: string };

    const response = await request(test.server())
      .post('/api/v1/auth/2fa/confirm')
      .set('Authorization', `Bearer ${session.accessToken}`)
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send({ code: codeFor(secret, test.clock.now()), currentPassword: PASSWORD })
      .expect(200);

    const body = response.body as { codes: string[] };

    expect(body.codes).toHaveLength(10);
    expect(new Set(body.codes).size).toBe(10);
    // M-4: ten plaintext recovery codes, shown exactly once.
    expect(response.headers['cache-control']).toBe('private, no-store');
  });

  /**
   * H-1 (security-gate addendum): a bearer token alone is not proof of the account owner. Without
   * this wall a hijacked session — no password in hand — could point a victim's account at an
   * attacker-controlled authenticator, a durable takeover a stolen-cookie mitigation cannot undo.
   */
  it('refuses a correct code presented with the wrong password, and enables nothing', async () => {
    const test = createAuthApp();
    const session = await signIn(test);

    const setup = await request(test.server())
      .post('/api/v1/auth/2fa/setup')
      .set('Authorization', `Bearer ${session.accessToken}`)
      .expect(200);

    const { secret } = setup.body as { secret: string };

    const response = await request(test.server())
      .post('/api/v1/auth/2fa/confirm')
      .set('Authorization', `Bearer ${session.accessToken}`)
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send({
        code: codeFor(secret, test.clock.now()),
        currentPassword: 'entirely-the-wrong-password',
      })
      .expect(403);

    expect((response.body as { code: string }).code).toBe('reauthentication_required');

    const status = await authed(test, session.accessToken)
      .get('/api/v1/auth/2fa/recovery-codes')
      .expect(200);

    expect(status.body).toEqual({ total: 0, remaining: 0 });
  });

  it('refuses a wrong code with invalid_totp_code and does not enable 2FA', async () => {
    const test = createAuthApp();
    const session = await signIn(test);

    await request(test.server())
      .post('/api/v1/auth/2fa/setup')
      .set('Authorization', `Bearer ${session.accessToken}`)
      .expect(200);

    const response = await request(test.server())
      .post('/api/v1/auth/2fa/confirm')
      .set('Authorization', `Bearer ${session.accessToken}`)
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send({ code: '000000', currentPassword: PASSWORD })
      .expect(422);

    expect((response.body as { code: string }).code).toBe('invalid_totp_code');
  });

  it('refuses a malformed code at the validator, before any use-case runs', async () => {
    const test = createAuthApp();
    const session = await signIn(test);

    const response = await request(test.server())
      .post('/api/v1/auth/2fa/confirm')
      .set('Authorization', `Bearer ${session.accessToken}`)
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send({ code: 'not-six-digits', currentPassword: PASSWORD })
      .expect(422);

    expect((response.body as { code: string }).code).toBe('validation_failed');
  });
});

describe('GET /api/v1/auth/2fa/recovery-codes', () => {
  it('answers zero and zero before any enrolment', async () => {
    const test = createAuthApp();
    const session = await signIn(test);

    const response = await authed(test, session.accessToken)
      .get('/api/v1/auth/2fa/recovery-codes')
      .expect(200);

    expect(response.body).toEqual({ total: 0, remaining: 0 });
  });

  it('answers the count after enrolment, and never the plaintext codes again', async () => {
    const test = createAuthApp();
    const session = await signIn(test);

    const setup = await authed(test, session.accessToken)
      .post('/api/v1/auth/2fa/setup')
      .expect(200);
    const { secret } = setup.body as { secret: string };

    await authed(test, session.accessToken)
      .post('/api/v1/auth/2fa/confirm')
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send({ code: codeFor(secret, test.clock.now()), currentPassword: PASSWORD })
      .expect(200);

    const status = await authed(test, session.accessToken)
      .get('/api/v1/auth/2fa/recovery-codes')
      .expect(200);

    expect(status.body).toEqual({ total: 10, remaining: 10 });
    expect(JSON.stringify(status.body)).not.toMatch(/codes/i);
  });
});

describe('POST /api/v1/auth/2fa/recovery-codes/regenerate', () => {
  /** Enrols and hands back the otpauth secret, which regenerating needs to prove a *live* code. */
  const enroll = async (test: AuthApp, accessToken: string): Promise<string> => {
    const setup = await authed(test, accessToken).post('/api/v1/auth/2fa/setup').expect(200);
    const { secret } = setup.body as { secret: string };

    await authed(test, accessToken)
      .post('/api/v1/auth/2fa/confirm')
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send({ code: codeFor(secret, test.clock.now()), currentPassword: PASSWORD })
      .expect(200);

    return secret;
  };

  it('replaces the set when the password and a live TOTP code are both correct', async () => {
    const test = createAuthApp();
    const session = await signIn(test);
    const secret = await enroll(test, session.accessToken);

    // Past the step `confirm` just spent: the same code inside the same window is a replay, and the
    // anti-replay counter would refuse it — so the proof here has to be a genuinely newer code.
    test.clock.advance(60);

    const response = await authed(test, session.accessToken)
      .post('/api/v1/auth/2fa/recovery-codes/regenerate')
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send({ currentPassword: PASSWORD, totpCode: codeFor(secret, test.clock.now()) })
      .expect(200);

    expect((response.body as { codes: string[] }).codes).toHaveLength(10);
    expect(response.headers['cache-control']).toBe('private, no-store');
  });

  it('refuses a wrong TOTP code presented with the right password', async () => {
    const test = createAuthApp();
    const session = await signIn(test);

    await enroll(test, session.accessToken);

    const response = await authed(test, session.accessToken)
      .post('/api/v1/auth/2fa/recovery-codes/regenerate')
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send({ currentPassword: PASSWORD, totpCode: '000000' })
      .expect(403);

    expect((response.body as { code: string }).code).toBe('reauthentication_required');
  });

  it('refuses a wrong password even with 2FA not enrolled at all, without disclosing that fact', async () => {
    const test = createAuthApp();
    const session = await signIn(test);

    const response = await authed(test, session.accessToken)
      .post('/api/v1/auth/2fa/recovery-codes/regenerate')
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send({ currentPassword: 'wrong-password-entirely', totpCode: '000000' })
      .expect(403);

    expect((response.body as { code: string }).code).toBe('reauthentication_required');
  });

  it('refuses without a session', async () => {
    const test = createAuthApp();

    const response = await request(test.server())
      .post('/api/v1/auth/2fa/recovery-codes/regenerate')
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send({ currentPassword: PASSWORD, totpCode: '000000' })
      .expect(401);

    expect((response.body as { code: string }).code).toBe('unauthenticated');
  });
});

describe('POST /api/v1/auth/2fa/disable', () => {
  /** Enrols and returns the first of the ten plaintext recovery codes — the material `disable`
   *  needs to test the recovery-code half of acceptance 2 without depending on a live TOTP window. */
  const enrollAndCollectFirstCode = async (test: AuthApp, accessToken: string): Promise<string> => {
    const setup = await authed(test, accessToken).post('/api/v1/auth/2fa/setup').expect(200);
    const { secret } = setup.body as { secret: string };

    const confirmed = await authed(test, accessToken)
      .post('/api/v1/auth/2fa/confirm')
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send({ code: codeFor(secret, test.clock.now()), currentPassword: PASSWORD })
      .expect(200);

    const [code] = (confirmed.body as { codes: string[] }).codes;

    if (code === undefined) throw new Error('confirm did not return any recovery codes');

    return code;
  };

  it('turns 2FA off with a correct password and an unused recovery code — acceptance 2', async () => {
    const test = createAuthApp();
    const session = await signIn(test);
    const code = await enrollAndCollectFirstCode(test, session.accessToken);

    await authed(test, session.accessToken)
      .post('/api/v1/auth/2fa/disable')
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send({ password: PASSWORD, code })
      .expect(204);

    const status = await authed(test, session.accessToken)
      .get('/api/v1/auth/2fa/recovery-codes')
      .expect(200);

    // Every code — the one just used to disable, and the nine untouched — is gone in the same
    // transaction (acceptance 1).
    expect(status.body).toEqual({ total: 0, remaining: 0 });
  });

  it('refuses a correct recovery code presented with the wrong password, and disables nothing — acceptance 3', async () => {
    const test = createAuthApp();
    const session = await signIn(test);
    const code = await enrollAndCollectFirstCode(test, session.accessToken);

    const response = await authed(test, session.accessToken)
      .post('/api/v1/auth/2fa/disable')
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send({ password: 'entirely-the-wrong-password', code })
      .expect(403);

    expect((response.body as { code: string }).code).toBe('reauthentication_required');

    const status = await authed(test, session.accessToken)
      .get('/api/v1/auth/2fa/recovery-codes')
      .expect(200);

    // 2FA is still on and the recovery code presented is still there to try again with the right
    // password — a wrong password must not burn it.
    expect(status.body).toEqual({ total: 10, remaining: 10 });
  });

  it('refuses a missing/wrong code with the correct password — acceptance 2', async () => {
    const test = createAuthApp();
    const session = await signIn(test);

    await enrollAndCollectFirstCode(test, session.accessToken);

    const response = await authed(test, session.accessToken)
      .post('/api/v1/auth/2fa/disable')
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send({ password: PASSWORD, code: 'ZZZZZ99999' })
      .expect(403);

    expect((response.body as { code: string }).code).toBe('reauthentication_required');
  });

  it('refuses without a session', async () => {
    const test = createAuthApp();

    const response = await request(test.server())
      .post('/api/v1/auth/2fa/disable')
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send({ password: PASSWORD, code: '000000' })
      .expect(401);

    expect((response.body as { code: string }).code).toBe('unauthenticated');
  });

  it('refuses a malformed body at the validator, before any use-case runs', async () => {
    const test = createAuthApp();
    const session = await signIn(test);

    const response = await authed(test, session.accessToken)
      .post('/api/v1/auth/2fa/disable')
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send({ password: PASSWORD })
      .expect(422);

    expect((response.body as { code: string }).code).toBe('validation_failed');
  });
});

/**
 * The step that makes 2FA mean anything: sign-in reading the second factor.
 *
 * Everything above enables and disables it. Until this route existed, a person could turn 2FA on
 * and the sign-in form would still let their password alone through — the feature was decorative,
 * which is exactly why STORY-013-03 blocked on an exit existing first.
 *
 * Only this level shows the two halves agreeing on the wire: that `POST /auth/login` stops at an
 * intermediate token and sets **no** cookie, and that the same token plus a live code comes back as
 * a real session from the identical stack the product runs.
 */
describe('POST /api/v1/auth/2fa/verify', () => {
  /** Enrols and hands back the secret, so a scenario can compute a live code for itself. */
  const enrol = async (test: AuthApp, accessToken: string): Promise<string> => {
    const setup = await authed(test, accessToken).post('/api/v1/auth/2fa/setup').expect(200);
    const { secret } = setup.body as { secret: string };

    await authed(test, accessToken)
      .post('/api/v1/auth/2fa/confirm')
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send({ code: codeFor(secret, test.clock.now()), currentPassword: PASSWORD })
      .expect(200);

    // Past the 30-second step that `confirm` just consumed. Without it the sign-in below would
    // present the identical code, and the anti-replay predicate would refuse it as
    // `mfa_code_replayed` — correctly: the same digits inside one step *are* a replay, whichever
    // endpoint saw them first. The clock is the harness's own, which is also what the adapter reads.
    test.clock.advance(31);

    return secret;
  };

  it('stops sign-in at an intermediate token once 2FA is on — acceptance 1', async () => {
    const test = createAuthApp();
    const first = await signIn(test);
    await enrol(test, first.accessToken);

    const response = await request(test.server())
      .post('/api/v1/auth/login')
      .send({ email: 'ada@example.com', password: PASSWORD })
      .expect(200);

    const body = response.body as { status: string; mfaToken?: string; accessToken?: string };

    expect(body.status).toBe('mfa_required');
    expect(body.mfaToken).toEqual(expect.any(String));
    // No session, and no half of one: the access token is absent from the body and the refresh
    // cookie was never set. A `Set-Cookie` here would hand out the durable half of a session to
    // somebody who has presented exactly one factor.
    expect(body.accessToken).toBeUndefined();
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('exchanges the token and a live code for a session — acceptance 2', async () => {
    const test = createAuthApp();
    const first = await signIn(test);
    const secret = await enrol(test, first.accessToken);

    const pending = await request(test.server())
      .post('/api/v1/auth/login')
      .send({ email: 'ada@example.com', password: PASSWORD })
      .expect(200);

    const { mfaToken } = pending.body as { mfaToken: string };

    const verified = await request(test.server())
      .post('/api/v1/auth/2fa/verify')
      .send({ mfaToken, code: codeFor(secret, test.clock.now()) })
      .expect(200);

    const session = verified.body as { status: string; accessToken: string };

    expect(session.status).toBe('authenticated');
    expect(session.accessToken).toEqual(expect.any(String));
    expect(verified.headers['set-cookie']).toBeDefined();
  });

  it('refuses the same token a second time — acceptance 2, one use only', async () => {
    const test = createAuthApp();
    const first = await signIn(test);
    const secret = await enrol(test, first.accessToken);

    const pending = await request(test.server())
      .post('/api/v1/auth/login')
      .send({ email: 'ada@example.com', password: PASSWORD })
      .expect(200);

    const { mfaToken } = pending.body as { mfaToken: string };
    const code = codeFor(secret, test.clock.now());

    await request(test.server())
      .post('/api/v1/auth/2fa/verify')
      .send({ mfaToken, code })
      .expect(200);

    // The second attempt is refused by the denylist rather than by the code being stale — the same
    // token, replayed, is what a stolen intermediate credential looks like.
    const replayed = await request(test.server())
      .post('/api/v1/auth/2fa/verify')
      .send({ mfaToken, code })
      .expect(401);

    expect((replayed.body as { code: string }).code).toBe('mfa_token_expired');
  });

  it('refuses a wrong code without spending the token — acceptance 5', async () => {
    const test = createAuthApp();
    const first = await signIn(test);
    const secret = await enrol(test, first.accessToken);

    const pending = await request(test.server())
      .post('/api/v1/auth/login')
      .send({ email: 'ada@example.com', password: PASSWORD })
      .expect(200);

    const { mfaToken } = pending.body as { mfaToken: string };

    const refused = await request(test.server())
      .post('/api/v1/auth/2fa/verify')
      .send({ mfaToken, code: '000000' })
      .expect(401);

    expect((refused.body as { code: string }).code).toBe('mfa_invalid_code');

    // Still usable: a mistyped digit must not cost the whole sign-in, which is the difference
    // between the attempt counter and the token being voided outright.
    await request(test.server())
      .post('/api/v1/auth/2fa/verify')
      .send({ mfaToken, code: codeFor(secret, test.clock.now()) })
      .expect(200);
  });
});
