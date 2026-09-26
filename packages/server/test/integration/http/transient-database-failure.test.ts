import { Prisma } from '@prisma/client';
import express, { type Express } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { type UnitOfWorkPort } from '@/application/platform/ports/unit-of-work.port.js';
import { AsyncRequestContextAdapter } from '@/infrastructure/logging/async-request-context.adapter.js';
import {
  createRootLogger,
  PinoLoggerAdapter,
} from '@/infrastructure/logging/pino-logger.adapter.js';
import {
  type TxClient,
  type withTenant,
} from '@/infrastructure/persistence/prisma/tenant.context.js';
import { PrismaUnitOfWork } from '@/infrastructure/persistence/prisma/unit-of-work.adapter.js';
import { createErrorHandler } from '@/presentation/http/error-handler.middleware.js';
import { createRequestContextMiddleware } from '@/presentation/http/middleware/request-context.middleware.js';

/**
 * A deadlock inside a use-case, followed all the way to the wire: the `PrismaUnitOfWork` the product
 * wires, a use-case that runs its work through it, the error handler the product mounts.
 *
 * Before this suite the same failure was answered `500 internal_error` with a stack trace at
 * `error` — a page for an operator and «do not retry» for a client, for a race a retry wins. The
 * transaction is a double (supertest has no database), but the error it throws is the shape Prisma
 * 6.19.3 really produces for a deadlock hit by a model call, measured on PostgreSQL in
 * `test/integration/db/transient-database-failure.test.ts`.
 */

const ORG = '018f4a3b-0000-7000-8000-000000000001';

/** What `tx.team.update()` throws when PostgreSQL picks it as the deadlock victim. */
const engineFailure = (sqlState: string): Prisma.PrismaClientUnknownRequestError =>
  new Prisma.PrismaClientUnknownRequestError(
    [
      '',
      'Invalid `tx.team.update()` invocation in',
      '/srv/app/dist/infrastructure/persistence/prisma/team.repository.js:40:21',
      '',
      'Error occurred during query execution:',
      `ConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "${sqlState}", message: "deadlock detected", severity: "ERROR", detail: None, column: None, hint: None }), transient: false })`,
    ].join('\n'),
    { clientVersion: 'test' },
  );

/** A transaction that opens, pins the tenant, and runs the work — no database behind it. */
const transactionDouble = (): Parameters<typeof withTenant>[0] =>
  ({
    $transaction: async (run: (tx: TxClient) => Promise<unknown>): Promise<unknown> =>
      run({ $executeRaw: (): Promise<number> => Promise.resolve(1) } as unknown as TxClient),
  }) as unknown as Parameters<typeof withTenant>[0];

/** The shape of every command: one transaction, the repository call inside it. */
const renameTeamUseCase = (unitOfWork: UnitOfWorkPort, failure: unknown) => (): Promise<void> =>
  unitOfWork.withTenant({ organizationId: ORG, userId: null }, () => Promise.reject(failure));

const appFailingWith = (failure: unknown): { app: Express; logLines: () => string[] } => {
  const written: string[] = [];
  const logger = createRootLogger(
    { level: 'debug', version: '0.0.0' },
    { write: (line: string) => written.push(line) },
  );
  const requestContext = new AsyncRequestContextAdapter();
  const execute = renameTeamUseCase(new PrismaUnitOfWork(transactionDouble() as never), failure);
  const app = express();

  app.use(
    createRequestContextMiddleware({
      requestContext,
      idGenerator: { next: () => '01J8Z2F5Q3K9V6N0R4T7YB3XQD' },
    }),
  );
  app.patch('/teams/current', async (_request, response) => {
    await execute();
    response.status(204).end();
  });
  app.use(createErrorHandler({ logger: new PinoLoggerAdapter(logger), requestContext }));

  return { app, logLines: () => [...written] };
};

const lastEntry = (lines: string[]): Record<string, unknown> =>
  JSON.parse(lines.at(-1) ?? '{}') as Record<string, unknown>;

describe('a deadlock inside a use-case', () => {
  it('is answered 503 service_unavailable with Retry-After', async () => {
    const { app } = appFailingWith(engineFailure('40P01'));

    const response = await request(app).patch('/teams/current');

    expect(response.status).toBe(503);
    expect(response.headers['retry-after']).toBe('1');
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.body).toMatchObject({ status: 503, code: 'service_unavailable' });
  });

  it('keeps the classification in the log and out of the body', async () => {
    const { app } = appFailingWith(engineFailure('40P01'));

    const response = await request(app).patch('/teams/current');

    expect(JSON.stringify(response.body)).not.toMatch(
      /deadlock|40P01|PostgresError|team\.repository/,
    );
  });

  it('is logged at warn with its reason, and without the driver message or a stack', async () => {
    const { app, logLines } = appFailingWith(engineFailure('40P01'));

    await request(app).patch('/teams/current');

    const entry = lastEntry(logLines());

    expect(entry['level']).toBe(40); // pino's numeric warn
    expect(entry['msg']).toBe('request rejected');
    expect(entry).toMatchObject({
      code: 'service_unavailable',
      status: 503,
      details: { dependency: 'postgres', reason: 'deadlock_detected', sqlState: '40P01' },
    });
    expect(entry).not.toHaveProperty('err');
    expect(JSON.stringify(entry)).not.toContain('PostgresError');
  });

  it('CONTROL: a database failure a retry cannot fix stays 500 at error, with its stack', async () => {
    // `42501` — a row-level-security refusal: this code wrote into another organization.
    const { app, logLines } = appFailingWith(engineFailure('42501'));

    const response = await request(app).patch('/teams/current');
    const entry = lastEntry(logLines());

    expect(response.status).toBe(500);
    expect(response.headers['retry-after']).toBeUndefined();
    expect(response.body).toMatchObject({ code: 'internal_error' });
    expect(entry['level']).toBe(50); // pino's numeric error
    expect(entry).toHaveProperty('err');
  });
});
