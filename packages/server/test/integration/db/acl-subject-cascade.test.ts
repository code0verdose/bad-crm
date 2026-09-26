import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { type SharedPermissions } from '@bad-crm/shared';

import {
  type AclEntryDraft,
  type AclEntryRow,
} from '@/application/access/ports/acl-repository.port.js';
import { GrantAclUseCase } from '@/application/access/use-cases/grant-acl.use-case.js';
import { ResolveAclQuery } from '@/application/access/use-cases/resolve-acl.query.js';
import { DeleteCustomRoleUseCase } from '@/application/iam/use-cases/delete-custom-role.use-case.js';
import { DeleteTeamUseCase } from '@/application/iam/use-cases/delete-team.use-case.js';
import { type AclSubjectRef } from '@/domain/access/acl-chain.types.js';
import { type Actor } from '@/domain/access/actor.types.js';
import { AppError } from '@/domain/shared/errors/app.errors.js';
import { PrismaAclReader } from '@/infrastructure/persistence/prisma/acl-reader.adapter.js';
import { PrismaCustomRoleRepository } from '@/infrastructure/persistence/prisma/custom-role.repository.js';
import { PrismaProjectAccessReader } from '@/infrastructure/persistence/prisma/project-access-reader.adapter.js';
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

/**
 * The gate's M-1: a grant racing the deletion of its subject. `resource_acl.subject_id` has no
 * foreign key, so nothing in the schema serializes the two — the use-cases do, with row locks:
 *
 * - `TEAM`: the grant reads the team row `FOR SHARE` and re-checks `deleted_at` under the lock;
 *   `disband()`'s `UPDATE` of that row waits for the grant, or the grant waits for the disbanding
 *   and then sees `deleted_at` set. `FOR KEY SHARE` would not do — disbanding rewrites a non-key
 *   column, which that mode does not conflict with.
 * - `ROLE`: the grant reads the role row `FOR KEY SHARE`; the deletion locks it `FOR UPDATE` before
 *   it removes the role's grants. The grant's lock alone is not enough: the deletion's
 *   `removeAllOfSubject` runs before its `DELETE FROM roles`, so a grant committed between the two
 *   would outlive the role.
 *
 * Each race is driven, not hoped for: the first transaction is held at its most dangerous point
 * (the grant right after its row is written, the deletion right after its grants are removed) until
 * the second one is observed waiting on a lock (`pg_locks … NOT granted`) — or until a short
 * deadline, which is what an unlocked implementation reaches, and then the orphan is what the
 * assertions see.
 */
describe('a grant racing the deletion of its subject leaves no orphan (gate M-1)', () => {
  const ADDRESS = '203.0.113.9';
  const WAIT_DEADLINE_MS = 1_500;

  interface Gate {
    readonly open: () => void;
    readonly opened: Promise<void>;
  }

  const gate = (): Gate => {
    let open = (): void => undefined;
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });

    return { open, opened };
  };

  /** The product's grants repository, held at one step until the test lets it go. */
  class HeldAclRepository extends PrismaResourceAclRepository {
    constructor(
      private readonly holdAfter: 'upsert' | 'removeAllOfSubject',
      private readonly reached: Gate,
      private readonly release: Gate,
    ) {
      super();
    }

    override async upsert(draft: AclEntryDraft): Promise<string> {
      const id = await super.upsert(draft);

      if (this.holdAfter === 'upsert') await this.hold();

      return id;
    }

    override async removeAllOfSubject(subject: AclSubjectRef): Promise<readonly AclEntryRow[]> {
      const rows = await super.removeAllOfSubject(subject);

      if (this.holdAfter === 'removeAllOfSubject') await this.hold();

      return rows;
    }

    private async hold(): Promise<void> {
      this.reached.open();
      await this.release.opened;
    }
  }

  const silentLogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => silentLogger,
  };

  let projectId: string;

  beforeEach(async () => {
    projectId = await asMaintenance(pools.owner, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO projects (organization_id, key, name, lead_id, color, updated_at)
         VALUES ($1::uuid, 'RACE', 'Race', $2::uuid, 'indigo', now())
         RETURNING id`,
        [ORG, seeded.ownerId],
      );

      return rows[0]?.id ?? '';
    });
  });

  const subjectOf = (type: 'ROLE' | 'TEAM'): AclSubjectRef => ({
    type,
    id: type === 'ROLE' ? seeded.roleId : seeded.teamId,
  });

  const grantTo = (
    subject: AclSubjectRef,
    acl: PrismaResourceAclRepository = new PrismaResourceAclRepository(),
  ): Promise<unknown> =>
    new GrantAclUseCase(
      new PrismaUnitOfWork(prisma),
      new ResolveAclQuery({
        acl: new PrismaAclReader(),
        projects: new PrismaProjectAccessReader(),
        clock: { now: () => new Date() },
        logger: silentLogger,
      }),
      acl,
      new FakeAuditLogger(),
    ).execute({
      actor: owner(),
      resource: { type: 'PROJECT', id: projectId },
      subject,
      level: 'EDITOR',
      expiresAt: null,
      ipAddress: ADDRESS,
    });

  const deleteSubject = (
    subject: AclSubjectRef,
    acl: PrismaResourceAclRepository = new PrismaResourceAclRepository(),
  ): Promise<void> =>
    subject.type === 'ROLE'
      ? new DeleteCustomRoleUseCase(
          new PrismaUnitOfWork(prisma),
          new PrismaCustomRoleRepository(),
          acl,
          new FakeAuditLogger(),
        ).execute({ actor: owner(), roleId: subject.id, ipAddress: ADDRESS })
      : new DeleteTeamUseCase(
          new PrismaUnitOfWork(prisma),
          new PrismaTeamRepository(),
          acl,
          new FakeAuditLogger(),
        ).execute({ actor: owner(), teamId: subject.id, ipAddress: ADDRESS });

  /** Grants of this organization whose subject is gone — a deleted role or a disbanded team. */
  const orphans = (): Promise<number> =>
    asMaintenance(pools.owner, async (client) => {
      const { rows } = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count
           FROM resource_acl a
          WHERE a.organization_id = $1::uuid
            AND ((a.subject_type = 'ROLE' AND NOT EXISTS (
                   SELECT 1 FROM roles r
                    WHERE r.organization_id = a.organization_id AND r.id = a.subject_id))
              OR (a.subject_type = 'TEAM' AND NOT EXISTS (
                   SELECT 1 FROM teams t
                    WHERE t.organization_id = a.organization_id AND t.id = a.subject_id
                      AND t.deleted_at IS NULL)))`,
        [ORG],
      );

      return rows[0]?.count ?? Number.NaN;
    });

  const grantsOnRaceProject = (): Promise<number> =>
    asMaintenance(pools.owner, async (client) => {
      const { rows } = await client.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM resource_acl WHERE resource_id = $1::uuid',
        [projectId],
      );

      return rows[0]?.count ?? Number.NaN;
    });

  /** Whether some backend is waiting on a lock, polled until `WAIT_DEADLINE_MS`. */
  const somebodyWaitsOnALock = async (): Promise<boolean> => {
    const deadline = Date.now() + WAIT_DEADLINE_MS;

    while (Date.now() < deadline) {
      const { rows } = await pools.owner.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM pg_locks WHERE NOT granted',
      );

      if ((rows[0]?.count ?? 0) > 0) return true;

      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    return false;
  };

  /**
   * Runs `first` until it is held, starts `second`, waits for the lock queue, then lets both finish.
   * A `first` that fails before it reaches the hold releases the test rather than hanging it.
   */
  const race = async (
    first: (acl: PrismaResourceAclRepository) => Promise<unknown>,
    holdAfter: 'upsert' | 'removeAllOfSubject',
    second: () => Promise<unknown>,
  ): Promise<{
    readonly waited: boolean;
    readonly first: PromiseSettledResult<unknown>;
    readonly second: PromiseSettledResult<unknown>;
  }> => {
    const reached = gate();
    const release = gate();
    const firstRun = first(new HeldAclRepository(holdAfter, reached, release));

    await Promise.race([reached.opened, firstRun.catch(() => undefined)]);

    const secondRun = second();
    const waited = await somebodyWaitsOnALock();

    release.open();

    const [firstOutcome, secondOutcome] = await Promise.allSettled([firstRun, secondRun]);

    return { waited, first: firstOutcome, second: secondOutcome };
  };

  const codeOf = (outcome: PromiseSettledResult<unknown>): string | undefined =>
    outcome.status === 'rejected' && outcome.reason instanceof AppError
      ? outcome.reason.code
      : undefined;

  it('CONTROL: without a deletion beside it, the grant writes its row and nothing is orphaned', async () => {
    await grantTo(subjectOf('ROLE'));
    await grantTo(subjectOf('TEAM'));

    await expect(grantsOnRaceProject()).resolves.toBe(2);
    await expect(orphans()).resolves.toBe(0);
  });

  it('CONTROL: the orphan count sees an orphan — a grant to a role that is not there', async () => {
    await asMaintenance(pools.owner, (client) =>
      grant(client, {
        resourceId: projectId,
        subjectType: 'ROLE',
        subjectId: randomUUID(),
        level: 'VIEWER',
      }),
    );

    await expect(orphans()).resolves.toBe(1);
  });

  for (const type of ['ROLE', 'TEAM'] as const) {
    it(`${type}: the grant first — the deletion waits for it and then takes its row too`, async () => {
      const subject = subjectOf(type);

      const outcome = await race(
        (acl) => grantTo(subject, acl),
        'upsert',
        () => deleteSubject(subject),
      );

      expect(outcome.first.status).toBe('fulfilled');
      expect(outcome.second.status).toBe('fulfilled');
      await expect(orphans()).resolves.toBe(0);
      await expect(grantsOnRaceProject()).resolves.toBe(0);
      expect(outcome.waited).toBe(true);
    });

    it(`${type}: the deletion first — the grant waits for it and answers 404 for the subject`, async () => {
      const subject = subjectOf(type);

      const outcome = await race(
        (acl) => deleteSubject(subject, acl),
        'removeAllOfSubject',
        () => grantTo(subject),
      );

      expect(outcome.first.status).toBe('fulfilled');
      expect(codeOf(outcome.second)).toBe(type === 'ROLE' ? 'role_not_found' : 'team_not_found');
      await expect(orphans()).resolves.toBe(0);
      await expect(grantsOnRaceProject()).resolves.toBe(0);
      expect(outcome.waited).toBe(true);
    });
  }
});
