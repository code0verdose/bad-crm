import { describe, expect, it } from 'vitest';

import { ConfirmTotpUseCase } from '@/application/identity/use-cases/confirm-totp.use-case.js';
import { type RecoveryCodeGeneratorPort } from '@/application/identity/ports/recovery-code-generator.port.js';
import { CsprngRecoveryCodeGenerator } from '@/infrastructure/crypto/csprng-recovery-code-generator.adapter.js';
import { LimitedPasswordHasher } from '@/infrastructure/crypto/limited-password-hasher.adapter.js';
import { GenerateRecoveryCodesUseCase } from '@/application/identity/use-cases/generate-recovery-codes.use-case.js';
import {
  InvalidTotpCodeError,
  RateLimitedError,
  ReauthenticationRequiredError,
  ServiceUnavailableError,
  TotpCodeReplayedError,
} from '@/domain/shared/errors/app.errors.js';

import {
  authUser,
  FakeAuditLogger,
  FakeClock,
  FakeMailDispatcher,
  FakePasswordHasher,
  FakeRateLimit,
  FakeUnitOfWork,
  FakeUsers,
  ORGANIZATION_ID,
  RecordingLogger,
  USER_ID,
} from '../../support/identity-doubles.util.js';
import { hashSemaphoreRefusingAfter } from '../../support/hash-semaphore-doubles.util.js';
import {
  FakeFieldEncryption,
  FakeRecoveryCodeGenerator,
  FakeRecoveryCodes,
  FakeTotpEnrollment,
  ScriptedTotp,
} from '../../support/mfa-doubles.util.js';

const ACTOR = { organizationId: ORGANIZATION_ID, userId: USER_ID };
const SECRET = 'THESECRET';
const CURRENT_PASSWORD = 'correct-horse-battery';
const IP_ADDRESS = '203.0.113.7';

const buildHarness = (
  /**
   * How the ten recovery-code hashes are produced — a double by default, a real batch under a
   * ceiling when a case is about the mint being refused halfway.
   */
  generator: RecoveryCodeGeneratorPort = new FakeRecoveryCodeGenerator(),
) => {
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

  users.credentials.set(USER_ID, {
    email: account.email,
    passwordHash: `$argon2id$hashed:${CURRENT_PASSWORD}`,
    locale: account.locale,
  });

  const hasher = new FakePasswordHasher();
  const enrollment = new FakeTotpEnrollment();
  const totp = new ScriptedTotp();
  const fields = new FakeFieldEncryption();
  const recoveryCodeRows = new FakeRecoveryCodes();
  const generateRecoveryCodes = new GenerateRecoveryCodesUseCase(recoveryCodeRows, generator);
  const unitOfWork = new FakeUnitOfWork();
  const rateLimit = new FakeRateLimit({ limits: { mfa_setup_attempt: 5 } });
  const clock = new FakeClock();
  const logger = new RecordingLogger();
  const audit = new FakeAuditLogger();
  const dispatcher = new FakeMailDispatcher();

  const useCase = new ConfirmTotpUseCase(
    enrollment,
    totp,
    fields,
    generateRecoveryCodes,
    users,
    hasher,
    unitOfWork,
    rateLimit,
    clock,
    logger,
    audit,
    dispatcher,
    'https://crm.example.com',
  );

  const seedDraft = async (overrides: { draftExpiresAt?: Date } = {}): Promise<void> => {
    await enrollment.beginDraft(
      USER_ID,
      fields.encrypt(SECRET) ?? '',
      overrides.draftExpiresAt ?? new Date(clock.now().getTime() + 15 * 60 * 1000),
    );
  };

  /** `{ actor, code, currentPassword, ipAddress }` with the right password by default. */
  const request = (overrides: { code?: string; currentPassword?: string } = {}) => ({
    actor: ACTOR,
    code: overrides.code ?? '123456',
    currentPassword: overrides.currentPassword ?? CURRENT_PASSWORD,
    ipAddress: IP_ADDRESS,
  });

  return {
    useCase,
    users,
    hasher,
    enrollment,
    totp,
    fields,
    recoveryCodeRows,
    unitOfWork,
    rateLimit,
    clock,
    logger,
    audit,
    dispatcher,
    seedDraft,
    request,
  };
};

describe('confirming a correct code', () => {
  it('enables 2FA and returns ten recovery codes', async () => {
    const harness = buildHarness();

    await harness.seedDraft();
    harness.totp.script = [{ accepted: true, counter: 5 }];

    const result = await harness.useCase.execute(harness.request());

    expect(result.recoveryCodes).toHaveLength(10);
    expect(new Set(result.recoveryCodes).size).toBe(10);

    const state = await harness.enrollment.find(USER_ID);

    expect(state).toMatchObject({ enabledAt: expect.any(Date), lastCounter: 5 });
  });

  it('records user.mfa_enabled in the audit trail, with the caller’s address, inside the transaction', async () => {
    const harness = buildHarness();

    await harness.seedDraft();

    await harness.useCase.execute(harness.request());

    expect(harness.audit.events).toContainEqual(
      expect.objectContaining({
        action: 'user.mfa_enabled',
        target: { type: 'USER', id: USER_ID },
        actor: expect.objectContaining({ ipAddress: IP_ADDRESS }),
      }),
    );
  });

  it('clears the mfa_setup_attempt budget once confirmed', async () => {
    const harness = buildHarness();

    await harness.seedDraft();
    await harness.useCase.execute(harness.request());

    expect(harness.rateLimit.cleared).toContainEqual({
      policy: 'mfa_setup_attempt',
      subject: { userId: USER_ID },
    });
  });

  it('decrypts the secret only for the length of the check — the plaintext never leaves this call', async () => {
    const harness = buildHarness();

    await harness.seedDraft();
    const result = await harness.useCase.execute(harness.request());

    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  /**
   * M-5: the one signal that reaches the account owner through a channel a hijacked session does not
   * control. Sent after the transaction commits, never inside it (`rules/outbox.mdc`, rule 2) — the
   * `onScopeClosed` hook is the seam that lets a test see "nothing was dispatched yet" at the one
   * moment that matters, since checking afterwards would pass just as well for a bug that dispatched
   * from inside the transaction.
   */
  it('notifies the account owner by mail, after the transaction has committed', async () => {
    const harness = buildHarness();

    await harness.seedDraft();

    harness.unitOfWork.onScopeClosed = (): void => {
      expect(harness.dispatcher.dispatched).toEqual([]);
    };

    await harness.useCase.execute(harness.request());

    expect(harness.dispatcher.dispatched).toHaveLength(1);
    expect(harness.dispatcher.dispatched[0]?.mail.to).toBe('ada@example.com');
  });
});

describe('refusing a wrong code', () => {
  it('answers invalid_totp_code, enables nothing, and logs totp_verification_failed', async () => {
    const harness = buildHarness();

    await harness.seedDraft();
    harness.totp.script = [{ accepted: false, replayed: false }];

    await expect(
      harness.useCase.execute(harness.request({ code: '000000' })),
    ).rejects.toBeInstanceOf(InvalidTotpCodeError);

    const state = await harness.enrollment.find(USER_ID);

    expect(state?.enabledAt).toBeNull();
    expect(harness.recoveryCodeRows.rows.size).toBe(0);
    expect(harness.logger.lines).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        fields: expect.objectContaining({
          event: 'totp_verification_failed',
          outcome: 'wrong_code',
        }),
      }),
    );
  });
});

describe('a replayed code', () => {
  it('answers totp_code_replayed rather than invalid_totp_code', async () => {
    const harness = buildHarness();

    await harness.seedDraft();
    harness.totp.script = [{ accepted: false, replayed: true }];

    await expect(
      harness.useCase.execute(harness.request({ code: '005924' })),
    ).rejects.toBeInstanceOf(TotpCodeReplayedError);

    expect(harness.logger.lines).toContainEqual(
      expect.objectContaining({
        fields: expect.objectContaining({ event: 'totp_verification_failed', outcome: 'replayed' }),
      }),
    );
  });
});

describe('confirming with the wrong password', () => {
  it('answers reauthentication_required regardless of whether the code is correct', async () => {
    const harness = buildHarness();

    await harness.seedDraft();
    harness.totp.script = [{ accepted: true, counter: 5 }];

    await expect(
      harness.useCase.execute(harness.request({ currentPassword: 'wrong' })),
    ).rejects.toBeInstanceOf(ReauthenticationRequiredError);

    const state = await harness.enrollment.find(USER_ID);

    expect(state?.enabledAt).toBeNull();
  });

  it('still verifies the password against the dummy digest when there is no draft, for equal timing', async () => {
    const harness = buildHarness();

    await expect(
      harness.useCase.execute(harness.request({ currentPassword: 'wrong' })),
    ).rejects.toBeInstanceOf(ReauthenticationRequiredError);

    expect(harness.hasher.verified.length).toBeGreaterThan(0);
  });
});

describe('confirming with no draft in progress', () => {
  it('answers invalid_totp_code rather than disclosing that no draft exists', async () => {
    const harness = buildHarness();

    await expect(harness.useCase.execute(harness.request())).rejects.toBeInstanceOf(
      InvalidTotpCodeError,
    );
    expect(harness.totp.verifyCalls).toEqual([]);
  });
});

describe('confirming after the draft has expired', () => {
  it('answers invalid_totp_code, the same code a wrong digit gets', async () => {
    const harness = buildHarness();

    await harness.seedDraft({ draftExpiresAt: new Date(harness.clock.now().getTime() + 1000) });
    harness.clock.advance(120); // two minutes past a fifteen-minute draft's one-second remainder

    await expect(harness.useCase.execute(harness.request())).rejects.toBeInstanceOf(
      InvalidTotpCodeError,
    );
  });
});

describe('a TOTP secret this key cannot decrypt', () => {
  it('answers service_unavailable rather than a bare 500, and logs at error level', async () => {
    const harness = buildHarness();

    await harness.seedDraft();
    harness.fields.decrypt = () => {
      throw new Error('encrypted field is not in the v1 format this key reads');
    };

    await expect(harness.useCase.execute(harness.request())).rejects.toBeInstanceOf(
      ServiceUnavailableError,
    );

    expect(harness.logger.lines).toContainEqual(
      expect.objectContaining({
        level: 'error',
        fields: expect.objectContaining({ event: 'totp_secret_undecryptable' }),
      }),
    );
  });
});

describe('five refused codes in a row', () => {
  it('abandons the draft, writes exactly one user.mfa_setup_failed audit row, and refuses with a Retry-After', async () => {
    const harness = buildHarness();

    await harness.seedDraft();
    harness.totp.script = [{ accepted: false, replayed: false }];

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await harness.useCase.execute(harness.request({ code: '000000' })).catch(() => undefined);
    }

    const sixth = await harness.useCase
      .execute(harness.request({ code: '000000' }))
      .catch((error: unknown) => error);

    expect(sixth).toBeInstanceOf(RateLimitedError);

    const state = await harness.enrollment.find(USER_ID);

    expect(state).toBeNull(); // the draft's secret column was cleared

    const abandonedEvents = harness.audit.events.filter(
      (event) => event.action === 'user.mfa_setup_failed',
    );

    expect(abandonedEvents).toHaveLength(1);
    expect(abandonedEvents[0]).toEqual(
      expect.objectContaining({ target: { type: 'USER', id: USER_ID } }),
    );
  });

  it('does not attempt the TOTP check once the budget is exhausted', async () => {
    const harness = buildHarness();

    await harness.seedDraft();
    harness.totp.script = [{ accepted: false, replayed: false }];

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await harness.useCase.execute(harness.request({ code: '000000' })).catch(() => undefined);
    }

    const callsBeforeSixth = harness.totp.verifyCalls.length;

    await harness.useCase.execute(harness.request({ code: '000000' })).catch(() => undefined);

    expect(harness.totp.verifyCalls.length).toBe(callsBeforeSixth);
  });

  /**
   * B-1: the rate limit is a ceiling, not an amplifier. Every request after the block has already
   * cleared the draft finds `abandonDraft` a no-op (`totp_secret_enc` is already `NULL`) and must
   * write nothing further — a limiter whose refusal keeps generating writes is a limiter that makes
   * the traffic it exists to bound *more* expensive to serve, not less.
   */
  it('writes exactly one audit row no matter how many requests arrive after the block', async () => {
    const harness = buildHarness();

    await harness.seedDraft();
    harness.totp.script = [{ accepted: false, replayed: false }];

    // Five real attempts spend the budget; ten more arrive while it stays blocked.
    for (let attempt = 0; attempt < 15; attempt += 1) {
      await harness.useCase.execute(harness.request({ code: '000000' })).catch(() => undefined);
    }

    const abandonedEvents = harness.audit.events.filter(
      (event) => event.action === 'user.mfa_setup_failed',
    );

    expect(abandonedEvents).toHaveLength(1);
  });
});

describe('losing the commit race', () => {
  it('answers invalid_totp_code, issues no recovery codes and logs race_lost', async () => {
    const harness = buildHarness();

    await harness.seedDraft();
    // The draft is gone by the time the write lands — a concurrent confirm closed it, or its own
    // expiry passed between the read and the write. `commitEnrollment` reports `false` for both.
    harness.enrollment.vanished = true;

    await expect(harness.useCase.execute(harness.request())).rejects.toBeInstanceOf(
      InvalidTotpCodeError,
    );

    expect(harness.recoveryCodeRows.rows.size).toBe(0);
    expect(harness.audit.events.map((event) => event.action)).not.toContain('user.mfa_enabled');
    expect(harness.logger.lines).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        fields: expect.objectContaining({ outcome: 'race_lost' }),
      }),
    );
  });
});

describe('an account with no credential row at all', () => {
  it('still pays one verification against the dummy digest, and answers reauthentication_required', async () => {
    const harness = buildHarness();

    await harness.seedDraft();
    harness.users.credentials.delete(USER_ID);

    await expect(harness.useCase.execute(harness.request())).rejects.toBeInstanceOf(
      ReauthenticationRequiredError,
    );

    // The point of the branch: elapsed time must not tell «no credential row» apart from
    // «the digest did not match», so the dummy digest is verified rather than skipped.
    expect(harness.hasher.verified).toContainEqual({
      digest: harness.hasher.dummyHash,
      password: CURRENT_PASSWORD,
    });
    expect(harness.enrollment.rows.get(USER_ID)?.enabledAt).toBeNull();
  });
});

/**
 * The queue refusing one of the ten hashes a fresh batch of recovery codes costs.
 *
 * `mint()` is not one computation, it is ten queued one after another
 * (`csprng-recovery-code-generator.adapter.ts`) — by a wide margin the likeliest moment in this flow
 * to meet a saturated ceiling. It used to run one line *above* the refund wrapper, so a refusal on
 * the fourth of ten raised a `503` and kept the point, and five such refusals during a spike locked
 * the account holder out for fifteen minutes, escalating to an hour, without a single wrong credential.
 */
describe('a batch the argon2 queue refused halfway', () => {
  const refusingMint = (admitted: number): RecoveryCodeGeneratorPort =>
    new CsprngRecoveryCodeGenerator(
      new LimitedPasswordHasher(new FakePasswordHasher(), hashSemaphoreRefusingAfter(admitted)),
    );

  it('gives back the attempt the mint never finished spending', async () => {
    const harness = buildHarness(refusingMint(3));

    await expect(harness.useCase.execute(harness.request())).rejects.toBeInstanceOf(
      ServiceUnavailableError,
    );

    // CONTROL: the point really was taken, so the refund below is an undo and not an absent call.
    expect(harness.rateLimit.consumed).toEqual([
      { policy: 'mfa_setup_attempt', subject: { userId: USER_ID } },
    ]);
    expect(harness.rateLimit.refunded).toEqual([
      { policy: 'mfa_setup_attempt', subject: { userId: USER_ID } },
    ]);
  });
});
