import {
  type MfaCoverageSubject,
  type MfaPolicyReaderPort,
} from '@/application/organization/ports/mfa-policy-reader.port.js';
import { type HeldRoleGrant } from '@/domain/identity/access/mfa-requirement.policy.js';
import { TenantScopedRepository } from '@/infrastructure/persistence/prisma/tenant-scoped.repository.js';

/**
 * `MfaPolicyReaderPort` on Prisma.
 *
 * Both reads exclude expired grants **in SQL** rather than after the rows come back
 * (`rules/permissions.mdc`, 8): a role whose `expires_at` has passed grants nothing from that
 * moment, whether or not any cleaner has run, so a person it once covered must stop being covered
 * without waiting for one.
 */
export class PrismaMfaPolicyReaderRepository
  extends TenantScopedRepository
  implements MfaPolicyReaderPort
{
  protected readonly resource = 'user' as const;
  protected readonly repositoryName = 'MfaPolicyReaderRepository';

  roleGrantsOf(userId: string): Promise<readonly HeldRoleGrant[]> {
    return this.run('roleGrantsOf', async (tx) => {
      const rows = await tx.userRole.findMany({
        where: { userId, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
        select: { roleId: true, grantedAt: true, role: { select: { key: true } } },
      });

      return rows.map((row) => ({
        roleId: row.roleId,
        roleKey: row.role.key,
        grantedAt: row.grantedAt,
      }));
    });
  }

  /**
   * Everybody the report can be about, in one statement plus its join.
   *
   * `SUSPENDED` and `INVITED` accounts are excluded: neither can open a session, so neither can be
   * locked out by the policy, and counting them would make the report say an organization is short
   * of enrolments it has no way to obtain.
   */
  coverageSubjects(): Promise<readonly MfaCoverageSubject[]> {
    return this.run('coverageSubjects', async (tx) => {
      const rows = await tx.user.findMany({
        where: { status: 'ACTIVE', deletedAt: null },
        orderBy: { email: 'asc' },
        select: {
          id: true,
          email: true,
          totpEnabledAt: true,
          roles: {
            where: { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
            select: { roleId: true, grantedAt: true, role: { select: { key: true } } },
          },
        },
      });

      return rows.map((row) => ({
        userId: row.id,
        email: row.email,
        totpEnabledAt: row.totpEnabledAt,
        roles: row.roles.map((grant) => ({
          roleId: grant.roleId,
          roleKey: grant.role.key,
          grantedAt: grant.grantedAt,
        })),
      }));
    });
  }
}
