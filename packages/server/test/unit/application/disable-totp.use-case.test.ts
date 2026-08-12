import { describe, expect, it } from 'vitest';

import { DisableTotpUseCase } from '@/application/identity/use-cases/disable-totp.use-case.js';
import { RecoveryCodeMatcher } from '@/application/identity/use-cases/recovery-code-matcher.use-case.js';
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
  FakeRecoveryCodes,
  FakeTotpEnrollment,
  ScriptedTotp,
} from '../../support/mfa-doubles.util.js';

const ACTOR = { organizationId: ORGANIZATION_ID, userId: USER_ID };
const PASSWORD = 'correct-horse-battery';
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
    passwordHash: `$argon2id$hashed:${PASSWORD}`,
    locale: account.locale,
  });

  const enrollment = new FakeTotpEnrollment();
  const totp = new ScriptedTotp();
  const fields = new FakeFieldEncryption();
  const recoveryCodeRows = new FakeRecoveryCodes();
  const matcher = new RecoveryCodeMatcher(recoveryCodeRows, new FakePasswordHasher());
  const hasher = new FakePasswordHasher();
  const unitOfWork = new FakeUnitOfWork();
  const rateLimit = new FakeRateLimit();
  const clock = new FakeClock();
  const logger = new RecordingLogger();
  const audit = new FakeAuditLogger();
  const dispatcher = new FakeMailDispatcher();

  const useCase = new DisableTotpUseCase(
    enrollment,
    totp,
    fields,
    recoveryCodeRows,
    matcher,
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

  const enableTotp = async (): Promise<void> => {
    const secretEnc = fields.encrypt('THESECRET') ?? '';

    await enrollment.beginDraft(USER_ID, secretEnc, new Date(clock.now().getTime() + 60_000));
    await enrollment.commitEnrollment(USER_ID, 1, clock.now());
    totp.script = [{ accepted: true, counter: 2 }];
  };

  const seedRecoveryCode = (plaintext: string): void => {
    recoveryCodeRows.rows.set(plaintext, {
      id: plaintext,
      userId: USER_ID,
      codeHash: `$argon2id$hashed:${plaintext}`,
      usedAt: null,
    });
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
    seedRecoveryCode,
  };
};

describe('disabling with a correct password and a live TOTP code', () => {
  it('clears the enrolment and deletes every recovery code, in one call', async () => {
    const harness = buildHarness();

    await harness.enableTotp();
    harness.seedRecoveryCode('ABCDE23456');

    await harness.useCase.execute({
      actor: ACTOR,
      password: PASSWORD,
      code: TOTP_CODE,
      ipAddress: IP_ADDRESS,
    });

    const state = await harness.enrollment.find(USER_ID);

    expect(state).toBeNull();
    expect(harness.recoveryCodeRows.rows.size).toBe(0);
  });

  it('records user.mfa_disabled with the caller’s address', async () => {
    const harness = buildHarness();

    await harness.enableTotp();
    harness.seedRecoveryCode('ABCDE23456');

    await harness.useCase.execute({
      actor: ACTOR,
      password: PASSWORD,
      code: TOTP_CODE,
      ipAddress: IP_ADDRESS,
    });

    expect(harness.audit.events).toContainEqual(
      expect.objectContaining({
        action: 'user.mfa_disabled',
        target: { type: 'USER', id: USER_ID },
        after: { recoveryCodesDeleted: 1, secondFactorKind: 'totp' },
        actor: expect.objectContaining({ ipAddress: IP_ADDRESS }),
      }),
    );
  });

  it('notifies the account owner by mail, after the transaction has committed', async () => {
    const harness = buildHarness();

    await harness.enableTotp();

    harness.unitOfWork.onScopeClosed = (): void => {
      expect(harness.dispatcher.dispatched).toEqual([]);
    };

    await harness.useCase.execute({
      actor: ACTOR,
      password: PASSWORD,
      code: TOTP_CODE,
      ipAddress: IP_ADDRESS,
    });

    expect(harness.dispatcher.dispatched).toHaveLength(1);
    expect(harness.dispatcher.dispatched[0]?.mail.to).toBe('ada@example.com');
  });
});

describe('disabling with a correct password and an unused recovery code — acceptance 2', () => {
  it('accepts the recovery code as the second proof and spends it', async () => {
    const harness = buildHarness();

    await harness.enableTotp();
    harness.seedRecoveryCode('ABCDE23456');

    await harness.useCase.execute({
      actor: ACTOR,
      password: PASSWORD,
      code: 'ABCDE23456',
      ipAddress: IP_ADDRESS,
    });

    const state = await harness.enrollment.find(USER_ID);

    expect(state).toBeNull();
    // Every code is gone — spent as one-time, then removed with the rest of the batch in the same
    // transaction (acceptance 1 and 2).
    expect(harness.recoveryCodeRows.rows.size).toBe(0);
  });

  it('records the recovery-code path in the audit trail', async () => {
    const harness = buildHarness();

    await harness.enableTotp();
    harness.seedRecoveryCode('ABCDE23456');

    await harness.useCase.execute({
      actor: ACTOR,
      password: PASSWORD,
      code: 'ABCDE23456',
      ipAddress: IP_ADDRESS,
    });

    expect(harness.audit.events).toContainEqual(
      expect.objectContaining({
        action: 'user.mfa_disabled',
        after: expect.objectContaining({ secondFactorKind: 'recovery_code' }),
      }),
    );
  });
});

describe('refusing a wrong password — acceptance 3, a session is not the second factor', () => {
  it('answers reauthentication_required and leaves 2FA enabled', async () => {
    const harness = buildHarness();

    await harness.enableTotp();
    harness.seedRecoveryCode('ABCDE23456');

    await expect(
      harness.useCase.execute({
        actor: ACTOR,
        password: 'wrong',
        code: TOTP_CODE,
        ipAddress: IP_ADDRESS,
      }),
    ).rejects.toBeInstanceOf(ReauthenticationRequiredError);

    const state = await harness.enrollment.find(USER_ID);

    expect(state?.enabledAt).not.toBeNull();
    expect(harness.recoveryCodeRows.rows.size).toBe(1);
  });
});

describe('refusing a missing or wrong code — acceptance 2', () => {
  it('answers reauthentication_required for a wrong TOTP code, and 2FA stays enabled', async () => {
    const harness = buildHarness();

    await harness.enableTotp();
    harness.totp.script = [{ accepted: false, replayed: false }];

    await expect(
      harness.useCase.execute({
        actor: ACTOR,
        password: PASSWORD,
        code: '000000',
        ipAddress: IP_ADDRESS,
      }),
    ).rejects.toBeInstanceOf(ReauthenticationRequiredError);

    const state = await harness.enrollment.find(USER_ID);

    expect(state?.enabledAt).not.toBeNull();
  });

  it('answers reauthentication_required for an unknown recovery code', async () => {
    const harness = buildHarness();

    await harness.enableTotp();

    await expect(
      harness.useCase.execute({
        actor: ACTOR,
        password: PASSWORD,
        code: 'ZZZZZ99999',
        ipAddress: IP_ADDRESS,
      }),
    ).rejects.toBeInstanceOf(ReauthenticationRequiredError);
  });

  it('answers reauthentication_required for an already-used recovery code, without touching it twice', async () => {
    const harness = buildHarness();

    await harness.enableTotp();
    harness.seedRecoveryCode('ABCDE23456');
    await harness.recoveryCodeRows.markUsed(USER_ID, 'ABCDE23456', harness.clock.now());

    await expect(
      harness.useCase.execute({
        actor: ACTOR,
        password: PASSWORD,
        code: 'ABCDE23456',
        ipAddress: IP_ADDRESS,
      }),
    ).rejects.toBeInstanceOf(ReauthenticationRequiredError);

    const state = await harness.enrollment.find(USER_ID);

    expect(state?.enabledAt).not.toBeNull();
  });
});

describe('an account with no TOTP enrolled', () => {
  it('answers reauthentication_required, not a distinct "not enrolled" error', async () => {
    const harness = buildHarness();

    await expect(
      harness.useCase.execute({
        actor: ACTOR,
        password: PASSWORD,
        code: TOTP_CODE,
        ipAddress: IP_ADDRESS,
      }),
    ).rejects.toBeInstanceOf(ReauthenticationRequiredError);
  });
});

describe('an account with no credential row at all', () => {
  it('answers reauthentication_required and still pays the dummy-hash verification', async () => {
    const harness = buildHarness();

    await harness.enableTotp();
    harness.users.credentials.delete(USER_ID);

    await expect(
      harness.useCase.execute({
        actor: ACTOR,
        password: PASSWORD,
        code: TOTP_CODE,
        ipAddress: IP_ADDRESS,
      }),
    ).rejects.toBeInstanceOf(ReauthenticationRequiredError);

    expect(harness.hasher.verified.some((call) => call.digest === harness.hasher.dummyHash)).toBe(
      true,
    );
  });
});

describe('a TOTP secret the running encryption key cannot read', () => {
  it('answers 503 service_unavailable rather than a wrong-code refusal', async () => {
    const harness = buildHarness();

    await harness.enableTotp();
    // `FakeFieldEncryption.decrypt` throws on any ciphertext it did not itself produce — the same
    // fact a rotated `APP_ENCRYPTION_KEY` produces against a real column.
    const row = harness.enrollment.rows.get(USER_ID);

    if (row !== undefined) row.secretEnc = 'not-something-this-double-encrypted';

    await expect(
      harness.useCase.execute({
        actor: ACTOR,
        password: PASSWORD,
        code: TOTP_CODE,
        ipAddress: IP_ADDRESS,
      }),
    ).rejects.toThrow('A dependency is unavailable');
  });
});

describe('a wrong password does not burn the TOTP counter or spend a recovery code', () => {
  it('leaves totp_last_counter untouched when the password is wrong, even with a valid code', async () => {
    const harness = buildHarness();

    await harness.enableTotp();
    const before = await harness.enrollment.find(USER_ID);

    await harness.useCase
      .execute({ actor: ACTOR, password: 'wrong', code: TOTP_CODE, ipAddress: IP_ADDRESS })
      .catch(() => undefined);

    const after = await harness.enrollment.find(USER_ID);

    expect(after?.lastCounter).toBe(before?.lastCounter);
  });

  it('leaves a valid recovery code unspent when the password is wrong', async () => {
    const harness = buildHarness();

    await harness.enableTotp();
    harness.seedRecoveryCode('ABCDE23456');

    await harness.useCase
      .execute({ actor: ACTOR, password: 'wrong', code: 'ABCDE23456', ipAddress: IP_ADDRESS })
      .catch(() => undefined);

    expect(harness.recoveryCodeRows.rows.get('ABCDE23456')?.usedAt).toBeNull();
  });
});

describe('a concurrent request racing the TOTP counter', () => {
  it('refuses reauthentication_required when the counter has already moved past this step', async () => {
    const harness = buildHarness();

    await harness.enableTotp();

    // Simulates a second confirmation of the identical TOTP step having already advanced the
    // counter — the same fact `advanceCounter` itself detects on a genuine race.
    await harness.enrollment.advanceCounter(USER_ID, 2);

    await expect(
      harness.useCase.execute({
        actor: ACTOR,
        password: PASSWORD,
        code: TOTP_CODE,
        ipAddress: IP_ADDRESS,
      }),
    ).rejects.toBeInstanceOf(ReauthenticationRequiredError);

    const state = await harness.enrollment.find(USER_ID);

    expect(state?.enabledAt).not.toBeNull();
  });
});

describe('the rate limit', () => {
  it('refuses once the mfa_reauth_attempt budget is spent', async () => {
    const harness = buildHarness();

    await harness.enableTotp();

    const limitedUseCase = new DisableTotpUseCase(
      harness.enrollment,
      harness.totp,
      harness.fields,
      harness.recoveryCodeRows,
      new RecoveryCodeMatcher(harness.recoveryCodeRows, harness.hasher),
      harness.users,
      harness.hasher,
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
        password: PASSWORD,
        code: TOTP_CODE,
        ipAddress: IP_ADDRESS,
      }),
    ).rejects.toBeInstanceOf(RateLimitedError);
  });
});
