import { describe, expect, it } from 'vitest';

import { IssueSessionUseCase } from '@/application/identity/use-cases/issue-session.use-case.js';
import {
  REFRESH_RACE_GRACE_SECONDS,
  RefreshSessionUseCase,
} from '@/application/identity/use-cases/refresh-session.use-case.js';
import { SECURITY_EVENTS } from '@/domain/identity/security-event.constant.js';
import {
  FakeAccessTokens,
  FakeAddressHasher,
  FakeAuthLookup,
  FakeClock,
  FakeIdGenerator,
  FakeOrganizations,
  FakeRateLimit,
  type FakeRateLimitOptions,
  FakeRefreshTokens,
  FakeSessions,
  FakeUnitOfWork,
  FakeUsers,
  ORGANIZATION_ID,
  RecordingLogger,
  USER_ID,
} from '../../support/identity-doubles.util.js';

const CLIENT = { userAgent: 'Firefox/128.0', ipAddress: '203.0.113.42' };
const FAMILY_ID = 'f0f0f0f0-0000-4000-8000-000000000001';

interface Harness {
  readonly refresh: RefreshSessionUseCase;
  readonly lookup: FakeAuthLookup;
  readonly sessions: FakeSessions;
  readonly users: FakeUsers;
  readonly clock: FakeClock;
  readonly logger: RecordingLogger;
  readonly rateLimit: FakeRateLimit;
}

/**
 * A session that has already been signed in to: a row in the repository, and the matching entry on
 * the `app_auth` lookup that the cookie resolves through.
 */
const harness = (
  options: { status?: string } = {},
  rateLimitOptions: Omit<FakeRateLimitOptions, 'journal'> = {},
): Harness => {
  const rateLimit = new FakeRateLimit(rateLimitOptions);
  const clock = new FakeClock();
  const sessions = new FakeSessions(clock);
  const lookup = new FakeAuthLookup().reading(sessions);
  const logger = new RecordingLogger();
  const users = new FakeUsers([
    {
      id: USER_ID,
      email: 'ada@example.com',
      locale: 'en',
      timezone: 'Europe/Berlin',
      status: options.status ?? 'ACTIVE',
      permissionsVersion: 1,
    },
  ]);

  const refreshTokens = new FakeRefreshTokens();
  const issue = new IssueSessionUseCase(
    sessions,
    new FakeOrganizations(),
    refreshTokens,
    new FakeAccessTokens(),
    new FakeAddressHasher(),
    clock,
    new FakeIdGenerator(),
  );

  return {
    refresh: new RefreshSessionUseCase(
      lookup,
      refreshTokens,
      sessions,
      users,
      new FakeOrganizations(),
      new FakeUnitOfWork(),
      issue,
      clock,
      logger,
      rateLimit,
    ),
    lookup,
    sessions,
    users,
    clock,
    logger,
    rateLimit,
  };
};

/** Lines the log carries for one security event, matched on the field rather than on the prose. */
const reuseEvents = (logger: RecordingLogger): RecordingLogger['lines'] =>
  logger.lines.filter((line) => line.fields['event'] === SECURITY_EVENTS.refreshReuseDetected);

/** Seeds one live session and returns the refresh token that addresses it. */
const signIn = async (harnessed: Harness): Promise<string> => {
  const token = 'refresh-0';

  await harnessed.sessions.create({
    userId: USER_ID,
    familyId: FAMILY_ID,
    rotatedFromId: null,
    refreshTokenHash: new TextEncoder().encode(`sha256:${token}`),
    userAgent: CLIENT.userAgent,
    ipHash: 'hmac:203.0.113.42',
    ipMasked: '203.0.113.0/24',
    expiresAt: new Date(harnessed.clock.now().getTime() + 30 * 24 * 3600 * 1000),
  });

  return token;
};

/**
 * The refusal, as the use-case expresses it: one `null` for every reason.
 *
 * The 401 is raised by the controller, on the single branch that also clears the cookie — asserted
 * in `test/integration/http/auth-endpoints.test.ts` against the real response.
 */
const refusal = async (run: () => Promise<unknown>): Promise<null> => {
  const result = await run();

  if (result !== null) throw new Error('expected the refresh to be refused');

  return null;
};

describe('rotating a refresh token', () => {
  it('spends the presented token and issues a new one in the same family', async () => {
    const test = harness();
    const token = await signIn(test);

    const result = await test.refresh.execute({ refreshToken: token, client: CLIENT });

    const rows = [...test.sessions.rows.values()];

    expect(rows).toHaveLength(2);
    expect(rows[0]?.revokedAt).not.toBeNull();
    expect(rows[1]).toMatchObject({ familyId: FAMILY_ID, rotatedFromId: rows[0]?.id });
    expect(result?.session.familyId).toBe(FAMILY_ID);
    expect(result?.session.refreshToken).not.toBe(token);
    expect(result?.user.email).toBe('ada@example.com');
    expect(result?.organization.slug).toBe('bad-company');
  });

  it('records the reason as a rotation rather than as a revocation', async () => {
    const test = harness();
    const token = await signIn(test);

    await test.refresh.execute({ refreshToken: token, client: CLIENT });

    expect([...test.sessions.rows.values()][0]?.revokedReason).toBe('ROTATED');
  });

  /**
   * The main mechanism of the epic. A token that was already spent is either theft or a race, and
   * the difference is how long ago it was spent and why.
   */
  describe('when an already spent token comes back', () => {
    it('revokes the whole family, not just the row', async () => {
      const test = harness();
      const token = await signIn(test);

      await test.refresh.execute({ refreshToken: token, client: CLIENT });
      test.clock.advance(REFRESH_RACE_GRACE_SECONDS + 1);

      await refusal(() => test.refresh.execute({ refreshToken: token, client: CLIENT }));

      expect([...test.sessions.rows.values()].every((row) => row.revokedAt !== null)).toBe(true);
      expect(
        [...test.sessions.rows.values()].some((row) => row.revokedReason === 'REUSE_DETECTED'),
      ).toBe(true);
    });

    it('writes an event naming the family, the user and the organization — and no token', async () => {
      const test = harness();
      const token = await signIn(test);

      await test.refresh.execute({ refreshToken: token, client: CLIENT });
      test.clock.advance(REFRESH_RACE_GRACE_SECONDS + 1);
      await refusal(() => test.refresh.execute({ refreshToken: token, client: CLIENT }));

      const [event] = reuseEvents(test.logger);

      expect(event?.level).toBe('warn');
      expect(event?.fields).toMatchObject({
        userId: USER_ID,
        organizationId: ORGANIZATION_ID,
        familyId: FAMILY_ID,
      });
      expect(JSON.stringify(test.logger.lines)).not.toContain(token);
    });

    /**
     * The identity of the event is a **field**, not the sentence the line happens to carry.
     *
     * `rules/security.mdc` rule 8 requires the detection to be recorded, and a detection nobody can
     * select on is not recorded in any useful sense: an alert keyed on a substring of `msg` breaks
     * the day somebody improves the wording, and a wording is exactly the kind of thing that gets
     * improved. `AuditLog` and the notification mail that the rule also asks for do not exist yet
     * (STORY-006-03 «Что осталось»); this is the part that can be honest today, and it is the field
     * both of them will be dispatched from.
     */
    it('marks the line with a machine-readable event name, not only with prose', async () => {
      const test = harness();
      const token = await signIn(test);

      await test.refresh.execute({ refreshToken: token, client: CLIENT });
      test.clock.advance(REFRESH_RACE_GRACE_SECONDS + 1);
      await refusal(() => test.refresh.execute({ refreshToken: token, client: CLIENT }));

      const [event] = reuseEvents(test.logger);

      expect(event?.fields['event']).toBe('refresh_reuse_detected');
      // The prose is free to change; nothing may depend on it, including this suite.
      expect(event?.message).not.toBe(SECURITY_EVENTS.refreshReuseDetected);
    });

    /**
     * Two tabs refreshing at once is not theft. The loser is told 401 — it has no session — and the
     * family survives, because revoking it would sign the person out of a browser that did nothing
     * wrong. The signal that separates the two is written down in STORY-006-03: the token was spent
     * by a *rotation*, moments ago.
     */
    it('leaves the family alone when the loss happened moments ago', async () => {
      const test = harness();
      const token = await signIn(test);

      await test.refresh.execute({ refreshToken: token, client: CLIENT });
      test.clock.advance(REFRESH_RACE_GRACE_SECONDS - 1);

      await refusal(() => test.refresh.execute({ refreshToken: token, client: CLIENT }));

      expect([...test.sessions.rows.values()].some((row) => row.revokedAt === null)).toBe(true);
      expect(reuseEvents(test.logger)).toEqual([]);
    });

    /**
     * And the grace applies to a rotation only. A token that was revoked because somebody signed out
     * or closed the session from `/settings/security` is not a lost race however recent it is —
     * coming back with it means the token outlived the revocation, which is exactly what theft looks
     * like.
     */
    it('treats a token spent by anything but a rotation as reuse, however recent', async () => {
      const test = harness();
      const token = await signIn(test);
      const [row] = [...test.sessions.rows.values()];

      await test.sessions.revoke(row?.id ?? '', 'REVOKED_BY_USER', test.clock.now());

      await refusal(() => test.refresh.execute({ refreshToken: token, client: CLIENT }));

      expect(reuseEvents(test.logger)).toHaveLength(1);
    });

    it('answers the same refusal whether it was theft or a race', async () => {
      const theft = harness();
      const race = harness();
      const stolen = await signIn(theft);
      const lost = await signIn(race);

      await theft.refresh.execute({ refreshToken: stolen, client: CLIENT });
      theft.clock.advance(REFRESH_RACE_GRACE_SECONDS + 1);
      await race.refresh.execute({ refreshToken: lost, client: CLIENT });

      await expect(
        theft.refresh.execute({ refreshToken: stolen, client: CLIENT }),
      ).resolves.toBeNull();
      await expect(
        race.refresh.execute({ refreshToken: lost, client: CLIENT }),
      ).resolves.toBeNull();
    });
  });

  /**
   * Two requests that both got past the lookup before either wrote. Only the atomic `markRotated`
   * separates them, which is why the port promises it and the integration suite proves it against a
   * real PostgreSQL.
   */
  it('lets exactly one of two concurrent rotations win', async () => {
    const test = harness();
    const token = await signIn(test);

    const results = await Promise.all([
      test.refresh.execute({ refreshToken: token, client: CLIENT }),
      test.refresh.execute({ refreshToken: token, client: CLIENT }),
    ]);

    expect(results.filter((result) => result !== null)).toHaveLength(1);
    expect(results.filter((result) => result === null)).toHaveLength(1);
    expect(reuseEvents(test.logger)).toEqual([]);
  });

  it('refuses a token that is not in the database at all', async () => {
    const test = harness();

    await signIn(test);
    await refusal(() => test.refresh.execute({ refreshToken: 'never-issued', client: CLIENT }));

    expect([...test.sessions.rows.values()].every((row) => row.revokedAt === null)).toBe(true);
  });

  /** An expiry is the ordinary end of a session, not a sign of theft: the family is untouched. */
  it('refuses an expired token without revoking the family', async () => {
    const test = harness();
    const token = await signIn(test);

    test.clock.advance(31 * 24 * 3600);
    await refusal(() => test.refresh.execute({ refreshToken: token, client: CLIENT }));

    expect(reuseEvents(test.logger)).toEqual([]);
    expect([...test.sessions.rows.values()].every((row) => row.revokedAt === null)).toBe(true);
  });

  /**
   * An account that stopped being allowed to hold sessions must not be able to keep one alive by
   * refreshing. The family goes, with the reason the schema reserves for it.
   */
  it('closes the family when the account may no longer hold a session', async () => {
    const test = harness({ status: 'SUSPENDED' });
    const token = await signIn(test);

    await refusal(() => test.refresh.execute({ refreshToken: token, client: CLIENT }));

    expect([...test.sessions.rows.values()].every((row) => row.revokedAt !== null)).toBe(true);
    expect(
      [...test.sessions.rows.values()].some((row) => row.revokedReason === 'OFFBOARDING'),
    ).toBe(true);
  });

  /**
   * Rotation is not a credential guess — the token is 256 opaque bits — so what the budget bounds
   * here is *work*: every call is a lookup through the `SECURITY DEFINER` path, a digest and, on the
   * happy branch, two writes. The ambient API budget is the one that fits (`api_request`,
   * 300/minute), and the address is all the subject there is: the caller is anonymous until the
   * cookie has been resolved, which is the very thing the budget is guarding.
   */
  describe('the ambient budget', () => {
    it('spends a point before the token is looked up', async () => {
      const test = harness();
      const token = await signIn(test);

      await test.refresh.execute({ refreshToken: token, client: CLIENT });

      expect(test.rateLimit.consumed).toEqual([
        { policy: 'api_request', subject: { userId: undefined, ipAddress: '203.0.113.42' } },
      ]);
    });

    it('refuses over budget with rate_limited, rotating nothing', async () => {
      const test = harness({}, { limits: { api_request: 0 }, retryAfterSeconds: 60 });
      const token = await signIn(test);

      await expect(
        test.refresh.execute({ refreshToken: token, client: CLIENT }),
      ).rejects.toMatchObject({ code: 'rate_limited', retryAfterSeconds: 60 });

      expect([...test.sessions.rows.values()].every((row) => row.revokedAt === null)).toBe(true);
    });
  });
});
