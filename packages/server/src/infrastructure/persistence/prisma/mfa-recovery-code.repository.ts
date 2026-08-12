import {
  type RecoveryCodeCandidate,
  type RecoveryCodeCounts,
  type RecoveryCodeRepositoryPort,
} from '@/application/identity/ports/recovery-code-repository.port.js';
import { TenantScopedRepository } from '@/infrastructure/persistence/prisma/tenant-scoped.repository.js';

interface UsedRow {
  readonly id: string;
}

/**
 * `mfa_recovery_codes` of the account in the current tenant scope, through Prisma.
 *
 * `markUsed` is the one raw statement, and for the reason `PrismaPasswordResetTokenRepository.consume`
 * gives at length: two requests presenting the same code both resolve the same candidate row by
 * argon2id comparison in the use-case, and only the conditional `UPDATE` here decides which of them —
 * if either — actually spends it. `createMany`, `listUnused`, `deleteAllForUser` and `counts` have no
 * such race to guard against: they either write rows nobody else references yet, or read a set without
 * deciding anything from the read alone.
 */
export class PrismaMfaRecoveryCodeRepository
  extends TenantScopedRepository
  implements RecoveryCodeRepositoryPort
{
  /** Errors here are errors about the account: there is no separate "recovery code" resource. */
  protected readonly resource = 'user' as const;
  protected readonly repositoryName = 'MfaRecoveryCodeRepository';

  createMany(userId: string, hashes: readonly string[]): Promise<void> {
    return this.run('createMany', async (tx) => {
      await tx.mfaRecoveryCode.createMany({
        data: hashes.map((codeHash) => ({
          // From the scope, never from an argument that could name another tenant — the same rule
          // every repository in this codebase follows (`organizationId()` reads `app.organization_id`
          // and nothing else can satisfy `WITH CHECK`).
          organizationId: this.organizationId('createMany'),
          userId,
          codeHash,
        })),
      });
    });
  }

  /**
   * The candidate set, and it is filtered by the state of the **account** as well as of the row.
   *
   * `user: { deletedAt: null }` is the same predicate `PrismaTotpEnrollmentRepository.find` carries,
   * and it is not symmetry for its own sake: no offboarding step removes rows from this table.
   * `PENDING_OFFBOARDING_STEPS` names projects, sockets, secure links and the vault, and says nothing
   * about the second factor — so a deleted account's codes would otherwise stay a live candidate set,
   * and this list is the only gate a presented code passes. The step that *deletes* them on
   * offboarding is a separate change; this predicate is what makes the survivors unusable meanwhile.
   */
  listUnused(userId: string): Promise<readonly RecoveryCodeCandidate[]> {
    return this.run('listUnused', async (tx) => {
      const rows = await tx.mfaRecoveryCode.findMany({
        where: { userId, usedAt: null, user: { deletedAt: null } },
        select: { id: true, codeHash: true },
      });

      return rows.map((row) => ({ id: row.id, codeHash: row.codeHash }));
    });
  }

  markUsed(userId: string, id: string, now: Date): Promise<boolean> {
    return this.run('markUsed', async (tx) => {
      const rows = await tx.$queryRaw<UsedRow[]>`
        UPDATE mfa_recovery_codes
           SET used_at = ${now}, updated_at = now()
         WHERE id = ${id}::uuid
           AND user_id = ${userId}::uuid
           AND used_at IS NULL
        RETURNING id`;

      return rows.length > 0;
    });
  }

  deleteAllForUser(userId: string): Promise<number> {
    return this.run('deleteAllForUser', async (tx) => {
      const result = await tx.mfaRecoveryCode.deleteMany({ where: { userId } });

      return result.count;
    });
  }

  counts(userId: string): Promise<RecoveryCodeCounts> {
    return this.run('counts', async (tx) => {
      const [total, remaining] = await Promise.all([
        tx.mfaRecoveryCode.count({ where: { userId } }),
        tx.mfaRecoveryCode.count({ where: { userId, usedAt: null } }),
      ]);

      return { total, remaining };
    });
  }
}
