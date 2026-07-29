import {
  type PasswordResetTokenDraft,
  type PasswordResetTokenRepositoryPort,
} from '@/application/identity/ports/password-reset-token.port.js';
import { TenantScopedRepository } from '@/infrastructure/persistence/prisma/tenant-scoped.repository.js';

interface SpentRow {
  readonly user_id: string;
}

/**
 * Password-reset tokens, through Prisma.
 *
 * One statement here is raw SQL, and it is the reason the class exists at all.
 *
 * **`consume` must be a single conditional `UPDATE`.** Read-then-write is two statements, and under
 * READ COMMITTED two requests holding the same token both pass the read: the password is then set
 * twice, the second time to whatever the slower request carried, and the "single use" the whole
 * design rests on is a comment. `WHERE used_at IS NULL AND expires_at > $now … RETURNING user_id`
 * makes the row itself the arbiter — the loser updates nothing, gets no row back, and is answered
 * `password_reset_token_invalid` exactly like an unknown token
 * (`docs/architecture/data-model.md` §1).
 *
 * Expiry is in the same predicate rather than checked by the caller, which is what keeps "spent" and
 * "expired" indistinguishable in the code as well as in the answer: there is no branch left that
 * knows which of the two happened.
 *
 * Both statements run inside the tenant scope, so the policy applies to them as it does to the ORM
 * calls — raw SQL bypasses Prisma, not row-level security.
 */
export class PrismaPasswordResetTokenRepository
  extends TenantScopedRepository
  implements PasswordResetTokenRepositoryPort
{
  /** Errors of this table are errors about the account it belongs to; the token is not a resource. */
  protected readonly resource = 'user' as const;
  protected readonly repositoryName = 'PasswordResetTokenRepository';

  create(draft: PasswordResetTokenDraft): Promise<string> {
    return this.run('create', async (tx) => {
      const row = await tx.passwordResetToken.create({
        data: {
          // From the scope, never from the draft: the row has to satisfy
          // `WITH CHECK (organization_id = current_setting('app.organization_id')::uuid)`, and
          // reading it here makes any other value unreachable rather than merely refused.
          organizationId: this.organizationId('create'),
          userId: draft.userId,
          tokenHash: Buffer.from(draft.tokenHash),
          expiresAt: draft.expiresAt,
          requestedIpHash: draft.requestedIpHash,
        },
        select: { id: true },
      });

      return row.id;
    });
  }

  consume(tokenId: string, now: Date): Promise<string | null> {
    return this.run('consume', async (tx) => {
      const rows = await tx.$queryRaw<SpentRow[]>`
        UPDATE password_reset_tokens
           SET used_at = ${now}, updated_at = now()
         WHERE id = ${tokenId}::uuid
           AND used_at IS NULL
           AND expires_at > ${now}
        RETURNING user_id`;

      return rows[0]?.user_id ?? null;
    });
  }

  /**
   * Every remaining live token of the account, spent in one indexed statement.
   *
   * `updateMany` and not a walk of the rows: the caller is inside the transaction that is writing
   * the new digest, and reading the ids first would only add a round trip and a window. The
   * predicate is `used_at IS NULL` and nothing else — an expired row is already unusable, and
   * touching it would rewrite history for no gain.
   *
   * `updated_at` is left to Prisma's `@updatedAt`, unlike in `consume`, which is raw SQL and has to
   * write it by hand.
   */
  invalidateOutstanding(userId: string, at: Date): Promise<number> {
    return this.run('invalidateOutstanding', async (tx) => {
      const result = await tx.passwordResetToken.updateMany({
        where: { userId, usedAt: null },
        data: { usedAt: at },
      });

      return result.count;
    });
  }

  /**
   * The rows of one account that can never be spent again.
   *
   * A `DELETE` and not an archive: the row holds the digest of a credential that was mailed, and
   * once it is settled it answers no question anybody asks — `consume` refuses it on both halves of
   * its predicate, and the security event that a reset happened is in the log, which is where the
   * `AuditLog` writer of EPIC-009 will read it from too.
   *
   * Both halves of the predicate are needed. `used_at IS NOT NULL` clears the ones a completed reset
   * left behind; `expires_at <= now` clears the ones nobody ever clicked, which is the larger of the
   * two piles on any installation.
   */
  deleteSettled(userId: string, now: Date): Promise<number> {
    return this.run('deleteSettled', async (tx) => {
      const result = await tx.passwordResetToken.deleteMany({
        where: { userId, OR: [{ usedAt: { not: null } }, { expiresAt: { lte: now } }] },
      });

      return result.count;
    });
  }
}
