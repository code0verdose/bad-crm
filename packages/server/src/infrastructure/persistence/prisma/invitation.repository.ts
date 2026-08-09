import { SharedPermissions } from '@bad-crm/shared';

import {
  type AcceptedInvitation,
  type InvitationDraftRow,
  type InvitationRepositoryPort,
  type InvitationRow,
  type InvitedAccountDraft,
} from '@/application/iam/ports/invitation-repository.port.js';
import { mailLocaleOf } from '@/domain/identity/mail-locale.util.js';
import { TenantScopedRepository } from '@/infrastructure/persistence/prisma/tenant-scoped.repository.js';

/**
 * Invitations through Prisma, inside the scope the caller opened.
 *
 * **The token is never here.** Every method deals in digests: `create` and `reissue` take one,
 * nothing returns one, and no read selects `token_hash` at all — a row this repository hands out
 * cannot leak a credential into a log, a serializer or a test snapshot, because it does not carry
 * one.
 *
 * `create` lets the partial unique index answer «already invited»: reading first and inserting
 * afterwards is two statements racing each other, and the loser cannot tell its failure apart from
 * success. `TenantScopedRepository.run` translates the violation, and the use-case reports it as
 * `invitation_already_exists`.
 */
export class PrismaInvitationRepository
  extends TenantScopedRepository
  implements InvitationRepositoryPort
{
  protected readonly resource = 'invitation' as const;
  protected readonly repositoryName = 'InvitationRepository';

  /** Everything a caller may see about an invitation — the digest is deliberately not in the list. */
  private static readonly VISIBLE = {
    id: true,
    email: true,
    roleId: true,
    teamIds: true,
    locale: true,
    invitedById: true,
    expiresAt: true,
    acceptedAt: true,
    createdAt: true,
  } as const;

  create(draft: InvitationDraftRow): Promise<string> {
    return this.run('create', async (tx) => {
      const invitation = await tx.invitation.create({
        data: {
          organizationId: this.organizationId('create'),
          email: draft.email,
          roleId: draft.roleId,
          teamIds: [...draft.teamIds],
          tokenHash: Buffer.from(draft.tokenHash),
          locale: draft.locale,
          invitedById: draft.invitedById,
          expiresAt: draft.expiresAt,
        },
        select: { id: true },
      });

      return invitation.id;
    });
  }

  byId(invitationId: string): Promise<InvitationRow | null> {
    return this.run('byId', async (tx) => {
      const invitation = await tx.invitation.findFirst({
        where: { organizationId: this.organizationId('byId'), id: invitationId },
        select: PrismaInvitationRepository.VISIBLE,
      });

      return invitation === null ? null : toRow(invitation);
    });
  }

  reissue(invitationId: string, tokenHash: Uint8Array, expiresAt: Date): Promise<boolean> {
    return this.run('reissue', async (tx) => {
      // The new digest replaces the old one in the same statement: an invitation with two live
      // tokens is a door somebody thinks they closed. `accepted_at IS NULL` in the predicate rather
      // than in a prior read, so a person who accepted in the meantime cannot be handed a new link.
      const touched = await tx.invitation.updateMany({
        where: {
          organizationId: this.organizationId('reissue'),
          id: invitationId,
          acceptedAt: null,
        },
        data: { tokenHash: Buffer.from(tokenHash), expiresAt },
      });

      return touched.count > 0;
    });
  }

  remove(invitationId: string): Promise<boolean> {
    return this.run('remove', async (tx) => {
      // Same predicate, same reason: an accepted invitation is a person, and this is not how their
      // access is taken away.
      const removed = await tx.invitation.deleteMany({
        where: {
          organizationId: this.organizationId('remove'),
          id: invitationId,
          acceptedAt: null,
        },
      });

      return removed.count > 0;
    });
  }

  listOpen(): Promise<readonly InvitationRow[]> {
    return this.run('listOpen', async (tx) => {
      const invitations = await tx.invitation.findMany({
        where: { organizationId: this.organizationId('listOpen'), acceptedAt: null },
        orderBy: { createdAt: 'desc' },
        select: PrismaInvitationRepository.VISIBLE,
      });

      return invitations.map((invitation) => toRow(invitation));
    });
  }

  userExists(email: string): Promise<boolean> {
    return this.run('userExists', async (tx) => {
      // A deactivated account still occupies the address: `uq_users_org_email` is partial on
      // `deleted_at IS NULL`, so inviting somebody who was deleted is allowed — and inviting
      // somebody who is merely suspended is not, because the account is still there to sign in with
      // once it is restored.
      const user = await tx.user.findFirst({
        where: { organizationId: this.organizationId('userExists'), email, deletedAt: null },
        select: { id: true },
      });

      return user !== null;
    });
  }

  accept(
    invitationId: string,
    acceptedUserId: string,
    now: Date,
  ): Promise<AcceptedInvitation | null> {
    return this.run('accept', async (tx) => {
      // One statement, and the predicate is the whole single-use guarantee: `updateMany` cannot
      // return the row, so this is raw — `RETURNING` is what makes «spend it and tell me what it
      // said» atomic. Expiry sits in the same predicate as `accepted_at IS NULL` so that «spent» and
      // «expired» are one outcome in the code as well as in the answer.
      const rows = await tx.$queryRaw<
        { email: string; role_id: string | null; team_ids: string[] }[]
      >`
        UPDATE invitations
           SET accepted_at = ${now}, accepted_user_id = ${acceptedUserId}::uuid, updated_at = ${now}
         WHERE organization_id = ${this.organizationId('accept')}::uuid
           AND id = ${invitationId}::uuid
           AND accepted_at IS NULL
           AND expires_at > ${now}
        RETURNING email, role_id, team_ids`;

      const row = rows[0];

      return row === undefined
        ? null
        : { email: row.email, roleId: row.role_id, teamIds: row.team_ids };
    });
  }

  createAccount(draft: InvitedAccountDraft): Promise<string> {
    return this.run('createAccount', async (tx) => {
      const user = await tx.user.create({
        data: {
          organizationId: this.organizationId('createAccount'),
          email: draft.email,
          passwordHash: draft.passwordHash,
          // `ACTIVE`, not `INVITED`: by now the person holds the link and has chosen a password,
          // which is everything the status means.
          status: 'ACTIVE',
          locale: draft.locale,
          timezone: draft.timezone,
        },
        select: { id: true },
      });

      return user.id;
    });
  }

  joinTeams(userId: string, teamIds: readonly string[]): Promise<readonly string[]> {
    return this.run('joinTeams', async (tx) => {
      if (teamIds.length === 0) return [];

      // `INSERT … SELECT` over the teams that still exist, rather than an insert of the drafted ids:
      // `team_ids` carries no foreign key, so a team deleted while the invitation was open would
      // fail the whole acceptance on a constraint. `ON CONFLICT DO NOTHING` makes a retry of the
      // whole flow idempotent against the uniqueness of `(team_id, user_id)`.
      //
      // **The conflict target is named by its columns, not by `ON CONSTRAINT uq_team_members`.**
      // `uq_team_members` is a unique *index* (`CREATE UNIQUE INDEX` in the migration, which is what
      // Prisma's `@@unique` emits), and `ON CONFLICT ON CONSTRAINT` is resolved against
      // `pg_constraint` — where an index does not appear. That spelling therefore fails at parse
      // time, on **every** call rather than only on a conflict: `42704`, «constraint does not
      // exist», and the whole acceptance rolls back for anybody invited into a team. Column
      // inference matches the index instead, as `session.repository.ts` does.
      //
      // `RETURNING team_id` rather than a bare `$executeRaw`, because a count is all a row count can
      // ever be: `team.member_added` is never filed for these memberships, so the ids returned here
      // are the only record `invitation.accepted` can carry them in at all.
      const written = await tx.$queryRaw<{ team_id: string }[]>`
        INSERT INTO team_members (organization_id, team_id, user_id, updated_at)
        SELECT t.organization_id, t.id, ${userId}::uuid, now()
          FROM teams t
         WHERE t.organization_id = ${this.organizationId('joinTeams')}::uuid
           AND t.id = ANY(${[...teamIds]}::uuid[])
           AND t.deleted_at IS NULL
        ON CONFLICT (team_id, user_id) DO NOTHING
        RETURNING team_id`;

      return written.map((row) => row.team_id);
    });
  }

  rolePermissions(roleId: string): Promise<readonly SharedPermissions.PermissionKey[] | null> {
    return this.run('rolePermissions', async (tx) => {
      const role = await tx.role.findFirst({
        where: { organizationId: this.organizationId('rolePermissions'), id: roleId },
        select: {
          permissions: {
            // A key retired from the catalogue grants nothing, so it is not something the invitation
            // hands out either — the same filter the effective-permission reader applies.
            where: { permission: { deprecatedAt: null } },
            select: { permissionKey: true },
          },
        },
      });

      if (role === null) return null;

      return role.permissions
        .map((grant) => grant.permissionKey)
        .filter((key): key is SharedPermissions.PermissionKey =>
          SharedPermissions.isPermissionKey(key),
        );
    });
  }
}

/**
 * The stored row as the application reads it.
 *
 * The one thing that is not a copy is the locale: the column is `TEXT` with a check constraint, and
 * `mailLocaleOf` is the same narrowing every other outgoing message goes through — so a value that
 * somehow got past the constraint becomes an English letter rather than a crash inside a template
 * lookup.
 */
const toRow = (row: {
  readonly id: string;
  readonly email: string;
  readonly roleId: string | null;
  readonly teamIds: string[];
  readonly locale: string;
  readonly invitedById: string;
  readonly expiresAt: Date;
  readonly acceptedAt: Date | null;
  readonly createdAt: Date;
}): InvitationRow => ({ ...row, locale: mailLocaleOf(row.locale) });
