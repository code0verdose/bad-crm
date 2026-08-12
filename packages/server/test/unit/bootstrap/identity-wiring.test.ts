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
  /**
   * The upgrade path of an installation whose `.env` predates `MAIL_FROM`.
   *
   * `SMTP_URL` has been in `.env.example` since EPIC-001 and `MAIL_FROM` is new, so this is the
   * common case rather than a corner one. It is asserted through `buildContainer` and not through
   * `createMailer`, because the defect it guards was not in the mailer: the mailer threw, the throw
   * was correct in isolation, and `buildContainer` calls it *before* `api-process.factory.ts` prints
   * any degradation. The process therefore exited before opening the port, while `CHANGELOG.md` and
   * `docs/runbooks/upgrade.md` both promised a warning — and the `warn` branch in
   * `env-features.util.ts` was unreachable code that no test could have noticed.
   *
   * A unit test on the mailer alone would have stayed green through all of that. The composition
   * root is the smallest place where "the installation still starts" is a statement about behaviour.
   */
  it('starts an installation whose SMTP_URL predates MAIL_FROM', () => {
    expect(() =>
      buildContainer({
        env: testEnv({ SMTP_URL: 'smtp://localhost:1025', MAIL_FROM: undefined }),
        logger: logger(),
      }),
    ).not.toThrow();
  });

  it('builds every use-case even without a database, so the routes always exist', () => {
    const container = buildContainer({ env: testEnv(), logger: logger() });

    expect(Object.keys(container.http.identity).sort()).toEqual([
      'authLookup',
      'authenticate',
      'changePassword',
      'confirmPasswordReset',
      'confirmTotp',
      'endSession',
      'listSessions',
      'login',
      'recoveryCodeStatus',
      'refresh',
      'refreshTokens',
      'regenerateRecoveryCodes',
      'register',
      'requestPasswordReset',
      'setupTotp',
    ]);
    // `mail` is unconditional: both mailers expose `close()`, so the step does not become a
    // conditional the day an installation is configured without SMTP (`mail.factory.ts`).
    expect(container.shutdownSteps.map((step) => step.name)).toEqual(['mail']);
  });

  it('opens the second pool when the authentication URL is configured, and closes it', async () => {
    const database = fakeDatabase();
    const container = buildContainer({
      env: testEnv({ DATABASE_AUTH_URL: AUTH_URL }),
      logger: logger(),
      database,
    });

    // Mail **before** both pools, and asserted as a sequence because `createShutdownHandler` awaits
    // the steps in array order — so this array is the order of execution, not a set of names. It read
    // `['database', 'auth-database', 'mail']` while the comment in `container.factory.ts` promised the
    // opposite; the steps were pushed as their subjects happened to be constructed.
    expect(container.shutdownSteps.map((step) => step.name)).toEqual([
      'mail',
      'database',
      'auth-database',
    ]);

    // Sequentially, the way the handler does it — `Promise.all` starts them all at once and would
    // report the same success for any order, which is how the reversed order survived until now.
    const closed: string[] = [];

    for (const step of container.shutdownSteps) {
      await step.close();
      closed.push(step.name);
    }

    expect(closed).toEqual(['mail', 'database', 'auth-database']);
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

    expect(container.shutdownSteps.map((step) => step.name)).toEqual(['mail', 'database']);
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
