import {
  type UserCredentialRecord,
  type UserRecord,
  type UserRepositoryPort,
} from '@/application/identity/ports/user-repository.port.js';
import { TenantScopedRepository } from '@/infrastructure/persistence/prisma/tenant-scoped.repository.js';

/**
 * Accounts of the organization in the current scope.
 *
 * No client, no transaction, no `organizationId` argument — the template of
 * `PrismaOrganizationRepository`, and for the same reason: the tenant is the scope, and a second
 * source of truth for it is one the policy silently overrules (`tenant-scoped.repository.ts`).
 *
 * Reads that precede the tenant — resolving an address at sign-in — are deliberately not here. Under
 * the policy they would return nothing, which is the correct outcome and a useless one; they live on
 * the `app_auth` surface behind `AuthLookupPort`.
 */
export class PrismaUserRepository extends TenantScopedRepository implements UserRepositoryPort {
  protected readonly resource = 'user' as const;
  protected readonly repositoryName = 'UserRepository';

  /**
   * The columns the session response and the authorization layer read — never the whole row.
   *
   * `passwordHash`, `totpSecretEnc` and the two `authVerifier*` columns are absent from the
   * selection by construction, so nothing downstream can leak them into a response or a log.
   */
  findById(userId: string): Promise<UserRecord | null> {
    return this.run('findById', async (tx) => {
      const row = await tx.user.findFirst({
        where: { id: userId, deletedAt: null },
        select: {
          id: true,
          email: true,
          locale: true,
          timezone: true,
          status: true,
          permissionsVersion: true,
        },
      });

      return row === null ? null : { ...row, status: row.status };
    });
  }

  /**
   * The digest, the address and the language of one account — the only selection here that reads
   * `password_hash`.
   *
   * Kept apart from `findById` rather than added to it: that one feeds the session response and the
   * authorization layer, and a digest travelling with it is a digest one careless serializer puts in
   * a body. This selection has exactly one caller and one destination, `PasswordHasherPort.verify`.
   *
   * `deletedAt: null`, like every other read: a soft-deleted account has no password to change.
   */
  findCredential(userId: string): Promise<UserCredentialRecord | null> {
    return this.run('findCredential', async (tx) => {
      const row = await tx.user.findFirst({
        where: { id: userId, deletedAt: null },
        select: { email: true, passwordHash: true, locale: true },
      });

      return row;
    });
  }

  /**
   * The write half of the transparent re-hash — and of the two operations that set a password.
   *
   * `updateMany` and not `update`: the latter raises `P2025` when it matches nothing, which the base
   * class translates into a 404 for the *user* — and a failed re-hash must not turn a successful
   * sign-in into "no such account". Matching nothing here means the row moved or was soft-deleted
   * between the lookup and the write.
   *
   * **The count is returned rather than dropped**, which is the whole of the change. `updateMany`
   * matching nothing is silent by construction, so a password change and a password reset both used
   * to go on to revoke sessions and answer 204 over a digest that had not moved. Which of the three
   * callers may ignore a zero is a decision only the caller can make, so the statement reports what
   * it did and stops deciding for them (`user-repository.port.ts`).
   */
  async updatePasswordHash(userId: string, passwordHash: string): Promise<boolean> {
    const result = await this.run('updatePasswordHash', (tx) =>
      tx.user.updateMany({ where: { id: userId, deletedAt: null }, data: { passwordHash } }),
    );

    return result.count > 0;
  }
}
