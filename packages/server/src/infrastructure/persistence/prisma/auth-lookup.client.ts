import { PrismaClient } from '@prisma/client';

/**
 * The second, deliberately tiny pool: the `app_auth` role.
 *
 * `app_auth` holds **no table privileges at all** — `prisma/sql/01-grants.sql` grants tables to
 * `app_user`, `backup_role` and the NOLOGIN function owner, and to nobody else. Its entire reachable
 * surface is the three `SECURITY DEFINER` functions of the authentication path, each with a fixed
 * signature and each returning only the columns one decision needs. A `SELECT * FROM users` over
 * this connection is refused by PostgreSQL with `permission denied`, which is what makes the path
 * narrow rather than merely intended to be — asserted in
 * `test/integration/db/auth-lookup-path.test.ts`.
 *
 * `app_auth` itself is **NOBYPASSRLS**, and that is not a detail. Row-level security is bypassed by
 * `app_auth_definer`, the NOLOGIN role the three functions execute as; the role behind
 * `DATABASE_AUTH_URL` needs no such attribute, because it reaches no table to apply a policy to.
 * Leaving `BYPASSRLS` on it would change no result today and would turn the first `GRANT` anybody
 * ever writes against this role into a read across every organization
 * (`packages/server/prisma/sql/00-bootstrap-roles.sql`, «app_auth»).
 *
 * A separate `PrismaClient` and not a second datasource on the main one, because the two must not
 * share a pool: the connection that can reach the privileged resolvers has to be the one nothing
 * else can pick up by accident. It is small — the auth path is three statements per sign-in — and
 * it is closed with the rest at shutdown.
 */
export const createAuthLookupClient = (url: string): PrismaClient =>
  new PrismaClient({
    datasourceUrl: url,
    // No query log. The statements this client sends carry an email address and the digest of a
    // refresh token as bind parameters, and both are things `CLAUDE.md` forbids writing to a log.
    log: [],
  });
