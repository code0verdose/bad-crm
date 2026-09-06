import { randomUUID } from 'node:crypto';

import { type Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { ResolveAclQuery } from '@/application/access/use-cases/resolve-acl.query.js';
import { type AclChainNode } from '@/domain/access/acl-chain.types.js';
import { type Actor } from '@/domain/access/actor.types.js';
import { PrismaAclReader } from '@/infrastructure/persistence/prisma/acl-reader.adapter.js';
import { PrismaProjectAccessReader } from '@/infrastructure/persistence/prisma/project-access-reader.adapter.js';
import { PrismaResourceAclRepository } from '@/infrastructure/persistence/prisma/resource-acl.repository.js';
import { withTenant } from '@/infrastructure/persistence/prisma/tenant.context.js';

import {
  asMaintenance,
  asTenant,
  closePools,
  createPools,
  insertOrganizationWithOwner,
  truncateAll,
  type HarnessPools,
} from './db-harness.util.js';

/**
 * The ACL reader and the resolver over it, against a real PostgreSQL — STORY-011-06.
 *
 * Five things here are only decidable by the database, and a recorder would pass on all five with
 * the product broken:
 *
 * 1. **the enum casts** — `$n::acl_resource_type` in a `VALUES` list is accepted by the server or
 *    it is not, and a mock accepts anything;
 * 2. **the subject subqueries** — `user_roles.expires_at` and `team_members` are real tables with
 *    real rows, and «a role that expired an hour ago does not match» is a fact about `now()`;
 * 3. **the tenant boundary** — a grant of the other organization on the *same* resource id must be
 *    invisible, which is the policy's doing and nothing the statement says;
 * 4. **one round trip** — acceptance 8 counts statements, and the count is taken from the driver's
 *    own log, not from a recorder that was told what to record;
 * 5. **the plan** — `uq_resource_acl` (there is no separate resource index; the unique one serves
 *    the join) is either what the planner picks for it or it is decoration, and only `EXPLAIN` on
 *    a table with enough rows can say which.
 *
 * Every describe opens with a `CONTROL:` case (`rules/testing.mdc`, 4): a suite whose negatives
 * all pass because nothing is visible passes on a broken connection too.
 */

let pools: HarnessPools;
/**
 * The driver logs every statement it sends, and the count is what acceptance 8 is about. Typed
 * through the options so `$on('query')` is admitted by the client's generic — `PrismaClient` alone
 * types the event name as `never`.
 */
const CLIENT_OPTIONS = {
  log: [{ level: 'query', emit: 'event' }],
} as const satisfies Prisma.PrismaClientOptions;

let prisma: PrismaClient<typeof CLIENT_OPTIONS>;

const ORG = randomUUID();
const OTHER_ORG = randomUUID();
const PROJECT = randomUUID();

/** Statements the driver sent, minus the two `set_config` calls that pin the scope. */
const statements: string[] = [];

interface Seeded {
  readonly ownerId: string;
  readonly ivanId: string;
  readonly petrId: string;
  readonly teamId: string;
  readonly roleId: string;
}

let seeded: Seeded;

const insertUser = async (
  client: Parameters<typeof insertOrganizationWithOwner>[0],
  organizationId: string,
): Promise<string> => {
  const userId = randomUUID();

  await client.query(
    `INSERT INTO users (id, organization_id, email, password_hash, status, updated_at)
     VALUES ($1::uuid, $2::uuid, $3, 'placeholder-not-a-credential', 'ACTIVE', now())`,
    [userId, organizationId, `member-${userId.slice(0, 8)}@example.test`],
  );

  return userId;
};

const seed = async (): Promise<Seeded> =>
  asMaintenance(pools.owner, async (client) => {
    const { ownerId } = await insertOrganizationWithOwner(client, ORG, {
      slug: `acl-${ORG.slice(0, 8)}`,
    });

    await insertOrganizationWithOwner(client, OTHER_ORG, {
      slug: `other-${OTHER_ORG.slice(0, 8)}`,
    });

    const ivanId = await insertUser(client, ORG);
    const petrId = await insertUser(client, ORG);
    const teamId = randomUUID();
    const roleId = randomUUID();

    await client.query(
      `INSERT INTO teams (id, organization_id, name, slug, updated_at)
       VALUES ($1::uuid, $2::uuid, 'Backend', 'backend', now())`,
      [teamId, ORG],
    );
    await client.query(
      `INSERT INTO team_members (organization_id, team_id, user_id, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, now())`,
      [ORG, teamId, ivanId],
    );
    await client.query(
      `INSERT INTO roles (id, organization_id, key, name, updated_at)
       VALUES ($1::uuid, $2::uuid, 'tech_writer', 'Tech writer', now())`,
      [roleId, ORG],
    );
    await client.query(
      `INSERT INTO user_roles (organization_id, user_id, role_id, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, now())`,
      [ORG, petrId, roleId],
    );

    return { ownerId, ivanId, petrId, teamId, roleId };
  });

interface GrantRow {
  readonly organizationId?: string;
  readonly resourceType?: string;
  readonly resourceId?: string;
  readonly subjectType: 'USER' | 'ROLE' | 'TEAM';
  readonly subjectId: string;
  readonly level: string;
  readonly expiresAt?: string | null;
}

/** Written by the migrator, so the fixture is never what the tenant is refused. */
const grant = (row: GrantRow): Promise<void> =>
  asMaintenance(pools.owner, async (client) => {
    await client.query(
      `INSERT INTO resource_acl
         (organization_id, resource_type, resource_id, subject_type, subject_id, access_level,
          expires_at, updated_at)
       VALUES ($1::uuid, $2::acl_resource_type, $3::uuid, $4::acl_subject_type, $5::uuid,
               $6::access_level, $7::timestamptz, now())`,
      [
        row.organizationId ?? ORG,
        row.resourceType ?? 'PROJECT',
        row.resourceId ?? PROJECT,
        row.subjectType,
        row.subjectId,
        row.level,
        row.expiresAt ?? null,
      ],
    );
  });

const projectChain: readonly AclChainNode[] = [
  { depth: 0, type: 'PROJECT', id: PROJECT },
  { depth: 1, type: 'ORGANIZATION', id: ORG },
];

const entriesFor = (
  userId: string,
  chain: readonly AclChainNode[] = projectChain,
  organizationId = ORG,
) =>
  withTenant(prisma, { organizationId, userId: null }, () =>
    new PrismaAclReader().entriesAlong(chain, userId),
  );

const actorFor = (userId: string, roleKeys: readonly string[] = []): Actor => ({
  userId,
  organizationId: ORG,
  isOwner: false,
  permissionsVersion: 1,
  permissions: new Set(),
  denied: new Set(),
  roleKeys,
});

beforeAll(() => {
  pools = createPools();
  prisma = new PrismaClient({
    ...CLIENT_OPTIONS,
    datasourceUrl: inject('databaseUrls').appUser,
  });
  prisma.$on('query', (event) => {
    if (!event.query.includes('set_config')) statements.push(event.query);
  });
});

afterAll(async () => {
  await prisma.$disconnect();
  await closePools(pools);
});

beforeEach(async () => {
  await truncateAll(pools.owner);
  seeded = await seed();
  statements.length = 0;
});

describe('PrismaAclReader.entriesAlong — what matches', () => {
  it('CONTROL: a grant to the person on the object comes back at depth 0', async () => {
    await grant({ subjectType: 'USER', subjectId: seeded.ivanId, level: 'EDITOR' });

    await expect(entriesFor(seeded.ivanId)).resolves.toEqual([
      { depth: 0, level: 'EDITOR', expiresAt: null },
    ]);
  });

  it('returns every node’s rows tagged with its depth, unreduced and ordered', async () => {
    await grant({ subjectType: 'USER', subjectId: seeded.ivanId, level: 'VIEWER' });
    await grant({
      resourceType: 'ORGANIZATION',
      resourceId: ORG,
      subjectType: 'USER',
      subjectId: seeded.ivanId,
      level: 'EDITOR',
    });

    await expect(entriesFor(seeded.ivanId)).resolves.toEqual([
      { depth: 0, level: 'VIEWER', expiresAt: null },
      { depth: 1, level: 'EDITOR', expiresAt: null },
    ]);
  });

  it('matches a TEAM grant for a member and not for somebody outside the team', async () => {
    await grant({ subjectType: 'TEAM', subjectId: seeded.teamId, level: 'EDITOR' });

    await expect(entriesFor(seeded.ivanId)).resolves.toEqual([
      { depth: 0, level: 'EDITOR', expiresAt: null },
    ]);
    await expect(entriesFor(seeded.petrId)).resolves.toEqual([]);
  });

  it('matches a ROLE grant for a holder and not for somebody without the role', async () => {
    await grant({ subjectType: 'ROLE', subjectId: seeded.roleId, level: 'COMMENTER' });

    await expect(entriesFor(seeded.petrId)).resolves.toEqual([
      { depth: 0, level: 'COMMENTER', expiresAt: null },
    ]);
    await expect(entriesFor(seeded.ivanId)).resolves.toEqual([]);
  });

  it('ignores a ROLE grant once the assignment itself has expired', async () => {
    await grant({ subjectType: 'ROLE', subjectId: seeded.roleId, level: 'COMMENTER' });
    await asMaintenance(pools.owner, async (client) => {
      await client.query(
        `UPDATE user_roles SET expires_at = now() - interval '1 hour' WHERE user_id = $1::uuid`,
        [seeded.petrId],
      );
    });

    await expect(entriesFor(seeded.petrId)).resolves.toEqual([]);
  });

  it('returns the maximum-rule inputs for one node: a TEAM and a USER row side by side', async () => {
    await grant({ subjectType: 'TEAM', subjectId: seeded.teamId, level: 'EDITOR' });
    await grant({ subjectType: 'USER', subjectId: seeded.ivanId, level: 'VIEWER' });

    const rows = await entriesFor(seeded.ivanId);

    expect(rows.map((row) => row.level).sort()).toEqual(['EDITOR', 'VIEWER']);
    expect(rows.every((row) => row.depth === 0)).toBe(true);
  });

  it('drops a grant that expired a second ago — the `expires_at > now()` filter in SQL', async () => {
    await grant({
      subjectType: 'USER',
      subjectId: seeded.ivanId,
      level: 'MANAGER',
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    });

    await expect(entriesFor(seeded.ivanId)).resolves.toEqual([]);
  });

  it('keeps a grant that expires later, with its expiry, for the policy to filter again', async () => {
    const later = new Date(Date.now() + 60_000);

    await grant({
      subjectType: 'USER',
      subjectId: seeded.ivanId,
      level: 'MANAGER',
      expiresAt: later.toISOString(),
    });

    const [row] = await entriesFor(seeded.ivanId);

    expect(row?.level).toBe('MANAGER');
    expect(row?.expiresAt?.getTime()).toBe(later.getTime());
  });
});

describe('PrismaAclReader.entriesAlong — the tenant boundary', () => {
  it('CONTROL: the tenant sees its own grant on the resource', async () => {
    await grant({ subjectType: 'USER', subjectId: seeded.ivanId, level: 'EDITOR' });

    await expect(entriesFor(seeded.ivanId)).resolves.toHaveLength(1);
  });

  it('does not see the other organization’s grant on the same resource id and subject id', async () => {
    // Same resource id, same subject id, other tenant: the row exists and the policy hides it.
    await grant({
      organizationId: OTHER_ORG,
      subjectType: 'USER',
      subjectId: seeded.ivanId,
      level: 'MANAGER',
    });

    await expect(entriesFor(seeded.ivanId)).resolves.toEqual([]);
    await expect(
      asMaintenance(pools.owner, async (client) => {
        const { rows } = await client.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM resource_acl WHERE resource_id = $1::uuid`,
          [PROJECT],
        );

        return rows[0]?.n;
      }),
    ).resolves.toBe('1');
  });
});

describe('PrismaAclReader.entriesAlong — one round trip (acceptance 8)', () => {
  it('sends exactly one statement for a chain four nodes deep', async () => {
    const deep: readonly AclChainNode[] = [
      { depth: 0, type: 'DOC_PAGE', id: randomUUID() },
      { depth: 1, type: 'DOC_PAGE', id: randomUUID() },
      { depth: 2, type: 'PROJECT', id: PROJECT },
      { depth: 3, type: 'ORGANIZATION', id: ORG },
    ];
    await grant({ subjectType: 'TEAM', subjectId: seeded.teamId, level: 'EDITOR' });

    statements.length = 0;

    await expect(entriesFor(seeded.ivanId, deep)).resolves.toEqual([
      { depth: 2, level: 'EDITOR', expiresAt: null },
    ]);
    // The transaction's own statements — `BEGIN`, the isolation level, `COMMIT` — are the scope, not
    // the read, and are left out of the count.
    const sent = statements.filter((sql) => !/^(BEGIN|COMMIT|ROLLBACK|SET TRANSACTION)/.test(sql));

    expect(sent, sent.join('\n---\n')).toHaveLength(1);
  });

  /**
   * The plan, on a table large enough for the planner to have a choice. A few rows would be a
   * sequential scan whatever the indexes say — measured: at a thousand rows PostgreSQL 16 still
   * hashed the whole table against the two `VALUES` rows — and the assertion would then be about
   * the seed size rather than about the index. So the seed is twenty thousand grants on as many
   * other objects to as many other subjects, analysed.
   *
   * **Why the index is named.** The first version of the resource index led with the enum
   * (`organization_id, resource_type, resource_id`), and this case was the one that caught it: as
   * `app_user` the plan was a sequential scan of the whole table (347 buffers, 2.2 ms at 20 000
   * rows) while as the owner it was an index scan — because `enum_eq` is not leakproof and under
   * row-level security the planner will not evaluate it ahead of the policy, so an enum column can
   * never be an index condition for the application role. The unique index now leads with
   * `(organization_id, resource_id)` and serves the lookup too, and the plan is expected to say so.
   */
  it('reaches resource_acl through uq_resource_acl as app_user, not a scan', async () => {
    await asMaintenance(pools.owner, async (client) => {
      await client.query(
        `INSERT INTO resource_acl
           (organization_id, resource_type, resource_id, subject_type, subject_id, access_level,
            updated_at)
         SELECT $1::uuid, 'PROJECT', gen_random_uuid(), 'USER', gen_random_uuid(), 'VIEWER', now()
           FROM generate_series(1, 20000)`,
        [ORG],
      );
      await client.query('ANALYZE resource_acl');
    });
    await grant({ subjectType: 'USER', subjectId: seeded.ivanId, level: 'EDITOR' });

    const plan = await asTenant(pools.app, ORG, async (client) => {
      const { rows } = await client.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN (ANALYZE, COSTS OFF)
         WITH chain(depth, resource_type, resource_id) AS (VALUES
           (0::int, 'PROJECT'::acl_resource_type, $1::uuid),
           (1::int, 'ORGANIZATION'::acl_resource_type, $2::uuid))
         SELECT c.depth, a.access_level::text, a.expires_at
           FROM chain c
           JOIN resource_acl a
             ON a.organization_id = $2::uuid
            AND a.resource_type   = c.resource_type
            AND a.resource_id     = c.resource_id
          WHERE (a.expires_at IS NULL OR a.expires_at > now())
            AND ((a.subject_type = 'USER' AND a.subject_id = $3::uuid)
              OR (a.subject_type = 'ROLE' AND a.subject_id IN (
                    SELECT ur.role_id FROM user_roles ur
                     WHERE ur.user_id = $3::uuid
                       AND (ur.expires_at IS NULL OR ur.expires_at > now())))
              OR (a.subject_type = 'TEAM' AND a.subject_id IN (
                    SELECT tm.team_id FROM team_members tm WHERE tm.user_id = $3::uuid)))
          ORDER BY c.depth`,
        [PROJECT, ORG, seeded.ivanId],
      );

      return rows.map((row) => row['QUERY PLAN']).join('\n');
    });

    expect(plan, plan).toContain('Index Scan using uq_resource_acl on resource_acl');
    expect(plan, plan).toMatch(/Index Cond: \(\(organization_id = .*\) AND \(resource_id = /);
    expect(plan, plan).not.toContain('Seq Scan on resource_acl');
  });
});

describe('ResolveAclQuery over the real reader — the organization chain', () => {
  const resolver = () =>
    new ResolveAclQuery({
      acl: new PrismaAclReader(),
      projects: new PrismaProjectAccessReader(),
      clock: { now: () => new Date() },
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        child() {
          return this;
        },
      },
    });

  const resolve = (actor: Actor, ref: Parameters<ResolveAclQuery['resolve']>[1]) =>
    withTenant(prisma, { organizationId: ORG, userId: actor.userId }, () =>
      resolver().resolve(actor, ref),
    );

  it('CONTROL: a member of the organization is a VIEWER of it by the implicit table', async () => {
    await expect(
      resolve(actorFor(seeded.ivanId), { type: 'ORGANIZATION', id: ORG }),
    ).resolves.toEqual({
      status: 'resolved',
      organizationId: ORG,
      level: 'VIEWER',
      family: 'standard',
    });
  });

  it('lets an org-wide TEAM grant lift a member to EDITOR — and a NONE refuse them', async () => {
    await grant({
      resourceType: 'ORGANIZATION',
      resourceId: ORG,
      subjectType: 'TEAM',
      subjectId: seeded.teamId,
      level: 'EDITOR',
    });

    await expect(
      resolve(actorFor(seeded.ivanId), { type: 'ORGANIZATION', id: ORG }),
    ).resolves.toMatchObject({ level: 'EDITOR' });

    await grant({
      resourceType: 'ORGANIZATION',
      resourceId: ORG,
      subjectType: 'USER',
      subjectId: seeded.ivanId,
      level: 'NONE',
    });

    await expect(
      resolve(actorFor(seeded.ivanId), { type: 'ORGANIZATION', id: ORG }),
    ).resolves.toMatchObject({ level: 'NONE' });
  });

  it('answers a guest NONE whatever the grants say short of an explicit one', async () => {
    await expect(
      resolve(actorFor(seeded.ivanId, ['guest']), { type: 'ORGANIZATION', id: ORG }),
    ).resolves.toMatchObject({ level: 'NONE' });
  });
});

describe('resource_acl — the grantor reference', () => {
  /**
   * The bare `ON DELETE SET NULL` on a composite key nulls every column of it, `organization_id`
   * included, and fails on NOT NULL — so a grant would *not* outlive its grantor, whatever the
   * comment said. The column-list form is what the migration uses; this is the row that proves it.
   */
  it('keeps the grant, with granted_by_id cleared, when the grantor is deleted', async () => {
    const grantor = await asMaintenance(pools.owner, (client) => insertUser(client, ORG));

    await asMaintenance(pools.owner, async (client) => {
      await client.query(
        `INSERT INTO resource_acl
           (organization_id, resource_type, resource_id, subject_type, subject_id, access_level,
            granted_by_id, updated_at)
         VALUES ($1::uuid, 'PROJECT', $2::uuid, 'USER', $3::uuid, 'EDITOR', $4::uuid, now())`,
        [ORG, PROJECT, seeded.ivanId, grantor],
      );
      await client.query(`DELETE FROM users WHERE id = $1::uuid`, [grantor]);
    });

    await expect(entriesFor(seeded.ivanId)).resolves.toEqual([
      { depth: 0, level: 'EDITOR', expiresAt: null },
    ]);
    await expect(
      asMaintenance(pools.owner, async (client) => {
        const { rows } = await client.query<{
          granted_by_id: string | null;
          organization_id: string;
        }>(`SELECT granted_by_id, organization_id FROM resource_acl WHERE resource_id = $1::uuid`, [
          PROJECT,
        ]);

        return rows[0];
      }),
    ).resolves.toEqual({ granted_by_id: null, organization_id: ORG });
  });
});

describe('PrismaResourceAclRepository — subjects and versions on real rows', () => {
  const inTenant = <T>(work: (repo: PrismaResourceAclRepository) => Promise<T>): Promise<T> =>
    withTenant(prisma, { organizationId: ORG, userId: null }, () =>
      work(new PrismaResourceAclRepository()),
    );

  const versionOf = (userId: string): Promise<number> =>
    asMaintenance(pools.owner, async (client) => {
      const { rows } = await client.query<{ permissions_version: number }>(
        `SELECT permissions_version FROM users WHERE id = $1::uuid`,
        [userId],
      );

      return rows[0]?.permissions_version ?? -1;
    });

  it('CONTROL: sees a team of this organization and the people on it', async () => {
    await expect(
      inTenant((repo) => repo.subjectExists({ type: 'TEAM', id: seeded.teamId })),
    ).resolves.toBe(true);
    await expect(
      inTenant((repo) => repo.subjectUserIds({ type: 'TEAM', id: seeded.teamId })),
    ).resolves.toEqual([seeded.ivanId]);
  });

  it('does not see a team of the other organization, nor a disbanded one', async () => {
    const foreign = randomUUID();
    const disbanded = randomUUID();

    await asMaintenance(pools.owner, async (client) => {
      await client.query(
        `INSERT INTO teams (id, organization_id, name, slug, updated_at)
         VALUES ($1::uuid, $2::uuid, 'Theirs', 'theirs', now())`,
        [foreign, OTHER_ORG],
      );
      await client.query(
        `INSERT INTO teams (id, organization_id, name, slug, deleted_at, updated_at)
         VALUES ($1::uuid, $2::uuid, 'Gone', 'gone', now(), now())`,
        [disbanded, ORG],
      );
    });

    await expect(
      inTenant((repo) => repo.subjectExists({ type: 'TEAM', id: foreign })),
    ).resolves.toBe(false);
    await expect(
      inTenant((repo) => repo.subjectExists({ type: 'TEAM', id: disbanded })),
    ).resolves.toBe(false);
  });

  it('upserts on the quadruple and reports the same id the second time', async () => {
    const draft = {
      resource: { type: 'PROJECT' as const, id: PROJECT },
      subject: { type: 'TEAM' as const, id: seeded.teamId },
      level: 'VIEWER' as const,
      expiresAt: null,
      grantedById: seeded.ownerId,
    };

    const first = await inTenant((repo) => repo.upsert(draft));
    const second = await inTenant((repo) => repo.upsert({ ...draft, level: 'EDITOR' }));

    expect(second).toBe(first);
    await expect(
      inTenant((repo) => repo.find(draft.resource, draft.subject)),
    ).resolves.toMatchObject({
      id: first,
      level: 'EDITOR',
      grantedById: seeded.ownerId,
    });
  });

  it('bumps the version of everyone in the set with one statement', async () => {
    const before = await Promise.all([versionOf(seeded.ivanId), versionOf(seeded.petrId)]);

    statements.length = 0;
    await inTenant((repo) => repo.bumpPermissionsVersionOf([seeded.ivanId, seeded.petrId]));

    expect(statements.filter((sql) => sql.includes('permissions_version'))).toHaveLength(1);
    await expect(versionOf(seeded.ivanId)).resolves.toBe((before[0] ?? 0) + 1);
    await expect(versionOf(seeded.petrId)).resolves.toBe((before[1] ?? 0) + 1);
  });
});

/**
 * The project half of the implicit table, against the tables EPIC-014 creates.
 *
 * This block was written with a guard that stepped aside, by name and with the reason, while
 * `projects` did not exist in the applied schema; the migration
 * (`20260906135656_projects_and_project_members`) landed in the same working tree before the first
 * run, so the guard was removed rather than shipped. The adapter's SQL was written against the
 * column names of `data-model.md` §3, and this block is what proves those names are the
 * migration's.
 */
describe('PrismaProjectAccessReader.aclFacts — against the project tables of EPIC-014', () => {
  const facts = (projectId: string, userId: string) =>
    withTenant(prisma, { organizationId: ORG, userId: null }, () =>
      new PrismaProjectAccessReader().aclFacts(projectId, userId),
    );

  const insertProject = (visibility: 'PUBLIC_ORG' | 'PRIVATE', deleted = false): Promise<string> =>
    asMaintenance(pools.owner, async (client) => {
      const id = randomUUID();

      await client.query(
        `INSERT INTO projects
           (id, organization_id, key, name, visibility, lead_id, color, deleted_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, 'Fixture', $4, $5::uuid, '#000000',
                 ${deleted ? 'now()' : 'NULL'}, now())`,
        [id, ORG, `P${id.slice(0, 6).toUpperCase()}`, visibility, seeded.ownerId],
      );

      return id;
    });

  const join = (projectId: string, userId: string, role: string, left = false): Promise<void> =>
    asMaintenance(pools.owner, async (client) => {
      await client.query(
        `INSERT INTO project_members
           (organization_id, project_id, user_id, project_role, left_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, ${left ? 'now()' : 'NULL'}, now())`,
        [ORG, projectId, userId, role],
      );
    });

  it('CONTROL: a member of a private project gets their role', async () => {
    const projectId = await insertProject('PRIVATE');
    await join(projectId, seeded.ivanId, 'REVIEWER');

    await expect(facts(projectId, seeded.ivanId)).resolves.toEqual({
      organizationId: ORG,
      visibility: 'PRIVATE',
      memberRole: 'REVIEWER',
    });
  });

  it('answers a non-member of a public project as a row without a role', async () => {
    const projectId = await insertProject('PUBLIC_ORG');

    await expect(facts(projectId, seeded.petrId)).resolves.toEqual({
      organizationId: ORG,
      visibility: 'PUBLIC_ORG',
      memberRole: null,
    });
  });

  it('treats a membership that ended as no membership', async () => {
    const projectId = await insertProject('PRIVATE');
    await join(projectId, seeded.ivanId, 'MEMBER', true);

    await expect(facts(projectId, seeded.ivanId)).resolves.toMatchObject({ memberRole: null });
  });

  it('answers null for a soft-deleted project and for an unknown id', async () => {
    const projectId = await insertProject('PUBLIC_ORG', true);

    await expect(facts(projectId, seeded.ivanId)).resolves.toBeNull();
    await expect(facts(randomUUID(), seeded.ivanId)).resolves.toBeNull();
  });

  it('resolves a member’s level through the whole chain, entries and implicit table together', async () => {
    const projectId = await insertProject('PRIVATE');
    await join(projectId, seeded.ivanId, 'MEMBER');
    await grant({
      resourceId: projectId,
      subjectType: 'USER',
      subjectId: seeded.ivanId,
      level: 'VIEWER',
    });

    const resolver = new ResolveAclQuery({
      acl: new PrismaAclReader(),
      projects: new PrismaProjectAccessReader(),
      clock: { now: () => new Date() },
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        child() {
          return this;
        },
      },
    });

    await expect(
      withTenant(prisma, { organizationId: ORG, userId: seeded.ivanId }, () =>
        resolver.resolve(actorFor(seeded.ivanId), { type: 'PROJECT', id: projectId }),
      ),
    ).resolves.toEqual({
      status: 'resolved',
      organizationId: ORG,
      level: 'VIEWER',
      family: 'standard',
    });
    await expect(
      withTenant(prisma, { organizationId: ORG, userId: seeded.petrId }, () =>
        resolver.resolve(actorFor(seeded.petrId), { type: 'PROJECT', id: projectId }),
      ),
    ).resolves.toMatchObject({ status: 'resolved', level: 'NONE' });
  });
});
