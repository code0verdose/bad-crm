import {
  type DependencyReport,
  type ReadinessProbePort,
} from '@/application/platform/ports/readiness-probe.port.js';
import { type DbRoleProbeClient } from '@/infrastructure/persistence/prisma/assert-db-role.util.js';

/** The name this dependency appears under in the `/ready` body. */
export const DATABASE_DEPENDENCY = 'postgres';

/**
 * Can this instance reach the database it serves requests through?
 *
 * The endpoint answered without asking that question until now: `/ready` probed the `app_auth` pool
 * and the optional services, and with Postgres unreachable the process still answered 200 and kept
 * its place in the load balancer's rotation while every request inside it failed. An instance that
 * cannot reach its database has nothing to serve.
 *
 * `SELECT 1` and nothing more. Readiness asks whether the pool answers; a query that touched a table
 * would also be asserting that migrations ran, which is a different question with its own answer.
 *
 * **The rejection is deliberately not caught.** `CheckReadinessUseCase` turns a throwing probe into
 * `down` and writes the exception to the log — and the split matters, because a driver error quotes
 * the connection string, password and all, and `/ready` is unauthenticated. Catching it here would
 * give the same verdict while losing the one copy of the reason an operator has.
 */
export const databaseReadinessProbe = (client: DbRoleProbeClient): ReadinessProbePort => ({
  dependency: DATABASE_DEPENDENCY,
  check: async (): Promise<DependencyReport> => {
    await client.$queryRaw`SELECT 1`;

    return { status: 'up' };
  },
});
