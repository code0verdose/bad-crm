import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { PrismaEmployeeDirectoryRepository } from '@/infrastructure/persistence/prisma/employee-directory.repository.js';
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
 * The directory against a real database, from two organizations at once.
 *
 * The repository joins four tables — accounts, personnel records, role assignments, team memberships
 * — and a join is where tenant isolation is easiest to lose: one relation whose predicate forgot the
 * organization, and a search returns a colleague from another company under a familiar name. Neither
 * the unit tests (a recorded driver has no policies) nor the registry-driven RLS suite (one table at
 * a time) can see that.
 *
 * **The positive control carries the file.** Every assertion about what is *not* visible would also
 * pass against a broken connection, an empty database or a repository that returns nothing at all;
 * the first test is what makes the rest mean something.
 */

let pools: HarnessPools;
let prisma: PrismaClient;

const ORG_A = randomUUID();
const ORG_B = randomUUID();

interface Seeded {
  readonly memberA: string;
  readonly memberB: string;
  readonly roleA: string;
  readonly teamA: string;
}

let seeded: Seeded;

/** One person in each organization, both named the same, so only the tenant tells them apart. */
const seed = async (): Promise<Seeded> =>
  asMaintenance(pools.owner, async (client) => {
    await insertOrganizationWithOwner(client, ORG_A, { slug: `a-${ORG_A.slice(0, 8)}` });
    await insertOrganizationWithOwner(client, ORG_B, { slug: `b-${ORG_B.slice(0, 8)}` });

    const person = async (organizationId: string, email: string): Promise<string> => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO users (organization_id, email, password_hash, status, updated_at)
         VALUES ($1::uuid, $2, 'placeholder-not-a-credential', 'ACTIVE', now())
         RETURNING id`,
        [organizationId, email],
      );
      const userId = rows[0]?.id ?? '';

      await client.query(
        `INSERT INTO employee_profiles
           (organization_id, user_id, first_name, last_name, job_title, department, updated_at)
         VALUES ($1::uuid, $2::uuid, 'Ivan', 'Petrov', 'Backend engineer', 'Platform', now())`,
        [organizationId, userId],
      );

      return userId;
    };

    const memberA = await person(ORG_A, `ivan-a-${ORG_A.slice(0, 8)}@example.test`);
    const memberB = await person(ORG_B, `ivan-b-${ORG_B.slice(0, 8)}@example.test`);

    const roleOf = async (organizationId: string, userId: string): Promise<string> => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO roles (organization_id, key, name, updated_at)
         VALUES ($1::uuid, 'developer', 'Developer', now())
         RETURNING id`,
        [organizationId],
      );
      const roleId = rows[0]?.id ?? '';

      await client.query(
        `INSERT INTO user_roles (organization_id, user_id, role_id, updated_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, now())`,
        [organizationId, userId, roleId],
      );

      return roleId;
    };

    const teamOf = async (organizationId: string, userId: string): Promise<string> => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO teams (organization_id, name, slug, updated_at)
         VALUES ($1::uuid, 'Platform', 'platform', now())
         RETURNING id`,
        [organizationId],
      );
      const teamId = rows[0]?.id ?? '';

      await client.query(
        `INSERT INTO team_members (organization_id, team_id, user_id, updated_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, now())`,
        [organizationId, teamId, userId],
      );

      return teamId;
    };

    const roleA = await roleOf(ORG_A, memberA);

    await roleOf(ORG_B, memberB);

    const teamA = await teamOf(ORG_A, memberA);

    await teamOf(ORG_B, memberB);

    return { memberA, memberB, roleA, teamA };
  });

const inOrgA = <T>(
  work: (repository: PrismaEmployeeDirectoryRepository) => Promise<T>,
): Promise<T> =>
  withTenant(prisma, { organizationId: ORG_A, userId: null }, () =>
    work(new PrismaEmployeeDirectoryRepository()),
  );

const filter = {
  query: '',
  statuses: ['ACTIVE'] as const,
  roleIds: [] as const,
  teamIds: [] as const,
  sort: 'name' as const,
  page: 1,
  perPage: 50,
};

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

describe('the directory across two organizations', () => {
  it('CONTROL: organization A sees its own person, with their role and team', async () => {
    const page = await inOrgA((repository) => repository.list(filter));

    expect(page.items.map((item) => item.userId)).toContain(seeded.memberA);
    expect(page.items.find((item) => item.userId === seeded.memberA)?.roles).toEqual([
      { id: seeded.roleA, key: 'developer', name: 'Developer' },
    ]);
    expect(page.items.find((item) => item.userId === seeded.memberA)?.teams).toEqual([
      { id: seeded.teamA, name: 'Platform' },
    ]);
  });

  it('never returns a person of organization B, however alike the two look', async () => {
    const page = await inOrgA((repository) => repository.list(filter));

    expect(page.items.map((item) => item.userId)).not.toContain(seeded.memberB);
    // Two people and one owner in A; B's three rows are not in the total either — a count taken with
    // a different predicate than the page is a pager that promises rows the next page has not got.
    expect(page.total).toBe(page.items.length);
  });

  it('finds by a name both organizations share, and only in this one', async () => {
    const page = await inOrgA((repository) => repository.list({ ...filter, query: 'Petrov' }));

    expect(page.items.map((item) => item.userId)).toEqual([seeded.memberA]);
  });

  it('offers only the roles and teams of this organization as filter values', async () => {
    const facets = await inOrgA((repository) => repository.facets());

    // Both organizations have a role called `developer` and a team called `Platform`; a facet list
    // that leaked would be visible here as a duplicate rather than as somebody else's name.
    expect(facets.roles).toEqual([{ id: seeded.roleA, key: 'developer', name: 'Developer' }]);
    expect(facets.teams).toEqual([{ id: seeded.teamA, name: 'Platform' }]);
  });

  it('draws every account of this organization, and none of the other', async () => {
    const nodes = await inOrgA((repository) => repository.orgChart());
    const drawn = nodes.map((node) => node.userId);

    // The owner has no personnel row — nobody has filled one in — and is on the chart all the same.
    // Reading `employee_profiles` instead would put them in the directory and leave them off the
    // chart of the same people: two views of one organization disagreeing about who is in it.
    expect(drawn).toContain(seeded.memberA);
    expect(drawn).toHaveLength(2);
    expect(drawn).not.toContain(seeded.memberB);
    expect(nodes.find((node) => node.userId === seeded.memberA)?.lastName).toBe('Petrov');
  });
});
