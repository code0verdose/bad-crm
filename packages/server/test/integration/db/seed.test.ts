import { type PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { type LoggerPort } from '@/application/platform/ports/logger.port.js';
import { BootstrapOrganizationUseCase } from '@/application/organization/use-cases/bootstrap-organization.use-case.js';
import { PrismaOrganizationRepository } from '@/infrastructure/persistence/prisma/organization.repository.js';
import { createPrismaClient } from '@/infrastructure/persistence/prisma/prisma.client.js';
import { SystemIdGeneratorAdapter } from '@/infrastructure/platform/system-id-generator.adapter.js';
import { PrismaUnitOfWork } from '@/infrastructure/persistence/prisma/unit-of-work.adapter.js';

import { SEED_ORGANIZATIONS } from '../../../scripts/seed-data.constant.js';
import { seedInstallation } from '../../../scripts/seed.util.js';

import {
  asMaintenance,
  closePools,
  createPools,
  truncateAll,
  type HarnessPools,
} from './db-harness.util.js';

/**
 * The seed against a real PostgreSQL.
 *
 * Two properties, and neither can be observed without the database. **Idempotency** is a statement
 * about a unique index: the seed does not ask whether an organization exists — a `SELECT ... WHERE
 * slug = $1` runs under row-level security and returns nothing for a tenant that is not the current
 * scope, so «not found» and «somebody else's» are the same answer. It writes, and reads the
 * conflict. That is only true against PostgreSQL with the policies applied.
 *
 * **Disjointness** is what the isolation scenarios of STORY-010-05 will compare, and a fixture whose
 * two tenants share a value cannot prove anything about isolation.
 *
 * The password digest is real argon2id and deliberately so: the fixture exists to be signed in with,
 * and a stub digest would make the e2e sign-in fail in a way that looks like a defect in
 * authentication.
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

/** A digest of the right shape, computed once: argon2id per run would cost seconds for nothing. */
const FAKE_DIGEST = '$argon2id$v=19$m=19456,t=2,p=1$c2VlZHNhbHQ$ZGlnZXN0';

const run = async (): ReturnType<typeof seedInstallation> =>
  seedInstallation({
    bootstrap: new BootstrapOrganizationUseCase(
      new PrismaUnitOfWork(base),
      new PrismaOrganizationRepository(),
      new SystemIdGeneratorAdapter(),
    ),
    hashPassword: () => Promise.resolve(FAKE_DIGEST),
  });

const countRows = async (table: 'organizations' | 'users'): Promise<number> =>
  asMaintenance(pools.owner, async (client) =>
    Number((await client.query<{ count: string }>(`SELECT count(*) FROM ${table}`)).rows[0]?.count),
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

describe('seeding an installation', () => {
  it('CONTROL: creates every declared organization with its owner', async () => {
    const summary = await run();

    expect(summary.organizations).toHaveLength(SEED_ORGANIZATIONS.length);
    expect(summary.organizations.every((organization) => organization.created)).toBe(true);
    expect(await countRows('organizations')).toBe(SEED_ORGANIZATIONS.length);
    expect(await countRows('users')).toBe(SEED_ORGANIZATIONS.length);
  });

  /**
   * The property the story is about: a second run must not be a second installation. Asserted on
   * the rows rather than on the return value alone — a summary saying «already there» while the
   * table grew would be the exact failure this test exists to catch.
   */
  it('leaves the same state when run twice', async () => {
    await run();
    const second = await run();

    expect(second.organizations.every((organization) => organization.created)).toBe(false);
    expect(await countRows('organizations')).toBe(SEED_ORGANIZATIONS.length);
    expect(await countRows('users')).toBe(SEED_ORGANIZATIONS.length);
  });

  it('gives each organization exactly one user, and none of the other one', async () => {
    await run();

    const perOrganization = await asMaintenance(pools.owner, async (client) =>
      (
        await client.query<{ slug: string; users: string }>(
          `SELECT o.slug, count(u.id)::text AS users
             FROM organizations o
             LEFT JOIN users u ON u.organization_id = o.id
            GROUP BY o.slug
            ORDER BY o.slug`,
        )
      ).rows.map((row) => ({ slug: row.slug, users: Number(row.users) })),
    );

    expect(perOrganization).toEqual(
      [...SEED_ORGANIZATIONS]
        .map((organization) => ({ slug: organization.slug, users: 1 }))
        .sort((left, right) => left.slug.localeCompare(right.slug)),
    );
  });

  /**
   * Seeded through the same use-case as registration, so the rows are subject to the same policies:
   * each owner is readable in the scope of their own organization and invisible in the other one.
   * The positive half is what makes the negative half mean something — without it, an empty result
   * proves only that the query was wrong.
   */
  it('writes rows that obey row-level security in both directions', async () => {
    await run();

    const organizations = await asMaintenance(
      pools.owner,
      async (client) =>
        (
          await client.query<{ id: string; slug: string }>(
            'SELECT id, slug FROM organizations ORDER BY slug',
          )
        ).rows,
    );
    const [first, second] = organizations;

    const usersVisibleIn = async (organizationId: string): Promise<string[]> => {
      const client = await pools.app.connect();

      try {
        await client.query('BEGIN');
        await client.query('SELECT set_config($1, $2, true)', [
          'app.organization_id',
          organizationId,
        ]);
        const { rows } = await client.query<{ email: string }>('SELECT email::text FROM users');
        await client.query('COMMIT');

        return rows.map((row) => row.email);
      } finally {
        client.release();
      }
    };

    expect(first).toBeDefined();
    expect(second).toBeDefined();

    const inFirst = await usersVisibleIn(first?.id ?? '');
    const inSecond = await usersVisibleIn(second?.id ?? '');

    expect(inFirst).toHaveLength(1);
    expect(inSecond).toHaveLength(1);
    expect(inFirst[0]).not.toBe(inSecond[0]);
  });
});
