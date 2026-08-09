import { type InvitationRepositoryPort } from '@/application/iam/ports/invitation-repository.port.js';
import { type UserRoleRepositoryPort } from '@/application/iam/ports/user-role-repository.port.js';
import { type AuthLookupPort } from '@/application/identity/ports/auth-lookup.port.js';
import { type PasswordHasherPort } from '@/application/identity/ports/password-hasher.port.js';
import { type ResetTokenPort } from '@/application/identity/ports/reset-token.port.js';
import {
  type IssuedSession,
  type IssueSessionUseCase,
  type SessionClient,
} from '@/application/identity/use-cases/issue-session.use-case.js';
import { type OrganizationRepositoryPort } from '@/application/organization/ports/organization-repository.port.js';
import { type AuditLoggerPort } from '@/application/platform/ports/audit-logger.port.js';
import { type ClockPort } from '@/application/platform/ports/clock.port.js';
import { type LoggerPort } from '@/application/platform/ports/logger.port.js';
import { type RateLimitPort } from '@/application/platform/ports/rate-limit.port.js';
import { type UnitOfWorkPort } from '@/application/platform/ports/unit-of-work.port.js';
import { maskIpAddress } from '@/domain/identity/mask-ip-address.util.js';
import { SECURITY_EVENTS } from '@/domain/identity/security-event.constant.js';
import { InvitationNotValidError, RateLimitedError } from '@/domain/shared/errors/app.errors.js';

export interface AcceptInvitationInput {
  /** The value from the link, as the client lifted it out of the SPA route into the request body. */
  readonly token: string;
  readonly password: string;
  readonly locale: string;
  readonly timezone: string;
  readonly client: SessionClient;
}

/**
 * What the person gets: an account, and the session that comes with it.
 *
 * The same shape registration and sign-in answer with, deliberately: the client stores an identity
 * after any of the three, and a fourth shape would be a fourth branch in the one place that must not
 * have branches.
 */
export interface AcceptedInvitationResult {
  readonly session: IssuedSession;
  readonly user: {
    readonly id: string;
    readonly email: string;
    readonly locale: string;
    readonly timezone: string;
  };
  readonly organization: { readonly id: string; readonly name: string; readonly slug: string };
}

/**
 * Accepting an invitation: the one operation that creates an account without a session.
 *
 * ## The order, and what each position buys
 *
 * 1. **The budget first.** The caller is anonymous and the token *is* the credential, so the address
 *    is the only subject a counter can have — and a limiter checked after an argon2id run over
 *    19 MiB is a memory-exhaustion vector rather than a defence (`T-IAM-08`). Keying it on anything
 *    derived from the token would hand every guess a fresh budget, which is not a limit.
 * 2. **The resolver next, and it is cheap.** One indexed read of a digest, before the tenant is
 *    known — the fifth `SECURITY DEFINER` path (`docs/security/rls-design.md`, «Особые пути»).
 *    Nothing is hashed for a token it does not find.
 * 3. **The hash after that, and outside the transaction.** Argon2id takes tens of milliseconds, and
 *    a transaction held open across it is a connection held open across it.
 * 4. **Everything else in one transaction:** the account, the role, the teams and the spend either
 *    all happened or none did. An account created without its role would be somebody signing in on
 *    Monday to an empty workspace, which is what this story exists to prevent.
 *
 * ## Why the account is written before the invitation is spent
 *
 * The opposite order reads better and cannot work: `ck_invitations_accepted_pair` requires
 * `accepted_at` and `accepted_user_id` to move together, and the composite foreign key on
 * `accepted_user_id` is checked when that statement ends — so the row it names has to exist first.
 * The cost is one account insert on a losing race, and it is not wasted work: the insert is inside
 * the transaction the failed spend rolls back.
 *
 * Two independent guards make the single use real:
 *
 *   * the conditional `UPDATE … WHERE accepted_at IS NULL AND expires_at > $now RETURNING …` — the
 *     loser of a race updates no row, and this raises;
 *   * `uq_users_org_email` — two requests that both read a still-open invitation both try to create
 *     the same account, and the partial unique index refuses the second.
 *
 * ## One answer for five states
 *
 * Unknown, revoked, already accepted, expired, and «the organization was deactivated» all end in
 * `410 invitation_not_valid`. Telling them apart would let a holder of a guessed token learn whether
 * it ever existed, and would let «already accepted» confirm that a particular colleague joined
 * (`T-IAM-03`).
 *
 * **Unknown, revoked and «organization deactivated» are decided by the resolver returning nothing**
 * — it joins `organizations ON deleted_at IS NULL` and matches on the digest, and it deliberately
 * carries no predicate on `accepted_at` or `expires_at` (returning those columns would make the
 * privileged read an oracle in its own right). **Already accepted and expired** are decided by the
 * conditional write matching no row, which is also what makes the spend single-use under
 * concurrency.
 */
export class AcceptInvitationUseCase {
  constructor(
    private readonly authLookup: AuthLookupPort,
    private readonly invitations: InvitationRepositoryPort,
    private readonly userRoles: UserRoleRepositoryPort,
    private readonly organizations: OrganizationRepositoryPort,
    private readonly issueSession: IssueSessionUseCase,
    private readonly hasher: PasswordHasherPort,
    private readonly resetTokens: ResetTokenPort,
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly rateLimit: RateLimitPort,
    private readonly clock: ClockPort,
    private readonly logger: LoggerPort,
    private readonly audit: AuditLoggerPort,
  ) {}

  async execute(input: AcceptInvitationInput): Promise<AcceptedInvitationResult> {
    const ipMasked = maskIpAddress(input.client.ipAddress);

    await this.spendBudget(input, ipMasked);

    const resolved = await this.authLookup.findInvitation(this.resetTokens.hash(input.token));

    if (resolved === null) {
      // Unknown, revoked, or an organization that has been deactivated — one answer, and nothing
      // expensive was spent finding out which.
      this.refuse(ipMasked, 'unresolved');
    }

    const passwordHash = await this.hasher.hash(input.password);

    // The two refusals raised **inside** the transaction — revoked between the resolver and the
    // read, and spent or expired by the conditional write — are logged here rather than at their
    // throw sites. Without this they were the only attempts that produced no line, which made
    // `invitationAccepted` a record of «everything except the races», exactly the cases the alert
    // «one address, four hundred refusals» exists for.
    const accepted = await this.unitOfWork
      .withTenant(
        // `userId: null` — there is no actor yet. The account this scope is about is created inside
        // it, which is also why the trail entry below is written without one.
        { organizationId: resolved.organizationId, userId: null },
        async () => this.settle({ ...input, passwordHash, invitationId: resolved.invitationId }),
      )
      .catch((error: unknown) => {
        if (error instanceof InvitationNotValidError) this.refuse(ipMasked, 'spent_or_revoked');

        throw error;
      });

    this.logger.info(
      { event: SECURITY_EVENTS.invitationAccepted, outcome: 'accepted', ipMasked },
      'invitation accepted',
    );

    return accepted;
  }

  /**
   * Everything the transaction does, in the order the constraints require.
   *
   * The invitation is read once for its address — a read, not a guard: what makes the acceptance
   * single-use is the conditional write two statements later, and reading first only decides which
   * address the account is created on.
   */
  private async settle(input: {
    readonly invitationId: string;
    readonly passwordHash: string;
    readonly locale: string;
    readonly timezone: string;
    readonly client: SessionClient;
  }): Promise<AcceptedInvitationResult> {
    const invitation = await this.invitations.byId(input.invitationId);

    // Revoked between the resolver and this read: the row is gone, and the answer is the same one.
    if (invitation === null || invitation.acceptedAt !== null) throw new InvitationNotValidError();

    const userId = await this.invitations.createAccount({
      // The address of the row, never one from the request: the body has no `email` field at all,
      // so an invitation cannot be redirected to an account of somebody's choosing.
      email: invitation.email,
      passwordHash: input.passwordHash,
      locale: input.locale,
      timezone: input.timezone,
    });

    const spent = await this.invitations.accept(input.invitationId, userId, this.clock.now());

    // Accepted by somebody else in the meantime, or expired between the resolver and now. Raising
    // here rolls the account back with it — which is the whole reason both writes are in one scope.
    if (spent === null) throw new InvitationNotValidError();

    if (spent.roleId !== null) {
      await this.userRoles.assign({
        userId,
        roleId: spent.roleId,
        // Nobody granted it just now: the grant was decided when the invitation was created, and
        // the person who decided it may since have left. The trail of *that* decision is
        // `invitation.created`.
        grantedById: null,
        expiresAt: null,
      });
    }

    const joinedTeamIds = await this.invitations.joinTeams(userId, spent.teamIds);

    const session = await this.issueSession.execute({
      userId,
      // A new account starts at 1, and the session says so rather than reading it back: the row was
      // written by the statement above with the column's default.
      permissionsVersion: 1,
      client: input.client,
    });

    const organization = await this.organizations.findCurrent();

    if (organization === null) {
      throw new Error(
        'accept-invitation: the tenant scope names an organization that does not exist',
      );
    }

    await this.audit.record({
      action: 'invitation.accepted',
      actor: { userId, organizationId: organization.id, ipAddress: undefined },
      target: { type: 'INVITATION', id: input.invitationId },
      // The address, the role and the teams actually joined — never the token. `joinedTeamIds` can
      // be a shorter list than the invitation drafted, because a team deleted in the meantime is
      // skipped, and the trail says what happened rather than what was asked for. Carrying the ids
      // rather than a count closes the gap the STORY-012-07 gate found in `team.deleted`'s
      // equivalent: `team.member_added` is never filed for a membership created this way, so this
      // entry is the only place any of these ids is ever recorded against this account.
      after: { email: spent.email, roleId: spent.roleId, teamIds: joinedTeamIds },
      requestId: undefined,
    });

    return {
      session,
      user: {
        id: userId,
        email: invitation.email,
        locale: input.locale,
        timezone: input.timezone,
      },
      organization: {
        id: organization.id,
        name: organization.name,
        slug: organization.slug,
      },
    };
  }

  private async spendBudget(input: AcceptInvitationInput, ipMasked: string): Promise<void> {
    const decision = await this.rateLimit.consume('invitation_accept', {
      ipAddress: input.client.ipAddress,
    });

    if (decision.allowed) return;

    this.logger.warn(
      { event: SECURITY_EVENTS.invitationAccepted, outcome: 'rate_limited', ipMasked },
      'invitation acceptance refused by the rate limiter',
    );

    throw new RateLimitedError(decision.retryAfterSeconds);
  }

  /** One refusal, one line, and a return type that lets the caller narrow past it. */
  private refuse(ipMasked: string, outcome: string): never {
    this.logger.warn(
      { event: SECURITY_EVENTS.invitationAccepted, outcome, ipMasked },
      'invitation link presented and refused',
    );

    throw new InvitationNotValidError();
  }
}
