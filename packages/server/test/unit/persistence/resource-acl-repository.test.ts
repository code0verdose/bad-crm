import { describe, expect, it } from 'vitest';

import { PrismaResourceAclRepository } from '@/infrastructure/persistence/prisma/resource-acl.repository.js';
import { withTenant } from '@/infrastructure/persistence/prisma/tenant.context.js';

/**
 * The grants repository with the driver replaced by a recorder — the shape of each statement, not
 * the database's answer to it (that is `resource-acl-reader.test.ts`, on a real PostgreSQL).
 *
 * What is held here: every read and write carries the tenant of the scope; the upsert is keyed by
 * the unique quadruple and rewrites the grantor; the subject queries look at **live** rows only;
 * the version bump is one statement over an array and is skipped for nobody.
 */

const ORG = '018f4a3b-0000-7000-8000-0000000000a1';
const IVAN = '018f4a3b-0000-7000-8000-0000000000c1';
const PETR = '018f4a3b-0000-7000-8000-0000000000c2';
const PROJECT = '018f4a3b-0000-7000-8000-0000000000d1';
const TEAM = '018f4a3b-0000-7000-8000-0000000000e1';
const ROW = '018f4a3b-0000-7000-8000-0000000000f1';

interface Call {
  readonly name: string;
  readonly args: Record<string, unknown>;
}

/** What `DELETE … RETURNING` hands back, in the column names of the table. */
interface RemovedRow {
  readonly id: string;
  readonly resource_type: string;
  readonly resource_id: string;
  readonly access_level: string;
  readonly expires_at: Date | null;
  readonly granted_by_id: string | null;
}

interface Recorder {
  readonly calls: Call[];
  readonly raw: { sql: string; values: unknown[] }[];
  readonly base: Parameters<typeof withTenant>[0];
}

const recordingClient = (
  answers: {
    found?: {
      id: string;
      accessLevel: string;
      expiresAt: Date | null;
      grantedById: string | null;
    } | null;
    byId?: {
      id: string;
      resourceType: string;
      resourceId: string;
      subjectType: string;
      subjectId: string;
      accessLevel: string;
      expiresAt: Date | null;
      grantedById: string | null;
    } | null;
    many?: {
      id: string;
      subjectType: string;
      subjectId: string;
      accessLevel: string;
      expiresAt: Date | null;
      grantedById: string | null;
      grantedAt: Date;
    }[];
    deleted?: number;
    counts?: { user?: number };
    userRoles?: { userId: string }[];
    teamMembers?: { userId: string }[];
    removedRows?: RemovedRow[];
    /** What a `SELECT … FOR [KEY] SHARE` of the subject row finds. */
    locked?: { id?: string; deleted_at?: Date | null }[];
  } = {},
): Recorder => {
  const calls: Call[] = [];
  const raw: { sql: string; values: unknown[] }[] = [];
  const record =
    <T>(name: string, result: T) =>
    (args: Record<string, unknown> = {}): Promise<T> => {
      calls.push({ name, args });

      return Promise.resolve(result);
    };

  const tx = {
    // `withTenant` pins the scope with two `set_config` statements of its own; they are the scope,
    // not the repository, and are left out so the assertions count only what the method sent.
    $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]): Promise<number> => {
      const sql = strings.join('?');

      if (!sql.includes('set_config')) raw.push({ sql, values });

      return Promise.resolve(values.length);
    },
    $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
      const sql = strings.join('?');

      raw.push({ sql, values });

      // A locking read answers the subject row; anything else here is the cascade's `DELETE`.
      return Promise.resolve(
        /\bFOR (KEY )?SHARE\b/.test(sql) ? (answers.locked ?? []) : (answers.removedRows ?? []),
      );
    },
    resourceAcl: {
      findFirst: record(
        'resourceAcl.findFirst',
        answers.byId === undefined ? (answers.found ?? null) : answers.byId,
      ),
      findMany: record('resourceAcl.findMany', answers.many ?? []),
      upsert: record('resourceAcl.upsert', { id: ROW }),
      deleteMany: record('resourceAcl.deleteMany', { count: answers.deleted ?? 0 }),
    },
    user: { count: record('user.count', answers.counts?.user ?? 0) },
    userRole: { findMany: record('userRole.findMany', answers.userRoles ?? []) },
    teamMember: { findMany: record('teamMember.findMany', answers.teamMembers ?? []) },
  };

  return {
    calls,
    raw,
    base: {
      $transaction: (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
    } as unknown as Parameters<typeof withTenant>[0],
  };
};

const inTenant = <T>(
  recorder: Recorder,
  work: (repository: PrismaResourceAclRepository) => Promise<T>,
): Promise<T> =>
  withTenant(recorder.base, { organizationId: ORG, userId: null }, () =>
    work(new PrismaResourceAclRepository()),
  );

const resource = { type: 'PROJECT' as const, id: PROJECT };
const team = { type: 'TEAM' as const, id: TEAM };

describe('PrismaResourceAclRepository', () => {
  it('finds one grant by the whole quadruple inside the tenant, and shapes it as a row', async () => {
    const recorder = recordingClient({
      found: { id: ROW, accessLevel: 'EDITOR', expiresAt: null, grantedById: PETR },
    });

    await expect(inTenant(recorder, (repo) => repo.find(resource, team))).resolves.toEqual({
      id: ROW,
      resource,
      subject: team,
      level: 'EDITOR',
      expiresAt: null,
      grantedById: PETR,
    });
    expect(recorder.calls[0]?.args['where']).toEqual({
      organizationId: ORG,
      resourceType: 'PROJECT',
      resourceId: PROJECT,
      subjectType: 'TEAM',
      subjectId: TEAM,
    });
  });

  it('answers null when there is no such grant', async () => {
    await expect(
      inTenant(recordingClient(), (repo) => repo.find(resource, team)),
    ).resolves.toBeNull();
  });

  it('finds one grant by its id inside the tenant, with the object and the subject it names', async () => {
    const recorder = recordingClient({
      byId: {
        id: ROW,
        resourceType: 'PROJECT',
        resourceId: PROJECT,
        subjectType: 'TEAM',
        subjectId: TEAM,
        accessLevel: 'MANAGER',
        expiresAt: null,
        grantedById: PETR,
      },
    });

    await expect(inTenant(recorder, (repo) => repo.findById(ROW))).resolves.toEqual({
      id: ROW,
      resource,
      subject: team,
      level: 'MANAGER',
      expiresAt: null,
      grantedById: PETR,
    });
    // The tenant is pinned in the statement, not only by the policy under it: RLS alone would
    // answer the same `null` for another organization's id and hide a missing predicate.
    expect(recorder.calls).toEqual([
      {
        name: 'resourceAcl.findFirst',
        args: {
          where: { organizationId: ORG, id: ROW },
          select: {
            id: true,
            resourceType: true,
            resourceId: true,
            subjectType: true,
            subjectId: true,
            accessLevel: true,
            expiresAt: true,
            grantedById: true,
          },
        },
      },
    ]);
  });

  it('answers null for an id that names no grant here', async () => {
    await expect(
      inTenant(recordingClient({ byId: null }), (repo) => repo.findById(ROW)),
    ).resolves.toBeNull();
  });

  it('lists the grants live at the given instant on this object only, oldest first with the id as tie-breaker', async () => {
    const now = new Date('2026-09-20T10:00:00.000Z');
    const grantedAt = new Date('2026-09-06T12:00:00.000Z');
    const recorder = recordingClient({
      many: [
        {
          id: ROW,
          subjectType: 'USER',
          subjectId: PETR,
          accessLevel: 'VIEWER',
          expiresAt: null,
          grantedById: IVAN,
          grantedAt,
        },
      ],
    });

    await expect(inTenant(recorder, (repo) => repo.listOn(resource, now))).resolves.toEqual([
      {
        id: ROW,
        resource,
        subject: { type: 'USER', id: PETR },
        level: 'VIEWER',
        expiresAt: null,
        grantedById: IVAN,
        grantedAt,
      },
    ]);
    expect(recorder.calls).toEqual([
      {
        name: 'resourceAcl.findMany',
        args: {
          where: {
            organizationId: ORG,
            resourceType: 'PROJECT',
            resourceId: PROJECT,
            OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
          },
          orderBy: [{ grantedAt: 'asc' }, { id: 'asc' }],
          select: {
            id: true,
            subjectType: true,
            subjectId: true,
            accessLevel: true,
            expiresAt: true,
            grantedById: true,
            grantedAt: true,
          },
        },
      },
    ]);
  });

  it('upserts on the unique quadruple, writes the tenant, and rewrites the grantor on replace', async () => {
    const recorder = recordingClient();
    const expiresAt = new Date('2026-12-31T00:00:00Z');

    await expect(
      inTenant(recorder, (repo) =>
        repo.upsert({ resource, subject: team, level: 'EDITOR', expiresAt, grantedById: IVAN }),
      ),
    ).resolves.toBe(ROW);

    const args = recorder.calls[0]?.args ?? {};

    expect(args['where']).toEqual({
      organizationId_resourceId_resourceType_subjectId_subjectType: {
        organizationId: ORG,
        resourceId: PROJECT,
        resourceType: 'PROJECT',
        subjectId: TEAM,
        subjectType: 'TEAM',
      },
    });
    expect(args['create']).toEqual({
      organizationId: ORG,
      resourceType: 'PROJECT',
      resourceId: PROJECT,
      subjectType: 'TEAM',
      subjectId: TEAM,
      accessLevel: 'EDITOR',
      expiresAt,
      grantedById: IVAN,
    });
    expect(args['update']).toEqual({
      accessLevel: 'EDITOR',
      expiresAt,
      grantedById: IVAN,
      grantedAt: expect.any(Date),
    });
  });

  it('removes by the quadruple inside the tenant and reports whether a row went', async () => {
    const gone = recordingClient({ deleted: 1 });
    const nothing = recordingClient({ deleted: 0 });

    await expect(inTenant(gone, (repo) => repo.remove(resource, team))).resolves.toBe(true);
    await expect(inTenant(nothing, (repo) => repo.remove(resource, team))).resolves.toBe(false);
    expect(gone.calls[0]?.args['where']).toMatchObject({ organizationId: ORG, subjectId: TEAM });
  });

  /**
   * The cascade of STORY-011-06 acceptance 13 and STORY-012-07 acceptance 5: a role or a team that
   * stops existing takes its grants with it. One statement that deletes and reports — a read then a
   * `deleteMany` would let a grant committed in between go without its `acl.revoked` entry.
   */
  describe('removeAllOfSubject — every grant one subject holds', () => {
    it('deletes in one statement, keyed by the tenant and the subject, and returns what went', async () => {
      const recorder = recordingClient({
        removedRows: [
          {
            id: ROW,
            resource_type: 'PROJECT',
            resource_id: PROJECT,
            access_level: 'EDITOR',
            expires_at: null,
            granted_by_id: PETR,
          },
        ],
      });

      await expect(inTenant(recorder, (repo) => repo.removeAllOfSubject(team))).resolves.toEqual([
        {
          id: ROW,
          resource,
          subject: team,
          level: 'EDITOR',
          expiresAt: null,
          grantedById: PETR,
        },
      ]);
      expect(recorder.raw).toHaveLength(1);
      expect(recorder.raw[0]?.sql).toMatch(/^\s*DELETE FROM resource_acl\s/);
      expect(recorder.raw[0]?.sql).toMatch(
        /WHERE organization_id = \?::uuid\s+AND subject_id = \?::uuid\s+AND subject_type = \?::acl_subject_type\s+RETURNING /,
      );
      // The tenant first, then exactly this subject — a statement that lost the type would take a
      // user's grants along with a role that happened to share nothing but the uuid space.
      expect(recorder.raw[0]?.values).toEqual([ORG, TEAM, 'TEAM']);
      // Nothing through the typed client: `deleteMany` cannot say what it removed.
      expect(recorder.calls).toEqual([]);
    });

    it('answers an empty list for a subject with no grants', async () => {
      await expect(
        inTenant(recordingClient(), (repo) => repo.removeAllOfSubject({ type: 'ROLE', id: TEAM })),
      ).resolves.toEqual([]);
    });
  });

  describe('subjectExists — a live thing of this organization, under a lock', () => {
    it('asks for a user that is not soft-deleted, with a plain count', async () => {
      const recorder = recordingClient({ counts: { user: 1 } });

      await expect(
        inTenant(recorder, (repo) => repo.subjectExists({ type: 'USER', id: PETR })),
      ).resolves.toBe(true);
      expect(recorder.calls[0]).toEqual({
        name: 'user.count',
        args: { where: { organizationId: ORG, id: PETR, deletedAt: null } },
      });
      expect(recorder.raw).toEqual([]);
    });

    /**
     * The gate's M-1: the role row is read `FOR KEY SHARE` — the lock `DeleteCustomRoleUseCase`'s
     * `FOR UPDATE` conflicts with — inside the tenant. The race itself is measured on PostgreSQL
     * (`acl-subject-cascade.test.ts`); what a recorder can hold is the statement's shape.
     */
    it('reads a role of this organization FOR KEY SHARE, and answers whether a row came back', async () => {
      const found = recordingClient({ locked: [{ id: TEAM }] });
      const gone = recordingClient({ locked: [] });

      await expect(
        inTenant(found, (repo) => repo.subjectExists({ type: 'ROLE', id: TEAM })),
      ).resolves.toBe(true);
      await expect(
        inTenant(gone, (repo) => repo.subjectExists({ type: 'ROLE', id: TEAM })),
      ).resolves.toBe(false);
      expect(found.raw[0]?.sql).toMatch(
        /SELECT id FROM roles\s+WHERE organization_id = \?::uuid\s+AND id = \?::uuid\s+FOR KEY SHARE\s*$/,
      );
      expect(found.raw[0]?.values).toEqual([ORG, TEAM]);
      expect(found.calls).toEqual([]);
    });

    /**
     * `FOR SHARE`, not `FOR KEY SHARE`: disbanding rewrites `deleted_at`, a non-key column, and only
     * the stronger mode conflicts with that `UPDATE`. `deleted_at` is read from the locked row — the
     * value a waiting reader gets once the disbanding committed.
     */
    it('reads a team FOR SHARE and counts a disbanded one as absent', async () => {
      const live = recordingClient({ locked: [{ deleted_at: null }] });
      const disbanded = recordingClient({
        locked: [{ deleted_at: new Date('2026-09-26T00:00:00Z') }],
      });
      const none = recordingClient({ locked: [] });

      await expect(inTenant(live, (repo) => repo.subjectExists(team))).resolves.toBe(true);
      await expect(inTenant(disbanded, (repo) => repo.subjectExists(team))).resolves.toBe(false);
      await expect(inTenant(none, (repo) => repo.subjectExists(team))).resolves.toBe(false);
      expect(live.raw[0]?.sql).toMatch(
        /SELECT deleted_at FROM teams\s+WHERE organization_id = \?::uuid\s+AND id = \?::uuid\s+FOR SHARE\s*$/,
      );
      expect(live.raw[0]?.values).toEqual([ORG, TEAM]);
      expect(live.calls).toEqual([]);
    });
  });

  describe('subjectUserIds — whom a grant reaches', () => {
    it('is the person for a USER, and nobody for a person who is not here', async () => {
      await expect(
        inTenant(recordingClient({ counts: { user: 1 } }), (repo) =>
          repo.subjectUserIds({ type: 'USER', id: PETR }),
        ),
      ).resolves.toEqual([PETR]);
      await expect(
        inTenant(recordingClient({ counts: { user: 0 } }), (repo) =>
          repo.subjectUserIds({ type: 'USER', id: PETR }),
        ),
      ).resolves.toEqual([]);
    });

    it('is every holder of a ROLE, read inside the tenant', async () => {
      const recorder = recordingClient({ userRoles: [{ userId: IVAN }, { userId: PETR }] });

      await expect(
        inTenant(recorder, (repo) => repo.subjectUserIds({ type: 'ROLE', id: TEAM })),
      ).resolves.toEqual([IVAN, PETR]);
      expect(recorder.calls[0]?.args['where']).toEqual({ organizationId: ORG, roleId: TEAM });
    });

    it('is every member of a TEAM, read inside the tenant', async () => {
      const recorder = recordingClient({ teamMembers: [{ userId: PETR }] });

      await expect(inTenant(recorder, (repo) => repo.subjectUserIds(team))).resolves.toEqual([
        PETR,
      ]);
      expect(recorder.calls[0]?.args['where']).toEqual({ organizationId: ORG, teamId: TEAM });
    });
  });

  describe('bumpPermissionsVersionOf', () => {
    it('is one statement over the array, scoped to the tenant', async () => {
      const recorder = recordingClient();

      await inTenant(recorder, (repo) => repo.bumpPermissionsVersionOf([IVAN, PETR]));

      expect(recorder.raw).toHaveLength(1);
      expect(recorder.raw[0]?.sql).toContain('permissions_version = permissions_version + 1');
      expect(recorder.raw[0]?.values).toEqual([ORG, [IVAN, PETR]]);
    });

    it('sends nothing for nobody', async () => {
      const recorder = recordingClient();

      await inTenant(recorder, (repo) => repo.bumpPermissionsVersionOf([]));

      expect(recorder.raw).toEqual([]);
    });
  });

  it('refuses to run outside a tenant scope', async () => {
    await expect(new PrismaResourceAclRepository().find(resource, team)).rejects.toThrow(
      /ResourceAclRepository\.find/,
    );
  });
});
