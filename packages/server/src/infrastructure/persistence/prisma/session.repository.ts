import {
  type ActiveSession,
  type CreatedSession,
  type SessionAuthContext,
  type SessionDraft,
  type SessionOwnerRecord,
  type SessionRepositoryPort,
  type SessionRevokedReason,
} from '@/application/identity/ports/session-repository.port.js';
import { TenantScopedRepository } from '@/infrastructure/persistence/prisma/tenant-scoped.repository.js';

interface AuthContextRow {
  readonly session_id: string;
  readonly user_id: string;
  readonly family_id: string;
  readonly revoked_at: Date | null;
  readonly expires_at: Date;
  readonly user_status: string;
  readonly permissions_version: number;
}

interface ActiveSessionRow {
  readonly id: string;
  readonly family_id: string;
  readonly started_at: Date;
  readonly last_used_at: Date;
  readonly expires_at: Date;
  readonly user_agent: string;
  readonly ip_masked: string;
}

interface CountRow {
  readonly count: number;
}

/**
 * Refresh-token families, through Prisma.
 *
 * Four statements here are written as raw SQL, and each one is raw for a reason the ORM cannot
 * express:
 *
 * - **`markRotated`** must be a single conditional `UPDATE`. Read-then-write is two statements, and
 *   under READ COMMITTED two requests holding the same token both pass the read — which mints two
 *   live sessions from one credential and makes the reuse detection this epic is built on report a
 *   theft that never happened.
 * - **`revokeFamily`** must be one indexed `UPDATE` over `family_id`, not a walk of `rotatedFromId`:
 *   the chain can be thirty days long, and the moment it runs is the moment a stolen token is in
 *   use.
 * - **`revokeOtherFamilies`** has to count *families* rather than rows, which is a
 *   `count(DISTINCT …)` over the rows it just updated.
 * - **`listActive`** needs `min(created_at)` per family in the same pass, because a session's start
 *   is the family's oldest row while everything else about it comes from the live one.
 *
 * All four still run inside the tenant scope, so the policy applies to them exactly as it does to
 * the ORM calls — raw SQL bypasses Prisma, not row-level security.
 */
export class PrismaSessionRepository
  extends TenantScopedRepository
  implements SessionRepositoryPort
{
  protected readonly resource = 'session' as const;
  protected readonly repositoryName = 'SessionRepository';

  /**
   * Inserts the row, or answers `null` when the refresh digest is already taken.
   *
   * `ON CONFLICT DO NOTHING` and not a plain insert, and the difference is not stylistic. A unique
   * violation is a real PostgreSQL error: it aborts the surrounding transaction, so a caller could
   * not simply mint another token and try again — every later statement would fail with `25P02`.
   * `DO NOTHING` turns the collision into "no row", which the caller can act on inside the same
   * transaction.
   *
   * The collision is a theoretical event — thirty-two CSPRNG bytes — but `uq_sessions_refresh_hash`
   * is **global**, so if it ever surfaced as its own error code it would answer "some organization
   * already holds this digest", which is a cross-tenant oracle however improbable
   * (`docs/architecture/data-model.md`, «Про глобальность uq_sessions_refresh_hash»).
   */
  create(draft: SessionDraft): Promise<CreatedSession | null> {
    return this.run('create', async (tx) => {
      const rows = await tx.$queryRaw<{ id: string; created_at: Date }[]>`
        INSERT INTO sessions (organization_id, user_id, family_id, rotated_from_id,
                              refresh_token_hash, user_agent, ip_hash, ip_masked,
                              expires_at, updated_at)
        VALUES (${this.organizationId('create')}::uuid,
                ${draft.userId}::uuid,
                ${draft.familyId}::uuid,
                ${draft.rotatedFromId}::uuid,
                ${Buffer.from(draft.refreshTokenHash)},
                ${draft.userAgent},
                ${draft.ipHash},
                ${draft.ipMasked},
                ${draft.expiresAt},
                now())
        ON CONFLICT (refresh_token_hash) DO NOTHING
        RETURNING id, created_at`;

      const row = rows[0];

      return row === undefined ? null : { id: row.id, createdAt: row.created_at };
    });
  }

  async markRotated(sessionId: string, at: Date): Promise<boolean> {
    const updated = await this.run(
      'markRotated',
      (tx) =>
        tx.$executeRaw`
        UPDATE sessions
           SET revoked_at = ${at}, revoked_reason = 'ROTATED'::session_revoked_reason
         WHERE id = ${sessionId}::uuid
           AND revoked_at IS NULL`,
    );

    return updated > 0;
  }

  async revoke(sessionId: string, reason: SessionRevokedReason, at: Date): Promise<boolean> {
    const updated = await this.run(
      'revoke',
      (tx) =>
        tx.$executeRaw`
        UPDATE sessions
           SET revoked_at = ${at}, revoked_reason = ${reason}::session_revoked_reason
         WHERE id = ${sessionId}::uuid
           AND revoked_at IS NULL`,
    );

    return updated > 0;
  }

  revokeFamily(familyId: string, reason: SessionRevokedReason, at: Date): Promise<number> {
    return this.run(
      'revokeFamily',
      (tx) =>
        tx.$executeRaw`
        UPDATE sessions
           SET revoked_at = ${at}, revoked_reason = ${reason}::session_revoked_reason
         WHERE family_id = ${familyId}::uuid
           AND revoked_at IS NULL`,
    );
  }

  /**
   * Every live session of one person, with no exception — the password-reset case.
   *
   * Written as its own statement rather than as `revokeOtherFamilies` with an id that matches
   * nothing: that construction makes "close everything" depend on a value being *absent* from the
   * table, and a `family_id <> $2` predicate with a real id passed by mistake silently leaves a
   * session alive. Here there is nowhere to pass one.
   */
  revokeAllFamilies(userId: string, reason: SessionRevokedReason, at: Date): Promise<number> {
    return this.run('revokeAllFamilies', async (tx) => {
      const rows = await tx.$queryRaw<CountRow[]>`
        WITH revoked AS (
          UPDATE sessions
             SET revoked_at = ${at}, revoked_reason = ${reason}::session_revoked_reason
           WHERE user_id = ${userId}::uuid
             AND revoked_at IS NULL
        RETURNING family_id
        )
        SELECT count(DISTINCT family_id)::int AS count FROM revoked`;

      return rows[0]?.count ?? 0;
    });
  }

  revokeOtherFamilies(
    userId: string,
    keepFamilyId: string,
    reason: SessionRevokedReason,
    at: Date,
  ): Promise<number> {
    return this.run('revokeOtherFamilies', async (tx) => {
      const rows = await tx.$queryRaw<CountRow[]>`
        WITH revoked AS (
          UPDATE sessions
             SET revoked_at = ${at}, revoked_reason = ${reason}::session_revoked_reason
           WHERE user_id = ${userId}::uuid
             AND family_id <> ${keepFamilyId}::uuid
             AND revoked_at IS NULL
        RETURNING family_id
        )
        SELECT count(DISTINCT family_id)::int AS count FROM revoked`;

      return rows[0]?.count ?? 0;
    });
  }

  findOwner(sessionId: string): Promise<SessionOwnerRecord | null> {
    return this.run('findOwner', async (tx) => {
      const row = await tx.session.findUnique({
        where: { id: sessionId },
        select: { id: true, userId: true, familyId: true },
      });

      return row;
    });
  }

  findAuthContext(sessionId: string): Promise<SessionAuthContext | null> {
    return this.run('findAuthContext', async (tx) => {
      const rows = await tx.$queryRaw<AuthContextRow[]>`
        SELECT s.id            AS session_id,
               s.user_id       AS user_id,
               s.family_id     AS family_id,
               s.revoked_at    AS revoked_at,
               s.expires_at    AS expires_at,
               u.status::text  AS user_status,
               u.permissions_version AS permissions_version
          FROM sessions s
          JOIN users u ON u.organization_id = s.organization_id AND u.id = s.user_id
         WHERE s.id = ${sessionId}::uuid
           AND u.deleted_at IS NULL`;

      const row = rows[0];

      return row === undefined
        ? null
        : {
            sessionId: row.session_id,
            userId: row.user_id,
            familyId: row.family_id,
            revokedAt: row.revoked_at,
            expiresAt: row.expires_at,
            userStatus: row.user_status,
            permissionsVersion: row.permissions_version,
          };
    });
  }

  /**
   * The live sessions of one person, one row per family.
   *
   * `started_at` is a **correlated** subquery over the family of each returned row, not an
   * aggregation over the user's whole history joined back. Both answer the same thing, and the
   * difference is what the cost follows. Nothing ever deletes a session row — a rotation writes a
   * new one and revokes the old — so a fifteen-minute access token leaves roughly ninety-six rows
   * per device per day and there is no cleanup job yet (STORY-006-04, «Что осталось»). Grouping over
   * every row of the user meant a month-old account with three devices aggregated several thousand
   * rows to return three, and the number grew every day the account existed. This form runs one
   * index lookup per *live device* against `idx_sessions_org_user_family`.
   *
   * The subquery deliberately does not filter `revoked_at IS NULL`: the oldest row of a live family
   * is the original sign-in, and a rotation revoked it. "When did this device sign in" is a question
   * only the revoked rows can answer.
   */
  listActive(userId: string, now: Date): Promise<readonly ActiveSession[]> {
    return this.run('listActive', async (tx) => {
      const rows = await tx.$queryRaw<ActiveSessionRow[]>`
        SELECT s.id,
               s.family_id,
               (SELECT min(f.created_at)
                  FROM sessions f
                 WHERE f.user_id = s.user_id
                   AND f.family_id = s.family_id) AS started_at,
               s.created_at AS last_used_at,
               s.expires_at,
               s.user_agent,
               s.ip_masked
          FROM sessions s
         WHERE s.user_id = ${userId}::uuid
           AND s.revoked_at IS NULL
           AND s.expires_at > ${now}
         ORDER BY s.created_at DESC`;

      return rows.map((row) => ({
        id: row.id,
        familyId: row.family_id,
        startedAt: row.started_at,
        lastUsedAt: row.last_used_at,
        expiresAt: row.expires_at,
        userAgent: row.user_agent,
        ipMasked: row.ip_masked,
      }));
    });
  }
}
