import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  asMaintenance,
  asTenant,
  closePools,
  createPools,
  insertOrganizationWithOwner,
  truncateAll,
  type HarnessPools,
} from './db-harness.util.js';

/**
 * «Who holds this role» — the direction the assignment table had no index for.
 *
 * Both indexes on `user_roles` lead with the person (`uq_user_roles (user_id, role_id)`,
 * `idx_user_roles_org_user (organization_id, user_id)`), and everything STORY-011-03 does goes the
 * other way: count the holders of every role for the administration matrix, invalidate everybody
 * holding a role that changed, cascade into the assignments of a role being deleted. All three
 * supply `role_id` and no `user_id`, so without `idx_user_roles_org_role` each of them reads the
 * assignments of the whole organization.
 *
 * The assertion is on the plan the planner picks **on its own settings**, with enough rows for the
 * choice to be a real one — an assertion on the result would pass with the index dropped, which is
 * the failure mode this file exists to avoid.
 */

let pools: HarnessPools;

/** Enough assignments for a scan to lose honestly; a smaller table is read faster sequentially. */
const NOISE_ASSIGNMENTS = 2_000;
const NOISE_ROLES = 40;

interface Fixture {
  readonly organizationId: string;
  readonly ownerId: string;
  readonly roleId: string;
}

const seed = async (): Promise<Fixture> => {
  const organizationId = randomUUID();

  return asMaintenance(pools.owner, async (client) => {
    const { ownerId } = await insertOrganizationWithOwner(client, organizationId);

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO roles (organization_id, key, name, updated_at)
       VALUES ($1::uuid, 'tech_writer', 'Technical writer', now())
       RETURNING id`,
      [organizationId],
    );
    const roleId = rows[0]?.id ?? '';

    // One organization, many people, many roles: the shape of an installation where the matrix screen
    // is worth looking at. The holders of the role under test are a handful of them.
    await client.query(
      `WITH people AS (
         INSERT INTO users (organization_id, email, password_hash, status, updated_at)
         SELECT $1::uuid, 'member-' || g || '-' || $4 || '@example.test',
                'placeholder-not-a-credential', 'ACTIVE', now()
           FROM generate_series(1, $2::int) g
         RETURNING id
       ), roles_of_the_org AS (
         INSERT INTO roles (organization_id, key, name, updated_at)
         SELECT $1::uuid, 'noise_' || g, 'Noise ' || g, now()
           FROM generate_series(1, $3::int) g
         RETURNING id
       ), numbered_people AS (
         SELECT id, row_number() OVER () AS n FROM people
       ), numbered_roles AS (
         SELECT id, row_number() OVER () AS n FROM roles_of_the_org
       )
       INSERT INTO user_roles (organization_id, user_id, role_id, updated_at)
       SELECT $1::uuid, p.id, r.id, now()
         FROM numbered_people p
         JOIN numbered_roles r ON r.n = ((p.n - 1) % $3::int) + 1`,
      [organizationId, NOISE_ASSIGNMENTS, NOISE_ROLES, randomUUID().slice(0, 8)],
    );

    await client.query(
      `INSERT INTO user_roles (organization_id, user_id, role_id, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, now())`,
      [organizationId, ownerId, roleId],
    );
    // Every table the plan weighs, not only the one under test: the join has `users` on the other
    // side, and a planner guessing its size is a planner making a different decision.
    await client.query('ANALYZE users, roles, user_roles');

    return { organizationId, ownerId, roleId };
  });
};

beforeAll(() => {
  pools = createPools();
});

afterAll(async () => {
  await closePools(pools);
});

beforeEach(async () => {
  await truncateAll(pools.owner);
});

describe('finding the holders of a role', () => {
  it('invalidates them through the two-column index rather than a scan of the organization', async () => {
    const fixture = await seed();

    const plan = await asTenant(pools.app, fixture.organizationId, async (client) => {
      const { rows } = await client.query<{ 'QUERY PLAN': string }>(
        // The statement `bumpHoldersOf` issues, verbatim in shape: a subquery, so «who holds it» is
        // resolved by the same statement that invalidates them.
        `EXPLAIN (ANALYZE, BUFFERS) UPDATE users
            SET permissions_version = permissions_version + 1
          WHERE organization_id = $1::uuid
            AND id IN (
                  SELECT user_id FROM user_roles
                   WHERE organization_id = $1::uuid AND role_id = $2::uuid
                     AND (expires_at IS NULL OR expires_at > now())
                )`,
        [fixture.organizationId, fixture.roleId],
      );

      return rows.map((row) => row['QUERY PLAN']).join('\n');
    });

    expect(
      plan,
      `invalidating the holders of one role reads every assignment of the organization — ` +
        `(organization_id, role_id) is not served by an index of its own:\n${plan}`,
    ).not.toMatch(/Seq Scan on user_roles/);
    // And not the other shape the planner falls back to without it: reading every **person** of the
    // organization and probing `idx_user_roles_org_user` once each — measured at `loops=2001`
    // against 2 000 assignments, which is the cost this index removes.
    expect(plan, `the holders were found by walking the people instead:\n${plan}`).not.toMatch(
      /Index Scan using idx_user_roles_org_user on user_roles/,
    );
    expect(plan, `the two-column index was not the one chosen:\n${plan}`).toMatch(
      /Index (Only )?Scan using idx_user_roles_org_role on user_roles/,
    );
  });

  /**
   * The other reader of the same direction, and the reason it is **not** asserted on the plan: the
   * administration matrix counts the holders of every role at once, and for a whole-table aggregate
   * a sequential scan of the assignments is the right plan — reading each row once beats descending
   * an index per role. The index earns its keep on the single-role lookups above and on the cascade
   * of deleting a role, both of which supply one `role_id`.
   */
  it('reads a single role’s holders through it as well', async () => {
    const fixture = await seed();

    const plan = await asTenant(pools.app, fixture.organizationId, async (client) => {
      const { rows } = await client.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN (ANALYZE, BUFFERS)
         SELECT user_id FROM user_roles
          WHERE organization_id = $1::uuid AND role_id = $2::uuid
            AND (expires_at IS NULL OR expires_at > now())`,
        [fixture.organizationId, fixture.roleId],
      );

      return rows.map((row) => row['QUERY PLAN']).join('\n');
    });

    expect(plan, `listing the holders of one role scans the organization:\n${plan}`).toMatch(
      /Index (Only )?Scan using idx_user_roles_org_role on user_roles/,
    );
  });
});
