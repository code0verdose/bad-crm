import { randomUUID } from 'node:crypto';

import { type PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { type IdGeneratorPort } from '@/application/platform/ports/id-generator.port.js';
import { type LoggerPort } from '@/application/platform/ports/logger.port.js';
import { BootstrapOrganizationUseCase } from '@/application/organization/use-cases/bootstrap-organization.use-case.js';
import { ConflictError } from '@/domain/shared/errors/app.errors.js';
import { PrismaOrganizationRepository } from '@/infrastructure/persistence/prisma/organization.repository.js';
import { ProvisionSystemRolesUseCase } from '@/application/iam/use-cases/provision-system-roles.use-case.js';
import { PrismaRoleRepository } from '@/infrastructure/persistence/prisma/role.repository.js';
import { createPrismaClient } from '@/infrastructure/persistence/prisma/prisma.client.js';
import { PrismaUnitOfWork } from '@/infrastructure/persistence/prisma/unit-of-work.adapter.js';
import { requireTenant, withTenant } from '@/infrastructure/persistence/prisma/tenant.context.js';

import {
  asMaintenance,
  closePools,
  createPools,
  insertOrganizationWithOwner,
  truncateAll,
  type HarnessPools,
} from './db-harness.util.js';
import { ROW_FACTORIES } from './row-factories.util.js';

/**
 * The organization bootstrap against a real PostgreSQL.
 *
 * This is the one path in the codebase that opens a tenant scope for a tenant that does not exist
 * yet, so it is the one path where "the policies protect us" has to be demonstrated rather than
 * assumed. Three properties are asserted, and the last two are the reason the file exists:
 *
 *   1. it works — the organization, and everything written beside it, lands in one transaction;
 *   2. **through this path, another organization is not readable**;
 *   3. **through this path, another organization is not writable**.
 *
 * A stand-in stands in for the owner: `users` arrives with [EPIC-006] (STORY-006-01 creates the
 * table), and this suite must still observe a *second real write* inside the same transaction —
 * otherwise "one transaction" is a claim about a single statement, which is trivially true. `teams`
 * is that second write: a tenant-scoped table with the same policy shape, which rolls back with the
 * organization exactly as the users table will.
 */

const silentLogger: LoggerPort = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: (): LoggerPort => silentLogger,
};

/** An organization of somebody else, created before every test and never touched afterwards. */
const OTHER_ORG = randomUUID();

let pools: HarnessPools;
let base: PrismaClient;

const idsReturning = (id: string): IdGeneratorPort => ({
  next: () => id,
  uuid: () => id,
});

const draftFor = (slug: string) => ({
  name: 'Acme',
  slug,
  timezone: 'Europe/Berlin',
  defaultCurrency: 'EUR',
});

const owner = {
  email: 'owner@example.com',
  passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA',
  locale: 'en',
  timezone: 'UTC',
};

const useCaseFor = (organizationId: string): BootstrapOrganizationUseCase =>
  new BootstrapOrganizationUseCase(
    new PrismaUnitOfWork(base),
    new PrismaOrganizationRepository(),
    idsReturning(organizationId),
    new ProvisionSystemRolesUseCase(new PrismaRoleRepository()),
  );

const countUsers = async (): Promise<number> =>
  asMaintenance(pools.owner, async (client) =>
    Number((await client.query<{ count: string }>('SELECT count(*) FROM users')).rows[0]?.count),
  );

const countOrganizations = async (): Promise<number> =>
  asMaintenance(pools.owner, async (client) =>
    Number(
      (await client.query<{ count: string }>('SELECT count(*) FROM organizations')).rows[0]?.count,
    ),
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
  await asMaintenance(pools.owner, async (client) => {
    await ROW_FACTORIES.organizations(client, OTHER_ORG);
    await ROW_FACTORIES.teams(client, OTHER_ORG);
  });
});

describe('bootstrapping an organization', () => {
  it('CONTROL: creates the organization and its owner in one transaction', async () => {
    const organizationId = randomUUID();

    const result = await useCaseFor(organizationId).execute({
      organization: draftFor('acme'),
      owner,
    });

    expect(result.organizationId).toBe(organizationId);

    const rows = await asMaintenance(pools.owner, async (client) => ({
      organizations: (
        await client.query('SELECT id FROM organizations WHERE id = $1', [organizationId])
      ).rowCount,
      users: (
        await client.query('SELECT id FROM users WHERE organization_id = $1', [organizationId])
      ).rowCount,
    }));

    expect(rows).toEqual({ organizations: 1, users: 1 });
  });

  it('CONTROL: the new organization is readable under its own scope right away', async () => {
    const organizationId = randomUUID();

    await useCaseFor(organizationId).execute({
      organization: draftFor('acme'),
      owner,
    });

    const found = await withTenant(base, { organizationId, userId: null }, () =>
      new PrismaOrganizationRepository().findCurrent(),
    );

    expect(found).toEqual({
      id: organizationId,
      slug: 'acme',
      name: 'Acme',
      timezone: 'Europe/Berlin',
      defaultCurrency: 'EUR',
    });
  });

  /**
   * The first of the two questions this file exists to answer. The scope is opened as an
   * organization that does not exist yet — which means the policy predicate is an equality against
   * a uuid no row carries, and every other organization is outside it.
   */
  it('cannot read another organization through the bootstrap scope', async () => {
    const organizationId = randomUUID();
    const repository = new PrismaOrganizationRepository();

    const seen = await new PrismaUnitOfWork(base).withTenant(
      { organizationId, userId: null },
      async () => {
        const beforeCreate = await requireTenant('probe').tx.organization.findMany();

        await repository.createWithOwner(draftFor('acme'), owner);

        const afterCreate = await requireTenant('probe').tx.organization.findMany();

        return { beforeCreate: beforeCreate.length, afterCreate: afterCreate.map((row) => row.id) };
      },
    );

    // Nothing before the insert, and afterwards exactly one row: its own. The other organization
    // exists in the table the whole time — `truncateAll` + the fixture above guarantee it.
    expect(seen.beforeCreate).toBe(0);
    expect(seen.afterCreate).toEqual([organizationId]);
    expect(await countOrganizations()).toBe(2);
  });

  /** The second question: a write aimed at somebody else's tenant is refused, not silently kept. */
  it('cannot write into another organization through the bootstrap scope', async () => {
    const organizationId = randomUUID();

    const attempt = new PrismaUnitOfWork(base).withTenant(
      { organizationId, userId: null },
      async () => {
        await new PrismaOrganizationRepository().createWithOwner(draftFor('acme'), owner);

        await requireTenant('probe').tx.team.create({
          data: { organizationId: OTHER_ORG, name: 'Smuggled', slug: 'smuggled' },
        });
      },
    );

    await expect(attempt).rejects.toThrow();

    const teamsOfTheOther = await asMaintenance(
      pools.owner,
      async (client) =>
        (await client.query('SELECT id FROM teams WHERE organization_id = $1', [OTHER_ORG]))
          .rowCount,
    );

    // Only the fixture's own team: the smuggled row was refused *and* the transaction rolled back.
    expect(teamsOfTheOther).toBe(1);
  });

  /**
   * «Neither, or both», which is what the single statement buys and what used to rest on the
   * transaction alone.
   *
   * The previous version of this case forced the *second* write to fail and checked that the first was
   * rolled back. There is no second write any more — `createWithOwner` is one statement — so the
   * property worth asserting is the one a caller can observe: a refused registration leaves no
   * organization **and no orphaned user**, and an accepted one leaves exactly one of each.
   */
  it('writes the organization and its owner together, or neither', async () => {
    const takenSlug = `both-${randomUUID().slice(0, 8)}`;

    await asMaintenance(pools.owner, (client) =>
      insertOrganizationWithOwner(client, randomUUID(), { slug: takenSlug, name: 'Taken' }),
    );

    const before = { organizations: await countOrganizations(), users: await countUsers() };

    await expect(
      useCaseFor(randomUUID()).execute({ organization: draftFor(takenSlug), owner }),
    ).rejects.toBeInstanceOf(ConflictError);

    expect({ organizations: await countOrganizations(), users: await countUsers() }).toEqual(
      before,
    );

    const accepted = randomUUID();
    await useCaseFor(accepted).execute({ organization: draftFor('accepted'), owner });

    expect(await countOrganizations()).toBe(before.organizations + 1);
    expect(await countUsers()).toBe(before.users + 1);
  });

  /**
   * The slug is globally unique and the policy hides every other organization, so the unique index
   * is the only thing that can see the collision. It has to surface as a conflict a caller can act
   * on — a 409 — and not as the raw `P2002` that would be answered `500`.
   */
  it('reports a taken slug as a conflict, with no row left behind', async () => {
    const takenSlug = `taken-${randomUUID().slice(0, 8)}`;

    await asMaintenance(pools.owner, (client) =>
      insertOrganizationWithOwner(client, randomUUID(), { slug: takenSlug, name: 'Other' }),
    );

    const organizationId = randomUUID();
    const failure = await useCaseFor(organizationId)
      .execute({ organization: draftFor(takenSlug), owner })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ConflictError);
    expect((failure as ConflictError).code).toBe('organization_already_exists');
    expect((failure as ConflictError).status).toBe(409);

    const left = await asMaintenance(
      pools.owner,
      async (client) =>
        (await client.query('SELECT id FROM organizations WHERE id = $1', [organizationId]))
          .rowCount,
    );

    expect(left).toBe(0);
  });
});
