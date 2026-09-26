import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { type SharedPermissions } from '@bad-crm/shared';

import { DeleteCustomRoleUseCase } from '@/application/iam/use-cases/delete-custom-role.use-case.js';
import { DeleteTeamUseCase } from '@/application/iam/use-cases/delete-team.use-case.js';
import { type Actor } from '@/domain/access/actor.types.js';
import { PrismaCustomRoleRepository } from '@/infrastructure/persistence/prisma/custom-role.repository.js';
import { PrismaResourceAclRepository } from '@/infrastructure/persistence/prisma/resource-acl.repository.js';
import { PrismaTeamRepository } from '@/infrastructure/persistence/prisma/team.repository.js';
import { PrismaUnitOfWork } from '@/infrastructure/persistence/prisma/unit-of-work.adapter.js';

import { FakeAuditLogger } from '../../support/identity-doubles.util.js';

import {
  asMaintenance,
  closePools,
  createPools,
  insertOrganizationWithOwner,
  truncateAll,
  type HarnessPools,
} from './db-harness.util.js';

/**
 * The two subject cascades of `resource_acl`, end to end on a real PostgreSQL: a deleted role
 * (STORY-011-06 acceptance 13) and a disbanded team (STORY-012-07 acceptance 5) take their grants
 * with them, in the transaction of the deletion.
 *
 * What only the database can say, and a recorder would pass with the product broken:
 *
 * 1. **the statement is accepted** — `$n::acl_subject_type` and `RETURNING` over a table under
 *    `FORCE RLS`, run as `app_user`;
 * 2. **the rows are really gone**, counted by the migrator in maintenance mode rather than by the
 *    repository that removed them;
 * 3. **the other organization is untouched** — a grant there naming the *same* subject uuid (the
 *    subject has no foreign key, so nothing stops such a row from existing) survives. The tenant
 *    predicate of the statement and the RLS policy both stand between them; this is the fact, not
 *    which of the two held it;
 * 4. **the neighbours are untouched** — another role, a team, a person, on the same project.
 *
 * Every describe opens with a `CONTROL:` case (`rules/testing.mdc`, 4): the fixture is proved to be
 * there before its absence is asserted.
 */

let pools: HarnessPools;
let prisma: PrismaClient;

const ORG = randomUUID();
const OTHER_ORG = randomUUID();
const PROJECT_A = randomUUID();
const PROJECT_B = randomUUID();

interface Seeded {
  readonly ownerId: string;
  readonly ivanId: string;
  readonly petrId: string;
  readonly roleId: string;
  readonly otherRoleId: string;
  readonly teamId: string;
  readonly otherTeamId: string;
}

let seeded: Seeded;

type Client = Parameters<typeof insertOrganizationWithOwner>[0];

const insertUser = async (client: Client, organizationId: string): Promise<string> => {
  const userId = randomUUID();

  await client.query(
    `INSERT INTO users (id, organization_id, email, password_hash, status, updated_at)
     VALUES ($1::uuid, $2::uuid, $3, 'placeholder-not-a-credential', 'ACTIVE', now())`,
    [userId, organizationId, `member-${userId.slice(0, 8)}@example.test`],
  );

  return userId;
};

const insertRole = async (client: Client, key: string): Promise<string> => {
  const roleId = randomUUID();

  await client.query(
    `INSERT INTO roles (id, organization_id, key, name, updated_at)
     VALUES ($1::uuid, $2::uuid, $3, $3, now())`,
    [roleId, ORG, key],
  );

  return roleId;
};

const insertTeam = async (client: Client, slug: string): Promise<string> => {
  const teamId = randomUUID();

  await client.query(
    `INSERT INTO teams (id, organization_id, name, slug, updated_at)
     VALUES ($1::uuid, $2::uuid, $3, $3, now())`,
    [teamId, ORG, slug],
  );

  return teamId;
};

const grant = async (
  client: Client,
  row: {
    readonly organizationId?: string;
    readonly resourceId: string;
    readonly subjectType: SharedPermissions.AclSubjectType;
    readonly subjectId: string;
    readonly level: SharedPermissions.AccessLevel;
  },
): Promise<void> => {
  await client.query(
    `INSERT INTO resource_acl
       (organization_id, resource_type, resource_id, subject_type, subject_id, access_level,
        updated_at)
     VALUES ($1::uuid, 'PROJECT', $2::uuid, $3::acl_subject_type, $4::uuid, $5::access_level,
             now())`,
    [row.organizationId ?? ORG, row.resourceId, row.subjectType, row.subjectId, row.level],
  );
};

/** Written by the migrator, so the fixture is never what the tenant is refused. */
const seed = (): Promise<Seeded> =>
  asMaintenance(pools.owner, async (client) => {
    const { ownerId } = await insertOrganizationWithOwner(client, ORG, {
      slug: `cascade-${ORG.slice(0, 8)}`,
    });

    await insertOrganizationWithOwner(client, OTHER_ORG, {
      slug: `other-${OTHER_ORG.slice(0, 8)}`,
    });

    const ivanId = await insertUser(client, ORG);
    const petrId = await insertUser(client, ORG);
    const roleId = await insertRole(client, 'tech_writer');
    const otherRoleId = await insertRole(client, 'reviewer');
    const teamId = await insertTeam(client, 'backend');
    const otherTeamId = await insertTeam(client, 'frontend');

    await client.query(
      `INSERT INTO user_roles (organization_id, user_id, role_id, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, now())`,
      [ORG, petrId, roleId],
    );
    await client.query(
      `INSERT INTO team_members (organization_id, team_id, user_id, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, now())`,
      [ORG, teamId, ivanId],
    );

    // The subjects under test, each on two projects.
    await grant(client, {
      resourceId: PROJECT_A,
      subjectType: 'ROLE',
      subjectId: roleId,
      level: 'EDITOR',
    });
    await grant(client, {
      resourceId: PROJECT_B,
      subjectType: 'ROLE',
      subjectId: roleId,
      level: 'VIEWER',
    });
    await grant(client, {
      resourceId: PROJECT_A,
      subjectType: 'TEAM',
      subjectId: teamId,
      level: 'EDITOR',
    });
    await grant(client, {
      resourceId: PROJECT_B,
      subjectType: 'TEAM',
      subjectId: teamId,
      level: 'NONE',
    });

    // Neighbours of this organization: another role, another team, a person — same project.
    await grant(client, {
      resourceId: PROJECT_A,
      subjectType: 'ROLE',
      subjectId: otherRoleId,
      level: 'MANAGER',
    });
    await grant(client, {
      resourceId: PROJECT_A,
      subjectType: 'TEAM',
      subjectId: otherTeamId,
      level: 'VIEWER',
    });
    await grant(client, {
      resourceId: PROJECT_A,
      subjectType: 'USER',
      subjectId: ivanId,
      level: 'COMMENTER',
    });

    // The other organization, naming the very same subject uuids: no foreign key forbids it.
    await grant(client, {
      organizationId: OTHER_ORG,
      resourceId: PROJECT_A,
      subjectType: 'ROLE',
      subjectId: roleId,
      level: 'EDITOR',
    });
    await grant(client, {
      organizationId: OTHER_ORG,
      resourceId: PROJECT_A,
      subjectType: 'TEAM',
      subjectId: teamId,
      level: 'EDITOR',
    });

    return { ownerId, ivanId, petrId, roleId, otherRoleId, teamId, otherTeamId };
  });

/** Every grant in the installation, as `organization:SUBJECT_TYPE:subject`, read past RLS. */
const allGrants = (): Promise<string[]> =>
  asMaintenance(pools.owner, async (client) => {
    const { rows } = await client.query<{ key: string }>(
      `SELECT organization_id || ':' || subject_type || ':' || subject_id AS key
         FROM resource_acl
        ORDER BY key`,
    );

    return rows.map((row) => row.key);
  });

const versionOf = (userId: string): Promise<number> =>
  asMaintenance(pools.owner, async (client) => {
    const { rows } = await client.query<{ permissions_version: number }>(
      'SELECT permissions_version FROM users WHERE id = $1::uuid',
      [userId],
    );

    return rows[0]?.permissions_version ?? Number.NaN;
  });

const owner = (): Actor => ({
  userId: seeded.ownerId,
  organizationId: ORG,
  isOwner: true,
  permissionsVersion: 1,
  permissions: new Set<SharedPermissions.PermissionKey>(['role:delete', 'team:delete']),
  denied: new Set<SharedPermissions.PermissionKey>(),
  roleKeys: [],
});

const key = (organizationId: string, type: string, id: string): string =>
  `${organizationId}:${type}:${id}`;

beforeAll(() => {
  pools = createPools();
  prisma = new PrismaClient({ datasourceUrl: inject('databaseUrls').appUser });
});

afterAll(async () => {
  await truncateAll(pools.owner);
  await prisma.$disconnect();
  await closePools(pools);
});

beforeEach(async () => {
  await truncateAll(pools.owner);
  seeded = await seed();
});

describe('deleting a role takes its grants (STORY-011-06, acceptance 13)', () => {
  const deleteRole = (audit = new FakeAuditLogger()): Promise<void> =>
    new DeleteCustomRoleUseCase(
      new PrismaUnitOfWork(prisma),
      new PrismaCustomRoleRepository(),
      new PrismaResourceAclRepository(),
      audit,
    ).execute({ actor: owner(), roleId: seeded.roleId, ipAddress: '203.0.113.9' });

  it('CONTROL: the role holds two grants here and one elsewhere before the deletion', async () => {
    const grants = await allGrants();

    expect(grants.filter((row) => row === key(ORG, 'ROLE', seeded.roleId))).toHaveLength(2);
    expect(grants).toContain(key(OTHER_ORG, 'ROLE', seeded.roleId));
  });

  it('removes both grants of the role, and nothing of anybody else, here or elsewhere', async () => {
    const before = await allGrants();

    await deleteRole();

    expect(await allGrants()).toEqual(
      before.filter((row) => row !== key(ORG, 'ROLE', seeded.roleId)).sort(),
    );
    // Positive controls, by name: the neighbours and the other organization survived.
    expect(await allGrants()).toEqual(
      expect.arrayContaining([
        key(ORG, 'ROLE', seeded.otherRoleId),
        key(ORG, 'TEAM', seeded.teamId),
        key(ORG, 'USER', seeded.ivanId),
        key(OTHER_ORG, 'ROLE', seeded.roleId),
      ]),
    );
  });

  it('bumps the holder the grants reached, and files one acl.revoked per grant', async () => {
    const audit = new FakeAuditLogger();
    const petrBefore = await versionOf(seeded.petrId);
    const ivanBefore = await versionOf(seeded.ivanId);

    await deleteRole(audit);

    expect(await versionOf(seeded.petrId)).toBe(petrBefore + 1);
    // CONTROL: a person who never held the role is not bumped.
    expect(await versionOf(seeded.ivanId)).toBe(ivanBefore);
    expect(audit.events.map((event) => event.action)).toEqual([
      'role.deleted',
      'acl.revoked',
      'acl.revoked',
    ]);
    expect(
      audit.events
        .slice(1)
        .map((event) => [event.before?.['resourceId'], event.before?.['accessLevel']])
        .sort(),
    ).toEqual(
      [
        [PROJECT_A, 'EDITOR'],
        [PROJECT_B, 'VIEWER'],
      ].sort(),
    );
  });
});

describe('disbanding a team takes its grants (STORY-012-07, acceptance 5)', () => {
  const disband = (audit = new FakeAuditLogger()): Promise<void> =>
    new DeleteTeamUseCase(
      new PrismaUnitOfWork(prisma),
      new PrismaTeamRepository(),
      new PrismaResourceAclRepository(),
      audit,
    ).execute({ actor: owner(), teamId: seeded.teamId, ipAddress: '203.0.113.9' });

  it('CONTROL: the team holds two grants here and one elsewhere before the disbanding', async () => {
    const grants = await allGrants();

    expect(grants.filter((row) => row === key(ORG, 'TEAM', seeded.teamId))).toHaveLength(2);
    expect(grants).toContain(key(OTHER_ORG, 'TEAM', seeded.teamId));
  });

  it('removes both grants of the team, and nothing of anybody else, here or elsewhere', async () => {
    const before = await allGrants();

    await disband();

    expect(await allGrants()).toEqual(
      before.filter((row) => row !== key(ORG, 'TEAM', seeded.teamId)).sort(),
    );
    expect(await allGrants()).toEqual(
      expect.arrayContaining([
        key(ORG, 'TEAM', seeded.otherTeamId),
        key(ORG, 'ROLE', seeded.roleId),
        key(ORG, 'USER', seeded.ivanId),
        key(OTHER_ORG, 'TEAM', seeded.teamId),
      ]),
    );
  });

  it('bumps the former member, and files team.deleted then one acl.revoked per grant', async () => {
    const audit = new FakeAuditLogger();
    const ivanBefore = await versionOf(seeded.ivanId);
    const petrBefore = await versionOf(seeded.petrId);

    await disband(audit);

    expect(await versionOf(seeded.ivanId)).toBe(ivanBefore + 1);
    // CONTROL: somebody who was never on the team is not bumped.
    expect(await versionOf(seeded.petrId)).toBe(petrBefore);
    expect(audit.events.map((event) => event.action)).toEqual([
      'team.deleted',
      'acl.revoked',
      'acl.revoked',
    ]);
    expect(audit.events.slice(1).map((event) => event.after)).toEqual([
      { cause: 'team.deleted' },
      { cause: 'team.deleted' },
    ]);
  });
});
