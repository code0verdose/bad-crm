import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createAuthApp, type AuthApp } from '../../support/auth-app.util.js';

/**
 * The two halves of password recovery on the wire.
 *
 * The property this level exists to hold is the one a use-case test cannot state as a *response*:
 * that `POST /auth/forgot-password` produces a byte-for-byte identical answer for an address that
 * exists and one that does not — same status, same (absent) body, same headers — and that the
 * refusal for an installation with no transport is identical for both as well.
 */

const IDEMPOTENCY_KEY = 'a'.repeat(32);
const KNOWN = 'ada@example.com';
const UNKNOWN = 'nobody@example.com';
const NEW_PASSWORD = 'staple-generator-lantern';

const forgot = (test: AuthApp, email: string): request.Test =>
  request(test.app)
    .post('/api/v1/auth/forgot-password')
    .set('Idempotency-Key', IDEMPOTENCY_KEY)
    .send({ email });

const reset = (test: AuthApp, body: Record<string, unknown>): request.Test =>
  request(test.app)
    .post('/api/v1/auth/reset-password')
    .set('Idempotency-Key', IDEMPOTENCY_KEY)
    .send(body);

/** The token the dispatcher was handed, lifted out of the link exactly as a browser would. */
const tokenFromMail = (test: AuthApp): string =>
  /reset-password\/([^\s"<]+)/.exec(test.dispatcher.dispatched.at(-1)?.mail.text ?? '')?.[1] ?? '';

describe('POST /api/v1/auth/forgot-password', () => {
  it('answers 202 with no body for an address that exists', async () => {
    const test = createAuthApp();

    const response = await forgot(test, KNOWN).expect(202);

    expect(response.body).toEqual({});
    expect(test.dispatcher.dispatched).toHaveLength(1);
  });

  /**
   * The whole operation, in one assertion: the two answers are compared field by field, so a
   * difference introduced anywhere — status, body, a header somebody adds on one branch — fails
   * here rather than being discovered by whoever is enumerating the installation.
   */
  it('answers an unknown address exactly as it answers a known one', async () => {
    const test = createAuthApp();

    const known = await forgot(test, KNOWN);
    const unknown = await forgot(test, UNKNOWN);

    expect(unknown.status).toBe(known.status);
    expect(unknown.body).toEqual(known.body);
    expect(unknown.text).toBe(known.text);
    expect(unknown.headers['content-type']).toBe(known.headers['content-type']);
    expect(test.dispatcher.dispatched).toHaveLength(1);
  });

  it('needs no session', async () => {
    const test = createAuthApp();

    const response = await forgot(test, KNOWN);

    expect(response.status).toBe(202);
  });

  it('requires the Idempotency-Key the contract declares', async () => {
    const test = createAuthApp();

    const response = await request(test.app)
      .post('/api/v1/auth/forgot-password')
      .send({ email: KNOWN });

    expect(response.status).toBe(422);
  });

  it('rejects a malformed address on the email field', async () => {
    const test = createAuthApp();

    const response = await forgot(test, 'not-an-address').expect(422);

    expect((response.body as { errors: { path: string }[] }).errors[0]?.path).toBe('email');
  });

  /**
   * The 503 depends on the installation and never on the address, so both spellings get it —
   * otherwise the error path is the oracle the 202 was built to avoid.
   */
  it('answers 503 for both addresses when the installation has no transport', async () => {
    const test = createAuthApp({ mailConfigured: false });

    const known = await forgot(test, KNOWN).expect(503);
    const unknown = await forgot(test, UNKNOWN).expect(503);

    expect(known.body).toMatchObject({ code: 'mail_not_configured' });
    expect(unknown.body).toMatchObject({ code: 'mail_not_configured' });
  });

  it('answers 429 over the budget, and still says nothing about the address', async () => {
    const test = createAuthApp({ rateLimit: { limits: { auth_attempt: 1 } } });

    await forgot(test, UNKNOWN).expect(202);
    const response = await forgot(test, UNKNOWN).expect(429);

    expect(response.body).toMatchObject({ code: 'rate_limited' });
  });

  it('puts neither the address nor the token into any log line', async () => {
    const test = createAuthApp();

    await forgot(test, KNOWN).expect(202);

    const written = [test.logLines().join('\n'), JSON.stringify(test.logger.lines)].join('\n');

    expect(written).not.toContain(KNOWN);
    expect(written).not.toContain(tokenFromMail(test));
    expect(written).toContain('password_reset_requested');
  });
});

describe('POST /api/v1/auth/reset-password', () => {
  const startReset = async (test: AuthApp): Promise<string> => {
    await forgot(test, KNOWN).expect(202);

    return tokenFromMail(test);
  };

  it('sets the new password, answers 204 and issues nothing', async () => {
    const test = createAuthApp();
    const token = await startReset(test);

    const response = await reset(test, { token, newPassword: NEW_PASSWORD }).expect(204);

    expect(response.body).toEqual({});
    expect(response.headers['set-cookie']).toBeUndefined();

    await request(test.app)
      .post('/api/v1/auth/login')
      .send({ email: KNOWN, password: NEW_PASSWORD })
      .expect(200);
  });

  it('closes every session the account had, including the one that asked', async () => {
    const test = createAuthApp();

    const signedIn = await request(test.app)
      .post('/api/v1/auth/login')
      .send({ email: KNOWN, password: 'correct-horse-battery' })
      .expect(200);
    const accessToken = (signedIn.body as { accessToken: string }).accessToken;

    const token = await startReset(test);

    await reset(test, { token, newPassword: NEW_PASSWORD }).expect(204);

    const after = await request(test.app)
      .get('/api/v1/auth/sessions')
      .set('Authorization', `Bearer ${accessToken}`);

    expect(after.status).toBe(401);
  });

  /**
   * A value of the right *shape* that no row matches, and a value that had a row and spent it. The
   * shape has to be right, or the schema answers first — see the length case below.
   */
  it.each([
    ['a token nobody issued', 'z'.repeat(43)],
    ['a token that was already spent', 'spent'],
  ])('answers 400 password_reset_token_invalid for %s', async (_case, marker) => {
    const test = createAuthApp();
    const token = await startReset(test);
    const presented = marker === 'spent' ? token : marker;

    if (marker === 'spent') {
      await reset(test, { token, newPassword: NEW_PASSWORD }).expect(204);
    }

    const response = await reset(test, {
      token: presented,
      newPassword: 'another-good-passphrase',
    }).expect(400);

    expect(response.body).toMatchObject({ code: 'password_reset_token_invalid', status: 400 });
  });

  /**
   * A token shorter than anything this server mints is refused by the schema, not by the store —
   * and that is not an oracle: the length is a property of what the caller sent, decided before any
   * row is read, so the answer is the same whether or not a matching row could ever have existed.
   */
  it('answers 422 for a token that is not even the right length', async () => {
    const test = createAuthApp();

    const response = await reset(test, { token: 'too-short', newPassword: NEW_PASSWORD });

    expect(response.status).toBe(422);
  });

  /**
   * And the upper bound, which the validator's own comment says is there to «stop a megabyte "token"
   * from being hashed and looked up» — a claim nothing was checking. Only the lower bound had a case,
   * so removing `.max(...)` left the suite green while handing an unbounded string to the digest and
   * the index lookup, once per request and before any budget is spent.
   */
  it('answers 422 for a token far longer than anything it mints', async () => {
    const test = createAuthApp();

    const response = await reset(test, { token: 'a'.repeat(1024), newPassword: NEW_PASSWORD });

    expect(response.status).toBe(422);
  });

  it('answers 422 on newPassword and leaves the token usable', async () => {
    const test = createAuthApp();
    const token = await startReset(test);

    const response = await reset(test, { token, newPassword: 'aaaaaaaaaaaa' }).expect(422);

    expect((response.body as { errors: { path: string }[] }).errors[0]?.path).toBe('newPassword');

    await reset(test, { token, newPassword: NEW_PASSWORD }).expect(204);
  });

  it('takes the token in the body and refuses it as a query parameter', async () => {
    const test = createAuthApp();
    const token = await startReset(test);

    const response = await request(test.app)
      .post(`/api/v1/auth/reset-password?token=${token}`)
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send({ newPassword: NEW_PASSWORD });

    expect(response.status).toBe(422);
  });

  it('needs no session', async () => {
    const test = createAuthApp();
    const token = await startReset(test);

    const response = await reset(test, { token, newPassword: NEW_PASSWORD });

    expect(response.status).toBe(204);
  });

  /**
   * The worst possible moment to fail on a letter: the person is recovering access right now, and
   * they got here *through* a mail that was delivered. `reset-password` sends no notification at
   * all — the token already proved possession of the mailbox, and every session being closed is the
   * visible signal — so there is nothing here that a transport could refuse.
   */
  it('sets the new password on an installation that cannot send mail', async () => {
    const withMail = createAuthApp();
    const token = await startReset(withMail);

    // The same token, presented to an application whose transport has since gone away: the reset
    // half must not depend on it.
    withMail.mail.configured = false;

    const response = await reset(withMail, { token, newPassword: NEW_PASSWORD });

    expect(response.status).toBe(204);

    const signedIn = await request(withMail.app)
      .post('/api/v1/auth/login')
      .send({ email: KNOWN, password: NEW_PASSWORD });

    expect(signedIn.status).toBe(200);
  });

  it('writes no token into any log line, on success or on refusal', async () => {
    const test = createAuthApp();
    const token = await startReset(test);

    await reset(test, { token, newPassword: NEW_PASSWORD }).expect(204);
    await reset(test, { token, newPassword: NEW_PASSWORD }).expect(400);

    const written = [test.logLines().join('\n'), JSON.stringify(test.logger.lines)].join('\n');

    expect(written).not.toContain(token);
    expect(written).toContain('password_reset_completed');
    expect(written).toContain('password_reset_refused');
  });
});
