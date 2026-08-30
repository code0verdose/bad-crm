import { randomUUID } from 'node:crypto';

import { type PrismaClient } from '@prisma/client';
import { SharedPermissions } from '@bad-crm/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { ProvisionSystemRolesUseCase } from '@/application/iam/use-cases/provision-system-roles.use-case.js';
import { type LoggerPort } from '@/application/platform/ports/logger.port.js';
import { BootstrapOrganizationUseCase } from '@/application/organization/use-cases/bootstrap-organization.use-case.js';
import { type IdGeneratorPort } from '@/application/platform/ports/id-generator.port.js';
import { PrismaOrganizationRepository } from '@/infrastructure/persistence/prisma/organization.repository.js';
import { PrismaRoleRepository } from '@/infrastructure/persistence/prisma/role.repository.js';
import { createPrismaClient } from '@/infrastructure/persistence/prisma/prisma.client.js';
import { PrismaUnitOfWork } from '@/infrastructure/persistence/prisma/unit-of-work.adapter.js';
import { withTenant } from '@/infrastructure/persistence/prisma/tenant.context.js';
import { HmacAddressHasher } from '@/infrastructure/crypto/address-hasher.adapter.js';
import { PrismaAuditLogger } from '@/infrastructure/persistence/prisma/audit-log.adapter.js';
import {
  type RequestContext,
  type RequestContextPort,
} from '@/application/platform/ports/request-context.port.js';
import { type AuditLoggerPort } from '@/application/platform/ports/audit-logger.port.js';

import {
  asMaintenance,
  closePools,
  createPools,
  insertOrganizationWithOwner,
  truncateAll,
  type HarnessPools,
} from './db-harness.util.js';

/**
 * The seven roles an organization starts with, against a real PostgreSQL.
 *
 * Three properties, and none of them can be observed without the database. They arrive **with** the
 * organization, in its transaction — an organization that existed for a moment with nobody able to
 * do anything is the failure this asserts against. Re-provisioning is idempotent, because the same
 * call runs on every upgrade: the composition of a system role is code, so a key added to the matrix
 * has to reach installations that already exist. And a **custom** role is never touched by it.
 */

const silentLogger: LoggerPort = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: (): LoggerPort => silentLogger,
};

let pools: HarnessPools;
let base: PrismaClient;

const idsReturning = (id: string): IdGeneratorPort => ({ next: () => id, uuid: () => id });

const RUN_ID = '00000000-0000-4000-8000-0000000000aa';

/** The context `pnpm db:provision-roles` opens: one identifier for the run, no person in it. */
const fixedRequestContext: RequestContextPort = {
  run: <T>(_context: RequestContext, fn: () => T): T => fn(),
  identify: () => undefined,
  current: () => ({ requestId: RUN_ID, organizationId: null, userId: null }),
};

const refusingUnscoped: AuditLoggerPort = {
  record: () => Promise.reject(new Error('an entry naming an organization must not land here')),
};

/** The real writer: these cases are about rows in `audit_logs`, so nothing about it is a double. */
const auditLogger = (): AuditLoggerPort =>
  new PrismaAuditLogger({
    addressHasher: new HmacAddressHasher(Buffer.alloc(32).toString('base64')),
    requestContext: fixedRequestContext,
    unscoped: refusingUnscoped,
  });

const provisioning = (): ProvisionSystemRolesUseCase =>
  new ProvisionSystemRolesUseCase(new PrismaRoleRepository(), auditLogger());

/** What the trail of one organization holds, newest last. */
const trailOf = async (
  organizationId: string,
): Promise<{ action: string; actorType: string; actorId: string | null; after: unknown }[]> =>
  asMaintenance(pools.owner, async (client) =>
    (
      await client.query<{
        action: string;
        actor_type: string;
        actor_id: string | null;
        after: unknown;
      }>(
        `SELECT action, actor_type, actor_id, after FROM audit_logs
          WHERE organization_id = $1 ORDER BY occurred_at, action`,
        [organizationId],
      )
    ).rows.map((row) => ({
      action: row.action,
      actorType: row.actor_type,
      actorId: row.actor_id,
      after: row.after,
    })),
  );

const bootstrapFor = (organizationId: string): BootstrapOrganizationUseCase =>
  new BootstrapOrganizationUseCase(
    new PrismaUnitOfWork(base),
    new PrismaOrganizationRepository(),
    idsReturning(organizationId),
    provisioning(),
  );

const createOrganization = async (slug: string): Promise<string> => {
  const organizationId = randomUUID();

  await bootstrapFor(organizationId).execute({
    organization: { name: 'Acme', slug, timezone: 'UTC', defaultCurrency: 'EUR' },
    owner: {
      email: `owner-${slug}@example.test`,
      passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA',
      locale: 'en',
      timezone: 'UTC',
    },
  });

  return organizationId;
};

const rolesOf = async (organizationId: string): Promise<{ key: string; grants: number }[]> =>
  asMaintenance(pools.owner, async (client) =>
    (
      await client.query<{ key: string; grants: string }>(
        `SELECT r.key, count(rp.id)::text AS grants
           FROM roles r
           LEFT JOIN role_permissions rp ON rp.role_id = r.id
          WHERE r.organization_id = $1
          GROUP BY r.key
          ORDER BY r.key`,
        [organizationId],
      )
    ).rows.map((row) => ({ key: row.key, grants: Number(row.grants) })),
  );

beforeAll(() => {
  pools = createPools();
  base = createPrismaClient({ url: inject('databaseUrls').appUser, logger: silentLogger });
});

afterAll(async () => {
  await base.$disconnect();
  await closePools(pools);
});

beforeEach(async () => {
  await truncateAll(pools.owner);
});

describe('an organization gets its roles when it is created', () => {
  it('CONTROL: creates the seven system roles, with the grants the matrix describes', async () => {
    const organizationId = await createOrganization('acme');
    const roles = await rolesOf(organizationId);

    expect(roles.map((role) => role.key).sort()).toEqual(
      [...SharedPermissions.SYSTEM_ROLE_KEYS].sort(),
    );

    const owner = roles.find((role) => role.key === 'owner');

    expect(owner?.grants).toBe(SharedPermissions.PERMISSIONS.length);
  });

  it('marks exactly one of them as the default', async () => {
    const organizationId = await createOrganization('acme');

    const defaults = await asMaintenance(pools.owner, async (client) =>
      (
        await client.query<{ key: string }>(
          'SELECT key FROM roles WHERE organization_id = $1 AND is_default',
          [organizationId],
        )
      ).rows.map((row) => row.key),
    );

    expect(defaults).toEqual([SharedPermissions.DEFAULT_SYSTEM_ROLE]);
  });

  it('gives another organization its own roles, and only its own', async () => {
    const first = await createOrganization('acme');
    const second = await createOrganization('globex');

    const [mine, theirs] = await Promise.all([rolesOf(first), rolesOf(second)]);

    expect(mine).toHaveLength(SharedPermissions.SYSTEM_ROLE_KEYS.length);
    expect(theirs).toHaveLength(SharedPermissions.SYSTEM_ROLE_KEYS.length);

    const visibleToFirst = await withTenant(base, { organizationId: first, userId: null }, (tx) =>
      tx.role.count(),
    );

    expect(visibleToFirst).toBe(SharedPermissions.SYSTEM_ROLE_KEYS.length);
  });
});

describe('re-provisioning, which is what an upgrade does', () => {
  it('changes nothing on a second run', async () => {
    const organizationId = await createOrganization('acme');
    const before = await rolesOf(organizationId);

    await withTenant(base, { organizationId, userId: null }, () =>
      provisioning().execute({ organizationId }),
    );

    expect(await rolesOf(organizationId)).toEqual(before);
  });

  /**
   * The property an upgrade depends on: a permission removed from a system role in a release
   * disappears from installations that already exist. Simulated by granting the administrator
   * something the matrix does not — the next provisioning must take it away.
   */
  it('replaces the grants of a system role rather than merging into them', async () => {
    const organizationId = await createOrganization('acme');

    await asMaintenance(pools.owner, async (client) => {
      await client.query(
        `INSERT INTO role_permissions (organization_id, role_id, permission_key, updated_at)
         SELECT $1, id, 'invoice:issue', now() FROM roles
          WHERE organization_id = $1 AND key = 'admin'`,
        [organizationId],
      );
    });

    await withTenant(base, { organizationId, userId: null }, () =>
      provisioning().execute({ organizationId }),
    );

    const stray = await asMaintenance(
      pools.owner,
      async (client) =>
        (
          await client.query(
            `SELECT rp.id FROM role_permissions rp
             JOIN roles r ON r.id = rp.role_id
            WHERE r.organization_id = $1 AND r.key = 'admin' AND rp.permission_key = 'invoice:issue'`,
            [organizationId],
          )
        ).rowCount,
    );

    expect(stray).toBe(0);
  });

  /**
   * Acceptance 7, second half: an upgrade that moves rights leaves a record of it.
   *
   * The composition of a system role is code, so `pnpm db:provision-roles` can change what people
   * may do in every organization of an installation at once. Until this case existed it did so in
   * silence — «people held rights on Monday they did not hold on Friday, and the journal says
   * nothing». Written against the real table rather than a double, because the two properties worth
   * proving are properties of the row: it is filed inside the organization whose rights moved, and
   * `actor_type` says `SYSTEM` because the writer found no person in the actor.
   */
  it('records the change as SYSTEM in the trail of the organization it changed', async () => {
    const organizationId = await createOrganization('acme');

    // A key the release removed: the administrator holds `invoice:issue`, the matrix does not give
    // it, so the next provisioning revokes it — a rights change of exactly the shape an upgrade makes.
    await asMaintenance(pools.owner, async (client) => {
      await client.query(
        `INSERT INTO role_permissions (organization_id, role_id, permission_key, updated_at)
         SELECT $1, id, 'invoice:issue', now() FROM roles
          WHERE organization_id = $1 AND key = 'admin'`,
        [organizationId],
      );
    });

    await withTenant(base, { organizationId, userId: null }, () =>
      provisioning().execute({ organizationId }),
    );

    const trail = await trailOf(organizationId);

    expect(trail).toHaveLength(1);
    expect(trail[0]?.action).toBe('role.updated');
    expect(trail[0]?.actorType).toBe('SYSTEM');
    expect(trail[0]?.actorId).toBeNull();
    expect(trail[0]?.after).toMatchObject({
      key: 'admin',
      revoked: ['invoice:issue'],
      granted: [],
    });
  });

  /**
   * CONTROL for the case above, and the reason the trail stays readable: the command runs on every
   * upgrade against every organization of the installation, and a run that changed nothing must
   * leave nothing. Without this, an installation of hundreds of tenants would file hundreds of
   * «nothing happened» entries per release and the entry above would be unfindable among them.
   */
  it('CONTROL: writes nothing when the re-run changed nothing', async () => {
    const organizationId = await createOrganization('acme');

    await withTenant(base, { organizationId, userId: null }, () =>
      provisioning().execute({ organizationId }),
    );

    expect(await trailOf(organizationId)).toEqual([]);
  });

  /**
   * And the other half: a role the organization made is its own. An upgrade that rewrote it would
   * silently change who can do what in an installation nobody asked.
   */
  it('leaves a custom role untouched', async () => {
    const organizationId = await createOrganization('acme');

    await asMaintenance(pools.owner, async (client) => {
      await client.query(
        `INSERT INTO roles (organization_id, key, name, is_system, updated_at)
         VALUES ($1, 'reviewer', 'Reviewer', false, now())`,
        [organizationId],
      );
      await client.query(
        `INSERT INTO role_permissions (organization_id, role_id, permission_key, updated_at)
         SELECT $1, id, 'task:read', now() FROM roles
          WHERE organization_id = $1 AND key = 'reviewer'`,
        [organizationId],
      );
    });

    await withTenant(base, { organizationId, userId: null }, () =>
      provisioning().execute({ organizationId }),
    );

    const custom = (await rolesOf(organizationId)).find((role) => role.key === 'reviewer');

    expect(custom).toEqual({ key: 'reviewer', grants: 1 });
  });

  /**
   * The upgrade scenario: an organization created without roles (e.g., restored from an old backup,
   * or bootstrapped with a broken version) gets them back when `ProvisionSystemRolesUseCase` runs
   * again. This simulates the call that `pnpm db:provision-roles` will make in the upgrade flow.
   */
  it('adds missing system roles to an organization that has none', async () => {
    const organizationId = randomUUID();
    const ownerId = randomUUID();

    // Create an organization and owner without system roles, simulating a broken installation
    // (e.g., restored from a backup predating EPIC-011)
    await asMaintenance(pools.owner, async (client) => {
      // Create both in order: user first, then organization with owner reference
      await client.query(
        `WITH created_organization AS (
           INSERT INTO organizations (id, owner_id, slug, name, updated_at)
           VALUES ($1::uuid, $2::uuid, 'orphan', 'Orphan Org', now())
           RETURNING id
         )
         INSERT INTO users (id, organization_id, email, password_hash, status, updated_at)
         VALUES ($2::uuid, $1::uuid, 'owner@example.test', 'placeholder-not-a-credential', 'ACTIVE', now())`,
        [organizationId, ownerId],
      );
    });

    // Verify it has no roles before provisioning
    const before = await rolesOf(organizationId);
    expect(before).toHaveLength(0);

    // Provision roles as the upgrade procedure would
    await withTenant(base, { organizationId, userId: null }, () =>
      provisioning().execute({ organizationId }),
    );

    // Verify all seven system roles are now present
    const after = await rolesOf(organizationId);
    expect(after.map((role) => role.key).sort()).toEqual(
      [...SharedPermissions.SYSTEM_ROLE_KEYS].sort(),
    );

    // Verify grants are correct (owner has all permissions)
    const owner = after.find((role) => role.key === 'owner');
    expect(owner?.grants).toBe(SharedPermissions.PERMISSIONS.length);

    // Verify the default role is marked
    const defaults = await asMaintenance(pools.owner, async (client) =>
      (
        await client.query<{ key: string }>(
          'SELECT key FROM roles WHERE organization_id = $1 AND is_default',
          [organizationId],
        )
      ).rows.map((row) => row.key),
    );
    expect(defaults).toEqual([SharedPermissions.DEFAULT_SYSTEM_ROLE]);
  });
});

/**
 * The step above provisions **one** organization it was handed. `pnpm db:provision-roles` has to
 * find them all first, and that half is where this feature actually broke.
 *
 * Enumerating organizations is a read across tenants, and `USING` governs reads: without the
 * maintenance switch the query is not "unfiltered because it is only a read" — it returns nothing.
 * The first implementation left the switch out on exactly that reasoning, printed
 * «✓ system roles provisioned for 0 organizations» against a database holding five, and exited 0.
 * Every assertion in the describe block above stayed green throughout, because each one hands the
 * use-case an id it already knows.
 *
 * So the property under test here is the one no per-organization test can see: that the list is
 * empty without the switch and complete with it. A regression turns the upgrade back into a no-op
 * that reports success, which is worse than a failure — the operator has no reason to look again.
 */
describe('finding the organizations an upgrade has to visit', () => {
  const idsIn = async (maintenance: boolean): Promise<string[]> => {
    const read = async (client: {
      query: (sql: string) => Promise<{ rows: { id: string }[] }>;
    }): Promise<string[]> =>
      (await client.query('SELECT id FROM organizations')).rows.map((row) => row.id);

    if (maintenance) return asMaintenance(pools.owner, read);

    const client = await pools.owner.connect();

    try {
      return await read(client);
    } finally {
      client.release();
    }
  };

  it('sees every organization under the maintenance switch, and none without it', async () => {
    const first = randomUUID();
    const second = randomUUID();

    await asMaintenance(pools.owner, async (client) => {
      await insertOrganizationWithOwner(client, first, { slug: `up-a-${first.slice(0, 8)}` });
      await insertOrganizationWithOwner(client, second, { slug: `up-b-${second.slice(0, 8)}` });
    });

    // The positive control comes first: without it, a harness that inserted nothing would satisfy
    // "invisible without the switch" perfectly, and the assertion below would be measuring an empty
    // database rather than row-level security.
    expect((await idsIn(true)).sort()).toEqual([first, second].sort());

    expect(await idsIn(false)).toEqual([]);
  });
});
