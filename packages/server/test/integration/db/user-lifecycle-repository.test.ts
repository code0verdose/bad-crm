import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { PrismaUserLifecycleRepository } from '@/infrastructure/persistence/prisma/user-lifecycle.repository.js';
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
 * The offboarding statements against a real PostgreSQL, under `FORCE ROW LEVEL SECURITY`.
 *
 * Every write this repository performs is a form no server had ever seen: the composite key
 * `organizationId_id`, `employeeProfile.updateMany` against a row that may not exist, `status` and
 * `permissions_version` moved by one operator, and a raw `DELETE … RETURNING`. The unit test asserts
 * all of them over a recorded driver, which agrees just as happily with SQL PostgreSQL would refuse
 * to parse — the lesson `invitation-join-teams.test.ts` was written after, where `ON CONFLICT ON
 * CONSTRAINT` passed a substring assertion and failed on every call.
 *
 * **The positive control carries the file.** Assertions about what did *not* change would also pass
 * against an empty database, a broken connection or a repository that writes nothing; the first test
 * of each block is what makes the rest mean anything.
 *
 * The connection is `app_user` — subject to the policies, no `BYPASSRLS` — and the scope is opened by
 * `withTenant`, exactly as the application opens it. Observation goes through the owner in
 * maintenance mode, which is the only way to see rows the application is not allowed to see.
 */

let pools: HarnessPools;
let prisma: PrismaClient;

const ORG = randomUUID();
const OTHER_ORG = randomUUID();

interface Seeded {
  readonly userId: string;
  readonly platformTeamId: string;
  readonly designTeamId: string;
  /** Somebody of the other organization, in a team of their own. */
  readonly strangerId: string;
  readonly strangerTeamId: string;
}

let seeded: Seeded;

const team = async (
  client: Parameters<typeof insertOrganizationWithOwner>[0],
  organizationId: string,
  name: string,
): Promise<string> => {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO teams (organization_id, name, slug, updated_at)
     VALUES ($1::uuid, $2, $3, now())
     RETURNING id`,
    [organizationId, name, `${name.toLowerCase()}-${randomUUID().slice(0, 8)}`],
  );

  return rows[0]?.id ?? '';
};

const join = async (
  client: Parameters<typeof insertOrganizationWithOwner>[0],
  organizationId: string,
  teamId: string,
  userId: string,
  teamRole: string,
): Promise<void> => {
  await client.query(
    `INSERT INTO team_members (organization_id, team_id, user_id, team_role, updated_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, now())`,
    [organizationId, teamId, userId, teamRole],
  );
};

/**
 * The owner of each organization is the subject: `insertOrganizationWithOwner` writes the one account
 * a tenant cannot exist without, and the policy that would refuse to offboard an owner lives a layer
 * above this file — the repository has no opinion about who the row belongs to.
 */
const seed = async (): Promise<Seeded> =>
  asMaintenance(pools.owner, async (client) => {
    const { ownerId } = await insertOrganizationWithOwner(client, ORG, {
      slug: `lifecycle-${ORG.slice(0, 8)}`,
    });
    const { ownerId: strangerId } = await insertOrganizationWithOwner(client, OTHER_ORG, {
      slug: `other-${OTHER_ORG.slice(0, 8)}`,
    });

    await client.query(
      `INSERT INTO employee_profiles
         (organization_id, user_id, first_name, last_name, hired_at, updated_at)
       VALUES ($1::uuid, $2::uuid, 'Ada', 'Lovelace', DATE '2024-03-01', now())`,
      [ORG, ownerId],
    );

    const platformTeamId = await team(client, ORG, 'Platform');
    const designTeamId = await team(client, ORG, 'Design');
    const strangerTeamId = await team(client, OTHER_ORG, 'Elsewhere');

    await join(client, ORG, platformTeamId, ownerId, 'LEAD');
    await join(client, ORG, designTeamId, ownerId, 'MEMBER');
    await join(client, OTHER_ORG, strangerTeamId, strangerId, 'LEAD');

    return { userId: ownerId, platformTeamId, designTeamId, strangerId, strangerTeamId };
  });

const inTenant = <T>(
  organizationId: string,
  work: (repository: PrismaUserLifecycleRepository) => Promise<T>,
): Promise<T> =>
  withTenant(prisma, { organizationId, userId: null }, () =>
    work(new PrismaUserLifecycleRepository()),
  );

interface AccountState {
  readonly status: string;
  readonly permissions_version: number;
  readonly terminated_at: Date | null;
}

const accountState = async (userId: string): Promise<AccountState | undefined> =>
  asMaintenance(pools.owner, async (client) => {
    const { rows } = await client.query<AccountState>(
      `SELECT u.status, u.permissions_version, p.terminated_at
         FROM users u
         LEFT JOIN employee_profiles p
           ON p.organization_id = u.organization_id AND p.user_id = u.id
        WHERE u.id = $1::uuid`,
      [userId],
    );

    return rows[0];
  });

const membershipsOf = async (userId: string): Promise<{ team_id: string; team_role: string }[]> =>
  asMaintenance(pools.owner, async (client) => {
    const { rows } = await client.query<{ team_id: string; team_role: string }>(
      `SELECT team_id, team_role FROM team_members WHERE user_id = $1::uuid ORDER BY team_role`,
      [userId],
    );

    return rows;
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

describe('reading the subject', () => {
  it('CONTROL: reads the account and the owner of its organization in one statement', async () => {
    const row = await inTenant(ORG, (repository) => repository.byId(seeded.userId));

    expect(row).toEqual({
      userId: seeded.userId,
      status: 'ACTIVE',
      organizationOwnerId: seeded.userId,
    });
  });

  it('answers null for an account of another organization, which the policy never sees', async () => {
    // The tenant predicate and the policy say the same thing here, and both have to: a `null` is
    // what becomes a 404 rather than a 403, and the repository is the only place that can tell.
    expect(await inTenant(ORG, (repository) => repository.byId(seeded.strangerId))).toBeNull();
  });
});

describe('switching the account off', () => {
  it('CONTROL: suspends, terminates and bumps the version in one transaction', async () => {
    const before = await accountState(seeded.userId);

    await inTenant(ORG, (repository) =>
      repository.suspend(seeded.userId, new Date('2026-08-08T09:00:00.000Z')),
    );

    const after = await accountState(seeded.userId);

    expect(before).toMatchObject({ status: 'ACTIVE', terminated_at: null });
    // The composite key `organizationId_id` matched a row — a spelling PostgreSQL would refuse
    // resolves to zero rows and a `P2025`, not to a quiet no-op.
    expect(after?.status).toBe('SUSPENDED');
    expect(after?.permissions_version).toBe((before?.permissions_version ?? 0) + 1);
    expect(after?.terminated_at).not.toBeNull();
  });

  it('returns the memberships it removed, with the role that disappears with the row', async () => {
    const removed = await inTenant(ORG, (repository) =>
      repository.suspend(seeded.userId, new Date()),
    );

    expect([...removed].sort((a, b) => a.teamRole.localeCompare(b.teamRole))).toEqual([
      { teamId: seeded.platformTeamId, teamRole: 'LEAD' },
      { teamId: seeded.designTeamId, teamRole: 'MEMBER' },
    ]);
    // And they really are gone: `team_members` has no `deleted_at`, which is precisely why the list
    // above is the only surviving record of what they were.
    expect(await membershipsOf(seeded.userId)).toEqual([]);
  });

  it('leaves the memberships of another organization alone', async () => {
    await inTenant(ORG, (repository) => repository.suspend(seeded.userId, new Date()));

    // The `DELETE` is raw, so the tenant predicate is written by hand — and a hand-written predicate
    // is the one that gets forgotten. `FORCE ROW LEVEL SECURITY` is the second rubber, not the first.
    expect(await membershipsOf(seeded.strangerId)).toEqual([
      { team_id: seeded.strangerTeamId, team_role: 'LEAD' },
    ]);
  });

  it('offboards an account that has no personnel record yet', async () => {
    // Somebody who accepted an invitation this morning. `updateMany` matches nothing and that is an
    // ordinary outcome; `update` would raise `P2025` and fail the whole offboarding.
    const fresh = await asMaintenance(pools.owner, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO users (organization_id, email, password_hash, status, updated_at)
         VALUES ($1::uuid, $2, 'placeholder-not-a-credential', 'ACTIVE', now())
         RETURNING id`,
        [ORG, `newcomer-${randomUUID().slice(0, 8)}@example.test`],
      );

      return rows[0]?.id ?? '';
    });

    await expect(
      inTenant(ORG, (repository) => repository.suspend(fresh, new Date())),
    ).resolves.toEqual([]);
    expect(await accountState(fresh)).toMatchObject({ status: 'SUSPENDED', terminated_at: null });
  });
});

describe('bringing the account back', () => {
  it('CONTROL: restores the status, clears the date and bumps the version again', async () => {
    await inTenant(ORG, (repository) => repository.suspend(seeded.userId, new Date()));

    const suspended = await accountState(seeded.userId);

    await inTenant(ORG, (repository) => repository.reactivate(seeded.userId));

    const revived = await accountState(seeded.userId);

    expect(suspended?.status).toBe('SUSPENDED');
    expect(revived).toMatchObject({ status: 'ACTIVE', terminated_at: null });
    // The version moves on the way back in as well: the account may have been suspended while a
    // token was in flight, and a returning account whose version never moved would accept it.
    expect(revived?.permissions_version).toBe((suspended?.permissions_version ?? 0) + 1);
  });

  it('restores no membership', async () => {
    await inTenant(ORG, (repository) => repository.suspend(seeded.userId, new Date()));
    await inTenant(ORG, (repository) => repository.reactivate(seeded.userId));

    expect(await membershipsOf(seeded.userId)).toEqual([]);
  });
});
