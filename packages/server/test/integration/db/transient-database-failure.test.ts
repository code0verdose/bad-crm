import { randomUUID } from 'node:crypto';

import { type PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { type LoggerPort } from '@/application/platform/ports/logger.port.js';
import { ServiceUnavailableError } from '@/domain/shared/errors/app.errors.js';
import { createPrismaClient } from '@/infrastructure/persistence/prisma/prisma.client.js';
import {
  requireTenant,
  withTenant,
  type TxClient,
} from '@/infrastructure/persistence/prisma/tenant.context.js';
import { translateTransientDatabaseFailure } from '@/infrastructure/persistence/prisma/transient-database-failure.util.js';
import { PrismaUnitOfWork } from '@/infrastructure/persistence/prisma/unit-of-work.adapter.js';

import {
  asMaintenance,
  closePools,
  createPools,
  truncateAll,
  type HarnessPools,
} from './db-harness.util.js';
import { ROW_FACTORIES } from './row-factories.util.js';

/**
 * Transient database failures produced for real — by PostgreSQL 16 and Prisma 6.19.3 — and what the
 * unit of work turns them into.
 *
 * This is the file that pins the **shapes** the translation reads (`rules/agent-orchestration.mdc`
 * A.4.4, «замер вместо предположения»). Two of them were not what the finding that started this
 * work assumed:
 *
 * - a deadlock or a lock timeout hit by a **model call** is not `P2034`. It is
 *   `PrismaClientUnknownRequestError` with no `code`, and the SQLSTATE lives only in the message.
 *   `P2034` is what a model call gets for a *serialization* failure;
 * - the same failure in a **raw** statement is `P2010` with the SQLSTATE in `meta.code`.
 *
 * A Prisma upgrade that changes either shape turns this suite red — and, until somebody looks,
 * leaves the failure answered `500`, which is loud rather than wrong.
 *
 * The transactions run through the `PrismaUnitOfWork` the product wires wherever the question is
 * «what does a request get». The two `P2028` shapes need a transaction ceiling far below the
 * product's five seconds to be produced in a test, and the port takes no options, so those two call
 * `withTenant` directly and hand the real error to the translation.
 */

const ORG = randomUUID();

const silentLogger: LoggerPort = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: (): LoggerPort => silentLogger,
};

let pools: HarnessPools;
let base: PrismaClient;
let unitOfWork: PrismaUnitOfWork;
let teamA: string;
let teamB: string;

beforeAll(() => {
  pools = createPools();
  base = createPrismaClient({ url: inject('databaseUrls').appUser, logger: silentLogger });
  unitOfWork = new PrismaUnitOfWork(base);
});

afterAll(async () => {
  await base.$disconnect();
  await closePools(pools);
});

beforeEach(async () => {
  await truncateAll(pools.owner);
  [teamA, teamB] = await asMaintenance(pools.owner, async (client) => {
    await ROW_FACTORIES.organizations(client, ORG);
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO teams (organization_id, name, slug, updated_at)
       VALUES ($1::uuid, 'Alpha', 'alpha', now()), ($1::uuid, 'Beta', 'beta', now())
       RETURNING id`,
      [ORG],
    );

    return [rows[0]?.id ?? '', rows[1]?.id ?? ''];
  });
});

/** The transaction of the scope, the way a repository reaches it. */
const tx = (): TxClient => requireTenant('transient-database-failure.test').tx;

const inScope = <T>(work: () => Promise<T>): Promise<T> =>
  unitOfWork.withTenant({ organizationId: ORG, userId: null }, work);

/**
 * Another session holding the row lock of `teamId` until released — what a concurrent request in
 * the middle of its own write looks like to this one.
 */
const holdRowLock = async (teamId: string): Promise<() => Promise<void>> => {
  const client = await pools.owner.connect();

  await client.query('BEGIN');
  await client.query(`SELECT set_config('app.maintenance', 'on', true)`);
  await client.query('SELECT 1 FROM teams WHERE id = $1::uuid FOR UPDATE', [teamId]);

  return async () => {
    await client.query('ROLLBACK');
    client.release();
  };
};

const rename = (teamId: string, name: string, raw: boolean): Promise<unknown> =>
  raw
    ? tx().$executeRaw`UPDATE teams SET name = ${name} WHERE id = ${teamId}::uuid`
    : tx().team.update({ where: { id: teamId }, data: { name } });

/**
 * Two transactions taking two rows in opposite order, held at a barrier until both hold their first
 * lock — so the deadlock is certain rather than a matter of scheduling luck.
 */
const deadlock = async (raw: boolean): Promise<PromiseSettledResult<unknown>[]> => {
  let holding = 0;
  let bothHold!: () => void;
  const barrier = new Promise<void>((resolve) => {
    bothHold = resolve;
  });

  const writer = (first: string, second: string) =>
    inScope(async () => {
      await rename(first, 'first', raw);
      holding += 1;
      if (holding === 2) bothHold();
      await barrier;
      await rename(second, 'second', raw);
    });

  return Promise.allSettled([writer(teamA, teamB), writer(teamB, teamA)]);
};

const refusalOf = (outcomes: PromiseSettledResult<unknown>[]): unknown[] =>
  outcomes.flatMap((outcome) => (outcome.status === 'rejected' ? [outcome.reason] : []));

const expectTransient = (error: unknown, reason: string): void => {
  expect(error).toBeInstanceOf(ServiceUnavailableError);
  expect(error).toMatchObject({
    code: 'service_unavailable',
    retryAfterSeconds: 1,
    details: { dependency: 'postgres', reason },
  });
};

describe('through the unit of work', () => {
  it('CONTROL: an uncontended write commits', async () => {
    await inScope(() => rename(teamA, 'renamed', false));

    const { rows } = await asMaintenance(pools.owner, (client) =>
      client.query<{ name: string }>('SELECT name FROM teams WHERE id = $1::uuid', [teamA]),
    );

    expect(rows[0]?.name).toBe('renamed');
  });

  it('answers the deadlock victim of two model calls with 503 — and lets the survivor commit', async () => {
    const outcomes = await deadlock(false);
    const refusals = refusalOf(outcomes);

    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(refusals).toHaveLength(1);
    expectTransient(refusals[0], 'deadlock_detected');
    expect((refusals[0] as ServiceUnavailableError).details).toMatchObject({ sqlState: '40P01' });
  });

  it('answers the deadlock victim of two raw statements with 503', async () => {
    const refusals = refusalOf(await deadlock(true));

    expect(refusals).toHaveLength(1);
    expectTransient(refusals[0], 'deadlock_detected');
  });

  it('answers a model call that gave up on lock_timeout with 503', async () => {
    const release = await holdRowLock(teamA);

    try {
      await expect(
        inScope(async () => {
          await tx().$executeRaw`SET LOCAL lock_timeout = '100ms'`;
          await rename(teamA, 'blocked', false);
        }),
      ).rejects.toSatisfy((error) => {
        expectTransient(error, 'lock_not_available');

        return true;
      });
    } finally {
      await release();
    }
  });

  it('answers a raw FOR UPDATE NOWAIT on a held row with 503', async () => {
    const release = await holdRowLock(teamA);

    try {
      await expect(
        inScope(
          () => tx().$queryRaw`SELECT 1 FROM teams WHERE id = ${teamA}::uuid FOR UPDATE NOWAIT`,
        ),
      ).rejects.toSatisfy((error) => {
        expectTransient(error, 'lock_not_available');

        return true;
      });
    } finally {
      await release();
    }
  });

  it('CONTROL: leaves a statement_timeout (57014) a plain 500, as decided', async () => {
    const outcome = inScope(async () => {
      await tx().$executeRaw`SET LOCAL statement_timeout = '50ms'`;
      await tx().$executeRaw`SELECT pg_sleep(0.3)`;
    });

    await expect(outcome).rejects.not.toBeInstanceOf(ServiceUnavailableError);
    await expect(outcome).rejects.toMatchObject({ code: 'P2010', meta: { code: '57014' } });
  });
});

describe('the transaction-level shapes, translated', () => {
  it('a serialization failure of a model call (P2034)', async () => {
    let read = 0;
    let bothRead!: () => void;
    const barrier = new Promise<void>((resolve) => {
      bothRead = resolve;
    });
    const writer = () =>
      withTenant(
        base,
        { organizationId: ORG, userId: null },
        async (transaction) => {
          await transaction.team.findMany();
          read += 1;
          if (read === 2) bothRead();
          await barrier;
          await transaction.team.update({ where: { id: teamA }, data: { name: 'serial' } });
        },
        { isolationLevel: 'Serializable' },
      );

    const refusals = refusalOf(await Promise.allSettled([writer(), writer()]));

    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatchObject({ code: 'P2034' });
    expectTransient(translateTransientDatabaseFailure(refusals[0]), 'write_conflict');
  });

  it('a transaction that outlived its ceiling (P2028, expired)', async () => {
    const outcome = await withTenant(
      base,
      { organizationId: ORG, userId: null },
      async (transaction) => {
        await transaction.$executeRaw`SELECT pg_sleep(0.5)`;
      },
      { timeoutMs: 200 },
    ).catch((error: unknown) => error);

    expect(outcome).toMatchObject({ code: 'P2028' });
    expectTransient(translateTransientDatabaseFailure(outcome), 'transaction_expired');
  });

  it('a transaction that never got a connection (P2028, maxWait)', async () => {
    const url = inject('databaseUrls').appUser;
    const onePool = createPrismaClient({
      url: `${url}${url.includes('?') ? '&' : '?'}connection_limit=1`,
      logger: silentLogger,
    });
    let releaseHolder!: () => void;
    const holding = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    let holderStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      holderStarted = resolve;
    });

    const holder = withTenant(onePool, { organizationId: ORG, userId: null }, async () => {
      holderStarted();
      await holding;
    });

    try {
      await started;

      const outcome = await withTenant(
        onePool,
        { organizationId: ORG, userId: null },
        () => Promise.resolve(),
        { maxWaitMs: 200 },
      ).catch((error: unknown) => error);

      expect(outcome).toMatchObject({ code: 'P2028' });
      expectTransient(translateTransientDatabaseFailure(outcome), 'transaction_start_timeout');
    } finally {
      releaseHolder();
      await holder;
      await onePool.$disconnect();
    }
  });
});
