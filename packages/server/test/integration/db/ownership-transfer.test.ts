import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { type PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { PrismaOwnershipRepository } from '@/infrastructure/persistence/prisma/ownership.repository.js';
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
 * `PrismaOwnershipRepository.transfer`, against a real PostgreSQL.
 *
 * This file exists because the unit test in `test/unit/persistence/ownership-repository.test.ts`
 * cannot see what it is testing. That file replaces the Prisma client with a recorder: it proves the
 * *shape* of the statements — which `where`, in which order — but a recorder answers `{ count: 1 }`
 * to anything, so it cannot know whether `organization.updateMany({ where: { id, ownerId } })` is a
 * form PostgreSQL accepts, whether `skipDuplicates` actually survives the real `uq_user_roles`
 * constraint, or whether two of these transactions racing off the same owner really do resolve to
 * exactly one winner. All three are asserted here, against the database.
 */

let pools: HarnessPools;
let prisma: PrismaClient;

const ORG = randomUUID();

interface Seeded {
  readonly ownerId: string;
  readonly heirAId: string;
  readonly heirBId: string;
  readonly ownerRoleId: string;
  readonly adminRoleId: string;
}

let seeded: Seeded;

const insertUser = async (client: PoolClient, suffix: string): Promise<string> => {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO users (organization_id, email, password_hash, status, updated_at)
     VALUES ($1::uuid, $2, 'placeholder-not-a-credential', 'ACTIVE', now())
     RETURNING id`,
    [ORG, `heir-${suffix}-${ORG.slice(0, 8)}@example.test`],
  );

  return rows[0]?.id ?? '';
};

const insertRole = async (client: PoolClient, key: string): Promise<string> => {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO roles (organization_id, key, name, is_system, updated_at)
     VALUES ($1::uuid, $2, $2, true, now())
     RETURNING id`,
    [ORG, key],
  );

  return rows[0]?.id ?? '';
};

const grantRole = async (client: PoolClient, userId: string, roleId: string): Promise<void> => {
  await client.query(
    `INSERT INTO user_roles (organization_id, user_id, role_id, updated_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, now())`,
    [ORG, userId, roleId],
  );
};

const seed = async (): Promise<Seeded> =>
  asMaintenance(pools.owner, async (client) => {
    const { ownerId } = await insertOrganizationWithOwner(client, ORG, {
      slug: `ownership-${ORG.slice(0, 8)}`,
    });

    const ownerRoleId = await insertRole(client, 'owner');
    const adminRoleId = await insertRole(client, 'admin');

    // The founder holds `owner` the way registration provisions it (STORY-006-01).
    await grantRole(client, ownerId, ownerRoleId);

    const heirAId = await insertUser(client, 'a');
    const heirBId = await insertUser(client, 'b');

    return { ownerId, heirAId, heirBId, ownerRoleId, adminRoleId };
  });

const inTenant = <T>(work: (repository: PrismaOwnershipRepository) => Promise<T>): Promise<T> =>
  withTenant(prisma, { organizationId: ORG, userId: null }, () =>
    work(new PrismaOwnershipRepository()),
  );

const ownerIdOfOrg = async (): Promise<string> =>
  asMaintenance(pools.owner, async (client) => {
    const { rows } = await client.query<{ owner_id: string }>(
      `SELECT owner_id FROM organizations WHERE id = $1::uuid`,
      [ORG],
    );

    return rows[0]?.owner_id ?? '';
  });

const ownerRoleHolders = async (): Promise<string[]> =>
  asMaintenance(pools.owner, async (client) => {
    const { rows } = await client.query<{ user_id: string }>(
      `SELECT user_id FROM user_roles
        WHERE organization_id = $1::uuid AND role_id = $2::uuid
        ORDER BY user_id`,
      [ORG, seeded.ownerRoleId],
    );

    return rows.map((row) => row.user_id);
  });

const roleKeysOf = async (userId: string): Promise<string[]> =>
  asMaintenance(pools.owner, async (client) => {
    const { rows } = await client.query<{ key: string }>(
      `SELECT r.key FROM user_roles ur
         JOIN roles r ON r.id = ur.role_id AND r.organization_id = ur.organization_id
        WHERE ur.organization_id = $1::uuid AND ur.user_id = $2::uuid
        ORDER BY r.key`,
      [ORG, userId],
    );

    return rows.map((row) => row.key);
  });

const permissionsVersionOf = async (userId: string): Promise<number> =>
  asMaintenance(pools.owner, async (client) => {
    const { rows } = await client.query<{ permissions_version: number }>(
      `SELECT permissions_version FROM users WHERE id = $1::uuid`,
      [userId],
    );

    return rows[0]?.permissions_version ?? -1;
  });

beforeAll(() => {
  pools = createPools();
  prisma = new PrismaClient({ datasourceUrl: inject('databaseUrls').appUser });
});

afterAll(async () => {
  await prisma.$disconnect();
  await closePools(pools);
});

beforeEach(async () => {
  await truncateAll(pools.owner);
  seeded = await seed();
});

describe('handing the organization over', () => {
  it('CONTROL: repoints the root, swaps the roles and bumps both versions in one transaction', async () => {
    await inTenant((repository) =>
      repository.transfer({
        fromUserId: seeded.ownerId,
        toUserId: seeded.heirAId,
        previousOwnerRoleKey: 'admin',
      }),
    );

    expect(await ownerIdOfOrg()).toBe(seeded.heirAId);
    expect(await ownerRoleHolders()).toEqual([seeded.heirAId]);
    expect(await roleKeysOf(seeded.ownerId)).toEqual(['admin']);
    expect(await roleKeysOf(seeded.heirAId)).toEqual(['owner']);
    expect(await permissionsVersionOf(seeded.ownerId)).toBe(2);
    expect(await permissionsVersionOf(seeded.heirAId)).toBe(2);
  });

  /**
   * `skipDuplicates` against the real `uq_user_roles (user_id, role_id)` constraint — the unit test
   * can only assert the flag is set, not that PostgreSQL honours it. An administrator promoted to
   * owner keeps their `admin` row; without the flag this `INSERT` would answer `23505` and the whole
   * transaction would roll back on an organization that had done nothing wrong.
   */
  it('is idempotent when the outgoing owner already holds the fallback role', async () => {
    await asMaintenance(pools.owner, (client) =>
      grantRole(client, seeded.ownerId, seeded.adminRoleId),
    );

    await expect(
      inTenant((repository) =>
        repository.transfer({
          fromUserId: seeded.ownerId,
          toUserId: seeded.heirAId,
          previousOwnerRoleKey: 'admin',
        }),
      ),
    ).resolves.toBeUndefined();

    // One row, not two: the pre-existing grant and the one the transfer asked for are the same row.
    expect(await roleKeysOf(seeded.ownerId)).toEqual(['admin']);
    expect(await roleKeysOf(seeded.heirAId)).toEqual(['owner']);
  });

  /**
   * The defect-3 regression, proven the way `refresh-rotation.test.ts` proves the equivalent claim
   * for a session: the `fromUserId` each call carries is fixed before either promise starts, so the
   * assertion does not depend on genuine interleaving inside PostgreSQL — only on the guarded
   * statement doing what it claims, whichever of the two happens to run first.
   */
  it('lets exactly one of two transfers racing off the same owner win', async () => {
    const attempt = (toUserId: string) =>
      inTenant((repository) =>
        repository.transfer({
          fromUserId: seeded.ownerId,
          toUserId,
          previousOwnerRoleKey: 'admin',
        }),
      );

    const [first, second] = await Promise.allSettled([
      attempt(seeded.heirAId),
      attempt(seeded.heirBId),
    ]);

    const outcomes = [first, second];

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const [loser] = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
    );

    expect(loser?.reason).toMatchObject({ code: 'stale_version', status: 409 });

    // Whichever won, the organization is left with exactly one `owner` — never zero, never two —
    // and the tenant root agrees with `user_roles` about who that is.
    const holders = await ownerRoleHolders();

    expect(holders).toHaveLength(1);
    expect([seeded.heirAId, seeded.heirBId]).toContain(holders[0]);
    expect(await ownerIdOfOrg()).toBe(holders[0]);
  });

  it('refuses a repeat call once `fromUserId` is no longer the owner, rather than silently repointing again', async () => {
    await inTenant((repository) =>
      repository.transfer({
        fromUserId: seeded.ownerId,
        toUserId: seeded.heirAId,
        previousOwnerRoleKey: 'admin',
      }),
    );

    await expect(
      inTenant((repository) =>
        repository.transfer({
          fromUserId: seeded.ownerId,
          toUserId: seeded.heirBId,
          previousOwnerRoleKey: 'admin',
        }),
      ),
    ).rejects.toMatchObject({ code: 'stale_version', status: 409 });

    expect(await ownerIdOfOrg()).toBe(seeded.heirAId);
    expect(await ownerRoleHolders()).toEqual([seeded.heirAId]);
  });
});
