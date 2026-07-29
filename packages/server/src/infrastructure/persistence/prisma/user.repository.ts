import {
  type OwnerDraft,
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
   * The first account of a new organization.
   *
   * `organizationId` is taken from the scope rather than from the draft: the row has to satisfy
   * `WITH CHECK (organization_id = current_setting('app.organization_id')::uuid)`, and reading it
   * from the scope makes any other value unreachable rather than merely refused.
   *
   * `status: 'ACTIVE'` is stated because the column has no default, on purpose: a row is created
   * either by registration or by an invitation, and a default would decide that for whichever path
   * forgets to (`schema.prisma`, `UserStatus`).
   */
  createOwner(draft: OwnerDraft): Promise<string> {
    return this.run('createOwner', async (tx) => {
      const row = await tx.user.create({
        data: {
          organizationId: this.organizationId('createOwner'),
          email: draft.email,
          passwordHash: draft.passwordHash,
          locale: draft.locale,
          timezone: draft.timezone,
          status: 'ACTIVE',
        },
        select: { id: true },
      });

      return row.id;
    });
  }

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
   * The write half of the transparent re-hash.
   *
   * `updateMany` and not `update`: the latter raises `P2025` when it matches nothing, which the base
   * class translates into a 404 for the *user* — and a failed re-hash must not turn a successful
   * sign-in into "no such account". Matching nothing here means the row moved or was deleted between
   * the lookup and the write, and the correct answer is to leave the digest as it was.
   */
  async updatePasswordHash(userId: string, passwordHash: string): Promise<void> {
    await this.run('updatePasswordHash', (tx) =>
      tx.user.updateMany({ where: { id: userId, deletedAt: null }, data: { passwordHash } }),
    );
  }
}
