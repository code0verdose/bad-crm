import { FakeTotpEnrollment } from '../../support/mfa-doubles.util.js';
import { assert, describe, expect, it } from 'vitest';

import { IssueSessionUseCase } from '@/application/identity/use-cases/issue-session.use-case.js';
import {
  REFRESH_RACE_GRACE_SECONDS,
  RefreshSessionUseCase,
} from '@/application/identity/use-cases/refresh-session.use-case.js';
import { type MailDispatchPort } from '@/application/platform/ports/mail-dispatch.port.js';
import { renderRefreshReuseMail } from '@/domain/identity/refresh-reuse-mail.util.js';
import { SECURITY_EVENTS } from '@/domain/identity/security-event.constant.js';
import { ImmediateMailDispatcher } from '@/infrastructure/mail/immediate-mail-dispatcher.adapter.js';
import {
  FakeAccessTokens,
  FakeAddressHasher,
  disabledMfaPolicy,
  FakeAuditLogger,
  FakeAuthLookup,
  FakeClock,
  FakeIdGenerator,
  FakeMail,
  FakeMailDispatcher,
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
const APP_URL = 'https://crm.example.com';

interface Harness {
  readonly refresh: RefreshSessionUseCase;
  readonly lookup: FakeAuthLookup;
  readonly sessions: FakeSessions;
  readonly users: FakeUsers;
  readonly clock: FakeClock;
  readonly logger: RecordingLogger;
  readonly rateLimit: FakeRateLimit;
  readonly audit: FakeAuditLogger;
  readonly unitOfWork: FakeUnitOfWork;
  readonly dispatcher: FakeMailDispatcher;
}

/**
 * A session that has already been signed in to: a row in the repository, and the matching entry on
 * the `app_auth` lookup that the cookie resolves through.
 */
const harness = (
  options: {
    status?: string;
    failingAudit?: boolean;
    locale?: string;
    /** A dispatcher other than the recording one — the whole chain down to a transport that fails. */
    dispatcher?: MailDispatchPort;
  } = {},
  rateLimitOptions: Omit<FakeRateLimitOptions, 'journal'> = {},
): Harness => {
  const rateLimit = new FakeRateLimit(rateLimitOptions);
  const clock = new FakeClock();
  const sessions = new FakeSessions(clock);
  const lookup = new FakeAuthLookup().reading(sessions);
  const logger = new RecordingLogger();
  const audit = new FakeAuditLogger(options.failingAudit ?? false);
  const unitOfWork = new FakeUnitOfWork();
  const users = new FakeUsers([
    {
      id: USER_ID,
      email: 'ada@example.com',
      locale: options.locale ?? 'en',
      timezone: 'Europe/Berlin',
      status: options.status ?? 'ACTIVE',
      permissionsVersion: 1,
    },
  ]);

  const dispatcher = new FakeMailDispatcher();

  const refreshTokens = new FakeRefreshTokens();
  const issue = new IssueSessionUseCase(
    sessions,
    new FakeOrganizations(),
    refreshTokens,
    new FakeAccessTokens(),
    new FakeAddressHasher(),
    clock,
    new FakeIdGenerator(),
    new FakeTotpEnrollment(),
    disabledMfaPolicy(clock),
  );

  return {
    refresh: new RefreshSessionUseCase(
      lookup,
      refreshTokens,
      sessions,
      users,
      new FakeOrganizations(),
      unitOfWork,
      issue,
      clock,
      logger,
      rateLimit,
      audit,
      options.dispatcher ?? dispatcher,
      APP_URL,
    ),
    lookup,
    sessions,
    users,
    clock,
    logger,
    rateLimit,
    audit,
    unitOfWork,
    dispatcher,
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

    assert(result !== null, 'the rotation was granted');

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ revokedAt: expect.any(Date) });
    expect(rows[1]).toMatchObject({ familyId: FAMILY_ID, rotatedFromId: rows[0]?.id });
    expect(result.session.familyId).toBe(FAMILY_ID);
    expect(result.session.refreshToken).not.toBe(token);
    expect(result.user.email).toBe('ada@example.com');
    expect(result.organization.slug).toBe('bad-company');
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
     * improved. The `AuditLog` row and the notification mail the rule also asks for select on this
     * same field rather than on the prose, and both are asserted below.
     */
    it('marks the line with a machine-readable event name, not only with prose', async () => {
      const test = harness();
      const token = await signIn(test);

      await test.refresh.execute({ refreshToken: token, client: CLIENT });
      test.clock.advance(REFRESH_RACE_GRACE_SECONDS + 1);
      await refusal(() => test.refresh.execute({ refreshToken: token, client: CLIENT }));

      const [event] = reuseEvents(test.logger);

      assert(event !== undefined, 'the reuse was written as a line');

      expect(event.fields['event']).toBe('refresh_reuse_detected');
      // The prose is free to change; nothing may depend on it, including this suite.
      expect(event.message).not.toBe(SECURITY_EVENTS.refreshReuseDetected);
    });

    /**
     * The signal an incident review reads the trail for: theft, not a race — the log line rule 8
     * asked for from the first day, now also a row nobody has to grep the process's stdout to find.
     */
    it('writes an AuditLog entry naming the family, the count revoked and the address', async () => {
      const test = harness();
      const token = await signIn(test);

      await test.refresh.execute({ refreshToken: token, client: CLIENT });
      test.clock.advance(REFRESH_RACE_GRACE_SECONDS + 1);
      await refusal(() => test.refresh.execute({ refreshToken: token, client: CLIENT }));

      expect(test.audit.events).toHaveLength(1);
      expect(test.audit.events[0]).toMatchObject({
        action: 'session.refresh_reuse_detected',
        actor: {
          userId: USER_ID,
          organizationId: ORGANIZATION_ID,
          ipAddress: CLIENT.ipAddress,
        },
        target: { type: 'SESSION_FAMILY', id: FAMILY_ID },
        after: { sessionsRevoked: 1 },
      });
    });

    /** The lost-race branch never revokes, so it must never file the entry either. */
    it('writes no entry when the loss happened moments ago', async () => {
      const test = harness();
      const token = await signIn(test);

      await test.refresh.execute({ refreshToken: token, client: CLIENT });
      test.clock.advance(REFRESH_RACE_GRACE_SECONDS - 1);

      await refusal(() => test.refresh.execute({ refreshToken: token, client: CLIENT }));

      expect(test.audit.events).toEqual([]);
    });

    /**
     * `before`/`after` carry identifiers and counters, never content — the invariant
     * `AuditEvent`'s own docstring states, and the one CLAUDE.md ranks as never-log for this exact
     * value: the token and its digest.
     */
    it('carries no token and no token digest into the trail', async () => {
      const test = harness();
      const token = await signIn(test);

      await test.refresh.execute({ refreshToken: token, client: CLIENT });
      test.clock.advance(REFRESH_RACE_GRACE_SECONDS + 1);
      await refusal(() => test.refresh.execute({ refreshToken: token, client: CLIENT }));

      const serialized = JSON.stringify(test.audit.events);

      expect(serialized).not.toContain(token);
      expect(serialized).not.toContain(`sha256:${token}`);
    });

    /**
     * The write happens inside the same `withTenant` scope that revokes the family — the identical
     * shape `login.use-case.test.ts` proves atomicity with, since the in-memory double cannot roll a
     * `Map` back: a rejection out of the trail write has to unwind the one scope that was opened, not
     * leave the revocation committed on its own with nothing recording why.
     */
    it('rolls the revocation back when the trail cannot be written', async () => {
      const test = harness({ failingAudit: true });
      const token = await signIn(test);

      await test.refresh.execute({ refreshToken: token, client: CLIENT });
      test.clock.advance(REFRESH_RACE_GRACE_SECONDS + 1);

      await expect(test.refresh.execute({ refreshToken: token, client: CLIENT })).rejects.toThrow(
        'audit sink unavailable',
      );

      // Two scopes total: the rotation above, then the reuse-detection transaction that this
      // assertion is actually about. What proves the rollback is real is *where* the rejection
      // came from — inside the second scope, which then closed like every other — rather than a
      // row disappearing from the in-memory double, which cannot roll a `Map` back at all.
      expect(test.unitOfWork.scopes).toHaveLength(2);
      expect(test.unitOfWork.current).toBe(undefined);
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

    /**
     * The third of the three actions `rules/security.mdc` rule 8 asks for, beside the revocation and
     * the trail: the account owner is told, through a channel the stolen session does not control.
     */
    describe('the notice to the account owner', () => {
      /** One family, one rotation, and the spent token presented again outside the grace window. */
      const replay = async (test: Harness): Promise<string> => {
        const token = await signIn(test);

        await test.refresh.execute({ refreshToken: token, client: CLIENT });
        test.clock.advance(REFRESH_RACE_GRACE_SECONDS + 1);
        await refusal(() => test.refresh.execute({ refreshToken: token, client: CLIENT }));

        return token;
      };

      it('hands one message to the dispatcher, addressed to the account', async () => {
        const test = harness();

        await replay(test);

        const [notice] = test.dispatcher.dispatched;

        assert(notice !== undefined, 'the notice was handed over');

        expect(test.dispatcher.dispatched).toHaveLength(1);
        expect(notice.mail.to).toBe('ada@example.com');
        expect(notice.context).toEqual({
          event: SECURITY_EVENTS.refreshReuseDetected,
          organizationId: ORGANIZATION_ID,
          userId: USER_ID,
        });
      });

      it('says how many sessions were closed', async () => {
        const test = harness();

        await replay(test);

        expect(test.dispatcher.dispatched[0]?.mail.text).toContain('1 session was signed out');
      });

      /** The account's own language, `users.locale`, since there is no browser to ask. */
      it('renders in the language of the account, not of the request', async () => {
        const test = harness({ locale: 'ru' });

        await replay(test);

        expect(test.dispatcher.dispatched[0]?.mail.subject).toBe(
          renderRefreshReuseMail({ locale: 'ru', appUrl: APP_URL, revokedSessions: 1 }).subject,
        );
      });

      /**
       * Nothing in the message is a credential or a fragment of one — not the replayed token, not
       * its digest, not the address of the request. The reader is somebody who may be reading a
       * mailbox that is itself compromised.
       */
      it('carries no token, no digest and no address', async () => {
        const test = harness();
        const token = await replay(test);
        const serialized = JSON.stringify(test.dispatcher.dispatched);

        expect(serialized).not.toContain(token);
        expect(serialized).not.toContain(`sha256:${token}`);
        expect(serialized).not.toContain(CLIENT.ipAddress);
      });

      /** `rules/outbox.mdc` rule 2: nothing external is touched from inside the transaction. */
      it('hands the notice over after the revoking scope has closed', async () => {
        const test = harness();

        test.unitOfWork.onScopeClosed = (): void => {
          expect(test.dispatcher.dispatched).toEqual([]);
        };

        await replay(test);

        expect(test.dispatcher.dispatched).toHaveLength(1);
      });

      /**
       * The recipient is read *after* the revocation committed, in a scope of its own. Reading it
       * inside the revoking transaction would put the mail path in a position to undo the defence:
       * an exhausted pool or a backend restarting mid-statement would roll back the revocation and
       * its trail together, leaving the stolen token working and nothing recording that anybody
       * noticed. Three scopes, in order: the rotation, the revocation, the read.
       */
      it('reads the recipient outside the transaction that revoked', async () => {
        const test = harness();

        await replay(test);

        expect(test.unitOfWork.scopes).toHaveLength(3);
      });

      /**
       * And the consequence that count exists for: a read of the recipient that fails leaves the
       * revocation and its trail standing. Inside the revoking transaction this would roll both
       * back — a stolen token still working, with nothing recording that it was noticed.
       */
      it('keeps the revocation when the recipient cannot be read', async () => {
        const test = harness();
        const token = await signIn(test);

        await test.refresh.execute({ refreshToken: token, client: CLIENT });
        test.clock.advance(REFRESH_RACE_GRACE_SECONDS + 1);
        test.users.findById = (): Promise<never> => Promise.reject(new Error('connection lost'));

        await expect(test.refresh.execute({ refreshToken: token, client: CLIENT })).rejects.toThrow(
          'connection lost',
        );

        expect([...test.sessions.rows.values()].every((row) => row.revokedAt !== null)).toBe(true);
        expect(test.audit.events).toHaveLength(1);
        expect(test.dispatcher.dispatched).toEqual([]);
      });

      it('sends nothing when the loss was a race rather than theft', async () => {
        const test = harness();
        const token = await signIn(test);

        await test.refresh.execute({ refreshToken: token, client: CLIENT });
        test.clock.advance(REFRESH_RACE_GRACE_SECONDS - 1);
        await refusal(() => test.refresh.execute({ refreshToken: token, client: CLIENT }));

        expect(test.dispatcher.dispatched).toEqual([]);
      });

      /**
       * The account can be gone by the time a stolen token is replayed — deleted rather than
       * suspended, which is what a self-hosted installation's own maintenance does. The family is
       * still closed and the trail still written; there is simply nobody left to write to.
       */
      it('revokes without a notice when the account row is gone', async () => {
        const test = harness();
        const token = await signIn(test);

        await test.refresh.execute({ refreshToken: token, client: CLIENT });
        test.clock.advance(REFRESH_RACE_GRACE_SECONDS + 1);
        test.users.rows.delete(USER_ID);

        await refusal(() => test.refresh.execute({ refreshToken: token, client: CLIENT }));

        expect(test.dispatcher.dispatched).toEqual([]);
        expect(test.audit.events).toHaveLength(1);
        expect([...test.sessions.rows.values()].every((row) => row.revokedAt !== null)).toBe(true);
      });

      /**
       * A mail per presentation would hand the attacker a mailer aimed at the person they stole
       * from: the family is already closed, so replaying the same token ten more times must cost
       * ten more log lines and no further messages. What bounds it is the revocation itself —
       * `UPDATE … WHERE family_id = $1 AND revoked_at IS NULL` matches nothing the second time —
       * rather than a counter somebody has to keep somewhere.
       */
      it('sends once per family, however many times the token comes back', async () => {
        const test = harness();
        const token = await replay(test);

        for (let attempt = 0; attempt < 3; attempt += 1) {
          await refusal(() => test.refresh.execute({ refreshToken: token, client: CLIENT }));
        }

        expect(test.dispatcher.dispatched).toHaveLength(1);
        expect(reuseEvents(test.logger)).toHaveLength(4);
      });

      /**
       * The revocation is the defence and the mail is the courtesy. An installation whose relay is
       * down still closes the family, still writes the trail, and still answers the replay with the
       * one refusal — proven through the real dispatcher and a transport that fails, because that
       * is where the swallowing actually happens (`ImmediateMailDispatcher`, «Why it never throws»).
       */
      it('revokes the family even when the transport is down', async () => {
        const transport = new FakeMail();

        transport.failure = 'connection';

        const dispatcher = new ImmediateMailDispatcher(transport, new RecordingLogger());
        const test = harness({ dispatcher });

        await replay(test);
        await dispatcher.drain();

        expect([...test.sessions.rows.values()].every((row) => row.revokedAt !== null)).toBe(true);
        expect(test.audit.events).toHaveLength(1);
        expect(transport.sent).toHaveLength(1);
      });
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
