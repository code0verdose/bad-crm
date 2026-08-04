import { describe, expect, it } from 'vitest';

import { databaseReadinessProbe } from '../../../src/infrastructure/persistence/prisma/database-readiness.adapter.js';

/**
 * The probe `/ready` was missing, and its absence was the loudest thing about the endpoint: with
 * Postgres unreachable the process answered 200 and kept its place in the load balancer's rotation
 * while every request inside it failed. The `app_auth` pool was probed; the pool the application
 * actually works through was not.
 *
 * `SELECT 1` rather than a table read: readiness asks «can I reach the database», and a query that
 * touched a table would also be asserting that migrations ran — a different question, with its own
 * probe and its own answer.
 */
const clientAnswering = (answer: () => Promise<unknown>) =>
  ({ $queryRaw: answer }) as unknown as Parameters<typeof databaseReadinessProbe>[0];

describe('the database readiness probe', () => {
  it('is up when the pool answers', async () => {
    const probe = databaseReadinessProbe(
      clientAnswering(() => Promise.resolve([{ '?column?': 1 }])),
    );

    await expect(probe.check()).resolves.toEqual({ status: 'up' });
  });

  /**
   * The rejection is deliberately **not** caught here. `CheckReadinessUseCase` turns a throwing
   * probe into `down` and writes the exception to the log — and that split matters: a driver error
   * quotes the connection string, password and all, and `/ready` is unauthenticated. Catching it
   * here would produce the same verdict while losing the one copy of the reason an operator has.
   */
  it('lets the failure through, so the use-case logs it and the body does not', async () => {
    const failure = new Error('connect ECONNREFUSED 127.0.0.1:5432');
    const probe = databaseReadinessProbe(clientAnswering(() => Promise.reject(failure)));

    await expect(probe.check()).rejects.toBe(failure);
  });

  it('answers under the name the body reports it by', () => {
    expect(databaseReadinessProbe(clientAnswering(() => Promise.resolve([]))).dependency).toBe(
      'postgres',
    );
  });
});
