import { type PrismaClient } from '@prisma/client';

import {
  type AuthLookupPort,
  type AuthSessionRecord,
  type AuthUserRecord,
} from '@/application/identity/ports/auth-lookup.port.js';

interface AuthUserRow {
  readonly user_id: string;
  readonly email: string;
  readonly locale: string;
  readonly timezone: string;
  readonly organization_id: string;
  readonly organization_name: string;
  readonly organization_slug: string;
  readonly password_hash: string;
  readonly status: string;
  readonly permissions_version: number;
}

interface AuthSessionRow {
  readonly session_id: string;
  readonly user_id: string;
  readonly organization_id: string;
  readonly family_id: string;
  readonly revoked_at: Date | null;
  readonly revoked_reason: string | null;
  readonly expires_at: Date;
}

const toUser = (row: AuthUserRow): AuthUserRecord => ({
  userId: row.user_id,
  email: row.email,
  locale: row.locale,
  timezone: row.timezone,
  organizationId: row.organization_id,
  organizationName: row.organization_name,
  organizationSlug: row.organization_slug,
  passwordHash: row.password_hash,
  status: row.status,
  permissionsVersion: row.permissions_version,
});

/**
 * The org-less path, and the only module in this codebase that speaks to `app_auth`.
 *
 * Every statement here is a call to a named function with a fixed signature — never a query this
 * adapter composes. That is the property the whole design rests on. The reading that crosses
 * organizations happens *inside* those functions, which are `SECURITY DEFINER` and execute as
 * `app_auth_definer` — a NOLOGIN role with `BYPASSRLS` and `SELECT` on exactly three tables.
 * `app_auth`, the role this connection uses, has neither: no `BYPASSRLS` and no privilege on any
 * table, so there is nothing else it can ask (`docs/security/rls-design.md`, «Особые пути»).
 *
 * The three functions are `auth_lookup_users_by_email`, `auth_lookup_user` and
 * `auth_lookup_session`, created by the migration that also sets their owner, revokes `EXECUTE` from
 * `PUBLIC` and grants it to `app_auth` alone; `prisma/sql/01-grants.sql` re-applies all three after
 * a restore, which is the fail-open case a table does not have.
 */
export class PrismaAuthLookup implements AuthLookupPort {
  constructor(private readonly client: PrismaClient) {}

  async findUsersByEmail(email: string): Promise<readonly AuthUserRecord[]> {
    const rows = await this.client.$queryRaw<AuthUserRow[]>`
      SELECT * FROM auth_lookup_users_by_email(${email}::citext)`;

    return rows.map(toUser);
  }

  async findUserByEmailAndSlug(
    email: string,
    organizationSlug: string,
  ): Promise<AuthUserRecord | null> {
    const rows = await this.client.$queryRaw<AuthUserRow[]>`
      SELECT * FROM auth_lookup_user(${email}::citext, ${organizationSlug})`;

    const row = rows[0];

    return row === undefined ? null : toUser(row);
  }

  async findSessionByRefreshHash(refreshTokenHash: Uint8Array): Promise<AuthSessionRecord | null> {
    const rows = await this.client.$queryRaw<AuthSessionRow[]>`
      SELECT * FROM auth_lookup_session(${Buffer.from(refreshTokenHash)})`;

    const row = rows[0];

    return row === undefined
      ? null
      : {
          sessionId: row.session_id,
          userId: row.user_id,
          organizationId: row.organization_id,
          familyId: row.family_id,
          revokedAt: row.revoked_at,
          revokedReason: row.revoked_reason,
          expiresAt: row.expires_at,
        };
  }
}
