import { afterEach, describe, expect, it, vi } from 'vitest';

import { PrismaCustomRoleRepository } from '@/infrastructure/persistence/prisma/custom-role.repository.js';
import { withTenant } from '@/infrastructure/persistence/prisma/tenant.context.js';

/**
 * Custom roles through Prisma, with the driver replaced by a recorder.
 *
 * The arguments are the subject, as in the neighbouring repository tests: a live database shows that
 * a statement was accepted, never which decision produced it. Three of those decisions are invisible
 * in an integration run and expensive when wrong:
 *
 *   * **grants are replaced, never merged** — a permission the draft no longer names has to be gone,
 *     and a merge would leave it granted for ever while the screen says «removed»;
 *   * **expiry is a predicate** on the read that answers «does this person keep the right elsewhere»,
 *     because an expired role grants nothing and must not prevent a lockout refusal;
 *   * **the tenant is never a parameter** — every statement takes `organizationId` from the scope.
 */

const ORG = '018f4a3b-0000-7000-8000-0000000000a1';

interface Recorder {
  readonly calls: { name: string; args: Record<string, unknown> }[];
  /** Raw statements, as the tagged template hands them over: the text and its bound values. */
  readonly raw: { sql: string; values: unknown[] }[];
  readonly base: Parameters<typeof withTenant>[0];
}

const recordingClient = (overrides: Record<string, unknown> = {}): Recorder => {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const record =
    <T>(name: string, result: T) =>
    (args: Record<string, unknown> = {}): Promise<T> => {
      calls.push({ name, args });

      return Promise.resolve(result);
    };

  const raw: { sql: string; values: unknown[] }[] = [];
  const tx = {
    $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]): Promise<number> => {
      raw.push({ sql: strings.join('?'), values });

      return Promise.resolve(1);
    },
    role: {
      findFirst: record('role.findFirst', overrides['role'] ?? null),
      findMany: record('role.findMany', overrides['roles'] ?? []),
      create: record('role.create', { id: 'role-created' }),
      updateMany: record('role.updateMany', { count: overrides['updated'] ?? 1 }),
      deleteMany: record('role.deleteMany', { count: 1 }),
    },
    rolePermission: {
      deleteMany: record('rolePermission.deleteMany', { count: 2 }),
      createMany: record('rolePermission.createMany', { count: 2 }),
    },
    userRole: {
      findMany: record('userRole.findMany', overrides['userRoles'] ?? []),
      findFirst: record('userRole.findFirst', overrides['userRole'] ?? null),
      count: record('userRole.count', 3),
    },
    userPermissionOverride: {
      findMany: record('userPermissionOverride.findMany', overrides['overrides'] ?? []),
    },
    user: { updateMany: record('user.updateMany', { count: 1 }) },
  };

  return {
    calls,
    raw,
    base: {
      $transaction: (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
    } as unknown as Parameters<typeof withTenant>[0],
  };
};

const inScope = async <T>(
  recorder: Recorder,
  work: (repository: PrismaCustomRoleRepository) => Promise<T>,
): Promise<T> =>
  withTenant(recorder.base, { organizationId: ORG, userId: null }, () =>
    work(new PrismaCustomRoleRepository()),
  );

const argsOf = (recorder: Recorder, name: string): Record<string, unknown> =>
  (recorder.calls.find((call) => call.name === name)?.args ?? {}) as Record<string, unknown>;

afterEach(() => {
  vi.useRealTimers();
});

describe('the expiry predicate', () => {
  it('reads the clock on every call, not once at import', async () => {
    // A module-level constant would compare every later query against the moment the process
    // started — right in a test run, wrong in a server that stays up for a week. Moving the clock
    // after the module is loaded is the only way to tell the two apart.
    const recorder = recordingClient();
    const later = new Date('2030-01-01T00:00:00Z');

    vi.useFakeTimers();
    vi.setSystemTime(later);

    await inScope(recorder, (repository) => repository.holdsRole('ivan', 'role-1'));

    const where = argsOf(recorder, 'userRole.findFirst')['where'] as {
      OR: [unknown, { expiresAt: { gt: Date } }];
    };

    expect(where.OR[1].expiresAt.gt).toEqual(later);
  });
});

describe('listing the roles of the tenant', () => {
  it('reads the composition and the holder count in one statement', async () => {
    const recorder = recordingClient({
      roles: [
        {
          id: 'role-1',
          key: 'tech_writer',
          name: 'Technical writer',
          description: null,
          isSystem: false,
          isDefault: false,
          permissions: [{ permissionKey: 'task:read' }],
          _count: { holders: 2 },
        },
      ],
    });

    expect(await inScope(recorder, (repository) => repository.list())).toEqual([
      {
        roleId: 'role-1',
        key: 'tech_writer',
        name: 'Technical writer',
        description: null,
        isSystem: false,
        isDefault: false,
        holderCount: 2,
        permissions: ['task:read'],
      },
    ]);

    const args = argsOf(recorder, 'role.findMany');

    expect(args['where']).toEqual({ organizationId: ORG });
    // A count per role would be one round trip per row, and the screen renders every role at once —
    // and it counts assignments that are in force, not ones that ran out (that number is what the
    // interface shows as «how many people does this change affect»).
    expect(args['select']).toMatchObject({
      _count: {
        select: {
          holders: {
            where: { OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }] },
          },
        },
      },
    });
    expect(args['orderBy']).toEqual([{ priority: 'desc' }, { key: 'asc' }]);
  });
});

describe('reading a composition', () => {
  it('answers nothing for a role of another organization', async () => {
    const recorder = recordingClient();

    expect(await inScope(recorder, (repository) => repository.composition('role-1'))).toBeNull();
    expect(argsOf(recorder, 'role.findFirst')['where']).toEqual({
      organizationId: ORG,
      id: 'role-1',
    });
  });

  it('returns the role with everything it grants', async () => {
    const recorder = recordingClient({
      role: {
        id: 'role-1',
        key: 'tech_writer',
        isSystem: false,
        permissions: [{ permissionKey: 'task:read' }],
      },
    });

    expect(await inScope(recorder, (repository) => repository.composition('role-1'))).toEqual({
      roleId: 'role-1',
      key: 'tech_writer',
      isSystem: false,
      permissions: ['task:read'],
    });
  });
});

describe('writing a role', () => {
  it('creates it with its grants in one statement, never as a system role', async () => {
    const recorder = recordingClient();

    expect(
      await inScope(recorder, (repository) =>
        repository.create({
          key: 'tech_writer',
          name: 'Technical writer',
          description: null,
          permissions: ['task:read'],
        }),
      ),
    ).toBe('role-created');

    expect(argsOf(recorder, 'role.create')['data']).toEqual({
      organizationId: ORG,
      key: 'tech_writer',
      name: 'Technical writer',
      description: null,
      // A role created through the API is never a system role: those are code, re-applied on upgrade.
      isSystem: false,
      isDefault: false,
      permissions: { create: [{ organizationId: ORG, permissionKey: 'task:read' }] },
    });
  });

  it('replaces the grants rather than merging them', async () => {
    const recorder = recordingClient();

    await inScope(recorder, (repository) =>
      repository.update('role-1', {
        name: 'Writer',
        description: 'x',
        permissions: ['task:read', 'task:update'],
      }),
    );

    // The delete has to come first and has to be unconditional; anything narrower leaves a permission
    // the draft no longer names granted for ever.
    expect(recorder.calls.map((call) => call.name)).toEqual([
      'role.updateMany',
      'rolePermission.deleteMany',
      'rolePermission.createMany',
    ]);
    expect(argsOf(recorder, 'rolePermission.deleteMany')['where']).toEqual({
      organizationId: ORG,
      roleId: 'role-1',
    });
    expect(argsOf(recorder, 'rolePermission.createMany')['data']).toEqual([
      { organizationId: ORG, roleId: 'role-1', permissionKey: 'task:read' },
      { organizationId: ORG, roleId: 'role-1', permissionKey: 'task:update' },
    ]);
  });

  it('writes no grants when the role is gone by the time the update runs', async () => {
    // The concurrent-delete window. Writing them anyway violates the foreign key — a 500 for what is
    // a 404 — and, for an empty composition, would not fail at all: it would answer 204 and file a
    // trail entry about a role that does not exist.
    const recorder = recordingClient({ updated: 0 });

    expect(
      await inScope(recorder, (repository) =>
        repository.update('role-1', {
          name: 'Writer',
          description: null,
          permissions: ['task:read'],
        }),
      ),
    ).toBe(false);
    expect(recorder.calls.map((call) => call.name)).toEqual(['role.updateMany']);
  });

  it('deletes it inside the tenant', async () => {
    const recorder = recordingClient();

    await inScope(recorder, (repository) => repository.remove('role-1'));

    expect(argsOf(recorder, 'role.deleteMany')['where']).toEqual({
      organizationId: ORG,
      id: 'role-1',
    });
  });
});

describe('who is affected by a change', () => {
  it('answers whether one person holds it, without listing anybody', async () => {
    // A question, not a list: a role the whole organization holds would otherwise be tens of
    // thousands of identifiers in memory on every edit.
    const holder = recordingClient({ userRole: { userId: 'ivan' } });
    const stranger = recordingClient();

    expect(await inScope(holder, (repository) => repository.holdsRole('ivan', 'role-1'))).toBe(
      true,
    );
    expect(await inScope(stranger, (repository) => repository.holdsRole('ivan', 'role-1'))).toBe(
      false,
    );
    expect(argsOf(holder, 'userRole.findFirst')['where']).toEqual({
      organizationId: ORG,
      userId: 'ivan',
      roleId: 'role-1',
      // The same predicate the «what does the actor keep elsewhere» read uses. Two different
      // definitions of «holds this role» would refuse a legitimate edit on the strength of a grant
      // that stopped applying yesterday.
      OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }],
    });
  });

  it('counts the holders in the database rather than in memory', async () => {
    const recorder = recordingClient();

    expect(await inScope(recorder, (repository) => repository.holderCount('role-1'))).toBe(3);
    expect(argsOf(recorder, 'userRole.count')['where']).toEqual({
      organizationId: ORG,
      roleId: 'role-1',
      // The same predicate as everywhere else: this number goes into the trail as «how many people
      // this affected», and an expired assignment affected nobody.
      OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }],
    });
  });

  it('collects what the actor keeps elsewhere — other roles and their ALLOW exceptions', async () => {
    const recorder = recordingClient({
      userRoles: [
        { role: { permissions: [{ permissionKey: 'role:update' }] } },
        { role: { permissions: [{ permissionKey: 'task:read' }] } },
      ],
      overrides: [{ permissionKey: 'role:delete' }],
    });

    expect(
      await inScope(recorder, (repository) =>
        repository.permissionsExcludingRole('admin', 'role-1'),
      ),
      // Without the exceptions, somebody whose right to edit roles came from one written for exactly
      // that purpose would be refused the edit as a self-lockout.
    ).toEqual(['role:update', 'task:read', 'role:delete']);

    const overrideWhere = argsOf(recorder, 'userPermissionOverride.findMany')['where'] as Record<
      string,
      unknown
    >;

    expect(overrideWhere).toMatchObject({ organizationId: ORG, userId: 'admin', effect: 'ALLOW' });

    const where = argsOf(recorder, 'userRole.findMany')['where'] as Record<string, unknown>;

    expect(where).toMatchObject({ organizationId: ORG, userId: 'admin' });
    expect(where['roleId']).toEqual({ not: 'role-1' });
    // A key retired from the catalogue grants nothing either.
    expect(argsOf(recorder, 'userRole.findMany')['select']).toMatchObject({
      role: { select: { permissions: { where: { permission: { deprecatedAt: null } } } } },
    });
    // An expired role grants nothing, so it is not a reason to believe somebody keeps a right — and
    // believing it wrongly is exactly the lockout the policy exists to refuse.
    expect(where['OR']).toEqual([{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }]);
  });

  it('invalidates the holders by subquery, never by a list of ids', async () => {
    const recorder = recordingClient();

    await inScope(recorder, (repository) => repository.bumpHoldersOf('role-1'));

    // The last statement, not the first: opening the scope issues its own `set_config`.
    const statement = recorder.raw.at(-1);

    expect(statement).toBeDefined();
    // The two properties this statement exists for: «who holds it» is resolved by the same statement
    // that invalidates them — no window in which an assignment lands unnoticed — and no bind
    // parameter per person, which a role the whole organization holds would eventually exceed.
    expect(statement?.sql).toContain('SELECT user_id');
    expect(statement?.sql).toContain('FROM user_roles');
    expect(statement?.sql).toContain('expires_at IS NULL OR expires_at > now()');
    expect(statement?.sql).toContain('permissions_version = permissions_version + 1');
    expect(statement?.values).toEqual([ORG, ORG, 'role-1']);
  });
});
