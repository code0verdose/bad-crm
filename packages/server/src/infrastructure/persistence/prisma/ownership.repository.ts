import {
  type OwnershipRepositoryPort,
  type OwnershipTransfer,
  type TransferCandidate,
} from '@/application/iam/ports/ownership-repository.port.js';
import { ConflictError } from '@/domain/shared/errors/app.errors.js';
import { TenantScopedRepository } from '@/infrastructure/persistence/prisma/tenant-scoped.repository.js';

/**
 * Ownership through Prisma, inside the scope the caller opened.
 *
 * Every statement of `transfer` runs in the transaction `withTenant` opened, and that is the whole
 * design: an organization whose root points at one person while the `owner` role sits on another is
 * an installation with two answers to «who is in charge». There is no ordering of these writes that
 * is safe outside one transaction, so there is no version of this method that takes them apart.
 *
 * **One transaction is necessary and, on its own, not sufficient.** Two callers can each open their
 * own transaction and both start from the same `currentOwnerId()`, under `ReadCommitted`
 * (`tenant.context.ts`) — the isolation level this application runs at everywhere. Nothing about
 * *this* transaction being atomic stops *another*, concurrent one, from doing the same four writes
 * off the same starting owner. What closes that gap is the first statement below: the root is
 * repointed only if the row still names the owner this transfer was built against, so of two
 * transfers racing off the same origin at most one may proceed — the other finds its own `UPDATE`
 * matching zero rows and refuses rather than guessing which of the two writes should have won.
 */
export class PrismaOwnershipRepository
  extends TenantScopedRepository
  implements OwnershipRepositoryPort
{
  protected readonly resource = 'organization' as const;
  protected readonly repositoryName = 'OwnershipRepository';

  currentOwnerId(): Promise<string | null> {
    return this.run('currentOwnerId', async (tx) => {
      const organization = await tx.organization.findFirst({
        where: { id: this.organizationId('currentOwnerId'), deletedAt: null },
        select: { ownerId: true },
      });

      return organization?.ownerId ?? null;
    });
  }

  candidate(userId: string): Promise<TransferCandidate | null> {
    return this.run('candidate', async (tx) => {
      const account = await tx.user.findFirst({
        where: { organizationId: this.organizationId('candidate'), id: userId, deletedAt: null },
        select: { id: true, status: true },
      });

      return account === null ? null : { userId: account.id, status: account.status };
    });
  }

  transfer(transfer: OwnershipTransfer): Promise<void> {
    return this.run('transfer', async (tx) => {
      const organizationId = this.organizationId('transfer');

      // The guard against two transfers racing off the same owner, and it comes first on purpose:
      // everything below it — the role reads, the two `userRole` writes — is wasted work for a
      // transfer that is about to be refused, and failing fast means a losing transaction never
      // queries roles it will roll back away anyway.
      //
      // The predicate is the lock. Under `ReadCommitted`, this `UPDATE` takes a row lock on the
      // organization the moment it matches, so a second, concurrent call to this method blocks here
      // until the first commits or rolls back — there is no `SELECT … FOR UPDATE` held across the
      // four writes below, because the conditional write *is* the critical section. Once unblocked,
      // PostgreSQL re-evaluates `owner_id = fromUserId` against whatever the first transaction left
      // behind: if it committed a different owner, the predicate no longer matches, `count` is `0`,
      // and this call refuses instead of silently repointing the root a second time.
      const claimedRoot = await tx.organization.updateMany({
        where: { id: organizationId, ownerId: transfer.fromUserId },
        data: { ownerId: transfer.toUserId },
      });

      if (claimedRoot.count !== 1) {
        throw new ConflictError('stale_version', { cause: 'ownership_changed_concurrently' });
      }

      const roles = await tx.role.findMany({
        where: { organizationId, key: { in: ['owner', transfer.previousOwnerRoleKey] } },
        select: { id: true, key: true },
      });
      const idOf = (key: string): string => {
        const role = roles.find((candidate) => candidate.key === key);

        // A system role missing from a provisioned organization is a broken installation, not a bad
        // request: `ProvisionSystemRolesUseCase` writes them on registration and re-applies on
        // upgrade. Failing loudly here beats handing the organization to somebody with no role.
        if (role === undefined) {
          throw new Error(`ownership.repository: the organization has no \`${key}\` role`);
        }

        return role.id;
      };

      const ownerRoleId = idOf('owner');
      const fallbackRoleId = idOf(transfer.previousOwnerRoleKey);

      // The recipient first: at no point in this transaction is there nobody holding `owner`. The
      // order is invisible outside — the whole thing commits or none of it does — but it is the
      // order a reader of a partial log would want to see.
      await tx.userRole.createMany({
        data: [
          { organizationId, userId: transfer.toUserId, roleId: ownerRoleId },
          { organizationId, userId: transfer.fromUserId, roleId: fallbackRoleId },
        ],
        // Already holding it is not a failure: an administrator promoted to owner keeps their
        // `admin` row, and re-running a half-finished transfer must not collide.
        skipDuplicates: true,
      });

      await tx.userRole.deleteMany({
        where: { organizationId, userId: transfer.fromUserId, roleId: ownerRoleId },
      });

      // The root itself was already repointed above, by the guarded `updateMany` that also doubles
      // as the concurrency check — there is nothing left to write here.

      // Both, and in one statement: the recipient needs the new authority on their next request, and
      // the outgoing owner's live token still claims one they have just given away.
      await tx.user.updateMany({
        where: { organizationId, id: { in: [transfer.fromUserId, transfer.toUserId] } },
        data: { permissionsVersion: { increment: 1 } },
      });
    });
  }
}
