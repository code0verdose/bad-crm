import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { type PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { PrismaEffectivePermissionsReader } from '@/infrastructure/persistence/prisma/effective-permissions-reader.adapter.js';
import { withTenant } from '@/infrastructure/persistence/prisma/tenant.context.js';

import {
  asMaintenance,
  closePools,
  createPools,
  insertOrganizationWithOwner,
  truncateAll,
  type HarnessPools,
} from './db-harness.util.js';

/**
 * The narrated read behind `GET /users/{userId}/permissions`, against a real PostgreSQL.
 *
 * The endpoint's own suite runs over in-memory ports, where the capability facts arrive already
 * folded — so the two properties this read actually adds cannot be shown there and are shown here:
 *
 * **Expiry is a predicate, not a cleaning job.** An exception or an assignment past its `expiresAt`
 * grants and denies nothing from that moment, whether or not the hourly cleaner has run. A double
 * cannot demonstrate that, because a double has no clock and no `WHERE`.
 *
 * **The two methods of the port are one fold.** `capabilitiesOf` builds the actor on every request
 * and `attributedCapabilitiesOf` builds the administration screen; the last block compares them on
 * the same rows, so a predicate added to one and forgotten in the other fails here rather than
 * appearing as a screen that reassures an administrator about a permission the guard refuses.
 *
 * **Every negative carries a positive control.** The expired rows sit beside unexpired ones on
 * neighbouring keys, and the foreign organization has a subject of its own: «not visible» would pass
 * against an empty database, a broken connection, or a reader that answers nothing at all.
 */

let pools: HarnessPools;
let prisma: PrismaClient;

const ORG = randomUUID();
const OTHER_ORG = randomUUID();

const PAST = '2020-01-01T00:00:00Z';
const FUTURE = '2099-01-01T00:00:00Z';

interface Seeded {
  readonly adminId: string;
  readonly ivanId: string;
  readonly managerRoleId: string;
  readonly reviewerRoleId: string;
  readonly retiredRoleId: string;
  readonly strangerId: string;
  readonly teammateId: string;
  readonly contributorRoleId: string;
}

let seeded: Seeded;

const createUser = async (client: PoolClient, organizationId: string): Promise<string> => {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO users (organization_id, email, password_hash, status, permissions_version, updated_at)
       VALUES ($1::uuid, $2, 'placeholder-not-a-credential', 'ACTIVE', 7, now())
       RETURNING id`,
    [organizationId, `member-${randomUUID().slice(0, 8)}@example.test`],
  );

  return rows[0]?.id ?? '';
};

const createRole = async (
  client: PoolClient,
  organizationId: string,
  key: string,
  name: string,
  permissions: readonly string[],
): Promise<string> => {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO roles (organization_id, key, name, updated_at)
       VALUES ($1::uuid, $2, $3, now())
       RETURNING id`,
    [organizationId, `${key}-${randomUUID().slice(0, 8)}`, name],
  );
  const roleId = rows[0]?.id ?? '';

  for (const permissionKey of permissions) {
    await client.query(
      `INSERT INTO role_permissions (organization_id, role_id, permission_key, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, now())`,
      [organizationId, roleId, permissionKey],
    );
  }

  return roleId;
};

const assign = (
  client: PoolClient,
  organizationId: string,
  userId: string,
  roleId: string,
  expiresAt: string | null = null,
): Promise<unknown> =>
  client.query(
    `INSERT INTO user_roles (organization_id, user_id, role_id, expires_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::timestamptz, now())`,
    [organizationId, userId, roleId, expiresAt],
  );

const override = (
  client: PoolClient,
  organizationId: string,
  userId: string,
  permissionKey: string,
  effect: 'ALLOW' | 'DENY',
  reason: string,
  grantedById: string | null,
  expiresAt: string | null,
): Promise<unknown> =>
  client.query(
    `INSERT INTO user_permission_overrides
       (organization_id, user_id, permission_key, effect, reason, granted_by_id, expires_at, updated_at)
     VALUES ($1::uuid, $2::uuid, $3, $4::"OverrideEffect", $5, $6::uuid, $7::timestamptz, now())`,
    [organizationId, userId, permissionKey, effect, reason, grantedById, expiresAt],
  );

const seed = async (): Promise<Seeded> =>
  asMaintenance(pools.owner, async (client) => {
    const { ownerId: adminId } = await insertOrganizationWithOwner(client, ORG, {
      slug: `attribution-${ORG.slice(0, 8)}`,
    });
    const { ownerId: otherOwnerId } = await insertOrganizationWithOwner(client, OTHER_ORG, {
      slug: `other-${OTHER_ORG.slice(0, 8)}`,
    });

    const ivanId = await createUser(client, ORG);
    // The neighbour inside the **same** organization — the one `OTHER_ORG`'s `strangerId` cannot
    // stand in for. RLS closes the tenant boundary on its own, which is exactly why a query that
    // dropped its `userId` predicate would still pass every check that only crosses `OTHER_ORG`: the
    // row is still inside `ORG`, so Postgres lets it through, and only a fixture with a second
    // subject *inside* this tenant can show the difference.
    const teammateId = await createUser(client, ORG);
    const strangerId = await createUser(client, OTHER_ORG);

    const managerRoleId = await createRole(client, ORG, 'manager', 'Manager', [
      'task:read',
      'task:update',
      'task:delete',
    ]);
    // Grants `task:read` as well: a key two roles both grant has to name both, or the screen tells
    // an administrator that removing one role loses an access it would not lose.
    const reviewerRoleId = await createRole(client, ORG, 'reviewer', 'Reviewer', ['task:read']);
    const retiredRoleId = await createRole(client, ORG, 'retired', 'Retired', ['audit:export']);

    await assign(client, ORG, ivanId, managerRoleId);
    await assign(client, ORG, ivanId, reviewerRoleId);
    await assign(client, ORG, ivanId, retiredRoleId, PAST);

    await override(
      client,
      ORG,
      ivanId,
      'task:delete',
      'DENY',
      'deletions frozen until the audit closes',
      adminId,
      FUTURE,
    );
    await override(
      client,
      ORG,
      ivanId,
      'invoice:issue',
      'ALLOW',
      'billing handed over during parental leave',
      adminId,
      null,
    );
    // The two expired rows, on keys whose neighbours are unexpired — so «ignored» cannot be
    // confused with «the reader returned nothing».
    await override(
      client,
      ORG,
      ivanId,
      'vault_item:export',
      'ALLOW',
      'temporary export window, long closed',
      adminId,
      PAST,
    );
    await override(
      client,
      ORG,
      ivanId,
      'task:read',
      'DENY',
      'reading frozen during an incident, long over',
      adminId,
      PAST,
    );

    // The neighbour of another tenant — the RLS-only case.
    await override(
      client,
      OTHER_ORG,
      strangerId,
      'task:read',
      'DENY',
      'belongs to another tenant entirely',
      otherOwnerId,
      null,
    );

    // The neighbour of *this* tenant — a role and a personal exception of their own, so ivan's read
    // has something to leak if the subject predicate is ever dropped: RLS would not stop it, because
    // both rows already satisfy `organization_id = ORG`.
    const contributorRoleId = await createRole(client, ORG, 'contributor', 'Contributor', [
      'doc:read',
      'kb_note:read',
    ]);

    await assign(client, ORG, teammateId, contributorRoleId);
    await override(
      client,
      ORG,
      teammateId,
      'doc:create',
      'ALLOW',
      "helping the teammate's own onboarding docs along, reviewed weekly",
      adminId,
      null,
    );

    return {
      adminId,
      ivanId,
      managerRoleId,
      reviewerRoleId,
      retiredRoleId,
      strangerId,
      teammateId,
      contributorRoleId,
    };
  });

const inTenant = <T>(
  organizationId: string,
  work: (reader: PrismaEffectivePermissionsReader) => Promise<T>,
): Promise<T> =>
  withTenant(prisma, { organizationId, userId: null }, () =>
    work(new PrismaEffectivePermissionsReader()),
  );

const attributedIvan = (): ReturnType<
  PrismaEffectivePermissionsReader['attributedCapabilitiesOf']
> => inTenant(ORG, (reader) => reader.attributedCapabilitiesOf(seeded.ivanId));

const attributedTeammate = (): ReturnType<
  PrismaEffectivePermissionsReader['attributedCapabilitiesOf']
> => inTenant(ORG, (reader) => reader.attributedCapabilitiesOf(seeded.teammateId));

beforeAll(() => {
  pools = createPools();
  prisma = new PrismaClient({ datasourceUrl: inject('databaseUrls').appUser });
});

afterAll(async () => {
  // Not merely tidy. The exceptions this file seeds reference `permissions` through
  // `fk_upo_permission_key`, and `permission-catalog.test.ts` empties that table in its own setup —
  // rows left behind here make *that* file fail, in a run whose order nobody chose. A file that
  // seeds referencing rows leaves none.
  await truncateAll(pools.owner);
  await prisma.$disconnect();
  await closePools(pools);
});

beforeEach(async () => {
  await truncateAll(pools.owner);
  seeded = await seed();
});

describe('attribution', () => {
  it('CONTROL: reads the subject, their roles and their unexpired exceptions', async () => {
    const attributed = await attributedIvan();

    expect(attributed).not.toBeNull();
    expect(attributed?.facts.permissionsVersion).toBe(7);
    expect([...(attributed?.roles ?? [])].map((role) => role.name).toSorted()).toEqual([
      'Manager',
      'Reviewer',
    ]);
    expect([...(attributed?.facts.granted ?? [])].toSorted()).toContain('task:read');
  });

  it('names every role that grants a key, not just the first', async () => {
    const attributed = await attributedIvan();

    expect([...(attributed?.grantedByRole.get('task:read') ?? [])].toSorted()).toEqual(
      [seeded.managerRoleId, seeded.reviewerRoleId].toSorted(),
    );
    expect(attributed?.grantedByRole.get('task:update')).toEqual([seeded.managerRoleId]);
  });

  /**
   * The fall-back the three-state control renders: `task:delete` is refused by an exception **and**
   * granted by a role, and the screen has to be able to say what lifting the exception restores.
   */
  it('reports the role behind a key an exception has taken away', async () => {
    const attributed = await attributedIvan();

    expect(attributed?.facts.denied).toContain('task:delete');
    expect(attributed?.grantedByRole.get('task:delete')).toEqual([seeded.managerRoleId]);
    expect(attributed?.overrides.get('task:delete')).toMatchObject({
      effect: 'DENY',
      reason: 'deletions frozen until the audit closes',
      grantedById: seeded.adminId,
    });
    expect(attributed?.overrides.get('task:delete')?.grantedAt).toBeInstanceOf(Date);
  });

  it('carries an open-ended ALLOW with a null expiry rather than a guessed one', async () => {
    const attributed = await attributedIvan();

    expect(attributed?.overrides.get('invoice:issue')).toMatchObject({
      effect: 'ALLOW',
      expiresAt: null,
    });
    expect(attributed?.facts.granted).toContain('invoice:issue');
  });
});

describe('expiry is a predicate', () => {
  it('ignores an ALLOW that has expired — and keeps the one that has not', async () => {
    const attributed = await attributedIvan();

    expect(attributed?.overrides.has('vault_item:export')).toBe(false);
    expect(attributed?.facts.granted).not.toContain('vault_item:export');
    // The positive control on the neighbouring key: the reader is reading exceptions, and only the
    // expired one is missing.
    expect(attributed?.overrides.has('invoice:issue')).toBe(true);
  });

  it('ignores a DENY that has expired, so the role grants again', async () => {
    const attributed = await attributedIvan();

    expect(attributed?.overrides.has('task:read')).toBe(false);
    expect(attributed?.facts.denied).not.toContain('task:read');
    // The point of the row, not just its absence: with the exception gone the roles decide again.
    expect(attributed?.facts.granted).toContain('task:read');
    expect(attributed?.facts.denied).toContain('task:delete');
  });

  it('applies the same predicate to an expired role assignment', async () => {
    const attributed = await attributedIvan();

    expect(attributed?.facts.granted).not.toContain('audit:export');
    expect(attributed?.roles.map((role) => role.roleId)).not.toContain(seeded.retiredRoleId);
    expect(attributed?.roles).toHaveLength(2);
  });
});

describe('one fold, two projections', () => {
  it('answers the same facts through both methods of the port', async () => {
    const [folded, attributed] = await inTenant(ORG, async (reader) => [
      await reader.capabilitiesOf(seeded.ivanId),
      await reader.attributedCapabilitiesOf(seeded.ivanId),
    ]);

    expect(folded).not.toBeNull();
    expect({
      ...attributed?.facts,
      granted: [...(attributed?.facts.granted ?? [])].toSorted(),
      denied: [...(attributed?.facts.denied ?? [])].toSorted(),
      roleKeys: [...(attributed?.facts.roleKeys ?? [])].toSorted(),
    }).toEqual({
      ...folded,
      granted: [...(folded?.granted ?? [])].toSorted(),
      denied: [...(folded?.denied ?? [])].toSorted(),
      roleKeys: [...(folded?.roleKeys ?? [])].toSorted(),
    });
  });
});

describe('tenancy', () => {
  it('CONTROL: answers for a subject of the open tenant', async () => {
    await expect(attributedIvan()).resolves.not.toBeNull();
  });

  it('answers nothing about a subject of another organization — which is a 404, never a 403', async () => {
    const attributed = await inTenant(ORG, (reader) =>
      reader.attributedCapabilitiesOf(seeded.strangerId),
    );

    expect(attributed).toBeNull();
  });

  it('does not leak the other tenant’s exception into this one’s answer', async () => {
    const attributed = await attributedIvan();

    expect(attributed?.overrides.get('task:read')).toBeUndefined();
    expect(attributed?.facts.granted).toContain('task:read');
  });
});

/**
 * The subject predicate, proved on a real Postgres rather than pinned only in the recorder-based
 * unit test.
 *
 * RLS is the second rubber, not the first: it refuses a row of `OTHER_ORG` on its own, which is
 * exactly why the case above passes whether or not `userId` is in the `WHERE` — the row belongs to a
 * different tenant either way. It says nothing about a **colleague inside `ORG`**, because their row
 * already satisfies the tenant policy. `teammateId` exists for that reason: their role and their
 * personal exception — with a reason of their own — sit in the same table, the same organization,
 * and the same query ivan's read runs. Isolation here rests entirely on the application predicate —
 * each case below carries a positive control: the reader answers for a subject asked for directly
 * (so the isolation cannot be passing on a broken connection or an empty database), and it does not
 * answer for the neighbour it was not asked about.
 */
describe('tenancy inside one organization', () => {
  it('CONTROL: reads the neighbour’s own role and exception when asked for them directly', async () => {
    const attributed = await attributedTeammate();

    expect(attributed).not.toBeNull();
    expect([...(attributed?.roles ?? [])].map((role) => role.name)).toEqual(['Contributor']);
    expect(attributed?.facts.granted).toContain('doc:read');
    expect(attributed?.overrides.get('doc:create')).toMatchObject({
      effect: 'ALLOW',
      reason: "helping the teammate's own onboarding docs along, reviewed weekly",
    });
  });

  it('does not attribute the neighbour’s role to ivan', async () => {
    const attributed = await attributedIvan();

    expect(attributed?.roles.map((role) => role.roleId)).not.toContain(seeded.contributorRoleId);
    expect(attributed?.roles.map((role) => role.name)).not.toContain('Contributor');
    // Not merely absent from `roles`: a subject predicate dropped from `userRole.findMany` would
    // union the neighbour's grant into `granted` too, through the very fold `attribution` above
    // relies on.
    expect(attributed?.facts.granted).not.toContain('kb_note:read');
  });

  it('does not attribute the neighbour’s personal exception — reason included — to ivan', async () => {
    const attributed = await attributedIvan();

    expect(attributed?.overrides.has('doc:create')).toBe(false);
    expect(attributed?.facts.granted).not.toContain('doc:create');

    // The reason is somebody else's sentence about a colleague, and this is what a subject predicate
    // actually protects: not the key, which is public information about the catalogue, but the
    // administrator's free-text explanation of a decision about a *named person*.
    const reasons = [...(attributed?.overrides.values() ?? [])].map((entry) => entry.reason);

    expect(reasons).not.toContain(
      "helping the teammate's own onboarding docs along, reviewed weekly",
    );
  });
});
