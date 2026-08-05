import { describe, expect, it } from 'vitest';

import { PrismaRoleRepository } from '@/infrastructure/persistence/prisma/role.repository.js';
import { withTenant, type TxClient } from '@/infrastructure/persistence/prisma/tenant.context.js';

/**
 * Roles through Prisma, with the driver replaced by a recorder.
 *
 * What is asserted here is the *arguments*, for the same reason as in `organization-repository`: a
 * live database can only show that a statement was accepted, not which decision produced it. Whether
 * the database then agrees is the subject of
 * `test/integration/db/system-roles-provisioning.test.ts`, which runs the same code against real
 * policies.
 *
 * Two decisions are worth pinning here and are invisible in the integration run:
 *
 *   * grants are **replaced**, not merged — a `deleteMany` precedes the `createMany`, which is what
 *     makes a permission removed from a release disappear from installations that already exist;
 *   * the default flag is **cleared before it is set**, because a partial unique index allows one
 *     default per organization and re-running after the default moved would otherwise hit it.
 */

const ORG = '018f4a3b-0000-7000-8000-000000000001';

interface Recorder {
  readonly calls: string[];
  readonly base: Parameters<typeof withTenant>[0];
}

const recordingClient = (): Recorder => {
  const calls: string[] = [];

  const tx = {
    $executeRaw: (): Promise<number> => Promise.resolve(1),
    role: {
      upsert: (args: { where: unknown }): Promise<{ id: string }> => {
        calls.push('role.upsert');
        void args;

        return Promise.resolve({ id: 'role-1' });
      },
      updateMany: (args: { data: { isDefault?: boolean } }): Promise<{ count: number }> => {
        calls.push(`role.updateMany:isDefault=${String(args.data.isDefault)}`);

        return Promise.resolve({ count: 1 });
      },
      findMany: (): Promise<unknown[]> => {
        calls.push('role.findMany');

        return Promise.resolve([]);
      },
    },
    rolePermission: {
      deleteMany: (): Promise<{ count: number }> => {
        calls.push('rolePermission.deleteMany');

        return Promise.resolve({ count: 0 });
      },
      createMany: (args: { data: unknown[] }): Promise<{ count: number }> => {
        calls.push(`rolePermission.createMany:${String(args.data.length)}`);

        return Promise.resolve({ count: args.data.length });
      },
    },
  } as unknown as TxClient;

  return {
    calls,
    base: {
      $transaction: <T>(work: (client: TxClient) => Promise<T>): Promise<T> => work(tx),
    } as unknown as Parameters<typeof withTenant>[0],
  };
};

const draft = {
  key: 'admin' as const,
  name: 'admin',
  isDefault: true,
  priority: 6,
  permissions: ['task:read', 'task:update'] as const,
};

describe('provisioning roles through Prisma', () => {
  it('replaces the grants of a role instead of merging into them', async () => {
    const recorder = recordingClient();

    await withTenant(recorder.base, { organizationId: ORG, userId: null }, () =>
      new PrismaRoleRepository().provisionSystemRoles([draft]),
    );

    const deleted = recorder.calls.indexOf('rolePermission.deleteMany');
    const created = recorder.calls.indexOf('rolePermission.createMany:2');

    expect(deleted).toBeGreaterThanOrEqual(0);
    expect(created).toBeGreaterThan(deleted);
  });

  it('clears the default flag before setting it, because only one may be set', async () => {
    const recorder = recordingClient();

    await withTenant(recorder.base, { organizationId: ORG, userId: null }, () =>
      new PrismaRoleRepository().provisionSystemRoles([draft]),
    );

    const cleared = recorder.calls.indexOf('role.updateMany:isDefault=false');
    const set = recorder.calls.indexOf('role.updateMany:isDefault=true');

    expect(cleared).toBeGreaterThanOrEqual(0);
    expect(set).toBeGreaterThan(cleared);
  });

  it('touches nothing when asked for no roles at all', async () => {
    const recorder = recordingClient();

    await withTenant(recorder.base, { organizationId: ORG, userId: null }, () =>
      new PrismaRoleRepository().provisionSystemRoles([]),
    );

    expect(recorder.calls).toEqual(['role.findMany']);
  });

  it('reads the roles of the scope, without being told which organization that is', async () => {
    const recorder = recordingClient();

    const roles = await withTenant(recorder.base, { organizationId: ORG, userId: null }, () =>
      new PrismaRoleRepository().listRoles(),
    );

    expect(roles).toEqual([]);
    expect(recorder.calls).toEqual(['role.findMany']);
  });

  /**
   * CONTROL: outside a scope the repository refuses rather than reaching for a default tenant —
   * the property `TenantScopedRepository` exists for.
   */
  it('CONTROL: refuses to run without a tenant scope', async () => {
    await expect(new PrismaRoleRepository().listRoles()).rejects.toThrow(/RoleRepository/);
  });
});
