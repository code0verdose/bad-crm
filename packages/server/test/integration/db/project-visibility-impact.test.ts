import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { ResolveAclQuery } from '@/application/access/use-cases/resolve-acl.query.js';
import { BuildActorQuery } from '@/application/iam/use-cases/build-actor.query.js';
import { GetProjectDetailQuery } from '@/application/project/use-cases/get-project-detail.query.js';
import { PreviewProjectVisibilityQuery } from '@/application/project/use-cases/preview-project-visibility.query.js';
import { type Actor } from '@/domain/access/actor.types.js';
import { PrismaAclReader } from '@/infrastructure/persistence/prisma/acl-reader.adapter.js';
import { PrismaEffectivePermissionsReader } from '@/infrastructure/persistence/prisma/effective-permissions-reader.adapter.js';
import { PrismaProjectAccessReader } from '@/infrastructure/persistence/prisma/project-access-reader.adapter.js';
import { PrismaProjectAudienceAccessReader } from '@/infrastructure/persistence/prisma/project-audience-access-reader.adapter.js';
import { PrismaProjectRepository } from '@/infrastructure/persistence/prisma/project.repository.js';
import { PrismaUnitOfWork } from '@/infrastructure/persistence/prisma/unit-of-work.adapter.js';

import {
  asMaintenance,
  closePools,
  createPools,
  insertOrganizationWithOwner,
  truncateAll,
  type HarnessPools,
} from './db-harness.util.js';

/**
 * The summary of a visibility change on a live PostgreSQL — STORY-014-01, acceptance 7.
 *
 * **The count is the set difference of the per-colleague read decision.** One organization holds
 * every way a colleague can reach a project or be kept from it: a bystander, a member, a grant to
 * the person, through a role and through a team, an expired grant, `NONE` on the organization, a
 * guest with and without a grant, a DENY exception on `project:read`, the owner — plus a suspended
 * and an invited account that must not be counted at all. For each active account the actor is
 * built by `BuildActorQuery` and the project read by `GetProjectDetailQuery` — the path a real
 * request takes — once under `PUBLIC_ORG` and once under `PRIVATE`. The preview has to equal the
 * difference of those two sets in both directions, and the hand-written expectation, so that two
 * implementations agreeing on nothing cannot pass.
 *
 * A neighbouring organization with its own project and accounts is seeded as the tenant control:
 * none of its people may appear in the count.
 */

let pools: HarnessPools;
let prisma: PrismaClient;

const ORG = randomUUID();
const OTHER_ORG = randomUUID();

interface Seeded {
  readonly ownerId: string;
  readonly projectId: string;
  /** Every account of the organization, by the case it stands for. */
  readonly people: Readonly<Record<string, string>>;
  /** The active ones — the audience the preview is about. */
  readonly active: readonly string[];
}

let seeded: Seeded;

const insertUser = async (
  client: PoolClient,
  organizationId: string,
  status: 'ACTIVE' | 'SUSPENDED' | 'INVITED' = 'ACTIVE',
): Promise<string> => {
  const userId = randomUUID();

  await client.query(
    `INSERT INTO users (id, organization_id, email, password_hash, status, updated_at)
     VALUES ($1::uuid, $2::uuid, $3, 'placeholder-not-a-credential', $4, now())`,
    [userId, organizationId, `impact-${userId.slice(0, 8)}@example.test`, status],
  );

  return userId;
};

const insertRole = async (
  client: PoolClient,
  organizationId: string,
  key: string,
  permissionKeys: readonly string[],
): Promise<string> => {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO roles (organization_id, key, name, updated_at)
     VALUES ($1::uuid, $2, $2, now()) RETURNING id`,
    [organizationId, key],
  );
  const roleId = rows[0]?.id ?? '';

  for (const permissionKey of permissionKeys) {
    await client.query(
      `INSERT INTO role_permissions (organization_id, role_id, permission_key, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, now())`,
      [organizationId, roleId, permissionKey],
    );
  }

  return roleId;
};

const assign = (
  client: PoolClient,
  organizationId: string,
  userId: string,
  roleId: string,
): Promise<unknown> =>
  client.query(
    `INSERT INTO user_roles (organization_id, user_id, role_id, updated_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, now())`,
    [organizationId, userId, roleId],
  );

const grant = (
  client: PoolClient,
  spec: {
    readonly resourceType: 'PROJECT' | 'ORGANIZATION';
    readonly resourceId: string;
    readonly subjectType: 'USER' | 'ROLE' | 'TEAM';
    readonly subjectId: string;
    readonly level: 'NONE' | 'VIEWER';
    readonly expired?: boolean;
  },
): Promise<unknown> =>
  client.query(
    `INSERT INTO resource_acl
       (organization_id, resource_type, resource_id, subject_type, subject_id, access_level,
        expires_at, updated_at)
     VALUES ($1::uuid, $2::acl_resource_type, $3::uuid, $4::acl_subject_type, $5::uuid,
             $6::access_level, $7::timestamptz, now())`,
    [
      ORG,
      spec.resourceType,
      spec.resourceId,
      spec.subjectType,
      spec.subjectId,
      spec.level,
      spec.expired === true ? new Date(Date.now() - 60_000).toISOString() : null,
    ],
  );

const insertProject = async (
  client: PoolClient,
  organizationId: string,
  leadId: string,
  key: string,
): Promise<string> => {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO projects (organization_id, key, name, lead_id, color, visibility, updated_at)
     VALUES ($1::uuid, $2, $2, $3::uuid, 'indigo', 'PUBLIC_ORG', now()) RETURNING id`,
    [organizationId, key, leadId],
  );

  return rows[0]?.id ?? '';
};

const seed = (): Promise<Seeded> =>
  asMaintenance(pools.owner, async (client) => {
    const { ownerId } = await insertOrganizationWithOwner(client, ORG, {
      slug: `impact-${ORG.slice(0, 8)}`,
    });
    const { ownerId: foreignOwnerId } = await insertOrganizationWithOwner(client, OTHER_ORG, {
      slug: `impact-other-${OTHER_ORG.slice(0, 8)}`,
    });

    const reader = await insertRole(client, ORG, 'developer', ['project:read']);
    const guest = await insertRole(client, ORG, 'guest', ['project:read']);
    const writer = await insertRole(client, ORG, 'tech_writer', ['project:read']);

    const people: Record<string, string> = {};
    const person = async (
      name: string,
      role: string | null,
      status: 'ACTIVE' | 'SUSPENDED' | 'INVITED' = 'ACTIVE',
    ): Promise<string> => {
      const userId = await insertUser(client, ORG, status);

      if (role !== null) await assign(client, ORG, userId, role);
      people[name] = userId;

      return userId;
    };

    const bystander = await person('bystander', reader);
    const member = await person('member', reader);
    const granted = await person('granted by name', reader);
    await person('granted through a role', writer);
    const byTeam = await person('granted through a team', reader);
    const expired = await person('grant expired', reader);
    const closedOut = await person('NONE on the organization', reader);
    await person('guest without a grant', guest);
    const guestGranted = await person('guest with a grant', guest);
    const denied = await person('DENY on project:read', reader);
    await person('never held project:read', null);
    await person('suspended', reader, 'SUSPENDED');
    await person('invited', reader, 'INVITED');

    const projectId = await insertProject(client, ORG, ownerId, 'IMP');

    await client.query(
      `INSERT INTO project_members (organization_id, project_id, user_id, project_role, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'MEMBER', now())`,
      [ORG, projectId, member],
    );

    const teamId = randomUUID();

    await client.query(
      `INSERT INTO teams (id, organization_id, name, slug, updated_at)
       VALUES ($1::uuid, $2::uuid, 'Docs', 'docs', now())`,
      [teamId, ORG],
    );
    await client.query(
      `INSERT INTO team_members (organization_id, team_id, user_id, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, now())`,
      [ORG, teamId, byTeam],
    );

    const onProject = { resourceType: 'PROJECT' as const, resourceId: projectId };

    await grant(client, { ...onProject, subjectType: 'USER', subjectId: granted, level: 'VIEWER' });
    await grant(client, { ...onProject, subjectType: 'ROLE', subjectId: writer, level: 'VIEWER' });
    await grant(client, { ...onProject, subjectType: 'TEAM', subjectId: teamId, level: 'VIEWER' });
    await grant(client, {
      ...onProject,
      subjectType: 'USER',
      subjectId: expired,
      level: 'VIEWER',
      expired: true,
    });
    await grant(client, {
      ...onProject,
      subjectType: 'USER',
      subjectId: guestGranted,
      level: 'VIEWER',
    });
    await grant(client, {
      resourceType: 'ORGANIZATION',
      resourceId: ORG,
      subjectType: 'USER',
      subjectId: closedOut,
      level: 'NONE',
    });
    await client.query(
      `INSERT INTO user_permission_overrides
         (organization_id, user_id, permission_key, effect, reason, updated_at)
       VALUES ($1::uuid, $2::uuid, 'project:read', 'DENY'::"OverrideEffect", 'impact fixture', now())`,
      [ORG, denied],
    );

    // The neighbour: a project and two accounts that must never be counted.
    const foreignReader = await insertRole(client, OTHER_ORG, 'developer', ['project:read']);

    for (let index = 0; index < 2; index += 1) {
      await assign(client, OTHER_ORG, await insertUser(client, OTHER_ORG), foreignReader);
    }
    await insertProject(client, OTHER_ORG, foreignOwnerId, 'IMP');

    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM users WHERE organization_id = $1::uuid AND status = 'ACTIVE' ORDER BY id`,
      [ORG],
    );

    // `bystander` is named so the hand-written expectation below can say who it is.
    expect(bystander).not.toBe('');

    return { ownerId, projectId, people, active: rows.map((row) => row.id) };
  });

const setVisibility = (visibility: 'PUBLIC_ORG' | 'PRIVATE'): Promise<unknown> =>
  asMaintenance(pools.owner, (client) =>
    client.query(`UPDATE projects SET visibility = $1 WHERE id = $2::uuid`, [
      visibility,
      seeded.projectId,
    ]),
  );

const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};

const clock = { now: () => new Date() };

const resolver = () =>
  new ResolveAclQuery({
    acl: new PrismaAclReader(),
    projects: new PrismaProjectAccessReader(),
    clock,
    logger: silentLogger,
  });

const actorOf = (userId: string): Promise<Actor> =>
  new BuildActorQuery(new PrismaUnitOfWork(prisma), new PrismaEffectivePermissionsReader()).execute(
    { userId, organizationId: ORG, mfaEnrollment: false },
  );

/** Who of the active accounts reads the project right now — the card's read, one by one. */
const readersNow = async (): Promise<Set<string>> => {
  const readers = new Set<string>();

  for (const userId of seeded.active) {
    const outcome = await new GetProjectDetailQuery(
      new PrismaUnitOfWork(prisma),
      new PrismaProjectRepository(),
      resolver(),
    )
      .execute({ actor: await actorOf(userId), projectId: seeded.projectId })
      .then(
        () => 'read',
        (error: { code?: string }) => error.code,
      );

    if (outcome === 'read') readers.add(userId);
    else expect(['project_not_found', 'project_forbidden']).toContain(outcome);
  }

  return readers;
};

const preview = async (to: 'PUBLIC_ORG' | 'PRIVATE') =>
  new PreviewProjectVisibilityQuery(
    new PrismaUnitOfWork(prisma),
    new PrismaProjectRepository(),
    resolver(),
    new PrismaProjectAudienceAccessReader(),
    new PrismaEffectivePermissionsReader(),
    clock,
  ).execute({
    actor: await actorOf(seeded.ownerId),
    projectId: seeded.projectId,
    visibility: to,
  });

const difference = (left: Set<string>, right: Set<string>): string[] =>
  [...left].filter((userId) => !right.has(userId));

let publicReaders: Set<string>;
let privateReaders: Set<string>;

beforeAll(async () => {
  pools = createPools();
  prisma = new PrismaClient({ datasourceUrl: inject('databaseUrls').appUser });
  await truncateAll(pools.owner);
  seeded = await seed();

  publicReaders = await readersNow();
  await setVisibility('PRIVATE');
  privateReaders = await readersNow();
  await setVisibility('PUBLIC_ORG');
});

afterAll(async () => {
  await truncateAll(pools.owner);
  await prisma.$disconnect();
  await closePools(pools);
});

describe('the preview is the set difference of the per-colleague read decision', () => {
  it('CONTROL: the two sets differ, and by the colleagues the fixture says', () => {
    const lost = difference(publicReaders, privateReaders).toSorted();

    // By hand: the bystander and the one whose grant has expired read it only while it is public.
    expect(lost).toEqual([seeded.people['bystander'], seeded.people['grant expired']].toSorted());
    expect(difference(privateReaders, publicReaders)).toEqual([]);
    // Positive control: the people who keep it are really readers under both.
    for (const name of [
      'member',
      'granted by name',
      'granted through a role',
      'granted through a team',
      'guest with a grant',
    ]) {
      expect(privateReaders.has(seeded.people[name] ?? '')).toBe(true);
    }
    expect(privateReaders.has(seeded.ownerId)).toBe(true);
  });

  it('closing the public project: losingAccess is |reads now ∖ reads afterwards|', async () => {
    await expect(preview('PRIVATE')).resolves.toEqual({
      losingAccess: difference(publicReaders, privateReaders).length,
      gainingAccess: difference(privateReaders, publicReaders).length,
    });
    await expect(preview('PRIVATE')).resolves.toEqual({ losingAccess: 2, gainingAccess: 0 });
  });

  it('opening it again: gainingAccess is the same difference the other way', async () => {
    await setVisibility('PRIVATE');

    try {
      await expect(preview('PUBLIC_ORG')).resolves.toEqual({
        losingAccess: difference(privateReaders, publicReaders).length,
        gainingAccess: difference(publicReaders, privateReaders).length,
      });
    } finally {
      await setVisibility('PUBLIC_ORG');
    }
  });

  it('CONTROL: the suspended and invited accounts exist and are outside the audience', () => {
    // They are not in the audience at all: were they, the bystander-like suspended account would
    // make losingAccess 3, and the neighbour's two readers would make it 5.
    expect(seeded.active).not.toContain(seeded.people['suspended']);
    expect(seeded.active).not.toContain(seeded.people['invited']);
    expect(seeded.active).toContain(seeded.people['bystander']);
  });
});
