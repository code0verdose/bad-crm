import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { type PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { PrismaTeamRepository } from '@/infrastructure/persistence/prisma/team.repository.js';
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
 * The TOCTOU the gate found (M-1), on a real PostgreSQL and with genuine concurrency — the sample is
 * `test/integration/db/ownership-transfer.test.ts:199-231`.
 *
 * `team.repository.ts`'s `scope()` and `subject()` used to read with a plain `findFirst`, and two
 * transactions could each decide from a fact the other was in the middle of overturning:
 *
 *   * `AddTeamMemberUseCase` reads `subject()` as `ACTIVE`, offboarding suspends the same account and
 *     deletes its (still empty) memberships, and the add path's own `INSERT` — which carries no
 *     predicate on the subject's current status — still lands afterwards. Result: a `SUSPENDED`
 *     account holding a membership, exactly the state offboarding's own `DELETE FROM team_members`
 *     exists to make unreachable.
 *   * Symmetrically, `scope()` reads a team as live, `disband()` hides it and deletes its (still
 *     empty) memberships, and the add path's `INSERT` still lands. Result: a membership on a team
 *     that no longer exists.
 *
 * `FOR SHARE` on both reads closes the gap by forcing one of the two transactions to wait for the
 * other's exclusive lock (`disband`'s and `suspend()`'s `UPDATE`s) rather than let both proceed from
 * the same stale row. The two tests below do not depend on *which* of the two wins the race — under
 * the lock there are only two legal outcomes, and a run against the unfixed repository could reach a
 * third, illegal one. That is what each assertion is written to catch, not to predict an ordering.
 */

let pools: HarnessPools;
let prisma: PrismaClient;

const ORG = randomUUID();

const insertUser = async (
  client: PoolClient,
  organizationId: string,
  status: 'ACTIVE' | 'SUSPENDED' = 'ACTIVE',
): Promise<string> => {
  const userId = randomUUID();

  await client.query(
    `INSERT INTO users (id, organization_id, email, password_hash, status, updated_at)
     VALUES ($1::uuid, $2::uuid, $3, 'placeholder-not-a-credential', $4, now())`,
    [userId, organizationId, `race-${userId.slice(0, 8)}@example.test`, status],
  );

  return userId;
};

const insertTeam = async (
  client: PoolClient,
  organizationId: string,
  slug: string,
): Promise<string> => {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO teams (organization_id, name, slug, updated_at)
     VALUES ($1::uuid, $2, $2, now())
     RETURNING id`,
    [organizationId, slug],
  );

  return rows[0]?.id ?? '';
};

/**
 * Runs `work` the way `AddTeamMemberUseCase` reads a subject and writes a membership from it — one
 * transaction, the same order, on the shared `prisma` client so that two calls made without awaiting
 * between them can genuinely run on two different connections at once (the same precondition
 * `ownership-transfer.test.ts`'s race test relies on).
 */
const inTenant = <T>(work: (repository: PrismaTeamRepository) => Promise<T>): Promise<T> =>
  withTenant(prisma, { organizationId: ORG, userId: null }, () => work(new PrismaTeamRepository()));

const offboard = (userId: string): Promise<readonly unknown[]> =>
  withTenant(prisma, { organizationId: ORG, userId: null }, () =>
    new PrismaUserLifecycleRepository().suspend(userId, new Date()),
  );

const statusAndMembershipsOf = async (
  userId: string,
): Promise<{ status: string; memberships: number }> =>
  asMaintenance(pools.owner, async (client) => {
    const { rows } = await client.query<{ status: string; memberships: string }>(
      `SELECT u.status,
              (SELECT count(*)::text FROM team_members tm WHERE tm.user_id = u.id) AS memberships
         FROM users u WHERE u.id = $1::uuid`,
      [userId],
    );
    const row = rows[0];

    return { status: row?.status ?? '', memberships: Number(row?.memberships ?? '-1') };
  });

const deletedAndMembershipsOf = async (
  teamId: string,
): Promise<{ deleted: boolean; memberships: number }> =>
  asMaintenance(pools.owner, async (client) => {
    const { rows } = await client.query<{ deleted: boolean; memberships: string }>(
      `SELECT (t.deleted_at IS NOT NULL) AS deleted,
              (SELECT count(*)::text FROM team_members tm WHERE tm.team_id = t.id) AS memberships
         FROM teams t WHERE t.id = $1::uuid`,
      [teamId],
    );
    const row = rows[0];

    return { deleted: row?.deleted ?? false, memberships: Number(row?.memberships ?? '-1') };
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
  await asMaintenance(pools.owner, (client) =>
    insertOrganizationWithOwner(client, ORG, { slug: `race-${ORG.slice(0, 8)}` }),
  );
});

describe('adding a member races the account being offboarded', () => {
  it('never leaves a suspended account holding a team membership', async () => {
    const [teamId, memberId] = await asMaintenance(pools.owner, async (client) => [
      await insertTeam(client, ORG, 'race-team'),
      await insertUser(client, ORG, 'ACTIVE'),
    ]);

    // The essential shape of `AddTeamMemberUseCase`: read the subject inside the scope, and only
    // write if it was still `ACTIVE` when read. `subject()` is what carries the `FOR SHARE` lock this
    // race depends on.
    const tryJoin = () =>
      inTenant(async (repository) => {
        const subject = await repository.subject(memberId);

        if (subject?.status !== 'ACTIVE') return;

        await repository.addMember(teamId, memberId, 'MEMBER');
      });

    await Promise.all([tryJoin(), offboard(memberId)]);

    const after = await statusAndMembershipsOf(memberId);

    // Whichever of the two committed second did so having re-read (or, for offboarding, having
    // deleted after) the other's result — never from the stale fact each started with. A suspended
    // account with a live membership is exactly the state this pair of transactions cannot leave
    // behind with the lock in place. One unconditional assertion over the whole fact (not
    // `if (…) expect(…)`, `vitest/no-conditional-expect`) so a failure shows both fields together.
    const suspendedWithoutAMembership = after.status !== 'SUSPENDED' || after.memberships === 0;

    expect(suspendedWithoutAMembership, JSON.stringify(after)).toBe(true);
  });
});

describe('adding a member races the team being disbanded', () => {
  it('never leaves a membership on a disbanded team', async () => {
    const [teamId, memberId] = await asMaintenance(pools.owner, async (client) => [
      await insertTeam(client, ORG, 'race-team'),
      await insertUser(client, ORG, 'ACTIVE'),
    ]);

    // The essential shape again, this time gated on `scope()` rather than `subject()` — the lock
    // `disband()`'s own `UPDATE` contends with.
    const tryJoin = () =>
      inTenant(async (repository) => {
        const scope = await repository.scope(teamId);

        if (scope === null || scope.isDeleted) return;

        await repository.addMember(teamId, memberId, 'MEMBER');
      });

    const disbandTeam = () => inTenant((repository) => repository.disband(teamId));

    await Promise.all([tryJoin(), disbandTeam()]);

    const after = await deletedAndMembershipsOf(teamId);

    // Same shape as the test above: one unconditional invariant, not a conditional `expect`.
    const disbandedWithoutAMembership = !after.deleted || after.memberships === 0;

    expect(disbandedWithoutAMembership, JSON.stringify(after)).toBe(true);
  });
});
