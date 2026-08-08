import { type InvitationRepositoryPort } from '@/application/iam/ports/invitation-repository.port.js';
import { type OrganizationRepositoryPort } from '@/application/organization/ports/organization-repository.port.js';
import { type AuditLoggerPort } from '@/application/platform/ports/audit-logger.port.js';
import { type ClockPort } from '@/application/platform/ports/clock.port.js';
import { type MailDispatchPort } from '@/application/platform/ports/mail-dispatch.port.js';
import { type MailPort } from '@/application/platform/ports/mail.port.js';
import { type RateLimitPort } from '@/application/platform/ports/rate-limit.port.js';
import { type UnitOfWorkPort } from '@/application/platform/ports/unit-of-work.port.js';
import { type ResetTokenPort } from '@/application/identity/ports/reset-token.port.js';
import { type Actor } from '@/domain/access/actor.types.js';
import { assertAllowed } from '@/domain/access/decision.util.js';
import {
  canInvite,
  canResendInvitation,
  canRevokeInvitation,
} from '@/domain/iam/access/invitation-access.policy.js';
import { invitationLinkOf, renderInvitationMail } from '@/domain/iam/invitation-mail.util.js';
import { type MailLocale } from '@/domain/identity/mail-locale.util.js';
import { SECURITY_EVENTS } from '@/domain/identity/security-event.constant.js';
import { ConflictError, RateLimitedError } from '@/domain/shared/errors/app.errors.js';
import { denyAccess } from '@/domain/shared/errors/access-denial.util.js';

/** How long an invitation stays open. Seven days: long enough for a holiday, short enough to expire. */
const LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

export interface CreateInvitationInput {
  readonly actor: Actor;
  readonly email: string;
  readonly roleId: string | null;
  readonly teamIds: readonly string[];
  /** The language of the letter; the client sends the one the inviter is reading. */
  readonly locale: MailLocale;
}

/**
 * The link, handed back **once**: the server keeps only the digest and cannot show it again.
 *
 * `mailDispatched` is `false` on an installation with no `SMTP_URL`, and that is not an error
 * (NFR-9): the invitation exists, the link is in this response, and the person who created it can
 * pass it on themselves. It says the message was **handed to the transport**, not that it arrived —
 * nothing in this process ever learns that, because the dispatcher returns before a socket opens.
 */
export interface MintedInvitation {
  readonly invitationId: string;
  readonly email: string;
  readonly inviteUrl: string;
  readonly expiresAt: Date;
  readonly mailDispatched: boolean;
}

/**
 * Inviting somebody — a role assignment written in advance.
 *
 * Three refusals before anything is written, and the order is the order of the questions:
 *
 * - **the role has to exist here.** A role id from another organization is answered 404, like every
 *   other object of somebody else's tenant;
 * - **the subset rule** (`T-IAM-09`): the invitation may only carry what the inviter effectively
 *   holds, because the account it produces would otherwise outrank its author;
 * - **the address has to be free**: an active account is `user_already_exists` and a second open
 *   invitation is `invitation_already_exists`, raised by the partial unique index — two different
 *   situations with two different things to do about them.
 *
 * The budget is spent **first**, before the transaction and before the address is looked at. Every
 * invitation is a letter our relay sends to an address the caller chose, so the operation is a mail
 * cannon if it is not bounded; and the refusals above are answers about an address, which makes an
 * unbounded endpoint a way to walk a list of addresses and learn who already has an account
 * (`T-IAM-10`). Twenty in ten minutes, counted against the inviter.
 *
 * The token is returned exactly once, in the response. What is stored is the digest, for the same
 * reason a session stores one: a dump, a backup or a curious operator must not yield a working
 * invitation.
 */
export class CreateInvitationUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly invitations: InvitationRepositoryPort,
    private readonly organizations: OrganizationRepositoryPort,
    private readonly tokens: ResetTokenPort,
    private readonly clock: ClockPort,
    private readonly audit: AuditLoggerPort,
    private readonly rateLimit: RateLimitPort,
    private readonly mail: MailPort,
    private readonly dispatcher: MailDispatchPort,
    private readonly appUrl: string,
  ) {}

  async execute(input: CreateInvitationInput): Promise<MintedInvitation> {
    await spendInvitationBudget(this.rateLimit, input.actor);

    const minted = this.tokens.mint();
    const expiresAt = new Date(this.clock.now().getTime() + LIFETIME_MS);

    const created = await this.unitOfWork.withTenant(
      { organizationId: input.actor.organizationId, userId: input.actor.userId },
      async () => {
        const rolePermissions =
          input.roleId === null ? [] : await this.invitations.rolePermissions(input.roleId);

        if (rolePermissions === null) throw denyAccess('role', 'other_organization');

        assertAllowed(
          canInvite(input.actor, { email: input.email, rolePermissions }),
          'invitation',
        );

        if (await this.invitations.userExists(input.email)) {
          throw new ConflictError('user_already_exists');
        }

        const invitationId = await this.invitations.create({
          email: input.email,
          roleId: input.roleId,
          teamIds: input.teamIds,
          tokenHash: minted.hash,
          locale: input.locale,
          invitedById: input.actor.userId,
          expiresAt,
        });

        await this.audit.record({
          action: 'invitation.created',
          actor: {
            userId: input.actor.userId,
            organizationId: input.actor.organizationId,
            ipAddress: undefined,
          },
          target: { type: 'INVITATION', id: invitationId },
          // The address, the role and the expiry — never the token or its digest. The trail is read
          // by whoever can read the log, and a credential that reached it has already leaked.
          after: { email: input.email, roleId: input.roleId, expiresAt: expiresAt.toISOString() },
          requestId: undefined,
        });

        return { invitationId, organizationName: await this.organizationName() };
      },
    );

    // Outside the scope: SMTP is never touched inside a transaction (`rules/outbox.mdc`, rule 2),
    // and `dispatch` itself returns before a socket opens.
    const mailDispatched = dispatchInvitation(this.mail, this.dispatcher, this.appUrl, {
      actor: input.actor,
      email: input.email,
      locale: input.locale,
      token: minted.token,
      expiresAt,
      organizationName: created.organizationName,
    });

    return {
      invitationId: created.invitationId,
      email: input.email,
      inviteUrl: invitationLinkOf(this.appUrl, minted.token),
      expiresAt,
      mailDispatched,
    };
  }

  private async organizationName(): Promise<string> {
    const organization = await this.organizations.findCurrent();

    if (organization === null) {
      throw new Error(
        'create-invitation: the tenant scope names an organization that does not exist',
      );
    }

    return organization.name;
  }
}

export interface InvitationActionInput {
  readonly actor: Actor;
  readonly invitationId: string;
}

/**
 * Re-issuing the link: a **new** token, and the old one dead in the same statement.
 *
 * Extending the old one instead would leave two live credentials for one invitation — and the
 * person who forwarded the first link to the wrong address has no way to take it back.
 *
 * It spends the same budget as creating one, and for the same reason: a resend mints a token and
 * sends a letter, so an endpoint that did not count would be the same mail cannon reached by a
 * different path.
 */
export class ResendInvitationUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly invitations: InvitationRepositoryPort,
    private readonly organizations: OrganizationRepositoryPort,
    private readonly tokens: ResetTokenPort,
    private readonly clock: ClockPort,
    private readonly audit: AuditLoggerPort,
    private readonly rateLimit: RateLimitPort,
    private readonly mail: MailPort,
    private readonly dispatcher: MailDispatchPort,
    private readonly appUrl: string,
  ) {}

  async execute(input: InvitationActionInput): Promise<MintedInvitation> {
    await spendInvitationBudget(this.rateLimit, input.actor);

    const minted = this.tokens.mint();
    const expiresAt = new Date(this.clock.now().getTime() + LIFETIME_MS);

    const resent = await this.unitOfWork.withTenant(
      { organizationId: input.actor.organizationId, userId: input.actor.userId },
      async () => {
        const invitation = await this.invitations.byId(input.invitationId);

        if (invitation === null) throw denyAccess('invitation', 'other_organization');

        assertAllowed(canResendInvitation(input.actor, invitation), 'invitation');

        if (!(await this.invitations.reissue(invitation.id, minted.hash, expiresAt))) {
          throw denyAccess('invitation', 'other_organization');
        }

        await this.audit.record({
          action: 'invitation.resent',
          actor: {
            userId: input.actor.userId,
            organizationId: input.actor.organizationId,
            ipAddress: undefined,
          },
          target: { type: 'INVITATION', id: invitation.id },
          after: { email: invitation.email, expiresAt: expiresAt.toISOString() },
          requestId: undefined,
        });

        const organization = await this.organizations.findCurrent();

        if (organization === null) {
          throw new Error(
            'resend-invitation: the tenant scope names an organization that does not exist',
          );
        }

        return { invitation, organizationName: organization.name };
      },
    );

    const mailDispatched = dispatchInvitation(this.mail, this.dispatcher, this.appUrl, {
      actor: input.actor,
      // The address of the row, not one the caller supplied: a resend that could be pointed at a
      // different mailbox would be a way to have an existing invitation delivered to an attacker.
      email: resent.invitation.email,
      locale: resent.invitation.locale,
      token: minted.token,
      expiresAt,
      organizationName: resent.organizationName,
    });

    return {
      invitationId: resent.invitation.id,
      email: resent.invitation.email,
      inviteUrl: invitationLinkOf(this.appUrl, minted.token),
      expiresAt,
      mailDispatched,
    };
  }
}

/**
 * Closing it early.
 *
 * The row goes, rather than gaining a flag: the token has to stop working, and a filter everybody
 * has to remember is a filter somebody forgets. An **accepted** invitation is refused instead —
 * it is a person now, and taking their access away is deactivation.
 */
export class RevokeInvitationUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly invitations: InvitationRepositoryPort,
    private readonly audit: AuditLoggerPort,
  ) {}

  execute(input: InvitationActionInput): Promise<void> {
    return this.unitOfWork.withTenant(
      { organizationId: input.actor.organizationId, userId: input.actor.userId },
      async () => {
        const invitation = await this.invitations.byId(input.invitationId);

        if (invitation === null) throw denyAccess('invitation', 'other_organization');

        assertAllowed(canRevokeInvitation(input.actor, invitation), 'invitation');

        if (!(await this.invitations.remove(invitation.id))) {
          throw denyAccess('invitation', 'other_organization');
        }

        await this.audit.record({
          action: 'invitation.revoked',
          actor: {
            userId: input.actor.userId,
            organizationId: input.actor.organizationId,
            ipAddress: undefined,
          },
          target: { type: 'INVITATION', id: invitation.id },
          before: { email: invitation.email, roleId: invitation.roleId },
          requestId: undefined,
        });
      },
    );
  }
}

/**
 * One point of `invitation_create`, spent before anything else happens.
 *
 * Shared by both operations that mint a token, so the two cannot drift into two budgets — which
 * would mean an inviter who exhausted one could carry on through the other.
 */
const spendInvitationBudget = async (rateLimit: RateLimitPort, actor: Actor): Promise<void> => {
  const decision = await rateLimit.consume('invitation_create', { userId: actor.userId });

  if (!decision.allowed) throw new RateLimitedError(decision.retryAfterSeconds);
};

/**
 * Hands the letter to the transport, and answers whether there was one.
 *
 * An installation without `SMTP_URL` is not a failed request (NFR-9): the invitation is created, the
 * link is in the response, and the interface tells the inviter to pass it on themselves. This is the
 * opposite of `POST /auth/forgot-password`, which refuses without a relay — there the link is the
 * *only* way the person can proceed, and here the caller is holding it.
 */
const dispatchInvitation = (
  mail: MailPort,
  dispatcher: MailDispatchPort,
  appUrl: string,
  letter: {
    readonly actor: Actor;
    readonly email: string;
    readonly locale: MailLocale;
    readonly token: string;
    readonly expiresAt: Date;
    readonly organizationName: string;
  },
): boolean => {
  if (!mail.isConfigured()) return false;

  dispatcher.dispatch(
    {
      to: letter.email,
      ...renderInvitationMail({
        locale: letter.locale,
        appUrl,
        token: letter.token,
        organizationName: letter.organizationName,
        expiresAt: letter.expiresAt,
      }),
    },
    {
      event: SECURITY_EVENTS.invitationDispatched,
      organizationId: letter.actor.organizationId,
      // The inviter, not the recipient: the recipient has no account, and the context of a dispatch
      // is who caused it — which is the only identifier this log line is allowed to carry.
      userId: letter.actor.userId,
    },
  );

  return true;
};
