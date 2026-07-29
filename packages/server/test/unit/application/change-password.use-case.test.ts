import { describe, expect, it } from 'vitest';

import { type SessionRevokedReason } from '@/application/identity/ports/session-repository.port.js';
import { ChangePasswordUseCase } from '@/application/identity/use-cases/change-password.use-case.js';
import { SECURITY_EVENTS } from '@/domain/identity/security-event.constant.js';
import {
  RateLimitedError,
  UnauthenticatedError,
  ValidationError,
} from '@/domain/shared/errors/app.errors.js';

import {
  authUser,
  FakeClock,
  FakeMail,
  FakeMailDispatcher,
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
 * Changing one's own password, and the one thing that makes it a security operation rather than an
 * update: every *other* session of the account is closed and this one is not.
 *
 * The acceptance criterion of STORY-006-06 is not "one session survives" — it is that the surviving
 * session is the caller's own. Those two are the same sentence right up to the moment the argument
 * is wrong, and then they are the difference between "the person who was locked out is back in
 * control" and "the intruder kept the session and the owner was signed out".
 */

const CURRENT_PASSWORD = 'correct-horse-battery';
const NEW_PASSWORD = 'staple-generator-lantern';
const APP_URL = 'https://crm.example.com';

const ACTOR = { organizationId: ORGANIZATION_ID, userId: USER_ID };

interface Harness {
  readonly useCase: ChangePasswordUseCase;
  readonly sessions: FakeSessions;
  readonly users: FakeUsers;
  readonly hasher: FakePasswordHasher;
  readonly mail: FakeMail;
  readonly dispatcher: FakeMailDispatcher;
  readonly rateLimit: FakeRateLimit;
  readonly logger: RecordingLogger;
  readonly unitOfWork: FakeUnitOfWork;
  readonly journal: string[];
  readonly tokens: FakePasswordResetTokens;
  /** Opens a session family and answers its id, so a test can name the one it expects to survive. */
  readonly openFamily: (familyId: string) => Promise<void>;
  /** Writes a live reset-token row for the account, as `POST /auth/forgot-password` would have. */
  readonly issueResetToken: () => Promise<void>;
}

const buildHarness = (options: { readonly rateLimit?: FakeRateLimitOptions } = {}): Harness => {
  const clock = new FakeClock();
  const journal: string[] = [];
  const sessions = new FakeSessions(clock);
  const account = authUser();
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

  users.credentials.set(account.userId, {
    email: account.email,
    passwordHash: `$argon2id$hashed:${CURRENT_PASSWORD}`,
    locale: account.locale,
  });

  const hasher = new FakePasswordHasher(journal);
  const rateLimit = new FakeRateLimit({ journal, ...(options.rateLimit ?? {}) });
  const unitOfWork = new FakeUnitOfWork();
  const mail = new FakeMail();
  const dispatcher = new FakeMailDispatcher();
  const logger = new RecordingLogger();
  const tokens = new FakePasswordResetTokens(unitOfWork);
  const resetTokens = new FakeResetTokens();

  return {
    useCase: new ChangePasswordUseCase(
      users,
      sessions,
      tokens,
      hasher,
      unitOfWork,
      rateLimit,
      dispatcher,
      clock,
      logger,
      APP_URL,
    ),
    sessions,
    users,
    hasher,
    mail,
    dispatcher,
    rateLimit,
    logger,
    unitOfWork,
    journal,
    tokens,
    issueResetToken: async (): Promise<void> => {
      await unitOfWork.withTenant(ACTOR, () =>
        tokens.create({
          userId: account.userId,
          tokenHash: resetTokens.mint().hash,
          expiresAt: new Date(clock.now().getTime() + 60 * 60 * 1000),
          requestedIpHash: 'hmac',
        }),
      );
    },
    openFamily: async (familyId: string): Promise<void> => {
      await sessions.create({
        userId: account.userId,
        familyId,
        rotatedFromId: null,
        refreshTokenHash: new TextEncoder().encode(`sha256:${familyId}`),
        userAgent: 'suite',
        ipHash: 'hmac',
        ipMasked: '203.0.113.0/24',
        expiresAt: new Date('2026-08-28T10:00:00.000Z'),
      });
    },
  };
};

const CURRENT_FAMILY = '11111111-1111-4111-8111-111111111111';
const OTHER_FAMILY = '22222222-2222-4222-8222-222222222222';
const THIRD_FAMILY = '33333333-3333-4333-8333-333333333333';

const change = (
  harness: Harness,
  overrides: Partial<{ currentPassword: string; newPassword: string }> = {},
): Promise<void> =>
  harness.useCase.execute({
    actor: ACTOR,
    currentFamilyId: CURRENT_FAMILY,
    currentPassword: overrides.currentPassword ?? CURRENT_PASSWORD,
    newPassword: overrides.newPassword ?? NEW_PASSWORD,
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

describe('changing a password', () => {
  it('replaces the digest with one derived from the new password', async () => {
    const harness = buildHarness();

    await harness.openFamily(CURRENT_FAMILY);
    await change(harness);

    expect(harness.users.rehashed).toEqual([
      { userId: USER_ID, passwordHash: `$argon2id$hashed:${NEW_PASSWORD}` },
    ]);
  });

  /**
   * The acceptance criterion, written so that it can only pass for the right reason.
   *
   * Three families, one of them the caller's. Asserting "exactly one survives" would pass on an
   * implementation that kept the newest, the oldest or the first the map happened to yield — and
   * two of those three sign the person out of the browser they are sitting in while leaving the
   * session they were trying to close alive.
   */
  it('closes every other session family and keeps the caller’s own', async () => {
    const harness = buildHarness();

    await harness.openFamily(CURRENT_FAMILY);
    await harness.openFamily(OTHER_FAMILY);
    await harness.openFamily(THIRD_FAMILY);

    await change(harness);

    expect(livingFamilies(harness.sessions)).toEqual([CURRENT_FAMILY]);
    expect(revokedReasons(harness.sessions)).toEqual(['PASSWORD_CHANGED']);
  });

  it('writes the change as an event, with the masked source and no address of any kind', async () => {
    const harness = buildHarness();

    await harness.openFamily(CURRENT_FAMILY);
    await harness.openFamily(OTHER_FAMILY);
    await change(harness);

    const line = harness.logger.lines.find(
      (entry) => entry.fields['event'] === SECURITY_EVENTS.passwordChanged,
    );

    expect(line?.fields).toMatchObject({
      organizationId: ORGANIZATION_ID,
      userId: USER_ID,
      revokedFamilies: 1,
      ipMasked: '203.0.113.0/24',
    });
    expect(JSON.stringify(harness.logger.lines)).not.toContain('ada@example.com');
  });

  it('hands the notification to the dispatcher instead of sending it inside the operation', async () => {
    const harness = buildHarness();

    await harness.openFamily(CURRENT_FAMILY);
    await change(harness);

    expect(harness.mail.sent).toEqual([]);
    expect(harness.dispatcher.dispatched).toHaveLength(1);
    expect(harness.dispatcher.dispatched[0]?.mail.to).toBe('ada@example.com');
    expect(harness.dispatcher.dispatched[0]?.mail.text).not.toContain(NEW_PASSWORD);
    expect(harness.dispatcher.dispatched[0]?.mail.text).not.toContain(CURRENT_PASSWORD);
  });

  it('clears the attempt budget once the password has changed', async () => {
    const harness = buildHarness();

    await harness.openFamily(CURRENT_FAMILY);
    await change(harness);

    expect(harness.rateLimit.cleared).toEqual([
      { policy: 'auth_attempt', subject: { ipAddress: '203.0.113.7', email: 'ada@example.com' } },
    ]);
  });
});

describe('refusing a change', () => {
  it('answers a wrong current password as a refused credential and touches nothing', async () => {
    const harness = buildHarness();

    await harness.openFamily(CURRENT_FAMILY);
    await harness.openFamily(OTHER_FAMILY);

    await expect(change(harness, { currentPassword: 'not-the-password' })).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );

    expect(harness.users.rehashed).toEqual([]);
    expect(livingFamilies(harness.sessions)).toEqual([CURRENT_FAMILY, OTHER_FAMILY]);
    expect(harness.dispatcher.dispatched).toEqual([]);
  });

  it('reports a wrong current password as invalid_credentials, the code a refused login carries', async () => {
    const harness = buildHarness();

    await harness.openFamily(CURRENT_FAMILY);

    await expect(change(harness, { currentPassword: 'not-the-password' })).rejects.toMatchObject({
      code: 'invalid_credentials',
      status: 401,
    });
  });

  it.each([
    ['equal to the current one', CURRENT_PASSWORD],
    ['refused by the policy', 'aaaaaaaaaaaa'],
  ])('rejects a new password %s on the newPassword field', async (_case, newPassword) => {
    const harness = buildHarness();

    await harness.openFamily(CURRENT_FAMILY);

    const failure = await change(harness, { newPassword }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ValidationError);
    expect((failure as ValidationError).issues.map((issue) => issue.path)).toEqual(['newPassword']);
    expect(harness.users.rehashed).toEqual([]);
  });

  /**
   * Both refusals above are decidable from the request alone, so neither costs an Argon2id
   * verification — and neither spends a point of a budget meant for guessing attempts.
   */
  it('decides those two before the limiter and before any digest is computed', async () => {
    const harness = buildHarness();

    await harness.openFamily(CURRENT_FAMILY);
    await change(harness, { newPassword: CURRENT_PASSWORD }).catch(() => undefined);

    expect(harness.journal).toEqual([]);
  });

  it('spends the attempt budget before verifying the current password', async () => {
    const harness = buildHarness();

    await harness.openFamily(CURRENT_FAMILY);
    await change(harness);

    expect(harness.journal.indexOf('rate-limit:consume:auth_attempt')).toBeLessThan(
      harness.journal.indexOf('password:verify'),
    );
  });

  it('refuses once the budget is spent, without verifying anything', async () => {
    const harness = buildHarness({ rateLimit: { limits: { auth_attempt: 1 } } });

    await harness.openFamily(CURRENT_FAMILY);
    await change(harness, { currentPassword: 'not-the-password' }).catch(() => undefined);

    const before = harness.hasher.verified.length;

    await expect(change(harness)).rejects.toBeInstanceOf(RateLimitedError);
    expect(harness.hasher.verified).toHaveLength(before);
  });

  it('refuses when the account behind the session no longer exists', async () => {
    const harness = buildHarness();

    harness.users.credentials.clear();
    await harness.openFamily(CURRENT_FAMILY);

    await expect(change(harness)).rejects.toBeInstanceOf(UnauthenticatedError);
  });
});

/**
 * The notification is a notification, and the change is a recovery action.
 *
 * A password change is what somebody does when they think their password has leaked, and the
 * installation profile `minimal` legitimately runs without `SMTP_URL`. Refusing the change because
 * the notice cannot be sent would make a supported configuration unable to perform a basic security
 * operation, and would put a courtesy above the fix. The letter is worth sending — the person who
 * did *not* change their password learns from it — but it is not the effect of the operation, and
 * the effect has a second signal of its own: every other session is closed.
 */
describe('an installation that cannot send mail', () => {
  it('changes the password anyway and still closes the other sessions', async () => {
    const harness = buildHarness();

    harness.mail.configured = false;
    await harness.openFamily(CURRENT_FAMILY);
    await harness.openFamily(OTHER_FAMILY);

    await expect(change(harness)).resolves.toBeUndefined();

    expect(harness.users.rehashed).toEqual([
      { userId: USER_ID, passwordHash: `$argon2id$hashed:${NEW_PASSWORD}` },
    ]);
    expect(livingFamilies(harness.sessions)).toEqual([CURRENT_FAMILY]);
  });

  /**
   * It still hands the message over: one path, and the transport decides. Branching here would put
   * the knowledge of what a transport can do into the use-case, and the answer to the caller is the
   * same either way — which is the whole point.
   */
  it('hands the notification over regardless, and lets the transport report the outcome', async () => {
    const harness = buildHarness();

    harness.mail.configured = false;
    await harness.openFamily(CURRENT_FAMILY);

    await change(harness);

    expect(harness.dispatcher.dispatched).toHaveLength(1);
  });

  it('records the change as usual, so the operation is not silently different', async () => {
    const harness = buildHarness();

    harness.mail.configured = false;
    await harness.openFamily(CURRENT_FAMILY);

    await change(harness);

    expect(
      harness.logger.lines.some(
        (entry) => entry.fields['event'] === SECURITY_EVENTS.passwordChanged,
      ),
    ).toBe(true);
  });
});

describe('the transaction the change runs in', () => {
  it('writes the digest and the revocations in one scope, opened on the caller’s tenant', async () => {
    const harness = buildHarness();

    await harness.openFamily(CURRENT_FAMILY);
    await change(harness);

    expect(harness.unitOfWork.scopes).toContainEqual(ACTOR);
  });

  /**
   * SMTP is never called from inside a transaction (`rules/outbox.mdc`, rule 2). The dispatcher is
   * handed the message only after the scope that wrote the digest has closed.
   */
  it('hands the notification over after the scope has closed', async () => {
    const harness = buildHarness();

    await harness.openFamily(CURRENT_FAMILY);

    harness.unitOfWork.onScopeClosed = (): void => {
      expect(harness.dispatcher.dispatched).toEqual([]);
    };

    await change(harness);

    expect(harness.dispatcher.dispatched).toHaveLength(1);
  });
});

/**
 * The reset links that were outstanding when the password changed.
 *
 * Closing every other session and leaving a live reset link behind closes nothing: a link is a
 * credential that mints a *new* password, and the reason somebody changes theirs is the suspicion
 * that somebody else has been in their mailbox. The two writes therefore belong to the same
 * transaction as the digest — a commit that rotated the password and left a usable link is a commit
 * that handed the account over.
 */
describe('reset links that were outstanding', () => {
  it('spends every live reset token of the account', async () => {
    const harness = buildHarness();

    await harness.openFamily(CURRENT_FAMILY);
    await harness.issueResetToken();
    await harness.issueResetToken();

    await change(harness);

    expect([...harness.tokens.rows.values()].filter((row) => row.usedAt === null)).toEqual([]);
  });

  /**
   * Not "afterwards, in a second transaction": by the time the scope that wrote the digest closed,
   * the links were already gone. A commit that rotated the password and left one alive would have
   * handed the account to whoever holds it, however short the window.
   *
   * The count is taken at *every* scope close and read from the last one — the credential is read in
   * a scope of its own before this one, and asserting on the first close would only prove that
   * nothing had happened yet.
   */
  it('does it in the same scope as the digest, before the answer is decided', async () => {
    const harness = buildHarness();
    const liveAtClose: number[] = [];

    await harness.openFamily(CURRENT_FAMILY);
    await harness.issueResetToken();

    harness.unitOfWork.onScopeClosed = (): void => {
      liveAtClose.push(
        [...harness.tokens.rows.values()].filter((row) => row.usedAt === null).length,
      );
    };

    await change(harness);

    expect(liveAtClose.at(-1)).toBe(0);
    expect(harness.dispatcher.dispatched).toHaveLength(1);
  });

  it('counts them in the event, so a change that interrupted a recovery is visible', async () => {
    const harness = buildHarness();

    await harness.openFamily(CURRENT_FAMILY);
    await harness.issueResetToken();
    await change(harness);

    const line = harness.logger.lines.find(
      (entry) => entry.fields['event'] === SECURITY_EVENTS.passwordChanged,
    );

    expect(line?.fields).toMatchObject({ revokedResetTokens: 1 });
  });

  it('touches none when there were none, and says so', async () => {
    const harness = buildHarness();

    await harness.openFamily(CURRENT_FAMILY);
    await change(harness);

    const line = harness.logger.lines.find(
      (entry) => entry.fields['event'] === SECURITY_EVENTS.passwordChanged,
    );

    expect(line?.fields).toMatchObject({ revokedResetTokens: 0 });
  });
});

/**
 * The write that matched no row — the account soft-deleted between `findCredential` and the
 * `updateMany` that replaces its digest.
 *
 * `updateMany` reports a count and raises nothing, so this used to pass straight through: the other
 * sessions were revoked, the notification went out and the caller was told 204 over a password that
 * had not changed. The refusal is the same `401 invalid_credentials` the branch above it gives for
 * the same fact found a moment earlier, so the contract is unchanged; what is new is that it is a
 * refusal at all, and that it is written down under its own event.
 */
describe('a password write that matched no row', () => {
  it('refuses instead of answering success, and keeps the other sessions', async () => {
    const harness = buildHarness();

    await harness.openFamily(CURRENT_FAMILY);
    await harness.openFamily(OTHER_FAMILY);

    harness.users.vanished = true;

    await expect(change(harness)).rejects.toMatchObject({
      code: 'invalid_credentials',
      status: 401,
    });
    expect(livingFamilies(harness.sessions)).toEqual([CURRENT_FAMILY, OTHER_FAMILY]);
  });

  it('sends no notification about a change that did not happen', async () => {
    const harness = buildHarness();

    await harness.openFamily(CURRENT_FAMILY);

    harness.users.vanished = true;
    await change(harness).catch(() => undefined);

    expect(harness.dispatcher.dispatched).toEqual([]);
  });

  it('records it at error under its own event', async () => {
    const harness = buildHarness();

    await harness.openFamily(CURRENT_FAMILY);

    harness.users.vanished = true;
    await change(harness).catch(() => undefined);

    const line = harness.logger.lines.find(
      (entry) => entry.fields['event'] === SECURITY_EVENTS.passwordNotWritten,
    );

    expect(line?.level).toBe('error');
    expect(line?.fields).toMatchObject({ organizationId: ORGANIZATION_ID, userId: USER_ID });
  });
});
