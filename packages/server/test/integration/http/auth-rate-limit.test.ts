import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createAuthApp } from '../../support/auth-app.util.js';

/**
 * The attempt budget as a client experiences it: the status, the header, and when it goes away.
 *
 * The use-case suites assert *that* the limiter is consulted and in what order; only the wire shows
 * the two things a client acts on — a `429` carrying a `Retry-After` with a real number of seconds
 * on it, and a counter that a correct password actually puts back. Both were absent from this
 * process entirely until the port was wired into the composition root: the adapter existed, was
 * tested against a live Redis, and was called from nowhere (STORY-006-07).
 *
 * The budgets here are the ones the shipped policy table declares — five sign-in attempts and three
 * registrations — restated rather than imported, so that a change to the table has to be a
 * deliberate change to this file as well.
 */

const IDEMPOTENCY_KEY = 'a'.repeat(32);
const PASSWORD = 'correct-horse-battery';
const RETRY_AFTER_SECONDS = 873;

const REGISTRATION = {
  organization: { name: 'Bad Company', slug: 'bad-company' },
  owner: { email: 'ada@example.com', password: PASSWORD },
};

const limitedApp = (limits: { auth_attempt?: number; organization_registration?: number }) =>
  createAuthApp({ rateLimit: { limits, retryAfterSeconds: RETRY_AFTER_SECONDS } });

describe('POST /api/v1/auth/login under a budget of five', () => {
  it('answers the sixth failed attempt 429 with a real Retry-After', async () => {
    const test = limitedApp({ auth_attempt: 5 });

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await request(test.app)
        .post('/api/v1/auth/login')
        .send({ email: 'ada@example.com', password: 'wrong-password' })
        .expect(401);
    }

    const refused = await request(test.app)
      .post('/api/v1/auth/login')
      .send({ email: 'ada@example.com', password: 'wrong-password' })
      .expect(429);

    expect(refused.body).toMatchObject({ code: 'rate_limited', status: 429 });
    // Not merely present: a header saying `0` reads as "retry now" and produces the tight loop the
    // budget was spent to stop.
    expect(refused.headers['retry-after']).toBe(String(RETRY_AFTER_SECONDS));
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
  });

  /**
   * The expensive half. Argon2id at the shipped parameters allocates 19 MiB per verification, so an
   * endpoint that hashes first and counts afterwards is a memory-exhaustion vector even against an
   * attacker who never guesses anything (`docs/security/threat-model.md`, T-IAM-08).
   */
  it('verifies no digest at all once the budget is gone', async () => {
    const test = limitedApp({ auth_attempt: 1 });

    await request(test.app)
      .post('/api/v1/auth/login')
      .send({ email: 'ada@example.com', password: 'wrong-password' })
      .expect(401);

    const verifiedBefore = test.hasher.verified.length;

    await request(test.app)
      .post('/api/v1/auth/login')
      .send({ email: 'ada@example.com', password: 'wrong-password' })
      .expect(429);

    expect(test.hasher.verified).toHaveLength(verifiedBefore);
  });

  it('puts the whole budget back when the password is finally right', async () => {
    const test = limitedApp({ auth_attempt: 5 });

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await request(test.app)
        .post('/api/v1/auth/login')
        .send({ email: 'ada@example.com', password: 'wrong-password' })
        .expect(401);
    }

    await request(test.app)
      .post('/api/v1/auth/login')
      .send({ email: 'ada@example.com', password: PASSWORD })
      .expect(200);

    // Five more failures, all of them answered on their merits. Without the reset the first of
    // these would already be the sixth spend of the window.
    const after: number[] = [];

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const response = await request(test.app)
        .post('/api/v1/auth/login')
        .send({ email: 'ada@example.com', password: 'wrong-password' });

      after.push(response.status);
    }

    expect(after).toEqual([401, 401, 401, 401, 401]);
  });

  /**
   * The budget belongs to the pair, which is what keeps it from becoming a lock-out tool: exhausting
   * one account's attempts from an address must not refuse a different account from the same one.
   */
  it('keeps a second account on the same address out of the first one’s budget', async () => {
    const test = limitedApp({ auth_attempt: 1 });

    await request(test.app)
      .post('/api/v1/auth/login')
      .send({ email: 'ada@example.com', password: 'wrong-password' })
      .expect(401);
    await request(test.app)
      .post('/api/v1/auth/login')
      .send({ email: 'ada@example.com', password: 'wrong-password' })
      .expect(429);

    const other = await request(test.app)
      .post('/api/v1/auth/login')
      .send({ email: 'grace@example.com', password: 'wrong-password' });

    expect(other.status).toBe(401);
    expect(other.body).toMatchObject({ code: 'invalid_credentials' });
  });
});

describe('POST /api/v1/auth/register under a budget of three', () => {
  it('answers the fourth registration from one address 429', async () => {
    const test = limitedApp({ organization_registration: 3 });

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await request(test.app)
        .post('/api/v1/auth/register')
        .set('Idempotency-Key', IDEMPOTENCY_KEY)
        .send({
          ...REGISTRATION,
          organization: { name: `Company ${attempt}`, slug: `company-${attempt}` },
        })
        .expect(201);
    }

    const refused = await request(test.app)
      .post('/api/v1/auth/register')
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send({ ...REGISTRATION, organization: { name: 'Company 4', slug: 'company-4' } })
      .expect(429);

    expect(refused.body).toMatchObject({ code: 'rate_limited' });
    expect(refused.headers['retry-after']).toBe(String(RETRY_AFTER_SECONDS));
  });
});

describe('POST /api/v1/auth/refresh under the ambient budget', () => {
  it('answers over budget 429 rather than rotating', async () => {
    const test = createAuthApp({
      rateLimit: { limits: { api_request: 1 }, retryAfterSeconds: RETRY_AFTER_SECONDS },
    });

    const signedIn = await request(test.app)
      .post('/api/v1/auth/login')
      .send({ email: 'ada@example.com', password: PASSWORD })
      .expect(200);

    const cookie = (signedIn.headers['set-cookie'] as unknown as string[])
      .find((value) => value.startsWith('bad_crm_refresh='))
      ?.split(';')[0];

    await request(test.app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', cookie ?? '')
      .expect(200);

    const refused = await request(test.app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', cookie ?? '')
      .expect(429);

    expect(refused.body).toMatchObject({ code: 'rate_limited' });
  });
});

/**
 * Fail closed, end to end. A limiter whose store is unreachable answers 503 — the code
 * `docs/api/openapi.yaml` declares on `login` and `refresh` — and never admits the request: were it
 * to admit, taking Redis down would be the cheapest way to switch the brute-force defence off
 * (T-IAM-03).
 */
describe('when the counter store cannot be reached', () => {
  it('refuses the sign-in with service_unavailable instead of admitting it', async () => {
    const test = createAuthApp({ rateLimit: { unavailable: true } });

    const response = await request(test.app)
      .post('/api/v1/auth/login')
      .send({ email: 'ada@example.com', password: PASSWORD })
      .expect(503);

    expect(response.body).toMatchObject({ code: 'service_unavailable' });
    expect(test.hasher.verified).toEqual([]);
    expect(test.sessions.rows.size).toBe(0);
  });
});
