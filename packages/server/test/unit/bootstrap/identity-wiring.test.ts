import { describe, expect, it } from 'vitest';

import { buildContainer } from '@/infrastructure/bootstrap/container.factory.js';
import { type DatabaseConnection } from '@/infrastructure/persistence/prisma/database.factory.js';
import { createRootLogger } from '@/infrastructure/logging/pino-logger.adapter.js';

import { testEnv } from '../../support/test-app.util.js';

/**
 * The authentication half of the composition root, in the three shapes a process can take.
 *
 * The container has always been buildable without a database — the HTTP and contract suites do it
 * on every run — and EPIC-006 adds a second optional connection beside it. That makes four
 * combinations, of which three are real: a full process, a process whose operator forgot
 * `DATABASE_AUTH_URL`, and the connectionless container the suites use. Each has to produce a
 * working *object*; what differs is what happens when somebody calls it, and that is asserted in
 * `test/unit/persistence/identity-repositories.test.ts`.
 */

const logger = (): ReturnType<typeof createRootLogger> =>
  createRootLogger({ level: 'silent', version: '0.0.0' }, { write: () => undefined });

/** A connection object with no server behind it: the container only stores and closes it. */
const fakeDatabase = (): DatabaseConnection & { closed: number } => {
  const connection = {
    base: {} as DatabaseConnection['base'],
    guarded: {} as DatabaseConnection['guarded'],
    closed: 0,
    close: (): Promise<void> => {
      connection.closed += 1;

      return Promise.resolve();
    },
  };

  return connection;
};

const AUTH_URL = 'postgres://app_auth:secret@localhost:5432/bad_crm';

describe('wiring the authentication surface', () => {
  it('builds every use-case even without a database, so the routes always exist', () => {
    const container = buildContainer({ env: testEnv(), logger: logger() });

    expect(Object.keys(container.http.identity).sort()).toEqual([
      'authLookup',
      'authenticate',
      'endSession',
      'listSessions',
      'login',
      'refresh',
      'refreshTokens',
      'register',
    ]);
    expect(container.shutdownSteps).toEqual([]);
  });

  it('opens the second pool when the authentication URL is configured, and closes it', async () => {
    const database = fakeDatabase();
    const container = buildContainer({
      env: testEnv({ DATABASE_AUTH_URL: AUTH_URL }),
      logger: logger(),
      database,
    });

    expect(container.shutdownSteps.map((step) => step.name)).toEqual(['database', 'auth-database']);

    // Closing a pool that never connected is a no-op for the driver and proves the step is wired.
    await Promise.all(container.shutdownSteps.map((step) => step.close()));
    expect(database.closed).toBe(1);
  });

  /**
   * A deployment with a database and no `DATABASE_AUTH_URL` is incomplete rather than broken: it
   * serves everything else and refuses the authentication path loudly on first use, which is what
   * `.optional()` in the env schema buys and why it is optional at all
   * (rules/self-host-packaging.mdc, rule 2).
   */
  it('registers no second shutdown step when the authentication URL is absent', () => {
    const container = buildContainer({
      env: testEnv(),
      logger: logger(),
      database: fakeDatabase(),
    });

    expect(container.shutdownSteps.map((step) => step.name)).toEqual(['database']);
  });

  /**
   * The floor is enforced where the parameters are read, so a container is the last place a
   * weakened configuration can be caught before it starts hashing passwords with it.
   */
  it('refuses to build on argon2 parameters below the OWASP floor', () => {
    expect(() =>
      buildContainer({ env: testEnv({ ARGON2_MEMORY_COST: 1024 }), logger: logger() }),
    ).toThrow(/memoryCost/);
  });
});
