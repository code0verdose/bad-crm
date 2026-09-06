import { describe, expect, it } from 'vitest';

import { type RecoveryCodeGeneratorPort } from '@/application/identity/ports/recovery-code-generator.port.js';
import { CsprngRecoveryCodeGenerator } from '@/infrastructure/crypto/csprng-recovery-code-generator.adapter.js';
import { LimitedPasswordHasher } from '@/infrastructure/crypto/limited-password-hasher.adapter.js';
import { GenerateRecoveryCodesUseCase } from '@/application/identity/use-cases/generate-recovery-codes.use-case.js';
import { RegenerateRecoveryCodesUseCase } from '@/application/identity/use-cases/regenerate-recovery-codes.use-case.js';
import {
  RateLimitedError,
  ReauthenticationRequiredError,
  ServiceUnavailableError,
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
const CURRENT_PASSWORD = 'correct-horse-battery';
const TOTP_CODE = '123456';
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

  const enrollment = new FakeTotpEnrollment();
  const totp = new ScriptedTotp();
  const fields = new FakeFieldEncryption();
  const recoveryCodeRows = new FakeRecoveryCodes();
  const generateRecoveryCodes = new GenerateRecoveryCodesUseCase(recoveryCodeRows, generator);
  const hasher = new FakePasswordHasher();
  const unitOfWork = new FakeUnitOfWork();
  const rateLimit = new FakeRateLimit();
  const clock = new FakeClock();
  const logger = new RecordingLogger();
  const audit = new FakeAuditLogger();
  const dispatcher = new FakeMailDispatcher();

  const useCase = new RegenerateRecoveryCodesUseCase(
    users,
    enrollment,
    totp,
    fields,
    recoveryCodeRows,
    hasher,
    generateRecoveryCodes,
    unitOfWork,
    rateLimit,
    clock,
    logger,
    audit,
    dispatcher,
    'https://crm.example.com',
  );

  const enableTotp = async (): Promise<void> => {
    const secretEnc = fields.encrypt('THESECRET') ?? '';

    await enrollment.beginDraft(USER_ID, secretEnc, new Date(clock.now().getTime() + 60_000));
    await enrollment.commitEnrollment(USER_ID, 1, clock.now());
    totp.script = [{ accepted: true, counter: 2 }];
  };

  return {
    useCase,
    users,
    enrollment,
    totp,
    fields,
    recoveryCodeRows,
    hasher,
    unitOfWork,
    rateLimit,
    clock,
    logger,
    audit,
    dispatcher,
    enableTotp,
  };
};

describe('regenerating with both credentials correct', () => {
  it('deletes every old code and issues a fresh set of ten', async () => {
    const harness = buildHarness();

    await harness.enableTotp();
    await harness.recoveryCodeRows.createMany(USER_ID, [
      '$argon2id$hashed:OLD1',
      '$argon2id$hashed:OLD2',
    ]);

    const result = await harness.useCase.execute({
      actor: ACTOR,
      currentPassword: CURRENT_PASSWORD,
      totpCode: TOTP_CODE,
      ipAddress: IP_ADDRESS,
    });

    expect(result.recoveryCodes).toHaveLength(10);
    expect(harness.recoveryCodeRows.rows.size).toBe(10);
    expect(
      [...harness.recoveryCodeRows.rows.values()].some(
        (row) => row.codeHash === '$argon2id$hashed:OLD1',
      ),
    ).toBe(false);
  });

  it('records user.mfa_recovery_codes_regenerated with the old and new counts, and the caller’s address', async () => {
    const harness = buildHarness();

    await harness.enableTotp();
    await harness.recoveryCodeRows.createMany(USER_ID, ['$argon2id$hashed:OLD1']);

    await harness.useCase.execute({
      actor: ACTOR,
      currentPassword: CURRENT_PASSWORD,
      totpCode: TOTP_CODE,
      ipAddress: IP_ADDRESS,
    });

    expect(harness.audit.events).toContainEqual(
      expect.objectContaining({
        action: 'user.mfa_recovery_codes_regenerated',
        before: { previousCount: 1 },
        after: { issuedCount: 10 },
        actor: expect.objectContaining({ ipAddress: IP_ADDRESS }),
      }),
    );
  });

  it('advances the TOTP counter so the same reauth code cannot be replayed at sign-in', async () => {
    const harness = buildHarness();

    await harness.enableTotp();
    await harness.useCase.execute({
      actor: ACTOR,
      currentPassword: CURRENT_PASSWORD,
      totpCode: TOTP_CODE,
      ipAddress: IP_ADDRESS,
    });

    const state = await harness.enrollment.find(USER_ID);

    expect(state?.lastCounter).toBe(2);
  });

  /** M-5: the one signal the account owner sees through a channel a hijacked session does not control. */
  it('notifies the account owner by mail, after the transaction has committed', async () => {
    const harness = buildHarness();

    await harness.enableTotp();

    harness.unitOfWork.onScopeClosed = (): void => {
      expect(harness.dispatcher.dispatched).toEqual([]);
    };

    await harness.useCase.execute({
      actor: ACTOR,
      currentPassword: CURRENT_PASSWORD,
      totpCode: TOTP_CODE,
      ipAddress: IP_ADDRESS,
    });

    expect(harness.dispatcher.dispatched).toHaveLength(1);
    expect(harness.dispatcher.dispatched[0]?.mail.to).toBe('ada@example.com');
  });
});

describe('refusing a wrong password', () => {
  it('answers reauthentication_required and deletes nothing', async () => {
    const harness = buildHarness();

    await harness.enableTotp();
    await harness.recoveryCodeRows.createMany(USER_ID, ['$argon2id$hashed:OLD1']);

    await expect(
      harness.useCase.execute({
        actor: ACTOR,
        currentPassword: 'wrong',
        totpCode: TOTP_CODE,
        ipAddress: IP_ADDRESS,
      }),
    ).rejects.toBeInstanceOf(ReauthenticationRequiredError);

    expect(harness.recoveryCodeRows.rows.size).toBe(1);
  });
});

describe('refusing a wrong TOTP code', () => {
  it('answers the identical reauthentication_required', async () => {
    const harness = buildHarness();

    await harness.enableTotp();
    harness.totp.script = [{ accepted: false, replayed: false }];

    await expect(
      harness.useCase.execute({
        actor: ACTOR,
        currentPassword: CURRENT_PASSWORD,
        totpCode: '000000',
        ipAddress: IP_ADDRESS,
      }),
    ).rejects.toBeInstanceOf(ReauthenticationRequiredError);
  });
});

describe('an account with no TOTP enrolled', () => {
  it('also answers reauthentication_required, not a distinct "not enrolled" error', async () => {
    const harness = buildHarness();

    await expect(
      harness.useCase.execute({
        actor: ACTOR,
        currentPassword: CURRENT_PASSWORD,
        totpCode: TOTP_CODE,
        ipAddress: IP_ADDRESS,
      }),
    ).rejects.toBeInstanceOf(ReauthenticationRequiredError);
  });
});

describe('a wrong password does not burn the TOTP counter — gate M-5', () => {
  it('leaves totp_last_counter untouched when the password is wrong, even with a valid code', async () => {
    const harness = buildHarness();

    await harness.enableTotp();
    const before = await harness.enrollment.find(USER_ID);

    await harness.useCase
      .execute({
        actor: ACTOR,
        currentPassword: 'wrong',
        totpCode: TOTP_CODE,
        ipAddress: IP_ADDRESS,
      })
      .catch(() => undefined);

    const after = await harness.enrollment.find(USER_ID);

    expect(after?.lastCounter).toBe(before?.lastCounter);
  });
});

describe('a concurrent regeneration racing the counter — gate M-1', () => {
  /**
   * `advanceCounter`'s own result decides the outcome now — previously it was called and ignored, so
   * a second call with the identical counter (a doubled form submission, or a sign-in racing a
   * regeneration) would still fall through to delete the batch the first call had *just* issued and
   * mint another one, leaving two "the current recovery codes" answers where only one write actually
   * stands.
   */
  it('refuses reauthentication_required when the counter has already moved past this step', async () => {
    const harness = buildHarness();

    await harness.enableTotp();

    // Simulates a second confirmation of the identical TOTP step having already advanced the
    // counter — the same fact `advanceCounter` itself detects on a genuine race.
    await harness.enrollment.advanceCounter(USER_ID, 2);

    await expect(
      harness.useCase.execute({
        actor: ACTOR,
        currentPassword: CURRENT_PASSWORD,
        totpCode: TOTP_CODE,
        ipAddress: IP_ADDRESS,
      }),
    ).rejects.toBeInstanceOf(ReauthenticationRequiredError);

    // Nothing about the recovery-code batch changed — the race was caught before either write.
    expect(harness.recoveryCodeRows.rows.size).toBe(0);
  });
});

describe('the rate limit', () => {
  it('refuses once the mfa_reauth_attempt budget is spent', async () => {
    const harness = buildHarness();

    await harness.enableTotp();

    const limitedUseCase = new RegenerateRecoveryCodesUseCase(
      harness.users,
      harness.enrollment,
      harness.totp,
      harness.fields,
      harness.recoveryCodeRows,
      harness.hasher,
      new GenerateRecoveryCodesUseCase(harness.recoveryCodeRows, new FakeRecoveryCodeGenerator()),
      harness.unitOfWork,
      new FakeRateLimit({ limits: { mfa_reauth_attempt: 0 } }),
      harness.clock,
      harness.logger,
      harness.audit,
      harness.dispatcher,
      'https://crm.example.com',
    );

    await expect(
      limitedUseCase.execute({
        actor: ACTOR,
        currentPassword: CURRENT_PASSWORD,
        totpCode: TOTP_CODE,
        ipAddress: IP_ADDRESS,
      }),
    ).rejects.toBeInstanceOf(RateLimitedError);
  });
});

describe('a TOTP secret this key cannot decrypt', () => {
  it('answers service_unavailable rather than a bare 500, and logs at error level', async () => {
    const harness = buildHarness();

    await harness.enableTotp();
    await harness.recoveryCodeRows.createMany(USER_ID, ['$argon2id$hashed:OLD1']);
    harness.fields.decrypt = () => {
      throw new Error('encrypted field is not in the v1 format this key reads');
    };

    await expect(
      harness.useCase.execute({
        actor: ACTOR,
        currentPassword: CURRENT_PASSWORD,
        totpCode: TOTP_CODE,
        ipAddress: IP_ADDRESS,
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableError);

    expect(harness.logger.lines).toContainEqual(
      expect.objectContaining({
        level: 'error',
        fields: expect.objectContaining({ event: 'totp_secret_undecryptable' }),
      }),
    );
    // Not a wrong code: the existing set stays, because nothing was proven either way.
    expect(harness.recoveryCodeRows.rows.size).toBe(1);
  });
});

describe('an account with no credential row at all', () => {
  it('still pays one verification against the dummy digest, and answers reauthentication_required', async () => {
    const harness = buildHarness();

    await harness.enableTotp();
    harness.users.credentials.delete(USER_ID);

    await expect(
      harness.useCase.execute({
        actor: ACTOR,
        currentPassword: CURRENT_PASSWORD,
        totpCode: TOTP_CODE,
        ipAddress: IP_ADDRESS,
      }),
    ).rejects.toBeInstanceOf(ReauthenticationRequiredError);

    // Elapsed time must not tell «no credential row» apart from «the digest did not match».
    expect(harness.hasher.verified).toContainEqual({
      digest: harness.hasher.dummyHash,
      password: CURRENT_PASSWORD,
    });
  });
});

/**
 * The queue refusing one of the ten hashes a fresh batch of recovery codes costs.
 *
 * `mint()` is not one computation, it is ten queued one after another
 * (`csprng-recovery-code-generator.adapter.ts`) — by a wide margin the likeliest moment in this flow
 * to meet a saturated ceiling. It used to run one line *above* the refund wrapper, so a refusal on
 * the fourth of ten raised a `503` and kept the point, and five such refusals during a spike locked
 * the account holder out for fifteen minutes without a single wrong credential.
 */
describe('a batch the argon2 queue refused halfway', () => {
  const refusingMint = (admitted: number): RecoveryCodeGeneratorPort =>
    new CsprngRecoveryCodeGenerator(
      new LimitedPasswordHasher(new FakePasswordHasher(), hashSemaphoreRefusingAfter(admitted)),
    );

  it('gives back the attempt the mint never finished spending', async () => {
    const harness = buildHarness(refusingMint(3));

    await expect(
      harness.useCase.execute({
        actor: ACTOR,
        currentPassword: CURRENT_PASSWORD,
        totpCode: TOTP_CODE,
        ipAddress: IP_ADDRESS,
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableError);

    // CONTROL: the point really was taken, so the refund below is an undo and not an absent call.
    expect(harness.rateLimit.consumed).toEqual([
      { policy: 'mfa_reauth_attempt', subject: { userId: USER_ID } },
    ]);
    expect(harness.rateLimit.refunded).toEqual([
      { policy: 'mfa_reauth_attempt', subject: { userId: USER_ID } },
    ]);
  });
});
