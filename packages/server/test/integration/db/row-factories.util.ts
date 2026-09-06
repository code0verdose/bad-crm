import { randomBytes, randomUUID } from 'node:crypto';

import { type PoolClient } from 'pg';

import { type TenantTableName } from '@/infrastructure/persistence/prisma/tenant-tables.constant.js';

/**
 * One row per tenant table, for the parameterised isolation suite.
 *
 * `satisfies Record<TenantTableName, TenantRowFactory>` is the load-bearing part: a table added to
 * the registry without a factory here does not compile, so "the new table has no isolation test"
 * cannot happen quietly (docs/security/rls-design.md, «Генератор isolation-тестов»).
 *
 * THE SHAPE OF THIS FILE IS A REPAIR, and both halves of it answer a way the cross-tenant INSERT
 * case used to pass without testing anything.
 *
 * 1. `seed` is separate from the statement. A factory that created its own foreign-key parents in
 *    the same call ran them inside the transaction the test had pinned to organization A, so for the
 *    nine tables with a parent it was the **parent's** insert that raised `42501` and the target
 *    table's policy was never consulted.
 * 2. The statement carries no `RETURNING` of its own. `RETURNING` makes PostgreSQL read the new row
 *    back, and the read is checked against the policy — with the *same* SQLSTATE and the *same*
 *    message as a `WITH CHECK` refusal (`ExecWithCheckOptions`, verified on PostgreSQL 16). A table
 *    shipped with `WITH CHECK (true)` therefore still "refused" the write, at the read-back, and
 *    nothing could tell the two apart. The write had in fact happened. So the id clause is appended
 *    by `insertRow`, which every ordinary caller uses, and omitted by `insertRowBare`, which the
 *    cross-tenant case uses.
 *
 * Together the two made `WITH CHECK (true)` undetectable on every table in the registry.
 */

/**
 * The ids of the rows `seed` created, keyed by the column that points at them.
 *
 * A plain record rather than a per-table type: the isolation suite is generated from the registry
 * and handles every table through the same calls, so a heterogeneous payload would have to be
 * narrowed at a place that does not know which table it is looking at. `parentId` fails loudly
 * instead.
 */
export type SeededParents = Readonly<Record<string, string>>;

export interface TenantRowFactory {
  /** The foreign-key parents of the target row, created in `organizationId`. */
  readonly seed: (client: PoolClient, organizationId: string) => Promise<SeededParents>;
  /**
   * The `INSERT` for the target row and nothing else — **without** a `RETURNING` clause, for the
   * reason in the file header.
   */
  readonly sql: string;
  /** Appended as `RETURNING …` when the caller wants the row's id. Defaults to `id`. */
  readonly returning?: string;
  /** Bound parameters, generated per call so unique indexes are exercised rather than tripped. */
  readonly values: (organizationId: string, parents: SeededParents) => readonly unknown[];
}

/** `seed` then the statement, in one call — every case except the cross-tenant INSERT wants this. */
export type RowFactory = (client: PoolClient, organizationId: string) => Promise<{ id: string }>;

const parentId = (parents: SeededParents, key: string): string => {
  const value = parents[key];

  if (value === undefined) throw new Error(`fixture parent "${key}" was not seeded`);

  return value;
};

const noParents = async (): Promise<SeededParents> => ({});

/** The target row, with its id read back. */
export const insertRow = async (
  client: PoolClient,
  factory: TenantRowFactory,
  organizationId: string,
  parents: SeededParents,
): Promise<{ id: string }> => {
  const sql = `${factory.sql} RETURNING ${factory.returning ?? 'id'}`;
  const { rows } = await client.query<{ id: string }>(sql, [
    ...factory.values(organizationId, parents),
  ]);
  const row = rows[0];

  if (row === undefined) throw new Error(`insert returned no row: ${sql}`);

  return row;
};

/**
 * The target row, written and not read back.
 *
 * The only caller is the cross-tenant INSERT case, and it must stay the only one: without
 * `RETURNING` there is nothing to assert about the row, which is the point — the assertion is that
 * the statement was refused.
 */
export const insertRowBare = async (
  client: PoolClient,
  factory: TenantRowFactory,
  organizationId: string,
  parents: SeededParents,
): Promise<void> => {
  await client.query(factory.sql, [...factory.values(organizationId, parents)]);
};

/**
 * A user, and nothing that resembles a credential.
 *
 * `password_hash` gets a marker string rather than a real argon2id digest, and no column here holds
 * anything a reader could mistake for a password, a token or a secret — a fixture that looks like
 * one is a fixture that gets copied into a seed (CLAUDE.md, «Чувствительность данных»). The column
 * is exercised as a column; its content is the subject of no assertion.
 */
const createUser = async (client: PoolClient, organizationId: string): Promise<{ id: string }> => {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO users (organization_id, email, password_hash, status, updated_at)
       VALUES ($1, $2, $3, 'ACTIVE', now())
       RETURNING id`,
    [
      organizationId,
      `member-${randomUUID().slice(0, 8)}@example.test`,
      'placeholder-not-a-credential',
    ],
  );

  if (rows[0] === undefined) throw new Error('fixture user was not created');

  return rows[0];
};

/**
 * A role of one organization. `key` is unique per organization, so it is randomised: the isolation
 * suite creates rows for two tenants and a fixed key would fail on the second for a reason that has
 * nothing to do with isolation.
 */
const createRole = async (client: PoolClient, organizationId: string): Promise<{ id: string }> => {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO roles (organization_id, key, name, updated_at)
       VALUES ($1, $2, $3, now())
       RETURNING id`,
    [organizationId, `role-${randomUUID().slice(0, 8)}`, 'Fixture role'],
  );

  if (rows[0] === undefined) throw new Error('fixture role was not created');

  return rows[0];
};

const createTeam = async (client: PoolClient, organizationId: string): Promise<{ id: string }> => {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO teams (organization_id, name, slug, updated_at)
       VALUES ($1, $2, $3, now())
       RETURNING id`,
    [organizationId, 'Core', `core-${randomUUID().slice(0, 8)}`],
  );

  if (rows[0] === undefined) throw new Error('fixture team was not created');

  return rows[0];
};

/**
 * A project of one organization, led by a freshly seeded user of the same one: `fk_projects_lead_id`
 * is composite, so a lead from anywhere else fails on the key rather than on the policy. The key is
 * randomised within `ck_projects_key_format` — two tenants may share one, but one tenant may not.
 */
const createProject = async (
  client: PoolClient,
  organizationId: string,
): Promise<{ id: string }> => {
  const lead = await createUser(client, organizationId);
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO projects (organization_id, key, name, lead_id, color, updated_at)
       VALUES ($1, $2, 'Fixture project', $3, 'indigo', now())
       RETURNING id`,
    [organizationId, `P${randomBytes(4).toString('hex').toUpperCase()}`, lead.id],
  );

  if (rows[0] === undefined) throw new Error('fixture project was not created');

  return rows[0];
};

const seedUser = async (client: PoolClient, organizationId: string): Promise<SeededParents> => ({
  userId: (await createUser(client, organizationId)).id,
});

export const TENANT_ROW_FACTORIES = {
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
  audit_logs: {
    seed: noParents,
    sql: `INSERT INTO audit_logs
            (organization_id, actor_type, action, resource_type, request_id, severity)
          VALUES ($1, 'SYSTEM', 'fixture.created', 'FIXTURE', $2, 'INFO')`,
    values: (organizationId) => [organizationId, `fixture-${randomUUID()}`],
  },

  /**
   * The tenant root: its id *is* the tenant, so the row is created with the organization id the
   * caller is acting as. Anything else could not pass `WITH CHECK` — which is exactly why the
   * application generates the id of a new organization and creates it inside `withTenant`
   * (docs/security/rls-design.md, «Особый случай: organizations»).
   *
   * Two rows in one statement, the same way `OrganizationRepositoryPort.createWithOwner` does it:
   * `owner_id` is NOT NULL and points at a user of this organization, while the user points back, so
   * neither insert can go first. Foreign keys are `AFTER ROW` triggers evaluated when the statement
   * ends, and by then both rows exist. A fixture that took a shortcut here would be a fixture that
   * does not exercise the constraint the product lives under.
   *
   * The data-modifying CTE returns nothing on purpose: an inner `RETURNING` would read the new
   * organization back and be checked against the policy, which is exactly the masking the file
   * header describes — and it would mask it on the tenant root, of all tables. Nothing references
   * the CTE, and an unreferenced data-modifying CTE still runs.
   *
   * `ownerOrganizationId` is the one parent key that is not a parent row but a choice, and it exists
   * for a single caller. Writing two rows means two policies are consulted, and in the cross-tenant
   * case both rows were foreign, so it was `users` that refused and the tenant root's own
   * `WITH CHECK` went untested — the very hole this file was reshaped to close. Pointing the owner
   * at an organization already in scope leaves the organization row as the only one crossing the
   * boundary. Everywhere else the key is absent and the owner belongs to the new organization, which
   * is the only arrangement the product ever writes.
   */
  organizations: {
    seed: noParents,
    sql: `WITH created_organization AS (
            INSERT INTO organizations (id, owner_id, slug, name, updated_at)
            VALUES ($1, $2, $3, $4, now())
          )
          INSERT INTO users (id, organization_id, email, password_hash, status, updated_at)
          VALUES ($2, $6, $5, 'placeholder-not-a-credential', 'ACTIVE', now())`,
    returning: 'organization_id AS id',
    values: (organizationId, parents) => {
      const ownerId = randomUUID();

      return [
        organizationId,
        ownerId,
        `org-${organizationId.slice(0, 8)}-${randomUUID().slice(0, 8)}`,
        'Acme',
        `owner-${ownerId.slice(0, 8)}@example.test`,
        parents['ownerOrganizationId'] ?? organizationId,
      ];
    },
  },

  users: {
    seed: noParents,
    sql: `INSERT INTO users (organization_id, email, password_hash, status, updated_at)
          VALUES ($1, $2, 'placeholder-not-a-credential', 'ACTIVE', now())`,
    values: (organizationId) => [organizationId, `member-${randomUUID().slice(0, 8)}@example.test`],
  },

  roles: {
    seed: noParents,
    sql: `INSERT INTO roles (organization_id, key, name, updated_at)
          VALUES ($1, $2, 'Fixture role', now())`,
    values: (organizationId) => [organizationId, `role-${randomUUID().slice(0, 8)}`],
  },

  teams: {
    seed: noParents,
    sql: `INSERT INTO teams (organization_id, name, slug, updated_at)
          VALUES ($1, 'Core', $2, now())`,
    values: (organizationId) => [organizationId, `core-${randomUUID().slice(0, 8)}`],
  },

  /**
   * A grant needs a role of the same organization **and** a permission that exists in the catalogue.
   *
   * The catalogue is seeded by the container setup, the way `pnpm db:seed:permissions` seeds an
   * installation — not here. The fixture used to insert the key itself and failed the moment it ran
   * as the tenant: `app_user` may read the catalogue and never write it, which is the whole point of
   * the table being global.
   */
  role_permissions: {
    seed: async (client, organizationId) => ({
      roleId: (await createRole(client, organizationId)).id,
    }),
    sql: `INSERT INTO role_permissions (organization_id, role_id, permission_key, updated_at)
          VALUES ($1, $2, 'task:read', now())`,
    values: (organizationId, parents) => [organizationId, parentId(parents, 'roleId')],
  },

  /**
   * An invitation needs the person who sent it, and its token has to be unique across the whole
   * installation — `uq_invitations_token` is one of the few globally unique keys in this schema,
   * because the digest **is** the credential. Random per row, so the index is exercised rather than
   * tripped by the second tenant.
   */
  invitations: {
    seed: seedUser,
    sql: `INSERT INTO invitations
            (organization_id, email, token_hash, invited_by_id, expires_at, updated_at)
          VALUES ($1, $2, $3, $4, now() + interval '7 days', now())`,
    values: (organizationId, parents) => [
      organizationId,
      `invited-${randomUUID().slice(0, 8)}@example.test`,
      randomBytes(32),
      parentId(parents, 'userId'),
    ],
  },

  /**
   * One exception on one permission. The reason is long enough on purpose — the database refuses
   * anything shorter than ten characters after trimming, and a fixture that tripped that check would
   * fail for a reason that has nothing to do with isolation.
   */
  user_permission_overrides: {
    seed: seedUser,
    sql: `INSERT INTO user_permission_overrides
            (organization_id, user_id, permission_key, effect, reason, updated_at)
          VALUES ($1, $2, 'task:read', 'ALLOW', 'isolation fixture row', now())`,
    values: (organizationId, parents) => [organizationId, parentId(parents, 'userId')],
  },

  /**
   * An assignment needs a user **and** a role of the same organization; both composite foreign keys
   * refuse anything from elsewhere, which is the point of them and the reason a shared fixture would
   * weaken the test.
   */
  user_roles: {
    seed: async (client, organizationId) => {
      const [user, role] = await Promise.all([
        createUser(client, organizationId),
        createRole(client, organizationId),
      ]);

      return { userId: user.id, roleId: role.id };
    },
    sql: `INSERT INTO user_roles (organization_id, user_id, role_id, updated_at)
          VALUES ($1, $2, $3, now())`,
    values: (organizationId, parents) => [
      organizationId,
      parentId(parents, 'userId'),
      parentId(parents, 'roleId'),
    ],
  },

  /**
   * A session needs a user of the same organization, so the factory seeds one: the composite
   * foreign key `(organization_id, user_id)` refuses a user from anywhere else, which is the point
   * of the key and the reason a shared fixture user would weaken the test.
   *
   * `refresh_token_hash` is 32 random bytes — the shape of a SHA-256 digest, generated per row so
   * the globally unique index is exercised rather than tripped.
   */
  sessions: {
    seed: seedUser,
    sql: `INSERT INTO sessions
            (organization_id, user_id, family_id, refresh_token_hash, user_agent, ip_hash, ip_masked,
             expires_at, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, now() + interval '30 days', now())`,
    values: (organizationId, parents) => [
      organizationId,
      parentId(parents, 'userId'),
      randomUUID(),
      randomBytes(32),
      'integration-suite',
      randomBytes(32).toString('hex'),
      // The shape the masking function produces, not an address: `203.0.113.0/24` is the
      // documentation range with its host half already gone (RFC 5737).
      '203.0.113.0/24',
    ],
  },

  /**
   * A recovery code needs a user of the same organization, for the identical reason `sessions` and
   * `password_reset_tokens` seed one: the composite foreign key refuses a user from anywhere else.
   *
   * `code_hash` gets a marker string rather than a real argon2id digest — nothing here is exercised
   * as a credential, only as a column, and a fixture that looked like a real digest is a fixture
   * somebody eventually copies into a seed (CLAUDE.md, «Чувствительность данных»).
   */
  mfa_recovery_codes: {
    seed: seedUser,
    sql: `INSERT INTO mfa_recovery_codes (organization_id, user_id, code_hash, updated_at)
          VALUES ($1, $2, 'not-a-real-argon2id-digest', now())`,
    values: (organizationId, parents) => [organizationId, parentId(parents, 'userId')],
  },

  password_reset_tokens: {
    seed: seedUser,
    sql: `INSERT INTO password_reset_tokens
            (organization_id, user_id, token_hash, expires_at, updated_at)
          VALUES ($1, $2, $3, now() + interval '60 minutes', now())`,
    values: (organizationId, parents) => [
      organizationId,
      parentId(parents, 'userId'),
      randomBytes(32),
    ],
  },

  /**
   * A profile needs the account it describes, of the same organization: the composite key carries
   * `organization_id`, so a fixture reusing another tenant's user would fail on the key rather than
   * on the policy — and the isolation test would be green for the wrong reason.
   */
  employee_profiles: {
    seed: seedUser,
    sql: `INSERT INTO employee_profiles (organization_id, user_id, first_name, last_name, updated_at)
          VALUES ($1, $2, 'Ivan', 'Petrov', now())`,
    values: (organizationId, parents) => [organizationId, parentId(parents, 'userId')],
  },

  /**
   * One membership, and therefore one team **and** one person of the same organization.
   *
   * Both parents are seeded rather than shared: the composite foreign keys carry `organization_id`,
   * so a fixture reusing another tenant's team would fail on the key instead of on the policy, and
   * the isolation test would be green for the wrong reason.
   */
  team_members: {
    seed: async (client, organizationId) => {
      const [team, user] = await Promise.all([
        createTeam(client, organizationId),
        createUser(client, organizationId),
      ]);

      return { teamId: team.id, userId: user.id };
    },
    sql: `INSERT INTO team_members (organization_id, team_id, user_id, updated_at)
          VALUES ($1, $2, $3, now())`,
    values: (organizationId, parents) => [
      organizationId,
      parentId(parents, 'teamId'),
      parentId(parents, 'userId'),
    ],
  },

  /**
   * A project needs its lead, of the same organization; the factory seeds one because the composite
   * key `(organization_id, lead_id)` refuses a user from anywhere else — the point of the key and
   * the reason a shared fixture would weaken the test.
   */
  projects: {
    seed: seedUser,
    sql: `INSERT INTO projects (organization_id, key, name, lead_id, color, updated_at)
          VALUES ($1, $2, 'Fixture project', $3, 'indigo', now())`,
    values: (organizationId, parents) => [
      organizationId,
      `P${randomBytes(4).toString('hex').toUpperCase()}`,
      parentId(parents, 'userId'),
    ],
  },

  /**
   * One membership, and therefore one project **and** one person of the same organization — the
   * shape of `team_members` above, for the same reason: both composite keys carry
   * `organization_id`, so a fixture reusing another tenant's project would fail on the key instead
   * of on the policy.
   */
  project_members: {
    seed: async (client, organizationId) => {
      const [project, user] = await Promise.all([
        createProject(client, organizationId),
        createUser(client, organizationId),
      ]);

      return { projectId: project.id, userId: user.id };
    },
    sql: `INSERT INTO project_members (organization_id, project_id, user_id, updated_at)
          VALUES ($1, $2, $3, now())`,
    values: (organizationId, parents) => [
      organizationId,
      parentId(parents, 'projectId'),
      parentId(parents, 'userId'),
    ],
  },

  /**
   * One grant. Neither end of it is a foreign key — the object and the subject are polymorphic
   * pairs by design (`rules/polymorphic-access.mdc`, 11) — so there is nothing to seed: both ids are
   * random, which also keeps `uq_resource_acl` exercised rather than tripped by the second tenant.
   * `granted_by_id`, the one real reference, is left NULL: the fixture is about the policy on this
   * row, and a grantor of the same organization would only move the refusal to the users table.
   */
  resource_acl: {
    seed: noParents,
    sql: `INSERT INTO resource_acl
            (organization_id, resource_type, resource_id, subject_type, subject_id, access_level,
             updated_at)
          VALUES ($1, 'PROJECT', $2, 'USER', $3, 'EDITOR', now())`,
    values: (organizationId) => [organizationId, randomUUID(), randomUUID()],
  },
} satisfies Record<TenantTableName, TenantRowFactory>;

/**
 * The combined form, unchanged for every caller that just wants a row of some tenant.
 *
 * Only the cross-tenant INSERT case needs the parts apart, and it is the only place that must not
 * use this: running `seed` inside the pinned transaction is what made the parent, rather than the
 * target table, the thing that raised.
 */
export const ROW_FACTORIES = Object.fromEntries(
  Object.entries(TENANT_ROW_FACTORIES).map(([table, factory]) => [
    table,
    async (client: PoolClient, organizationId: string) =>
      insertRow(client, factory, organizationId, await factory.seed(client, organizationId)),
  ]),
) as Record<TenantTableName, RowFactory>;
