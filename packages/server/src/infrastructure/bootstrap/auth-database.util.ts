import {
  type DependencyReport,
  type ReadinessProbePort,
} from '@/application/platform/ports/readiness-probe.port.js';
import {
  OWNER_DB_ROLE,
  RUNTIME_DB_ROLE,
  UnsafeDatabaseRoleError,
  type DbRoleProbeClient,
} from '@/infrastructure/persistence/prisma/assert-db-role.util.js';

/**
 * The startup check and the readiness probe of the **second** pool — the one `DATABASE_AUTH_URL`
 * opens.
 *
 * `assert-db-role.util.ts` next door asks the same question of the runtime pool and refuses to
 * return on a connection that can escape row-level security. That check was never applied here, and
 * the gap is not symmetrical noise: this is the connection that bypasses the policies *by design*,
 * so the only thing keeping it narrow is which role it is. A `DATABASE_AUTH_URL` pointing at
 * `app_migrator` or at a superuser produces no error anywhere — every sign-in works, and the
 * authentication path quietly runs with full write privileges over every organization's tables.
 *
 * Prisma connects lazily, so without a check at startup the first connection is made by the first
 * person to sign in: a wrong password in the URL becomes a 503 hours after the deploy, in the one
 * operation nobody can work around.
 */

/** The one role `DATABASE_AUTH_URL` may connect as (`prisma/sql/00-bootstrap-roles.sql`). */
export const AUTH_DB_ROLE = 'app_auth';

/** The key the second pool appears under in `/ready` and in the startup degradation summary. */
export const AUTH_DEPENDENCY = 'authentication';

/** What the catalog says about the connection the authentication pool just made. */
export interface AuthDbRoleFacts {
  readonly role: string;
  readonly isSuperuser: boolean;
  readonly ownsSchema: boolean;
  readonly canBecomeOwner: boolean;
  readonly canBecomeRuntime: boolean;
  /**
   * Whether the role itself bypasses row-level security.
   *
   * It must not: the attribute lives on the NOLOGIN owner of the resolvers, not on the role that
   * connects. Read here because an installation upgraded without the role bootstrap keeps whatever
   * attribute it had before, and nothing else would notice.
   */
  readonly bypassesRowLevelSecurity: boolean;
  /**
   * Whether this role can `SELECT` from `users` without going through a resolver.
   *
   * The whole claim of `docs/security/rls-design.md` («Особые пути») is that the credential behind
   * `DATABASE_AUTH_URL` holds no table privilege at all — its reachable surface is three
   * `SECURITY DEFINER` functions owned by a NOLOGIN role. A connection that can read `users` on its
   * own is a credential that dumps every account of every organization, whatever its name is.
   */
  readonly readsAccountsDirectly: boolean;
}

/** The row shape of the probe, as PostgreSQL returns it. */
interface AuthDbRoleRow {
  readonly role: string;
  readonly is_superuser: boolean;
  readonly owns_schema: boolean;
  readonly can_become_owner: boolean;
  readonly can_become_runtime: boolean;
  readonly bypasses_row_level_security: boolean;
  readonly reads_accounts_directly: boolean;
}

/**
 * Every reason this connection must not serve the authentication path, in one list.
 *
 * All of them at once, for the same reason as the runtime check: a misconfigured installation
 * usually has several, and an operator who fixes them one restart at a time learns about the second
 * problem after deploying the first fix.
 *
 * `BYPASSRLS` **is** a violation here, and this comment used to say the opposite. The attribute
 * belongs to `app_auth_definer`, the `NOLOGIN` role the function bodies execute as; the role behind
 * `DATABASE_AUTH_URL` is `NOBYPASSRLS`, so a leaked credential opens nothing on its own. Checking it
 * matters for one concrete case: an installation upgraded without the role bootstrap step keeps the
 * old attribute, the second line of defence is silently absent, and `/ready` is green.
 */
export const authDatabaseRoleViolations = (facts: AuthDbRoleFacts): string[] => {
  const violations: string[] = [];

  if (facts.role !== AUTH_DB_ROLE) {
    violations.push(
      `expected the role ${AUTH_DB_ROLE}, got ${facts.role} — DATABASE_AUTH_URL is the org-less authentication path and nothing else`,
    );
  }

  if (facts.isSuperuser) {
    violations.push(
      'the role is a superuser: the authentication path would run with unrestricted write access to every table',
    );
  }

  if (facts.ownsSchema) {
    violations.push(
      'the role owns schema public, so it can alter or drop the resolvers it is supposed to be limited to',
    );
  }

  if (facts.canBecomeOwner) {
    violations.push(
      `the role may SET ROLE ${OWNER_DB_ROLE}, so its narrowness lasts exactly until one statement says otherwise`,
    );
  }

  if (facts.canBecomeRuntime) {
    violations.push(
      `the role may SET ROLE ${RUNTIME_DB_ROLE}, which combines BYPASSRLS with the runtime's table privileges`,
    );
  }

  if (facts.bypassesRowLevelSecurity) {
    violations.push(
      `the role has BYPASSRLS: the attribute belongs to ${OWNER_DB_ROLE}, the NOLOGIN owner the resolvers execute as, and a connectable role that carries it is one GRANT away from reading every organization`,
    );
  }

  if (facts.readsAccountsDirectly) {
    violations.push(
      'the role can read public.users directly: its reachable surface must be the three SECURITY DEFINER resolvers and nothing else',
    );
  }

  return violations;
};

/**
 * Reads the facts out of the catalog and refuses to return on an unsafe authentication connection.
 *
 * `to_regrole`/`to_regclass` rather than literal casts: on a database where the bootstrap never
 * created a role, or before the first migration created `users`, a cast raises `42704` and the
 * process would die with "role does not exist" instead of the answer it asked for. Both yield NULL
 * there, and `COALESCE` reads that as "no, it cannot" — which is true.
 */
export const assertAuthDatabaseRole = async (
  client: DbRoleProbeClient,
): Promise<AuthDbRoleFacts> => {
  const rows = await client.$queryRaw<AuthDbRoleRow[]>`
    SELECT current_user::text                                     AS role,
           r.rolsuper                                             AS is_superuser,
           r.rolbypassrls                                         AS bypasses_row_level_security,
           pg_catalog.pg_get_userbyid(n.nspowner) = current_user  AS owns_schema,
           COALESCE(
             pg_catalog.pg_has_role(current_user, to_regrole(${OWNER_DB_ROLE}), 'MEMBER'),
             false
           )                                                      AS can_become_owner,
           COALESCE(
             pg_catalog.pg_has_role(current_user, to_regrole(${RUNTIME_DB_ROLE}), 'MEMBER'),
             false
           )                                                      AS can_become_runtime,
           COALESCE(
             pg_catalog.has_table_privilege(current_user, to_regclass('public.users'), 'SELECT'),
             false
           )                                                      AS reads_accounts_directly
      FROM pg_catalog.pg_roles r
      JOIN pg_catalog.pg_namespace n ON n.nspname = 'public'
     WHERE r.rolname = current_user`;

  const row = rows[0];

  // No row is not a pass, exactly as in the runtime check: `pg_roles` is world-readable, so an
  // empty answer means the probe did not run the way this module believes it does.
  if (row === undefined) {
    throw new UnsafeDatabaseRoleError([
      'the catalog returned no row for the authentication role, so nothing about that connection could be verified',
    ]);
  }

  const facts: AuthDbRoleFacts = {
    role: row.role,
    isSuperuser: row.is_superuser,
    ownsSchema: row.owns_schema,
    canBecomeOwner: row.can_become_owner,
    canBecomeRuntime: row.can_become_runtime,
    bypassesRowLevelSecurity: row.bypasses_row_level_security,
    readsAccountsDirectly: row.reads_accounts_directly,
  };

  const violations = authDatabaseRoleViolations(facts);

  if (violations.length > 0) throw new UnsafeDatabaseRoleError(violations);

  return facts;
};

/**
 * A live `/ready` probe for the second pool, registered only when there is one.
 *
 * Live rather than `disabled`, and it therefore *does* change the HTTP status — the same reasoning
 * as Redis (`redis-readiness.adapter.ts`): with this pool unreachable nobody can sign in, so an
 * instance in that state belongs out of the load balancer's rotation rather than in it answering
 * 503 to every sign-in. An installation that never configured the pool is reported `disabled`
 * instead, by `optionalServiceProbes`, and that one does not change the status.
 *
 * A driver failure is **not** caught here. `CheckReadinessUseCase` already turns a throwing probe
 * into `down`, logs the exception and puts nothing of it in the body — which is the behaviour
 * required, since `/ready` is unauthenticated and a driver error quotes the connection string, and
 * the connection string quotes the password. Catching it here would answer the same thing while
 * losing the one copy of the reason an operator has.
 */
export const authDatabaseReadinessProbe = (client: DbRoleProbeClient): ReadinessProbePort => ({
  dependency: AUTH_DEPENDENCY,
  check: async (): Promise<DependencyReport> => {
    await client.$queryRaw`SELECT 1`;

    return { status: 'up' };
  },
});
