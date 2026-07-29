import {
  type AuthLookupPort,
  type AuthPasswordResetRecord,
} from '@/application/identity/ports/auth-lookup.port.js';
import { type PasswordHasherPort } from '@/application/identity/ports/password-hasher.port.js';
import { type PasswordResetTokenRepositoryPort } from '@/application/identity/ports/password-reset-token.port.js';
import { type ResetTokenPort } from '@/application/identity/ports/reset-token.port.js';
import { type SessionRepositoryPort } from '@/application/identity/ports/session-repository.port.js';
import { type UserRepositoryPort } from '@/application/identity/ports/user-repository.port.js';
import { type SessionClient } from '@/application/identity/use-cases/issue-session.use-case.js';
import { type ClockPort } from '@/application/platform/ports/clock.port.js';
import { type LoggerPort } from '@/application/platform/ports/logger.port.js';
import { type RateLimitPort } from '@/application/platform/ports/rate-limit.port.js';
import { type UnitOfWorkPort } from '@/application/platform/ports/unit-of-work.port.js';
import { maskIpAddress } from '@/domain/identity/mask-ip-address.util.js';
import { SECURITY_EVENTS } from '@/domain/identity/security-event.constant.js';
import { isWeakPassword } from '@/domain/identity/weak-password.util.js';
import {
  PasswordResetTokenInvalidError,
  RateLimitedError,
  ValidationError,
} from '@/domain/shared/errors/app.errors.js';

export interface ConfirmPasswordResetInput {
  /** The value from the link, as the client lifted it out of the SPA route into the request body. */
  readonly token: string;
  readonly newPassword: string;
  readonly client: SessionClient;
}

/**
 * Setting a new password with a token from the reset mail.
 *
 * ## The token is spent by the database, not by a check
 *
 * `PasswordResetTokenRepositoryPort.consume` is one conditional `UPDATE … WHERE used_at IS NULL AND
 * expires_at > $now RETURNING user_id`. Two clicks on the same link therefore race, and one of them
 * updates no row — while a read-then-write would let both pass under READ COMMITTED and set the
 * password twice, the second time to whatever the slower request carried. Expiry lives in the same
 * predicate so that "spent" and "expired" are one outcome in the code as well as in the answer:
 * there is no branch left where a caller could be told which of the two it was.
 *
 * Unknown is the third member of that set and is reached earlier — the resolver simply finds no row
 * — and it is answered with the same error. Telling the three apart would let a holder of a guessed
 * token learn whether it ever existed, and would let "already used" confirm that somebody completed
 * a reset.
 *
 * ## The order, and what each position buys
 *
 * 1. **The password policy first.** It is decidable from the request alone, and deciding it before
 *    the token is spent is what lets a rejected form be corrected instead of restarted — the
 *    contract promises exactly that (`docs/api/openapi.yaml`: "leaves the token usable until it
 *    expires").
 * 2. **The ambient budget next.** This half of the flow has no account to name until the credential
 *    in the body has been believed, so it is counted on the per-address `api_request` budget rather
 *    than on `auth_attempt`, whose subject is the pair of address and *email* — and keying it on
 *    anything derived from the token would give every guess a fresh budget, which is not a limit.
 * 3. **Nothing is hashed until a row has actually been spent.** This is the position that carries
 *    the operation, and it used to be the other way round.
 *
 * ## Why the digest is computed inside the transaction, after the spend
 *
 * The earlier arrangement hashed first and spent afterwards, on the reasoning that Argon2id is on
 * the order of a hundred milliseconds and a transaction held open across it holds row locks across
 * it. The reasoning was sound and the conclusion was wrong, because **a hash does not spend a
 * token**: a replayed link resolved a row, allocated 19 MiB, and only then learned that the row had
 * already been used. One token bought an unlimited number of Argon2id computations, at 300 a minute
 * per address — roughly nine hundred times the allowance `rules/security.mdc` rule 11 gives the
 * login path, which is the same primitive with a limiter in front of it
 * (`docs/security/threat-model.md`, T-IAM-08).
 *
 * Spending first removes the primitive rather than narrowing it. A row can be spent once, so the
 * number of digests an address can force is the number of tokens `POST /auth/forgot-password` issued
 * to it — and *that* operation is counted on `auth_attempt`, five per fifteen minutes on the pair of
 * address and email, which is where rule 11's number belongs and where the subject to key it on
 * exists. A stricter budget on this half would have reduced the amplification without removing it,
 * and, with no email to pair it with, would have been keyed on the address alone: five recoveries
 * per fifteen minutes for everybody behind one office NAT, which is the exact failure
 * `rate-limit.port.ts` explains the pair was chosen to avoid.
 *
 * **The cost this pays is the lock.** The spend, the digest and the writes are one transaction, so
 * the row lock on the reset token — and a connection — is held for the length of an Argon2id. That
 * is bounded by the same number as above: only a token that was live and is now spent reaches the
 * hash, so the concurrency is bounded by the live tokens of the installation, not by request rate.
 *
 * **And it is what makes "spent but not written" unreachable.** Spending in one transaction and
 * writing the password in another would trade the amplification for a worse failure: a process that
 * dies in between leaves a token that can never be used again on an account whose password never
 * changed — recovery permanently broken for that person until they notice and ask again. In one
 * transaction there is no such state: the `UPDATE` that spends the token and the `UPDATE` that
 * writes the digest commit together or roll back together. A crash mid-hash rolls the spend back and
 * the link still works; a crash *after* the commit is a completed reset whose 204 was lost, and that
 * one is not recoverable today — the retry answers `400`, because `Idempotency-Key` is required and
 * validated but there is no keyed response store behind it yet. The password was changed, so the way
 * out is signing in with it; requiring the header now is what lets replay land later without a
 * contract change.
 *
 * ## Every session goes
 *
 * Not every *other* one. Somebody recovering access is usually doing so because access is in
 * somebody else's hands as well, and the device asking is no more trusted than the rest. Nothing is
 * issued in return either: a session minted straight from an emailed token would be a session minted
 * from something that sat in a mailbox. The client sends the person to `/login`.
 *
 * **And every other link goes with them**, in the same transaction. Sessions were the only thing
 * being closed, which left the more direct credential open: somebody with a few minutes of access
 * to a mailbox asks for a reset and keeps the link; the owner notices and resets or changes the
 * password; every session closes — and the link in the other person's hands is still good for the
 * rest of its hour, long enough to set a third password and close the sessions the owner has just
 * opened. Two honest resets started minutes apart are the same shape without the attacker.
 */
export class ConfirmPasswordResetUseCase {
  constructor(
    private readonly authLookup: AuthLookupPort,
    private readonly tokens: PasswordResetTokenRepositoryPort,
    private readonly resetTokens: ResetTokenPort,
    private readonly users: UserRepositoryPort,
    private readonly sessions: SessionRepositoryPort,
    private readonly hasher: PasswordHasherPort,
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly rateLimit: RateLimitPort,
    private readonly clock: ClockPort,
    private readonly logger: LoggerPort,
  ) {}

  async execute(input: ConfirmPasswordResetInput): Promise<void> {
    const ipMasked = maskIpAddress(input.client.ipAddress);

    if (isWeakPassword(input.newPassword)) {
      throw new ValidationError([
        {
          path: 'newPassword',
          code: 'invalid_value',
          message: 'the new password does not satisfy the password policy',
        },
      ]);
    }

    const decision = await this.rateLimit.consume('api_request', {
      userId: undefined,
      ipAddress: input.client.ipAddress,
    });

    if (!decision.allowed) throw new RateLimitedError(decision.retryAfterSeconds);

    const record = await this.authLookup.findPasswordResetToken(this.resetTokens.hash(input.token));

    if (record === null) {
      this.refuse(ipMasked);

      throw new PasswordResetTokenInvalidError();
    }

    const now = this.clock.now();
    const done = await this.unitOfWork.withTenant(
      { organizationId: record.organizationId, userId: record.userId },
      () => this.spend(record, input, now, ipMasked),
    );

    if (done === null) {
      this.refuse(ipMasked);

      throw new PasswordResetTokenInvalidError();
    }

    this.logger.info(
      {
        event: SECURITY_EVENTS.passwordResetCompleted,
        organizationId: record.organizationId,
        userId: record.userId,
        revokedFamilies: done.revokedFamilies,
        revokedResetTokens: done.revokedResetTokens,
        ipMasked,
      },
      'password reset completed and every session revoked',
    );
  }

  /**
   * Everything that has to be atomic, inside the scope that opens the tenant.
   *
   * `null` means "refused" and is answered by the one error this operation publishes. It covers two
   * cases that are deliberately not told apart: a token that could not be spent, and a token that
   * was spent for an account which may no longer sign in.
   *
   * **The suspended account keeps the spend.** The row is gone by the time the refusal is written,
   * which is the direction that fails safe: a link minted while the account was active must not
   * become usable again the day the account is reactivated. There is no separate `account_suspended`
   * here for the reason there is no separate "already used" — an answer that distinguished them
   * would tell whoever is holding the link that the link itself was genuine.
   */
  private async spend(
    record: AuthPasswordResetRecord,
    input: ConfirmPasswordResetInput,
    now: Date,
    ipMasked: string,
  ): Promise<{ readonly revokedFamilies: number; readonly revokedResetTokens: number } | null> {
    // The one statement that decides everything. Everything after it is unreachable for a token
    // that was already spent or has expired, which is what makes the outcome atomic rather than
    // agreed on between a read and a write — and what keeps the Argon2id below out of reach of a
    // replayed link.
    const spentFor = await this.tokens.consume(record.tokenId, now);

    if (spentFor === null) return null;

    // A token outlives a suspension: it is good for an hour, and an hour is long enough for an
    // account to be closed in the middle of it. `RequestPasswordResetUseCase` already refuses to
    // mint one for an account that may not sign in, and this is the same rule at the other end.
    // `findById` reads `deleted_at IS NULL`, so a soft-deleted account arrives here as `null`.
    const account = await this.users.findById(spentFor);

    if (account === null || account.status !== 'ACTIVE') return null;

    const passwordHash = await this.hasher.hash(input.newPassword);

    if (!(await this.users.updatePasswordHash(spentFor, passwordHash))) {
      // The row was there a moment ago, in this transaction, and the write matched nothing: it was
      // soft-deleted in between. Throwing rather than returning `null` is what makes it a rollback —
      // the spend goes back, so the link is not consumed by a reset that did not happen — and the
      // `error` line is the only place this becomes visible, because the caller is answered with the
      // same refusal as everything else and a 400 in an access log looks like an expired link.
      this.logger.error(
        {
          event: SECURITY_EVENTS.passwordNotWritten,
          organizationId: record.organizationId,
          userId: record.userId,
          ipMasked,
        },
        'password reset matched no account row; nothing was written and the transaction was rolled back',
      );

      throw new PasswordResetTokenInvalidError();
    }

    // Beside the sessions, and for the same reason: a link is a credential that mints a password,
    // so leaving one alive would leave the account open through a door the revocations do not cover.
    const revokedResetTokens = await this.tokens.invalidateOutstanding(spentFor, now);
    const revokedFamilies = await this.sessions.revokeAllFamilies(
      spentFor,
      'PASSWORD_CHANGED',
      now,
    );

    return { revokedFamilies, revokedResetTokens };
  }

  /**
   * One line for all three refusals, and **no field that separates them**.
   *
   * An `outcome` here would be the same disclosure the single error code exists to prevent, moved
   * into the log — where it is read by more people, exported to an aggregator, and rendered on a
   * dashboard somebody can be standing next to. The token is not written either, masked or
   * otherwise: a masked prefix of a 256-bit value is still the part an attacker uses to confirm a
   * guess reached the server.
   */
  private refuse(ipMasked: string): void {
    this.logger.warn(
      { event: SECURITY_EVENTS.passwordResetRefused, ipMasked },
      'password reset token refused',
    );
  }
}
