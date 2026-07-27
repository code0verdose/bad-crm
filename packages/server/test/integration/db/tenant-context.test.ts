import { randomUUID } from 'node:crypto';

import { type PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { type LoggerPort } from '@/application/platform/ports/logger.port.js';
import { createPrismaClient } from '@/infrastructure/persistence/prisma/prisma.client.js';
import { guardedClient } from '@/infrastructure/persistence/prisma/tenant-guard.adapter.js';
import {
  CrossTenantNestingError,
  MissingTenantContextError,
  withTenant,
} from '@/infrastructure/persistence/prisma/tenant.context.js';

import {
  asMaintenance,
  closePools,
  createPools,
  truncateAll,
  type HarnessPools,
} from './db-harness.util.js';
import { ROW_FACTORIES } from './row-factories.util.js';

/**
 * The application-side wrapper, against the real database.
 *
 * The isolation suite proves the database refuses a query without context; this one proves the code
 * path an actual request takes ends up with that context set — and that the guard turns the
 * database's cryptic `42704` into a refusal naming the model, before a connection is even taken.
 */

const ORG_A = randomUUID();
const ORG_B = randomUUID();

const silentLogger: LoggerPort = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: (): LoggerPort => silentLogger,
};

let pools: HarnessPools;
let base: PrismaClient;
let guarded: PrismaClient;

beforeAll(() => {
  pools = createPools();
  base = createPrismaClient({ url: inject('databaseUrls').appUser, logger: silentLogger });
  guarded = guardedClient(base);
});

afterAll(async () => {
  await base.$disconnect();
  await closePools(pools);
});

beforeEach(async () => {
  await truncateAll(pools.owner);
  await asMaintenance(pools.owner, async (client) => {
    await ROW_FACTORIES.organizations(client, ORG_A);
    await ROW_FACTORIES.organizations(client, ORG_B);
    await ROW_FACTORIES.teams(client, ORG_B);
  });
});

describe('withTenant', () => {
  it('CONTROL: reads and writes the tenant’s own data', async () => {
    const created = await withTenant(base, { organizationId: ORG_A, userId: null }, (tx) =>
      tx.team.create({ data: { organizationId: ORG_A, name: 'Core', slug: 'core' } }),
    );

    const found = await withTenant(base, { organizationId: ORG_A, userId: null }, (tx) =>
      tx.team.findMany(),
    );

    expect(created.organizationId).toBe(ORG_A);
    expect(found.map((team) => team.id)).toEqual([created.id]);
  });

  it('does not show another tenant’s rows, even though they exist', async () => {
    const visible = await withTenant(base, { organizationId: ORG_A, userId: null }, (tx) =>
      tx.team.count(),
    );
    const total = await asMaintenance(pools.owner, async (client) =>
      Number((await client.query<{ count: string }>('SELECT count(*) FROM teams')).rows[0]?.count),
    );

    expect(total).toBe(1);
    expect(visible).toBe(0);
  });

  it('refuses to write a row into another tenant', async () => {
    const attempt = withTenant(base, { organizationId: ORG_A, userId: null }, (tx) =>
      tx.team.create({ data: { organizationId: ORG_B, name: 'Smuggled', slug: 'smuggled' } }),
    );

    await expect(attempt).rejects.toThrow();
  });

  it('refuses to switch tenant inside an open transaction', async () => {
    const attempt = withTenant(base, { organizationId: ORG_A, userId: null }, () =>
      withTenant(base, { organizationId: ORG_B, userId: null }, (tx) => tx.team.findMany()),
    );

    await expect(attempt).rejects.toBeInstanceOf(CrossTenantNestingError);
  });

  /**
   * The pool leak this project is most afraid of: a context set with `SET` instead of `SET LOCAL`
   * survives the transaction, returns to the pool and applies to the next request — of another
   * organization. Here the same physical connection is used again and has to have forgotten
   * everything (docs/security/rls-design.md, «Ловушки», 1).
   */
  it('leaves no context on the connection once the transaction is over', async () => {
    await withTenant(base, { organizationId: ORG_A, userId: null }, (tx) => tx.team.findMany());

    await expect(base.$queryRaw`SELECT count(*) FROM teams`).rejects.toThrow(/22P02|42704/);
  });
});

describe('guardedClient', () => {
  it('refuses a tenant-scoped query made outside withTenant', async () => {
    await expect(guarded.team.findMany()).rejects.toBeInstanceOf(MissingTenantContextError);
  });

  it('names the model and the operation, instead of leaving a Postgres error code', async () => {
    await expect(guarded.team.findMany()).rejects.toThrow(/Team\.findMany/);
  });

  it('CONTROL: lets the same query through inside withTenant', async () => {
    // Through `tx`, not through `guarded`: the transaction handle is the one carrying the context.
    // A model call on the client itself would run on a second connection — the guard would pass it
    // (a context is in effect) and the database would refuse it, which is the correct answer to a
    // query that escaped its own transaction.
    const teams = await withTenant(guarded, { organizationId: ORG_B, userId: null }, (tx) =>
      tx.team.findMany(),
    );

    expect(teams).toHaveLength(1);
  });
});
