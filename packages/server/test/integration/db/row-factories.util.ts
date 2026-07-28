import { randomBytes, randomUUID } from 'node:crypto';

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

/**
 * A user, and nothing that resembles a credential.
 *
 * `password_hash` gets a marker string rather than a real argon2id digest, and no column here holds
 * anything a reader could mistake for a password, a token or a secret — a fixture that looks like
 * one is a fixture that gets copied into a seed (CLAUDE.md, «Чувствительность данных»). The column
 * is exercised as a column; its content is the subject of no assertion.
 *
 * Declared beside the registry rather than inside it because `sessions` and `password_reset_tokens`
 * need a user of their own organization: a factory referring to `ROW_FACTORIES` from within the
 * object's own initialiser has no inferable type.
 */
const createUser: RowFactory = (client, organizationId) =>
  insert(
    client,
    `INSERT INTO users (organization_id, email, password_hash, status, updated_at)
       VALUES ($1, $2, $3, 'ACTIVE', now())
       RETURNING id`,
    [
      organizationId,
      `member-${randomUUID().slice(0, 8)}@example.test`,
      'placeholder-not-a-credential',
    ],
  );

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

  users: createUser,

  /**
   * A session needs a user of the same organization, so the factory makes one: the composite
   * foreign key `(organization_id, user_id)` refuses a user from anywhere else, which is the point
   * of the key and the reason a shared fixture user would weaken the test.
   *
   * `refresh_token_hash` is 32 random bytes — the shape of a SHA-256 digest, generated per row so
   * the globally unique index is exercised rather than tripped.
   */
  sessions: async (client, organizationId) => {
    const user = await createUser(client, organizationId);

    return insert(
      client,
      `INSERT INTO sessions
         (organization_id, user_id, family_id, refresh_token_hash, user_agent, ip_hash, ip_masked,
          expires_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now() + interval '30 days', now())
       RETURNING id`,
      [
        organizationId,
        user.id,
        randomUUID(),
        randomBytes(32),
        'integration-suite',
        randomBytes(32).toString('hex'),
        // The shape the masking function produces, not an address: `203.0.113.0/24` is the
        // documentation range with its host half already gone (RFC 5737).
        '203.0.113.0/24',
      ],
    );
  },

  password_reset_tokens: async (client, organizationId) => {
    const user = await createUser(client, organizationId);

    return insert(
      client,
      `INSERT INTO password_reset_tokens
         (organization_id, user_id, token_hash, expires_at, updated_at)
       VALUES ($1, $2, $3, now() + interval '60 minutes', now())
       RETURNING id`,
      [organizationId, user.id, randomBytes(32)],
    );
  },

  teams: (client, organizationId) =>
    insert(
      client,
      `INSERT INTO teams (organization_id, name, slug, updated_at)
       VALUES ($1, $2, $3, now())
       RETURNING id`,
      [organizationId, 'Core', `core-${randomUUID().slice(0, 8)}`],
    ),
} satisfies Record<TenantTableName, RowFactory>;
