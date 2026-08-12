import {
  type TotpEnrollmentRepositoryPort,
  type TotpEnrollmentState,
} from '@/application/identity/ports/totp-enrollment.port.js';
import { TenantScopedRepository } from '@/infrastructure/persistence/prisma/tenant-scoped.repository.js';

interface EnrollmentRow {
  readonly id: string;
}

/**
 * The four TOTP columns of `users`, through Prisma — raw SQL throughout, and that is the point of
 * the class.
 *
 * Every write is a single conditional `UPDATE`, on the same reasoning `PrismaPasswordResetTokenRepository`
 * documents at length: a read-then-write here would let two requests — a fresh `setup` racing a
 * `confirm`, or two `confirm` calls for the same draft — both pass under READ COMMITTED, and the
 * "confirmed once" guarantee STORY-013-01 rests on would be a comment rather than a property of the
 * schema.
 *
 * `find` is the one method that is not conditional, because it decides nothing on its own — it is
 * read by `ConfirmTotpUseCase` only to fetch `secretEnc` for the TOTP check that runs *before* the
 * conditional write below it settles the outcome.
 */
export class PrismaTotpEnrollmentRepository
  extends TenantScopedRepository
  implements TotpEnrollmentRepositoryPort
{
  /** Errors here are errors about the account: there is no separate "enrolment" resource. */
  protected readonly resource = 'user' as const;
  protected readonly repositoryName = 'TotpEnrollmentRepository';

  find(userId: string): Promise<TotpEnrollmentState | null> {
    return this.run('find', async (tx) => {
      const row = await tx.user.findFirst({
        where: { id: userId, deletedAt: null },
        select: {
          totpSecretEnc: true,
          totpEnabledAt: true,
          totpDraftExpiresAt: true,
          totpLastCounter: true,
        },
      });

      if (row === null || row.totpSecretEnc === null) return null;

      return {
        secretEnc: row.totpSecretEnc,
        enabledAt: row.totpEnabledAt,
        draftExpiresAt: row.totpDraftExpiresAt,
        lastCounter: row.totpLastCounter,
      };
    });
  }

  beginDraft(userId: string, secretEnc: string, draftExpiresAt: Date): Promise<boolean> {
    return this.run('beginDraft', async (tx) => {
      const rows = await tx.$queryRaw<EnrollmentRow[]>`
        UPDATE users
           SET totp_secret_enc = ${secretEnc},
               totp_draft_expires_at = ${draftExpiresAt},
               totp_last_counter = NULL,
               updated_at = now()
         WHERE id = ${userId}::uuid
           AND deleted_at IS NULL
           AND totp_enabled_at IS NULL
        RETURNING id`;

      return rows.length > 0;
    });
  }

  commitEnrollment(userId: string, counter: number, now: Date): Promise<boolean> {
    return this.run('commitEnrollment', async (tx) => {
      const rows = await tx.$queryRaw<EnrollmentRow[]>`
        UPDATE users
           SET totp_enabled_at = ${now},
               totp_draft_expires_at = NULL,
               totp_last_counter = ${counter},
               updated_at = now()
         WHERE id = ${userId}::uuid
           AND deleted_at IS NULL
           AND totp_enabled_at IS NULL
           AND totp_draft_expires_at > ${now}
        RETURNING id`;

      return rows.length > 0;
    });
  }

  advanceCounter(userId: string, counter: number): Promise<boolean> {
    return this.run('advanceCounter', async (tx) => {
      const rows = await tx.$queryRaw<EnrollmentRow[]>`
        UPDATE users
           SET totp_last_counter = ${counter},
               updated_at = now()
         WHERE id = ${userId}::uuid
           AND deleted_at IS NULL
           AND totp_enabled_at IS NOT NULL
           AND (totp_last_counter IS NULL OR totp_last_counter < ${counter})
        RETURNING id`;

      return rows.length > 0;
    });
  }

  abandonDraft(userId: string): Promise<boolean> {
    return this.run('abandonDraft', async (tx) => {
      const rows = await tx.$queryRaw<EnrollmentRow[]>`
        UPDATE users
           SET totp_secret_enc = NULL,
               totp_draft_expires_at = NULL,
               totp_last_counter = NULL,
               updated_at = now()
         WHERE id = ${userId}::uuid
           AND deleted_at IS NULL
           AND totp_enabled_at IS NULL
           AND totp_secret_enc IS NOT NULL
        RETURNING id`;

      return rows.length > 0;
    });
  }
}
