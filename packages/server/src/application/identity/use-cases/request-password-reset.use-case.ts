import { type AddressHasherPort } from '@/application/identity/ports/address-hasher.port.js';
import {
  type AuthLookupPort,
  type AuthUserRecord,
} from '@/application/identity/ports/auth-lookup.port.js';
import { type PasswordResetTokenRepositoryPort } from '@/application/identity/ports/password-reset-token.port.js';
import { type ResetTokenPort } from '@/application/identity/ports/reset-token.port.js';
import { type SessionClient } from '@/application/identity/use-cases/issue-session.use-case.js';
import { type ClockPort } from '@/application/platform/ports/clock.port.js';
import { type LoggerPort } from '@/application/platform/ports/logger.port.js';
import { type MailDispatchPort } from '@/application/platform/ports/mail-dispatch.port.js';
import { type MailPort, type OutgoingMail } from '@/application/platform/ports/mail.port.js';
import { type RateLimitPort } from '@/application/platform/ports/rate-limit.port.js';
import { type UnitOfWorkPort } from '@/application/platform/ports/unit-of-work.port.js';
import { maskIpAddress } from '@/domain/identity/mask-ip-address.util.js';
import { renderPasswordResetMail } from '@/domain/identity/password-reset-mail.util.js';
import { SECURITY_EVENTS } from '@/domain/identity/security-event.constant.js';
import { MailNotConfiguredError, RateLimitedError } from '@/domain/shared/errors/app.errors.js';

/** Sixty minutes, as the contract publishes and `data-model.md` §1 records. */
export const PASSWORD_RESET_TTL_MINUTES = 30;

export interface RequestPasswordResetInput {
  /** Already trimmed and lower-cased by the request validator (`emailSchema`). */
  readonly email: string;
  readonly client: SessionClient;
}

/**
 * Asking for a reset link — an operation designed so that its answer carries no information.
 *
 * ## The constant answer is the feature
 *
 * A registered address and one nobody has get the same status, the same empty body and the same
 * *wording* on the client: "if this address is registered, a message has been sent". A 404 for the
 * unknown one, or a slower answer for the known one, would turn account recovery into a directory of
 * everyone with an account on the installation — which is exactly the list that turns a breach
 * somewhere else into a breach here.
 *
 * Three things are arranged around that, and each of them is an ordering rather than a value:
 *
 * 1. **`mail_not_configured` is decided first, from configuration alone.** It is the one answer here
 *    that is not constant by construction, so it is raised *before* any address is resolved: an
 *    installation without `SMTP_URL` refuses every request, and one with it answers every request
 *    with 202. Raised after the lookup, the 503 would mean "this address exists, the mail just did
 *    not leave" — the enumeration oracle, reintroduced through the error path. The contract states
 *    this in the operation's own description because it is the sentence an implementer needs.
 * 2. **The budget is spent before the lookup**, so the counter is not itself an oracle for how much
 *    work an address caused, and so an address list cannot be walked cheaply.
 * 3. **The mail is handed to `MailDispatchPort`, never awaited.** The branch with an account would
 *    otherwise additionally wait for a connection to a relay, and the difference between the two
 *    branches would be measurable from the outside — a timing oracle instead of a status one. What
 *    remains is one indexed insert, and it happens after the limiter has already made repetition
 *    expensive.
 *
 * ## One message per account, and no `organizationSlug` in the request
 *
 * On a self-hosted installation one address legitimately holds accounts in several organizations.
 * Asking the caller which one they meant would require them to know; answering "wrong organization"
 * would tell them where they do *not* have one. So every account gets its own token and its own
 * message, and each message names its organization so the two letters can be told apart by the only
 * person who receives them.
 *
 * An account that may not sign in gets nothing: a reset that ends at `account_suspended` is a
 * message that helps nobody, and the answer to the caller is unchanged either way.
 *
 * ## What is written down
 *
 * One line per request, for **both** branches — an event written only when an account was found
 * would move the oracle from the response into the log. It carries the masked source network and the
 * number of accounts; it carries no address, and it never carries the token.
 */
export class RequestPasswordResetUseCase {
  constructor(
    private readonly authLookup: AuthLookupPort,
    private readonly tokens: PasswordResetTokenRepositoryPort,
    private readonly resetTokens: ResetTokenPort,
    private readonly addresses: AddressHasherPort,
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly rateLimit: RateLimitPort,
    private readonly mail: MailPort,
    private readonly dispatcher: MailDispatchPort,
    private readonly clock: ClockPort,
    private readonly logger: LoggerPort,
    private readonly appUrl: string,
  ) {}

  async execute(input: RequestPasswordResetInput): Promise<void> {
    // First, and from configuration only. Nothing has been looked up at this point and nothing
    // needs to be: the answer is a property of the installation.
    if (!this.mail.isConfigured()) {
      throw new MailNotConfiguredError({ operation: 'requestPasswordReset' });
    }

    const ipMasked = maskIpAddress(input.client.ipAddress);
    const decision = await this.rateLimit.consume('auth_attempt', {
      ipAddress: input.client.ipAddress,
      email: input.email,
    });

    if (!decision.allowed) {
      // The refusal says nothing about the address either — a 429 that only fired for registered
      // addresses would answer the question the 202 refuses to.
      this.logger.warn(
        { event: SECURITY_EVENTS.passwordResetRequested, outcome: 'rate_limited', ipMasked },
        'password reset request refused by the rate limiter',
      );

      throw new RateLimitedError(decision.retryAfterSeconds);
    }

    const accounts = (await this.authLookup.findUsersByEmail(input.email)).filter(
      (account) => account.status === 'ACTIVE',
    );

    for (const account of accounts) await this.issueFor(account, input);

    // Written for zero accounts exactly as for three. The count is operational information and a
    // log is not a response body, so it may say what the answer may not.
    this.logger.info(
      {
        event: SECURITY_EVENTS.passwordResetRequested,
        accounts: accounts.length,
        ipMasked,
      },
      'password reset requested',
    );
  }

  /**
   * One token for one account: the row inside a transaction, the message after it.
   *
   * The message is built *before* the scope closes only in the sense that its ingredients are known;
   * `dispatch` is called after `withTenant` has returned, because SMTP is never touched inside a
   * transaction (`rules/outbox.mdc`, rule 2) — and `dispatch` itself returns before a socket opens.
   *
   * The settled rows of the same account are deleted in that transaction, immediately before the
   * insert. Nothing ever deleted from `password_reset_tokens`, and every row in it is the digest of
   * a credential that was mailed to somebody — a table that only grows, of credentials. There is no
   * scheduler to sweep it with (no `outbox_event`, no BullMQ worker), so the cleanup happens where a
   * write of that account is already being made: one indexed `DELETE` on the same
   * `(organization_id, user_id)` path as the `INSERT` beside it, which is what keeps it invisible in
   * the timing of a branch that already writes.
   *
   * It is hygiene and not the control. What makes a stale link harmless is that `consume` refuses it
   * on both halves of its predicate, and that the refusal is reached before anything expensive
   * happens (`confirm-password-reset.use-case.ts`).
   */
  private async issueFor(account: AuthUserRecord, input: RequestPasswordResetInput): Promise<void> {
    const now = this.clock.now();
    const minted = this.resetTokens.mint();
    const expiresAt = new Date(now.getTime() + PASSWORD_RESET_TTL_MINUTES * 60 * 1000);

    await this.unitOfWork.withTenant(
      { organizationId: account.organizationId, userId: account.userId },
      async () => {
        await this.tokens.deleteSettled(account.userId, now);

        return this.tokens.create({
          userId: account.userId,
          tokenHash: minted.hash,
          expiresAt,
          // The same keyed digest a session row carries. The address itself is stored nowhere, and
          // `null` is a legitimate value: a request over a unix socket has no peer address.
          requestedIpHash:
            input.client.ipAddress === undefined
              ? null
              : this.addresses.hash(input.client.ipAddress),
        });
      },
    );

    const mail: OutgoingMail = {
      to: account.email,
      ...renderPasswordResetMail({
        locale: account.locale,
        appUrl: this.appUrl,
        token: minted.token,
        lifetimeMinutes: PASSWORD_RESET_TTL_MINUTES,
        organizationName: account.organizationName,
      }),
    };

    this.dispatcher.dispatch(mail, {
      event: SECURITY_EVENTS.passwordResetRequested,
      organizationId: account.organizationId,
      userId: account.userId,
    });
  }
}
