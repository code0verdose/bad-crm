import { describe, expect, it } from 'vitest';

import { GenerateRecoveryCodesUseCase } from '@/application/identity/use-cases/generate-recovery-codes.use-case.js';
import { RegenerateRecoveryCodesUseCase } from '@/application/identity/use-cases/regenerate-recovery-codes.use-case.js';
import {
  RateLimitedError,
  ReauthenticationRequiredError,
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

const buildHarness = () => {
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
  const generator = new FakeRecoveryCodeGenerator();
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
