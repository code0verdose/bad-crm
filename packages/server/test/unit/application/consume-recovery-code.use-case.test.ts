import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { ConsumeRecoveryCodeUseCase } from '@/application/identity/use-cases/consume-recovery-code.use-case.js';
import { RateLimitedError, RecoveryCodeInvalidError } from '@/domain/shared/errors/app.errors.js';

import {
  FakeAuditLogger,
  FakeClock,
  FakePasswordHasher,
  FakeRateLimit,
  FakeUnitOfWork,
  ORGANIZATION_ID,
  RecordingLogger,
  USER_ID,
} from '../../support/identity-doubles.util.js';
import { FakeRecoveryCodes } from '../../support/mfa-doubles.util.js';

const ACTOR = { organizationId: ORGANIZATION_ID, userId: USER_ID };
const VALID_CODE = 'ABCDE23456';
const IP_ADDRESS = '203.0.113.7';

const buildHarness = () => {
  const codes = new FakeRecoveryCodes();
  const hasher = new FakePasswordHasher();
  const unitOfWork = new FakeUnitOfWork();
  const rateLimit = new FakeRateLimit();
  const clock = new FakeClock();
  const logger = new RecordingLogger();
  const audit = new FakeAuditLogger();

  const useCase = new ConsumeRecoveryCodeUseCase(
    codes,
    hasher,
    unitOfWork,
    rateLimit,
    clock,
    logger,
    audit,
  );

  const seedCode = (plaintext: string): string => {
    const id = randomUUID();

    codes.rows.set(id, {
      id,
      userId: USER_ID,
      codeHash: `$argon2id$hashed:${plaintext}`,
      usedAt: null,
    });

    return id;
  };

  return { useCase, codes, hasher, unitOfWork, rateLimit, clock, logger, audit, seedCode };
};

describe('consuming a valid code', () => {
  it('marks the matching row used and returns its id', async () => {
    const harness = buildHarness();
    const id = harness.seedCode(VALID_CODE);

    const spentId = await harness.useCase.execute({
      actor: ACTOR,
      code: VALID_CODE,
      ipAddress: IP_ADDRESS,
    });

    expect(spentId).toBe(id);
    expect(harness.codes.rows.get(id)?.usedAt).not.toBeNull();
  });

  it('normalizes the presented code (dashes, case, whitespace) before matching', async () => {
    const harness = buildHarness();

    harness.seedCode(VALID_CODE);

    const spentId = await harness.useCase.execute({
      actor: ACTOR,
      code: '  abcde-23456  \n',
      ipAddress: IP_ADDRESS,
    });

    expect(harness.codes.rows.get(spentId)?.usedAt).not.toBeNull();
  });

  it('records user.mfa_recovery_code_used, with the caller’s address', async () => {
    const harness = buildHarness();

    harness.seedCode(VALID_CODE);
    await harness.useCase.execute({ actor: ACTOR, code: VALID_CODE, ipAddress: IP_ADDRESS });

    expect(harness.audit.events).toContainEqual(
      expect.objectContaining({
        action: 'user.mfa_recovery_code_used',
        target: { type: 'USER', id: USER_ID },
        actor: expect.objectContaining({ ipAddress: IP_ADDRESS }),
      }),
    );
  });

  it('clears the mfa_recovery_consume_attempt budget on success', async () => {
    const harness = buildHarness();

    harness.seedCode(VALID_CODE);
    await harness.useCase.execute({ actor: ACTOR, code: VALID_CODE, ipAddress: IP_ADDRESS });

    expect(harness.rateLimit.cleared).toContainEqual({
      policy: 'mfa_recovery_consume_attempt',
      subject: { userId: USER_ID },
    });
  });

  it('leaves an unrelated code of the same account untouched', async () => {
    const harness = buildHarness();

    harness.seedCode(VALID_CODE);
    const otherId = harness.seedCode('OTHER234XY');

    await harness.useCase.execute({ actor: ACTOR, code: VALID_CODE, ipAddress: IP_ADDRESS });

    expect(harness.codes.rows.get(otherId)?.usedAt).toBeNull();
  });
});

describe('refusing an unknown code', () => {
  it('answers recovery_code_invalid and verifies a dummy hash instead of skipping the check', async () => {
    const harness = buildHarness();

    harness.seedCode(VALID_CODE);

    await expect(
      harness.useCase.execute({ actor: ACTOR, code: 'ZZZZZ99999', ipAddress: IP_ADDRESS }),
    ).rejects.toBeInstanceOf(RecoveryCodeInvalidError);

    expect(harness.hasher.verified.some((call) => call.digest === harness.hasher.dummyHash)).toBe(
      true,
    );
  });

  it('records nothing in the audit trail for a refusal', async () => {
    const harness = buildHarness();

    await harness.useCase
      .execute({ actor: ACTOR, code: 'ZZZZZ99999', ipAddress: IP_ADDRESS })
      .catch(() => undefined);

    expect(harness.audit.events).toEqual([]);
  });
});

describe('refusing an already-used code', () => {
  it('answers the same recovery_code_invalid as an unknown code', async () => {
    const harness = buildHarness();
    const id = harness.seedCode(VALID_CODE);

    await harness.codes.markUsed(USER_ID, id, harness.clock.now());

    await expect(
      harness.useCase.execute({ actor: ACTOR, code: VALID_CODE, ipAddress: IP_ADDRESS }),
    ).rejects.toBeInstanceOf(RecoveryCodeInvalidError);
  });
});

describe('the fixed-cost match — L-2 / timing', () => {
  /**
   * The regression this pins: a batch down to its last code must cost exactly as many Argon2id
   * verifications as a fresh batch of ten, never fewer — otherwise the elapsed time of a refused
   * guess reveals how many codes remain, which is precisely the number `GET /auth/2fa/recovery-codes`
   * is gated behind a session for.
   */
  it('runs exactly ten verifications whether one code remains or ten do', async () => {
    const fullHarness = buildHarness();

    for (let index = 0; index < 10; index += 1)
      fullHarness.seedCode(`FULLBATCH${index.toString()}`);
    await fullHarness.useCase
      .execute({ actor: ACTOR, code: 'ZZZZZ99999', ipAddress: IP_ADDRESS })
      .catch(() => undefined);

    const emptyHarness = buildHarness();

    emptyHarness.seedCode(VALID_CODE);
    await emptyHarness.useCase
      .execute({ actor: ACTOR, code: 'ZZZZZ99999', ipAddress: IP_ADDRESS })
      .catch(() => undefined);

    expect(fullHarness.hasher.verified.length).toBe(10);
    expect(emptyHarness.hasher.verified.length).toBe(10);
  });

  it('refuses a malformed code before any Argon2id verification runs', async () => {
    const harness = buildHarness();

    harness.seedCode(VALID_CODE);

    await expect(
      harness.useCase.execute({ actor: ACTOR, code: 'too-short', ipAddress: IP_ADDRESS }),
    ).rejects.toBeInstanceOf(RecoveryCodeInvalidError);

    expect(harness.hasher.verified).toEqual([]);
  });
});

describe('the rate limit', () => {
  it('refuses once the budget is spent, without touching any row', async () => {
    const harness = buildHarness();
    const id = harness.seedCode(VALID_CODE);

    const limitedUseCase = new ConsumeRecoveryCodeUseCase(
      harness.codes,
      harness.hasher,
      harness.unitOfWork,
      new FakeRateLimit({ limits: { mfa_recovery_consume_attempt: 0 } }),
      harness.clock,
      harness.logger,
      harness.audit,
    );

    await expect(
      limitedUseCase.execute({ actor: ACTOR, code: VALID_CODE, ipAddress: IP_ADDRESS }),
    ).rejects.toBeInstanceOf(RateLimitedError);
    expect(harness.codes.rows.get(id)?.usedAt).toBeNull();
  });
});
