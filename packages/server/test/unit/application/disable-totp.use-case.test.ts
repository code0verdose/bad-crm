import { describe, expect, it } from 'vitest';

import { DisableTotpUseCase } from '@/application/identity/use-cases/disable-totp.use-case.js';
import { RecoveryCodeMatcher } from '@/application/identity/use-cases/recovery-code-matcher.use-case.js';
import { MfaPolicyQuery } from '@/application/organization/use-cases/mfa-policy.query.js';
import { type FieldEncryptionPort } from '@/application/platform/ports/field-encryption.port.js';
import { type TenantScope } from '@/application/platform/ports/unit-of-work.port.js';
import {
  MfaRequiredByPolicyError,
  RateLimitedError,
  ReauthenticationRequiredError,
} from '@/domain/shared/errors/app.errors.js';

import {
  authUser,
  FakeAuditLogger,
  FakeMfaPolicyReader,
  FakeOrganizations,
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

interface HarnessOptions {
  /** Substituted only by the race case below, which needs a rival to write between the scopes. */
  /**
   * Typed as the double, not as the port: the harness hands it straight back, and the one case that
   * substitutes a rival reads `onScopeClosed` off it — a seam only the double has.
   */
  readonly unitOfWork?: FakeUnitOfWork;
  /** Substituted only by the broken-port case below. */
  readonly fields?: FieldEncryptionPort;
}

/**
 * A unit of work that lets a rival request land between the read scope and the write scope.
 *
 * That window is the whole point of the three-phase shape this command runs in (see the use-case's
 * own docstring): the rows are read in one transaction, the proofs are judged holding none, and the
 * write opens a second. Whatever another request did in the meantime is decided by the conditional
 * statements `commit` issues — which is what these cases exercise. A double that opened one scope
 * could not express «in the meantime» at all.
 */
class RacingUnitOfWork extends FakeUnitOfWork {
  /** Assigned after the harness is built, because the rival writes through its repositories. */
  rival: (() => Promise<void>) | undefined;

  private opened = 0;

  override async withTenant<T>(scope: TenantScope, work: () => Promise<T>): Promise<T> {
    this.opened += 1;

    if (this.opened === 2 && this.rival !== undefined) await this.rival();

    return await super.withTenant(scope, work);
  }
}

/** A field-encryption port that breaks the contract `FieldEncryptionPort.decrypt` states. */
class NullDecryptingFields extends FakeFieldEncryption {
  override decrypt(): string | null {
    return null;
  }
}

const buildHarness = (options: HarnessOptions = {}) => {
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
  const fields = options.fields ?? new FakeFieldEncryption();
  const recoveryCodeRows = new FakeRecoveryCodes();
  // Kept apart from `hasher` on purpose: the password verification and the recovery-code
  // comparisons are then countable separately, which is what «malformed code buys no argon2id»
  // needs to say anything at all.
  const matcherHasher = new FakePasswordHasher();
  const matcher = new RecoveryCodeMatcher(recoveryCodeRows, matcherHasher);
  const hasher = new FakePasswordHasher();
  const unitOfWork = options.unitOfWork ?? new FakeUnitOfWork();
  const rateLimit = new FakeRateLimit();
  const clock = new FakeClock();
  const logger = new RecordingLogger();
  const audit = new FakeAuditLogger();
  const dispatcher = new FakeMailDispatcher();
  const organizations = new FakeOrganizations();

  // Empty by default: an installation with no second-factor policy, which is what every case in
  // this file but the last block is about. `policyReader.grants` is what puts the account under one.
  const policyReader = new FakeMfaPolicyReader();
  const policies = new MfaPolicyQuery(organizations, policyReader, clock, logger);

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
    policies,
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
    matcherHasher,
    unitOfWork,
    rateLimit,
    clock,
    logger,
    audit,
    dispatcher,
    enableTotp,
    seedRecoveryCode,
    policyReader,
    organizations,
    policies,
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

    // The container, not the field: `find` answers `null` when the account has no enrolment left at
    // all, `state?.enabledAt` was then `undefined`, and `expect(undefined).not.toBeNull()` passed on
    // exactly the outcome this case forbids — a refusal that disabled the second factor anyway.
    expect(state).toMatchObject({ enabledAt: expect.any(Date) });
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

    expect(state).toMatchObject({ enabledAt: expect.any(Date) });
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

    expect(state).toMatchObject({ enabledAt: expect.any(Date) });
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

    expect(state).toMatchObject({ enabledAt: expect.any(Date) });
  });
});

describe('a concurrent request racing the recovery code', () => {
  it('refuses reauthentication_required when the code was spent between the read and the write', async () => {
    const unitOfWork = new RacingUnitOfWork();
    const harness = buildHarness({ unitOfWork });

    await harness.enableTotp();
    harness.seedRecoveryCode('ABCDE23456');

    // Somebody else — a second disable, or a sign-in presenting the same sheet — spends the row
    // after this call matched it and before this call writes. `markUsed` is the conditional
    // `UPDATE ... WHERE used_at IS NULL` that decides the winner, and it answers `false` here.
    // The already-used case a few blocks above never reaches this statement: `listUnused` does not
    // return a spent row, so that request is refused at the comparison instead.
    unitOfWork.rival = async (): Promise<void> => {
      await harness.recoveryCodeRows.markUsed(USER_ID, 'ABCDE23456', harness.clock.now());
    };

    await expect(
      harness.useCase.execute({
        actor: ACTOR,
        password: PASSWORD,
        code: 'ABCDE23456',
        ipAddress: IP_ADDRESS,
      }),
    ).rejects.toBeInstanceOf(ReauthenticationRequiredError);

    // The loser of the race changes nothing: 2FA is still on, and the batch was not deleted.
    const state = await harness.enrollment.find(USER_ID);

    expect(state).toMatchObject({ enabledAt: expect.any(Date) });
    expect(harness.recoveryCodeRows.rows.size).toBe(1);
    expect(harness.audit.events).toEqual([]);
  });
});

describe('a recovery code that is not of the shape this system issues', () => {
  it('is refused without buying a single argon2id comparison', async () => {
    const harness = buildHarness();

    await harness.enableTotp();
    harness.seedRecoveryCode('ABCDE23456');

    // Nine characters where a code has ten — the typo, and equally the cheapest thing an attacker
    // can send. The point of the branch is the cost, not the answer: a malformed code must not buy
    // `RECOVERY_CODE_COUNT` verifications of the ration this ceiling exists to protect.
    await expect(
      harness.useCase.execute({
        actor: ACTOR,
        password: PASSWORD,
        code: 'ABCDE2345',
        ipAddress: IP_ADDRESS,
      }),
    ).rejects.toBeInstanceOf(ReauthenticationRequiredError);

    expect(harness.matcherHasher.verified).toEqual([]);

    // CONTROL for that probe: a code of the right shape that simply belongs to nobody does reach
    // the matcher, so the empty list above is the refusal and not a hasher nothing ever calls.
    const control = buildHarness();

    await control.enableTotp();
    control.seedRecoveryCode('ABCDE23456');

    await control.useCase
      .execute({ actor: ACTOR, password: PASSWORD, code: 'ZZZZZ99999', ipAddress: IP_ADDRESS })
      .catch(() => undefined);

    expect(control.matcherHasher.verified.length).toBeGreaterThan(0);
  });
});

describe('a field-encryption port that breaks its own contract', () => {
  it('answers 503 rather than handing an empty secret to the TOTP verifier', async () => {
    const harness = buildHarness({ fields: new NullDecryptingFields() });

    await harness.enableTotp();

    await expect(
      harness.useCase.execute({
        actor: ACTOR,
        password: PASSWORD,
        code: TOTP_CODE,
        ipAddress: IP_ADDRESS,
      }),
    ).rejects.toThrow('A dependency is unavailable');

    // The half that makes the guard worth its lines: the verifier is never asked to judge a code
    // against `''`, which a `null` reaching `base32Secret` unguarded would have handed it.
    expect(harness.totp.verifyCalls).toEqual([]);
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
      harness.policies,
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

/**
 * STORY-013-05 acceptance 6, and the half STORY-013-04 deliberately left open: `assertNotRequiredByPolicy`
 * was not written then because there was no policy row for it to read, and a refusal nobody could
 * lift would have been worse than none.
 */
describe('the organization policy', () => {
  const underPolicy = async (
    harness: ReturnType<typeof buildHarness>,
    graceDays = 30,
  ): Promise<void> => {
    harness.organizations.settings = {
      securityPolicy: {
        mfaRequiredForRoles: ['admin'],
        mfaGracePeriodDays: graceDays,
        mfaRequiredSince: { admin: harness.clock.now().toISOString() },
      },
    };
    harness.policyReader.grants.set(USER_ID, [
      { roleKey: 'admin', roleId: 'role-admin', grantedAt: harness.clock.now() },
    ]);
  };

  it('refuses with mfa_required_by_policy and leaves 2FA on', async () => {
    const harness = buildHarness();

    await harness.enableTotp();
    await underPolicy(harness);

    await expect(
      harness.useCase.execute({
        actor: ACTOR,
        password: PASSWORD,
        code: TOTP_CODE,
        ipAddress: IP_ADDRESS,
      }),
    ).rejects.toBeInstanceOf(MfaRequiredByPolicyError);

    const state = await harness.enrollment.find(USER_ID);

    expect(state).not.toBeNull();
    expect(state?.enabledAt).toEqual(harness.clock.now());
  });

  /**
   * Inside the grace period the policy still *requires* the factor: the countdown decides what a
   * session may do, not whether a factor already in place may be thrown away.
   */
  it('refuses inside the grace period too', async () => {
    const harness = buildHarness();

    await harness.enableTotp();
    await underPolicy(harness, 30);

    await expect(
      harness.useCase.execute({
        actor: ACTOR,
        password: PASSWORD,
        code: TOTP_CODE,
        ipAddress: IP_ADDRESS,
      }),
    ).rejects.toBeInstanceOf(MfaRequiredByPolicyError);
  });

  /**
   * The refusal is about the organization's state, not about the caller's credentials, so it must
   * never be reachable without them: otherwise a stolen access token would answer «is this colleague
   * covered by the policy» for free.
   */
  it('answers the reauthentication refusal first for a wrong password', async () => {
    const harness = buildHarness();

    await harness.enableTotp();
    await underPolicy(harness);

    await expect(
      harness.useCase.execute({
        actor: ACTOR,
        password: 'not-the-password',
        code: TOTP_CODE,
        ipAddress: IP_ADDRESS,
      }),
    ).rejects.toBeInstanceOf(ReauthenticationRequiredError);
  });

  it('CONTROL: the same request succeeds when the policy covers none of the caller’s roles', async () => {
    const harness = buildHarness();

    await harness.enableTotp();
    await underPolicy(harness);
    harness.policyReader.grants.set(USER_ID, [
      { roleKey: 'developer', roleId: 'role-developer', grantedAt: harness.clock.now() },
    ]);

    await harness.useCase.execute({
      actor: ACTOR,
      password: PASSWORD,
      code: TOTP_CODE,
      ipAddress: IP_ADDRESS,
    });

    // Disabled: the row is gone, exactly as every other successful disable in this file leaves it.
    expect(await harness.enrollment.find(USER_ID)).toBeNull();
  });
});
