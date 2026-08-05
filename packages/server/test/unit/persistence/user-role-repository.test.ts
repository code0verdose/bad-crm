import { describe, expect, it } from 'vitest';

import { PrismaUserRoleRepository } from '@/infrastructure/persistence/prisma/user-role.repository.js';
import { withTenant } from '@/infrastructure/persistence/prisma/tenant.context.js';

/**
 * Assignments through Prisma, with the driver replaced by a recorder.
 *
 * The arguments are the subject, for the reason `role-repository.test.ts` gives: a live database
 * shows that a statement was accepted, never which decision produced it. Two of those decisions are
 * invisible in an integration run and expensive when wrong:
 *
 *   * **expiry is a predicate on every read**, not only a job. A read without it means «temporary
 *     access» lasts until a background job somebody does not monitor happens to run;
 *   * **the tenant is never a parameter.** Every query carries `organizationId` from the scope, so a
 *     caller cannot pass a second answer to «which tenant» — one the policy silently filters by
 *     rather than refuses.
 */

const ORG = '018f4a3b-0000-7000-8000-0000000000a1';

interface Recorder {
  readonly calls: { name: string; args: Record<string, unknown> }[];
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

  const tx = {
    $executeRaw: (): Promise<number> => Promise.resolve(1),
    role: { findFirst: record('role.findFirst', overrides['role'] ?? null) },
    user: {
      findFirst: record('user.findFirst', overrides['user'] ?? null),
      updateMany: record('user.updateMany', { count: 1 }),
    },
    userRole: {
      findFirst: record('userRole.findFirst', overrides['userRole'] ?? null),
      findMany: record('userRole.findMany', overrides['userRoles'] ?? []),
      count: record('userRole.count', 3),
      create: record('userRole.create', { id: 'assignment-1' }),
      deleteMany: record('userRole.deleteMany', overrides['deleted'] ?? { count: 1 }),
    },
  };

  return {
    calls,
    base: {
      $transaction: (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
    } as unknown as Parameters<typeof withTenant>[0],
  };
};

const inScope = async <T>(
  recorder: Recorder,
  work: (repository: PrismaUserRoleRepository) => Promise<T>,
): Promise<T> =>
  withTenant(recorder.base, { organizationId: ORG, userId: null }, () =>
    work(new PrismaUserRoleRepository()),
  );

const argsOf = (recorder: Recorder, name: string): Record<string, unknown> =>
  (recorder.calls.find((call) => call.name === name)?.args ?? {}) as Record<string, unknown>;

describe('reading what somebody holds', () => {
  it('filters out expired grants, so a job that has not run cannot extend access', async () => {
    const recorder = recordingClient({ userRoles: [{ roleId: 'role-1' }] });

    expect(await inScope(recorder, (repository) => repository.roleIdsOf('ivan'))).toEqual([
      'role-1',
    ]);

    const where = argsOf(recorder, 'userRole.findMany')['where'] as Record<string, unknown>;

    expect(where['organizationId']).toBe(ORG);
    expect(where['userId']).toBe('ivan');
    expect(where['OR']).toEqual([{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }]);
  });

  it('counts the holders of a role key without one person, which is the «would be left» question', async () => {
    const recorder = recordingClient();

    expect(await inScope(recorder, (repository) => repository.countHoldersOfKey('owner', 'ivan')))
      .toBe(3);

    const where = argsOf(recorder, 'userRole.count')['where'] as Record<string, unknown>;

    expect(where).toMatchObject({ organizationId: ORG, role: { key: 'owner' } });
    expect(where['userId']).toEqual({ not: 'ivan' });
    // The same predicate as above: an expired owner is not an owner, and «the last owner» must not
    // be answered by a row that stopped counting yesterday.
    expect(where['OR']).toEqual([{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }]);
  });

  it('counts every holder when nobody is excluded', async () => {
    const recorder = recordingClient();

    await inScope(recorder, (repository) => repository.countHoldersOfKey('owner'));

    expect(argsOf(recorder, 'userRole.count')['where']).not.toHaveProperty('userId');
  });

  it('reads a role with everything it grants, or nothing at all', async () => {
    const empty = recordingClient();

    expect(await inScope(empty, (repository) => repository.roleFacts('role-1'))).toBeNull();

    const found = recordingClient({
      role: { id: 'role-1', key: 'manager', permissions: [{ permissionKey: 'task:read' }] },
    });

    expect(await inScope(found, (repository) => repository.roleFacts('role-1'))).toEqual({
      roleId: 'role-1',
      key: 'manager',
      permissions: ['task:read'],
    });
  });

  it('treats a soft-deleted account as absent', async () => {
    // «Deactivated» is `deleted_at`, and a role assigned to a deactivated person is an assignment
    // nobody can see in the interface — so the read that guards it has to agree with the interface.
    const recorder = recordingClient();

    expect(await inScope(recorder, (repository) => repository.userExists('ivan'))).toBe(false);
    expect(argsOf(recorder, 'user.findFirst')['where']).toMatchObject({
      organizationId: ORG,
      id: 'ivan',
      deletedAt: null,
    });
  });
});

describe('writing an assignment', () => {
  it('reports that nothing was created when the person already holds the role', async () => {
    const recorder = recordingClient({ userRole: { id: 'existing' } });

    expect(
      await inScope(recorder, (repository) =>
        repository.assign({
          userId: 'ivan',
          roleId: 'role-1',
          grantedById: 'admin',
          expiresAt: null,
        }),
      ),
    ).toEqual({ created: false });
    expect(recorder.calls.map((call) => call.name)).not.toContain('userRole.create');
  });

  it('records who granted it and until when', async () => {
    const recorder = recordingClient();
    const expiresAt = new Date('2027-01-01T00:00:00Z');

    expect(
      await inScope(recorder, (repository) =>
        repository.assign({ userId: 'ivan', roleId: 'role-1', grantedById: 'admin', expiresAt }),
      ),
    ).toEqual({ created: true });
    expect(argsOf(recorder, 'userRole.create')['data']).toEqual({
      organizationId: ORG,
      userId: 'ivan',
      roleId: 'role-1',
      grantedById: 'admin',
      expiresAt,
    });
  });

  it('answers whether a revocation removed anything', async () => {
    const removed = recordingClient();
    const nothing = recordingClient({ deleted: { count: 0 } });

    expect(await inScope(removed, (repository) => repository.revoke('ivan', 'role-1'))).toBe(true);
    expect(await inScope(nothing, (repository) => repository.revoke('ivan', 'role-1'))).toBe(false);
    expect(argsOf(removed, 'userRole.deleteMany')['where']).toEqual({
      organizationId: ORG,
      userId: 'ivan',
      roleId: 'role-1',
    });
  });

  it('bumps the version by one, scoped to the tenant', async () => {
    const recorder = recordingClient();

    await inScope(recorder, (repository) => repository.bumpPermissionsVersion('ivan'));

    expect(argsOf(recorder, 'user.updateMany')).toEqual({
      where: { organizationId: ORG, id: 'ivan' },
      data: { permissionsVersion: { increment: 1 } },
    });
  });
});
