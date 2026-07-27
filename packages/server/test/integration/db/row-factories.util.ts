import { randomUUID } from 'node:crypto';

import { type PoolClient } from 'pg';

import { type TenantTableName } from '@/infrastructure/persistence/prisma/tenant-tables.constant.js';

/**
 * One row per tenant table, for the parameterised isolation suite.
 *
 * `satisfies Record<TenantTableName, RowFactory>` is the load-bearing part: a table added to the
 * registry without a factory here does not compile, so "the new table has no isolation test" cannot
 * happen quietly (docs/security/rls-design.md, «Генератор isolation-тестов»).
 */

export type RowFactory = (client: PoolClient, organizationId: string) => Promise<{ id: string }>;

const insert = async (
  client: PoolClient,
  sql: string,
  values: readonly unknown[],
): Promise<{ id: string }> => {
  const { rows } = await client.query<{ id: string }>(sql, [...values]);
  const row = rows[0];

  if (row === undefined) throw new Error(`insert returned no row: ${sql}`);

  return row;
};

export const ROW_FACTORIES = {
  /**
   * The tenant root: its id *is* the tenant, so the row is created with the organization id the
   * caller is acting as. Anything else could not pass `WITH CHECK` — which is exactly why the
   * application generates the id of a new organization and creates it inside `withTenant`
   * (docs/security/rls-design.md, «Особый случай: organizations»).
   */
  organizations: (client, organizationId) =>
    insert(
      client,
      `INSERT INTO organizations (id, slug, name, updated_at)
       VALUES ($1, $2, $3, now())
       RETURNING id`,
      [organizationId, `org-${organizationId.slice(0, 8)}-${randomUUID().slice(0, 8)}`, 'Acme'],
    ),

  teams: (client, organizationId) =>
    insert(
      client,
      `INSERT INTO teams (organization_id, name, slug, updated_at)
       VALUES ($1, $2, $3, now())
       RETURNING id`,
      [organizationId, 'Core', `core-${randomUUID().slice(0, 8)}`],
    ),
} satisfies Record<TenantTableName, RowFactory>;
