import { type PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { SharedPermissions } from '@bad-crm/shared';

import { type LoggerPort } from '@/application/platform/ports/logger.port.js';
import { createPrismaClient } from '@/infrastructure/persistence/prisma/prisma.client.js';

import { planCatalog } from '../../../scripts/seed-permissions.util.js';
import { asMaintenance, closePools, createPools, type HarnessPools } from './db-harness.util.js';

/**
 * The catalogue table against a real PostgreSQL: what the seed writes, and what the application may
 * do with it afterwards.
 *
 * Two properties need the database and cannot be observed anywhere else. **Idempotency** is one — a
 * second run must leave the same rows, and «the same» includes a row an operator edited by hand
 * being corrected back to what the code says. **The privilege** is the other, and it is the point of
 * the table being global: `app_user` reads the catalogue and must never write it, because an
 * application that could write it could grant itself a permission.
 */

const silentLogger: LoggerPort = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: (): LoggerPort => silentLogger,
};

let pools: HarnessPools;
let asApplication: PrismaClient;
let asMigrator: PrismaClient;

/** The same two statements `scripts/seed-permissions.ts` runs, over the migration connection. */
const seed = async (): Promise<void> => {
  const existing = await asMigrator.permission.findMany({
    select: { key: true, deprecatedAt: true },
  });
  const plan = planCatalog(existing);

  await asMigrator.$transaction([
    ...plan.upsert.map((permission) =>
      asMigrator.permission.upsert({
        where: { key: permission.key },
        create: permission,
        update: { ...permission, deprecatedAt: null },
      }),
    ),
    asMigrator.permission.updateMany({
      where: { key: { in: [...plan.deprecate] } },
      data: { deprecatedAt: new Date() },
    }),
  ]);
};

beforeAll(() => {
  pools = createPools();
  asApplication = createPrismaClient({ url: inject('databaseUrls').appUser, logger: silentLogger });
  asMigrator = createPrismaClient({ url: inject('databaseUrls').migrator, logger: silentLogger });
});

afterAll(async () => {
  await Promise.all([asApplication.$disconnect(), asMigrator.$disconnect()]);
  await closePools(pools);
});

beforeEach(async () => {
  await asMaintenance(pools.owner, async (client) => {
    await client.query('DELETE FROM permissions');
  });
});

describe('seeding the permission catalogue', () => {
  it('CONTROL: writes every key the code declares', async () => {
    await seed();

    const count = await asMigrator.permission.count();

    expect(count).toBe(SharedPermissions.PERMISSIONS.length);
  });

  it('leaves the same rows when run twice, and corrects a hand-edited one', async () => {
    await seed();
    await asMigrator.permission.update({
      where: { key: 'task:update' },
      data: { isDangerous: true, category: 'nonsense' },
    });

    await seed();

    const corrected = await asMigrator.permission.findUniqueOrThrow({
      where: { key: 'task:update' },
    });

    expect(await asMigrator.permission.count()).toBe(SharedPermissions.PERMISSIONS.length);
    expect(corrected.isDangerous).toBe(SharedPermissions.PERMISSION_META['task:update'].dangerous);
    expect(corrected.category).toBe(SharedPermissions.PERMISSION_META['task:update'].domain);
  });

  /**
   * The property the whole `deprecatedAt` column exists for: a key that leaves the code leaves the
   * catalogue **as a marked row**, because rows elsewhere reference permissions by name and a
   * delete would break every installation where somebody had granted it.
   */
  it('marks a key that is no longer in the code instead of deleting it', async () => {
    await seed();
    await asMigrator.permission.create({
      data: { key: 'legacy:thing', resource: 'legacy', action: 'thing', category: 'platform' },
    });

    await seed();

    const legacy = await asMigrator.permission.findUnique({ where: { key: 'legacy:thing' } });

    expect(legacy).not.toBeNull();
    expect(legacy?.deprecatedAt).not.toBeNull();
    expect(SharedPermissions.isPermissionKey('legacy:thing')).toBe(false);
  });

  it('clears the mark when a key comes back', async () => {
    await seed();
    await asMigrator.permission.update({
      where: { key: 'task:update' },
      data: { deprecatedAt: new Date() },
    });

    await seed();

    const revived = await asMigrator.permission.findUniqueOrThrow({ where: { key: 'task:update' } });

    expect(revived.deprecatedAt).toBeNull();
  });
});

describe('what the application may do with the catalogue', () => {
  beforeEach(async () => {
    await seed();
  });

  it('reads it, without a tenant scope — it belongs to no organization', async () => {
    const permission = await asApplication.permission.findUnique({ where: { key: 'task:read' } });

    expect(permission?.resource).toBe('task');
  });

  it.each([
    [
      'insert',
      async (): Promise<unknown> =>
        asApplication.permission.create({
          data: { key: 'invented:key', resource: 'invented', action: 'key', category: 'platform' },
        }),
    ],
    [
      'update',
      async (): Promise<unknown> =>
        asApplication.permission.update({
          where: { key: 'task:read' },
          data: { isDangerous: true },
        }),
    ],
    [
      'delete',
      async (): Promise<unknown> =>
        asApplication.permission.delete({ where: { key: 'task:read' } }),
    ],
  ])('cannot %s: an application that could would grant itself a permission', async (_case, write) => {
    await expect(write()).rejects.toThrow(/permission denied/i);
  });
});
