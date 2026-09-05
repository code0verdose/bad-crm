import { randomUUID } from 'node:crypto';

import { Prisma, PrismaClient } from '@prisma/client';
import { type PoolClient } from 'pg';
import { afterAll, assert, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { PrismaEffectivePermissionsReader } from '@/infrastructure/persistence/prisma/effective-permissions-reader.adapter.js';
import { withTenant } from '@/infrastructure/persistence/prisma/tenant.context.js';

import {
  asMaintenance,
  closePools,
  createPools,
  insertOrganizationWithOwner,
  truncateAll,
  type HarnessPools,
} from './db-harness.util.js';

/**
 * What one actor build **costs**, in statements, against a real PostgreSQL.
 *
 * This file exists because of a decision rather than a feature. STORY-011-08 designs a Redis cache
 * of the actor (acceptance 2, 4, 5, 6) and the story closes those four by refusal: the build was
 * measured at 5.4 ms mean and 6.0 ms p95 on the reference stack — 4 % of the 150 ms NFR-2 gives a
 * single-entity read — so a lock, a degradation path and a race were not worth buying. That
 * refusal rests on one property of the read, and only one: **its cost does not grow with the
 * subject**. A build that issued a statement per held role would be 5 ms for the seed fixture and
 * something else entirely for a person with fifteen roles, and the measurement behind the refusal
 * would have been a measurement of the fixture.
 *
 * So the property is asserted rather than assumed, on the level where it can be: statements sent to
 * a real database, counted from Prisma's own query events. Nothing else here is about performance —
 * no timing is asserted, because a wall-clock threshold on a laptop, in CI and under a neighbouring
 * container is three different numbers and the flake it buys teaches nobody anything.
 *
 * The count is pinned as well as compared. Comparing alone would pass a reader that grew from 11
 * statements to 40 in one step for every subject equally — a regression the refusal is just as
 * sensitive to, because it is the absolute cost the budget is spent from.
 *
 * **Which failure means what.** Only the first assertion — cost that grew with the subject — is the
 * one §8 names as a condition for revisiting the cache. The pinned eleven can also move *downward*,
 * or sideways, for reasons that have nothing to do with this decision: Prisma collapsing the three
 * role statements into a join, or the isolation level moving into the connection string. That is a
 * signal to re-derive the number and say so here, not to build a cache.
 */

let pools: HarnessPools;
/**
 * Typed with its log configuration, because `$on('query')` exists only on a client whose options
 * say the events are emitted — the plain `PrismaClient` type accepts no event name at all.
 */
let prisma: PrismaClient<{ log: [{ emit: 'event'; level: 'query' }] }>;

const ORG = randomUUID();

/** Real catalogue keys: `role_permissions.permission_key` is a foreign key into `permissions`. */
const KEYS = ['task:read', 'task:update', 'task:delete', 'doc:read', 'kb_note:read'] as const;

interface Seeded {
  readonly ownerId: string;
  /** Holds two roles — the shape the fixture of every other file has. */
  readonly modestId: string;
  /** Holds eight, with exceptions on top: the same read, with far more rows behind it. */
  readonly loadedId: string;
}

let seeded: Seeded;

const createUser = async (client: PoolClient): Promise<string> => {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO users (organization_id, email, password_hash, status, permissions_version, updated_at)
       VALUES ($1::uuid, $2, 'placeholder-not-a-credential', 'ACTIVE', 7, now())
       RETURNING id`,
    [ORG, `cost-${randomUUID().slice(0, 8)}@example.test`],
  );

  return rows[0]?.id ?? '';
};

const createRole = async (client: PoolClient, index: number): Promise<string> => {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO roles (organization_id, key, name, updated_at)
       VALUES ($1::uuid, $2, $3, now()) RETURNING id`,
    [ORG, `cost-role-${index}-${randomUUID().slice(0, 8)}`, `Role ${index}`],
  );
  const roleId = rows[0]?.id ?? '';

  for (const permissionKey of KEYS) {
    await client.query(
      `INSERT INTO role_permissions (organization_id, role_id, permission_key, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, now())`,
      [ORG, roleId, permissionKey],
    );
  }

  return roleId;
};

const assign = (client: PoolClient, userId: string, roleId: string): Promise<unknown> =>
  client.query(
    `INSERT INTO user_roles (organization_id, user_id, role_id, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, now())`,
    [ORG, userId, roleId],
  );

const seed = async (): Promise<Seeded> =>
  asMaintenance(pools.owner, async (client) => {
    const { ownerId } = await insertOrganizationWithOwner(client, ORG, {
      slug: `cost-${ORG.slice(0, 8)}`,
    });

    const modestId = await createUser(client);
    const loadedId = await createUser(client);

    const roles: string[] = [];

    for (let index = 0; index < 8; index += 1) roles.push(await createRole(client, index));

    for (const roleId of roles.slice(0, 2)) await assign(client, modestId, roleId);
    for (const roleId of roles) await assign(client, loadedId, roleId);

    for (const [permissionKey, effect] of [
      ['task:delete', 'DENY'],
      ['invoice:issue', 'ALLOW'],
      ['doc:create', 'ALLOW'],
    ] as const) {
      await client.query(
        `INSERT INTO user_permission_overrides
           (organization_id, user_id, permission_key, effect, reason, granted_by_id, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, $4::"OverrideEffect", 'cost fixture', $5::uuid, now())`,
        [ORG, loadedId, permissionKey, effect, ownerId],
      );
    }

    return { ownerId, modestId, loadedId };
  });

/** Statements Prisma sent since the last measurement started. */
const recorded: string[] = [];

/** Statements Prisma sent while building the actor for `userId`. */
const statementsToBuild = async (userId: string): Promise<readonly string[]> => {
  // The listener is registered once, in `beforeAll`, and this only empties what it collected.
  // `PrismaClient` has no way to remove one, so registering per measurement would leave the
  // previous call's listener alive and charge the next subject's statements to it as well — which
  // is precisely the shape of drift this file exists to catch, and it would have hidden it.
  recorded.length = 0;

  const facts = await withTenant(prisma, { organizationId: ORG, userId: null }, () =>
    new PrismaEffectivePermissionsReader().capabilitiesOf(userId),
  );

  assert(facts !== null, 'the reader answered for the subject');

  await drain();

  return [...recorded];
};

/**
 * Waits until the query events stop arriving.
 *
 * They arrive after the awaited promise has already settled, so counting immediately misses the
 * tail — the `COMMIT` above all. A fixed pause would do it on this machine and would be a
 * wall-clock assumption in a file whose whole point is that wall-clock assumptions in CI are a
 * different number: a cold runner that delivered the last event at 260 ms would report ten
 * statements and fail for a reason that has nothing to do with the reader. So the condition is
 * quiescence — two consecutive looks that see the same count — rather than a duration.
 */
const drain = async (): Promise<void> => {
  let previous = -1;

  while (previous !== recorded.length) {
    previous = recorded.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

beforeAll(() => {
  pools = createPools();
  prisma = new PrismaClient({
    datasourceUrl: inject('databaseUrls').appUser,
    log: [{ emit: 'event', level: 'query' }],
  });

  prisma.$on('query', (event: Prisma.QueryEvent) => {
    recorded.push(event.query);
  });
});

afterAll(async () => {
  // The exceptions seeded here reference `permissions`, which `permission-catalog.test.ts` empties
  // in its own setup — rows left behind make that file fail in a run whose order nobody chose.
  await truncateAll(pools.owner);
  await prisma.$disconnect();
  await closePools(pools);
});

beforeEach(async () => {
  await truncateAll(pools.owner);
  seeded = await seed();
});

describe('cost of building an actor', () => {
  it('CONTROL: the fixtures differ in what they hold, so a difference in cost could show', async () => {
    const modest = await withTenant(prisma, { organizationId: ORG, userId: null }, () =>
      new PrismaEffectivePermissionsReader().capabilitiesOf(seeded.modestId),
    );
    const loaded = await withTenant(prisma, { organizationId: ORG, userId: null }, () =>
      new PrismaEffectivePermissionsReader().capabilitiesOf(seeded.loadedId),
    );

    expect(modest?.roleKeys).toHaveLength(2);
    expect(loaded?.roleKeys).toHaveLength(8);
    expect(loaded?.denied).toEqual(['task:delete']);

    // This case builds twice and asserts nothing about statements, but its events are still in
    // flight when it ends — and the helper empties the buffer at its *start*, not at its end. Left
    // undrained, they would be charged to whichever measurement runs next.
    await drain();
  });

  it('sends the same number of statements for two roles and for eight', async () => {
    const modest = await statementsToBuild(seeded.modestId);
    const loaded = await statementsToBuild(seeded.loadedId);

    expect(loaded).toHaveLength(modest.length);
  });

  it('sends eleven statements — the transaction, the tenant context and six reads', async () => {
    const statements = await statementsToBuild(seeded.loadedId);

    // `BEGIN`, `SET TRANSACTION ISOLATION LEVEL`, `COMMIT`, the two `set_config` calls that pin the
    // tenant — and six reads: the subject, the organization (for `owner_id`), the personal
    // exceptions, and the role assignments, which Prisma sends as three statements of its own
    // (`user_roles`, then `roles`, then `role_permissions`), each an `IN` over the ids of the
    // previous. Three statements for the roles however many roles there are is the whole point:
    // one per role is what the previous test forbids and this one prices.
    expect(statements).toHaveLength(11);
    // The two `set_config` calls are `SELECT`s as well, which is why this is eight and not six.
    expect(statements.filter((statement) => statement.startsWith('SELECT'))).toHaveLength(8);
  });
});
