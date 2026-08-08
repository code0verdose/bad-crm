import {
  type LeftTeamMembership,
  type UserLifecycleRepositoryPort,
  type UserLifecycleRow,
} from '@/application/iam/ports/user-lifecycle-repository.port.js';
import { TenantScopedRepository } from '@/infrastructure/persistence/prisma/tenant-scoped.repository.js';

/**
 * The account lifecycle through Prisma, inside the scope the caller opened.
 *
 * Every write of `suspend` happens in the transaction `withTenant` opened, and that is the whole
 * design: an account whose status changed but whose sessions survived — or whose version never moved
 * — is an account that still answers requests. Splitting these across transactions would make the
 * gap between them a window, and the window is exactly what offboarding exists to close.
 */
export class PrismaUserLifecycleRepository
  extends TenantScopedRepository
  implements UserLifecycleRepositoryPort
{
  protected readonly resource = 'user' as const;
  protected readonly repositoryName = 'UserLifecycleRepository';

  byId(userId: string): Promise<UserLifecycleRow | null> {
    return this.run('byId', async (tx) => {
      const organizationId = this.organizationId('byId');
      const account = await tx.user.findFirst({
        where: { organizationId, id: userId, deletedAt: null },
        select: {
          id: true,
          status: true,
          // The owner id travels with the subject rather than being fetched separately: the two are
          // compared, and an ownership transfer landing between two reads would let the previous
          // owner be deactivated on a fact that had already stopped being true.
          organization: { select: { ownerId: true } },
        },
      });

      if (account === null) return null;

      return {
        userId: account.id,
        status: account.status,
        organizationOwnerId: account.organization.ownerId,
      };
    });
  }

  suspend(userId: string, at: Date): Promise<readonly LeftTeamMembership[]> {
    return this.run('suspend', async (tx) => {
      const organizationId = this.organizationId('suspend');

      // Status and version in one statement. A bump issued separately, after the status change, is a
      // window in which a live access token still passes `AuthenticateSessionQuery`.
      await tx.user.update({
        where: { organizationId_id: { organizationId, id: userId } },
        data: { status: 'SUSPENDED', permissionsVersion: { increment: 1 } },
      });

      // `updateMany`, not `update`: an account with no personnel record yet has nothing to terminate,
      // and that is an ordinary case — somebody who accepted an invitation this morning — rather than
      // a missing row to raise about.
      await tx.employeeProfile.updateMany({
        where: { organizationId, userId },
        data: { terminatedAt: at },
      });

      // Membership is access, not history: teams are left. Tasks, hours and the trail keep pointing
      // at the person, because those are a record of work that really happened (NFR-12).
      //
      // Raw, and for the same reason `invitation.repository.ts` goes raw: `deleteMany` cannot return
      // the rows, and these rows are the only record that the memberships existed — `team_members`
      // has no `deleted_at`, and `team_role` disappears with the row. Reading first and deleting
      // afterwards would be two statements over a set that can change between them; `RETURNING`
      // makes «remove them and tell me what they were» one statement and one truth.
      const removed = await tx.$queryRaw<{ team_id: string; team_role: string }[]>`
        DELETE FROM team_members
         WHERE organization_id = ${organizationId}::uuid
           AND user_id = ${userId}::uuid
        RETURNING team_id, team_role`;

      return removed.map((row) => ({ teamId: row.team_id, teamRole: row.team_role }));
    });
  }

  reactivate(userId: string): Promise<void> {
    return this.run('reactivate', async (tx) => {
      const organizationId = this.organizationId('reactivate');

      await tx.user.update({
        where: { organizationId_id: { organizationId, id: userId } },
        data: { status: 'ACTIVE', permissionsVersion: { increment: 1 } },
      });

      // The termination date is cleared; nothing else comes back. Restoring memberships would be
      // re-granting access on the strength of a state that was correct months ago.
      await tx.employeeProfile.updateMany({
        where: { organizationId, userId },
        data: { terminatedAt: null },
      });
    });
  }
}
