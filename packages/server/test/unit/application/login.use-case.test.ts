import { describe, expect, it } from 'vitest';

import { LoginUseCase } from '@/application/identity/use-cases/login.use-case.js';
import { IssueSessionUseCase } from '@/application/identity/use-cases/issue-session.use-case.js';
import { type LogFields } from '@/application/platform/ports/logger.port.js';
import { SECURITY_EVENTS } from '@/domain/identity/security-event.constant.js';
import { type AppError } from '@/domain/shared/errors/app.errors.js';
import {
  authUser,
  FakeAccessTokens,
  FakeAddressHasher,
  FakeAuthLookup,
  FakeClock,
  FakeIdGenerator,
  FakeOrganizations,
  FakePasswordHasher,
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

const PASSWORD = 'correct-horse-battery';

const CLIENT = { userAgent: 'Firefox/128.0', ipAddress: '203.0.113.42' };

interface Harness {
  readonly login: LoginUseCase;
  readonly lookup: FakeAuthLookup;
  readonly hasher: FakePasswordHasher;
  readonly users: FakeUsers;
  readonly sessions: FakeSessions;
  readonly unitOfWork: FakeUnitOfWork;
  readonly accessTokens: FakeAccessTokens;
  readonly rateLimit: FakeRateLimit;
  readonly logger: RecordingLogger;
  /** What the hasher and the limiter did, in the order they did it. */
  readonly journal: string[];
}

const harness = (
  users: ReturnType<typeof authUser>[] = [authUser()],
  rateLimitOptions: Omit<FakeRateLimitOptions, 'journal'> = {},
): Harness => {
  const clock = new FakeClock();
  const lookup = new FakeAuthLookup(users);
  const journal: string[] = [];
  const hasher = new FakePasswordHasher(journal);
  const sessions = new FakeSessions(clock);
  const organizations = new FakeOrganizations();
  const accessTokens = new FakeAccessTokens();
  const userRows = new FakeUsers();
  const unitOfWork = new FakeUnitOfWork();
  const rateLimit = new FakeRateLimit({ ...rateLimitOptions, journal });
  const logger = new RecordingLogger();

  const issue = new IssueSessionUseCase(
    sessions,
    organizations,
    new FakeRefreshTokens(),
    accessTokens,
    new FakeAddressHasher(),
    clock,
    new FakeIdGenerator(),
  );

  return {
    login: new LoginUseCase(lookup, hasher, userRows, unitOfWork, issue, rateLimit, logger),
    lookup,
    hasher,
    users: userRows,
    sessions,
    unitOfWork,
    accessTokens,
    rateLimit,
    logger,
    journal,
  };
};

const refusal = async (
  run: () => Promise<unknown>,
): Promise<{ error: AppError; elapsedCalls: number }> => {
  try {
    await run();
  } catch (error) {
    return { error: error as AppError, elapsedCalls: 0 };
  }

  throw new Error('expected the sign-in to be refused');
};

describe('signing in', () => {
  it('answers with a session, a profile and the organization', async () => {
    const { login, accessTokens } = harness();

    const result = await login.execute({
      email: 'ada@example.com',
      password: PASSWORD,
      client: CLIENT,
    });

    expect(result.status).toBe('authenticated');

    if (result.status !== 'authenticated') return;

    expect(result.user).toEqual({
      id: USER_ID,
      email: 'ada@example.com',
      locale: 'en',
      timezone: 'Europe/Berlin',
    });
    expect(result.organization).toEqual({
      id: ORGANIZATION_ID,
      name: 'Bad Company',
      slug: 'bad-company',
    });
    expect(result.session.accessToken).not.toBe('');
    expect(result.session.refreshToken).not.toBe('');
    expect(accessTokens.issued[0]).toMatchObject({
      userId: USER_ID,
      organizationId: ORGANIZATION_ID,
      permissionsVersion: 1,
    });
  });

  it('opens the tenant scope of the organization it signed in to', async () => {
    const { login, unitOfWork } = harness();

    await login.execute({ email: 'ada@example.com', password: PASSWORD, client: CLIENT });

    expect(unitOfWork.scopes).toEqual([{ organizationId: ORGANIZATION_ID, userId: USER_ID }]);
  });

  /**
   * The acceptance criterion of the epic, and the one this whole use-case is shaped around.
   *
   * Two assertions, because the requirement has two halves and the second is the one an
   * implementation loses first: the *answer* has to be identical, and so does the *work done to
   * produce it*. Skipping the verification when there is no user turns a hundred milliseconds into
   * microseconds, which a script measures far more reliably than it reads a body.
   */
  describe('when the credentials are refused', () => {
    it('answers an unknown address exactly as it answers a wrong password', async () => {
      const unknown = await refusal(() =>
        harness().login.execute({
          email: 'nobody@example.com',
          password: PASSWORD,
          client: CLIENT,
        }),
      );
      const wrong = await refusal(() =>
        harness().login.execute({
          email: 'ada@example.com',
          password: 'wrong-password',
          client: CLIENT,
        }),
      );

      expect(unknown.error.code).toBe('invalid_credentials');
      expect(unknown.error.status).toBe(401);
      expect(unknown.error.code).toBe(wrong.error.code);
      expect(unknown.error.status).toBe(wrong.error.status);
      expect(unknown.error.message).toBe(wrong.error.message);
      expect(unknown.error.details).toBeUndefined();
    });

    it('verifies a dummy digest when there is no user, so the two cost the same', async () => {
      const unknown = harness();
      const wrong = harness();

      await refusal(() =>
        unknown.login.execute({ email: 'nobody@example.com', password: PASSWORD, client: CLIENT }),
      );
      await refusal(() =>
        wrong.login.execute({
          email: 'ada@example.com',
          password: 'wrong-password',
          client: CLIENT,
        }),
      );

      expect(unknown.hasher.verified).toHaveLength(1);
      expect(unknown.hasher.verified).toHaveLength(wrong.hasher.verified.length);
      expect(unknown.hasher.verified[0]?.digest).toBe(unknown.hasher.dummyHash);
    });

    it('writes no session and opens no tenant scope', async () => {
      const { login, sessions, unitOfWork } = harness();

      await refusal(() =>
        login.execute({ email: 'nobody@example.com', password: PASSWORD, client: CLIENT }),
      );

      expect(sessions.rows.size).toBe(0);
      expect(unitOfWork.scopes).toEqual([]);
    });

    /**
     * A slug nobody has must be refused the same way. It is the other half of the enumeration
     * question — "which organizations exist on this installation" — and the contract answers it
     * explicitly (`LoginRequest.organizationSlug`).
     */
    it('answers an unknown organization slug the same way, still verifying a digest', async () => {
      const { login, hasher } = harness();

      const error = await refusal(() =>
        login.execute({
          email: 'ada@example.com',
          password: PASSWORD,
          organizationSlug: 'no-such-company',
          client: CLIENT,
        }),
      );

      expect(error.error.code).toBe('invalid_credentials');
      expect(hasher.verified).toHaveLength(1);
      expect(hasher.verified[0]?.digest).toBe(hasher.dummyHash);
    });
  });

  /**
   * `account_suspended` is reachable only *after* a correct password. Anything else would make it a
   * second answer for "does this address exist", which is what `invalid_credentials` exists to avoid
   * (`docs/api/openapi.yaml`, `AccountSuspended`).
   */
  describe('an account that may not open a session', () => {
    it('refuses a suspended account with its own code, once the password verified', async () => {
      const { login, sessions } = harness([authUser({ status: 'SUSPENDED' })]);

      const { error } = await refusal(() =>
        login.execute({ email: 'ada@example.com', password: PASSWORD, client: CLIENT }),
      );

      expect(error.code).toBe('account_suspended');
      expect(error.status).toBe(403);
      expect(sessions.rows.size).toBe(0);
    });

    it('does not reveal a suspended account to somebody with the wrong password', async () => {
      const { login } = harness([authUser({ status: 'SUSPENDED' })]);

      const { error } = await refusal(() =>
        login.execute({ email: 'ada@example.com', password: 'wrong-password', client: CLIENT }),
      );

      expect(error.code).toBe('invalid_credentials');
    });

    /**
     * An invited account has a row and no password anybody set. It is answered as a refused
     * credential rather than as a suspension: nothing was suspended, and the honest message —
     * "accept your invitation" — is not one the sign-in form may give to a stranger.
     */
    it('answers an invited account as a refused credential', async () => {
      const { login } = harness([authUser({ status: 'INVITED' })]);

      const { error } = await refusal(() =>
        login.execute({ email: 'ada@example.com', password: PASSWORD, client: CLIENT }),
      );

      expect(error.code).toBe('invalid_credentials');
    });
  });

  describe('an address used in more than one organization', () => {
    const two = [
      authUser(),
      authUser({
        userId: 'c0ffee00-0000-4000-8000-000000000001',
        organizationId: '1d0f8a2b-6c34-4e51-b8aa-9f2e7c5d31b4',
        organizationName: 'Side Project',
        organizationSlug: 'side-project',
      }),
    ];

    it('asks which one, and only after the password verified', async () => {
      const { login, sessions, hasher } = harness(two);

      const result = await login.execute({
        email: 'ada@example.com',
        password: PASSWORD,
        client: CLIENT,
      });

      expect(result).toEqual({
        status: 'organization_selection_required',
        organizations: [
          { id: ORGANIZATION_ID, name: 'Bad Company', slug: 'bad-company' },
          {
            id: '1d0f8a2b-6c34-4e51-b8aa-9f2e7c5d31b4',
            name: 'Side Project',
            slug: 'side-project',
          },
        ],
      });
      expect(sessions.rows.size).toBe(0);
      expect(hasher.verified).toHaveLength(2);
    });

    it('says nothing about the multiplicity when the password is wrong', async () => {
      const { login } = harness(two);

      const { error } = await refusal(() =>
        login.execute({ email: 'ada@example.com', password: 'wrong-password', client: CLIENT }),
      );

      expect(error.code).toBe('invalid_credentials');
    });

    it('signs in to the organization the repeat call names', async () => {
      const { login } = harness(two);

      const result = await login.execute({
        email: 'ada@example.com',
        password: PASSWORD,
        organizationSlug: 'side-project',
        client: CLIENT,
      });

      expect(result.status).toBe('authenticated');

      if (result.status !== 'authenticated') return;

      expect(result.organization.slug).toBe('side-project');
    });

    /**
     * Only the organizations whose password matched. Two accounts of one person may have different
     * passwords, and listing the ones that did not verify would answer "where else does this address
     * have an account" to somebody who guessed only one of them.
     */
    it('signs in directly when only one of two accounts holds that password', async () => {
      const { login, accessTokens } = harness([
        authUser(),
        authUser({
          userId: 'c0ffee00-0000-4000-8000-000000000001',
          organizationId: '1d0f8a2b-6c34-4e51-b8aa-9f2e7c5d31b4',
          organizationSlug: 'side-project',
          passwordHash: '$argon2id$hashed:a-different-password',
        }),
      ]);

      const result = await login.execute({
        email: 'ada@example.com',
        password: PASSWORD,
        client: CLIENT,
      });

      expect(result.status).toBe('authenticated');
      expect(accessTokens.issued[0]?.organizationId).toBe(ORGANIZATION_ID);
    });

    it('offers only the organizations the password actually opened', async () => {
      const { login } = harness([
        authUser(),
        authUser({
          userId: 'c0ffee00-0000-4000-8000-000000000001',
          organizationId: '1d0f8a2b-6c34-4e51-b8aa-9f2e7c5d31b4',
          organizationName: 'Side Project',
          organizationSlug: 'side-project',
        }),
        authUser({
          userId: 'c0ffee00-0000-4000-8000-000000000002',
          organizationId: '2e1f9b3c-7d45-4f62-a9bb-0e3f8d6e42c5',
          organizationName: 'Former Employer',
          organizationSlug: 'former-employer',
          passwordHash: '$argon2id$hashed:a-different-password',
        }),
      ]);

      const result = await login.execute({
        email: 'ada@example.com',
        password: PASSWORD,
        client: CLIENT,
      });

      expect(result).toEqual({
        status: 'organization_selection_required',
        organizations: [
          { id: ORGANIZATION_ID, name: 'Bad Company', slug: 'bad-company' },
          {
            id: '1d0f8a2b-6c34-4e51-b8aa-9f2e7c5d31b4',
            name: 'Side Project',
            slug: 'side-project',
          },
        ],
      });
    });
  });

  /**
   * The status rule applies to every candidate, not only to the one that happens to be alone.
   *
   * Before this was fixed the selection branch answered *before* any status was looked at, so a
   * person with two accounts saw a suspended organization offered to them — and a single-account
   * holder in the same state was refused. One address, two behaviours, decided by how many rows the
   * lookup returned.
   */
  describe('a suspended account among several', () => {
    const suspendedSecond = [
      authUser(),
      authUser({
        userId: 'c0ffee00-0000-4000-8000-000000000001',
        organizationId: '1d0f8a2b-6c34-4e51-b8aa-9f2e7c5d31b4',
        organizationName: 'Side Project',
        organizationSlug: 'side-project',
        status: 'SUSPENDED',
      }),
    ];

    it('never offers an organization the account may not open a session in', async () => {
      const { login, accessTokens } = harness(suspendedSecond);

      const result = await login.execute({
        email: 'ada@example.com',
        password: PASSWORD,
        client: CLIENT,
      });

      expect(result.status).toBe('authenticated');
      expect(accessTokens.issued[0]?.organizationId).toBe(ORGANIZATION_ID);
    });

    it('refuses with account_suspended when every verified account is suspended', async () => {
      const { login } = harness([
        authUser({ status: 'SUSPENDED' }),
        authUser({
          userId: 'c0ffee00-0000-4000-8000-000000000001',
          organizationId: '1d0f8a2b-6c34-4e51-b8aa-9f2e7c5d31b4',
          organizationSlug: 'side-project',
          status: 'SUSPENDED',
        }),
      ]);

      const { error } = await refusal(() =>
        login.execute({ email: 'ada@example.com', password: PASSWORD, client: CLIENT }),
      );

      expect(error.code).toBe('account_suspended');
    });

    it('still asks which one when two of three are usable', async () => {
      const { login } = harness([
        ...suspendedSecond,
        authUser({
          userId: 'c0ffee00-0000-4000-8000-000000000002',
          organizationId: '2e1f9b3c-7d45-4f62-a9bb-0e3f8d6e42c5',
          organizationName: 'Former Employer',
          organizationSlug: 'former-employer',
        }),
      ]);

      const result = await login.execute({
        email: 'ada@example.com',
        password: PASSWORD,
        client: CLIENT,
      });

      expect(result).toEqual({
        status: 'organization_selection_required',
        organizations: [
          { id: ORGANIZATION_ID, name: 'Bad Company', slug: 'bad-company' },
          {
            id: '2e1f9b3c-7d45-4f62-a9bb-0e3f8d6e42c5',
            name: 'Former Employer',
            slug: 'former-employer',
          },
        ],
      });
    });
  });

  describe('a digest hashed with older parameters', () => {
    it('re-hashes it in the same transaction as the sign-in', async () => {
      const { login, hasher, users, unitOfWork } = harness();

      hasher.rehashNeeded = true;
      await login.execute({ email: 'ada@example.com', password: PASSWORD, client: CLIENT });

      expect(users.rehashed).toEqual([
        { userId: USER_ID, passwordHash: `$argon2id$hashed:${PASSWORD}` },
      ]);
      expect(unitOfWork.scopes).toHaveLength(1);
    });

    it('leaves a current digest alone', async () => {
      const { login, users } = harness();

      await login.execute({ email: 'ada@example.com', password: PASSWORD, client: CLIENT });

      expect(users.rehashed).toEqual([]);
    });
  });

  /**
   * The attempt budget, and above all *where* it is spent.
   *
   * A limiter consulted after the password has been verified is not a limiter: argon2id at the
   * configured cost allocates 19 MiB per call, so an unbounded login endpoint is a memory
   * exhaustion vector whether or not anybody ever guesses a password (`docs/security/threat-model.md`,
   * T-IAM-08; STORY-006-07). That is why the first assertion below is about order rather than about
   * a status code — a status code stays green if `consume` is moved one line down.
   */
  describe('the attempt budget', () => {
    it('spends a point before any digest is verified', async () => {
      const { login, journal } = harness();

      await login.execute({ email: 'ada@example.com', password: PASSWORD, client: CLIENT });

      expect(journal[0]).toBe('rate-limit:consume:auth_attempt');
      expect(journal.indexOf('rate-limit:consume:auth_attempt')).toBeLessThan(
        journal.indexOf('password:verify'),
      );
    });

    it('counts the pair of address and account, never one of the two alone', async () => {
      const { login, rateLimit } = harness();

      await login.execute({ email: 'ada@example.com', password: PASSWORD, client: CLIENT });

      expect(rateLimit.consumed).toEqual([
        {
          policy: 'auth_attempt',
          subject: { ipAddress: '203.0.113.42', email: 'ada@example.com' },
        },
      ]);
    });

    it('refuses the attempt over budget with rate_limited and the seconds left', async () => {
      const { login } = harness([authUser()], {
        limits: { auth_attempt: 0 },
        retryAfterSeconds: 873,
      });

      const { error } = await refusal(() =>
        login.execute({ email: 'ada@example.com', password: PASSWORD, client: CLIENT }),
      );

      expect(error.code).toBe('rate_limited');
      expect(error.status).toBe(429);
      expect((error as { retryAfterSeconds?: number }).retryAfterSeconds).toBe(873);
    });

    it('verifies nothing at all once the budget is gone', async () => {
      const { login, hasher, lookup } = harness([authUser()], { limits: { auth_attempt: 0 } });

      await refusal(() =>
        login.execute({ email: 'ada@example.com', password: PASSWORD, client: CLIENT }),
      );

      expect(hasher.verified).toEqual([]);
      expect(lookup.users).toHaveLength(1);
    });

    it('clears the counter once the credential is accepted', async () => {
      const { login, rateLimit } = harness();

      await login.execute({ email: 'ada@example.com', password: PASSWORD, client: CLIENT });

      expect(rateLimit.cleared).toEqual([
        {
          policy: 'auth_attempt',
          subject: { ipAddress: '203.0.113.42', email: 'ada@example.com' },
        },
      ]);
    });

    it('leaves the counter alone when the credential was refused', async () => {
      const { login, rateLimit } = harness();

      await refusal(() =>
        login.execute({ email: 'ada@example.com', password: 'wrong-password', client: CLIENT }),
      );

      expect(rateLimit.cleared).toEqual([]);
    });

    /**
     * Fail closed. A store that cannot be reached must not become an admission: making Redis
     * unreachable would otherwise be the cheapest way to switch the brute-force defence off
     * (T-IAM-03). The use-case does not catch it, so the 503 the adapter raises is what the client
     * gets — the answer `docs/api/openapi.yaml` declares on this operation.
     */
    it('lets a limiter failure refuse the sign-in rather than admit it', async () => {
      const { login, hasher } = harness([authUser()], { unavailable: true });

      const { error } = await refusal(() =>
        login.execute({ email: 'ada@example.com', password: PASSWORD, client: CLIENT }),
      );

      expect(error.code).toBe('service_unavailable');
      expect(hasher.verified).toEqual([]);
    });
  });
});

/**
 * What the sign-in path writes down.
 *
 * Before this, the whole of `application/identity` contained exactly one call to a logger — the
 * refresh-reuse detection — so a refused sign-in was visible only as the error handler's generic
 * `request rejected`, with no subject and no source. The practical consequence is that a
 * credential-stuffing campaign cannot be described: "one address, ten thousand attempts" and "ten
 * thousand people mistyped a password" produce the same log.
 *
 * The address is masked by `domain/identity/mask-ip-address.util.ts` before it is written — a full
 * address is personal data and is not stored anywhere, logs included (`CLAUDE.md`, «Персональные
 * данные»). The email is never written at all.
 */
describe('what the sign-in path records', () => {
  const linesOf = (test: Harness, level: string): { fields: LogFields; message: string }[] =>
    test.logger.lines.filter((line) => line.level === level);

  it('records a refused credential at warn, with the masked source and no address', async () => {
    const test = harness();

    await refusal(() =>
      test.login.execute({ email: 'ada@example.com', password: 'wrong-password', client: CLIENT }),
    );

    const [line] = linesOf(test, 'warn');

    expect(line?.fields).toMatchObject({
      event: SECURITY_EVENTS.signInFailed,
      outcome: 'invalid_credentials',
      ipMasked: '203.0.113.0/24',
    });
    expect(JSON.stringify(line)).not.toContain('ada@example.com');
    expect(JSON.stringify(line)).not.toContain('203.0.113.42');
  });

  it('distinguishes a suspended account from a wrong password, in the log only', async () => {
    const test = harness([authUser({ status: 'SUSPENDED' })]);

    await refusal(() =>
      test.login.execute({ email: 'ada@example.com', password: PASSWORD, client: CLIENT }),
    );

    expect(linesOf(test, 'warn')[0]?.fields).toMatchObject({ outcome: 'account_suspended' });
  });

  it('records a refusal by the limiter too, so a burst has a source', async () => {
    const test = harness([authUser()], { limits: { auth_attempt: 0 } });

    await refusal(() =>
      test.login.execute({ email: 'ada@example.com', password: PASSWORD, client: CLIENT }),
    );

    expect(linesOf(test, 'warn')[0]?.fields).toMatchObject({
      event: SECURITY_EVENTS.signInFailed,
      outcome: 'rate_limited',
      ipMasked: '203.0.113.0/24',
    });
  });

  it('records a successful sign-in at info, with the identifiers an investigation needs', async () => {
    const test = harness();

    await test.login.execute({ email: 'ada@example.com', password: PASSWORD, client: CLIENT });

    const [line] = linesOf(test, 'info');

    expect(line?.fields).toMatchObject({
      event: SECURITY_EVENTS.signInSucceeded,
      outcome: 'session_opened',
      userId: USER_ID,
      organizationId: ORGANIZATION_ID,
      sessionId: expect.any(String) as string,
      ipMasked: '203.0.113.0/24',
    });
    expect(JSON.stringify(line)).not.toContain('ada@example.com');
  });

  /**
   * A verified password that stops at the organization picker is still a successful
   * authentication, and the one thing it must not carry is *which* accounts matched.
   */
  it('records the selection branch without naming the organizations', async () => {
    const test = harness([
      authUser(),
      authUser({ organizationSlug: 'side-project', organizationName: 'Side Project' }),
    ]);

    await test.login.execute({ email: 'ada@example.com', password: PASSWORD, client: CLIENT });

    const [line] = linesOf(test, 'info');

    expect(line?.fields).toMatchObject({
      event: SECURITY_EVENTS.signInSucceeded,
      outcome: 'organization_selection_required',
    });
    expect(JSON.stringify(line)).not.toContain('side-project');
  });
});
