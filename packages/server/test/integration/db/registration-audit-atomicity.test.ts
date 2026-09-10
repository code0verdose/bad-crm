import { type PrismaClient } from '@prisma/client';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { buildContainer } from '@/infrastructure/bootstrap/container.factory.js';
import { AUDIT_WRITE_DEGRADED_EVENT } from '@/infrastructure/logging/degrading-audit-logger.adapter.js';
import { type LoggerPort } from '@/application/platform/ports/logger.port.js';
import { createRootLogger } from '@/infrastructure/logging/pino-logger.adapter.js';
import { type DatabaseConnection } from '@/infrastructure/persistence/prisma/database.factory.js';
import { createPrismaClient } from '@/infrastructure/persistence/prisma/prisma.client.js';
import { guardedClient } from '@/infrastructure/persistence/prisma/tenant-guard.adapter.js';

import { testEnv } from '../../support/test-app.util.js';

import {
  asMaintenance,
  closePools,
  createPools,
  truncateAll,
  type HarnessPools,
} from './db-harness.util.js';

/**
 * Registration and its `organization.registered` row commit together or not at all — proved on the
 * chain the process actually hands out, against a real PostgreSQL.
 *
 * ## Why the unit suites could not prove this
 *
 * `register-organization.use-case.test.ts` shows the record is written *inside* the transaction
 * that creates the tenant, and `bootstrap-organization.use-case.test.ts` shows a rejection from
 * `inSameTransaction` rolls the tenant back. Both are true of the seam and neither is a statement
 * about the product: the sink in both is a double that rejects, and what the real adapter does
 * with a failed insert is decided by the **severity** of the action
 * (`degradable-audit-actions.util.ts`). Until 2026-09-10 `organization.registered` was `INFO`, so
 * the real chain fenced the insert in a savepoint, swallowed the failure one layer up, and
 * committed an organization with no record of who created it — while every unit test around the
 * seam stayed green. The premise «the row commits with the tenant or not at all» was a claim about
 * a call site; atomicity rests on the severity, and this file is where that is observed rather
 * than reasoned about.
 *
 * ## How the failure is induced
 *
 * The container is built on a `DatabaseConnection` whose transactions hand out a client identical
 * to the real one in everything but `auditLog.create`, which issues a statement PostgreSQL refuses
 * (`SELECT 1/0`, `22012`) — inside the transaction, after it was sent, so the transaction is
 * genuinely aborted the way a refused insert leaves it. Everything else — the tenant `set_config`
 * calls, the single-statement creation of the organization and its owner, the seven system roles,
 * argon2id, the rate limiter on a real Redis — is the product's own code on the product's own
 * adapters.
 */

/** Same major as `docker-compose.yml`; the budget below is Lua running on this server. */
const REDIS_IMAGE = 'redis:8.8.1-alpine';

type Transaction = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

interface Line {
  readonly event?: string;
  readonly action?: string;
}

/** A view over a real client that behaves the same in everything but `$transaction`. */
const viewOf = <T extends object>(target: T, override: (property: PropertyKey) => unknown): T =>
  new Proxy(target, {
    get(inner, property, receiver) {
      const replaced = override(property);

      if (replaced !== undefined) return replaced;

      const value: unknown = Reflect.get(inner, property, receiver);

      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(inner)
        : value;
    },
  });

/** The real pool, except that every audit insert fails inside the database. */
const withFailingAuditInsert = (real: PrismaClient): PrismaClient =>
  viewOf(real, (property) => {
    if (property !== '$transaction') return undefined;

    return (fn: (tx: Transaction) => Promise<unknown>, options?: unknown): Promise<unknown> =>
      real.$transaction(
        (tx) =>
          fn(
            viewOf(tx, (txProperty) =>
              txProperty === 'auditLog'
                ? { create: (): Promise<unknown> => tx.$queryRawUnsafe('SELECT 1/0') }
                : undefined,
            ),
          ),
        options as never,
      );
  });

const capturing = (): { lines: Line[]; write: (line: string) => void } => {
  const lines: Line[] = [];

  return { lines, write: (line) => lines.push(JSON.parse(line) as Line) };
};

const silent: LoggerPort = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: (): LoggerPort => silent,
};

let pools: HarnessPools;
let base: PrismaClient;
let redisContainer: StartedRedisContainer;
let redis: Redis;

const connection = (client: PrismaClient): DatabaseConnection => ({
  base: client,
  guarded: guardedClient(client),
  close: () => Promise.resolve(),
});

const containerOn = (client: PrismaClient) => {
  const destination = capturing();
  const container = buildContainer({
    env: testEnv({ REGISTRATION_OPEN: true }),
    logger: createRootLogger({ level: 'error', version: '0.0.0' }, destination),
    database: connection(client),
    redis: { client: redis, close: () => Promise.resolve() },
  });

  return { register: container.http.identity.register, lines: destination.lines };
};

const registration = (slug: string, ipAddress: string) => ({
  organization: { name: 'Acme', slug },
  owner: { email: `owner-${slug}@example.test`, password: 'correct-horse-battery' },
  client: { userAgent: 'vitest', ipAddress },
});

const organizationsWithSlug = (slug: string): Promise<number> =>
  asMaintenance(pools.owner, async (client) => {
    const result = await client.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM organizations WHERE slug = $1',
      [slug],
    );

    return Number(result.rows[0]?.count);
  });

const registeredEntries = (): Promise<
  { action: string; actor_type: string; actor_id: string | null }[]
> =>
  asMaintenance(pools.owner, async (client) => {
    const result = await client.query<{
      action: string;
      actor_type: string;
      actor_id: string | null;
    }>(
      `SELECT action, actor_type, actor_id FROM audit_logs WHERE action = 'organization.registered'`,
    );

    return result.rows;
  });

beforeAll(async () => {
  pools = createPools();
  base = createPrismaClient({ url: inject('databaseUrls').appUser, logger: silent });
  redisContainer = await new RedisContainer(REDIS_IMAGE).start();
  redis = new Redis(redisContainer.getConnectionUrl());
  await redis.ping();
}, 300_000);

beforeEach(async () => {
  await truncateAll(pools.owner);
  await redis.flushall();
});

afterAll(async () => {
  redis.disconnect();
  await redisContainer.stop();
  await base.$disconnect();
  await closePools(pools);
});

describe('organization.registered on the chain the process wires', () => {
  it('rolls the registration back when its row cannot be written — no organization, no swallow', async () => {
    const { register, lines } = containerOn(withFailingAuditInsert(base));

    // The database's own refusal, not the limiter's and not a guard's: the failure that reaches the
    // caller is the one the audit insert produced inside the transaction.
    await expect(register.execute(registration('acme-refused', '203.0.113.10'))).rejects.toThrow(
      /division by zero|22012/,
    );

    expect(await organizationsWithSlug('acme-refused')).toBe(0);
    expect(await registeredEntries()).toEqual([]);
    // Not degraded: a swallowed failure would have left this line and a committed tenant behind it.
    expect(lines.filter((line) => line.event === AUDIT_WRITE_DEGRADED_EVENT)).toEqual([]);
  });

  /**
   * CONTROL: the same chain on a healthy database writes exactly one row, and it names the owner —
   * the person the trail says created the tenant. Without this the case above would also pass for
   * a chain that refuses every registration.
   */
  it('CONTROL: writes exactly one row naming the owner on the happy path', async () => {
    const { register, lines } = containerOn(base);

    const result = await register.execute(registration('acme-created', '203.0.113.11'));

    expect(await organizationsWithSlug('acme-created')).toBe(1);
    expect(await registeredEntries()).toEqual([
      { action: 'organization.registered', actor_type: 'USER', actor_id: result.user.id },
    ]);
    expect(lines.filter((line) => line.event === AUDIT_WRITE_DEGRADED_EVENT)).toEqual([]);
  });
});
