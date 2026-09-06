import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { ConsumeRecoveryCodeUseCase } from '@/application/identity/use-cases/consume-recovery-code.use-case.js';
import { IssueSessionUseCase } from '@/application/identity/use-cases/issue-session.use-case.js';
import { RecoveryCodeMatcher } from '@/application/identity/use-cases/recovery-code-matcher.use-case.js';
import { VerifySecondFactorUseCase } from '@/application/identity/use-cases/verify-second-factor.use-case.js';
import { SECURITY_EVENTS } from '@/domain/identity/security-event.constant.js';
import { noopMetrics } from '@/infrastructure/metrics/noop-metrics.adapter.js';
import {
  type AppError,
  MfaCodeReplayedError,
  MfaInvalidCodeError,
  MfaTokenExpiredError,
  RateLimitedError,
  RecoveryCodeInvalidError,
} from '@/domain/shared/errors/app.errors.js';

import {
  FakeAccessTokens,
  FakeAddressHasher,
  FakeAuditLogger,
  disabledMfaPolicy,
  FakeClock,
  FakeIdGenerator,
  FakeMailDispatcher,
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
import {
  FakeFieldEncryption,
  FakeRecoveryCodes,
  FakeTotpEnrollment,
  ScriptedTotp,
} from '../../support/mfa-doubles.util.js';
import { FakeMfaPendingTokens, JournalingTotpEnrollment } from './second-factor-doubles.util.js';

const CLIENT = { userAgent: 'Firefox/128.0', ipAddress: '203.0.113.42' };
const TOTP_CODE = '123456';
const RECOVERY_CODE = 'ABCDE23456';
const SECRET = 'JBSWY3DPEHPK3PXP';
const PERMISSIONS_VERSION = 7;
const LAST_COUNTER = 42;

const buildHarness = (rateLimitOptions: Omit<FakeRateLimitOptions, 'journal'> = {}) => {
  const clock = new FakeClock();
  const journal: string[] = [];
  const hasher = new FakePasswordHasher(journal);
  const rateLimit = new FakeRateLimit({ ...rateLimitOptions, journal });
  const unitOfWork = new FakeUnitOfWork();
  const logger = new RecordingLogger();
  const audit = new FakeAuditLogger();
  const sessions = new FakeSessions(clock);
  const organizations = new FakeOrganizations();
  const accessTokens = new FakeAccessTokens();
  const users = new FakeUsers([
    {
      id: USER_ID,
      email: 'ada@example.com',
      locale: 'en',
      timezone: 'Europe/Berlin',
      status: 'ACTIVE',
      permissionsVersion: PERMISSIONS_VERSION,
    },
  ]);
  // The credential the recovery-code notice is addressed to. Seeded here rather than only in
  // `ConsumeRecoveryCodeUseCase`'s own suite so that the *composition* is exercised: the notice is
  // dispatched from a use-case this one delegates to, and a harness with no credential would let
  // the whole branch stay silent without a test noticing.
  users.credentials.set(USER_ID, {
    email: 'ada@example.com',
    passwordHash: '$argon2id$hashed:irrelevant',
    locale: 'en',
  });

  const enrollment = new JournalingTotpEnrollment(journal);
  const fields = new FakeFieldEncryption();
  const totp = new ScriptedTotp();

  // A step *after* the one the account already spent — `ScriptedTotp` defaults to counter 1, which
  // `advanceCounter` would refuse against the seeded 42 and make every happy path a replay.
  totp.script = [{ accepted: true, counter: LAST_COUNTER + 1 }];
  const codes = new FakeRecoveryCodes();
  const mfaTokens = new FakeMfaPendingTokens(clock);

  const issueSession = new IssueSessionUseCase(
    sessions,
    organizations,
    new FakeRefreshTokens(),
    accessTokens,
    new FakeAddressHasher(),
    clock,
    new FakeIdGenerator(),
    new FakeTotpEnrollment(),
    disabledMfaPolicy(clock),
  );

  const dispatcher = new FakeMailDispatcher();
  const consumeRecoveryCode = new ConsumeRecoveryCodeUseCase(
    new RecoveryCodeMatcher(codes, hasher),
    codes,
    users,
    unitOfWork,
    rateLimit,
    clock,
    logger,
    audit,
    noopMetrics,
    dispatcher,
    'https://crm.example.test',
  );

  const verify = new VerifySecondFactorUseCase(
    mfaTokens,
    enrollment,
    totp,
    fields,
    consumeRecoveryCode,
    users,
    organizations,
    unitOfWork,
    issueSession,
    rateLimit,
    clock,
    logger,
    audit,
  );

  // The account state a pending sign-in leaves behind: TOTP confirmed, one counter already spent.
  enrollment.rows.set(USER_ID, {
    secretEnc: fields.encrypt(SECRET) ?? '',
    enabledAt: new Date('2026-07-01T00:00:00.000Z'),
    draftExpiresAt: null,
    lastCounter: LAST_COUNTER,
  });

  const seedRecoveryCode = (plaintext: string = RECOVERY_CODE): string => {
    const id = randomUUID();

    codes.rows.set(id, {
      id,
      userId: USER_ID,
      codeHash: `$argon2id$hashed:${plaintext}`,
      usedAt: null,
    });

    return id;
  };

  return {
    verify,
    clock,
    journal,
    hasher,
    rateLimit,
    unitOfWork,
    logger,
    audit,
    sessions,
    accessTokens,
    users,
    enrollment,
    fields,
    totp,
    codes,
    mfaTokens,
    dispatcher,
    organizationsStore: organizations,
    seedRecoveryCode,
  };
};

type Harness = ReturnType<typeof buildHarness>;

/** Mints the token a pending sign-in would have handed the caller. */
const pendingToken = async (test: Harness): Promise<string> => {
  const issued = await test.mfaTokens.issue({
    userId: USER_ID,
    organizationId: ORGANIZATION_ID,
  });

  return issued.token;
};

const refusal = async (run: () => Promise<unknown>): Promise<AppError> => {
  try {
    await run();
  } catch (error) {
    return error as AppError;
  }

  throw new Error('expected the second factor to be refused');
};

describe('a correct TOTP code', () => {
  it('opens a session carrying the account’s permission version', async () => {
    const test = buildHarness();
    const token = await pendingToken(test);

    const result = await test.verify.execute({ mfaToken: token, code: TOTP_CODE, client: CLIENT });

    expect(result.status).toBe('authenticated');
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
    expect(test.accessTokens.issued[0]).toMatchObject({
      userId: USER_ID,
      organizationId: ORGANIZATION_ID,
      permissionsVersion: PERMISSIONS_VERSION,
    });
  });

  it('opens the tenant scope the pending token names', async () => {
    const test = buildHarness();
    const token = await pendingToken(test);

    await test.verify.execute({ mfaToken: token, code: TOTP_CODE, client: CLIENT });

    expect(test.unitOfWork.scopes[0]).toEqual({
      organizationId: ORGANIZATION_ID,
      userId: USER_ID,
    });
  });

  it('verifies the presented code against the stored secret, from the counter already accepted', async () => {
    const test = buildHarness();
    const token = await pendingToken(test);

    await test.verify.execute({ mfaToken: token, code: TOTP_CODE, client: CLIENT });

    expect(test.totp.verifyCalls).toEqual([
      { base32Secret: SECRET, code: TOTP_CODE, sinceCounter: LAST_COUNTER },
    ]);
  });

  /** Acceptance 6's other half: the step just accepted becomes the floor for the next one. */
  it('advances the anti-replay counter to the step it accepted', async () => {
    const test = buildHarness();

    test.totp.script = [{ accepted: true, counter: 99 }];

    const token = await pendingToken(test);

    await test.verify.execute({ mfaToken: token, code: TOTP_CODE, client: CLIENT });

    expect(test.enrollment.rows.get(USER_ID)?.lastCounter).toBe(99);
  });

  it('records session.signed_in, marked as a TOTP sign-in', async () => {
    const test = buildHarness();
    const token = await pendingToken(test);

    const result = await test.verify.execute({ mfaToken: token, code: TOTP_CODE, client: CLIENT });

    expect(test.audit.events).toHaveLength(1);
    expect(test.audit.events[0]).toMatchObject({
      action: 'session.signed_in',
      actor: { userId: USER_ID, organizationId: ORGANIZATION_ID, ipAddress: '203.0.113.42' },
      target: { type: 'SESSION', id: result.session.sessionId },
      after: { mfa: 'totp' },
    });
  });

  it('records the sign-in at info, without the address or the code', async () => {
    const test = buildHarness();
    const token = await pendingToken(test);

    await test.verify.execute({ mfaToken: token, code: TOTP_CODE, client: CLIENT });

    const [line] = test.logger.lines.filter((entry) => entry.level === 'info');

    expect(line?.fields).toMatchObject({
      event: SECURITY_EVENTS.signInSucceeded,
      outcome: 'session_opened',
      mfa: 'totp',
      userId: USER_ID,
      organizationId: ORGANIZATION_ID,
      ipMasked: '203.0.113.0/24',
    });
    expect(JSON.stringify(line)).not.toContain('203.0.113.42');
    expect(JSON.stringify(line)).not.toContain(TOTP_CODE);
  });
});

/**
 * Acceptance 2, second half: the intermediate token is spent the moment it works.
 *
 * Two assertions rather than one, and deliberately not the same assertion twice: that the port was
 * asked to revoke, and that the token genuinely stops working afterwards. The first alone would pass
 * on a revoke that writes nothing; the second alone would pass on an implementation that happens to
 * refuse the second attempt for an unrelated reason (the counter it just advanced).
 */
describe('spending the intermediate token', () => {
  it('revokes it on the successful verification', async () => {
    const test = buildHarness();
    const token = await pendingToken(test);

    await test.verify.execute({ mfaToken: token, code: TOTP_CODE, client: CLIENT });

    expect(test.mfaTokens.revoked).toEqual([test.mfaTokens.issued[0]?.jti]);
  });

  it('refuses a second presentation of the same token as expired', async () => {
    const test = buildHarness();
    const token = await pendingToken(test);

    await test.verify.execute({ mfaToken: token, code: TOTP_CODE, client: CLIENT });

    // A fresh step, so the refusal cannot be the anti-replay counter answering instead.
    test.totp.script = [{ accepted: true, counter: 100 }];

    const error = await refusal(() =>
      test.verify.execute({ mfaToken: token, code: TOTP_CODE, client: CLIENT }),
    );

    expect(error).toBeInstanceOf(MfaTokenExpiredError);
    expect(error.status).toBe(401);
    expect(test.sessions.rows.size).toBe(1);
  });

  it('keeps the token alive after a wrong code, so the person can try again', async () => {
    const test = buildHarness();
    const token = await pendingToken(test);

    test.totp.script = [
      { accepted: false, replayed: false },
      { accepted: true, counter: 43 },
    ];

    await refusal(() => test.verify.execute({ mfaToken: token, code: '000000', client: CLIENT }));

    expect(test.mfaTokens.revoked).toEqual([]);

    const result = await test.verify.execute({
      mfaToken: token,
      code: TOTP_CODE,
      client: CLIENT,
    });

    expect(result.status).toBe('authenticated');
  });
});

describe('a token that cannot be used', () => {
  it('refuses one that was never issued, without reading anything about the account', async () => {
    const test = buildHarness();

    const error = await refusal(() =>
      test.verify.execute({ mfaToken: 'mfa.forged', code: TOTP_CODE, client: CLIENT }),
    );

    expect(error).toBeInstanceOf(MfaTokenExpiredError);
    expect(test.journal).not.toContain('totp-enrollment:find');
    expect(test.totp.verifyCalls).toEqual([]);
    expect(test.sessions.rows.size).toBe(0);
  });

  /** Acceptance 4: five minutes later the same string is answered exactly like a forged one. */
  it('refuses one whose five minutes are over, with the identical code', async () => {
    const test = buildHarness();
    const token = await pendingToken(test);

    test.clock.advance(301);

    const error = await refusal(() =>
      test.verify.execute({ mfaToken: token, code: TOTP_CODE, client: CLIENT }),
    );

    expect(error.code).toBe('mfa_token_expired');
    expect(error.status).toBe(401);
    expect(test.sessions.rows.size).toBe(0);
    expect(test.totp.verifyCalls).toEqual([]);
  });

  it('spends no attempt budget for a token it never accepted', async () => {
    const test = buildHarness();

    await refusal(() =>
      test.verify.execute({ mfaToken: 'mfa.forged', code: TOTP_CODE, client: CLIENT }),
    );

    expect(test.rateLimit.consumed).toEqual([]);
  });
});

/**
 * The attempt budget, keyed on the token rather than on the account.
 *
 * The order assertion is the one that matters and it is asserted twice over, because the two
 * expensive comparisons live on different branches: the recovery path pays ten Argon2id
 * verifications and the TOTP path pays a decryption plus an HMAC. Neither may run for a caller whose
 * budget is already gone.
 */
describe('the attempt budget', () => {
  it('counts the token’s jti', async () => {
    const test = buildHarness();
    const token = await pendingToken(test);

    await test.verify.execute({ mfaToken: token, code: TOTP_CODE, client: CLIENT });

    expect(test.rateLimit.consumed[0]).toEqual({
      policy: 'mfa_verify_attempt',
      subject: { jti: test.mfaTokens.issued[0]?.jti },
    });
  });

  /**
   * And counts the **account** as well, which is the half that actually bounds guessing.
   *
   * A budget keyed on `jti` alone is not a limit on guessing a code: a new token carries a new key
   * and therefore a fresh five, and a new token costs one correct password — which the attacker
   * this whole feature exists to stop already has. `auth_attempt` does not close the loop either,
   * because `LoginUseCase` resets it on every verified password, including the branch that mints
   * this token. So the sequence `login → five guesses → login → five guesses` had no bound at all
   * until this counter existed.
   */
  it('also counts the account, so a fresh token does not buy fresh attempts', async () => {
    const test = buildHarness();
    const token = await pendingToken(test);

    await test.verify.execute({ mfaToken: token, code: TOTP_CODE, client: CLIENT });

    expect(test.rateLimit.consumed).toContainEqual({
      policy: 'mfa_verify_account_attempt',
      subject: { userId: USER_ID, ipAddress: CLIENT.ipAddress },
    });
  });

  it('refuses once the account budget is gone, whatever the token', async () => {
    const test = buildHarness({ limits: { mfa_verify_account_attempt: 0 } });
    const token = await pendingToken(test);

    await expect(
      test.verify.execute({ mfaToken: token, code: TOTP_CODE, client: CLIENT }),
    ).rejects.toBeInstanceOf(RateLimitedError);
  });

  it('spends a point before the recovery-code comparisons run', async () => {
    const test = buildHarness();

    test.seedRecoveryCode();

    const token = await pendingToken(test);

    await test.verify.execute({ mfaToken: token, code: RECOVERY_CODE, client: CLIENT });

    expect(test.journal.indexOf('rate-limit:consume:mfa_verify_attempt')).toBeLessThan(
      test.journal.indexOf('password:verify'),
    );
  });

  it('reads neither the secret nor a code once the budget is gone', async () => {
    const test = buildHarness({ limits: { mfa_verify_attempt: 0 } });
    const token = await pendingToken(test);

    await refusal(() => test.verify.execute({ mfaToken: token, code: TOTP_CODE, client: CLIENT }));

    expect(test.totp.verifyCalls).toEqual([]);
    expect(test.journal).not.toContain('totp-enrollment:find');
  });

  /**
   * Acceptance 5: five wrong codes and the token is gone — the way back is the password, not a
   * wait. So the refusal is `mfa_token_expired` and not `rate_limited`: a `Retry-After` would send
   * the client back with a credential that will never be accepted again.
   */
  describe('five wrong codes', () => {
    const exhaust = async (test: Harness, token: string): Promise<void> => {
      test.totp.script = [{ accepted: false, replayed: false }];

      for (let attempt = 0; attempt < 5; attempt += 1) {
        await refusal(() =>
          test.verify.execute({ mfaToken: token, code: '000000', client: CLIENT }),
        );
      }
    };

    it('refuses the sixth attempt as an unusable token', async () => {
      const test = buildHarness({ limits: { mfa_verify_attempt: 5 } });
      const token = await pendingToken(test);

      await exhaust(test, token);

      const error = await refusal(() =>
        test.verify.execute({ mfaToken: token, code: '000000', client: CLIENT }),
      );

      expect(error).toBeInstanceOf(MfaTokenExpiredError);
    });

    it('voids the token itself, so a correct code cannot rescue it either', async () => {
      const test = buildHarness({ limits: { mfa_verify_attempt: 5 } });
      const token = await pendingToken(test);

      await exhaust(test, token);
      test.totp.script = [{ accepted: true, counter: 43 }];

      await refusal(() =>
        test.verify.execute({ mfaToken: token, code: TOTP_CODE, client: CLIENT }),
      );

      expect(test.mfaTokens.revoked).toEqual([test.mfaTokens.issued[0]?.jti]);
      expect(test.sessions.rows.size).toBe(0);
    });

    /**
     * The counter itself, asserted apart from the refusal: «неверный код отвергается» stays green
     * on an implementation that never spends a point, so the number of points spent is its own
     * assertion. Five refusals, one blocked attempt — six consumptions of the token budget, all on the same jti.
     */
    it('spends exactly one point per attempt, on the one jti', async () => {
      const test = buildHarness({ limits: { mfa_verify_attempt: 5 } });
      const token = await pendingToken(test);

      await exhaust(test, token);
      await refusal(() => test.verify.execute({ mfaToken: token, code: '000000', client: CLIENT }));

      // Filtered to the token budget, which is what this case is about. Every attempt also spends
      // the account budget beside it (`mfa_verify_account_attempt`), and counting both together
      // would make this assertion break whenever the other one changes — a number about two things
      // is a number about neither.
      const perToken = test.rateLimit.consumed.filter(
        (call) => call.policy === 'mfa_verify_attempt',
      );

      expect(perToken).toHaveLength(6);
      expect(perToken.every((call) => Object.keys(call.subject as object)[0] === 'jti')).toBe(true);
    });
  });
});

describe('a code that does not match', () => {
  it('answers mfa_invalid_code, opens no session and leaves the counter where it was', async () => {
    const test = buildHarness();

    test.totp.script = [{ accepted: false, replayed: false }];

    const token = await pendingToken(test);

    const error = await refusal(() =>
      test.verify.execute({ mfaToken: token, code: '000000', client: CLIENT }),
    );

    expect(error).toBeInstanceOf(MfaInvalidCodeError);
    expect(error.status).toBe(401);
    expect(test.sessions.rows.size).toBe(0);
    expect(test.enrollment.rows.get(USER_ID)?.lastCounter).toBe(LAST_COUNTER);
    expect(test.audit.events).toEqual([]);
  });

  it('writes the refusal down, with the outcome and without the code', async () => {
    const test = buildHarness();

    test.totp.script = [{ accepted: false, replayed: false }];

    const token = await pendingToken(test);

    await refusal(() => test.verify.execute({ mfaToken: token, code: '000000', client: CLIENT }));

    const [line] = test.logger.lines.filter((entry) => entry.level === 'warn');

    expect(line?.fields).toMatchObject({
      event: SECURITY_EVENTS.totpVerificationFailed,
      outcome: 'wrong_code',
    });
    expect(JSON.stringify(line)).not.toContain('000000');
  });

  /** Acceptance 6: a code that *was* right gets its own answer, so the client can say so. */
  it('answers mfa_code_replayed when the step was already accepted', async () => {
    const test = buildHarness();

    test.totp.script = [{ accepted: false, replayed: true }];

    const token = await pendingToken(test);

    const error = await refusal(() =>
      test.verify.execute({ mfaToken: token, code: TOTP_CODE, client: CLIENT }),
    );

    expect(error).toBeInstanceOf(MfaCodeReplayedError);
    expect(error.status).toBe(401);
    expect(test.sessions.rows.size).toBe(0);
  });

  /**
   * The same refusal when the race is lost to a concurrent request rather than to the clock: two
   * verifications of the same step both pass `TotpPort.verify`, and only the conditional `UPDATE`
   * decides which of them may open a session.
   */
  it('answers mfa_code_replayed when the counter was advanced under it', async () => {
    const test = buildHarness();

    // Accepted at a step the row already holds — exactly what `advanceCounter` refuses.
    test.totp.script = [{ accepted: true, counter: LAST_COUNTER }];

    const token = await pendingToken(test);

    const error = await refusal(() =>
      test.verify.execute({ mfaToken: token, code: TOTP_CODE, client: CLIENT }),
    );

    expect(error).toBeInstanceOf(MfaCodeReplayedError);
    expect(test.sessions.rows.size).toBe(0);
  });

  it('answers mfa_invalid_code when 2FA was switched off between the two steps', async () => {
    const test = buildHarness();
    const token = await pendingToken(test);

    await test.enrollment.disable(USER_ID);

    const error = await refusal(() =>
      test.verify.execute({ mfaToken: token, code: TOTP_CODE, client: CLIENT }),
    );

    expect(error).toBeInstanceOf(MfaInvalidCodeError);
    expect(test.sessions.rows.size).toBe(0);
  });

  /**
   * The other half of the same guard, and the one that is not merely tidy: a secret **exists** on
   * the row and nobody has proved possession of it yet. That is what an account looks like when its
   * owner turned 2FA off and started a fresh enrolment inside the five minutes a pending token
   * lives. A draft that could complete a sign-in would mean the code from a QR nobody confirmed is
   * already a credential.
   */
  it('never accepts a code against a draft secret nobody confirmed', async () => {
    const test = buildHarness();
    const token = await pendingToken(test);

    test.enrollment.rows.set(USER_ID, {
      secretEnc: test.fields.encrypt(SECRET) ?? '',
      enabledAt: null,
      draftExpiresAt: new Date('2026-07-29T10:05:00.000Z'),
      lastCounter: null,
    });

    const error = await refusal(() =>
      test.verify.execute({ mfaToken: token, code: TOTP_CODE, client: CLIENT }),
    );

    expect(error).toBeInstanceOf(MfaInvalidCodeError);
    expect(test.totp.verifyCalls).toEqual([]);
    expect(test.sessions.rows.size).toBe(0);
  });
});

/**
 * Acceptance 7 — the branch that finally makes `ConsumeRecoveryCodeUseCase` reachable.
 *
 * Which branch runs is decided by the shape of what was typed, exactly as `DisableTotpUseCase`
 * decides it: six digits is an authenticator code, anything else is tried as a recovery code. The
 * two shapes cannot collide — a recovery code is ten characters.
 */
describe('a recovery code instead of an authenticator', () => {
  it('spends the code and opens a session', async () => {
    const test = buildHarness();
    const id = test.seedRecoveryCode();
    const token = await pendingToken(test);

    const result = await test.verify.execute({
      mfaToken: token,
      code: RECOVERY_CODE,
      client: CLIENT,
    });

    expect(result.status).toBe('authenticated');
    expect(test.codes.rows.get(id)).toMatchObject({ usedAt: expect.any(Date) });
    expect(test.sessions.rows.size).toBe(1);
  });

  it('marks the sign-in as a recovery-code one, beside the code’s own entry', async () => {
    const test = buildHarness();

    test.seedRecoveryCode();

    const token = await pendingToken(test);

    await test.verify.execute({ mfaToken: token, code: RECOVERY_CODE, client: CLIENT });

    expect(test.audit.events.map((event) => event.action)).toEqual([
      'user.mfa_recovery_code_used',
      'session.signed_in',
    ]);
    expect(test.audit.events[1]).toMatchObject({ after: { mfa: 'recovery_code' } });
  });

  it('tells the account owner by mail that a recovery code opened the session', async () => {
    const test = buildHarness();

    test.seedRecoveryCode();

    const token = await pendingToken(test);

    await test.verify.execute({ mfaToken: token, code: RECOVERY_CODE, client: CLIENT });

    expect(test.dispatcher.dispatched).toHaveLength(1);
    expect(test.dispatcher.dispatched[0]?.context.event).toBe(SECURITY_EVENTS.recoveryCodeUsed);
  });

  it('spends the intermediate token on this path too', async () => {
    const test = buildHarness();

    test.seedRecoveryCode();

    const token = await pendingToken(test);

    await test.verify.execute({ mfaToken: token, code: RECOVERY_CODE, client: CLIENT });

    expect(test.mfaTokens.revoked).toEqual([test.mfaTokens.issued[0]?.jti]);
  });

  it('never reaches the TOTP secret', async () => {
    const test = buildHarness();

    test.seedRecoveryCode();

    const token = await pendingToken(test);

    await test.verify.execute({ mfaToken: token, code: RECOVERY_CODE, client: CLIENT });

    expect(test.totp.verifyCalls).toEqual([]);
  });

  it('refuses an unknown one with recovery_code_invalid and opens no session', async () => {
    const test = buildHarness();

    test.seedRecoveryCode();

    const token = await pendingToken(test);

    const error = await refusal(() =>
      test.verify.execute({ mfaToken: token, code: 'ZZZZZ99999', client: CLIENT }),
    );

    expect(error).toBeInstanceOf(RecoveryCodeInvalidError);
    expect(error.status).toBe(401);
    expect(test.sessions.rows.size).toBe(0);
    expect(test.mfaTokens.revoked).toEqual([]);
  });

  /** Six digits is an authenticator code even when the account has recovery codes left. */
  it('never tries a six-digit code against the recovery batch', async () => {
    const test = buildHarness();

    test.seedRecoveryCode();

    const token = await pendingToken(test);

    await test.verify.execute({ mfaToken: token, code: TOTP_CODE, client: CLIENT });

    expect(test.hasher.verified).toEqual([]);
  });
});

/**
 * The account can change between the password and the code — five minutes is long enough to be
 * offboarded in, and offboarding revokes every session family without knowing that a second-factor
 * step is in flight. A pending token that still opened a session would be a way back in for somebody
 * who was suspended thirty seconds ago.
 */
describe('an account that may no longer sign in', () => {
  it('refuses a suspended account and spends nothing', async () => {
    const test = buildHarness();
    const id = test.seedRecoveryCode();
    const token = await pendingToken(test);

    test.users.rows.set(USER_ID, {
      id: USER_ID,
      email: 'ada@example.com',
      locale: 'en',
      timezone: 'Europe/Berlin',
      status: 'SUSPENDED',
      permissionsVersion: PERMISSIONS_VERSION,
    });

    const error = await refusal(() =>
      test.verify.execute({ mfaToken: token, code: RECOVERY_CODE, client: CLIENT }),
    );

    expect(error.code).toBe('account_suspended');
    expect(test.sessions.rows.size).toBe(0);
    expect(test.codes.rows.get(id)?.usedAt).toBeNull();
  });

  /** Any other non-`ACTIVE` state answers the refused credential, exactly as the password step does. */
  it('refuses a status that is neither active nor suspended as a refused credential', async () => {
    const test = buildHarness();
    const token = await pendingToken(test);

    test.users.rows.set(USER_ID, {
      id: USER_ID,
      email: 'ada@example.com',
      locale: 'en',
      timezone: 'Europe/Berlin',
      status: 'INVITED',
      permissionsVersion: PERMISSIONS_VERSION,
    });

    const error = await refusal(() =>
      test.verify.execute({ mfaToken: token, code: TOTP_CODE, client: CLIENT }),
    );

    expect(error.code).toBe('invalid_credentials');
    expect(test.sessions.rows.size).toBe(0);
  });

  it('refuses an account whose row is gone as a refused credential', async () => {
    const test = buildHarness();
    const token = await pendingToken(test);

    test.users.rows.delete(USER_ID);

    const error = await refusal(() =>
      test.verify.execute({ mfaToken: token, code: TOTP_CODE, client: CLIENT }),
    );

    expect(error.code).toBe('invalid_credentials');
    expect(test.sessions.rows.size).toBe(0);
  });
});

/**
 * The organization behind the scope disappeared between the two steps — a state no ordinary
 * refusal covers, because the token names a tenant the transaction then cannot resolve. It is an
 * internal error rather than a credential answer: nothing the caller did is wrong.
 */
describe('an organization that is gone', () => {
  it('fails loudly rather than answering a session with no organization', async () => {
    const test = buildHarness();
    const token = await pendingToken(test);

    test.organizationsStore.forget();

    await expect(
      test.verify.execute({ mfaToken: token, code: TOTP_CODE, client: CLIENT }),
      // The message of *this* use-case, not merely the word «organization»: `IssueSessionUseCase`
      // refuses the same state with a sentence of its own, and a substring both of them satisfy
      // would leave this case green no matter which of the two actually ran.
    ).rejects.toThrow('verify-second-factor: the tenant scope names an organization that is gone');
  });
});

/**
 * A secret the running `APP_ENCRYPTION_KEY` cannot read is an operator fault, not a wrong code —
 * the identical handling `ConfirmTotpUseCase` and `DisableTotpUseCase` give the same failure.
 */
describe('a secret that cannot be decrypted', () => {
  it('answers service_unavailable and says so at error level', async () => {
    const test = buildHarness();
    const token = await pendingToken(test);

    test.enrollment.rows.set(USER_ID, {
      secretEnc: 'not-something-this-key-can-read',
      enabledAt: new Date('2026-07-01T00:00:00.000Z'),
      draftExpiresAt: null,
      lastCounter: LAST_COUNTER,
    });

    const error = await refusal(() =>
      test.verify.execute({ mfaToken: token, code: TOTP_CODE, client: CLIENT }),
    );

    expect(error.code).toBe('service_unavailable');
    expect(error.status).toBe(503);
    expect(test.logger.lines.filter((line) => line.level === 'error')[0]?.fields).toMatchObject({
      event: SECURITY_EVENTS.totpSecretUndecryptable,
    });
  });
});
