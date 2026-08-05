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

import { asMaintenance, closePools, createPools, truncateAll, type HarnessPools } from './db-harness.util.js';

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

const bootstrapFor = (organizationId: string): BootstrapOrganizationUseCase =>
  new BootstrapOrganizationUseCase(
    new PrismaUnitOfWork(base),
    new PrismaOrganizationRepository(),
    idsReturning(organizationId),
    new ProvisionSystemRolesUseCase(new PrismaRoleRepository()),
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

    expect(roles.map((role) => role.key).sort()).toEqual([...SharedPermissions.SYSTEM_ROLE_KEYS].sort());

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

    const visibleToFirst = await withTenant(base, { organizationId: first, userId: null }, (tx) => tx.role.count());

    expect(visibleToFirst).toBe(SharedPermissions.SYSTEM_ROLE_KEYS.length);
  });
});

describe('re-provisioning, which is what an upgrade does', () => {
  it('changes nothing on a second run', async () => {
    const organizationId = await createOrganization('acme');
    const before = await rolesOf(organizationId);

    await withTenant(base, { organizationId, userId: null }, () =>
      new ProvisionSystemRolesUseCase(new PrismaRoleRepository()).execute(),
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
      new ProvisionSystemRolesUseCase(new PrismaRoleRepository()).execute(),
    );

    const stray = await asMaintenance(pools.owner, async (client) =>
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
      new ProvisionSystemRolesUseCase(new PrismaRoleRepository()).execute(),
    );

    const custom = (await rolesOf(organizationId)).find((role) => role.key === 'reviewer');

    expect(custom).toEqual({ key: 'reviewer', grants: 1 });
  });
});
