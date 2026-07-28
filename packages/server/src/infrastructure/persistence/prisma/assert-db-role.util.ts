import { type PrismaClient } from '@prisma/client';

/**
 * The startup check that decides whether row level security is in force at all.
 *
 * Every policy in this codebase filters rows for one role — `app_user` — and does nothing for a
 * connection that is not subject to it. A superuser and a `BYPASSRLS` role skip policies outright;
 * the owner of the schema skips them on any table that is missing `FORCE ROW LEVEL SECURITY`; a
 * role that can `SET ROLE app_migrator` is one statement away from becoming that owner. None of
 * this is observable from the application: every query succeeds, every isolation test passes
 * against a correctly configured database, and on the misconfigured installation the rows of every
 * organization are readable through the ordinary API.
 *
 * A wrong `DATABASE_URL` is not exotic — it is the single likeliest way this installation loses
 * tenant isolation, because the same connection string is used for migrations, for psql and for
 * restore procedures. So the process refuses to open its port instead of serving from it
 * (docs/security/rls-design.md, «Почему приложение не ходит под владельцем»).
 */

/** The one role the runtime is allowed to connect as. */
export const RUNTIME_DB_ROLE = 'app_user';

/** Owns the schema and every table; used by `prisma migrate deploy` and by nothing else. */
export const OWNER_DB_ROLE = 'app_migrator';

/** What the catalog says about the connection the application just made. */
export interface DbRoleFacts {
  readonly role: string;
  readonly isSuperuser: boolean;
  readonly bypassesRls: boolean;
  readonly ownsSchema: boolean;
  readonly canBecomeOwner: boolean;
}

/** The row shape of the probe, as PostgreSQL returns it. */
interface DbRoleRow {
  readonly role: string;
  readonly is_superuser: boolean;
  readonly bypasses_rls: boolean;
  readonly owns_schema: boolean;
  readonly can_become_owner: boolean;
}

export class UnsafeDatabaseRoleError extends Error {
  readonly reasons: readonly string[];

  constructor(reasons: readonly string[]) {
    super(
      `The database role this process connected as cannot be trusted with tenant isolation:\n${reasons
        .map((reason) => `  - ${reason}`)
        .join(
          '\n',
        )}\nCheck DATABASE_URL: the runtime connects as ${RUNTIME_DB_ROLE}, migrations as ${OWNER_DB_ROLE}.`,
    );
    this.name = 'UnsafeDatabaseRoleError';
    this.reasons = reasons;
  }
}

/**
 * Every reason this connection must not serve traffic, in one list.
 *
 * All of them, not the first one: a misconfigured installation usually has several at once — a
 * `DATABASE_URL` pointing at the owner is also a role that owns the schema — and an operator who
 * fixes them one restart at a time learns about the second problem after deploying the first fix.
 */
export const databaseRoleViolations = (facts: DbRoleFacts): string[] => {
  const violations: string[] = [];

  if (facts.role !== RUNTIME_DB_ROLE) {
    violations.push(
      `expected the role ${RUNTIME_DB_ROLE}, got ${facts.role} — ${OWNER_DB_ROLE} and every other role is for maintenance, not for the runtime`,
    );
  }

  if (facts.isSuperuser) {
    violations.push('the role is a superuser, and no row level security policy applies to it');
  }

  if (facts.bypassesRls) {
    violations.push('the role has BYPASSRLS — the tenant policies are not applied to its queries');
  }

  if (facts.ownsSchema) {
    violations.push(
      'the role owns schema public: a table that ever ships without FORCE ROW LEVEL SECURITY is unfiltered for it',
    );
  }

  if (facts.canBecomeOwner) {
    violations.push(
      `the role may SET ROLE ${OWNER_DB_ROLE}, so its isolation lasts exactly until one statement says otherwise`,
    );
  }

  return violations;
};

/**
 * The narrow slice of `PrismaClient` this module needs, so the branches above can be exercised
 * without a database.
 */
export type DbRoleProbeClient = Pick<PrismaClient, '$queryRaw'>;

/**
 * Reads the facts out of the catalog and refuses to return on an unsafe connection.
 *
 * `to_regrole` rather than a literal cast: on a database where the bootstrap never created
 * `app_migrator` the cast raises `42704` and the process would die with "role does not exist"
 * instead of the answer it asked for. `to_regrole` yields NULL there, `pg_has_role` yields NULL in
 * turn, and `COALESCE` reads that as "cannot become the owner" — which is true.
 */
export const assertRuntimeDbRole = async (client: DbRoleProbeClient): Promise<DbRoleFacts> => {
  const rows = await client.$queryRaw<DbRoleRow[]>`
    SELECT current_user::text                                     AS role,
           r.rolsuper                                             AS is_superuser,
           r.rolbypassrls                                         AS bypasses_rls,
           pg_catalog.pg_get_userbyid(n.nspowner) = current_user  AS owns_schema,
           COALESCE(
             pg_catalog.pg_has_role(current_user, to_regrole(${OWNER_DB_ROLE}), 'MEMBER'),
             false
           )                                                      AS can_become_owner
      FROM pg_catalog.pg_roles r
      JOIN pg_catalog.pg_namespace n ON n.nspname = 'public'
     WHERE r.rolname = current_user`;

  const row = rows[0];

  // No row is not a pass. `pg_roles` is world-readable, so an empty answer means the probe did not
  // run the way this module believes it does — and "no facts" must never read as "no problems".
  if (row === undefined) {
    throw new UnsafeDatabaseRoleError([
      'the catalog returned no row for the current role, so nothing about this connection could be verified',
    ]);
  }

  const facts: DbRoleFacts = {
    role: row.role,
    isSuperuser: row.is_superuser,
    bypassesRls: row.bypasses_rls,
    ownsSchema: row.owns_schema,
    canBecomeOwner: row.can_become_owner,
  };

  const violations = databaseRoleViolations(facts);

  if (violations.length > 0) throw new UnsafeDatabaseRoleError(violations);

  return facts;
};
