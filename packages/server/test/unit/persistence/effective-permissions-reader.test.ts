import { describe, expect, it } from 'vitest';

import { PrismaEffectivePermissionsReader } from '@/infrastructure/persistence/prisma/effective-permissions-reader.adapter.js';
import { withTenant } from '@/infrastructure/persistence/prisma/tenant.context.js';

import { countingArray } from '../../support/counting-array.util.js';

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

interface RecordedRole {
  readonly id?: string;
  readonly key?: string;
  readonly name?: string;
  readonly permissions: { permissionKey: string }[];
}

const recordingClient = (state: {
  user?: { id: string; permissionsVersion: number } | null;
  ownerId?: string;
  assignments?: { role: RecordedRole }[];
  overrides?: {
    permissionKey: string;
    effect: 'ALLOW' | 'DENY';
    reason?: string;
    grantedById?: string | null;
    grantedAt?: Date;
    expiresAt?: Date | null;
  }[];
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
      findMany: record(
        'userPermissionOverride.findMany',
        (state.overrides ?? []).map((row) => ({
          reason: 'seeded exception row',
          grantedById: null,
          grantedAt: new Date('2026-08-01T00:00:00.000Z'),
          expiresAt: null,
          ...row,
        })),
      ),
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
        {
          role: { permissions: [{ permissionKey: 'task:read' }, { permissionKey: 'task:update' }] },
        },
        { role: { permissions: [{ permissionKey: 'task:read' }, { permissionKey: 'role:read' }] } },
      ],
    });

    const facts = await read(recorder, 'ivan');

    expect([...(facts?.granted ?? [])].sort()).toEqual(['role:read', 'task:read', 'task:update']);
    expect(facts?.permissionsVersion).toBe(7);

    const where = (recorder.calls.find((call) => call.name === 'userRole.findMany')?.args[
      'where'
    ] ?? {}) as Record<string, unknown>;

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
        {
          role: {
            permissions: [{ permissionKey: 'task:read' }, { permissionKey: 'task:teleport' }],
          },
        },
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

    expect(
      recorder.calls.find((call) => call.name === 'user.findFirst')?.args['where'],
    ).toMatchObject({ organizationId: ORG, id: 'ivan', deletedAt: null });
  });
});

/**
 * The narrated projection of the same read.
 *
 * `capabilitiesOf` builds the actor on every request; `attributedCapabilitiesOf` builds the
 * administration screen of STORY-011-11. What matters here is that they are **one** read folded
 * twice, not two reads: the last case compares the facts half of one against the whole of the other
 * over the same rows, so a predicate added to one and forgotten in the other fails by name.
 *
 * The expiry predicate itself is exercised against a real PostgreSQL in
 * `test/integration/db/effective-permissions-attribution.test.ts` — a recorder has no `WHERE`, so
 * what can be pinned here is the statement, and what has to be proved there is the behaviour.
 */
const readAttributed = async (recorder: Recorder, userId: string) =>
  withTenant(recorder.base, { organizationId: ORG, userId: null }, () =>
    new PrismaEffectivePermissionsReader().attributedCapabilitiesOf(userId),
  );

describe('narrating where each permission came from', () => {
  const twoRoles = () =>
    recordingClient({
      user: { id: 'ivan', permissionsVersion: 4 },
      assignments: [
        {
          role: {
            id: 'role-manager',
            key: 'manager',
            name: 'Manager',
            permissions: [{ permissionKey: 'task:read' }, { permissionKey: 'task:update' }],
          },
        },
        {
          role: {
            id: 'role-reviewer',
            key: 'reviewer',
            name: 'Reviewer',
            permissions: [{ permissionKey: 'task:read' }],
          },
        },
      ],
      overrides: [
        {
          permissionKey: 'task:update',
          effect: 'DENY',
          reason: 'deletions frozen until the audit closes',
          grantedById: 'admin',
          expiresAt: new Date('2099-01-01T00:00:00.000Z'),
        },
      ],
    });

  it('answers nothing at all for somebody who is not in this organization', async () => {
    expect(await readAttributed(recordingClient({ user: null }), 'ghost')).toBeNull();
  });

  it('names every role that grants a key, not just the first', async () => {
    const attributed = await readAttributed(twoRoles(), 'ivan');

    expect(attributed?.grantedByRole.get('task:read')).toEqual(['role-manager', 'role-reviewer']);
    expect(attributed?.grantedByRole.get('task:update')).toEqual(['role-manager']);
    expect(attributed?.roles).toEqual([
      { roleId: 'role-manager', key: 'manager', name: 'Manager' },
      { roleId: 'role-reviewer', key: 'reviewer', name: 'Reviewer' },
    ]);
  });

  it('keeps the role behind a key an exception took away', async () => {
    const attributed = await readAttributed(twoRoles(), 'ivan');

    expect(attributed?.facts.denied).toEqual(['task:update']);
    // The fall-back the three-state control renders: lifting the exception restores the role grant.
    expect(attributed?.grantedByRole.get('task:update')).toEqual(['role-manager']);
    expect(attributed?.overrides.get('task:update')).toEqual({
      effect: 'DENY',
      reason: 'deletions frozen until the audit closes',
      grantedById: 'admin',
      grantedAt: new Date('2026-08-01T00:00:00.000Z'),
      expiresAt: new Date('2099-01-01T00:00:00.000Z'),
    });
  });

  it('drops a key the code no longer declares from the attribution too', async () => {
    const recorder = recordingClient({
      user: { id: 'ivan', permissionsVersion: 1 },
      assignments: [
        {
          role: {
            id: 'role-1',
            permissions: [{ permissionKey: 'task:read' }, { permissionKey: 'task:teleport' }],
          },
        },
      ],
      overrides: [{ permissionKey: 'task:levitate', effect: 'DENY' }],
    });

    const attributed = await readAttributed(recorder, 'ivan');

    expect([...(attributed?.grantedByRole.keys() ?? [])]).toEqual(['task:read']);
    expect([...(attributed?.overrides.keys() ?? [])]).toEqual([]);
  });

  it('reads the exception columns the screen shows, and no others', async () => {
    const recorder = twoRoles();

    await readAttributed(recorder, 'ivan');

    const select = recorder.calls.find((call) => call.name === 'userPermissionOverride.findMany')
      ?.args['select'];

    // Compared whole rather than by `toContain`: a column quietly added here is a column that ends
    // up in a body about one person, and the point of listing them is that the list is the contract.
    expect(select).toEqual({
      permissionKey: true,
      effect: true,
      reason: true,
      grantedById: true,
      grantedAt: true,
      expiresAt: true,
    });
  });

  it('folds the same facts as the unnarrated read, over the same rows', async () => {
    const [folded, attributed] = await Promise.all([
      read(twoRoles(), 'ivan'),
      readAttributed(twoRoles(), 'ivan'),
    ]);

    expect(attributed?.facts).toEqual(folded);
  });

  it('applies the same expiry predicate as the unnarrated read', async () => {
    const recorder = twoRoles();

    await readAttributed(recorder, 'ivan');

    for (const name of ['userRole.findMany', 'userPermissionOverride.findMany']) {
      const where = (recorder.calls.find((call) => call.name === name)?.args['where'] ??
        {}) as Record<string, unknown>;

      expect(where['OR']).toEqual([{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }]);
      expect(where['organizationId']).toBe(ORG);
    }
  });

  /**
   * The subject predicate, pinned exactly — not merely observed to have an `organizationId` and an
   * `OR` beside it.
   *
   * `organizationId` is closed over RLS: drop it from either query and the isolation suite in
   * `test/integration/db/effective-permissions-attribution.test.ts` still fails, because the
   * database refuses the cross-tenant row on its own. `userId` has no such second rubber — RLS
   * closes the rental, not the door between two tenants of it, and a `where` missing it would still
   * satisfy `organizationId` alone while returning every colleague's roles and personal exceptions,
   * reasons included, in the same organization. Compared whole rather than by `toContain` on one
   * field, the way `select` is pinned above: a predicate quietly dropped here is not a shorter test,
   * it is a wider answer nobody asked to see.
   */
  it('pins the subject predicate exactly, for both queries the answer is built from', async () => {
    const recorder = twoRoles();

    await readAttributed(recorder, 'ivan');

    const expected = {
      organizationId: ORG,
      userId: 'ivan',
      OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }],
    };

    for (const name of ['userRole.findMany', 'userPermissionOverride.findMany']) {
      const where = recorder.calls.find((call) => call.name === name)?.args['where'];

      expect(where).toEqual(expected);
    }
  });
});

/**
 * The fold for a whole audience (`capabilitiesOfMany`) — the read behind the summary of a
 * visibility change. What it must not do is answer one person differently from `capabilitiesOf`:
 * the same predicates, the same fold, grouped by id; and a fixed number of statements.
 */
describe('assembling what several people may do at once', () => {
  const IVAN = '018f4a3b-0000-7000-8000-0000000000c1';
  const PETR = '018f4a3b-0000-7000-8000-0000000000c2';

  const batchClient = (users: { id: string; permissionsVersion: number }[]) => {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const record =
      <T>(name: string, result: T) =>
      (args: Record<string, unknown> = {}): Promise<T> => {
        calls.push({ name, args });

        return Promise.resolve(result);
      };
    const tx = {
      $executeRaw: (): Promise<number> => Promise.resolve(1),
      user: { findMany: record('user.findMany', users) },
      organization: { findFirst: record('organization.findFirst', { ownerId: OWNER }) },
      userRole: {
        findMany: record('userRole.findMany', [
          {
            userId: IVAN,
            role: {
              id: 'r1',
              key: 'developer',
              name: 'Developer',
              permissions: [{ permissionKey: 'project:read' }, { permissionKey: 'not:a_key' }],
            },
          },
        ]),
      },
      userPermissionOverride: {
        findMany: record('userPermissionOverride.findMany', [
          {
            userId: IVAN,
            permissionKey: 'project:update',
            effect: 'DENY',
            reason: 'seeded exception row',
            grantedById: null,
            grantedAt: new Date('2026-08-01T00:00:00.000Z'),
            expiresAt: null,
          },
        ]),
      },
    };

    return {
      calls,
      base: {
        $transaction: (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
      } as unknown as Parameters<typeof withTenant>[0],
    };
  };

  const BOTH = [
    { id: OWNER, permissionsVersion: 3 },
    { id: IVAN, permissionsVersion: 5 },
  ];

  const readMany = (base: Parameters<typeof withTenant>[0], ids: readonly string[]) =>
    withTenant(base, { organizationId: ORG, userId: null }, () =>
      new PrismaEffectivePermissionsReader().capabilitiesOfMany(ids),
    );

  it('sends nothing for nobody', async () => {
    const recorder = batchClient(BOTH);

    expect((await readMany(recorder.base, [])).size).toBe(0);
    expect(recorder.calls).toEqual([]);
  });

  it('folds each person on their own rows, and leaves out an id that is not a person here', async () => {
    const recorder = batchClient(BOTH);

    const facts = await readMany(recorder.base, [OWNER, IVAN, PETR]);

    expect([...facts.keys()]).toEqual([OWNER, IVAN]);
    expect(facts.get(OWNER)).toEqual({
      isOwner: true,
      granted: [],
      denied: [],
      roleKeys: [],
      permissionsVersion: 3,
    });
    expect(facts.get(IVAN)).toEqual({
      isOwner: false,
      granted: ['project:read'],
      denied: ['project:update'],
      roleKeys: ['developer'],
      permissionsVersion: 5,
    });
    // Four client calls, whatever the number of ids — a constant number of statements, not four:
    // Prisma sends the nested role selects on their own.
    expect(recorder.calls.map((call) => call.name).toSorted()).toEqual([
      'organization.findFirst',
      'user.findMany',
      'userPermissionOverride.findMany',
      'userRole.findMany',
    ]);
  });

  it('sends the predicates capabilitiesOf sends — tenant, deletion, expiry, deprecation', async () => {
    const recorder = batchClient(BOTH);

    await readMany(recorder.base, [OWNER, IVAN]);

    const argsOf = (name: string) => recorder.calls.find((call) => call.name === name)?.args ?? {};

    expect(argsOf('user.findMany')['where']).toEqual({
      organizationId: ORG,
      id: { in: [OWNER, IVAN] },
      deletedAt: null,
    });

    for (const name of ['userRole.findMany', 'userPermissionOverride.findMany']) {
      expect(argsOf(name)['where']).toEqual({
        organizationId: ORG,
        userId: { in: [OWNER, IVAN] },
        OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }],
      });
    }

    const select = argsOf('userRole.findMany')['select'] as {
      role: { select: { permissions: { where: unknown } } };
    };

    expect(select.role.select.permissions.where).toEqual({ permission: { deprecatedAt: null } });
  });

  it('stops after the accounts when none of the ids is a person here', async () => {
    const recorder = batchClient([]);

    expect((await readMany(recorder.base, [PETR])).size).toBe(0);
    expect(recorder.calls.map((call) => call.name)).toEqual(['user.findMany']);
  });

  it('walks the role and exception rows once, not once per person', async () => {
    // A per-person `filter` over the whole result is N² element reads: at 20 000 accounts that
    // outlived `idle_in_transaction_session_timeout` and the summary answered 500. The rows are
    // walked a bounded number of times however many people are asked about.
    const people = Array.from({ length: 400 }, (_, index) => ({
      id: `018f4a3b-0000-7000-8000-${index.toString().padStart(12, '0')}`,
      permissionsVersion: 1,
    }));
    const assignments = countingArray(
      people.map((person) => ({
        userId: person.id,
        role: {
          id: 'r1',
          key: 'developer',
          name: 'Developer',
          permissions: [{ permissionKey: 'project:read' }],
        },
      })),
    );
    const overrides = countingArray(
      people.map((person) => ({
        userId: person.id,
        permissionKey: 'project:update',
        effect: 'DENY' as const,
        reason: 'seeded exception row',
        grantedById: null,
        grantedAt: new Date('2026-08-01T00:00:00.000Z'),
        expiresAt: null,
      })),
    );
    const tx = {
      $executeRaw: (): Promise<number> => Promise.resolve(1),
      user: { findMany: () => Promise.resolve(people) },
      organization: { findFirst: () => Promise.resolve({ ownerId: OWNER }) },
      userRole: { findMany: () => Promise.resolve(assignments.rows) },
      userPermissionOverride: { findMany: () => Promise.resolve(overrides.rows) },
    };
    const base = {
      $transaction: (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
    } as unknown as Parameters<typeof withTenant>[0];

    const facts = await readMany(
      base,
      people.map((person) => person.id),
    );

    expect(facts.size).toBe(people.length);
    expect(facts.get(people[123]?.id ?? '')).toMatchObject({
      granted: ['project:read'],
      denied: ['project:update'],
      roleKeys: ['developer'],
    });
    // Linear: a small constant number of passes over each result, never one pass per person.
    expect(assignments.reads()).toBeLessThanOrEqual(4 * people.length);
    expect(overrides.reads()).toBeLessThanOrEqual(4 * people.length);
  });
});
