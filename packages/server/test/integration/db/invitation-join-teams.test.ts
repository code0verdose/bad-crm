import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { type InvitationDraftRow } from '@/application/iam/ports/invitation-repository.port.js';
import { PrismaInvitationRepository } from '@/infrastructure/persistence/prisma/invitation.repository.js';
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
 * The two raw statements of the invitation repository, against a real PostgreSQL.
 *
 * This file exists because the unit test could not have caught what it is testing. `joinTeams` is
 * raw SQL, and the unit test asserts on the **string** — that it contains `ON CONFLICT` — over a
 * stubbed `$executeRaw`. A statement that PostgreSQL refuses to parse passes that assertion
 * perfectly: nothing in a recorded driver knows the difference between a unique **index** and a
 * unique **constraint**, and `ON CONFLICT ON CONSTRAINT` is resolved against `pg_constraint` at
 * parse time — so the wrong one fails on every call, not only on a conflict.
 *
 * `accept()` is here for the same reason and not because it was suspected: it is the other raw
 * statement in that file, its unit test also compares **substrings** of the SQL over a recorded
 * driver, and the single-use guarantee of the whole product rests on its predicate. A guarantee
 * asserted by `toContain('accepted_at IS NULL')` is a guarantee nobody has run.
 */

let pools: HarnessPools;
let prisma: PrismaClient;

const ORG = randomUUID();

interface Seeded {
  readonly userId: string;
  readonly liveTeamId: string;
  readonly deletedTeamId: string;
}

let seeded: Seeded;

const seed = async (): Promise<Seeded> =>
  asMaintenance(pools.owner, async (client) => {
    const { ownerId } = await insertOrganizationWithOwner(client, ORG, {
      slug: `teams-${ORG.slice(0, 8)}`,
    });

    const team = async (name: string, deleted: boolean): Promise<string> => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO teams (organization_id, name, slug, deleted_at, updated_at)
         VALUES ($1::uuid, $2, $3, ${deleted ? 'now()' : 'NULL'}, now())
         RETURNING id`,
        [ORG, name, name.toLowerCase()],
      );

      return rows[0]?.id ?? '';
    };

    return {
      userId: ownerId,
      liveTeamId: await team('Platform', false),
      deletedTeamId: await team('Retired', true),
    };
  });

const inTenant = <T>(work: (repository: PrismaInvitationRepository) => Promise<T>): Promise<T> =>
  withTenant(prisma, { organizationId: ORG, userId: null }, () =>
    work(new PrismaInvitationRepository()),
  );

const memberships = async (): Promise<string[]> =>
  asMaintenance(pools.owner, async (client) => {
    const { rows } = await client.query<{ team_id: string }>(
      `SELECT team_id FROM team_members WHERE organization_id = $1::uuid ORDER BY team_id`,
      [ORG],
    );

    return rows.map((row) => row.team_id);
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

describe('joining the teams an invitation named', () => {
  it('CONTROL: puts the person in the team the invitation carried', async () => {
    const written = await inTenant((repository) =>
      repository.joinTeams(seeded.userId, [seeded.liveTeamId]),
    );

    expect(written).toBe(1);
    expect(await memberships()).toEqual([seeded.liveTeamId]);
  });

  it('is idempotent, so retrying the whole acceptance does not fail on the second run', async () => {
    await inTenant((repository) => repository.joinTeams(seeded.userId, [seeded.liveTeamId]));

    const second = await inTenant((repository) =>
      repository.joinTeams(seeded.userId, [seeded.liveTeamId]),
    );

    expect(second).toBe(0);
    expect(await memberships()).toEqual([seeded.liveTeamId]);
  });

  it('skips a team deleted while the invitation was open, instead of failing the acceptance', async () => {
    const written = await inTenant((repository) =>
      repository.joinTeams(seeded.userId, [seeded.liveTeamId, seeded.deletedTeamId]),
    );

    expect(written).toBe(1);
    expect(await memberships()).toEqual([seeded.liveTeamId]);
  });

  it('writes nothing when the invitation named no team', async () => {
    expect(await inTenant((repository) => repository.joinTeams(seeded.userId, []))).toBe(0);
    expect(await memberships()).toEqual([]);
  });
});

describe('spending an invitation', () => {
  const draft = (expiresAt: Date): InvitationDraftRow => ({
    email: `invitee-${ORG.slice(0, 8)}@example.test`,
    tokenHash: Buffer.from(`${ORG}-token`.padEnd(32, '0').slice(0, 32)),
    roleId: null,
    teamIds: [],
    locale: 'en',
    expiresAt,
    invitedById: seeded.userId,
  });

  const inSevenDays = (): Date => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  it('CONTROL: spends a live invitation and hands back what it carried', async () => {
    const live = draft(inSevenDays());
    const invitationId = await inTenant((repository) => repository.create(live));

    const spent = await inTenant((repository) =>
      repository.accept(invitationId, seeded.userId, new Date()),
    );

    expect(spent).toMatchObject({ email: live.email, roleId: null, teamIds: [] });
  });

  it('answers null the second time, which is the whole single-use guarantee', async () => {
    const invitationId = await inTenant((repository) => repository.create(draft(inSevenDays())));

    await inTenant((repository) => repository.accept(invitationId, seeded.userId, new Date()));

    // The predicate carries `accepted_at IS NULL`, so the second `UPDATE` matches no row and
    // `RETURNING` yields nothing. Two winners here would mean two accounts on one invitation.
    expect(
      await inTenant((repository) => repository.accept(invitationId, seeded.userId, new Date())),
    ).toBeNull();
  });

  it('answers null for an invitation that expired, without a separate branch', async () => {
    const invitationId = await inTenant((repository) => repository.create(draft(inSevenDays())));

    // The clock moves, not the row. An already-expired invitation cannot be inserted at all —
    // `ck_invitations_expiry` refuses it, which is the database saying the same thing this test is
    // about — so the honest way to reach the `expires_at > $now` half of the predicate is to arrive
    // late. «Spent» and «expired» are one outcome in the SQL as well as in the answer, which is what
    // keeps them one 410 on the wire.
    const tooLate = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000);

    expect(
      await inTenant((repository) => repository.accept(invitationId, seeded.userId, tooLate)),
    ).toBeNull();
  });
});
