import {
  type InvitationRepositoryPort,
  type InvitationRow,
} from '@/application/iam/ports/invitation-repository.port.js';
import { type AuditLoggerPort } from '@/application/platform/ports/audit-logger.port.js';
import { type ClockPort } from '@/application/platform/ports/clock.port.js';
import { type UnitOfWorkPort } from '@/application/platform/ports/unit-of-work.port.js';
import { type ResetTokenPort } from '@/application/identity/ports/reset-token.port.js';
import { type Actor } from '@/domain/access/actor.types.js';
import { assertAllowed } from '@/domain/access/decision.util.js';
import {
  canInvite,
  canResendInvitation,
  canRevokeInvitation,
} from '@/domain/iam/access/invitation-access.policy.js';
import { ConflictError } from '@/domain/shared/errors/app.errors.js';
import { denyAccess } from '@/domain/shared/errors/access-denial.util.js';

/** How long an invitation stays open. Seven days: long enough for a holiday, short enough to expire. */
const LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

export interface CreateInvitationInput {
  readonly actor: Actor;
  readonly email: string;
  readonly roleId: string | null;
  readonly teamIds: readonly string[];
}

/** The link, handed back **once**: the server keeps only the digest and cannot show it again. */
export interface MintedInvitation {
  readonly invitationId: string;
  readonly token: string;
  readonly expiresAt: Date;
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
 *   invitation is `invitation_already_pending` — two different situations with two different things
 *   to do about them.
 *
 * The token is returned exactly once, in the response. What is stored is the digest, for the same
 * reason a session stores one: a dump, a backup or a curious operator must not yield a working
 * invitation.
 */
export class CreateInvitationUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly invitations: InvitationRepositoryPort,
    private readonly tokens: ResetTokenPort,
    private readonly clock: ClockPort,
    private readonly audit: AuditLoggerPort,
  ) {}

  execute(input: CreateInvitationInput): Promise<MintedInvitation> {
    return this.unitOfWork.withTenant(
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

        const minted = this.tokens.mint();
        const expiresAt = new Date(this.clock.now().getTime() + LIFETIME_MS);

        const invitationId = await this.invitations.create({
          email: input.email,
          roleId: input.roleId,
          teamIds: input.teamIds,
          tokenHash: minted.hash,
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

        return { invitationId, token: minted.token, expiresAt };
      },
    );
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
 */
export class ResendInvitationUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly invitations: InvitationRepositoryPort,
    private readonly tokens: ResetTokenPort,
    private readonly clock: ClockPort,
    private readonly audit: AuditLoggerPort,
  ) {}

  execute(input: InvitationActionInput): Promise<MintedInvitation> {
    return this.unitOfWork.withTenant(
      { organizationId: input.actor.organizationId, userId: input.actor.userId },
      async () => {
        const invitation = await this.open(input);

        assertAllowed(canResendInvitation(input.actor, invitation), 'invitation');

        const minted = this.tokens.mint();
        const expiresAt = new Date(this.clock.now().getTime() + LIFETIME_MS);

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

        return { invitationId: invitation.id, token: minted.token, expiresAt };
      },
    );
  }

  private async open(input: InvitationActionInput): Promise<InvitationRow> {
    const invitation = await this.invitations.byId(input.invitationId);

    if (invitation === null) throw denyAccess('invitation', 'other_organization');

    return invitation;
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
