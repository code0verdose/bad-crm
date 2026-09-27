import { randomUUID } from 'node:crypto';

import { type Prisma, PrismaClient } from '@prisma/client';
import { type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { type SharedPermissions } from '@bad-crm/shared';

import { ResolveAclQuery } from '@/application/access/use-cases/resolve-acl.query.js';
import { GetProjectDetailQuery } from '@/application/project/use-cases/get-project-detail.query.js';
import { ListProjectOptionsQuery } from '@/application/project/use-cases/list-project-options.query.js';
import {
  ListProjectsQuery,
  type ListProjectsInput,
} from '@/application/project/use-cases/list-projects.query.js';
import { type Actor } from '@/domain/access/actor.types.js';
import { PROJECT_STATUSES } from '@/domain/project/project.enums.js';
import { PrismaAclReader } from '@/infrastructure/persistence/prisma/acl-reader.adapter.js';
import { PrismaProjectAccessReader } from '@/infrastructure/persistence/prisma/project-access-reader.adapter.js';
import { PrismaProjectListQuery } from '@/infrastructure/persistence/prisma/project-list-query.adapter.js';
import { PrismaProjectRepository } from '@/infrastructure/persistence/prisma/project.repository.js';
import { PrismaUnitOfWork } from '@/infrastructure/persistence/prisma/unit-of-work.adapter.js';

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
 * The project list on a live PostgreSQL — STORY-014-04 acceptance 5, 8, 9, 10 and STORY-011-06
 * acceptance 12 («списки не резолвят построчно»; «список = фильтр по `can()` построчно»).
 *
 * **1. The list is `can()`, applied to a set.** A small organization holds every combination of
 * visibility and access the model has — a public project, a private one with and without the caller
 * on it, a left membership, an explicit `NONE`, a grant through a team and one through a role, `NONE`
 * beating `EDITOR` on one node, an expired `NONE` and an expired `VIEWER`, a deleted row, an archived
 * one, a guest's only grant, an organization-wide `NONE` with one project opened on top. For five
 * callers the list is compared with the detail read of **every** project, one by one, through the
 * same resolver and policy the card uses — and with the set written out by hand, so that two
 * implementations agreeing on nothing cannot pass.
 *
 * **2. Nothing hidden leaks sideways**: not into `total`, not into the facets, not across tenants
 * (with the neighbouring organization's own caller as the positive control).
 *
 * **3. The cost does not grow with the rows** — the statements of a list are counted from the
 * driver's log on one project and on sixty.
 *
 * **4. The plan, measured** on the volume the story names (1 000 projects, 10 000 memberships).
 */

const CLIENT_OPTIONS = {
  log: [{ level: 'query', emit: 'event' }],
} as const satisfies Prisma.PrismaClientOptions;

let pools: HarnessPools;
let prisma: PrismaClient<typeof CLIENT_OPTIONS>;

const ORG = randomUUID();
const OTHER_ORG = randomUUID();

/** Statements the driver sent since the buffer was emptied, with their bound values. */
const recorded: { query: string; params: string }[] = [];

const ALL_STATUSES = [...PROJECT_STATUSES];

type Key =
  | 'P01'
  | 'P02'
  | 'P03'
  | 'P04'
  | 'P05'
  | 'P06'
  | 'P07'
  | 'P08'
  | 'P09'
  | 'P10'
  | 'P11'
  | 'P12'
  | 'P13';

interface Seeded {
  readonly ownerId: string;
  readonly ivanId: string;
  readonly petrId: string;
  readonly gusId: string;
  readonly olgaId: string;
  readonly laraId: string;
  readonly xenaId: string;
  readonly foreignProjectId: string;
  readonly ids: Readonly<Record<Key, string>>;
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

interface ProjectSpec {
  readonly key: string;
  readonly name?: string;
  readonly visibility: 'PUBLIC_ORG' | 'PRIVATE';
  readonly status?: string;
  readonly leadId: string;
  readonly deleted?: boolean;
}

const insertProject = async (
  client: PoolClient,
  organizationId: string,
  spec: ProjectSpec,
): Promise<string> => {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO projects
       (organization_id, key, name, lead_id, color, visibility, status, deleted_at, updated_at)
     VALUES ($1::uuid, $2, $3, $4::uuid, 'indigo', $5, $6, $7::timestamptz, now())
     RETURNING id`,
    [
      organizationId,
      spec.key,
      spec.name ?? `Project ${spec.key}`,
      spec.leadId,
      spec.visibility,
      spec.status ?? 'ACTIVE',
      spec.deleted === true ? new Date().toISOString() : null,
    ],
  );

  return rows[0]?.id ?? '';
};

const insertMember = (
  client: PoolClient,
  projectId: string,
  userId: string,
  role: string,
  left = false,
): Promise<unknown> =>
  client.query(
    `INSERT INTO project_members
       (organization_id, project_id, user_id, project_role, left_at, updated_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::timestamptz, now())`,
    [ORG, projectId, userId, role, left ? new Date().toISOString() : null],
  );

const insertGrant = (
  client: PoolClient,
  grant: {
    readonly resourceType?: 'PROJECT' | 'ORGANIZATION';
    readonly resourceId: string;
    readonly subjectType: 'USER' | 'ROLE' | 'TEAM';
    readonly subjectId: string;
    readonly level: SharedPermissions.AccessLevel;
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
      grant.resourceType ?? 'PROJECT',
      grant.resourceId,
      grant.subjectType,
      grant.subjectId,
      grant.level,
      grant.expired === true ? new Date(Date.now() - 60_000).toISOString() : null,
    ],
  );

const seed = async (): Promise<Seeded> =>
  asMaintenance(pools.owner, async (client) => {
    const { ownerId } = await insertOrganizationWithOwner(client, ORG, {
      slug: `list-${ORG.slice(0, 8)}`,
    });
    const { ownerId: foreignOwnerId } = await insertOrganizationWithOwner(client, OTHER_ORG, {
      slug: `other-${OTHER_ORG.slice(0, 8)}`,
    });
    const ivanId = await insertUser(client, ORG);
    const petrId = await insertUser(client, ORG);
    const gusId = await insertUser(client, ORG);
    const olgaId = await insertUser(client, ORG);
    const laraId = await insertUser(client, ORG);
    const xenaId = await insertUser(client, OTHER_ORG);
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

    const project = (spec: Omit<ProjectSpec, 'leadId'> & { leadId?: string }) =>
      insertProject(client, ORG, { leadId: ownerId, ...spec });

    const ids: Record<Key, string> = {
      P01: await project({ key: 'P01', visibility: 'PUBLIC_ORG' }),
      P02: await project({ key: 'P02', visibility: 'PRIVATE', status: 'ON_HOLD' }),
      // Lara leads only this one, and it is hidden from Ivan: her id must not reach his facets.
      P03: await project({ key: 'P03', visibility: 'PRIVATE', status: 'CLOSED', leadId: laraId }),
      P04: await project({ key: 'P04', visibility: 'PUBLIC_ORG' }),
      P05: await project({ key: 'P05', visibility: 'PRIVATE', leadId: ivanId }),
      P06: await project({ key: 'P06', visibility: 'PRIVATE' }),
      P07: await project({ key: 'P07', name: '100% done', visibility: 'PUBLIC_ORG' }),
      P08: await project({ key: 'P08', visibility: 'PRIVATE' }),
      P09: await project({ key: 'P09', visibility: 'PUBLIC_ORG', deleted: true }),
      P10: await project({ key: 'P10', visibility: 'PUBLIC_ORG', status: 'ARCHIVED' }),
      P11: await project({ key: 'P11', visibility: 'PRIVATE' }),
      P12: await project({ key: 'P12', visibility: 'PRIVATE' }),
      P13: await project({ key: 'P13', visibility: 'PRIVATE' }),
    };

    await insertMember(client, ids.P02, ivanId, 'OBSERVER');
    await insertMember(client, ids.P05, ivanId, 'LEAD');
    await insertMember(client, ids.P11, ivanId, 'MEMBER', true);
    await insertGrant(client, {
      resourceId: ids.P04,
      subjectType: 'USER',
      subjectId: ivanId,
      level: 'NONE',
    });
    // Ivan leads P05 by membership, but the team grant is what matters for the TEAM path — so the
    // team is also the only way into P06 for nobody: the role grant opens it for Petr.
    await insertGrant(client, {
      resourceId: ids.P05,
      subjectType: 'TEAM',
      subjectId: teamId,
      level: 'VIEWER',
    });
    await insertGrant(client, {
      resourceId: ids.P06,
      subjectType: 'ROLE',
      subjectId: roleId,
      level: 'VIEWER',
    });
    await insertGrant(client, {
      resourceId: ids.P07,
      subjectType: 'USER',
      subjectId: ivanId,
      level: 'NONE',
      expired: true,
    });
    await insertGrant(client, {
      resourceId: ids.P08,
      subjectType: 'USER',
      subjectId: ivanId,
      level: 'VIEWER',
      expired: true,
    });
    await insertGrant(client, {
      resourceId: ids.P12,
      subjectType: 'USER',
      subjectId: ivanId,
      level: 'EDITOR',
    });
    await insertGrant(client, {
      resourceId: ids.P12,
      subjectType: 'TEAM',
      subjectId: teamId,
      level: 'NONE',
    });
    await insertGrant(client, {
      resourceId: ids.P13,
      subjectType: 'USER',
      subjectId: gusId,
      level: 'VIEWER',
    });
    // Olga: the whole organization closed to her, one project opened on top — the closest node wins.
    await insertGrant(client, {
      resourceType: 'ORGANIZATION',
      resourceId: ORG,
      subjectType: 'USER',
      subjectId: olgaId,
      level: 'NONE',
    });
    await insertGrant(client, {
      resourceId: ids.P03,
      subjectType: 'USER',
      subjectId: olgaId,
      level: 'VIEWER',
    });

    return {
      ownerId,
      ivanId,
      petrId,
      gusId,
      olgaId,
      laraId,
      xenaId,
      foreignProjectId: await insertProject(client, OTHER_ORG, {
        key: 'P01',
        visibility: 'PUBLIC_ORG',
        leadId: foreignOwnerId,
      }),
      ids,
    };
  });

const actorFor = (userId: string, overrides: Partial<Actor> = {}): Actor => ({
  userId,
  organizationId: ORG,
  isOwner: false,
  permissionsVersion: 1,
  permissions: new Set<SharedPermissions.PermissionKey>(['project:read']),
  denied: new Set<SharedPermissions.PermissionKey>(),
  roleKeys: ['developer'],
  ...overrides,
});

const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};

const listQuery = (): ListProjectsQuery =>
  new ListProjectsQuery(
    new PrismaUnitOfWork(prisma),
    new PrismaAclReader(),
    new PrismaProjectListQuery(),
    { now: () => new Date() },
    silentLogger,
  );

const detailQuery = (): GetProjectDetailQuery =>
  new GetProjectDetailQuery(
    new PrismaUnitOfWork(prisma),
    new PrismaProjectRepository(),
    new ResolveAclQuery({
      acl: new PrismaAclReader(),
      projects: new PrismaProjectAccessReader(),
      clock: { now: () => new Date() },
      logger: silentLogger,
    }),
  );

const FILTER: ListProjectsInput['filter'] = {
  query: '',
  statuses: ALL_STATUSES,
  leadId: null,
  memberOnly: false,
  sort: 'key',
  page: 1,
  perPage: 100,
};

const list = (actor: Actor, filter: Partial<ListProjectsInput['filter']> = {}) =>
  listQuery().execute({ actor, filter: { ...FILTER, ...filter } });

const keysOf = (items: readonly { readonly key: string }[]): string[] =>
  items.map((item) => item.key);

/** Every project of the organization, live or deleted, as the migrator sees them. */
const everyProjectId = (): string[] => [...Object.values(seeded.ids), seeded.foreignProjectId];

/** `can(actor, 'project:read', p)` for every project — the detail read, one at a time. */
const readableOneByOne = async (actor: Actor): Promise<string[]> => {
  const readable: string[] = [];

  for (const projectId of everyProjectId()) {
    const outcome = await detailQuery()
      .execute({ actor, projectId })
      .then(
        () => 'read',
        (error: { code?: string }) => error.code,
      );

    if (outcome === 'read') readable.push(projectId);
    // Anything but «not there» would be a different question than the one this file asks.
    else expect(outcome).toBe('project_not_found');
  }

  return readable;
};

const byKey = (keys: readonly Key[]): string[] => keys.map((key) => seeded.ids[key]).toSorted();

beforeAll(async () => {
  pools = createPools();
  prisma = new PrismaClient({ ...CLIENT_OPTIONS, datasourceUrl: inject('databaseUrls').appUser });
  prisma.$on('query', (event) => {
    recorded.push({ query: event.query, params: event.params });
  });
  await truncateAll(pools.owner);
  seeded = await seed();
});

afterAll(async () => {
  await truncateAll(pools.owner);
  await prisma.$disconnect();
  await closePools(pools);
});

describe('the list is can(project:read), applied to a set', () => {
  const cases: readonly (readonly [string, () => Actor, readonly Key[]])[] = [
    [
      'Ivan — member of the organization, on two projects, in a team, with grants',
      () => actorFor(seeded.ivanId),
      ['P01', 'P02', 'P05', 'P07', 'P10'],
    ],
    [
      'Petr — through a role grant',
      () => actorFor(seeded.petrId),
      ['P01', 'P04', 'P06', 'P07', 'P10'],
    ],
    [
      'Gus — a guest: nothing without an explicit grant',
      () => actorFor(seeded.gusId, { roleKeys: ['guest'] }),
      ['P13'],
    ],
    [
      'Olga — NONE on the organization, VIEWER on one project',
      () => actorFor(seeded.olgaId),
      ['P03'],
    ],
    [
      'the owner — everything live, the deleted row excepted',
      () => actorFor(seeded.ownerId, { isOwner: true, permissions: new Set(), roleKeys: [] }),
      ['P01', 'P02', 'P03', 'P04', 'P05', 'P06', 'P07', 'P08', 'P10', 'P11', 'P12', 'P13'],
    ],
  ];

  it.each(cases)('%s', async (_who, actor, expected) => {
    const page = await list(actor());
    const listed = page.items.map((item) => item.projectId).toSorted();

    // The list, the per-row decision and the hand-written expectation are one set.
    expect(listed).toEqual(byKey(expected));
    expect((await readableOneByOne(actor())).toSorted()).toEqual(listed);
    expect(page.total).toBe(expected.length);
  });
});

/**
 * The header's switcher (STORY-014-06) reads the **same** visible set: for every caller above, the
 * options with the archive on are exactly the list with every status, and the recent ids come back
 * only when the caller could open them — a hidden, deleted or foreign id is simply absent.
 */
describe('the switcher offers what the list shows, and nothing else', () => {
  const optionsQuery = (): ListProjectOptionsQuery =>
    new ListProjectOptionsQuery(
      new PrismaUnitOfWork(prisma),
      new PrismaAclReader(),
      new PrismaProjectListQuery(),
      { now: () => new Date() },
      silentLogger,
    );

  const offer = (
    actor: Actor,
    input: { query?: string; includeArchived?: boolean; recentIds?: string[] },
  ) =>
    optionsQuery().execute({
      actor,
      query: input.query ?? '',
      includeArchived: input.includeArchived ?? true,
      recentIds: input.recentIds ?? [],
    });

  it.each<readonly [string, () => Actor]>([
    ['Ivan', () => actorFor(seeded.ivanId)],
    ['Petr', () => actorFor(seeded.petrId)],
    ['Gus', () => actorFor(seeded.gusId, { roleKeys: ['guest'] })],
    ['Olga', () => actorFor(seeded.olgaId)],
    [
      'the owner',
      () => actorFor(seeded.ownerId, { isOwner: true, permissions: new Set(), roleKeys: [] }),
    ],
  ])('%s — options ≡ list, recent ≡ readable one by one', async (_who, actor) => {
    const listed = (await list(actor())).items.map((item) => item.projectId).toSorted();
    const offered = await offer(actor(), {});

    expect(offered.items.map((item) => item.projectId).toSorted()).toEqual(listed);
    expect(offered.hasMore).toBe(false);

    // Five ids of every kind at once — readable, hidden, deleted, foreign — answered as a set.
    const asked = [
      seeded.ids.P01,
      seeded.ids.P03,
      seeded.ids.P09,
      seeded.ids.P12,
      seeded.foreignProjectId,
    ];
    const recent = await offer(actor(), { recentIds: asked });
    const readable = await readableOneByOne(actor());

    expect(recent.recent.map((item) => item.projectId).toSorted()).toEqual(
      asked.filter((id) => readable.includes(id)).toSorted(),
    );
  });

  it('keeps the archive out by default and matches text in name and key', async () => {
    const ivan = actorFor(seeded.ivanId);
    const plain = await offer(ivan, { includeArchived: false });
    const found = await offer(ivan, { includeArchived: false, query: '100%' });

    // In name order — «100% done» sorts before the projects named after their keys.
    expect(keysOf(plain.items)).toEqual(['P07', 'P01', 'P02', 'P05']);
    expect(keysOf(found.items)).toEqual(['P07']);
  });
});

describe('nothing hidden leaks sideways', () => {
  it('CONTROL: the neighbouring organization’s caller sees its own project, and only it', async () => {
    const xena = { ...actorFor(seeded.xenaId), organizationId: OTHER_ORG };

    const page = await list(xena);

    expect(page.items.map((item) => item.projectId)).toEqual([seeded.foreignProjectId]);
  });

  it('a project of another organization with the same key is never on Ivan’s list', async () => {
    const page = await list(actorFor(seeded.ivanId), { query: 'P01' });

    expect(page.items.map((item) => item.projectId)).toEqual([seeded.ids.P01]);
    expect(page.total).toBe(1);
  });

  it('the facets name only what the caller can see', async () => {
    const page = await list(actorFor(seeded.ivanId));

    // P03 (CLOSED, led by Lara) is hidden from Ivan: neither its status nor its lead appears.
    expect(page.facets.statuses).toEqual(['ACTIVE', 'ON_HOLD', 'ARCHIVED']);
    expect(page.facets.leadIds).toEqual([seeded.ownerId, seeded.ivanId].toSorted());

    // CONTROL: the owner sees P03, and with it both.
    const owner = await list(
      actorFor(seeded.ownerId, { isOwner: true, permissions: new Set(), roleKeys: [] }),
    );

    expect(owner.facets.statuses).toContain('CLOSED');
    expect(owner.facets.leadIds).toContain(seeded.laraId);
  });
});

describe('the filters, on top of the visible set', () => {
  const ivan = () => actorFor(seeded.ivanId);

  it('hides the archive by default, and shows it when asked', async () => {
    const byDefault = await list(ivan(), { statuses: [] });
    const archive = await list(ivan(), { statuses: ['ARCHIVED'] });

    expect(keysOf(byDefault.items)).toEqual(['P01', 'P02', 'P05', 'P07']);
    expect(byDefault.total).toBe(4);
    expect(keysOf(archive.items)).toEqual(['P10']);
  });

  it('member=me is the caller’s live membership — a left one is not', async () => {
    const mine = await list(ivan(), { memberOnly: true });

    expect(keysOf(mine.items)).toEqual(['P02', 'P05']);
  });

  it('narrows by lead', async () => {
    const led = await list(ivan(), { leadId: seeded.ivanId });

    expect(keysOf(led.items)).toEqual(['P05']);
  });

  it('searches name and key case-insensitively, with % as a character', async () => {
    const byPercent = await list(ivan(), { query: '%' });
    const byName = await list(ivan(), { query: 'project p0' });

    expect(keysOf(byPercent.items)).toEqual(['P07']);
    expect(keysOf(byName.items)).toEqual(['P01', 'P02', 'P05']);
  });

  it('pages over the filtered set, total unchanged by the page', async () => {
    const second = await list(ivan(), { perPage: 2, page: 2 });
    const beyond = await list(ivan(), { perPage: 2, page: 9 });

    expect(keysOf(second.items)).toEqual(['P05', 'P07']);
    expect(second.total).toBe(5);
    expect(beyond.items).toEqual([]);
    expect(beyond.total).toBe(5);
  });

  it('orders descending by key', async () => {
    const page = await list(ivan(), { sort: '-key' });

    expect(keysOf(page.items)).toEqual(['P10', 'P07', 'P05', 'P02', 'P01']);
  });

  it('counts live members only', async () => {
    const page = await list(ivan(), { query: 'P11' });
    const owner = await list(
      actorFor(seeded.ownerId, { isOwner: true, permissions: new Set(), roleKeys: [] }),
      { query: 'P1' },
    );

    // Hidden from Ivan (he left it); for the owner the left membership does not count.
    expect(page.items).toEqual([]);
    expect(owner.items.find((item) => item.key === 'P11')?.memberCount).toBe(0);
    expect(owner.items.find((item) => item.key === 'P10')?.memberCount).toBe(0);
  });
});

/**
 * Quiescence rather than a pause: the query events arrive after the awaited promise settled, and a
 * fixed wait is a different number on every runner.
 */
const drain = async (): Promise<void> => {
  let previous = -1;

  while (previous !== recorded.length) {
    previous = recorded.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

const statementsOfOneList = async (actor: Actor): Promise<string[]> => {
  recorded.length = 0;
  await list(actor);
  await drain();

  return recorded.map((entry) => entry.query);
};

describe('the cost does not grow with the rows (no N+1)', () => {
  it('one visible project and sixty-one cost the same statements', async () => {
    const olga = actorFor(seeded.olgaId);
    const ivan = actorFor(seeded.ivanId);

    const few = await statementsOfOneList(olga);

    await asMaintenance(pools.owner, async (client) => {
      for (let index = 0; index < 60; index += 1) {
        const projectId = await insertProject(client, ORG, {
          key: `N${String(index).padStart(3, '0')}`,
          visibility: 'PUBLIC_ORG',
          leadId: seeded.ownerId,
        });

        await insertMember(client, projectId, seeded.petrId, 'MEMBER');
      }
    });

    const many = await statementsOfOneList(ivan);

    expect((await list(ivan)).total).toBe(65);
    // The same statements, in the same order: the organization node, the count, the page and the
    // facets, wrapped in the transaction and its `set_config` — whatever the number of rows.
    expect(many).toEqual(few);
    expect(many.filter((statement) => statement.includes('resource_acl'))).toHaveLength(4);
  });
});

/** Runs a recorded statement under `EXPLAIN (ANALYZE, BUFFERS)` as `app_user`, in the tenant. */
const explain = (statement: { query: string; params: string }): Promise<string> =>
  asTenant(pools.app, ORG, async (client) => {
    const { rows } = await client.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) ${statement.query}`,
      JSON.parse(statement.params) as unknown[],
    );

    return rows.map((row) => row['QUERY PLAN']).join('\n');
  });

const executionMs = (plan: string): number =>
  Number(/Execution Time: ([\d.]+) ms/.exec(plan)?.[1] ?? Number.NaN);

/** The count, the page and the facets of one list — every statement that builds the visible set. */
const visibleSetPlans = async (actor: Actor): Promise<string[]> => {
  recorded.length = 0;
  await list(actor, { statuses: [], perPage: 25, sort: 'name' });
  await drain();

  const statements = recorded.filter((entry) => entry.query.includes('FROM visible v'));

  return Promise.all(statements.map((statement) => explain(statement)));
};

/**
 * An index node on `resource_acl` whose index condition names `subject_id` — the grants reached by
 * the caller's subjects, read within that node (the lookahead stops at the next `->`). An index
 * scan seeking on `organization_id` alone, with the subjects left to a filter, reads the
 * organization's whole ACL and does not match.
 */
const SUBJECT_SEEK =
  /(?:Index|Index Only|Bitmap Index) Scan using idx_resource_acl_subject(?: on resource_acl)?[^\n]*\n(?:(?![^\n]*->)[^\n]*\n)*?\s*Index Cond: \([^\n]*subject_id/;

describe('the caller’s grants are found by subject, not by reading the ACL', () => {
  beforeAll(async () => {
    // Tens of thousands of grants the caller has nothing to do with, in the proportions that make
    // «read the organization's ACL and filter» the expensive shape: most of them in the caller's
    // own organization (so its leading column selects nothing), on projects and on other kinds of
    // resource, to other users, roles and teams; a slice in the neighbouring organization; and a
    // few of the caller's own on other kinds of resource, which the list must not count either.
    await asMaintenance(pools.owner, async (client) => {
      await client.query(
        `INSERT INTO resource_acl (organization_id, resource_type, resource_id, subject_type,
                                   subject_id, access_level, updated_at)
         SELECT $1::uuid,
                (ARRAY['PROJECT','BOARD','TASK','DOC_PAGE']::acl_resource_type[])[1 + i % 4],
                gen_random_uuid(),
                (ARRAY['USER','ROLE','TEAM']::acl_subject_type[])[1 + i % 3],
                gen_random_uuid(),
                (ARRAY['NONE','VIEWER','EDITOR']::access_level[])[1 + i % 3],
                now()
           FROM generate_series(1, 40000) AS i`,
        [ORG],
      );
      await client.query(
        `INSERT INTO resource_acl (organization_id, resource_type, resource_id, subject_type,
                                   subject_id, access_level, updated_at)
         SELECT $1::uuid, 'PROJECT', gen_random_uuid(), 'USER', gen_random_uuid(), 'MANAGER', now()
           FROM generate_series(1, 10000)`,
        [OTHER_ORG],
      );
      await client.query(
        `INSERT INTO resource_acl (organization_id, resource_type, resource_id, subject_type,
                                   subject_id, access_level, updated_at)
         SELECT $1::uuid, (ARRAY['BOARD','TASK']::acl_resource_type[])[1 + i % 2],
                gen_random_uuid(), 'USER', $2::uuid, 'MANAGER', now()
           FROM generate_series(1, 200) AS i`,
        [ORG, seeded.ivanId],
      );
      await client.query('ANALYZE resource_acl');
    });
  });

  it('CONTROL: the noise changes nothing Ivan sees — the list is still can(), row by row', async () => {
    const ivan = actorFor(seeded.ivanId);
    const page = await list(ivan);
    // The sixty public projects of the cost suite are visible to everybody; the combinations that
    // grants decide are the seeded ones.
    const seededIds = new Set(everyProjectId());
    const listed = page.items
      .map((item) => item.projectId)
      .filter((projectId) => seededIds.has(projectId))
      .toSorted();

    expect(listed).toEqual(byKey(['P01', 'P02', 'P05', 'P07', 'P10']));
    expect((await readableOneByOne(ivan)).toSorted()).toEqual(listed);
  });

  it.each([
    ['Ivan — a user grant, a team grant, grants on other kinds of resource', () => seeded.ivanId],
    ['Petr — through a role', () => seeded.petrId],
  ])('%s: every statement seeks the ACL by subject', async (_who, userId) => {
    const plans = await visibleSetPlans(actorFor(userId()));

    expect(plans).toHaveLength(3);

    for (const plan of plans) {
      expect(plan, plan).not.toContain('Seq Scan on resource_acl');
      expect(plan, plan).toMatch(SUBJECT_SEEK);
    }
  });
});

describe('measured on the volume the story names — 1 000 projects, 10 000 memberships', () => {
  beforeAll(async () => {
    await asMaintenance(pools.owner, async (client) => {
      const users: string[] = [];

      for (let index = 0; index < 50; index += 1) users.push(await insertUser(client, ORG));

      await client.query(
        `INSERT INTO projects (organization_id, key, name, lead_id, color, visibility, status,
                               updated_at)
         SELECT $1::uuid, 'B' || lpad(i::text, 4, '0'), 'Bulk ' || i, $2::uuid, 'indigo',
                CASE WHEN i % 3 = 0 THEN 'PRIVATE' ELSE 'PUBLIC_ORG' END,
                (ARRAY['ACTIVE','ON_HOLD','ARCHIVED','CLOSED'])[1 + i % 4], now()
           FROM generate_series(1, 1000) AS i`,
        [ORG, seeded.ownerId],
      );
      // Ten distinct members on every bulk project — 10 000 live memberships, Ivan in place of the
      // first one on every seventh project. Ten consecutive residues mod 50 never collide.
      await client.query(
        `INSERT INTO project_members (organization_id, project_id, user_id, project_role, updated_at)
         SELECT $1::uuid, p.id, u.user_id, 'MEMBER', now()
           FROM projects p
           CROSS JOIN LATERAL (
             SELECT CASE WHEN n = 1 AND (substr(p.key, 2)::int % 7 = 0) THEN $2::uuid
                         ELSE ($3::uuid[])[1 + ((substr(p.key, 2)::int * 7 + n) % 50)] END AS user_id
               FROM generate_series(1, 10) AS n
           ) u
          WHERE p.organization_id = $1::uuid AND p.key LIKE 'B%'
          ON CONFLICT DO NOTHING`,
        [ORG, seeded.ivanId, users],
      );
      await client.query('ANALYZE projects');
      await client.query('ANALYZE project_members');
      await client.query('ANALYZE resource_acl');
    });
  });

  it('p95 of the whole list under 300 ms, and no statement reads a membership table in full', async () => {
    const ivan = actorFor(seeded.ivanId);
    const durations: number[] = [];

    for (let run = 0; run < 20; run += 1) {
      const started = performance.now();

      // By name: no index serves this order, so the page has to see every visible project — the
      // expensive shape, not the one an ordered index scan can stop early on.
      await list(ivan, { statuses: [], perPage: 25, sort: 'name' });
      durations.push(performance.now() - started);
    }

    const p95 = durations.toSorted((a, b) => a - b)[Math.ceil(durations.length * 0.95) - 1] ?? 0;

    recorded.length = 0;
    await list(ivan, { statuses: [], perPage: 25, sort: 'name' });
    await drain();

    // The count, the page and the facets — every statement that builds the visible set.
    const statements = recorded.filter((entry) => entry.query.includes('FROM visible v'));
    const plans = await Promise.all(statements.map((statement) => explain(statement)));
    const memberships = await asMaintenance(pools.owner, async (client) =>
      Number(
        (await client.query<{ n: string }>('SELECT count(*) AS n FROM project_members')).rows[0]?.n,
      ),
    );

    expect(memberships).toBeGreaterThanOrEqual(10_000);
    expect(plans).toHaveLength(3);
    expect(p95, `p95 ${p95.toFixed(1)} ms over ${durations.join(', ')}`).toBeLessThan(300);

    for (const plan of plans) {
      expect(executionMs(plan), plan).toBeLessThan(300);
      // The caller's membership is found by index, not by reading ten thousand rows per project.
      expect(plan, plan).not.toContain('Seq Scan on project_members');
    }
  });
});
