import { randomUUID } from 'node:crypto';

import { type Prisma, PrismaClient } from '@prisma/client';
import { type PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { type SharedPermissions } from '@bad-crm/shared';

import { ResolveAclQuery } from '@/application/access/use-cases/resolve-acl.query.js';
import { GetProjectDetailQuery } from '@/application/project/use-cases/get-project-detail.query.js';
import { type Actor } from '@/domain/access/actor.types.js';
import { decideProjectAccess } from '@/domain/project/access/project-access.policy.js';
import { PrismaAclReader } from '@/infrastructure/persistence/prisma/acl-reader.adapter.js';
import { PrismaProjectAccessReader } from '@/infrastructure/persistence/prisma/project-access-reader.adapter.js';
import { PrismaProjectRepository } from '@/infrastructure/persistence/prisma/project.repository.js';
import { withTenant } from '@/infrastructure/persistence/prisma/tenant.context.js';
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
 * Reading one project against a real PostgreSQL, with the statements counted — STORY-011-07,
 * acceptance 3 (the resource half) and 4, on the first resource the model has.
 *
 * Two things only a live database can show:
 *
 * 1. **The order and the cost of the conjunction.** A caller without `project:read` is refused
 *    before a single statement about the project is sent; a caller with it costs the scope, the two
 *    reads of the resolver and then the entity — in that order, and the entity last. The number is
 *    pinned as well as ordered, for the reason `effective-permissions-cost.test.ts` gives: a read
 *    that grew from four statements to twelve equally for everybody would pass an order check.
 * 2. **The closed contour, end to end.** A project that does not exist, a project of another
 *    organization and a `PRIVATE` project the caller is not on come back as one `project_not_found`
 *    from the same composition the container will wire — the tenant policy, the reader, the
 *    resolver and the policy together — with the caller's own `PUBLIC_ORG` project as the control.
 */

const CLIENT_OPTIONS = {
  log: [{ level: 'query', emit: 'event' }],
} as const satisfies Prisma.PrismaClientOptions;

let pools: HarnessPools;
let prisma: PrismaClient<typeof CLIENT_OPTIONS>;

const ORG = randomUUID();
const OTHER_ORG = randomUUID();

/** Every statement the driver sent since the buffer was last emptied — `BEGIN` and `COMMIT` included. */
const recorded: string[] = [];

interface Seeded {
  readonly ownerId: string;
  readonly ivanId: string;
  readonly petrId: string;
  readonly publicProjectId: string;
  readonly privateProjectId: string;
  readonly foreignProjectId: string;
}

let seeded: Seeded;

const insertUser = async (client: PoolClient, organizationId: string): Promise<string> => {
  const userId = randomUUID();

  await client.query(
    `INSERT INTO users (id, organization_id, email, password_hash, status, updated_at)
     VALUES ($1::uuid, $2::uuid, $3, 'placeholder-not-a-credential', 'ACTIVE', now())`,
    [userId, organizationId, `member-${userId.slice(0, 8)}@example.test`],
  );

  return userId;
};

const insertProject = async (
  client: PoolClient,
  organizationId: string,
  key: string,
  leadId: string,
  visibility: 'PUBLIC_ORG' | 'PRIVATE',
): Promise<string> => {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO projects (organization_id, key, name, lead_id, color, visibility, updated_at)
     VALUES ($1::uuid, $2, $2, $3::uuid, 'indigo', $4, now())
     RETURNING id`,
    [organizationId, key, leadId, visibility],
  );

  return rows[0]?.id ?? '';
};

const seed = async (): Promise<Seeded> =>
  asMaintenance(pools.owner, async (client) => {
    const { ownerId } = await insertOrganizationWithOwner(client, ORG, {
      slug: `read-${ORG.slice(0, 8)}`,
    });
    const { ownerId: foreignOwnerId } = await insertOrganizationWithOwner(client, OTHER_ORG, {
      slug: `other-${OTHER_ORG.slice(0, 8)}`,
    });
    const ivanId = await insertUser(client, ORG);
    const petrId = await insertUser(client, ORG);
    const privateProjectId = await insertProject(client, ORG, 'SECRET', ownerId, 'PRIVATE');

    // Petr watches the private project: an OBSERVER, which the implicit table reads as VIEWER.
    await client.query(
      `INSERT INTO project_members (organization_id, project_id, user_id, project_role, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'OBSERVER', now())`,
      [ORG, privateProjectId, petrId],
    );

    return {
      ownerId,
      ivanId,
      petrId,
      publicProjectId: await insertProject(client, ORG, 'BAD', ownerId, 'PUBLIC_ORG'),
      privateProjectId,
      foreignProjectId: await insertProject(
        client,
        OTHER_ORG,
        'THEIRS',
        foreignOwnerId,
        'PUBLIC_ORG',
      ),
    };
  });

const actorFor = (
  userId: string,
  granted: readonly SharedPermissions.PermissionKey[] = ['project:read'],
): Actor => ({
  userId,
  organizationId: ORG,
  isOwner: false,
  permissionsVersion: 1,
  permissions: new Set(granted),
  denied: new Set(),
  roleKeys: ['developer'],
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

const query = (): GetProjectDetailQuery =>
  new GetProjectDetailQuery(
    new PrismaUnitOfWork(prisma),
    new PrismaProjectRepository(),
    resolver(),
  );

/**
 * Quiescence rather than a pause, as in `effective-permissions-cost.test.ts`: the query events
 * arrive after the awaited promise settled, and a fixed wait is a different number on every runner.
 */
const drain = async (): Promise<void> => {
  let previous = -1;

  while (previous !== recorded.length) {
    previous = recorded.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

/** The statements one read costs, in the order they were sent. */
const statementsToRead = async (actor: Actor, projectId: string): Promise<readonly string[]> => {
  recorded.length = 0;

  await query()
    .execute({ actor, projectId })
    .catch(() => undefined);
  await drain();

  return [...recorded];
};

const touchesTheProject = (statement: string): boolean =>
  /projects|project_members|resource_acl/.test(statement);

beforeAll(() => {
  pools = createPools();
  prisma = new PrismaClient({ ...CLIENT_OPTIONS, datasourceUrl: inject('databaseUrls').appUser });
  prisma.$on('query', (event) => {
    recorded.push(event.query);
  });
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

describe('the closed contour, end to end', () => {
  it('CONTROL: a member of the organization reads their own PUBLIC_ORG project', async () => {
    await expect(
      query().execute({ actor: actorFor(seeded.ivanId), projectId: seeded.publicProjectId }),
    ).resolves.toMatchObject({
      projectId: seeded.publicProjectId,
      key: 'BAD',
      visibility: 'PUBLIC_ORG',
    });
  });

  it.each<[string, () => string]>([
    ['a project that does not exist', () => randomUUID()],
    ['a project of another organization', () => seeded.foreignProjectId],
    ['a PRIVATE project the caller is not on', () => seeded.privateProjectId],
  ])('%s → project_not_found', async (_case, projectId) => {
    await expect(
      query().execute({ actor: actorFor(seeded.ivanId), projectId: projectId() }),
    ).rejects.toMatchObject({ code: 'project_not_found', reason: 'resource_not_found' });
  });

  it('a deleted project → project_not_found: the flag reaches the policy, not a WHERE clause', async () => {
    await asMaintenance(pools.owner, (client) =>
      client.query(`UPDATE projects SET deleted_at = now() WHERE id = $1::uuid`, [
        seeded.publicProjectId,
      ]),
    );

    await expect(
      query().execute({ actor: actorFor(seeded.ivanId), projectId: seeded.publicProjectId }),
    ).rejects.toMatchObject({ code: 'project_not_found', reason: 'resource_not_found' });
  });

  it('a member of a PRIVATE project reads it through the implicit level', async () => {
    await expect(
      query().execute({ actor: actorFor(seeded.petrId), projectId: seeded.privateProjectId }),
    ).resolves.toMatchObject({ projectId: seeded.privateProjectId, visibility: 'PRIVATE' });
  });

  /**
   * Acceptance 2 of STORY-011-07, its resource half, on a live object: the caller holds the key,
   * the object is theirs to see, and the level the chain answers is one rung too low. This is the
   * one refusal that is a 403 with a reason — inside the contour, existence is not a secret.
   */
  it('an OBSERVER holding project:update is refused as insufficient_acl_level, on the live chain', async () => {
    const actor = actorFor(seeded.petrId, ['project:update']);
    const projects = new PrismaProjectRepository();
    const acl = resolver();

    const decision = await withTenant(prisma, { organizationId: ORG, userId: actor.userId }, () =>
      decideProjectAccess(actor, 'project:update', async () => ({
        scope: await projects.scope(seeded.privateProjectId),
        acl: await acl.resolve(actor, { type: 'PROJECT', id: seeded.privateProjectId }),
      })),
    );

    expect(decision).toEqual({
      allowed: false,
      reason: 'insufficient_acl_level',
      permissionKey: 'project:update',
    });
  });
});

describe('what one read costs, in statements', () => {
  it('sends nothing about the project to a caller without project:read', async () => {
    const statements = await statementsToRead(actorFor(seeded.ivanId, []), seeded.publicProjectId);

    expect(statements.filter(touchesTheProject)).toEqual([]);
  });

  it('reads the scope, then the chain, and the entity last — capability → ACL → entity', async () => {
    const statements = await statementsToRead(actorFor(seeded.ivanId), seeded.publicProjectId);
    const about = statements
      .filter(touchesTheProject)
      .map((statement) => statement.replaceAll(/\s+/g, ' ').trim());

    // 1. `scope()`, under `FOR SHARE`; 2. the reader of the implicit table; 3. the entries along
    // the chain, in one statement; 4. the entity — never before the three that decide.
    expect(about.map((statement) => statement.slice(0, 40))).toEqual([
      expect.stringMatching(/^SELECT id, deleted_at, visibility FROM/),
      expect.stringMatching(/^SELECT p\.organization_id AS organization/),
      expect.stringMatching(/^WITH chain\(depth, resource_type, resou/),
      expect.stringMatching(/^SELECT "public"\."projects"\."id"/),
    ]);
    expect(about[0]).toMatch(/FOR SHARE$/);
    expect(about[2]).toMatch(/JOIN resource_acl/);
  });

  /**
   * What each refusal costs, next to what success costs. The scope and the reader are always both
   * read — the use-case decides nothing by itself — and the entity is never read for a refusal.
   * The chain is read only when the reader found a row: the resolver stops at a missing chain
   * (`resolve-acl.query.ts`, «broken chain»), so «not there» and «not yours» differ from «not on
   * it» by one statement. Recorded rather than hidden: the code is the same 404 in all three, and
   * the difference lives in the resolver, not in this read.
   */
  it.each<[string, () => string, number]>([
    ['a project that does not exist', () => randomUUID(), 2],
    ['a project of another organization', () => seeded.foreignProjectId, 2],
    ['a PRIVATE project the caller is not on', () => seeded.privateProjectId, 3],
    ['CONTROL: the caller’s own PUBLIC_ORG project', () => seeded.publicProjectId, 4],
  ])('%s costs %i statements about the project', async (_case, projectId, expected) => {
    const statements = await statementsToRead(actorFor(seeded.ivanId), projectId());
    const about = statements.filter(touchesTheProject);

    expect(about).toHaveLength(expected);
    expect(about.some((statement) => statement.includes('"public"."projects"'))).toBe(
      expected === 4,
    );
  });

  it('is one transaction: BEGIN, the tenant, three decisions, one entity, COMMIT', async () => {
    const statements = await statementsToRead(actorFor(seeded.ivanId), seeded.publicProjectId);

    // `BEGIN`, `SET TRANSACTION ISOLATION LEVEL`, two `set_config`, four reads, `COMMIT`.
    expect(statements).toHaveLength(9);
  });
});
