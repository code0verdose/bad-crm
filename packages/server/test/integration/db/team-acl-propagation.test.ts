import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { type PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { type SharedPermissions } from '@bad-crm/shared';

import { GrantAclUseCase } from '@/application/access/use-cases/grant-acl.use-case.js';
import { ResolveAclQuery } from '@/application/access/use-cases/resolve-acl.query.js';
import {
  AddTeamMemberUseCase,
  RemoveTeamMemberUseCase,
} from '@/application/iam/use-cases/manage-team-members.use-case.js';
import { DeleteTeamUseCase } from '@/application/iam/use-cases/delete-team.use-case.js';
import { GetProjectDetailQuery } from '@/application/project/use-cases/get-project-detail.query.js';
import { UpdateProjectUseCase } from '@/application/project/use-cases/update-project.use-case.js';
import { type Actor } from '@/domain/access/actor.types.js';
import { PrismaAclReader } from '@/infrastructure/persistence/prisma/acl-reader.adapter.js';
import { PrismaProjectAccessReader } from '@/infrastructure/persistence/prisma/project-access-reader.adapter.js';
import { PrismaProjectMemberRepository } from '@/infrastructure/persistence/prisma/project-member.repository.js';
import { PrismaProjectRepository } from '@/infrastructure/persistence/prisma/project.repository.js';
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
 * The team half of STORY-012-07 (acceptance 3, 4 and 6), end to end on a real PostgreSQL: a grant
 * to a team, a membership change and a level change all move the project's own access decision on
 * the very next read — through the resolver, the reader and the policy the container actually
 * wires, never a double.
 *
 * `test/integration/http/acl-endpoints.test.ts` and `team-endpoints.test.ts` already prove the wire
 * — validators, the capability guard, idempotency, the problem bodies — against `FakeProjectStore`.
 * What a double cannot show is the property this file is about: that `resource_acl.subject_id`
 * naming a team is resolved by **joining `team_members` inside the same statement**
 * (`acl-reader.adapter.ts`), so a membership change is not a cache to invalidate — the very next
 * read already joins against the row as it now stands. `resource-acl-reader.test.ts` proves that
 * join in isolation, one grant at a time; this file is the chain a person actually lives through —
 * join a team that already holds a grant, get taken off it, watch a lead narrow the grant under
 * their feet — composed from the same production use-cases `container.factory.ts` wires, wired here
 * over real repositories instead of the container's HTTP transport (`rules/testing.mdc`, level
 * "integration"; the transport itself has no bearing on the property under test, and is already
 * covered by the two doubles-based suites above).
 *
 * Every describe opens with a `CONTROL:` case (`rules/testing.mdc`, 4): the negative that follows is
 * proved to mean something, not to pass on a broken connection.
 */

let pools: HarnessPools;
let prisma: PrismaClient;

const ORG = randomUUID();

interface Seeded {
  readonly ownerId: string;
  readonly ivanId: string;
  readonly petrId: string;
  readonly teamId: string;
  readonly projectId: string;
}

let seeded: Seeded;

const insertUser = async (client: PoolClient, organizationId: string): Promise<string> => {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO users (organization_id, email, password_hash, status, updated_at)
     VALUES ($1::uuid, $2, 'placeholder-not-a-credential', 'ACTIVE', now())
     RETURNING id`,
    [organizationId, `member-${randomUUID().slice(0, 8)}@example.test`],
  );

  return rows[0]?.id ?? '';
};

const insertTeam = async (client: PoolClient, organizationId: string): Promise<string> => {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO teams (organization_id, name, slug, updated_at)
     VALUES ($1::uuid, 'Backend', $2, now())
     RETURNING id`,
    [organizationId, `backend-${randomUUID().slice(0, 8)}`],
  );

  return rows[0]?.id ?? '';
};

/** A `PRIVATE` project — the shape whose implicit level is `NONE` for anyone not on it. */
const insertPrivateProject = async (
  client: PoolClient,
  organizationId: string,
  leadId: string,
): Promise<string> => {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO projects (organization_id, key, name, lead_id, color, visibility, updated_at)
     VALUES ($1::uuid, 'VAULT', 'Vault migration', $2::uuid, 'indigo', 'PRIVATE', now())
     RETURNING id`,
    [organizationId, leadId],
  );

  return rows[0]?.id ?? '';
};

const seed = async (): Promise<Seeded> =>
  asMaintenance(pools.owner, async (client) => {
    const { ownerId } = await insertOrganizationWithOwner(client, ORG, {
      slug: `team-acl-${ORG.slice(0, 8)}`,
    });
    const ivanId = await insertUser(client, ORG);
    const petrId = await insertUser(client, ORG);
    const teamId = await insertTeam(client, ORG);
    const projectId = await insertPrivateProject(client, ORG, ownerId);

    return { ownerId, ivanId, petrId, teamId, projectId };
  });

const versionOf = (userId: string): Promise<number> =>
  asMaintenance(pools.owner, async (client) => {
    const { rows } = await client.query<{ permissions_version: number }>(
      'SELECT permissions_version FROM users WHERE id = $1::uuid',
      [userId],
    );

    return rows[0]?.permissions_version ?? Number.NaN;
  });

const grantRowCount = (): Promise<number> =>
  asMaintenance(pools.owner, async (client) => {
    const { rows } = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM resource_acl
        WHERE organization_id = $1::uuid AND subject_type = 'TEAM'`,
      [ORG],
    );

    return Number(rows[0]?.count ?? '0');
  });

/**
 * The organization's owner, whose only interesting property here is that ownership replaces the
 * layers rather than enumerating them (`rules/permissions.mdc`, 9) — every team and grant command in
 * this file is run by this actor, so what is under test is never gated by the owner's own
 * capability.
 */
const owner = (): Actor => ({
  userId: seeded.ownerId,
  organizationId: ORG,
  isOwner: true,
  permissionsVersion: 1,
  permissions: new Set<SharedPermissions.PermissionKey>([
    'acl:grant',
    'team:manage_members',
    'team:delete',
  ]),
  denied: new Set<SharedPermissions.PermissionKey>(),
  roleKeys: [],
});

/**
 * A non-owner with the two capabilities a project write path needs (`project:read`,
 * `project:update`) org-wide — the shape a `lead` system role carries
 * (`system-roles.enums.ts`). What decides whether this caller actually reaches the project is not
 * this set: it is the ACL level the resolver reads on `PROJECT` — the property this whole file is
 * about — so capability is granted freely and access is carried entirely by team membership and the
 * grant.
 */
const projectActor = (userId: string): Actor => ({
  userId,
  organizationId: ORG,
  isOwner: false,
  permissionsVersion: 1,
  permissions: new Set<SharedPermissions.PermissionKey>(['project:read', 'project:update']),
  denied: new Set<SharedPermissions.PermissionKey>(),
  roleKeys: ['lead'],
});

const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};

const resolver = (): ResolveAclQuery =>
  new ResolveAclQuery({
    acl: new PrismaAclReader(),
    projects: new PrismaProjectAccessReader(),
    clock: { now: () => new Date() },
    logger: silentLogger,
  });

const grantAcl = (): GrantAclUseCase =>
  new GrantAclUseCase(
    new PrismaUnitOfWork(prisma),
    resolver(),
    new PrismaResourceAclRepository(),
    new FakeAuditLogger(),
  );

const addMember = (): AddTeamMemberUseCase =>
  new AddTeamMemberUseCase(
    new PrismaUnitOfWork(prisma),
    new PrismaTeamRepository(),
    new FakeAuditLogger(),
  );

const removeMember = (): RemoveTeamMemberUseCase =>
  new RemoveTeamMemberUseCase(
    new PrismaUnitOfWork(prisma),
    new PrismaTeamRepository(),
    new FakeAuditLogger(),
  );

const deleteTeam = (): DeleteTeamUseCase =>
  new DeleteTeamUseCase(
    new PrismaUnitOfWork(prisma),
    new PrismaTeamRepository(),
    new PrismaResourceAclRepository(),
    new FakeAuditLogger(),
  );

const readProject = (): GetProjectDetailQuery =>
  new GetProjectDetailQuery(
    new PrismaUnitOfWork(prisma),
    new PrismaProjectRepository(),
    resolver(),
  );

/** Renames the project without moving the lead — the branch this file has no business exercising. */
const writeProject = (): UpdateProjectUseCase =>
  new UpdateProjectUseCase(
    new PrismaUnitOfWork(prisma),
    new PrismaProjectRepository(),
    new PrismaProjectMemberRepository(),
    resolver(),
    new FakeAuditLogger(),
  );

const renameInput = (actor: Actor) => ({
  actor,
  ipAddress: '203.0.113.20',
  projectId: seeded.projectId,
  name: 'Vault migration, phase 2',
  description: null,
  leadId: seeded.ownerId,
  startedAt: null,
  dueAt: null,
  color: 'indigo',
});

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

describe('a team grant reaches its members immediately, and closes for the one who leaves', () => {
  it('CONTROL: before any grant, the PRIVATE project is invisible to everyone but the owner', async () => {
    await expect(
      readProject().execute({ actor: owner(), projectId: seeded.projectId }),
    ).resolves.toMatchObject({ projectId: seeded.projectId });

    await expect(
      readProject().execute({ actor: projectActor(seeded.ivanId), projectId: seeded.projectId }),
    ).rejects.toMatchObject({ code: 'project_not_found', reason: 'resource_not_found' });
  });

  it('acceptance 3: a grant to the team plus membership gives access, without a personal ACL row', async () => {
    await grantAcl().execute({
      actor: owner(),
      resource: { type: 'PROJECT', id: seeded.projectId },
      subject: { type: 'TEAM', id: seeded.teamId },
      level: 'EDITOR',
      expiresAt: null,
      ipAddress: '203.0.113.10',
    });

    // Not yet a member: the grant alone does not reach him.
    await expect(
      readProject().execute({ actor: projectActor(seeded.ivanId), projectId: seeded.projectId }),
    ).rejects.toMatchObject({ code: 'project_not_found', reason: 'resource_not_found' });

    const versionBefore = await versionOf(seeded.ivanId);

    await addMember().execute({
      actor: owner(),
      teamId: seeded.teamId,
      userId: seeded.ivanId,
      teamRole: 'MEMBER',
      ipAddress: '203.0.113.11',
    });

    // The membership itself is the only new fact — nothing was written for Ivan personally.
    const personal = await asMaintenance(pools.owner, (client) =>
      client.query(
        `SELECT count(*)::text AS count FROM resource_acl
           WHERE organization_id = $1::uuid AND subject_type = 'USER' AND subject_id = $2::uuid`,
        [ORG, seeded.ivanId],
      ),
    );

    expect(Number(personal.rows[0]?.count ?? '1')).toBe(0);
    expect(await versionOf(seeded.ivanId)).toBe(versionBefore + 1);

    await expect(
      readProject().execute({ actor: projectActor(seeded.ivanId), projectId: seeded.projectId }),
    ).resolves.toMatchObject({ projectId: seeded.projectId });

    // A bystander of the same organization, never on the team, still sees nothing (positive control
    // for the negative above: the project is not simply PUBLIC_ORG by accident of the fixture).
    await expect(
      readProject().execute({ actor: projectActor(seeded.petrId), projectId: seeded.projectId }),
    ).rejects.toMatchObject({ code: 'project_not_found', reason: 'resource_not_found' });
  });

  it('acceptance 4: leaving the team closes the project on the very next request', async () => {
    await grantAcl().execute({
      actor: owner(),
      resource: { type: 'PROJECT', id: seeded.projectId },
      subject: { type: 'TEAM', id: seeded.teamId },
      level: 'EDITOR',
      expiresAt: null,
      ipAddress: '203.0.113.10',
    });
    await addMember().execute({
      actor: owner(),
      teamId: seeded.teamId,
      userId: seeded.ivanId,
      teamRole: 'MEMBER',
      ipAddress: '203.0.113.11',
    });

    // CONTROL, inline: the door is open before it is closed.
    await expect(
      readProject().execute({ actor: projectActor(seeded.ivanId), projectId: seeded.projectId }),
    ).resolves.toMatchObject({ projectId: seeded.projectId });

    const versionBefore = await versionOf(seeded.ivanId);

    await removeMember().execute({
      actor: owner(),
      teamId: seeded.teamId,
      userId: seeded.ivanId,
      ipAddress: '203.0.113.12',
    });

    expect(await versionOf(seeded.ivanId)).toBe(versionBefore + 1);

    // The grant is untouched — it is the membership that stopped matching, not the ACL row.
    expect(await grantRowCount()).toBe(1);

    await expect(
      readProject().execute({ actor: projectActor(seeded.ivanId), projectId: seeded.projectId }),
    ).rejects.toMatchObject({ code: 'project_not_found', reason: 'resource_not_found' });
  });

  it('acceptance 6: narrowing the team grant from EDITOR to VIEWER keeps read but blocks write', async () => {
    await grantAcl().execute({
      actor: owner(),
      resource: { type: 'PROJECT', id: seeded.projectId },
      subject: { type: 'TEAM', id: seeded.teamId },
      level: 'EDITOR',
      expiresAt: null,
      ipAddress: '203.0.113.10',
    });
    await addMember().execute({
      actor: owner(),
      teamId: seeded.teamId,
      userId: seeded.ivanId,
      teamRole: 'MEMBER',
      ipAddress: '203.0.113.11',
    });

    // CONTROL, inline: EDITOR really does let him write, before it is narrowed.
    await expect(
      writeProject().execute(renameInput(projectActor(seeded.ivanId))),
    ).resolves.toBeUndefined();

    await grantAcl().execute({
      actor: owner(),
      resource: { type: 'PROJECT', id: seeded.projectId },
      subject: { type: 'TEAM', id: seeded.teamId },
      level: 'VIEWER',
      expiresAt: null,
      ipAddress: '203.0.113.13',
    });

    // One row, replaced — not a second grant beside the first (`uq_resource_acl`, the upsert).
    expect(await grantRowCount()).toBe(1);

    await expect(
      readProject().execute({ actor: projectActor(seeded.ivanId), projectId: seeded.projectId }),
    ).resolves.toMatchObject({ projectId: seeded.projectId });

    await expect(
      writeProject().execute(renameInput(projectActor(seeded.ivanId))),
    ).rejects.toMatchObject({ code: 'project_forbidden', reason: 'insufficient_acl_level' });
  });

  it('disbanding the team takes the grant with it, closing access for the last member in the same transaction', async () => {
    await grantAcl().execute({
      actor: owner(),
      resource: { type: 'PROJECT', id: seeded.projectId },
      subject: { type: 'TEAM', id: seeded.teamId },
      level: 'EDITOR',
      expiresAt: null,
      ipAddress: '203.0.113.10',
    });
    await addMember().execute({
      actor: owner(),
      teamId: seeded.teamId,
      userId: seeded.ivanId,
      teamRole: 'MEMBER',
      ipAddress: '203.0.113.11',
    });

    await expect(
      readProject().execute({ actor: projectActor(seeded.ivanId), projectId: seeded.projectId }),
    ).resolves.toMatchObject({ projectId: seeded.projectId });

    await deleteTeam().execute({
      actor: owner(),
      teamId: seeded.teamId,
      ipAddress: '203.0.113.14',
    });

    expect(await grantRowCount()).toBe(0);

    await expect(
      readProject().execute({ actor: projectActor(seeded.ivanId), projectId: seeded.projectId }),
    ).rejects.toMatchObject({ code: 'project_not_found', reason: 'resource_not_found' });
  });
});
