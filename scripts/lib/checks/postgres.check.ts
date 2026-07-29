import { maskUrl, type PostgresTarget } from '../connection-target.util.js';
import type { CheckOutcome, ServiceCheck } from '../service-check.types.js';

/**
 * What "PostgreSQL is usable" means for Bad CRM.
 *
 * The container healthcheck answers `pg_isready`, which is true of an empty cluster with no
 * extensions and no roles. The three failures that actually stop a developer are invisible to it:
 * a volume initialised before an extension was added, a bootstrap that never ran, and — the
 * expensive one — `app_user` carrying BYPASSRLS, where every query works and tenant isolation is
 * silently gone (CLAUDE.md, invariant 1).
 */

/** Kept in step with `packages/server/prisma/sql/initdb/01-extensions.sql`. */
export const REQUIRED_EXTENSIONS = [
  'btree_gist',
  'citext',
  'pg_trgm',
  'pgcrypto',
  'vector',
] as const;

export interface RoleExpectation {
  readonly role: string;
  /** `docs/security/rls-design.md`: only the backup role and the function owner may bypass RLS. */
  readonly bypassRls: boolean;
  /** `app_auth_definer` is NOLOGIN by design: its privileges are reachable only through functions. */
  readonly canLogin: boolean;
  readonly why: string;
}

/**
 * The five roles of `docs/security/rls-design.md`, in the shape a preflight can check.
 *
 * `app_auth_definer` is on this list because leaving it off was not a cosmetic omission: it is the
 * role `20260729120000_auth_owner_and_lookup_functions` transfers ownership to, so on a cluster
 * without it the very next `prisma migrate deploy` fails with `P3018` — and the preflight, which
 * exists to catch exactly that class of "the bootstrap never ran here", reported everything in
 * order. `test/infra/role-canon.test.ts` holds this table against the bootstrap SQL and the design
 * document so the three cannot drift again.
 */
export const EXPECTED_ROLES: readonly RoleExpectation[] = [
  {
    role: 'app_migrator',
    bypassRls: false,
    canLogin: true,
    why: 'owns the schema, runs migrations',
  },
  { role: 'app_user', bypassRls: false, canLogin: true, why: 'serves requests under RLS' },
  {
    role: 'app_auth',
    bypassRls: false,
    canLogin: true,
    why: 'holds EXECUTE on the three resolvers and no privilege on any table',
  },
  {
    role: 'app_auth_definer',
    bypassRls: true,
    canLogin: false,
    why: 'owns the SECURITY DEFINER resolvers, whose bodies run with its privileges',
  },
  {
    role: 'backup_role',
    bypassRls: true,
    canLogin: true,
    why: 'pg_dump under FORCE ROW LEVEL SECURITY',
  },
];

export interface RoleFact {
  readonly rolname: string;
  readonly rolbypassrls: boolean;
  readonly rolsuper: boolean;
  readonly rolcanlogin: boolean;
}

export interface PostgresFacts {
  readonly currentUser: string;
  readonly extensions: readonly string[];
  readonly roles: readonly RoleFact[];
}

const BOOTSTRAP_REMEDY =
  're-apply the roles with `pnpm db:bootstrap` (packages/server/prisma/sql/00-bootstrap-roles.sql)';
const RESET_REMEDY =
  'extensions are created only on an empty pgdata volume — recreate it with `pnpm docker:reset` ' +
  '(this deletes local data), or run prisma/sql/initdb/01-extensions.sql by hand as the superuser';

export const interpretPostgres = (facts: PostgresFacts): CheckOutcome => {
  const problems: string[] = [];
  const details: string[] = [`connected as ${facts.currentUser}`];

  const missingExtensions = REQUIRED_EXTENSIONS.filter((name) => !facts.extensions.includes(name));

  if (missingExtensions.length > 0) {
    problems.push(`missing extension(s): ${missingExtensions.join(', ')}`);
  } else {
    details.push(`extensions present: ${REQUIRED_EXTENSIONS.join(', ')}`);
  }

  const roleProblems = EXPECTED_ROLES.flatMap((expected) => {
    const actual = facts.roles.find((role) => role.rolname === expected.role);

    if (actual === undefined) return [`role ${expected.role} does not exist (${expected.why})`];

    const issues: string[] = [];

    if (actual.rolbypassrls !== expected.bypassRls) {
      issues.push(
        expected.bypassRls
          ? `role ${expected.role} lost BYPASSRLS — ${expected.why} needs it`
          : `role ${expected.role} has BYPASSRLS — it must not: ${expected.why}`,
      );
    }
    if (actual.rolsuper) issues.push(`role ${expected.role} is SUPERUSER — it must not be`);

    if (actual.rolcanlogin !== expected.canLogin) {
      issues.push(
        expected.canLogin
          ? `role ${expected.role} cannot LOGIN`
          : `role ${expected.role} can LOGIN — it must not: ${expected.why}`,
      );
    }

    return issues;
  });

  if (roleProblems.length > 0) {
    problems.push(...roleProblems);
  } else {
    details.push(
      `roles present with the expected attributes: ${EXPECTED_ROLES.map((role) => role.role).join(', ')}`,
    );
  }

  if (problems.length === 0) return { status: 'ok', details };

  return {
    status: 'failed',
    details: [...details, ...problems],
    remedy: missingExtensions.length > 0 ? RESET_REMEDY : BOOTSTRAP_REMEDY,
  };
};

/** One row per column value, as `pg` returns it. */
export type PostgresQuery = (sql: string) => Promise<Record<string, unknown>[]>;

export const CURRENT_USER_SQL = 'SELECT current_user AS name';
export const EXTENSIONS_SQL = 'SELECT extname AS name FROM pg_extension ORDER BY extname';
export const ROLES_SQL = `SELECT rolname, rolbypassrls, rolsuper, rolcanlogin
                          FROM   pg_roles
                          WHERE  rolname LIKE 'app\\_%' OR rolname = 'backup_role'
                          ORDER  BY rolname`;

export const collectPostgresFacts = async (query: PostgresQuery): Promise<PostgresFacts> => {
  const [user] = await query(CURRENT_USER_SQL);
  const extensions = await query(EXTENSIONS_SQL);
  const roles = await query(ROLES_SQL);

  return {
    currentUser: String(user?.['name'] ?? 'unknown'),
    extensions: extensions.map((row) => String(row['name'])),
    roles: roles.map((row) => ({
      rolname: String(row['rolname']),
      rolbypassrls: row['rolbypassrls'] === true,
      rolsuper: row['rolsuper'] === true,
      rolcanlogin: row['rolcanlogin'] === true,
    })),
  };
};

/**
 * A connection that never opened, diagnosed by SQLSTATE rather than by the message text.
 *
 * The message is localised by the server: the very first live run of this script against a stray
 * host PostgreSQL answered `роль "app_user" не существует`, which no English regexp would match.
 * SQLSTATE is defined by the standard and is the same in every locale.
 */
export interface PostgresConnectionError {
  readonly code?: string | undefined;
  readonly message: string;
}

const CONNECTION_DIAGNOSES: Record<string, { detail: string; remedy: string }> = {
  // invalid_authorization_specification — most often "role does not exist".
  '28000': {
    detail:
      'the server rejected the role in DATABASE_URL: it does not exist on the server answering this port',
    remedy: `${BOOTSTRAP_REMEDY}; if the roles do exist in the container, DATABASE_URL is reaching a different PostgreSQL — compare \`docker compose port postgres 5432\` with the port in .env`,
  },
  // invalid_password
  '28P01': {
    detail: 'the server rejected the password in DATABASE_URL',
    remedy: `the role password and .env drifted apart — ${BOOTSTRAP_REMEDY}, which re-applies the passwords from .env to an existing volume`,
  },
  // invalid_catalog_name
  '3D000': {
    detail: 'the database named in DATABASE_URL does not exist on this server',
    remedy: `${BOOTSTRAP_REMEDY} — it creates the database when it is missing`,
  },
  ECONNREFUSED: {
    detail: 'nothing is listening on the port in DATABASE_URL',
    remedy: 'start the development services with `pnpm docker:up`',
  },
  ETIMEDOUT: {
    detail: 'the port in DATABASE_URL accepted nothing within the timeout',
    remedy: 'check that POSTGRES_PORT in .env matches `docker compose port postgres 5432`',
  },
};

export const interpretPostgresError = (error: PostgresConnectionError): CheckOutcome => {
  const diagnosis = error.code === undefined ? undefined : CONNECTION_DIAGNOSES[error.code];

  return {
    status: 'failed',
    details: diagnosis === undefined ? [error.message] : [error.message, diagnosis.detail],
    remedy:
      diagnosis?.remedy ??
      'see docs/runbooks/local-environment.md, «PostgreSQL» — it lists the four failures that produce this',
  };
};

const asConnectionError = (error: unknown): PostgresConnectionError => ({
  code:
    typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : undefined,
  message: error instanceof Error ? error.message : String(error),
});

export const createPostgresCheck = (options: {
  readonly databaseUrl: string;
  readonly target: PostgresTarget;
  readonly withConnection: <T>(run: (query: PostgresQuery) => Promise<T>) => Promise<T>;
}): ServiceCheck => ({
  service: 'postgres',
  requirement: 'required',
  target: maskUrl(options.databaseUrl),
  run: async () => {
    try {
      return interpretPostgres(await options.withConnection(collectPostgresFacts));
    } catch (error) {
      return interpretPostgresError(asConnectionError(error));
    }
  },
});
