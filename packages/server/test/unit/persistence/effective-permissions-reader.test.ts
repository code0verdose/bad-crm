import { describe, expect, it } from 'vitest';

import { PrismaEffectivePermissionsReader } from '@/infrastructure/persistence/prisma/effective-permissions-reader.adapter.js';
import { withTenant } from '@/infrastructure/persistence/prisma/tenant.context.js';

/**
 * What one person may do, assembled from rows — with the driver replaced by a recorder.
 *
 * Three decisions live in this read and each of them is a way to grant too much:
 *
 *   * an **expired** assignment must stop granting at its expiry, not when a cleanup job runs;
 *   * a **deprecated** permission grants nothing — the key stays in the catalogue so existing rows
 *     survive, and resolving it to a capability would silently reinstate a right the release
 *     removed;
 *   * a key the **code no longer declares** is dropped, because `PermissionKey` is closed and a
 *     string outside it cannot be checked at any call site.
 *
 * None of the three is visible in an integration run, where the rows are whatever the fixture wrote.
 */

const ORG = '018f4a3b-0000-7000-8000-0000000000b1';
const OWNER = '018f4a3b-0000-7000-8000-0000000000b2';

interface Recorder {
  readonly calls: { name: string; args: Record<string, unknown> }[];
  readonly base: Parameters<typeof withTenant>[0];
}

const recordingClient = (state: {
  user?: { id: string; permissionsVersion: number } | null;
  ownerId?: string;
  assignments?: { role: { permissions: { permissionKey: string }[] } }[];
  overrides?: { permissionKey: string; effect: 'ALLOW' | 'DENY' }[];
}): Recorder => {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const record =
    <T>(name: string, result: T) =>
    (args: Record<string, unknown> = {}): Promise<T> => {
      calls.push({ name, args });

      return Promise.resolve(result);
    };

  const tx = {
    $executeRaw: (): Promise<number> => Promise.resolve(1),
    user: { findFirst: record('user.findFirst', state.user ?? null) },
    organization: {
      findFirst: record('organization.findFirst', { ownerId: state.ownerId ?? OWNER }),
    },
    userRole: { findMany: record('userRole.findMany', state.assignments ?? []) },
    userPermissionOverride: {
      findMany: record('userPermissionOverride.findMany', state.overrides ?? []),
    },
  };

  return {
    calls,
    base: {
      $transaction: (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
    } as unknown as Parameters<typeof withTenant>[0],
  };
};

const read = async (recorder: Recorder, userId: string) =>
  withTenant(recorder.base, { organizationId: ORG, userId: null }, () =>
    new PrismaEffectivePermissionsReader().capabilitiesOf(userId),
  );

describe('assembling what a person may do', () => {
  it('answers nothing at all for somebody who is not in this organization', async () => {
    // `null`, not an empty capability set: «not here» is answered 404 by the caller, and an empty
    // set would be answered 403 — the difference invariant 2 is about.
    expect(await read(recordingClient({ user: null }), 'ghost')).toBeNull();
  });

  it('unions the permissions of every unexpired role, without duplicates', async () => {
    const recorder = recordingClient({
      user: { id: 'ivan', permissionsVersion: 7 },
      assignments: [
        { role: { permissions: [{ permissionKey: 'task:read' }, { permissionKey: 'task:update' }] } },
        { role: { permissions: [{ permissionKey: 'task:read' }, { permissionKey: 'role:read' }] } },
      ],
    });

    const facts = await read(recorder, 'ivan');

    expect([...(facts?.granted ?? [])].sort()).toEqual(['role:read', 'task:read', 'task:update']);
    expect(facts?.permissionsVersion).toBe(7);

    const where = (recorder.calls.find((call) => call.name === 'userRole.findMany')?.args['where'] ??
      {}) as Record<string, unknown>;

    expect(where['OR']).toEqual([{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }]);
    // The deprecated half of the rule, as the query states it: a key the release removed is still in
    // the catalogue and must resolve to «no permission».
    const select = recorder.calls.find((call) => call.name === 'userRole.findMany')?.args[
      'select'
    ] as { role: { select: { permissions: { where: unknown } } } };

    expect(select.role.select.permissions.where).toEqual({ permission: { deprecatedAt: null } });
  });

  /**
   * Layer 3 folded in, and the two halves kept apart: an ALLOW joins the grants, a DENY comes back
   * on its own. Subtracting here would make `effectivePermission` unable to tell «refused by an
   * exception» from «nobody gave it to you» — two sentences with different remedies in the
   * interface, and two different reasons in the trail.
   */
  it('adds an ALLOW exception to the grants and returns a DENY separately', async () => {
    const recorder = recordingClient({
      user: { id: 'ivan', permissionsVersion: 2 },
      assignments: [{ role: { permissions: [{ permissionKey: 'task:read' }] } }],
      overrides: [
        { permissionKey: 'invoice:issue', effect: 'ALLOW' },
        { permissionKey: 'task:read', effect: 'DENY' },
      ],
    });

    const facts = await read(recorder, 'ivan');

    expect([...(facts?.granted ?? [])].sort()).toEqual(['invoice:issue', 'task:read']);
    expect(facts?.denied).toEqual(['task:read']);

    const where = (recorder.calls.find((call) => call.name === 'userPermissionOverride.findMany')
      ?.args['where'] ?? {}) as Record<string, unknown>;

    // The same expiry predicate as the roles: an exception that expired a second ago grants and
    // denies nothing, whether or not the cleaner has run.
    expect(where['OR']).toEqual([{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }]);
  });

  it('drops a key the code no longer declares', async () => {
    const recorder = recordingClient({
      user: { id: 'ivan', permissionsVersion: 1 },
      assignments: [
        { role: { permissions: [{ permissionKey: 'task:read' }, { permissionKey: 'task:teleport' }] } },
      ],
    });

    expect((await read(recorder, 'ivan'))?.granted).toEqual(['task:read']);
  });

  it('reads ownership from the organization, not from a role called owner', async () => {
    const owner = recordingClient({ user: { id: OWNER, permissionsVersion: 1 }, ownerId: OWNER });
    const member = recordingClient({ user: { id: 'ivan', permissionsVersion: 1 }, ownerId: OWNER });

    // The property that has to survive a broken roles table is the one that says who can repair it.
    expect((await read(owner, OWNER))?.isOwner).toBe(true);
    expect((await read(member, 'ivan'))?.isOwner).toBe(false);
  });

  it('ignores a person marked deleted', async () => {
    const recorder = recordingClient({ user: null });

    await read(recorder, 'ivan');

    expect(recorder.calls.find((call) => call.name === 'user.findFirst')?.args['where']).toMatchObject(
      { organizationId: ORG, id: 'ivan', deletedAt: null },
    );
  });
});
