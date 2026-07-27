import { Client } from 'pg';

import type { PostgresQuery } from '../checks/postgres.check.js';

/**
 * A single short-lived `pg` connection opened with the application's own `DATABASE_URL`.
 *
 * `pg` and not Prisma on purpose: the point of the check is that the credentials and the role in
 * `DATABASE_URL` work against this cluster, and Prisma neither exists yet (EPIC-003) nor would
 * exercise `pg_roles` the way the RLS design requires (`docs/security/rls-design.md` uses the same
 * driver in its isolation tests for the same reason).
 */
export const withPostgresConnection = async <T>(
  connectionString: string,
  timeoutMs: number,
  run: (query: PostgresQuery) => Promise<T>,
): Promise<T> => {
  const client = new Client({ connectionString, connectionTimeoutMillis: timeoutMs });

  await client.connect();

  try {
    return await run(async (sql) => (await client.query(sql)).rows as Record<string, unknown>[]);
  } finally {
    await client.end();
  }
};
