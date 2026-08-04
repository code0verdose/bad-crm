import { describe, expect, it } from 'vitest';

import { type SessionRevokedReason } from '@/application/identity/ports/session-repository.port.js';
import { ConfirmPasswordResetUseCase } from '@/application/identity/use-cases/confirm-password-reset.use-case.js';
import { SECURITY_EVENTS } from '@/domain/identity/security-event.constant.js';
import {
  PasswordResetTokenInvalidError,
  RateLimitedError,
  ValidationError,
} from '@/domain/shared/errors/app.errors.js';

import {
  authUser,
  FakeAuthLookup,
  FakeAuditLogger,
  FakeClock,
  FakePasswordHasher,
  FakePasswordResetTokens,
  FakeRateLimit,
  type FakeRateLimitOptions,
  FakeResetTokens,
  FakeSessions,
  FakeUnitOfWork,
  FakeUsers,
  ORGANIZATION_ID,
  RecordingLogger,
  USER_ID,
} from '../../support/identity-doubles.util.js';

/**
 * Spending a reset token.
 *
 * Two properties carry the whole operation, and both are properties of *when* rather than of what:
 * the token is spent by a single conditional statement, so two clicks on one link cannot both win;
 * and unknown, spent and expired are one answer, so a holder of a guessed token learns nothing —
 * including whether it ever existed.
 */

const NEW_PASSWORD = 'staple-generator-lantern';

interface Harness {
  readonly useCase: ConfirmPasswordResetUseCase;
  readonly tokens: FakePasswordResetTokens;
  readonly resetTokens: FakeResetTokens;
  readonly sessions: FakeSessions;
  readonly users: FakeUsers;
  readonly hasher: FakePasswordHasher;
  readonly clock: FakeClock;
  readonly rateLimit: FakeRateLimit;
  readonly logger: RecordingLogger;
  readonly unitOfWork: FakeUnitOfWork;
  /** Shared by the hasher and the limiter, so a test can assert which of the two ran first. */
  readonly journal: string[];
  /** Issues a live token for the seeded account and answers the value that would be in the link. */
  readonly issueToken: () => Promise<string>;
}

const buildHarness = (
  options: {
    readonly rateLimit?: FakeRateLimitOptions;
    /** The status of the account the token resolves to; `ACTIVE` unless a test says otherwise. */
    readonly status?: string;
  } = {},
): Harness => {
  const clock = new FakeClock();
  const journal: string[] = [];
  const unitOfWork = new FakeUnitOfWork();
  const audit = new FakeAuditLogger();
  const tokens = new FakePasswordResetTokens(unitOfWork, journal);
  const resetTokens = new FakeResetTokens();
  const sessions = new FakeSessions(clock);
  const account = authUser({ status: options.status ?? 'ACTIVE' });
  // The account exists as a row inside the tenant as well as behind the `app_auth` resolver: the
  // reset re-reads it through `UserRepositoryPort` before it writes, to see whether it may still
  // sign in at all.
  const users = new FakeUsers([
    {
      id: account.userId,
      email: account.email,
      locale: account.locale,
      timezone: account.timezone,
      status: account.status,
      permissionsVersion: account.permissionsVersion,
    },
  ]);
  const lookup = new FakeAuthLookup([account]).readingResetTokens(tokens);
  const hasher = new FakePasswordHasher(journal);
  const rateLimit = new FakeRateLimit({ journal, ...(options.rateLimit ?? {}) });
  const logger = new RecordingLogger();

  users.credentials.set(USER_ID, {
    email: 'ada@example.com',
    passwordHash: '$argon2id$hashed:correct-horse-battery',
    locale: 'en',
  });

  return {
    useCase: new ConfirmPasswordResetUseCase(
      lookup,
      tokens,
      resetTokens,
      users,
      sessions,
      hasher,
      unitOfWork,
      rateLimit,
      clock,
      logger,
      audit,
    ),
    tokens,
    resetTokens,
    sessions,
    users,
    hasher,
    clock,
    rateLimit,
    logger,
    unitOfWork,
    journal,
    issueToken: async (): Promise<string> => {
      const minted = resetTokens.mint();

      await unitOfWork.withTenant({ organizationId: ORGANIZATION_ID, userId: USER_ID }, () =>
        tokens.create({
          userId: USER_ID,
          tokenHash: minted.hash,
          expiresAt: new Date(clock.now().getTime() + 60 * 60 * 1000),
          requestedIpHash: 'hmac',
        }),
      );

      return minted.token;
    },
  };
};

const openFamily = (sessions: FakeSessions, familyId: string): Promise<unknown> =>
  sessions.create({
    userId: USER_ID,
    familyId,
    rotatedFromId: null,
    refreshTokenHash: new TextEncoder().encode(`sha256:${familyId}`),
    userAgent: 'suite',
    ipHash: 'hmac',
    ipMasked: '203.0.113.0/24',
    expiresAt: new Date('2026-08-28T10:00:00.000Z'),
  });

const confirm = (harness: Harness, token: string, newPassword = NEW_PASSWORD): Promise<void> =>
  harness.useCase.execute({
    token,
    newPassword,
    client: { userAgent: 'suite', ipAddress: '203.0.113.7' },
  });

const livingFamilies = (sessions: FakeSessions): string[] =>
  [...sessions.rows.values()]
    .filter((row) => row.revokedAt === null)
    .map((row) => row.familyId)
    .sort();

const revokedReasons = (sessions: FakeSessions): SessionRevokedReason[] => [
  ...new Set(
    [...sessions.rows.values()]
      .map((row) => row.revokedReason)
      .filter((reason): reason is SessionRevokedReason => reason !== null),
  ),
];

describe('spending a reset token', () => {
  it('sets the new password and marks the token used', async () => {
    const harness = buildHarness();
    const token = await harness.issueToken();

    await confirm(harness, token);

    expect(harness.users.rehashed).toEqual([
      { userId: USER_ID, passwordHash: `$argon2id$hashed:${NEW_PASSWORD}` },
    ]);
    expect([...harness.tokens.rows.values()][0]?.usedAt).not.toBeNull();
  });

  /**
   * **Every** session, not every other one: somebody who has to recover access usually has to
   * because access is in somebody else's hands too.
   */
  it('closes every session of the account, keeping none', async () => {
    const harness = buildHarness();

    await openFamily(harness.sessions, '11111111-1111-4111-8111-111111111111');
    await openFamily(harness.sessions, '22222222-2222-4222-8222-222222222222');

    await confirm(harness, await harness.issueToken());

    expect(livingFamilies(harness.sessions)).toEqual([]);
    expect(revokedReasons(harness.sessions)).toEqual(['PASSWORD_CHANGED']);
  });

  it('issues no session and no token of its own', async () => {
    const harness = buildHarness();

    await expect(confirm(harness, await harness.issueToken())).resolves.toBeUndefined();
    expect([...harness.sessions.rows.values()]).toEqual([]);
  });

  it('runs the write in the tenant the token resolved to', async () => {
    const harness = buildHarness();

    await confirm(harness, await harness.issueToken());

    expect(harness.unitOfWork.scopes).toContainEqual({
      organizationId: ORGANIZATION_ID,
      userId: USER_ID,
    });
  });

  it('records the reset as an event, without the token and without the address', async () => {
    const harness = buildHarness();
    const token = await harness.issueToken();

    await confirm(harness, token);

    const line = harness.logger.lines.find(
      (entry) => entry.fields['event'] === SECURITY_EVENTS.passwordResetCompleted,
    );

    expect(line?.fields).toMatchObject({ organizationId: ORGANIZATION_ID, userId: USER_ID });
    expect(JSON.stringify(harness.logger.lines)).not.toContain(token);
    expect(JSON.stringify(harness.logger.lines)).not.toContain('ada@example.com');
  });
});

describe('a token that cannot be spent', () => {
  it.each([
    ['unknown', async (harness: Harness): Promise<string> => `${await harness.issueToken()}-nope`],
    [
      'already used',
      async (harness: Harness): Promise<string> => {
        const token = await harness.issueToken();

        await confirm(harness, token);

        return token;
      },
    ],
    [
      'expired',
      async (harness: Harness): Promise<string> => {
        const token = await harness.issueToken();

        harness.clock.advance(61 * 60);

        return token;
      },
    ],
  ])('answers %s with the one refusal the contract publishes', async (_case, prepare) => {
    const harness = buildHarness();
    const token = await prepare(harness);

    const failure = await confirm(harness, token).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PasswordResetTokenInvalidError);
    expect(failure).toMatchObject({ code: 'password_reset_token_invalid', status: 400 });
  });

  /**
   * The second click on a link loses a race rather than resetting a password twice. Modelled here
   * as two calls with one token; the same property against real concurrent statements is asserted
   * on PostgreSQL in `test/integration/auth/password-reset.test.ts`.
   */
  it('lets exactly one of two attempts with the same token win', async () => {
    const harness = buildHarness();
    const token = await harness.issueToken();

    const outcomes = await Promise.allSettled([confirm(harness, token), confirm(harness, token)]);

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(harness.users.rehashed).toHaveLength(1);
  });

  it('says nothing in the log about which of the three it was', async () => {
    const harness = buildHarness();

    await confirm(harness, 'no-such-token').catch(() => undefined);

    const line = harness.logger.lines.find(
      (entry) => entry.fields['event'] === SECURITY_EVENTS.passwordResetRefused,
    );

    expect(line).toBeDefined();
    expect(Object.keys(line?.fields ?? {})).not.toContain('reason');
    expect(Object.keys(line?.fields ?? {})).not.toContain('outcome');
  });
});

describe('a new password the policy refuses', () => {
  it.each([
    ['refused by the policy', 'aaaaaaaaaaaa'],
    ['a keyboard walk', 'password12345'],
  ])('answers 422 on newPassword and leaves the token usable — %s', async (_case, weak) => {
    const harness = buildHarness();
    const token = await harness.issueToken();

    const failure = await confirm(harness, token, weak).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ValidationError);
    expect((failure as ValidationError).issues.map((issue) => issue.path)).toEqual(['newPassword']);
    expect([...harness.tokens.rows.values()][0]?.usedAt).toBeNull();

    // And the token really is still usable, which is what "leaves it usable" has to mean.
    await expect(confirm(harness, token)).resolves.toBeUndefined();
  });
});

/**
 * The budget of the confirm half, and the thing that actually bounds the expensive work.
 *
 * This block used to assert the ambient budget and stop there, which read as a statement that
 * 300 requests a minute is an adequate allowance for a path that runs Argon2id — and it was not.
 * It was not because the digest used to be computed *before* the token was spent: a holder of one
 * legitimate token could replay it, and every replay resolved a row, allocated 19 MiB and only then
 * discovered that the row had already been spent. One token bought an unlimited number of hashes.
 *
 * What bounds the hashing is not this counter. It is the order: nothing is hashed until the
 * conditional `UPDATE` has actually spent a row, and a row can be spent once. The number of digests
 * an address can force is therefore the number of tokens `POST /auth/forgot-password` issued to it,
 * and *that* is what carries the five-per-fifteen-minutes of `rules/security.mdc` rule 11 — spent
 * there, where the operation has an email and the subject can be the pair the limiter is designed
 * for (`rate-limit.port.ts`).
 *
 * So the ambient counter stays what it is: the allowance that keeps anybody from making this
 * endpoint the cheapest way to fill a log file. The assertions that matter are in
 * «the cost of a token that cannot be spent» below.
 */
describe('the budget of the confirm half', () => {
  it('is spent on the caller’s address, before the token is resolved', async () => {
    const harness = buildHarness();

    await confirm(harness, 'no-such-token').catch(() => undefined);

    expect(harness.rateLimit.consumed).toEqual([
      { policy: 'api_request', subject: { userId: undefined, ipAddress: '203.0.113.7' } },
    ]);
  });

  it('refuses over the limit', async () => {
    const harness = buildHarness({ rateLimit: { limits: { api_request: 1 } } });

    await confirm(harness, 'no-such-token').catch(() => undefined);

    await expect(confirm(harness, await harness.issueToken())).rejects.toBeInstanceOf(
      RateLimitedError,
    );
  });
});

describe('the cost of a token that cannot be spent', () => {
  it('computes no digest for a token that does not resolve', async () => {
    const harness = buildHarness();

    await confirm(harness, 'no-such-token').catch(() => undefined);

    expect(harness.hasher.hashed).toEqual([]);
  });

  it('computes no digest for a token that resolved and had already been spent', async () => {
    const harness = buildHarness();
    const token = await harness.issueToken();

    await confirm(harness, token);
    harness.hasher.hashed.length = 0;

    await confirm(harness, token).catch(() => undefined);

    expect(harness.hasher.hashed).toEqual([]);
  });

  it('computes no digest for a token that resolved and had expired', async () => {
    const harness = buildHarness();
    const token = await harness.issueToken();

    harness.clock.advance(61 * 60);

    await confirm(harness, token).catch(() => undefined);

    expect(harness.hasher.hashed).toEqual([]);
  });

  /**
   * The finding, as an assertion: one issued token costs one Argon2id, however many times the link
   * is replayed. At 19 MiB and roughly a tenth of a second each, the difference between this and
   * "one per request" is the difference between a bounded cost and a memory-exhaustion primitive
   * handed to anybody who has ever asked for a reset (`docs/security/threat-model.md`, T-IAM-08).
   */
  it('costs one digest per issued token however often the link is replayed', async () => {
    const harness = buildHarness();
    const token = await harness.issueToken();

    for (let attempt = 0; attempt < 20; attempt += 1) {
      await confirm(harness, token).catch(() => undefined);
    }

    expect(harness.hasher.hashed).toHaveLength(1);
  });

  /** The same property stated as an order, so a reordering fails here and not only in the count. */
  it('spends the token before it hashes, never the other way round', async () => {
    const harness = buildHarness();

    await confirm(harness, await harness.issueToken());

    expect(harness.journal).toEqual([
      'rate-limit:consume:api_request',
      'reset-token:consume',
      'password:hash',
    ]);
    expect([...harness.tokens.rows.values()][0]?.usedAt).not.toBeNull();
  });
});

/**
 * Every other link of the account dies with the reset.
 *
 * The scenario is a mailbox somebody else reached for a few minutes: they ask for a reset and keep
 * the link. The owner notices, resets or changes the password, and every session closes. Without
 * this, the link the other person is holding is still good for the rest of its hour — and using it
 * sets a third password and closes the sessions the owner has just opened. The same race exists
 * between two honest resets started minutes apart.
 */
describe('the other links of the same account', () => {
  const issueTwo = async (harness: Harness): Promise<[string, string]> => [
    await harness.issueToken(),
    await harness.issueToken(),
  ];

  it('spends every outstanding token of the account, not only the one presented', async () => {
    const harness = buildHarness();
    const [first] = await issueTwo(harness);

    await confirm(harness, first);

    expect([...harness.tokens.rows.values()].filter((row) => row.usedAt === null)).toEqual([]);
  });

  it('refuses a link that was issued before the reset and never used', async () => {
    const harness = buildHarness();
    const [first, second] = await issueTwo(harness);

    await confirm(harness, first);

    const failure = await confirm(harness, second, 'another-good-passphrase').catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(PasswordResetTokenInvalidError);
    expect(harness.users.rehashed).toHaveLength(1);
  });

  it('says how many other links it closed', async () => {
    const harness = buildHarness();
    const [first] = await issueTwo(harness);

    await confirm(harness, first);

    const line = harness.logger.lines.find(
      (entry) => entry.fields['event'] === SECURITY_EVENTS.passwordResetCompleted,
    );

    expect(line?.fields).toMatchObject({ revokedResetTokens: 1 });
  });
});

/**
 * A token minted for an account that could sign in, presented after it no longer can.
 *
 * `RequestPasswordResetUseCase` already refuses to mint one for a suspended account. The hour a
 * token lives is long enough for the suspension to happen in between, and the answer must be the
 * one this operation always gives: a suspension that produced its own error code would tell the
 * holder of the link that the token itself was genuine.
 */
describe('an account that may no longer sign in', () => {
  it('refuses a token whose account is suspended, and sets no password', async () => {
    const harness = buildHarness({ status: 'SUSPENDED' });
    const token = await harness.issueToken();

    const failure = await confirm(harness, token).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PasswordResetTokenInvalidError);
    expect(failure).toMatchObject({ code: 'password_reset_token_invalid', status: 400 });
    expect(harness.users.rehashed).toEqual([]);
    expect(harness.hasher.hashed).toEqual([]);
  });

  it('closes no session of the suspended account', async () => {
    const harness = buildHarness({ status: 'SUSPENDED' });

    await openFamily(harness.sessions, '11111111-1111-4111-8111-111111111111');
    await confirm(harness, await harness.issueToken()).catch(() => undefined);

    expect(livingFamilies(harness.sessions)).toEqual(['11111111-1111-4111-8111-111111111111']);
  });

  /**
   * The suspended account **keeps the spend**, and this is the assertion that holds the order.
   *
   * The two tests above pass whether the status is checked before `consume` or after it, so on their
   * own they pin the refusal and leave the ordering free — a rearrangement that checks first and
   * spends second stays green. What it would break is stated in the use-case docblock: a link minted
   * while the account was active must not become usable again the day the account is reactivated.
   * Check-then-spend leaves the row unspent and the link live for the rest of its half hour.
   *
   * So the property asserted here is the one the ordering exists for — the token is gone even though
   * nothing was written.
   */
  it('spends the token anyway, so reactivating the account does not revive the link', async () => {
    const harness = buildHarness({ status: 'SUSPENDED' });
    const token = await harness.issueToken();

    await confirm(harness, token).catch(() => undefined);

    expect([...harness.tokens.rows.values()].map((row) => row.usedAt !== null)).toEqual([true]);
  });

  /**
   * The other half of `account === null || account.status !== 'ACTIVE'`: the row is gone, not merely
   * suspended. `findById` reads `deleted_at IS NULL`, so a soft delete between issuing the link and
   * following it arrives here as `null`.
   *
   * Covered separately because `||` short-circuits: the suspended case exercises the right operand
   * and leaves the left one unexecuted, which no line-coverage number distinguishes. The equivalent
   * case exists for change-password and was simply missed here.
   */
  it('refuses a token whose account was deleted after the link was sent', async () => {
    const harness = buildHarness();
    const token = await harness.issueToken();
    harness.users.rows.delete(USER_ID);

    const failure = await confirm(harness, token).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PasswordResetTokenInvalidError);
    expect(harness.users.rehashed).toEqual([]);
    expect(harness.hasher.hashed).toEqual([]);
  });
});

/**
 * The write that matched no row.
 *
 * `updatePasswordHash` is an `updateMany`, so an account soft-deleted between the read and the
 * write leaves it matching zero rows and saying nothing about it. Before this, the operation went
 * on to revoke every session and answer 204 over a password that had not changed — a success
 * report for something that did not happen, invisible everywhere.
 */
describe('a password write that matched no row', () => {
  it('refuses instead of answering success', async () => {
    const harness = buildHarness();
    const token = await harness.issueToken();

    harness.users.vanished = true;

    const failure = await confirm(harness, token).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PasswordResetTokenInvalidError);
  });

  it('records it at error, under its own event, and closes no session', async () => {
    const harness = buildHarness();

    await openFamily(harness.sessions, '11111111-1111-4111-8111-111111111111');

    const token = await harness.issueToken();

    harness.users.vanished = true;
    await confirm(harness, token).catch(() => undefined);

    const line = harness.logger.lines.find(
      (entry) => entry.fields['event'] === SECURITY_EVENTS.passwordNotWritten,
    );

    expect(line?.level).toBe('error');
    expect(line?.fields).toMatchObject({ organizationId: ORGANIZATION_ID, userId: USER_ID });
    expect(livingFamilies(harness.sessions)).toEqual(['11111111-1111-4111-8111-111111111111']);
  });
});
