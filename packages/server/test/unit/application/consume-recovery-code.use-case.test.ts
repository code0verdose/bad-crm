import { randomUUID } from 'node:crypto';

import { assert, describe, expect, it } from 'vitest';

import { ConsumeRecoveryCodeUseCase } from '@/application/identity/use-cases/consume-recovery-code.use-case.js';
import { RecoveryCodeMatcher } from '@/application/identity/use-cases/recovery-code-matcher.use-case.js';
import {
  type TenantScope,
  type UnitOfWorkPort,
} from '@/application/platform/ports/unit-of-work.port.js';
import { RateLimitedError, RecoveryCodeInvalidError } from '@/domain/shared/errors/app.errors.js';

import { createPromMetrics } from '@/infrastructure/metrics/prom-client.adapter.js';

import {
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
import { FakeRecoveryCodes } from '../../support/mfa-doubles.util.js';

const ACTOR = { organizationId: ORGANIZATION_ID, userId: USER_ID };
const VALID_CODE = 'ABCDE23456';
const IP_ADDRESS = '203.0.113.7';
const APP_URL = 'https://crm.example.test';

interface HarnessOptions {
  readonly locale?: string;
  readonly limits?: { readonly mfa_recovery_consume_attempt: number };
  /** Substituted only by the race case below, which needs a rival to write between the scopes. */
  readonly unitOfWork?: UnitOfWorkPort;
}

/**
 * A unit of work that lets a rival request land between the read scope and the write scope.
 *
 * `spend` reads the candidates in one transaction, compares them holding none and writes in a
 * second (see its docstring) — so «somebody else spent this row in the meantime» is a state this
 * command can genuinely be in, and `markUsed` answering `false` is how it finds out. A double that
 * opened a single scope could not express the meantime at all.
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

const buildHarness = (options: HarnessOptions = {}) => {
  const codes = new FakeRecoveryCodes();
  const hasher = new FakePasswordHasher();
  const unitOfWork = options.unitOfWork ?? new FakeUnitOfWork();
  const rateLimit = new FakeRateLimit(
    options.limits === undefined ? {} : { limits: options.limits },
  );
  const clock = new FakeClock();
  const logger = new RecordingLogger();
  const audit = new FakeAuditLogger();
  const metrics = createPromMetrics();
  const dispatcher = new FakeMailDispatcher();
  const users = new FakeUsers();
  const matcher = new RecoveryCodeMatcher(codes, hasher);

  users.credentials.set(USER_ID, {
    email: 'ada@example.com',
    passwordHash: '$argon2id$hashed:irrelevant',
    locale: options.locale ?? 'en',
  });

  const useCase = new ConsumeRecoveryCodeUseCase(
    matcher,
    codes,
    users,
    unitOfWork,
    rateLimit,
    clock,
    logger,
    audit,
    metrics,
    dispatcher,
    APP_URL,
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

  return {
    useCase,
    codes,
    hasher,
    unitOfWork,
    rateLimit,
    clock,
    logger,
    audit,
    metrics,
    dispatcher,
    users,
    seedCode,
  };
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
    expect(harness.codes.rows.get(id)).toMatchObject({ usedAt: expect.any(Date) });
  });

  it('normalizes the presented code (dashes, case, whitespace) before matching', async () => {
    const harness = buildHarness();

    harness.seedCode(VALID_CODE);

    const spentId = await harness.useCase.execute({
      actor: ACTOR,
      code: '  abcde-23456  \n',
      ipAddress: IP_ADDRESS,
    });

    // The row, not its field: a use-case that answered an id it never spent made
    // `rows.get(spentId)` `undefined`, and `expect(undefined).not.toBeNull()` passed — the case
    // about matching a normalized code proved nothing about the row it claims was matched.
    expect(harness.codes.rows.get(spentId)).toMatchObject({ usedAt: expect.any(Date) });
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

    // Both halves of the subject, asserted literally rather than with `objectContaining`: the
    // address is what STORY-013-02 acceptance 10 added to this budget, and a partial match would
    // keep passing if it were dropped again on the way to the limiter.
    expect(harness.rateLimit.cleared).toContainEqual({
      policy: 'mfa_recovery_consume_attempt',
      subject: { userId: USER_ID, ipAddress: IP_ADDRESS },
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
      new RecoveryCodeMatcher(harness.codes, harness.hasher),
      harness.codes,
      harness.users,
      harness.unitOfWork,
      new FakeRateLimit({ limits: { mfa_recovery_consume_attempt: 0 } }),
      harness.clock,
      harness.logger,
      harness.audit,
      harness.metrics,
      harness.dispatcher,
      APP_URL,
    );

    await expect(
      limitedUseCase.execute({ actor: ACTOR, code: VALID_CODE, ipAddress: IP_ADDRESS }),
    ).rejects.toBeInstanceOf(RateLimitedError);
    expect(harness.codes.rows.get(id)?.usedAt).toBeNull();
  });
});

/**
 * Acceptance 4, the half that was still open: spending a code has to reach the account owner
 * through a channel the session that spent it does not control.
 *
 * The audit row is not that channel — it is read by an administrator, later, if anybody looks. A
 * stranger who found a printed sheet of recovery codes signs in successfully, and the owner's only
 * chance of noticing is a message arriving in their mailbox. Same notice, same renderer and same
 * after-the-commit dispatch `ConfirmTotpUseCase` and `DisableTotpUseCase` already use for the other
 * three 2FA changes.
 */
describe('the notice to the account owner', () => {
  it('mails the owner after the transaction has committed', async () => {
    const harness = buildHarness();

    harness.seedCode(VALID_CODE);

    // The seam that makes "after" observable: checking once the call returned would pass just as
    // well for a dispatch made from inside the transaction.
    harness.unitOfWork.onScopeClosed = (): void => {
      expect(harness.dispatcher.dispatched).toEqual([]);
    };

    await harness.useCase.execute({ actor: ACTOR, code: VALID_CODE, ipAddress: IP_ADDRESS });

    expect(harness.dispatcher.dispatched).toHaveLength(1);
    expect(harness.dispatcher.dispatched[0]?.mail.to).toBe('ada@example.com');
    expect(harness.dispatcher.dispatched[0]?.context).toEqual({
      event: 'recovery_code_used',
      organizationId: ORGANIZATION_ID,
      userId: USER_ID,
    });
  });

  it('writes the notice in the account’s own language, carrying no code', async () => {
    const harness = buildHarness({ locale: 'ru' });

    harness.seedCode(VALID_CODE);
    await harness.useCase.execute({ actor: ACTOR, code: VALID_CODE, ipAddress: IP_ADDRESS });

    const [notice] = harness.dispatcher.dispatched;

    assert(notice !== undefined, 'the notice was handed to the dispatcher');

    const { mail } = notice;

    expect(mail.subject).toContain('резервный код');
    expect(mail.text).toContain(`${APP_URL}/settings/security`);
    // A notice, never the secret it is about — the restraint `renderMfaChangedMail` documents.
    expect([mail.subject, mail.text, mail.html].join('')).not.toContain(VALID_CODE);
  });

  it('sends nothing when the code was refused', async () => {
    const harness = buildHarness();

    harness.seedCode(VALID_CODE);
    await harness.useCase
      .execute({ actor: ACTOR, code: 'ZZZZZ99999', ipAddress: IP_ADDRESS })
      .catch(() => undefined);

    expect(harness.dispatcher.dispatched).toEqual([]);
  });

  /**
   * A notice that could not be addressed must not undo a sign-in that already happened: the row is
   * spent and committed by the time this runs. The account row can be missing for the same reason
   * `FakeUsers.vanished` exists — soft-deleted between the read and the write — and an installation
   * with no SMTP configured reaches the identical branch one layer down
   * (`unconfigured-mail.adapter.ts`), which is why the dispatch is fire-and-forget rather than awaited.
   */
  it('still spends the code when there is no credential to address the notice to', async () => {
    const harness = buildHarness();
    const id = harness.seedCode(VALID_CODE);

    harness.users.credentials.delete(USER_ID);

    await expect(
      harness.useCase.execute({ actor: ACTOR, code: VALID_CODE, ipAddress: IP_ADDRESS }),
    ).resolves.toBe(id);
    expect(harness.codes.rows.get(id)).toMatchObject({ usedAt: expect.any(Date) });
    expect(harness.dispatcher.dispatched).toEqual([]);
  });
});

/**
 * Acceptance 10, the half that was still open: a run of refused codes has to be visible as a number
 * an operator can alert on, and as **one** trail entry rather than none.
 */
describe('the counter and the record of a series', () => {
  const failedTotal = async (harness: ReturnType<typeof buildHarness>): Promise<string[]> =>
    (await harness.metrics.render())
      .split('\n')
      .filter((line) => line.startsWith('mfa_recovery_failed_total'));

  it('counts every refused code', async () => {
    const harness = buildHarness();

    harness.seedCode(VALID_CODE);

    for (const code of ['ZZZZZ99999', 'YYYYY88888']) {
      await harness.useCase
        .execute({ actor: ACTOR, code, ipAddress: IP_ADDRESS })
        .catch(() => undefined);
    }

    expect(await failedTotal(harness)).toContain('mfa_recovery_failed_total 2');
  });

  it('counts a malformed code too — it is a guess like any other', async () => {
    const harness = buildHarness();

    await harness.useCase
      .execute({ actor: ACTOR, code: 'too-short', ipAddress: IP_ADDRESS })
      .catch(() => undefined);

    expect(await failedTotal(harness)).toContain('mfa_recovery_failed_total 1');
  });

  it('leaves the counter alone when a code is spent successfully', async () => {
    const harness = buildHarness();

    harness.seedCode(VALID_CODE);
    await harness.useCase.execute({ actor: ACTOR, code: VALID_CODE, ipAddress: IP_ADDRESS });

    expect(await failedTotal(harness)).toContain('mfa_recovery_failed_total 0');
  });

  /**
   * One entry for the whole run, filed by the refusal that spent the last of the budget — not one
   * per attempt, which is what «агрегированная запись» rules out, and not none, which is what the
   * trail carried before.
   *
   * The transition is observable exactly once: the attempt that burns the budget is the last one
   * the limiter allows (`remaining === 0`), and every attempt after it is refused by the limiter
   * before a code is ever compared. The next entry therefore costs the attacker a fresh window.
   */
  it('files one aggregated entry on the refusal that exhausts the budget', async () => {
    const harness = buildHarness({ limits: { mfa_recovery_consume_attempt: 3 } });

    for (const code of ['ZZZZZ99999', 'YYYYY88888', 'XXXXX77777']) {
      await harness.useCase
        .execute({ actor: ACTOR, code, ipAddress: IP_ADDRESS })
        .catch(() => undefined);
    }

    expect(
      harness.audit.events.filter((event) => event.action === 'user.mfa_recovery_locked_out'),
    ).toEqual([
      expect.objectContaining({
        action: 'user.mfa_recovery_locked_out',
        target: { type: 'USER', id: USER_ID },
        actor: expect.objectContaining({ ipAddress: IP_ADDRESS }),
      }),
    ]);
  });

  it('does not file a second entry while the lock-out holds', async () => {
    const harness = buildHarness({ limits: { mfa_recovery_consume_attempt: 3 } });

    for (const code of ['ZZZZZ99999', 'YYYYY88888', 'XXXXX77777', 'WWWWW66666', 'VVVVV55555']) {
      await harness.useCase
        .execute({ actor: ACTOR, code, ipAddress: IP_ADDRESS })
        .catch(() => undefined);
    }

    expect(
      harness.audit.events.filter((event) => event.action === 'user.mfa_recovery_locked_out'),
    ).toHaveLength(1);
  });

  it('files nothing when the last allowed attempt succeeds', async () => {
    const harness = buildHarness({ limits: { mfa_recovery_consume_attempt: 1 } });

    harness.seedCode(VALID_CODE);
    await harness.useCase.execute({ actor: ACTOR, code: VALID_CODE, ipAddress: IP_ADDRESS });

    expect(
      harness.audit.events.filter((event) => event.action === 'user.mfa_recovery_locked_out'),
    ).toEqual([]);
  });
});

describe('a concurrent request racing the same recovery code', () => {
  it('answers recovery_code_invalid, not a sign-in, when the row was spent in the meantime', async () => {
    const unitOfWork = new RacingUnitOfWork();
    const harness = buildHarness({ unitOfWork });
    const id = harness.seedCode(VALID_CODE);

    // The row this call matched is spent by somebody else after the comparison and before the
    // write. `markUsed`'s conditional UPDATE answers `false`, and the answer folds into the one
    // refusal this endpoint has — telling the two apart would confirm the code was real.
    unitOfWork.rival = async (): Promise<void> => {
      await harness.codes.markUsed(USER_ID, id, harness.clock.now());
    };

    await expect(
      harness.useCase.execute({ actor: ACTOR, code: VALID_CODE, ipAddress: IP_ADDRESS }),
    ).rejects.toBeInstanceOf(RecoveryCodeInvalidError);

    // The loser of the race hands out nothing a winner would have got: no trail entry saying a code
    // was used, and no notice to the account owner about a sign-in that did not happen.
    expect(harness.audit.events.map((event) => event.action)).not.toContain(
      'user.mfa_recovery_code_used',
    );
    expect(harness.dispatcher.dispatched).toEqual([]);
  });
});
