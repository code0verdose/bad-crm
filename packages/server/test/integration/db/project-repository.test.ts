import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { type PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { type ProjectRole } from '@/domain/project/project.enums.js';
import { ConflictError } from '@/domain/shared/errors/app.errors.js';
import { PrismaProjectMemberRepository } from '@/infrastructure/persistence/prisma/project-member.repository.js';
import { PrismaProjectRepository } from '@/infrastructure/persistence/prisma/project.repository.js';
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
 * Projects and their membership against a real PostgreSQL — STORY-014-01 / STORY-014-02, the
 * persistence half.
 *
 * What only the database can decide, and what a recorder therefore cannot prove:
 *
 * 1. **`uq_projects_org_key` is partial and scoped to the organization.** Two organizations may both
 *    own `BAD`; one organization may reuse a key it freed by deleting the project. Prisma models no
 *    partial index, so the constraint exists only in the migration.
 * 2. **`uq_project_members` is partial on `left_at IS NULL`.** A person who left can be brought back
 *    as a *new* row, and `ON CONFLICT (project_id, user_id) WHERE left_at IS NULL` has to be
 *    accepted by the parser — the spelling without the predicate fails on every call.
 * 3. **The `CHECK` constraints hold the closed lists.** `status`, `visibility`, `project_role`, the
 *    key format and the allocation range are refused by the database, not only by a validator that
 *    a raw statement can bypass.
 * 4. **The locks serialize.** Two concurrent adds of one pair leave one row; two concurrent removals
 *    of two leads, each of which read «two leads» before acting, cannot both proceed once `leads()`
 *    holds `FOR UPDATE`.
 *
 * Every describe opens with a `CONTROL:` case, per `rules/testing.mdc`, 4.
 */

let pools: HarnessPools;
let prisma: PrismaClient;

const ORG = randomUUID();
const OTHER_ORG = randomUUID();

/** `check_violation` — the SQLSTATE every `CHECK` refusal answers with. */
const CHECK_VIOLATION = '23514';

/** `foreign_key_violation` — what a composite key answers to a parent of another organization. */
const FK_VIOLATION = '23503';

interface Seeded {
  readonly ownerId: string;
  readonly ivanId: string;
  readonly petrId: string;
  readonly suspendedId: string;
  readonly projectId: string;
  /** A second live project of this organization, so a delete has a sibling to leave alone. */
  readonly siblingProjectId: string;
  /** A project of the other organization, addressed to prove this tenant cannot see it. */
  readonly foreignProjectId: string;
  readonly foreignUserId: string;
}

let seeded: Seeded;

const insertUser = async (
  client: PoolClient,
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

const insertProject = async (
  client: PoolClient,
  organizationId: string,
  key: string,
  leadId: string,
): Promise<string> => {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO projects (organization_id, key, name, lead_id, color, updated_at)
     VALUES ($1::uuid, $2, $2, $3::uuid, 'indigo', now())
     RETURNING id`,
    [organizationId, key, leadId],
  );

  return rows[0]?.id ?? '';
};

const seed = async (): Promise<Seeded> =>
  asMaintenance(pools.owner, async (client) => {
    const { ownerId } = await insertOrganizationWithOwner(client, ORG, {
      slug: `projects-${ORG.slice(0, 8)}`,
    });
    const { ownerId: foreignOwnerId } = await insertOrganizationWithOwner(client, OTHER_ORG, {
      slug: `other-${OTHER_ORG.slice(0, 8)}`,
    });

    return {
      ownerId,
      ivanId: await insertUser(client, ORG, 'ACTIVE'),
      petrId: await insertUser(client, ORG, 'ACTIVE'),
      suspendedId: await insertUser(client, ORG, 'SUSPENDED'),
      projectId: await insertProject(client, ORG, 'BAD', ownerId),
      siblingProjectId: await insertProject(client, ORG, 'CRM', ownerId),
      // `BAD` is left free in the other organization so the control below can take it **through
      // `app_user`** rather than through the migrator.
      foreignProjectId: await insertProject(client, OTHER_ORG, 'THEIRS', foreignOwnerId),
      foreignUserId: foreignOwnerId,
    };
  });

const inTenant = <T>(
  work: (repository: PrismaProjectRepository) => Promise<T>,
  organizationId = ORG,
): Promise<T> =>
  withTenant(prisma, { organizationId, userId: null }, () => work(new PrismaProjectRepository()));

const members = <T>(
  work: (repository: PrismaProjectMemberRepository) => Promise<T>,
  organizationId = ORG,
): Promise<T> =>
  withTenant(prisma, { organizationId, userId: null }, () =>
    work(new PrismaProjectMemberRepository()),
  );

const draft = (key: string, leadId: string) => ({
  key,
  name: key,
  description: null,
  visibility: 'PUBLIC_ORG' as const,
  leadId,
  startedAt: null,
  dueAt: null,
  color: 'indigo',
});

const liveMembershipCount = async (projectId: string): Promise<number> =>
  asMaintenance(pools.owner, async (client) => {
    const { rows } = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM project_members
        WHERE project_id = $1::uuid AND left_at IS NULL`,
      [projectId],
    );

    return Number(rows[0]?.count ?? '-1');
  });

const liveLeadCount = async (projectId: string): Promise<number> =>
  asMaintenance(pools.owner, async (client) => {
    const { rows } = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM project_members
        WHERE project_id = $1::uuid AND left_at IS NULL AND project_role = 'LEAD'`,
      [projectId],
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

describe('the key is unique inside the organization', () => {
  it('CONTROL: a free key is accepted', async () => {
    const projectId = await inTenant((repository) =>
      repository.create(draft('OPS', seeded.ivanId)),
    );

    expect(projectId).toEqual(expect.any(String));
  });

  it('refuses a key another live project of this organization already uses', async () => {
    await expect(
      inTenant((repository) => repository.create(draft('BAD', seeded.ivanId))),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('CONTROL: allows the same key in another organization', async () => {
    const projectId = await inTenant(
      (repository) => repository.create(draft('BAD', seeded.foreignUserId)),
      OTHER_ORG,
    );

    expect(projectId).toEqual(expect.any(String));
  });

  it('CONTROL: allows a key freed by deleting the project that held it', async () => {
    await expect(inTenant((repository) => repository.softDelete(seeded.projectId))).resolves.toBe(
      true,
    );

    const projectId = await inTenant((repository) =>
      repository.create(draft('BAD', seeded.ivanId)),
    );

    expect(projectId).toEqual(expect.any(String));
  });
});

describe('the closed lists are held by the database', () => {
  /**
   * Through `pg` as `app_user`, not through Prisma: a `CHECK` refusal arrives from the model client
   * as an *unknown* request error with the SQLSTATE buried in its message, while `pg` reports it as
   * `code`. The constraint is the subject, not the client's error taxonomy.
   */
  const rawInsert = (
    columns: string,
    values: string,
    params: unknown[],
    key = 'NEW',
  ): Promise<unknown> =>
    asTenant(pools.app, ORG, (client) =>
      client.query(
        `INSERT INTO projects (organization_id, key, name, lead_id, color, updated_at${columns})
         VALUES ($1::uuid, $2, 'New', $3::uuid, 'indigo', now()${values})`,
        [ORG, key, seeded.ivanId, ...params],
      ),
    );

  it('CONTROL: every value of the lists is accepted', async () => {
    await expect(
      rawInsert(', status, visibility', ', $4, $5', ['ON_HOLD', 'PRIVATE']),
    ).resolves.toBeDefined();
  });

  it.each(['DELETED', 'active', ''])('refuses status %j', async (status) => {
    await expect(rawInsert(', status', ', $4', [status])).rejects.toMatchObject({
      code: CHECK_VIOLATION,
    });
  });

  it.each(['PUBLIC', 'private'])('refuses visibility %j', async (visibility) => {
    await expect(rawInsert(', visibility', ', $4', [visibility])).rejects.toMatchObject({
      code: CHECK_VIOLATION,
    });
  });

  /**
   * The key is stored normalized — upper-case, no whitespace — and the database refuses anything
   * else, so the normalization the value object performs cannot be skipped by a raw write.
   */
  it.each(['bad', ' BAD', 'B', '1AB', 'ABCDEFGHIJK', 'BA-D'])(
    'refuses a key that is not in its normalized form: %j',
    async (key) => {
      await expect(rawInsert('', '', [], key)).rejects.toMatchObject({ code: CHECK_VIOLATION });
    },
  );

  it('refuses a task counter below zero', async () => {
    await expect(rawInsert(', task_counter', ', $4', [-1])).rejects.toMatchObject({
      code: CHECK_VIOLATION,
    });
  });
});

describe('the lead is an account of the same organization', () => {
  it('refuses a lead of another organization: the composite key names the tenant', async () => {
    const attempt = asTenant(pools.app, ORG, (client) =>
      client.query(
        `INSERT INTO projects (organization_id, key, name, lead_id, color, updated_at)
         VALUES ($1::uuid, 'OPS', 'Ops', $2::uuid, 'indigo', now())`,
        [ORG, seeded.foreignUserId],
      ),
    );

    await expect(attempt).rejects.toMatchObject({ code: FK_VIOLATION });
  });
});

describe('reading a project', () => {
  it('CONTROL: the tenant sees its own project, flagged live', async () => {
    await expect(
      inTenant((repository) => repository.detail(seeded.projectId)),
    ).resolves.toMatchObject({ key: 'BAD', isDeleted: false, memberCount: 0 });
  });

  it('answers null for a project of another organization', async () => {
    await expect(
      inTenant((repository) => repository.scope(seeded.foreignProjectId)),
    ).resolves.toBeNull();
    await expect(
      inTenant((repository) => repository.detail(seeded.foreignProjectId)),
    ).resolves.toBeNull();
  });

  it('returns a deleted project flagged rather than hidden', async () => {
    await inTenant((repository) => repository.softDelete(seeded.projectId));

    await expect(
      inTenant((repository) => repository.scope(seeded.projectId)),
    ).resolves.toMatchObject({ isDeleted: true, visibility: 'PUBLIC_ORG' });
  });

  it('leaves a deleted project out of the list, and only that one', async () => {
    await inTenant((repository) => repository.softDelete(seeded.projectId));

    await expect(inTenant((repository) => repository.list())).resolves.toEqual([
      expect.objectContaining({ projectId: seeded.siblingProjectId }),
    ]);
  });

  it('counts live members only', async () => {
    await members((repository) => repository.add(seeded.projectId, seeded.ivanId, 'MEMBER', 50));
    await members((repository) => repository.add(seeded.projectId, seeded.petrId, 'MEMBER', 50));
    await members((repository) => repository.leave(seeded.projectId, seeded.petrId));

    await expect(inTenant((repository) => repository.list())).resolves.toEqual([
      expect.objectContaining({ key: 'BAD', memberCount: 1 }),
      expect.objectContaining({ key: 'CRM', memberCount: 0 }),
    ]);
  });
});

describe('writing a project', () => {
  it('CONTROL: a live project is updated', async () => {
    await expect(
      inTenant((repository) =>
        repository.update(seeded.projectId, {
          name: 'Bad CRM',
          description: null,
          leadId: seeded.ivanId,
          startedAt: null,
          dueAt: null,
          color: 'teal',
        }),
      ),
    ).resolves.toBe(true);
  });

  it('does not update a deleted project', async () => {
    await inTenant((repository) => repository.softDelete(seeded.projectId));

    await expect(
      inTenant((repository) => repository.changeVisibility(seeded.projectId, 'PRIVATE')),
    ).resolves.toBe(false);
  });

  it('does not reach a project of another organization', async () => {
    await expect(
      inTenant((repository) => repository.changeStatus(seeded.foreignProjectId, 'ARCHIVED')),
    ).resolves.toBe(false);
    await expect(
      inTenant((repository) => repository.softDelete(seeded.foreignProjectId)),
    ).resolves.toBe(false);
  });

  it('deletes once: the second deletion has nothing left to delete', async () => {
    await expect(inTenant((repository) => repository.softDelete(seeded.projectId))).resolves.toBe(
      true,
    );
    await expect(inTenant((repository) => repository.softDelete(seeded.projectId))).resolves.toBe(
      false,
    );
  });
});

describe('membership', () => {
  it('CONTROL: writes a membership and reads it back', async () => {
    await expect(
      members((repository) => repository.add(seeded.projectId, seeded.ivanId, 'REVIEWER', 30)),
    ).resolves.toBe(true);

    await expect(
      members((repository) => repository.membershipOf(seeded.projectId, seeded.ivanId)),
    ).resolves.toEqual({ projectRole: 'REVIEWER', allocationPct: 30 });
    await expect(members((repository) => repository.roster(seeded.projectId))).resolves.toEqual([
      expect.objectContaining({ userId: seeded.ivanId, projectRole: 'REVIEWER', leftAt: null }),
    ]);
  });

  it('adds the same pair once: the second add is a no-op reported as false', async () => {
    await members((repository) => repository.add(seeded.projectId, seeded.ivanId, 'MEMBER', 50));

    await expect(
      members((repository) => repository.add(seeded.projectId, seeded.ivanId, 'LEAD', 100)),
    ).resolves.toBe(false);

    expect(await liveMembershipCount(seeded.projectId)).toBe(1);
    // The role of the existing row is untouched: promotion is `update`, never a second `add`.
    await expect(
      members((repository) => repository.membershipOf(seeded.projectId, seeded.ivanId)),
    ).resolves.toMatchObject({ projectRole: 'MEMBER' });
  });

  it('ends a membership by left_at and lets the person come back as a new row', async () => {
    await members((repository) => repository.add(seeded.projectId, seeded.ivanId, 'MEMBER', 50));

    await expect(
      members((repository) => repository.leave(seeded.projectId, seeded.ivanId)),
    ).resolves.toBe(true);
    await expect(
      members((repository) => repository.leave(seeded.projectId, seeded.ivanId)),
    ).resolves.toBe(false);
    await expect(
      members((repository) => repository.membershipOf(seeded.projectId, seeded.ivanId)),
    ).resolves.toBeNull();

    // The row is history, not gone: the roster shows it on request …
    await expect(
      members((repository) => repository.roster(seeded.projectId, { includeLeft: true })),
    ).resolves.toEqual([expect.objectContaining({ leftAt: expect.any(Date) })]);

    // … and the partial index lets the same person join again.
    await expect(
      members((repository) => repository.add(seeded.projectId, seeded.ivanId, 'OBSERVER', 0)),
    ).resolves.toBe(true);
    expect(await liveMembershipCount(seeded.projectId)).toBe(1);
  });

  it('changes role and allocation of the live row and reports when there is none', async () => {
    await members((repository) => repository.add(seeded.projectId, seeded.ivanId, 'MEMBER', 50));

    await expect(
      members((repository) =>
        repository.update(seeded.projectId, seeded.ivanId, { projectRole: 'LEAD' }),
      ),
    ).resolves.toBe(true);
    await expect(
      members((repository) => repository.membershipOf(seeded.projectId, seeded.ivanId)),
    ).resolves.toEqual({ projectRole: 'LEAD', allocationPct: 50 });

    await members((repository) => repository.leave(seeded.projectId, seeded.ivanId));
    await expect(
      members((repository) =>
        repository.update(seeded.projectId, seeded.ivanId, { allocationPct: 10 }),
      ),
    ).resolves.toBe(false);
  });

  it.each(['ADMIN', 'lead', ''])('refuses project role %j', async (projectRole) => {
    // Past the port's type on purpose: the subject is `ck_project_members_role`, the database's
    // own copy of the closed list, which a raw statement can reach without the compiler.
    await expect(
      members((repository) =>
        repository.add(seeded.projectId, seeded.ivanId, projectRole as ProjectRole, 50),
      ),
    ).rejects.toMatchObject({ meta: { code: CHECK_VIOLATION } });
  });

  it.each([-1, 101])('refuses allocation %i', async (allocationPct) => {
    await expect(
      members((repository) =>
        repository.add(seeded.projectId, seeded.ivanId, 'MEMBER', allocationPct),
      ),
    ).rejects.toMatchObject({ meta: { code: CHECK_VIOLATION } });
  });

  it('refuses a member of another organization: the composite key names the tenant', async () => {
    await expect(
      members((repository) => repository.add(seeded.projectId, seeded.foreignUserId, 'MEMBER', 50)),
    ).rejects.toMatchObject({ meta: { code: FK_VIOLATION } });
  });

  it('refuses a membership on a project of another organization', async () => {
    await expect(
      members((repository) => repository.add(seeded.foreignProjectId, seeded.ivanId, 'MEMBER', 50)),
    ).rejects.toMatchObject({ meta: { code: FK_VIOLATION } });
  });

  it('reads the subject with its status, and not one of another organization', async () => {
    await expect(members((repository) => repository.subject(seeded.suspendedId))).resolves.toEqual({
      userId: seeded.suspendedId,
      status: 'SUSPENDED',
    });
    await expect(
      members((repository) => repository.subject(seeded.foreignUserId)),
    ).resolves.toBeNull();
  });
});

describe('two requests race', () => {
  /**
   * Two transactions add the same pair without awaiting in between, so they genuinely run on two
   * connections. The partial unique index plus `ON CONFLICT … DO NOTHING` is what makes the outcome
   * deterministic: exactly one row, exactly one `true`, and no error on either side.
   */
  it('adding one person twice at once leaves one membership and one creation', async () => {
    const outcomes = await Promise.all([
      members((repository) => repository.add(seeded.projectId, seeded.ivanId, 'MEMBER', 50)),
      members((repository) => repository.add(seeded.projectId, seeded.ivanId, 'MEMBER', 50)),
    ]);

    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect(await liveMembershipCount(seeded.projectId)).toBe(1);
  });

  /**
   * The DB half of «the last lead cannot leave». Each transaction reads the live leads, and leaves
   * one of them only if there is more than one — the shape the use-case will have. Without
   * `FOR UPDATE` on that read both transactions count two and both proceed, and the project ends
   * with no lead at all. With it, the second waits for the first, re-evaluates the predicate on the
   * updated row version (`READ COMMITTED` does that on a locked row), finds one live lead, and stops.
   */
  it('two removals of two leads cannot both proceed: at least one lead survives', async () => {
    await members((repository) => repository.add(seeded.projectId, seeded.ivanId, 'LEAD', 100));
    await members((repository) => repository.add(seeded.projectId, seeded.petrId, 'LEAD', 100));

    const removeUnlessLast = (userId: string): Promise<boolean> =>
      members(async (repository) => {
        const leads = await repository.leads(seeded.projectId);

        if (leads.length < 2) return false;

        return repository.leave(seeded.projectId, userId);
      });

    const outcomes = await Promise.all([
      removeUnlessLast(seeded.ivanId),
      removeUnlessLast(seeded.petrId),
    ]);

    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect(await liveLeadCount(seeded.projectId)).toBe(1);
  });
});
