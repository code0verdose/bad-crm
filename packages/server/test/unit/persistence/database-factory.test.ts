import { afterEach, describe, expect, it } from 'vitest';

import { type LoggerPort } from '@/application/platform/ports/logger.port.js';
import {
  connectDatabase,
  type DatabaseConnection,
} from '@/infrastructure/persistence/prisma/database.factory.js';
import { MissingTenantContextError } from '@/infrastructure/persistence/prisma/tenant.errors.js';

/**
 * The composition root hands out two handles over one pool, and the difference between them is what
 * makes "every query runs inside `withTenant`" true rather than aspirational.
 *
 * No database is needed to observe it: Prisma connects lazily, and the guard refuses **before** the
 * query is sent — which is the property under test. A connection attempt here would mean the guard
 * had already let the call through.
 */

const silentLogger: LoggerPort = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: (): LoggerPort => silentLogger,
};

/** Never dialled: no statement in this file gets past the guard. */
const UNREACHABLE_URL = 'postgresql://app_user:unused@127.0.0.1:1/bad_crm';

let connection: DatabaseConnection | undefined;

const open = (): DatabaseConnection => {
  connection = connectDatabase({ url: UNREACHABLE_URL, logger: silentLogger });

  return connection;
};

afterEach(async () => {
  await connection?.close();
  connection = undefined;
});

describe('connectDatabase', () => {
  it('hands out a guarded view beside the base client, not the same object', () => {
    const database = open();

    expect(database.guarded).not.toBe(database.base);
  });

  /**
   * The guarded handle is the one everything except `withTenant` receives. A model call on it
   * outside a tenant scope must fail in process, naming the model — not travel to PostgreSQL and
   * come back as `42704 unrecognized configuration parameter`.
   */
  it('refuses a tenant-scoped query on the guarded handle, without reaching the database', async () => {
    const database = open();

    await expect(database.guarded.team.findMany()).rejects.toBeInstanceOf(
      MissingTenantContextError,
    );
  });

  it('closes the pool through the base client, which is the one that owns it', async () => {
    const database = open();

    await expect(database.close()).resolves.toBeUndefined();
  });
});
