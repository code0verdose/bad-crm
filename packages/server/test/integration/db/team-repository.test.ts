import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { ConflictError } from '@/domain/shared/errors/app.errors.js';
import { PrismaTeamRepository } from '@/infrastructure/persistence/prisma/team.repository.js';
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
 * The team repository against a real PostgreSQL — STORY-012-07.
 *
 * Four things in this file are only decidable by the database, and a test over a recording driver
 * would pass on all four while the product was broken:
 *
 * 1. **`uq_teams_org_slug` is partial and scoped to the organization.** «Unique inside the
 *    organization» is an assertion about an index, and the index is `WHERE deleted_at IS NULL` — so
 *    two organizations may use one slug and one organization may reuse a slug it freed. Neither
 *    property is visible in the ORM schema: Prisma models no partial index, which is why the
 *    constraint lives only in the migration.
 * 2. **`ON CONFLICT (team_id, user_id) DO NOTHING`** — the conflict target is named by columns
 *    because `uq_team_members` is a unique *index*, and `ON CONFLICT ON CONSTRAINT` is resolved
 *    against `pg_constraint` at parse time. The wrong spelling fails on **every** call, not only on
 *    a conflict, and a stubbed `$executeRaw` cannot tell the difference.
 * 3. **`DELETE … RETURNING user_id`** — the ids it hands back are the only record that the
 *    memberships existed, because `team_members` has no `deleted_at`.
 * 4. **`UPDATE … WHERE id = ANY($n::uuid[])`** — one statement for the whole team, whatever its
 *    size. Whether the array cast is accepted is a question for the server, not for a mock.
 *
 * Every describe opens with a `CONTROL:` case, per `rules/testing.mdc`, 4: a suite whose negatives
 * all pass because nothing is visible is a suite that passes on a broken connection.
 */

let pools: HarnessPools;
let prisma: PrismaClient;

const ORG = randomUUID();
const OTHER_ORG = randomUUID();

interface Seeded {
  readonly ownerId: string;
  readonly ivanId: string;
  readonly petrId: string;
  readonly teamId: string;
  /**
   * A second live team of **this** organization, seeded so `disband(teamId)` has a sibling to
   * leave alone. Without one, a disband whose `WHERE` lost its `id`/`team_id` predicate and fell
   * back to `organization_id` alone would still disband — and unstaff — only the single team this
   * tenant has, and the positive control below would pass over a broken statement.
   */
  readonly siblingTeamId: string;
  /** A team of the other organization, addressed to prove this tenant cannot see it. */
  readonly foreignTeamId: string;
}

let seeded: Seeded;

const insertTeam = async (
  client: Parameters<typeof insertOrganizationWithOwner>[0],
  organizationId: string,
  slug: string,
  deleted = false,
): Promise<string> => {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO teams (organization_id, name, slug, deleted_at, updated_at)
     VALUES ($1::uuid, $2, $2, ${deleted ? 'now()' : 'NULL'}, now())
     RETURNING id`,
    [organizationId, slug],
  );

  return rows[0]?.id ?? '';
};

const insertUser = async (
  client: Parameters<typeof insertOrganizationWithOwner>[0],
  organizationId: string,
  status: 'ACTIVE' | 'SUSPENDED',
): Promise<string> => {
  const userId = randomUUID();

  await client.query(
    `INSERT INTO users (id, organization_id, email, password_hash, status, updated_at)
     VALUES ($1::uuid, $2::uuid, $3, 'placeholder-not-a-credential', $4, now())`,
    [userId, organizationId, `member-${userId.slice(0, 8)}@example.test`, status],
  );

  return userId;
};

const seed = async (): Promise<Seeded> =>
  asMaintenance(pools.owner, async (client) => {
    const { ownerId } = await insertOrganizationWithOwner(client, ORG, {
      slug: `teams-${ORG.slice(0, 8)}`,
    });

    await insertOrganizationWithOwner(client, OTHER_ORG, {
      slug: `other-${OTHER_ORG.slice(0, 8)}`,
    });

    return {
      ownerId,
      ivanId: await insertUser(client, ORG, 'ACTIVE'),
      petrId: await insertUser(client, ORG, 'ACTIVE'),
      teamId: await insertTeam(client, ORG, 'backend'),
      siblingTeamId: await insertTeam(client, ORG, 'frontend'),
      // A different slug on purpose: `backend` is left free in the other organization so that the
      // control below can take it **through `app_user`**. Seeding it here would prove the same
      // property as the migrator, which is not the role the product runs as.
      foreignTeamId: await insertTeam(client, OTHER_ORG, 'their-team'),
    };
  });

const inTenant = <T>(
  work: (repository: PrismaTeamRepository) => Promise<T>,
  organizationId = ORG,
): Promise<T> =>
  withTenant(prisma, { organizationId, userId: null }, () => work(new PrismaTeamRepository()));

const versionOf = async (userId: string): Promise<number> =>
  asMaintenance(pools.owner, async (client) => {
    const { rows } = await client.query<{ permissions_version: number }>(
      `SELECT permissions_version FROM users WHERE id = $1::uuid`,
      [userId],
    );

    return rows[0]?.permissions_version ?? -1;
  });

const membershipCount = async (teamId: string): Promise<number> =>
  asMaintenance(pools.owner, async (client) => {
    const { rows } = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM team_members WHERE team_id = $1::uuid`,
      [teamId],
    );

    return Number(rows[0]?.count ?? '-1');
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

describe('the slug is unique inside the organization', () => {
  it('CONTROL: a free slug is accepted', async () => {
    const teamId = await inTenant((repository) =>
      repository.create({ name: 'Growth', slug: 'growth', description: null }),
    );

    expect(teamId).toEqual(expect.any(String));
  });

  it('refuses a slug another live team of this organization already uses', async () => {
    await expect(
      inTenant((repository) =>
        repository.create({ name: 'Backend again', slug: 'backend', description: null }),
      ),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  /**
   * The positive control the uniqueness needs: `uq_teams_org_slug` is on
   * `(organization_id, slug)`, so a slug is an organization's own vocabulary. A globally unique
   * index would have made the same negative above pass while quietly telling one tenant which names
   * another had taken.
   */
  it('CONTROL: allows the same slug in another organization', async () => {
    const teamId = await inTenant(
      (repository) => repository.create({ name: 'Backend', slug: 'backend', description: null }),
      OTHER_ORG,
    );

    expect(teamId).toEqual(expect.any(String));
  });

  /**
   * The index is partial (`WHERE deleted_at IS NULL`), which is what makes disbanding a team free
   * its name. Without the partial clause this insert would fail and a team name would be spent
   * forever the first time somebody used it.
   */
  it('CONTROL: allows a slug freed by disbanding the team that held it', async () => {
    await inTenant((repository) => repository.disband(seeded.teamId));

    const teamId = await inTenant((repository) =>
      repository.create({ name: 'Backend', slug: 'backend', description: null }),
    );

    expect(teamId).toEqual(expect.any(String));
  });
});

/**
 * `update()` runs the same `uq_teams_org_slug` through `updateMany` rather than `create`, and the
 * base class translates the violation the same way (`P2002` → `${resource}_already_exists`) — but
 * that translation is generic over every statement this repository issues, and until now nothing
 * proved it actually fires for a rename. A mutant that dropped the `P2002` branch, or one that broke
 * `updateMany`'s ability to raise it in the first place, would have left every existing suite green.
 */
describe('renaming a team into an already-used slug', () => {
  it('refuses the slug of another live team of this organization', async () => {
    await expect(
      inTenant((repository) =>
        repository.update(seeded.siblingTeamId, {
          name: 'Frontend',
          slug: 'backend',
          description: null,
        }),
      ),
    ).rejects.toBeInstanceOf(ConflictError);

    // Refused before anything changed: the sibling keeps its own slug rather than ending up
    // half-renamed.
    await expect(
      inTenant((repository) => repository.detail(seeded.siblingTeamId)),
    ).resolves.toMatchObject({ slug: 'frontend' });
  });

  /**
   * The positive control the uniqueness needs, mirroring the one `create` has above: the index is
   * `(organization_id, slug)`, so a slug taken in another organization is not taken here. Without
   * this control the negative case above would also pass with a globally unique index — which would
   * make renaming into a slug an unrelated tenant happens to hold fail for no reason this tenant can
   * see.
   */
  it('CONTROL: allows the slug of a team that only exists in another organization', async () => {
    await expect(
      inTenant((repository) =>
        repository.update(seeded.teamId, {
          name: 'Their Team',
          slug: 'their-team',
          description: null,
        }),
      ),
    ).resolves.toBe(true);
  });
});

describe('reading a team', () => {
  it('CONTROL: the tenant sees its own team, with its members', async () => {
    await inTenant((repository) => repository.addMember(seeded.teamId, seeded.ivanId, 'LEAD'));

    await expect(inTenant((repository) => repository.detail(seeded.teamId))).resolves.toMatchObject(
      {
        slug: 'backend',
        isDeleted: false,
        memberCount: 1,
        members: [{ userId: seeded.ivanId, teamRole: 'LEAD' }],
      },
    );
  });

  /** Acceptance 7, at the level that actually enforces it: the row-level-security policy. */
  it('answers null for a team of another organization', async () => {
    await expect(
      inTenant((repository) => repository.scope(seeded.foreignTeamId)),
    ).resolves.toBeNull();
  });

  /** The same acceptance, through `detail` rather than `scope` — the two reads share the predicate. */
  it('answers null for the detail of a team of another organization', async () => {
    await expect(
      inTenant((repository) => repository.detail(seeded.foreignTeamId)),
    ).resolves.toBeNull();
  });

  /**
   * A disbanded team is returned by `scope`/`detail` and flagged, not filtered. The decision is the
   * policy's; a `WHERE deleted_at IS NULL` here would take it away and leave the branch that answers
   * 404 for a disbanded team unreachable.
   */
  it('returns a disbanded team flagged rather than hidden', async () => {
    await inTenant((repository) => repository.disband(seeded.teamId));

    await expect(inTenant((repository) => repository.scope(seeded.teamId))).resolves.toMatchObject({
      isDeleted: true,
    });
  });

  /** The list is the one read that must filter, and it filters in SQL. */
  it('leaves a disbanded team out of the list', async () => {
    await inTenant((repository) => repository.disband(seeded.teamId));

    // The sibling team seeded alongside `teamId` (see `Seeded.siblingTeamId`) stays live and stays
    // listed — the assertion is that the disbanded team specifically is gone, not that the tenant's
    // list emptied out.
    await expect(inTenant((repository) => repository.list())).resolves.toEqual([
      expect.objectContaining({ teamId: seeded.siblingTeamId }),
    ]);
  });
});

describe('membership', () => {
  it('CONTROL: writes a membership and reports that it appeared', async () => {
    await expect(
      inTenant((repository) => repository.addMember(seeded.teamId, seeded.ivanId, 'MEMBER')),
    ).resolves.toEqual({ outcome: 'created', previousRole: null });

    expect(await membershipCount(seeded.teamId)).toBe(1);
  });

  /**
   * `ON CONFLICT (team_id, user_id) DO UPDATE … WHERE team_role <> EXCLUDED.team_role`, parsed by
   * the server. The spelling that names the constraint instead would have failed on the CONTROL
   * above rather than here — which is exactly why the control is there.
   */
  it('is idempotent and says so: a repeat with the same role reports unchanged', async () => {
    await inTenant((repository) => repository.addMember(seeded.teamId, seeded.ivanId, 'MEMBER'));

    await expect(
      inTenant((repository) => repository.addMember(seeded.teamId, seeded.ivanId, 'MEMBER')),
    ).resolves.toEqual({ outcome: 'unchanged', previousRole: null });

    expect(await membershipCount(seeded.teamId)).toBe(1);
  });

  /**
   * The gate's L-3, on a live server: before the fix this was the exact scenario a bare `DO NOTHING`
   * turned into a silent no-op — a repeat `POST` naming `LEAD` for an existing `MEMBER` answered 204
   * and changed nothing. The `WHERE` clause on the `DO UPDATE` is what makes the difference, and only
   * PostgreSQL can confirm it actually fires.
   */
  it('reports role_changed and moves the row when a repeat names a different role', async () => {
    await inTenant((repository) => repository.addMember(seeded.teamId, seeded.ivanId, 'MEMBER'));

    await expect(
      inTenant((repository) => repository.addMember(seeded.teamId, seeded.ivanId, 'LEAD')),
    ).resolves.toEqual({ outcome: 'role_changed', previousRole: 'MEMBER' });

    expect(await membershipCount(seeded.teamId)).toBe(1);
    await expect(inTenant((repository) => repository.detail(seeded.teamId))).resolves.toMatchObject(
      {
        members: [{ userId: seeded.ivanId, teamRole: 'LEAD' }],
      },
    );
  });

  it('refuses a team role the CHECK constraint does not allow', async () => {
    await expect(
      inTenant((repository) => repository.addMember(seeded.teamId, seeded.ivanId, 'OWNER')),
    ).rejects.toThrow();
  });

  it('CONTROL: removes a membership and reports it', async () => {
    await inTenant((repository) => repository.addMember(seeded.teamId, seeded.ivanId, 'MEMBER'));

    await expect(
      inTenant((repository) => repository.removeMember(seeded.teamId, seeded.ivanId)),
    ).resolves.toBe(true);

    expect(await membershipCount(seeded.teamId)).toBe(0);
  });

  it('reports nothing removed when there was no membership', async () => {
    await expect(
      inTenant((repository) => repository.removeMember(seeded.teamId, seeded.ivanId)),
    ).resolves.toBe(false);
  });

  /** Acceptance 9, at the source: the repository reports the status the policy refuses on. */
  it('reports the status of the account a membership would be written for', async () => {
    const suspended = await asMaintenance(pools.owner, (client) =>
      insertUser(client, ORG, 'SUSPENDED'),
    );

    await expect(inTenant((repository) => repository.subject(suspended))).resolves.toMatchObject({
      status: 'SUSPENDED',
    });
  });

  it('answers null for an account of another organization', async () => {
    const foreigner = await asMaintenance(pools.owner, (client) =>
      insertUser(client, OTHER_ORG, 'ACTIVE'),
    );

    await expect(inTenant((repository) => repository.subject(foreigner))).resolves.toBeNull();
  });
});

describe('disbanding a team', () => {
  /**
   * Acceptance 5, minus the ACL cascade that has nothing to cascade over. The two roles are
   * deliberately different — `LEAD` and `MEMBER` — because a fixture where everybody held the same
   * role would not notice `team_role` dropped from the `RETURNING` clause: the test would still see
   * the right *count* of members back.
   */
  it('CONTROL: hides the team, deletes every membership and returns who held one, with their role', async () => {
    await inTenant((repository) => repository.addMember(seeded.teamId, seeded.ivanId, 'LEAD'));
    await inTenant((repository) => repository.addMember(seeded.teamId, seeded.petrId, 'MEMBER'));

    const disbanded = await inTenant((repository) => repository.disband(seeded.teamId));

    expect(disbanded?.name).toBe('backend');
    const byUser = (left: { userId: string }, right: { userId: string }): number =>
      left.userId.localeCompare(right.userId);

    expect([...(disbanded?.members ?? [])].sort(byUser)).toEqual(
      [
        { userId: seeded.ivanId, teamRole: 'LEAD' },
        { userId: seeded.petrId, teamRole: 'MEMBER' },
      ].sort(byUser),
    );
    expect(await membershipCount(seeded.teamId)).toBe(0);
  });

  /** The concurrent-delete window: the second caller must not file a deletion somebody else made. */
  it('answers null the second time', async () => {
    await inTenant((repository) => repository.disband(seeded.teamId));

    await expect(inTenant((repository) => repository.disband(seeded.teamId))).resolves.toBeNull();
  });

  it('answers null for a team of another organization', async () => {
    await expect(
      inTenant((repository) => repository.disband(seeded.foreignTeamId)),
    ).resolves.toBeNull();
  });

  it('returns an empty roster for a team nobody was on', async () => {
    await expect(
      inTenant((repository) => repository.disband(seeded.teamId)),
    ).resolves.toMatchObject({ members: [] });
  });

  /**
   * The positive control `bumpPermissionsVersionOf` has (`leaves everybody else alone`, below) and
   * `disband` was missing: both statements name the team as well as the organization, and a `WHERE`
   * that lost the `id`/`team_id` half and fell back to `organization_id` alone would disband and
   * unstaff every team of this tenant, not just the one addressed. With a single live team the
   * `CONTROL` test above cannot tell the difference — it would still see its own team hidden and its
   * own memberships gone. A sibling team makes the missing predicate visible.
   */
  it('leaves a sibling team of the same organization untouched', async () => {
    await inTenant((repository) =>
      repository.addMember(seeded.siblingTeamId, seeded.ivanId, 'LEAD'),
    );

    await inTenant((repository) => repository.disband(seeded.teamId));

    await expect(
      inTenant((repository) => repository.scope(seeded.siblingTeamId)),
    ).resolves.toMatchObject({ isDeleted: false });
    expect(await membershipCount(seeded.siblingTeamId)).toBe(1);
  });
});

describe('invalidating the folded permission view', () => {
  it('CONTROL: bumps every named account in one statement', async () => {
    const before = await Promise.all([versionOf(seeded.ivanId), versionOf(seeded.petrId)]);

    await inTenant((repository) =>
      repository.bumpPermissionsVersionOf([seeded.ivanId, seeded.petrId]),
    );

    // The `= ANY($n::uuid[])` cast, executed rather than asserted as a substring: an array that the
    // server refuses would leave both versions untouched and be indistinguishable from a no-op in a
    // test that only checked the SQL text.
    expect(await Promise.all([versionOf(seeded.ivanId), versionOf(seeded.petrId)])).toEqual(
      before.map((version) => version + 1),
    );
  });

  it('leaves everybody else alone', async () => {
    const untouched = await versionOf(seeded.petrId);

    await inTenant((repository) => repository.bumpPermissionsVersionOf([seeded.ivanId]));

    expect(await versionOf(seeded.petrId)).toBe(untouched);
  });

  /** Fail-closed on the empty case: disbanding a team nobody was on sends no statement. */
  it('sends nothing for an empty list', async () => {
    const before = await versionOf(seeded.ivanId);

    await inTenant((repository) => repository.bumpPermissionsVersionOf([]));

    expect(await versionOf(seeded.ivanId)).toBe(before);
  });

  /**
   * The second rubber: row-level security refuses the write even if the statement asked for it.
   *
   * What this does **not** prove is that the statement carries its own
   * `organization_id = current_scope` predicate — deleting that predicate leaves this test green,
   * because the policy filters the row either way. That half is pinned by
   * `test/unit/persistence/team-repository.test.ts`, which asserts the bound values of the
   * statement. Both are worth having, and saying so here is the difference between a test that
   * documents a defence and a comment that claims one nobody checked.
   */
  it('cannot bump an account of another organization', async () => {
    const foreigner = await asMaintenance(pools.owner, (client) =>
      insertUser(client, OTHER_ORG, 'ACTIVE'),
    );
    const before = await versionOf(foreigner);

    await inTenant((repository) => repository.bumpPermissionsVersionOf([foreigner]));

    expect(await versionOf(foreigner)).toBe(before);
  });
});
