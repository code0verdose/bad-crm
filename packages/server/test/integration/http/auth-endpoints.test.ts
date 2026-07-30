import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { ORGANIZATION_ID, USER_ID, authUser } from '../../support/identity-doubles.util.js';
import { createAuthApp, type AuthApp } from '../../support/auth-app.util.js';

/**
 * The authentication surface as a client sees it: statuses, bodies, and the cookie.
 *
 * Two properties are asserted here and nowhere else, because only the wire can show them:
 *
 *   1. **the refresh token is in `Set-Cookie` and in no body, ever** — the rule the whole split
 *      between a fifteen-minute token and a thirty-day one depends on (`docs/api/openapi.yaml`,
 *      «Two rules hold across the whole group»);
 *   2. **the cookie carries the attributes the contract publishes** — `HttpOnly`, `Secure`,
 *      `SameSite=Lax` and `Path=/api/v1/auth`. Each removes a different attack, and each is
 *      invisible to every test that stops at the JSON.
 */

const IDEMPOTENCY_KEY = 'a'.repeat(32);
const PASSWORD = 'correct-horse-battery';
const ORIGIN = 'https://crm.example.com';

const REGISTRATION = {
  organization: { name: 'Bad Company', slug: 'bad-company' },
  owner: { email: 'ada@example.com', password: PASSWORD },
};

const cookiesOf = (response: { headers: Record<string, unknown> }): string[] => {
  const header = response.headers['set-cookie'];

  return Array.isArray(header) ? (header as string[]) : [];
};

const refreshCookie = (response: { headers: Record<string, unknown> }): string =>
  cookiesOf(response).find((cookie) => cookie.startsWith('bad_crm_refresh=')) ?? '';

/** The `name=value` pair a browser would send back. */
const cookieHeader = (response: { headers: Record<string, unknown> }): string =>
  refreshCookie(response).split(';')[0] ?? '';

const signIn = async (
  test: AuthApp,
): Promise<{ accessToken: string; cookie: string; sessionId: string }> => {
  const response = await request(test.app)
    .post('/api/v1/auth/login')
    .send({ email: 'ada@example.com', password: PASSWORD })
    .expect(200);

  return {
    accessToken: (response.body as { accessToken: string }).accessToken,
    cookie: cookieHeader(response),
    sessionId: [...test.sessions.rows.values()].at(-1)?.id ?? '',
  };
};

describe('POST /api/v1/auth/register', () => {
  it('creates the organization, signs the owner in and sets the refresh cookie', async () => {
    const test = createAuthApp();

    const response = await request(test.app)
      .post('/api/v1/auth/register')
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send(REGISTRATION)
      .expect(201);

    expect(response.body).toMatchObject({
      status: 'authenticated',
      tokenType: 'Bearer',
      expiresIn: 900,
      user: { email: 'ada@example.com', locale: 'en', timezone: 'UTC' },
      organization: { name: 'Bad Company', slug: 'bad-company' },
    });
    expect(refreshCookie(response)).not.toBe('');
  });

  it('carries every cookie attribute the contract publishes', async () => {
    const test = createAuthApp();

    const response = await request(test.app)
      .post('/api/v1/auth/register')
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send(REGISTRATION)
      .expect(201);

    const cookie = refreshCookie(response);

    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/api/v1/auth');
  });

  /**
   * The rule that makes the split worth anything: an XSS that reaches a response body gets fifteen
   * minutes, not thirty days. Asserted against the *string* of the body, so a field added later
   * under any name is caught.
   */
  it('never puts the refresh token in the body', async () => {
    const test = createAuthApp();

    const response = await request(test.app)
      .post('/api/v1/auth/register')
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send(REGISTRATION)
      .expect(201);

    const token = refreshCookie(response).split(';')[0]?.split('=')[1] ?? '';

    expect(token).not.toBe('');
    expect(JSON.stringify(response.body)).not.toContain(token);
  });

  it('refuses a request without an Idempotency-Key, naming the header', async () => {
    const test = createAuthApp();

    const response = await request(test.app)
      .post('/api/v1/auth/register')
      .send(REGISTRATION)
      .expect(422);

    expect(response.body).toMatchObject({
      code: 'validation_failed',
      errors: [{ path: 'Idempotency-Key' }],
    });
    expect(test.organizations.createdOwner).toBeUndefined();
  });

  it('refuses a key that is too short to be one', async () => {
    const test = createAuthApp();

    const response = await request(test.app)
      .post('/api/v1/auth/register')
      .set('Idempotency-Key', 'short')
      .send(REGISTRATION);

    expect(response.status).toBe(422);
  });

  it('reports a weak password on the field, with no password in the answer', async () => {
    const test = createAuthApp();

    const response = await request(test.app)
      .post('/api/v1/auth/register')
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send({ ...REGISTRATION, owner: { ...REGISTRATION.owner, password: 'qwertyuiop12' } }) // scan-secrets:allow gitleaks:allow
      .expect(422);

    expect(response.body.errors).toEqual([
      { path: 'owner.password', code: 'custom', message: expect.any(String) },
    ]);
    expect(JSON.stringify(response.body)).not.toContain('qwertyuiop12');
  });

  it('takes the locale and timezone from the form when it supplies them', async () => {
    const test = createAuthApp();

    const response = await request(test.app)
      .post('/api/v1/auth/register')
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send({
        ...REGISTRATION,
        owner: { ...REGISTRATION.owner, locale: 'ru', timezone: 'Europe/Berlin' },
      })
      .expect(201);

    expect(response.body.user).toMatchObject({ locale: 'ru', timezone: 'Europe/Berlin' });
  });

  it('refuses an unknown field rather than ignoring it', async () => {
    const test = createAuthApp();

    const response = await request(test.app)
      .post('/api/v1/auth/register')
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send({ ...REGISTRATION, organisation: { name: 'typo' } });

    expect(response.status).toBe(422);
  });

  it('answers 403 when the installation does not accept new organizations', async () => {
    const test = createAuthApp({ registrationOpen: false });

    const response = await request(test.app)
      .post('/api/v1/auth/register')
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send(REGISTRATION)
      .expect(403);

    expect(response.body.code).toBe('registration_disabled');
    expect(cookiesOf(response)).toEqual([]);
  });
});

describe('POST /api/v1/auth/login', () => {
  it('returns a session and sets the cookie', async () => {
    const test = createAuthApp();

    const response = await request(test.app)
      .post('/api/v1/auth/login')
      .send({ email: 'ada@example.com', password: PASSWORD })
      .expect(200);

    expect(response.body.status).toBe('authenticated');
    expect(refreshCookie(response)).toContain('HttpOnly');
  });

  /** The acceptance criterion, at the level a client can observe it: byte for byte one answer. */
  it('answers an unknown address and a wrong password identically', async () => {
    const test = createAuthApp();

    const unknown = await request(test.app)
      .post('/api/v1/auth/login')
      .send({ email: 'nobody@example.com', password: PASSWORD })
      .expect(401);
    const wrong = await request(test.app)
      .post('/api/v1/auth/login')
      .send({ email: 'ada@example.com', password: 'wrong-password-here' })
      .expect(401);

    // `requestId` differs per request by design; everything else has to be byte for byte equal.
    const withoutRequestId = (body: Record<string, unknown>): Record<string, unknown> =>
      Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'requestId'));

    expect(withoutRequestId(unknown.body)).toEqual(withoutRequestId(wrong.body));
    expect(unknown.body.code).toBe('invalid_credentials');
    expect(cookiesOf(unknown)).toEqual([]);
  });

  it('sets no cookie when it has to ask which organization', async () => {
    const test = createAuthApp({
      accounts: [
        authUser(),
        authUser({
          userId: 'c0ffee00-0000-4000-8000-000000000001',
          organizationId: '1d0f8a2b-6c34-4e51-b8aa-9f2e7c5d31b4',
          organizationName: 'Side Project',
          organizationSlug: 'side-project',
        }),
      ],
    });

    const response = await request(test.app)
      .post('/api/v1/auth/login')
      .send({ email: 'ada@example.com', password: PASSWORD })
      .expect(200);

    expect(response.body.status).toBe('organization_selection_required');
    expect(response.body.organizations).toHaveLength(2);
    expect(cookiesOf(response)).toEqual([]);
  });

  it('signs in to the organization a repeat call names', async () => {
    const test = createAuthApp({
      accounts: [
        authUser(),
        authUser({
          userId: 'c0ffee00-0000-4000-8000-000000000001',
          organizationId: '1d0f8a2b-6c34-4e51-b8aa-9f2e7c5d31b4',
          organizationName: 'Side Project',
          organizationSlug: 'side-project',
        }),
      ],
    });

    const response = await request(test.app)
      .post('/api/v1/auth/login')
      .send({ email: 'ada@example.com', password: PASSWORD, organizationSlug: 'side-project' })
      .expect(200);

    expect(response.body.organization.slug).toBe('side-project');
  });

  /**
   * A client that sends no `User-Agent` — `curl`, a script, a native app — still gets a session. The
   * column is NOT NULL, so the empty string is what is stored, and the list renders it as the stated
   * "unknown device" rather than as a fragment of nothing.
   */
  it('signs in a client that sends no user agent', async () => {
    const test = createAuthApp();

    const response = await request(test.app)
      .post('/api/v1/auth/login')
      .set('User-Agent', '')
      .send({ email: 'ada@example.com', password: PASSWORD })
      .expect(200);

    expect(response.body.status).toBe('authenticated');
  });

  it('normalises the address before it looks anything up', async () => {
    const test = createAuthApp();

    const response = await request(test.app)
      .post('/api/v1/auth/login')
      .send({ email: '  Ada@Example.COM ', password: PASSWORD });

    expect(response.status).toBe(200);
  });

  it('reports a suspended account with its own code and issues no cookie', async () => {
    const test = createAuthApp({ accounts: [authUser({ status: 'SUSPENDED' })] });

    const response = await request(test.app)
      .post('/api/v1/auth/login')
      .send({ email: 'ada@example.com', password: PASSWORD })
      .expect(403);

    expect(response.body.code).toBe('account_suspended');
    expect(cookiesOf(response)).toEqual([]);
  });
});

describe('POST /api/v1/auth/refresh', () => {
  it('rotates the cookie and returns a new access token', async () => {
    const test = createAuthApp();
    const session = await signIn(test);

    const response = await request(test.app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', session.cookie)
      .set('Origin', ORIGIN)
      .expect(200);

    expect(response.body.status).toBe('authenticated');
    expect(cookieHeader(response)).not.toBe(session.cookie);
  });

  it('clears the cookie on every refusal', async () => {
    const test = createAuthApp();

    const response = await request(test.app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', 'bad_crm_refresh=never-issued')
      .expect(401);

    expect(response.body.code).toBe('unauthenticated');
    expect(refreshCookie(response)).toContain('Path=/api/v1/auth');
    expect(refreshCookie(response)).toMatch(/Expires=Thu, 01 Jan 1970|Max-Age=0/);
  });

  it('refuses a request with no cookie at all', async () => {
    const test = createAuthApp();

    const response = await request(test.app).post('/api/v1/auth/refresh');

    expect(response.status).toBe(401);
  });

  /** An empty value is not a token, and a cookie header carrying something else is not one either. */
  it.each(['bad_crm_refresh=', 'other=value'])(
    'refuses a cookie header of "%s"',
    async (cookie) => {
      const test = createAuthApp();

      const response = await request(test.app).post('/api/v1/auth/refresh').set('Cookie', cookie);

      expect(response.status).toBe(401);
    },
  );

  /**
   * `SameSite=Lax` keeps the cookie off a cross-site sub-resource request but not off a top-level
   * POST, so the one endpoint the cookie authorises checks `Origin` as well (STORY-006-03).
   */
  it('refuses a request from another origin, with the same answer as any other refusal', async () => {
    const test = createAuthApp();
    const session = await signIn(test);

    const response = await request(test.app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', session.cookie)
      .set('Origin', 'https://evil.example')
      .expect(401);

    expect(response.body.code).toBe('unauthenticated');
    expect([...test.sessions.rows.values()].every((row) => row.revokedAt === null)).toBe(true);
  });

  /**
   * And it leaves the cookie exactly where it was.
   *
   * Clearing it would hand any page on the internet a working sign-out: a hidden form posting to
   * this endpoint carries the cookie by `SameSite=Lax`, so a refusal that also expired it would let
   * `evil.example` end the session of anyone who loads their page. The refusal the *use-case*
   * produces does clear it — that token is spent or unknown and the client should stop presenting
   * it — and this one is a request the process refused to look at, which is a different fact about
   * a cookie that is still perfectly good.
   *
   * The asymmetry is not an oracle. The attacker's origin is not in the allow-list, so no CORS
   * headers come back and their script can read neither the body nor `Set-Cookie`; the difference is
   * visible only to the browser, and only as "nothing happened".
   */
  it('leaves the cookie in place, so no page on the internet can sign a person out', async () => {
    const test = createAuthApp();
    const session = await signIn(test);

    const response = await request(test.app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', session.cookie)
      .set('Origin', 'https://evil.example')
      .expect(401);

    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('accepts a request with no Origin at all — a browser always sends one', async () => {
    const test = createAuthApp();
    const session = await signIn(test);

    const response = await request(test.app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', session.cookie);

    expect(response.status).toBe(200);
  });
});

describe('the sessions of the caller', () => {
  it('lists them with a device, a masked address and the current marker', async () => {
    const test = createAuthApp();
    const session = await signIn(test);

    const response = await request(test.app)
      .get('/api/v1/auth/sessions')
      .set('Authorization', `Bearer ${session.accessToken}`)
      .expect(200);

    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0]).toMatchObject({
      current: true,
      ipMasked: expect.any(String),
      device: expect.any(String),
    });
    expect(response.body.items[0]).not.toHaveProperty('familyId');
    expect(response.body.items[0]).not.toHaveProperty('ipHash');
  });

  it('refuses without a bearer token', async () => {
    const test = createAuthApp();

    const response = await request(test.app).get('/api/v1/auth/sessions');

    expect(response.status).toBe(401);
  });

  it('refuses a malformed Authorization header', async () => {
    const test = createAuthApp();

    const response = await request(test.app)
      .get('/api/v1/auth/sessions')
      .set('Authorization', 'Basic ada:secret');

    expect(response.status).toBe(401);
  });

  /**
   * The cookie is scoped to `/api/v1/auth`, so a browser attaches it here too. It must not count as
   * a credential on anything but the two operations whose contract declares it.
   */
  it('does not accept the refresh cookie as a credential', async () => {
    const test = createAuthApp();
    const session = await signIn(test);

    const response = await request(test.app)
      .get('/api/v1/auth/sessions')
      .set('Cookie', session.cookie);

    expect(response.status).toBe(401);
  });

  it('revokes one of them and answers 204', async () => {
    const test = createAuthApp();
    const session = await signIn(test);

    await request(test.app)
      .delete(`/api/v1/auth/sessions/${session.sessionId}`)
      .set('Authorization', `Bearer ${session.accessToken}`)
      .expect(204);

    expect(test.sessions.rows.get(session.sessionId)?.revokedReason).toBe('REVOKED_BY_USER');
  });

  it('clears the cookie when the revoked session is the current one', async () => {
    const test = createAuthApp();
    const session = await signIn(test);

    const response = await request(test.app)
      .delete(`/api/v1/auth/sessions/${session.sessionId}`)
      .set('Authorization', `Bearer ${session.accessToken}`)
      .expect(204);

    expect(refreshCookie(response)).toMatch(/Expires=Thu, 01 Jan 1970|Max-Age=0/);
  });

  /**
   * And leaves it alone otherwise: closing a session on another machine must not sign the caller out
   * of the browser they are looking at.
   */
  it('leaves the cookie alone when the revoked session is another device', async () => {
    const test = createAuthApp();
    const other = await signIn(test);
    const current = await signIn(test);

    const response = await request(test.app)
      .delete(`/api/v1/auth/sessions/${other.sessionId}`)
      .set('Authorization', `Bearer ${current.accessToken}`)
      .expect(204);

    expect(cookiesOf(response)).toEqual([]);
  });

  /** Invariant 2 of CLAUDE.md over an enumerable id: 404, never 403. */
  it('answers 404 for an id that is not the caller’s', async () => {
    const test = createAuthApp();
    const session = await signIn(test);

    const response = await request(test.app)
      .delete('/api/v1/auth/sessions/4f1c2f4a-0a6d-4a7b-9a1e-2d3c4b5a6f70')
      .set('Authorization', `Bearer ${session.accessToken}`)
      .expect(404);

    expect(response.body.code).toBe('session_not_found');
  });

  it('refuses an id that is not a uuid before it looks anything up', async () => {
    const test = createAuthApp();
    const session = await signIn(test);

    const response = await request(test.app)
      .delete('/api/v1/auth/sessions/not-a-uuid')
      .set('Authorization', `Bearer ${session.accessToken}`);

    expect(response.status).toBe(422);
  });

  it('closes the others and reports how many', async () => {
    const test = createAuthApp();
    const first = await signIn(test);

    await signIn(test);

    const response = await request(test.app)
      .post('/api/v1/auth/sessions/revoke-others')
      .set('Authorization', `Bearer ${first.accessToken}`)
      .expect(200);

    expect(response.body).toEqual({ revokedCount: 1 });
  });
});

describe('POST /api/v1/auth/logout', () => {
  it('ends the session, clears the cookie and answers 204', async () => {
    const test = createAuthApp();
    const session = await signIn(test);

    const response = await request(test.app)
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${session.accessToken}`)
      .expect(204);

    expect(refreshCookie(response)).toMatch(/Expires=Thu, 01 Jan 1970|Max-Age=0/);
    expect(test.sessions.rows.get(session.sessionId)?.revokedReason).toBe('LOGOUT');
  });

  /**
   * The reason `POST /auth/logout` declares two security schemes: an expired access token must not
   * make it impossible to sign out, which is exactly the moment somebody wants to.
   */
  it('accepts the refresh cookie on its own', async () => {
    const test = createAuthApp();
    const session = await signIn(test);

    await request(test.app).post('/api/v1/auth/logout').set('Cookie', session.cookie).expect(204);

    expect(test.sessions.rows.get(session.sessionId)?.revokedAt).not.toBeNull();
  });

  it('accepts the cookie when the bearer token no longer verifies', async () => {
    const test = createAuthApp();
    const session = await signIn(test);

    const response = await request(test.app)
      .post('/api/v1/auth/logout')
      .set('Authorization', 'Bearer access.no-such-session')
      .set('Cookie', session.cookie);

    expect(response.status).toBe(204);
  });

  it('refuses when neither credential resolves to a session', async () => {
    const test = createAuthApp();

    const response = await request(test.app).post('/api/v1/auth/logout');

    expect(response.status).toBe(401);
  });

  it('refuses a cookie that was never issued', async () => {
    const test = createAuthApp();

    const response = await request(test.app)
      .post('/api/v1/auth/logout')
      .set('Cookie', 'bad_crm_refresh=never-issued');

    expect(response.status).toBe(401);
  });

  /** Revocation takes effect on the next request, not at the end of the access token's lifetime. */
  it('makes the access token stop working immediately', async () => {
    const test = createAuthApp();
    const session = await signIn(test);

    const response = await request(test.app)
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${session.accessToken}`);

    expect(response.status).toBe(204);

    await request(test.app)
      .get('/api/v1/auth/sessions')
      .set('Authorization', `Bearer ${session.accessToken}`)
      .expect(401);
  });
});

describe('what the authentication surface writes to the log', () => {
  /**
   * `rules/observability.mdc`, rule 2: every line carries `requestId`, `organizationId` and
   * `userId`. The first has been there since EPIC-003; the other two were `null` on every line of
   * every authenticated request, because the guard wrote the caller to `res.locals` and to nothing
   * else. The cost lands during an incident — "who closed somebody else's sessions" becomes a
   * manual join of log lines by timestamp.
   */
  it('stamps the tenant and the caller on the completion line of an authenticated request', async () => {
    const test = createAuthApp();
    const session = await signIn(test);

    await request(test.app)
      .get('/api/v1/auth/sessions')
      .set('Authorization', `Bearer ${session.accessToken}`)
      .expect(200);

    const completion = test
      .logLines()
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .findLast((line) => line['msg'] === 'request completed');

    expect(completion).toMatchObject({
      route: '/api/v1/auth/sessions',
      organizationId: ORGANIZATION_ID,
      userId: USER_ID,
      requestId: expect.any(String) as string,
    });
  });

  /** Sign-in itself has no caller yet: the fields are `null`, which is a fact rather than a gap. */
  it('leaves the tenant and the caller null on a request that carried no credential', async () => {
    const test = createAuthApp();

    await signIn(test);

    const completion = test
      .logLines()
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .findLast((line) => line['msg'] === 'request completed');

    expect(completion).toMatchObject({ organizationId: null, userId: null });
  });

  it('records no token, no cookie and no address', async () => {
    const test = createAuthApp();
    const session = await signIn(test);

    await request(test.app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', session.cookie)
      .set('Origin', ORIGIN)
      .expect(200);

    const written = JSON.stringify(test.logger.lines);

    expect(written).not.toContain(session.cookie);
    expect(written).not.toContain(session.accessToken);
    expect(written).not.toContain('ada@example.com');
  });
});
