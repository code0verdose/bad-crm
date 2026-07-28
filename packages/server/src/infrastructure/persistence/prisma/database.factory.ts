import { type PrismaClient } from '@prisma/client';

import { type LoggerPort } from '@/application/platform/ports/logger.port.js';
import { createPrismaClient } from '@/infrastructure/persistence/prisma/prisma.client.js';
import { guardedClient } from '@/infrastructure/persistence/prisma/tenant-guard.adapter.js';

/**
 * The database as the rest of the process sees it: two handles and a way to close them.
 *
 * Two, and the distinction is the whole point of `guardedClient`. `base` is the only handle that
 * may open a transaction, and exactly one function does — `withTenant`, which sets the tenant
 * context inside it. Everything else receives `guarded`, on which a model query outside a tenant
 * scope throws before a connection is taken from the pool.
 *
 * They are the same pool: `$extends` returns a view over the client, not a second one. Handing out
 * two clients would mean two pools, two connection limits and a shutdown that closes one of them.
 */
export interface DatabaseConnection {
  /** For `withTenant` and for the startup role probe, and for nothing else. */
  readonly base: PrismaClient;
  /** What the container hands to adapters: refuses any tenant-scoped query outside `withTenant`. */
  readonly guarded: PrismaClient;
  close(): Promise<void>;
}

export interface ConnectDatabaseOptions {
  readonly url: string;
  readonly logger: LoggerPort;
}

/**
 * Opens the pool. It does not verify the role it connected as — that is a separate step in
 * `startApiProcess`, so that "the port is opened only after the role was checked" is visible in the
 * startup sequence rather than buried inside a constructor.
 */
export const connectDatabase = ({ url, logger }: ConnectDatabaseOptions): DatabaseConnection => {
  const base = createPrismaClient({ url, logger });

  return {
    base,
    guarded: guardedClient(base),
    close: () => base.$disconnect(),
  };
};
