import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { type PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { ResolveAclQuery } from '@/application/access/use-cases/resolve-acl.query.js';
import { DeleteProjectUseCase } from '@/application/project/use-cases/delete-project.use-case.js';
import {
  AddProjectMemberUseCase,
  RemoveProjectMemberUseCase,
} from '@/application/project/use-cases/manage-project-members.use-case.js';
import { UpdateProjectUseCase } from '@/application/project/use-cases/update-project.use-case.js';
import { type Actor } from '@/domain/access/actor.types.js';
import { AppError } from '@/domain/shared/errors/app.errors.js';
import { PrismaAclReader } from '@/infrastructure/persistence/prisma/acl-reader.adapter.js';
import { PrismaProjectAccessReader } from '@/infrastructure/persistence/prisma/project-access-reader.adapter.js';
import { PrismaProjectMemberRepository } from '@/infrastructure/persistence/prisma/project-member.repository.js';
import { PrismaProjectRepository } from '@/infrastructure/persistence/prisma/project.repository.js';
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
 * The four races the roster commands promise to settle — measured on the product's own use-cases
 * over the product's own adapters against a real PostgreSQL, because nothing else can measure
 * them. The HTTP suites (`project-member-endpoints.test.ts`, `project-write-endpoints.test.ts`)
 * run over an in-memory store that serves one caller at a time; `project-write-locks.test.ts`
 * proves the lock at the repository seam. What neither shows is that the **use-case** built on
 * that lock reaches the right answer when two of them run at once — and that is the claim the
 * docstrings make («two concurrent removals each count two leads and both proceed» is what the
 * lock prevents, `project-membership.policy.ts`, `assertLastLeadKept`).
 *
 * 1. **Two leads leave at the same time.** Without the project lock, both transactions count two
 *    leads, both stamp `left_at`, and the project has none. With it, the second waits on
 *    `lockForWrite`, re-reads the roster once the first committed, and is refused with
 *    `409 last_project_lead_required`. Exactly one leaves; exactly one lead remains.
 * 2. **One person is added twice at the same time.** The second transaction waits on the same
 *    lock, reads the seat the first wrote, and is a silent no-op — so the person holds one live
 *    row, was bumped once, and appears in the trail once. Both callers are answered.
 * 3. **A project is edited while it is being deleted.** Whichever transaction takes the lock
 *    first wins; the other reads the committed state. The edit therefore either lands before the
 *    deletion or is the same `project_not_found` a foreign id gets — never a change on a hidden
 *    row, and never an entry for one.
 * 4. **One person is put on two different projects at the same time.** No project lock is shared
 *    here; what the two transactions contend for is the person's `users` row — read by
 *    `subject()`, updated by the version bump. This one was red: under `FOR SHARE` it was the
 *    share-lock upgrade of race 1 in `project-write-locks.test.ts`, on a different table, and it
 *    is what moved `subject()` to `FOR NO KEY UPDATE`.
 *
 * Each race has a sequential control beside it, so a race that «passes» because the command did
 * nothing at all is not mistaken for the lock working. The actor is the organization's owner:
 * `isOwner` clears the capability and the level, and the races are about the roster, not about
 * who may touch it (`project-read-access.test.ts` measures that).
 */

let pools: HarnessPools;
let prisma: PrismaClient;

const ORG = randomUUID();
const ADDRESS = '203.0.113.7';

interface Seeded {
  readonly ownerId: string;
  readonly annaId: string;
  readonly borisId: string;
  readonly dariaId: string;
  readonly projectId: string;
}

let seeded: Seeded;
let audit: FakeAuditLogger;

const insertUser = async (client: PoolClient, organizationId: string): Promise<string> => {
  const userId = randomUUID();

  await client.query(
    `INSERT INTO users (id, organization_id, email, password_hash, status, updated_at)
     VALUES ($1::uuid, $2::uuid, $3, 'placeholder-not-a-credential', 'ACTIVE', now())`,
    [userId, organizationId, `member-${userId.slice(0, 8)}@example.test`],
  );

  return userId;
};

const insertMembership = async (
  client: PoolClient,
  projectId: string,
  userId: string,
  projectRole: 'LEAD' | 'MEMBER',
): Promise<void> => {
  await client.query(
    `INSERT INTO project_members (organization_id, project_id, user_id, project_role, updated_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, now())`,
    [ORG, projectId, userId, projectRole],
  );
};

/** Anna and Boris lead the project; Daria is in the organization and not on it. */
const seed = async (): Promise<Seeded> =>
  asMaintenance(pools.owner, async (client) => {
    const { ownerId } = await insertOrganizationWithOwner(client, ORG, {
      slug: `races-${ORG.slice(0, 8)}`,
    });
    const annaId = await insertUser(client, ORG);
    const borisId = await insertUser(client, ORG);
    const dariaId = await insertUser(client, ORG);
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO projects (organization_id, key, name, lead_id, color, updated_at)
       VALUES ($1::uuid, 'RACE', 'Race', $2::uuid, 'indigo', now())
       RETURNING id`,
      [ORG, annaId],
    );
    const projectId = rows[0]?.id ?? '';

    await insertMembership(client, projectId, annaId, 'LEAD');
    await insertMembership(client, projectId, borisId, 'LEAD');

    return { ownerId, annaId, borisId, dariaId, projectId };
  });

const owner = (): Actor => ({
  userId: seeded.ownerId,
  organizationId: ORG,
  isOwner: true,
  permissionsVersion: 1,
  permissions: new Set(),
  denied: new Set(),
  roleKeys: ['owner'],
});

const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};

/** The composition `buildProject` wires, over this suite's client and a recording trail. */
const useCases = () => {
  const unitOfWork = new PrismaUnitOfWork(prisma);
  const projects = new PrismaProjectRepository();
  const members = new PrismaProjectMemberRepository();
  const acl = new ResolveAclQuery({
    acl: new PrismaAclReader(),
    projects: new PrismaProjectAccessReader(),
    clock: { now: () => new Date() },
    logger: silentLogger,
  });

  return {
    remove: new RemoveProjectMemberUseCase(unitOfWork, projects, members, acl, audit),
    add: new AddProjectMemberUseCase(unitOfWork, projects, members, acl, audit),
    update: new UpdateProjectUseCase(unitOfWork, projects, members, acl, audit),
    del: new DeleteProjectUseCase(unitOfWork, projects, members, acl, audit),
  };
};

const removeLead = (userId: string): Promise<void> =>
  useCases().remove.execute({
    actor: owner(),
    ipAddress: ADDRESS,
    projectId: seeded.projectId,
    userId,
  });

const addDaria = (): Promise<void> =>
  useCases().add.execute({
    actor: owner(),
    ipAddress: ADDRESS,
    projectId: seeded.projectId,
    userId: seeded.dariaId,
    projectRole: 'MEMBER',
    allocationPct: 100,
  });

const rename = (name: string): Promise<void> =>
  useCases().update.execute({
    actor: owner(),
    ipAddress: ADDRESS,
    projectId: seeded.projectId,
    name,
    description: null,
    leadId: seeded.annaId,
    startedAt: null,
    dueAt: null,
    color: 'indigo',
  });

const deleteProject = (): Promise<void> =>
  useCases().del.execute({ actor: owner(), ipAddress: ADDRESS, projectId: seeded.projectId });

const liveLeads = (): Promise<string[]> =>
  asMaintenance(pools.owner, async (client) => {
    const { rows } = await client.query<{ user_id: string }>(
      `SELECT user_id FROM project_members
        WHERE project_id = $1::uuid AND project_role = 'LEAD' AND left_at IS NULL`,
      [seeded.projectId],
    );

    return rows.map((row) => row.user_id);
  });

const liveRowsOf = (userId: string): Promise<number> =>
  asMaintenance(pools.owner, async (client) => {
    const { rows } = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM project_members
        WHERE project_id = $1::uuid AND user_id = $2::uuid AND left_at IS NULL`,
      [seeded.projectId, userId],
    );

    return Number(rows[0]?.count ?? '0');
  });

const versionOf = (userId: string): Promise<number> =>
  asMaintenance(pools.owner, async (client) => {
    const { rows } = await client.query<{ permissions_version: number }>(
      `SELECT permissions_version FROM users WHERE id = $1::uuid`,
      [userId],
    );

    return rows[0]?.permissions_version ?? -1;
  });

const projectRow = (): Promise<{ name: string; deleted: boolean } | undefined> =>
  asMaintenance(pools.owner, async (client) => {
    const { rows } = await client.query<{ name: string; deleted_at: Date | null }>(
      `SELECT name, deleted_at FROM projects WHERE id = $1::uuid`,
      [seeded.projectId],
    );
    const row = rows[0];

    return row === undefined ? undefined : { name: row.name, deleted: row.deleted_at !== null };
  });

const actions = (): string[] => audit.events.map((event) => event.action);

const codeOf = (outcome: PromiseSettledResult<void>): string | undefined =>
  outcome.status === 'rejected' && outcome.reason instanceof AppError
    ? outcome.reason.code
    : undefined;

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
  audit = new FakeAuditLogger();
});

describe('two leads leaving one project at the same time', () => {
  it('CONTROL: one lead leaves, the other stays, and the trail and the bump say so', async () => {
    const before = await versionOf(seeded.annaId);

    await removeLead(seeded.annaId);

    await expect(liveLeads()).resolves.toEqual([seeded.borisId]);
    await expect(versionOf(seeded.annaId)).resolves.toBe(before + 1);
    expect(actions()).toEqual(['project.member_removed']);
  });

  it('lets exactly one go: the other is 409 last_project_lead_required and a lead remains', async () => {
    const outcomes = await Promise.allSettled([
      removeLead(seeded.annaId),
      removeLead(seeded.borisId),
    ]);

    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(outcomes.map(codeOf).filter(Boolean)).toEqual(['last_project_lead_required']);

    const remaining = await liveLeads();

    expect(remaining).toHaveLength(1);
    expect([seeded.annaId, seeded.borisId]).toContain(remaining[0]);
    // One removal filed, for the one that happened; the refusal is a conflict, not an entry.
    expect(actions()).toEqual(['project.member_removed']);
  });
});

describe('one person added to a project twice at the same time', () => {
  it('CONTROL: a single add seats the person once, bumps once and files once', async () => {
    const before = await versionOf(seeded.dariaId);

    await addDaria();

    await expect(liveRowsOf(seeded.dariaId)).resolves.toBe(1);
    await expect(versionOf(seeded.dariaId)).resolves.toBe(before + 1);
    expect(actions()).toEqual(['project.member_added']);
  });

  it('seats the person once: both callers answered, one row, one bump, one entry', async () => {
    const before = await versionOf(seeded.dariaId);

    const outcomes = await Promise.allSettled([addDaria(), addDaria()]);

    expect(outcomes.map((outcome) => outcome.status)).toEqual(['fulfilled', 'fulfilled']);
    await expect(liveRowsOf(seeded.dariaId)).resolves.toBe(1);
    // The second transaction read the seat the first one wrote and did nothing — not a second
    // bump for a right that was granted once.
    await expect(versionOf(seeded.dariaId)).resolves.toBe(before + 1);
    expect(actions()).toEqual(['project.member_added']);
  });
});

describe('one person put on two different projects at the same time', () => {
  /**
   * The project lock serializes nothing here — the two rows are different — so what the two
   * transactions contend for is the **person**: `subject()` reads the `users` row, and
   * `bumpPermissionsVersionOf` updates it. The same share-lock upgrade the project row was
   * measured for (`project-write-locks.test.ts`) would spring on `users` if `subject()` took
   * `FOR SHARE`: both transactions hold the share, each waits for the other's before its own
   * `UPDATE`, and PostgreSQL refuses one with `40P01` — a `500` for a request that was fine.
   * Under `FOR NO KEY UPDATE` the second `subject()` waits for the first commit, and both land.
   */
  let secondProjectId: string;

  beforeEach(async () => {
    secondProjectId = await asMaintenance(pools.owner, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO projects (organization_id, key, name, lead_id, color, updated_at)
         VALUES ($1::uuid, 'RACE2', 'Race 2', $2::uuid, 'indigo', now())
         RETURNING id`,
        [ORG, seeded.annaId],
      );
      const id = rows[0]?.id ?? '';

      await insertMembership(client, id, seeded.annaId, 'LEAD');

      return id;
    });
  });

  const addDariaTo = (projectId: string): Promise<void> =>
    useCases().add.execute({
      actor: owner(),
      ipAddress: ADDRESS,
      projectId,
      userId: seeded.dariaId,
      projectRole: 'MEMBER',
      allocationPct: 50,
    });

  const liveRowsOn = (projectId: string): Promise<number> =>
    asMaintenance(pools.owner, async (client) => {
      const { rows } = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM project_members
          WHERE project_id = $1::uuid AND user_id = $2::uuid AND left_at IS NULL`,
        [projectId, seeded.dariaId],
      );

      return Number(rows[0]?.count ?? '0');
    });

  it('CONTROL: one after the other, both seats are written and the person is bumped twice', async () => {
    const before = await versionOf(seeded.dariaId);

    await addDariaTo(seeded.projectId);
    await addDariaTo(secondProjectId);

    await expect(liveRowsOn(seeded.projectId)).resolves.toBe(1);
    await expect(liveRowsOn(secondProjectId)).resolves.toBe(1);
    await expect(versionOf(seeded.dariaId)).resolves.toBe(before + 2);
  });

  it('at the same time, both seats are written: no deadlock on the users row', async () => {
    const before = await versionOf(seeded.dariaId);

    const outcomes = await Promise.allSettled([
      addDariaTo(seeded.projectId),
      addDariaTo(secondProjectId),
    ]);

    expect(outcomes.map((outcome) => outcome.status)).toEqual(['fulfilled', 'fulfilled']);
    await expect(liveRowsOn(seeded.projectId)).resolves.toBe(1);
    await expect(liveRowsOn(secondProjectId)).resolves.toBe(1);
    await expect(versionOf(seeded.dariaId)).resolves.toBe(before + 2);
    expect(actions()).toEqual(['project.member_added', 'project.member_added']);
  });
});

describe('editing a project that is being deleted', () => {
  it('CONTROL: the edit lands on a live project and is filed', async () => {
    await rename('Renamed');

    await expect(projectRow()).resolves.toEqual({ name: 'Renamed', deleted: false });
    expect(actions()).toEqual(['project.updated']);
  });

  it('answers project_not_found after the deletion and files nothing for it', async () => {
    await deleteProject();

    await expect(rename('Too late')).rejects.toMatchObject({ code: 'project_not_found' });
    await expect(projectRow()).resolves.toEqual({ name: 'Race', deleted: true });
    expect(actions()).toEqual(['project.deleted']);
  });

  it('under a concurrent deletion, either lands first or is 404 — never on the hidden row', async () => {
    const [edit, deletion] = await Promise.allSettled([rename('Racing'), deleteProject()]);

    expect(deletion.status).toBe('fulfilled');

    const row = await projectRow();
    const observed = {
      deleted: row?.deleted,
      name: row?.name,
      code: codeOf(edit),
      actions: actions(),
    };

    // Which transaction took the lock first is the scheduler's choice; what each order must
    // produce is not. Edit first: the deletion read its write and hid the renamed project. Deletion
    // first: the edit read the flagged row and was refused as the same 404 a foreign id gets, with
    // no entry for a change that did not happen.
    expect(observed).toEqual(
      edit.status === 'fulfilled'
        ? {
            deleted: true,
            name: 'Racing',
            code: undefined,
            actions: ['project.updated', 'project.deleted'],
          }
        : { deleted: true, name: 'Race', code: 'project_not_found', actions: ['project.deleted'] },
    );
  });
});
