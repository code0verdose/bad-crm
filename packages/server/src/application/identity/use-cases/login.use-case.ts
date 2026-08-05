import { type AuditLoggerPort } from '@/application/platform/ports/audit-logger.port.js';
import {
  type AuthLookupPort,
  type AuthUserRecord,
} from '@/application/identity/ports/auth-lookup.port.js';
import { type PasswordHasherPort } from '@/application/identity/ports/password-hasher.port.js';
import { type UserRepositoryPort } from '@/application/identity/ports/user-repository.port.js';
import {
  type IssuedSession,
  type IssueSessionUseCase,
  type SessionClient,
} from '@/application/identity/use-cases/issue-session.use-case.js';
import { type LoggerPort } from '@/application/platform/ports/logger.port.js';
import {
  type IpEmailSubject,
  type RateLimitPort,
} from '@/application/platform/ports/rate-limit.port.js';
import { type UnitOfWorkPort } from '@/application/platform/ports/unit-of-work.port.js';
import { maskIpAddress } from '@/domain/identity/mask-ip-address.util.js';
import { SECURITY_EVENTS } from '@/domain/identity/security-event.constant.js';
import {
  AccountRefusedError,
  RateLimitedError,
  UnauthenticatedError,
} from '@/domain/shared/errors/app.errors.js';

export interface LoginInput {
  /** Already trimmed and lower-cased by the request validator (`emailSchema`). */
  readonly email: string;
  readonly password: string;
  /** Present on the repeat call that follows `organization_selection_required`. */
  readonly organizationSlug?: string;
  readonly client: SessionClient;
}

export interface SessionProfile {
  readonly id: string;
  readonly email: string;
  readonly locale: string;
  readonly timezone: string;
}

export interface SessionOrganization {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
}

export type LoginResult =
  | {
      readonly status: 'authenticated';
      readonly session: IssuedSession;
      readonly user: SessionProfile;
      readonly organization: SessionOrganization;
    }
  | {
      readonly status: 'organization_selection_required';
      readonly organizations: readonly SessionOrganization[];
    };

/**
 * Why a sign-in was refused — a closed set, because it is a log field an alert selects on.
 *
 * It exists only in the log. The *answer* is one refusal for all three, and the whole design of
 * `UnauthenticatedError` is that nothing a caller can observe separates them.
 */
type SignInRefusal = 'invalid_credentials' | 'account_suspended' | 'rate_limited';

const describeOrganization = (user: AuthUserRecord): SessionOrganization => ({
  id: user.organizationId,
  name: user.organizationName,
  slug: user.organizationSlug,
});

/**
 * Email and password in, a session out — and one refusal for everything that is not one.
 *
 * ## The refusal is the design
 *
 * An address nobody has and a wrong password produce the same status, the same code, the same
 * message and the same amount of work. The first three are a property of `UnauthenticatedError`,
 * whose message is a constant; the fourth is the reason for the `dummyHash` below.
 *
 * **Why the timing matters as much as the body.** argon2id at the configured cost takes on the order
 * of a hundred milliseconds. Returning early when there is no user makes that branch finish in
 * microseconds — a difference no human notices and a script measures on the first hundred requests.
 * The result is a directory of everyone with an account on the installation, which is exactly the
 * list that turns a breach somewhere else into a breach here. So when there is no candidate, the
 * password is verified against a digest nothing matches, and the answer is thrown afterwards.
 *
 * ## Why every candidate is verified
 *
 * `findUsersByEmail` may return more than one account: on a self-hosted installation one person
 * legitimately belongs to two organizations, and the two rows can hold different passwords. The loop
 * runs to the end rather than stopping at the first match — an early exit would make the elapsed
 * time depend on *which* of somebody's accounts the password belongs to.
 *
 * The list of organizations that comes back on `organization_selection_required` is built from the
 * candidates that **verified**, never from the candidates that were found. Building it from the
 * lookup would answer "where else does this address have an account" to somebody who guessed one
 * password out of two (`docs/api/openapi.yaml`, `OrganizationSelectionRequired`).
 *
 * ## The budget comes first
 *
 * `consume` runs before the lookup and therefore before any digest is computed. Order is the whole
 * of the rule: argon2id at the configured cost allocates 19 MiB per verification, so a limiter
 * consulted afterwards protects nothing and the endpoint is a memory-exhaustion vector against an
 * attacker who never guesses a single password (`docs/security/threat-model.md`, T-IAM-08).
 *
 * ## What is written down
 *
 * Every outcome, refusal included, produces one line naming the event and the **masked** source
 * address (`rules/observability.mdc`). Without it a refused sign-in appears only as the error
 * handler's generic `request rejected` — a code, a status, no subject and no source — and a
 * credential-stuffing run is indistinguishable from a day of mistyped passwords.
 *
 * The line carries no email, and it carries the reason for the refusal that the *answer*
 * deliberately does not: `outcome` separating a wrong password from a suspended account is
 * operational information, and it stays operational because a log is not a response body.
 */
export class LoginUseCase {
  constructor(
    private readonly authLookup: AuthLookupPort,
    private readonly hasher: PasswordHasherPort,
    private readonly users: UserRepositoryPort,
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly issueSession: IssueSessionUseCase,
    private readonly rateLimit: RateLimitPort,
    private readonly logger: LoggerPort,
    private readonly audit: AuditLoggerPort,
  ) {}

  async execute(input: LoginInput): Promise<LoginResult> {
    const subject: IpEmailSubject = { ipAddress: input.client.ipAddress, email: input.email };
    const ipMasked = maskIpAddress(input.client.ipAddress);

    // First, before the lookup and before any hashing. A store that cannot be reached raises
    // instead of answering, and the raise is not caught here: 503 is the stated behaviour, because
    // a limiter that admits everybody while Redis is down makes "take Redis down" the cheapest way
    // to switch the brute-force defence off (T-IAM-03).
    const decision = await this.rateLimit.consume('auth_attempt', subject);

    if (!decision.allowed) {
      // The budget running out is the *most* interesting refusal of the three: it is the shape a
      // campaign takes once the limiter starts working, and it is the one an alert should fire on.
      this.refuse('rate_limited', ipMasked);

      throw new RateLimitedError(decision.retryAfterSeconds);
    }

    const candidates = await this.candidates(input);
    const verified = await this.verifyAll(candidates, input.password);

    if (verified.length === 0) {
      this.refuse('invalid_credentials', ipMasked);

      throw new UnauthenticatedError('invalid_credentials');
    }

    // The status rule applies to every candidate, not only to the one that happens to be alone. A
    // selection list built before it was applied would offer an organization the account may not
    // open a session in — and would answer differently for the same account depending on how many
    // rows the lookup returned.
    const usable = verified.filter((candidate) => candidate.status === 'ACTIVE');

    if (usable.length === 0) {
      const refusal = this.refuseInactive(verified);

      this.refuse(
        refusal.code === 'account_suspended' ? 'account_suspended' : 'invalid_credentials',
        ipMasked,
      );

      throw refusal;
    }

    // Only a sign-in that is actually going somewhere clears the counter. Clearing it on any
    // verified digest would hand an unlimited argon2 budget to whoever knows the password of an
    // account that may not sign in anyway — a refusal that resets its own limit is not a limit.
    await this.rateLimit.reset('auth_attempt', subject);

    if (usable.length > 1) {
      // A verified password that stops at the picker is a successful authentication and is recorded
      // as one. Which organizations matched stays out of the line: naming them would put the answer
      // to "where else does this address have an account" into the log of a request that was never
      // told it.
      this.logger.info(
        {
          event: SECURITY_EVENTS.signInSucceeded,
          outcome: 'organization_selection_required',
          candidates: usable.length,
          ipMasked,
        },
        'credential verified, waiting for an organization to be chosen',
      );

      return {
        status: 'organization_selection_required',
        organizations: usable.map(describeOrganization),
      };
    }

    // Present by construction — `usable.length` is exactly one here — and read this way so the
    // narrowing is the compiler's rather than a non-null assertion nobody re-checks.
    const [user] = usable as [AuthUserRecord];

    const result = await this.openSession(user, input);

    // After the transaction committed, so the line describes a session that exists. The identifiers
    // are written explicitly rather than left to the ambient context: sign-in is a public route, so
    // the guard never ran and the context still says `userId: null` at this point — this line is
    // where the correlation between a request id and a person begins.
    this.logger.info(
      {
        event: SECURITY_EVENTS.signInSucceeded,
        outcome: 'session_opened',
        userId: user.userId,
        organizationId: user.organizationId,
        sessionId: result.session.sessionId,
        ipMasked,
      },
      'session opened',
    );

    return result;
  }

  /**
   * `SUSPENDED` gets its own code; anything else does not.
   *
   * Reachable only *after* a password verified — `verified` is the list of accounts whose digest
   * matched — because "this address exists and is suspended" is a second answer where the contract
   * promises one.
   *
   * `INVITED` is an account that exists and has no password anybody chose: the honest thing to say
   * is "accept your invitation", and that is not a sentence the sign-in form may hand to somebody
   * who has just typed a password into it. It is a refused credential, which is also true.
   */
  private refuseInactive(
    verified: readonly AuthUserRecord[],
  ): AccountRefusedError | UnauthenticatedError {
    return verified.some((candidate) => candidate.status === 'SUSPENDED')
      ? new AccountRefusedError('account_suspended')
      : new UnauthenticatedError('invalid_credentials');
  }

  /**
   * One line per refused sign-in: the event as a **field**, the reason, and the masked source.
   *
   * `warn` rather than `info`, because a run of these is the signal — a degradation the system
   * handled, which is what the level means (`rules/observability.mdc`, rule 7). The address is
   * masked to /24 or /48 before it is written: a full one is personal data and this product keeps
   * it nowhere, logs included. The email is not written at all, and neither is anything derived
   * from the password.
   */
  private refuse(outcome: SignInRefusal, ipMasked: string): void {
    this.logger.warn({ event: SECURITY_EVENTS.signInFailed, outcome, ipMasked }, 'sign-in refused');
  }

  private async candidates(input: LoginInput): Promise<readonly AuthUserRecord[]> {
    if (input.organizationSlug === undefined) {
      return this.authLookup.findUsersByEmail(input.email);
    }

    const user = await this.authLookup.findUserByEmailAndSlug(input.email, input.organizationSlug);

    // A slug that does not exist, and a slug this address has no account in, are the same empty
    // list — and therefore the same refusal, after the same dummy verification.
    return user === null ? [] : [user];
  }

  private async verifyAll(
    candidates: readonly AuthUserRecord[],
    password: string,
  ): Promise<AuthUserRecord[]> {
    if (candidates.length === 0) {
      await this.hasher.verify(this.hasher.dummyHash, password);

      return [];
    }

    const verified: AuthUserRecord[] = [];

    for (const candidate of candidates) {
      // Sequential and without an early exit: `Promise.all` would run the verifications in parallel
      // and make the elapsed time of two candidates indistinguishable from one, and `break` would
      // make it depend on their order.
      if (await this.hasher.verify(candidate.passwordHash, password)) verified.push(candidate);
    }

    return verified;
  }

  private async openSession(
    user: AuthUserRecord,
    input: LoginInput,
  ): Promise<Extract<LoginResult, { status: 'authenticated' }>> {
    const session = await this.unitOfWork.withTenant(
      { organizationId: user.organizationId, userId: user.userId },
      async () => {
        // The transparent re-hash of the epic acceptance, in the one moment the plaintext exists and
        // the person has already proved they know it. In the same transaction as the session, so a
        // failure leaves neither rather than a new digest and no sign-in.
        if (this.hasher.needsRehash(user.passwordHash)) {
          await this.users.updatePasswordHash(user.userId, await this.hasher.hash(input.password));
        }

        const issued = await this.issueSession.execute({
          userId: user.userId,
          permissionsVersion: user.permissionsVersion,
          client: input.client,
        });

        // Inside the transaction on purpose: an action nobody could write down did not happen. A
        // rejected audit write rolls the session back rather than leaving a sign-in with no record
        // of it — which is the difference between a trail and a best effort.
        await this.audit.record({
          action: 'session.signed_in',
          actor: {
            userId: user.userId,
            organizationId: user.organizationId,
            ipAddress: input.client.ipAddress,
          },
          target: { type: 'SESSION', id: issued.sessionId },
          requestId: undefined,
        });

        return issued;
      },
    );

    return {
      status: 'authenticated',
      session,
      user: {
        id: user.userId,
        email: user.email,
        locale: user.locale,
        timezone: user.timezone,
      },
      organization: describeOrganization(user),
    };
  }
}
