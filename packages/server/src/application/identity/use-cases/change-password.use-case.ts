import { type AuditLoggerPort } from '@/application/platform/ports/audit-logger.port.js';
import { type PasswordHasherPort } from '@/application/identity/ports/password-hasher.port.js';
import { type PasswordResetTokenRepositoryPort } from '@/application/identity/ports/password-reset-token.port.js';
import { type SessionRepositoryPort } from '@/application/identity/ports/session-repository.port.js';
import {
  type UserCredentialRecord,
  type UserRepositoryPort,
} from '@/application/identity/ports/user-repository.port.js';
import { type SessionClient } from '@/application/identity/use-cases/issue-session.use-case.js';
import { type ClockPort } from '@/application/platform/ports/clock.port.js';
import { type LoggerPort } from '@/application/platform/ports/logger.port.js';
import { type MailDispatchPort } from '@/application/platform/ports/mail-dispatch.port.js';
import {
  type IpEmailSubject,
  type RateLimitPort,
} from '@/application/platform/ports/rate-limit.port.js';
import { type UnitOfWorkPort } from '@/application/platform/ports/unit-of-work.port.js';
import { maskIpAddress } from '@/domain/identity/mask-ip-address.util.js';
import { renderPasswordChangedMail } from '@/domain/identity/password-changed-mail.util.js';
import { SECURITY_EVENTS } from '@/domain/identity/security-event.constant.js';
import { isWeakPassword } from '@/domain/identity/weak-password.util.js';
import {
  RateLimitedError,
  UnauthenticatedError,
  ValidationError,
} from '@/domain/shared/errors/app.errors.js';

export interface ChangePasswordInput {
  readonly actor: { readonly organizationId: string; readonly userId: string };
  /**
   * The family of the session the request was made from — the one that survives.
   *
   * A *family* and not a session id, for the reason `EndSessionUseCase` gives: a rotation writes a
   * new row every fifteen minutes, so the row is not the device and only the family is.
   */
  readonly currentFamilyId: string;
  readonly currentPassword: string;
  readonly newPassword: string;
  readonly client: SessionClient;
}

/** Why a change was refused — a closed set, because it is the field an alert selects on. */
type ChangeRefusal = 'invalid_credentials' | 'rate_limited';

/**
 * Changing one's own password, and closing every other session in the same breath.
 *
 * ## The point of the operation is the revocation
 *
 * A password change that left the other sessions alive would be an update to a column. The reason
 * somebody changes a password is that they think somebody else has it, and a refresh token issued
 * before the change keeps working for thirty days — so the credential is only actually rotated when
 * the sessions minted with the old one are gone. That is why the two are one transaction: a commit
 * that wrote the digest and failed to revoke would report success on an account that is still open
 * to whoever had the old password.
 *
 * **The caller's own family is the exception, and it is named rather than inferred.** "Keep one
 * session" and "keep *this* session" are the same sentence until the argument is wrong, and then
 * they are the difference between the owner staying signed in and the owner being signed out while
 * an intruder's session survives. `currentFamilyId` comes from the access token the guard already
 * verified, so it cannot be chosen by the request.
 *
 * The `sid` denylist of `rules/security.mdc` rule 9 needs no separate write: revoking the rows *is*
 * the denylist, because `AuthenticateSessionQuery` reads `revoked_at` on every request. The Redis
 * copy remains the optimisation that file describes, and it would change no outcome here.
 *
 * **Outstanding reset links are revoked with them, and for the same reason.** Sessions were the only
 * credential being closed, which left the stronger one open: a reset link mints a *new* password,
 * and it lives for an hour. Somebody with a few minutes of access to a mailbox asks for a reset and
 * keeps the link; the owner notices, changes their password and closes every other session — and the
 * link still works, long enough to set a third password and close the sessions the owner has just
 * opened. So they go in the same transaction as the digest (`commit` below).
 *
 * ## The order of the checks, and why each one is where it is
 *
 * 1. **Both 422s first.** "The new password equals the current one" and "the new password fails the
 *    policy" are decidable from the request body alone. Deciding them before the limiter means a
 *    person fixing a form does not spend the budget that exists to slow down guessing, and deciding
 *    them before the digest is read means they cost nothing.
 * 2. **The attempt budget before the Argon2id verification.** A verification allocates 19 MiB, so a
 *    limiter consulted afterwards is a memory-exhaustion vector rather than a defence
 *    (`docs/security/threat-model.md`, T-IAM-08). The credential read that precedes it is a
 *    primary-key lookup, and it has to precede it: the counter is keyed on the pair of address and
 *    account, which is what puts a wrong `currentPassword` in the *same* budget as a wrong login
 *    instead of opening a second, uncounted way to guess a password.
 * 3. **A wrong current password is `401 invalid_credentials`**, the code a refused sign-in carries,
 *    because it is the same fact. Dressing it as a validation issue would move those attempts out
 *    of the counter that limits them (`docs/api/openapi.yaml`, `changePassword`).
 *
 * ## The notification is best-effort, and that is a decision rather than an omission
 *
 * There is **no `mail_not_configured` here**, and there deliberately is one on
 * `POST /auth/forgot-password`. The difference is what the operation *is*: asking for a reset link is
 * the sending of a message, so without a transport it cannot work at all; changing a password is the
 * change of a password, and the letter is a notice about it.
 *
 * Refusing the change when the notice cannot be delivered would invert two priorities at once. A
 * password change is a **recovery action** — the most common reason to perform one is the suspicion
 * that the old password is in somebody else's hands — so blocking the remedy because a courtesy
 * cannot be delivered is backwards. And `SMTP_URL` is optional by documentation in the `minimal`
 * profile (`docs/runbooks/install.md`), so a basic security operation would be unavailable in a
 * supported configuration, which is a defect and not a safeguard.
 *
 * The notice is still worth sending — it is how somebody who did *not* change their password finds
 * out that somebody else did — but it is not the only signal: the change closes every other session,
 * which is loud on its own.
 *
 * So the message is handed to `MailDispatchPort` after the commit and its fate is the transport's:
 * no external call inside a transaction (`rules/outbox.mdc`, rule 2), and a relay having a bad day
 * cannot turn a completed password change into anything at all. An installation with no transport
 * produces one `warn` naming `SMTP_URL` (`immediate-mail-dispatcher.adapter.ts`) and a changed
 * password.
 *
 * **The answer says nothing about the notification**, and could not honestly: `dispatch` returns
 * before a socket is opened, so at the moment the 204 is written this process does not yet know
 * whether anything was delivered. Reporting it would mean awaiting the relay — reintroducing exactly
 * the coupling this design removes — to hand the caller a fact only an operator can act on.
 */
export class ChangePasswordUseCase {
  constructor(
    private readonly users: UserRepositoryPort,
    private readonly sessions: SessionRepositoryPort,
    private readonly tokens: PasswordResetTokenRepositoryPort,
    private readonly hasher: PasswordHasherPort,
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly rateLimit: RateLimitPort,
    private readonly dispatcher: MailDispatchPort,
    private readonly clock: ClockPort,
    private readonly logger: LoggerPort,
    private readonly audit: AuditLoggerPort,
    /** `APP_URL`. Required rather than defaulted: a link built on a guess points at nobody. */
    private readonly appUrl: string,
  ) {}

  async execute(input: ChangePasswordInput): Promise<void> {
    this.assertNewPasswordUsable(input);

    const ipMasked = maskIpAddress(input.client.ipAddress);
    const credential = await this.readCredential(input);

    if (credential === null) {
      // A live session whose account row is gone or soft-deleted. The honest answer is the one the
      // guard would give on the next request anyway, and it is not "no such account".
      throw new UnauthenticatedError('invalid_credentials');
    }

    const subject: IpEmailSubject = {
      ipAddress: input.client.ipAddress,
      email: credential.email,
    };

    const decision = await this.rateLimit.consume('auth_attempt', subject);

    if (!decision.allowed) {
      this.refuse('rate_limited', input, ipMasked);

      throw new RateLimitedError(decision.retryAfterSeconds);
    }

    if (!(await this.hasher.verify(credential.passwordHash, input.currentPassword))) {
      this.refuse('invalid_credentials', input, ipMasked);

      throw new UnauthenticatedError('invalid_credentials');
    }

    const passwordHash = await this.hasher.hash(input.newPassword);
    const committed = await this.commit(input, passwordHash, ipMasked);

    // Only a change that went through clears the counter. Clearing it earlier would let a wrong
    // current password reset its own limit, which is not a limit.
    await this.rateLimit.reset('auth_attempt', subject);

    this.logger.info(
      {
        event: SECURITY_EVENTS.passwordChanged,
        organizationId: input.actor.organizationId,
        userId: input.actor.userId,
        revokedFamilies: committed.revokedFamilies,
        revokedResetTokens: committed.revokedResetTokens,
        ipMasked,
      },
      'password changed and other sessions revoked',
    );

    this.notify(input, credential, committed.revokedFamilies);
  }

  /**
   * The two refusals a form can fix, both reported on `newPassword`.
   *
   * The same code for both, on purpose: from the person's point of view it is one problem, and a
   * distinct code for "that is your current password" would confirm a guess to somebody typing into
   * a form they should not have reached.
   */
  private assertNewPasswordUsable(input: ChangePasswordInput): void {
    if (input.newPassword !== input.currentPassword && !isWeakPassword(input.newPassword)) return;

    throw new ValidationError([
      {
        path: 'newPassword',
        code: 'invalid_value',
        message:
          'the new password must differ from the current one and satisfy the password policy',
      },
    ]);
  }

  private readCredential(input: ChangePasswordInput): Promise<UserCredentialRecord | null> {
    return this.unitOfWork.withTenant(input.actor, () =>
      this.users.findCredential(input.actor.userId),
    );
  }

  /**
   * The digest, the outstanding reset links and the revocations, in one scope.
   *
   * The count of families is what comes back for the mail, because that is what the mail calls
   * devices — the number of rows would be the number of rotations since each device signed in, and
   * would read as "ninety-six other sessions were closed" for one forgotten laptop.
   *
   * **The reset links are here and not somewhere afterwards.** Closing every other session while
   * leaving a live reset link behind closes nothing: the link mints a new password, which is a
   * better credential than any of the sessions that were just revoked. The scenario is somebody who
   * reached the mailbox for a few minutes, asked for a reset and kept the link — the owner changes
   * their password, and the link is still good for the rest of its hour.
   *
   * A write that matched **no row** is the one outcome this method refuses to paper over.
   * `updatePasswordHash` is an `updateMany`, so an account soft-deleted between `findCredential`
   * and this statement leaves it matching nothing and saying nothing about it — and the operation
   * used to go on to revoke sessions, mail a notice and answer 204 over a password that had not
   * moved. Raising here rolls the whole scope back and is answered with the same
   * `401 invalid_credentials` that the missing-credential branch above gives for the same fact
   * found a moment earlier, so the contract is unchanged.
   */
  private commit(
    input: ChangePasswordInput,
    passwordHash: string,
    ipMasked: string,
  ): Promise<{ readonly revokedFamilies: number; readonly revokedResetTokens: number }> {
    const now = this.clock.now();

    return this.unitOfWork.withTenant(input.actor, async () => {
      if (!(await this.users.updatePasswordHash(input.actor.userId, passwordHash))) {
        this.logger.error(
          {
            event: SECURITY_EVENTS.passwordNotWritten,
            organizationId: input.actor.organizationId,
            userId: input.actor.userId,
            ipMasked,
          },
          'password change matched no account row; nothing was written and the transaction was rolled back',
        );

        throw new UnauthenticatedError('invalid_credentials');
      }

      const revokedResetTokens = await this.tokens.invalidateOutstanding(input.actor.userId, now);
      const revokedFamilies = await this.sessions.revokeOtherFamilies(
        input.actor.userId,
        input.currentFamilyId,
        'PASSWORD_CHANGED',
        now,
      );

      // Inside the transaction, like every privileged action: a password changed with no record of
      // it is exactly the event an incident review needs and cannot reconstruct. Nothing about the
      // password itself goes into the trail — `after` says how many sessions the change closed,
      // which is what a reader is trying to explain.
      await this.audit.record({
        action: 'password.changed',
        actor: {
          userId: input.actor.userId,
          organizationId: input.actor.organizationId,
          ipAddress: undefined,
        },
        target: { type: 'user', id: input.actor.userId },
        after: { revokedFamilies, revokedResetTokens },
        requestId: undefined,
      });

      return { revokedFamilies, revokedResetTokens };
    });
  }

  private notify(
    input: ChangePasswordInput,
    credential: UserCredentialRecord,
    revokedSessions: number,
  ): void {
    this.dispatcher.dispatch(
      {
        to: credential.email,
        ...renderPasswordChangedMail({
          locale: credential.locale,
          appUrl: this.appUrl,
          revokedSessions,
        }),
      },
      {
        event: SECURITY_EVENTS.passwordChanged,
        organizationId: input.actor.organizationId,
        userId: input.actor.userId,
      },
    );
  }

  /**
   * One line per refused change: the event as a field, the reason, the identifiers and the masked
   * source. No address of the account, and nothing derived from either password.
   */
  private refuse(outcome: ChangeRefusal, input: ChangePasswordInput, ipMasked: string): void {
    this.logger.warn(
      {
        event: SECURITY_EVENTS.passwordChangeFailed,
        outcome,
        organizationId: input.actor.organizationId,
        userId: input.actor.userId,
        ipMasked,
      },
      'password change refused',
    );
  }
}
