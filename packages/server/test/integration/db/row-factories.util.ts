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
const createRole = (client: PoolClient, organizationId: string): Promise<{ id: string }> =>
  insert(
    client,
    `INSERT INTO roles (organization_id, key, name, updated_at)
       VALUES ($1, $2, $3, now())
       RETURNING id`,
    [organizationId, `role-${randomUUID().slice(0, 8)}`, 'Fixture role'],
  );

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
   * One audit entry, written the way the application writes them — through the **parent** table.
   *
   * That is not a shortcut: `app_user` holds no privilege on any partition leaf, and a query against
   * the parent applies the parent's policy to every partition it touches while checking privileges
   * on the parent alone. A fixture that addressed a leaf directly would be testing something the
   * product never does, and would fail on a privilege rather than on isolation.
   *
   * `occurred_at` is left to its default so the row lands in the partition for the current month —
   * the one the migration created and the one the job keeps ahead.
   */
  audit_logs: (client, organizationId) =>
    insert(
      client,
      `INSERT INTO audit_logs
         (organization_id, actor_type, action, resource_type, request_id, severity)
       VALUES ($1, 'SYSTEM', 'fixture.created', 'FIXTURE', $2, 'INFO')
       RETURNING id`,
      [organizationId, `fixture-${randomUUID()}`],
    ),

  /**
   * The tenant root: its id *is* the tenant, so the row is created with the organization id the
   * caller is acting as. Anything else could not pass `WITH CHECK` — which is exactly why the
   * application generates the id of a new organization and creates it inside `withTenant`
   * (docs/security/rls-design.md, «Особый случай: organizations»).
   */
  organizations: (client, organizationId) => {
    // Two rows in one statement, the same way `OrganizationRepositoryPort.createWithOwner` does it:
    // `owner_id` is NOT NULL and points at a user of this organization, while the user points back, so
    // neither insert can go first. Foreign keys are `AFTER ROW` triggers evaluated when the statement
    // ends, and by then both rows exist. A fixture that took a shortcut here would be a fixture that
    // does not exercise the constraint the product lives under.
    const ownerId = randomUUID();

    return insert(
      client,
      `WITH created_organization AS (
         INSERT INTO organizations (id, owner_id, slug, name, updated_at)
         VALUES ($1, $2, $3, $4, now())
         RETURNING id
       )
       INSERT INTO users (id, organization_id, email, password_hash, status, updated_at)
       VALUES ($2, $1, $5, 'placeholder-not-a-credential', 'ACTIVE', now())
       RETURNING organization_id AS id`,
      [
        organizationId,
        ownerId,
        `org-${organizationId.slice(0, 8)}-${randomUUID().slice(0, 8)}`,
        'Acme',
        `owner-${ownerId.slice(0, 8)}@example.test`,
      ],
    );
  },

  users: createUser,

  /**
   * A role of one organization. `key` is unique per organization, so it is randomised: the isolation
   * suite creates rows for two tenants and a fixed key would fail on the second for a reason that
   * has nothing to do with isolation.
   */
  roles: (client, organizationId) =>
    insert(
      client,
      `INSERT INTO roles (organization_id, key, name, updated_at)
         VALUES ($1, $2, $3, now())
         RETURNING id`,
      [organizationId, `role-${randomUUID().slice(0, 8)}`, 'Fixture role'],
    ),

  /**
   * A grant needs a role of the same organization **and** a permission that exists in the catalogue.
   *
   * The catalogue is seeded by the container setup, the way `pnpm db:seed:permissions` seeds an
   * installation — not here. The fixture used to insert the key itself and failed the moment it ran
   * as the tenant: `app_user` may read the catalogue and never write it, which is the whole point of
   * the table being global.
   */
  role_permissions: async (client, organizationId) => {
    const role = await createRole(client, organizationId);

    return insert(
      client,
      `INSERT INTO role_permissions (organization_id, role_id, permission_key, updated_at)
         VALUES ($1, $2, 'task:read', now())
         RETURNING id`,
      [organizationId, role.id],
    );
  },

  /**
   * An invitation needs the person who sent it, and its token has to be unique across the whole
   * installation — `uq_invitations_token` is one of the few globally unique keys in this schema,
   * because the digest **is** the credential. Random per row, so the index is exercised rather than
   * tripped by the second tenant.
   */
  invitations: async (client, organizationId) => {
    const inviter = await createUser(client, organizationId);

    return insert(
      client,
      `INSERT INTO invitations
         (organization_id, email, token_hash, invited_by_id, expires_at, updated_at)
       VALUES ($1, $2, $3, $4, now() + interval '7 days', now())
       RETURNING id`,
      [
        organizationId,
        `invited-${randomUUID().slice(0, 8)}@example.test`,
        randomBytes(32).toString('hex'),
        inviter.id,
      ],
    );
  },

  /**
   * One exception on one permission. The reason is long enough on purpose — the database refuses
   * anything shorter than ten characters after trimming, and a fixture that tripped that check would
   * fail for a reason that has nothing to do with isolation.
   */
  user_permission_overrides: async (client, organizationId) => {
    const user = await createUser(client, organizationId);

    return insert(
      client,
      `INSERT INTO user_permission_overrides
         (organization_id, user_id, permission_key, effect, reason, updated_at)
       VALUES ($1, $2, 'task:read', 'ALLOW', 'isolation fixture row', now())
       RETURNING id`,
      [organizationId, user.id],
    );
  },

  /**
   * An assignment needs a user **and** a role of the same organization; both composite foreign keys
   * refuse anything from elsewhere, which is the point of them and the reason a shared fixture would
   * weaken the test.
   */
  user_roles: async (client, organizationId) => {
    const user = await createUser(client, organizationId);
    const role = await createRole(client, organizationId);

    return insert(
      client,
      `INSERT INTO user_roles (organization_id, user_id, role_id, updated_at)
         VALUES ($1, $2, $3, now())
         RETURNING id`,
      [organizationId, user.id, role.id],
    );
  },

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
