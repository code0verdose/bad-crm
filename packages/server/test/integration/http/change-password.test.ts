import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createAuthApp, type AuthApp } from '../../support/auth-app.util.js';

/**
 * `POST /api/v1/auth/change-password` on the wire.
 *
 * What only this level can show: that the route is behind the authentication guard, that
 * `Idempotency-Key` is required as the contract declares it, that a wrong current password is a
 * `401` carrying `invalid_credentials` rather than a validation document, and — the acceptance
 * criterion — that the caller's own session still answers afterwards while the other one does not.
 */

const IDEMPOTENCY_KEY = 'a'.repeat(32);
const PASSWORD = 'correct-horse-battery';
const NEW_PASSWORD = 'staple-generator-lantern';

interface SignedIn {
  readonly accessToken: string;
}

const signIn = async (test: AuthApp): Promise<SignedIn> => {
  const response = await request(test.app)
    .post('/api/v1/auth/login')
    .send({ email: 'ada@example.com', password: PASSWORD })
    .expect(200);

  return { accessToken: (response.body as { accessToken: string }).accessToken };
};

const changePassword = (
  test: AuthApp,
  accessToken: string,
  body: Record<string, unknown> = { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
): request.Test =>
  request(test.app)
    .post('/api/v1/auth/change-password')
    .set('Authorization', `Bearer ${accessToken}`)
    .set('Idempotency-Key', IDEMPOTENCY_KEY)
    .send(body);

describe('POST /api/v1/auth/change-password', () => {
  it('answers 204 with no body and no new tokens', async () => {
    const test = createAuthApp();
    const session = await signIn(test);

    const response = await changePassword(test, session.accessToken).expect(204);

    expect(response.body).toEqual({});
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  /**
   * The acceptance criterion, driven end to end: two devices sign in, one of them changes the
   * password, and the *right* one keeps working.
   *
   * Asserted through the guard rather than by counting rows — what the person experiences is that
   * the browser they are in keeps answering while the other one is signed out, and that is exactly
   * what a row count cannot tell apart from the inverse.
   */
  it('keeps the calling session alive and closes the other one', async () => {
    const test = createAuthApp();
    const other = await signIn(test);
    const current = await signIn(test);

    await changePassword(test, current.accessToken).expect(204);

    const mine = await request(test.app)
      .get('/api/v1/auth/sessions')
      .set('Authorization', `Bearer ${current.accessToken}`);
    const theirs = await request(test.app)
      .get('/api/v1/auth/sessions')
      .set('Authorization', `Bearer ${other.accessToken}`);

    expect(mine.status).toBe(200);
    expect(theirs.status).toBe(401);
  });

  it('leaves exactly one session listed, and it is the caller’s own', async () => {
    const test = createAuthApp();

    await signIn(test);
    await signIn(test);
    const current = await signIn(test);

    await changePassword(test, current.accessToken).expect(204);

    const response = await request(test.app)
      .get('/api/v1/auth/sessions')
      .set('Authorization', `Bearer ${current.accessToken}`)
      .expect(200);

    const sessions = (response.body as { items: { current: boolean }[] }).items;

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.current).toBe(true);
  });

  it('accepts the new password afterwards and refuses the old one', async () => {
    const test = createAuthApp();
    const session = await signIn(test);

    await changePassword(test, session.accessToken).expect(204);

    const withOld = await request(test.app)
      .post('/api/v1/auth/login')
      .send({ email: 'ada@example.com', password: PASSWORD });
    const withNew = await request(test.app)
      .post('/api/v1/auth/login')
      .send({ email: 'ada@example.com', password: NEW_PASSWORD });

    expect(withOld.status).toBe(401);
    expect(withNew.status).toBe(200);
  });

  it('refuses a wrong current password with 401 invalid_credentials, not a validation document', async () => {
    const test = createAuthApp();
    const session = await signIn(test);

    const response = await changePassword(test, session.accessToken, {
      currentPassword: 'not-the-password',
      newPassword: NEW_PASSWORD,
    }).expect(401);

    expect(response.body).toMatchObject({ code: 'invalid_credentials', status: 401 });
    expect(response.body).not.toHaveProperty('errors');
  });

  it.each([
    ['equal to the current one', { currentPassword: PASSWORD, newPassword: PASSWORD }],
    ['too short', { currentPassword: PASSWORD, newPassword: 'short' }],
    ['refused by the policy', { currentPassword: PASSWORD, newPassword: 'aaaaaaaaaaaa' }],
  ])('answers 422 for a new password %s, naming the field', async (_case, body) => {
    const test = createAuthApp();
    const session = await signIn(test);

    const response = await changePassword(test, session.accessToken, body).expect(422);

    expect(response.body).toMatchObject({ code: 'validation_failed' });
    expect((response.body as { errors: { path: string }[] }).errors[0]?.path).toBe('newPassword');
  });

  it('rejects an unknown field instead of ignoring it', async () => {
    const test = createAuthApp();
    const session = await signIn(test);

    const response = await changePassword(test, session.accessToken, {
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
      current_password: PASSWORD,
    });

    expect(response.status).toBe(422);
  });

  it('requires the Idempotency-Key the contract declares', async () => {
    const test = createAuthApp();
    const session = await signIn(test);

    const response = await request(test.app)
      .post('/api/v1/auth/change-password')
      .set('Authorization', `Bearer ${session.accessToken}`)
      .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD });

    expect(response.status).toBe(422);
  });

  it('is behind the authentication guard', async () => {
    const test = createAuthApp();

    const response = await request(test.app)
      .post('/api/v1/auth/change-password')
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD });

    expect(response.status).toBe(401);
  });

  it('answers 429 once the attempt budget is spent', async () => {
    const test = createAuthApp({ rateLimit: { limits: { auth_attempt: 1 } } });
    const session = await signIn(test);

    await changePassword(test, session.accessToken, {
      currentPassword: 'not-the-password',
      newPassword: NEW_PASSWORD,
    }).expect(401);

    const response = await changePassword(test, session.accessToken).expect(429);

    expect(response.body).toMatchObject({ code: 'rate_limited' });
    expect(response.headers['retry-after']).toBeDefined();
  });

  /**
   * An installation with no `SMTP_URL` changes the password and sends no notice.
   *
   * The contract declares no 503 here, and the reason is the priority: a password change is a
   * recovery action, `minimal` is a supported profile that runs without SMTP, and refusing the fix
   * because the courtesy cannot be delivered inverts the two.
   */
  it('changes the password on an installation that cannot send mail', async () => {
    const test = createAuthApp({ mailConfigured: false });
    const session = await signIn(test);

    const response = await changePassword(test, session.accessToken);

    expect(response.status).toBe(204);

    const withOld = await request(test.app)
      .post('/api/v1/auth/login')
      .send({ email: 'ada@example.com', password: PASSWORD });
    const withNew = await request(test.app)
      .post('/api/v1/auth/login')
      .send({ email: 'ada@example.com', password: NEW_PASSWORD });

    expect(withOld.status).toBe(401);
    expect(withNew.status).toBe(200);
  });

  /**
   * And it says nothing about it in the answer. The response is 204 by contract; a body reporting
   * "the notice did not go out" would be a fact the caller cannot act on — only an operator can —
   * and, more decisively, a fact this process does not have yet: the message is handed over and the
   * answer is written before any transport has been consulted.
   */
  it('carries no body reporting the state of the notification', async () => {
    const test = createAuthApp({ mailConfigured: false });
    const session = await signIn(test);

    const response = await changePassword(test, session.accessToken);

    expect(response.body).toEqual({});
    expect(response.text).toBe('');
  });

  it('writes neither password nor address into any log line', async () => {
    const test = createAuthApp();
    const session = await signIn(test);

    await changePassword(test, session.accessToken).expect(204);

    const written = [test.logLines().join('\n'), JSON.stringify(test.logger.lines)].join('\n');

    expect(written).not.toContain(PASSWORD);
    expect(written).not.toContain(NEW_PASSWORD);
    expect(written).not.toContain('ada@example.com');
    expect(written).toContain('password_changed');
  });
});
